#!/usr/bin/env node
// test/stream-jump-cost.mjs —— 「会话界面流式跳变」的**真机量化台**（真 Chromium + 假 API）。
//
// 要回答的不是「卡不卡」（那是 test/stream-frame-cost.mjs 的问题），而是**视口/几何在什么时候跳了多少 px**：
//   · 流式中（直播块纯文本，一个文本节点）
//   · 结束瞬间（`session.end` ⇒ refreshMessages ⇒ 正式节点替换直播块）
//   · 结束后（渐进补历史 / 树刷新 / 用量行）
//
// 做法：`Page.addScriptToEvaluateOnNewDocument` 注入只读观测器，逐帧记录
//   #messages 的 scrollHeight/scrollTop/clientHeight、可见首/末消息的 getBoundingClientRect().top、
//   正文节点数（message/thinking/tool/markdown/live）、header/composer/usage/queue 高度、
//   树的两条滚动轴与首行位置；再用浏览器原生 `PerformanceObserver('layout-shift')` 收 CLS。
// 事件时刻：包一层 `EventSource.prototype.addEventListener`，记下每条 SSE 事件到达的 performance.now()，
// 于是每个 Δ 都能写成「<事件名> 之后 N ms / M 帧」。fetch('/api/.../messages'、'/api/tree') 也记下到点。
//
// 三个场景：
//   A 结束瞬间的整块替换：同一段流分别收在三种最终 payload（text-only / +thinking / +thinking+tool），
//     差值就是「工具卡一次性长出来」的贡献。⚠️ thinking 自甲落地起**边流边显**，所以 A2 的
//     「结束跳变」不再含思考块的一次性长高（A1 也不再喂 thinking 通道，否则基线会被污染）。
//   B 渐进补历史：大会话 + 不贴底，流式中触发 snapshot 重拉，量准备补屏时视口跳不跳。
//   C 侧栏重建：流式中 tree.session 风暴 + 每次 /tree 让选中会话换位置，量活跃树滚动轴与首行位置。
//
// 只用高位随机端口 + 临时 ASSIST_HOME/浏览器 profile；不碰真实 profile、7331/7321；不 pkill（只杀自己 spawn 的 chromium）。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/stream-jump-cost.mjs
//   SOPHO_STREAMJUMP_VARIANT=… node test/stream-jump-cost.mjs   # 对照/实验：只替换伺服出去的 web/app.js 文本
//     · old-compensation   把 refreshMessages 的不贴底补偿回放成修复前那一行（并去掉 index.html 的 overflow-anchor:none）
//     · live-thinking-iso  把**直播块的思考**也过 markdown（补上 renderMarkdown 的 `<p>`）⇒ 与结束后的正式
//                          思考块**真正同构**；用来量「同构之后，结束那一刻还剩多少 Δpx」
//   ⚠️ 甲（3d6bc0e：思考边流边显）落地后，旧的 `live-thinking` / `live-thinking+md` 两个变体**已被取代**
//      （它们的锚点在新代码里不存在了）⇒ 显式报错，不再静默走错路。
//
// checks 计数：`checks: N` 数的是**断言总数**（红绿都算），恒等于本变体实际跑的断言条数（base 变体 14 条）。
//
// ── 夹具依据：为什么 assistant 的 parts 里**工具 part 恒在末尾**（2026-09-22 起） ──────────────
// 本门的夹具曾经是 `[thinking, tool, text]`（工具 part 夹在中间）。业主 2026-09-22 的 `3d242e9`
// （工具调用与 bash 执行平铺成独立块）把工具块从 assistant 块里提成**顶层** `section.tool-card` 之后，
// 那个形状让夹具多切出一篇正文（3 个顶层块），Δ(+工具)-Δ(+思考) 从 40px 涨到 108px ⇒ 稳定越过 100px 阈值。
// 但那个夹具形状**在真会话里根本不存在**。只读普查（2026-09-22，本机）：
//
//   $ python3 - <<'PY'      # 只读：只 open+json.loads，从不写
//   import json, glob, collections
//   n = last = 0; shapes = collections.Counter()
//   for f in glob.glob('/home/<你>/.pi/profiles/assistant/sessions/*.jsonl'):
//       for line in open(f):
//           r = json.loads(line)
//           if r.get('type') != 'message' or (r.get('message') or {}).get('role') != 'assistant': continue
//           content = (r['message'] or {}).get('content')
//           if not isinstance(content, list): continue
//           t = ['tool' if p.get('type') in ('toolCall', 'tool') else p.get('type') for p in content]
//           if 'tool' not in t: continue
//           n += 1; shapes[tuple(t)] += 1
//           if t[-1] != 'tool': last += 1
//   print(n, last, shapes.most_common(4))
//   PY
//   24606 0 [('thinking','tool',13304), ('tool',4446), ('thinking','text','tool',2945), ('thinking','tool','tool',2635)]
//         ↑ 带工具块的 assistant 消息数 / 其中「工具 part 不是最后一块」的条数
//   （2026-09-22 的快照。这个 profile 是活的：总条数会随新会话长 —— 复跑常看到 24625/0 这类数字，
//     左列会涨、右列恒为 0。）
//
// ⇒ 「工具 part 后面还有正文」= 0 条；A3 要模拟的真形状就是 `('thinking','text','tool')`（2945 条）。
// 于是把夹具改成真形状（工具 part 在末尾），阈值 `toolAddsMaxPx: 100` **一个字没动**。
//
// 关于「工具卡那一跳为什么是几十 px 而不是几百 px」：当前主干长工具输出**默认折叠**
// （web/render.js 的 TOOL_OUTPUT_COLLAPSE_LINES=12 / TOOL_OUTPUT_COLLAPSE_CHARS=800），
// 所以结束那一刻工具卡只多一个卡头（+ 平铺之后它自己的一整套块底盘）。
//   · 2026-09-22 之前（工具块嵌在 assistant 块里）：Δ(+工具)-Δ(+思考)=40px；
//   · `3d242e9` 平铺之后（同一夹具、改成真形状）：**59px**（实测，见下）；
//   · 同一张卡**展开**画出来时：必然越过阈值（本门新增的负控臂 A5 量的就是这一条）。
//     A3 自己那张卡的展开代价也已经在门里量着：场景 F 的「展开时输出高」= 252px（每次跑都 252px）
//     ⇒ 若长输出不再默认折叠，A3 那一跳会变成 59 + 252 ≈ 311px > 100px ⇒ 必红。
// 40/59px 都是折叠所致，**不是**产品缺陷，也不是不贴底补偿(bd3b4f8) / I-05 占位回显造成的
// （事后逐一去掉仍恒为同值）。历史归因见 /tmp/jump-gate-align-report.md。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-streamjump-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-streamjump');
const reportFile = path.join(artifactRoot, 'stream-jump.json');

const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const TREE_FILLER_ID = '99999999-9999-4999-8999-999999999999';
const VARIANT = process.env.SOPHO_STREAMJUMP_VARIANT || 'base';

// ── 内容 ─────────────────────────────────────────────────────────────────────
const THINKING = [
  '先把问题拆开看：跳变只可能来自三个方向。',
  '第一，直播块与正式节点不是同一种东西 —— 直播块是纯文本，正式节点跑 markdown 并带思考块与工具卡。',
  '第二，结束那一刻才把思考与工具补进来，等于消息区高度一次性增加。',
  '第三，树是事件驱动重建，用量行与输入区也会在结束瞬间改高度。',
  '逐条量：ΔscrollHeight、可见首条消息的 top、CLS 的 sources。',
].join('\n').repeat(3);
const TEXT_MD = [
  '## 结束瞬间',
  '',
  '正文这一段故意带 markdown，好让「纯文本 → markdown」的几何差看得见：',
  '',
  '- 列表项一：' + '列表项的正文要够长，好让行数与换行真的改变高度。'.repeat(3),
  '- 列表项二：' + '第二条同样要长。'.repeat(3),
  '',
  '```js',
  "const jump = messagesNode.scrollHeight - previousHeight;",
  'console.log(jump);',
  '```',
  '',
  '最后一段：' + '收尾的正文。'.repeat(24),
].join('\n');
const TOOL_RESULT = Array.from({ length: 14 }, (_, i) => `tool-output-line-${i + 1}: ${'x'.repeat(60)}`).join('\n');
// 负控臂 A5 的夹具：一张**被画成展开**的长工具块（30 行 `write`）。为什么是它：`write` 的逐行 diff
// 按 `TOOL_DIFF_OPEN_LINES`（40 行）**故意**保持展开（web/render.js —— TUI 里 edit/write 的 diff
// 就是摊开看的），所以这一臂是「长工具块真被一次性画出来」的真实现场，而不是改产品改出来的。
// 它与 A3 用同一把尺子、同一条路（同一个 `session.end` 跳变），只有一处不同：工具块展开 vs 折叠。
const WRITE_OPEN_LINES = 30;
const WRITE_CONTENT = Array.from({ length: WRITE_OPEN_LINES }, (_, i) => `export const line${String(i + 1).padStart(2, '0')} = '${'y'.repeat(56)}';`).join('\n');
const WRITE_TOOL_PART = {
  type: 'tool',
  toolCallId: 'call-write-open',
  name: 'write',
  args: { path: 'tmp/open-sample.mjs', content: WRITE_CONTENT },
  status: 'done-success',
  result: `已写入 ${WRITE_OPEN_LINES} 行`,
};

