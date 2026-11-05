import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, quiesceCdpPage, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'compact-ui-'));
const sessionId = '66666666-6666-4666-8666-666666666666';
const coldSessionId = '77777777-7777-4777-8777-777777777777';
const disabledSessionId = '88888888-8888-4888-8888-888888888888';
const screenshots = {
  disabled: path.join(os.tmpdir(), 'sopho-compact-disabled-1200x760.png'),
  confirm: path.join(os.tmpdir(), 'sopho-compact-confirm-1200x760.png'),
  boundary: path.join(os.tmpdir(), 'sopho-compact-boundary-1200x760.png'),
};
const requests = [];
const clients = new Set();
let compacting = false;
let messagesPayload = {
  messages: [
    { role: 'user', text: '压缩前的历史', parts: [{ type: 'text', text: '压缩前的历史' }] },
    { role: 'assistant', text: '压缩前的回答', parts: [{ type: 'text', text: '压缩前的回答' }] },
  ],
  extras: [],
  compaction: { atIndex: null, note: '正文列表 ≠ 模型现在看得见的东西' },
  observability: null,
};
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
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function broadcast(event, data) {
  for (const response of clients) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

async function screenshot(file) {
  const result = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(file, Buffer.from(result.data, 'base64'));
}

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions: [
      { id: sessionId, name: '压缩契约会话', status: compacting ? 'working' : 'idle', statusLabel: compacting ? '工作中' : '闲置', archived: false, parentId: null, context: { freeTokens: 700, compactionEnabled: true } },
      { id: disabledSessionId, name: '自动压缩已关', status: 'idle', statusLabel: '闲置', archived: false, parentId: null, context: { freeTokens: 700, compactionEnabled: false } },
      { id: coldSessionId, name: '冷会话', status: 'idle', statusLabel: '闲置', archived: false, parentId: null, context: null },
    ] });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: [] })}\n\n`);
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) {
      return sendJson(response, 200, {
        name: '压缩契约会话',
        runtime: { isStreaming: false, isCompacting: compacting, isRetrying: false },
        observability: null,
        context: { modelId: 'fake-compact', provider: 'fake', usedTokens: 3000, thresholdTokens: 3700, freeTokens: 700, contextWindow: 4096, reserveTokens: 396, keepRecentTokens: 128, compactionEnabled: true },
      });
    }
    if (url.pathname === `/api/sessions/${disabledSessionId}`) {
      return sendJson(response, 200, {
        name: '自动压缩已关',
        runtime: { isStreaming: false, isCompacting: false, isRetrying: false },
        observability: null,
        context: { modelId: 'fake-compact', provider: 'fake', usedTokens: 3000, thresholdTokens: 3700, freeTokens: 700, contextWindow: 4096, reserveTokens: 396, keepRecentTokens: 128, compactionEnabled: false },
      });
    }
    if (url.pathname === `/api/sessions/${coldSessionId}`) {
      return sendJson(response, 200, {
        name: '冷会话',
        runtime: { isStreaming: false, isCompacting: false, isRetrying: false },
        observability: null,
        context: null,
      });
    }
    if ([sessionId, disabledSessionId, coldSessionId].some((id) => url.pathname === `/api/sessions/${id}/messages`)) return sendJson(response, 200, messagesPayload);
    if ([sessionId, disabledSessionId, coldSessionId].some((id) => url.pathname === `/api/sessions/${id}/draft`)) {
      if (request.method === 'GET') return sendJson(response, 200, { text: '', at: null });
      if (request.method === 'PUT') return sendJson(response, 200, { text: '', at: null });
    }
    if ([sessionId, disabledSessionId, coldSessionId].some((id) => url.pathname === `/api/sessions/${id}/commands`)) {
      return sendJson(response, 200, { commands: [{ name: 'compact', source: 'builtin', runnable: true, via: 'compact' }], streaming: false, compacting: url.pathname.includes(sessionId) && compacting });
    }
    if ([sessionId, disabledSessionId, coldSessionId].some((id) => url.pathname === `/api/sessions/${id}/events`)) {
      const selectedCompacting = url.pathname.includes(sessionId) && compacting;
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: selectedCompacting, isRetrying: false })}\n\n`);
      clients.add(response);
      response.once('close', () => clients.delete(response));
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}/compact` && request.method === 'POST') {
      const body = await bodyOf(request);
      requests.push({ action: 'compact', body });
      compacting = true;
      sendJson(response, 202, { accepted: true, sessionId });
      broadcast('session.compaction_start', { type: 'compaction_start' });
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}/message` && request.method === 'POST') {
      requests.push({ action: 'message', body: await bodyOf(request) });
      return sendJson(response, compacting ? 409 : 202, compacting
        ? { error: 'session_compacting', message: 'Cannot submit a prompt while compaction is in progress.' }
        : { accepted: true });
    }
    if (url.pathname === '/control/complete' && request.method === 'POST') {
      compacting = false;
      messagesPayload = {
        messages: [
          { role: 'assistant', text: '压缩摘要后的上下文', parts: [{ type: 'text', text: '压缩摘要后的上下文' }] },
          { role: 'user', text: '保留的最近消息', parts: [{ type: 'text', text: '保留的最近消息' }] },
        ],
        extras: [],
        compaction: {
          atIndex: 1,
          timestamp: '2026-09-17T08:30:00.000Z',
          summary: '这是服务端落盘的压缩摘要。',
          tokensBefore: 3000,
          note: '正文列表 ≠ 模型现在看得见的东西',
        },
        observability: null,
      };
      sendJson(response, 200, { ok: true });
      broadcast('session.compaction_end', { type: 'compaction_end' });
      return;
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
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
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1200,760', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
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
  await waitFor(() => evaluate(`document.querySelector('#compact').disabled === false`), 'compact button did not enable');

  const initial = await evaluate(`(() => { const b=document.querySelector('#compact'); const s=getComputedStyle(b); return {text:b.textContent,slot:s.borderInlineStartWidth,slotColor:s.borderInlineStartColor,usage:document.querySelector('#session-usage').textContent}; })()`);
  assert.equal(initial.text, '✂ 压缩');
  assert.equal(initial.slot, '3px');
  assert.ok(initial.usage.includes('距压缩阈值还剩 700 tokens'), initial.usage);
  print('chromium enabled compaction wording', initial);

  await evaluate(`document.querySelector('[data-session-id="${disabledSessionId}"]').click()`);
  const disabledUsage = await waitFor(async () => {
    const value = await evaluate(`document.querySelector('#session-usage').textContent`);
    return value.includes('自动压缩已关') ? value : null;
  }, 'disabled compaction wording missing');
  assert.ok(disabledUsage.includes('距压缩边界还剩 700（自动压缩已关）'), disabledUsage);
  assert.ok(!disabledUsage.includes('距压缩阈值还剩 700 tokens'), disabledUsage);
  await screenshot(screenshots.disabled);
  print('chromium disabled compaction wording', { usage: disabledUsage, screenshot: screenshots.disabled });

  await evaluate(`document.querySelector('[data-session-id="${coldSessionId}"]').click()`);
  const coldUsage = await waitFor(async () => {
    const value = await evaluate(`document.querySelector('#session-usage').textContent`);
    return value.includes('服务端未提供') ? value : null;
  }, 'cold session did not show unknown context usage');
  assert.doesNotMatch(coldUsage, /还剩 [\d,]+ tokens/);
  print('chromium cold context assertion', { usage: coldUsage });
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#session-usage').textContent.includes('还剩 700 tokens') && document.querySelector('#compact').disabled === false`), 'hot session context did not return after cold selection');

  await evaluate(`document.querySelector('#compact').click()`);
  const confirm = await waitFor(async () => {
    const value = await evaluate(`({hidden:document.querySelector('#compact-confirm').hidden,text:document.querySelector('#compact-confirm-text').textContent})`);
    return value.hidden ? null : value;
  }, 'confirmation did not open');
  assert.match(confirm.text, /有损.*不能撤销/);
  assert.match(confirm.text, /服务端报告当前用了 3,000 tokens/);
  assert.equal(requests.length, 0);
  await screenshot(screenshots.confirm);
  print('confirmation before POST', { ...confirm, requests: requests.length, screenshot: screenshots.confirm });

  await evaluate(`document.querySelector('#compact-confirm-no').click()`);
  await waitFor(() => evaluate(`document.querySelector('#compact-confirm').hidden === true`), 'cancel did not close confirmation');
  assert.equal(requests.length, 0);
  print('cancel sends no request', { requests: requests.length, notice: await evaluate(`document.querySelector('#notice').textContent`) });

  await evaluate(`document.querySelector('#compact').click()`);
  await waitFor(() => evaluate(`document.querySelector('#compact-confirm').hidden === false`), 'second confirmation did not open');
  await evaluate(`document.querySelector('#compact-confirm-yes').click()`);
  await waitFor(() => requests.some((entry) => entry.action === 'compact'), 'confirmed compact POST missing');
  const during = await waitFor(async () => {
    const value = await evaluate(`({button:document.querySelector('#compact').textContent,disabled:document.querySelector('#compact').disabled,notice:document.querySelector('#notice').textContent})`);
    return value.button.includes('压缩中') ? value : null;
  }, 'compacting feedback missing');
  assert.equal(during.disabled, true);

  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='压缩窗口里不能排队'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
  const refused = await waitFor(async () => {
    const value = await evaluate(`({input:document.querySelector('#prompt').value,notice:document.querySelector('#notice').textContent})`);
    return value.notice.includes('没有发送也没有排队') ? value : null;
  }, 'send during compaction was not visibly refused');
  assert.equal(refused.input, '压缩窗口里不能排队');
  assert.equal(requests.filter((entry) => entry.action === 'message').length, 0);
  print('send refused during compaction', { ...refused, messagePosts: 0 });

  await fetch(`http://127.0.0.1:${port}/control/complete`, { method: 'POST' });
  const boundary = await waitFor(async () => {
    const value = await evaluate(`({notice:document.querySelector('#notice').textContent,boundary:document.querySelector('.compaction-note')?.textContent,summary:document.querySelector('.compaction-summary')?.textContent,button:document.querySelector('#compact').textContent})`);
    return value.boundary?.includes('✂ 压缩边界 @ 1') ? value : null;
  }, 'compaction boundary did not render');
  assert.match(boundary.notice, /压缩完成/);
  assert.match(boundary.boundary, /2026/);
  assert.match(boundary.summary, /服务端落盘的压缩摘要/);
  assert.equal(boundary.button, '✂ 压缩');
  await screenshot(screenshots.boundary);
  print('compaction complete + boundary', { ...boundary, screenshot: screenshots.boundary });
  print('chromium', { product: version.Browser, chrome, viewport: '1200x760', forbiddenPortsUsed: false, port, debugPort });
  print('RESULT', 'compact UI PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  await quiesceCdpPage(browser);
  browser?.close();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await new Promise((resolve) => chromium.once('exit', resolve));
  }
  if (server) {
    for (const response of clients) response.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
