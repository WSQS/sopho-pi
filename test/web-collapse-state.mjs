#!/usr/bin/env node
// test/web-collapse-state.mjs —— 「收起思考 / 收起输出点了之后，逻辑一结束就重置」这条用户报告的门 + 复现。
//
// 用户报告（2026-09-20）：会话页点「收起思考」→ 逻辑一结束（session.end 重拉正文）就弹回展开 ✗。
// 根因（本门把它钉成机械可复现）：折叠态原来只存在 DOM 节点自己的 `dataset.collapsed` 上，
// 而 `renderMessages` 是 `container.replaceChildren(...)` —— session.end / session.snapshot /
// session.compaction_end / 切会话 / 渐进补齐**全走这一条**，每次重画节点都是新的 ⇒ 状态被抹回默认。
// 同一个毛病对「工具输出」同样成立。修法：会话级、按稳定身份（entryId / toolCallId）索引的折叠态
// 容器；渲染时先建节点、再把状态应用回去。
//
// 本门断言（真 Chromium + 假 API，`CHROME_BIN=/usr/bin/chromium`）：
//   ① 思考：收起 → 重画（snapshot / session.end / compaction_end / 切会话）⇒ **仍然收起**；
//   ② 思考：展开 → 重画 ⇒ **仍然展开**；
//   ③ 工具输出：默认折叠的长输出「展开 → 重画 ⇒ 仍然展开」；再收起 → 重画 ⇒ 仍然收起；
//      没有 toolCallId 的卡片靠 part 序数键也成立；
//   ④ 流式 → 正式正文**交接**：直播里点收起 → session.end 换成历史那条 ⇒ 仍然收起；
//   ⑤ 会话隔离：A 的折叠态不串到 B；切走再切回 A ⇒ A 记得自己的状态；
//   ⑥ 压缩边界：entryId 不变的条目保住状态（压缩后条目身份变了 ⇒ 优雅退化回默认，只打印不断言）；
//   ⑦ 容器上界：Node 臂直接锤 `rememberCollapseState`，每会话 ≤ 256 键、最多 24 个会话。
//   ⑧ 原始证据：每一步都打印 `dataset/hidden/aria/按钮文案` 四处读数 + 存前后截图。
//
// 沙箱：高位随机端口 + 临时目录；不碰 7331/7321，不碰真 profile，不 pkill（只杀自己 spawn 的 chromium）。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/web-collapse-state.mjs
//   SOPHO_COLLAPSE_SHOT_DIR=/tmp/collapse-shots node test/web-collapse-state.mjs   # 截图落盘目录

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-collapse-'));
const shotDir = process.env.SOPHO_COLLAPSE_SHOT_DIR || path.join(os.tmpdir(), 'sopho-collapse-shots');
await mkdir(shotDir, { recursive: true });

const SHOT_BEFORE = path.join(shotDir, 'collapse-before-redraw-1200x760.png');
const SHOT_AFTER = path.join(shotDir, 'collapse-after-redraw-1200x760.png');
const SHOT_LIVE = path.join(shotDir, 'collapse-live-handoff-1200x760.png');

const SESSION_A = '1a1a1a1a-1111-4111-8111-111111111111';
const SESSION_B = '2b2b2b2b-2222-4222-8222-222222222222';
const SESSION_C = '3c3c3c3c-3333-4333-8333-333333333333'; // 大会话：走「尾批 + 渐进补旧消息」那条渲染路径
const THINKING = '把这段思考收起来，重画之后不许自己弹开。'.repeat(4);
const LONG_RESULT = Array.from({ length: 30 }, (_, index) => `long tool line ${index + 1}: ${'x'.repeat(20)}`).join('\n');
const LIVE_THINKING = '直播里的思考：点收起之后，正文交接过来也得是收起的。'.repeat(3);
const LIVE_TEXT = '直播的正文，跟在思考后面。';