const historyFiller = (index) => `历史消息 ${index + 1}：${'用来把滚动区域撑到真实大会话量级的中文正文。'.repeat(6)}`;
const SMALL_HISTORY = Array.from({ length: 40 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: historyFiller(index) }],
}));
const BIG_HISTORY = Array.from({ length: 260 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: historyFiller(index) }],
}));

// ⚠️ parts 的顺序 = **真机形状**：工具 part 永远在**末尾**（普查 24606 条带工具块的 assistant 消息里
// 「工具 part 不是最后一块」= 0 条，见文件头「夹具依据」）。别把工具 part 挪回中间：那会让
// `assistantBlocks()` 多切出一篇正文（`3d242e9` 之后每个顶层块都自带 padding/边框/角标/margin）,
// 量出来的就不是真机上结束那一刻的样子。
function assistantMessage({ thinking = false, tool = false, text = TEXT_MD, toolPart = null } = {}) {
  const parts = [];
  if (thinking) parts.push({ type: 'thinking', text: THINKING });
  parts.push({ type: 'text', text });
  if (tool) parts.push(toolPart ?? { type: 'tool', name: 'bash', args: { command: 'npm run test:streamjump' }, status: 'done-success', result: TOOL_RESULT });
  return { role: 'assistant', entryId: `synthetic-${parts.length}-${parts.map((p) => p.type).join('+')}`, timestamp: new Date().toISOString(), parts };
}

const OBSERVABILITY = {
  lastTurn: { model: { display: 'fake-model-v2.2-quantified' }, usage: { status: 'known', input: 123456, output: 7890 } },
  cumulative: { usage: { status: 'known', input: 987654321, output: 12345678 }, cost: { total: 12.3456 } },
};
const CONTEXT = { freeTokens: 700, compactionEnabled: true };

const treeSessions = () => {
  const rows = [
    { id: SESSION_ID, name: '流式跳变量化', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, lastActivity: '2026-09-20T08:00:00.000Z', modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  ];
  for (let index = 0; index < 60; index += 1) {
    rows.push({
      id: `${String(index).padStart(8, '0')}-1111-4111-8111-${String(index).padStart(12, '0')}`,
      name: `侧栏第 ${index + 1} 条${'（名字长一点，好让行宽足）'.repeat(2)}`,
      parentId: index % 7 === 3 ? TREE_FILLER_ID : null,
      archived: false,
      status: 'idle',
      statusLabel: '闲置',
      unread: false,
      // 位置由这个时间决定：场景 C 每次 /tree 都把它往前挪，逼 renderTree 重建后行序变化。
      lastActivity: `2026-09-19T${String(23 - (index % 24)).padStart(2, '0')}:00:00.000Z`,
      modifiedAt: '2026-09-19T12:00:00.000Z',
      notify: { notifies: [], waitingFor: [] },
    });
  }
  return rows;
};
let treeActivityBump = 0;

// ── 假 API 状态 ──────────────────────────────────────────────────────────────
let currentMessages = SMALL_HISTORY;
let currentObservability = null;
let currentContext = null;
let sessionStreaming = false;
let sessionStream;
let treeStream;
let treePayload = treeSessions();
let messageReads = 0;
let treeReads = 0;
let seenPosts = 0;
let server;
let chromium;
let browser;
let port;

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

/** 等 `#messages` 的 scrollHeight 连续 3 帧不变再采样：content-visibility / 字体 / 折叠卡的布局
 *  比一次刷新晚一两帧才稳定，不等就可能量到中间的半成品高度（实测 A3 会在 40 和 297 之间抖）。 */
async function settle() {
  await evaluate(`new Promise((resolve)=>{const n=document.querySelector('#messages');let last=-1,stable=0,left=90;const step=()=>{const h=n.scrollHeight;if(h===last)stable+=1;else stable=0;last=h;left-=1;if(stable>=3||left<=0)resolve(h);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
}

async function emit(name, data = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });
  if (!response.ok) throw new Error(`emit ${name} failed: ${response.status}`);
}

async function streamDeltaChunks(chunks, paceMs, channel = 'text') {
  const response = await fetch(`http://127.0.0.1:${port}/api/test/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chunks, paceMs, channel }),
  });
  if (!response.ok) throw new Error(`stream failed: ${response.status}`);
}

function chunk(text, size) {
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
}

