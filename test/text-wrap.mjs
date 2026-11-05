#!/usr/bin/env node
// test/text-wrap.mjs —— 「单词被从中间折断」这条用户报告的机械门（真 Chromium + 假 API）。
//
// 用户原话：**「像 spawn 现在在页面上会被换行为 `sp` / `aw` / `n`」** —— 单词从中间折断，
// 每行只剩一两字。修前的真实几何（本门在修前跑出的原始数字，见报告）：
//   · 1200×760：`.tool-name`（`spawn`）盒子 28.03×30px，Range 量到 **2 个 rect / 2 条 baseline**
//     （`23.4px` + `15.6px` = `spa` / `wn`）；
//   · 420×820：盒子 **10.75×75px** —— **5 个 rect / 5 条 baseline**，每行 7.8px = 一个字。
//
// 元凶（`web/index.html`）：`.tool-call { display:flex }` 里
//   ① `.tool-name` 没有 `flex:none`（= `flex: 0 1 auto`，可以收缩）；
//   ② `overflow-wrap: anywhere` 从 `.message` 继承下来 ⇒ 该 flex 项的 `min-width:auto` 不再是
//      「最宽单词」（39px），而是「一个字符」（7.8px）⇒ 负自由空间全压到名字上逐字换行；
//   ③ 对比 v2.1（`git show v2.1-final:web/app.css` 的 `.tname { flex: none }` + `.targs { nowrap + ellipsis }`）
//      ⇒ 这是 v2.2 重写工具卡时丢掉的宽度约束（回归）。
//
// 判据为什么必须是几何（而不是「字符串还在」）：文字一直都在，只是被折断了 ——
// 「断言字符串存在」的门在这条缺陷上**永远绿**。所以这里用 Range + `getClientRects()`：
//   · 一个词只应产生 **1 个 rect**（同一 baseline）；`>1` 或 baseline `>1` ⇒ 从中间折断 ⇒ 判红；
//   · 那个 rect 必须**真的和词一样宽**（宽度被裁掉 / 被压扁也算红）；
//   · 承它的容器可用宽度（`clientWidth` 扣 computed padding/border）必须 ≥ 词宽 ⇒ 「宽度被挤」判红；
//   · 词宽 > 消息列可用宽度时才允许断开（真的装不下），但必须**逐个列出来**，不许静默放过；
//   · `#messages` 不许出现横向溢出（`scrollWidth ≤ clientWidth + 1`）—— 防止有人用
//     `white-space: nowrap` 把「折断」换成「顶出屏幕」，那只是换个坏法。
//
// 覆盖 2 种宽度（1200×760 / 420×820）× 2 个阶段（结束后正式正文 / 直播中）× 4 个载体
// （`.tool-name` / `.thinking-body` / `.message-body` 正文 / `.tool-result`）。
//
// 沙箱：临时目录 + 随机高位端口（明确不用 7331/7321），不碰真实 profile，不 pkill。
// 用法：CHROME_BIN=/usr/bin/chromium node test/text-wrap.mjs
//   可选 SOPHO_WRAP_SHOT_DIR=<目录> —— 把两个宽度 × 两个阶段的截图写到那里（取证用；默认不写）。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, quiesceCdpPage, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-text-wrap-'));

// 被盯的那个词：用户报的是 `spawn`。它必须同时出现在 4 个载体里，否则门会漏掉载体。
const WORD = 'spawn';
const SESSION = '77777777-7777-4777-8777-777777777777';
const TOKEN = 'A'.repeat(160); // 不可断的长 token：用来把 `.tool-call` 挤到负自由空间（复现的必要条件）

