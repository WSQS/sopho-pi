#!/usr/bin/env node
// test/switch-session-paint.mjs —— 「切会话时正文是怎么出现的」观察台（不是门，先看）。
//
// 形状：真 Chromium + 假 API（照 test/big-session-firstpaint.mjs 的套路）。
// 钉的是「观感」而不是「总耗时」：
//   ① MutationObserver 记**每个正文节点被插入**的时刻（页内 performance.now）、
//      插在父节点的第几位（顶部 prepend / 末尾 append 一眼可辨）、这条消息的序号；
//   ② rAF 每帧记：scrollTop / scrollHeight / clientHeight / DOM 条数 /
//      视口中线那条消息的序号（用户眼睛里的锚点有没有被顶走）；
//   ③ 结束后按「同一帧内的插入」归批：批次序列 = 「t → +N 条（序号 a..b，插在第 i 位）」。
//
// 只看，不改：默认 exit 0，除非 --assert 开到断言档。

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
const artifactRoot = process.env.SOPHO_SWITCH_ARTIFACT_DIR || path.join(os.tmpdir(), 'sopho-switch-paint');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-switchpaint-'));

const BIG_ID = '11111111-1111-4111-8111-111111111111';
const MID_ID = '33333333-3333-4333-8333-333333333333';
const SMALL_ID = '22222222-2222-4222-8222-222222222222';
const BIG_COUNT = Number(process.env.SOPHO_SWITCH_BIG ?? 1521);
const MID_COUNT = Number(process.env.SOPHO_SWITCH_MID ?? 400);
const SMALL_COUNT = 12;

const fillerUnit = '保持大会话正文形状的中文填充句子。';
const bigFiller = fillerUnit.repeat(169); // ≈10 KB/条
const midFiller = fillerUnit.repeat(16); // ≈1 KB/条

const bigMessages = Array.from({ length: BIG_COUNT }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [
    { type: 'text', text: `MSG${index}：${bigFiller}` },
    { type: 'tool', name: 'bash', status: 'done-success', args: { command: `echo ${index}` }, result: `工具结果 ${index}：\n\`\`\`\n${bigFiller.slice(0, 600)}\n\`\`\`` },
  ],
}));
const midMessages = Array.from({ length: MID_COUNT }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `MSG${index}：${midFiller}` }],
}));
const smallMessages = Array.from({ length: SMALL_COUNT }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `MSG${index}：这是一条小会话正文。` }],
}));

const bodies = new Map([
  [BIG_ID, JSON.stringify({ messages: bigMessages, extras: [], compaction: { atIndex: null }, observability: null })],
  [MID_ID, JSON.stringify({ messages: midMessages, extras: [], compaction: { atIndex: null }, observability: null })],
  [SMALL_ID, JSON.stringify({ messages: smallMessages, extras: [], compaction: { atIndex: null }, observability: null })],
]);

