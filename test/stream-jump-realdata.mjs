#!/usr/bin/env node
// test/stream-jump-realdata.mjs —— 「流式连接之后页面跳变」的**真规模数据**量化台。
//
// 与前一条线的门（test/stream-jump-cost.mjs / test/session-connect-flow.mjs）的分工：
//   · 它们用**合成夹具 + 假 API**（假 API 直接伺服 web/），量出来的位移在它们那套夹具上是 0；
//   · 这一条换三个角度，补它们没覆盖的：
//       ① **真规模数据**：从真 profile **只读复制**整份 sessions/（338 条 / 211 MB，含 15.5 MB、
//          2237 条消息、952 个工具调用、47 条扩展消息、图片块的那条），逐文件只重写 header 的
//          parentSession 路径前缀（让树能按真血缘成树）—— 正文一个字节都不动；
//       ② **真服务器**：spawn 真的 server/base.mjs + server/app.mjs（高位随机端口 + 临时 ASSIST_HOME），
//          只把模型指向本地假 provider（openai-completions，慢速流），于是走的是真的 runtime / 真的
//          SSE / 真的 /messages 冷读路径；
//       ③ **真浏览器逐帧采样每个区域**：headless Chromium（CHROME_BIN=/usr/bin/chromium）真开页面，
//          逐帧记 #messages 的 scrollTop/scrollHeight/clientHeight、可见首/末消息 rect、侧栏两条轴、
//          用量行、输入区、header 的高度与 top；并把 screencast 帧按**正文区**做逐帧像素位移（行剖面 SAD
//          取 argmin）与 6 带差；每个事件（session.start / 首个 delta / tool_* / end / settled / es-open
//          / es-error / fetch 到点）标出它落在第几帧、毫秒偏移。
//
// 场景矩阵（前一条漏掉的那几格打 ★）：× {冷开 / 热开 / ★打开时那一轮正在流式 / ★流式中杀掉 SSE 让它重连}
// × {贴底 / 不贴底} × {重会话 / 轻会话} × {有图 / 无图} × {1200 / 420}。
//
// 默认只观察（exit 0，写 JSON + PNG 到 artifact 目录）；`--assert` 才按阈值断言。
//
// 纪律：只用高位随机端口 + 临时 ASSIST_HOME/浏览器 profile；真 profile 只读（copyFile 出去）；
// 不碰 7331/7321；不 pkill（只按 pid 杀自己 spawn 的 base/app/chromium）。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/stream-jump-realdata.mjs
//   SOPHO_JUMP_DATA=~/.pi/profiles/assistant/sessions
//   SOPHO_JUMP_COPY=all|N      复制多少条（默认 all；N=按文件大小取最重的 N 条 + 它们的祖先）
//   SOPHO_JUMP_CELLS=a,b,c     只跑指定 cell（默认全部）
//   SOPHO_JUMP_ARTIFACT=/tmp/sopho-streamjump-real
//   --assert                   断言「从打开到静置，各区域逐帧 Δpx 的最大值 ≤ 阈值」（阈值见 LIMITS）

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, quiesceCdpPage, removeSandbox } from './harness.mjs';
import { decodePng, bandDiff } from './screencast-bands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = root;
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const appEntry = path.join(sourceRoot, 'server', 'app.mjs');
const webRoot = path.join(sourceRoot, 'web');

const REAL_PROFILE = process.env.SOPHO_JUMP_PROFILE || path.join(os.homedir(), '.pi', 'profiles', 'assistant');
const REAL_SESSIONS = process.env.SOPHO_JUMP_DATA || path.join(REAL_PROFILE, 'sessions');
const artifactRoot = process.env.SOPHO_JUMP_ARTIFACT || path.join(os.tmpdir(), 'sopho-streamjump-real');
const COPY_MODE = process.env.SOPHO_JUMP_COPY || 'all';
const onlyCells = process.env.SOPHO_JUMP_CELLS ? new Set(process.env.SOPHO_JUMP_CELLS.split(',').map((value) => value.trim())) : null;
const assertMode = process.argv.includes('--assert') || process.env.SOPHO_JUMP_ASSERT === '1';

// 阈值（见报告「阈值依据」一节）。Δpx 口径见 docs/design-intent.md。
// 三个门分别对应三类「非零位移」：
//   layout    区域布局位移（顶栏各行 / 用量行 / 输入区 / notice / 侧栏两条轴）—— 页面骨架被抽动
//   swapPull  贴底格「锚被抽走的位数」= 锚换人前那一刻的 dist —— 「读者被拽走」的那类跳变（核心 bug）
//   anchor    读者阅读锚的逐帧位移 —— 含流式 follow-bottom 时新内容在下方长高（那是应有的滚动）
const LIMITS = {
  layoutPx: Number(process.env.SOPHO_JUMP_LIMIT_LAYOUT ?? 6),
  swapPullPx: Number(process.env.SOPHO_JUMP_LIMIT_SWAP ?? 4), // 口径同 test:connectflow 的 maxAbsDistPx ≤ 4
  anchorPx: Number(process.env.SOPHO_JUMP_LIMIT_ANCHOR ?? 130), // 依据：实测最坏 106px（stream-open-narrow420 的直播块首帧）
  widthFillPx: Number(process.env.SOPHO_JUMP_LIMIT_WIDTH ?? 2), // 方向书 2026-09-19：受检区域可用宽度 == 容器内容宽（±1–2px，树/归档树缩进行例外）
  screenShiftPx: Number(process.env.SOPHO_JUMP_LIMIT_SHIFT ?? 6),
  requireCells: ['cold-heavy-sticky', 'stream-open-heavy-bottom', 'cold-heavy-mid'],
};

// ── 假 provider：慢速 openai-completions 流（先沉默一段 ⇒ 页面能在「思考中…」那一刻打开） ──
const STREAM_TEXT = [
  '# 真规模数据上的流式回复',
  '',
  '这一段故意写得长一些，好让打开页面这件事真的落在**流式过程中**：',
  '',
  '- 第一条：正文按 delta 逐块到达，每块之间 ~40ms，前端每帧只提交一次。',
  '- 第二条：思考中占位（✻ 思考中…）只在**一个 part 都没有**时出现；一有内容就被移除。',
  '',
  '```js',
  'const frame = requestAnimationFrame(() => renderLive({ follow: isFollowingBottom() }));',
  '```',
  '',
  '后面再补几段普通正文，把这一轮的可见高度撑到几屏：',
  '收尾段落。'.repeat(60),
  '',
  '```bash',
  '$ node test/stream-jump-realdata.mjs --assert',
  '```',
  '',
  '最后一行：END-OF-STREAM-MARKER',
].join('\n').repeat(3);

let providerPort;
let providerServer;
let silenceMs = Number(process.env.SOPHO_JUMP_SILENCE_MS ?? 12000);
let chunkChars = 32;
let chunkPaceMs = Number(process.env.SOPHO_JUMP_PACE_MS ?? 40);
const THINKING_TEXT = [
  '先把这条真会话的形状过一遗：2237 条消息、952 个工具调用、47 条扩展消息。',
  '真规模数据与合成夹具的差别在：正文长度长短悬殊、工具结果很长 —— 估算高度最容易失真的正是这种。',
  '逐帧看：直播块追加、follow bottom 的 scrollTop 写入、收尾那一刻的整块替换、以及用量行/顶栏两行的出现。',
  '结论要挂在原始帧上，不写“应该没问题”。',
  'THINKING-END',
].join('\n').repeat(3);

