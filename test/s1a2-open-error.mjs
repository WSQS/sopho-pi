import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, quiesceCdpPage, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-open-error-'));
const ids = {
  normal: '11111111-1111-4111-8111-111111111111',
  broken: '22222222-2222-4222-8222-222222222222',
  disconnected: '33333333-3333-4333-8333-333333333333',
};
const sessions = [
  { id: ids.normal, name: '正常会话', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
  { id: ids.broken, name: '目录已删除的会话', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
  { id: ids.disconnected, name: '事件流断线会话', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
];
const missingCwd = '/home/user/code/ai/.sopho-wt/v2-2-netc';
let devicesVisible = false;
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

async function waitFor(fn, message, timeoutMs = 6000) {
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
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
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
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null } });
    if (url.pathname === '/api/devices') {
      return sendJson(response, 200, devicesVisible
        ? { exists: true, devices: [{ name: 'lab', host: 'lab.local', lastProbe: { ok: true } }] }
        : { exists: false, devices: [] });
    }
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return;
    }
    if (url.pathname === '/control/devices-on') {
      devicesVisible = true;
      return sendJson(response, 200, { ok: true });
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|events))?$/.exec(url.pathname);
    if (match) {
      const session = sessions.find((entry) => entry.id === match[1]);
      if (!session) return sendJson(response, 404, { message: 'missing' });
      if (session.id === ids.broken) {
        return sendJson(response, 500, { error: 'internal_error', message: `session cwd does not exist or is not a directory: ${missingCwd}` });
      }
      if (match[2] === 'messages') {
        return sendJson(response, 200, {
          messages: [{ role: 'user', text: '正常消息仍然可见' }, { role: 'assistant', text: '正常回复仍然可见' }],
          extras: [],
          compaction: { atIndex: null },
          observability: null,
        });
      }
      if (match[2] === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        if (session.id === ids.disconnected) setTimeout(() => response.destroy(), 80);
        return;
      }
      return sendJson(response, 200, { name: session.name, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
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
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const result = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return result?.ok ? result.json() : null;
  }, 'chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${port}/`, { method: 'PUT' })).json();
  browser = cdp(target.webSocketDebuggerUrl);
  await browser.ready;
  const exceptions = [];
  const consoleErrors = [];
  browser.on('Runtime.exceptionThrown', (event) => exceptions.push(event));
  browser.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') consoleErrors.push(event.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
  });
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${ids.broken}"]') !== null`), 'tree did not render');
  exceptions.length = 0;
  consoleErrors.length = 0;

  assert.equal(await evaluate(`document.querySelector('#device-panel').hidden`), true);
  print('empty devices hidden', { exists: false, hidden: true });

  await evaluate(`document.querySelector('[data-session-id="${ids.broken}"]').click()`);
  exceptions.length = 0;
  consoleErrors.length = 0;
  const failed = await waitFor(async () => {
    const value = await evaluate(`({title:document.querySelector('#session-title').textContent,notice:document.querySelector('#notice').textContent,promptDisabled:document.querySelector('#prompt').disabled,sendDisabled:document.querySelector('#send').disabled,abortDisabled:document.querySelector('#abort').disabled,messages:document.querySelectorAll('#messages .message').length})`);
    return value.notice.includes('工作目录') ? value : null;
  }, 'permanent open failure was not shown');
  assert.match(failed.notice, /工作目录.*已不存在/);
  assert.match(failed.notice, /v2-2-netc/);
  assert.doesNotMatch(failed.notice, /浏览器会自动重连/);
  assert.equal(failed.title, '目录已删除的会话（打不开）');
  assert.notEqual(failed.title, ids.broken);
  assert.equal(failed.promptDisabled, true);
  assert.equal(failed.sendDisabled, true);
  assert.equal(failed.abortDisabled, true);
  assert.equal(failed.messages, 0);
  print('permanent open failure is honest', failed);

  await evaluate(`document.querySelector('[data-session-id="${ids.normal}"]').click()`);
  exceptions.length = 0;
  consoleErrors.length = 0;
  await waitFor(async () => {
    const value = await evaluate(`({title:document.querySelector('#session-title').textContent,text:document.querySelector('#messages').textContent,promptDisabled:document.querySelector('#prompt').disabled,sendDisabled:document.querySelector('#send').disabled})`);
    return value.text.includes('正常回复仍然可见') ? value : null;
  }, 'normal session did not render');
  // 稳定读点（本机实测 3/3 红，旧写法读在 :232）：换会话是**异步**的 —— 详情 → 首屏 → 草稿 →
  // 才 `setComposerAvailable(true)` 把输入框打开。上面那个 waitFor 只等「正文里有那句话」，
  // 而首屏文字落下的那一刻 `#prompt` 仍是 disabled（实测：正文落下后 ~61ms 才开）⇒ 断言读得太早。
  // 这里补一个**有上界**的稳定等待：等到这个会话的打开流程真的收尾（输入框与发送键都可用）
  // 再读下来断言。到点还没开 = 一条明确的红（`waitFor` 抛错带最后读数），不会静默挂住；
  // 下面的断言一条没删、阈值一字未放宽，只是不再抢在异步收尾之前读。
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false && document.querySelector('#send').disabled === false`), 'normal session composer never enabled (session open flow did not finish)');
  const settledNormal = await evaluate(`({title:document.querySelector('#session-title').textContent,text:document.querySelector('#messages').textContent,promptDisabled:document.querySelector('#prompt').disabled,sendDisabled:document.querySelector('#send').disabled})`);
  assert.equal(settledNormal.title, '正常会话');
  assert.equal(settledNormal.promptDisabled, false);
  assert.equal(settledNormal.sendDisabled, false);
  print('normal session still renders', settledNormal);

  await evaluate(`document.querySelector('[data-session-id="${ids.disconnected}"]').click()`);
  exceptions.length = 0;
  consoleErrors.length = 0;
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), 'disconnect session did not open before SSE cut');
  const disconnected = await waitFor(async () => {
    const text = await evaluate(`document.querySelector('#notice').textContent`);
    return text.includes('事件流或 worker 断开') ? text : null;
  }, 'real SSE disconnect was not shown');
  assert.match(disconnected, /浏览器会自动重连/);
  print('real SSE disconnect remains distinct', disconnected);
  exceptions.length = 0;
  consoleErrors.length = 0;

  assert.equal(exceptions.length, 0, `Runtime.exceptionThrown before reload: ${JSON.stringify(exceptions)}`);
  assert.deepEqual(consoleErrors, []);
  await fetch(`http://127.0.0.1:${port}/control/devices-on`);
  const reloaded = browser.once('Page.loadEventFired');
  await browser.send('Page.reload', { ignoreCache: true });
  await reloaded;
  // Reload deliberately destroys the old document while its SSE-triggered refresh may still
  // own a fetch. That navigation cancellation is outside either page's active lifetime.
  exceptions.length = 0;
  consoleErrors.length = 0;
  const device = await waitFor(async () => {
    const value = await evaluate(`({hidden:document.querySelector('#device-panel').hidden,text:document.querySelector('#devices').textContent})`);
    return value.text.includes('lab.local') ? value : null;
  }, 'non-empty devices panel did not render');
  assert.equal(device.hidden, false);
  print('non-empty devices visible', device);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(exceptions.length, 0, `Runtime.exceptionThrown: ${JSON.stringify(exceptions)}`);
  assert.deepEqual(consoleErrors, []);
  print('browser errors', { runtimeExceptions: exceptions.length, consoleErrors });
  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });
  print('RESULT', 'S1a-2 honest open error frontend PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  await quiesceCdpPage(browser);
  browser?.close();
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