// ── 页内只读观测器（在新文档里、app.js 之前跑） ───────────────────────────────
const INSTRUMENT = `(() => {
  const J = window.__jump = { events: [], fetches: [], shifts: [], frames: [], scrollWrites: [], sampling: false, pageErrors: [] };
  const now = () => Math.round(performance.now() * 100) / 100;
  const rect = (r) => r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  const pathOf = (node) => {
    if (!node) return null;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return null;
    const bits = [];
    for (let cur = node; cur && cur.nodeType === 1 && bits.length < 4; cur = cur.parentElement) {
      let bit = cur.tagName.toLowerCase();
      if (cur.id) bit += '#' + cur.id;
      else if (typeof cur.className === 'string' && cur.className) bit += '.' + cur.className.trim().split(/\\s+/).slice(0, 2).join('.');
      bits.unshift(bit);
    }
    return bits.join('>');
  };
  // ① 浏览器原生 CLS
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        J.shifts.push({
          t: now(), value: Math.round(entry.value * 10000) / 10000, hadRecentInput: entry.hadRecentInput,
          startTime: Math.round(entry.startTime * 100) / 100,
          sources: (entry.sources || []).map((s) => ({ node: pathOf(s.node), previousRect: rect(s.previousRect), currentRect: rect(s.currentRect) })),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (error) { J.layoutShiftError = String(error); }
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes && !PerformanceObserver.supportedEntryTypes.includes('layout-shift')) J.layoutShiftUnsupported = true;

  // ②b #messages 的每一次 scrollTop 写：谁写的（调用栈）、从多少写到多少。这是「谁把视口挪了」的直接证据。
  const stDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true, enumerable: stDesc.enumerable,
    get: stDesc.get,
    set(value) {
      if (this.id === 'messages' && J.scrollWrites.length < 400) {
        const from = stDesc.get.call(this);
        const stack = (new Error().stack || '').split(String.fromCharCode(10)).slice(1, 5).map((line) => line.trim().replace(/^at +/, '')).join(' ⇐ ');
        J.scrollWrites.push({ t: now(), from: Math.round(from * 100) / 100, to: Math.round(Number(value) * 100) / 100, stack });
      }
      return stDesc.set.call(this, value);
    },
  });

  // ② SSE 事件到达时刻（只读：包一层 addEventListener）
  const addEventListener = EventSource.prototype.addEventListener;
  EventSource.prototype.addEventListener = function (type, listener, options) {
    const wrapped = typeof listener === 'function' ? function (...args) {
      if (type === 'session.end' || type === 'session.start' || type === 'session.snapshot' || type === 'tree.session' || type === 'tree.snapshot') {
        J.events.push({ t: now(), type });
      }
      return listener.apply(this, args);
    } : listener;
    return addEventListener.call(this, type, wrapped, options);
  };
  // ③ fetch 到点时刻（/messages 与 /tree 是重绘的触发点）
  const fetchOriginal = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
    const at = now();
    const promise = fetchOriginal.apply(this, args);
    if (typeof url === 'string' && (url.includes('/messages') || url === '/api/tree')) {
      promise.then(() => J.fetches.push({ t: now(), start: at, url })).catch(() => {});
    }
    return promise;
  };
  // ④ 逐帧几何采样
  const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);
  const sample = () => {
    const messages = document.querySelector('#messages');
    const pane = document.querySelector('.messages-pane');
    const header = document.querySelector('main > header');
    const composer = document.querySelector('#composer');
    const usage = document.querySelector('#session-usage');
    const notice = document.querySelector('#notice');
    const queue = document.querySelector('#queue-status');
    const activeList = document.querySelector('[data-active-tree-list="true"]');
    const tree = document.querySelector('#tree');
    if (!messages || !pane) return null;
    const paneRect = pane.getBoundingClientRect();
    let first = null;
    let last = null;
    let visibleCount = 0;
    let messageIndex = 0;
    for (const node of messages.querySelectorAll('.message')) {
      const r = node.getBoundingClientRect();
      const identity = { index: messageIndex, entryId: node.dataset.entryId ?? null, text: (node.textContent || '').slice(0, 16) };
      messageIndex += 1;
      if (r.bottom <= paneRect.top || r.top >= paneRect.bottom) continue;
      visibleCount += 1;
      const top = Math.round(r.top * 100) / 100;
      const bottom = Math.round(r.bottom * 100) / 100;
      if (first === null) first = { top, bottom, role: node.dataset.role || node.className, kind: node.dataset.kind || 'message', ...identity };
      last = { top, bottom, role: node.dataset.role || node.className, kind: node.dataset.kind || 'message', ...identity };
    }
    // 侧栏锚：固定视口高度处那一条是谁。renderTree 会整栏重建；「轴不动但内容换了」也要看得见。
    let treeAnchor = null;
    let treeTopRow = null;
    if (activeList) {
      const listRect = activeList.getBoundingClientRect();
      const probeY = listRect.top + Math.min(120, Math.max(10, listRect.height * 0.3));
      let index = 0;
      for (const row of activeList.querySelectorAll('.tree-session')) {
        const r = row.getBoundingClientRect();
        if (index === 0) treeTopRow = { id: row.dataset.sessionId, top: Math.round(r.top * 100) / 100 };
        if (!treeAnchor && r.top <= probeY && r.bottom > probeY) treeAnchor = { id: row.dataset.sessionId, top: Math.round(r.top * 100) / 100, index };
        index += 1;
      }
    }
    return {
      t: now(),
      scrollHeight: num(messages.scrollHeight), scrollTop: num(messages.scrollTop), clientHeight: num(messages.clientHeight),
      paneTop: num(paneRect.top), paneHeight: num(pane.clientHeight),
      headerHeight: num(header?.getBoundingClientRect().height), composerHeight: num(composer?.getBoundingClientRect().height),
      usageHeight: num(usage?.getBoundingClientRect().height), queueHeight: num(queue && !queue.hidden ? queue.getBoundingClientRect().height : 0),
      noticeHeight: num(notice?.getBoundingClientRect().height),
      messages: messages.querySelectorAll('.message').length,
      thinking: messages.querySelectorAll('.message-thinking').length,
      tools: messages.querySelectorAll('.tool-card').length,
      // 折叠/展开的**事实**：卡头高度 + 结果区 scrollHeight（折叠时 tool-output[hidden] ⇒ 0）。
      toolCardHeight: (() => { const node = messages.querySelector('.tool-card'); return node ? num(node.getBoundingClientRect().height) : null; })(),
      toolResultScrollHeight: (() => { const node = messages.querySelector('.tool-card .tool-result'); return node ? Math.round(node.scrollHeight) : null; })(),
      markdown: messages.querySelectorAll('.markdown').length,
      live: messages.querySelectorAll('.live-message').length,
      liveText: (messages.querySelector('.live-message .message-body')?.textContent || '').length,
      liveThinking: (messages.querySelector('.live-message .message-thinking')?.textContent || '').length,
      renderComplete: messages.dataset.renderComplete === 'true',
      virtual: messages.dataset.virtual === 'true',
      first, last, visibleCount,
      treeRows: tree?.querySelectorAll('.tree-session').length ?? 0,
      treeScrollTop: activeList ? num(activeList.scrollTop) : null,
      treeFirstRowTop: activeList?.firstElementChild ? num(activeList.firstElementChild.getBoundingClientRect().top) : null,
      treeScrollHeight: activeList ? num(activeList.scrollHeight) : null,
      treeAnchorId: treeAnchor?.id ?? null,
      treeAnchorTop: treeAnchor?.top ?? null,
      treeAnchorIndex: treeAnchor?.index ?? null,
      treeTopRowId: treeTopRow?.id ?? null,
    };
  };
  J.sampleOnce = sample;
  J.start = () => {
    J.frames = [];
    J.sampling = true;
    const step = () => {
      if (!J.sampling) return;
      const value = sample();
      if (value) J.frames.push(value);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  J.stop = () => { J.sampling = false; };
  J.collect = () => ({
    frames: J.frames,
    events: J.events,
    fetches: J.fetches,
    shifts: J.shifts,
    scrollWrites: J.scrollWrites,
    layoutShiftError: J.layoutShiftError ?? null,
    layoutShiftUnsupported: J.layoutShiftUnsupported === true,
  });
  J.reset = () => { J.frames = []; J.events = []; J.fetches = []; J.shifts = []; J.scrollWrites = []; };
})();`;

// ── 实验变体：把 thinking 通道接进直播块（临时、只在本测试里替换 app.js 文本） ──
// ⚠️ 甲已落地：`base` 变体本身就是「思考边流边显」，`live-thinking` 变体因此已被吸收；
//    其锚点指向旧代码，若仍被显式调用会明确报「找不到锚点」。
function transformAppJs(source, variant) {
  if (variant === 'base') return { code: source, applied: [] };
  const edits = [];
  const apply = (from, to, label) => {
    if (!source.includes(from)) throw new Error(`variant ${variant}: 找不到锚点（${label}）`);
    source = source.replace(from, to);
    edits.push(label);
  };
  // `renderMarkdown` 现在 app.js 可能**已经**自己 import 了（I-05 的占位用它做预览）——
  // 再前缀一次会得到重复绑定 ⇒ SyntaxError ⇒ 整页不渲染（实测踩过：症状是 "session row did not render"）。
  const ensureMarkdownImportNeeded = () => {
    if (/import\s*\{[^}]*\brenderMarkdown\b/.test(source)) return;
    apply('import { renderCommandPalette,', 'import { renderMarkdown, renderCommandPalette,', 'import-markdown');
  };
  // ⚠️ 甲（3d6bc0e）落地前，这两个变体是「把被丢掉的 thinking 通道临时接进直播块」的替身；
  //    落地后它们的锚点（`if (data.channel !== 'text') return`、`liveRenderedText`…）在新代码里不存在了。
  //    显式报错而不是让 apply() 抛出「找不到锚点」，免得误以为只是锚点漂了。
  if (variant === 'live-thinking' || variant === 'live-thinking+md') {
    throw new Error(`变体 ${variant} 已被甲（3d6bc0e：思考边流边显、与结束同构）取代，不再有意义 —— 用 base 或 live-thinking-iso。`);
  }
  // 对照：把不贴底补偿回放成修复前那一行（bd3b4f8 之前），用来同机同时刻比「修复前/后」。
  if (variant === 'old-compensation') {
    apply(
      "    const removedAbove = Math.max(0, previousHeight - messagesNode.scrollHeight);\n    messagesNode.scrollTop = Math.max(0, previousTop - removedAbove);",
      "    messagesNode.scrollTop = previousTop + Math.max(0, messagesNode.scrollHeight - previousHeight);",
      'restore-old-formula',
    );
  }
  // 甲的方向是「与结束同构」。当前实现把直播思考的正文放成**裸文本节点**（web/app.js 的 livePartNode），
  // 而结束后的正式思考块走 `renderMarkdown` ⇒ `.message-body p` 只对正式那块生效（pre-wrap + 段落边距）。
  // 这个变体把直播思考的正文也包进 `div.markdown > p`，量「真正同构之后」结束那一刻还剩多少。
  if (variant === 'live-thinking-iso') {
    ensureMarkdownImportNeeded();
    apply(
      "    const content = document.createElement('div');\n    content.className = 'thinking-body';\n    const textNode = document.createTextNode('');\n    content.append(textNode);",
      "    const content = document.createElement('div');\n    content.className = 'thinking-body';\n    const md = document.createElement('div');\n    md.className = 'markdown';\n    const mdP = document.createElement('p');\n    const textNode = document.createTextNode('');\n    mdP.append(textNode);\n    md.append(mdP);\n    content.append(md);",
      'thinking-body-through-markdown',
    );
  }
  if (!edits.length) throw new Error(`未知变体：${variant}`);
  return { code: source, applied: edits };
}

// ── 分析：把逐帧数字变成「跳变 + 归因」 ─────────────────────────────────────
const TRACKED = ['scrollHeight', 'scrollTop', 'paneTop', 'paneHeight', 'headerHeight', 'usageHeight', 'composerHeight', 'noticeHeight', 'messages', 'thinking', 'tools', 'markdown', 'live', 'treeRows', 'treeScrollTop', 'treeFirstRowTop', 'treeAnchorTop', 'treeAnchorIndex'];

