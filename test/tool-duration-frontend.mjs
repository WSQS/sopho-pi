#!/usr/bin/env node
// test/tool-duration-frontend.mjs —— 工具卡耗时的**网页那一半**：跑着的每秒跳、跑完冻结。
//
// 对齐目标（pi 源码，逐字，不自己发明格式）：
//   · `dist/core/tools/renderers/bash.js:23`  `function formatDuration(ms) { return `${(ms/1000).toFixed(1)}s` }`
//   · 同文件 `:93-95` 跑着写 `Elapsed …`、跑完写 `Took …`（muted，落在结果块里）
//   · 同文件 `renderResult`：`options.isPartial` 期间 `setInterval(() => context.invalidate(), 1000)`
//   ⇒ 语义就是「**活的时候每秒跳、结束冻结在最终值**」。
//
// 这一道门量的是**网页真的在跳**（真 Chromium + 假 API），判据（每条都要能复现）：
//   ① 跑着的卡：隔 ~1.2s 采样两次，文字**变了**，且值 ≈ `Date.now() - startedAt`（不是从 0 开始计）；
//   ② 结束的卡：逐字 `用时 4.5s`（夹具给的 4500 ms），再等 1.5s **一个字不变**；
//   ③ `startedAt` 缺失 ⇒ **一个标签都没有**（尤其不许出现 `0.0s`）；只有 `startedAt` 而没有结果的
//      静止卡（未完成/中断）同样不画；
//   ④ 直播路：`session.tool_start` 后那张卡就在跳；`session.tool_end` 后**冻结**成事件给的
//      `endedAt - startedAt`，且页面上再没有一个耗时定时器（`setInterval` 计数归零）；
//   ⑤ 清场：切会话之后旧卡（已离开文档）**不再跳**，页面上的耗时定时器归零；
//   ⑥ `#messages` 的子节点顺序不因它改变（一个节点不增、不重排）。
//
// **反证臂**（修前红）：把「以 `startedAt` 为基准」改成「从 0 开始计」（在**一份 web/ 的临时副本**里改一行）
// ⇒ ① 必红：同一张卡会显示 ≈0.1s，而它其实已经跑了 ≈3s（正是「刷新/重连之后显示错」那个毛病）。
//
// 铁律：只起自己 spawn 的 server 与 Chromium；高位随机端口；不碰真 profile；不用 7331/7321；不 pkill。
//
// 用法：
//   CHROME_BIN='C:/Users/user/AppData/Local/Chromium/Application/chrome.exe' node test/tool-duration-frontend.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

const MAIN_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

// ── 夹具真值：结束的卡是**固定的**两个 timestamp ⇒ 4500 ms ⇒ `4.5s`（逐字对账用）────────────
const DONE_STARTED = '2026-09-01T00:00:10.000Z';
const DONE_ENDED = '2026-09-01T00:00:14.500Z';
const DONE_TEXT = '用时 4.5s';
const FRAC_STARTED = '2026-09-01T00:00:20.000Z';
const FRAC_ENDED = '2026-09-01T00:00:23.400Z'; // 3400 ms ⇒ `3.4s`（钉 toFixed(1) 的逐字格式）
const FRAC_TEXT = '用时 3.4s';
const INSTANT = '2026-09-01T00:00:30.000Z'; // 两端相等 ⇒ 真的 0 ms ⇒ `0.0s`（不是编的填充值）

/** 假 API 用的 messages：一张跑着的卡（基准取「现在 - 3s」）+ 四张结束/静止的卡。 */
function mainMessages(runningStartedAt) {
  return [
    { entryId: 'u1', role: 'user', parts: [{ type: 'text', text: '历史消息：跑几个工具看看。' }] },
    {
      entryId: 'a1',
      role: 'assistant',
      parts: [
        { type: 'tool', toolCallId: 'call-running', name: 'bash', args: { command: 'sleep 30' }, status: 'running', startedAt: runningStartedAt },
        { type: 'tool', toolCallId: 'call-done', name: 'bash', args: { command: 'sleep 4.5' }, status: 'done-success', result: 'done\n', startedAt: DONE_STARTED, endedAt: DONE_ENDED },
        { type: 'tool', toolCallId: 'call-frac', name: 'bash', args: { command: 'sleep 3.4' }, status: 'done-success', result: 'frac\n', startedAt: FRAC_STARTED, endedAt: FRAC_ENDED },
        { type: 'tool', toolCallId: 'call-instant', name: 'read', args: { path: '/tmp/x' }, status: 'done-success', result: 'instant\n', startedAt: INSTANT, endedAt: INSTANT },
        // 没有时间戳（老服务端 / 老文件）⇒ 一个标签都不许有。
        { type: 'tool', toolCallId: 'call-unknown', name: 'bash', args: { command: 'echo ?' }, status: 'done-success', result: '?\n' },
        // 只有 startedAt、没有结果且**不在跑** ⇒ 同样不画（那只能写「到现在为止跑了多久」，是另一种口径）。
        { type: 'tool', toolCallId: 'call-stale', name: 'bash', args: { command: 'sleep 99' }, status: 'unfinished', startedAt: FRAC_STARTED },
      ],
    },
  ];
}

