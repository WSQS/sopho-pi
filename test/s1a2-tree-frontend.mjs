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
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-tree-frontend-'));
const ids = {
  active: '11111111-1111-4111-8111-111111111111',
  activeChild: '22222222-2222-4222-8222-222222222222',
  archived: '33333333-3333-4333-8333-333333333333',
  archivedChild: '44444444-4444-4444-8444-444444444444',
  archivedParent: '55555555-5555-4555-8555-555555555555',
  hiddenActiveChild: '66666666-6666-4666-8666-666666666666',
};
const sessions = [
  { id: ids.active, name: 'Active root', archived: false, parentId: null, modifiedAt: '2026-09-18T06:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: false },
  { id: ids.activeChild, name: 'Active child', archived: false, parentId: ids.active, modifiedAt: '2026-09-18T05:00:00.000Z', status: 'working', statusLabel: '工作中', unread: true, settledAt: Date.now() },
  { id: ids.archived, name: 'Archived branch', archived: true, parentId: ids.active, modifiedAt: '2026-09-18T04:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: false, cwd: 'C:/work/archive', titleSource: 'manual' },
  { id: ids.archivedChild, name: 'Archived grandchild', archived: true, parentId: ids.archived, modifiedAt: '2026-09-18T03:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: false },
  { id: ids.archivedParent, name: 'Archived root', archived: true, parentId: null, modifiedAt: '2026-09-18T02:00:00.000Z', status: 'idle', statusLabel: '闲置', unread: false },
  { id: ids.hiddenActiveChild, name: 'Active under archive', archived: false, parentId: ids.archivedParent, modifiedAt: '2026-09-18T01:00:00.000Z', hiddenByArchive: true, status: 'idle', statusLabel: '闲置', unread: true },
].map((session) => ({ notify: { notifies: [], waitingFor: [] }, ...session }));
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
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 1, oldestId: ids.activeChild, oldestName: 'Active child', oldestAt: sessions[1].settledAt } });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return;
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
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${ids.active}"]') !== null`), 'active tree did not render');

  const initial = await evaluate(`(() => {
    const aside = document.querySelector('aside.tree');
    const tree = document.querySelector('#tree');
    const row = document.querySelector('[data-session-id="${ids.active}"]');
    const selectStyle = getComputedStyle(row.querySelector('.tree-select'));
    return {
      visibleIds: Array.from(document.querySelectorAll('.tree-session')).map((node) => node.dataset.sessionId),
      branchMark: document.querySelector('[data-fold-id="${ids.active}"]')?.textContent,
      atticToggle: document.querySelector('[data-attic-toggle="true"]')?.textContent,
      atticExpanded: document.querySelector('[data-attic-toggle="true"]')?.getAttribute('aria-expanded'),
      sidebarWidth: aside.getBoundingClientRect().width,
      asidePadding: parseFloat(getComputedStyle(aside).paddingTop),
      treeGap: parseFloat(getComputedStyle(tree).rowGap),
      rowHeight: row.getBoundingClientRect().height,
      rowPaddingBlock: parseFloat(selectStyle.paddingTop) + parseFloat(selectStyle.paddingBottom),
      uuidInTitle: row.title.includes('${ids.active}'),
    };
  })()`);
  assert.deepEqual(initial.visibleIds, [ids.active, ids.activeChild]);
  assert.equal(initial.branchMark, '▸2');
  assert.match(initial.atticToggle, /存档 ▸ 1/);
  assert.equal(initial.atticExpanded, 'false');
  assert.equal(initial.uuidInTitle, true);
  assert.ok(Math.abs(initial.sidebarWidth - 304) < 0.1, `sidebar width changed: ${initial.sidebarWidth}`);
  assert.ok(Math.abs(initial.asidePadding) < 0.1, `aside padding changed: ${initial.asidePadding}`);
  assert.ok(Math.abs(initial.treeGap) < 0.1, `tree gap changed: ${initial.treeGap}`);
  assert.ok(initial.rowHeight <= 28, `row height changed: ${initial.rowHeight}`);
  assert.ok(Math.abs(initial.rowPaddingBlock) < 0.1, `row block padding changed: ${initial.rowPaddingBlock}`);
  print('compact DOM dimensions', { expected: { sidebarWidth: 304, asidePadding: 0, treeGap: 0, rowHeightMax: 28, rowPaddingBlock: 0 }, actual: initial });
  print('archive default hidden', { visibleIds: initial.visibleIds, branchMark: initial.branchMark, attic: initial.atticToggle });

  await evaluate(`document.querySelector('[data-fold-id="${ids.active}"]').click()`);
  const expanded = await waitFor(async () => {
    const value = await evaluate(`({mark:document.querySelector('[data-fold-id="${ids.active}"]').textContent,ids:Array.from(document.querySelectorAll('[data-active-tree-list="true"] > .tree-session')).map((node)=>node.dataset.sessionId)})`);
    return value.mark === '▾2' ? value : null;
  }, 'archived branch did not expand in place');
  assert.deepEqual(expanded.ids, [ids.active, ids.activeChild, ids.archived, ids.archivedChild]);
  print('archive branch expanded in place', expanded);

  const archivedTooltip = await evaluate(`document.querySelector('[data-session-id="${ids.archived}"]').title`);
  assert.equal(archivedTooltip.includes(ids.archived), true);
  assert.match(archivedTooltip, /C:\/work\/archive/);
  assert.match(archivedTooltip, /已存档 —— 发消息就会复活/);
  assert.match(archivedTooltip, /标题：用户自己设的/);
  await evaluate(`document.querySelector('[data-session-id="${ids.archived}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#session-title').textContent === 'Archived branch（已归档）'`), 'archived selection was not explicit');
  await evaluate(`document.querySelector('[data-fold-id="${ids.active}"]').click()`);
  const collapsed = await waitFor(async () => {
    const value = await evaluate(`({mark:document.querySelector('[data-fold-id="${ids.active}"]').textContent,archivedRows:Array.from(document.querySelectorAll('[data-active-tree-list="true"] > .tree-session')).filter((node)=>node.dataset.archived==='true').length,title:document.querySelector('#session-title').textContent,promptDisabled:document.querySelector('#prompt').disabled})`);
    return value.mark === '▸2' ? value : null;
  }, 'archived branch did not collapse');
  assert.equal(collapsed.archivedRows, 0);
  assert.equal(collapsed.title, 'Archived branch（已归档）');
  assert.equal(collapsed.promptDisabled, false);
  print('archive collapse preserves selected detail', collapsed);

  await evaluate(`document.querySelector('[data-attic-toggle="true"]').click()`);
  const attic = await waitFor(async () => {
    const value = await evaluate(`({expanded:document.querySelector('[data-attic-toggle="true"]').getAttribute('aria-expanded'),heading:document.querySelector('.attic-heading')?.textContent,ids:Array.from(document.querySelectorAll('.attic-list .tree-session')).map((node)=>node.dataset.sessionId)})`);
    return value.expanded === 'true' ? value : null;
  }, 'attic did not expand below its button');
  assert.equal(attic.heading, '存档箱 · 顶层 1 个（不在上面的树里）');
  assert.deepEqual(attic.ids, [ids.archivedParent, ids.hiddenActiveChild]);
  print('top-level archive attic', attic);

  await evaluate(`document.querySelector('[data-session-id="${ids.activeChild}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#session-title').textContent === 'Active child'`), 'active child was not selectable');
  // 未读汇总条已删（用户裁定，docs/interaction-parity.md I-46）；这里改钉树行自己的未读记号。
  const unreadMarks = await evaluate(`Array.from(document.querySelectorAll('.tree-session.unread')).map((node) => node.dataset.sessionId)`);
  assert.deepEqual(unreadMarks, [ids.activeChild]);
  print('active tree selection + row unread mark', { title: 'Active child', unreadMarks });
  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });
  print('RESULT', 'S1a-2 compact/archive tree frontend PASS');
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
