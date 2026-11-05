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
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-rich-frontend-'));
const sessionId = '22222222-2222-4222-8222-222222222222';
let browser;
let chromium;
let server;

const payload = {
  messages: [
    { role: 'user', text: '用户 **正文** <script>globalThis.pwned=true</script>' },
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: '# 结构化正文\n\n行内 `code`\n\n```html\n<img src=x onerror=globalThis.pwned=true>\n```' },
        { type: 'tool', name: 'bash', args: { command: 'sleep 1' }, status: 'running' },
        { type: 'tool', name: 'read', args: { path: 'ok.txt' }, status: 'done-success', result: 'read ok' },
        { type: 'tool', name: 'write', args: { path: 'bad.txt' }, status: 'done-error', result: 'permission denied', isError: true },
        { type: 'tool', name: 'edit', args: { path: 'half.txt' }, status: 'unfinished' },
      ],
    },
  ],
  extras: [{ customType: 'notify', text: 'extension body only', display: true }],
  compaction: { atIndex: 1, note: '正文列表 ≠ 模型现在看得见的东西' },
  observability: null,
};

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
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
      sendJson(response, 200, { sessions: [{ id: sessionId, name: 'Rich session', status: 'idle', statusLabel: '闲置', archived: false, parentId: null }] });
      return;
    }
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: [{ id: sessionId, name: 'Rich session', status: 'idle', statusLabel: '闲置', archived: false, parentId: null }] })}\n\n`);
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) return sendJson(response, 200, { name: 'Rich session', runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
    if (url.pathname === `/api/sessions/${sessionId}/messages`) return sendJson(response, 200, payload);
    if (url.pathname === `/api/sessions/${sessionId}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      return;
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
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
  if (process.env.SOPHO_GEOMETRY_MUTANT === 'narrow-user') {
    await waitFor(() => evaluate(`document.querySelector('.message-user') !== null`), 'geometry mutant target did not render');
    await evaluate(`document.querySelector('.message-user').style.cssText += '; width: calc(100% - 24px); margin-left: 24px'`);
  }
  const view = await waitFor(async () => {
    const value = await evaluate(`(() => {
      const tools = Array.from(document.querySelectorAll('.tool-card'));
      if (tools.length !== 4) return null;
      return {
        roles: Array.from(document.querySelectorAll('.message')).map((node) => node.dataset.role),
        states: tools.map((node) => node.dataset.state),
        colors: tools.map((node) => getComputedStyle(node).backgroundColor),
        code: document.querySelector('.code-block code')?.textContent,
        scripts: document.querySelectorAll('#messages script').length,
        pwned: globalThis.pwned === true,
        userText: document.querySelector('.message-user')?.textContent,
        extraKind: document.querySelector('.extra-message')?.dataset.kind,
        extraInsideAssistant: document.querySelector('.message-assistant .extra-message') !== null,
        compactionText: document.querySelector('.compaction-note')?.textContent,
        topKinds: Array.from(document.querySelector('#messages').children).map((node) => node.dataset.kind || node.className),
        geometry: (() => { const container=document.querySelector('#messages'); const style=getComputedStyle(container); const rect=container.getBoundingClientRect(); const paddingLeft=parseFloat(style.paddingLeft); const paddingRight=parseFloat(style.paddingRight); const left=rect.left+parseFloat(style.borderLeftWidth)+paddingLeft; const width=container.clientWidth-paddingLeft-paddingRight; const right=left+width; return ['.message-user','.message-assistant','.tool-card','.extra-message','.compaction-note'].map((selector)=>{const box=document.querySelector(selector).getBoundingClientRect();return {selector,left:box.left-left,right:right-box.right,width:box.width-width};}); })(),
        horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    })()`);
    return value?.states?.length === 4 ? value : null;
  }, 'rich messages did not render');

  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });
  assert.deepEqual(view.roles, ['user', 'assistant']);
  assert.deepEqual(view.states, ['running', 'done-success', 'done-error', 'unfinished']);
  assert.deepEqual(view.colors, ['rgb(40, 40, 50)', 'rgb(40, 50, 40)', 'rgb(60, 40, 40)', 'rgb(58, 50, 37)']);
  assert.equal(new Set(view.colors).size, 4);
  assert.equal(view.code, '<img src=x onerror=globalThis.pwned=true>');
  assert.equal(view.scripts, 0);
  assert.equal(view.pwned, false);
  assert.match(view.userText, /<script>globalThis\.pwned=true<\/script>/);
  assert.equal(view.extraKind, 'extra');
  assert.equal(view.extraInsideAssistant, false);
  assert.match(view.compactionText, /✂ 压缩边界 @ 1/);
  assert.deepEqual(view.topKinds.slice(0, 3), ['message', 'compaction', 'message']);
  assert.ok(view.geometry.every((row) => Math.abs(row.left) <= 1 && Math.abs(row.right) <= 1 && Math.abs(row.width) <= 2), JSON.stringify(view.geometry));
  assert.equal(view.horizontalScroll, false);
  print('rich DOM', view);
  print('RESULT', 'S1a-2 rich frontend PASS');
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
