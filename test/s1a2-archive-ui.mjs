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
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-archive-ui-'));
const activeShot = path.join(os.tmpdir(), 'sopho-v22-archive-active-1200x760.png');
const archivedShot = path.join(os.tmpdir(), 'sopho-v22-archive-archived-1200x760.png');
const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000018';
const requests = [];
const seenRequests = [];
let failNext = null;
let browser;
let chromium;
let server;

const sessions = [];
for (let index = 0; index < 40; index += 1) {
  sessions.push({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    name: `Active ${String(index).padStart(2, '0')}`,
    archived: false,
    parentId: null,
    modifiedAt: new Date(Date.UTC(2026, 8, 18, 8, index)).toISOString(),
    status: 'idle', statusLabel: '闲置', unread: false,
    notify: { notifies: [], waitingFor: [] },
  });
  sessions.push({
    id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`,
    name: `Archived ${String(index).padStart(2, '0')}`,
    archived: true,
    parentId: null,
    modifiedAt: new Date(Date.UTC(2026, 8, 18, 7, index)).toISOString(),
    status: 'idle', statusLabel: '闲置', unread: false,
    notify: { notifies: [], waitingFor: [] },
  });
}

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
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
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

async function screenshot(file) {
  const image = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(file, Buffer.from(image.data, 'base64'));
}

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return;
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|seen|commands|draft|archive))?$/.exec(url.pathname);
    if (match) {
      const session = sessions.find((entry) => entry.id === match[1]);
      if (!session) return sendJson(response, 404, { message: 'missing' });
      const action = match[2] || null;
      if (action === 'archive' && request.method === 'POST') {
        const raw = await requestBody(request);
        const body = JSON.parse(raw || '{}');
        requests.push({ path: url.pathname, body });
        if (failNext) {
          const failure = failNext;
          failNext = null;
          return sendJson(response, failure.status, { message: failure.message });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        session.archived = body.archived === true;
        // 回执照**真**服务端的新形状（`POST /sessions/{id}/archive` 现在多带 `changed`/`by`/`at`；
        // 人这条路不带 `by` ⇒ 回执里为 null）。前端**不读**这些新字段 —— 这个夹具让这条“不会读错”
        // 变成一条真 Chromium 判据，而不是一句声明。
        return sendJson(response, 200, { id: session.id, archived: session.archived, changed: true, by: null, at: Date.now() });
      }
      if (action === 'messages') return sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return;
      }
      if (action === 'seen') {
        seenRequests.push(session.id);
        return sendJson(response, 200, { ok: true });
      }
      if (action === 'commands') return sendJson(response, 200, { commands: [], streaming: false });
      if (action === 'draft') return request.method === 'GET' ? sendJson(response, 200, { text: '' }) : sendJson(response, 200, { ok: true });
      return sendJson(response, 200, { name: session.name, archived: session.archived, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
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
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${targetId}"]') !== null`), 'target session did not render');
  await evaluate(`document.querySelector('[data-attic-toggle="true"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-attic-list="true"]') !== null`), 'archive pane did not open');
  await evaluate(`document.querySelector('[data-session-id="${targetId}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#archive')?.textContent === '存档'`), 'unarchived archive control missing');
  const activeControl = await evaluate(`(() => { const button=document.querySelector('#archive'); const style=getComputedStyle(button); return {text:button.textContent,height:button.getBoundingClientRect().height,whiteSpace:style.whiteSpace,fontFamily:style.fontFamily,slot:style.borderLeftWidth}; })()`);
  assert.equal(activeControl.text, '存档');
  assert.ok(activeControl.height <= 28, JSON.stringify(activeControl));
  assert.equal(activeControl.whiteSpace, 'nowrap');
  assert.equal(activeControl.slot, '3px');
  await screenshot(activeShot);
  print('ASSERT 1 control states', { unarchived: activeControl.text, archived: 'pending', activeShot });

  const beforeArchive = await evaluate(`(() => { const active=document.querySelector('.active-tree-list'); const attic=document.querySelector('.attic-list'); active.scrollTop=240; attic.scrollTop=260; return {active:active.scrollTop,attic:attic.scrollTop}; })()`);
  sessions.find((entry) => entry.id === targetId).unread = true;
  await evaluate(`document.querySelector('#archive').click()`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const pending = await evaluate(`({button:document.querySelector('#archive').textContent,inActive:!!document.querySelector('.active-tree-list [data-session-id="${targetId}"]'),inAttic:!!document.querySelector('.attic-list [data-session-id="${targetId}"]')})`);
  assert.deepEqual(pending, { button: '存档', inActive: true, inAttic: false });
  print('ASSERT 2 waits for real response', pending);

  const archived = await waitFor(async () => {
    const value = await evaluate(`({button:document.querySelector('#archive')?.textContent,inActive:!!document.querySelector('.active-tree-list [data-session-id="${targetId}"]'),inAttic:!!document.querySelector('.attic-list [data-session-id="${targetId}"]'),title:document.querySelector('#session-title').textContent,activeTop:document.querySelector('.active-tree-list').scrollTop,atticTop:document.querySelector('.attic-list').scrollTop})`);
    return value.button === '取消存档' ? value : null;
  }, 'successful archive did not update UI');
  assert.deepEqual(requests[0], { path: `/api/sessions/${targetId}/archive`, body: { archived: true } });
  assert.equal(archived.inActive, false);
  assert.equal(archived.inAttic, true);
  assert.match(archived.title, /已归档/);
  assert.ok(Math.abs(archived.activeTop - beforeArchive.active) <= 2, JSON.stringify({ beforeArchive, archived }));
  assert.ok(Math.abs(archived.atticTop - beforeArchive.attic) <= 2, JSON.stringify({ beforeArchive, archived }));
  await screenshot(archivedShot);
  print('ASSERT 3 archive request + lower group', { request: requests[0], ui: archived, archivedShot });

  await evaluate(`document.querySelector('#archive').click()`);
  const unarchived = await waitFor(async () => {
    const value = await evaluate(`({button:document.querySelector('#archive')?.textContent,inActive:!!document.querySelector('.active-tree-list [data-session-id="${targetId}"]'),inAttic:!!document.querySelector('.attic-list [data-session-id="${targetId}"]'),activeTop:document.querySelector('.active-tree-list').scrollTop,atticTop:document.querySelector('.attic-list').scrollTop})`);
    return requests.length >= 2 && value.button === '存档' ? value : null;
  }, 'successful unarchive did not update UI');
  assert.deepEqual(requests[1], { path: `/api/sessions/${targetId}/archive`, body: { archived: false } });
  assert.equal(unarchived.inActive, true);
  assert.equal(unarchived.inAttic, false);
  assert.ok(Math.abs(unarchived.activeTop - beforeArchive.active) <= 2, JSON.stringify({ beforeArchive, unarchived }));
  assert.ok(Math.abs(unarchived.atticTop - beforeArchive.attic) <= 2, JSON.stringify({ beforeArchive, unarchived }));
  print('ASSERT 4 unarchive request + original group', { request: requests[1], ui: unarchived });
  assert.deepEqual(seenRequests, []);
  print('ASSERT 5 both scroll axes preserved; seen untouched', { before: beforeArchive, afterArchive: { active: archived.activeTop, attic: archived.atticTop }, afterUnarchive: { active: unarchived.activeTop, attic: unarchived.atticTop }, seenRequests });

  failNext = { status: 409, message: 'archive conflict: session is settling' };
  await evaluate(`document.querySelector('#archive').click()`);
  const failed = await waitFor(async () => {
    const value = await evaluate(`({notice:document.querySelector('#notice').textContent,level:document.querySelector('#notice').dataset.level,button:document.querySelector('#archive')?.textContent,inActive:!!document.querySelector('.active-tree-list [data-session-id="${targetId}"]'),inAttic:!!document.querySelector('.attic-list [data-session-id="${targetId}"]')})`);
    return value.notice.includes('archive conflict') ? value : null;
  }, 'archive failure was not reported');
  assert.equal(failed.level, 'error');
  assert.match(failed.notice, /存档失败.*409.*archive conflict/);
  assert.deepEqual({ button: failed.button, inActive: failed.inActive, inAttic: failed.inAttic }, { button: '存档', inActive: true, inAttic: false });
  assert.deepEqual(requests[2], { path: `/api/sessions/${targetId}/archive`, body: { archived: true } });
  print('ASSERT 6 failure is loud + UI unchanged', { request: requests[2], ui: failed });
  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });
  print('screenshots', { active: activeShot, archived: archivedShot, viewport: '1200x760' });
  print('RESULT', 'S1a-2 archive UI PASS');
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