const rows = [
  { id: SESSION_A, name: '折叠 A', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: SESSION_B, name: '折叠 B', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: SESSION_C, name: '大会话 C', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T06:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];

// 夹具：一条 assistant 正文 = [思考, 带 toolCallId 的长工具输出, 不带 toolCallId 的短工具输出, 正文]。
const messagesA = () => ([
  { entryId: 'a-user-1', role: 'user', text: '问题 A' },
  { entryId: 'a-asst-1', role: 'assistant', parts: [
    { type: 'thinking', text: THINKING },
    { type: 'tool', toolCallId: 'call-long', name: 'long-tool', status: 'done-success', result: LONG_RESULT },
    { type: 'tool', name: 'short-tool', status: 'done-success', result: 'ok' },
    { type: 'text', text: '答案 A' },
  ] },
]);
const messagesB = () => ([
  { entryId: 'b-user-1', role: 'user', text: '问题 B' },
  { entryId: 'b-asst-1', role: 'assistant', parts: [
    { type: 'thinking', text: 'B 的思考。' },
    { type: 'text', text: '答案 B' },
  ] },
]);
// 120 条：尾批只画最近 80 条（下标 40..119），前面的旧消息在空闲期分片 prepend。
const messagesC = () => Array.from({ length: 120 }, (_, index) => (index % 2 === 0
  ? { entryId: `c-${index}`, role: 'user', text: `C 的第 ${index} 条问题：${'撑开高度用。'.repeat(4)}` }
  : { entryId: `c-${index}`, role: 'assistant', parts: [{ type: 'thinking', text: `C 的第 ${index} 条思考。` }, { type: 'text', text: `C 的第 ${index} 条答案。` }] }));

const state = new Map([
  [SESSION_A, { messages: messagesA(), streaming: false, stream: null }],
  [SESSION_B, { messages: messagesB(), streaming: false, stream: null }],
  [SESSION_C, { messages: messagesC(), streaming: false, stream: null }],
]);

let checks = 0;
const failures = [];
// 一条断言失败也不当场中断：把「**所有**会丢状态的重画路径」一次列全（修前一份日志就能看见全貌）。
const check = (name, ok, detail) => {
  if (ok) {
    checks += 1;
    process.stdout.write(`✓ ${name} —— ${detail}\n`);
    return;
  }
  failures.push({ name, detail });
  process.stdout.write(`✗ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

function chunk(text, count) {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
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

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
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
    close() { socket.close(); },
  };
}

const port = await reservePort();
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions: rows, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: rows })}\n\n`);
      return;
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(url.pathname);
    if (match) {
      const row = rows.find((item) => item.id === match[1]);
      const session = state.get(match[1]);
      if (!row || !session) return sendJson(response, 404, { message: 'not found' });
      const action = match[2] ?? null;
      if (action === null) return sendJson(response, 200, { name: row.name, cwd: '/work/collapse', archived: false, runtime: { isStreaming: session.streaming, isCompacting: false, isRetrying: false }, observability: null, context: null });
      if (action === 'messages') return sendJson(response, 200, { sessionId: match[1], messages: session.messages, extras: [], compaction: session.compaction ?? { atIndex: null }, observability: null });
      if (action === 'commands') return sendJson(response, 200, { streaming: session.streaming, commands: [] });
      if (action === 'seen') return sendJson(response, 200, { ok: true });
      if (action === 'draft') return sendJson(response, 200, { text: '' });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: session.streaming, isCompacting: false, isRetrying: false, pendingMessages: 0, queue: { steering: [], followUp: [] } })}\n\n`);
        session.stream = response;
        response.once('close', () => { if (session.stream === response) session.stream = null; });
        return;
      }
    }
    if (url.pathname === '/api/test/event' && request.method === 'POST') {
      const chunks = [];
      for await (const part of request) chunks.push(part);
      const { sessionId, name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const session = state.get(sessionId);
      if (!session?.stream || session.stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
      if (name === 'session.start') session.streaming = true;
      if (name === 'session.end') session.streaming = false;
      session.stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/api/test/stream' && request.method === 'POST') {
      const chunks = [];
      for await (const part of request) chunks.push(part);
      const { sessionId, frames, paceMs } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const session = state.get(sessionId);
      if (!session?.stream || session.stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
      sendJson(response, 200, { ok: true, count: frames.length });
      for (const frame of frames) {
        if (session.stream.destroyed) return;
        session.stream.write(`event: session.delta\ndata: ${JSON.stringify({ channel: frame.channel, delta: frame.delta })}\n\n`);
        if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
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
const chromiumPath = process.env.CHROME_BIN || '/usr/bin/chromium';
const chromium = spawn(chromiumPath, [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank',
], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });

let browser;
const pageProblems = [];
let primaryError;
try {
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

  const evaluate = async (expression) => {
    const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
    return result.result.value;
  };
  const frames = (count = 3) => evaluate(`new Promise((resolve)=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
  const screenshot = async (file) => {
    const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    await writeFile(file, Buffer.from(shot.data, 'base64'));
  };
  // 四处读数（dataset / hidden / aria / 按钮文案）——「状态有没有被记住」就看它是不是四处一致。
  const readState = () => evaluate(`(() => {
    const thinking = Array.from(document.querySelectorAll('#messages .message-thinking')).map((node) => ({
      entryId: node.closest('article')?.dataset.entryId ?? null,
      live: !!node.closest('.live-message'),
      collapsed: node.dataset.collapsed,
      hidden: node.querySelector('.thinking-body').hidden,
      aria: node.querySelector('.thinking-toggle').getAttribute('aria-expanded'),
      label: node.querySelector('.thinking-toggle').textContent,
    }));
    const tools = Array.from(document.querySelectorAll('#messages .tool-card')).map((card) => ({
      entryId: card.closest('article')?.dataset.entryId ?? null,
      name: card.querySelector('.tool-name').textContent,
      collapsed: card.dataset.collapsed,
      hidden: card.querySelector('.tool-output').hidden,
      aria: card.querySelector('.tool-toggle').getAttribute('aria-expanded'),
      label: card.querySelector('.tool-toggle').textContent,
      cardPx: Math.round(card.getBoundingClientRect().height),
      outputPx: Math.round(card.querySelector('.tool-output').getBoundingClientRect().height),
    }));
    const root = document.querySelector('#messages');
    return { thinking, tools, height: root.scrollHeight, top: root.scrollTop, scope: root.dataset.collapseScope };
  })()`);
  const historyThinking = (snapshot) => snapshot.thinking.filter((item) => !item.live);
  const liveThinking = (snapshot) => snapshot.thinking.filter((item) => item.live);
  const emit = async (sessionId, name, data = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, name, data }) });
    if (!response.ok) throw new Error(`emit ${name} failed ${response.status}`);
  };
  const stream = async (sessionId, frameList, paceMs) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/test/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, frames: frameList, paceMs }) });
    if (!response.ok) throw new Error(`stream failed ${response.status}`);
  };
  const open = async (sessionId, expectedEntries) => {
    await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
    await waitFor(() => state.get(sessionId).stream !== null, `session ${sessionId} events stream did not connect`);
    await waitFor(() => evaluate(`document.querySelector('#prompt')?.disabled === false && document.querySelectorAll('#messages article[data-kind="message"]').length >= ${expectedEntries}`), `session ${sessionId} messages did not render`);
    await frames(2);
  };
  const clickThinking = (which = 0) => evaluate(`document.querySelectorAll('#messages .message-thinking .thinking-toggle')[${which}].click()`);
  const clickTool = (which) => evaluate(`document.querySelectorAll('#messages .tool-card .tool-toggle')[${which}].click()`);
  // 每次重画的断言都先把前置状态**摆正**（不看上一条断言的脸色），否则一条失败会污染后面的读数。
  const setThinking = async (wantCollapsed) => {
    const current = historyThinking(await readState())[0];
    if ((current.collapsed === 'true') !== wantCollapsed) { await clickThinking(0); await frames(2); }
  };
  const setTool = async (which, wantCollapsed) => {
    const current = (await readState()).tools[which];
    if ((current.collapsed === 'true') !== wantCollapsed) { await clickTool(which); await frames(2); }
  };
  // 按 entryId 精确找一个正文里的 thinking 块（大会话的渐进路径要按条定位）。
  const messageThinking = (entryId) => evaluate(`(() => {
    const article = document.querySelector('#messages article[data-entry-id="${entryId}"]');
    if (!article || !article.querySelector('.message-thinking')) return null;
    const node = article.querySelector('.message-thinking');
    return { entryId: '${entryId}', collapsed: node.dataset.collapsed, hidden: node.querySelector('.thinking-body').hidden, aria: node.querySelector('.thinking-toggle').getAttribute('aria-expanded') };
  })()`);
  const clickMessageThinking = (entryId) => evaluate(`document.querySelector('#messages article[data-entry-id="${entryId}"] .thinking-toggle').click()`);
  // 按 toolCallId 定位工具卡（直播卡与正式卡同名；`data-tool-call-id` 是渲染时挂的稳定钩子）。
  const toolByCallId = (callId) => evaluate(`(() => {
    const card = document.querySelector('#messages .tool-card[data-tool-call-id="${callId}"]');
    if (!card) return null;
    const toggle = card.querySelector('.tool-toggle');
    return {
      callId: '${callId}',
      live: !!card.closest('.live-message'),
      state: card.dataset.state,
      collapsed: card.dataset.collapsed,
      hidden: card.querySelector('.tool-output').hidden,
      aria: toggle.getAttribute('aria-expanded'),
      label: toggle.textContent,
    };
  })()`);
  const clickToolByCallId = (callId) => evaluate(`document.querySelector('#messages .tool-card[data-tool-call-id="${callId}"] .tool-toggle').click()`);
  // 重画一定要真发生：重画前都往末尾加一条真内容（不依赖任何「同一份不重画」的省流闸）。
  let extra = 0;
  const redraw = async (label) => {
    state.get(SESSION_A).messages = [...state.get(SESSION_A).messages, { entryId: `a-extra-${++extra}`, role: 'user', text: `追加的正文 ${extra}` }];
    await emit(SESSION_A, 'session.snapshot', { isStreaming: false, isCompacting: false, isRetrying: false });
    await waitFor(() => evaluate(`!!document.querySelector('#messages article[data-entry-id="a-extra-${extra}"]')`), `${label} redraw did not land`);
    await frames(2);
  };

  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${SESSION_A}"]')`), 'page did not load');
  await open(SESSION_A, 2);

  // ── 0. 初始默认态 ────────────────────────────────────────────────────────────
  const initial = await readState();
  print('初始态（原始读数）', initial);
  check('初始：思考默认展开（四处一致）', historyThinking(initial)[0].collapsed === 'false' && historyThinking(initial)[0].hidden === false && historyThinking(initial)[0].aria === 'true' && /收起思考/.test(historyThinking(initial)[0].label), JSON.stringify(historyThinking(initial)[0]));
  check('初始：长工具输出默认折叠 / 短工具输出默认展开', initial.tools[0].collapsed === 'true' && initial.tools[0].hidden === true && initial.tools[1].collapsed === 'false' && initial.tools[1].hidden === false, JSON.stringify(initial.tools));

  // 让重画一定发生（不依赖任何「同一份不重画」的省流闸）：每次重画前都往末尾加一条真内容。
  // （`redraw()` 在上面定义。）

  // ── ① 思考：收起 → 重画（snapshot）⇒ 仍然收起 ────────────────────────────
  await setThinking(true);
  const collapsedBeforeSnap = await readState();
  await screenshot(SHOT_BEFORE);
  await redraw('snapshot #1');
  const afterSnap = await readState();
  print('重画前（原始读数）', historyThinking(collapsedBeforeSnap)[0]);
  print('session.snapshot 重画后（原始读数）', historyThinking(afterSnap)[0]);
  check('① 思考：收起 → snapshot 重画 ⇒ 仍然收起（四处一致）', historyThinking(afterSnap)[0].collapsed === 'true' && historyThinking(afterSnap)[0].hidden === true && historyThinking(afterSnap)[0].aria === 'false' && /展开思考/.test(historyThinking(afterSnap)[0].label), JSON.stringify(historyThinking(afterSnap)[0]));

  // ── ② 思考：展开 → 重画 ⇒ 仍然展开（注：展开是默认态，这一条天然弱，修前也可能碰巧通过）───
  await setThinking(false);
  await redraw('snapshot #2');
  const expanded = await readState();
  print('② 展开 → 重画后（原始读数）', historyThinking(expanded)[0]);
  check('② 思考：展开 → 重画 ⇒ 仍然展开（四处一致）', historyThinking(expanded)[0].collapsed === 'false' && historyThinking(expanded)[0].hidden === false && historyThinking(expanded)[0].aria === 'true', JSON.stringify(historyThinking(expanded)[0]));

  // ── ③ 工具输出：展开 → 重画 ⇒ 仍然展开；再收起 → 重画 ⇒ 仍然收起 ────────────
  const heightBeforeTool = (await readState()).tools[0]; // 默认折叠态读数（先读，再看展开后）
  await setTool(0, false); // 长输出：默认折叠 → 展开
  const toolExpanded = await readState();
  await redraw('snapshot #3');
  const toolAfter = await readState();
  print('③ 工具输出：展开 → 重画后（原始读数）', toolAfter.tools);
  check('③ 工具输出：展开 → 重画 ⇒ 仍然展开（四处一致）', toolAfter.tools[0].collapsed === 'false' && toolAfter.tools[0].hidden === false && toolAfter.tools[0].aria === 'true' && /收起输出/.test(toolAfter.tools[0].label), JSON.stringify(toolAfter.tools[0]));
  print('量化：长工具输出 展开 → 重画（修前=被折回，outputPx 归 0、cardPx 缩下去；修后=不变）', {
    默认折叠时: { cardPx: heightBeforeTool.cardPx, outputPx: heightBeforeTool.outputPx },
    展开后: { cardPx: toolExpanded.tools[0].cardPx, outputPx: toolExpanded.tools[0].outputPx },
    重画后: { cardPx: toolAfter.tools[0].cardPx, outputPx: toolAfter.tools[0].outputPx },
    '展开的工具输出高度px': toolExpanded.tools[0].outputPx,
    '重画把工具卡缩回去的px': toolAfter.tools[0].cardPx - toolExpanded.tools[0].cardPx,
    '#messages 总高变化px': toolAfter.height - toolExpanded.height,
    '(其中新追加的那条正文自己占了 px)': await evaluate(`document.querySelector('#messages article[data-entry-id="a-extra-${extra}"]')?.getBoundingClientRect().height ?? -1`),
  });
  await setTool(0, true); // 再收起
  await redraw('snapshot #4');
  const toolRecollapsed = await readState();
  check('③ 工具输出：收起 → 重画 ⇒ 仍然收起（四处一致）', toolRecollapsed.tools[0].collapsed === 'true' && toolRecollapsed.tools[0].hidden === true && toolRecollapsed.tools[0].aria === 'false', JSON.stringify(toolRecollapsed.tools[0]));
  // 没有 toolCallId 的卡片（键回落到 part 序数）：收起 → 重画 ⇒ 仍然收起。
  await setTool(1, true);
  await redraw('snapshot #5');
  const noIdTool = await readState();
  check('③ 无 toolCallId 的短工具输出：收起 → 重画 ⇒ 仍然收起', noIdTool.tools[1].collapsed === 'true' && noIdTool.tools[1].hidden === true, JSON.stringify(noIdTool.tools[1]));

  // ── ⑧ 渐进渲染补进的旧消息：状态也要跟着回来（大会话的「尾批 + prepend」那条路）────
  state.get(SESSION_C).messages = messagesC();
  await open(SESSION_C, 120);
  await waitFor(() => evaluate(`document.querySelector('#messages').dataset.renderComplete === 'true'`), 'C progressive render did not complete', 20_000);
  // 目标：下标 41 的 assistant（尾批 tailStart=40 ⇒ 现在同步画着；再追加几条后它会被挤进 prepend 批次）。
  check('⑧ 大会话 C 的渐进首画完成，目标正文在 DOM 里', (await messageThinking('c-41'))?.collapsed === 'false', JSON.stringify(await messageThinking('c-41')));
  await clickMessageThinking('c-41');
  await frames(2);
  check('⑧ C 里把 c-41 的思考收起', (await messageThinking('c-41'))?.collapsed === 'true', JSON.stringify(await messageThinking('c-41')));
  // 追加 5 条 ⇒ tailStart 40 → 45，c-41 从尾批变成「空闲期补进正文顶部」的那一批。
  state.get(SESSION_C).messages = [...state.get(SESSION_C).messages, ...Array.from({ length: 5 }, (_, index) => ({ entryId: `c-extra-${index}`, role: 'user', text: `C 追加 ${index}` }))];
  await emit(SESSION_C, 'session.snapshot', { isStreaming: false, isCompacting: false, isRetrying: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitFor(() => evaluate(`document.querySelector('#messages').dataset.renderComplete === 'true' && !!document.querySelector('#messages article[data-entry-id="c-41"]')`), 'C progressive prepend did not settle', 20_000);
  await frames(2);
  const progressive = await messageThinking('c-41');
  print('⑧ 渐进 prepend 后（原始读数）', { c41: progressive, renderComplete: await evaluate(`document.querySelector('#messages').dataset.renderComplete`) });
  check('⑧ 从尾批被挤进 prepend 批次的旧消息，折叠态跟着回来', progressive.collapsed === 'true' && progressive.hidden === true && progressive.aria === 'false', JSON.stringify(progressive));
  await open(SESSION_A, 2 + extra);

  // ── ⑤ 会话隔离：A 的折叠态不串 B；切走再切回 A ⇒ A 记得 ─────────────────────
  await setThinking(true); // A 的思考收起（留着切走）
  const aBeforeSwitch = await readState();
  check('切走前 A 的思考是收起的', historyThinking(aBeforeSwitch)[0].collapsed === 'true', JSON.stringify(historyThinking(aBeforeSwitch)[0]));
  await open(SESSION_B, 2);
  const onB = await readState();
  print('切到 B（原始读数）', { scope: onB.scope, thinking: historyThinking(onB) });
  check('⑤ 切到 B：B 的思考是默认展开（不继承 A 的收起）', onB.scope === SESSION_B && historyThinking(onB)[0].collapsed === 'false' && historyThinking(onB)[0].entryId === 'b-asst-1', JSON.stringify(historyThinking(onB)[0]));
  await setThinking(true); // B 也收起
  await open(SESSION_A, 2 + extra);
  const backA = await readState();
  check('⑤ 切回 A：A 记得自己收起过（会话级记住）', historyThinking(backA)[0].entryId === 'a-asst-1' && historyThinking(backA)[0].collapsed === 'true' && historyThinking(backA)[0].hidden === true, JSON.stringify(historyThinking(backA)[0]));
  await open(SESSION_B, 2);
  const backB = await readState();
  check('⑤ 再切回 B：B 也记得自己收起过（两个会话互不串）', historyThinking(backB)[0].collapsed === 'true', JSON.stringify(historyThinking(backB)[0]));
  await open(SESSION_A, 2 + extra);
  await screenshot(SHOT_AFTER);

  // ── ④ 流式 → 正式正文交接：直播里点收起 ⇒ session.end 换成历史那条，仍然收起 ──
  await open(SESSION_A, 2 + extra);
  const messagesBeforeLive = state.get(SESSION_A).messages.length;
  await emit(SESSION_A, 'session.start', { role: 'assistant' });
  await stream(SESSION_A, chunk(LIVE_THINKING, 8).map((delta) => ({ channel: 'thinking', delta })), 4);
  await frames(3);
  const duringLive = await readState();
  check('④ 直播块里出现思考节点', liveThinking(duringLive).length === 1, JSON.stringify(duringLive.thinking));
  await evaluate(`document.querySelector('.live-message .thinking-toggle').click()`);
  await frames(2);
  const liveCollapsed = await readState();
  check('④ 直播里点收起（四处一致）', liveThinking(liveCollapsed)[0].collapsed === 'true' && liveThinking(liveCollapsed)[0].hidden === true && liveThinking(liveCollapsed)[0].aria === 'false', JSON.stringify(liveThinking(liveCollapsed)[0]));
  await screenshot(SHOT_LIVE);
  await stream(SESSION_A, chunk(LIVE_TEXT, 4).map((delta) => ({ channel: 'text', delta })), 4);
  await frames(2);
  // 这一轮落盘：正文带 entryId，parts 与到达顺序同构。
  state.get(SESSION_A).messages = [...state.get(SESSION_A).messages, {
    entryId: 'a-live-turn',
    role: 'assistant',
    parts: [{ type: 'thinking', text: LIVE_THINKING }, { type: 'text', text: LIVE_TEXT }],
  }];
  assert.equal(state.get(SESSION_A).messages.length, messagesBeforeLive + 1);
  await emit(SESSION_A, 'session.end', { stopReason: 'stop', errorMessage: null, text: LIVE_TEXT });
  await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && !!document.querySelector('#messages article[data-entry-id="a-live-turn"] .message-thinking')`), 'live -> history handoff did not converge');
  await frames(2);
  const afterHandoff = await readState();
  const handedOver = historyThinking(afterHandoff).find((item) => item.entryId === 'a-live-turn');
  print('④ 交接后历史那条（原始读数）', handedOver);
  check('④ 流式 → 正式交接：直播里收起的思考，交接过来仍然收起（四处一致）', !!handedOver && handedOver.collapsed === 'true' && handedOver.hidden === true && handedOver.aria === 'false' && /展开思考/.test(handedOver.label), JSON.stringify(handedOver));

  // ── ⑨ 直播工具卡：收起 → tool_end 就地重建 → 流式→正式交接，三段都要保持（这次补的缺口）──
  await open(SESSION_A, 2 + extra);
  await emit(SESSION_A, 'session.start', { role: 'assistant' });
  await emit(SESSION_A, 'session.tool_start', { toolCallId: 'call-live', name: 'bash', args: { command: 'echo hi' } });
  await waitFor(async () => (await toolByCallId('call-live'))?.live === true, 'live tool card did not appear', 10_000);
  await frames(2);
  const liveToolRunning = await toolByCallId('call-live');
  check('⑨ 直播工具卡出现（running、默认展开）', liveToolRunning.state === 'running' && liveToolRunning.live === true && liveToolRunning.collapsed === 'false', JSON.stringify(liveToolRunning));
  await clickToolByCallId('call-live');
  await frames(2);
  const liveToolFolded = await toolByCallId('call-live');
  check('⑨ 直播里把工具输出收起（四处一致）', liveToolFolded.collapsed === 'true' && liveToolFolded.hidden === true && liveToolFolded.aria === 'false' && /展开输出/.test(liveToolFolded.label), JSON.stringify(liveToolFolded));
  // tool_end：短结果 ⇒ 默认又是展开；但用户点过收起 ⇒ 必须保持收起（且 key 变了 ⇒ 节点是原位重建的）。
  await emit(SESSION_A, 'session.tool_end', { toolCallId: 'call-live', name: 'bash', isError: false, result: 'hi' });
  await waitFor(async () => (await toolByCallId('call-live'))?.state === 'done-success', 'live tool card did not flip to done-success', 10_000);
  await frames(2);
  const liveToolDone = await toolByCallId('call-live');
  print('⑨ tool_end 后就地重建的卡（原始读数）', liveToolDone);
  check('⑨ tool_end 让节点原位重建（running→done）后，收起态不丢', liveToolDone.live === true && liveToolDone.state === 'done-success' && liveToolDone.collapsed === 'true' && liveToolDone.hidden === true && liveToolDone.aria === 'false', JSON.stringify(liveToolDone));
  // 流式 → 正式交接：这条 assistant 落盘到历史后，卡换成 toolCallId 相同的那一张。
  state.get(SESSION_A).messages = [...state.get(SESSION_A).messages, {
    entryId: 'a-live-tool-turn',
    role: 'assistant',
    parts: [
      { type: 'tool', toolCallId: 'call-live', name: 'bash', args: { command: 'echo hi' }, status: 'done-success', result: 'hi' },
      { type: 'text', text: '工具跑完了。' },
    ],
  }];
  await emit(SESSION_A, 'session.end', { stopReason: 'stop', errorMessage: null, text: '工具跑完了。' });
  await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && !!document.querySelector('#messages .tool-card[data-part-of="a-live-tool-turn"]')`), 'live tool -> history handoff did not converge', 10_000);
  await frames(2);
  const handedTool = await toolByCallId('call-live');
  print('⑨ 交接后正式卡（原始读数）', handedTool);
  check('⑨ 流式 → 正式交接：直播里收起的工具卡，交接过来仍然收起（四处一致）', !!handedTool && handedTool.live === false && handedTool.collapsed === 'true' && handedTool.hidden === true && handedTool.aria === 'false' && /展开输出/.test(handedTool.label), JSON.stringify(handedTool));
  await open(SESSION_A, 2 + extra);

  // ── ⑩ 跨刷新记住（localStorage，乙）：真 F5 之后仍是收起 ──────────────────────
  await setThinking(true); // A 的思考收起（非默认）
  await new Promise((resolve) => setTimeout(resolve, 400)); // 等 200ms 防抖落盘
  const storedShape = await evaluate(`(() => {
    try {
      const raw = localStorage.getItem('sopho.collapse.v1');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const values = [];
      for (const scope of Object.keys(parsed.scopes || {})) for (const key of Object.keys(parsed.scopes[scope])) values.push(parsed.scopes[scope][key]);
      return { v: parsed.v, scopes: Object.keys(parsed.scopes || {}).length, entries: values.length, onlyBooleans: values.every((value) => value === true || value === false), bytes: raw.length };
    } catch { return 'broken'; }
  })()`);
  print('⑩ localStorage 落盘（原始读数）', storedShape);
  check('⑩ 只存布尔 + 带版本号（v=1）', !!storedShape && storedShape !== 'broken' && storedShape.v === 1 && storedShape.onlyBooleans === true && storedShape.entries > 0, JSON.stringify(storedShape));
  // 真刷新：同一个 user-data-dir，localStorage 留着；应用重新 import render.js 时读回。
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${SESSION_A}"]')`), 'page did not reload', 20_000);
  await evaluate(`document.querySelector('[data-session-id="${SESSION_A}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt')?.disabled === false && !!document.querySelector('#messages article[data-entry-id="a-asst-1"] .message-thinking')`), 'session did not re-render after reload', 20_000);
  await frames(3);
  const afterReload = await readState();
  const reloaded = afterReload.thinking.find((item) => !item.live && item.entryId === 'a-asst-1');
  print('⑩ 刷新后（原始读数）', reloaded);
  check('⑩ 跨刷新：重进会话后思考仍是收起的（四处一致）', !!reloaded && reloaded.collapsed === 'true' && reloaded.hidden === true && reloaded.aria === 'false', JSON.stringify(reloaded));
  // 不可用 / 写失败时静默降级：临时让 Storage.setItem 抛，点两下（展开→收起）——
  // 页面不许崩，折叠照常（写盘那一步走 try/catch，且是在防抖定时器里跑，抛出去就成未捕获异常了）。
  const degradedWrite = await evaluate(`(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new Error('quota exceeded'); };
    const node = document.querySelector('#messages article[data-entry-id="a-asst-1"] .message-thinking');
    const toggle = node.querySelector('.thinking-toggle');
    try {
      toggle.click();
      const expanded = node.dataset.collapsed;
      toggle.click();
      return { expanded, collapsed: node.dataset.collapsed };
    } catch (error) { return { error: String(error && error.message) }; }
    finally { Storage.prototype.setItem = original; }
  })()`);
  await frames(3);
  await new Promise((resolve) => setTimeout(resolve, 300)); // 让被拒的那次落盘真的跑到
  print('⑩ localStorage 写失败时（原始读数）', degradedWrite);
  check('⑩ localStorage 写失败 ⇒ 静默降级（页面不崩、折叠照常）', degradedWrite.expanded === 'false' && degradedWrite.collapsed === 'true', JSON.stringify(degradedWrite));

  // ── ⑥ 压缩边界：entryId 不变的条目保住状态；entryId 变的条目优雅退化回默认 ────
  const beforeCompaction = state.get(SESSION_A).messages.find((item) => item.entryId === 'a-asst-1');
  assert.ok(beforeCompaction);
  check('压缩前 a-asst-1 的思考是收起的', (await readState()).thinking.some((item) => item.entryId === 'a-asst-1' && item.collapsed === 'true'), 'a-asst-1 应处于收起');
  state.get(SESSION_A).messages = [
    { entryId: 'a-asst-1', role: 'assistant', parts: beforeCompaction.parts },
  ];
  state.get(SESSION_A).compaction = { entryId: 'cut-1', atIndex: 0, note: '压缩 1' };
  await emit(SESSION_A, 'session.compaction_end', {});
  await waitFor(() => evaluate(`!!document.querySelector('#messages article[data-entry-id="a-asst-1"] .message-thinking')`), 'compaction redraw did not land');
  await frames(2);
  const afterCompaction = await readState();
  print('⑥ 压缩后（entryId 不变，原始读数）', historyThinking(afterCompaction));
  check('⑥ 压缩边界：entryId 不变的条目保住收起态', historyThinking(afterCompaction)[0].collapsed === 'true' && historyThinking(afterCompaction)[0].hidden === true, JSON.stringify(historyThinking(afterCompaction)[0]));
  // 退化路径：压缩后这条 assistant 换了 entryId ⇒ 旧键落空 ⇒ 回到默认（只打印，不当断言）。
  state.get(SESSION_A).messages = [{ entryId: 'a-asst-2', role: 'assistant', parts: beforeCompaction.parts }];
  await emit(SESSION_A, 'session.compaction_end', {});
  await waitFor(() => evaluate(`!!document.querySelector('#messages article[data-entry-id="a-asst-2"] .message-thinking')`), 'compaction redraw #2 did not land');
  await frames(2);
  const degraded = await readState();
  print('⑥ 压缩后 entryId 变了（优雅退化，不断言）', { entryId: degraded.thinking[0].entryId, collapsed: degraded.thinking[0].collapsed });

  check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));
  print('截图', { 重画前: SHOT_BEFORE, 重画后: SHOT_AFTER, 直播交接: SHOT_LIVE });
  // 上界臂与失败汇总也放进 try：失败要原样抛，清理绝不能替掉它。
  await runStoreArm();
  if (failures.length > 0) {
    print('FAILURES', failures);
    throw new Error(`web collapse state gate failed: ${failures.length} 条 —— ${failures.map((item) => item.name).join(' | ')}`);
  }
} catch (error) {
  primaryError = error;
} finally {
  // 沙箱清理一律走 test/harness.mjs：清理失败绝不替掉真正的失败（裸 `rm` 会被 test:harness 元门抓到）。
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'close browser', async () => { browser?.close(); });
  await cleanupStep(cleanupProblems, 'close session streams', async () => { for (const session of state.values()) session.stream?.destroy(); });
  await cleanupStep(cleanupProblems, 'stop chromium', async () => {
    if (chromium && chromium.exitCode === null) {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    }
  });
  await cleanupStep(cleanupProblems, 'close server', async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}