const THINK_TEXT = `我在考虑 ${WORD} 这件事：${WORD} 会新建一棵工作树，${WORD} 的边界是 cwd。`.repeat(3);
const BODY_TEXT = `调度一条子会话：用 ${WORD} 起一个孩子，再等它收敛。`.repeat(3);
const TOOL_NAME = WORD; // 工具名就是那个词 —— 修前它自己被挤成逐字换行
const TOOL_RESULT = `line one about ${WORD}\n` + `${WORD} 输出里也有这个词。\n`.repeat(2) + `done-with-${WORD}`;
// args 里**不含**被盯的词：它是一根 160 字符的不可断 token，负责制造收缩压力；
// 词若落在 args 里，会不会被断取决于折行落点（不确定），那样门就会抖动。
const TOOL_ARGS = { command: TOKEN };
const HISTORY_PARTS = [
  { type: 'thinking', text: THINK_TEXT },
  { type: 'text', text: BODY_TEXT },
  // TUI 平价（工具卡耗时）：给它两个时间戳 ⇒ 标题行会多出 `.tool-duration`（签名钉子里那个可选成员）。
  { type: 'tool', toolCallId: 'call-wrap-1', name: TOOL_NAME, args: TOOL_ARGS, result: TOOL_RESULT, status: 'done-success', startedAt: '2026-09-20T08:01:00.000Z', endedAt: '2026-09-20T08:01:04.500Z' },
];
const HISTORY_MESSAGES = [
  { role: 'user', text: `请演示 ${WORD}。`, content: [{ type: 'text', text: `请演示 ${WORD}。` }] },
  { role: 'assistant', entryId: 'e-wrap-1', text: BODY_TEXT, parts: HISTORY_PARTS, stopReason: 'stop' },
];

