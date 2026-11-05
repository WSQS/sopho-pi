import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-frontend-'));
const sessionId = '11111111-1111-4111-8111-111111111111';
const readOnlySessionId = '22222222-2222-4222-8222-222222222222';
const requests = [];
const draftRequests = [];
const drafts = new Map();
const sessionClients = new Set();
let queue = { steering: [], followUp: [] };
let failSteer = false;
// 反方向兜底（steer 409 session_not_streaming ⇒ 按新消息重发一发）之后，那発 message 也失败：
// 用来验「兜一次仍失败 ⇒ 今天那句可读 409 仍然可见」+「只兜一次、不成环」。
let failRecoveryMessage = false;
let failDraft = false;
let browser;
let chromium;
let server;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function broadcast(event, data) {
  for (const response of sessionClients) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    send(method, params = {}) {
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    once(method) {
      return new Promise((resolve) => {
        const listener = (params) => {
          listeners.get(method).delete(listener);
          resolve(params);
        };
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(listener);
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || result.result?.description || 'browser evaluation failed');
  return result.result.value;
}

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') {
      sendJson(response, 200, { sessions: [
        { id: sessionId, name: 'Running session', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
        { id: readOnlySessionId, name: 'Old worktree', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
      ] });
      return;
    }
    if (url.pathname === '/api/devices') {
      sendJson(response, 200, { exists: true, devices: [] });
      return;
    }
    if (url.pathname === '/api/host') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: [
        { id: sessionId, name: 'Running session', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
        { id: readOnlySessionId, name: 'Old worktree', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
      ] })}\n\n`);
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) {
      sendJson(response, 200, { name: 'Running session', runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}/messages`) {
      sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null });
      return;
    }
    if (url.pathname === `/api/sessions/${readOnlySessionId}`) {
      sendJson(response, 200, { name: 'Old worktree', readOnly: true, readOnlyReason: 'cwd-missing', cwdMissing: 'C:\\gone\\worktree', runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
      return;
    }
    if (url.pathname === `/api/sessions/${readOnlySessionId}/messages`) {
      sendJson(response, 200, { messages: [{ role: 'assistant', text: '历史正文仍可查看', parts: [{ type: 'text', text: '历史正文仍可查看' }] }], extras: [], compaction: { atIndex: null }, observability: null });
      return;
    }
    const draftSessionId = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/)?.[1];
    if (draftSessionId) {
      if (request.method === 'GET') {
        const draft = drafts.get(draftSessionId);
        sendJson(response, 200, draft ?? { text: '', at: null });
        return;
      }
      if (request.method === 'PUT') {
        const body = await bodyOf(request);
        draftRequests.push({ sessionId: draftSessionId, body });
        if (failDraft) {
          failDraft = false;
          sendJson(response, 503, { error: 'draft_store_failed', message: 'temporary draft failure' });
          return;
        }
        if (body.text === '') drafts.delete(draftSessionId);
        else drafts.set(draftSessionId, { text: body.text, at: Date.now() });
        sendJson(response, 200, drafts.get(draftSessionId) ?? { text: '', at: null });
        return;
      }
    }
    if (url.pathname === `/api/sessions/${sessionId}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      sessionClients.add(response);
      response.once('close', () => sessionClients.delete(response));
      return;
    }
    const action = url.pathname.match(new RegExp(`^/api/sessions/${sessionId}/(message|steer|follow-up|abort)$`))?.[1];
    if (action && request.method === 'POST') {
      const body = await bodyOf(request);
      requests.push({ action, body });
      if (action === 'steer' && failSteer) {
        failSteer = false;
        failRecoveryMessage = true; // 前端会把这条原文按新消息重发一发 —— 让那一发也失败
        sendJson(response, 409, { error: 'session_not_streaming', message: 'Agent is not currently processing; steer requires an active response.' });
        return;
      }
      if (action === 'message' && failRecoveryMessage) {
        failRecoveryMessage = false;
        sendJson(response, 409, { error: 'session_streaming', message: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
        return;
      }
      if (action === 'abort') {
        sendJson(response, 200, { aborted: true });
        queue = { steering: [], followUp: [] };
        broadcast('session.queue', queue);
        broadcast('session.end', { stopReason: 'aborted', text: '' });
        // 真实服务端在一轮 run 结束时先发 session.end（每条 assistant 消息的结束），
        // 再在 pi 的 agent_settled 那一刻发 session.settled（**run** 结束，= 真的空闲）。
        // 前端现在拿 session.settled 当空闲判据，所以夹具必须照实把这条也发出来。
        broadcast('session.settled', {});
        return;
      }
      sendJson(response, 202, { accepted: true });
      if (action === 'steer') queue.steering.push(body.text);
      if (action === 'follow-up') queue.followUp.push(body.text);
      if (action !== 'message') broadcast('session.queue', queue);
      return;
    }
    if (url.pathname === '/control/start') {
      broadcast('session.start', { role: 'assistant' });
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/control/clear-queue') {
      queue = { steering: [], followUp: [] };
      broadcast('session.queue', queue);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/control/fail-steer') {
      failSteer = true;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/control/fail-draft') {
      failDraft = true;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/control/disconnect') {
      for (const client of sessionClients) client.destroy();
      sendJson(response, 200, { ok: true });
      return;
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reservePort();
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const result = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return result?.ok ? result.json() : null;
  }, 'chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${port}/`, { method: 'PUT' })).json();
  browser = cdp(target.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'tree did not render');
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not open');
  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });

  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='reload keeps this draft'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor(() => drafts.get(sessionId)?.text === 'reload keeps this draft', 'debounced draft write missing');
  const reloaded = browser.once('Page.loadEventFired');
  await browser.send('Page.reload', { ignoreCache: true });
  await reloaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'tree did not render after reload');
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"]').click()`);
  const restoredAfterReload = await waitFor(async () => {
    const value = await evaluate(`({disabled:document.querySelector('#prompt').disabled,value:document.querySelector('#prompt').value})`);
    return !value.disabled && value.value === 'reload keeps this draft' ? value : null;
  }, 'draft did not survive reload');
  print('draft survives reload', { restoredAfterReload, stored: drafts.get(sessionId) });

  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='switch keeps this draft'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-session-id="${readOnlySessionId}"]').click(); })()`);
  await waitFor(() => drafts.get(sessionId)?.text === 'switch keeps this draft', 'switch did not flush current draft');
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === true`), 'read-only session did not open during draft switch');
  const readonlyDraftWrites = draftRequests.filter((entry) => entry.sessionId === readOnlySessionId).length;
  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='must not save'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(draftRequests.filter((entry) => entry.sessionId === readOnlySessionId).length, readonlyDraftWrites);
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false && document.querySelector('#prompt').value === 'switch keeps this draft'`), 'draft did not survive session switch');
  print('draft survives switch; read-only writes stay absent', { stored: drafts.get(sessionId), readOnlyDraftWrites: readonlyDraftWrites });

  await fetch(`http://127.0.0.1:${port}/control/fail-draft`);
  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='draft write will fail'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const draftFailure = await waitFor(async () => {
    const value = await evaluate(`({text:document.querySelector('#notice').textContent,level:document.querySelector('#notice').dataset.level,color:document.querySelector('#notice').style.color})`);
    return value.text.includes('草稿保存失败') ? value : null;
  }, 'draft write failure was silent');
  assert.equal(draftFailure.level, 'info');
  assert.notEqual(draftFailure.color, 'var(--danger)');
  print('draft write failure is visible but non-alarming', draftFailure);

  const shiftEnter = await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='line 1\\nline 2'; input.dispatchEvent(new Event('input',{bubbles:true})); const before=input.getBoundingClientRect().height; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true})); return {value:input.value,height:before,resize:getComputedStyle(input).resize}; })()`);
  assert.equal(requests.length, 0);
  assert.equal(shiftEnter.value, 'line 1\nline 2');
  assert.equal(shiftEnter.resize, 'none');
  assert.ok(shiftEnter.height >= 56, JSON.stringify(shiftEnter));
  print('Shift+Enter remains a multiline edit', shiftEnter);

  await evaluate(`(() => { const input = document.querySelector('#prompt'); input.value='ordinary'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  await waitFor(() => requests.some((item) => item.action === 'message'), 'ordinary message route missing');
  await waitFor(() => !drafts.has(sessionId) && draftRequests.some((entry) => entry.sessionId === sessionId && entry.body.text === ''), 'successful send did not delete server draft');
  assert.equal(requests[0].action, 'message');
  assert.equal(await evaluate(`document.querySelector('#prompt').value`), '');
  print('ordinary Enter clears input and server draft', { message: requests[0], lastDraftRequest: draftRequests.at(-1) });

  await fetch(`http://127.0.0.1:${port}/control/start`);
  await waitFor(() => evaluate(`document.querySelector('#abort').disabled === false`), 'running state not visible');
  await evaluate(`(() => { const input = document.querySelector('#prompt'); input.value='interrupt'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  await waitFor(() => requests.some((item) => item.action === 'steer'), 'steer route missing');
  await waitFor(() => evaluate(`document.querySelector('#queue-status').textContent.includes('steer：interrupt')`), 'steer queue not visible');

  await evaluate(`(() => { const input = document.querySelector('#prompt'); input.value='later'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true})); })()`);
  await waitFor(() => requests.some((item) => item.action === 'follow-up'), 'follow-up route missing');
  const queueView = await waitFor(async () => {
    const value = await evaluate(`({hidden:document.querySelector('#queue-status').hidden,text:document.querySelector('#queue-status').textContent,types:Array.from(document.querySelectorAll('.queue-item')).map((node)=>node.dataset.queueType)})`);
    return value.text.includes('2 条') ? value : null;
  }, 'combined queue not visible');
  assert.deepEqual(queueView.types, ['steer', 'follow-up']);
  print('steer/follow-up queue visible', { requests: requests.slice(1, 3), queueView });

  await fetch(`http://127.0.0.1:${port}/control/clear-queue`);
  await waitFor(() => evaluate(`document.querySelector('#queue-status').hidden === true`), 'queue did not disappear');
  print('queue cleared by session.queue', { hidden: true });

  await fetch(`http://127.0.0.1:${port}/control/fail-steer`);
  const beforeFailureCount = requests.length;
  await evaluate(`(() => { const input = document.querySelector('#prompt'); input.value='must remain'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  // 前端现在会为这个 409 按新消息兜一次（反方向），而那一发也被拒 ⇒ 一共两跳、到此为止。
  await waitFor(() => requests.length === beforeFailureCount + 2, 'failed steer + single recovery request missing');
  const honestFailure = await waitFor(async () => {
    const value = await evaluate(`({input:document.querySelector('#prompt').value,notice:document.querySelector('#notice').textContent})`);
    return value.notice.includes('409') ? value : null;
  }, 'failed steer was hidden');
  const failureActions = requests.slice(beforeFailureCount).map((item) => item.action);
  assert.deepEqual(failureActions, ['steer', 'message'], `反方向兜底只许一跳（不成环），实测 ${JSON.stringify(failureActions)}`);
  assert.equal(honestFailure.input, 'must remain');
  print('non-streaming steer failure stays visible after exactly one recovery attempt', { requests: failureActions, ...honestFailure });

  await evaluate(`document.querySelector('#abort').click()`);
  await waitFor(() => requests.some((item) => item.action === 'abort'), 'abort route missing');
  // 稳定读点：`session.end`（stopReason=aborted）先把「已中断，可以继续发送」写上，而**真正的空闲**
  // 判据是跟着到的 `session.settled` —— 它才把 `#abort` 置空（产品注释：在 settled 之前 abort 必须可用）。
  // 旧写法只等那句话就断言 `disabled === true` ⇒ 抢在 settled 之前读。这里等到「那句话在**且**
  // abort 已复位」再读，给上界；到点没复位就是一条明确的红。
  // （本机 60 次里没直接撞上这一格；把 [end, settled] 拉开成确定性探针时，旧写法当场红在
  // `assert.equal(aborted.disabled, true)`。同门下一条瞬时读数撞了 2 次，见那里。）
  const aborted = await waitFor(async () => {
    const value = await evaluate(`({disabled:document.querySelector('#abort').disabled,notice:document.querySelector('#notice').textContent})`);
    return value.notice.includes('可以继续发送') && value.disabled === true ? value : null;
  }, 'abort did not settle UI (session.settled never arrived)');
  assert.equal(aborted.disabled, true);
  await evaluate(`(() => { const input = document.querySelector('#prompt'); input.value='after abort'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  await waitFor(() => requests.some((item) => item.action === 'message' && item.body.text === 'after abort'), 'ordinary send after abort missing');
  print('abort settles and ordinary send resumes', aborted);

  // 断流这条报文是**瞬时**的：`sessionEvents.onerror` 写上去之后，紧接着那条「消息已接收」回执
  // （上一条 Enter 发出、服务端 202 后前端才写的）会把它盖掉（实测：盖掉发生在 ~20ms 内）。
  // `waitFor` 按 40ms 轮询去抓一个 20ms 的窗口 ⇒ 60 次里漏 2（“worker disconnect was hidden”）。
  // 确定性读数：断流前先在页面里装一个 MutationObserver，把 `#notice` 的**每一次**文本都记下来，
  // 再等这条日志里出现过那句话 —— 轮询漏掉的瞬时报文不会再漏（断言仍是「必须报过」。）
  await evaluate(`(() => {
    window.__noticeLog = [];
    const node = document.querySelector('#notice');
    const record = () => { const text = node.textContent; if (window.__noticeLog[window.__noticeLog.length - 1] !== text) window.__noticeLog.push(text); };
    record();
    window.__noticeObserver = new MutationObserver(record);
    window.__noticeObserver.observe(node, { childList: true, characterData: true, subtree: true, attributes: true });
  })()`);
  await fetch(`http://127.0.0.1:${port}/control/disconnect`);
  const disconnect = await waitFor(async () => {
    const log = await evaluate(`window.__noticeLog ?? []`);
    return log.find((text) => text.includes('worker 断开')) ?? null;
  }, 'worker disconnect was hidden');
  print('worker disconnect visible', { notice: disconnect, noticeLog: await evaluate(`window.__noticeLog`) });

  await evaluate(`document.querySelector('[data-session-id="${readOnlySessionId}"]').click()`);
  const readOnlyView = await waitFor(async () => {
    const value = await evaluate(`({
      promptDisabled:document.querySelector('#prompt').disabled,
      sendDisabled:document.querySelector('#send').disabled,
      abortDisabled:document.querySelector('#abort').disabled,
      title:document.querySelector('#session-title').textContent,
      notice:document.querySelector('#notice').textContent,
      messages:document.querySelector('#messages').textContent,
    })`);
    return value.messages.includes('历史正文仍可查看') ? value : null;
  }, 'read-only history did not render');
  assert.equal(readOnlyView.promptDisabled, true);
  assert.equal(readOnlyView.sendDisabled, true);
  assert.equal(readOnlyView.abortDisabled, true);
  assert.match(readOnlyView.title, /只读/);
  assert.match(readOnlyView.notice, /工作目录已不存在.*可以查看历史，不能继续/);
  print('cwd-missing session is readable but composer is locked', readOnlyView);
  print('RESULT', 'S1a-2 frontend interaction PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  browser?.close();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await new Promise((resolve) => chromium.once('exit', resolve));
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
