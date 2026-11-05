#!/usr/bin/env node
// test/stream-frame-cost.mjs —— 「会话页流式卡顿」成因 A 的**真机量化门**（真 Chromium + 假 API）。
//
// 为什么要有它：流式卡顿的根因不是 JS（实测 JS 只有几毫秒），而是**每个 delta 都重写整块正文 +
// 强制读布局** ⇒ 交给 DOM 的字符数 ≈ 回复长度 × delta 数、正文节点每个 delta 重建一个，
// 排版/绘制成为瓶颈。这条门把这件事变成**机械可量**的数字，而不是「感觉卡」：
//
//   ① 交 DOM 的直播正文字符数（`domLiveChars`）—— 修复目标是 O(回复长度)，不是 O(回复长度×delta 数)；
//   ② 直播正文节点重建次数（`liveRebuilds`）—— 修复目标是一次回复 1 个节点；
//   ③ 布局读次数（`layoutReads`：scrollHeight/scrollTop/clientHeight/getBoundingClientRect）
//      —— 每帧有上界，不是每个 delta 两次；
//   ④ 浏览器自己的 DevTools 计时（LayoutCount/LayoutDuration/RecalcStyle*/ScriptDuration/TaskDuration）
//      —— 「卡在排版/绘制」这半句的原始证据；
//   ⑤ 长任务与帧间隔（p50/p95/max）—— 用户可感的形状；
//   ⑥ **正文口径不许变**：整段回复在直播块里逐字出现且只出现一次。
//
// 形状：假 API（`web/` 原样伺服）+ 真 Chromium；一条 2760 字符回复拆成 920 个 delta，
// 对同一份历史跑三种节奏（burst / 2 ms / 8 ms）。只用一个高位随机端口 + 临时 user-data-dir；
// 不碰真实 profile、7331/7321；不 pkill（只杀自己 spawn 的 chromium）。
//
// 用法：
//   node test/stream-frame-cost.mjs                 # 打印三种节奏的数字，并断言默认上界
//   SOPHO_STREAMFRAMES_MODE=2ms node test/stream-frame-cost.mjs
//   SOPHO_STREAMFRAMES_LIMIT_JSON='{"domLiveCharsRatio":6}' node test/stream-frame-cost.mjs

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = process.env.SOPHO_STREAMFRAMES_WEB_ROOT || path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-streamframes-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-streamframes');
const reportFile = path.join(artifactRoot, 'stream-frame-cost.json');

const SESSION_ID = '77777777-7777-4777-8777-777777777777';
const DELTA_COUNT = 920;
const DELTA_SIZE = 3;
const REPLY = ('流式下每个字都得来，一个都不许丢也不许重复。'.repeat(120)).slice(0, DELTA_COUNT * DELTA_SIZE);
const REPLY_LEN = REPLY.length;
const HISTORY_COUNT = 120; // 每段 ≈ 0.6 KB ⇒ 历史 join 成本与真实中大会话同量级

// 节奏：0 = 一个 tick 里全塞进去（最坏情况）；2/8 ms = 每 delta 间隔（浏览器每帧能收到多个）。
const PACES = [
  { name: 'burst(0ms)', paceMs: 0 },
  { name: 'paced(2ms)', paceMs: 2 },
  { name: 'paced(8ms)', paceMs: 8 },
];