function reservePort() {
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

async function waitFor(operation, message, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(50);
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function startFakeProvider() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of request) raw += part;
    try { requests.push({ at: Date.now(), bytes: raw.length }); } catch { /* ignore */ }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunk = (content, finishReason = null, usage = null, reasoning = null) => ({
      id: 'chatcmpl-jump', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'deepseek-flash',
      choices: [{ index: 0, delta: content === null && reasoning === null ? {} : { ...(reasoning !== null ? { reasoning_content: reasoning } : {}), ...(content !== null ? { content } : {}) }, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    });
    response.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    // 沉默期：只发 SSE 注释行（连接活着的证据），前端这期间只有「✻ 思考中…」。
    const silenceUntil = Date.now() + silenceMs;
    while (Date.now() < silenceUntil && !response.destroyed) {
      response.write(': keep-alive\n\n');
      await sleep(200);
    }
    // 思考通道：与真 provider 一样先发 reasoning_content（前端「甲」把思考也画进直播块）。
    if (process.env.SOPHO_JUMP_THINKING !== '0') {
      for (let index = 0; index < THINKING_TEXT.length && !response.destroyed; index += chunkChars) {
        response.write(`data: ${JSON.stringify(chunk(null, null, null, THINKING_TEXT.slice(index, index + chunkChars)))}\n\n`);
        await sleep(chunkPaceMs);
      }
    }
    for (let index = 0; index < STREAM_TEXT.length && !response.destroyed; index += chunkChars) {
      response.write(`data: ${JSON.stringify(chunk(STREAM_TEXT.slice(index, index + chunkChars)))}\n\n`);
      await sleep(chunkPaceMs);
    }
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify(chunk(null, 'stop', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, requests };
}

// ── 播种：只读复制真 sessions/，只重写 header 的 parentSession 路径前缀 ──
async function seedSessions(sessionsRoot) {
  await mkdir(sessionsRoot, { recursive: true });
  const names = (await readdir(REAL_SESSIONS)).filter((name) => name.endsWith('.jsonl'));
  const sized = [];
  for (const name of names) {
    const info = await stat(path.join(REAL_SESSIONS, name));
    sized.push({ name, size: info.size });
  }
  sized.sort((a, b) => b.size - a.size);
  let chosen = sized;
  if (COPY_MODE !== 'all') {
    const limit = Number(COPY_MODE);
    if (Number.isFinite(limit) && limit > 0) chosen = sized.slice(0, limit);
  }
  let copiedBytes = 0;
  const ids = [];
  for (const { name, size } of chosen) {
    const raw = await readFile(path.join(REAL_SESSIONS, name));
    const nl = raw.indexOf(0x0a);
    const headBuffer = nl === -1 ? raw : raw.subarray(0, nl);
    const rest = nl === -1 ? Buffer.alloc(0) : raw.subarray(nl + 1);
    let head = headBuffer.toString('utf8').split(REAL_SESSIONS + '/').join(sessionsRoot + '/');
    try { ids.push(JSON.parse(head).id); } catch { /* not a session header; keep as-is */ }
    await writeFile(path.join(sessionsRoot, name), Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from('\n'), rest]));
    copiedBytes += size;
  }
  return { files: chosen.length, bytes: copiedBytes, ids };
}

// ── 页内只读观测器 ────────────────────────────────────────────────────────────
const INSTRUMENT = `(() => {
  const J = window.__jd = { frames: [], events: [], fetches: [], scrollWrites: [], shifts: [], sampling: false, pageErrors: [] };
  const now = () => Math.round(performance.now() * 100) / 100;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);
  const box = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { top: num(r.top), bottom: num(r.bottom), height: num(r.height) };
  };
  // ── 水平铺满（方向书 2026-09-19 新约束）──────────────────────────────────────
  // 「水平方向都保持铺满，除了会话栏/归档栏里带缩进的栏目」⇒ 受检区域的 border-box 必须等于
  // 其容器**内容宽**（clientWidth 扣 padding；容器有滚动条时 clientWidth 已排除它），阈值 ±2px。
  // 用 WeakMap 缓存每个元素的 padding 读数（帧内多次调用的开销）。
  const padCache = new WeakMap();
  const contentWidth = (node) => {
    if (!node) return null;
    let pad = padCache.get(node);
    if (pad === undefined) {
      const cs = node.ownerDocument.defaultView.getComputedStyle(node);
      pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      padCache.set(node, pad);
    }
    return Math.round((node.clientWidth - pad) * 100) / 100;
  };
  const fillDelta = (child, container) => {
    if (!child || !container) return null;
    const cw = contentWidth(container);
    if (cw === null) return null;
    const outer = Math.round(child.getBoundingClientRect().width * 100) / 100;
    return { child: outer, container: cw, delta: Math.round((outer - cw) * 100) / 100 };
  };
  const widthFill = () => {
    const messages = document.querySelector('#messages');
    if (!messages) return null;
    const out = { messages: fillDelta(messages, messages.parentElement) };
    const firstMessage = messages.querySelector('.message');
    out.message = fillDelta(firstMessage, messages);
    const header = document.querySelector('main > header');
    out.usage = fillDelta(document.getElementById('session-usage'), header);
    out.cwd = fillDelta(document.getElementById('session-cwd'), header);
    out.context = fillDelta(document.getElementById('session-context'), header);
    out.composer = fillDelta(document.getElementById('composer'), document.querySelector('main'));
    // 平铺（业主 2026-09-22）：工具卡是 #messages 的**顶层块**，与 .message 同一套底盘 —— 不再是
    // 「全出血」嵌套元素，所以它现在跟消息块一样进「水平铺满」断言（量与 .message 同一口径）。
    const firstTool = messages.querySelector('.tool-card');
    out.tool = fillDelta(firstTool, messages);
    if (firstTool) {
      // 同一容器里两个顶层块：工具卡与参考消息块的 border-box 宽应当相等（不再有出血差）。
      const reference = firstMessage;
      const cardWidth = Math.round(firstTool.getBoundingClientRect().width * 100) / 100;
      const referenceWidth = reference ? Math.round(reference.getBoundingClientRect().width * 100) / 100 : null;
      out.toolCardBleed = { card: cardWidth, message: referenceWidth, delta: referenceWidth === null ? null : Math.round((cardWidth - referenceWidth) * 100) / 100 };
    }
    out.messagesOverflowX = Math.round((messages.scrollWidth - messages.clientWidth) * 100) / 100;
    const treeList = document.querySelector('[data-active-tree-list="true"]');
    if (treeList) {
      const row = Array.from(treeList.querySelectorAll('.tree-session')).find((node) => parseFloat(node.style.marginInlineStart || '0') === 0);
      out.treeRowUnindented = row ? fillDelta(row, treeList) : null;
    }
    return out;
  };

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        J.shifts.push({ t: now(), value: Math.round(entry.value * 10000) / 10000, hadRecentInput: entry.hadRecentInput,
          sources: (entry.sources || []).map((s) => ({ node: s.node ? (s.node.id ? '#' + s.node.id : (s.node.className || s.node.tagName || '')).toString().slice(0, 40) : null,
            prevTop: s.previousRect ? Math.round(s.previousRect.top) : null, curTop: s.currentRect ? Math.round(s.currentRect.top) : null })) });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (error) { J.layoutShiftError = String(error); }

  const stDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true, enumerable: stDesc.enumerable, get: stDesc.get,
    set(value) {
      if ((this.id === 'messages' || this.dataset?.activeTreeList === 'true') && J.scrollWrites.length < 800) {
        J.scrollWrites.push({ t: now(), target: this.id || 'active-tree-list', from: Math.round(stDesc.get.call(this) * 100) / 100, to: Math.round(Number(value) * 100) / 100,
          stack: (new Error().stack || '').split(String.fromCharCode(10)).slice(1, 6).map((line) => line.trim().replace(/^at +/, '')).join(' ⇐ ') });
      }
      return stDesc.set.call(this, value);
    },
  });

  // 只读包一层：SSE 事件到达 / open / error
  const OrigEventSource = window.EventSource;
  window.EventSource = function (url, config) {
    J.events.push({ t: now(), type: 'es:construct', url: String(url) });
    const instance = new OrigEventSource(url, config);
    instance.addEventListener('open', () => J.events.push({ t: now(), type: 'es:open' }));
    instance.addEventListener('error', () => J.events.push({ t: now(), type: 'es:error', url: String(url) }));
    return instance;
  };
  window.EventSource.prototype = OrigEventSource.prototype;
  window.EventSource.CONNECTING = OrigEventSource.CONNECTING;
  window.EventSource.OPEN = OrigEventSource.OPEN;
  window.EventSource.CLOSED = OrigEventSource.CLOSED;
  const addEventListener = OrigEventSource.prototype.addEventListener;
  OrigEventSource.prototype.addEventListener = function (type, listener, options) {
    const wrapped = typeof listener === 'function' ? function (...args) {
      if (/^session\.|^tree\./.test(type)) {
        let detail = null;
        try {
          const event = args[0];
          if (event && typeof event.data === 'string') { const parsed = JSON.parse(event.data); detail = { channel: parsed.channel, stopReason: parsed.stopReason, toolCallId: parsed.toolCallId, name: parsed.name, delta: typeof parsed.delta === 'string' ? parsed.delta : undefined }; }
        } catch { /* keep null */ }
        J.events.push({ t: now(), type, ...(detail || {}) });
      }
      return listener.apply(this, args);
    } : listener;
    return addEventListener.call(this, type, wrapped, options);
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const at = now();
    const promise = origFetch(input, init);
    if (typeof url === 'string' && (url.includes('/messages') || url.includes('/tree') || /\\/sessions\\/[^/]+$/.test(url) || url.endsWith('/events'))) {
      promise.then((response) => { J.fetches.push({ t: now(), start: at, url, status: response.status }); }).catch(() => {});
    }
    return promise;
  };

  const sample = () => {
    const messages = document.querySelector('#messages');
    if (!messages) return null;
    const pane = messages.parentElement;
    const paneRect = pane ? pane.getBoundingClientRect() : messages.getBoundingClientRect();
    const paneTop = paneRect.top;
    const paneBottom = paneRect.bottom;
    let first = null; let last = null;
    const visible = [];
    let index = 0;
    let lastNode = null;
    for (const node of messages.querySelectorAll('.message')) {
      const r = node.getBoundingClientRect();
      const identity = { index, entryId: node.dataset.entryId ?? null, key: node.dataset.entryId ?? ('i' + index), kind: node.dataset.kind ?? (node.classList.contains('live-message') ? 'live' : 'message') };
      lastNode = node;
      if (r.bottom > paneTop && r.top < paneBottom) {
        const item = { top: num(r.top), bottom: num(r.bottom), ...identity };
        visible.push(item);
        if (!first) first = item;
        last = item;
      }
      index += 1;
    }
    // 稳定锚：**最后一条正文**（DOM 里最后一个 .message）的 top/bottom —— 不管上面补进来多少条，它是同一条。
    const lastBox = lastNode ? lastNode.getBoundingClientRect() : null;
    const treeList = document.querySelector('[data-active-tree-list="true"]');
    let treeAnchor = null;
    if (treeList) {
      const r = treeList.getBoundingClientRect();
      const probeY = r.top + Math.min(120, Math.max(10, r.height * 0.3));
      let ti = 0;
      for (const row of treeList.querySelectorAll('.tree-session')) {
        const rb = row.getBoundingClientRect();
        if (!treeAnchor && rb.top <= probeY && rb.bottom > probeY) treeAnchor = { id: row.dataset.sessionId, top: num(rb.top), index: ti };
        ti += 1;
      }
    }
    return {
      t: now(),
      scrollHeight: num(messages.scrollHeight), scrollTop: num(messages.scrollTop), clientHeight: num(messages.clientHeight),
      dist: num(messages.scrollHeight - messages.scrollTop - messages.clientHeight),
      paneTop: num(paneRect.top), paneHeight: pane ? num(pane.clientHeight) : null,
      paneRect: { top: num(paneRect.top), bottom: num(paneRect.bottom), left: num(paneRect.left), right: num(paneRect.right) },
      header: box(document.querySelector('main > header')),
      headerParts: (() => {
        const out = {};
        for (const id of ['session-title', 'session-cwd', 'session-usage', 'session-context', 'session-connection', 'rename-form', 'compact-confirm']) {
          const node = document.getElementById(id);
          if (!node) continue;
          const r = node.getBoundingClientRect();
          out[id] = { hidden: node.hidden === true, display: (node.ownerDocument.defaultView.getComputedStyle(node).display), top: num(r.top), height: num(r.height), text: (node.textContent || '').slice(0, 24) };
        }
        const actions = document.querySelector('.session-actions');
        if (actions) { const r = actions.getBoundingClientRect(); out['session-actions'] = { top: num(r.top), height: num(r.height) }; }
        return out;
      })(),
      usage: box(document.querySelector('#session-usage')),
      composer: box(document.querySelector('#composer')),
      notice: box(document.querySelector('#notice')),
      queue: box(document.querySelector('#queue-status')),
      connection: (document.querySelector('#session-connection') || {}).textContent ?? null,
      counts: {
        messages: messages.querySelectorAll('.message').length,
        live: messages.querySelectorAll('.live-message').length,
        thinking: messages.querySelectorAll('.message-thinking').length,
        tools: messages.querySelectorAll('.tool-card').length,
        thinkPlaceholder: messages.querySelectorAll('.think[data-think="live"]').length,
      },
      renderComplete: messages.dataset.renderComplete === 'true',
      total: messages.dataset.messageTotal ?? null,
      first, last, visibleCount: visible.length,
      lastMessage: lastBox ? { top: num(lastBox.top), bottom: num(lastBox.bottom), gapToPaneBottom: num(paneBottom - lastBox.bottom), entryId: lastNode.dataset.entryId ?? null, kind: lastNode.classList.contains('live-message') ? 'live' : 'message' } : null,
      tree: treeList ? { scrollTop: num(treeList.scrollTop), scrollHeight: num(treeList.scrollHeight), top: num(treeList.getBoundingClientRect().top), firstRowTop: treeList.firstElementChild ? num(treeList.firstElementChild.getBoundingClientRect().top) : null, anchorId: treeAnchor?.id ?? null, anchorTop: treeAnchor?.top ?? null, anchorIndex: treeAnchor?.index ?? null, rows: treeList.querySelectorAll('.tree-session').length } : null,
      treeContainerTop: (() => { const node = document.getElementById('tree'); return node ? num(node.getBoundingClientRect().top) : null; })(),
      widthFill: widthFill(),
      devicesHeight: (() => { const node = document.getElementById('device-panel'); return node ? num(node.getBoundingClientRect().height) : null; })(),
      asideParts: (() => {
        const out = {};
        for (const id of ['tree-search', 'new-session-panel', 'device-panel', 'tree', 'tree-connection']) {
          const node = document.getElementById(id);
          if (!node) continue;
          const r = node.getBoundingClientRect();
          out[id] = { hidden: node.hidden === true, top: num(r.top), height: num(r.height), text: (node.textContent || '').slice(0, 20) };
        }
        return out;
      })(),
    };
  };
  J.sampleOnce = sample;
  J.start = () => { J.frames = []; J.sampling = true; const step = () => { if (!J.sampling) return; const value = sample(); if (value) J.frames.push(value); requestAnimationFrame(step); }; requestAnimationFrame(step); };
  J.stop = () => { J.sampling = false; };
  J.collect = () => ({ frames: J.frames, events: J.events, fetches: J.fetches, scrollWrites: J.scrollWrites, shifts: J.shifts, layoutShiftError: J.layoutShiftError ?? null });
  J.reset = () => { J.frames = []; J.events = []; J.fetches = []; J.scrollWrites = []; J.shifts = []; };
})();`;

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
        const listener = (params) => { listeners.get(method).delete(listener); resolve(params); };
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

async function main() {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-jump-real-'));
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const cwd = path.join(sandbox, 'cwd');
  const cleanupProblems = [];
  const pageProblems = [];
  let server;
  let chromium;
  let browser;
  let baseChild;
  let appChild;
  let basePort;
  let appPort;
  let report = null;
  const startedAt = Date.now();

  const evaluate = async (expression) => {
    const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
    return result.result.value;
  };
  const frames = (count = 3) => evaluate(`new Promise((resolve)=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
  const sleepFrames = async (count) => { await evaluate(`new Promise((resolve)=>{setTimeout(resolve,${count})})`); };

  try {
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const seed = await seedSessions(sessionsRoot);
    basePort = await reservePort();
    appPort = await reservePort();
    providerPort = await reservePort();
    providerServer = await startFakeProvider();

    await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
      providers: {
        litellm: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          api: 'openai-completions',
          apiKey: 'sandbox-key',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: 'deepseek-flash', name: 'Fake DeepSeek Flash', contextWindow: 1000000, maxTokens: 32000 }],
        },
      },
    }, null, 2)}\n`);
    await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
      defaultProvider: 'litellm',
      defaultModel: 'deepseek-flash',
      defaultThinkingLevel: 'off',
      compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    }, null, 2)}\n`);
    await writeFile(path.join(home, 'seen.json'), '{}\n');

    const baseLogPath = path.join(sandbox, 'base.log');
    const appLogPath = path.join(sandbox, 'app.log');
    const baseLog = await open(baseLogPath, 'w');
    const appLog = await open(appLogPath, 'w');
    const commonEnv = {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_DEFAULT_CWD: cwd,
      SOPHO_NO_TOOLS: '1',
    };
    baseChild = spawn(process.execPath, [baseEntry], { cwd: sourceRoot, env: { ...commonEnv, SOPHO_PORT: String(basePort) }, stdio: ['ignore', baseLog.fd, baseLog.fd] });
    appChild = spawn(process.execPath, [appEntry], {
      cwd: sourceRoot,
      env: { ...commonEnv, SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort), SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(basePort), SOPHO_WEB_ROOT: webRoot },
      stdio: ['ignore', appLog.fd, appLog.fd],
    });

    const api = async (pathname, init = {}) => {
      const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
      const text = await response.text();
      let value = null;
      try { value = text ? JSON.parse(text) : null; } catch { value = text; }
      return { statusCode: response.status, value };
    };
    await waitFor(async () => (await api('/host')).statusCode === 200, 'host did not come up', 90000);

    const tree = await waitFor(async () => {
      const response = await api('/tree');
      return response.statusCode === 200 ? response.value : null;
    }, 'tree did not load', 90000);
    const rows = tree.sessions || [];
    const byId = new Map(rows.map((row) => [row.id, row]));

    // 选会话：最重的（按 sandbox 文件大小）、有图的那条、轻的。
    const fileSizes = new Map();
    for (const name of await readdir(sessionsRoot)) {
      const info = await stat(path.join(sessionsRoot, name));
      fileSizes.set(name.replace(/^.*_/, '').replace(/\.jsonl$/, ''), info.size);
    }
    const imageIds = [];
    for (const name of await readdir(sessionsRoot)) {
      const text = await readFile(path.join(sessionsRoot, name), 'utf8');
      if (text.includes('"type":"image"') || text.includes('"data:image')) imageIds.push(name.replace(/^.*_/, '').replace(/\.jsonl$/, ''));
    }
    const sorted = [...rows].sort((a, b) => (fileSizes.get(b.id) ?? 0) - (fileSizes.get(a.id) ?? 0));
    const heavy = sorted[0];
    // 轻会话：文件小、根会话、且真的有正文（空会话不需要画任何消息）。
    let light = null;
    const pickLight = async (availableIds) => {
      for (const row of [...rows].sort((a, b) => (fileSizes.get(a.id) ?? 0) - (fileSizes.get(b.id) ?? 0))) {
        const size = fileSizes.get(row.id) ?? 0;
        if (row.parentId !== null || row.archived === true || size < 4_000 || size > 300_000) continue;
        if (availableIds && !availableIds.has(row.id)) continue;
        const detail = await api(`/sessions/${row.id}`);
        if (detail.statusCode !== 200) continue;
        const probe = await api(`/sessions/${row.id}/messages`);
        const count = Array.isArray(probe.value?.messages) ? probe.value.messages.length : 0;
        if (probe.statusCode === 200 && count >= 4 && count <= 80) { light = row; break; }
      }
      light ??= sorted[sorted.length - 1];
      return light;
    };
    const imageRow = [...rows].filter((row) => imageIds.includes(row.id)).sort((a, b) => (fileSizes.get(b.id) ?? 0) - (fileSizes.get(a.id) ?? 0))[0] ?? null;

    report = {
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, loadavg: os.loadavg(), chromium: process.env.CHROME_BIN || '/usr/bin/chromium' },
      fixture: { source: REAL_SESSIONS, copyMode: COPY_MODE, files: seed.files, bytes: seed.bytes, treeSessions: rows.length },
      sessions: {
        heavy: heavy ? { id: heavy.id, name: heavy.name, bytes: fileSizes.get(heavy.id) ?? null } : null,
        light: null,
        image: imageRow ? { id: imageRow.id, name: imageRow.name, bytes: fileSizes.get(imageRow.id) ?? null } : null,
      },
      cells: {},
      providerRequests: [],
    };

    // ── Chromium ──
    const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
    const debugPort = await reservePort();
    chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
    const version = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
      return response?.ok ? response.json() : null;
    }, 'Chromium remote debugger did not start', 30000);
    report.environment.browser = version.Browser;
    // 隔离实验用：显式给一个 CSS 补丁文件路径才注入（例如关掉 content-visibility 看漂移是不是它）。
    const cssPatchFile = process.env.SOPHO_JUMP_CSS_PATCH || null;
    const cssPatch = cssPatchFile ? await readFile(cssPatchFile, 'utf8') : '';
    report.environment.cssPatch = cssPatchFile ? { file: cssPatchFile, bytes: cssPatch.length } : null;
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    browser = cdp(target.webSocketDebuggerUrl, pageProblems);
    await browser.ready;
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    await browser.send('Network.enable');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    if (cssPatch) {
      await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const apply = () => { if (!document.documentElement) return false; const style = document.createElement('style'); style.textContent = ${JSON.stringify(cssPatch)}; document.documentElement.append(style); document.documentElement.dataset.jumpCssPatch = '1'; return true; }; if (!apply()) { const timer = setInterval(() => { if (apply()) clearInterval(timer); }, 0); } })();` });
    }

    const pageBaseUrl = `http://127.0.0.1:${appPort}/`;
    const freshPage = async () => {
      const loaded = browser.once('Page.loadEventFired');
      await browser.send('Page.navigate', { url: pageBaseUrl });
      await loaded;
      await waitFor(() => evaluate(`document.querySelector('#messages') !== null`), 'page did not load');
    };
    await freshPage();
    await waitFor(() => evaluate(`document.querySelector('.tree-session') !== null`), 'tree did not render');
    // 选轻会话：要在**已经画进树的**行里选（归档/折叠掉的行点不到）。
    const renderedIds = new Set(await evaluate(`Array.from(document.querySelectorAll('.tree-session')).map((node) => node.dataset.sessionId)`));
    if (cssPatch) report.environment.cssPatchApplied = await evaluate(`document.documentElement.dataset.jumpCssPatch === '1'`);
    const lightRow = await pickLight(renderedIds);
    report.sessions.light = lightRow ? { id: lightRow.id, name: lightRow.name, bytes: fileSizes.get(lightRow.id) ?? null } : null;
    const lightId = lightRow?.id ?? null;

    const clickSession = (id) => `(() => { const row = document.querySelector('[data-session-id="${id}"] .tree-select'); if (!row) return false; row.click(); return true; })()`;

    const sampleOnce = () => evaluate('window.__jd.sampleOnce()');
    const resetInstrument = () => evaluate('window.__jd.reset()');
    const startInstrument = () => evaluate('window.__jd.start()');
    const collect = async () => evaluate('(() => { window.__jd.stop(); return window.__jd.collect(); })()');

    // 消息总数（从真 API 拿）
    const messageCount = async (id) => {
      const response = await api(`/sessions/${id}/messages`);
      return { status: response.statusCode, count: Array.isArray(response.value?.messages) ? response.value.messages.length : null, bytes: JSON.stringify(response.value ?? '').length };
    };

    const waitQuiet = async (id, timeoutMs = 180000) => {
      let last = null;
      let stable = 0;
      try {
        await waitFor(async () => {
          const state = await evaluate(`(() => { const m=document.querySelector('#messages'); return { complete: m.dataset.renderComplete === 'true', dom: m.querySelectorAll('.message').length, total: m.dataset.messageTotal ?? null }; })()`);
          if (state.complete && last && state.dom === last.dom) stable += 1; else stable = 0;
          last = state;
          return stable >= 3;
        }, `did not settle (${id})`, timeoutMs);
      } catch (error) {
        throw new Error(`${error.message}; last=${JSON.stringify(last)}`);
      }
      return last;
    };

    // 起一轮流：给会话发一条消息，等 isStreaming 变真。
    const startStreamingTurn = async (id) => {
      const before = (await api(`/sessions/${id}`)).value?.runtime?.isStreaming === true;
      const posted = await api(`/sessions/${id}/message`, { method: 'POST', body: JSON.stringify({ text: 'REALDATA-JUMP-PROBE: 请用一段较长的 markdown 回复，先沉默几秒再输出。' }) });
      await waitFor(async () => (await api(`/sessions/${id}`)).value?.runtime?.isStreaming === true, 'session never became streaming', 60000);
      return { before, posted: posted.statusCode };
    };
    const waitStreamingDone = (id, timeoutMs = 180000) => waitFor(async () => (await api(`/sessions/${id}`)).value?.runtime?.isStreaming === false, 'stream did not finish', timeoutMs);

    // screencast 收集器
    const startScreencast = async (timeOrigin) => {
      const collected = [];
      let ackError = null;
      const off = browser.on('Page.screencastFrame', (params) => {
        collected.push({ t: Math.round((params.metadata.timestamp * 1000 - timeOrigin) * 10) / 10, data: params.data, sessionId: params.sessionId });
        browser.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch((error) => { ackError = error.message; });
      });
      await browser.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1200, maxHeight: 900 });
      return { collected, stop: async () => { await browser.send('Page.stopScreencast'); off(); return { frames: collected, ackError }; } };
    };

    // ── 跑一格 ──
    const runCell = async (cell) => {
      process.stdout.write(`\n… cell ${cell.name}\n`);
      await browser.send('Emulation.setDeviceMetricsOverride', { width: cell.width ?? 1200, height: cell.height ?? 760, deviceScaleFactor: 1, mobile: false });
      await freshPage();
      await waitFor(() => evaluate(`document.querySelector('[data-session-id="${cell.id}"]') !== null`), `row for ${cell.id} missing`);
      const counting = await messageCount(cell.id);
      const expect = counting.count;
      let streaming = null;
      if (cell.preClickId) {
        // 热路径前置：先把另一个会话打开（同一个页面、不经整页重开），再点目标会话。
        await evaluate(clickSession(cell.preClickId));
        try { await waitQuiet(cell.preClickId, 30000); } catch (error) { process.stdout.write(`   (pre-click 会话未静置：${error.message})\n`); }
      }
      if (cell.mode === 'stream-open' || cell.mode === 'stream-reconnect') {
        streaming = await startStreamingTurn(cell.id);
        // 等真的开始发（session.start 由 agent_start 触发；这里等 runtime 报 streaming 就够）
        await sleep(250);
      }
      await resetInstrument();
      const timeOrigin = await evaluate('performance.timeOrigin');
      const screencast = await startScreencast(timeOrigin);
      const startedClock = await evaluate('Math.round(performance.now()*100)/100');
      await startInstrument();
      await evaluate(clickSession(cell.id));
      const openedClock = await evaluate('Math.round(performance.now()*100)/100');
      // 等首屏出现
      let settleError = null;
      try {
        await waitFor(() => evaluate(`document.querySelector('#messages .message') !== null`), 'no message painted', 60000);
      } catch (error) { settleError = `no-first-paint: ${error.message}`; }
      if (cell.sticky === false) {
        // 不贴底：滚到 35% 处（等补齐完再滚，否则会被后续 prepend 覆盖）
        await waitQuiet(cell.id);
        await evaluate(`(() => { const n=document.querySelector('#messages'); n.scrollTop = Math.round((n.scrollHeight - n.clientHeight) * 0.35); n.dispatchEvent(new Event('scroll')); window.__jd.events.push({ t: performance.now(), type: 'test:manual-scroll', to: n.scrollTop }); return n.scrollTop; })()`);
        await frames(3);
      }
      if (cell.mode === 'stream-reconnect') {
        // 等直播块真的出现（说明在流式中）
        await waitFor(() => evaluate(`document.querySelector('#messages .live-message') !== null || document.querySelector('#messages .think[data-think="live"]') !== null`), 'live block never appeared', 60000);
        await sleep(600);
        // 杀掉 SSE：整页离线 ⇒ EventSource error ⇒ 恢复后自动重连
        await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await sleep(1200);
        await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      }
      if (cell.mode === 'stream-open' || cell.mode === 'stream-reconnect') {
        try { await waitFor(() => evaluate(`document.querySelector('#messages .live-message') !== null || document.querySelector('#messages .think[data-think="live"]') !== null`), 'live block missing', 60000); } catch (error) { settleError ??= `no-live-block: ${error.message}`; }
        await waitStreamingDone(cell.id);
        // 收尾那一刻：session.end/settled 会触发一次 refreshMessages → 渐进重画（先只留尾批）→ 空闲期补旧→贴底。
        // 这一段必须把采样窗拉长才量得到（否则 collect 落在补旧之前）。
        await sleep(Number(process.env.SOPHO_JUMP_POST_MS ?? 7000));
      }
      try { await waitQuiet(cell.id, 180000); } catch (error) { settleError ??= `no-settle: ${error.message}`; }
      await frames(8);
      const collected = await collect();
      const screencastResult = await screencast.stop();
      const finalShot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      const safe = cell.name.replace(/[^0-9A-Za-z._-]/g, '_');
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(path.join(artifactRoot, `settled-${safe}.png`), Buffer.from(finalShot.data, 'base64'));
      const screenshotFrames = [];
      for (const [index, frame] of screencastResult.frames.entries()) {
        const bytes = Buffer.from(frame.data, 'base64');
        const file = path.join(artifactRoot, `frame-${safe}-${String(index).padStart(3, '0')}-t${Math.round(frame.t)}.png`);
        await writeFile(file, bytes);
        screenshotFrames.push({ t: frame.t, file, bytes });
      }
      const analysis = analyseCell(collected, screenshotFrames, expect, cell);
      report.cells[cell.name] = {
        cell,
        expectedCount: expect,
        messagesPayloadBytes: counting.bytes,
        streaming,
        settleError,
        clock: { timeOrigin, startedClock, openedClock },
        frameCount: collected.frames.length,
        events: collected.events,
        fetches: collected.fetches.map((entry) => ({ t: entry.t, url: entry.url.replace(/^https?:\/\/[^/]+\/api/, '/api'), status: entry.status })),
        scrollWrites: collected.scrollWrites,
        shifts: collected.shifts,
        cls: Math.round(collected.shifts.filter((shift) => !shift.hadRecentInput).reduce((sum, shift) => sum + shift.value, 0) * 10000) / 10000,
        animationFrameCount: screenshotFrames.length,
        domAnimationFrames: collected.frames.map((frame) => ({ t: frame.t, scrollTop: frame.scrollTop, scrollHeight: frame.scrollHeight, dist: frame.dist, lastTop: frame.lastMessage?.top ?? null, counts: frame.counts, usageTop: frame.usage?.top ?? null, composerTop: frame.composer?.top ?? null, headerHeight: frame.header?.height ?? null, headerParts: frame.headerParts ?? null, asideParts: frame.asideParts ?? null, widthFill: frame.widthFill ?? null, treeTop: frame.tree?.top ?? null, treeAnchor: frame.tree?.anchorId ?? null, treeAnchorTop: frame.tree?.anchorTop ?? null, first: frame.first ?? null })),
        ...analysis,
      };
      process.stdout.write(`   ⇒ frames(dom)=${collected.frames.length} frames(screen)=${screenshotFrames.length} maxRegionΔ=${analysis.maxRegionDeltaPx}px maxReaderJump=${analysis.maxReaderJumpPx}px maxScreenShift=${analysis.maxScreenShiftPx}px maxScreenDiff=${analysis.maxScreenDiff.value}\n`);
      return report.cells[cell.name];
    };

    // ── 矩阵 ──
    const heavyId = report.sessions.heavy?.id;
    const imageId = report.sessions.image?.id ?? heavyId;
    const cells = [
      { name: 'cold-heavy-sticky', id: heavyId, mode: 'cold', sticky: true, width: 1200, height: 760, note: '冷开最重会话（2237 条 / 15.5MB）· 贴底 · 1200×760' },
      { name: 'cold-heavy-mid', id: heavyId, mode: 'cold', sticky: false, width: 1200, height: 760, note: '冷开最重会话 · 不贴底（滚到 35%）' },
      { name: 'switch-hot-heavy', id: heavyId, preClickId: lightId, mode: 'cold', sticky: true, width: 1200, height: 760, note: '先开轻会话，再切到最重会话（热路径）' },
      { name: 'stream-open-heavy-bottom', id: heavyId, mode: 'stream-open', sticky: true, width: 1200, height: 760, note: '★打开时那一轮正在流式 · 贴底' },
      { name: 'stream-open-heavy-mid', id: heavyId, mode: 'stream-open', sticky: false, width: 1200, height: 760, note: '★打开时那一轮正在流式 · 不贴底' },
      { name: 'stream-reconnect-heavy', id: heavyId, mode: 'stream-reconnect', sticky: true, width: 1200, height: 760, note: '★流式中杀掉 SSE（离线）再自动重连' },
      { name: 'cold-image-session', id: imageId, mode: 'cold', sticky: true, width: 1200, height: 760, note: '冷开含图片块的会话（异步内容）' },
      { name: 'cold-light', id: lightId, mode: 'cold', sticky: true, width: 1200, height: 760, note: '冷开轻会话（对照）' },
      { name: 'cold-heavy-narrow420', id: heavyId, mode: 'cold', sticky: true, width: 420, height: 820, note: '冷开最重会话 · 420×820（窄屏换行）' },
      { name: 'stream-open-narrow420', id: heavyId, mode: 'stream-open', sticky: true, width: 420, height: 820, note: '★流式打开 · 420×820' },
    ].filter((cell) => cell.id && (!onlyCells || onlyCells.has(cell.name)));

    for (const cell of cells) {
      await runCell(cell);
    }

    report.pageProblems = pageProblems;
    report.providerRequests = providerServer.requests;
    report.durationMs = Date.now() - startedAt;
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, 'stream-jump-realdata.json'), `${JSON.stringify(report, null, 2)}\n`);

    // ── 门 ──
    const failures = [];
    let checks = 0;
    const check = (name, ok, detail) => {
      checks += 1;
      if (!ok) { failures.push(`${name}：${detail}`); return; }
      process.stdout.write(`✓ ${name} —— ${detail}\n`);
    };
    if (assertMode) {
      for (const required of LIMITS.requireCells) {
        check(`覆盖矩阵里有 ${required}`, Boolean(report.cells[required]) && !report.cells[required].settleError, report.cells[required] ? String(report.cells[required].settleError ?? 'ok') : Object.keys(report.cells).join(','));
      }
      for (const [name, result] of Object.entries(report.cells)) {
        if (!LIMITS.requireCells.includes(name)) { process.stdout.write(`… ${name} 只记录不断言（非覆盖矩阵必需的格${result.settleError ? `；settleError=${result.settleError}` : ''}）\n`); continue; }
        check(`${name}｜区域布局逐帧 Δpx ≤ ${LIMITS.layoutPx}`, result.maxLayoutDeltaPx <= LIMITS.layoutPx, `max=${result.maxLayoutDeltaPx}px (${result.maxLayoutDeltaDetail})`);
        check(`${name}｜贴底格锚被抽走的位数 ≤ ${LIMITS.swapPullPx}`, result.maxSwapPullPx <= LIMITS.swapPullPx, `max=${result.maxSwapPullPx}px (${result.maxSwapPullDetail})`);
        check(`${name}｜读者阅读锚逐帧位移 ≤ ${LIMITS.anchorPx}`, result.maxAnchorMovePx <= LIMITS.anchorPx, `max=${result.maxAnchorMovePx}px (${result.maxAnchorMoveDetail})`);
        check(`${name}｜水平铺满：受检区域 vs 容器内容宽差 ≤ ${LIMITS.widthFillPx}`, result.maxWidthFillDeltaPx <= LIMITS.widthFillPx, `max=${result.maxWidthFillDeltaPx}px (${result.maxWidthFillDetail})`);
        check(`${name}｜正文容器无横向溢出`, result.maxMessagesOverflowXPx <= 1, `scrollWidth-clientWidth max=${result.maxMessagesOverflowXPx}px (${result.maxMessagesOverflowXDetail})`);
      }
      check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems.slice(0, 5)));
    }
    report.checks = { count: checks, failures, limits: LIMITS };

    process.stdout.write('\n── 汇总 ──\n');
    for (const [name, result] of Object.entries(report.cells)) {
      process.stdout.write(`${name} :: 布局Δmax=${result.maxLayoutDeltaPx}px · 侧栏位移max=${result.maxSidebarShiftPx}px · 锚位移max=${result.maxAnchorMovePx}px (${result.maxAnchorMoveDetail}) · 贴底被抽走max=${result.maxSwapPullPx}px · 水平铺满差max=${result.maxWidthFillDeltaPx}px · 屏幕位移max=${result.maxScreenShiftPx}px · 屏幕差max=${result.maxScreenDiff.value} · 事件=${result.eventTimeline.slice(0, 6).join(' ')}\n`);
    }
    process.stdout.write(`fixture: ${report.fixture.files} files / ${(report.fixture.bytes / 1048576).toFixed(1)}MB · tree=${report.fixture.treeSessions} sessions\n`);
    process.stdout.write(`artifact: ${artifactRoot}\n`);
    if (assertMode) {
      process.stdout.write(`checks ${checks}${failures.length ? ` FAIL: ${failures.join(' | ')}` : ' PASS'}\n`);
      if (failures.length) throw new Error(`stream-jump realdata gate failed: ${failures.join(' | ')}`);
    }
    return report;
  } finally {
    await cleanupStep(cleanupProblems, 'quiesce page', () => quiesceCdpPage(browser));
    await cleanupStep(cleanupProblems, 'close browser', () => browser?.close());
    if (chromium && chromium.exitCode === null) {
      await cleanupStep(cleanupProblems, 'stop chromium', async () => { chromium.kill('SIGTERM'); await new Promise((resolve) => chromium.once('exit', resolve)); });
    }
    if (appChild && appChild.exitCode === null) await cleanupStep(cleanupProblems, 'stop app', async () => { appChild.kill('SIGTERM'); await new Promise((resolve) => appChild.once('exit', resolve)); });
    if (baseChild && baseChild.exitCode === null) await cleanupStep(cleanupProblems, 'stop base', async () => { baseChild.kill('SIGTERM'); await new Promise((resolve) => baseChild.once('exit', resolve)); });
    if (providerServer?.server) await cleanupStep(cleanupProblems, 'close provider', async () => { providerServer.server.closeAllConnections(); await new Promise((resolve) => providerServer.server.close(resolve)); });
    await removeSandbox(sandbox, cleanupProblems);
    finishCleanup(null, cleanupProblems);
  }
}

