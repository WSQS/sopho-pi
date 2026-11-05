import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-livededup-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-livededup');
const screenshotFile = path.join(artifactRoot, 'live-dedup-streaming-1200x760.png');
const disconnectedScreenshotFile = path.join(artifactRoot, 'session-stream-disconnected-1200x760.png');
const queueScreenshotFile = path.join(artifactRoot, 'reconnect-queue-restored-1200x760.png');
const sessionId = '55555555-5555-4555-8555-555555555555';
const staleSessionId = '66666666-6666-4666-8666-666666666666';
const mentionSessionId = '77777777-7777-4777-8777-777777777777';
const STALE = 'U11-旧会话迟到正文绝不能覆盖新会话。';
const PREFIX = 'H05-已经产出的正文：先给出唯一前缀。';
const MIDDLE = 'H05-刷新后的增量：继续这一轮。';
const TAIL = 'H05-用户滚开后仍不能丢的尾部。';
// 「我刚发出去的那条」必须立刻出现 + 历史一到就按 (role,text) 去重（用户 2026-09-20 报的现象）。
const ECHO_STEER = 'H06-插话：这条必须在我按下发送之后就出现在消息区。';
const ECHO_FOLLOWUP = 'H06-排队：这一条排在插话后面。';
const ECHO_MENTION_INPUT = '@parity H06-mention：框里的字和发出去的字不一样。';
const ECHO_MENTION_NEEDLE = 'H06-mention：框里的字和发出去的字不一样。';
const ECHO_SWITCH = 'H06-换会话：这条占位不许跟到别的会话去。';
const ECHO_RECONNECT = 'H06-断线重连：这条断线期间落了盘，重连后占位不许残留。';
const ECHO_REFUSED = 'H06-被拒：服务端 409，这条不许留下占位。';
// H06 的比较口径：**按 wire 文本**，不再比「DOM 文本」逐字相等。
// 旧的 `.message-body.textContent === ECHO_STEER` 只在自研渲染器下凑巧成立：那条路把整段当纯文本
// 放进单个节点，textContent 与 POST 出去的那份逐字相同。正式消息现在走 marked（web/markdown.mjs），
// DOM 文本是**渲染结果** —— marked 每块后补一个 `\n`，软换行还会变 `<br>` —— 拿它跟 wire 文本逐字
// 相等比，是比错了东西。这里把两侧空白规范化（折叠连续空白、去首尾）再比：断言仍然是
// 「正文内容等于发出去的那份」，**没有**放宽成空断言，也**没有**删断言。
const wireText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const SLOW_TURN_MS = 2400; // 慢假上游：这一轮要跑这么久，修前「我的消息」要等这么久才出现
const ECHO_PENDING_BUDGET_MS = 250;
const filler = (index) => `历史消息 ${index + 1}：${'用于撑开滚动区域的中文内容。'.repeat(9)}`;
const baseMessages = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: filler(index) }));
let currentMessages = [...baseMessages];
const sessions = [
  { id: sessionId, name: 'H-05 直播去重', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: staleSessionId, name: 'U-11 迟到请求', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: mentionSessionId, name: 'parity', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T06:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];
let sessionStream;
const sessionStreams = new Map();
let sessionStreaming = false;
let sessionConnections = 0;
let snapshotQueue = { steering: [], followUp: [] };
let snapshotIncludesQueue = true;
let staleMessageReads = 0;
let treeStream;
let server;
let chromium;
let browser;
let checks = 0;
let messageReads = 0;
const delivered = []; // 服务端实到的发送（含 POST 出去的那一份文本）
const switchedModels = [];

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
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

async function waitFor(operation, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function cdp(wsUrl, pageProblems) {
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
    if (message.method === 'Runtime.exceptionThrown') pageProblems.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageProblems.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
  return result.result.value;
}

async function emit(name, data = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  if (!response.ok) throw new Error(`emit ${name} failed: ${response.status}`);
}

async function frames(count = 3) {
  await evaluate(`new Promise(resolve=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
}

async function state() {
  return evaluate(`(() => {
    const root=document.querySelector('#messages');
    const text=root.textContent;
    const count=(needle)=>text.split(needle).length-1;
    return {
      live:root.querySelectorAll('.live-message').length,
      assistants:root.querySelectorAll('.message-assistant').length,
      prefix:count(${JSON.stringify(PREFIX)}),
      middle:count(${JSON.stringify(MIDDLE)}),
      tail:count(${JSON.stringify(TAIL)}),
      dist:Math.round(root.scrollHeight-root.scrollTop-root.clientHeight),
      top:Math.round(root.scrollTop),
      height:root.scrollHeight,
      liveText:root.querySelector('.live-message .message-body')?.textContent||'',
      notice:document.querySelector('#notice').textContent,
      connection:document.querySelector('#session-connection')?.textContent || '',
      connectionHeight:document.querySelector('#session-connection')?.getBoundingClientRect().height || 0,
      connectionSlot:document.querySelector('#session-connection') ? getComputedStyle(document.querySelector('#session-connection')).borderInlineStartWidth : '',
      title:document.querySelector('#session-title').textContent,
      stale:count(${JSON.stringify(STALE)}),
      queueHidden:document.querySelector('#queue-status').hidden,
      queueText:document.querySelector('#queue-status').textContent,
      queueItems:Array.from(document.querySelectorAll('#queue-status .queue-item')).map((node)=>({type:node.dataset.queueType,text:node.textContent})),
      queueSlot:getComputedStyle(document.querySelector('#queue-status')).borderInlineStartWidth,
      pending:Array.from(root.querySelectorAll('[data-pending]')).map((node)=>({
        state:node.dataset.pending,
        queue:node.dataset.queue||null,
        role:node.querySelector('.message-role')?.textContent||'',
        body:node.querySelector('.message-body')?.textContent||'',
        slot:getComputedStyle(node).borderInlineStartColor,
        note:node.querySelector('.message-pending-note')?.textContent||''
      })),
      pendingKinds:Array.from(root.children).map((node)=>node.dataset.kind||node.className)
    };
  })()`);
}

await mkdir(artifactRoot, { recursive: true });
const port = await reservePort();
let primaryError;
try {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      treeStream = response;
      return;
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|message|steer|follow-up|followUp|model))?$/.exec(url.pathname);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const action = sessionMatch[2] ?? null;
      const row = sessions.find((item) => item.id === id);
      if (!row) return sendJson(response, 404, { message: 'not found' });
      if (action === null) return sendJson(response, 200, { name: row.name, runtime: { isStreaming: id === sessionId && sessionStreaming, isCompacting: false, isRetrying: false }, observability: null });
      if (action === 'messages') {
        if (id === staleSessionId) {
          staleMessageReads += 1;
          await new Promise((resolve) => setTimeout(resolve, 500));
          return sendJson(response, 200, { messages: [{ role: 'assistant', text: STALE }], extras: [], compaction: { atIndex: null }, observability: null });
        }
        messageReads += 1;
        return sendJson(response, 200, { messages: currentMessages, extras: [], compaction: { atIndex: null }, observability: null });
      }
      if (action === 'message' || action === 'steer' || action === 'follow-up' || action === 'followUp') {
        const body = await bodyJson(request);
        delivered.push({ action, text: body.text });
        if (body.text === ECHO_REFUSED) return sendJson(response, 409, { error: 'session_streaming', message: 'fake refusal: 服务端不收这一条' });
        return sendJson(response, 202, { accepted: true, sessionId: id });
      }
      if (action === 'model') {
        const body = await bodyJson(request);
        switchedModels.push(body.model);
        return sendJson(response, 200, { ok: true, model: body.model });
      }
      if (action === 'commands') return sendJson(response, 200, {
        streaming: id === sessionId && sessionStreaming,
        commands: [
          { name: 'model', description: 'switch model', source: 'builtin', runnable: true, via: 'model', argumentHint: '<ref>' },
          // 扩展命令：pi 会直接吃掉它（连 user 正文都不会有）⇒ 客户端绝不能画占位。
          { name: 'cwd', description: 'show cwd', source: 'extension', runnable: true, via: 'prompt', argumentHint: null },
        ],
      });
      if (action === 'seen') return sendJson(response, 200, { ok: true });
      if (action === 'draft') return sendJson(response, 200, { text: '' });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        const snapshot = { isStreaming: id === sessionId && sessionStreaming, isCompacting: false, isRetrying: false, pendingMessages: 0 };
        if (id === sessionId && snapshotIncludesQueue) snapshot.queue = snapshotQueue;
        response.write(`event: session.snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        sessionStreams.set(id, response);
        if (id === sessionId) {
          sessionStream = response;
          sessionConnections += 1;
        }
        response.once('close', () => {
          if (sessionStreams.get(id) === response) sessionStreams.delete(id);
          if (sessionStream === response) sessionStream = null;
        });
        return;
      }
    }
    if (url.pathname === '/api/test/disconnect' && request.method === 'POST') {
      const id = url.searchParams.get('id') || sessionId;
      const stream = sessionStreams.get(id);
      if (!stream || stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
      stream.destroy();
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/api/test/snapshot-queue' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      snapshotIncludesQueue = data.include !== false;
      if (data.queue) snapshotQueue = data.queue;
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/api/test/event' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!sessionStream || sessionStream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
      if (name === 'session.start') sessionStreaming = true;
      if (name === 'session.end') sessionStreaming = false;
      sessionStream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      return sendJson(response, 200, { ok: true });
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reservePort();
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'Chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const pageProblems = [];
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'session row did not render');
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false && document.querySelectorAll('#messages .message').length === ${baseMessages.length}`), 'session did not open');

  await emit('session.start');
  await emit('session.delta', { channel: 'text', delta: PREFIX });
  await waitFor(async () => (await state()).prefix === 1, 'live prefix did not render');
  currentMessages = [...baseMessages, { role: 'assistant', text: PREFIX }];
  const readsBeforeRefresh = messageReads;
  await emit('session.snapshot', { isStreaming: true, isCompacting: false, isRetrying: false });
  await waitFor(async () => messageReads > readsBeforeRefresh && (await state()).live === 0, 'snapshot refresh did not converge');
  const deduped = await state();
  check('流式中刷新后同一轮正文只出现一次', deduped.prefix === 1 && deduped.live === 0, `prefix=${deduped.prefix} live=${deduped.live} assistants=${deduped.assistants}`);

  await emit('session.delta', { channel: 'text', delta: MIDDLE });
  await waitFor(async () => (await state()).middle === 1, 'post-refresh delta did not render');
  const afterDelta = await state();
  check('刷新后续 delta 接在历史后面且不重放前缀', afterDelta.prefix === 1 && afterDelta.middle === 1 && afterDelta.live === 1 && afterDelta.liveText === MIDDLE, `prefix=${afterDelta.prefix} middle=${afterDelta.middle} live=${afterDelta.live} liveText=${JSON.stringify(afterDelta.liveText)}`);

  await evaluate(`(() => { const node=document.querySelector('#messages'); node.scrollTop=Math.max(0,node.scrollTop-120); node.dispatchEvent(new Event('scroll')); })()`);
  await frames();
  const scrolled = await state();
  currentMessages = [...baseMessages, { role: 'assistant', text: PREFIX + MIDDLE }];
  const readsBeforeScrollRefresh = messageReads;
  await emit('session.snapshot', { isStreaming: true, isCompacting: false, isRetrying: false });
  await waitFor(async () => messageReads > readsBeforeScrollRefresh && (await state()).live === 0, 'scrolled refresh did not converge');
  const refreshedAway = await state();
  check('不贴底时刷新不把用户弹到底', scrolled.dist > 50 && refreshedAway.dist > 50, `刷新前距底=${scrolled.dist}px top=${scrolled.top}；刷新后距底=${refreshedAway.dist}px top=${refreshedAway.top}`);
  check('不贴底刷新也没有因去重丢正文', refreshedAway.prefix === 1 && refreshedAway.middle === 1, `prefix=${refreshedAway.prefix} middle=${refreshedAway.middle} live=${refreshedAway.live}`);

  await emit('session.delta', { channel: 'text', delta: TAIL });
  await waitFor(async () => (await state()).tail === 1, 'tail delta did not render');
  await frames();
  const streamingShot = await state();
  check('滚开后继续流式仍不贴底且尾部只出现一次', streamingShot.dist > 50 && streamingShot.tail === 1 && streamingShot.live === 1, `距底=${streamingShot.dist}px tail=${streamingShot.tail} live=${streamingShot.live}`);
  await evaluate(`(() => { const node=document.querySelector('#messages'); node.scrollTop=node.scrollHeight; node.dispatchEvent(new Event('scroll')); })()`);
  await frames();
  const screenshotState = await state();
  check('截图时在飞轮次的三段正文各只出现一次', screenshotState.prefix === 1 && screenshotState.middle === 1 && screenshotState.tail === 1 && screenshotState.live === 1, `prefix=${screenshotState.prefix} middle=${screenshotState.middle} tail=${screenshotState.tail} live=${screenshotState.live}`);
  const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(screenshotFile, Buffer.from(shot.data, 'base64'));

  const connectionsBeforeDrop = sessionConnections;
  const disconnect = await fetch(`http://127.0.0.1:${port}/api/test/disconnect`, { method: 'POST' });
  if (!disconnect.ok) throw new Error(`disconnect failed: ${disconnect.status}`);
  await waitFor(() => sessionStream === null, 'fake SSE did not disconnect');
  const disconnected = await waitFor(async () => {
    const value = await state();
    return value.connection.includes('未连接') ? value : null;
  }, 'session connection did not become disconnected');
  check('会话流断开后右栏状态变未连接', disconnected.connection.includes('○ 未连接'), `connection=${JSON.stringify(disconnected.connection)} notice=${JSON.stringify(disconnected.notice)}`);
  check('会话流状态栏保持 26px 单行与 3px 左槽', disconnected.connectionHeight === 26 && disconnected.connectionSlot === '3px', `height=${disconnected.connectionHeight}px slot=${disconnected.connectionSlot}`);
  const disconnectedShot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(disconnectedScreenshotFile, Buffer.from(disconnectedShot.data, 'base64'));
  currentMessages = [...baseMessages, { role: 'assistant', text: PREFIX + MIDDLE + TAIL }];
  sessionStreaming = false; // session.end happened while the browser was offline, so no end event is delivered.
  const readsBeforeReconnect = messageReads;
  await waitFor(() => sessionConnections > connectionsBeforeDrop, 'EventSource did not reconnect', 8000);
  await waitFor(async () => {
    const value = await state();
    return messageReads > readsBeforeReconnect && value.live === 0 && value.prefix === 1 && value.middle === 1 && value.tail === 1 && value.notice.includes('回复完成');
  }, 'reconnect snapshot did not reconcile the lost session.end', 8000);
  const ended = await state();
  check('断线期间落盘正文由重连 snapshot 自动补齐且不重复', ended.live === 0 && ended.prefix === 1 && ended.middle === 1 && ended.tail === 1, `connections=${sessionConnections} reads=${messageReads} live=${ended.live} prefix=${ended.prefix} middle=${ended.middle} tail=${ended.tail}`);
  check('断线期间丢失的 session.end 由 snapshot 收敛', ended.notice.includes('回复完成'), `notice=${JSON.stringify(ended.notice)}`);
  check('会话流重连后右栏状态回到已连接', ended.connection.includes('● 已连接'), `connection=${JSON.stringify(ended.connection)}`);

  const localQueue = { steering: ['本地旧 steering', '重连保留且不重复'], followUp: ['本地旧 followUp'] };
  await emit('session.queue', localQueue);
  await waitFor(async () => (await state()).queueItems.length === 3, 'local queue did not render before disconnect');
  const queueConnectionsBeforeDrop = sessionConnections;
  const queueDisconnect = await fetch(`http://127.0.0.1:${port}/api/test/disconnect`, { method: 'POST' });
  if (!queueDisconnect.ok) throw new Error(`queue disconnect failed: ${queueDisconnect.status}`);
  await waitFor(() => sessionStream === null, 'queue reconciliation SSE did not disconnect');
  const reconciledQueue = { steering: ['重连保留且不重复'], followUp: ['断线期间新增 followUp'] };
  await fetch(`http://127.0.0.1:${port}/api/test/snapshot-queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queue: reconciledQueue }),
  });
  await waitFor(() => sessionConnections > queueConnectionsBeforeDrop, 'queue reconciliation EventSource did not reconnect', 8000);
  const restoredQueue = await waitFor(async () => {
    const value = await state();
    return value.queueItems.length === 2 && value.queueText.includes('断线期间新增 followUp') ? value : null;
  }, 'reconnect snapshot did not restore queue contents', 8000);
  check('断线期间丢失的 queue_update 由 snapshot 逐字复原', restoredQueue.queueItems[0].text === 'steer：重连保留且不重复' && restoredQueue.queueItems[1].text === 'follow-up：断线期间新增 followUp', JSON.stringify(restoredQueue.queueItems));
  check('snapshot 以覆盖语义替换本地队列且不重复', restoredQueue.queueItems.length === 2 && !restoredQueue.queueText.includes('本地旧'), `items=${JSON.stringify(restoredQueue.queueItems)}`);
  check('重连队列继续使用共享 3px 左槽', restoredQueue.queueSlot === '3px', `slot=${restoredQueue.queueSlot}`);
  const queueShot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(queueScreenshotFile, Buffer.from(queueShot.data, 'base64'));

  const noQueueConnectionsBeforeDrop = sessionConnections;
  const noQueueDisconnect = await fetch(`http://127.0.0.1:${port}/api/test/disconnect`, { method: 'POST' });
  if (!noQueueDisconnect.ok) throw new Error(`no-queue disconnect failed: ${noQueueDisconnect.status}`);
  await waitFor(() => sessionStream === null, 'no-queue SSE did not disconnect');
  await fetch(`http://127.0.0.1:${port}/api/test/snapshot-queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ include: false }),
  });
  await waitFor(() => sessionConnections > noQueueConnectionsBeforeDrop, 'no-queue EventSource did not reconnect', 8000);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const queueAfterMissingField = await state();
  check('snapshot 缺少 queue 字段时保持现有显示不清空', JSON.stringify(queueAfterMissingField.queueItems) === JSON.stringify(restoredQueue.queueItems), `before=${JSON.stringify(restoredQueue.queueItems)} after=${JSON.stringify(queueAfterMissingField.queueItems)}`);

  await evaluate(`document.querySelector('[data-session-id="${staleSessionId}"] .tree-select').click()`);
  await waitFor(async () => (await state()).connection.includes('● 已连接'), 'stale session stream did not connect');
  await evaluate(`(() => { fetch('/api/test/disconnect?id=${staleSessionId}', {method:'POST'}); document.querySelector('[data-session-id="${sessionId}"] .tree-select').click(); })()`);
  await waitFor(async () => (await state()).title === 'H-05 直播去重' && (await state()).connection.includes('● 已连接'), 'new session stream did not connect after switch');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterOldDisconnect = await state();
  check('切会话期间旧流断开不污染新会话连接状态', afterOldDisconnect.title === 'H-05 直播去重' && afterOldDisconnect.connection.includes('● 已连接'), `title=${JSON.stringify(afterOldDisconnect.title)} connection=${JSON.stringify(afterOldDisconnect.connection)}`);

  await evaluate(`document.querySelector('[data-session-id="${staleSessionId}"] .tree-select').click()`);
  await waitFor(() => staleMessageReads > 0, 'stale session messages request did not start');
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(async () => (await state()).title === 'H-05 直播去重', 'new session did not win request race');
  await new Promise((resolve) => setTimeout(resolve, 650));
  const afterRace = await state();
  check('旧会话迟到响应不覆盖新会话', afterRace.title === 'H-05 直播去重' && afterRace.stale === 0 && afterRace.prefix === 1, `title=${JSON.stringify(afterRace.title)} stale=${afterRace.stale} prefix=${afterRace.prefix}`);
  // ── 「我刚发出去的那条」：发送后立刻出现，正文一到就按 (role,text) 去重 ──
  // 修的正是用户 2026-09-20 报的现象：v2.2 只在 snapshot/end/compaction_end 重拉正文，所以
  // 「刚发出去的那条」要等**整轮跑完**才出现。这里用一条**慢假上游**同时量出两件事：
  //   · submit → 占位可见（修后）；
  //   · submit → 这条落进正文（修前唯一能看到它的时刻，≈ 整轮时长）。
  const pendingScreenshotFile = path.join(artifactRoot, 'pending-user-echo-1200x760.png');
  async function countOf(needle) {
    return evaluate(`(document.querySelector('#messages').textContent.split(${JSON.stringify(needle)}).length-1)`);
  }
  await emit('session.start');
  // 计时全在浏览器里做（Node 侧的 emit 只负责“这一轮跑得慢”）。两个计时都从“按下发送”之前起。
  const echoProbe = evaluate(`(async () => {
    const needle = ${JSON.stringify(ECHO_STEER)};
    const root = document.querySelector('#messages');
    const waitForNode = (selector, budgetMs) => new Promise((resolve) => {
      const started = performance.now();
      const tick = () => {
        const hit = Array.from(root.querySelectorAll(selector)).find((node) => node.textContent.includes(needle));
        if (hit) return resolve({ ms: Math.round(performance.now() - started), node: hit });
        if (performance.now() - started > budgetMs) return resolve({ ms: Infinity, node: null });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const prompt = document.querySelector('#prompt');
    prompt.value = needle;
    prompt.dispatchEvent(new Event('input'));
    const historyWait = waitForNode('[data-kind="message"][data-role="user"]', 20000);
    document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }));
    const pending = await waitForNode('[data-pending]', 8000);
    const historyAtPending = Array.from(root.querySelectorAll('[data-kind="message"][data-role="user"]')).some((node) => node.textContent.includes(needle));
    const dist = Math.round(root.scrollHeight - root.scrollTop - root.clientHeight);
    const history = await historyWait;
    return {
      submitToPendingMs: pending.ms,
      submitToHistoryMs: history.ms,
      pendingText: pending.node ? pending.node.querySelector('.message-body').textContent : null,
      historyAtPending,
      distAfterPending: dist,
      historyRole: history.node ? history.node.dataset.role : null,
    };
  })()`);
  const slowStarted = Date.now();
  let slowChunks = 0;
  while (Date.now() - slowStarted < SLOW_TURN_MS) {
    await emit('session.delta', { channel: 'text', delta: `H06-慢轮次第 ${slowChunks += 1} 片。` });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const duringTurn = await waitFor(async () => {
    const value = await state();
    return value.pending.length === 1 ? value : null;
  }, 'pending user echo did not appear while the turn was still running');
  check('流式中发送：占位立刻出现，且不冒充“排队中”（pi 的队列事实还没到）', duringTurn.pending[0].state === 'sent' && duringTurn.pending[0].role.includes('已发送') && wireText(duringTurn.pending[0].body) === wireText(ECHO_STEER) && (await countOf(ECHO_STEER)) === 1, JSON.stringify(duringTurn.pending[0]));

  // pi 的队列事实到了：占位从「已发送」翻成「排队中（steering）」
  await emit('session.queue', { steering: [ECHO_STEER], followUp: [] });
  const queuedEcho = await waitFor(async () => {
    const value = await state();
    return value.pending[0]?.state === 'queued' ? value : null;
  }, 'queue fact did not reach the pending echo');
  check('占位标注抄 pi 的队列事实：排队中 · steering + 说清何时注入', queuedEcho.pending[0].queue === 'steering' && queuedEcho.pending[0].role.includes('排队中') && queuedEcho.pending[0].note.includes('还没进模型上下文'), `${queuedEcho.pending[0].role} / ${queuedEcho.pending[0].note}`);
  check('排队中的占位用等待态槽色（与 #queue-status 同一个 warning 槽）', queuedEcho.pending[0].slot === 'rgb(216, 180, 90)' && queuedEcho.queueSlot === '3px', `slot=${queuedEcho.pending[0].slot} queueSlot=${queuedEcho.queueSlot}`);

  // 连续两条待处理（steering + followUp）：各留一个占位，顺序 = 发送顺序
  await evaluate(`(() => { const p=document.querySelector('#prompt'); p.value=${JSON.stringify(ECHO_FOLLOWUP)}; p.dispatchEvent(new Event('input')); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, cancelable: true, bubbles: true })); })()`);
  await waitFor(async () => (await state()).pending.length === 2, 'follow-up echo did not appear next to the steer echo');
  await emit('session.queue', { steering: [ECHO_STEER], followUp: [ECHO_FOLLOWUP] });
  const twoQueued = await waitFor(async () => {
    const value = await state();
    return value.pending.length === 2 && value.pending.every((item) => item.state === 'queued') ? value : null;
  }, 'two pending messages did not both show queue facts');
  const twoCounts = { steer: await countOf(ECHO_STEER), followUp: await countOf(ECHO_FOLLOWUP) };
  check('连续两条待处理各一个占位、顺序=发送顺序、各只出现一次', twoQueued.pending[0].queue === 'steering' && twoQueued.pending[1].queue === 'followUp' && wireText(twoQueued.pending[0].body) === wireText(ECHO_STEER) && wireText(twoQueued.pending[1].body) === wireText(ECHO_FOLLOWUP) && twoCounts.steer === 1 && twoCounts.followUp === 1, `${JSON.stringify(twoQueued.pending.map((item) => item.queue))} counts=${JSON.stringify(twoCounts)}`);
  const pendingShot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(pendingScreenshotFile, Buffer.from(pendingShot.data, 'base64'));

  // 正文那一发到了（我发的插话已经落盘）：占位按 (role,text) 去重消失，同句只出现一次
  currentMessages = [...currentMessages, { role: 'assistant', text: 'H06-慢轮次前半段。' }, { role: 'user', text: ECHO_STEER }];
  const readsBeforeEchoConfirm = messageReads;
  await emit('session.snapshot', { isStreaming: true, isCompacting: false, isRetrying: false });
  await waitFor(async () => messageReads > readsBeforeEchoConfirm && (await state()).pending.length === 1, 'history arrival did not retire the confirmed echo');
  const echoConfirmed = await state();
  const steerAfterConfirm = await countOf(ECHO_STEER);
  check('正文一到，占位消失 —— 同一句在消息区只出现一次（不是两条）', echoConfirmed.pending.length === 1 && wireText(echoConfirmed.pending[0].body) === wireText(ECHO_FOLLOWUP) && steerAfterConfirm === 1, `pending=${JSON.stringify(echoConfirmed.pending.map((item) => item.body))} steerCount=${steerAfterConfirm}`);
  check('还没落盘的 followUp 占位不受影响（仍标排队中）', echoConfirmed.pending[0].state === 'queued', echoConfirmed.pending[0].role);

  // 这一轮结束：两条都被正文接管，占位全清
  currentMessages = [...currentMessages, { role: 'assistant', text: 'H06-慢轮次收尾。' }, { role: 'user', text: ECHO_FOLLOWUP }];
  await emit('session.end', { stopReason: 'stop' });
  // 真实服务端在一轮 run 结束时先发 session.end（每条 assistant 消息的结束），再在 pi 的
  // agent_settled 那一刻发 session.settled（**run** 结束 = 真的空闲）。夹具以前只发 end，
  // 前端现在拿 session.settled 判空闲，所以这里必须照实补上（否则这轮永远算「还在跑」）。
  await emit('session.settled', {});
  await waitFor(async () => (await state()).pending.length === 0, 'turn end did not retire every confirmed echo');
  const settledEcho = await state();
  const settledCounts = { steer: await countOf(ECHO_STEER), followUp: await countOf(ECHO_FOLLOWUP) };
  check('轮次结束：占位清零、两句各只出现一次（没有留下重复的一条）', settledEcho.pending.length === 0 && settledEcho.live === 0 && settledCounts.steer === 1 && settledCounts.followUp === 1, `pending=${settledEcho.pending.length} live=${settledEcho.live} counts=${JSON.stringify(settledCounts)}`);

  const echoNumbers = await echoProbe;
  check('发送 → 我的消息可见：修后 ≈ 一帧（慢假上游这一轮 ' + SLOW_TURN_MS + 'ms）', echoNumbers.submitToPendingMs <= ECHO_PENDING_BUDGET_MS && wireText(echoNumbers.pendingText) === wireText(ECHO_STEER) && echoNumbers.historyAtPending === false, JSON.stringify(echoNumbers));
  check('同一句落进正文（修前唯一能看到它的时刻）≈ 整轮时长', echoNumbers.submitToHistoryMs >= SLOW_TURN_MS * 0.8 && echoNumbers.submitToHistoryMs > echoNumbers.submitToPendingMs * 4 && echoNumbers.historyRole === 'user', JSON.stringify(echoNumbers));
  check('发送后视口贴底（刚发出的那条看得见）', echoNumbers.distAfterPending <= 8, `距底=${echoNumbers.distAfterPending}px`);

  // 被拒（409）：占位只在 POST 2xx 之后才建 ⇒ 一次都不该出现
  await evaluate(`(() => { const p=document.querySelector('#prompt'); p.value=${JSON.stringify(ECHO_REFUSED)}; p.dispatchEvent(new Event('input')); document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); })()`);
  const refused = await waitFor(async () => {
    const value = await state();
    return value.notice.includes('失败') && value.notice.includes('409') ? value : null;
  }, 'refused send did not surface an honest notice');
  const refusedCount = await countOf(ECHO_REFUSED);
  check('发送被拒（HTTP 409）：不留占位，只留诚实的失败提示', refused.pending.length === 0 && refusedCount === 0 && refused.notice.includes('409'), `notice=${JSON.stringify(refused.notice)} count=${refusedCount}`);

  // 命令（/model /cwd）：pi 会在服务端再解释这段文本 ⇒ 客户端不画占位（画了也兑不掉）
  const deliveredBeforeCommands = delivered.length;
  await evaluate(`(() => { const p=document.querySelector('#prompt'); p.value='/model fake-model'; p.dispatchEvent(new Event('input')); document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); })()`);
  await waitFor(() => (switchedModels.includes('fake-model') ? true : null), '/model did not reach the session model route');
  await frames();
  const afterModelCommand = await state();
  check('/model 命令不画占位（走会话模型入口，不是一条 user 正文）', afterModelCommand.pending.length === 0 && delivered.length === deliveredBeforeCommands, `pending=${afterModelCommand.pending.length} delivered+${delivered.length - deliveredBeforeCommands}`);
  await evaluate(`(() => { const p=document.querySelector('#prompt'); p.value='/cwd'; p.dispatchEvent(new Event('input')); document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); })()`);
  await waitFor(() => (delivered.length > deliveredBeforeCommands ? true : null), '/cwd was not posted as a prompt');
  await frames();
  const afterCwdCommand = await state();
  check('扩展命令（pi 直接吃掉、不会变成 user 正文）也不画占位', afterCwdCommand.pending.length === 0 && delivered.at(-1).text === '/cwd', `pending=${afterCwdCommand.pending.length} delivered=${JSON.stringify(delivered.at(-1))}`);

  // mention：占位与请求里那一份必须是 resolveForSend 之后的最终文本（框里的字 != 发出去的字）
  const deliveredBeforeMention = delivered.length;
  await evaluate(`(() => { const p=document.querySelector('#prompt'); p.value=${JSON.stringify(ECHO_MENTION_INPUT)}; p.dispatchEvent(new Event('input')); document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); })()`);
  await waitFor(() => (delivered.length > deliveredBeforeMention ? true : null), 'mention message was not posted');
  const mentionEcho = await waitFor(async () => {
    const value = await state();
    return value.pending.length === 1 ? value : null;
  }, 'mention echo did not appear');
  const mentionPosted = delivered.at(-1);
  check('mention 展开后的最终文本 = 请求里那一份 = 占位里那一份', mentionPosted.text !== ECHO_MENTION_INPUT && mentionPosted.text.includes(mentionSessionId) && wireText(mentionEcho.pending[0].body) === wireText(mentionPosted.text) && mentionEcho.pending[0].body.includes(ECHO_MENTION_NEEDLE), JSON.stringify({ posted: mentionPosted.text, pending: mentionEcho.pending[0].body }));
  currentMessages = [...currentMessages, { role: 'user', text: mentionPosted.text }];
  const readsBeforeMentionConfirm = messageReads;
  await emit('session.snapshot', { isStreaming: false, isCompacting: false, isRetrying: false });
  await waitFor(async () => messageReads > readsBeforeMentionConfirm && (await state()).pending.length === 0, 'mention history did not retire its echo');
  const mentionSettled = await state();
  const mentionCount = await countOf(ECHO_MENTION_NEEDLE);
  check('mention 那条落进正文后占位消失、只出现一次', mentionSettled.pending.length === 0 && mentionCount === 1, `pending=${mentionSettled.pending.length} count=${mentionCount}`);

  // 换会话：占位必须立刻清空，不许跟到别的会话
  await evaluate(`(() => { const p=document.querySelector('#prompt'); p.value=${JSON.stringify(ECHO_SWITCH)}; p.dispatchEvent(new Event('input')); document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); })()`);
  await waitFor(async () => (await state()).pending.length === 1, 'switch-case echo did not appear');
  await evaluate(`document.querySelector('[data-session-id="${staleSessionId}"] .tree-select').click()`);
  await waitFor(async () => (await state()).title === 'U-11 迟到请求', 'switch to the other session did not happen');
  const switchedAway = await state();
  const switchedAwayCount = await countOf(ECHO_SWITCH);
  check('切走会话：占位立刻清空（不跟到别的会话）', switchedAway.pending.length === 0 && switchedAwayCount === 0, `pending=${switchedAway.pending.length} count=${switchedAwayCount}`);
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(async () => (await state()).title === 'H-05 直播去重', 'switch back did not happen');
  await frames();
  const switchedBack = await state();
  const switchedBackCount = await countOf(ECHO_SWITCH);
  check('切回原会话也不残留占位（正文里本来就没有它）', switchedBack.pending.length === 0 && switchedBackCount === 0, `pending=${switchedBack.pending.length} count=${switchedBackCount}`);

  // 断线重连：重连快照重拉正文 ⇒ 已经落盘的占位必须收敛（不许残留）
  await evaluate(`(() => { const p=document.querySelector('#prompt'); p.value=${JSON.stringify(ECHO_RECONNECT)}; p.dispatchEvent(new Event('input')); document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); })()`);
  await waitFor(async () => (await state()).pending.length === 1, 'reconnect-case echo did not appear');
  const connectionsBeforeReconnect = sessionConnections;
  const reconnectDrop = await fetch(`http://127.0.0.1:${port}/api/test/disconnect`, { method: 'POST' });
  if (!reconnectDrop.ok) throw new Error(`reconnect disconnect failed: ${reconnectDrop.status}`);
  await waitFor(() => sessionStream === null, 'reconnect-case SSE did not disconnect');
  currentMessages = [...currentMessages, { role: 'user', text: ECHO_RECONNECT }]; // 断线期间落盘
  await waitFor(() => sessionConnections > connectionsBeforeReconnect, 'EventSource did not reconnect after the echo send', 8000);
  const reconnectSettled = await waitFor(async () => {
    const value = await state();
    return value.pending.length === 0 ? value : null;
  }, 'reconnect snapshot did not retire the confirmed echo', 8000);
  const reconnectCount = await countOf(ECHO_RECONNECT);
  check('断线重连：重连快照重拉正文后，已落盘的占位收敛、只出现一次', reconnectSettled.pending.length === 0 && reconnectCount === 1 && reconnectSettled.connection.includes('● 已连接'), `pending=${reconnectSettled.pending.length} count=${reconnectCount} connection=${JSON.stringify(reconnectSettled.connection)}`);

  check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));

  print('关键计数', { duringRefresh: deduped, afterDelta, scrolledBefore: scrolled, scrolledAfter: refreshedAway, streamingShot, screenshotState, ended, afterRace, messageReads, staleMessageReads, sessionConnections });
  print('待发回显时延', { probe: echoNumbers, slowTurnMs: SLOW_TURN_MS, budgetMs: ECHO_PENDING_BUDGET_MS, duringTurn: duringTurn.pending, queued: twoQueued.pending });
  print('screenshots', { streaming: screenshotFile, disconnected: disconnectedScreenshotFile, reconnectQueue: queueScreenshotFile, pendingEcho: pendingScreenshotFile });
  print('chromium', { product: version.Browser, executable: chrome, viewport: '1200x760', forbiddenPortsUsed: false });
  print('checks', checks);
  print('RESULT', 'live dedup contract PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  browser?.close();
  treeStream?.destroy();
  sessionStream?.destroy();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await new Promise((resolve) => chromium.once('exit', resolve));
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
