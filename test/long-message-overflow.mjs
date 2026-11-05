#!/usr/bin/env node
// test/long-message-overflow.mjs —— 「消息卡超出了窗口」这条业主报告的机械门（真 Chromium + 假 API）。
//
// 业主原话（标注 `an-3f3bad82`，会话 `ee5cd6a9-…`、`messageId=36c28998…`、role=assistant）：
//   **「请看看这个消息，它的大小超出了窗口」**
// 被标的那条消息一手事实：正文 **1781 字 / 42 行 / 最长一行 179 字**，而那一行是
//   `![Stylized retro sports car](https://media.sketchfab.com/models/…/64e848b593df468990e0b5c76af691d5.jpeg)`
//   —— 一条**markdown 图片**，不是普通段落。179 字的中文一行在 ~14px 下约有 2500px 宽，但真正把卡片撑破的
//   不是「不换行」三个字：`web/markdown.mjs` 的 image renderer 产出的是**裸 `<img src=…>`**，而
//   `web/index.html` 只给 `.message-image img`（工具结果/附件那条 `<figure>` 路）写了 `max-width:100%` ——
//   **markdown 正文里的 `<img>` 一条宽度约束都没有** ⇒ 它按自身固有宽度（缩略图 1024px 级）铺开，
//   把消息卡与 `#messages` 一起撑出横向滚动条。
//
// 判据（每条都只在**真浏览器几何**上有意义，字符串断言在这条缺陷上永远绿）：
//   ① 消息卡 `.message` 的 `scrollWidth <= clientWidth + 1`（卡自己不被内容撑破）；
//   ② `#messages` 的 `scrollWidth <= clientWidth + 1`（右栏不出现横向滚动）；
//   ③ 文档根 `scrollWidth <= clientWidth + 1`（整页不出现横向滚动条）；
//   ④ `.code-block` **仍然可以横向滚动**（它自己的 `scrollWidth > clientWidth`）—— 这条单独断言，
//      防止「把溢出按住」的修法把代码块也压坏（代码块/预格式化本来就该横向滚）；
//   ⑤ 179 字中文单行**真的换行了**（Range 量到的 rect 数 > 1，且每个 rect 的右边界都在卡内）；
//   ⑥ 卡片内没有**任何**元素的右边界越过卡的内容右边界（逐个点名，不是只看最大值）。
// 两种宽度（1200×760 / 420×820）各跑一遍，两边都成立才算绿。
//
// 反证臂（`--reverse-arm=<名字>`）：在 `web/` 的**副本**上把那条保护去掉，再拿真门去打它 ⇒ 必须红在 ①②③。
// 副本由 `test/harness.mjs` 的 `runGateOnMutatedCopy` 建在**仓库根里面**（ESM/相对路径解析需要），
// 真树一个字节不动；子进程里由 `SOPHO_LONGMSG_GATE_ROOT` 指过去。
//
// 沙箱：mkdtemp 临时目录 + 随机高位端口（明确避开 7313/7321/7331 一族与真 profile），不 pkill、不重启 A。
// 用法：CHROME_BIN='C:/Users/user/AppData/Local/Chromium/Application/chrome.exe' node test/long-message-overflow.mjs
//   可选 SOPHO_LONGMSG_SHOT_DIR=<目录> —— 把两个宽度的截图写到那里（取证用；默认不写）。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { browserSandboxEnv, finishCleanup, quiesceCdpPage, removeSandbox, runGateOnMutatedCopy } from './harness.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 反证臂用：让门去跑**另一棵树**的 `web/`（子进程里由 `runGateOnMutatedCopy` 指过来）。
const root = path.resolve(process.env.SOPHO_LONGMSG_GATE_ROOT || DEFAULT_ROOT);
const webRoot = path.join(root, 'web');
const GATE_FILE = fileURLToPath(import.meta.url);
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-longmsg-'));