const VIEWPORTS = [
  { label: '宽屏 1200×760', width: 1200, height: 760 },
  { label: '窄屏 420×820', width: 420, height: 820 },
];

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 16000); candidate < 62000; candidate += 1) {
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

async function waitFor(operation, message, timeoutMs = 15_000) {
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
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
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

// ── 在页面里量：每个目标词的出现位置一个 Range ─────────────────────────────────────
// 只认「完整的词」：`sp` / `awn` 这种残片不算（围标的事交给父会话）。
const PROBE = `(() => {
  const WORD = ${JSON.stringify(WORD)};
  const root = document.querySelector('#messages');
  const num = (value) => parseFloat(value) || 0;
  // 可用宽度：排除滚动条的 clientWidth，再扣掉 computed padding 与 border（有边框时起点也要加）。
  const avail = (el) => el.clientWidth - num(getComputedStyle(el).paddingLeft) - num(getComputedStyle(el).paddingRight)
    - num(getComputedStyle(el).borderLeftWidth) - num(getComputedStyle(el).borderRightWidth);
  const wordWidth = (el) => {
    const style = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;left:-10000px;top:0;white-space:pre;';
    probe.style.font = style.font;
    probe.style.letterSpacing = style.letterSpacing;
    probe.textContent = WORD;
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  };
  const rendered = (el) => el.isConnected && el.getClientRects().length > 0;
  const occurrences = [];
  const hidden = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const el = node.parentElement;
    if (!el) continue;
    const pattern = new RegExp(WORD, 'g');
    let match;
    while ((match = pattern.exec(node.data))) {
      // 词边界：西文词只认两侧都不是 [A-Za-z0-9_] 的出现位置。
      const before = match.index > 0 ? node.data[match.index - 1] : ' ';
      const after = node.data[match.index + WORD.length] ?? ' ';
      if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + WORD.length);
      const rects = Array.from(range.getClientRects()).map((rect) => ({ x: +rect.x.toFixed(1), y: +rect.y.toFixed(1), w: +rect.width.toFixed(1), h: +rect.height.toFixed(1) }));
      const carrier = el.classList.contains('message-body') ? 'message-body(裸文本)' : (el.className || el.tagName);
      const row = {
        carrier,
        here: node.data.slice(Math.max(0, match.index - 16), match.index + WORD.length + 16),
        rectCount: rects.length,
        baselines: new Set(rects.map((rect) => Math.round(rect.y))).size,
        rects,
        wordWidth: +wordWidth(el).toFixed(2),
        carrierAvail: +avail(el).toFixed(2),
        columnAvail: +(el.closest('.message-body') ? avail(el.closest('.message-body')) : avail(el)).toFixed(2),
      };
      if (rendered(el)) occurrences.push(row); else hidden.push(row);
    }
  }
  const messages = document.querySelector('#messages');
  const live = document.querySelector('#messages .live-message');
  // ── 规矩 2（方向书：「除了我下面提到的页面组成中的要素，不要额外添加其他的要素」）的机械钉子 ──
  // 布局只能用「宽度」修（min-width / flex / grid 轨道），**不许靠新增元素去撑宽** ——
  // 所以工具调用这一行的**元素签名**必须就是那 3 个既有元素，一个不多。
  const row = document.querySelector('#messages .tool-call');
  const composition = row ? {
    childCount: row.children.length,
    signature: Array.from(row.children).map((child) => [child.tagName.toLowerCase(), child.className].join('.')),
  } : null;
  // ── 槽位（方向书：「一行只有最左侧一个槽」）—— 工具卡一条 3px 槽，行内不得再长槽 ──
  const slotOf = (node) => node ? getComputedStyle(node).borderInlineStartWidth : null;
  const slots = {
    toolCard: slotOf(document.querySelector('#messages .tool-card')),
    toolCall: slotOf(row),
    toolName: slotOf(row?.querySelector('.tool-name')),
    toolArgs: slotOf(row?.querySelector('.tool-args')),
    toolToggle: slotOf(row?.querySelector('.tool-toggle')),
  };
  // ── 规矩 1（「所有的行都是很重要的，除了必要的情况，绝不换行」）的**诊断**（不判红）──
  // 数每个载体占几行：名字必须恒为 1 行（已由 rect 断钉死）；args 目前仍会随长 token 换行，
  // 「args 该不该也压成一行」是要人类拍板的开放问题，所以这里只量、只打印，且把「如果压成一行」
  // 的样子在**运行时**（不写文件）量出来给判断用。
  const rowsOf = (node, lineHeightPx) => node ? +(node.getBoundingClientRect().height / lineHeightPx).toFixed(2) : null;
  const lines = {
    toolCall: rowsOf(row, 18),
    toolName: rowsOf(row?.querySelector('.tool-name'), 15),
    toolArgs: rowsOf(row?.querySelector('.tool-args'), 18),
    toolResult: rowsOf(document.querySelector('#messages .tool-result'), 18),
    thinkingBody: rowsOf(document.querySelector('#messages .thinking-body'), 15),
    bodyP: rowsOf(document.querySelector('#messages .message-body p'), 15),
  };
  const alternative = (() => {
    const args = document.querySelector('#messages .tool-args');
    if (!args) return null;
    const before = { rowPx: +row.getBoundingClientRect().height.toFixed(1), argsPx: +args.getBoundingClientRect().height.toFixed(1) };
    args.style.whiteSpace = 'nowrap';
    args.style.overflow = 'hidden';
    args.style.textOverflow = 'ellipsis';
    const after = { rowPx: +row.getBoundingClientRect().height.toFixed(1), argsPx: +args.getBoundingClientRect().height.toFixed(1), nameW: +row.querySelector('.tool-name').getBoundingClientRect().width.toFixed(2) };
    args.style.whiteSpace = '';
    args.style.overflow = '';
    args.style.textOverflow = '';
    return { before, after };
  })();
  return {
    occurrences,
    hidden: hidden.map((row) => ({ carrier: row.carrier, here: row.here, rectCount: row.rectCount })),
    liveMessagePresent: !!live,
    carriers: { names: document.querySelectorAll('#messages .tool-name').length, thinking: document.querySelectorAll('#messages .thinking-body').length, results: document.querySelectorAll('#messages .tool-result').length, live: live ? 1 : 0 },
    scroll: { clientWidth: messages.clientWidth, scrollWidth: messages.scrollWidth },
    composition,
    slots: slots,
    lines: lines,
    alternative: alternative,
    toolName: (() => { const name = document.querySelector('#messages .tool-name'); if (!name) return null; const rect = name.getBoundingClientRect(); return { text: name.textContent, w: +rect.width.toFixed(2), h: +rect.height.toFixed(2), flex: getComputedStyle(name).flex, avail: +avail(name).toFixed(2) }; })(),
    toolArgs: (() => { const args = document.querySelector('#messages .tool-args'); if (!args) return null; const rect = args.getBoundingClientRect(); return { w: +rect.width.toFixed(2), h: +rect.height.toFixed(2), flex: getComputedStyle(args).flex, avail: +avail(args).toFixed(2), chars: args.textContent.length }; })(),
  };
})()`;

/** 判据：把一次量到的结果判红/判绿。逐出现位置的全量行只在判红时才打出来。 */
function judge(where, measured) {
  const failures = [];
  const allowed = [];
  for (const row of measured.occurrences) {
    const fitsColumn = row.wordWidth <= row.columnAvail + 0.5;
    const at = `${where} 的 ${row.carrier}${row.here ? `（…${row.here}…）` : ''}`;
    if (!fitsColumn) {
      // 真的装不下（词比整列还宽）⇒ 允许断；但必须列出来，不许静默。
      allowed.push({ carrier: row.carrier, rectCount: row.rectCount, wordWidth: row.wordWidth, columnAvail: row.columnAvail });
      continue;
    }
    if (row.rectCount !== 1 || row.baselines !== 1) {
      failures.push(`「${WORD}」在 ${at} 被从中间折断：${row.rectCount} 个 rect / ${row.baselines} 条 baseline（词宽 ${row.wordWidth}px / 列宽 ${row.columnAvail}px）rects=${JSON.stringify(row.rects)}`);
      continue;
    }
    if (row.rects[0].w < row.wordWidth - 1) {
      failures.push(`「${WORD}」在 ${at} 画出来只有 ${row.rects[0].w}px，小于它自己的宽度 ${row.wordWidth}px（被裁/被压扁）`);
      continue;
    }
    if (row.carrierAvail + 0.5 < row.wordWidth) {
      failures.push(`承「${WORD}」的容器 ${at} 可用宽度只有 ${row.carrierAvail}px < 词宽 ${row.wordWidth}px（容器的宽度被挤成了 min-content）`);
    }
  }
  if (measured.scroll.scrollWidth > measured.scroll.clientWidth + 1) {
    failures.push(`${where} 的 #messages 出现横向溢出：scrollWidth ${measured.scroll.scrollWidth} > clientWidth ${measured.scroll.clientWidth}（把「折断」换成了「顶出去」）`);
  }
  // 规矩 2（方向书）：布局只能用「宽度」修，**不许靠新增元素去撑宽**。
  const expectedSignature = ['strong.tool-name', 'span.tool-args', 'button.tool-toggle'];
  // TUI 平价（工具卡耗时）：`.tool-duration` 只在服务端给了 `startedAt` 时才画（没给就一个元素都不加），
  // 所以它是**可有可无**的那一个 —— 过掉它再比，别的元素仍然一个不许加。
  const actualSignature = (measured.composition?.signature || []).filter((entry) => entry !== 'span.tool-duration');
  if (!measured.composition) {
    failures.push(`${where}：没量到工具调用这一行的元素组成（.tool-call 缺失，这一臂没测到）`);
  } else if (actualSignature.length !== expectedSignature.length
    || actualSignature.join('|') !== expectedSignature.join('|')) {
    failures.push(`${where}：工具调用这一行的元素签名是 ${JSON.stringify(measured.composition.signature)}（去掉可选的 span.tool-duration 后是 ${JSON.stringify(actualSignature)}），不是既有的 ${JSON.stringify(expectedSignature)} —— 布局问题不许靠新增/重排元素解决（方向书：除页面组成里提到的要素，不要额外添加其他要素）`);
  }
  // 槽位（方向书：一行只有最左侧一个槽）—— 工具卡一条 3px 左槽，行内不得再长槽。
  if (measured.slots?.toolCard !== '3px') {
    failures.push(`${where}：.tool-card 的左侧槽是 ${measured.slots?.toolCard}，应为 3px（槽位是核心设计语言）`);
  }
  for (const key of ['toolCall', 'toolName', 'toolArgs', 'toolToggle']) {
    if (measured.slots?.[key] !== '0px') {
      failures.push(`${where}：${key} 多长了一条左侧槽（${measured.slots?.[key]}）—— 一行只能有最左侧那一个槽`);
    }
  }
  return { failures, allowed };
}

/** 每个载体的汇总量（打印用）。 */
function summarize(measured) {
  const carriers = {};
  for (const row of measured.occurrences) {
    const slot = carriers[row.carrier] ??= { 出现次数: 0, rect数: [], 词宽: row.wordWidth, 容器可用宽: [] };
    slot.出现次数 += 1;
    slot.rect数.push(row.rectCount);
    slot.容器可用宽.push(row.carrierAvail);
  }
  return carriers;
}

async function runArm({ port }) {
  let sessionStream = null;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      const sessions = [{ id: SESSION, name: `折断现场 ${WORD}`, parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } }];
      if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
      if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
      if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
      if (url.pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
        return;
      }
      const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(url.pathname);
      if (match) {
        if (match[1] !== SESSION) return sendJson(response, 404, { message: 'not found' });
        const action = match[2] ?? null;
        if (action === null) return sendJson(response, 200, { name: sessions[0].name, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
        if (action === 'messages') return sendJson(response, 200, { messages: HISTORY_MESSAGES, extras: [], compaction: { atIndex: null }, observability: null });
        if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] });
        if (action === 'seen') return sendJson(response, 200, { ok: true });
        if (action === 'draft') return sendJson(response, 200, { text: '', at: null });
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false, pendingMessages: 0 })}\n\n`);
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
        sessionStream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return sendJson(response, 200, { ok: true });
      }
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.resolve(webRoot, `.${pathname}`);
      if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
      let content;
      try { content = await readFile(file); } catch { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(content);
    } catch (error) {
      try { if (!response.headersSent) response.writeHead(500).end(String(error && error.message)); } catch {}
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reserveHighPort(new Set([port]));
  const chromiumPath = process.env.CHROME_BIN || '/usr/bin/chromium';
  const chromium = spawn(chromiumPath, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank',
  ], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  let chromiumErr = '';
  chromium.stderr.on('data', (chunk) => { chromiumErr += chunk; });

  const pageProblems = [];
  const results = {};
  let browser;
  try {
    const version = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
      return response?.ok ? response.json() : null;
    }, 'Chromium remote debugger did not start', 30_000);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    browser = cdp(target.webSocketDebuggerUrl, pageProblems);
    await browser.ready;
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    const evaluate = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
      return result.result.value;
    };
    const emit = (name, data) => evaluate(`fetch('/api/test/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ name, data }))} }).then((response) => response.status)`);
    const shotDir = process.env.SOPHO_WRAP_SHOT_DIR;
    const shot = async (name) => {
      if (!shotDir) return;
      await mkdir(shotDir, { recursive: true });
      const captured = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(shotDir, `${name}.png`);
      await writeFile(file, Buffer.from(captured.data, 'base64'));
      print('  截图', file);
    };

    for (const viewport of VIEWPORTS) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      // 每个宽度用不同的 URL 强制一次真加载（hash 相同的导航是同文档的，上一轮的直播块会留着）。
      await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/?vp=${viewport.width}#${SESSION}` });
      await waitFor(() => evaluate(`document.readyState === 'complete' && !!(document.querySelector('#messages .tool-name') && document.querySelector('#messages .thinking-body') && document.querySelector('#messages .tool-result'))`), `${viewport.label}: history fixtures did not render`);

      const history = await evaluate(PROBE);
      await shot(`text-wrap-${viewport.width}x${viewport.height}-history`);
      // ── 直播中：同一段文字再走一遍（正文是裸文本节点、思考在 .thinking-body、工具卡走 toolCard()）──
      await emit('session.start', {});
      await emit('session.delta', { channel: 'thinking', delta: THINK_TEXT });
      await emit('session.delta', { channel: 'text', delta: BODY_TEXT });
      await emit('session.tool_start', { toolCallId: 'call-wrap-live', name: TOOL_NAME, args: TOOL_ARGS });
      await emit('session.tool_end', { toolCallId: 'call-wrap-live', name: TOOL_NAME, isError: false, result: TOOL_RESULT });
      await waitFor(() => evaluate(`(() => { const live = document.querySelector('#messages .live-message'); return !!(live && live.querySelector('.tool-card') && Array.from(live.querySelectorAll('.thinking-body')).some((node) => node.textContent.includes(${JSON.stringify(WORD)})) && live.querySelectorAll('.tool-name').length === 1); })()`), `${viewport.label}: live block did not render`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const live = await evaluate(PROBE);
      await shot(`text-wrap-${viewport.width}x${viewport.height}-live`);

      const rows = [];
      const failures = [];
      for (const [phase, measured] of [['结束后正式正文', history], ['直播中', live]]) {
        const where = `${viewport.label} · ${phase}`;
        print(`  ${where} · 承词容器`, { 工具名: measured.toolName, 工具参数: measured.toolArgs, 载体数: measured.carriers, 滚动: measured.scroll });
        print(`  ${where} · 逐载体汇总（出现 ${measured.occurrences.length} 处 / 被折叠藏起来 ${measured.hidden.length} 处）`, summarize(measured));
        print(`  ${where} · 规矩2 元素签名 + 槽位`, { 元素签名: measured.composition, 槽位: measured.slots });
        // 规矩 1 的**诊断**（不判红）：名字已恒为 1 行；args 仍随长 token 换行 —— 这是等人类拍板的开放问题。
        print(`  ${where} · 规矩1 诊断（占几行；不判红）`, measured.lines);
        print(`  ${where} · 规矩1 开放问题：若把 args 压成一行（运行时试改，未写文件）`, measured.alternative);
        if (measured.hidden.length) print(`  ${where} · 被跳过（不可见，不计入判据）`, measured.hidden);
        const verdict = judge(where, measured);
        if (verdict.allowed.length) print(`  ${where} · 真装不下（词宽 > 列宽，允许断）`, verdict.allowed);
        if (verdict.failures.length) print(`  ${where} · 逐出现位置（全量）`, measured.occurrences);
        failures.push(...verdict.failures);
        rows.push({ viewport: viewport.label, phase, occurrences: measured.occurrences.length, hidden: measured.hidden.length, toolName: measured.toolName, scroll: measured.scroll });
        if (phase === '直播中') assert.ok(measured.liveMessagePresent, `${viewport.label}: 直播块必须存在（否则这一臂什么都没测到）`);
      }
      assert.ok(history.occurrences.length + live.occurrences.length >= 16, `${viewport.label}: 量到的出现位置太少（${history.occurrences.length + live.occurrences.length}），门本身可能废了`);
      for (const carrier of ['thinking-body', 'message-body(裸文本)', 'tool-name', 'tool-result']) {
        assert.ok([...history.occurrences, ...live.occurrences].some((row) => row.carrier === carrier), `${viewport.label}: 载体 ${carrier} 一次都没量到 —— 夹具没覆盖它`);
      }
      results[viewport.label] = { rows, failures };
    }

    // 先把所有宽度都量完再一起判红：只停在第一个红宽度会把后面那个宽度的证据藏起来。
    const allFailures = VIEWPORTS.flatMap((viewport) => results[viewport.label].failures);
    if (allFailures.length) throw new Error(`text wrap gate failed（共 ${allFailures.length} 条）：\n - ${allFailures.join('\n - ')}`);
    assert.deepEqual(pageProblems, [], `页面异常：${JSON.stringify(pageProblems)}`);
    return { chromium: version.Browser, results };
  } finally {
    await quiesceCdpPage(browser);
    browser?.close();
    if (sessionStream) sessionStream.destroy();
    if (chromium.exitCode === null && chromium.signalCode === null) {
      chromium.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => chromium.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (chromium.exitCode === null && chromiumErr) process.stderr.write(`chromium stderr (secondary): ${chromiumErr.slice(-400)}\n`);
  }
}

const used = new Set();
const port = await reserveHighPort(used); used.add(port);

let primaryError;
try {
  await mkdir(sandbox, { recursive: true });
  const arm = await runArm({ port });
  print('沙箱', { dir: sandbox, port, forbiddenPortsUsed: false });
  print('RESULT', `text wrap PASS（${WORD} 在 ${VIEWPORTS.length} 种宽度 × 2 个阶段里都只产生 1 个 rect，容器可用宽度 ≥ 词宽；Chromium ${arm.chromium}）`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
