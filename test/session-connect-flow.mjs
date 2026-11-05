#!/usr/bin/env node
// test/session-connect-flow.mjs —— 「选中一个会话 → 会话流连上 → 连上之后页面跳不跳」的观察台 + 门。
//
// 与 test/switch-session-paint.mjs 的分工：
//   · 那个门问的是「**切**会话时正文画几遍」；
//   · 这个门问的是**初连/重连**这条路径：
//       ① `选中会话 → EventSource open → 收到 session.snapshot → 首次正文可见（首屏）→ 全部补齐/静置`
//          每一段的 ms（页内 performance.now，逐段给原始标记）；
//       ② 连上之后**正文有没有被重建/重画**（同一份正文插两次 = 白烧 CPU + 可见地跳一下）；
//       ③ 首屏之后**高度沉降**让读者眼前那一段动了多少（Δpx 口径 —— 见 docs/design-intent.md
//          「量化口径」：这里不是 `session.end` 那一刻，先给 Δpx，同时把原生 CLS 也记下来对照）。
//
// 形状：真 Chromium + 假 API（照 switch-session-paint.mjs / big-session-firstpaint.mjs 的套路）。
// 默认只观察（exit 0）；`--assert` 才断言。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, quiesceCdpPage, removeSandbox } from './harness.mjs';
import { bandDiff, decodePng, isUniform } from './screencast-bands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const artifactRoot = process.env.SOPHO_CONNECT_ARTIFACT_DIR || path.join(os.tmpdir(), 'sopho-connect-flow');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-connect-'));

const BIG_ID = '11111111-1111-4111-8111-111111111111';
const SMALL_ID = '22222222-2222-4222-8222-222222222222';
const BIG_COUNT = Number(process.env.SOPHO_CONNECT_BIG ?? 1521);
const SMALL_COUNT = 12;

const fillerUnit = '保持大会话正文形状的中文填充句子。';
const bigFiller = fillerUnit.repeat(169); // ≈10 KB/条
// 等高 fixture（默认）用来对照 switchpaint；`SOPHO_CONNECT_VARIED=1` 换**长短悬殊**的正文 ——
// 估算高度最容易失真的正是这种（真实内容一屏里既有 1 行也有几百行），也是线上会话的形状。
const varied = process.env.SOPHO_CONNECT_VARIED === '1';
function variedUnit(index) {
  // 用确定性的长度序列（不依赖随机种子），覆盖 1 行 … 几百行。
  const factor = [1, 40, 3, 200, 8, 90, 2, 300][index % 8];
  return fillerUnit.repeat(Math.max(1, factor * 2));
}
const bigMessages = Array.from({ length: BIG_COUNT }, (_, index) => {
  const text = varied ? variedUnit(index) : bigFiller;
  const head = `MSG${index}：${text}`;
  return index % 2
    ? { role: 'assistant', parts: [{ type: 'text', text: head }, { type: 'tool', name: 'bash', status: 'done-success', args: { command: `echo ${index}` }, result: `工具结果 ${index}：\n\`\`\`\n${text.slice(0, varied ? Math.max(200, text.length >> 1) : 600)}\n\`\`\`` }] }
    : { role: 'user', parts: [{ type: 'text', text: head }] };
});
const smallMessages = Array.from({ length: SMALL_COUNT }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `MSG${index}：这是一条小会话正文。` }],
}));

const bodies = new Map([
  [BIG_ID, JSON.stringify({ messages: bigMessages, extras: [], compaction: { atIndex: null }, observability: null })],
  [SMALL_ID, JSON.stringify({ messages: smallMessages, extras: [], compaction: { atIndex: null }, observability: null })],
]);
const counts = new Map([[BIG_ID, BIG_COUNT], [SMALL_ID, SMALL_COUNT]]);

const sessions = [
  { id: BIG_ID, name: '大会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: SMALL_ID, name: '小会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];

// 可选：给 `/sessions/{id}` 与 `/messages` 加人为延迟/分片，模拟真机上「按会话大小要等一会儿」的那一段。
const phaseDelayMs = Number(process.env.SOPHO_CONNECT_PHASE_DELAY ?? 0);

let server;
let chromium;
let browser;
let treeStream;
const sessionStreams = new Map();
let messagesRequests = 0;
const requestsByPath = new Map();
const assert = process.argv.includes('--assert') || process.env.SOPHO_CONNECT_ASSERT === '1';
let checks = 0;

function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function sendBody(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extraHeaders });
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

async function waitFor(operation, message, timeoutMs = 8000) {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(handler);
      return () => listeners.get(method)?.delete(handler);
    },
    close() { socket.close(); },
  };
}

async function evaluate(expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
  return result.result.value;
}