// ── 夹具：业主那条消息的**结构等价物**（几何等价，内容不是原文 —— 不把业主的真实正文抄进仓库）──
// 三张缩略图 / 一条 179 字中文单行 / 一条多行代码块 / 一条长 URL 正文 / 一条无空格长串。
const IMG_HOST = 'https://media.wrapfix.invalid';
// 缩略图的**固有像素**尺寸。真实 Sketchfab 缩略图是 1024×576 那一档；1024 在 1200 宽的右栏
// （≈896px）和 420 窄屏（≈396px）下都装不下 ⇒ 两种宽度都会复现同一个溢出。
const IMAGE_W = 1024;
const IMAGE_H = 576;

// 179 字、中间一个空格都没有的中文单行：这是业主报告的「最长一行 179 字」。
const CJK_UNIT = '卡片里的中文长句必须跟着右栏换行它不该把消息卡撑破更不该让整页冒出横向滚动条';
const CJK_LINE = (() => {
  let text = '';
  while (text.length < 179) text += CJK_UNIT;
  return text.slice(0, 179);
})();

/** 造一条**长度精确**的 markdown 图片行（`![alt](https://…/<填满>.jpeg)`）。 */
function imageLine(alt, total) {
  const head = `![${alt}](${IMG_HOST}/`;
  const tail = '.jpeg)';
  const fill = total - head.length - tail.length;
  if (fill < 8) throw new Error(`imageLine: total=${total} 太短`);
  return `${head}${'a'.repeat(fill)}${tail}`;
}

const CODE_LINE = `const veryLongSingleLine = "${'x'.repeat(300)}";`;
const BODY_TEXT = [
  '已查看，并发已经实际跑起来了，**两条已完成，风格原型正在制作**。先把能看的结果给你，不等全部齐。',
  '',
  '## 1. 候选模型：找到 5 项',
  '',
  CJK_LINE,
  '',
  '### ① 一号候选 · 低模跑车',
  '',
  imageLine('候选一', 179),
  '',
  '[3D 预览页面](https://example.invalid/m/7tPSW5UYD20) · 页面标注 **CC-BY 3.0，需署名**',
  '',
  '### ② 二号候选 · 宽体楔形',
  '',
  imageLine('候选二', 164),
  '',
  '长 URL 作为正文文本（不是链接文字）：' + `https://example.invalid/${'b'.repeat(140)}`,
  '',
  '无空格长串：' + 'Z'.repeat(200),
  '',
  '## 2. 一段多行代码块（它本来就该横向滚，但不许把卡片撑破）',
  '',
  '```js',
  CODE_LINE,
  'shortLine();',
  '```',
  '',
  '**当前游戏仍可运行，车模尚未正式替换。**',
].join('\n');

const SESSION = '55555555-5555-4555-8555-555555555555';
const HISTORY_MESSAGES = [
  { role: 'user', text: '请把这些候选列出来，带缩略图。', content: [{ type: 'text', text: '请把这些候选列出来，带缩略图。' }] },
  { role: 'assistant', entryId: 'e-longmsg-1', text: BODY_TEXT, parts: [{ type: 'text', text: BODY_TEXT }], stopReason: 'stop' },
];

const VIEWPORTS = [
  { label: '宽屏 1200×760', width: 1200, height: 760 },
  { label: '窄屏 420×820', width: 420, height: 820 },
];

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

