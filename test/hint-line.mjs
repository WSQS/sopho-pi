#!/usr/bin/env node
// test/hint-line.mjs —— I-12「输入框下方那一行 = 随状态变的提示行」的契约门（真 Chromium + 假 API）。
//
// 用户 2026-09-19 批准的形状：**常驻、随状态变、零新增元素**。实现见 `web/app.js` 的
// `renderNotice()/hintStatus()/notice()`：**复用**既有的 `#notice`（它本来就占位 `min-height:1rem`），
// 行上两层 —— ① 状态层（未选会话 / 空闲 / 流式中 / 压缩中，状态源=既有变量 selectedId/compacting/agentBusy）
// ② 覆盖层（`notice(...)` 的瞬时报文；错误**优先覆盖**状态层，确认类回执退场后把行还给状态层）。
//
// 这条门证的四件事（每条都在下面有断言；截图见 /tmp/sopho-hint-line）：
//   1. 四种状态层文案逐字正确，且**不含动态数字**（不含 [0-9] —— 会变宽变窄 ⇒ 整行抖）；
//   2. 报文覆盖层真的压过状态层（错误优先级），且错误 / 确认类回执各自的退场纪律成立；
//   3. 文案在五种状态之间换来换去，`#notice` / composer / 正文区的几何**逐帧位移 = 0px**
//      （那一行本来就占位 ⇒ 换文案不动布局；这是「零新增元素、零新增行」的机械证明）；
//   4. 四个宽度（1200/900/420/360）下每一句状态层文案都是**单行、不横向溢出**（词不被折断）。
//
// 只用高位随机端口 + 临时 sandbox + 自带 chromium profile；不碰真实 profile、7331/7321；不 pkill。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `SOPHO_HINT_WEB` 只给**对照实验**用：把伺服出去的 `web/` 换成另一份（例如修前的 `git show HEAD:web/app.js`）——
// 同一把尺子量两个版本，修前应当**红**（它没有状态层、也没有 data-layer）。
const webRoot = process.env.SOPHO_HINT_WEB ? path.resolve(process.env.SOPHO_HINT_WEB) : path.join(root, 'web');
const artifactRoot = process.env.SOPHO_HINT_ARTIFACT || path.join(os.tmpdir(), 'sopho-hint-line');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const WIDTHS = [1200, 900, 420, 360];

// 契约文案（与 `web/app.js` 顶部五个常量逐字一致；这里是**另一份抄写**，抄错了门就红）。
const HINT_NO_SESSION = '先选一个会话';
const HINT_IDLE = 'Enter 发送 · Shift+Enter 换行';
const HINT_STREAMING = '流式中 —— Enter 插话 · Alt+Enter 排到队尾';
const HINT_COMPACTING = '正在压缩上下文…（可能要几十秒）';
// 确认类回执的存活时间（`web/app.js` 的 NOTICE_RECEIPT_MS）。门比它多等 1s 再验「让回状态层」。
const NOTICE_RECEIPT_MS = 5000;

const HISTORY = [
  { role: 'user', text: 'I-12 提示行：先来一条正文，让正文区有高度。' },
  { role: 'assistant', text: 'I-12 提示行：正文在，下面这一行换成什么都不会动它。' },
];

let server; let chromium; let browser; let port; let sandbox; let sessionStream; let treeStream;

