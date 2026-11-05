#!/usr/bin/env node
// test/thinking-frame-cost.mjs —— 「思考边流边显」的**每帧成本门**（真 Chromium + 假 API）。
//
// 为什么要有它：`test/stream-frame-cost.mjs` 只量**正文**通道（它送的全是 `channel:"text"`），
// 而「甲 = 思考在流式中直接展开」这条已落地的行为**从未被量化**。用户拍板时留了一个唯一的未知：
// **思考一旦也走直播块，每帧新建节点 / 重算样式会不会显著上升**（跳变量化报告 §6.4 记的正文旧账：
// 节点 10→870、RecalcStyle 12→441）。这条门就是回答这个问题的机械台。
//
// 它量的是**每帧成本**，三档对照（同一夹具、同一节奏，只换通道 / 内容）：
//   ① `none`     —— 帧照发、payload 为空（`delta:""`）：纯调度/rAF 的地板，回答"固定开销有多大"；
//   ② `thinking` —— 当前实现（`channel:"thinking"` 进直播块 `.message-thinking > .thinking-body`）；
//   ③ `text`     —— 同样字符数走正文通道：**已被接受的廉价路径**，用来判"思考是不是比正文贵"。
// 每档跑两种 delta 粒度（**密** 4 字符 / **疏** 24 字符），另加一次 burst（一 tick 全塞）。
//
// 指标：交 DOM 的字符数（分 thinking-body / message-body）、新建节点数、布局读次数、
// longtask 总时长与最长一条、CDP `Performance.getMetrics` 的
// LayoutCount/LayoutDuration/RecalcStyle*/ScriptDuration/TaskDuration 窗口差值、rAF 帧间隔。
//
// 判据（见文件末 `LIMITS`）：都取**每 1000 字符**或**每次跑**的绝对上界，理由写在报告里，
// 依据是本次实测量到的数字 + 复现命令，不是拍脑袋。
//
// 形状：假 API（`web/` 原样伺服）+ 真 Chromium；只用高位随机端口 + 临时 user-data-dir；
// 不碰真实 profile、7331/7321；不 pkill（只杀自己 spawn 的 chromium）。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/thinking-frame-cost.mjs
//   SOPHO_THINKINGFRAMES_LIMIT_JSON='{"maxLongTaskMs":200}' node test/thinking-frame-cost.mjs

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = process.env.SOPHO_THINKINGFRAMES_WEB_ROOT || path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-thinkingframes-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-thinkingframes');
const reportFile = path.join(artifactRoot, 'thinking-frame-cost.json');

const SESSION_ID = '66666666-6666-4666-8666-666666666666';
const TARGET_CHARS = 4032; // ≥4000（派单硬要求）
// 历史 80 条：刚好 = renderMessages 的同步尾窗 RENDER_TAIL(80) ⇒ 结束那一刻的重画是**同步**的，
// 不会用 requestIdleCallback 分片把「重建历史」的成本漏进下一档（这会污染 createElement 计数）。
const HISTORY_COUNT = 80;

