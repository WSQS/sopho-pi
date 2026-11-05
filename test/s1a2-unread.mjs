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
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-unread-'));
const ids = {
  old: '11111111-1111-4111-8111-111111111111',
  newer: '22222222-2222-4222-8222-222222222222',
  running: '33333333-3333-4333-8333-333333333333',
  read: '44444444-4444-4444-8444-444444444444',
  archived: '55555555-5555-4555-8555-555555555555',
  archivedParent: '66666666-6666-4666-8666-666666666666',
  hiddenChild: '77777777-7777-4777-8777-777777777777',
};
const base = Date.now() - 100_000;
const state = {
  settled: {
    [ids.old]: base,
    [ids.newer]: base + 10_000,
    [ids.running]: base + 20_000,
    [ids.read]: base + 30_000,
    [ids.archived]: base + 40_000,
    [ids.hiddenChild]: base + 50_000,
  },
  seen: { [ids.read]: base + 60_000 },
  running: true,
  seenPosts: [],
};
const treeClients = new Set();
const sessionClients = new Map();
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

function sessions() {
  const rows = [
    { id: ids.old, name: 'Old unread', archived: false, parentId: null },
    { id: ids.newer, name: 'New unread', archived: false, parentId: null },
    { id: ids.running, name: 'Running unread', archived: false, parentId: null },
    { id: ids.read, name: 'Already read', archived: false, parentId: null },
    { id: ids.archived, name: 'Archived unread fact', archived: true, parentId: null },
    { id: ids.archivedParent, name: 'Archived parent', archived: true, parentId: null },
    { id: ids.hiddenChild, name: 'Hidden live child', archived: false, parentId: ids.archivedParent, hiddenByArchive: true },
  ];
  return rows.map((row) => {
    const settledAt = state.settled[row.id] ?? null;
    const seenAt = state.seen[row.id] ?? null;
    const unread = !row.archived && (settledAt ?? 0) > (seenAt ?? 0);
    const working = row.id === ids.running && state.running;
    return {
      ...row,
      status: working ? 'working' : unread ? 'unread' : 'idle',
      statusLabel: working ? '工作中' : unread ? '未读' : '闲置',
      settledAt,
      seenAt,
      unread,
      hiddenByArchive: row.hiddenByArchive === true,
      notify: { notifies: [], waitingFor: [] },
    };
  });
}

function treePayload() {
  const rows = sessions();
  const visible = rows.filter((row) => row.unread && !row.hiddenByArchive).sort((a, b) => a.settledAt - b.settledAt || a.id.localeCompare(b.id));
  const oldest = visible[0] ?? null;
  return { sessions: rows, unread: { count: visible.length, oldestId: oldest?.id ?? null, oldestName: oldest?.name ?? null, oldestAt: oldest?.settledAt ?? null } };
}

function broadcastTree(reason = 'test') {
  const data = JSON.stringify({ type: 'tree.session', sessionId: ids.running, reason });
  for (const response of treeClients) response.write(`event: tree.session\ndata: ${data}\n\n`);
}

