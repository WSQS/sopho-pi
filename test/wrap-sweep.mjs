#!/usr/bin/env node
// test/wrap-sweep.mjs —— 「宽度挤压 / 单词被从中间折断」这条 bug 的**全页普查**门。
//
// 起因：用户报「`spawn` 在页面上被换行成 `sp` / `aw` / `n`」。另一条会话定因并修了工具卡：
//   `.tool-call { display:flex }` 里 `.tool-name` 缺 `flex:none`，叠加从 `.message` 继承的
//   `overflow-wrap:anywhere` ⇒ 该 flex 项的 `min-width:auto` 从「最宽单词」塌成「一个字符」
//   ⇒ args 一长，名字就被压成逐字换行（420px 下 `spawn` = 5 行各 1 字）。
// 这类病**可能还有别的现场**，所以这一门把同一把尺子（`test/text-wrap.mjs` 的 Range +
// `getClientRects()`）铺到**全页每个载体**上，而不是只看工具卡那 4 个。
//
// 尺子（与 text-wrap.mjs 同口径）：
//   · 一个词只应产生 **1 个 rect / 1 条 baseline**；`>1 条 baseline`（或去重后 `>1` 个 rect）
//     ⇒ 从中间折断 ⇒ 判红；
//   · 那个 rect 必须真的和词一样宽（被裁 / 被压扁也算红；`text-overflow:ellipsis` 真溢出的
//     元素除外 —— 那里截断是设计意图）；
//   · 承它的容器**可用宽度**（clientWidth 扣 padding/border）必须 ≥ 词宽 ⇒「宽度被挤成
//     min-content」判红；
//   · 词宽 > 承载列可用宽度时才允许断（真的装不下），但必须逐个列出来，不许静默放过；
//   · 滚动面不许横向溢出（`scrollWidth ≤ clientWidth + 1`）。
//   另加两条同源的「一行」钉子（对**按设计就该单行**的既有元素）：
//   · 「整段文本只占 1 条 baseline」—— 盖住没有西文词的 CJK 标签（如「✂ 压缩」「发送这一块」被挤成两行）；
//   · 「元素签名」—— 布局只许用宽度 / flex 修，不许靠新增元素撑宽（方向书规矩 2）。
//
// ⚠️ 尺子的一个实测修正（探针 /tmp 里跑过，见报告）：Chrome 在 `text-overflow:ellipsis` +
// `overflow:hidden` 且文本**真溢出**时，`Range.getClientRects()` 会回**两个几何完全相同**的
// rect（baseline 一样、x/w 一样）。这不是断行，所以判据用「去重后的 rect 数」。
//
// 覆盖：主页面 1200×760 / 900×760 / 420×820 / 360×820 × 4 阶段（正式正文+命令面板 /
//   正式正文+mention 面板 / 直播中 / 调试页）。
//   每个宽度×阶段都落截图。
//
// 沙箱：临时目录 + 随机高位端口（明确不用 7331/7321）、真 Chromium + 假 API，
// 不碰真实 profile、不 pkill、只按本次 spawn 的 pid 收尾；清理走 test/harness.mjs 的共享助手。
// 用法：CHROME_BIN=/usr/bin/chromium node test/wrap-sweep.mjs
//   可选 SOPHO_WRAP_SWEEP_SHOT_DIR=<目录> —— 截图落到这里（默认落系统临时目录）。

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boot, sendJson, waitFor } from './ui-harness.mjs';
import { removeSandbox, finishCleanup } from './harness.mjs';

// 被盯的那个词：用户报的就是它。它必须同时出现在每个能装西文词的载体里。
const WORD = 'spawn';
// 不可断的长 token：制造收缩压力（复现「负自由空间」的必要条件）。
const PRESSURE = 'A'.repeat(160);
const LONG_NAME = `${WORD} 子会话 ${'b'.repeat(40)}`;
const SESSION = '77777777-7777-4777-8777-777777777777';
const PEER = '88888888-8888-4888-8888-888888888888';
const ARCHIVED = '99999999-9999-4999-8999-999999999999';
const GRANDCHILD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CWD = `/home/user/code/ai/${'deep-'.repeat(10)}${WORD}-leaf`;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

// ── 主页面假 API 的数据 ─────────────────────────────────────────────────────────

const THINK_TEXT = `我在考虑 ${WORD} 这件事：${WORD} 会新建一棵工作树，${WORD} 的边界是 cwd。`;
const BODY_TEXT = `调度一条子会话：用 ${WORD} 起一个孩子，再等它收敛。`;
const TOOL_ARGS = { command: `${PRESSURE} ${WORD}` };
const TOOL_RESULT = `line one about ${WORD}\n${WORD} 输出里也有这个词。\ndone-with-${WORD}`;
const EXTRA_TEXT = `扩展消息里也有 ${WORD} 这个词，它必须整词一行。`;
const COMPACT_NOTE = `上下文太长，压掉前 12 条；${WORD} 相关的决定保留在上面。`;

const MESSAGES = [
  { role: 'user', text: `请演示 ${WORD}。`, content: [{ type: 'text', text: `请演示 ${WORD}。` }], timestamp: '2026-09-20T08:00:00.000Z' },
  {
    role: 'assistant',
    entryId: 'e-wrap-1',
    text: BODY_TEXT,
    parts: [
      { type: 'thinking', text: THINK_TEXT },
      { type: 'text', text: BODY_TEXT },
      // TUI 平价（工具卡耗时）：这里故意给它两个时间戳 ⇒ 卡片会长出 `.tool-duration`，
      // 上面那条「元素签名」就该看到 `span.tool-duration`（可选成员）；没时间戳的卡一个都不长。
      { type: 'tool', toolCallId: 'call-wrap-1', name: WORD, args: TOOL_ARGS, result: TOOL_RESULT, status: 'done-success', startedAt: '2026-09-20T08:01:00.000Z', endedAt: '2026-09-20T08:01:04.500Z' },
    ],
    stopReason: 'stop',
    timestamp: '2026-09-20T08:01:00.000Z',
  },
];
const EXTRAS = [{ kind: 'custom', customType: 'sopho.delegation', entryId: 'e-wrap-1', text: EXTRA_TEXT, timestamp: '2026-09-20T08:00:30.000Z' }];
const COMPACTION = { atIndex: 1, timestamp: '2026-09-20T08:02:00.000Z', note: COMPACT_NOTE, summary: `${WORD} 会话的摘要：工作树、cwd、边界。` };