const historyFiller = '历史正文用来把滚动区域撑到真实大会话的量级。';
const baseMessages = Array.from({ length: HISTORY_COUNT }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `历史消息 ${index + 1}：${historyFiller.repeat(12)}` }],
}));
const sessions = [
  { id: SESSION_ID, name: '流式量化', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];

let server;
let chromium;
let browser;
let treeStream;
let sessionStream;
let sessionStreaming = false;

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

async function waitFor(operation, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
  return result.result.value;
}

// 页内注入：把「交给 DOM 的字符数」「正文节点重建」「布局读」变成可读计数。
// 全部只包一层，不改语义（app.js 跑的还是原生方法）。
const INSTRUMENT = `(() => {
  const S = {
    domWritesTotal: 0, domCharsTotal: 0,
    domBodyWrites: 0, domBodyChars: 0,
    appendDataCalls: 0, appendDataChars: 0,
    createElementCalls: 0, removeCalls: 0, liveRemoves: 0,
    layoutReads: 0, layoutReadsByProp: {},
    liveChildListMutations: 0, liveNodesAdded: 0, liveNodesRemoved: 0,
    longTasks: 0, longTaskMs: 0, maxLongTaskMs: 0,
    frames: [], lastFrameAt: null,
  };
  window.__streamPerf = S;
  S.reset = () => {
    S.domWritesTotal = 0; S.domCharsTotal = 0; S.domBodyWrites = 0; S.domBodyChars = 0;
    S.appendDataCalls = 0; S.appendDataChars = 0; S.createElementCalls = 0; S.removeCalls = 0;
    S.liveRemoves = 0; S.layoutReads = 0; S.layoutReadsByProp = {};
    S.liveChildListMutations = 0; S.liveNodesAdded = 0; S.liveNodesRemoved = 0;
    S.longTasks = 0; S.longTaskMs = 0; S.maxLongTaskMs = 0; S.frames = []; S.lastFrameAt = null;
  };
  const inLive = (node) => {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(el && typeof el.className === 'string' && el.className.includes('message-body'));
  };
  // ① textContent 写
  const tdesc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  Object.defineProperty(Node.prototype, 'textContent', {
    configurable: true, enumerable: tdesc.enumerable,
    get: tdesc.get,
    set(value) {
      const len = value == null ? 0 : String(value).length;
      S.domWritesTotal += 1; S.domCharsTotal += len;
      if (inLive(this)) { S.domBodyWrites += 1; S.domBodyChars += len; }
      return tdesc.set.call(this, value);
    },
  });
  // ② 增量写（持久文本节点走 appendData/insertData/replaceData/data=）
  const ddesc = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data');
  Object.defineProperty(CharacterData.prototype, 'data', {
    configurable: true, enumerable: ddesc.enumerable,
    get: ddesc.get,
    set(value) {
      S.appendDataCalls += 1;
      const len = value == null ? 0 : String(value).length;
      S.appendDataChars += len;
      if (inLive(this)) { S.domBodyWrites += 1; S.domBodyChars += len; }
      return ddesc.set.call(this, value);
    },
  });
  for (const method of ['appendData', 'insertData', 'replaceData', 'deleteData']) {
    const original = CharacterData.prototype[method];
    if (!original) continue;
    CharacterData.prototype[method] = function (...args) {
      S.appendDataCalls += 1;
      const data = typeof args[0] === 'string' ? args[0] : args[1];
      S.appendDataChars += data == null ? 0 : String(data).length;
      if (inLive(this)) { S.domBodyWrites += 1; S.domBodyChars += data == null ? 0 : String(data).length; }
      return original.apply(this, args);
    };
  }
  // ③ 建/删节点
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (...args) { S.createElementCalls += 1; return createElement.apply(this, args); };
  const remove = Element.prototype.remove;
  Element.prototype.remove = function (...args) {
    S.removeCalls += 1;
    if (this.classList && this.classList.contains('live-message')) S.liveRemoves += 1;
    return remove.apply(this, args);
  };
  // ④ 布局读
  const readProps = [['Element', 'scrollHeight'], ['Element', 'scrollTop'], ['Element', 'clientHeight'], ['Element', 'scrollWidth'], ['Element', 'clientWidth'], ['HTMLElement', 'offsetHeight'], ['HTMLElement', 'offsetTop'], ['HTMLElement', 'offsetWidth']];
  for (const [ctorName, prop] of readProps) {
    const ctor = window[ctorName].prototype;
    const d = Object.getOwnPropertyDescriptor(ctor, prop);
    if (!d || !d.get) continue;
    Object.defineProperty(ctor, prop, {
      configurable: true, enumerable: d.enumerable,
      get() { S.layoutReads += 1; S.layoutReadsByProp[prop] = (S.layoutReadsByProp[prop] || 0) + 1; return d.get.call(this); },
      set: d.set,
    });
  }
  const gbcr = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (...args) {
    S.layoutReads += 1; S.layoutReadsByProp.getBoundingClientRect = (S.layoutReadsByProp.getBoundingClientRect || 0) + 1;
    return gbcr.apply(this, args);
  };
  // ⑤ #messages 里的实际 DOM 变更（正文节点重建的**事实**计数，不是靠猜调用）
  const observeMessages = () => {
    const box = document.querySelector('#messages');
    if (!box) { setTimeout(observeMessages, 10); return; }
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== 'childList') continue;
        const liveAdded = [...record.addedNodes].filter((n) => n.nodeType === 1 && n.classList && n.classList.contains('live-message'));
        const liveRemoved = [...record.removedNodes].filter((n) => n.nodeType === 1 && n.classList && n.classList.contains('live-message'));
        const total = record.addedNodes.length + record.removedNodes.length;
        S.liveChildListMutations += total;
        S.liveNodesAdded += liveAdded.length;
        S.liveNodesRemoved += liveRemoved.length;
      }
    }).observe(box, { childList: true, subtree: true });
  };
  observeMessages();
  // ⑥ 长任务
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) { S.longTasks += 1; S.longTaskMs += entry.duration; S.maxLongTaskMs = Math.max(S.maxLongTaskMs, entry.duration); }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  // ⑦ 帧间隔采样（由测试显式开关）
  S.startFrames = () => {
    S.frames = []; S.sampling = true;
    const step = (t) => {
      if (!S.sampling) return;
      if (S.lastFrameAt !== null) S.frames.push(t - S.lastFrameAt);
      S.lastFrameAt = t;
      requestAnimationFrame(step);
    };
    S.lastFrameAt = null;
    requestAnimationFrame(step);
  };
  S.stopFrames = () => { S.sampling = false; };
})();`;

async function emit(name, data = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  if (!response.ok) throw new Error(`emit ${name} failed: ${response.status}`);
}

/** 一次性把整轮 delta 交给假上游，服务端按 paceMs 写 SSE（模拟上游的送达节奏）。 */
async function streamDeltas(chunks, paceMs) {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chunks, paceMs }),
  });
  if (!response.ok) throw new Error(`stream failed: ${response.status}`);
}

