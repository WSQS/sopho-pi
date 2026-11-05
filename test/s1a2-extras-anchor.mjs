#!/usr/bin/env node
// s1a2-extras-anchor.mjs —— 扩展消息（`extras`）**摆在哪**的机械门（真 chromium + 真 web/render.js）。
//
// 为什么要有它：`extras` 是独立字段（不进 `messages`，见 server/base-logic.mjs 的 messageWire），
// v2.1 因此只能把它们统一堆在正文之后（v2.1-final:web/app.mjs:41-47 的注释：没有下标、推不出插在哪两条之间）。
// v2.2 的 payload 每条 extra 都带 `entryId` / `parentId` / `timestamp`，用户已拍板按锚插回正文流里。
// 这条门钉住四件事：
//   ① 锚命中父 message ⇒ extra 是那个节点的**紧邻后继**（父是 toolResult 时 = 那张工具卡之后）；
//   ② 连续多条同父 / 同为一条 extra 的子 ⇒ 保持 payload 顺序；
//   ③ 父是压缩条目 ⇒ 紧跟在「✂ 压缩边界」块之后；父不在 `messages` 里 ⇒ 按时间落位；
//      连时间都没有 ⇒ 回落末尾（这一档是回落路径，不是正常路径）；
//   ④ **红线**：extra 永远是独立的 `aside.extra-message`，绝不出现在 message 正文里面（v2.1 原意）。
// 另外①的渐进渲染那一半（父在本批还没画出来）另造一条 300 条正文的会话专门验 —— 这是唯一
// 「父晚于 extra 才被 prepend 进来」的真实路径。
//
// 铁律：只起自己的 http 假后端 + 自己的 chromium；端口 0（不碰 7321/7331）；只按自己的 pid 停；不 pkill。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-extras-anchor-'));
const SMALL_ID = '44444444-4444-4444-8444-444444444444';
const BIG_ID = '55555555-5555-4555-8555-555555555555';
const CHAIN_IDS = [SMALL_ID, BIG_ID];
let browser;
let chromium;
let server;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

const iso = (seconds) => new Date(Date.parse('2026-09-01T00:00:00.000Z') + seconds * 1000).toISOString();

function wireMessage(entryId, parentId, seconds, role, content, extra = {}) {
  return {
    entryId,
    parentId,
    timestamp: iso(seconds),
    role,
    content,
    text: content.filter((block) => block?.type === 'text').map((block) => block.text).join(''),
    stopReason: null,
    errorMessage: null,
    toolCallId: null,
    toolName: null,
    isError: false,
    aborted: false,
    extras: [],
    parts: role === 'assistant' ? content.filter((block) => block.type === 'text' || block.type === 'tool') : undefined,
    ...extra,
  };
}

function wireExtra(entryId, parentId, seconds, customType, text, display = true) {
  return { entryId, parentId, timestamp: seconds === null ? null : iso(seconds), customType, content: [{ type: 'text', text }], text, display, details: null };
}