const SESSIONS = [
  { id: SESSION, name: LONG_NAME, parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: true, cwd: CWD, lastActivity: '2026-09-20T08:02:00.000Z', notify: { notifies: [1, 2, 3], waitingFor: [1, 2] } },
  { id: PEER, name: `同伴 ${WORD} 会话`, parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, cwd: '/tmp/peer', lastActivity: '2026-09-20T07:00:00.000Z' },
  { id: CHILD, name: '子会话', parentId: SESSION, archived: false, status: 'idle', statusLabel: '闲置', unread: false, cwd: '/tmp/child', lastActivity: '2026-09-20T06:00:00.000Z' },
  { id: ARCHIVED, name: `存档的 ${WORD} 会话`, parentId: null, archived: true, status: 'idle', statusLabel: '闲置', unread: false, cwd: '/tmp/archived', lastActivity: '2026-09-19T06:00:00.000Z' },
  { id: GRANDCHILD, name: `${WORD}-grand`, parentId: ARCHIVED, archived: true, status: 'idle', statusLabel: '闲置', unread: false, cwd: '/tmp/gc', lastActivity: '2026-09-18T06:00:00.000Z' },
];

const COMMANDS = [
  { name: WORD, description: `启动一条子会话（含 ${PRESSURE} 的长说明）`, source: 'extension', runnable: true, reason: null, tag: null, via: 'prompt' },
  { name: 'compact', description: `${WORD} 手动压缩上下文`, source: 'builtin', runnable: true, reason: null, tag: null, via: 'compact' },
  { name: 'model', description: 'Select model', source: 'builtin', argumentHint: `${WORD}-argument-hint`, runnable: true, reason: null, tag: null, via: 'model' },
  { name: 'settings', description: 'Open settings menu', source: 'builtin', runnable: false, reason: 'TUI 专用（设置菜单）', tag: 'TUI 专用', via: null },
];

const OBSERVABILITY = {
  lastTurn: { model: { display: `${WORD}-model-name` }, usage: { status: 'known', input: 12345, output: 678, cacheRead: 4000, cacheWrite: 500 } },
  cumulative: { usage: { status: 'known', input: 437427072, output: 123456, cacheRead: 98765432, cacheWrite: 12345 }, cost: { total: 12.3456 } },
};
const CONTEXT = { usedTokens: 82000, contextWindow: 128000, freeTokens: 46000, compactionEnabled: true };
const QUEUE = { steering: [`插话：把 ${WORD} 的结果贴出来（${PRESSURE}）`], followUp: [`后续：再等 ${WORD} 收敛一次`] };

// ── 调试页（`#debug-pane`，业主 2026-09-22 裁定的第四个页签）的假数据 ─────────────────
// 每个能装西文词的载体都塞进 WORD；`sessionsRoot` 用一根不可断的长 token 制造收缩压力。
// 形状与 `test/debug-pane-ui.mjs` 约定的那份一致（两个来源：A 的 /api/debug/instances + B 的同源 /app-host）。
const DEBUG_INSTANCES = () => ({
  at: '2026-09-20T08:00:00.000Z',
  endpoint: 'GET /debug/instances',
  readOnly: true,
  worker: {
    pid: 4242, generationId: 'gen-wrap-1', logicVersion: 'logic-wrap-1', codeRevision: { revision: 'wrap' },
    uptimeSeconds: 12.5, memory: { rss: 268435456, heapTotal: 134217728, heapUsed: 99999999, external: 12345678, arrayBuffers: 7654321 },
  },
  pool: {
    scope: `${WORD} only this generation worker's own pool`,
    summary: { hot: 1, cold: 0, active: 0, pinned: 0, draining: false, maxHot: 8 },
    sessions: [{ sessionId: SESSION, runtimeState: 'hot', durable: true, idleForMs: 1000, evictionEligible: true, acquiredLeases: 0, pendingMessages: 0, queuedOperations: 0, pinReasons: [], blockers: [WORD], sessionFileBytes: 1234 }],
  },
  policy: {
    heapLimitBytes: 1073741824,
    watermarks: { heapHighBytes: 805306368, heapLowBytes: 536870912, rssHighBytes: 1610612736, rssLowBytes: 1073741824 },
    admission: { singleFileBudgetBytes: 805306368, formula: `${WORD} admission formula` },
  },
  host: { generationId: 'gen-wrap-1', currentGenerationId: 'gen-wrap-1', draining: false, worker: { pid: 4242, rssBytes: 268435456 }, hotSessions: [{ sessionId: SESSION, generationId: 'gen-wrap-1', runtimeState: 'hot', durable: true, pinReasons: [], acquiredLeases: 0 }], sessionsRoot: `/sandbox/${PRESSURE}` },
  // 真实形状（端点已合入主干）：`active` 是**每会话**的，插件/内建靠 `path` 分辨，
  // 没有热 runtime 时 `registered` 为 `null` ＋ 原因（不吐空清单）。
  tools: {
    source: 'GET /debug/instances → tools（由插件上报）',
    scope: `only HOT (live) runtimes in this worker's own pool (${WORD})`,
    liveSessionCount: 1,
    observedOn: 'gen-wrap-1',
    registered: [{ name: WORD, source: 'cli', path: `/ext/${WORD}`, hasParameters: true, parameterNames: ['task'], descriptionHead: `Delegate a task to a child ${WORD} session` }],
    registeredCount: 1,
    registeredUnavailableReason: null,
    identicalRegisteredAcrossLiveSessions: true,
    activeBySession: [{ sessionId: SESSION, activeCount: 1, active: [WORD] }],
    unreadableLiveSessions: [],
    unavailable: [],
  },
  unavailable: [{ field: 'hostProcess', reason: `${WORD} is a separate process`, where: 'GET /host on the A host' }],
});
const APP_HOST_FACTS = () => ({ pid: 9090, codeVersion: 'app-wrap-1', startedAt: '2026-09-20T08:00:00.000Z', upstream: 'http://127.0.0.1:7331', webRoot: '/repo/web' });

// ── 假 API 的路由 ───────────────────────────────────────────────────────────────

