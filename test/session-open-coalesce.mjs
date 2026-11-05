#!/usr/bin/env node
// test/session-open-coalesce.mjs —— 「打开一个会话时正文只拉一次」的**合并状态机**（假 API + 真 Chromium）。
//
// 与另外两条门的分工：
//   · `test/session-connect-flow.mjs`：假 API，快照**连上就发** ⇒ 只覆盖「两条拉取重叠」那一格；
//   · `test/session-open-fetch-count.mjs`：真 A/B + 真 Chromium，量真实现场（缓存命中时第一条 GET
//     先回来）—— 但那条时序是产品代码决定的，不能逐格拨；
//   · 本门：假 API **自己拨时序**，把 `web/app.js` 的 `sessionHello` 合并账逐格钉死：
//       ① 空闲 + 快照**晚到**（第一条 GET 已完成）⇒ 复用这一次，**只发 1 条**（本门要防的回归）；
//       ② 在跑 + 快照晚到 ⇒ **必须发第 2 条**（服务端登记 SSE 订阅在它把 runtime 打开之后，
//          「正文还在写」那一段里可能有落盘内容既没被第一条 GET 拿到、也没赶上订阅 ⇒ 不赌）；
//       ③ 在跑 + 快照**立刻到**（两条重叠）⇒ 由「在飞合并」挡掉，仍是 1 条；
//       ④ 空闲 + 断流后 EventSource 自动重连 ⇒ 重连那条快照**必须真拉**（断线期间的正文要补回来）。
//
// 红线：只起自己 spawn 的静态服务器与 Chromium，只按各自 pid 停（`test/harness.mjs`）；
// 高位随机端口；日志写本次沙箱；**不 pkill**；不碰真实 profile（本门根本不需要 A/profile）。

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, quiesceCdpPage, removeSandbox } from './harness.mjs';
import { reserveHighPort, sleep } from './perf-verify-lib.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-coalesce-'));

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
let checks = 0;
function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const baseMessages = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `COALESCE-${index}` }] }));

// 假 API 的可拨旋钮：在跑 / 空闲、快照延迟多久发、正文 GET 拖多久才回。
const config = { streaming: false, snapshotDelayMs: 500, messagesDelayMs: 0 };

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

function cdp(wsUrl, pageProblems) {
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
    if (message.method === 'Runtime.exceptionThrown') pageProblems.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageProblems.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
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
        const listener = (params) => { listeners.get(method).delete(listener); resolve(params); };
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(listener);
      });
    },
    close() { socket.close(); },
  };
}

let server = null;
let chromium = null;
let browser = null;
let primaryError = null;
let stream = null;
const pageProblems = [];
const messagesRequests = [];

