#!/usr/bin/env node
// test/big-session-firstpaint.mjs —— 「大会话首开」前端门（v2.2 内容完整性 + 首开不卡）。
//
// 形状：真 Chromium + 假 API。fixture 是「1521 条 × ~10 KB」的合成大会话（≈15.4 MiB，
// 与 docs/history/perf-v21-vs-v22.md 记的正式已知形状同量级；这里不用真 profile，
// 那样门会随机器上的会话文件漂移 —— 真实形状的对照由 test/perf-compare.mjs 负责）。
//
// 要机械钉住的五件事：
//   ① 首开时间：点击会话 → 正文可滚动，有上界；
//   ② 完整性：补齐后 DOM 消息数 == /messages 返回条数（不许为了数字好看砍内容）；
//   ③ 不阻塞：渲染期间长任务有上界、帧交付有下限；
//   ④ 贴底语义不变：补齐期间仍贴底、发消息后到底且按钮消失；
//   ⑤ 切会话隔离：旧会话还在分片补齐时切走，旧消息一粒都不许进新会话正文。
//
// 只用一个高位随机端口 + 临时 user-data-dir；不碰真实 profile、7331/7321。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-bigfirstpaint-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-bigfirstpaint');
const screenshotFile = path.join(artifactRoot, 'big-session-firstpaint-1200x760.png');

const BIG_ID = '11111111-1111-4111-8111-111111111111';
const SMALL_ID = '22222222-2222-4222-8222-222222222222';
const BIG_COUNT = 1521;
const SMALL_COUNT = 12;
const BIG_MARK = 'BIGMSG';
const SMALL_MARK = 'SMALLMSG';

// 门的阈值（依据见本轮报告）：
//   修复后首开 ≈0.15–0.35 s；修复前在本 fixture 上是 ≈2.3 s；真实 v2.1 ≈3.9 s、v2.2 修前 ≈23.2 s。
//   阈值 1.5 s：比修复后高 4–9×（留机器抖动用），又低于修复前（2.3 s）与 v2.1（3.9 s）。
const FIRST_PAINT_LIMIT_MS = Number(process.env.SOPHO_BIGFIRSTPAINT_LIMIT_MS ?? 1500);
const FRAME_LOWER_BOUND = Number(process.env.SOPHO_BIGFIRSTPAINT_MIN_FRAMES ?? 30);
const LONG_TASK_LIMIT_MS = Number(process.env.SOPHO_BIGFIRSTPAINT_LONG_TASK_MS ?? 300);
const BOTTOM_EPSILON = 4;

// 每条 ≈10 KB（中文按 UTF-8 3 字节/字）⇒ 1521 条 ≈ 15.4 MiB，正对正式已知形状（docs/history/perf-v21-vs-v22.md）。
const fillerUnit = '保持大会话正文形状的中文填充句子。';
const bigFiller = fillerUnit.repeat(169);
const bigMessages = Array.from({ length: BIG_COUNT }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [
    { type: 'text', text: `${BIG_MARK}${index}：${bigFiller}` },
    // 真实大会话里大量消息带工具卡与代码块 —— 它们比纯文本贵得多，不加进去门就太轻。
    { type: 'tool', name: 'bash', status: 'done-success', args: { command: `echo ${index}` }, result: `工具结果 ${index}：\n\`\`\`\n${bigFiller.slice(0, 600)}\n\`\`\`` },
  ],
}));
const smallMessages = Array.from({ length: SMALL_COUNT }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  text: `${SMALL_MARK}${index}：这是一条小会话正文。`,
}));
let bigBodyCache = null;
function bigBody() {
  if (bigBodyCache === null) {
    bigBodyCache = JSON.stringify({ messages: bigMessages, extras: [], compaction: { atIndex: null }, observability: null });
  }
  return bigBodyCache;
}
const bigPayloadApproxMiB = Math.round((Buffer.byteLength(bigBody()) / 1048576) * 100) / 100;

const sessions = [
  { id: BIG_ID, name: '大会话 1521 条', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: SMALL_ID, name: '小会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];

let server;
let chromium;
let browser;
let treeStream;
const sessionStreams = new Map();
let checks = 0;
let messageReads = 0;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
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
    close() { socket.close(); },
  };
}

async function evaluate(expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
  return result.result.value;
}