function makeRoutes() {
  const state = { sessionStream: null, requests: [] };
  const json = (response, status, value) => { sendJson(response, status, value); return true; };
  const routes = async (request, response, url) => {
    const p = url.pathname;
    state.requests.push(`${request.method} ${p}${url.search}`);
    if (p === '/api/host') return json(response, 200, { ok: true });
    if (p === '/api/devices') {
      return json(response, 200, {
        exists: true,
        devices: [{ name: `${WORD}-device`, host: '127.0.0.1', user: 'dev', ok: false, lastProbe: { ok: false, error: `${WORD} 探活失败`, at: '2026-09-20T08:00:00.000Z' } }],
      });
    }
    if (p === '/api/tree') return json(response, 200, { sessions: SESSIONS, unread: { count: 3, oldestId: PEER, oldestName: LONG_NAME, oldestAt: '2026-09-20T07:00:00.000Z' } });
    if (p === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: SESSIONS })}\n\n`);
      return true;
    }
    // ── 调试页（第四个页签）：A 的实例事实（经 /api 反代）+ B 的同源 /app-host ──
    if (p === '/api/debug/instances') return json(response, 200, DEBUG_INSTANCES());
    if (p === '/app-host') return json(response, 200, APP_HOST_FACTS());
    if (p === '/api/test/event' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!state.sessionStream || state.sessionStream.destroyed) return json(response, 409, { message: 'stream unavailable' });
      state.sessionStream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      return json(response, 200, { ok: true });
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|models|seen|draft|events|archive))?$/.exec(p);
    if (match) {
      const id = match[1];
      const action = match[2] ?? null;
      const known = SESSIONS.find((session) => session.id === id);
      if (!known) return json(response, 404, { message: 'not found' });
      if (action === null && request.method === 'GET') {
        return json(response, 200, {
          sessionId: id, name: known.name, cwd: known.cwd, archived: known.archived,
          runtime: { isStreaming: false, isCompacting: false, isRetrying: false },
          observability: OBSERVABILITY, context: CONTEXT,
        });
      }
      if (action === 'messages') return json(response, 200, { sessionId: id, messages: MESSAGES, extras: EXTRAS, compaction: COMPACTION, observability: OBSERVABILITY, context: CONTEXT });
      if (action === 'commands') return json(response, 200, { sessionId: id, streaming: false, compacting: false, canRun: true, builtinError: null, builtinHow: 'fixture', commands: COMMANDS });
      if (action === 'models') {
        return json(response, 200, {
          sessionId: id, current: 'fake/current', source: 'available',
          models: [
            { provider: 'fake', id: 'current', ref: 'fake/current', name: 'Current', current: true, contextWindow: 4096 },
            { provider: 'fake', id: `${WORD}-other`, ref: `fake/${WORD}-other`, name: `${WORD} other`, current: false, contextWindow: 8192 },
          ],
        });
      }
      if (action === 'seen') return json(response, 200, { ok: true });
      if (action === 'draft') return json(response, 200, { text: '', at: null });
      if (action === 'archive') return json(response, 200, { ok: true });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ sessionId: id, isStreaming: false, isCompacting: false, isRetrying: false, pendingMessages: 0, queue: QUEUE, observability: OBSERVABILITY, context: CONTEXT })}\n\n`);
        state.sessionStream = response;
        response.once('close', () => { if (state.sessionStream === response) state.sessionStream = null; });
        return true;
      }
    }
    return false;
  };
  return { routes, state };
}