async function waitFor(operation, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(30);
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

try {
  const port = await reserveHighPort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/tree') {
      return sendJson(response, 200, { sessions: [row()], unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    }
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: [row()] })}\n\n`);
      return;
    }
    if (url.pathname === '/api/test/config' && request.method === 'POST') {
      for await (const chunk of request) void chunk;
      config.streaming = url.searchParams.get('streaming') === '1';
      config.snapshotDelayMs = Number(url.searchParams.get('delay') ?? 500);
      config.messagesDelayMs = Number(url.searchParams.get('msgdelay') ?? 0);
      return sendJson(response, 200, { ok: true, config });
    }
    if (url.pathname === '/api/test/drop' && request.method === 'POST') {
      stream?.end();
      stream = null;
      return sendJson(response, 200, { ok: true });
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(url.pathname);
    if (match) {
      const action = match[2] ?? null;
      if (action === null) {
        return sendJson(response, 200, { name: '合并状态机', runtime: { isStreaming: config.streaming, isCompacting: false, isRetrying: false }, observability: null, context: null });
      }
      if (action === 'messages') {
        // ③ 要的是「快照与第一条 GET **真的重叠**」。只把快照设成 delay=0 并不够 ——
        // 两条都是异步，GET 常常先回来，于是走的是第 ② 格（在跑 + 快照晚到 ⇒ 该发第二条）,
        // 本机实测 10 次红 3（与总台 9 次红 5 同因）。这里让正文 GET **可控地按住一会儿**
        // （`msgdelay`，只有第 ③ 格设它），快照在 0ms 就发、必然落在这次 GET 还在飞的时候
        // ⇒ 在飞合并那一格才是确定性可测的。断言与阈值一字未动。
        if (config.messagesDelayMs) await sleep(config.messagesDelayMs);
        messagesRequests.push({ at: Date.now(), query: url.search });
        return sendJson(response, 200, { messages: baseMessages, extras: [], compaction: { atIndex: null }, observability: null });
      }
      if (action === 'commands') return sendJson(response, 200, { streaming: config.streaming, commands: [] });
      if (action === 'seen') return sendJson(response, 200, { ok: true });
      if (action === 'draft') return sendJson(response, 200, { text: '' });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write('retry: 100\n\n');
        // 产品的真相是「快照要等 runtime 打开」⇒ 这里用可拨的延迟模拟那一段。
        const delay = config.snapshotDelayMs;
        setTimeout(() => {
          if (response.destroyed) return;
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ sessionId: SESSION_ID, isStreaming: config.streaming, isCompacting: false, isRetrying: false, pendingMessages: 0, queue: { steering: [], followUp: [] } })}\n\n`);
        }, delay);
        stream = response;
        response.once('close', () => { if (stream === response) stream = null; });
        return;
      }
    }
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    const resolved = path.resolve(webRoot, `.${file}`);
    if (!resolved.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(resolved);
      response.writeHead(200, { 'content-type': contentType(resolved), 'cache-control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  function row() {
    return { id: SESSION_ID, name: '合并状态机', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } };
  }

  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  const debugPort = await reserveHighPort();
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'Chromium remote debugger did not start', 60_000);
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });

  const evaluate = (expression) => browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });

  /** 拨旋钮/断流都从 Node 走（页面此时可能还停在 about:blank）。 */
  function control(pathname) {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: pathname }, (response) => {
        response.on('data', () => {});
        response.on('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
      request.end();
    });
  }

  async function freshPage() {
    const loaded = browser.once('Page.loadEventFired');
    await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await loaded;
    await waitFor(() => evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"]') !== null`), 'tree did not render');
  }

  /** 点开会话，等正文画完 + 静置（静置期内没有新的 /messages 才算数）。 */
  async function openSession() {
    const before = messagesRequests.length;
    await evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"] .tree-select').click(); true`);
    await waitFor(() => evaluate(`(() => { const m = document.querySelector('#messages'); return m.dataset.renderComplete === 'true' && m.querySelectorAll('.message').length === ${baseMessages.length}; })()`), '正文没有渲成');
    // 等够长：延迟发的那条快照与它可能触发的第二次拉取都要落进来（不能只等一个 120ms 的空窗）。
    await sleep(config.snapshotDelayMs + 700);
    let seen = messagesRequests.length;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(120);
      if (messagesRequests.length === seen) break;
      seen = messagesRequests.length;
    }
    return messagesRequests.slice(before).map((record) => record.query || '(无查询串)');
  }

  // ① 空闲 + 快照晚到 ⇒ 只发 1 条
  await control('/api/test/config?streaming=0&delay=600');
  await freshPage();
  const idleLate = await openSession();
  print('① 空闲 + 快照晚到(600ms)', idleLate);
  check('① 空闲会话：快照晚到也不发第二条 GET（复用「选中会话」那一次）', idleLate.length === 1, `GET /messages 次数=${idleLate.length} 明细=${JSON.stringify(idleLate)}`);

  // ② 在跑 + 快照晚到 ⇒ 必须发第 2 条（正文还在写，那一段有丢内容的风险）
  await control('/api/test/config?streaming=1&delay=600');
  await freshPage();
  const busyLate = await openSession();
  print('② 在跑 + 快照晚到(600ms)', busyLate);
  check('② 在跑的会话：快照晚到时**必须**发第二条（不许把还在写的正文合并掉）', busyLate.length === 2, `GET /messages 次数=${busyLate.length} 明细=${JSON.stringify(busyLate)}`);

  // ③ 在跑 + 快照立刻到（两条重叠）⇒ 由「在飞合并」挡掉，仍是 1 条
  // `msgdelay=600`：把正文 GET 按住 600ms，保证 0ms 就发的快照**落在它还在飞的时候**（见 messages 路由注释）。
  await control('/api/test/config?streaming=1&delay=0&msgdelay=600');
  await freshPage();
  const busyFast = await openSession();
  print('③ 在跑 + 快照立刻到', busyFast);
  check('③ 在跑的会话：快照立刻到（与第一条 GET 重叠）⇒ 在飞合并生效，仍是 1 条', busyFast.length === 1, `GET /messages 次数=${busyFast.length} 明细=${JSON.stringify(busyFast)}`);

  // ④ 空闲 + 断流重连 ⇒ 重连那条快照必须真拉（第一次 1 条 + 重连 1 条）
  await control('/api/test/config?streaming=0&delay=600');
  await freshPage();
  const offsetBeforeFourth = messagesRequests.length;
  const first = await openSession();
  await evaluate(`fetch('/api/test/drop', { method: 'POST' })`);
  const reconnected = await waitFor(async () => {
    // 注意：计数要按**绝对下标**减（`first` 是这一臂的切片，它的 length 不是数组下标）。
    const count = messagesRequests.length - offsetBeforeFourth - first.length;
    return count >= 1 ? count : null;
  }, '重连后没有补拉正文', 15_000);
  print('④ 空闲 + 断流重连', { first, reconnectRequests: reconnected, streams: messagesRequests.length });
  check('④ 断流重连：重连那条快照**必须真拉**（第一次 1 条 + 重连 ≥1 条）', first.length === 1 && reconnected >= 1, `首次=${first.length} 重连后新增=${reconnected}`);
  check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));

  print('environment', { browser: version.Browser, chrome, node: process.version, viewport: '1200x760' });
  print('RESULT', `session open coalesce PASS (${checks} checks)`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'quiesce page', () => quiesceCdpPage(browser));
  await cleanupStep(cleanupProblems, 'close browser', () => browser?.close());
  if (chromium && chromium.exitCode === null) {
    await cleanupStep(cleanupProblems, 'stop chromium', async () => {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    });
  }
  if (server) {
    await cleanupStep(cleanupProblems, 'close server', async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