// ── 一张**真的** PNG（IHDR + IDAT + IEND，CRC 按规范算），尺寸就是我们声明的 IMAGE_W×IMAGE_H ──
// 为什么必须是真的图：坏图（404/解不出）在布局里**没有固有尺寸**，那就复现不出「被固有宽度撑破」——
// 一条坏图夹具会让这道门永远绿。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function pngBytes(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit / truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = 90;
      raw[row + 2 + x * 3] = 190;
      raw[row + 3 + x * 3] = 183;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = pngBytes(IMAGE_W, IMAGE_H);

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 16000); candidate < 62000; candidate += 1) {
    if ([7313, 7321, 7331].includes(candidate) || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const listener = net.createServer();
      listener.once('error', () => resolve(false));
      listener.listen(candidate, '127.0.0.1', () => listener.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

async function waitFor(operation, message, timeoutMs = 20_000) {
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

// ── CDP over WebSocket（零依赖，与 test/text-wrap.mjs 同口径）────────────────────────────────
function cdp(wsUrl, pageProblems) {
  const socket = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  const on = (method, handler) => {
    const list = listeners.get(method) ?? [];
    list.push(handler);
    listeners.set(method, list);
  };
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
    on,
    send(method, params = {}) {
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    close() { socket.close(); },
  };
}

// ── 在页面里量几何 ───────────────────────────────────────────────────────────────────────────
// 既有计数口径：clientWidth 已排除滚动条，内容右边界再扣掉 padding/border。
const PROBE = `(() => {
  const CJK = ${JSON.stringify(CJK_LINE)};
  const num = (value) => parseFloat(value) || 0;
  const messages = document.querySelector('#messages');
  const card = document.querySelector('#messages .message:not(.message-user)')
    || document.querySelector('#messages .message');
  const avail = (el) => el.clientWidth - num(getComputedStyle(el).paddingLeft) - num(getComputedStyle(el).paddingRight)
    - num(getComputedStyle(el).borderLeftWidth) - num(getComputedStyle(el).borderRightWidth);
  const box = (el) => el ? { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, overflowX: +((el.scrollWidth - el.clientWidth) / 1).toFixed(1) } : null;
  // 卡片的内容盒 / 内边距盒都从 getBoundingClientRect 算：clientWidth 是取整的，拿它去减
  // padding+border 会差几个像素（实测 4px），那样正常满宽的子块会被误判成越界 —— 误判会把门变成
  // 常态假红，同样是废门。
  const cardStyle = getComputedStyle(card);
  const cardRect = card.getBoundingClientRect();
  const borderBoxLeft = cardRect.left + num(cardStyle.borderLeftWidth);
  const padRight = cardRect.right - num(cardStyle.borderRightWidth);
  const contentLeft = borderBoxLeft + num(cardStyle.paddingLeft);
  const contentRight = padRight - num(cardStyle.paddingRight);
  const cardInner = {
    left: +contentLeft.toFixed(2),
    right: +contentRight.toFixed(2),
    width: +(contentRight - contentLeft).toFixed(2),
    padRight: +padRight.toFixed(2),
    padWidth: +(padRight - borderBoxLeft).toFixed(2),
  };
  const describe = (el) => ({ tag: el.tagName.toLowerCase(), cls: el.className || '', w: +el.getBoundingClientRect().width.toFixed(1), right: +el.getBoundingClientRect().right.toFixed(1) });
  // 越界扫描：overflow 非 visible 的祖先会裁掉后代 ⇒ 那种子树里的溢出不算（代码块内部的横向滚动
  // 就是这一类，它本来就是设计的一部分）。绝对定位的角标（.annotate）落在卡片的内边距盒里，也不算。
  const clipped = (el) => {
    let node = el.parentElement;
    while (node && node !== card) {
      if (getComputedStyle(node).overflowX !== 'visible') return true;
      node = node.parentElement;
    }
    return false;
  };
  const offenders = [];
  for (const el of card.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (clipped(el)) continue;
    if (rect.right > cardInner.padRight + 1 || rect.width > cardInner.padWidth + 1) offenders.push(describe(el));
  }
  const images = Array.from(card.querySelectorAll('img')).map((image) => ({
    ...describe(image),
    natural: image.naturalWidth + '×' + image.naturalHeight,
    maxWidth: getComputedStyle(image).maxWidth,
    complete: image.complete,
  }));
  // 179 字中文单行：Range 的 rect 数 = 它实际占了几行。
  const cjkRow = (() => {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf(CJK);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + CJK.length);
      const rects = Array.from(range.getClientRects()).map((rect) => ({ y: +rect.y.toFixed(1), right: +rect.right.toFixed(1), w: +rect.width.toFixed(1) }));
      return {
        rects: rects.length,
        lines: new Set(rects.map((rect) => Math.round(rect.y))).size,
        maxRight: rects.length ? +Math.max(...rects.map((rect) => rect.right)).toFixed(2) : null,
        sample: node.data.slice(at, at + CJK.length),
        parent: node.parentElement.className || node.parentElement.tagName,
      };
    }
    return null;
  })();
  const pre = card.querySelector('pre.code-block');
  const preBox = box(pre);
  const code = pre ? card.querySelector('pre.code-block code') : null;
  const wraps = {
    card: getComputedStyle(card).overflowWrap,
    markdown: document.querySelector('#messages .message .markdown') ? getComputedStyle(document.querySelector('#messages .message .markdown')).overflowWrap : null,
    paragraph: card.querySelector('.message-body p') ? getComputedStyle(card.querySelector('.message-body p')).overflowWrap : null,
    paragraphWhiteSpace: card.querySelector('.message-body p') ? getComputedStyle(card.querySelector('.message-body p')).whiteSpace : null,
  };
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    card: box(card),
    cardInner,
    messages: box(messages),
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    body: box(document.body),
    offenders,
    images,
    cjkRow,
    pre: preBox,
    preCode: code ? box(code) : null,
    codeWhiteSpace: code ? getComputedStyle(code.parentElement).whiteSpace : null,
    wraps,
    counts: {
      images: card.querySelectorAll('img').length,
      codeBlocks: card.querySelectorAll('pre.code-block').length,
      paragraphs: card.querySelectorAll('.message-body p').length,
    },
  };
})()`;

/** 判据：把一次量到的几何判红/判绿。 */
function judge(where, measured) {
  const failures = [];
  const check = (label, clientWidth, scrollWidth) => {
    if (!(scrollWidth <= clientWidth + 1)) failures.push(`${where}：${label} 横向溢出 —— scrollWidth ${scrollWidth} > clientWidth ${clientWidth}（溢出 ${scrollWidth - clientWidth}px）`);
  };
  check('消息卡', measured.card?.clientWidth, measured.card?.scrollWidth);
  check('#messages（右栏）', measured.messages?.clientWidth, measured.messages?.scrollWidth);
  check('文档根（整页）', measured.document?.clientWidth, measured.document?.scrollWidth);
  // ④ 代码块必须**仍然**可以横向滚动（它本来就该滚）。这条不看「有没有溢出」，看「溢出了还能滚」。
  if (!measured.pre) {
    failures.push(`${where}：没量到代码块（pre.code-block 缺失）—— 这一臂没测到`);
  } else if (!(measured.pre.scrollWidth > measured.pre.clientWidth + 1)) {
    failures.push(`${where}：代码块被压坏了 —— 它的内部 scrollWidth ${measured.pre.scrollWidth} 没有超过 clientWidth ${measured.pre.clientWidth}（代码块应当保持 white-space: pre ＋ 内部横向滚动，不该被折行/压扁）`);
  }
  // ⑤ 179 字中文单行必须真的换行，且每一段都在卡内。
  if (!measured.cjkRow) {
    failures.push(`${where}：没找到那 179 字中文单行的文本节点 —— 夹具没覆盖到`);
  } else {
    if (!(measured.cjkRow.lines > 1)) failures.push(`${where}：179 字中文单行没有换行（只占 ${measured.cjkRow.lines} 行 / ${measured.cjkRow.rects} 个 rect）—— 它被压成了一行铺出去`);
    if (measured.cjkRow.maxRight !== null && measured.cjkRow.maxRight > measured.cardInner.right + 1) {
      failures.push(`${where}：179 字中文单行的右边界 ${measured.cjkRow.maxRight} 越过了卡片内容右边界 ${measured.cardInner.right.toFixed(2)}`);
    }
  }
  // ⑥ 卡片内没有元素越过内容右边界（逐个点名）。
  if (measured.offenders.length) {
    failures.push(`${where}：卡片里有 ${measured.offenders.length} 个元素越过了内容右边界（卡内宽 ${measured.cardInner.width}px）：${JSON.stringify(measured.offenders.slice(0, 8))}`);
  }
  return failures;
}

async function runArm({ port }) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      const sessions = [{ id: SESSION, name: '长消息现场', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-10-19T08:39:39.000Z', notify: { notifies: [], waitingFor: [] } }];
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
          return;
        }
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
    // 缩略图走**假域名**：用 CDP 的 Fetch 域在请求落地之前把它换成一张真 PNG（固有 1024×576）。
    // 必须这样做：markdown 里那条 179 字的图片行要**逐字**保持长 URL 的形状，
    // 而坏图/404 在布局里没有固有尺寸 ⇒ 复现不出「被固有宽度撑破」。
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: `${IMG_HOST}/*` }] });
    browser.on('Fetch.requestPaused', (params) => {
      const body = PNG.toString('base64');
      browser.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'image/png' }, { name: 'cache-control', value: 'no-store' }],
        body,
      }).catch(() => {});
    });
    const evaluate = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
      return result.result.value;
    };
    const shotDir = process.env.SOPHO_LONGMSG_SHOT_DIR;
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
      await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/?vp=${viewport.width}#${SESSION}` });
      await waitFor(() => evaluate(`document.readyState === 'complete' && document.querySelectorAll('#messages img').length === 2 && !!document.querySelector('#messages pre.code-block')`), `${viewport.label}: history fixtures did not render`);
      // 图片有固有尺寸之后才会撑开布局：等到两张都解码完（naturalWidth>0）再量。
      await waitFor(() => evaluate(`Array.from(document.querySelectorAll('#messages img')).every((image) => image.complete && image.naturalWidth > 0)`), `${viewport.label}: 夹具图片没有解码成功（坏图夹具会让本门假绿）`);
      const measured = await evaluate(PROBE);
      await shot(`long-message-${viewport.width}x${viewport.height}`);
      print(`  ${viewport.label} · 原始几何`, {
        视口: measured.viewport,
        消息卡: measured.card,
        卡内容宽: measured.cardInner,
        messages: measured.messages,
        文档: measured.document,
        body: measured.body,
        计数: measured.counts,
      });
      print(`  ${viewport.label} · 图片与代码块`, { 图片: measured.images, 代码块: measured.pre, 代码内层: measured.preCode, 代码whiteSpace: measured.codeWhiteSpace });
      print(`  ${viewport.label} · 179 字中文单行`, measured.cjkRow);
      print(`  ${viewport.label} · 越界元素`, measured.offenders);
      print(`  ${viewport.label} · 换行规则（computed）`, measured.wraps);
      assert.equal(measured.counts.images, 2, `${viewport.label}: 夹具应有 2 张 markdown 图片（实得 ${measured.counts.images}）`);
      assert.ok(measured.pre, `${viewport.label}: 夹具应有 1 个代码块`);
      const failures = judge(viewport.label, measured);
      results[viewport.label] = { measured, failures };
    }

    // 先把所有宽度都量完再一起判红：只停在第一个红宽度会把后面那个宽度的证据藏起来。
    const allFailures = VIEWPORTS.flatMap((viewport) => results[viewport.label].failures);
    if (allFailures.length) throw new Error(`long message overflow gate failed（共 ${allFailures.length} 条）：\n - ${allFailures.join('\n - ')}`);
    assert.deepEqual(pageProblems, [], `页面异常：${JSON.stringify(pageProblems)}`);
    return { chromium: version.Browser, results };
  } finally {
    await quiesceCdpPage(browser);
    browser?.close();
    if (chromium.exitCode === null && chromium.signalCode === null) {
      chromium.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => chromium.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (chromium.exitCode === null && chromiumErr) process.stderr.write(`chromium stderr (secondary): ${chromiumErr.slice(-400)}\n`);
  }
}