// ── 页面里的量尺（两个页面共用同一把）──────────────────────────────────────────
//
// 「承载列」(`columnAvail`) = 这行文字真正排版的那一列的可用宽度，**不是元素自己**：元素被挤扁之后
// 拿它自己当列宽，会把「被挤压」误判成「本来装不下」（`wordWidth > columnAvail` ⇒ 放行），
// 反而放过被折断的现场。平铺（业主 2026-09-22 ③）之后，`.tool-card` / `.bash-card` 是 `#messages`
// 的**顶层块**（`3d242e9` 平铺历史卡、`cdcba2c` 流式期间也平铺直播卡），不再挂在 `.message-body`
// 底下 ⇒ 旧的兜底 `|| el` 把列宽取成工具名自己被压扁后的 11px，反向自检当场看不到折断
// （实测 `cdcba2c` 起 3/3 红）。所以列宽按**卡片内容盒**取：卡片自带 `overflow-wrap:anywhere`，
// 它就是这行文字的排版列。断言与阈值一字未动，只是取数不再掉队。
function measureScript({ carriers, oneLine }) {
  return `(() => {
  const WORD = ${JSON.stringify(WORD)};
  const CARRIERS = ${JSON.stringify(carriers)};
  const ONE_LINE = ${JSON.stringify(oneLine)};
  const num = (value) => parseFloat(value) || 0;
  const boxAvail = (el) => el.clientWidth - num(getComputedStyle(el).paddingLeft) - num(getComputedStyle(el).paddingRight)
    - num(getComputedStyle(el).borderLeftWidth) - num(getComputedStyle(el).borderRightWidth);
  // 行内元素（display:inline）没有 clientWidth —— Chrome 恒回 0 ⇒ 单靠它会把「承词容器」
  // 误报成 0 宽（实测：tool-args 里的 tool-args-summary 是行内 span，旧口径量出 0）。
  // 行内盒子占的是它所在**块容器**的列：退回最近的非行内祖先的可用宽度（列宽同样按这个口径）。
  const avail = (el) => {
    if (getComputedStyle(el).display !== 'inline') return boxAvail(el);
    let node = el.parentElement;
    while (node) {
      if (getComputedStyle(node).display !== 'inline') {
        const value = boxAvail(node);
        if (value > 0) return value;
      }
      node = node.parentElement;
    }
    return boxAvail(el);
  };
  const wordWidth = (el, text) => {
    const style = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;left:-10000px;top:0;white-space:pre;';
    probe.style.font = style.font;
    probe.style.letterSpacing = style.letterSpacing;
    probe.textContent = text;
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  };
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      parts.unshift(node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).trim().split(/\\s+/).join('.') : ''));
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = (el) => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const rows = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const el = node.parentElement;
    if (!el) continue;
    const pattern = new RegExp(WORD, 'g');
    let match;
    while ((match = pattern.exec(node.data))) {
      const before = match.index > 0 ? node.data[match.index - 1] : ' ';
      const after = match.index + WORD.length < node.data.length ? node.data[match.index + WORD.length] : ' ';
      if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + WORD.length);
      const raw = Array.from(range.getClientRects()).map((rect) => ({ x: +rect.x.toFixed(1), y: +rect.y.toFixed(1), w: +rect.width.toFixed(1), h: +rect.height.toFixed(1) }));
      // ⚠️ Chrome 的已知怪癖（本门实测钉住，探针见报告）：text-overflow:ellipsis + overflow:hidden
      // 且文本**真溢出**时，Range.getClientRects() 会回**两个几何完全相同**的 rect。那不是断行
      // （baseline 一样、x/w 一样），所以判据用「去重后的 rect 数」而不是原始 rect 数。
      const rects = [];
      for (const rect of raw) if (!rects.some((other) => other.x === rect.x && other.y === rect.y && other.w === rect.w)) rects.push(rect);
      const style = getComputedStyle(el);
      const carrier = el.closest(CARRIERS) || el;
      const carrierLabel = carrier.id ? ('#' + carrier.id) : (carrier.className ? String(carrier.className) : carrier.tagName.toLowerCase());
      rows.push({
        carrier: carrierLabel,
        path: pathOf(el),
        here: node.data.slice(Math.max(0, match.index - 20), match.index + WORD.length + 20),
        rectCount: rects.length,
        rawRectCount: raw.length,
        baselines: new Set(raw.map((rect) => Math.round(rect.y))).size,
        rects,
        wordWidth: +wordWidth(el, WORD).toFixed(2),
        elAvail: +avail(el).toFixed(2),
        // 承载列（取数口径，见 measureScript 上方那段说明）：卡片内容盒优先。
        columnAvail: +avail(el.closest('.message-body') || el.closest('.tool-card') || el.closest('.bash-card') || el).toFixed(2),
        box: (() => { const rect = el.getBoundingClientRect(); return { w: +rect.width.toFixed(1), h: +rect.height.toFixed(1), x: +rect.x.toFixed(1), y: +rect.y.toFixed(1) }; })(),
        visible: visible(el),
        ellipsisTruncated: style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1,
        flex: style.flex,
        minWidth: style.minWidth,
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        display: getComputedStyle(carrier).display,
      });
    }
  }
  const wholeLines = (selector) => Array.from(document.querySelectorAll(selector)).map((el) => {
    const inner = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = inner.nextNode())) if (n.data.trim()) nodes.push(n);
    if (!nodes.length) return { selector, visible: false, lines: 0 };
    const range = document.createRange();
    range.setStart(nodes[0], 0);
    range.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].data.length);
    const rects = Array.from(range.getClientRects()).map((rect) => ({ x: +rect.x.toFixed(1), y: +rect.y.toFixed(1), w: +rect.width.toFixed(1), h: +rect.height.toFixed(1) }));
    const box = el.getBoundingClientRect();
    return {
      selector, visible: visible(el), lines: new Set(rects.map((rect) => Math.round(rect.y))).size, rects,
      text: el.textContent, whiteSpace: getComputedStyle(el).whiteSpace,
      clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
      box: { w: +box.width.toFixed(1), h: +box.height.toFixed(1), x: +box.x.toFixed(1), y: +box.y.toFixed(1) },
    };
  });
  const scrollSurface = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    return { selector, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, overflowX: getComputedStyle(el).overflowX };
  };
  // 元素签名：tag + 归一化后的类名（空格换成点；className 为空就只留 tag）。
  const sig = (child) => child.tagName.toLowerCase() + (child.className ? '.' + String(child.className).trim().split(/\\s+/).join('.') : '');
  const childSignature = (selector) => Array.from(document.querySelectorAll(selector)).map((el) => Array.from(el.children).map(sig).join('|'));
  return {
    rows,
    oneLine: ONE_LINE.flatMap((selector) => wholeLines(selector)),
    signatures: {
      toolCall: childSignature('.tool-call'),
      toolCardChildren: childSignature('.tool-card'),
      thinkingHead: childSignature('.message-thinking-head'),
      commandPaletteRow: childSignature('.command-palette-item'),
      mentionPaletteRow: childSignature('.mention-palette-item'),
      queueStatusChildren: childSignature('#queue-status'),
    },
    counts: {
      'tool-name': document.querySelectorAll('.tool-name').length,
      'tool-args': document.querySelectorAll('.tool-args').length,
      'tool-result': document.querySelectorAll('.tool-result').length,
      'tool-duration': document.querySelectorAll('.tool-duration').length,
      'thinking-body': document.querySelectorAll('.thinking-body').length,
      'message-body': document.querySelectorAll('.message-body').length,
      'extra-body': document.querySelectorAll('.extra-body').length,
      'compaction-summary': document.querySelectorAll('.compaction-summary').length,
      'queue-item': document.querySelectorAll('.queue-item').length,
      'command-item': document.querySelectorAll('.command-palette-item').length,
      'mention-item': document.querySelectorAll('.mention-palette-item').length,
      'tree-name': document.querySelectorAll('.tree-name').length,
      'tree-delegation': document.querySelectorAll('.tree-delegation').length,
      'fold-toggle': document.querySelectorAll('.fold-toggle').length,
      'device': document.querySelectorAll('.device').length,
      'live': document.querySelectorAll('.live-message').length,
      'debug-item': document.querySelectorAll('#debug-list .debug-item').length,
      'debug-value': document.querySelectorAll('#debug-list .debug-value').length,
    },
    scrolls: ${JSON.stringify(['#messages', 'aside.tree', '#tree', '.tree-nav', '#composer', 'header', 'body', '#debug-list'])}.map(scrollSurface).filter(Boolean),
    texts: {
      usage: document.querySelector('#session-usage')?.textContent,
      notice: document.querySelector('#notice')?.textContent,
      cwd: document.querySelector('#session-cwd')?.textContent,
      title: document.querySelector('#session-title')?.textContent,
    },
  };
})()`;
}