async function perfMetrics() {
  const { metrics } = await browser.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

// 页内探针。与 switchpaint 的 TRACE 同源，差别是这里额外记：
//   · fetch / EventSource 的**每一段时刻**（谁在等谁）；
//   · layout-shift 的**来源节点**（哪一段正文在动、动多少）—— 这是「跳变归因」的直接证据；
//   · `#session-connection` 的状态切换（● 已连接那一刻）。
const TRACE_SOURCE = `(() => {
  const m = document.querySelector('#messages');
  const cf = window.__cf = { t0: performance.now(), marks: [], inserts: [], removes: [], frames: [], shifts: [] };
  const rel = () => Math.round((performance.now() - cf.t0) * 100) / 100;
  const mark = (kind, detail) => cf.marks.push({ t: rel(), kind, ...detail });

  // ── 网络时序：fetch 与 EventSource 各段的真实时刻 ───────────────────────────
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    mark('fetch-start', { url });
    try {
      const response = await origFetch(input, init);
      mark('fetch-end', { url, status: response.status });
      return response;
    } catch (error) {
      mark('fetch-error', { url, error: String(error?.name || error) });
      throw error;
    }
  };
  const OrigEventSource = window.EventSource;
  window.EventSource = function (url, config) {
    mark('es-construct', { url });
    const instance = new OrigEventSource(url, config);
    instance.addEventListener('open', () => mark('es-open', { url }));
    instance.addEventListener('error', () => mark('es-error', { url }));
    return instance;
  };
  window.EventSource.prototype = OrigEventSource.prototype;
  window.EventSource.CONNECTING = OrigEventSource.CONNECTING;
  window.EventSource.OPEN = OrigEventSource.OPEN;
  window.EventSource.CLOSED = OrigEventSource.CLOSED;

  // ── 原生 layout-shift：逐条带上「搬动了哪几段、搬了多少」 ─────────────────
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        cf.shifts.push({
          t: Math.round((entry.startTime - cf.t0) * 100) / 100,
          value: entry.value,
          sources: (entry.sources || []).map((source) => ({
            node: source.node ? (source.node.className || source.node.tagName || '').slice(0, 40) : null,
            idx: source.node?.dataset?.cfIdx ?? null,
            prevTop: source.previousRect ? Math.round(source.previousRect.top) : null,
            curTop: source.currentRect ? Math.round(source.currentRect.top) : null,
            prevHeight: source.previousRect ? Math.round(source.previousRect.height) : null,
            curHeight: source.currentRect ? Math.round(source.currentRect.height) : null,
          })),
        });
      }
    }).observe({ type: 'layout-shift', buffered: false });
  } catch (error) { cf.shiftError = String(error); }

  // ── 正文插入：每个节点插在第几位、是哪一条 ───────────────────────────────
  const idxOf = (node) => {
    const match = /MSG(\\d+)/.exec(node.textContent.slice(0, 80));
    return match ? Number(match[1]) : null;
  };
  const observer = new MutationObserver((records) => {
    const t = rel();
    for (const record of records) {
      if (record.type !== 'childList') continue;
      const target = record.target;
      if (!(target === m || target.parentNode === m || target.closest?.('#messages') === m)) continue;
      for (const node of record.addedNodes) {
        if (!(node instanceof Element) || !node.matches('.message, .extra-message, .compaction-note')) continue;
        const index = idxOf(node);
        if (index !== null) node.dataset.cfIdx = String(index);
        const siblings = node.parentNode ? Array.from(node.parentNode.children) : [];
        cf.inserts.push({ t, idx: index, at: siblings.indexOf(node), parent: node.parentNode === m ? 'messages' : (node.parentNode?.className || 'other') });
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element) || !node.matches('.message, .extra-message, .compaction-note')) continue;
        cf.removes.push({ t, idx: node.dataset.cfIdx ? Number(node.dataset.cfIdx) : null });
      }
    }
  });
  observer.observe(m, { childList: true, subtree: true });

  // ── 每帧几何：读者眼前那一段（顶部可见 / 底部可见 / 它们的 top） ─────────────
  const sample = () => {
    const r = m.getBoundingClientRect();
    const pane = { top: r.top + 14, bottom: r.bottom - 14 };
    let visFirst = null; let visLast = null; let visCount = 0; let topNodeTop = null; let botNodeTop = null;
    for (const node of m.children) {
      if (!node.dataset || node.dataset.cfIdx === undefined) continue;
      const box = node.getBoundingClientRect();
      if (box.bottom < pane.top || box.top > pane.bottom) continue;
      const value = Number(node.dataset.cfIdx);
      if (visFirst === null) { visFirst = value; topNodeTop = Math.round(box.top); }
      visLast = value;
      botNodeTop = Math.round(box.top);
      visCount += 1;
    }
    // 稳定锚点 = **最后一条正文**（idx == expect-1）的位置：它不受「补齐把旧节点插到前面」影响，
    // 每一帧都取同一条 ⇒ 它的 top/bottom 变化就是读者眼睛里的跳变（Δpx 口径）。
    const lastIdx = cf.expect === undefined ? null : String(cf.expect - 1);
    const lastNode = lastIdx === null ? null : Array.from(m.children).filter((node) => node.dataset && node.dataset.cfIdx === lastIdx).pop();
    const lastBox = lastNode ? lastNode.getBoundingClientRect() : null;
    const mBox = m.getBoundingClientRect();
    cf.frames.push({
      t: rel(),
      top: Math.round(m.scrollTop),
      height: Math.round(m.scrollHeight),
      client: Math.round(m.clientHeight),
      dist: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
      bubbles: m.querySelectorAll('.message').length,
      complete: m.dataset.renderComplete ?? null,
      virtual: m.dataset.virtual ?? null,
      visFirst, visLast, visCount, topNodeTop, botNodeTop,
      jumpShown: document.querySelector('#jump')?.classList.contains('show') ?? null,
      lastTop: lastBox ? Math.round(lastBox.top) : null,
      lastBottom: lastBox ? Math.round(lastBox.bottom) : null,
      lastBottomGap: lastBox ? Math.round(mBox.bottom - lastBox.bottom) : null,
    });
    if (cf.watching) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  // ── 连接状态（● 已连接）与 renderComplete 的切换时刻 ────────────────────────
  const conn = document.querySelector('#session-connection');
  if (conn) new MutationObserver(() => mark('stream-state', { text: conn.textContent })).observe(conn, { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => mark('render-complete', { value: m.dataset.renderComplete ?? null })).observe(m, { attributes: true, attributeFilter: ['data-render-complete'] });

  cf.reset = () => { cf.inserts.length = 0; cf.removes.length = 0; cf.frames.length = 0; cf.marks.length = 0; cf.shifts.length = 0; return true; };
  cf.start = (expect) => { if (expect !== undefined) cf.expect = expect; cf.watching = true; requestAnimationFrame(sample); return true; };
  cf.stop = () => { cf.watching = false; return { t0: cf.t0, marks: cf.marks.slice(), inserts: cf.inserts.slice(), removes: cf.removes.slice(), frames: cf.frames.slice(), shifts: cf.shifts.slice(), shiftError: cf.shiftError ?? null }; };
  cf.counts = () => ({ inserts: cf.inserts.length, removes: cf.removes.length });
  return true;
})()`;

function batches(inserts) {
  const out = [];
  for (const item of inserts) {
    const last = out[out.length - 1];
    if (last && item.t - last.lastT <= 8) {
      last.count += 1;
      last.lastT = item.t;
      if (item.idx !== null) { last.firstIdx = last.firstIdx === null ? item.idx : Math.min(last.firstIdx, item.idx); last.lastIdx = last.lastIdx === null ? item.idx : Math.max(last.lastIdx, item.idx); }
      last.positions.push(item.at);
    } else {
      out.push({ t: item.t, count: 1, lastT: item.t, firstIdx: item.idx, lastIdx: item.idx, positions: [item.at] });
    }
  }
  return out.map((batch) => ({ t: batch.t, nodes: batch.count, indices: batch.firstIdx === null ? null : [batch.firstIdx, batch.lastIdx], atMin: Math.min(...batch.positions) }));
}

const clickSession = (id) => `document.querySelector('[data-session-id="${id}"] .tree-select').click(); true`;
const screencast = process.env.SOPHO_CONNECT_SCREENCAST === '1';
// 隔离实验用：整页重开后先注入一段 CSS（例如干掉 content-visibility），再点会话。
// 只在显式给文件时生效；门里不给 ⇒ 走真实样式。
const cssPatchFile = process.env.SOPHO_CONNECT_CSS_PATCH_FILE || null;
const cssPatch = cssPatchFile ? await readFile(cssPatchFile, 'utf8') : '';
const jsPatchFile = process.env.SOPHO_CONNECT_JS_PATCH_FILE || null;
const jsPatch = jsPatchFile ? await readFile(jsPatchFile, 'utf8') : '';
const onlyInitial = process.env.SOPHO_CONNECT_ONLY_INITIAL === '1';

await mkdir(artifactRoot, { recursive: true });
const port = await reservePort();
const report = { fixture: { bigCount: BIG_COUNT, smallCount: SMALL_COUNT, varied }, runs: [], environment: {} };
const cleanupProblems = [];
const pageProblems = [];
function writeArtifact() {
  return writeFile(path.join(artifactRoot, 'connect-flow.json'), `${JSON.stringify(report, null, 2)}\n`);
}
try {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    requestsByPath.set(url.pathname, (requestsByPath.get(url.pathname) || 0) + 1);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      treeStream = response;
      return;
    }
    // 受控断流：让 EventSource 自己按 retry 重连（重连路径的入口）。
    if (url.pathname === '/api/test/drop') {
      const id = url.searchParams.get('id') || BIG_ID;
      const stream = sessionStreams.get(id);
      if (!stream) return sendJson(response, 409, { message: 'no session stream' });
      stream.end();
      sessionStreams.delete(id);
      return sendJson(response, 200, { ok: true });
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|message))?$/.exec(url.pathname);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const action = sessionMatch[2] ?? null;
      const row = sessions.find((item) => item.id === id);
      if (!row) return sendJson(response, 404, { message: 'not found' });
      if (action === null) {
        if (phaseDelayMs) await sleep(phaseDelayMs);
        return sendJson(response, 200, { name: row.name, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null });
      }
      if (action === 'messages') {
        messagesRequests += 1;
        if (phaseDelayMs) await sleep(phaseDelayMs);
        return sendBody(response, 200, bodies.get(id), { 'x-fake-bytes': String(bodies.get(id).length) });
      }
      if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] });
      if (action === 'seen') return sendJson(response, 200, { ok: true });
      if (action === 'draft') return sendJson(response, 200, { text: '' });
      if (action === 'message') return sendJson(response, 200, { ok: true });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        // 真 base 在初连时必发一条 session.snapshot（app.js 收到后会再 refreshMessages 一次）——照抄。
        response.write('retry: 200\n\n');
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        sessionStreams.set(id, response);
        response.once('close', () => { if (sessionStreams.get(id) === response) sessionStreams.delete(id); });
        return;
      }
    }
    if (url.pathname === '/index.html' || url.pathname === '/') {
      const content = await readFile(path.join(webRoot, 'index.html'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(content);
    }
    const file = path.resolve(webRoot, `.${url.pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  const debugPort = await reservePort();
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'Chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${BIG_ID}"]') !== null`), 'tree did not render');
  await evaluate(TRACE_SOURCE);
  await browser.send('Performance.enable');
  report.environment = { browser: version.Browser, chrome, viewport: '1200x760', node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, loadavg: os.loadavg(), phaseDelayMs };

  async function waitQuiet(expectedCount, polls = 4) {
    let last = null;
    let lastSeen = null;
    let stable = 0;
    try {
      await waitFor(async () => {
        const value = await evaluate(`(() => { const m = document.querySelector('#messages'); const counts = window.__cf.counts(); return { bubbles: m.querySelectorAll('.message').length, complete: m.dataset.renderComplete ?? null, inserts: counts.inserts, removes: counts.removes }; })()`);
        lastSeen = value;
        const settled = value.bubbles === expectedCount && value.complete === 'true';
        if (settled && last && value.inserts === last.inserts && value.removes === last.removes) stable += 1;
        else stable = 0;
        last = value;
        return stable >= polls;
      }, 'page did not go quiet', 60000);
    } catch (error) {
      throw new Error(`${error.message}; 期待条数=${expectedCount}，最后一次观察=${JSON.stringify(lastSeen)}`);
    }
  }

  // 跑一条「初连 / 重连」臂。trigger 由调用方给（点树行 / 断流触发重连 / 深链导航）。
  async function runFlow(label, id, expectedCount, { trigger, kind = 'initial', waitQuiet: doWait = true } = {}) {
    process.stdout.write(`… runFlow start: ${label}\n`);
    await evaluate(`window.__cf.reset()`);
    const timeOrigin = await evaluate('performance.timeOrigin');
    const frames = [];
    let screencastError = null;
    const offScreencast = browser.on('Page.screencastFrame', (params) => {
      frames.push({ t: Math.round((params.metadata.timestamp * 1000 - timeOrigin) * 10) / 10, data: params.data });
      browser.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch((error) => { screencastError = error.message; });
    });
    if (screencast) await browser.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1200, maxHeight: 760 });
    const startedAt = await evaluate(`(() => { window.__cf.start(${expectedCount}); return Math.round(performance.now()*100)/100; })()`);
    const metricsBefore = await perfMetrics();
    const markBefore = await evaluate('window.__cf.t0');
    const clockStart = await evaluate('performance.now()');
    process.stdout.write(`… trigger: ${label}\n`);
    await evaluate(trigger);
    process.stdout.write(`… triggered: ${label}\n`);
    if (doWait) await waitQuiet(expectedCount);
    process.stdout.write(`… quiet: ${label}\n`);
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    const trace = await evaluate('window.__cf.stop()');
    process.stdout.write(`… trace: ${label} inserts=${trace.inserts.length} shifts=${trace.shifts.length}\n`);
    const metricsAfter = await perfMetrics();
    const paneRect = await evaluate(`(() => { const r = document.querySelector('#messages').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
    const tail = await evaluate(`(() => {
      const m = document.querySelector('#messages');
      return {
        bubbles: m.querySelectorAll('.message').length,
        scrollTop: Math.round(m.scrollTop), scrollHeight: Math.round(m.scrollHeight), clientHeight: Math.round(m.clientHeight),
        dist: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
        complete: m.dataset.renderComplete, total: m.dataset.messageTotal, virtual: m.dataset.virtual,
        textTotal: (m.textContent.match(/MSG\\d+/g) || []).length,
        title: document.querySelector('#session-title').textContent,
      };
    })()`);

    process.stdout.write(`… settle begin: ${label}\n`);
    const settle = await evaluate(`(() => {
      const m = document.querySelector('#messages');
      const kids = Array.from(m.children).filter((node) => node.dataset && node.dataset.cfIdx !== undefined);
      // 估算 vs 真实：把 content-visibility 临时撤掉（强制全部真布局）后再读 scrollHeight。
      const before = m.scrollHeight;
      const savedTop = m.scrollTop;
      const saved = kids.map((node) => node.style.contentVisibility);
      kids.forEach((node) => { node.style.contentVisibility = 'visible'; });
      void m.offsetHeight;
      const real = m.scrollHeight;
      kids.forEach((node, index) => { node.style.contentVisibility = saved[index]; });
      void m.offsetHeight;
      const back = m.scrollHeight;
      // 这一发只量「估算 vs 真实」，不许把容器滚动位置永久改掉（否则下一臂从错位置起跑）。
      m.scrollTop = savedTop;
      return { estimateHeight: Math.round(before), realHeight: Math.round(real), restoredHeight: Math.round(back), deltaPx: Math.round(real - before), nodes: kids.length, scrollTopRestored: m.scrollTop === savedTop };
    })()`);
    process.stdout.write(`… settle done: ${label}\n`);
    if (screencast) await browser.send('Page.stopScreencast');
    offScreencast();
    const referenceShot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const safe = label.replace(/[^0-9A-Za-z()+-]/g, '_');
    await writeFile(path.join(artifactRoot, `settled-${safe}.png`), Buffer.from(referenceShot.data, 'base64'));
    const reference = decodePng(Buffer.from(referenceShot.data, 'base64'));
    const paint = [];
    for (const [index, frame] of frames.entries()) {
      try {
        const bytes = Buffer.from(frame.data, 'base64');
        await writeFile(path.join(artifactRoot, `frame-${safe}-${String(index).padStart(2, '0')}-t${Math.round(frame.t)}.png`), bytes);
        const image = decodePng(bytes);
        paint.push({ t: frame.t, size: [image.width, image.height], bands: bandDiff(image, reference, paneRect, 6), blank: isUniform(image, paneRect) });
      } catch (error) {
        paint.push({ t: frame.t, error: error.message, size: null });
      }
    }
    // 每段时序：从 marks + inserts 里抽「选中 → fetch → EventSource → 首屏 → 补齐 → 静置」的每一段。
    const phase = phaseTimeline(trace.marks, trace.frames, expectedCount, trace.inserts);
    const result = {
      label, id, kind, expectedCount, startedAt, clockStart, markBefore, tail,
      phase,
      mainThread: {
        scriptMs: Math.round((metricsAfter.ScriptDuration - metricsBefore.ScriptDuration) * 1000),
        taskMs: Math.round((metricsAfter.TaskDuration - metricsBefore.TaskDuration) * 1000),
        layoutCount: metricsAfter.LayoutCount - metricsBefore.LayoutCount,
      },
      cls: Math.round(trace.shifts.reduce((sum, entry) => sum + entry.value, 0) * 10000) / 10000,
      shifts: trace.shifts,
      insertedNodes: trace.inserts.length,
      removedNodes: trace.removes.length,
      distinctIndicesInserted: new Set(trace.inserts.map((item) => item.idx).filter((value) => value !== null)).size,
      doubleInsertedIndices: doubleIndices(trace.inserts),
      batches: batches(trace.inserts),
      frames: trace.frames,
      marks: trace.marks,
      settle,
      paneRect,
      screencastError,
      paint,
    };
    result.jump = anchorJump(trace.frames, expectedCount);
    report.runs.push(result);
    return result;
  }

  // 预热：开小会话，让 renderer / SSE 都走一遍（避免把「第一次」当稳态）。
  await evaluate(clickSession(SMALL_ID));
  await waitQuiet(SMALL_COUNT);

  // 真·初连：整页重开（没有会话被选中），再从树里点大会话。
  async function freshPage(url = '/') {
    const loadedAgain = browser.once('Page.loadEventFired');
    await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}${url}` });
    await loadedAgain;
    await waitFor(() => evaluate(`document.querySelector('[data-session-id="${BIG_ID}"]') !== null`), 'tree did not render after reload');
    await evaluate('window.__cf = undefined');
    await evaluate(TRACE_SOURCE);
    if (cssPatch) await evaluate(`(() => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(cssPatch)}; document.head.append(style); return true; })()`);
    if (jsPatch) await evaluate(`(() => { ${jsPatch} return true; })()`);
  }

  await freshPage('/');
  report.cssPatch = cssPatch ? cssPatchFile : null;
  report.jsPatch = jsPatch ? jsPatchFile : null;
  const patchLabel = cssPatch ? ` [css:${path.basename(cssPatchFile)}]` : jsPatch ? ` [js:${path.basename(jsPatchFile)}]` : '';
  await runFlow(`初连：整页重开后点大会话(1521条)${patchLabel}`, BIG_ID, BIG_COUNT, { trigger: clickSession(BIG_ID), kind: 'initial' });
  if (!onlyInitial) await runFlow('大会话：受控断流 → EventSource 自动重连', BIG_ID, BIG_COUNT, {
    kind: 'reconnect',
    trigger: `(async () => {
      await fetch('/api/test/drop?id=${BIG_ID}');
      await new Promise((resolve) => setTimeout(resolve, 400));
      return true;
    })()`,
  });
  if (!onlyInitial) await runFlow('大会话：小会话→大会话（切会话入口，对照）', BIG_ID, BIG_COUNT, {
    kind: 'switch-control',
    trigger: `(async () => { ${clickSession(SMALL_ID)}; await new Promise((resolve) => setTimeout(resolve, 600)); ${clickSession(BIG_ID)}; return true; })()`,
    waitQuiet: true,
  });
  // 深链初连（用户「刷新/贴链接」那条路）：整页重开直接落到大会话；只留结构量 + 请求计数。
  if (!onlyInitial) {
    const before = messagesRequests;
    await freshPage(`/?deeplink=1#${BIG_ID}`);
    await waitQuiet(BIG_COUNT);
    const tail = await evaluate(`(() => { const m = document.querySelector('#messages'); return { bubbles: m.querySelectorAll('.message').length, complete: m.dataset.renderComplete, scrollHeight: Math.round(m.scrollHeight), dist: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight) }; })()`);
    report.deeplink = { tail, messagesRequests: messagesRequests - before };
    print(`deep-link #${BIG_ID}`, report.deeplink);
  }

  report.pageProblems = pageProblems;
  report.messagesRequests = messagesRequests;
  report.requestsByPath = Object.fromEntries([...requestsByPath].sort());
  await writeArtifact();

  print('environment', report.environment);
  print('fixture', report.fixture);
  for (const run of report.runs) {
    print(`run[${run.label}] 时序(ms)`, run.phase);
    print(`run[${run.label}] 汇总`, {
      insertedNodes: run.insertedNodes, distinctIndices: run.distinctIndicesInserted, doubleInserted: run.doubleInsertedIndices,
      finalBubbles: run.tail.bubbles, expected: run.expectedCount, complete: run.tail.complete, dist: run.tail.dist,
      batches: run.batches.map((batch) => `${batch.t}:+${batch.nodes}`),
      cls: run.cls, jump: run.jump,
    });
    print(`run[${run.label}] 估算/真实高度`, run.settle);
    print(`run[${run.label}] layout-shift 明细`, run.shifts.map((shift) => `t=${shift.t} v=${Math.round(shift.value * 10000) / 10000} ${JSON.stringify(shift.sources)}`));
    print(`run[${run.label}] 帧序列(变化点)`, run.frames.filter((frame, index) => index === 0 || index === run.frames.length - 1 || frame.bubbles !== run.frames[index - 1].bubbles || frame.height !== run.frames[index - 1].height || frame.lastTop !== run.frames[index - 1].lastTop).slice(0, 40).map((frame) => `t=${frame.t} 条数=${frame.bubbles} top=${frame.top} h=${frame.height}/${frame.client} dist=${frame.dist} 可见=${frame.visFirst}..${frame.visLast}(${frame.visCount}) topNodeTop=${frame.topNodeTop} complete=${frame.complete} virtual=${frame.virtual} lastTop=${frame.lastTop} lastGap=${frame.lastBottomGap}`));
    if (run.paint?.length) print(`run[${run.label}] 屏幕帧(${run.paint.length}张，带差 vs 收尾帧/6带)`, run.paint.map((frame) => frame.error ? `t=${frame.t} 解帧失败:${frame.error}` : `t=${frame.t} ${frame.size.join('x')} ${frame.blank ? '[整片空白]' : ''} 带差=[${frame.bands.join(', ')}]`));
    print(`run[${run.label}] marks`, run.marks.map((mark) => `t=${mark.t} ${mark.kind}${mark.url ? ' ' + mark.url.replace(/^.*\/api/, '/api') : ''}${mark.text ? ' ' + mark.text : ''}${mark.value !== undefined ? ' complete=' + mark.value : ''}`));

    if (assert && (run.kind === 'initial' || run.kind === 'reconnect')) {
      // ① 连接建立之后正文不许被重建（同一份正文插两次 = 重复渲染）。
      check(`${run.label}｜正文不重复渲染（每个序号只插一次）`,
        run.doubleInsertedIndices.length === 0 && run.insertedNodes <= run.expectedCount && run.distinctIndicesInserted === run.insertedNodes,
        `inserted=${run.insertedNodes} distinct=${run.distinctIndicesInserted} 重复序号=${JSON.stringify(run.doubleInsertedIndices.slice(0, 8))} 正文条数=${run.expectedCount}`);
      // ② 连接建立之后（es-open 之后）不许有「重画」那种插入：只能是补齐旧消息（下标更小的那批）。
      check(`${run.label}｜连接建立后不重画已显示的正文`,
        run.phase.afterOpenRedrawInserts === 0,
        `es-open 之后插入的「已在屏上的序号」=${run.phase.afterOpenRedrawInserts}（期望 0）`);
      // ③ 初连/重连时正文只拉一次：SSE 初连必发一条 session.snapshot，它那次拉取必须与
      //    「选中会话」那一次合并（coalesce），不许对同一份正文发两次 GET。
      check(`${run.label}｜初连/重连时正文只拉一次`,
        run.phase.messageFetchCount <= 1,
        `GET /messages 次数=${run.phase.messageFetchCount}（期望 ≤1；两次 = 同一份正文白拉一遍）`);
      // ④ 初连/重连不许产生超过阈值的高度沉降跳变（Δpx 口径，见 docs/design-intent.md）。
      //    尺子：贴底渲染期间 `dist = scrollHeight - scrollTop - clientHeight` 的最大绝对值 ——
      //    它就是「底部锚点离容器底多远」，也就是读者眼睛里的沉降量（Δpx）。
      //    阈值 4：就是 app 自己 `isFollowingBottom()` 的容差（≤4px 才算「在底部」），
      //    实测修前修后都是 0px（uniform 与 varied 两档，见报告）。CLS 不在这里当判据 ——
      //    实测它对同一份正文会在 0.0012 / 0.5105 之间乱跳（content-visibility 的固有量），
      //    正是 docs/design-intent.md 说的「CLS 只在能确认它随被测量变化时才是判据」。
      check(`${run.label}｜初连/重连不产生超阈值的高度沉降跳变（Δpx ≤ 4）`,
        run.jump.maxAbsDistPx <= 4 && run.jump.maxLastBottomGapDeltaPx <= 4,
        `贴底期间最大 |dist|=${run.jump.maxAbsDistPx}px；最后一条正文底边相对容器底的最大位移=${run.jump.maxLastBottomGapDeltaPx}px（阈值 4px）`);
    }
  }
  print('requests', report.requestsByPath);
  print('pageProblems', report.pageProblems);
  print('checks', checks);
  print('RESULT', assert ? 'session connect flow PASS' : 'session connect flow trace written');
  print('artifact', path.join(artifactRoot, 'connect-flow.json'));
} catch (error) {
  await cleanupStep(cleanupProblems, 'report failure context', async () => {
    report.pageProblems = pageProblems;
    report.requestsByPath = Object.fromEntries([...requestsByPath].sort());
    await writeArtifact();
    print('失败时 artifact', path.join(artifactRoot, 'connect-flow.json'));
  });
  throw error;
} finally {
  await cleanupStep(cleanupProblems, 'quiesce page', () => quiesceCdpPage(browser));
  await cleanupStep(cleanupProblems, 'close browser', () => browser?.close());
  await cleanupStep(cleanupProblems, 'destroy tree stream', () => { treeStream?.destroy(); });
  await cleanupStep(cleanupProblems, 'destroy session streams', () => { for (const stream of sessionStreams.values()) stream.destroy(); });
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
  finishCleanup(null, cleanupProblems);
}