function analyse(frames, events, fetches, { jumpThreshold = 8 } = {}) {
  const byKey = {};
  for (const key of TRACKED) byKey[key] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const prev = frames[index - 1];
    const cur = frames[index];
    for (const key of TRACKED) {
      if (typeof prev[key] !== 'number' || typeof cur[key] !== 'number') continue;
      const delta = Math.round((cur[key] - prev[key]) * 100) / 100;
      if (delta === 0) continue;
      const lastEvent = [...events].reverse().find((event) => event.t <= cur.t) || null;
      const lastFetch = [...fetches].reverse().find((entry) => entry.t <= cur.t) || null;
      byKey[key].push({
        frame: index,
        t: cur.t,
        delta,
        afterEvent: lastEvent ? `${lastEvent.type}@+${Math.round((cur.t - lastEvent.t) * 100) / 100}ms` : null,
        afterFetch: lastFetch && cur.t - lastFetch.t < 250 ? `${lastFetch.url.replace(/^\/api/, '')}@+${Math.round((cur.t - lastFetch.t) * 100) / 100}ms` : null,
      });
    }
  }
  const jumps = [];
  for (const key of TRACKED) {
    for (const entry of byKey[key]) if (Math.abs(entry.delta) >= jumpThreshold) jumps.push({ key, ...entry });
  }
  jumps.sort((a, b) => a.t - b.t);
  return { deltas: byKey, jumps };
}

function visibleAnchorJumps(frames, threshold = 8) {
  const out = [];
  for (let index = 1; index < frames.length; index += 1) {
    const prev = frames[index - 1];
    const cur = frames[index];
    if (prev.first && cur.first) {
      const delta = Math.round((cur.first.top - prev.first.top) * 100) / 100;
      if (Math.abs(delta) >= threshold) out.push({ frame: index, t: cur.t, delta, kind: 'firstVisibleMessageTop', from: prev.first, to: cur.first });
    }
    if (prev.last && cur.last) {
      const delta = Math.round((cur.last.top - prev.last.top) * 100) / 100;
      if (Math.abs(delta) >= threshold) out.push({ frame: index, t: cur.t, delta, kind: 'lastVisibleMessageTop', from: prev.last, to: cur.last });
    }
  }
  return out;
}

function clsReport(shifts) {
  const counted = shifts.filter((shift) => !shift.hadRecentInput);
  return {
    entries: shifts,
    countedEntries: counted.length,
    cls: Math.round(counted.reduce((sum, shift) => sum + shift.value, 0) * 10000) / 10000,
    allValue: Math.round(shifts.reduce((sum, shift) => sum + shift.value, 0) * 10000) / 10000,
    sources: counted.flatMap((shift) => (shift.sources || []).map((source) => ({ value: shift.value, node: source.node, previousRect: source.previousRect, currentRect: source.currentRect }))),
  };
}

function summariseFrames(frames) {
  const heightDeltas = frames.slice(1).map((frame, index) => Math.round((frame.scrollHeight - frames[index].scrollHeight) * 100) / 100);
  return {
    frames: frames.length,
    durationMs: frames.length > 1 ? Math.round((frames[frames.length - 1].t - frames[0].t) * 100) / 100 : 0,
    'scrollHeight 增速 p50/p95/max': (() => {
      const positives = heightDeltas.filter((delta) => delta > 0).sort((a, b) => a - b);
      if (!positives.length) return null;
      const at = (q) => positives[Math.min(positives.length - 1, Math.floor(q * positives.length))];
      return [at(0.5), at(0.95), positives[positives.length - 1]];
    })(),
  };
}