function summarizeFrames(frames) {
  if (!frames.length) return { count: 0, p50: null, p95: null, max: null, mean: null };
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (n) => Math.round(n * 100) / 100;
  return {
    count: frames.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(frames.reduce((a, b) => a + b, 0) / frames.length),
  };
}

const port = await reservePort();
const paceMs = 0;
let primaryError;
try {
  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
      if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
      if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
      if (url.pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
        treeStream = response;
        return;
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(url.pathname);
      if (sessionMatch) {
        const id = sessionMatch[1];
        const action = sessionMatch[2] ?? null;
        const row = sessions.find((item) => item.id === id);
        if (!row) return sendJson(response, 404, { message: 'not found' });
        if (action === null) return sendJson(response, 200, { name: row.name, runtime: { isStreaming: sessionStreaming, isCompacting: false, isRetrying: false }, observability: null });
        if (action === 'messages') return sendJson(response, 200, { messages: baseMessages, extras: [], compaction: { atIndex: null }, observability: null });
        if (action === 'commands') return sendJson(response, 200, { streaming: sessionStreaming, commands: [] });
        if (action === 'seen') return sendJson(response, 200, { ok: true });
        if (action === 'draft') return sendJson(response, 200, { text: '' });
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: sessionStreaming, isCompacting: false, isRetrying: false, pendingMessages: 0 })}\n\n`);
          sessionStream = response;
          response.once('close', () => { if (sessionStream === response) sessionStream = null; });
          return;
        }
      }
      if (url.pathname === '/api/test/event' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!sessionStream || sessionStream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
        if (name === 'session.start') sessionStreaming = true;
        if (name === 'session.end') sessionStreaming = false;
        sessionStream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === '/api/test/stream' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { chunks: deltas, paceMs: pace } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!sessionStream || sessionStream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
        sendJson(response, 200, { ok: true, count: deltas.length });
        for (const delta of deltas) {
          if (sessionStream.destroyed) return;
          sessionStream.write(`event: session.delta\ndata: ${JSON.stringify({ channel: 'text', delta })}\n\n`);
          if (pace > 0) await new Promise((resolve) => setTimeout(resolve, pace));
        }
        return;
      }
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.resolve(webRoot, `.${pathname}`);
      if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
      try {
        const content = await readFile(file);
        response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
        response.end(content);
      } catch { response.writeHead(404).end(); }
    } catch (error) {
      try { response.writeHead(500).end(String(error && error.message)); } catch {}
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reservePort();
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank',
  ], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'Chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const pageProblems = [];
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Performance.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('#messages') && window.__streamPerf`), 'instrument or page did not load');
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"]') !== null`), 'session row did not render');
  await evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false && document.querySelectorAll('#messages .message').length === ${HISTORY_COUNT}`), 'session did not open');

  const perfDelta = async (before, after) => {
    const keys = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'];
    const out = {};
    for (const key of keys) {
      const a = before.metrics.find((m) => m.name === key)?.value ?? null;
      const b = after.metrics.find((m) => m.name === key)?.value ?? null;
      out[key] = a === null || b === null ? null : Math.round((b - a) * 1000) / 1000;
    }
    return out;
  };

  const runs = [];
  for (const pace of PACES) {
    if (!sessionStream || sessionStream.destroyed) await waitFor(() => sessionStream !== null, 'session stream not connected');
    await emit('session.start');
    await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === true || document.querySelector('#abort') !== null`), 'session.start did not register');
    await evaluate(`window.__streamPerf.reset(); window.__streamPerf.startFrames();`);
    const before = await browser.send('Performance.getMetrics');
    const startedAt = Date.now();
    const deltas = [];
    for (let index = 0; index < DELTA_COUNT; index += 1) deltas.push(REPLY.slice(index * DELTA_SIZE, (index + 1) * DELTA_SIZE));
    await streamDeltas(deltas, pace.paceMs);
    // 等页内把这一轮的 delta 全部消化：直播块正文 === 整段回复。
    await waitFor(() => evaluate(`(() => { const b=document.querySelector('#messages .live-message .message-body'); return !!b && b.textContent === ${JSON.stringify(REPLY)}; })()`), `pace=${pace.name}: live body did not reach full reply`, 20_000);
    await evaluate(`new Promise((resolve)=>{let left=4;const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
    const after = await browser.send('Performance.getMetrics');
    const counters = await evaluate(`(() => { const S=window.__streamPerf; S.stopFrames(); const c={}; for (const k of Object.keys(S)) if (typeof S[k] !== 'function' && k!=='frames') c[k]=S[k]; return { counters:c, frames:S.frames, liveBody: document.querySelector('#messages .live-message .message-body')?.textContent || '', liveNodes: document.querySelectorAll('#messages .live-message').length }; })()`);
    const elapsedMs = Date.now() - startedAt;
    const run = {
      pace: pace.name,
      paceMs: pace.paceMs,
      elapsedMs,
      ...counters.counters,
      frames: summarizeFrames(counters.frames),
      devtools: await perfDelta(before, after),
      liveBodyLength: counters.liveBody.length,
      liveBodyMatches: counters.liveBody === REPLY,
      liveNodes: counters.liveNodes,
    };
    runs.push(run);
    await emit('session.end', { stopReason: 'stop', errorMessage: null, text: REPLY });
    await evaluate(`window.__streamPerf.reset();`);
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0`), `pace=${pace.name}: live block did not clear`);
    sessionStreaming = false;
  }

  // 默认上界（按修复后的真机实测标定，留 1.5–4× 机器抖动余量）：
  //   domLiveCharsRatio 3     —— 修复后 = 1（回复长度），修复前 = 480
  //   liveNodesAddedMax  4    —— 修复后 = 1，修复前 = 920
  //   layoutReadsPerFrame 8   —— 修复后 ≤5.2，修复前 ≥14.6（burst 达 1290）
  //   maxLongTaskMs 400       —— 修复后 burst = 0，修复前 burst = 891 ms
  //   maxFrameMs 250          —— 修复后 burst max 16.7 ms，修复前 883 ms
  const limits = {
    domLiveCharsRatio: 3,
    liveNodesAddedMax: 4,
    liveRemovesMax: 4,
    layoutReadsPerFrame: 8,
    maxLongTaskMs: 400,
    maxFrameMs: 250,
    ...(process.env.SOPHO_STREAMFRAMES_LIMIT_JSON ? JSON.parse(process.env.SOPHO_STREAMFRAMES_LIMIT_JSON) : {}),
  };
  const loudest = runs.reduce((worst, run) => (worst === null || run.domBodyChars > worst.domBodyChars ? run : worst), null);
  const failures = [];
  for (const run of runs) {
    const readsPerFrame = run.frames.count ? run.layoutReads / run.frames.count : null;
    if (!run.liveBodyMatches) failures.push(`${run.pace}: 直播正文与回复不逐字相同（len=${run.liveBodyLength} 期望 ${REPLY_LEN}）`);
    if (run.domBodyChars > REPLY_LEN * limits.domLiveCharsRatio) failures.push(`${run.pace}: domBodyChars=${run.domBodyChars} > ${REPLY_LEN * limits.domLiveCharsRatio}`);
    if (run.liveNodesAdded > limits.liveNodesAddedMax) failures.push(`${run.pace}: liveNodesAdded=${run.liveNodesAdded} > ${limits.liveNodesAddedMax}`);
    if (run.liveRemoves > limits.liveRemovesMax) failures.push(`${run.pace}: liveRemoves=${run.liveRemoves} > ${limits.liveRemovesMax}`);
    if (readsPerFrame === null || readsPerFrame > limits.layoutReadsPerFrame) failures.push(`${run.pace}: layoutReads/frame=${readsPerFrame === null ? 'null' : Math.round(readsPerFrame * 100) / 100} > ${limits.layoutReadsPerFrame}`);
    if (run.maxLongTaskMs > limits.maxLongTaskMs) failures.push(`${run.pace}: maxLongTaskMs=${Math.round(run.maxLongTaskMs)} > ${limits.maxLongTaskMs}`);
    if (run.frames.max !== null && run.frames.max > limits.maxFrameMs) failures.push(`${run.pace}: maxFrameMs=${run.frames.max} > ${limits.maxFrameMs}`);
  }
  if (pageProblems.length) failures.push(`页面异常：${JSON.stringify(pageProblems)}`);

  await mkdir(artifactRoot, { recursive: true });
  await writeFile(reportFile, `${JSON.stringify({ sessionId: SESSION_ID, replyLen: REPLY_LEN, deltaCount: DELTA_COUNT, deltaSize: DELTA_SIZE, historyCount: HISTORY_COUNT, chromium: version.Browser, limits, runs }, null, 2)}\n`);

  print('环境', { replyLen: REPLY_LEN, deltaCount: DELTA_COUNT, historyCount: HISTORY_COUNT, chromium: version.Browser, viewport: '1200x760' });
  for (const run of runs) {
    print(`── ${run.pace}`, {
      耗时ms: run.elapsedMs,
      交DOM正文块字符: run.domBodyChars,
      交DOM总字符: run.domCharsTotal,
      正文块textContent写: run.domBodyWrites,
      增量appendData次: run.appendDataCalls,
      '新增/移除直播节点': `${run.liveNodesAdded}/${run.liveNodesRemoved}`,
      布局读: run.layoutReads,
      布局读明细: run.layoutReadsByProp,
      长任务: `${run.longTasks} 次 / 共 ${Math.round(run.longTaskMs)}ms / 最长 ${Math.round(run.maxLongTaskMs)}ms`,
      帧: run.frames,
      DevTools: run.devtools,
      直播正文逐字相同: run.liveBodyMatches,
    });
  }
  print('报告文件', reportFile);
  print('测法', '假 API 原样伺服 web/ + 真 Chromium；Page.addScriptToEvaluateOnNewDocument 注入计数器（Node.textContent 写、CharacterData 增量写、createElement/remove、scrollHeight/scrollTop/clientHeight/getBoundingClientRect 读、#messages MutationObserver、longtask）；CDP Performance.getMetrics 取 LayoutCount/LayoutDuration/RecalcStyle*/ScriptDuration/TaskDuration 的窗口差值。');
  if (failures.length) {
    print('FAIL', failures);
    throw new Error(`stream frame cost gate failed: ${failures.join(' | ')}`);
  }
  print('checks', runs.length);
  print('RESULT', `stream frame cost PASS（最响的一跑：${loudest.pace} 正文块交 DOM 字符 ${loudest.domBodyChars} = 回复长度 ×${Math.round((loudest.domBodyChars / REPLY_LEN) * 10) / 10}）`);
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  browser?.close();
  treeStream?.destroy();
  sessionStream?.destroy();
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