/** 从 marks + frames + inserts 抽出「选中 → fetch → EventSource → 首屏 → 补齐 → 静置」的时间线。 */
function phaseTimeline(marks, frames, expectedCount, inserts) {
  const first = (kind) => marks.find((mark) => mark.kind === kind)?.t ?? null;
  const sessionFetch = marks.find((mark) => mark.kind === 'fetch-end' && /\/api\/sessions\/[^/]+$/.test(mark.url));
  const messageFetches = marks.filter((mark) => mark.kind === 'fetch-end' && /\/messages(?:\?|$)/.test(mark.url));
  const firstMessageFetch = messageFetches[0] ?? null;
  const esConstruct = first('es-construct');
  const esOpen = first('es-open');
  const streamConnected = marks.find((mark) => mark.kind === 'stream-state' && String(mark.text).includes('已连接'))?.t ?? null;
  const firstFrameWithContent = frames.find((frame) => frame.bubbles > 0);
  const firstComplete = frames.find((frame) => frame.complete === 'true' && frame.bubbles === expectedCount);
  const quiet = frames.length ? frames[frames.length - 1] : null;
  // 「es-open 之后插入的、且序号已经出现在 es-open 之前已画好的集合里」= 重画已显示的正文。
  const drawnBeforeOpen = new Set(inserts.filter((item) => esOpen !== null && item.t < esOpen && item.idx !== null).map((item) => item.idx));
  const afterOpenRedrawInserts = inserts.filter((item) => esOpen !== null && item.t >= esOpen && item.idx !== null && drawnBeforeOpen.has(item.idx)).length;
  return {
    sessionFetchEnd: sessionFetch?.t ?? null,
    firstMessagesFetchEnd: firstMessageFetch?.t ?? null,
    messageFetchCount: messageFetches.length,
    messageFetchTimes: messageFetches.map((mark) => mark.t),
    esConstruct, esOpen, streamConnected,
    firstContentFrame: firstFrameWithContent?.t ?? null,
    firstCompleteFrame: firstComplete?.t ?? null,
    quietFrame: quiet?.t ?? null,
    openToFirstContentMs: firstFrameWithContent && esOpen !== null ? Math.round((firstFrameWithContent.t - esOpen) * 100) / 100 : null,
    openToCompleteMs: firstComplete && esOpen !== null ? Math.round((firstComplete.t - esOpen) * 100) / 100 : null,
    afterOpenRedrawInserts,
  };
}