const historyFiller = '历史正文用来把滚动区域撑到真实大会话的量级。';
const baseMessages = Array.from({ length: HISTORY_COUNT }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `历史消息 ${index + 1}：${historyFiller.repeat(12)}` }],
}));
const sessions = [
  { id: SESSION_ID, name: '思考帧成本', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];

// 内容：凑到 TARGET_CHARS。thinking / text 用**同一段字**，只换通道。
const CONTENT = ('思考在流式中展开，每帧只应付出与新增字符成正比的排版代价，而不是整块重排。'.repeat(200)).slice(0, TARGET_CHARS);
const DELTA_SIZES = [{ key: 'dense', size: 4 }, { key: 'chunky', size: 24 }];
const PACE_MS = 8;
// 一次 burst（一 tick 塞满）只为拿"最坏单帧"的 longtask。
const RUN_PLAN = [
  { label: 'none/dense', arm: 'none', deltaSize: 4, paceMs: PACE_MS },
  { label: 'thinking/dense', arm: 'thinking', deltaSize: 4, paceMs: PACE_MS },
  { label: 'text/dense', arm: 'text', deltaSize: 4, paceMs: PACE_MS },
  { label: 'none/chunky', arm: 'none', deltaSize: 24, paceMs: PACE_MS },
  { label: 'thinking/chunky', arm: 'thinking', deltaSize: 24, paceMs: PACE_MS },
  { label: 'text/chunky', arm: 'text', deltaSize: 24, paceMs: PACE_MS },
  { label: 'thinking/dense(burst)', arm: 'thinking', deltaSize: 4, paceMs: 0 },
];

function contentFor(arm) {
  return arm === 'none' ? '' : CONTENT;
}
function framesFor(arm, deltaSize) {
  const text = contentFor(arm);
  if (!text) {
    // `none`：帧数/节奏与 thinking 一致，但 payload 为空。
    const count = Math.ceil(TARGET_CHARS / deltaSize);
    return Array.from({ length: count }, () => ({ channel: 'thinking', delta: '' }));
  }
  const channel = arm === 'thinking' ? 'thinking' : 'text';
  const frames = [];
  for (let index = 0; index < text.length; index += deltaSize) frames.push({ channel, delta: text.slice(index, index + deltaSize) });
  return frames;
}

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

// 页内注入：把「交给 DOM 的字符数」「新建节点」「布局读」「SSE delta 到达」变成可读计数。
// 全在 `Page.addScriptToEvaluateOnNewDocument` 里跑，所以在 app.js 注册监听之前就包好了。
const INSTRUMENT = `(() => {
  const S = {
    domCharsTotal: 0, domBodyChars: 0, domBodyWrites: 0, domThinkingChars: 0, domThinkingWrites: 0,
    appendDataCalls: 0, appendDataChars: 0,
    createElementCalls: 0, removeCalls: 0, liveRemoves: 0,
    layoutReads: 0, layoutReadsByProp: {},
    liveChildListMutations: 0, liveNodesAdded: 0, liveNodesRemoved: 0,
    thinkingBlocksAdded: 0, thinkingBlocksRemoved: 0,
    longTasks: 0, longTaskMs: 0, maxLongTaskMs: 0,
    deltaCount: 0, deltaChars: 0, deltaAt: [],
    frames: [], lastFrameAt: null,
  };
  window.__streamPerf = S;
  S.reset = () => {
    S.domCharsTotal = 0; S.domBodyChars = 0; S.domBodyWrites = 0; S.domThinkingChars = 0; S.domThinkingWrites = 0;
    S.appendDataCalls = 0; S.appendDataChars = 0; S.createElementCalls = 0; S.removeCalls = 0; S.liveRemoves = 0;
    S.layoutReads = 0; S.layoutReadsByProp = {};
    S.liveChildListMutations = 0; S.liveNodesAdded = 0; S.liveNodesRemoved = 0;
    S.thinkingBlocksAdded = 0; S.thinkingBlocksRemoved = 0;
    S.longTasks = 0; S.longTaskMs = 0; S.maxLongTaskMs = 0;
    S.deltaCount = 0; S.deltaChars = 0; S.deltaAt = [];
    S.frames = []; S.lastFrameAt = null;
  };
  // 直播块里的两个容器：正文级(.message-body) 与思考级(.thinking-body)。
  // ⚠️ 不要只查 parentElement —— 思考文本节点的父是 .thinking-body，它本身在 .message-body 里，
  //    但 className 不含 message-body，只查一层会把**思考的 DOM 写全漏掉**。
  const levelOf = (node) => {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || typeof el.closest !== 'function') return null;
    if (el.closest('.thinking-body')) return 'thinking';
    if (el.closest('.message-body')) return 'body';
    return null;
  };
  const account = (node, len) => {
    S.domCharsTotal += len;
    const level = levelOf(node);
    if (level === 'thinking') { S.domThinkingWrites += 1; S.domThinkingChars += len; }
    else if (level === 'body') { S.domBodyWrites += 1; S.domBodyChars += len; }
  };
  const tdesc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  Object.defineProperty(Node.prototype, 'textContent', {
    configurable: true, enumerable: tdesc.enumerable,
    get: tdesc.get,
    set(value) { account(this, value == null ? 0 : String(value).length); return tdesc.set.call(this, value); },
  });
  const ddesc = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data');
  Object.defineProperty(CharacterData.prototype, 'data', {
    configurable: true, enumerable: ddesc.enumerable,
    get: ddesc.get,
    set(value) { S.appendDataCalls += 1; const len = value == null ? 0 : String(value).length; S.appendDataChars += len; account(this, len); return ddesc.set.call(this, value); },
  });
  for (const method of ['appendData', 'insertData', 'replaceData', 'deleteData']) {
    const original = CharacterData.prototype[method];
    if (!original) continue;
    CharacterData.prototype[method] = function (...args) {
      S.appendDataCalls += 1;
      const data = typeof args[0] === 'string' ? args[0] : args[1];
      const len = data == null ? 0 : String(data).length;
      S.appendDataChars += len;
      account(this, len);
      return original.apply(this, args);
    };
  }
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (...args) { S.createElementCalls += 1; return createElement.apply(this, args); };
  const remove = Element.prototype.remove;
  Element.prototype.remove = function (...args) {
    S.removeCalls += 1;
    if (this.classList && this.classList.contains('live-message')) S.liveRemoves += 1;
    return remove.apply(this, args);
  };
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
  // SSE delta 到达（在 app.js 注册监听之前包一层 addEventListener）。
  const addListener = EventSource.prototype.addEventListener;
  EventSource.prototype.addEventListener = function (type, listener, options) {
    if (type === 'session.delta' && typeof listener === 'function') {
      const wrapped = function (event) {
        try {
          const data = JSON.parse(event.data);
          S.deltaCount += 1;
          S.deltaChars += (data.delta || '').length;
          S.deltaAt.push(performance.now());
        } catch {}
        return listener.call(this, event);
      };
      return addListener.call(this, type, wrapped, options);
    }
    return addListener.call(this, type, listener, options);
  };
  const observeMessages = () => {
    const box = document.querySelector('#messages');
    if (!box) { setTimeout(observeMessages, 10); return; }
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== 'childList') continue;
        const liveAdded = [...record.addedNodes].filter((n) => n.nodeType === 1 && n.classList && n.classList.contains('live-message'));
        const liveRemoved = [...record.removedNodes].filter((n) => n.nodeType === 1 && n.classList && n.classList.contains('live-message'));
        // 直接钉住本门的核心风险：直播块里的 .message-thinking 被重建了几次。
        // 帧间复用节点 ⇒ 一次流里恒为 1（建一次）；每帧重建 ⇒ ≈ 帧数。
        for (const node of record.addedNodes) if (node.nodeType === 1 && node.classList && node.classList.contains('message-thinking')) S.thinkingBlocksAdded += 1;
        for (const node of record.removedNodes) if (node.nodeType === 1 && node.classList && node.classList.contains('message-thinking')) S.thinkingBlocksRemoved += 1;
        S.liveChildListMutations += record.addedNodes.length + record.removedNodes.length;
        S.liveNodesAdded += liveAdded.length;
        S.liveNodesRemoved += liveRemoved.length;
      }
    }).observe(box, { childList: true, subtree: true });
  };
  observeMessages();
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) { S.longTasks += 1; S.longTaskMs += entry.duration; S.maxLongTaskMs = Math.max(S.maxLongTaskMs, entry.duration); }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
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

async function streamFrames(frames, paceMs) {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ frames, paceMs }),
  });
  if (!response.ok) throw new Error(`stream failed: ${response.status}`);
}

function summarizeFrames(frames) {
  if (!frames.length) return { count: 0, p50: null, p95: null, max: null, mean: null };
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (n) => Math.round(n * 100) / 100;
  return { count: frames.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1]), mean: round(frames.reduce((a, b) => a + b, 0) / frames.length) };
}

const port = await reservePort();
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
        const { frames: list, paceMs: pace } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!sessionStream || sessionStream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
        sendJson(response, 200, { ok: true, count: list.length });
        for (const frame of list) {
          if (sessionStream.destroyed) return;
          sessionStream.write(`event: session.delta\ndata: ${JSON.stringify({ channel: frame.channel, delta: frame.delta })}\n\n`);
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

  // 档与档之间必须干净：先等上一档的收尾（session.end 触发的历史重画 / 树刷新）真的停下来，
  // 再 reset 计数。否则「重建历史」的 createElement 会漏进下一档，把节点数读脏（实测过）。
  const waitForQuiet = async () => {
    await waitFor(() => evaluate(`document.querySelector('#messages')?.dataset.renderComplete === 'true' || document.querySelectorAll('#messages .message').length === ${HISTORY_COUNT}`), 'history render did not settle');
    let last = -1;
    let stable = 0;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && stable < 3) {
      const value = await evaluate(`window.__streamPerf.createElementCalls + window.__streamPerf.removeCalls`);
      if (value === last) stable += 1; else { stable = 0; last = value; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (stable < 3) throw new Error('page did not go quiet between runs');
  };

  const runs = [];
  for (const plan of RUN_PLAN) {
    const frames = framesFor(plan.arm, plan.deltaSize);
    await waitForQuiet();
    if (!sessionStream || sessionStream.destroyed) await waitFor(() => sessionStream !== null, 'session stream not connected');
    await emit('session.start');
    await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === true || document.querySelector('#abort') !== null`), `session.start did not register (${plan.label})`);
    await evaluate(`window.__streamPerf.reset(); window.__streamPerf.startFrames();`);
    const before = await browser.send('Performance.getMetrics');
    const startedAt = Date.now();
    await streamFrames(frames, plan.paceMs);
    // 等到页内真的把全部 delta 处理完（`none` 档没有可见内容，所以用 delta 到达计数当锚点）。
    await waitFor(() => evaluate(`window.__streamPerf.deltaCount >= ${frames.length}`), `${plan.label}: deltas did not arrive in page`, 30_000);
    await evaluate(`new Promise((resolve)=>{let left=6;const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
    const after = await browser.send('Performance.getMetrics');
    const elapsedMs = Date.now() - startedAt;
    const state = await evaluate(`(() => {
      const S = window.__streamPerf; S.stopFrames();
      const c = {}; for (const k of Object.keys(S)) if (typeof S[k] !== 'function' && k !== 'frames' && k !== 'deltaAt') c[k] = S[k];
      const body = document.querySelector('#messages .live-message .message-body');
      const thinking = document.querySelector('#messages .live-message .thinking-body');
      return { counters: c, frames: S.frames, liveBody: body?.textContent || '', liveThinking: thinking?.textContent || '', liveNodes: document.querySelectorAll('#messages .live-message').length };
    })()`);
    const run = {
      label: plan.label,
      arm: plan.arm,
      deltaSize: plan.deltaSize,
      paceMs: plan.paceMs,
      frameCount: frames.length,
      elapsedMs,
      contentChars: contentFor(plan.arm).length,
      ...state.counters,
      frames: summarizeFrames(state.frames),
      devtools: await perfDelta(before, after),
      liveBodyLength: state.liveBody.length,
      liveThinkingLength: state.liveThinking.length,
      liveNodes: state.liveNodes,
    };
    // 通道口径：思考档的可见内容在 .thinking-body，正文档在 .message-body，none 档无内容。
    run.visibleChars = run.arm === 'thinking' ? run.liveThinkingLength : run.arm === 'text' ? run.liveBodyLength : 0;
    run.contentMatches = run.arm === 'none' ? true : run.visibleChars === run.contentChars;
    runs.push(run);
    await emit('session.end', { stopReason: 'stop', errorMessage: null, text: contentFor(plan.arm) });
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0`), `${plan.label}: live block did not clear`);
    await evaluate(`window.__streamPerf.reset();`);
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0`), `${plan.label}: live block did not clear`);
    sessionStreaming = false;
  }

  // 派生「每 1000 字符」的数（思考档按 contentChars 归一；none 档 contentChars=0 ⇒ 记 null）。
  for (const run of runs) {
    const denom = run.contentChars > 0 ? run.contentChars / 1000 : null;
    run.per1000 = denom === null ? null : {
      LayoutDuration: run.devtools.LayoutDuration === null ? null : Math.round((run.devtools.LayoutDuration / denom) * 1000) / 1000,
      RecalcStyleDuration: run.devtools.RecalcStyleDuration === null ? null : Math.round((run.devtools.RecalcStyleDuration / denom) * 1000) / 1000,
      ScriptDuration: run.devtools.ScriptDuration === null ? null : Math.round((run.devtools.ScriptDuration / denom) * 1000) / 1000,
    };
    run.nodesCreatedPerFrame = run.frames.count ? Math.round((run.createElementCalls / run.frames.count) * 1000) / 1000 : null;
  }

  // ── 判据（阈值依据见 /tmp/thinking-frame-cost-report.md「阈值与依据」）──────────────
  // 每一条都取一个**足够宽、但仍能抓住「每帧重建 / 整块重排」那种回归**的绝对上界。
  const LIMITS = {
    // ① 思考通道交 DOM 的字符总数 ≤ 内容长度 × 1.5（增量 appendData ⇒ 恰好 = 内容长度；
    //    每帧整块重写 ⇒ ≈ 内容长度²/(2×delta) 量级）。
    thinkingDomCharsRatio: 1.5,
    // ② 一次流里新建元素总数 ≤ 64。这是**全局**计数（含每档开播时重建一次会话树的那 ~10 个元素 +
    //    直播块 4 个 + article/label 2 个）；帧间复用节点 ⇒ 实测 ~14。每帧重建 ⇒ ≈ 帧数（dense 1008）。
    //    留 ~4× 余量给树刷新抖动，仍比回归低两个数量级。
    nodesCreatedMax: 64,
    // ②′ 本门的**主判据**：直播块里 `.message-thinking` 只许建 1 次（帧间复用）。
    //    允许 2 是给“树/正文重画时同一个思考块被挂回”留一次抖动。每帧重建 ⇒ ≈ 帧数。
    thinkingBlocksMax: 2,
    // ③ 每 1000 字符思考的 LayoutDuration 上界（ms）。实测 thinking dense = 0.208、chunky = 0.036，
    //    取 1.5 ⇒ ~7× 余量。它只做“不是每帧整块重排”的宽松上限，真正的判别在 ②/②′/①。
    layoutMsPer1000Chars: 1.5,
    // ④ 单条 longtask 上限（ms）。实测全档 0–90ms；正文旧账 burst = 891ms。
    maxLongTaskMs: 200,
    // ⑤ 每帧布局读次数上界（scrollHeight/scrollTop/clientHeight 各一次）。
    layoutReadsPerFrame: 8,
    // ⑥ 整次流里 RecalcStyle 次数上界。实测最好实现全档 ≤ 3（树刷新）；合成回归（每帧重建块）
    //    thinking/dense = 492。取 32 ⇒ ~10× 余量，仍比回归低一个量级。
    recalcStyleCountMax: 32,
    ...(process.env.SOPHO_THINKINGFRAMES_LIMIT_JSON ? JSON.parse(process.env.SOPHO_THINKINGFRAMES_LIMIT_JSON) : {}),
  };

  const failures = [];
  for (const run of runs) {
    const measured = run.arm === 'none';
    // 自检：门必须真的量到了内容交 DOM（否则「永远通过」）。thinking 档 domThinkingChars 必须 ≈ 内容长度；
    // text 档 domBodyChars 必须 ≈ 内容长度。
    if (run.arm === 'thinking') {
      if (run.domThinkingChars < run.contentChars * 0.95) failures.push(`${run.label}: 思考内容没进 .thinking-body（domThinkingChars=${run.domThinkingChars}，期望≈${run.contentChars}）—— 门自己量错了`);
      if (run.domThinkingChars > run.contentChars * LIMITS.thinkingDomCharsRatio) failures.push(`${run.label}: domThinkingChars=${run.domThinkingChars} > ${Math.round(run.contentChars * LIMITS.thinkingDomCharsRatio)}（每帧整块重写会爆这里）`);
    }
    // 通道口径不许变：整段内容必须在直播块里逐字出现（否则“便宜”可能是靠少画东西换的）。
    if (!run.contentMatches) failures.push(`${run.label}: 直播块可见内容 ${run.visibleChars} != ${run.contentChars}（通道口径被改）`);
    if (run.arm === 'text') {
      if (run.domBodyChars < run.contentChars * 0.95) failures.push(`${run.label}: 正文内容没进 .message-body（domBodyChars=${run.domBodyChars}，期望≈${run.contentChars}）`);
      if (run.domBodyChars > run.contentChars * LIMITS.thinkingDomCharsRatio) failures.push(`${run.label}: domBodyChars=${run.domBodyChars} > ${Math.round(run.contentChars * LIMITS.thinkingDomCharsRatio)}`);
    }
    if (run.createElementCalls > LIMITS.nodesCreatedMax) failures.push(`${run.label}: 新建元素 ${run.createElementCalls} > ${LIMITS.nodesCreatedMax}（帧间应复用节点，每帧重建会爆这里）`);
    if (run.arm === 'thinking' && run.thinkingBlocksAdded > LIMITS.thinkingBlocksMax) failures.push(`${run.label}: .message-thinking 重建了 ${run.thinkingBlocksAdded} 次 > ${LIMITS.thinkingBlocksMax}（直播思考块必须帧间复用）`);
    if (run.maxLongTaskMs > LIMITS.maxLongTaskMs) failures.push(`${run.label}: maxLongTaskMs=${Math.round(run.maxLongTaskMs)} > ${LIMITS.maxLongTaskMs}`);
    const needsPer1000 = run.arm === 'thinking' && run.label !== 'thinking/dense(burst)';
    if (needsPer1000 && run.per1000.LayoutDuration !== null && run.per1000.LayoutDuration > LIMITS.layoutMsPer1000Chars) failures.push(`${run.label}: LayoutDuration=${run.per1000.LayoutDuration}ms/1000字符 > ${LIMITS.layoutMsPer1000Chars}`);
    const readsPerFrame = run.frames.count ? run.layoutReads / run.frames.count : null;
    if (readsPerFrame !== null && readsPerFrame > LIMITS.layoutReadsPerFrame) failures.push(`${run.label}: layoutReads/frame=${Math.round(readsPerFrame * 100) / 100} > ${LIMITS.layoutReadsPerFrame}`);
    if (run.devtools.RecalcStyleCount !== null && run.devtools.RecalcStyleCount > LIMITS.recalcStyleCountMax) failures.push(`${run.label}: RecalcStyleCount=${run.devtools.RecalcStyleCount} > ${LIMITS.recalcStyleCountMax}（每帧重建节点会重算样式）`);
    void measured;
  }
  if (pageProblems.length) failures.push(`页面异常：${JSON.stringify(pageProblems)}`);

  await mkdir(artifactRoot, { recursive: true });
  await writeFile(reportFile, `${JSON.stringify({ sessionId: SESSION_ID, contentChars: TARGET_CHARS, paceMs: PACE_MS, deltaSizes: DELTA_SIZES, historyCount: HISTORY_COUNT, chromium: version.Browser, limits: LIMITS, runs }, null, 2)}\n`);

  print('环境', { contentChars: TARGET_CHARS, paceMs: PACE_MS, historyCount: HISTORY_COUNT, chromium: version.Browser, viewport: '1200x760' });
  for (const run of runs) {
    print(`── ${run.label}`, {
      耗时ms: run.elapsedMs,
      帧数: run.frames.count,
      帧: run.frames,
      思考交DOM字符: run.domThinkingChars,
      正文交DOM字符: run.domBodyChars,
      appendData次: run.appendDataCalls,
      '新增元素/移除': `${run.createElementCalls}/${run.removeCalls}`,
      '新增/移除直播节点': `${run.liveNodesAdded}/${run.liveNodesRemoved}`,
      '思考块重建次数': run.thinkingBlocksAdded,
      可见内容字符: run.visibleChars,
      内容逐字相同: run.contentMatches,
      布局读: run.layoutReads,
      长任务: `${run.longTasks} 次 / 共 ${Math.round(run.longTaskMs)}ms / 最长 ${Math.round(run.maxLongTaskMs)}ms`,
      DevTools: run.devtools,
      每1000字符: run.per1000,
      每帧新建元素: run.nodesCreatedPerFrame,
    });
  }
  print('报告文件', reportFile);
  print('测法', '假 API 原样伺服 web/ + 真 Chromium；Page.addScriptToEvaluateOnNewDocument 注入计数器（textContent 写、CharacterData 增量写、createElement/remove、scrollHeight/scrollTop/clientHeight/getBoundingClientRect 读、EventSource.addEventListener 包 session.delta 到达、#messages MutationObserver、longtask）；CDP Performance.getMetrics 取窗口差值。');
  if (failures.length) {
    print('FAIL', failures);
    throw new Error(`thinking frame cost gate failed: ${failures.join(' | ')}`);
  }
  print('checks', runs.length);
  print('RESULT', `thinking frame cost PASS（${runs.length} 档；思考 dense 每1000字符 LayoutDuration=${runs.find((r) => r.label === 'thinking/dense')?.per1000?.LayoutDuration}ms，最长 longtask=${Math.round(Math.max(...runs.map((r) => r.maxLongTaskMs)))}ms，思考块重建最多 ${Math.max(...runs.filter((r) => r.arm === 'thinking').map((r) => r.thinkingBlocksAdded))} 次）`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  browser?.close();
  treeStream?.destroy();
  sessionStream?.destroy();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await cleanupStep(cleanupProblems, 'chromium exit', () => new Promise((resolve) => chromium.once('exit', resolve)));
  }
  if (server) {
    server.closeAllConnections();
    await cleanupStep(cleanupProblems, 'http server close', () => new Promise((resolve) => server.close(resolve)));
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
