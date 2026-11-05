#!/usr/bin/env node
// test/live-order.mjs —— 「消息区 DOM 顺序」的观察台 + 门。
//
// 要守住的一条不变量（一句话）：**一轮流式里，我发出去的那条 user 消息必须排在它对应的助手块
// 之前** —— 不管那块是历史节点、还是屏幕最下面那个直播块（`.live-message`），中间夹不夹扩展消息块。
// 业主 2026-09-20 报的现象正是这条被破：发一条消息之后，「流式回复出现在我的消息上面」。
//
// 形状：真 Chromium + 假 API（不碰真实例：高位随机端口 + 临时目录 + 只读 web/ 源码）。
// 假 API 照**真服务端**的形状给载荷，不是"凑巧能让前端跑起来"的形状：
//   · 每条 message 带 `entryId` / `stopReason` / `parts`（server/base-logic.mjs 的 messageWire），
//     助手条目在流式途中 `stopReason: null`（未定稿）、结束才写 `'stop'`；
//   · `GET /messages?after=<entryId>` 走真服务端那套尾部增量（同 tailMessageValue：`messages` 只给
//     游标之后的，另带 `tail:{afterEntryId,from,total}`，`extras` 照旧给全）——这样客户端走的才是
//     **真** 的 `tailBase`/`tailMerge`/`appendMessageNodes` 落位路径；
//   · 每条载荷带 `sessionId`（前端 tailBase 拿它认会话）。
//
// 覆盖的路径（业主报的那条是 ①②）：
//   ① 「我的这条还没进 DOM，直播块已经画上了」—— POST 的 202 慢（SSE 先到）⇒ 占位在直播块**之后**才建；
//   ② session.start 那一帧的尾部增量回来时直播块已经在屏幕上 ⇒ 后到的那条 user 正文节点往哪儿插；
//   ③ 流式期间切走再切回（含初连快照 / greeting hello 账那条路）；
//   ④ 子会话 push 回来的代理消息块（`aside.extra-message`，customType=sopho.delegation）；
//   ⑤ 渐进渲染还没 `renderComplete` 时就开始流式（大会话）。
// 另有一条**护栏**（不属于主现象，但修法绝不许把它改坏）：插话（steer）时，占位必须排在直播块
// **之后** —— pi 是把这条插话注入到"当前这一段之后"的，而它的历史正文也落在那一块后面。
//
// ⚠️ 时延是**夹具制造的**、不是猜的：`postDelayMs` / `tailDelayMs` 只把「202 比 SSE 慢」「尾部增量
// 回得比一帧慢」这两件事做**确定**（真服务端上它们本来就是同一量级的抖动），否则这条门只是
// 「谁先到」的掷骰子。两个时延都在报告里如实打印。

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
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-liveorder-'));
const artifactRoot = process.env.SOPHO_LIVE_ORDER_ARTIFACT_DIR || path.join(os.tmpdir(), 'sopho-live-order');
const screenshotSendFile = path.join(artifactRoot, 'live-order-after-send-1200x760.png');
const screenshotSteerFile = path.join(artifactRoot, 'live-order-steer-1200x760.png');
const screenshotBigFile = path.join(artifactRoot, 'live-order-big-streaming-1200x760.png');

const MAIN = '11111111-1111-4111-8111-111111111111';
const BIG = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const SEND_A = 'ORDER-A1-我发的那条必须排在流式块之前。';
const PREFIX_A = 'ORDER-A2-这一轮已经落盘的前缀。';
const LIVE_TAIL = 'ORDER-A3-直播里还没落盘的那一段。';
const DELEGATION = 'ORDER-D1-子会话-push-回来的代理消息。';
const SEND_B = 'ORDER-B1-切回会话之后再发一条。';
const STEER = 'ORDER-S1-插话：这一条必须排在直播块之后。';
const STEER_SEGMENT = 'ORDER-S2-插话之前那一段已经落盘。';
const STEER_AFTER = 'ORDER-S3-插话注入之后新起的那一段。';
const BIG_SEND = 'ORDER-E1-大会话渐进渲染还没画完时发的那条。';
const BIG_LIVE = 'ORDER-E2-大会话里的流式正文。';