// ── 会话 A（小、一次画完）：把每一档锚各放一条 ──────────────────────────────
// 正文顺序：u1, a1, a2(toolCall), t1(toolResult，不单独成节点), a3, ✂cut, a4, a5
// 锚：a1 / t1 / (链在 X2 上) / 压缩条目 / 不在 messages 里的 model_change / 查不到的 id / 无时间
const SMALL = {
  sessionId: SMALL_ID,
  observability: null,
  messages: [
    wireMessage('s-u1', 's-head', 2, 'user', [{ type: 'text', text: 'A-USER-1' }]),
    wireMessage('s-a1', 's-u1', 3, 'assistant', [{ type: 'text', text: 'A-ASSISTANT-1' }], { stopReason: 'stop' }),
    wireMessage('s-a2', 's-a1', 5, 'assistant', [
      { type: 'tool', toolCallId: 'call-a', name: 'read', args: { path: 'ok.txt' }, status: 'done-success', result: 'A-TOOL-RESULT' },
    ], { stopReason: 'toolUse' }),
    wireMessage('s-t1', 's-a2', 6, 'toolResult', [{ type: 'text', text: 'A-TOOL-RESULT' }], { toolCallId: 'call-a', toolName: 'read' }),
    wireMessage('s-a3', 's-t1', 9, 'assistant', [{ type: 'text', text: 'A-ASSISTANT-2' }], { stopReason: 'stop' }),
    wireMessage('s-a4', 's-cut1', 14, 'assistant', [{ type: 'text', text: 'A-ASSISTANT-3' }], { stopReason: 'stop' }),
    wireMessage('s-a5', 's-a4', 20, 'assistant', [{ type: 'text', text: 'A-ASSISTANT-4' }], { stopReason: 'stop' }),
  ],
  extras: [
    wireExtra('x-a1', 's-a1', 4, 'anchor.message', '① 父是 a1（紧邻其后）'),                        // ①
    wireExtra('x-tool', 's-t1', 7, 'anchor.toolresult', '② 父是 toolResult（该落到那张工具卡之后）'), // ①
    wireExtra('x-chain', 'x-tool', 8, 'anchor.chain', '③ 父是另一条 extra（连续两条，保持顺序）'),   // ③
    wireExtra('x-cut', 's-cut1', 11, 'anchor.compaction', '④ 父是压缩条目（落在 ✂ 块之后）'),        // ②
    wireExtra('x-mc', 's-mc1', 15, 'anchor.timestamp', '⑤ 父是 model_change（不在 messages 里 ⇒ 按时间：a4(14) 之后、a5(20) 之前）'), // ④
    wireExtra('x-ghost', 's-ghost', null, 'anchor.end.a', '⑥ 父查不到、时间也没有 ⇒ 回落末尾'),       // ⑤
    wireExtra('x-null', null, null, 'anchor.end.b', '⑦ 父为空、时间也没有 ⇒ 回落末尾（排在⑥之后）'),  // ⑤
    wireExtra('x-hidden', 's-a1', 4, 'anchor.hidden', '⑧ display:false ⇒ 不画', false),
  ],
  compaction: { entryId: 's-cut1', atIndex: 5, timestamp: iso(10), summary: 'A-COMPACTION-SUMMARY', firstKeptEntryId: 's-u1', tokensBefore: 999, note: '正文列表 ≠ 模型现在看得见的东西' },
};

// ── 会话 B（300 条正文，走渐进渲染）：两条 extra 的父在**分片补进来的旧区**，一条在尾部 ──
const BIG_MESSAGES = [];
for (let index = 0; index < 300; index += 1) {
  BIG_MESSAGES.push(wireMessage(`b-${index}`, index === 0 ? 'b-head' : `b-${index - 1}`, 100 + index, index % 2 === 0 ? 'user' : 'assistant', [{ type: 'text', text: `B-BODY-${index}` }], index % 2 === 0 ? {} : { stopReason: 'stop' }));
}
const BIG = {
  sessionId: BIG_ID,
  observability: null,
  messages: BIG_MESSAGES,
  extras: [
    wireExtra('y-old', 'b-10', 110.5, 'anchor.staged', '渐进：父在旧区分片里（b-10）'),
    wireExtra('y-mid', 'b-150', 250.5, 'anchor.staged2', '渐进：父在旧区分片里（b-150）'),
    wireExtra('y-tail', 'b-295', 395.5, 'anchor.tail', '渐进：父在首批尾部（b-295）'),
  ],
  compaction: { entryId: 'b-cut', atIndex: null, timestamp: null, summary: '', firstKeptEntryId: null, tokensBefore: null, note: '正文列表 ≠ 模型现在看得见的东西' },
};

const payloads = new Map([[SMALL_ID, SMALL], [BIG_ID, BIG]]);
const tree = () => ({
  sessions: CHAIN_IDS.map((id, index) => ({ id, name: index === 0 ? 'Anchor small' : 'Anchor big', status: 'idle', statusLabel: '闲置', archived: false, parentId: null })),
});

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
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