const checkpoints = { pass: [], fail: [] };
function check(label, ok, detail) {
  (ok ? checkpoints.pass : checkpoints.fail).push(`${label}：${detail}`);
  process.stdout.write(`${ok ? '✓' : '✗'} ${label} —— ${detail}\n`);
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
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}
async function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port: free } = listener.address();
      listener.close(() => resolve(free));
    });
  });
}
async function waitFor(operation, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
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
async function frames(count = 3) {
  await evaluate(`new Promise((resolve)=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
}
async function viewport(width, height = 760) {
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await frames(3);
}
async function shot(name) {
  const image = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const file = path.join(artifactRoot, `${name}.png`);
  await writeFile(file, Buffer.from(image.data, 'base64'));
  return file;
}
async function emit(name, data = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  if (!response.ok) throw new Error(`emit ${name} failed: ${response.status}`);
}

/** 行上事实的只读探针：文案 / 层 / data-level / 字色 / 盒高 / 行数 / 横向溢出。 */
const PROBE = `(() => {
  const node = document.querySelector('#notice');
  const prompt = document.querySelector('#prompt');
  const style = getComputedStyle(node);
  const box = node.getBoundingClientRect();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts = [];
  let cursor;
  while ((cursor = walker.nextNode())) if (cursor.data.trim()) texts.push(cursor);
  let lines = 0;
  if (texts.length) {
    const range = document.createRange();
    range.setStart(texts[0], 0);
    range.setEnd(texts[texts.length - 1], texts[texts.length - 1].data.length);
    lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.y))).size;
  }
  return {
    text: node.textContent,
    layer: node.dataset.layer ?? null,
    level: node.dataset.level ?? null,
    color: node.style.color,
    slot: style.borderInlineStartColor,
    height: Math.round(box.height * 100) / 100,
    lines,
    nodeCount: node.childElementCount,
    promptDisabled: prompt.disabled,
    overflowX: Math.round((document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth) * 100) / 100,
  };
})()`;
const probe = () => evaluate(PROBE);

/** 软等待：等不到就记一条红、继续往下量 —— 修前对照（`SOPHO_HINT_WEB`）要的是**全量**差在哪，
 *  而不是在第一条断言上就停下来。 */
async function softWaitFor(operation, message, timeoutMs = 5000) {
  try { return await waitFor(operation, message, timeoutMs); }
  catch (error) { check(message, false, error.message); return null; }
}

/** 逐帧采样：只记盒子，不写任何东西（`window.__hint` 由注入脚本挂上）。 */
async function startSampling() { await evaluate(`window.__hint.start()`); }
async function stopSampling() { return evaluate(`window.__hint.collect()`); }

const INSTRUMENT = `(() => {
  const H = window.__hint = { frames: [], sampling: false };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);
  const box = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { top: num(r.top), height: num(r.height), left: num(r.left), width: num(r.width) }; };
  const sample = () => {
    const notice = document.querySelector('#notice');
    const composer = document.querySelector('#composer');
    const pane = document.querySelector('.messages-pane');
    const header = document.querySelector('main > header');
    if (!notice || !composer) return null;
    return {
      t: num(performance.now()),
      text: notice.textContent,
      layer: notice.dataset.layer ?? null,
      notice: box(notice),
      composer: box(composer),
      pane: box(pane),
      header: box(header),
    };
  };
  H.start = () => { H.frames = []; H.sampling = true; const step = () => { if (!H.sampling) return; const value = sample(); if (value) H.frames.push(value); requestAnimationFrame(step); }; requestAnimationFrame(step); };
  H.collect = () => { H.sampling = false; return H.frames; };
})();`;

let primaryError;
try {
  await mkdir(artifactRoot, { recursive: true });
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-hint-line-'));
  port = await reservePort();
  const treeRows = [
    { id: SESSION_ID, name: 'I-12 提示行（正常会话）', cwd: '/tmp/i12-hint', archived: false, status: 'idle', statusLabel: '闲置', unread: false, lastActivity: '2026-09-19T12:00:00.000Z', modifiedAt: '2026-09-19T12:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
    { id: OTHER_ID, name: 'I-12 提示行（另一条）', cwd: '/tmp/i12-hint-2', archived: false, status: 'idle', statusLabel: '闲置', unread: false, lastActivity: '2026-09-19T11:00:00.000Z', modifiedAt: '2026-09-19T11:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  ];
  let sessionStreaming = false;
  let compacting = false;

  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
      if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
      if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions: treeRows, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
      if (url.pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: treeRows })}\n\n`);
        treeStream = response;
        response.once('close', () => { if (treeStream === response) treeStream = null; });
        return;
      }
      if (url.pathname === '/api/test/event' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (name === 'session.start') sessionStreaming = true;
        if (name === 'session.settled') sessionStreaming = false;
        if (name === 'session.compaction_start') compacting = true;
        if (name === 'session.compaction_end') compacting = false;
        if (!sessionStream || sessionStream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
        sessionStream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return sendJson(response, 200, { ok: true });
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|draft|events))?$/.exec(url.pathname);
      if (sessionMatch) {
        const id = sessionMatch[1];
        const action = sessionMatch[2] ?? null;
        const row = treeRows.find((entry) => entry.id === id);
        if (!row) return sendJson(response, 404, { message: 'not found' });
        if (action === null) {
          return sendJson(response, 200, {
            id, name: row.name, archived: false, readOnly: false,
            runtime: { isStreaming: sessionStreaming, isCompacting: compacting, isRetrying: false },
            observability: null, context: null,
          });
        }
        if (action === 'messages') return sendJson(response, 200, { messages: HISTORY, extras: [], compaction: { atIndex: null }, observability: null, context: null });
        if (action === 'commands') return sendJson(response, 200, { streaming: sessionStreaming, commands: [] });
        if (action === 'draft') return sendJson(response, 200, { text: '' });
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: sessionStreaming, isCompacting: compacting, isRetrying: false, pendingMessages: 0, queue: { steering: [], followUp: [] } })}\n\n`);
          if (id === SESSION_ID) sessionStream = response;
          response.once('close', () => { if (sessionStream === response) sessionStream = null; });
          return;
        }
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
  await viewport(1200, 760);
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`!!document.querySelector('#notice') && !!window.__hint`), 'page did not load');
  await frames(3);

  const openSession = async (id) => {
    await evaluate(`document.querySelector('[data-session-id="${id}"] .tree-select').click()`);
    await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false && document.querySelector('#messages').dataset.renderComplete === 'true'`), `session ${id} did not open`);
    await frames(3);
  };
  const clearReceipt = async () => {
    await evaluate(`(() => { const input = document.querySelector('#prompt'); input.value = 'x'; input.dispatchEvent(new Event('input', { bubbles: true })); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await frames(2);
  };

  // ── ① 冷开：未选会话 ─────────────────────────────────────────────────────
  // 逐帧采样就从这里开始（含冷开那一句）：下面每一次换状态都必须**不动布局**。
  await startSampling();
  const cold = await probe();
  check('① 冷开（未选会话）', cold.text === HINT_NO_SESSION && cold.layer === 'hint', `text=${JSON.stringify(cold.text)} layer=${cold.layer}`);
  const coldShot = await shot('hint-1-no-session-1200x760');

  // ── ② 打开会话：空闲 ────────────────────────────────────────────────────
  await openSession(SESSION_ID);
  const idle = await probe();
  check('② 空闲', idle.text === HINT_IDLE && idle.layer === 'hint', `text=${JSON.stringify(idle.text)} height=${idle.height} lines=${idle.lines}`);
  const idleShot = await shot('hint-2-idle-1200x760');

  // ── ③ 流式中（既有变量 agentBusy：session.start→true / session.settled→false） ──
  await emit('session.start', {});
  await softWaitFor(async () => (await probe()).text === HINT_STREAMING, '③ 流式中：状态层文案未出现');
  const streaming = await probe();
  check('③ 流式中', streaming.text === HINT_STREAMING && streaming.layer === 'hint', `text=${JSON.stringify(streaming.text)} height=${streaming.height} lines=${streaming.lines}`);
  const streamingShot = await shot('hint-3-streaming-1200x760');

  // ── ④ 压缩中（既有变量 compacting：session.compaction_start→true） ─────────
  await emit('session.compaction_start', {});
  await softWaitFor(async () => (await probe()).text === HINT_COMPACTING, '④ 压缩中：状态层文案未出现');
  const compactText = await probe();
  check('④ 压缩中', compactText.text === HINT_COMPACTING && compactText.layer === 'hint', `text=${JSON.stringify(compactText.text)} height=${compactText.height} lines=${compactText.lines}`);
  const compactShot = await shot('hint-4-compacting-1200x760');
  await emit('session.compaction_end', {});
  await softWaitFor(async () => (await probe()).layer === 'notice', '④b compaction_end 回执未占行');
  await clearReceipt();

  // ── ⑤ 报文覆盖层：错误优先压过状态层，打字后把行还回来 ────────────────────
  await emit('session.error', { message: 'I-12 受控错误：这一句必须盖过状态层' });
  const errored = await probe();
  check('⑤ 错误优先覆盖状态层', errored.layer === 'notice' && errored.level === 'error' && errored.text.includes('受控错误') && errored.color === 'var(--danger)', `text=${JSON.stringify(errored.text)} layer=${errored.layer} level=${errored.level} color=${errored.color}`);
  const errorShot = await shot('hint-5-error-override-1200x760');
  await clearReceipt();
  const afterTyping = await probe();
  check('⑤b 打字后错误撤掉、行让回状态层', afterTyping.layer === 'hint' && afterTyping.text === HINT_STREAMING, `text=${JSON.stringify(afterTyping.text)} layer=${afterTyping.layer}`);

  // ── ⑥ 确认类回执（info）自己退场：回执不得永久挡住状态层 ────────────────────
  await emit('session.end', { stopReason: 'stop' });
  await softWaitFor(async () => (await probe()).text.includes('回复完成'), '⑥ 回复完成回执未出现');
  const receipt = await probe();
  check('⑥ 确认类回执先占行（info）', receipt.layer === 'notice' && receipt.level === 'info' && receipt.text.includes('回复完成'), `text=${JSON.stringify(receipt.text)} layer=${receipt.layer} level=${receipt.level}`);
  const receiptAt = Date.now();
  const reverted = await softWaitFor(async () => {
    const value = await probe();
    return value.layer === 'hint' ? value : null;
  }, `⑥b 回执未在 ${NOTICE_RECEIPT_MS + 1200}ms 内把行还给状态层`, NOTICE_RECEIPT_MS + 1500);
  check('⑥b 回执退场后行还给状态层', reverted?.layer === 'hint' && reverted?.text === HINT_STREAMING, `回执出现后 ${Date.now() - receiptAt}ms（NOTICE_RECEIPT_MS=${NOTICE_RECEIPT_MS}）⇒ text=${JSON.stringify(reverted?.text ?? null)}`);
  await emit('session.settled', {});
  await softWaitFor(async () => (await probe()).text === HINT_IDLE, '⑥c settled 未把行还回空闲状态');

  // ── ⑦ 切会话：状态层跟着新会话走（不是残留上一条的报文） ──────────────────
  await openSession(OTHER_ID);
  await clearReceipt();
  const switched = await probe();
  check('⑦ 切会话后是状态层', switched.layer === 'hint' && switched.text === HINT_IDLE, `text=${JSON.stringify(switched.text)} layer=${switched.layer}`);
  await openSession(SESSION_ID);
  await clearReceipt();

  // ── 逐帧几何：整段换状态过程里 notice / composer / pane / header 位移必须 = 0 ──
  const framesAll = await stopSampling();
  assert.ok(framesAll.length > 60, `采样帧太少：${framesAll.length}`);
  const keys = [['notice', 'top'], ['notice', 'height'], ['composer', 'top'], ['composer', 'height'], ['pane', 'top'], ['header', 'top'], ['header', 'height']];
  const drift = {};
  for (const [node, field] of keys) {
    let max = 0; let detail = 'none';
    for (let index = 1; index < framesAll.length; index += 1) {
      const before = framesAll[index - 1][node]?.[field];
      const after = framesAll[index][node]?.[field];
      if (typeof before !== 'number' || typeof after !== 'number') continue;
      const delta = Math.round((after - before) * 100) / 100;
      if (Math.abs(delta) > max) { max = Math.abs(delta); detail = `${node}.${field} Δ=${delta}px @frame${index}（${JSON.stringify(framesAll[index - 1].text)} → ${JSON.stringify(framesAll[index].text)}）`; }
    }
    drift[`${node}.${field}`] = { maxPx: max, detail };
  }
  const texts = [...new Set(framesAll.map((frame) => frame.text))];
  const seenStates = [HINT_NO_SESSION, HINT_IDLE, HINT_STREAMING, HINT_COMPACTING].filter((text) => texts.includes(text));
  check(
    '⑧ 换文案不动布局（逐帧位移 = 0px）',
    Object.values(drift).every((entry) => entry.maxPx === 0) && seenStates.length === 4,
    `${framesAll.length} 帧 / ${texts.length} 种文案（状态层 4 种都出现：${seenStates.length}/4）；最大位移 ${JSON.stringify(Object.fromEntries(Object.entries(drift).map(([key, value]) => [key, value.maxPx])))}`,
  );
  print('逐帧位移明细', drift);
  print('逐帧文案序列（去重）', texts);

  // ── ⑨ 四个宽度：状态层每一句都单行、不横向溢出；重绘一整套状态并拍图 ─────────
  const widthReport = {};
  for (const width of WIDTHS) {
    // 每一档都从**冷开**（未选会话）起：先刷一次页，再按状态层顺序走一圈。
    await viewport(width, width <= 420 ? 820 : 760);
    const reloaded = browser.once('Page.loadEventFired');
    await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await reloaded;
    await waitFor(() => evaluate(`!!document.querySelector('#notice')`), `${width}: reload did not settle`);
    await frames(3);
    const rows = [];
    const record = async (label) => {
      const value = await probe();
      rows.push({ label, text: value.text, layer: value.layer, height: value.height, lines: value.lines, overflowX: value.overflowX });
      return value;
    };
    const coldish = await record('no-session');
    check(`⑨ ${width}px：冷开状态层文案`, coldish.text === HINT_NO_SESSION, `text=${JSON.stringify(coldish.text)}`);
    await openSession(SESSION_ID);
    await clearReceipt();
    await record('idle');
    await emit('session.start', {});
    await softWaitFor(async () => (await probe()).text === HINT_STREAMING, `⑨ ${width}px：流式中状态层文案未出现`);
    await record('streaming');
    await shot(`hint-3-streaming-${width}x${width <= 420 ? 820 : 760}`);
    await emit('session.compaction_start', {});
    await softWaitFor(async () => (await probe()).text === HINT_COMPACTING, `⑨ ${width}px：压缩中状态层文案未出现`);
    await record('compacting');
    await shot(`hint-4-compacting-${width}x${width <= 420 ? 820 : 760}`);
    await emit('session.compaction_end', {});
    await softWaitFor(async () => (await probe()).layer === 'notice', `⑨ ${width}px：compaction_end 回执未占行`);
    await clearReceipt();
    await emit('session.end', { stopReason: 'stop' });
    await softWaitFor(async () => (await probe()).layer === 'notice' && (await probe()).text.includes('回复完成'), `⑨ ${width}px：回复完成回执未出现`);
    await record('receipt');
    await clearReceipt();
    await emit('session.settled', {});
    await softWaitFor(async () => (await probe()).text === HINT_IDLE, `⑨ ${width}px：settled 后空闲状态未回`);
    await record('idle-after-settled');
    await shot(`hint-2-idle-${width}x${width <= 420 ? 820 : 760}`);
    widthReport[width] = rows;
    const statusRows = rows.filter((row) => row.layer === 'hint');
    check(
      `⑨ ${width}px：状态层单行、不溢出、无动态数字`,
      statusRows.length >= 4 && statusRows.every((row) => row.lines === 1 && row.overflowX <= 0 && row.height <= 20 && !/[0-9]/.test(row.text)),
      statusRows.map((row) => `${row.label}「${row.text}」lines=${row.lines} h=${row.height} overflowX=${row.overflowX}`).join(' · '),
    );
  }
  print('四档宽度明细', widthReport);

  check('⑩ 页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));
  print('screenshots', { cold: coldShot, idle: idleShot, streaming: streamingShot, compacting: compactShot, errorOverride: errorShot });
  print('chromium', { product: version.Browser, executable: chrome, forbiddenPortsUsed: false, port, debugPort });
  print('checks', checkpoints.pass.length + checkpoints.fail.length);
  if (checkpoints.fail.length) throw new Error(`hint line gate failed:\n${checkpoints.fail.join('\n')}`);
  print('RESULT', `hint line PASS（状态层 4 句 + 覆盖层 2 类；换文案逐帧位移 0px；四档宽度 ${WIDTHS.join('/')} 单行）`);
  primaryError = null;
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'close browser', async () => { browser?.close(); });
  await cleanupStep(cleanupProblems, 'close event streams', async () => { treeStream?.destroy(); sessionStream?.destroy(); });
  if (chromium && chromium.exitCode === null) {
    await cleanupStep(cleanupProblems, 'stop chromium', () => {
      chromium.kill('SIGTERM');
      return new Promise((resolve) => chromium.once('exit', resolve));
    });
  }
  if (server) {
    await cleanupStep(cleanupProblems, 'close server', () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
  }
  if (sandbox) await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