const sessions = [
  { id: BIG_ID, name: '大会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: MID_ID, name: '中会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T07:30:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: SMALL_ID, name: '小会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];

let server;
let chromium;
let browser;
let treeStream;
const sessionStreams = new Map();
let messagesRequests = 0;
const requestsByPath = new Map();
const assert = process.argv.includes('--assert') || process.env.SOPHO_SWITCH_ASSERT === '1';
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

function sendBody(response, status, body) {
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

/** 主线程干了多少活（CDP Performance 域的累计量差值）。这是「重画一遍白烧 CPU」那个说法的尺子。 */
async function perfMetrics() {
  const { metrics } = await browser.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

const TRACE_SOURCE = `(() => {
  const m = document.querySelector('#messages');
  window.__sw = { t0: performance.now(), inserts: [], removes: [], frames: [], marks: [], shifts: [] };
  // 原生 layout-shift（CLS 的那把尺子，见 docs/design-intent.md「量化口径」）：只记
  // hadRecentInput=false 的那些；每次观察前 reset、观察完 read。
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__sw.shifts.push({ t: Math.round((entry.startTime - window.__sw.t0) * 100) / 100, value: entry.value });
    }).observe({ type: 'layout-shift', buffered: false });
  } catch (error) { window.__sw.shiftError = String(error); }
  const kindOf = (node) => {
    if (!(node instanceof Element)) return null;
    if (node.matches('.message, .extra-message, .compaction-note, .tool-card') === false) return null;
    if (node.classList.contains('tool-card')) return null; // 工具卡跟着正文节点走，不单独记
    return 'bubble';
  };
  const idxOf = (node) => {
    const match = /MSG(\\d+)/.exec(node.textContent.slice(0, 80));
    return match ? Number(match[1]) : null;
  };
  const observer = new MutationObserver((records) => {
    const t = performance.now();
    for (const record of records) {
      if (record.type !== 'childList') continue;
      const target = record.target;
      const isMessages = target === m || target.parentNode === m || target.closest?.('#messages') === m;
      if (!isMessages) continue;
      for (const node of record.addedNodes) {
        const kind = kindOf(node);
        if (!kind) continue;
        const index = idxOf(node);
        if (index !== null) node.dataset.swIdx = String(index);
        const siblings = node.parentNode ? Array.from(node.parentNode.children) : [];
        window.__sw.inserts.push({ t: Math.round((t - window.__sw.t0) * 100) / 100, idx: index, at: siblings.indexOf(node), parent: node.parentNode === m ? 'messages' : (node.parentNode?.className || 'other') });
      }
      for (const node of record.removedNodes) {
        const kind = kindOf(node);
        if (!kind) continue;
        window.__sw.removes.push({ t: Math.round((t - window.__sw.t0) * 100) / 100, idx: node.dataset.swIdx ? Number(node.dataset.swIdx) : null });
      }
    }
  });
  observer.observe(m, { childList: true, subtree: true });
  const sample = () => {
    const r = m.getBoundingClientRect();
    const probe = (y) => {
      const hit = document.elementsFromPoint(r.left + r.width / 2, y).find((el) => el.dataset && el.dataset.swIdx !== undefined);
      return hit ? Number(hit.dataset.swIdx) : null;
    };
    // 视口里真正带 data-sw-idx 的那些节点：起止序号 + 个数（元素盒与容器可视区相交）
    const pane = { top: r.top + 14, bottom: r.bottom - 14 };
    let visFirst = null; let visLast = null; let visCount = 0;
    for (const node of m.children) {
      if (!node.dataset || node.dataset.swIdx === undefined) continue;
      const box = node.getBoundingClientRect();
      if (box.bottom < pane.top || box.top > pane.bottom) continue;
      const value = Number(node.dataset.swIdx);
      if (visFirst === null) visFirst = value;
      visLast = value;
      visCount += 1;
    }
    window.__sw.frames.push({
      t: Math.round((performance.now() - window.__sw.t0) * 100) / 100,
      top: Math.round(m.scrollTop),
      height: Math.round(m.scrollHeight),
      client: Math.round(m.clientHeight),
      bubbles: m.querySelectorAll('.message').length,
      extras: m.querySelectorAll('.extra-message').length,
      complete: m.dataset.renderComplete ?? null,
      virtual: m.dataset.virtual ?? null,
      topIdx: probe(pane.top + 4),
      midIdx: probe((pane.top + pane.bottom) / 2),
      bottomIdx: probe(pane.bottom - 4),
      visFirst,
      visLast,
      visCount,
    });
    if (window.__sw.watching) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  window.__swResetShift = () => { window.__sw.shifts.length = 0; return true; };
  window.__swReadShift = () => {
    const values = window.__sw.shifts.map((entry) => entry.value);
    return { cls: Math.round(values.reduce((sum, value) => sum + value, 0) * 10000) / 10000, count: values.length, max: Math.round((values.length ? Math.max(...values) : 0) * 10000) / 10000, error: window.__sw.shiftError ?? null };
  };
  window.__swStart = (label) => { window.__sw.watching = true; window.__sw.marks.push({ label, t: Math.round((performance.now() - window.__sw.t0) * 100) / 100 }); requestAnimationFrame(sample); };
  window.__swStop = () => { window.__sw.watching = false; return { t0: window.__sw.t0, inserts: window.__sw.inserts.slice(), removes: window.__sw.removes.slice(), frames: window.__sw.frames.slice(), marks: window.__sw.marks.slice() }; };
  window.__swCounts = () => ({ inserts: window.__sw.inserts.length, removes: window.__sw.removes.length });
  return true;
})()`;

// 把「同一帧内发生的插入」捏成一批：帧边界用 rAF 无法直接拿，改用「相邻插入时间差 > 8ms」切批
// （Chromium headless 的帧节拍 ≈16.7ms；同一任务里的插入时间差 <1ms）。
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
  return out.map((batch) => ({ t: batch.t, nodes: batch.count, indices: batch.firstIdx === null ? null : [batch.firstIdx, batch.lastIdx], atPositions: [...new Set(batch.positions)].slice(0, 4), atMin: Math.min(...batch.positions) }));
}

const clickSession = (id) => `document.querySelector('[data-session-id="${id}"] .tree-select').click(); true`;
const screencast = process.env.SOPHO_SWITCH_SCREENCAST === '1';

await mkdir(artifactRoot, { recursive: true });
const port = await reservePort();
const report = { fixture: { bigCount: BIG_COUNT, midCount: MID_COUNT, smallCount: SMALL_COUNT }, switches: [], environment: {} };
// 沙箱清理不许顶掉真正的断言失败（口径见 test/harness.mjs 开头那一段）。
const cleanupProblems = [];
// 页面异常/console.error 也放模块作用域：catch 里要报「失败时页面出了什么」，而且 catch 自己
// 也不许因为看不到变量而把真正的断言错替换掉（我自己踩过一次）。
const pageProblems = [];
function writeArtifact() {
  return writeFile(path.join(artifactRoot, 'switch-session-trace.json'), `${JSON.stringify(report, null, 2)}\n`);
}
try {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    requestsByPath.set(url.pathname, (requestsByPath.get(url.pathname) || 0) + 1);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/test/snapshot') {
      const id = url.searchParams.get('id') || SMALL_ID;
      const stream = sessionStreams.get(id);
      if (!stream) return sendJson(response, 409, { message: 'no session stream' });
      // 逐字相同的快照：正文一份没变，只是「重连/兜底」那条对账又来了 —— 正是要观察的那条路。
      stream.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      treeStream = response;
      return;
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|message))?$/.exec(url.pathname);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const action = sessionMatch[2] ?? null;
      const row = sessions.find((item) => item.id === id);
      if (!row) return sendJson(response, 404, { message: 'not found' });
      if (action === null) return sendJson(response, 200, { name: row.name, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null });
      if (action === 'messages') { messagesRequests += 1; return sendBody(response, 200, bodies.get(id)); }
      if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] });
      if (action === 'seen') return sendJson(response, 200, { ok: true });
      if (action === 'draft') return sendJson(response, 200, { text: '' });
      if (action === 'message') return sendJson(response, 200, { ok: true });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        // 真 base 在初连时必发一条 session.snapshot（app.js 收到后会再 refreshMessages 一次）——照抄。
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

  const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
    ? 'C:/Users/user/AppData/Local/Chromium/Application/chrome.exe'
    : '/usr/bin/chromium');
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
  report.environment = { browser: version.Browser, chrome, viewport: '1200x760', node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, loadavg: os.loadavg() };

  async function waitQuiet(expectedCount, polls = 4) {
    let last = null;
    let lastSeen = null;
    let stable = 0;
    try {
    await waitFor(async () => {
      const value = await evaluate(`(() => { const m = document.querySelector('#messages'); const counts = window.__swCounts(); return { bubbles: m.querySelectorAll('.message').length, complete: m.dataset.renderComplete ?? null, inserts: counts.inserts, removes: counts.removes }; })()`);
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

  async function runSwitch(label, id, expectedCount, { trigger = null } = {}) {
    const before = await evaluate(`(() => { const s = window.__sw; s.inserts.length = 0; s.removes.length = 0; s.frames.length = 0; s.marks.length = 0; return true; })()`);
    void before;
    const timeOrigin = await evaluate('performance.timeOrigin');
    const frames = [];
    let screencastError = null;
    const offScreencast = browser.on('Page.screencastFrame', (params) => {
      frames.push({ t: Math.round((params.metadata.timestamp * 1000 - timeOrigin) * 10) / 10, data: params.data });
      browser.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch((error) => { screencastError = error.message; });
    });
    if (screencast) await browser.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1200, maxHeight: 760 });
    await evaluate('window.__swResetShift()');
    const startedAt = await evaluate(`(() => { window.__swStart(${JSON.stringify(label)}); const m = document.querySelector('#messages'); return { t: Math.round((performance.now() - window.__sw.t0) * 100) / 100, scrollTop: Math.round(m.scrollTop), bubbles: m.querySelectorAll('.message').length }; })()`);
    const metricsBefore = await perfMetrics();
    await evaluate(trigger ?? clickSession(id));
    // 「静下来了」= 条数 == 期望 && complete == true && 再没有新的插入（见 waitQuiet）。
    // 不能用 «complete === true» 当唯一条件：replaceChildren 不改 dataset，上一次会话的 true 会残留。
    await waitQuiet(expectedCount);
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    const shift = await evaluate('window.__swReadShift()');
    // 「读者正看的那一段」动没动（Δpx / 索引）—— 只有那一跑（不贴底刷新）会种下 __swAnchorBefore。
    const anchorShift = await evaluate(`(() => {
      if (!window.__swAnchorBefore) return null;
      const m = document.querySelector('#messages');
      const node = Array.from(m.children).find((item) => { const box = item.getBoundingClientRect(); return box.bottom > 120; });
      const after = node ? { idx: node.dataset.swIdx ?? null, top: Math.round(node.getBoundingClientRect().top) } : null;
      const before = window.__swAnchorBefore;
      const control = window.__swAnchorControl;
      window.__swAnchorBefore = null;
      window.__swAnchorControl = null;
      const delta = (a, b) => (a && b ? { deltaTop: b.top - a.top, deltaHeight: b.h - a.h, idxMoved: a.idx !== b.idx, from: a.idx, to: b.idx } : null);
      return { before, control, after, settleOnly: delta(before, control), refreshOnly: delta(control, after), whole: delta(before, after) };
    })()`);
    const trace = await evaluate(`window.__swStop()`);
    const metricsAfter = await perfMetrics();
    // 收尾后的那一帧当参照物：每张中间帧都跟它比「哪几条横带还没长成最终的样子」。
    const paneRect = await evaluate(`(() => { const r = document.querySelector('#messages').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
    if (screencast) await browser.send('Page.stopScreencast');
    offScreencast();
    const referenceShot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    await writeFile(path.join(artifactRoot, `settled-${label.replace(/[^0-9A-Za-z()+-]/g, '_')}.png`), Buffer.from(referenceShot.data, 'base64'));
    const reference = decodePng(Buffer.from(referenceShot.data, 'base64'));
    const paint = [];
    for (const [index, frame] of frames.entries()) {
      try {
        const bytes = Buffer.from(frame.data, 'base64');
        await writeFile(path.join(artifactRoot, `frame-${label.replace(/[^0-9A-Za-z()+-]/g, '_')}-${String(index).padStart(2, '0')}-t${Math.round(frame.t)}.png`), bytes);
        const image = decodePng(bytes);
        paint.push({
          t: frame.t,
          size: [image.width, image.height],
          bands: bandDiff(image, reference, paneRect, 6),
          blank: isUniform(image, paneRect),
        });
      } catch (error) {
        paint.push({ t: frame.t, error: error.message, size: null });
      }
    }
    const tail = await evaluate(`(() => {
      const m = document.querySelector('#messages');
      return {
        bubbles: m.querySelectorAll('.message').length,
        extras: m.querySelectorAll('.extra-message').length,
        scrollTop: Math.round(m.scrollTop), scrollHeight: Math.round(m.scrollHeight), clientHeight: Math.round(m.clientHeight),
        dist: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
        complete: m.dataset.renderComplete, total: m.dataset.messageTotal, virtual: m.dataset.virtual,
        textTotal: (m.textContent.match(/MSG\\d+/g) || []).length,
        title: document.querySelector('#session-title').textContent,
      };
    })()`);
    const result = {
      label, id, expectedCount, startedAt, tail,
      mainThread: {
        scriptMs: Math.round((metricsAfter.ScriptDuration - metricsBefore.ScriptDuration) * 1000),
        taskMs: Math.round((metricsAfter.TaskDuration - metricsBefore.TaskDuration) * 1000),
        recalcStyleMs: Math.round((metricsAfter.RecalcStyleDuration - metricsBefore.RecalcStyleDuration) * 1000),
        layoutCount: metricsAfter.LayoutCount - metricsBefore.LayoutCount,
      },
      cls: shift,
      anchorShift,
      insertedNodes: trace.inserts.length,
      removedNodes: trace.removes.length,
      distinctIndicesInserted: new Set(trace.inserts.map((item) => item.idx).filter((value) => value !== null)).size,
      batches: batches(trace.inserts),
      frames: trace.frames,
      marks: trace.marks,
      paneRect,
      pageT0: trace.t0 ?? null,
      screencastError,
      paint,
    };
    // 每次切会话后都重新挂观察器（切走时容器被 replaceChildren，旧观察器还在，无妨）
    report.switches.push(result);
    if (assert && trigger === null) {
      // 门的判据（都是结构量，不跟机器负载抢）：
      //   ① 一次切换只允许把正文建一遍：插进去的节点数 == 正文条数（多出来的就是重建）；
      //   ② 可见插入批次 ≤ 2（尾批 + 一次静默补到顶部）——小会话（≤ 80 条）只允许 1 批；
      //   ③ 视口从头到尾锚在**最后一条**上（第一批插入之后）：没有一刻是从上往下出现的。
      const inserted = result.insertedNodes;
      const distinct = result.distinctIndicesInserted;
      check(`${label}｜正文只建一遍（插入节点数 == 正文条数）`, inserted === expectedCount && distinct === expectedCount,
        `insertedNodes=${inserted} distinctIndices=${distinct} 期望=${expectedCount}（多出来的就是同一份正文被画了第二遍）`);
      const batchLimit = expectedCount <= 80 ? 1 : 2;
      check(`${label}｜可见插入批次 ≤ ${batchLimit}`, result.batches.length <= batchLimit,
        `batches=${result.batches.length} ${JSON.stringify(result.batches.map((batch) => `${batch.t}:+${batch.nodes}`))}`);
      const tFirstInsert = result.batches[0]?.t ?? 0;
      const after = result.frames.filter((frame) => frame.t >= tFirstInsert && frame.visLast !== null);
      const wrong = after.filter((frame) => frame.visLast !== expectedCount - 1);
      check(`${label}｜第一批之后视口一直锨在最后一条上`, after.length > 0 && wrong.length === 0,
        `已出现锚点序列=${[...new Set(after.map((frame) => frame.visLast))].join(',')} 期望一直是 ${expectedCount - 1}（偏了的帧：${wrong.map((frame) => `t=${frame.t}:${frame.visFirst}..${frame.visLast}`).join(' ') || '无'}）`);
    }
    return result;
  }

  // 预热：开小会话，让小会话的 renderer 与 SSE 都走一遍（避免把「第一次」当稳态）。
  await evaluate(clickSession(SMALL_ID));
  await waitFor(() => evaluate(`document.querySelector('#messages').dataset.renderComplete === 'true'`), 'warmup failed', 20000);
  // 预热要等到**真静下来**：SSE 初连那条 session.snapshot 会再拉一次 /messages，如果只等
  // `renderComplete`，那第二遍会在下一次 switch 的观察窗里才落地（表现为「上一会话的 +N 条」
  // 混进本次统计）。
  await waitQuiet(SMALL_COUNT);

  await runSwitch('小会话 → 中会话(400条)', MID_ID, MID_COUNT);
  const geometryBig = await runSwitch('中会话 → 大会话(1521条)', BIG_ID, BIG_COUNT);
  // 几何探针：content-visibility:auto 到底在不在起作用？占位高跟真实高差多少？
  report.geometry = await evaluate(`(() => {
    const m = document.querySelector('#messages');
    const kids = Array.from(m.children).filter((node) => node.dataset && node.dataset.swIdx !== undefined);
    const at = (i) => { const node = kids[i]; if (!node) return null; const r = node.getBoundingClientRect(); const cs = getComputedStyle(node); return { idx: Number(node.dataset.swIdx), h: Math.round(r.height), top: Math.round(r.top), contentVisibility: cs.contentVisibility, containIntrinsicSize: cs.containIntrinsicSize }; };
    return { virtual: m.dataset.virtual, scrollHeight: Math.round(m.scrollHeight), clientHeight: Math.round(m.clientHeight), nodes: kids.length, samples: [0, 1, 20, 219, 220, 299].map(at) };
  })()`);
  void geometryBig;
  await runSwitch('大会话 → 中会话(400条)', MID_ID, MID_COUNT);
  // 不贴底（往上滚 2 屏）之后来一条**逐字相同**的快照刷新：修前会整段重画（读者那一段被搬走），
  // 修后同一份不重画。这一跑同时给 CLS / Δpx / 插入节点数（新口径点名的正是这类「渐进补历史」）。
  // （只在观察台档跑：它问的是「同一份正文的刷新」，不是切换。）
  if (!assert) {
    await runSwitch('不贴底时来一条「同一份」快照刷新（同一会话，不是切换）', MID_ID, MID_COUNT, {
      trigger: `(async () => {
        const m = document.querySelector('#messages');
        m.scrollTop = Math.max(0, m.scrollTop - m.clientHeight * 2);
        m.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const probe = () => {
          const node = Array.from(m.children).find((item) => { const box = item.getBoundingClientRect(); return box.bottom > 120; });
          return node ? { idx: node.dataset.swIdx ?? null, top: Math.round(node.getBoundingClientRect().top), h: Math.round(m.scrollHeight) } : null;
        };
        window.__swAnchorBefore = probe();
        // 对照组：什么都不做，等一会儿 —— content-visibility 的「估算高度 ↔ 真实高度」自己也会让
        // 内容沉一点。先把这段沉降量出来，再看刷新额外搬走了多少。
        await new Promise((resolve) => setTimeout(resolve, 250));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        window.__swAnchorControl = probe();
        // 从这里才开始算 layout-shift：上面那两下滚动与这段等待都是**我**干的/本来就有的，
        // 别把它算进「刷新带来的 CLS」。
        window.__swResetShift();
        await fetch('/api/test/snapshot?id=${MID_ID}', { method: 'POST' });
        return true;
      })()`,
    });
  }
  await runSwitch('中会话 → 小会话(12条)', SMALL_ID, SMALL_COUNT);
  await runSwitch('小会话 → 大会话(1521条)', BIG_ID, BIG_COUNT);
  // 附带一跑（只在观察台档跑，门里不跑——它跟「切换」无关，只是顺手量一下）：
  // 在大会话里往上滚 3 屏——用来看「切完之后滚上去，正文是不是一截一截地长出来」
  // （content-visibility:auto 会把屏幕外的正文按估算高度占位，滚到时才真布局）。
  if (!assert) {
    // 顺手再看一眼：大会话里往上滚（content-visibility 的估算高度会不会一截截长出来）
    await runSwitch('大会话里往上滚 3 屏（同一会话，不是切换）', BIG_ID, BIG_COUNT, {
      trigger: `(() => { const m = document.querySelector('#messages'); m.scrollTop = Math.max(0, m.scrollTop - m.clientHeight * 3); m.dispatchEvent(new Event('scroll')); return true; })()`,
    });
  }

  report.pageProblems = pageProblems;
  report.messagesRequests = messagesRequests;
  report.requestsByPath = Object.fromEntries([...requestsByPath].sort());
  await writeArtifact();

  // ── 摘要 ────────────────────────────────────────────────────────
  print('environment', report.environment);
  print('fixture', report.fixture);
  for (const item of report.switches) {
    const batchLines = item.batches.map((batch) => `t=${batch.t}ms +${batch.nodes}条 ${batch.indices ? `idx=${batch.indices[0]}..${batch.indices[1]}` : ''} 插在父节点第${batch.atMin}位`);
    print(`switch[${item.label}] 批次(${item.batches.length})`, batchLines);
    print(`switch[${item.label}] 汇总`, {
      insertedNodes: item.insertedNodes,
      removedNodes: item.removedNodes,
      distinctIndices: item.distinctIndicesInserted,
      finalBubbles: item.tail.bubbles,
      expected: item.expectedCount,
      textTotal: item.tail.textTotal,
      complete: item.tail.complete,
      dist: item.tail.dist,
      frames: item.frames.length,
      spanMs: item.frames.length ? item.frames[item.frames.length - 1].t : null,
    });
    const frames = item.frames;
    print(`switch[${item.label}] 主线程(CDP Performance 累计量差值)`, item.mainThread);
    print(`switch[${item.label}] layout-shift（新口径：渐进补历史以 CLS 为主判据）`, item.cls);
    if (item.anchorShift) print(`switch[${item.label}] 读者锚点（Δpx / 索引）`, item.anchorShift);
    const interesting = frames.filter((frame, index) => index === 0 || index === frames.length - 1 || frame.bubbles !== frames[index - 1].bubbles || frame.midIdx !== frames[index - 1].midIdx);
    print(`switch[${item.label}] 帧序列(变化点)`, interesting.slice(0, 60).map((frame) => `t=${frame.t} 条数=${frame.bubbles} top=${frame.top} h=${frame.height}/${frame.client} 可见序号=${frame.visFirst}..${frame.visLast}(${frame.visCount}条) 探针 top/mid/bot=${frame.topIdx}/${frame.midIdx}/${frame.bottomIdx} complete=${frame.complete}`));
    if (item.paint?.length) {
      print(`switch[${item.label}] 屏幕帧(${item.paint.length}张，横带差 vs 收尾帧/6 带)`, item.paint.map((frame) => frame.error ? `t=${frame.t} 解帧失败:${frame.error}` : `t=${frame.t} ${frame.size.join('x')} ${frame.blank ? '[整片空白]' : ''} 带差=[${frame.bands.join(', ')}]`));
    }
  }
  print('requests', report.requestsByPath);
  if (report.geometry) print('geometry(大会话 300 条，收尾后)', report.geometry);
  print('pageProblems', report.pageProblems);
  print('checks', checks);
  print('RESULT', assert ? 'switch-session paint PASS' : 'switch-session paint trace written');
  print('measured(screencast 会干扰时间；结构量不受影响)', { checks, switches: report.switches.map((item) => ({ label: item.label, inserted: item.insertedNodes, batches: item.batches.length, cls: item.cls.cls, scriptMs: item.mainThread.scriptMs })) });
  print('artifact', path.join(artifactRoot, 'switch-session-trace.json'));
} catch (error) {
  // 判据不过时，把「已经量到的」先落地（不然追一个红门得重跑一遍）。
  // 每一步都单独兜住：这里的任何一步自己炸了都**不许**顶掉正在传播的真错（踩过一次：
  // 早期版本这里引用了 try 里声明的 pageProblems ⇒ ReferenceError 盖掉了 ✗ 断言）。
  await cleanupStep(cleanupProblems, 'report failure context', async () => {
    report.pageProblems = pageProblems;
    report.requestsByPath = Object.fromEntries([...requestsByPath].sort());
    await writeArtifact();
    for (const item of report.switches) {
      print(`失败时 switch[${item.label}] 批次`, item.batches.map((batch) => `t=${batch.t}:+${batch.nodes} idx=${batch.indices?.[0]}..${batch.indices?.[1]}`));
      print(`失败时 switch[${item.label}] 汇总`, { insertedNodes: item.insertedNodes, distinctIndices: item.distinctIndicesInserted, expected: item.expectedCount, batches: item.batches.length });
    }
    print('失败时 artifact', path.join(artifactRoot, 'switch-session-trace.json'));
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
