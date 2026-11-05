import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-pane-layout-'));
const screenshotWide = path.join(os.tmpdir(), 'sopho-v22-pane-1200x760.png');
const screenshotNarrow = path.join(os.tmpdir(), 'sopho-v22-pane-420x820.png');
const ids = {
  first: '11111111-1111-4111-8111-111111111111',
  second: '22222222-2222-4222-8222-222222222222',
};
const sessions = [
  { id: ids.first, name: 'Pane fixture', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
  { id: ids.second, name: 'Switch target', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
];
const payload = {
  messages: [
    { role: 'user', text: '用户消息保留原有底色，但不再靠右。' },
    { role: 'assistant', parts: [
      { type: 'text', text: '助手消息与用户消息占用相同整行宽度。' },
      { type: 'tool', name: 'bash', args: { command: 'printf layout' }, status: 'done-success', result: 'layout ok' },
    ] },
  ],
  extras: [{ customType: 'pane.fixture', text: '扩展消息同样铺满整行', display: true }],
  compaction: { atIndex: 1, note: '压缩边界同样铺满整行' },
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

async function waitFor(operation, message, timeoutMs = 6000) {
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
  const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(file, Buffer.from(shot.data, 'base64'));
}

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0 } });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return;
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|commands|seen))?$/.exec(url.pathname);
    if (match) {
      const session = sessions.find((entry) => entry.id === match[1]);
      if (!session) return sendJson(response, 404, { message: 'missing' });
      if (match[2] === 'messages') return sendJson(response, 200, payload);
      if (match[2] === 'commands') return sendJson(response, 200, { streaming: false, commands: [] });
      if (match[2] === 'seen') return sendJson(response, 200, { ok: true });
      if (match[2] === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return;
      }
      return sendJson(response, 200, { name: session.name, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
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
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelectorAll('.tree-session').length === 2`), 'tree did not render');
  const disabledHeight = await evaluate(`(() => { const input=document.querySelector('#prompt'); const before=input.getBoundingClientRect().height; input.value=Array.from({length:40},()=> 'disabled').join('\\n'); input.dispatchEvent(new Event('input',{bubbles:true})); return {before,after:input.getBoundingClientRect().height,disabled:input.disabled}; })()`);
  assert.equal(disabledHeight.disabled, true);
  assert.ok(Math.abs(disabledHeight.after - disabledHeight.before) <= 1, JSON.stringify(disabledHeight));
  print('disabled composer stays collapsed px', disabledHeight);
  await evaluate(`document.querySelector('[data-session-id="${ids.first}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.tool-card') && document.querySelector('#prompt').disabled === false`), 'pane fixture did not render');

  const layout = await evaluate(`(() => {
    const messages=document.querySelector('#messages'); const style=getComputedStyle(messages); const rect=messages.getBoundingClientRect();
    const paddingLeft=parseFloat(style.paddingLeft); const paddingRight=parseFloat(style.paddingRight); const left=rect.left+parseFloat(style.borderLeftWidth)+paddingLeft; const width=messages.clientWidth-paddingLeft-paddingRight; const right=left+width;
    const selectors=['.message-user','.message-assistant','.tool-card','.extra-message','.compaction-note'];
    const rows=selectors.map((selector)=>{const node=document.querySelector(selector);const box=node.getBoundingClientRect();return {selector,left:box.left,right:box.right,width:box.width,alignSelf:getComputedStyle(node).alignSelf,leftDelta:box.left-left,rightDelta:right-box.right,widthDelta:box.width-width};});
    const main=document.querySelector('main'); const header=document.querySelector('main > header').getBoundingClientRect(); const body=messages.getBoundingClientRect(); const footer=document.querySelector('#composer').getBoundingClientRect();
    return {container:{left,right,width},rows,noHorizontalScroll:document.documentElement.scrollWidth<=document.documentElement.clientWidth&&document.body.scrollWidth<=document.body.clientWidth,order:{headerTop:header.top,messagesTop:body.top,footerTop:footer.top},main:{clientWidth:main.clientWidth,scrollWidth:main.scrollWidth},userBackground:getComputedStyle(document.querySelector('.message-user')).backgroundColor};
  })()`);
  for (const row of layout.rows) {
    assert.ok(Math.abs(row.leftDelta) <= 1, JSON.stringify(row));
    assert.ok(Math.abs(row.rightDelta) <= 1, JSON.stringify(row));
    assert.ok(Math.abs(row.widthDelta) <= 2, JSON.stringify(row));
    assert.notEqual(row.alignSelf, 'flex-end', JSON.stringify(row));
  }
  assert.equal(layout.noHorizontalScroll, true, JSON.stringify(layout));
  assert.ok(layout.main.scrollWidth <= layout.main.clientWidth, JSON.stringify(layout));
  assert.ok(layout.order.headerTop < layout.order.messagesTop && layout.order.messagesTop < layout.order.footerTop, JSON.stringify(layout.order));
  assert.equal(layout.userBackground, 'rgb(23, 27, 34)');
  print('message geometry px', layout);

  const heights = await evaluate(`(() => {
    const input=document.querySelector('#prompt'); const sample=(lines)=>{input.value=Array.from({length:lines},(_,index)=>'line '+index).join('\\n');input.dispatchEvent(new Event('input',{bubbles:true}));return {height:input.getBoundingClientRect().height,clientHeight:input.clientHeight,scrollHeight:input.scrollHeight,overflowY:getComputedStyle(input).overflowY};};
    return {resize:getComputedStyle(input).resize,maxHeight:parseFloat(getComputedStyle(input).maxHeight),one:sample(1),eight:sample(8),forty:sample(40)};
  })()`);
  assert.equal(heights.resize, 'none');
  assert.ok(heights.eight.height > heights.one.height, JSON.stringify(heights));
  assert.ok(heights.forty.height <= heights.maxHeight + 1, JSON.stringify(heights));
  assert.ok(heights.forty.scrollHeight > heights.forty.clientHeight, JSON.stringify(heights));
  assert.match(heights.forty.overflowY, /^(auto|scroll)$/);
  print('composer heights px', heights);

  await evaluate(`document.querySelector('[data-session-id="${ids.second}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#session-title').textContent.includes('Switch target') && document.querySelector('#prompt').disabled === false`), 'session switch did not settle');
  const reset = await evaluate(`(() => { const input=document.querySelector('#prompt'); return {height:input.getBoundingClientRect().height,valueLines:input.value.split('\\n').length,disabled:input.disabled}; })()`);
  assert.ok(Math.abs(reset.height - heights.one.height) <= 1, JSON.stringify({ reset, heights }));
  assert.equal(reset.disabled, false);
  print('composer switch reset px', reset);

  await evaluate(`document.querySelector('[data-session-id="${ids.first}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#session-title').textContent.includes('Pane fixture')`), 'first session did not reopen');
  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await screenshot(screenshotWide);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const narrow = await evaluate(`({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,bodyScrollWidth:document.body.scrollWidth,bodyClientWidth:document.body.clientWidth})`);
  assert.ok(narrow.scrollWidth <= narrow.clientWidth && narrow.bodyScrollWidth <= narrow.bodyClientWidth, JSON.stringify(narrow));
  await screenshot(screenshotNarrow);
  print('narrow no horizontal scroll', narrow);
  print('screenshots', { wide: screenshotWide, narrow: screenshotNarrow });
  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });
  print('RESULT', 'S1a-2 pane layout PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
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