const MAIN_MEASURE = measureScript({
  carriers: '.message-body, .thinking-body, .extra-body, .extra-label, .tool-name, .tool-args, .tool-result, .tool-toggle, .thinking-toggle, .queue-item, #queue-status strong, .command-description, .command-argument, .command-name, .command-source, .command-unavailable, .mention-name, .mention-id, .mention-badge, .tree-name, .tree-time, .tree-delegation, .fold-toggle, .attic-toggle, .attic-heading, .tree-empty, #session-title, #session-usage, #session-cwd, #session-context, #session-connection, #notice, .compaction-summary, .compaction-label, .device, .device-panel h2, .message-role, .debug-title, .debug-source, .debug-key, .debug-value, .debug-empty, #debug-scope, #debug-notice',
  oneLine: [
    '#session-title', '#session-usage', '#session-cwd', '#session-context', '#session-connection',
    '.tree-name', '.tree-time', '.tree-delegation', '.fold-toggle', '.attic-toggle',
    '#compact', '#abort', '#archive', '#delete', '#rename', '#export', '#send', '#tree-named-only', '#tree-search-toggle', '#tree-sort-toggle',
    '.command-name', '.command-description', '.command-source', '.command-argument',
    '.mention-name', '.mention-id', '.mention-badge', '.tool-toggle', '.thinking-toggle',
    // TUI 平价：工具卡的耗时标签（`white-space:nowrap` + `flex:none`，设计上恒为一行）。
    '.tool-duration',
    // 调试页（第四个页签）：页签/刷新是 CJK 标签（设计上单行）；`.debug-title` 是块标题
    // （`white-space:nowrap` + 省略号，恒为一行）。这三个只在调试页可见，其他阶段量不到或不可见。
    '#debug-refresh', '.debug-title',
  ],
});

// ── 判据 ───────────────────────────────────────────────────────────────────────

// 元素签名钉子（每个都必须是**既有**形状；新增元素去撑宽 ⇒ 判红）。
const SIGNATURE_RULES = {
  // 工具调用行：**恰好**这 3 个既有元素，一个不多一个不少（这条已由 text-wrap.mjs 钉过）。
  // TUI 平价（工具卡耗时）：`.tool-duration` 只有在服务端给了 `startedAt`（+ `endedAt`）时才画，
  // 算不出来时**一个元素都不加** —— 所以它是**可选**的；别的元素仍然判红（钉子的作用没变）。
  toolCall: { required: ['strong.tool-name', 'span.tool-args', 'button.tool-toggle'], optional: ['span.tool-duration'], exact: false },
  // 卡片级反馈（annotations，`docs/design-annotations.md` v1）：每张工具卡右下角多了一个
  // `.annotate` 控件（按钮 + 表单 + 本地标记）。平铺（业主 2026-09-22）又让每张工具卡顶上多了一行
  // `.message-role` 角标（说清「类型 + 谁发起的」）—— 它现在是**必有**的：块自带可见身份是这次交付的硬要求。
  toolCardChildren: { required: ['div.message-role', 'div.tool-call', 'div.tool-output'], optional: ['div.annotate'], exact: false },
  thinkingHead: { required: ['button.thinking-toggle'], optional: [], exact: true },
  // 命令 / mention 面板行：行内元素随「有没有 argumentHint / 有几个 badge」变化，所以只钉
  // 「必有的 + 允许出现的」，并禁止任何别的类名（新增元素仍然判红）。
  commandPaletteRow: { required: ['span.command-name', 'span.command-source'], optional: ['span.command-argument', 'span.command-description', 'span.command-unavailable'], exact: false },
  mentionPaletteRow: { required: ['span.mention-name', 'span.mention-id'], optional: ['span.mention-badge', 'span.mention-badge.archived'], exact: false },  queueStatusChildren: { required: ['strong'], optional: ['span.queue-item'], exact: false },
};

function judge(where, measured, { checkSignatures = true } = {}) {
  const failures = [];
  const allowed = [];
  for (const row of measured.rows) {
    if (!row.visible) continue;
    const at = `${where} · ${row.carrier}（${row.path}｜…${row.here}…）`;
    if (row.wordWidth > row.columnAvail + 0.5) {
      // 真的装不下（词比承载列还宽）⇒ 允许断，但逐个列出来，不许静默。
      allowed.push({ carrier: row.carrier, rectCount: row.rectCount, wordWidth: row.wordWidth, columnAvail: row.columnAvail });
      continue;
    }
    if (row.rectCount !== 1 || row.baselines !== 1) {
      failures.push(`「${WORD}」在 ${at} 被从中间折断：${row.rectCount} 个 rect / ${row.baselines} 条 baseline（原始 rect ${row.rawRectCount} 个；词宽 ${row.wordWidth}px / 列宽 ${row.columnAvail}px；盒子 ${row.box.w}×${row.box.h}；display=${row.display}；flex=${row.flex}；min-width=${row.minWidth}；white-space=${row.whiteSpace}；overflow-wrap=${row.overflowWrap}）rects=${JSON.stringify(row.rects)}`);
      continue;
    }
    // `text-overflow:ellipsis` 且真溢出的承词元素：截断是**设计意图**，词恰好落在截断处时 rect 会比词窄，
    // 这不算「宽度挤压」。其余承词元素 rect 比词窄 ⇒ 被裁 / 被压扁 ⇒ 判红。
    if (!row.ellipsisTruncated && row.rects[0].w < row.wordWidth - 1) {
      failures.push(`「${WORD}」在 ${at} 画出来只有 ${row.rects[0].w}px，小于它自己的宽度 ${row.wordWidth}px（被裁 / 被压扁）`);
      continue;
    }
    if (row.elAvail + 0.5 < row.wordWidth) {
      failures.push(`承「${WORD}」的容器 ${at} 可用宽度只有 ${row.elAvail}px < 词宽 ${row.wordWidth}px（容器的宽度被挤成了 min-content）`);
    }
  }
  // CJK 的对应臂：按设计该单行的既有元素，整段文本必须只占 1 条 baseline。
  for (const row of measured.oneLine) {
    if (!row.visible || row.lines <= 1) continue;
    failures.push(`${where}：${row.selector} 按设计应单行，却占了 ${row.lines} 条 baseline（文本「${row.text}」，white-space=${row.whiteSpace}，盒子 ${row.box.w}×${row.box.h}）逐行 rect=${JSON.stringify(row.rects)}`);
  }
  if (checkSignatures) {
    for (const [key, rule] of Object.entries(SIGNATURE_RULES)) {
      for (const actual of measured.signatures[key] || []) {
        const classes = actual.split('|');
        const missing = rule.required.filter((entry) => !classes.includes(entry));
        const extra = classes.filter((entry) => !rule.required.includes(entry) && !rule.optional.includes(entry));
        if (missing.length || extra.length || (rule.exact && classes.length !== rule.required.length)) {
          failures.push(`${where}：${key} 的元素签名变成了 ${actual}（必有 ${JSON.stringify(rule.required)}，允许 ${JSON.stringify(rule.optional)}${rule.exact ? '，且恰好这些' : ''}）—— 布局问题不许靠新增 / 重排元素解决（方向书：除页面组成里提到的要素，不要额外添加其他要素）`);
        }
      }
    }
  }
  const surfaces = measured.scrolls;
  for (const surface of surfaces) {
    if (surface.scrollWidth > surface.clientWidth + 1) {
      failures.push(`${where}：${surface.selector} 出现横向溢出 scrollWidth ${surface.scrollWidth} > clientWidth ${surface.clientWidth}（overflowX=${surface.overflowX}）`);
    }
  }
  return { failures, allowed };
}