const HOLD_MS = { post: 150, tail: 200 };
let entrySeq = 0;
const nextEntryId = (tag) => `${tag}-${String(++entrySeq).padStart(3, '0')}`;
const stamp = () => new Date(Date.UTC(2026, 8, 20, 0, 0, 0) + (entrySeq * 1000)).toISOString();

function wireUser(text) {
  const entryId = nextEntryId('u');
  return { entryId, parentId: null, timestamp: stamp(), kind: 'message', role: 'user', content: [{ type: 'text', text }], text, images: [], stopReason: null, errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [] };
}

function wireAssistant(text, { stopReason = 'stop' } = {}) {
  const entryId = nextEntryId('a');
  return { entryId, parentId: null, timestamp: stamp(), kind: 'message', role: 'assistant', content: [{ type: 'text', text }], text, parts: [{ type: 'text', text }], images: [], stopReason, errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [] };
}

function wireExtra(text, parentId, customType = 'sopho.delegation') {
  const entryId = nextEntryId('x');
  return { entryId, parentId, timestamp: stamp(), customType, content: [{ type: 'text', text }], text, display: true, details: null };
}

function historyPair(index) {
  return [wireUser(`历史 ${index} 条：这一条在开会话时就画好了。`), wireAssistant(`历史 ${index} 条的回话：也在开会话时画好了。`)];
}

function makeCell(id, name, messages, extra = {}) {
  return { id, name, messages, extras: [], streaming: false, queue: { steering: [], followUp: [] }, reads: 0, postDelayMs: 0, tailDelayMs: 0, ...extra };
}

const cells = new Map([
  [MAIN, makeCell(MAIN, 'ORDER 主会话', [...historyPair(1), ...historyPair(2), ...historyPair(3)])],
  [BIG, makeCell(BIG, 'ORDER 大会话', Array.from({ length: 150 }, (_, index) => historyPair(index + 1)).flat())],
  [OTHER, makeCell(OTHER, 'ORDER 另一个会话', [...historyPair(1), ...historyPair(2)])],
]);
const sessions = [...cells.values()].map((cell) => ({
  id: cell.id, name: cell.name, parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
  unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}));

const sessionStreams = new Map();
let treeStream;
let server;
let chromium;
let browser;
let checks = 0;
let primaryError;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(operation, message, timeoutMs = 10_000) {
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

// 消息区子节点的**顺序快照**：`kind` 直接读节点上的 dataset（render.js / app.js 自己打的），
// 所以「哪一块排在哪儿」是**屏幕上的事实**，不是测试算出来的。
async function snapshot() {
  return evaluate(`(() => {
    const root = document.querySelector('#messages');
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    return {
      renderComplete: root.dataset.renderComplete === 'true',
      total: root.dataset.messageTotal || null,
      children: Array.from(root.children).map((node, index) => ({
        index,
        kind: node.dataset.kind || '',
        role: node.dataset.role || '',
        live: node.classList.contains('live-message') === true,
        pending: node.dataset.pending || '',
        custom: node.dataset.customType || null,
        anchor: node.dataset.anchor || null,
        entry: node.dataset.entryId || null,
        label: clean(node.querySelector('.message-role')?.textContent),
        text: clean((node.querySelector('.message-body') || node).textContent),
      })),
    };
  })()`);
}

const isLive = (child) => child.live === true || child.kind === 'live';
const isFrozenLive = (child) => child.kind === 'live-done';
const isPending = (child) => child.pending !== '';
const mentionsText = (needle) => (child) => child.text.includes(needle);
const isUser = (needle) => (child) => child.kind === 'message' && child.role === 'user' && child.text.includes(needle);
const isAssistant = (needle) => (child) => child.kind === 'message' && child.role === 'assistant' && child.text.includes(needle);
const isExtra = (needle) => (child) => child.kind === 'extra' && child.text.includes(needle);

function at(children, predicate) {
  return children.findIndex(predicate);
}

function layout(children) {
  return children.map((child) => {
    const kind = isLive(child) ? 'LIVE' : child.kind || '?';
    const marks = [
      child.role ? `/${child.role}` : '',
      child.pending ? `|pending:${child.pending}` : '',
      child.custom ? `|${child.custom}` : '',
      child.anchor ? `|${child.anchor}` : '',
    ].join('');
    return `${child.index}:${kind}${marks}${child.text ? `:${child.text.slice(0, 14)}` : ''}`;
  }).join('  ');
}

/** 断言一组「A 必须在 B 之前」——两边都必须在场（找不到就是 red，不是 skip）。 */
function checkOrder(name, children, pairs) {
  const failed = pairs
    .map(([label, before, after]) => ({ label, before: at(children, before), after: at(children, after) }))
    .filter((item) => !(item.before >= 0 && item.after >= 0 && item.before < item.after));
  check(name, failed.length === 0, `${failed.map((item) => `${item.label}(before=#${item.before} after=#${item.after})`).join(' ') || 'ok'} :: ${layout(children)}`);
}

async function countOf(needle) {
  return evaluate(`(document.querySelector('#messages').textContent.split(${JSON.stringify(needle)}).length-1)`);
}

// 页内发送：走**用户那条路**（prompt input + keydown Enter）—— `send()` 自己按 agentBusy 选
// message / steer，于是量到的是真语义，不是测试替它选出来的。
async function sendKey(text, { alt = false } = {}) {
  await evaluate(`(() => {
    const prompt = document.querySelector('#prompt');
    prompt.value = ${JSON.stringify(text)};
    prompt.dispatchEvent(new Event('input'));
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: ${alt}, cancelable: true, bubbles: true }));
    return true;
  })()`);
}

async function emit(name, data = {}, id = MAIN) {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, name, data }),
  });
  if (!response.ok) throw new Error(`emit ${name} failed: ${response.status}`);
}