async function waitFor(fn, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function cdp(wsUrl) {
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

let evaluate = () => { throw new Error('browser not ready'); };

// 容器直接子节点的「标签」：message 用 entryId，压缩块用 cut，extra 用 anchor + customType。
const sampleOf = (selector) => `(() => {
  const box = document.querySelector('${selector}');
  if (!box) return null;
  const label = (node) => {
    if (node.dataset.kind === 'extra') return 'extra:' + node.dataset.anchor;
    if (node.dataset.kind === 'compaction') return 'cut';
    if (node.dataset.kind === 'live') return 'live';
    return node.dataset.kind + ':' + (node.dataset.entryId || '?');
  };
  const children = Array.from(box.children);
  return {
    renderComplete: box.dataset.renderComplete,
    virtual: box.dataset.virtual,
    labels: children.map(label),
    messageIds: children.filter((node) => node.dataset.kind === 'message').map((node) => node.dataset.entryId),
    extrasInsideMessage: document.querySelectorAll('${selector} .message .extra-message').length,
    extras: Array.from(box.querySelectorAll(':scope > .extra-message')).map((node) => {
      const previous = node.previousElementSibling;
      const next = node.nextElementSibling;
      return {
        index: children.indexOf(node),
        anchor: node.dataset.anchor,
        customType: node.dataset.customType,
        label: node.querySelector('.extra-label')?.textContent || '',
        insideMessage: node.closest('.message') !== null,
        prevEntryId: previous?.dataset.entryId || previous?.dataset.partOf || null,
        prevKind: previous?.dataset.kind || null,
        // 平铺（业主 2026-09-22）之后「承载工具的那一块」有两种可能形状，这里**分开报、两边都断言** ——
        // 不再用 || 压成一个布尔（那样会把「卡在 assistant 块内」那条证明力稀释掉）：
        //   · prevIsToolCard：前一条**就是**那张顶层 section.tool-card（新 DOM 的常态）；
        //   · prevHasToolCard：前一条是 assistant 文章、**里面**含工具卡（旧 DOM 的嵌套形状）。
        prevIsToolCard: previous?.dataset.kind === 'tool',
        prevHasToolCard: previous ? previous.querySelector('.tool-card') !== null : false,
        // 那张工具卡的身份证：toolCallId = 画的是哪次调用；partOf = 它属于哪条 assistant 消息。
        prevToolCard: (() => {
          const card = previous?.dataset.kind === 'tool' ? previous : previous?.querySelector('.tool-card') || null;
          return card ? { toolCallId: card.dataset.toolCallId || null, partOf: card.dataset.partOf || null } : null;
        })(),
        nextEntryId: next?.dataset.entryId || next?.dataset.partOf || null,
        nextKind: next?.dataset.kind || null,
        width: Math.round(node.getBoundingClientRect().width),
      };
    }),
    lastMessageIndex: children.reduce((at, node, index) => (node.dataset.kind === 'message' || node.dataset.kind === 'compaction' ? index : at), -1),
    contentWidth: Math.round((() => { const style = getComputedStyle(box); return box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight); })()),
  };
})()`;

const SAMPLE = sampleOf('#messages');
const PROBE_SAMPLE = sampleOf('#anchor-probe');

function findExtra(view, customType) {
  const found = view.extras.find((item) => item.customType === customType);
  assert.ok(found, `extra ${customType} 没渲染出来；labels=${JSON.stringify(view.labels)}`);
  return found;
}

const report = { small: {}, big: {} };

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    const sessionPath = /^\/api\/sessions\/([^/]+)(?:\/(messages|events))?$/.exec(url.pathname);
    if (url.pathname === '/api/tree') return sendJson(response, 200, tree());
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify(tree())}\n\n`);
      return;
    }
    if (sessionPath) {
      const id = sessionPath[1];
      const payload = payloads.get(id);
      if (!payload) return sendJson(response, 404, { error: 'not_found' });
      if (sessionPath[2] === 'messages') return sendJson(response, 200, payload);
      if (sessionPath[2] === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return;
      }
      return sendJson(response, 200, { name: 'Anchor session', runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
    }
    if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'not_found' });
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reservePort();
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const result = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return result?.ok ? result.json() : null;
  }, 'chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${port}/`, { method: 'PUT' })).json();
  browser = cdp(target.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  evaluate = async (expression) => {
    const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || result.result?.description || 'browser evaluation failed');
    return result.result.value;
  };
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${SMALL_ID}"]') !== null`), 'tree did not render');

  // ── 会话 A：每一档锚 ────────────────────────────────────────────────────
  await evaluate(`document.querySelector('[data-session-id="${SMALL_ID}"]').click()`);
  const small = await waitFor(async () => {
    const view = await evaluate(SAMPLE);
    return view.renderComplete === 'true' && view.extras.length >= 7 ? view : null;
  }, 'small session extras did not render');

  print('A · labels', small.labels);
  print('A · extras', small.extras);
  assert.equal(small.renderComplete, 'true');
  assert.equal(small.extrasInsideMessage, 0, '红线：extra 绝不出现在 message 正文里');
  assert.ok(small.extras.every((item) => item.insideMessage === false), '红线：extra 必须是容器直接子节点');
  // 独立块 + 自己的标签（v2.1 原意：不伪装成模型的话）
  assert.ok(small.extras.every((item) => item.label.startsWith('扩展消息 · ')), JSON.stringify(small.extras.map((item) => item.label)));
  assert.equal(small.extras.length, 7, 'display:false 的那条不该画');

  // ① 父是正文 ⇒ 紧邻其后
  const xA1 = findExtra(small, 'anchor.message');
  assert.equal(xA1.anchor, 'message');
  assert.equal(xA1.prevEntryId, 's-a1', '父是 s-a1 时 extra 必须紧跟在它后面');
  assert.equal(xA1.nextEntryId, 's-a2', '并且在那之后的正文之前');
  // ② 父是 toolResult（不单独成节点）⇒ 落在画着那次工具调用的卡之后
  const xTool = findExtra(small, 'anchor.toolresult');
  assert.equal(xTool.anchor, 'message');
  assert.equal(xTool.prevEntryId, 's-a2', '父是 toolResult 时 extra 紧跟承载工具卡的那条 assistant');
  // 平铺后承载工具的那一块换了形状 ⇒ **两边都断言**，不用 || 把证明力稀释掉：
  //   ① 紧邻前驱真的带工具卡（两种形状**恰好**成立一种：顶层卡 / 含卡的文章）—— 两者都为空就是没证明；
  //   ② 那张卡自己声明归属（data-part-of），且指向 **payload 里真有的**那条 assistant 消息 ——
  //      这就是旧断言「那张卡在 assistant 块内」在新 DOM 下的等价证明（归属靠 data-part-of 说出来，不靠嵌套）。
  assert.equal(xTool.prevIsToolCard !== xTool.prevHasToolCard, true, `紧邻前驱要么是顶层工具卡、要么是含工具卡的文章（恰好一种）：${JSON.stringify({ isToolCard: xTool.prevIsToolCard, hasToolCard: xTool.prevHasToolCard })}`);
  assert.ok(xTool.prevToolCard, `紧邻前驱必须真的带工具卡（新旧两种形状都算）：${JSON.stringify(xTool.prevToolCard)}`);
  assert.equal(xTool.prevToolCard.partOf, 's-a2', '那张工具卡必须声明它属于哪条 assistant 消息（data-part-of）');
  assert.ok(SMALL.messages.some((message) => message.entryId === xTool.prevToolCard.partOf && message.role === 'assistant'), 'data-part-of 必须指向 payload 里真有的那条 assistant 消息（不是编的 id）');
  assert.equal(xTool.prevToolCard.toolCallId, 'call-a', '而且画的正是该 toolResult（s-t1 / call-a）对应的那次工具调用');
  assert.equal(xTool.nextKind, 'extra', '它紧跟的第二条是链上的那一条（不是正文）');
  // ③ 连续两条同父 ⇒ payload 顺序紧跟其后
  const xChain = findExtra(small, 'anchor.chain');
  assert.equal(xChain.anchor, 'extra');
  assert.equal(xChain.prevKind, 'extra', '链上的第二条必须紧跟前一条 extra');
  assert.equal(xChain.index, xTool.index + 1, '两条连续 extra 必须相邻且顺序与 payload 一致');
  assert.equal(xChain.nextEntryId, 's-a3', '两条之后才回到正文 s-a3');
  // ④ 父是压缩条目 ⇒ 落在 ✂ 块之后
  const xCut = findExtra(small, 'anchor.compaction');
  assert.equal(xCut.anchor, 'compaction');
  assert.equal(xCut.prevKind, 'compaction', '父是压缩条目时必须紧跟在压缩块后面');
  assert.equal(xCut.nextEntryId, 's-a4');
  // ⑤ 父是 model_change（不进 messages）⇒ 按时间落位：a4(14) 之后、a5(20) 之前
  const xMc = findExtra(small, 'anchor.timestamp');
  assert.equal(xMc.anchor, 'timestamp');
  assert.equal(xMc.prevEntryId, 's-a4', 'ts=15 的 extra 必须排在 ts=14 的正文之后');
  assert.equal(xMc.nextEntryId, 's-a5', '并且排在 ts=20 的正文之前');
  // ⑥⑦ 锚与时间都拿不到 ⇒ 末尾，且保持 payload 顺序
  const xEndA = findExtra(small, 'anchor.end.a');
  const xEndB = findExtra(small, 'anchor.end.b');
  assert.equal(xEndA.anchor, 'end');
  assert.equal(xEndB.anchor, 'end');
  assert.ok(xEndA.index > small.lastMessageIndex && xEndB.index > small.lastMessageIndex, '回落档必须留在所有正文/压缩块之后');
  assert.equal(xEndB.index, xEndA.index + 1, '回落档之间保持 extras 的数组顺序');
  // 边界与正文一样铺满整行（外观不变，只改位置）
  assert.ok(small.extras.every((item) => Math.abs(item.width - small.contentWidth) <= 2), JSON.stringify({ width: small.extras.map((item) => item.width), contentWidth: small.contentWidth }));
  report.small = { labels: small.labels, anchors: small.extras.map((item) => `${item.customType}=${item.anchor}`), insideMessage: small.extrasInsideMessage };

  await evaluate(`document.querySelector('[data-custom-type="anchor.message"]').scrollIntoView({ block: 'center' })`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const shotSmall = await browser.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/delegation-anchor-small.png', Buffer.from(shotSmall.data, 'base64'));

  // ── 会话 B：渐进渲染（父在分片补进来的旧区）────────────────────────────
  await evaluate(`document.querySelector('[data-session-id="${BIG_ID}"]').click()`);
  const bigFirst = await waitFor(async () => {
    const view = await evaluate(SAMPLE);
    return view.labels.filter((label) => label.startsWith('extra:')).length >= 1 ? view : null;
  }, 'big session first paint did not show extras');
  print('B · 首批（渐进未完成）labels 头部', { complete: bigFirst.renderComplete, extraAt: bigFirst.labels.findIndex((label) => label.startsWith('extra:')), head: bigFirst.labels.slice(0, 6) });

  const big = await waitFor(async () => {
    const view = await evaluate(SAMPLE);
    return view.renderComplete === 'true' ? view : null;
  }, 'big session did not finish progressive render', 60000);
  print('B · 完成后 extras', big.extras);
  assert.equal(big.extrasInsideMessage, 0);
  const yOld = findExtra(big, 'anchor.staged');
  assert.equal(yOld.anchor, 'message');
  assert.equal(yOld.prevEntryId, 'b-10', '渐进：旧区的 extra 最终必须紧跟它的父 b-10（父是后补进来的）');
  assert.equal(yOld.nextEntryId, 'b-11');
  const yMid = findExtra(big, 'anchor.staged2');
  assert.equal(yMid.prevEntryId, 'b-150');
  assert.equal(yMid.nextEntryId, 'b-151');
  const yTail = findExtra(big, 'anchor.tail');
  assert.equal(yTail.prevEntryId, 'b-295');
  assert.equal(yTail.nextEntryId, 'b-296');
  // extra 在容器里的下标必须夹在父节点与下一条之间（顺序不变量）
  assert.ok(yOld.index > 0 && yMid.index > yOld.index && yTail.index > yMid.index);
  assert.equal(big.labels.filter((label) => label.startsWith('extra:')).length, 3, '每条 extra 只画一次（分片路径不许重复）');
  report.big = { firstPaintExtraAt: bigFirst.labels.findIndex((label) => label.startsWith('extra:')), labels: big.labels.slice(0, 4).concat(['…']), anchors: big.extras.map((item) => `${item.customType}(prev=${item.prevEntryId},next=${item.nextEntryId})`) };

  await evaluate(`document.querySelector('[data-custom-type="anchor.staged"]').scrollIntoView({ block: 'center' })`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const shotBig = await browser.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/delegation-anchor-big.png', Buffer.from(shotBig.data, 'base64'));

  // ── 阶段 C：渐进渲染的**中间态**（父还没补进来的那几帧）─────────────────────
  // 阶段 B 用的是真 app 的默认参数（tailSize 80 / slice 6 / budget 6ms），太快了，
  // 取样常常落在「已完成」之后。这里直接把 renderMessages 拿过来，用 sliceSize=5、budgetMs=0
  // 把分片拉成长过程（每帧只补 5 条），于是能逐帧盯住：extra **只在它那一批被 prepend 之后**出现，
  // 而且一出现就紧跟已经画出来的父 —— 不会先冒出来再被搬走。
  await evaluate(`(async () => {
    const mod = await import('/render.js');
    const host = document.createElement('section');
    host.id = 'anchor-probe';
    host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1000px;height:600px;overflow:auto';
    document.body.append(host);
    const payload = await (await fetch('/api/sessions/${BIG_ID}/messages')).json();
    mod.renderMessages(host, payload, { progressive: true, tailSize: 100, sliceSize: 5, budgetMs: 0 });
    return true;
  })()`);

  const samples = [];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const view = await evaluate(PROBE_SAMPLE);
    if (!view) break;
    samples.push(view);
    if (view.renderComplete === 'true') break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const incomplete = samples.filter((view) => view.renderComplete !== 'true');
  const midFlight = samples.filter((view) => view.renderComplete !== 'true' && view.extras.length > 0);
  print('C · 中间态样本', {
    samples: samples.length,
    incomplete: incomplete.length,
    midFlightWithExtras: midFlight.length,
    firstIncomplete: incomplete[0] ? { labels: incomplete[0].labels.slice(0, 8), extras: incomplete[0].extras.map((item) => item.customType) } : null,
    // 只记「变了」的那些帧：正文条数 / extras 条数怎么一起长起来 —— 这是「父补进来 extra 才出现」的直接证据。
    transitions: (() => {
      const rows = [];
      let last = null;
      for (const view of samples) {
        const key = `${view.messageIds.length}/${view.extras.length}`;
        if (key !== last) { rows.push(key); last = key; }
      }
      return rows;
    })(),
  });
  assert.ok(incomplete.length >= 2, `必须真的观察到渐进渲染的中间态（拿到 ${incomplete.length} 个未完成样本）`);
  assert.ok(midFlight.length >= 1, '中间态里必须至少有一帧已经画出了 extra（否则等于没验到插入时机）');
  // 第一批（尾部 100 条）画完之后、分片补旧区**之前**：只有尾部那条 extra 在场，
  // 两条父在旧区的 extra **一条都不许冒出来**（先冒出来再被搬走 = 错）。
  const firstFrame = samples[0];
  assert.deepEqual(firstFrame.extras.map((item) => item.customType), ['anchor.tail'], `首批只该有尾部那条 extra：${JSON.stringify(firstFrame.extras.map((item) => item.customType))}`);
  assert.ok(firstFrame.messageIds.includes('b-295') && !firstFrame.messageIds.includes('b-10') && !firstFrame.messageIds.includes('b-150'));
  for (const view of samples) {
    assert.equal(view.extrasInsideMessage, 0, '红线：任何一帧 extra 都不许出现在 message 正文里');
    for (const item of view.extras) {
      if (item.anchor !== 'message') continue;
      // 中间态不变量：已经在 DOM 里的 extra，它的父 must**已经**画出来了，且仍是紧邻后继。
      assert.ok(view.messageIds.includes(item.prevEntryId), `中间态：extra ${item.customType} 冒出来了但它的父 ${item.prevEntryId} 还没画（说明它被插到了错位置）`);
    }
    // 相对顺序：已经画出来的 extras 之间必须始终与 payload 顺序一致（prepend 只会往前面加东西）。
    const order = view.extras.map((item) => item.customType);
    const expected = BIG.extras.map((item) => item.customType).filter((type) => order.includes(type));
    assert.deepEqual(order, expected, '中间态：extras 的相对顺序被打乱了');
  }
  const lastSample = samples.at(-1);
  assert.equal(lastSample.renderComplete, 'true');
  assert.deepEqual(lastSample.extras.map((item) => item.customType), BIG.extras.map((item) => item.customType));
  report.progressive = { samples: samples.length, incomplete: incomplete.length, midFlightWithExtras: midFlight.length, extraGrowth: samples.map((view) => view.extras.length).slice(0, 40) };

  print('chromium', { product: version.Browser, chrome, forbiddenPortsUsed: false, port, debugPort });
  print('RESULT', 'S1a-2 extras anchor PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  browser?.close();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await new Promise((resolve) => chromium.once('exit', resolve));
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