// ── 起服 ─────────────────────────────────────────────────────────────────────
await mkdir(artifactRoot, { recursive: true });
port = await reservePort();
let primaryError;
try {
  let appJs = (await readFile(path.join(webRoot, 'app.js'), 'utf8'));
  const transformed = transformAppJs(appJs, VARIANT);
  const appJsServed = transformed.code;
  let appJsText = await readFile(path.join(webRoot, 'app.js'), 'utf8');

  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
      if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
      if (url.pathname === '/api/tree') {
        treeReads += 1;
        return sendJson(response, 200, { sessions: treePayload, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
      }
      if (url.pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: treePayload })}\n\n`);
        treeStream = response;
        return;
      }
      if (url.pathname === '/api/test/tree-bump' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
        treeActivityBump += 1;
        if (body.reorder) {
          // 让一条 filler 会话变成「最近活动」⇒ 它排到最前，整条列表往下错一行（scrollTop 不变）。
          const index = 1 + (treeActivityBump % (treePayload.length - 1));
          treePayload[index] = { ...treePayload[index], lastActivity: `2026-09-20T09:00:${String(treeActivityBump % 60).padStart(2, '0')}.000Z` };
        } else {
          treePayload[0] = { ...treePayload[0], status: treeActivityBump % 2 ? 'working' : 'idle', statusLabel: treeActivityBump % 2 ? '工作中' : '闲置' };
        }
        if (treeStream && !treeStream.destroyed) treeStream.write(`event: tree.session\ndata: ${JSON.stringify({ sessionId: SESSION_ID })}\n\n`);
        return sendJson(response, 200, { ok: true, bump: treeActivityBump, reorder: body.reorder === true });
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(url.pathname);
      if (sessionMatch) {
        const id = sessionMatch[1];
        const action = sessionMatch[2] ?? null;
        if (id !== SESSION_ID && !treePayload.some((row) => row.id === id)) return sendJson(response, 404, { message: 'not found' });
        if (action === null) {
          const row = treePayload.find((item) => item.id === id) || {};
          return sendJson(response, 200, {
            id, name: row.name ?? null, archived: false, readOnly: false,
            runtime: { isStreaming: id === SESSION_ID && sessionStreaming, isCompacting: false, isRetrying: false },
            observability: currentObservability, context: currentContext,
          });
        }
        if (action === 'messages') {
          messageReads += 1;
          return sendJson(response, 200, { messages: currentMessages, extras: [], compaction: { atIndex: null }, observability: currentObservability, context: currentContext });
        }
        if (action === 'commands') return sendJson(response, 200, { streaming: id === SESSION_ID && sessionStreaming, commands: [] });
        if (action === 'seen') { seenPosts += 1; return sendJson(response, 200, { ok: true }); }
        if (action === 'draft') return sendJson(response, 200, { text: '' });
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: id === SESSION_ID && sessionStreaming, isCompacting: false, isRetrying: false, pendingMessages: 0, queue: { steering: [], followUp: [] } })}\n\n`);
          if (id === SESSION_ID) sessionStream = response;
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
        const { chunks: deltas, paceMs: pace, channel = 'text' } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!sessionStream || sessionStream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
        sendJson(response, 200, { ok: true, count: deltas.length });
        for (const delta of deltas) {
          if (sessionStream.destroyed) return;
          sessionStream.write(`event: session.delta\ndata: ${JSON.stringify({ channel, delta })}\n\n`);
          if (pace > 0) await new Promise((resolve) => setTimeout(resolve, pace));
        }
        return;
      }
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.resolve(webRoot, `.${pathname}`);
      if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
      try {
        let content = file.endsWith(`${path.sep}app.js`) ? appJsServed : await readFile(file);
        if (VARIANT === 'old-compensation' && file.endsWith(`${path.sep}index.html`)) {
          // 对照实验要回放修复前的 CSS（bd3b4f8 那一笔同时加了 overflow-anchor:none）。
          content = String(content).replace('overflow-anchor: none;', '');
        }
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
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('#messages') && window.__jump`), 'instrument or page did not load');
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"]') !== null`), 'session row did not render');

  const openSession = async (history, { observability = null, context = null } = {}) => {
    currentObservability = observability;
    currentContext = context;
    currentMessages = history;
    await evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"] .tree-select').click()`);
    await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false && document.querySelector('#messages').dataset.renderComplete === 'true'`), 'session did not open');
    await frames(3);
  };

  const reset = async () => {
    await evaluate(`window.__jump.reset()`);
    await evaluate(`window.__jump.start()`);
  };
  const collect = async () => evaluate(`(() => { window.__jump.stop(); return window.__jump.collect(); })()`);

  const results = { variant: VARIANT, variantEdits: transformed.applied, scenarios: {} };

  const scenarioState = (state) => ({
    scrollHeight: state.scrollHeight, scrollTop: state.scrollTop, clientHeight: state.clientHeight,
    paneTop: state.paneTop, paneHeight: state.paneHeight, headerHeight: state.headerHeight,
    usageHeight: state.usageHeight, noticeHeight: state.noticeHeight,
    messages: state.messages, thinking: state.thinking, tools: state.tools, markdown: state.markdown, live: state.live,
    renderComplete: state.renderComplete, first: state.first, last: state.last,
  });

  const endDeltaOf = (before, after) => ({
    scrollHeight: Math.round((after.scrollHeight - before.scrollHeight) * 100) / 100,
    scrollTop: Math.round((after.scrollTop - before.scrollTop) * 100) / 100,
    paneTop: Math.round((after.paneTop - before.paneTop) * 100) / 100,
    paneHeight: Math.round((after.paneHeight - before.paneHeight) * 100) / 100,
    headerHeight: Math.round((after.headerHeight - before.headerHeight) * 100) / 100,
    usageHeight: Math.round((after.usageHeight - before.usageHeight) * 100) / 100,
    noticeHeight: Math.round((after.noticeHeight - before.noticeHeight) * 100) / 100,
    firstVisibleMessageTop: before.first && after.first ? Math.round((after.first.top - before.first.top) * 100) / 100 : null,
    lastVisibleMessageTop: before.last && after.last ? Math.round((after.last.top - before.last.top) * 100) / 100 : null,
    domNodes: after.messages - before.messages,
    thinkingNodes: after.thinking - before.thinking,
    toolNodes: after.tools - before.tools,
    markdownNodes: after.markdown - before.markdown,
    liveNodes: after.live - before.live,
  });

  // 一条完整的时间线：打开 → （可选）滚离底部 → 流式（thinking 通道 + text）→ 结束 → 结束后若干帧。
  const runEndScenario = async (name, { note, history, message, follow, scrollRatio = 0.35, settleFrames = 6, observability = OBSERVABILITY, context = CONTEXT, afterOpen = null, streamThinking = true }) => {
    await openSession(history, { observability, context });
    if (afterOpen) await evaluate(afterOpen);
    if (follow) await evaluate(`document.querySelector('#messages').scrollTop = document.querySelector('#messages').scrollHeight`);
    else await evaluate(`(() => { const n=document.querySelector('#messages'); n.scrollTop = Math.round((n.scrollHeight - n.clientHeight) * ${scrollRatio}); n.dispatchEvent(new Event('scroll')); })()`);
    await frames(3);
    await reset();
    await emit('session.start');
    // 流式：先 thinking（服务端真的会发这个通道），再 text。
    // 甲落地后前端**会**把 thinking 画进直播块 —— 所以「结束 payload 不带思考」的基线（A1）
    // 不再喂 thinking 通道（否则结束那一刻消失的是直播块里多出来的思考，把 A1 的基线污染成负数）。
    if (streamThinking) await streamDeltaChunks(chunk(THINKING, 24), 1, 'thinking');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await streamDeltaChunks(chunk(TEXT_MD, 12), 1);
    // 不能用 length 判：live-md 变体下直播块是 markdown（syntax 字符不进 textContent）。
    await waitFor(() => evaluate(`(() => { const b=document.querySelector('#messages .live-message .message-body'); return !!b && b.textContent.includes('收尾的正文。'); })()`), `${name}: live text did not reach full length`);
    await frames(4);
    const before = await evaluate(`window.__jump.sampleOnce()`);
    currentMessages = [...history, message];
    // 用量行在开屏时就是最终形态（Δheader=0），所以这里的 Δ 全是消息区；用量行单独的 Δ 在场景 D 里量。
    const readsBefore = messageReads;
    await emit('session.end', { stopReason: 'stop', errorMessage: null, text: TEXT_MD });
    await waitFor(() => evaluate(`document.querySelector('#messages .live-message') === null && ${readsBefore} < ${messageReads}`), `${name}: end refresh did not settle`, 12000);
    await frames(settleFrames);
    const after = await evaluate(`window.__jump.sampleOnce()`);
    const collected = await collect();
    results.scenarios[name] = {
      note,
      follow,
      before: scenarioState(before),
      after: scenarioState(after),
      endDelta: endDeltaOf(before, after),
      frameSummary: summariseFrames(collected.frames),
      jumps: analyse(collected.frames, collected.events, collected.fetches).jumps,
      visibleAnchorJumps: visibleAnchorJumps(collected.frames),
      cls: clsReport(collected.shifts),
      events: collected.events.map((event) => ({ t: event.t, type: event.type })),
      scrollWrites: collected.scrollWrites.slice(-60),
      frames: collected.frames,
    };
    sessionStreaming = false;
    await evaluate(`window.__jump.stop()`);
  };

  // ── 场景 A：结束瞬间的整块替换（贴底；用量行保持不变，把「消息区」的 Δ 单独量出来） ──
  const payloadModes = [
    { name: 'A1 结束·仅正文(贴底)', message: assistantMessage({ text: TEXT_MD }), streamThinking: false, note: '结束 payload 只有正文（无思考、无工具卡）；用量行在开屏时就已是最长形态，所以 Δ 全是消息区的' },
    { name: 'A2 结束·正文+思考(贴底)', message: assistantMessage({ thinking: true, text: TEXT_MD }), note: '结束 payload 正文 + 思考块' },
    { name: 'A3 结束·正文+思考+工具(贴底)', message: assistantMessage({ thinking: true, tool: true, text: TEXT_MD }), note: '结束 payload 正文 + 思考块 + 工具卡；parts 顺序 = [thinking, text, tool]，工具 part 在末尾 = 真数据形状（24606 条带工具块的 assistant 消息里「工具 part 不在末尾」= 0 条）' },
    // 负控（自检）：同一把尺子、同一条路，但工具块这次是**展开**画出来的 ⇒ 它必须越过阈值。
    // 这一臂保证「折叠一失效 ⇒ 这道门必红」，也就是保证 `toolAddsMaxPx` 不是一句空话。
    { name: 'A5 结束·正文+思考+工具(长输出展开态·负控)', message: assistantMessage({ thinking: true, tool: true, text: TEXT_MD, toolPart: WRITE_TOOL_PART }), note: `负控：同一个结束跳变测点，但工具块是${WRITE_OPEN_LINES} 行 write diff（产品按 TOOL_DIFF_OPEN_LINES=40 行**默认展开**画出来）⇒ 按同一阈值判，这一臂必红` },
  ];
  for (const mode of payloadModes) {
    await runEndScenario(mode.name, { note: mode.note, history: SMALL_HISTORY, message: mode.message, follow: true, streamThinking: mode.streamThinking !== false });
  }

  if (VARIANT === 'base') {
    // ── 场景 A4：不贴底 + 小会话（refreshMessages 的「不贴底」补偿分支） ──
    await runEndScenario('A4 结束·不贴底·40条', { note: '用户读完历史在中间时收到 session.end；走 refreshMessages 的不贴底补偿分支', history: SMALL_HISTORY, message: assistantMessage({ thinking: true, tool: true }), follow: false, scrollRatio: 0.35 });
    await runEndScenario('A4b 结束·不贴底·40条(overflow-anchor:none)', { note: 'A4 的同一时间线，但 #messages 关掉原生 scroll anchoring（对照：看小会话的不贴底补偿会变好还是变坏）', history: SMALL_HISTORY, message: assistantMessage({ thinking: true, tool: true }), follow: false, scrollRatio: 0.35, afterOpen: "document.querySelector('#messages').style.overflowAnchor = 'none'; true" });

    // ── 场景 B：渐进补历史（260 条；结束时才重拉） ──
    await runEndScenario('B1 结束·不贴底·260条(渐进)', { note: '260 条历史 + 不贴底；session.end 触发 refreshMessages(progressive) ⇒ 先只画最近 80 条，旧消息随后一次 prepend', history: BIG_HISTORY, message: assistantMessage({ thinking: true, tool: true }), follow: false, scrollRatio: 0.25, settleFrames: 80 });

    // ── 场景 B3：同一场景，但把 #messages 的原生 scroll anchoring 关掉（对照实验） ──
    await runEndScenario('B3 结束·不贴底·260条(overflow-anchor:none)', {
      note: 'B1 的同一时间线；openSession 之后把 #messages.style.overflowAnchor 设成 none ⇒ 浏览器不再在 prepend 时自己改 scrollTop',
      history: BIG_HISTORY, message: assistantMessage({ thinking: true, tool: true }), follow: false, scrollRatio: 0.25, settleFrames: 80,
      afterOpen: "document.querySelector('#messages').style.overflowAnchor = 'none'; true",
    });

    // ── 场景 B2：流式中重拉（snapshot hello / 重连） ──
    await openSession(BIG_HISTORY);
    const initial = await evaluate(`window.__jump.sampleOnce()`);
    await evaluate(`(() => { const n=document.querySelector('#messages'); n.scrollTop = Math.round((n.scrollHeight - n.clientHeight) * 0.25); n.dispatchEvent(new Event('scroll')); })()`);
    await frames(3);
    await reset();
    await emit('session.start');
    await streamDeltaChunks(chunk(TEXT_MD, 12), 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const beforeB2 = await evaluate(`window.__jump.sampleOnce()`);
    currentMessages = [...BIG_HISTORY, assistantMessage({ thinking: true, tool: true })];
    currentObservability = OBSERVABILITY;
    currentContext = CONTEXT;
    await emit('session.snapshot', { isStreaming: true, isCompacting: false, isRetrying: false });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const afterB2 = await evaluate(`window.__jump.sampleOnce()`);
    const collectedB2 = await collect();
    results.scenarios['B2 流式中重拉·不贴底·260条'] = {
      note: 'session.snapshot（hello/重连）触发同一个 refreshMessages(progressive)；与 B1 同一段代码',
      openState: { virtual: initial.virtual, renderComplete: initial.renderComplete, messages: initial.messages },
      before: scenarioState(beforeB2),
      after: scenarioState(afterB2),
      endDelta: endDeltaOf(beforeB2, afterB2),
      jumps: analyse(collectedB2.frames, collectedB2.events, collectedB2.fetches).jumps,
      visibleAnchorJumps: visibleAnchorJumps(collectedB2.frames),
      cls: clsReport(collectedB2.shifts),
      scrollWrites: collectedB2.scrollWrites.slice(-60),
      frames: collectedB2.frames,
    };
    sessionStreaming = false;

    // ── 场景 D：只有用量行变化（不改任何消息） ──
    await openSession(SMALL_HISTORY, { observability: null });
    await frames(3);
    await reset();
    const beforeD = await evaluate(`window.__jump.sampleOnce()`);
    currentObservability = OBSERVABILITY;
    currentContext = CONTEXT;
    await emit('session.snapshot', { isStreaming: false, isCompacting: false, isRetrying: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterD = await evaluate(`window.__jump.sampleOnce()`);
    const collectedD = await collect();
    results.scenarios['D 用量行变化(消息不变)'] = {
      note: '/messages 里 observability 由「服务端未提供」变成完整一行；正文一条不改',
      before: scenarioState(beforeD),
      after: scenarioState(afterD),
      endDelta: endDeltaOf(beforeD, afterD),
      jumps: analyse(collectedD.frames, collectedD.events, collectedD.fetches).jumps,
      cls: clsReport(collectedD.shifts),
      frames: collectedD.frames,
    };

    // ── 场景 F：用户展开了工具输出，刷新后又被折叠回去（同一块内容被重画） ──
    // 长工具输出**默认折叠**（web/render.js 的 TOOL_OUTPUT_COLLAPSE_LINES/CHARS）；用户手动展开后，
    // 任何一次 /messages 重画都会重建工具卡、startCollapsed 重新算 ⇒ 展开的那一块又不见了。
    // 2026-09-18：这条**已经翻面**——折叠容器（web/render.js 的会话级容器）+ localStorage 让展开态跨重画保持，
    // 下面那条 check 现在断言的是**新事实**（刷新后仍展开、Δ≈0），不再断言旧的折回。
    const fMessage = assistantMessage({ tool: true });
    await openSession([...SMALL_HISTORY, fMessage]);
    await frames(2);
    await settle();
    const collapsedF = await evaluate(`window.__jump.sampleOnce()`);
    await evaluate(`document.querySelector('#messages .tool-toggle').click()`);
    await frames(2);
    await settle();
    const expandedF = await evaluate(`window.__jump.sampleOnce()`);
    await reset();
    currentMessages = [...SMALL_HISTORY, fMessage];
    currentObservability = OBSERVABILITY;
    currentContext = CONTEXT;
    await emit('session.snapshot', { isStreaming: false, isCompacting: false, isRetrying: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    const afterF = await evaluate(`window.__jump.sampleOnce()`);
    const collectedF = await collect();
    results.scenarios['F 展开的工具输出在刷新后被折回'] = {
      note: '长工具输出默认折叠；用户展开后触发一次重画（这里用 session.snapshot 模拟刷新）⇒ 由于折叠态已搬进会话级容器（+ localStorage），展开态保持、Δ≈0',
      collapsed: { scrollHeight: collapsedF.scrollHeight, toolCardHeight: collapsedF.toolCardHeight, toolResultScrollHeight: collapsedF.toolResultScrollHeight },
      expanded: { scrollHeight: expandedF.scrollHeight, toolCardHeight: expandedF.toolCardHeight, toolResultScrollHeight: expandedF.toolResultScrollHeight },
      afterRefresh: { scrollHeight: afterF.scrollHeight, toolCardHeight: afterF.toolCardHeight, toolResultScrollHeight: afterF.toolResultScrollHeight },
      endDelta: endDeltaOf(expandedF, afterF),
      jumps: analyse(collectedF.frames, collectedF.events, collectedF.fetches).jumps,
      cls: clsReport(collectedF.shifts),
      frames: collectedF.frames,
    };

    // ── 场景 C：侧栏（会话树）事件驱动重建 —— 行序不变 ──
    await openSession(SMALL_HISTORY);
    await evaluate(`(() => { const list=document.querySelector('[data-active-tree-list="true"]'); list.scrollTop = Math.round((list.scrollHeight - list.clientHeight) * 0.6); list.dispatchEvent(new Event('scroll')); })()`);
    await frames(3);
    await reset();
    const beforeC = await evaluate(`window.__jump.sampleOnce()`);
    const treeReadsBefore = treeReads;
    for (let index = 0; index < 6; index += 1) {
      await fetch(`http://127.0.0.1:${port}/api/test/tree-bump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reorder: false }) });
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    await frames(4);
    const afterC = await evaluate(`window.__jump.sampleOnce()`);
    const collectedC = await collect();
    results.scenarios['C1 侧栏重建·行序不变'] = {
      note: '流式中 6 次 tree.session ⇒ 每次 refreshTree + renderTree 整栏 replaceChildren；行集合与顺序不变',
      treeReads: treeReads - treeReadsBefore,
      before: { treeRows: beforeC.treeRows, treeScrollTop: beforeC.treeScrollTop, treeScrollHeight: beforeC.treeScrollHeight, treeAnchorId: beforeC.treeAnchorId, treeAnchorTop: beforeC.treeAnchorTop, treeAnchorIndex: beforeC.treeAnchorIndex, treeTopRowId: beforeC.treeTopRowId },
      after: { treeRows: afterC.treeRows, treeScrollTop: afterC.treeScrollTop, treeScrollHeight: afterC.treeScrollHeight, treeAnchorId: afterC.treeAnchorId, treeAnchorTop: afterC.treeAnchorTop, treeAnchorIndex: afterC.treeAnchorIndex, treeTopRowId: afterC.treeTopRowId },
      jumps: analyse(collectedC.frames, collectedC.events, collectedC.fetches).jumps,
      cls: clsReport(collectedC.shifts),
      frames: collectedC.frames,
    };

    // ── 场景 C2：侧栏重建 —— 会话活动时间变了，行序跟着变 ──
    await openSession(SMALL_HISTORY);
    await evaluate(`(() => { const list=document.querySelector('[data-active-tree-list="true"]'); list.scrollTop = Math.round((list.scrollHeight - list.clientHeight) * 0.6); list.dispatchEvent(new Event('scroll')); })()`);
    await frames(3);
    await reset();
    const beforeC2 = await evaluate(`window.__jump.sampleOnce()`);
    for (let index = 0; index < 4; index += 1) {
      await fetch(`http://127.0.0.1:${port}/api/test/tree-bump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reorder: true }) });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await frames(4);
    const afterC2 = await evaluate(`window.__jump.sampleOnce()`);
    const collectedC2 = await collect();
    results.scenarios['C2 侧栏重建·行序变(活动时间更新)'] = {
      note: '别的会话 lastActivity 更新 ⇒ 排序变了、整栏重建；滚动轴被 restoreScrollPositions 保住，但轴下面的**内容**换了',
      before: { treeRows: beforeC2.treeRows, treeScrollTop: beforeC2.treeScrollTop, treeScrollHeight: beforeC2.treeScrollHeight, treeAnchorId: beforeC2.treeAnchorId, treeAnchorTop: beforeC2.treeAnchorTop, treeAnchorIndex: beforeC2.treeAnchorIndex, treeTopRowId: beforeC2.treeTopRowId },
      after: { treeRows: afterC2.treeRows, treeScrollTop: afterC2.treeScrollTop, treeScrollHeight: afterC2.treeScrollHeight, treeAnchorId: afterC2.treeAnchorId, treeAnchorTop: afterC2.treeAnchorTop, treeAnchorIndex: afterC2.treeAnchorIndex, treeTopRowId: afterC2.treeTopRowId },
      jumps: analyse(collectedC2.frames, collectedC2.events, collectedC2.fetches).jumps,
      cls: clsReport(collectedC2.shifts),
      frames: collectedC2.frames,
    };
    // ── 场景 E：浏览器原生 scroll anchoring 探针（解释 B1 为什么会弹到底） ──
    const anchorProbe = await evaluate(`(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px;top:0;height:200px;width:200px;overflow:auto';
      document.body.append(probe);
      const fill = (n) => { const f=document.createDocumentFragment(); for (let i=0;i<n;i++){ const d=document.createElement('div'); d.style.height='20px'; d.textContent='row'+i; f.append(d);} return f; };
      probe.append(fill(200));
      probe.scrollTop = 2000;
      const st0 = probe.scrollTop, sh0 = probe.scrollHeight;
      probe.prepend(fill(10));
      const stAnchored = probe.scrollTop, sh1 = probe.scrollHeight;
      // 再把模式改成 overflow-anchor:none，重做一遍
      const probe2 = document.createElement('div');
      probe2.style.cssText = 'position:fixed;left:-9999px;top:0;height:200px;width:200px;overflow:auto;overflow-anchor:none';
      document.body.append(probe2);
      probe2.append(fill(200));
      probe2.scrollTop = 2000;
      const b0 = probe2.scrollTop, bh0 = probe2.scrollHeight;
      probe2.prepend(fill(10));
      const bNone = probe2.scrollTop, bh1 = probe2.scrollHeight;
      probe.remove(); probe2.remove();
      return { prependedPx: sh1 - sh0, defaultAnchor: { scrollTopBefore: st0, scrollTopAfterPrepend: stAnchored, adjustedBy: stAnchored - st0 }, overflowAnchorNone: { scrollTopBefore: b0, scrollTopAfterPrepend: bNone, adjustedBy: bNone - b0, prependedPx: bh1 - bh0 } };
    })()`);
    results.scenarios['E scroll-anchoring 探针'] = {
      note: '同一台 Chromium 里，向一个已滚动的容器顶部 prepend 200px：默认 overflow-anchor 会不会自己改 scrollTop；overflow-anchor:none 呢。',
      ...anchorProbe,
      conclusion: anchorProbe.defaultAnchor.adjustedBy === anchorProbe.prependedPx && anchorProbe.overflowAnchorNone.adjustedBy === 0
        ? '默认模式下浏览器自己把 scrollTop 加了 prepend 的高度 ⇒ 代码里再 scrollTop += delta 就是双重补偿'
        : '预期模式未出现，看原始数字',
    };
  }

  results.pageProblems = pageProblems;
  results.counters = { messageReads, treeReads, seenPosts, treeActivityBump };
  results.environment = { chromium: version.Browser, executable: chrome, viewport: '1200x760', variant: VARIANT, resolvedAppJsBytes: appJsServed.length, baseAppJsBytes: appJsText.length };

  // ── 门：把上面量出来的事实变成机械断言（默认基线；可用 SOPHO_STREAMJUMP_LIMIT_JSON 覆盖）──
  const limits = {
    // A1 的结束跳变（仅正文）阈值；A2 的思考不再一次性长高（改断言「结束净增 0 个思考节点」）；
    // A3 - A2 是工具卡的贡献。
    endedTextMinPx: 100,
    // 工具卡：长输出**默认折叠**（web/render.js 的 TOOL_OUTPUT_COLLAPSE_LINES=12 /
    // TOOL_OUTPUT_COLLAPSE_CHARS=800），所以结束瞬间只多一个卡头 —— 断言「节点长出来（toolNodes===1）
    // + 高度增量小」。
    // 标定（都挂在本门夹具上，夹具形状 = 真机形状 `[thinking, text, tool]`）：
    //   · 2026-09-22 之前（工具块嵌在 assistant 块里）：折叠时 A3-A2 = 40px；
    //   · `3d242e9` 平铺之后（每个 top-level 块自带 padding/边框/margin + 一条 .message-role 角标行）：
    //     折叠时 A3-A2 = **59px**（+19px 是那张卡自己的角标行 + 上下 1px 边框 —— 产品端真实代价）；
    //   · 同一张卡**展开**画出来（负控臂 A5，30 行 write diff）：A5-A2 必然越过这个阈值（实测见输出）。
    // ⇒ 这是「折叠/展开」的分界，**不是**「工具卡应该长出来多少」的下界；59px 也不是被放宽出来的
    //   —— 阈值与断言一字未动，改的只是夹具的 parts 顺序（旧夹具 `[thinking, tool, text]` 在真会话里
    //   不存在：24606 条带工具块的 assistant 消息里「工具 part 不在末尾」= 0，见文件头「夹具依据」）。
    // ⚠️ 夹具差异：59px 是**本门夹具**（1 张工具卡、结果 14 行 = 1092 字符 > 12 行/800 字符 ⇒ 默认折叠）；
    //   test:thinkingstream 的「工具卡结束跳变」是**另一夹具**（5 张工具卡、每张结果 1 行 88 字符 ⇒ 默认展开，
    //   而且那门自己会发工具帧 ⇒ 直播卡在它门里已经画好 ⇒ 结束净增只有 ~15px 左右；修前那个 417px
    //   是「结束才一次性画出来」时代的数，在那个夹具上已经过去）。
    //   两者不可直接比；本门的阈值就挂在本门夹具上。
    // ⚠️ 重设条件：I-16（直播期就画工具卡）落地后，工具卡已在直播块里 ⇒ 结束那一刻 tools 净增 0、
    //   toolNodes 不再 ===1，这条会失败 —— 那是**重设触发点**，届时应改成断言新事实
    //   （直播期已有工具卡 / 结束净增 0 个），**不要**放宽阈值。
    //   ⚠️ 现状**不要当成 I-16 已经发生**（2026-09-19 实测量：活实例采样 240s，`session.tool_*` 帧数
    //   = **0**、`session.delta` 1823 条）⇒ 「直播期就画工具卡」在真机上**可能根本没生效**，
    //   工具卡仍只在结束/重画时由历史一次画出（场景 F 量的就是这条路的副作用）。
    toolAddsMaxPx: 100,
    // 用量行：2026-09-18 起是**固定一行**（不再长出一行）⇒ 这一跑应无位移（见下面那条 check 的说明）
    usageLineCls: 0.005,
    ...(process.env.SOPHO_STREAMJUMP_LIMIT_JSON ? JSON.parse(process.env.SOPHO_STREAMJUMP_LIMIT_JSON) : {}),
  };
  const failures = [];
  let checks = 0;
  const check = (name, ok, detail) => {
    // checks 数的是「断言总数」（过不过都 +1）⇒ 打印的 checks: N 恒等于本变体实际跑的断言条数（base 13 条）。
    // 以前只在通过时 +1，红了会少报（主干红 1 条时打印 checks: 11，其实跑了 12 条）。
    checks += 1;
    if (!ok) { failures.push(`${name}：${detail}`); return; }
    process.stdout.write(`✓ ${name} —— ${detail}\n`);
  };
  if (VARIANT === 'base') {
    const a1 = results.scenarios['A1 结束·仅正文(贴底)'];
    const a2 = results.scenarios['A2 结束·正文+思考(贴底)'];
    const a3 = results.scenarios['A3 结束·正文+思考+工具(贴底)'];
    const a5 = results.scenarios['A5 结束·正文+思考+工具(长输出展开态·负控)'];
    const b1 = results.scenarios['B1 结束·不贴底·260条(渐进)'];
    const b3 = results.scenarios['B3 结束·不贴底·260条(overflow-anchor:none)'];
    const a4 = results.scenarios['A4 结束·不贴底·40条'];
    const c1 = results.scenarios['C1 侧栏重建·行序不变'];
    const c2 = results.scenarios['C2 侧栏重建·行序变(活动时间更新)'];
    const d = results.scenarios['D 用量行变化(消息不变)'];
    check('流式中直播块里已经有正式思考块（甲：思考边流边显，不再等结束）', a2.before.thinking === 1 && a2.before.live === 1, `before.thinking=${a2.before.thinking} before.live=${a2.before.live}`);
    check('结束瞬间直播块被正式节点替换（live -1）', a1.endDelta.liveNodes === -1 && a2.endDelta.liveNodes === -1 && a3.endDelta.liveNodes === -1, `A1/A2/A3 liveNodes=${a1.endDelta.liveNodes}/${a2.endDelta.liveNodes}/${a3.endDelta.liveNodes}`);
    check('结束跳变：仅正文 ≥ 阈值', a1.endDelta.scrollHeight >= limits.endedTextMinPx, `ΔscrollHeight=${a1.endDelta.scrollHeight}px`);
    check('结束跳变：思考块不再一次性长出来（甲：直播期已在，结束净增 0 个思考节点）', a2.endDelta.thinkingNodes === 0, `thinkingNodesΔ=${a2.endDelta.thinkingNodes} ΔscrollHeight=${a2.endDelta.scrollHeight}px`);
    check('结束跳变：工具卡节点一次性长出来（长输出默认折叠，所以高度增量小）', a3.endDelta.toolNodes === 1 && a3.endDelta.scrollHeight - a2.endDelta.scrollHeight < limits.toolAddsMaxPx, `Δ(+工具)-Δ(+思考)=${a3.endDelta.scrollHeight - a2.endDelta.scrollHeight}px（本门夹具=1 张长输出卡，真形状 [thinking,text,tool]、默认折叠只多一个卡头 + 卡自己的角标/边框）toolNodes=${a3.endDelta.toolNodes}`);
    // 负控（这道门还咬得住吗）：同一把尺子、同一条路，只把工具块换成**展开画出来**（30 行 write diff）。
    // 它**必须**越过同一个阈值 —— 若连展开态都量不出「工具块一次性长出一大块」，说明阈值已经变成空话。
    // 这条不是「产品不许展开」（展开是用户/设计的事），而是「这把尺子还能看到那类跳变」的能力证明：
    // 折叠一旦失效（长输出被默认画成展开），A3 那一跳就会加上这一臂多出来的这段高度 ⇒ 必红。
    check('展开态（负控）：工具块真被画成展开时这一跳必然越过阈值（这道门还咬得住）', a5.endDelta.toolNodes === 1 && a5.endDelta.scrollHeight - a2.endDelta.scrollHeight >= limits.toolAddsMaxPx, `Δ(+展开的工具)-Δ(+思考)=${a5.endDelta.scrollHeight - a2.endDelta.scrollHeight}px ≥ 阈值 ${limits.toolAddsMaxPx}px ⇒ **按同一阈值判这一臂必红**（对照：A3 折叠态 = ${a3.endDelta.scrollHeight - a2.endDelta.scrollHeight}px < 阈值）toolNodes=${a5.endDelta.toolNodes}`);
    check('渐进补历史：不贴底用户不再被推到最底部', b1.after.scrollHeight - b1.after.scrollTop - b1.after.clientHeight > 1000, `距底 ${b1.before.scrollHeight - b1.before.scrollTop - b1.before.clientHeight}px → ${b1.after.scrollHeight - b1.after.scrollTop - b1.after.clientHeight}px（修复前会落在 ~194px，即贴到底部）`);
    const refreshWrite = (scenario) => (scenario.scrollWrites || []).find((write) => write.stack.includes('refreshMessages'));
    const b1Refresh = refreshWrite(b1);
    const flushWrite = (scenario) => (scenario.scrollWrites || []).find((write) => write.stack.includes('flush'));
    const b1Flush = flushWrite(b1);
    const b3Flush = flushWrite(b3);
    check('prepend 前后没有第三方（原生 scroll anchoring）插手 ⇒ flush 的 += 是单一补偿', b1Refresh && b1Flush && Math.abs(b1Flush.from - b1Refresh.to) < 1 && b3Flush && Math.abs(b3Flush.from - (refreshWrite(b3)?.to ?? NaN)) < 1, `B1 refresh 写 ${b1Refresh?.to}，flush 读到的 from=${b1Flush?.from}（修复前会出现 flush from ≫ refresh 写的值，即双重补偿）`);
    check('不贴底 + 小会话：阅读位置逐像素保住（无渐进截断）', a4.before.first && a4.after.first && a4.before.first.index === a4.after.first.index && Math.abs(a4.endDelta.firstVisibleMessageTop) < 5, `index ${a4.before.first?.index}→${a4.after.first?.index} firstTopΔ=${a4.endDelta.firstVisibleMessageTop}px`);
    check('侧栏行序不变时滚动轴与锚都不动', c1.before.treeScrollTop === c1.after.treeScrollTop && c1.before.treeAnchorId === c1.after.treeAnchorId && c1.jumps.length === 0, `scrollTop ${c1.before.treeScrollTop}→${c1.after.treeScrollTop} anchor ${c1.before.treeAnchorId === c1.after.treeAnchorId ? '同一条' : '换了'}`);
    check('侧栏行序变时轴不动但锚换人（内容位移）', c2.before.treeScrollTop === c2.after.treeScrollTop && c2.before.treeAnchorId !== c2.after.treeAnchorId, `scrollTop ${c2.before.treeScrollTop}→${c2.after.treeScrollTop} anchor ${c2.before.treeAnchorId}→${c2.after.treeAnchorId}`);
    // 2026-09-18 翻面：用量行改成**固定一行**（`#session-usage` 26px + nowrap + ellipsis，见 3e4ba26），
    // 它不再随内容长出一行 ⇒ 这一跑**不该再有任何整块位移**。原断言要求 ΔscrollTop===16 且 CLS ≥ 阈值，
    // 按「真修好时改成断言新事实、不放宽阈值」的规矩改成更强的一条：ΔscrollTop **恰好为 0**、CLS **低于**旧阈值。
    check('用量行固定一行 ⇒ 不再有整块位移（新事实，旧断言要的 16px 位移已消失）', d.endDelta.scrollTop === 0 && d.cls.cls < limits.usageLineCls, `ΔscrollTop=${d.endDelta.scrollTop}px CLS=${d.cls.cls}（旧阈值 ${limits.usageLineCls}）`);
    const f = results.scenarios['F 展开的工具输出在刷新后被折回'];
    // 2026-09-18 翻面：展开态现在由会话级折叠容器（web/render.js）+ localStorage 保住 ⇒ 刷新后**不再折回**。
    // 原哨兵断言「刷新后高度归 0、Δ>100px」，修好后按设计失败；按原注释的指示改成断言新事实（**没有**放宽阈值：
    // 仍旧要求展开时高度 >0，且刷新后与展开时**逐像素相同**、ΔscrollHeight ≈ 0）。
    check('展开的工具输出跨重画保持展开（内容不再消失）', f.expanded.toolResultScrollHeight > 0 && f.afterRefresh.toolResultScrollHeight === f.expanded.toolResultScrollHeight && Math.abs(f.expanded.scrollHeight - f.afterRefresh.scrollHeight) <= 4, `展开时输出高 ${f.expanded.toolResultScrollHeight}px ⇒ 刷新后 ${f.afterRefresh.toolResultScrollHeight}px；ΔscrollHeight=${f.endDelta.scrollHeight}px`);
    check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));
  }
  results.checks = { count: checks, failures, limits };

  await writeFile(reportFile, `${JSON.stringify(results, null, 2)}\n`);

  // ── 打印 ─────────────────────────────────────────────────────────────────
  print('环境', results.environment);
  if (transformed.applied.length) print('变体改动', { variant: VARIANT, edits: transformed.applied });
  for (const [name, scenario] of Object.entries(results.scenarios)) {
    print(`── ${name}`, {
      说明: scenario.note,
      ...(scenario.endDelta ? { 结束瞬间Δ: scenario.endDelta } : {}),
      ...(scenario.before?.scrollTop !== undefined ? { 滚动前: { scrollHeight: scenario.before.scrollHeight, scrollTop: scenario.before.scrollTop, firstTop: scenario.before.first?.top ?? null, lastTop: scenario.before.last?.top ?? null } } : {}),
      ...(scenario.after?.scrollTop !== undefined ? { 滚动后: { scrollHeight: scenario.after.scrollHeight, scrollTop: scenario.after.scrollTop, firstTop: scenario.after.first?.top ?? null, lastTop: scenario.after.last?.top ?? null } } : {}),
      ...(scenario.openState ? { 开屏: scenario.openState } : {}),
      ...(scenario.treeReads !== undefined ? { treeReads: scenario.treeReads, 树前: scenario.before, 树后: scenario.after } : {}),
      ...(scenario.before?.treeAnchorId !== undefined ? { 侧栏轴: { 前: scenario.before, 后: scenario.after, 锚是否同一条: scenario.before.treeAnchorId === scenario.after.treeAnchorId } } : {}),
      '跳变(≥8px)': scenario.jumps ?? [],
      '可见锚跳变(≥8px)': scenario.visibleAnchorJumps ?? [],
      ...(scenario.cls ? { CLS: { cls: scenario.cls.cls, countedEntries: scenario.cls.countedEntries, 全部entries: scenario.cls.entries.length, sources: scenario.cls.sources.slice(0, 8) } } : {}),
    });
  }
  print('页面异常', pageProblems);
  print('checks', results.checks.count);
  print('报告文件', reportFile);
  print('测法', '假 API 原样伺服 web/ + 真 Chromium；页内只读观测器逐帧记录 #messages 几何与可见首/末消息 rect、包 EventSource.addEventListener 记 SSE 到点、包 fetch 记 /messages 与 /tree 到点；CLS 用浏览器原生 PerformanceObserver(layout-shift)。');
  print('夹具依据', 'assistant 的 parts 恒为真机形状（工具 part 在末尾）：只读普查 ~/.pi/profiles/assistant/sessions/*.jsonl（397 个文件、58181 行）⇒ 带工具块的 assistant 消息 24606 条，其中「工具 part 不是最后一块」= 0 条（2026-09-22）。旧夹具 [thinking, tool, text] 在真会话里不存在。');
  if (results.checks.failures.length) {
    print('FAIL', results.checks.failures);
    throw new Error(`stream jump gate failed: ${results.checks.failures.join(' | ')}`);
  }
  print('RESULT', `stream jump quantified PASS (variant=${VARIANT})`);
} catch (error) {
  primaryError = error;
} finally {
  // Cleanup must never hide why the gate failed: collect cleanup problems, keep the primary
  // error, and only fail on cleanup when the run itself passed. Same contract as test/s0b.mjs
  // via test/harness.mjs -- the old bare rm only swallowed ENOENT, while a live writer
  // (chromium user-data-dir) can make the final rmdir throw ENOTEMPTY and replace the real
  // failure.
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
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