async function control(id, options) {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, ...options }),
  });
  if (!response.ok) throw new Error(`control failed: ${response.status}`);
}

async function openSession(id, expected) {
  await evaluate(`document.querySelector('[data-session-id="${id}"] .tree-select').click()`);
  await waitFor(async () => {
    const value = await snapshot();
    return value.children.length === expected ? value : null;
  }, `session ${id} did not open with ${expected} blocks`);
  await frames();
}

await mkdir(artifactRoot, { recursive: true });
const port = await reservePort();
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
    if (url.pathname === '/api/test/control' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const cell = cells.get(body.id);
      if (!cell) return sendJson(response, 404, { message: 'unknown session' });
      if (typeof body.postDelayMs === 'number') cell.postDelayMs = body.postDelayMs;
      if (typeof body.tailDelayMs === 'number') cell.tailDelayMs = body.tailDelayMs;
      return sendJson(response, 200, { ok: true, postDelayMs: cell.postDelayMs, tailDelayMs: cell.tailDelayMs });
    }
    if (url.pathname === '/api/test/event' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { id, name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const stream = sessionStreams.get(id);
      if (!stream || stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
      const cell = cells.get(id);
      if (name === 'session.start') cell.streaming = true;
      if (name === 'session.end') cell.streaming = false;
      stream.write(`event: ${name}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
      return sendJson(response, 200, { ok: true });
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|message|steer|follow-up|model))?$/.exec(url.pathname);
    if (match) {
      const id = match[1];
      const action = match[2] ?? null;
      const cell = cells.get(id);
      if (!cell) return sendJson(response, 404, { message: 'not found' });
      if (action === null) return sendJson(response, 200, {
        name: cell.name, cwd: '/tmp/fake-cwd', context: null, observability: null,
        runtime: { isStreaming: cell.streaming, isCompacting: false, isRetrying: false },
      });
      if (action === 'messages') {
        cell.reads += 1;
        const after = url.searchParams.get('after');
        let body = {
          sessionId: id, cwd: '/tmp/fake-cwd', messages: cell.messages, extras: cell.extras,
          compaction: { entryId: null, atIndex: null, timestamp: null, summary: null, tokensBefore: null },
          observability: null, context: null,
        };
        if (after !== null) {
          const index = cell.messages.findIndex((item) => item.entryId === after);
          if (index >= 0) body = { ...body, messages: cell.messages.slice(index + 1), tail: { afterEntryId: after, from: index + 1, total: cell.messages.length } };
        }
        if (cell.tailDelayMs > 0) await sleep(cell.tailDelayMs);
        return sendJson(response, 200, body);
      }
      if (action === 'message') {
        const body = JSON.parse((await readBody(request)) || '{}');
        cell.messages.push(wireUser(body.text));
        if (cell.postDelayMs > 0) await sleep(cell.postDelayMs);
        return sendJson(response, 202, { accepted: true, sessionId: id, mode: 'message' });
      }
      if (action === 'steer' || action === 'follow-up') {
        const body = JSON.parse((await readBody(request)) || '{}');
        const key = action === 'steer' ? 'steering' : 'followUp';
        cell.queue[key] = [...cell.queue[key], body.text];
        const stream = sessionStreams.get(id);
        if (stream && !stream.destroyed) stream.write(`event: session.queue\ndata: ${JSON.stringify(cell.queue)}\n\n`);
        return sendJson(response, 202, { accepted: true, mode: action === 'steer' ? 'steer' : 'followUp' });
      }
      if (action === 'commands') return sendJson(response, 200, { streaming: cell.streaming, commands: [] });
      if (action === 'model') return sendJson(response, 200, { models: [], current: null });
      if (action === 'seen') return sendJson(response, 200, { ok: true });
      if (action === 'draft') return sendJson(response, 200, { text: '' });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: cell.streaming, isCompacting: false, isRetrying: false, pendingMessages: 0, queue: cell.queue })}\n\n`);
        sessionStreams.set(id, response);
        response.once('close', () => { if (sessionStreams.get(id) === response) sessionStreams.delete(id); });
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
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reservePort();
  const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
    ? 'C:/Users/user/AppData/Local/Chromium/Application/chrome.exe'
    : '/usr/bin/chromium');
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const pageProblems = [];
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  // ⑤ 渐进渲染那一档要的是「还没 renderComplete」——把空闲回调扣住（**只在页内**：真浏览器的
  // requestIdleCallback 是「有空才跑」，这里把它变确定），否则大会话会在我们发消息之前就补完。
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const held = [];
    window.__heldIdleCallbacks = held;
    window.requestIdleCallback = (callback) => { held.push(callback); return held.length; };
    window.cancelIdleCallback = () => {};
  })();` });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${MAIN}"]') !== null`), 'session row did not render');

  // ── ①② 业主报的那条：历史已经画好 → 发一条 → 助手开始流式 ─────────────────────
  await openSession(MAIN, 6);
  const opened = await snapshot();
  check('主会话开会话时 6 条历史一次画完（渐进路走完，尾部增量机制可用）', opened.renderComplete === true && opened.children.length === 6,
    `renderComplete=${opened.renderComplete} children=${opened.children.length}`);

  await control(MAIN, { postDelayMs: HOLD_MS.post, tailDelayMs: HOLD_MS.tail });
  const readsBeforeSend = cells.get(MAIN).reads;
  await sendKey(SEND_A);
  // 假 API 在 POST 进来那一刻就写进正文（真服务端也是先落盘再起轮），202 慢 150ms 才回；
  // SSE 的 session.start 由测试在 80ms 时发 ⇒ **直播块先画上、占位后建**。
  await sleep(80);
  await emit('session.start');
  await emit('session.delta', { channel: 'text', delta: PREFIX_A });
  await emit('session.delta', { channel: 'text', delta: LIVE_TAIL });
  await waitFor(async () => {
    const value = await snapshot();
    return at(value.children, isLive) >= 0 && value.children.some((child) => isLive(child) && child.text.includes(LIVE_TAIL)) ? value : null;
  }, 'live block did not appear with its streamed text');
  await waitFor(async () => {
    const value = await snapshot();
    return value.children.some(isPending) ? value : null;
  }, 'the sent message did not show up as a pending placeholder');
  await frames();
  const pendingShot = await snapshot();
  check('发送后占位与直播块同时在场（这一档要量的就是它们俩的先后）', pendingShot.children.some(isPending) && at(pendingShot.children, isLive) >= 0,
    layout(pendingShot.children));
  checkOrder('① 我的这条（占位，还没进正文）必须排在直播块**之前**', pendingShot.children, [
    ['占位', isPending, isLive],
    ['占位文本', (child) => isPending(child) && mentionsText(SEND_A)(child), isLive],
  ]);
  const sendShot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(screenshotSendFile, Buffer.from(sendShot.data, 'base64'));

  await waitFor(() => (cells.get(MAIN).reads > readsBeforeSend ? true : null), 'the tail refresh after session.start did not happen');
  await waitFor(async () => {
    const value = await snapshot();
    return at(value.children, isUser(SEND_A)) >= 0 ? value : null;
  }, 'the sent user message never reached the rendered history');
  await frames();
  const afterRefresh = await snapshot();
  checkOrder('② 落进正文之后：我那条 user 正文必须排在直播块**之前**', afterRefresh.children, [
    ['user(SEND_A)', isUser(SEND_A), isLive],
  ]);
  check('② 占位被正文兑掉、同一句只出现一次', afterRefresh.children.filter(isPending).length === 0 && (await countOf(SEND_A)) === 1,
    `pending=${afterRefresh.children.filter(isPending).length} count=${await countOf(SEND_A)} :: ${layout(afterRefresh.children)}`);

  // ── ④ 子会话 push 回来的代理消息块 + 这一轮已落盘的前缀 ────────────────────────
  // 中途落盘：这一轮的 assistant 前缀（真 pi 就是边流边写）、外加一条 `custom_message`
  //（子会话 push 回来，parentId 指着我那条 user 正文 ⇒ 它属于那条正文**之后**）。
  const mainCell = cells.get(MAIN);
  const sentEntry = mainCell.messages.find((item) => item.role === 'user' && item.text === SEND_A).entryId;
  mainCell.messages.push(wireAssistant(PREFIX_A, { stopReason: null }));
  mainCell.extras.push(wireExtra(DELEGATION, sentEntry));
  await emit('session.snapshot', { isStreaming: true, isCompacting: false, isRetrying: false });
  await frames();
  const withExtra = await waitFor(async () => {
    const value = await snapshot();
    return value.children.some(isExtra(DELEGATION)) ? value : null;
  }, 'the delegation extra block did not render');
  await frames();
  const extraShot = await snapshot();
  checkOrder('④ 代理消息块与已落盘前缀都排在直播块**之前**（顺序：user → extra → 前缀 → 直播）', extraShot.children, [
    ['user(SEND_A)', isUser(SEND_A), isExtra(DELEGATION)],
    ['extra', isExtra(DELEGATION), isLive],
    ['assistant(PREFIX_A)', isAssistant(PREFIX_A), isLive],
  ]);
  check('④ 代理消息块用的是 parentId 那一档锚（不是回落末尾）', extraShot.children.find(isExtra(DELEGATION))?.anchor === 'message',
    `anchor=${extraShot.children.find(isExtra(DELEGATION))?.anchor} :: ${layout(extraShot.children)}`);
  const prefixCount = await countOf(PREFIX_A);
  check('④ 前缀被直播块接管、正文不重复（直播只画没接管的那段）', prefixCount === 1 && extraShot.children.some((child) => isLive(child) && child.text.includes(LIVE_TAIL)) && !extraShot.children.some((child) => isLive(child) && child.text.includes(PREFIX_A)),
    `prefixCount=${prefixCount} :: ${layout(extraShot.children)}`);

  // ── ③ 流式期间切走再切回 ─────────────────────────────────────────────────────
  await openSession(OTHER, 4);
  const away = await snapshot();
  check('③ 切走时消息区只剩那个会话自己的 4 块（直播块 / 占位都不跟过去）', away.children.length === 4 && !away.children.some(isLive) && !away.children.some(isPending),
    layout(away.children));
  // 浏览器不在的这一段时间里，这一轮把剩下的那段也写完、落盘了（真服务端就是这么长出来的）
  // —— 注意直播块里那段「还没落盘的尾巴」此刻只在屏幕上，切走就跟着没了：它是**当轮**的事实。
  const prefixEntry = mainCell.messages.find((item) => item.role === 'assistant' && item.text === PREFIX_A);
  prefixEntry.text = PREFIX_A + LIVE_TAIL;
  prefixEntry.parts = [{ type: 'text', text: PREFIX_A + LIVE_TAIL }];
  await openSession(MAIN, 9);
  const back = await snapshot();
  checkOrder('③ 切回来：user → extra → 前缀（顺序按服务端那份正文）', back.children, [
    ['user(SEND_A)', isUser(SEND_A), isExtra(DELEGATION)],
    ['extra', isExtra(DELEGATION), isAssistant(PREFIX_A)],
  ]);
  await emit('session.delta', { channel: 'text', delta: SEND_B });
  await waitFor(async () => {
    const value = await snapshot();
    return value.children.some((child) => isLive(child) && child.text.includes(SEND_B)) ? value : null;
  }, 'the live block did not come back after the switch');
  await frames();
  const backLive = await snapshot();
  checkOrder('③ 切回来之后的新流式块仍然排在历史（含我那条）之后', backLive.children, [
    ['user(SEND_A)', isUser(SEND_A), isLive],
    ['extra', isExtra(DELEGATION), isLive],
  ]);
  check('③ 切回来之后恰好一个直播块，落盘的前缀与尾部各一份（不重复画）',
    backLive.children.filter(isLive).length === 1 && (await countOf(PREFIX_A)) === 1 && (await countOf(LIVE_TAIL)) === 1 && (await countOf(SEND_B)) === 1,
    `live=${backLive.children.filter(isLive).length} prefix=${await countOf(PREFIX_A)} tail=${await countOf(LIVE_TAIL)} new=${await countOf(SEND_B)} :: ${layout(backLive.children)}`);

  // ── ⑥ 护栏：插话（steer）的占位必须在直播块**之后** ───────────────────────────
  const paragraphBefore = mainCell.messages.length;
  await sendKey(STEER);
  const steered = await waitFor(async () => {
    const value = await snapshot();
    return at(value.children, (child) => isPending(child) && child.text.includes(STEER)) >= 0 ? value : null;
  }, 'the steer echo did not appear');
  const steerShotPending = await snapshot();
  checkOrder('⑥ 护栏：插话占位排在直播块**之后**（pi 会把它注入到这一段之后）', steerShotPending.children, [
    ['live', isLive, (child) => isPending(child) && child.text.includes(STEER)],
  ]);
  check('⑥ 插话占位按 pi 的队列事实标成排队中', steerShotPending.children.some((child) => isPending(child) && child.text.includes(STEER) && child.label.includes('排队中')),
    layout(steerShotPending.children));
  const steerShot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(screenshotSteerFile, Buffer.from(steerShot.data, 'base64'));

  // 注入：这一段收口 → 队列清空（前端据此认出「被注入了」）→ 新一段开播。
  mainCell.messages.push(wireAssistant(STEER_SEGMENT, { stopReason: 'stop' }));
  mainCell.messages.push(wireUser(STEER));
  mainCell.queue = { steering: [], followUp: [] };
  await emit('session.queue', mainCell.queue);
  await emit('session.start');
  await emit('session.delta', { channel: 'text', delta: STEER_AFTER });
  await waitFor(async () => {
    const value = await snapshot();
    return at(value.children, isUser(STEER)) >= 0 && at(value.children, isAssistant(STEER_SEGMENT)) >= 0 && value.children.some((child) => isLive(child) && child.text.includes(STEER_AFTER)) ? value : null;
  }, 'the injected steer did not settle into history with a fresh live block after it');
  await frames();
  const injectedShot = await snapshot();
  checkOrder('⑥ 注入之后：插话那条 user 正文排在「插话前那一段」之后、新直播块**之前**', injectedShot.children, [
    ['assistant(插话前那一段)', isAssistant(STEER_SEGMENT), isUser(STEER)],
    ['user(插话)', isUser(STEER), isLive],
  ]);
  const steerCount = await countOf(STEER);
  const steerAfterCount = await countOf(STEER_AFTER);
  const segmentCount = await countOf(STEER_SEGMENT);
  check('⑥ 注入之后占位消失，插话 / 新一段 / 插话前那一段各只出现一次（收口块不重复画）',
    injectedShot.children.filter(isPending).length === 0 && steerCount === 1 && steerAfterCount === 1 && segmentCount === 1,
    `pending=${injectedShot.children.filter(isPending).length} steer=${steerCount} after=${steerAfterCount} segment=${segmentCount} frozen=${injectedShot.children.filter(isFrozenLive).length} :: ${layout(injectedShot.children)}`);
  print('paragraph 记账', { messagesBeforeParagraph: paragraphBefore, messagesAfterParagraph: mainCell.messages.length });

  // ── ⑤ 渐进渲染还没 renderComplete 时就开始流式（大会话） ─────────────────────
  await openSession(BIG, 80);
  const bigOpened = await snapshot();
  check('⑤ 大会话开会话：只画了尾部一批、renderComplete 还是 false（空闲补旧消息被扣住）',
    bigOpened.renderComplete === false && bigOpened.children.length === 80 && bigOpened.total === '300',
    `renderComplete=${bigOpened.renderComplete} children=${bigOpened.children.length} total=${bigOpened.total}`);
  await control(BIG, { postDelayMs: HOLD_MS.post, tailDelayMs: HOLD_MS.tail });
  const bigReads = cells.get(BIG).reads;
  await sendKey(BIG_SEND);
  await sleep(60);
  await emit('session.start', {}, BIG);
  await emit('session.delta', { channel: 'text', delta: BIG_LIVE }, BIG);
  await waitFor(async () => {
    const value = await snapshot();
    return value.children.some((child) => isLive(child) && child.text.includes(BIG_LIVE)) ? value : null;
  }, 'the big-session live block did not appear');
  await waitFor(async () => {
    const value = await snapshot();
    return value.children.some(isPending) ? value : null;
  }, 'the big-session sent message did not show up as a pending placeholder');
  await frames();
  const bigPending = await snapshot();
  checkOrder('⑤ 渐进渲染途中开播：我那条的占位也必须在直播块之前', bigPending.children, [
    ['占位', isPending, isLive],
  ]);
  await waitFor(() => (cells.get(BIG).reads > bigReads ? true : null), 'the big-session refresh did not happen');
  await waitFor(async () => {
    const value = await snapshot();
    return at(value.children, isUser(BIG_SEND)) >= 0 ? value : null;
  }, 'the big-session sent message never reached the rendered history');
  await frames();
  const bigShot = await snapshot();
  check('⑤ 这一档确实还在渐进渲染途中（没有拿渲染完的状态冒充）', bigShot.renderComplete === false, `renderComplete=${bigShot.renderComplete} total=${bigShot.total} children=${bigShot.children.length}`);
  checkOrder('⑤ 落进正文之后：我那条也必须在直播块之前', bigShot.children, [
    ['user(BIG_SEND)', isUser(BIG_SEND), isLive],
  ]);
  const bigImage = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(screenshotBigFile, Buffer.from(bigImage.data, 'base64'));

  check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems.slice(0, 4)));

  print('DOM 顺序（关键三帧）', {
    '① 占位与直播块同时在场的顺序': layout(pendingShot.children),
    '② 落进正文之后的顺序': layout(afterRefresh.children),
    '④ 代理消息块与前缀落位后的顺序': layout(extraShot.children),
    '③ 切回来之后': layout(backLive.children),
    '⑥ 插话注入之后': layout(injectedShot.children),
    '⑤ 大会话渐进渲染途中（占位在场）': layout(bigPending.children),
    '⑤ 大会话渐进渲染途中（落进正文之后）': layout(bigShot.children),
  });
  print('夹具时延', { postDelayMs: HOLD_MS.post, tailDelayMs: HOLD_MS.tail });
  print('screenshots', { afterSend: screenshotSendFile, steer: screenshotSteerFile, big: screenshotBigFile });
  print('chromium', { product: version.Browser, executable: chrome, viewport: '1200x760', forbiddenPortsUsed: false });
  print('checks', checks);
  print('RESULT', 'live message order contract PASS');
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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
