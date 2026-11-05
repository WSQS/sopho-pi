// test/live-segments.mjs —— 「流式期间思考段与工具段之间也要有块边界/隔断」的机械门。
//
// 业主 2026-09-22 报的缺陷②：「流式的时候 toolcall 和思考之间的隔断还没有做」。
// 已知同族缺口：**流式期间那条 `.live-message` 没有被平铺** —— 平铺（每段思考 / 每个工具调用
// 各自成为独立的块、顺序 = 存储顺序）只在回合结束/重画后才呈现；流式当场是一段混在一起的
// 内容（思考、工具卡、再思考、正文全塞在**同一个** `.message-body` 里）⇒ 思考与工具之间
// 既没有块边界、也没有隔断。
//
// 本门要守住的不变量（一句话）：**流式途中，思考段与工具段之间就已经是块边界**——
//   · 工具卡在流式途中就是**独立块**（不嵌在 assistant 段内部、是 `#messages` 的直接子元素）；
//   · 思考段在自己的 assistant 块里，工具卡与它是**相邻的顶层块**；
//   · 流式态的这一串块与结束态的那一串块**逐一对齐**（同类型、同顺序、同角标身份）；
//   · 块与块之间在**布局上**真的分开（不是靠像素猜，是块级几何断言：两者 rect 不重叠、
//     中间有空隙、且各自是独立盒子）。
//
// 形状：真 Chromium + 假 API（不碰真实例：高位随机端口 + 临时目录 + 只读 web/ 源码）。
// 夹具造的是**真机形状**的一轮（工具 part 恒在 assistant 消息末尾，见 test/flat-blocks.mjs
// 与 test/stream-jump-cost.mjs 文件头的只读普查：24606 条带工具块的 assistant 消息里
// 「工具 part 不是最后一块」= 0 条）：
//     session.start → thinking(第一段) → session.end{toolUse} → tool_start → tool_end
//       → session.start → thinking(第二段) → 正文 → session.end{stop}
// 流式途中捕获 DOM + 截图（`--observe` 跑只打印、不判死）；结束态用**同一条历史**再捕获一次，
// 两份做「逐一对齐」。
//
// 用法：CHROME_BIN=/usr/bin/chromium node test/live-segments.mjs
//      CHROME_BIN=... node test/live-segments.mjs --observe     （只观测，不判死）
//
// 红绿对照（反证臂，报告里给的复跑命令；同一把尺子量两个版本：`SOPHO_LIVESEGMENTS_WEB`）：
//   把流式态退回旧形状（一个 `.message-body` 混着画）⇒ 本门必红：
//     SOPHO_LIVESEGMENTS_WEB=<把 HEAD 的 web/ 拷一份> CHROME_BIN=... node test/live-segments.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, sendJson, waitFor, WEB_ROOT } from './ui-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = process.env.SOPHO_LIVESEGMENTS_WEB ? path.resolve(process.env.SOPHO_LIVESEGMENTS_WEB) : WEB_ROOT;
const OBSERVE = process.argv.includes('--observe');

const SESSION = '5e9e9e9e-5e9e-4e9e-8e9e-5e9e9e9e9e9e';
const THINK_1 = 'THINK-SEG-1-第一段思考（工具之前）。';
const THINK_2 = 'THINK-SEG-2-第二段思考（工具之后）。';
const FINAL_TEXT = 'FINAL-SEG-正文：这一轮的终稿。';
const TOOL_RESULT = 'TOOL-SEG-RESULT-只有工具卡里才有。';