// ── 反证臂：`--reverse-arm=<名字>`（在 `web/` 副本上改一处，再拿真门去打它，断言它必红）──────────
// 没有反证臂的几何门只是会变绿的装饰：它无法证明「把保护拿掉 ⇒ 红」。
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const ARM_MUTATIONS = {
  // 把 markdown 正文里那句宽度保护**整条删掉** ⇒ 回到业主报的那个溢出。
  'no-image-width': {
    expect: '消息卡 横向溢出',
    async mutate(copyRoot) {
      const file = path.join(copyRoot, 'web', 'index.html');
      const source = await readFile(file, 'utf8');
      const needle = /[ \t]*\.message-body img \{[^}]*\}\n/;
      const match = needle.exec(source);
      if (!match) throw new Error('反证臂 no-image-width 的改写没命中：副本 web/index.html 里找不到 `.message-body img { … }` 那条规则（产品形状变了）');
      const hits = source.split(match[0]).length - 1;
      if (hits !== 1) throw new Error(`反证臂 no-image-width 的接缝在副本 web/index.html 里出现 ${hits} 次（应恰好 1 次）`);
      await writeFile(file, source.replace(match[0], ''), 'utf8');
    },
  },
  // 把**正文的换行规则**（`.message` 上那条继承给整张卡的 `overflow-wrap: anywhere`）去掉
  // ⇒ 长 URL / 无空格长串不再断开 ⇒ 回到「一行顶出右栏」。这条臂针对的就是「不换行的那一类」，
  // 与上一条（图片宽度）是**两条独立的保护**：拿掉任一条都必须红。
  'no-break-rule': {
    expect: '消息卡 横向溢出',
    async mutate(copyRoot) {
      const file = path.join(copyRoot, 'web', 'index.html');
      const source = await readFile(file, 'utf8');
      const seam = '    .message, .extra-message, .compaction-note { width: 100%; min-width: 0; border-radius: 2px; padding: .55rem .65rem; overflow-wrap: anywhere; margin: 0 0 .55rem; }';
      const hits = source.split(seam).length - 1;
      if (hits !== 1) throw new Error(`反证臂 no-break-rule 的接缝在副本 web/index.html 里出现 ${hits} 次（应恰好 1 次；找不到 = 那条声明被改写过了）`);
      await writeFile(file, source.replace(seam, seam.replace(' overflow-wrap: anywhere;', '')), 'utf8');
    },
  },
};

