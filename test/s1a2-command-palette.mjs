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
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-command-palette-'));
const sessionId = '11111111-1111-4111-8111-111111111111';
const requests = [];
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

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions: [{ id: sessionId, name: 'Palette session', status: 'idle', statusLabel: '闲置', archived: false, parentId: null }] });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: [] })}\n\n`);
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) return sendJson(response, 200, { name: 'Palette session', runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
    if (url.pathname === `/api/sessions/${sessionId}/messages`) return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null });
    if (url.pathname === `/api/sessions/${sessionId}/commands`) {
      requests.push({ action: 'commands' });
      return sendJson(response, 200, {
        sessionId,
        streaming: false,
        compacting: false,
        canRun: true,
        builtinError: null,
        builtinHow: 'fixture',
        commands: [
          { name: 'settings', description: 'Open settings menu', source: 'builtin', runnable: false, reason: 'TUI 专用（设置菜单）', tag: 'TUI 专用', via: null },
          { name: 'cwd', description: 'Show current working directory', source: 'extension', runnable: true, reason: null, tag: null, via: 'prompt' },
          { name: 'compact', description: 'Manually compact context', source: 'builtin', runnable: true, reason: null, tag: null, via: 'compact' },
          { name: 'model', description: 'Select model', source: 'builtin', argumentHint: '<provider/model>', runnable: true, reason: null, tag: null, via: 'model' },
        ],
      });
    }
    if (url.pathname === `/api/sessions/${sessionId}/models`) {
      requests.push({ action: 'models' });
      return sendJson(response, 200, { sessionId, current: 'fake/current', source: 'available', models: [
        { provider: 'fake', id: 'other', ref: 'fake/other', name: 'Other', current: false, contextWindow: 8192 },
        { provider: 'fake', id: 'current', ref: 'fake/current', name: 'Current', current: true, contextWindow: 4096 },
      ] });
    }
    if (url.pathname === `/api/sessions/${sessionId}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      return;
    }
    const action = url.pathname.match(new RegExp(`^/api/sessions/${sessionId}/(message|compact|model)$`))?.[1];
    if (action && request.method === 'POST') {
      const body = await bodyOf(request);
      requests.push({ action, body });
      return sendJson(response, action === 'model' ? 200 : 202, action === 'model' ? { ok: true, model: body.model } : { accepted: true });
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
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'tree did not render');
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not open');
  await waitFor(() => requests.some((entry) => entry.action === 'commands'), 'commands were not loaded from the server');
  print('chromium', { product: version.Browser, chrome, port, debugPort, forbiddenPortsUsed: false });

  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='/'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const opened = await waitFor(async () => {
    const value = await evaluate(`(() => { const row=document.querySelector('.command-palette-item'); return {hidden:document.querySelector('#command-palette').hidden,names:Array.from(document.querySelectorAll('.command-palette-item')).map((node)=>node.dataset.commandName),selected:document.querySelector('.command-palette-item.selected')?.dataset.commandName,rowHeight:row?.getBoundingClientRect().height,font:getComputedStyle(row).fontFamily,background:getComputedStyle(document.querySelector('#command-palette')).backgroundColor}; })()`);
    return !value.hidden && value.names.length === 4 ? value : null;
  }, 'slash did not open the palette');
  assert.equal(opened.selected, 'settings');
  assert.equal(opened.rowHeight, 26);
  assert.match(opened.font, /monospace/i);
  assert.equal(opened.background, 'rgb(13, 14, 17)');
  print('/ opens server-backed palette', opened);

  await evaluate(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
  const moved = await waitFor(() => evaluate(`document.querySelector('.command-palette-item.selected')?.dataset.commandName`), 'selection missing');
  assert.equal(moved, 'cwd');
  await evaluate(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('.command-palette-item.selected')?.dataset.commandName`), 'settings');
  print('ArrowDown/ArrowUp change selection', { down: moved, up: 'settings' });

  await evaluate(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('#command-palette').hidden`), true);
  print('Escape closes palette', true);

  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='/working'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const descriptionFiltered = await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.command-palette-item')).map((node)=>node.dataset.commandName)`), 'description filter missing');
  assert.deepEqual(descriptionFiltered, ['cwd']);
  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='/cw'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const filtered = await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.command-palette-item')).map((node)=>node.dataset.commandName)`), 'name filter missing');
  assert.deepEqual(filtered, ['cwd']);
  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='/cwd'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  await waitFor(() => requests.some((entry) => entry.action === 'message' && entry.body.text === '/cwd'), 'Enter did not execute /cwd');
  print('filter + Enter executes corresponding request', requests.find((entry) => entry.action === 'message'));

  const beforeUnavailable = requests.length;
  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='/settings'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  const unavailable = await waitFor(async () => {
    const value = await evaluate(`({notice:document.querySelector('#notice').textContent,paletteText:document.querySelector('#command-palette').textContent})`);
    return value.notice.includes('TUI 专用') ? value : null;
  }, 'TUI-only command had no explanation');
  assert.equal(requests.length, beforeUnavailable);
  assert.match(unavailable.notice, /网页里不能执行/);
  print('TUI-only command is disabled with reason', unavailable);

  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='/model '; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const modelPalette = await waitFor(async () => {
    const value = await evaluate(`({names:Array.from(document.querySelectorAll('.command-palette-item')).map((node)=>node.dataset.commandName),selected:document.querySelector('.command-palette-item.selected')?.dataset.commandName})`);
    return value.names.length === 2 ? value : null;
  }, '/model did not show candidates');
  assert.deepEqual(modelPalette.names, ['fake/current', 'fake/other']);
  assert.equal(modelPalette.selected, 'fake/current');
  await evaluate(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await waitFor(() => requests.some((entry) => entry.action === 'model' && entry.body.model === 'fake/current'), 'model candidate Enter did not POST');
  print('/model candidates keep current first and execute', { modelPalette, request: requests.find((entry) => entry.action === 'model') });

  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='/'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#messages').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); })()`);
  assert.equal(await evaluate(`document.querySelector('#command-palette').hidden`), true);
  print('outside click closes palette', true);

  await evaluate(`(() => { const input=document.querySelector('#prompt'); input.value='cd /tmp && ls'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const middleSlash = await evaluate(`({hidden:document.querySelector('#command-palette').hidden,text:document.querySelector('#prompt').value})`);
  assert.equal(middleSlash.hidden, true);
  assert.equal(middleSlash.text, 'cd /tmp && ls');
  print('slash in message body stays ordinary text', middleSlash);
  print('RESULT', 'S1a-2 command palette Chromium contract PASS');
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