const sessions = [{
  id: SESSION, name: '流式隔断门', parentId: null, archived: false, status: 'working', statusLabel: '工作中',
  unread: false, modifiedAt: '2026-09-22T10:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}];

const baseMessages = [
  { entryId: 'u-1', parentId: null, timestamp: '2026-09-22T10:00:01.000Z', kind: 'message', role: 'user', content: [{ type: 'text', text: 'USER-SEG-问题。' }], text: 'USER-SEG-问题。', images: [], stopReason: null, errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [] },
];

// 结束态那一条历史 = 真服务端会返回的形状（工具 part 在每条 assistant 消息**末尾**）。
const endMessages = [
  ...baseMessages,
  {
    entryId: 'a-1', parentId: 'u-1', timestamp: '2026-09-22T10:00:02.000Z', kind: 'message', role: 'assistant',
    content: [], text: THINK_1, images: [], stopReason: 'toolUse', errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [],
    parts: [
      { type: 'thinking', text: THINK_1 },
      { type: 'tool', toolCallId: 'call-1', name: 'bash', args: { command: 'ls -la' }, status: 'done-success', isError: false, result: TOOL_RESULT },
    ],
  },
  { entryId: 't-1', parentId: 'a-1', timestamp: '2026-09-22T10:00:03.000Z', kind: 'message', role: 'toolResult', content: [{ type: 'text', text: TOOL_RESULT }], text: TOOL_RESULT, images: [], stopReason: null, errorMessage: null, toolCallId: 'call-1', toolName: 'bash', isError: false, aborted: false, extras: [] },
  {
    entryId: 'a-2', parentId: 't-1', timestamp: '2026-09-22T10:00:04.000Z', kind: 'message', role: 'assistant',
    content: [], text: THINK_2 + FINAL_TEXT, images: [], stopReason: 'stop', errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [],
    parts: [
      { type: 'thinking', text: THINK_2 },
      { type: 'text', text: FINAL_TEXT },
    ],
  },
];

const artifactRoot = process.env.SOPHO_LIVESEGMENTS_ARTIFACT_DIR || path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'sopho-live-segments');
await mkdir(artifactRoot, { recursive: true });
const shotStreaming = path.join(artifactRoot, 'live-segments-streaming-1200x760.png');
const shotEnded = path.join(artifactRoot, 'live-segments-ended-1200x760.png');
const reportFile = path.join(artifactRoot, 'live-segments-report.json');

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

const holder = { messages: baseMessages, streaming: false };
let sseResponse = null;

const ui = await boot({
  webRoot,
  routes: async (request, response, url) => {
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0 } }), true;
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return true;
    }
    const match = /^\/api\/sessions\/([^/]+)\/(messages|events|commands|seen|annotations|draft)$/.exec(url.pathname);
    if (match) {
      if (match[2] === 'messages') return sendJson(response, 200, { sessionId: SESSION, messages: holder.messages, extras: [], compaction: { atIndex: null, entryId: null, note: '' }, observability: null }), true;
      if (match[2] === 'commands') return sendJson(response, 200, { streaming: holder.streaming, commands: [] }), true;
      if (match[2] === 'annotations') return sendJson(response, 200, { exists: true, items: [], total: 0, counts: { open: 0, done: 0 } }), true;
      if (match[2] === 'seen') return sendJson(response, 200, { ok: true }), true;
      if (match[2] === 'draft') return sendJson(response, 200, { text: '' }), true;
      if (match[2] === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: holder.streaming, isCompacting: false, isRetrying: false })}\n\n`);
        sseResponse = response;
        response.once('close', () => { if (sseResponse === response) sseResponse = null; });
        return true;
      }
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (detail) return sendJson(response, 200, { name: '流式隔断门', cwd: 'C:/work/segments', archived: false, runtime: { isStreaming: holder.streaming, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
    return false;
  },
});

// 直接把帧写进这条 SSE 连接（与 test/live-tools.mjs 的 `/api/test/stream` 同一条路：
// 服务端把 pi 的事件投影成 `session.*` 帧，前端照真服务端的形状消费）。
const frames = (count = 3) => ui.frames(count);
const stream = async (name, data = {}) => {
  if (!sseResponse || sseResponse.destroyed) throw new Error(`session stream unavailable when emitting ${name}`);
  if (name === 'session.start') holder.streaming = true;
  if (name === 'session.end' && data?.stopReason !== 'toolUse') holder.streaming = false;
  sseResponse.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  await new Promise((resolve) => setTimeout(resolve, 6));
};
const waitForStream = () => waitFor(() => Promise.resolve(sseResponse !== null), 'session events stream did not connect');

// ── 页内观测：把「块」按 DOM 语义抽出来（不看像素） ────────────────────────────────────
const snapshot = () => ui.evaluate(`(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const root = document.querySelector('#messages');
  // 一个「块」= assistant 段（article.message-assistant）或工具卡（section.tool-card）。
  // 流式态与结束态都按同一把尺子抽：从 #messages 往下找，**穿过**直播包装节点（如果有）。
  const live = root.querySelector('.live-message');
  const wrapper = (node) => (live && live.contains(node) ? 'live' : 'history');
  const blocks = [];
  const walk = (node) => {
    for (const child of node.children) {
      const isMessage = child.classList.contains('message-assistant');
      const isTool = child.classList.contains('tool-card');
      if (isMessage || isTool) {
        blocks.push({
          wrapper: wrapper(child),
          kind: isTool ? 'tool' : 'message',
          label: clean(child.querySelector(':scope > .message-role')?.textContent),
          toolCallId: child.dataset.toolCallId || null,
          partOf: child.dataset.partOf || null,
          entryId: child.dataset.entryId || null,
          live: child.classList.contains('live-message') || !!child.closest('.live-message'),
          text: clean(child.textContent).slice(0, 90),
          bodyParts: Array.from((child.querySelector(':scope > .message-body') || child).children)
            .map((part) => part.classList.contains('message-thinking') ? 'thinking'
              : part.classList.contains('tool-card') ? 'tool'
              : part.classList.contains('markdown') ? 'markdown' : (part.tagName || '').toLowerCase()),
          rect: (() => { const r = child.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; })(),
        });
        continue;
      }
      // 直播包装节点不是块 ⇒ 继续往下找（这样流式态与结束态用同一把尺子）。
      if (child.classList.contains('live-message') || child.children.length) walk(child);
    }
  };
  walk(root);
  const liveNode = root.querySelector('.live-message');
  const liveTree = liveNode ? (() => {
    const describe = (node, depth) => {
      if (depth > 2) return null;
      return {
        tag: node.tagName.toLowerCase(),
        cls: node.className || '',
        kind: node.dataset?.kind || null,
        role: node.dataset?.role || null,
        children: Array.from(node.children).map((child) => describe(child, depth + 1)).filter(Boolean),
        textNodes: Array.from(node.childNodes).filter((n) => n.nodeType === 3).map((n) => clean(n.data).slice(0, 40)).filter(Boolean),
      };
    };
    return describe(liveNode, 0);
  })() : null;
  // 直播块里「思考段」与「工具段」的**块级**关系（DOM 级，不看像素）：
  const liveBlocks = blocks.filter((block) => block.wrapper === 'live');
  const boundaries = [];
  for (let i = 1; i < liveBlocks.length; i += 1) {
    const a = liveBlocks[i - 1]; const b = liveBlocks[i];
    boundaries.push({ from: a.kind, to: b.kind, gapPx: b.rect.top - a.rect.bottom, aBottom: a.rect.bottom, bTop: b.rect.top });
  }
  // 「长得一样」的机械证据：块自己的盒子样式（除边框颜色外应逐一相同 —— 边框色是直播提示，故意不同）。
  const styleOf = (node) => {
    if (!node) return null;
    const s = getComputedStyle(node);
    return { padding: s.padding, borderRadius: s.borderRadius, backgroundColor: s.backgroundColor, borderLeftWidth: s.borderLeftWidth, borderTopWidth: s.borderTopWidth, width: Math.round(node.getBoundingClientRect().width), marginTop: s.marginTop, marginBottom: s.marginBottom };
  };
  const scope = live || root;
  return {
    live: !!liveNode,
    liveCount: root.querySelectorAll('.live-message').length,
    wrapperDisplay: liveNode ? getComputedStyle(liveNode).display : null,
    nestedToolInBody: root.querySelectorAll('.live-message .message-body .tool-card').length,
    liveBlocks,
    boundaries,
    liveTree,
    blockStyles: { assistant: styleOf(scope.querySelector('.message-assistant')), tool: styleOf(scope.querySelector('.tool-card')) },
    historyBlocks: blocks.filter((block) => block.wrapper === 'history'),
    childrenOfMessages: Array.from(root.children).map((node) => ({ tag: node.tagName.toLowerCase(), cls: node.className, kind: node.dataset?.kind || null })),
  };
})()`);

const chunkText = (text, count = 4) => {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
};

let streamingShot = null;
let endedShot = null;
let midView = null;
let endView = null;

try {
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.tree-session').length >= 1`), 'tree did not render');
  await ui.evaluate(`document.querySelector('[data-session-id="${SESSION}"] .tree-select').click()`);
  await waitForStream();
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt')?.disabled === false && document.querySelectorAll('#messages > *').length >= 1`), 'messages did not render');
  await frames(3);

  // ── 一轮流式：思考 → 工具 → 思考 → 正文（工具 part 恒在各 assistant 消息末尾）──
  await stream('session.start', { role: 'assistant' });
  for (const delta of chunkText(THINK_1)) await stream('session.delta', { channel: 'thinking', delta });
  await frames(2);
  await stream('session.end', { stopReason: 'toolUse', errorMessage: null, text: THINK_1 });
  await frames(2);
  await stream('session.tool_start', { toolCallId: 'call-1', name: 'bash', args: { command: 'ls -la' } });
  await frames(2);
  await stream('session.tool_end', { toolCallId: 'call-1', name: 'bash', isError: false, result: TOOL_RESULT });
  await frames(2);
  await stream('session.start', { role: 'assistant' });
  for (const delta of chunkText(THINK_2)) await stream('session.delta', { channel: 'thinking', delta });
  for (const delta of chunkText(FINAL_TEXT)) await stream('session.delta', { channel: 'text', delta });
  await frames(4);

  midView = await snapshot();
  await ui.screenshot(shotStreaming);
  streamingShot = shotStreaming;

  print('【流式途中】#messages 顶层', JSON.stringify(midView.childrenOfMessages));
  print('【流式途中】块序（同一把尺子）', JSON.stringify(midView.liveBlocks.map((b) => `${b.kind}:${b.label}`)));
  print('【流式途中】直播块内部树', JSON.stringify(midView.liveTree));
  print('【流式途中】块边界（gap）', JSON.stringify(midView.boundaries));
  print('【流式途中】嵌套在 .message-body 里的工具卡数', midView.nestedToolInBody);
  print('【流式途中】截图', streamingShot);

  // ── 收尾：同一条历史落盘 ⇒ 结束态（重画后平铺）──
  holder.messages = endMessages;
  await stream('session.end', { stopReason: 'stop', errorMessage: null, text: FINAL_TEXT });
  await waitFor(() => ui.evaluate(`document.querySelectorAll('#messages .live-message').length === 0`), 'live block did not finish', 10_000);
  await frames(4);
  endView = await snapshot();
  await ui.screenshot(shotEnded);
  endedShot = shotEnded;

  print('【结束态】#messages 顶层', JSON.stringify(endView.childrenOfMessages));
  print('【结束态】块序（同一把尺子）', JSON.stringify(endView.historyBlocks.map((b) => `${b.kind}:${b.label}`)));
  print('【结束态】块边界（gap）', JSON.stringify(endView.historyBlocks.slice(1).map((b, i) => ({ from: endView.historyBlocks[i].kind, to: b.kind, gapPx: b.rect.top - endView.historyBlocks[i].rect.bottom }))));
  print('【结束态】截图', endedShot);

  if (OBSERVE) {
    print('OBSERVE', '只观测、不判死');
  } else {
    const kindOf = (block) => (block.kind === 'tool' ? 'tool' : 'message');
    const normalizeLabel = (label) => String(label || '').replace(' · streaming', '');
    const gapsOf = (list) => list.slice(1).map((block, index) => block.rect.top - list[index].rect.bottom);
    const styleKeys = ['padding', 'borderRadius', 'backgroundColor', 'borderLeftWidth', 'borderTopWidth', 'width', 'marginTop', 'marginBottom'];
    const styleEquals = (a, b) => !!a && !!b && styleKeys.every((key) => String(a[key]) === String(b[key]));

    // ① 流式途中工具卡就是独立块：不在任何 `.message-body` 里。
    check('流式途中：工具卡不在 `.message-body` 内（平铺成独立块）',
      midView.nestedToolInBody === 0 && midView.liveBlocks.filter((block) => block.kind === 'tool').length === 1,
      JSON.stringify({ nestedToolInBody: midView.nestedToolInBody, blocks: midView.liveBlocks.map((b) => `${kindOf(b)}:${b.label}`) }));

    // ② 流式途中的块序列 = 思考段 → 工具块 → 思考段。
    check('流式途中：块序列 = 思考段 → 工具块 → 思考段（工具块夹在两段之间，不是混在一起）',
      JSON.stringify(midView.liveBlocks.map(kindOf)) === JSON.stringify(['message', 'tool', 'message'])
        && midView.liveBlocks[0].bodyParts.includes('thinking')
        && midView.liveBlocks[2].bodyParts.includes('thinking'),
      JSON.stringify(midView.liveBlocks.map((b) => `${kindOf(b)}/${b.label}/${JSON.stringify(b.bodyParts)}`)));

    // ③ 隔断（DOM 级）：思考段与工具块之间是块边界 —— 矩形不重叠 + 真有空隙。
    const seal = midView.boundaries.find((boundary) => boundary.from === 'message' && boundary.to === 'tool');
    check('流式途中：思考段与工具块之间真有块边界（矩形不重叠 + 有空隙，DOM 级不是像素猜）',
      !!seal && seal.gapPx > 0 && seal.aBottom <= seal.bTop,
      JSON.stringify({ seal, boundaries: midView.boundaries }));

    // ④ 直播包装节点 display:contents（自身不产生盒子）⇒ 里面的块就是顶层块。
    const wrapperDisplay = midView.wrapperDisplay;
    check('流式途中：直播包装节点 display:contents（自身不产生盒子，块不是塞在一个气泡里）',
      wrapperDisplay === 'contents', `display=${wrapperDisplay} liveCount=${midView.liveCount}`);

    // ⑤ 结构对齐：流式态块序 ≡ 结束态块序（类型 + 角标归一后逐个相同）。
    check('结构对齐：流式态的块序 ≡ 结束态的块序（逐一对齐）',
      JSON.stringify(midView.liveBlocks.map(kindOf)) === JSON.stringify(endView.historyBlocks.map(kindOf))
        && JSON.stringify(midView.liveBlocks.map((b) => normalizeLabel(b.label))) === JSON.stringify(endView.historyBlocks.map((b) => normalizeLabel(b.label))),
      JSON.stringify({ live: midView.liveBlocks.map((b) => `${kindOf(b)}:${normalizeLabel(b.label)}`), ended: endView.historyBlocks.map((b) => `${kindOf(b)}:${normalizeLabel(b.label)}`) }));

    // ⑥ 工具块的身份也对齐（同一个 toolCallId / 同一个工具名）。
    check('结构对齐：流式与结束的工具块是同一张卡（toolCallId / 名称逐字相同）',
      midView.liveBlocks[1].toolCallId === 'call-1' && midView.liveBlocks[1].toolCallId === endView.historyBlocks[1].toolCallId
        && midView.liveBlocks[1].text.includes('bash') && endView.historyBlocks[1].text.includes('bash'),
      JSON.stringify({ liveTool: midView.liveBlocks[1].toolCallId, endedTool: endView.historyBlocks[1].toolCallId }));

    // ⑦ 块间距逐一对齐。
    const liveGaps = gapsOf(midView.liveBlocks);
    const endedGaps = gapsOf(endView.historyBlocks);
    check('结构对齐：块间距逐一对齐（|Δ| ≤ 2px）',
      liveGaps.length === endedGaps.length && liveGaps.every((gap, index) => Math.abs(gap - endedGaps[index]) <= 2),
      JSON.stringify({ liveGaps, endedGaps }));

    // ⑧ 「长得一样」：块自己的盒子样式逐一相同（边框色是直播提示，故意不同，不在此列）。
    check('长得一样：assistant 段与工具块的盒子样式逐项相同（padding/圆角/底色/边框宽/宽/底距）',
      styleEquals(midView.blockStyles.assistant, endView.blockStyles.assistant)
        && styleEquals(midView.blockStyles.tool, endView.blockStyles.tool),
      JSON.stringify({ live: midView.blockStyles, ended: endView.blockStyles }));

    check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));
  }

  await writeFile(reportFile, `${JSON.stringify({ webRoot, streaming: midView, ended: endView }, null, 2)}\n`);
  print('报告文件', reportFile);
  print('checks', checks);
  print('RESULT', OBSERVE ? 'live-segments OBSERVE（只观测、不判死）' : `live-segments PASS（${checks} checks；webRoot=${webRoot}）`);
} finally {
  await ui.close();
}