async function frames(count = 2) {
  await evaluate(`new Promise(resolve=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
}

async function messageState() {
  return evaluate(`(() => {
    const m = document.querySelector('#messages');
    return {
      count: m.querySelectorAll('.message').length,
      complete: m.dataset.renderComplete ?? null,
      total: m.dataset.messageTotal ?? null,
      dist: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
      top: Math.round(m.scrollTop),
      scrollHeight: m.scrollHeight,
      clientHeight: m.clientHeight,
      jumpShown: document.querySelector('#jump').classList.contains('show'),
      bigMarkers: (m.textContent.match(/BIGMSG/g) || []).length,
      smallMarkers: (m.textContent.match(/SMALLMSG/g) || []).length,
      title: document.querySelector('#session-title').textContent,
    };
  })()`);
}

const clickSession = (id) => `document.querySelector('[data-session-id="${id}"] .tree-select').click(); true`;

await mkdir(artifactRoot, { recursive: true });
const port = await reservePort();
let primaryError;
try {
  server = http.createServer(async (request, response) => {
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
    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|message))?$/.exec(url.pathname);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const action = sessionMatch[2] ?? null;
      const row = sessions.find((item) => item.id === id);
      if (!row) return sendJson(response, 404, { message: 'not found' });
      if (action === null) return sendJson(response, 200, { name: row.name, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null });
      if (action === 'messages') {
        messageReads += 1;
        if (id === BIG_ID) return sendBody(response, 200, bigBody());
        return sendJson(response, 200, { messages: smallMessages, extras: [], compaction: { atIndex: null }, observability: null });
      }
      if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] });
      if (action === 'seen') return sendJson(response, 200, { ok: true });
      if (action === 'draft') return sendJson(response, 200, { text: '' });
      if (action === 'message') return sendJson(response, 200, { ok: true });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
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
  const pageProblems = [];
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${BIG_ID}"]') !== null`), 'tree did not render');

  print('fixture', { bigCount: BIG_COUNT, bigPayloadMiB: bigPayloadApproxMiB, smallCount: SMALL_COUNT });
  await evaluate(`(() => {
    window.__longTasks = [];
    try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration)); }).observe({ type: 'longtask', buffered: true }); }
    catch (error) { window.__longTaskError = String(error); }
    return true;
  })()`);

  // ── ① 首开时间（点击 → 正文可滚动）──────────────────────────────
  const firstPaintMs = await evaluate(`(async () => {
    const m = document.querySelector('#messages');
    const t0 = performance.now();
    document.querySelector('[data-session-id="${BIG_ID}"] .tree-select').click();
    while (performance.now() - t0 < 120000) {
      if (m.children.length > 0 && m.scrollHeight > m.clientHeight + 200) break;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    return Math.round(performance.now() - t0);
  })()`);
  check('① 点击大会话 → 正文可滚动（有上界）', firstPaintMs <= FIRST_PAINT_LIMIT_MS, `firstPaint=${firstPaintMs}ms limit=${FIRST_PAINT_LIMIT_MS}ms`);

  // ── ③ 不阻塞：首开后 2.5s 内交付的帧数（此时分片还在补）──────────────
  const fps = await evaluate(`(async () => {
    const t0 = performance.now(); let last = t0; const deltas = [];
    return await new Promise((resolve) => {
      const step = () => { const t = performance.now(); deltas.push(Math.round((t - last) * 100) / 100); last = t; if (t - t0 < 2500) requestAnimationFrame(step); else resolve({ frames: deltas.length, deltas, durationMs: Math.round(t - t0) }); };
      requestAnimationFrame(step);
    });
  })()`);
  const sorted = [...fps.deltas].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const incompleteDuringFps = (await messageState()).complete;
  check('③ 渲染期间帧交付有下限', fps.frames >= FRAME_LOWER_BOUND, `frames=${fps.frames}/2.5s p50=${at(0.5)}ms p95=${at(0.95)}ms limit>=${FRAME_LOWER_BOUND}`);

  // 初始同步渲染如果能阻塞主线程，会表现成一条超长 longtask（fps 窗口在它之后，量不到）。
  const longTasks = await evaluate(`({ tasks: window.__longTasks ?? null, error: window.__longTaskError ?? null })`);
  check('③ 渲染期间没有超过上界的长任务', Array.isArray(longTasks.tasks) && longTasks.tasks.every((d) => d <= LONG_TASK_LIMIT_MS), `longTasks=${JSON.stringify(longTasks.tasks)} error=${longTasks.error}`);

  const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(screenshotFile, Buffer.from(shot.data, 'base64'));

  // ── ② 完整性：等“补齐完成”，DOM 条数 == 服务端条数 ─────────────────
  const integrity = await waitFor(async () => {
    const value = await messageState();
    return value.complete === 'true' ? value : null;
  }, 'progressive render did not signal completion', 90000);
  check('② 补齐后 DOM 消息数 == /messages 条数', integrity.count === BIG_COUNT && integrity.bigMarkers === BIG_COUNT, `count=${integrity.count} total=${integrity.total} markers=${integrity.bigMarkers} expected=${BIG_COUNT}（渲染中 complete=${incompleteDuringFps}）`);
  const heap = await browser.send('Runtime.getHeapUsage');
  print('heap', { usedMiB: Math.round((heap.usedSize / 1048576) * 100) / 100, totalMiB: Math.round((heap.totalSize / 1048576) * 100) / 100, note: '全量 DOM 保留（完整性判据），heap 不会因分片而下降' });

  // ── ④ 贴底语义 ──────────────────────────────────────────────────
  check('④ 补齐完成后仍贴底且回底按钮隐藏', integrity.dist <= BOTTOM_EPSILON && integrity.jumpShown === false, `dist=${integrity.dist}px top=${integrity.top} scrollHeight=${integrity.scrollHeight} clientHeight=${integrity.clientHeight} jump=${integrity.jumpShown}`);
  await evaluate(`(() => { const m = document.querySelector('#messages'); m.scrollTop = Math.max(0, m.scrollTop - 6000); m.dispatchEvent(new Event('scroll')); return true; })()`);
  await frames(2);
  const scrolledUp = await messageState();
  check('④ 滚上去后回底按钮出现', scrolledUp.dist > BOTTOM_EPSILON && scrolledUp.jumpShown === true, `dist=${scrolledUp.dist}px jump=${scrolledUp.jumpShown}`);
  await evaluate(`(() => { const prompt = document.querySelector('#prompt'); prompt.value = '贴底语义探针'; prompt.dispatchEvent(new Event('input')); document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); return true; })()`);
  const afterSend = await waitFor(async () => {
    const value = await messageState();
    return value.dist <= BOTTOM_EPSILON && value.jumpShown === false ? value : null;
  }, 'send did not return to the bottom', 8000);
  check('④ 发消息后直接到底、按钮消失', afterSend.dist <= BOTTOM_EPSILON && afterSend.jumpShown === false, `dist=${afterSend.dist}px jump=${afterSend.jumpShown}`);

  // ── ⑤ 切会话隔离：旧会话还在补片时切走 ────────────────────────────
  await evaluate(clickSession(BIG_ID));
  await waitFor(() => evaluate(`document.querySelector('#messages').dataset.renderComplete === 'false'`), 'second big-session open did not enter progressive mode');
  const pendingBefore = (await messageState()).count;
  await evaluate(clickSession(SMALL_ID));
  await waitFor(async () => {
    const value = await messageState();
    return value.title === '小会话' && value.complete === 'true' && value.count === SMALL_COUNT ? value : null;
  }, 'small session did not finish after switching away from the big one', 15000);
  await frames(6); // 给被作废的旧分片任务几个帧的机会去“犯案”
  const isolated = await messageState();
  check('⑤ 切走后旧会话渲染任务作废、旧消息没进新会话', isolated.bigMarkers === 0 && isolated.smallMarkers === SMALL_COUNT && isolated.count === SMALL_COUNT, `bigMarkers=${isolated.bigMarkers} smallMarkers=${isolated.smallMarkers} count=${isolated.count}（切走前大会话已渲染 ${pendingBefore} 条）`);

  check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));

  print('measured', { firstPaintMs, frameFrames: fps.frames, frameP50: at(0.5), frameP95: at(0.95), longTasks: longTasks.tasks, integrityCount: integrity.count, bottomDist: integrity.dist, scrollHeight: integrity.scrollHeight, messageReads, bigPayloadMiB: bigPayloadApproxMiB });
  print('screenshot', screenshotFile);
  print('chromium', { product: version.Browser, executable: chrome, viewport: '1200x760' });
  print('checks', checks);
  print('RESULT', 'big session first paint PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  browser?.close();
  treeStream?.destroy();
  for (const stream of sessionStreams.values()) stream.destroy();
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
