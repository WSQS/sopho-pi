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
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-mentions-'));
const screenshotPath = path.join(os.tmpdir(), 'sopho-v22-mentions-open-1200x760.png');
const currentId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const archivedIds = [
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
  '88888888-8888-4888-8888-888888888888',
];
const targetToken = `@#${targetId}「沙箱脚本」`;
const archivedToken = `@#${archivedIds[0]}「归档会话一」`;
const sessions = [
  { id: currentId, name: '当前会话', status: 'idle', statusLabel: '闲置', archived: false, parentId: null },
  { id: targetId, name: '沙箱脚本', status: 'idle', statusLabel: '闲置', archived: false, parentId: null, unread: true },
  { id: otherId, name: 'sandbox 脚本 带空格', status: 'working', statusLabel: '运行中', archived: false, parentId: null },
  ...archivedIds.map((id, index) => ({ id, name: `归档会话${'一二三四五'[index]}`, status: 'idle', statusLabel: '闲置', archived: true, parentId: null })),
];
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

const setPrompt = (value) => evaluate(`(() => { const input=document.querySelector('#prompt'); input.value=${JSON.stringify(value)}; input.setSelectionRange(input.value.length,input.value.length); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
const press = (key) => evaluate(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`);

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return;
    }
    if (url.pathname === `/api/sessions/${currentId}`) return sendJson(response, 200, { name: '当前会话', runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
    if (url.pathname === `/api/sessions/${currentId}/messages`) return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null });
    if (url.pathname === `/api/sessions/${currentId}/commands`) return sendJson(response, 200, { streaming: false, commands: [{ name: 'cwd', description: 'Show cwd', source: 'extension', runnable: true, via: 'prompt' }] });
    if (url.pathname === `/api/sessions/${currentId}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
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
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${currentId}"]') !== null`), 'tree did not render');
  await evaluate(`document.querySelector('[data-session-id="${currentId}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not open');
  print('chromium', { product: version.Browser, chrome, port, debugPort, viewport: '1200x760', forbiddenPortsUsed: false });

  await setPrompt('@');
  const opened = await waitFor(async () => {
    const value = await evaluate(`(() => { const panel=document.querySelector('#mention-palette'); const rows=Array.from(document.querySelectorAll('.mention-palette-item')); const row=rows[0]; const selected=document.querySelector('.mention-palette-item.selected'); const separator=document.querySelector('.mention-palette-separator'); const prompt=document.querySelector('#prompt'); return {hidden:panel.hidden,count:rows.length,ids:rows.map((node)=>node.dataset.sessionId),archived:rows.map((node)=>node.dataset.archived==='true'),selected:selected?.dataset.sessionId,rowHeight:row?.getBoundingClientRect().height,slotWidth:getComputedStyle(row).borderLeftWidth,slotColor:getComputedStyle(selected).borderLeftColor,separatorCount:document.querySelectorAll('.mention-palette-separator').length,separatorText:separator?.textContent,separatorHeight:separator?.getBoundingClientRect().height,separatorTag:separator?.tagName,separatorSelected:separator?.classList.contains('selected'),panelBottom:panel.getBoundingClientRect().bottom,promptTop:prompt.getBoundingClientRect().top}; })()`);
    return !value.hidden && value.count === sessions.length ? value : null;
  }, '@ did not open all mention candidates');
  assert.equal(opened.rowHeight, 26);
  assert.equal(opened.slotWidth, '3px');
  assert.equal(opened.slotColor, 'rgb(138, 190, 183)');
  assert.ok(opened.panelBottom <= opened.promptTop, 'mention panel must sit above the input');
  const activeIndexes = opened.archived.flatMap((archived, index) => archived ? [] : [index]);
  const archivedIndexes = opened.archived.flatMap((archived, index) => archived ? [index] : []);
  assert.ok(Math.max(...activeIndexes) < Math.min(...archivedIndexes), 'all active candidates must precede every archived candidate');
  assert.deepEqual(opened.ids.slice(0, 3), [currentId, targetId, otherId]);
  assert.deepEqual(opened.ids.slice(3), archivedIds);
  print('sorting assertion: all 3 active indexes precede all 5 archived indexes', { ids: opened.ids, archived: opened.archived });
  assert.deepEqual({ count: opened.separatorCount, text: opened.separatorText, height: opened.separatorHeight, tag: opened.separatorTag, selected: opened.separatorSelected }, { count: 1, text: '归档', height: 26, tag: 'DIV', selected: false });
  print('archive separator is a non-selectable 26px row', { count: opened.separatorCount, text: opened.separatorText, height: opened.separatorHeight, tag: opened.separatorTag, selected: opened.separatorSelected });
  print('@ opens all candidates above composer with 3px accent slot', opened);

  const shot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
  print('screenshot', screenshotPath);

  await setPrompt('@脚本');
  const filtered = await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.mention-palette-item')).map((node)=>node.dataset.sessionId)`), 'mention filtering did not settle');
  assert.deepEqual(filtered, [targetId, otherId]);
  await press('ArrowDown');
  assert.equal(await evaluate(`document.querySelector('.mention-palette-item.selected')?.dataset.sessionId`), otherId);
  await press('ArrowUp');
  assert.equal(await evaluate(`document.querySelector('.mention-palette-item.selected')?.dataset.sessionId`), targetId);
  await press('Enter');
  const inserted = await evaluate(`(() => { const input=document.querySelector('#prompt'); return {text:input.value,cursor:input.selectionStart,hidden:document.querySelector('#mention-palette').hidden}; })()`);
  assert.equal(inserted.text, `${targetToken} `);
  assert.equal(inserted.cursor, inserted.text.length);
  assert.equal(inserted.hidden, true);
  print('token exact text', inserted.text);
  print('filter + ArrowDown/ArrowUp + Enter inserts and places cursor after token', inserted);

  await setPrompt('@');
  await press('ArrowDown');
  await press('ArrowDown');
  await press('ArrowDown');
  assert.equal(await evaluate(`document.querySelector('.mention-palette-item.selected')?.dataset.sessionId`), archivedIds[0]);
  await press('ArrowUp');
  assert.equal(await evaluate(`document.querySelector('.mention-palette-item.selected')?.dataset.sessionId`), otherId);
  await press('ArrowDown');
  await press('Enter');
  const archivedInserted = await evaluate(`(() => { const input=document.querySelector('#prompt'); return {text:input.value,cursor:input.selectionStart,hidden:document.querySelector('#mention-palette').hidden}; })()`);
  assert.deepEqual(archivedInserted, { text: `${archivedToken} `, cursor: archivedToken.length + 1, hidden: true });
  print('keyboard crosses active/archive groups and inserts archived token exactly', archivedInserted);

  await setPrompt('@沙');
  await press('Escape');
  assert.equal(await evaluate(`document.querySelector('#mention-palette').hidden`), true);
  print('Escape closes mention palette', true);

  await setPrompt('mail a@b.com');
  assert.equal(await evaluate(`document.querySelector('#mention-palette').hidden`), true);
  print('email body does not open mention palette', true);

  await setPrompt('/');
  const slashState = await waitFor(() => evaluate(`({commandHidden:document.querySelector('#command-palette').hidden,mentionHidden:document.querySelector('#mention-palette').hidden})`), 'command palette did not open');
  assert.deepEqual(slashState, { commandHidden: false, mentionHidden: true });
  await setPrompt('@沙');
  const mentionState = await waitFor(async () => {
    const state = await evaluate(`({commandHidden:document.querySelector('#command-palette').hidden,mentionHidden:document.querySelector('#mention-palette').hidden})`);
    return state.commandHidden && !state.mentionHidden ? state : null;
  }, 'mention palette did not take over from command palette');
  assert.deepEqual(mentionState, { commandHidden: true, mentionHidden: false });
  print('/ and @ palettes are mutually exclusive', { slashState, mentionState });

  await evaluate(`document.querySelector('#messages').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('#mention-palette').hidden`), true);
  print('outside click closes mention palette', true);
  print('RESULT', 'S1a-2 mentions Chromium contract PASS');
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