// ── 分析：逐帧 Δpx（各区域）+ screencast 逐帧像素位移 ──────────────────────────
const REGION_KEYS = [
  ['usageTop', (frame) => frame.usage?.top ?? null],
  ['composerTop', (frame) => frame.composer?.top ?? null],
  ['headerHeight', (frame) => frame.header?.height ?? null],
  ['noticeHeight', (frame) => frame.notice?.height ?? null],
  ['paneTop', (frame) => frame.paneTop],
  ['treeScrollTop', (frame) => frame.tree?.scrollTop ?? null],
  ['treeAnchorTop', (frame) => frame.tree?.anchorTop ?? null],
];
// 只记录、不进门的区域（它们是「内容增长 / 底部跟随」的信息量，不是等价于「可见内容被挪了」）。
const INFO_KEYS = [
  ['scrollHeight', (frame) => frame.scrollHeight],
  ['scrollTop', (frame) => frame.scrollTop],
  ['dist', (frame) => frame.dist],
  ['lastMessageTop', (frame) => frame.lastMessage?.top ?? null],
  ['lastMessageGap', (frame) => frame.lastMessage?.gapToPaneBottom ?? null],
];

function analyseCell(collected, screenshotFrames, expect, cell) {
  const frames = collected.frames;
  const events = collected.events;
  const regionDeltas = {};
  const infoDeltas = {};
  const viewChanges = [];
  const maxRegion = { px: 0, detail: 'none' };
  const maxInfo = { px: 0, detail: 'none' };
  const maxLayout = { px: 0, detail: 'none' };
  const maxSidebar = { px: 0, detail: 'none' };
  const LAYOUT_KEYS = new Set(['usageTop', 'composerTop', 'headerHeight', 'noticeHeight', 'paneTop', 'treeScrollTop']);
  const SIDEBAR_KEYS = new Set(['treeAnchorTop', 'treeContainerTop', 'devicesHeight']);
  // 水平铺满：逐帧取每个受检区域与其容器内容宽的差的最大绝对值。
  const widthFillMax = {};
  let maxBleed = { px: 0, detail: 'none' };
  let maxOverflowX = { px: 0, detail: 'none' };
  for (const frame of frames) {
    if (typeof frame.widthFill?.messagesOverflowX === 'number' && Math.abs(frame.widthFill.messagesOverflowX) > maxOverflowX.px) {
      maxOverflowX = { px: Math.abs(frame.widthFill.messagesOverflowX), detail: `#messages scrollWidth-clientWidth=${frame.widthFill.messagesOverflowX}px @t=${frame.t}` };
    }
    const bleed = frame.widthFill?.toolCardBleed;
    if (bleed && typeof bleed.delta === 'number' && Math.abs(bleed.delta) > maxBleed.px) {
      maxBleed = { px: Math.abs(bleed.delta), detail: `tool-card=${bleed.card}px vs .message=${bleed.message}px Δ=${bleed.delta}px @t=${frame.t}` };
    }
    for (const [key, value] of Object.entries(frame.widthFill || {})) {
      if (key === 'toolCardBleed' || key === 'messagesOverflowX') continue;
      if (!value || typeof value.delta !== 'number') continue;
      const abs = Math.abs(value.delta);
      const current = widthFillMax[key];
      if (!current || abs > current.px) widthFillMax[key] = { px: abs, delta: value.delta, child: value.child, container: value.container, t: frame.t, frame: frames.indexOf(frame) };
    }
  }
  let maxWidthFill = { px: 0, detail: 'none' };
  for (const [key, value] of Object.entries(widthFillMax)) {
    if (value.px > maxWidthFill.px) maxWidthFill = { px: value.px, detail: `${key} 子=${value.child}px vs 容器内容宽=${value.container}px Δ=${value.delta}px @t=${value.t}` };
  }
  for (let index = 1; index < frames.length; index += 1) {
    const prev = frames[index - 1];
    const cur = frames[index];
    const push = (bucket, key, delta) => {
      (bucket[key] ??= []).push({ frame: index, t: cur.t, delta, afterEvent: lastEventBefore(events, cur.t) });
    };
    for (const [key, get] of REGION_KEYS) {
      const a = get(prev);
      const b = get(cur);
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      const delta = Math.round((b - a) * 100) / 100;
      if (delta === 0) continue;
      push(regionDeltas, key, delta);
    }
    for (const key of ['treeContainerTop', 'devicesHeight']) {
      const a = prev[key];
      const b = cur[key];
      if (typeof a !== 'number' || typeof b !== 'number' || a === b) continue;
      push(regionDeltas, key, Math.round((b - a) * 100) / 100);
    }
    // 顶栏每一行的高度变化（「哪一行长出来了」的直接证据）。
    for (const id of ['session-title', 'session-cwd', 'session-usage', 'session-context', 'session-connection']) {
      const a = prev.headerParts?.[id];
      const b = cur.headerParts?.[id];
      if (!a || !b || a.height === b.height) continue;
      push(regionDeltas, `header:${id}`, Math.round((b.height - a.height) * 100) / 100);
    }
    for (const [key, get] of INFO_KEYS) {
      const a = get(prev);
      const b = get(cur);
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      const delta = Math.round((b - a) * 100) / 100;
      if (delta === 0) continue;
      push(infoDeltas, key, delta);
    }
    // 阅读锚（视口顶部那条消息）：**同一条**才有可比性 —— 它的 top 变化就是读者眼睛里的位移。
    if (prev.first && cur.first) {
      if (prev.first.key === cur.first.key) {
        const delta = Math.round((cur.first.top - prev.first.top) * 100) / 100;
        if (delta !== 0) push(regionDeltas, 'viewAnchorTop', delta);
      } else {
        viewChanges.push({ frame: index, t: cur.t, from: prev.first.key, to: cur.first.key, fromTop: prev.first.top, toTop: cur.first.top,
          scrollTopDelta: Math.round((cur.scrollTop - prev.scrollTop) * 100) / 100, scrollHeightDelta: Math.round((cur.scrollHeight - prev.scrollHeight) * 100) / 100,
          distBefore: prev.dist, distAfter: cur.dist, afterEvent: lastEventBefore(events, cur.t) });
      }
    }
  }
  for (const [key, list] of Object.entries(regionDeltas)) {
    for (const entry of list) {
      if (Math.abs(entry.delta) > maxRegion.px) { maxRegion.px = Math.abs(entry.delta); maxRegion.detail = `${key}@frame${entry.frame}(t=${entry.t})Δ=${entry.delta}px ${entry.afterEvent ?? ''}`; }
      const isLayout = LAYOUT_KEYS.has(key) || key.startsWith('header:');
      if (isLayout && Math.abs(entry.delta) > maxLayout.px) { maxLayout.px = Math.abs(entry.delta); maxLayout.detail = `${key}@frame${entry.frame}(t=${entry.t})Δ=${entry.delta}px ${entry.afterEvent ?? ''}`; }
      if (SIDEBAR_KEYS.has(key) && Math.abs(entry.delta) > maxSidebar.px) { maxSidebar.px = Math.abs(entry.delta); maxSidebar.detail = `${key}@frame${entry.frame}(t=${entry.t})Δ=${entry.delta}px ${entry.afterEvent ?? ''}`; }
    }
  }
  for (const [key, list] of Object.entries(infoDeltas)) {
    for (const entry of list) {
      if (Math.abs(entry.delta) > maxInfo.px) { maxInfo.px = Math.abs(entry.delta); maxInfo.detail = `${key}@frame${entry.frame}(t=${entry.t})Δ=${entry.delta}px ${entry.afterEvent ?? ''}`; }
    }
  }
  // 屏幕位移：相邻 screencast 帧在正文区的行剖面 SAD argmin
  const paneRect = frames[0]?.paneRect ?? { top: 80, bottom: 700, left: 260, right: 1200 };
  const screenShifts = [];
  let maxShift = { px: 0, detail: 'none' };
  let maxDiff = { value: 0, detail: 'none' };
  const decoded = [];
  for (const frame of screenshotFrames) {
    try { decoded.push({ t: frame.t, image: decodePng(frame.bytes), file: frame.file }); }
    catch (error) { decoded.push({ t: frame.t, error: error.message, file: frame.file }); }
  }
  for (let index = 1; index < decoded.length; index += 1) {
    const prev = decoded[index - 1];
    const cur = decoded[index];
    if (prev.error || cur.error) { screenShifts.push({ t: cur.t, error: prev.error || cur.error }); continue; }
    if (prev.image.width !== cur.image.width || prev.image.height !== cur.image.height) continue;
    let shift = null;
    let bands = null;
    let meanDiff = null;
    try {
      shift = estimateVerticalShift(prev.image, cur.image, paneRect, 80);
      bands = bandDiff(cur.image, prev.image, paneRect, 6);
      meanDiff = Math.round((bands.reduce((sum, value) => sum + value, 0) / bands.length) * 100) / 100;
    } catch (error) { shift = { error: error.message }; }
    const entry = { t: cur.t, from: path.basename(prev.file), to: path.basename(cur.file), shift, bands, meanDiff };
    screenShifts.push(entry);
    if (typeof shift?.px === 'number' && Math.abs(shift.px) > Math.abs(maxShift.px)) {
      maxShift = { px: shift.px, detail: `t=${cur.t} sad@0=${shift.sad0} sad@best=${shift.sadBest} (${path.basename(cur.file)})` };
    }
    if (typeof meanDiff === 'number' && meanDiff > maxDiff.value) {
      maxDiff = { value: meanDiff, detail: `t=${cur.t} bands=[${bands.join(', ')}] (${path.basename(prev.file)}→${path.basename(cur.file)})` };
    }
  }
  const eventTimeline = events.map((event) => `${event.type}@+${event.t}ms`);
  // 读者眼里的位移（只看同一阅读锚；锚换了人就不叫“位移”，改报“被抽掉多少 px”）。
  const sticky = cell.sticky !== false;
  const manualScrollAt = events.find((event) => event.type === 'test:manual-scroll')?.t ?? null;
  let maxAnchorMove = { px: 0, detail: 'none' };
  let maxSwapDist = { px: 0, detail: 'none' };
  let maxDist = { px: 0, detail: 'none' };
  for (let index = 1; index < frames.length; index += 1) {
    const prev = frames[index - 1];
    const cur = frames[index];
    if (sticky && typeof cur.dist === 'number' && Math.abs(cur.dist) > maxDist.px) maxDist = { px: Math.abs(cur.dist), detail: `frame${index}(t=${cur.t}) dist=${cur.dist}px` };
    if (prev.first && cur.first && prev.first.key === cur.first.key) {
      if (manualScrollAt !== null && cur.t < manualScrollAt + 400) continue; // 非贴底格：只看「测试主动滚到中间」并静置 400ms 之后
      const delta = Math.abs(Math.round((cur.first.top - prev.first.top) * 100) / 100);
      if (delta > maxAnchorMove.px) maxAnchorMove = { px: delta, detail: `frame${index}(t=${cur.t}) Δ=${Math.round((cur.first.top - prev.first.top) * 100) / 100}px ${lastEventBefore(events, cur.t) ?? ''}` };
    }
  }
  for (const change of viewChanges) {
    if (!sticky) continue;
    const magnitude = Math.abs(change.distBefore ?? 0);
    if (magnitude > maxSwapDist.px) maxSwapDist = { px: magnitude, detail: `frame${change.frame}(t=${change.t}) distBefore=${change.distBefore}px ΔscrollTop=${change.scrollTopDelta}px` };
  }
  const maxReaderJumpPx = sticky ? Math.max(maxAnchorMove.px, maxSwapDist.px) : maxAnchorMove.px;
  return {
    regionDeltas,
    infoDeltas,
    viewChanges,
    maxRegionDeltaPx: maxRegion.px,
    maxRegionDeltaDetail: maxRegion.detail,
    maxLayoutDeltaPx: maxLayout.px,
    maxLayoutDeltaDetail: maxLayout.detail,
    maxSidebarShiftPx: maxSidebar.px,
    maxSidebarShiftDetail: maxSidebar.detail,
    maxWidthFillDeltaPx: maxWidthFill.px,
    maxWidthFillDetail: maxWidthFill.detail,
    maxToolCardBleedPx: maxBleed.px,
    maxToolCardBleedDetail: maxBleed.detail,
    maxMessagesOverflowXPx: maxOverflowX.px,
    maxMessagesOverflowXDetail: maxOverflowX.detail,
    widthFillMax,
    maxInfoDeltaPx: maxInfo.px,
    maxInfoDeltaDetail: maxInfo.detail,
    screenShifts,
    maxScreenShiftPx: maxShift.px,
    maxScreenShiftDetail: maxShift.detail,
    maxScreenDiff: maxDiff,
    maxReaderJumpPx,
    maxReaderJumpDetail: maxAnchorMove.px >= maxSwapDist.px ? maxAnchorMove.detail : maxSwapDist.detail,
    maxAnchorMovePx: maxAnchorMove.px,
    maxAnchorMoveDetail: maxAnchorMove.detail,
    maxSwapPullPx: maxSwapDist.px,
    maxSwapPullDetail: maxSwapDist.detail,
    maxDistPx: maxDist.px,
    maxDistDetail: maxDist.detail,
    eventTimeline,
  };
}