function summarize(rows) {
  const carriers = {};
  for (const row of rows) {
    if (!row.visible) continue;
    const slot = carriers[row.carrier] ??= { 出现次数: 0, rect数: [], 词宽: row.wordWidth, 容器可用宽: [] };
    slot.出现次数 += 1;
    slot.rect数.push(row.rectCount);
    slot.容器可用宽.push(row.elAvail);
  }
  return carriers;
}

// 每个阶段至少要量到的元素（夹具没覆盖它 ⇒ 门自己废了，必须显式判红）。
const MAIN_REQUIRED_COUNTS = ['tool-name', 'tool-args', 'tool-result', 'tool-duration', 'thinking-body', 'message-body', 'extra-body', 'compaction-summary', 'queue-item', 'tree-name', 'tree-delegation', 'fold-toggle', 'device'];
const PHASE_COUNTS = { command: ['command-item'], mention: ['mention-item'], live: [], debug: ['debug-item', 'debug-value'] };
const MAIN_REQUIRED_ONELINE = [
  '#session-title', '#session-usage', '#session-cwd', '#session-context', '#session-connection',
  '.tree-name', '.tree-time', '.tree-delegation', '.fold-toggle', '.attic-toggle',
  '#compact', '#abort', '#archive', '#delete', '#rename', '#export', '#send', '#tree-named-only', '#tree-search-toggle', '#tree-sort-toggle',
  '.tool-toggle', '.thinking-toggle',
  // TUI 平价（工具卡耗时）：`.tool-duration` 也是**设计上必须单行**的一个标签（`white-space:nowrap`
  // + `flex:none` —— 不给 `flex:none` 就会被长 args 挤成逐字换行，这条臂就是守它的）。
  '.tool-duration',
];
const PHASE_ONELINE = {
  command: ['.command-name', '.command-description', '.command-source', '.command-argument'],
  mention: ['.mention-name', '.mention-id', '.mention-badge'],
  live: [],
  // 调试页：页签按钮与块标题（CJK，设计上单行）。`.debug-key` 故意**不进**单行臂 ——
  // 它是长点名标签（如 `mismatches.registeredButNotActive`），折行是它的设计行为。
  debug: ['.debug-title', '#debug-refresh'],
};

