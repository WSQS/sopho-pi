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
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-v21-style-'));
const ids = {
  oldest: '11111111-1111-4111-8111-111111111111',
  settled: '22222222-2222-4222-8222-222222222222',
  invalid: '33333333-3333-4333-8333-333333333333',
};
const sessions = [
  { id: ids.invalid, name: 'A very long session name that must be ellipsized instead of making a second line', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', modifiedAt: 'not-a-date', cwd: 'C:/invalid-date', notify: { notifies: [], waitingFor: [] } },
  { id: ids.settled, name: 'Settled time fallback', parentId: null, archived: false, status: 'working', statusLabel: '工作中', settledAt: '2026-09-18T08:05:00', cwd: 'C:/settled', notify: { notifies: [], waitingFor: [] } },
  { id: ids.oldest, name: 'Oldest unread', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: true, modifiedAt: '2026-09-17T16:51:00', settledAt: '2026-09-17T16:51:00', cwd: 'C:/oldest', titleSource: 'auto', notify: { notifies: [], waitingFor: [] } },
];
const createBodies = [];
const opened = [];
const treeClients = new Set();
let treeOffline = false;
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
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 1, oldestId: ids.oldest, oldestName: 'Oldest unread', oldestAt: sessions[2].settledAt } });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      if (treeOffline) return response.writeHead(503).end();
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      treeClients.add(response);
      response.once('close', () => treeClients.delete(response));
      return;
    }
    if (url.pathname === '/api/sessions' && request.method === 'POST') {
      const body = await bodyOf(request);
      createBodies.push(body);
      return sendJson(response, 201, { id: ids.invalid, cwd: body.cwd || (body.scratch ? 'C:/scratch' : 'C:/project') });
    }
    if (url.pathname === '/control/disconnect-tree') {
      treeOffline = true;
      for (const client of treeClients) client.destroy();
      return sendJson(response, 200, { ok: true });
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|seen))?$/.exec(url.pathname);
    if (match) {
      const session = sessions.find((entry) => entry.id === match[1]);
      if (!session) return sendJson(response, 404, { message: 'missing' });
      if (match[2] === 'messages') return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null });
      if (match[2] === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return;
      }
      if (match[2] === 'seen') return sendJson(response, 200, { ok: true });
      opened.push(session.id);
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
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 613, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelectorAll('.tree-session').length === 3`), 'tree did not render');

  // 状态圆点已由全高 3px 左槽取代；单行判据只量仍可见的名字/时间，不能把 display:none 的旧兼容节点算进去。
  const density = await evaluate(`(() => { const row=document.querySelector('[data-session-id="${ids.oldest}"]'); const select=row.querySelector('.tree-select'); const style=getComputedStyle(row); const body=getComputedStyle(document.body); const visible=Array.from(select.children).filter((node)=>getComputedStyle(node).display!=='none'); const rects=visible.map((node)=>node.getBoundingClientRect()); return {rowHeight:row.getBoundingClientRect().height,statusNodes:row.querySelectorAll('.tree-status').length,statusDotDisplay:getComputedStyle(row.querySelector('.status-dot')).display,childTags:visible.map((node)=>node.tagName),singleLine:rects.every((rect)=>Math.abs(rect.top-rects[0].top)<10),font:body.fontFamily,bodyBg:body.backgroundColor,rowColor:style.color,firstOffsetTop:document.querySelector('[data-active-tree-list="true"] > .tree-session').offsetTop,longNameOverflow:document.querySelector('[data-session-id="${ids.invalid}"] .tree-name').scrollWidth > document.querySelector('[data-session-id="${ids.invalid}"] .tree-name').clientWidth}; })()`);
  assert.equal(density.rowHeight, 26, JSON.stringify(density));
  assert.equal(density.statusNodes, 0);
  assert.equal(density.statusDotDisplay, 'none');
  assert.equal(density.singleLine, true);
  assert.match(density.font, /monospace/i);
  assert.equal(density.bodyBg, 'rgb(15, 16, 19)');
  assert.equal(density.rowColor, 'rgb(227, 232, 228)');
  assert.ok(density.firstOffsetTop <= 120, JSON.stringify(density));
  assert.equal(density.longNameOverflow, true);
  const idleColor = await evaluate(`getComputedStyle(document.querySelector('[data-session-id="${ids.invalid}"]')).color`);
  assert.equal(idleColor, 'rgb(124, 127, 138)');
  print('density + terminal palette at 1200x613', { ...density, idleColor });

  const times = await evaluate(`Object.fromEntries(Array.from(document.querySelectorAll('.tree-session')).map((row)=>[row.dataset.sessionId,row.querySelector('.tree-time')?.textContent||'']))`);
  assert.equal(times[ids.oldest], '09-17 16:51');
  assert.equal(times[ids.settled], '09-18 08:05');
  assert.equal(times[ids.invalid], '');
  assert.doesNotMatch(JSON.stringify(times), /NaN|Invalid Date/);
  const tooltip = await evaluate(`document.querySelector('[data-session-id="${ids.oldest}"]').title`);
  assert.match(tooltip, /Oldest unread/);
  assert.match(tooltip, new RegExp(ids.oldest));
  assert.match(tooltip, /C:\/oldest/);
  assert.match(tooltip, /模型自己起的/);
  assert.match(tooltip, /状态：闲置 · 未读/);
  print('timestamps + complete tooltip', { times, tooltip });

  // 「N 个会话有新东西 →」汇总条已按用户裁定删除（docs/interaction-parity.md I-46）；
  // 它曾是这个测试里打开会话的入口，这里改点树行本身，保留后面 composer 可用性断言的覆盖。
  await evaluate(`document.querySelector('[data-session-id="${ids.oldest}"] .tree-select').click()`);
  await waitFor(() => opened.includes(ids.oldest), 'tree row did not open oldest unread');
  const composerStyle = await waitFor(async () => {
    const value = await evaluate(`(() => { const input=document.querySelector('#prompt'); return {disabled:input.disabled,resize:getComputedStyle(input).resize,height:input.getBoundingClientRect().height}; })()`);
    return value.disabled ? null : value;
  }, 'composer did not become available');
  assert.equal(composerStyle.resize, 'none');
  assert.ok(composerStyle.height >= 55 && composerStyle.height <= 57, JSON.stringify(composerStyle));
  print('quiet tree row opens oldest unread', { opened: opened.at(-1), composerStyle });

  const connected = await waitFor(async () => {
    const text = await evaluate(`document.querySelector('#tree-connection').textContent`);
    return text.includes('● 已连接') ? text : null;
  }, 'tree connection did not become connected');
  assert.equal(connected, '● 已连接 · 3 个会话');
  print('tree SSE connected', connected);

  assert.equal(await evaluate(`document.querySelector('#new-session-panel').hidden`), true);
  await evaluate(`document.querySelector('#new-session-toggle').click()`);
  const form = await evaluate(`({hidden:document.querySelector('#new-session-panel').hidden,input:!!document.querySelector('#new-cwd'),buttons:Array.from(document.querySelectorAll('#new-session-panel button')).map((node)=>node.textContent)})`);
  assert.equal(form.hidden, false);
  assert.deepEqual(form.buttons, ['项目根', '临时目录', '建这条会话', '取消']);
  await evaluate(`document.querySelector('#new-project').click()`);
  await waitFor(() => createBodies.length === 1, 'project create missing');
  await waitFor(() => evaluate(`document.querySelector('#new-project').disabled === false`), 'project create did not settle');
  await evaluate(`document.querySelector('#new-session-toggle').click(); document.querySelector('#new-scratch').click()`);
  await waitFor(() => createBodies.length === 2, 'scratch create missing');
  await waitFor(() => evaluate(`document.querySelector('#new-scratch').disabled === false`), 'scratch create did not settle');
  await evaluate(`(() => { document.querySelector('#new-session-toggle').click(); const input=document.querySelector('#new-cwd'); input.value='C:/work/demo'; document.querySelector('#advanced-session').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); })()`);
  await waitFor(() => createBodies.length === 3, 'cwd create missing');
  await waitFor(() => evaluate(`document.querySelector('#new-session-panel').hidden === true`), 'cwd create did not settle');
  assert.deepEqual(createBodies, [{}, { scratch: true }, { cwd: 'C:/work/demo' }]);
  assert.equal(await evaluate(`document.querySelector('#new-session-panel').hidden`), true);
  print('inline new-session form keeps three routes', { defaultCollapsed: true, form, createBodies });

  await browser.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const narrow = await evaluate(`(() => { const aside=document.querySelector('aside.tree'); const first=document.querySelector('[data-active-tree-list="true"] > .tree-session'); return {asideHeight:aside.clientHeight,firstOffsetTop:first.offsetTop,firstBottom:first.getBoundingClientRect().bottom,asideBottom:aside.getBoundingClientRect().bottom}; })()`);
  assert.ok(narrow.firstOffsetTop < narrow.asideHeight, JSON.stringify(narrow));
  assert.ok(narrow.firstBottom <= narrow.asideBottom, JSON.stringify(narrow));
  print('narrow 420x820 keeps first row in first screen', narrow);

  await fetch(`http://127.0.0.1:${port}/control/disconnect-tree`);
  const disconnected = await waitFor(async () => {
    const text = await evaluate(`document.querySelector('#tree-connection').textContent`);
    return text.includes('○ 未连接') ? text : null;
  }, 'tree connection did not report disconnect');
  assert.equal(disconnected, '○ 未连接 · 3 个会话');
  print('tree SSE disconnected', disconnected);
  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });
  print('RESULT', 'S1a-2 v2.1 terminal-density style PASS');
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