/** 同一个序号被插了两次 ⇒ 重复渲染。 */
function doubleIndices(inserts) {
  const seen = new Set();
  const doubled = new Set();
  for (const item of inserts) {
    if (item.idx === null) continue;
    if (seen.has(item.idx)) doubled.add(item.idx);
    seen.add(item.idx);
  }
  return [...doubled];
}

/** Δpx 口径的「沉降跳变」：首屏之后，读者眼前那段的 top 相对首屏动了多少。 */
function anchorJump(frames, expectedCount) {
  // 用**底部那条可见消息**（DOM 里最后一个可见节点）当锚点：它不受「补齐把更多旧节点插到前面」影响，
  // 两次都能取到同一条（最后一条正文）。补充一个更粗的：整屏顶部可见消息的 top。
  const withContent = frames.filter((frame) => frame.bubbles > 0 && frame.lastTop !== null);
  if (!withContent.length) return null;
  const base = withContent[0];
  let maxLastDelta = 0;
  let maxGapDelta = 0;
  let atFrame = null;
  for (const frame of withContent) {
    const delta = Math.abs((frame.lastTop ?? 0) - (base.lastTop ?? 0));
    if (delta > maxLastDelta) { maxLastDelta = delta; atFrame = frame; }
    maxGapDelta = Math.max(maxGapDelta, Math.abs((frame.lastBottomGap ?? 0) - (base.lastBottomGap ?? 0)));
  }
  let maxAbsDist = 0;
  for (const frame of withContent) maxAbsDist = Math.max(maxAbsDist, Math.abs(frame.dist ?? 0));
  return {
    baseLastTop: base.lastTop,
    maxAbsDistPx: maxAbsDist,
    // 「最后一条正文的 top」相对首屏的最大位移 —— 这就是读者眼睛里的跳变（Δpx）。
    maxLastMsgDeltaPx: maxLastDelta, atFrame: atFrame?.t ?? null,
    maxLastBottomGapDeltaPx: maxGapDelta,
    jumpFlashed: withContent.some((frame) => frame.jumpShown === true),
    jumpFrames: withContent.filter((frame) => frame.jumpShown === true).map((frame) => frame.t),
    trace: withContent.map((frame) => `t=${frame.t}:${frame.lastTop}`),
    frames: withContent.length,
  };
}