function messagesFor(id) {
  const messages = Array.from({ length: 90 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `${id} line ${index} ${'content '.repeat(24)}` }));
  return { messages, extras: [], compaction: { atIndex: null, note: '' }, observability: null };
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
    if (url.pathname === '/api/tree') return sendJson(response, 200, treePayload());
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload())}\n\n`);
      treeClients.add(response);
      response.once('close', () => treeClients.delete(response));
      return;
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|seen))?$/.exec(url.pathname);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const action = sessionMatch[2] ?? null;
      if (action === 'seen' && request.method === 'POST') {
        state.seen[id] = Date.now();
        state.seenPosts.push(id);
        sendJson(response, 200, { ok: true, id, seenAt: state.seen[id], unread: false });
        return;
      }
      if (action === 'messages') {
        if (id === ids.old) await new Promise((resolve) => setTimeout(resolve, 120));
        return sendJson(response, 200, messagesFor(id));
      }
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: id === ids.running && state.running, isCompacting: false, isRetrying: false })}\n\n`);
        if (!sessionClients.has(id)) sessionClients.set(id, new Set());
        sessionClients.get(id).add(response);
        response.once('close', () => sessionClients.get(id)?.delete(response));
        return;
      }
      if (id === ids.old) await new Promise((resolve) => setTimeout(resolve, 120));
      return sendJson(response, 200, { name: sessions().find((row) => row.id === id)?.name, runtime: { isStreaming: id === ids.running && state.running, isCompacting: false, isRetrying: false }, observability: null });
    }
    if (url.pathname === '/control/settle-running') {
      state.running = false;
      state.settled[ids.running] = Date.now();
      broadcastTree('settled');
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/control/state') return sendJson(response, 200, state);
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
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;

  const initial = await waitFor(async () => {
    const value = await evaluate(`({unreadRows:document.querySelectorAll('.tree-session.unread').length,dotDisplays:Array.from(document.querySelectorAll('.status-dot')).map((node)=>getComputedStyle(node).display),unreadSlot:getComputedStyle(document.querySelector('.tree-session.unread')).borderLeftColor,idleSlot:getComputedStyle(document.querySelector('[data-session-id="${ids.read}"]')).borderLeftColor,hiddenChild:!!document.querySelector('[data-session-id="${ids.hiddenChild}"]'),archivedDot:!!document.querySelector('[data-session-id="${ids.archived}"] .unread-dot')})`);
    return value.unreadRows === 3 ? value : null;
  }, 'initial tree unread marks missing');
  assert.equal(initial.unreadRows, 3);
  assert.ok(initial.dotDisplays.every((display) => display === 'none'), JSON.stringify(initial));
  assert.notEqual(initial.unreadSlot, initial.idleSlot);
  assert.equal(initial.hiddenChild, false);
  assert.equal(initial.archivedDot, false);
  print('initial visible unread', initial);

  // 「树顶 N 个会话有新东西 →」汇总条已按用户裁定删除（见 docs/interaction-parity.md I-46）。
  // 它曾是页面上唯一「跳最旧未读」的入口；删掉后这条能力不再存在，汇总文本/收缩断言随之删除，
  // 但「打开最旧未读 → 贴底时上报已读」这条语义仍用树行本身走一遍，未读语义改由树行断言覆盖。
  await evaluate(`document.querySelector('[data-session-id="${ids.old}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#session-title').textContent === 'Old unread'`), 'tree row did not open the oldest unread');
  await waitFor(() => state.seenPosts.includes(ids.old), 'oldest unread was not marked seen at bottom');
  const afterOldest = await evaluate(`({selected:document.querySelector('#session-title').textContent,distance:document.querySelector('#messages').scrollHeight-document.querySelector('#messages').scrollTop-document.querySelector('#messages').clientHeight})`);
  assert.ok(afterOldest.distance <= 8);
  print('open oldest unread + seen at bottom', afterOldest);

  await evaluate(`(() => { document.querySelector('[data-session-id="${ids.old}"]').click(); document.querySelector('[data-session-id="${ids.newer}"]').click(); })()`);
  await waitFor(() => evaluate(`document.querySelector('#session-title').textContent === 'New unread'`), 'new session lost race to stale request');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await evaluate(`document.querySelector('#session-title').textContent`), 'New unread');
  print('stale session request cannot overwrite new selection', { title: 'New unread' });

  await evaluate(`document.querySelector('[data-session-id="${ids.running}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#session-title').textContent === 'Running unread'`), 'running session did not open');
  await waitFor(() => state.seenPosts.includes(ids.running), 'opening running unread at bottom did not mark it seen');
  await waitFor(() => evaluate(`document.querySelectorAll('#messages .message').length === 90`), 'running messages did not render');
  const dimensions = await evaluate(`({height:document.querySelector('#messages').scrollHeight,client:document.querySelector('#messages').clientHeight})`);
  assert.ok(dimensions.height - dimensions.client > 100, `messages are not scrollable: ${JSON.stringify(dimensions)}`);
  await evaluate(`document.querySelector('#messages').scrollTop = 0`);
  const seenBeforeSettle = state.seenPosts.filter((id) => id === ids.running).length;
  await fetch(`http://127.0.0.1:${port}/control/settle-running`);
  const away = await waitFor(async () => {
    const value = await evaluate(`({unread:document.querySelector('[data-session-id="${ids.running}"]').classList.contains('unread'),slot:getComputedStyle(document.querySelector('[data-session-id="${ids.running}"]')).borderLeftColor,top:document.querySelector('#messages').scrollTop})`);
    return value.unread ? value : null;
  }, 'settled running session did not become unread while scrolled away');
  assert.equal(state.seenPosts.filter((id) => id === ids.running).length, seenBeforeSettle);
  assert.equal(away.top, 0);
  print('scrolled away preserves unread', away);

  await evaluate(`document.querySelector('#messages').scrollTop = document.querySelector('#messages').scrollHeight`);
  await waitFor(() => state.seenPosts.filter((id) => id === ids.running).length === seenBeforeSettle + 1, 'returning to bottom did not mark seen');
  await waitFor(() => evaluate(`!document.querySelector('[data-session-id="${ids.running}"]').classList.contains('unread')`), 'running unread slot did not clear');
  print('return to bottom marks seen', { posts: state.seenPosts.filter((id) => id === ids.running).length });

  const reload = browser.once('Page.loadEventFired');
  await browser.send('Page.reload', { ignoreCache: true });
  await reload;
  const persisted = await waitFor(async () => {
    const value = await evaluate(`({unread:Array.from(document.querySelectorAll('.tree-session.unread')).map((node)=>node.dataset.sessionId)})`);
    return value.unread.length === 0 ? value : null;
  }, 'seen state did not survive refresh');
  assert.deepEqual(persisted.unread, []);
  print('refresh preserves server seen state', persisted);
  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });
  print('RESULT', 'S1a-2 unread frontend PASS');
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