if (ARM) {
  const arm = ARM_MUTATIONS[ARM];
  if (!arm) {
    process.stdout.write(`✗ 未知的反证臂：${ARM}（认识的：${Object.keys(ARM_MUTATIONS).join(', ')}）\n`);
    process.exit(2);
  }
  let armResult = null;
  let armError = null;
  try {
    armResult = await runGateOnMutatedCopy({
      root: DEFAULT_ROOT,
      tag: 'longmsg',
      dirs: ['web'],
      mutate: arm.mutate,
      gateFile: GATE_FILE,
      expect: arm.expect,
      envKey: 'SOPHO_LONGMSG_GATE_ROOT',
    });
  } catch (error) {
    armError = error;
  }
  process.stdout.write(`\n──── 反证臂 ${ARM}：预期红在 ${JSON.stringify(arm.expect)} ────\n`);
  if (armError !== null) {
    process.stdout.write(`✗ 反证臂 ${ARM} 没红到位：${armError instanceof Error ? armError.message : String(armError)}\n`);
  } else {
    process.stdout.write(`✓ 反证臂 ${ARM} 红到位（真门退出码 ${armResult.exitCode}）—— 这是**期望**的结果，不是缺陷\n`);
    process.stdout.write(`  红的那一行：${armResult.redLine}\n`);
    process.stdout.write(`  门输出（末 1600 字）：\n${armResult.output.slice(-1600)}\n`);
  }
  for (const problem of armResult?.problems ?? []) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
  await removeSandbox(sandbox, []);
  process.exit(armError === null && armResult?.ok === true && (armResult?.problems ?? []).length === 0 ? 0 : 1);
}

const used = new Set();
const port = await reserveHighPort(used); used.add(port);

let primaryError;
try {
  await mkdir(sandbox, { recursive: true });
  const arm = await runArm({ port });
  print('沙箱', { dir: sandbox, port, forbiddenPortsUsed: false });
  print('RESULT', `long message overflow PASS（179 字中文单行 / 长 URL / 无空格长串都跟着右栏换行；markdown 图片被压进卡内；代码块仍可横向滚动；${VIEWPORTS.length} 种宽度都成立；Chromium ${arm.chromium}）`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