function lastEventBefore(events, t) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].t <= t) return `${events[index].type}@+${events[index].t}ms`;
  }
  return null;
}

/** 相邻 screencast 帧在 rect 内的**竖直像素位移**：行灰度剖面的 SAD argmin。
 *  返回 px>0 = 内容整体向下移了 px 个像素。 */
function estimateVerticalShift(prev, cur, rect, maxShift = 80) {
  const { width, channels } = prev;
  const x0 = Math.max(0, Math.round(rect.left));
  const x1 = Math.min(width, Math.round(rect.right));
  const y0 = Math.max(0, Math.round(rect.top));
  const y1 = Math.min(prev.height, Math.round(rect.bottom));
  const stepX = Math.max(1, Math.floor((x1 - x0) / 120)); // 水平降采样
  const profile = (image) => {
    const out = [];
    for (let y = y0; y < y1; y += 2) {
      let sum = 0; let count = 0;
      for (let x = x0; x < x1; x += stepX) {
        const at = (y * image.width + x) * channels;
        sum += image.pixels[at] * 0.299 + image.pixels[at + 1] * 0.587 + image.pixels[at + 2] * 0.114;
        count += 1;
      }
      out.push(sum / count);
    }
    return out;
  };
  const a = profile(prev);
  const b = profile(cur);
  const inner = 12; // 忽略边缘，避免 content-visibility 的视口边界效应
  const sad = (shift) => {
    let sum = 0; let count = 0;
    for (let y = inner; y < a.length - inner; y += 2) {
      const other = y - shift;
      if (other < 0 || other >= b.length) continue;
      // b 的内容 = a 的内容向下移 shift ⇒ b[y] 对应 a[y-shift]
      sum += Math.abs(b[y] - a[other]);
      count += 1;
    }
    return count ? sum / count : Infinity;
  };
  let best = 0; let bestSad = Infinity;
  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    const value = sad(shift);
    if (value < bestSad) { bestSad = value; best = shift; }
  }
  const sad0 = sad(0);
  // 只有当「位移后的差」**明显**优于「不动」、且残差本身也很低时才认这个位移；
  // 否则整片重画（内容被替换）会被误读成位移。
  const px = sad0 > 1.5 && bestSad <= 6 && bestSad < sad0 * 0.6 ? best : 0;
  return { px, best, sad0: Math.round(sad0 * 100) / 100, sadBest: Math.round(bestSad * 100) / 100 };
}

main().catch((error) => {
  process.stderr.write(`stream-jump-realdata FAILED: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