function coverageFailures(measured, counts, oneLine) {
  const failures = [];
  for (const key of counts) if (!(measured.counts[key] > 0)) failures.push(`夹具里没有 ${key}（这一臂没测到它）`);
  for (const selector of oneLine) {
    if (!measured.oneLine.some((row) => row.selector === selector && row.visible)) failures.push(`${selector} 一次都没量到（单行臂没测到它）`);
  }
  return failures;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────

const VIEWPORTS = [
  { label: '宽屏 1200×760', width: 1200, height: 760 },
  { label: '中屏 900×760', width: 900, height: 760 },
  { label: '窄屏 420×820', width: 420, height: 820 },
  { label: '更窄 360×820', width: 360, height: 820 },
];
const SHOT_DIR = process.env.SOPHO_WRAP_SWEEP_SHOT_DIR || path.join(os.tmpdir(), 'sopho-wrap-sweep');

const { routes } = makeRoutes();

let primaryError;
let ui = null;
try {
  ui = await boot({ routes, width: 1200, height: 760 });
  print('chromium', { product: ui.version.Browser, chrome: ui.chrome, port: ui.port, debugPort: ui.debugPort, forbiddenPortsUsed: false });

  const navigate = async (viewport, url) => {
    await ui.browser.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    const loaded = ui.browser.once('Page.loadEventFired');
    await ui.browser.send('Page.navigate', { url: `http://127.0.0.1:${ui.port}${url}` });
    await loaded;
  };
  const shot = async (name) => {
    await mkdir(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `${name}.png`);
    await ui.screenshot(file);
    print('  截图', file);
    return file;
  };
  const shotClip = async (name, box) => {
    await mkdir(SHOT_DIR, { recursive: true });
    const clip = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.max(16, box.w + 16), height: Math.max(16, box.h + 16), scale: 2 };
    const captured = await ui.browser.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    const file = path.join(SHOT_DIR, `${name}.png`);
    await writeFile(file, Buffer.from(captured.data, 'base64'));
    print('  焦点截图', file);
  };
  const openSession = async (viewport) => {
    await waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${SESSION}"]') !== null`), `${viewport.label}: tree did not render`);
    // 展开存档箱 + 打开左栏两个折叠面板，好让底部归档行、折叠记号、搜索面板也进量程。
    await ui.evaluate(`document.querySelector('[data-attic-toggle="true"]')?.click()`);
    await ui.evaluate(`document.querySelector('#tree-search-toggle')?.click()`);
    await ui.evaluate(`document.querySelector('#new-session-toggle')?.click()`);
    await ui.evaluate(`document.querySelector('[data-session-id="${SESSION}"] .tree-select').click()`);
    await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), `${viewport.label}: session did not open`);
    await waitFor(() => ui.evaluate(`document.querySelector('#messages .tool-name') !== null && document.querySelector('#messages .tool-result') !== null && document.querySelector('#messages .compaction-summary') !== null && document.querySelector('#messages .extra-body') !== null`), `${viewport.label}: message fixtures did not render`);
    await waitFor(() => ui.evaluate(`document.querySelectorAll('#queue-status .queue-item').length === 2`), `${viewport.label}: queue did not render`);
  };

  const results = {};
  for (const viewport of VIEWPORTS) {
    const collected = { failures: [], phases: {} };
    for (const phase of ['command', 'mention', 'live', 'debug', 'selfcheck']) {
      await navigate(viewport, `/?vp=${viewport.width}&phase=${phase}#${SESSION}`);
      await waitFor(() => ui.evaluate(`document.querySelector('#session-title') !== null`), `${viewport.label}: page did not load`);
      await openSession(viewport);
      if (phase === 'command') {
        await ui.evaluate(`(() => { const input = document.querySelector('#prompt'); input.value = '/'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(() => ui.evaluate(`document.querySelectorAll('.command-palette-item').length === 4`), `${viewport.label}: command palette did not render`);
      } else if (phase === 'mention') {
        await ui.evaluate(`(() => { const input = document.querySelector('#prompt'); input.value = '@'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(() => ui.evaluate(`document.querySelectorAll('.mention-palette-item').length >= 2`), `${viewport.label}: mention palette did not render`);
      } else if (phase === 'debug') {
        // 第四个页签（业主 2026-09-22）：切过去之后正文区只切 visibility、底栏/PIN条隐藏，
        // 调试面板里的文字得进同一把尺子（载体已登记在 MAIN_MEASURE 的 CARRIERS 里）。
        await ui.evaluate(`(() => { const input = document.querySelector('#prompt'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await ui.evaluate(`document.querySelector('#view-tab-debug').click()`);
        await waitFor(() => ui.evaluate(`document.querySelector('#debug-list')?.dataset.load === 'ready' && document.querySelectorAll('#debug-list .debug-item').length > 0`), `${viewport.label}: debug pane did not render`);
      } else {
        await ui.evaluate(`(() => { const input = document.querySelector('#prompt'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await ui.emit('session.start', {});
        await ui.emit('session.delta', { channel: 'thinking', delta: THINK_TEXT });
        await ui.emit('session.delta', { channel: 'text', delta: BODY_TEXT });
        await ui.emit('session.tool_start', { toolCallId: 'call-wrap-live', name: WORD, args: TOOL_ARGS });
        await ui.emit('session.tool_end', { toolCallId: 'call-wrap-live', name: WORD, isError: false, result: TOOL_RESULT });
        await waitFor(() => ui.evaluate(`(() => { const live = document.querySelector('#messages .live-message'); return !!(live && live.querySelector('.tool-name') && live.querySelector('.thinking-body')); })()`), `${viewport.label}: live block did not render`);
      }
      // 反向自检（门的负控）：把工具名的 `flex:none` 在**运行时**改回 `0 1 auto`（修前的值），
      // 尺子必须当场看到「spawn 被逐字换行」。看不到 ⇒ 这个门测不出那个 bug 类，直接判红。
      //
      // ⚠️ 两根刺（2026-09-22 实测；业主拍板 ③ 的「平铺成独立块」之后开始偶发红 2/5）：
      //   ① 注入**必须走样式表**（`<style>` + `!important`），**不能**用内联 `node.style.flex`：
      //      这一臂里有两张工具卡（历史夹具那张 + 直播那张），而直播卡在 `session.tool_end` 之后
      //      还会被**整块重画一次**；重画换掉节点 ⇒ 内联样式与被注入的 args 文本**一起**被抹掉
      //      （实测：新节点 flex=0 0 auto / inlineFlex="" / 标记属性消失，而旧节点上刚写进去的是
      //      flex=0 1 auto）⇒ 量到的是「没被改坏」的布局 ⇒ 自检假红成「门测不出这个 bug 类」。
      //      样式表对重画后的新节点一样生效，所以它才是碰得到那个 bug 类的注入。
      //   ② 注入生效是**异步**的（要等（重画后的）节点与样式真的落到布局上）⇒ **轮询 computedStyle
      //      等到生效再量**，给上限；到点还没生效就报**明确的红**（带现场数字），不许静默挂住。
      if (phase === 'selfcheck') {
        const measured = await ui.evaluate(`(async () => {
          const DEADLINE_MS = 5000;
          const PRESSURE = ${JSON.stringify(PRESSURE + PRESSURE)};
          const MARKER = 'command: ' + PRESSURE + ' ${WORD}';
          let style = document.querySelector('style[data-wrap-sweep-selfcheck="true"]');
          if (!style) {
            style = document.createElement('style');
            style.dataset.wrapSweepSelfcheck = 'true';
            // 修前的值：.tool-name 没有 flex:none ⇒ 这个 flex 项的 min-width:auto 从
            // 「最宽单词」塌成「一个字符」⇒ args 一长就被压成逐字换行（用户报的那个 bug）。
            style.textContent = '#messages .tool-name { flex: 0 1 auto !important; }';
            document.head.append(style);
          }
          const snapshot = () => [...document.querySelectorAll('#messages .tool-name')].map((node) => ({
            flex: getComputedStyle(node).flex,
            inline: node.style.flex,
            width: +node.getBoundingClientRect().width.toFixed(1),
            height: +node.getBoundingClientRect().height.toFixed(1),
          }));
          const effective = () => { const rows = snapshot(); return rows.length > 0 && rows.every((row) => row.flex === '0 1 auto') ? rows : null; };
          const deadline = performance.now() + DEADLINE_MS;
          let rows = null;
          let ticks = 0;
          while (performance.now() < deadline) {
            // args 的压力文本也补一遍（重画会把它抹回夹具自己的那 166 字符 —— 那也够制造负自由空间，
            // 但补上就不必依赖「刚好够」这个假设）。
            document.querySelectorAll('#messages .tool-args').forEach((node) => { if (node.textContent !== MARKER) node.textContent = MARKER; });
            await new Promise((resolve) => requestAnimationFrame(resolve));
            ticks += 1;
            rows = effective();
            if (rows) break;
          }
          const where = { ticks, deadlineMs: DEADLINE_MS, styleApplied: !!style.isConnected, names: snapshot(), argsLen: [...document.querySelectorAll('#messages .tool-args')].map((node) => node.textContent.length) };
          if (!rows) return { injected: false, ...where };
          // 生效之后再量（**同一个任务里**，中间不让出事件循环 ⇒ 不会有重画插进来）。
          return { injected: true, ...where, ...${MAIN_MEASURE} };
        })()`);
        print(`  ${viewport.label} · 反向自检注入生效（轮询 computedStyle）`, { injected: measured.injected, ticks: measured.ticks, names: measured.names, argsLen: measured.argsLen });
        if (!measured.injected) {
          throw new Error(`${viewport.label}: 反向自检的注入没生效 —— 轮询 ${measured.deadlineMs}ms（${measured.ticks} tick）后 #messages .tool-name 的 computedStyle 仍不是修前的 0 1 auto，这一臂没法证明这道门咬得住那个 bug 类：${JSON.stringify({ styleApplied: measured.styleApplied, names: measured.names, argsLen: measured.argsLen })}`);
        }
        const verdict = judge(`${viewport.label} · 反向自检（工具名 flex 改回 0 1 auto）`, measured);
        const broken = verdict.failures.filter((line) => line.includes(WORD) && (line.includes('被从中间折断') || line.includes('min-content')));
        assert.ok(broken.length > 0, `${viewport.label}: 反向自检没红 —— 把 .tool-name 的 flex 改回 0 1 auto 之后尺子仍看不到折断，这个门测不出那个 bug 类（注入已生效：${JSON.stringify(measured.names)}）：${JSON.stringify(verdict.failures)}`);
        print(`  ${viewport.label} · 反向自检（故意改坏）· 如期判红 ${broken.length} 条`, broken[0]);
        await shot(`wrap-sweep-${viewport.width}x${viewport.height}-selfcheck-broken`);
        continue; // 自检臂不参与最终判红
      }
      // 顶栏提示行走受控 notice（`会话错误：…`），把 WORD 也送进 #notice。
      // ⚠️ 调试页里 `#composer`（`#notice` 就在它里面）是 display:none ⇒ 这条臂跳过；
      //    WORD 由调试面板自己的载体承接（`pool.scope` / 工具名 / 路径）—— 那是这一臂要量的东西。
      if (phase !== 'debug') {
        await ui.emit('session.error', { message: `${WORD} 这条提示必须整词一行` });
        await waitFor(() => ui.evaluate(`document.querySelector('#notice').textContent.includes(${JSON.stringify(WORD)})`), `${viewport.label}: notice did not update`);
      }
      await ui.frames(3);
      const measured = await ui.evaluate(MAIN_MEASURE);
      await shot(`wrap-sweep-${viewport.width}x${viewport.height}-${phase}`);
      const phaseName = phase === 'command' ? '正式正文+命令面板' : phase === 'mention' ? '正式正文+mention 面板' : phase === 'debug' ? '调试页' : '直播中';
      // 调试页把正文区（连同它的一半单行臂）隐掉了 ⇒ 只查它与调试页共享的那几条：
      // 拿 MAIN_REQUIRED_* 去要求它属于误报（那些元素在，但按设计不可见）。
      const coverage = phase === 'debug'
        ? coverageFailures(measured, PHASE_COUNTS.debug, PHASE_ONELINE.debug)
        : coverageFailures(measured, [...MAIN_REQUIRED_COUNTS, ...PHASE_COUNTS[phase]], [...MAIN_REQUIRED_ONELINE, ...PHASE_ONELINE[phase]]);
      const verdict = judge(`${viewport.label} · ${phaseName}`, measured);
      const failures = [...coverage, ...verdict.failures];
      collected.phases[phase] = { measured, failures };
      collected.failures.push(...failures);
      print(`  ${viewport.label} · ${phase} · 载体汇总`, summarize(measured.rows));
      // 元素计数（夹具里真有这些元素才算测到 —— 包括 TUI 平价的 `.tool-duration`）。
      print(`  ${viewport.label} · ${phase} · 元素计数`, measured.counts);
      print(`  ${viewport.label} · ${phase} · 单行臂（=1 即一行）`, measured.oneLine.filter((row) => row.visible).map((row) => `${row.selector}=${row.lines}`).join(' '));
      if (verdict.allowed.length) print(`  ${viewport.label} · ${phase} · 真装不下（词宽 > 列宽，允许断）`, verdict.allowed);
      if (failures.length) {
        print(`  ${viewport.label} · ${phase} · 逐出现位置（全量）`, measured.rows.filter((row) => row.visible));
        for (const row of measured.rows.filter((r) => r.visible && (r.rectCount !== 1 || r.baselines !== 1 || r.elAvail + 0.5 < r.wordWidth))) {
          await shotClip(`FAIL-${viewport.width}-${phase}-${row.carrier.replace(/[^a-z0-9-]/gi, '_')}`, row.box).catch(() => {});
        }
      }
    }
    results[viewport.label] = collected;
    if (collected.failures.length) print(`  ${viewport.label} · 失败 ${collected.failures.length} 条`, collected.failures);
  }

  const allFailures = VIEWPORTS.flatMap((viewport) => results[viewport.label].failures);
  assert.deepEqual(ui.pageProblems, [], `页面异常：${JSON.stringify(ui.pageProblems)}`);
  if (allFailures.length) throw new Error(`wrap sweep gate failed（共 ${allFailures.length} 条）：\n - ${allFailures.join('\n - ')}`);
  print('截图目录', SHOT_DIR);
  print('RESULT', `wrap sweep PASS（${WORD} 在 ${VIEWPORTS.length} 个宽度 × 主页面 4 阶段（正式正文+命令面板 / +mention 面板 / 直播中 / 调试页）的全页载体里都整词不断行、承载容器可用宽度 ≥ 词宽、单行元素仍单行、滚动面无横向溢出；Chromium ${ui.version.Browser}）`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  // 传 cleanupProblems：收尾自己失败（等不到整棵树退出 / 删完又出现）也进这条判红通道，不静默。
  await (async () => { try { await ui?.close(cleanupProblems); } catch (error) { cleanupProblems.push(`close: ${error.message}`); } })();
  if (ui) await removeSandbox(ui.sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