const OTHER_MESSAGES = [
  { entryId: 'u2', role: 'user', parts: [{ type: 'text', text: '另一个会话：没有任何在跑的工具。' }] },
  { entryId: 'a2', role: 'assistant', parts: [{ type: 'text', text: '这里没有工具卡。' }] },
];

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const listener = net.createServer();
      listener.once('error', () => resolve(false));
      listener.listen(candidate, '127.0.0.1', () => listener.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

async function waitFor(operation, message, timeoutMs = 10_000) {
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

/** 页面上装一个 `setInterval` 计数器（**必须在任何页面脚本之前**注入）：本页的耗时定时器只该有 1 个，
 *  归零就是「没有后台一直跳」的直接证据（web/ 里再没有别处用 setInterval —— 只有 setTimeout）。 */
const INTERVAL_COUNTER = `(() => {
  const live = new Set();
  const originalSet = window.setInterval;
  const originalClear = window.clearInterval;
  window.__durationIntervals = live;
  window.setInterval = function (fn, ms, ...rest) { const id = originalSet.call(window, fn, ms, ...rest); live.add(id); return id; };
  window.clearInterval = function (id) { live.delete(id); return originalClear.call(window, id); };
})();`;

/**
 * 一条臂：真 Chromium 打开 `webRoot` 的那份网页，对着假 API 量上面那六条判据。
 * 返回 `{ results, evidence }`；**不抛错**（反证臂就是要看它红在哪），由调用方判定。
 */
async function runFrontendArm({ webRoot, port, runningStartedAt }) {
  const runningStartedMs = Date.parse(runningStartedAt);
  const rows = [
    { id: MAIN_ID, name: '工具耗时', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-21T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
    { id: OTHER_ID, name: '另一个会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-21T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  ];
  const messageSets = { [MAIN_ID]: mainMessages(runningStartedAt), [OTHER_ID]: OTHER_MESSAGES };
  const session = { stream: null, streaming: false };
  const toolFrames = { start: 0, end: 0 };

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
        if (!row) return sendJson(response, 404, { message: 'not found' });
        const action = match[2] ?? null;
        if (action === null) return sendJson(response, 200, { name: row.name, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
        if (action === 'messages') return sendJson(response, 200, { sessionId: match[1], messages: messageSets[match[1]], extras: [], compaction: { atIndex: null }, observability: null });
        if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] });
        if (action === 'seen') return sendJson(response, 200, { ok: true });
        if (action === 'draft') return sendJson(response, 200, { text: '' });
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false, pendingMessages: 0 })}\n\n`);
          session.stream = response;
          response.once('close', () => { if (session.stream === response) session.stream = null; });
          return;
        }
      }
      if (url.pathname === '/api/test/event' && request.method === 'POST') {
        const chunks = [];
        for await (const part of request) chunks.push(part);
        const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!session.stream || session.stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
        if (name === 'session.tool_start') toolFrames.start += 1;
        if (name === 'session.tool_end') toolFrames.end += 1;
        session.stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return sendJson(response, 200, { ok: true });
      }
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.resolve(webRoot, `.${pathname}`);
      if (!file.startsWith(`${path.resolve(webRoot)}${path.sep}`)) return response.writeHead(403).end();
      try {
        const content = await readFile(file);
        response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
        response.end(content);
      } catch { response.writeHead(404).end(); }
    } catch (error) {
      try { response.writeHead(500).end(String(error && error.message)); } catch { /* 已经回了 */ }
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reserveHighPort(new Set([port]));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'sopho-tooldur-chrome-'));
  const chromium = spawn(process.env.CHROME_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { env: browserSandboxEnv(userDataDir), stdio: ['ignore', 'ignore', 'pipe'] });
  let browser;
  const results = [];
  const evidence = { webRoot };
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    print(`${ok ? '✓' : '✗'} ${name}`, detail);
  };
  try {
    const version = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
      return response?.ok ? response.json() : null;
    }, 'Chromium remote debugger did not start');
    evidence.chromium = version.Browser;
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    const pageProblems = [];
    browser = cdp(target.webSocketDebuggerUrl, pageProblems);
    await browser.ready;
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: INTERVAL_COUNTER });
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
    const evaluate = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
      return result.result.value;
    };
    const snapshot = () => evaluate(`(() => {
      const root = document.querySelector('#messages');
      const order = Array.from(root.children).map((node) => node.dataset.entryId || node.className);
      const cardIds = Array.from(root.querySelectorAll('.tool-card')).map((node) => node.dataset.toolCallId || null);
      const labels = {};
      for (const id of ['call-running', 'call-done', 'call-frac', 'call-instant', 'call-unknown', 'call-stale', 'call-live']) {
        const card = root.querySelector('[data-tool-call-id="' + id + '"]');
        const label = card ? card.querySelector('.tool-duration') : null;
        labels[id] = {
          hasCard: card !== null,
          state: card ? card.dataset.state : null,
          hasLabel: label !== null,
          text: label ? label.textContent : null,
          inHeader: card ? [...card.querySelectorAll('.tool-call > *')].some((node) => node.classList.contains('tool-duration')) : false,
        };
      }
      return {
        now: Date.now(),
        intervals: window.__durationIntervals ? window.__durationIntervals.size : null,
        order,
        cardIds,
        labels,
        liveBlocks: root.querySelectorAll('.live-message').length,
        durationLabels: root.querySelectorAll('.tool-duration').length,
      };
    })()`);
    const emit = async (name, data = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, data }) });
      if (!response.ok) throw new Error(`emit ${name} failed ${response.status}`);
    };
    /** 把标签文本里的数字取出来（`已跑 3.4s` / `用时 4.5s` 都取 3.4 / 4.5；取不到 ⇒ null）。 */
    const secondsOf = (text) => {
      const match = typeof text === 'string' ? text.match(/-?\d+\.\d+s$/) : null;
      return match ? Number.parseFloat(match[0]) : null;
    };

    await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor(() => evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${MAIN_ID}"]')`), 'page did not load');
    const beforeOpen = await snapshot();
    check('基线：打开任何会话之前，页面上一个耗时定时器都没有', beforeOpen.intervals === 0, `setInterval 存活数=${beforeOpen.intervals}`);

    await evaluate(`document.querySelector('[data-session-id="${MAIN_ID}"] .tree-select').click()`);
    await waitFor(() => session.stream !== null, 'session events stream did not connect');
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .tool-card').length === ${mainMessages(runningStartedAt)[1].parts.length}`), 'tool cards did not render');
    const first = await snapshot();
    print('第一帧读数', first.labels);
    evidence.firstFrame = first.labels;

    // ── ① 跑着的卡：值 ≈ now - startedAt，且隔 1.2s 会变 ────────────────────────
    const running1 = first.labels['call-running'];
    const expected1 = (first.now - runningStartedMs) / 1000;
    const shown1 = secondsOf(running1.text);
    check('① 跑着的卡有标签，且值 ≈ Date.now() - startedAt（不是从 0 开始计）',
      running1.hasCard && running1.hasLabel && shown1 !== null && Math.abs(shown1 - expected1) <= 0.35,
      `显示 ${JSON.stringify(running1.text)}（解析出 ${shown1}）vs 应约 ${expected1.toFixed(1)}（容差 0.35）`);
    check('① 跑着的卡：整页只有 1 个耗时定时器在跳', first.intervals === 1, `setInterval 存活数=${first.intervals}`);
    await sleep(1200);
    const second = await snapshot();
    const running2 = second.labels['call-running'];
    const expected2 = (second.now - runningStartedMs) / 1000;
    const shown2 = secondsOf(running2.text);
    check('① 隔 1.2s 再采：文字变了，且仍然 ≈ now - startedAt',
      running2.text !== running1.text && shown2 !== null && Math.abs(shown2 - expected2) <= 0.35,
      `${JSON.stringify(running1.text)} → ${JSON.stringify(running2.text)}（应约 ${expected2.toFixed(1)}）`);

    // ── ② 结束的卡：逐字 + 再等 1.5s 不变 ──────────────────────────────────────
    check('② 结束的卡：逐字 `用时 4.5s`（夹具 4500 ms）', second.labels['call-done'].text === DONE_TEXT, `实测 ${JSON.stringify(second.labels['call-done'].text)}，真值 ${JSON.stringify(DONE_TEXT)}`);
    check('② toFixed(1) 的逐字格式：3400 ms ⇒ `用时 3.4s`', second.labels['call-frac'].text === FRAC_TEXT, `实测 ${JSON.stringify(second.labels['call-frac'].text)}，真值 ${JSON.stringify(FRAC_TEXT)}`);
    check('② 两端相等的真值 ⇒ `用时 0.0s`（是量出来的，不是填的）', second.labels['call-instant'].text === '用时 0.0s', `实测 ${JSON.stringify(second.labels['call-instant'].text)}`);
    check('② 标签落在**标题行**（`.tool-call > .tool-duration`）', second.labels['call-done'].inHeader === true, JSON.stringify(second.labels['call-done']));
    await sleep(1500);
    const third = await snapshot();
    check('② 再等 1.5s：结束的卡一个字不变（冻结，不许继续跳）',
      third.labels['call-done'].text === DONE_TEXT && third.labels['call-frac'].text === FRAC_TEXT && third.labels['call-instant'].text === '用时 0.0s',
      JSON.stringify({ done: third.labels['call-done'].text, frac: third.labels['call-frac'].text, instant: third.labels['call-instant'].text }));

    // ── ③ 没有 startedAt / 只有 startedAt 的静止卡：一个标签都不画 ──────────────
    check('③ 缺 startedAt 的卡：**没有**标签（更不许出现 0.0s）',
      third.labels['call-unknown'].hasCard && third.labels['call-unknown'].hasLabel === false && third.labels['call-unknown'].text === null,
      JSON.stringify(third.labels['call-unknown']));
    check('③ 只有 startedAt、没有结果且不在跑的卡：同样不画（那会随停留时间变大）',
      third.labels['call-stale'].hasCard && third.labels['call-stale'].hasLabel === false,
      JSON.stringify(third.labels['call-stale']));
    check('③ 全页只长了 4 个耗时标签（跑着 1 + 结束 3）：两张没时间戳的卡一个都没长',
      third.durationLabels === 4,
      `实测 .tool-duration 元素数=${third.durationLabels}，应为 4`);

    // ── ⑥ 顺序：一个节点不增、不重排 ────────────────────────────────────────────
    check('⑥ `#messages` 子节点顺序与卡片顺序在跳动前后一字不差',
      JSON.stringify(first.order) === JSON.stringify(third.order) && JSON.stringify(first.cardIds) === JSON.stringify(third.cardIds),
      JSON.stringify({ order: third.order, cardIds: third.cardIds }));

    // ── ⑤ 清场：切会话之后旧卡不再跳、定时器归零 ────────────────────────────────
    // 让 MAIN 上那张跑着的卡先把标签攥在手里（它一直在跳），然后切到一个**没有工具卡**的会话。
    const staleLabelHandle = await evaluate(`(() => {
      const card = document.querySelector('[data-tool-call-id="call-running"]');
      window.__staleLabel = card ? card.querySelector('.tool-duration') : null;
      return window.__staleLabel ? window.__staleLabel.textContent : null;
    })()`);
    const beforeSwitch = await snapshot();
    check('⑤ 切走之前：MAIN 上那张卡还在跳（基线）', beforeSwitch.intervals === 1 && staleLabelHandle !== null, JSON.stringify({ intervals: beforeSwitch.intervals, text: staleLabelHandle }));
    await evaluate(`document.querySelector('[data-session-id="${OTHER_ID}"] .tree-select').click()`);
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .tool-card').length === 0`), 'other session did not render', 10_000);
    // 旧卡此刻已离开文档；定时器最迟在下一次 tick（250ms）把它剔掉。
    await waitFor(async () => (await snapshot()).intervals === 0, 'duration interval did not stop after the switch', 4000);
    const afterSwitch = await snapshot();
    const stale1 = await evaluate(`window.__staleLabel ? window.__staleLabel.textContent : null`);
    await sleep(1300);
    const stale2 = await evaluate(`window.__staleLabel ? window.__staleLabel.textContent : null`);
    check('⑤ 切会话后：旧的耗时定时器归零（`setInterval` 存活数 = 0）', afterSwitch.intervals === 0, `setInterval 存活数=${afterSwitch.intervals}`);
    check('⑤ 切会话后：那张已经离开文档的旧卡不再被改写（文本冻结）', stale1 === stale2 && stale1 !== null, `${JSON.stringify(stale1)} → ${JSON.stringify(stale2)}`);
    check('⑤ 切会话后：新会话里没有耗时标签（它本来就没有工具卡）', Object.values(afterSwitch.labels).every((label) => label.hasCard === false), JSON.stringify(afterSwitch.labels));

    // ── ④ 直播路：tool_start 就开始跳，tool_end 冻结且定时器归零 ────────────────
    // 在**没有历史工具卡**的 OTHER 上做：页面上那个唯一的耗时定时器就只能是这张直播卡的。
    const liveStartedMs = Date.now() - 2000;
    const liveStartedAt = new Date(liveStartedMs).toISOString();
    const liveEndedAt = new Date(liveStartedMs + 2000).toISOString(); // 恰好 2000 ms ⇒ `用时 2.0s`
    await emit('session.start', { role: 'assistant' });
    await emit('session.tool_start', { toolCallId: 'call-live', name: 'bash', args: { command: 'sleep 2' }, startedAt: liveStartedAt });
    await waitFor(async () => (await snapshot()).labels['call-live'].hasCard, 'live tool card did not appear', 8000);
    const liveRunning = await snapshot();
    const liveShown = secondsOf(liveRunning.labels['call-live'].text);
    check('④ 直播卡（历史里还没有结果）：tool_start 后就在跳，值 ≈ now - startedAt',
      liveRunning.labels['call-live'].state === 'running' && liveRunning.labels['call-live'].hasLabel
      && liveShown !== null && Math.abs(liveShown - (liveRunning.now - liveStartedMs) / 1000) <= 0.35,
      JSON.stringify({ state: liveRunning.labels['call-live'].state, text: liveRunning.labels['call-live'].text, 解析出: liveShown, intervals: liveRunning.intervals }));
    check('④ 直播期间：页面上恰好 1 个耗时定时器（这张卡自己那个）', liveRunning.intervals === 1, `setInterval 存活数=${liveRunning.intervals}`);
    await sleep(1200);
    const liveTicking = await snapshot();
    check('④ 直播卡隔 1.2s 文字确实变了',
      liveTicking.labels['call-live'].text !== liveRunning.labels['call-live'].text,
      `${JSON.stringify(liveRunning.labels['call-live'].text)} → ${JSON.stringify(liveTicking.labels['call-live'].text)}`);
    await emit('session.tool_end', { toolCallId: 'call-live', name: 'bash', isError: false, result: 'ok\n', endedAt: liveEndedAt });
    await waitFor(async () => (await snapshot()).labels['call-live'].state === 'done-success', 'live card did not flip to done-success', 8000);
    const liveDone = await snapshot();
    check('④ tool_end 后冻结成 `用时 2.0s`（事件给的 endedAt - startedAt，逐字）',
      liveDone.labels['call-live'].text === '用时 2.0s',
      `实测 ${JSON.stringify(liveDone.labels['call-live'].text)}，真值 ${JSON.stringify('用时 2.0s')}`);
    // 冻结那一帧旧节点就被换掉了，但它要等**下一次 tick**才从册里出局（≤ 250ms）——所以这里给一个
    // 有上界的等，并把「冻到归零花了多久」原样记下来（不是「等一会儿大概就停了」）。
    const stopped = await waitFor(async () => {
      const snap = await snapshot();
      return snap.intervals === 0 ? snap : null;
    }, 'live card freeze did not stop the duration interval', 3000).catch((error) => ({ error: error.message }));
    check('④ 冻结后（最迟一次 tick）就把这个卡上的定时器停了（页面上耗时定时器归零）',
      stopped.error === undefined && stopped.intervals === 0,
      stopped.error ?? `冻结时的读数 ${liveDone.now} → 归零时的读数 ${stopped.now}（相差 ${stopped.now - liveDone.now}ms）；setInterval 存活数=${stopped.intervals}`);
    await sleep(1500);
    const liveFrozen = await snapshot();
    check('④ 再等 1.5s：直播那张卡也一个字不变，定时器一直是 0',
      liveFrozen.labels['call-live'].text === '用时 2.0s' && liveFrozen.intervals === 0,
      JSON.stringify({ text: liveFrozen.labels['call-live'].text, intervals: liveFrozen.intervals }));

    check('整页没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));
    evidence.toolFrames = toolFrames;
    evidence.finalIntervals = afterSwitch.intervals;
    evidence.pageProblems = pageProblems.length;
    return { results, evidence };
  } finally {
    browser?.close();
    session.stream?.destroy();
    if (chromium && chromium.exitCode === null) {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(webRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ── web/ 的临时副本：反证臂只改**一行**（把基准从服务端的 `startedAt` 换成登记那一刻的本地时钟）──
const REVERT_OLD = 'const entry = { node, prefix, startedAtMs };';
const REVERT_NEW = 'const entry = { node, prefix, startedAtMs: Date.now() };';

async function createWebCopy({ revert }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sopho-tooldur-web-'));
  const webRoot = path.join(dir, 'web');
  await cp(path.join(root, 'web'), webRoot, { recursive: true });
  if (revert) {
    const file = path.join(webRoot, 'render.js');
    const source = await readFile(file, 'utf8');
    assert.ok(source.includes(REVERT_OLD), '反证臂的补丁锚点不在了 —— 这条臂什么都没改（必须红）');
    const patched = source.replace(REVERT_OLD, REVERT_NEW);
    assert.ok(patched !== source && patched.includes(REVERT_NEW));
    await writeFile(file, patched);
  }
  return webRoot;
}

const used = new Set();
const afterPort = await reserveHighPort(used); used.add(afterPort);
const beforePort = await reserveHighPort(used); used.add(beforePort);
const RUNNING_STARTED_AT = new Date(Date.now() - 3000).toISOString();
print('夹具：跑着的那张卡以「服务端给的 startedAt = 现在 - 3s」为基准', RUNNING_STARTED_AT);
print('夹具：结束的卡', { call_done: `${DONE_STARTED} → ${DONE_ENDED}`, 期望: DONE_TEXT, call_frac: FRAC_TEXT });

let primaryError = null;
try {
  // ── 修后臂：本仓现在这版 web/ ────────────────────────────────────────────────
  const afterWeb = await createWebCopy({ revert: false });
  print('修后臂 · web/ 的字节副本（真门里也走副本，好让两条臂的起法一模一样）', afterWeb);
  const after = await runFrontendArm({ webRoot: afterWeb, port: afterPort, runningStartedAt: RUNNING_STARTED_AT });
  const afterFailures = after.results.filter((item) => !item.ok);
  assert.deepEqual(afterFailures.map((item) => `${item.name} —— ${item.detail}`), [], '修后臂应当全绿');
  print('修后臂结论', { checks: after.results.length, failures: 0, chromium: after.evidence.chromium, SSE: after.evidence.toolFrames });

  // ── 反证臂：基准改成「从 0 开始计」（临时副本里改一行）⇒ ① 必红 ──────────────
  const beforeWeb = await createWebCopy({ revert: true });
  print('反证臂 · 改的是这一行', `${REVERT_OLD}  →  ${REVERT_NEW}`);
  const before = await runFrontendArm({ webRoot: beforeWeb, port: beforePort, runningStartedAt: RUNNING_STARTED_AT });
  const beforeFailures = before.results.filter((item) => !item.ok);
  const runningFailure = beforeFailures.find((item) => item.name.startsWith('①'));
  assert.ok(runningFailure, '反证臂（从 0 开始计）竟然没让 ① 红 —— 这条臂没有证明任何东西（必须红）');
  print('反证臂 · 修复前红（原始结论）', beforeFailures);
  print('反证臂结论', { checks: before.results.length, failures: beforeFailures.length, 红的是哪些: beforeFailures.map((item) => item.name) });

  print('RESULT', `tool duration frontend PASS（修后 ${after.results.length} 项全绿；反证臂 ${beforeFailures.length} 项红，其中 ① 直接量出「从 0 开始计」）`);
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError) {
    process.stderr.write(`${primaryError.stack ?? primaryError.message}\n`);
    process.exitCode = 1;
  }
}