print('RESULT', `web collapse state PASS（${checks} checks）`);

// ── ⑦ 容器上界（Node 臂，直接锤 store，不起浏览器） ────────────────────────────
async function runStoreArm() {
  const { rememberCollapseState, readCollapseState, collapseStoreStats, collapsePersistedJson } = await import('../web/render.js');
  if (typeof rememberCollapseState !== 'function') {
    check('⑦ render.js 必须导出折叠态容器（rememberCollapseState）', false, '没有这个导出 → 上界臂无从测起');
    return;
  }
  const beforeStats = collapseStoreStats();
  for (let index = 0; index < 5000; index += 1) rememberCollapseState('scope-hot', `key-${index}`, index % 2 === 0);
  const hotStats = collapseStoreStats();
  check('⑦ 单会话 5000 个键 ⇒ 每会话 ≤ 256 键（LRU 淘汰）', hotStats.maxScopeKeys <= hotStats.keyLimit, JSON.stringify(hotStats));
  for (let index = 0; index < 200; index += 1) rememberCollapseState(`scope-${index}`, 'k', true);
  const scopeStats = collapseStoreStats();
  check('⑦ 200 个会话 ⇒ 最多 24 个会话（LRU 淘汰）', scopeStats.scopes <= scopeStats.scopeLimit, JSON.stringify(scopeStats));
  for (let index = 0; index < 5000; index += 1) rememberCollapseState('scope-repeat', 'same-key', index % 2 === 0);
  check('⑦ 同一个键点 5000 次 ⇒ 容器不涨（覆盖，不是追加）', collapseStoreStats().maxScopeKeys <= scopeStats.keyLimit, JSON.stringify(collapseStoreStats()));
  check('⑦ 最近写过的键读得回来 / 淘汰掉的键读不到', readCollapseState('scope-repeat', 'same-key') === false && readCollapseState('scope-hot', 'key-0') === undefined, JSON.stringify({ repeat: readCollapseState('scope-repeat', 'same-key'), evicted: readCollapseState('scope-hot', 'key-0') }));
  // 跨刷新的落盘体积上界：把 24 会话 × 256 键塞满（键长取真 entryId/toolCallId 的量级），
  // 量会写进 localStorage 的那份 JSON；超上限就从最老的会话丢。
  const storageStats = collapseStoreStats();
  for (let scope = 0; scope < 30; scope += 1) for (let key = 0; key < 300; key += 1) rememberCollapseState(`bulk-${scope}`, `e:${'x'.repeat(36)}:c:${'y'.repeat(24)}-${key}`, key % 2 === 0);
  const persistedBytes = collapsePersistedJson().length;
  check('⑦ 跨刷新落盘有字节上界（超了从最老的会话丢）', persistedBytes <= storageStats.storageMaxChars, JSON.stringify({ bytes: persistedBytes, cap: storageStats.storageMaxChars }));
  print('⑦ 落盘体积实测（30 会话 × 300 键塞满容器后）', { storedBytes: persistedBytes, cap: storageStats.storageMaxChars, version: storageStats.storageVersion });
  // 静默降级：Node 里没有 localStorage ⇒ 上面的上万次写入/序列化全走「不可用」分支，一次都没抛。
  check('⑦ localStorage 不可用 ⇒ 静默降级（Node 无 localStorage，写入不抛）', typeof localStorage === 'undefined', JSON.stringify({ nodeLocalStorage: typeof localStorage }));
  print('⑦ 容器上界实测', { start: beforeStats, afterHot: hotStats, afterScopes: scopeStats, final: collapseStoreStats() });
}
