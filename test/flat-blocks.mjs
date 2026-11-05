// test/flat-blocks.mjs —— 「工具/bash 平铺成独立块」的机械门（业主 2026-09-22 拍板）。
//
// 要守住的不变量（一句话）：**每一个工具调用（连同它的结果）与每一个 bash 执行，都是 `#messages`
// 的顶层块，不嵌在 assistant 块里**；块的顺序 = 存储顺序逐字；每个块自带可见身份（角标 + 槽色）；
// 工具块仍按 `toolCallId` 把调用与结果配成一块。
//
// 形状：真 Chromium + 假 API（不碰真实例：高位随机端口 + 临时目录 + 只读 web/ 源码）。
// 假载荷照**真服务端**的形状给（`server/base-logic.mjs` 的 messageWire）：
//   · assistant 的 `parts` 带 `{type:'thinking'|'tool'|'text'}`；tool part 带 `toolCallId`；
//   · `toolResult` 是**独立一条 message**（前端跳过它，靠 `toolCallId` 配到工具卡上）；
//   · `bashExecution` 是**独立一条 message**（没有 `content`，只有 command/output/exitCode…）。
//
// 红绿对照（报告里给的复跑命令；同一把尺子量两个版本：`SOPHO_FLATBLOCKS_WEB`）：
//   把「块化」退回旧形态（工具/bash 塞回 assistant 块内、bash 按普通消息块画）⇒ 本门必红：
//     SOPHO_FLATBLOCKS_WEB=<把 HEAD 的 web/ 拷一份、用 `git show HEAD:web/render.js` 覆盖 render.js> \
//       CHROME_BIN=... node test/flat-blocks.mjs
//
// 用法：CHROME_BIN=/usr/bin/chromium node test/flat-blocks.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, sendJson, waitFor, WEB_ROOT } from './ui-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = process.env.SOPHO_FLATBLOCKS_WEB ? path.resolve(process.env.SOPHO_FLATBLOCKS_WEB) : WEB_ROOT;

const SESSION = '9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f';
const LONG_RESULT = Array.from({ length: 30 }, (_, index) => `long line ${index}`).join('\n');
const TOOL_RESULT = 'TOOL-RESULT-ONLY-IN-THE-CARD';
const BASH_OUTPUT = ' M a.mjs\n M b.mjs';

const sessions = [{
  id: SESSION, name: '平铺门', parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
  unread: false, modifiedAt: '2026-09-22T08:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}];

// 一条**内容完全已知**的会话：
//   · a-1 = assistant，parts 是 thinking → text → tool（**工具在末尾**，真机形态）⇒ 文章(思考+正文) + 工具块；
//   · a-2 = assistant，parts 是 text → tool → text（**工具在中间**）⇒ 文章 + 工具块 + 文章，
//     专钉「顺序 = 存储顺序逐字」（不许把工具挪到末尾 / 归拢成一组）；
//   · toolResult 与 bashExecution 都是独立条目。
const messages = [
  { entryId: 'u-1', parentId: null, timestamp: '2026-09-22T08:00:01.000Z', kind: 'message', role: 'user', content: [{ type: 'text', text: 'USER-BODY' }], text: 'USER-BODY', images: [], stopReason: null, errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [] },
  {
    entryId: 'a-1', parentId: 'u-1', timestamp: '2026-09-22T08:00:02.000Z', kind: 'message', role: 'assistant',
    content: [], text: 'THINK-BODYASSIST-BODY', images: [], stopReason: 'toolUse', errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [],
    parts: [
      { type: 'thinking', text: 'THINK-BODY' },
      { type: 'text', text: 'ASSIST-BODY' },
      { type: 'tool', toolCallId: 'call-1', name: 'read', args: { path: 'x.txt' }, status: 'done-success', isError: false, result: LONG_RESULT },
    ],
  },
  { entryId: 't-1', parentId: 'a-1', timestamp: '2026-09-22T08:00:03.000Z', kind: 'message', role: 'toolResult', content: [{ type: 'text', text: TOOL_RESULT }], text: TOOL_RESULT, images: [], stopReason: null, errorMessage: null, toolCallId: 'call-1', toolName: 'read', isError: false, aborted: false, extras: [] },
  {
    entryId: 'a-2', parentId: 't-1', timestamp: '2026-09-22T08:00:04.000Z', kind: 'message', role: 'assistant',
    content: [], text: 'BEFORE-AFTER', images: [], stopReason: 'toolUse', errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [],
    parts: [
      { type: 'text', text: 'BEFORE-TOOL' },
      { type: 'tool', toolCallId: 'call-2', name: 'bash', args: { command: 'echo hi' }, status: 'done-success', isError: false, result: 'hi' },
      { type: 'text', text: 'AFTER-TOOL' },
    ],
  },
  {
    entryId: 'e-1', parentId: 'a-2', timestamp: '2026-09-22T08:00:05.000Z', kind: 'bashExecution', role: 'bashExecution',
    content: [], text: `$ git status --short\n${BASH_OUTPUT}`, images: [], stopReason: null, errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [],
    bash: { command: 'git status --short', output: BASH_OUTPUT, exitCode: 0, cancelled: false, truncated: false, fullOutputPath: null, excludeFromContext: false },
  },
];

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const screenshotFile = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-v22-flat-blocks-1200x760.png`;

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
    const match = /^\/api\/sessions\/([^/]+)\/(messages|events|commands|seen|annotations)$/.exec(url.pathname);
    if (match) {
      if (match[2] === 'messages') return sendJson(response, 200, { sessionId: SESSION, messages, extras: [], compaction: { atIndex: null, entryId: null, note: '' }, observability: null }), true;
      if (match[2] === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
      if (match[2] === 'annotations') return sendJson(response, 200, { exists: true, items: [], total: 0, counts: { open: 0, done: 0 } }), true;
      if (match[2] === 'seen') return sendJson(response, 200, { ok: true }), true;
      if (match[2] === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return true;
      }
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      if (!sessions.some((entry) => entry.id === detail[1])) return sendJson(response, 404, { message: 'missing' }), true;
      return sendJson(response, 200, { name: '平铺门', cwd: 'C:/work/flat', archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
    }
    return false;
  },
});

const snapshot = () => ui.evaluate(`(() => {
  const root = document.querySelector('#messages');
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const children = Array.from(root.children).map((node, index) => ({
    index,
    kind: node.dataset.kind || '',
    role: node.dataset.role || '',
    entryId: node.dataset.entryId || null,
    partOf: node.dataset.partOf || null,
    partIndex: node.dataset.partIndex ?? null,
    toolCallId: node.dataset.toolCallId || null,
    collapsed: node.dataset.collapsed ?? null,
    label: clean(node.querySelector(':scope > .message-role')?.textContent),
    text: clean(node.textContent),
  }));
  const color = (selector) => { const node = document.querySelector(selector); return node ? getComputedStyle(node).borderLeftColor : null; };
  const assistantArticle = Array.from(document.querySelectorAll('#messages article.message-assistant'));
  const textArticle = document.querySelector('#messages article[data-entry-id="a-1"]');
  const annotate = textArticle?.querySelector(':scope > .annotate');
  // 「复制助手正文」的口径：annotationCardText 取卡面上的人可见正文（工具/bash 输出绝不算）。
  const bodyText = (() => {
    if (!textArticle) return null;
    const body = textArticle.querySelector('.message-body');
    if (!body) return null;
    const clone = body.cloneNode(true);
    for (const tool of clone.querySelectorAll('.tool-card, .bash-card')) tool.remove();
    return clean(clone.textContent);
  })();
  return {
    children,
    directTools: root.querySelectorAll(':scope > .tool-card').length,
    directBash: root.querySelectorAll(':scope > .bash-card').length,
    nestedTools: root.querySelectorAll('.message .tool-card').length,
    nestedBash: root.querySelectorAll('.message .bash-card').length,
    toolInArticle: document.querySelectorAll('#messages article .tool-card, #messages article .bash-card').length,
    assistantArticles: assistantArticle.length,
    assistantEntryIds: assistantArticle.map((node) => node.dataset.entryId),
    tool: (() => { const node = root.querySelector(':scope > .tool-card[data-tool-call-id="call-1"]'); if (!node) return null; return { label: clean(node.querySelector(':scope > .message-role')?.textContent), toolCallId: node.dataset.toolCallId || null, partOf: node.dataset.partOf || null, partIndex: node.dataset.partIndex ?? null, collapsed: node.dataset.collapsed, result: clean(node.querySelector('.tool-result')?.textContent), name: clean(node.querySelector('.tool-name')?.textContent) }; })(),
    bash: (() => { const node = root.querySelector(':scope > .bash-card'); if (!node) return null; return { label: clean(node.querySelector(':scope > .message-role')?.textContent), entryId: node.dataset.entryId || null, collapsed: node.dataset.collapsed, command: clean(node.querySelector('.bash-command')?.textContent), output: clean(node.querySelector('.bash-output')?.textContent) }; })(),
    colors: { user: color('.message-user'), assistant: color('.message-assistant'), tool: color('.tool-card'), bash: color('.bash-card') },
    palette: (() => {
      const probe = document.createElement('i'); document.body.append(probe);
      const names = ['--slot-user', '--slot-assistant', '--slot-pending', '--slot-success', '--slot-error', '--slot-warning', '--slot-bash'];
      const out = names.map((name) => { probe.style.color = 'var(' + name + ')'; return getComputedStyle(probe).color; });
      probe.remove();
      return out;
    })(),
    assistantBodyText: bodyText,
    annotateKind: annotate?.dataset.annotateKind || null,
    toolCardText: clean(root.querySelector(':scope > .tool-card[data-tool-call-id="call-1"]')?.textContent),
  };
})()`);

try {
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.tree-session').length >= 1`), 'tree did not render');
  await ui.evaluate(`document.querySelector('[data-session-id="${SESSION}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt')?.disabled === false && document.querySelectorAll('#messages > *').length >= 4`), 'messages did not render');
  await ui.frames(3);
  const view = await snapshot();

  // ── ① 顶层块：工具与 bash 都是 #messages 的直接子元素，绝不嵌在 assistant 块里 ─────────
  check('工具块与 bash 块都是 #messages 的**直接子元素**（顶层块）',
    view.directTools === 2 && view.directBash === 1,
    JSON.stringify({ directTools: view.directTools, directBash: view.directBash }));
  check('工具/bash **绝不**出现在任何 assistant 块内部（不是嵌套）',
    view.nestedTools === 0 && view.nestedBash === 0 && view.toolInArticle === 0,
    JSON.stringify({ nestedTools: view.nestedTools, nestedBash: view.nestedBash, inArticle: view.toolInArticle }));

  // ── ② 顺序 = 存储顺序逐字（parts = thinking → tool → text ⇒ 块序：文章(思考) → 工具 → 文章(正文)）──
  const kinds = view.children.map((child) => child.kind);
  check('顶层块顺序 = 存储顺序逐字（工具在 a-2 的 parts 中间 ⇒ 块序也是夹在两段文章之间）',
    JSON.stringify(kinds) === JSON.stringify(['message', 'message', 'tool', 'message', 'tool', 'message', 'bash']),
    JSON.stringify(view.children.map((child) => `${child.index}:${child.kind}/${child.role}/${child.text.slice(0, 16)}`)));
  check('assistant 的 text 段被工具**按 parts 顺序**分开（a-2 两段 article，同一 entryId a-2）',
    view.assistantArticles === 3 && JSON.stringify(view.assistantEntryIds) === JSON.stringify(['a-1', 'a-2', 'a-2']),
    JSON.stringify({ articles: view.assistantArticles, ids: view.assistantEntryIds }));

  // ── ③ 工具块：块自带身份、按 toolCallId 与结果配对、长输出默认折叠 ─────────────────
  check('工具块自带可见身份（角标 `tool · assistant`）+ 所属消息钩子（partOf/partIndex）',
    view.tool?.label === 'tool · assistant' && view.tool?.partOf === 'a-1' && view.tool?.partIndex === '2' && view.tool?.name === 'read',
    JSON.stringify(view.tool));
  check('工具块按 toolCallId 把调用与结果配成**一块**（结果文本在卡里）',
    view.tool?.toolCallId === 'call-1' && view.tool?.result?.includes('long line 0') && view.tool?.result?.includes('long line 29'),
    JSON.stringify({ toolCallId: view.tool?.toolCallId, resultHead: view.tool?.result?.slice(0, 24) }));
  check('工具块的长输出默认**折叠**（data-collapsed=true）',
    view.tool?.collapsed === 'true', JSON.stringify({ collapsed: view.tool?.collapsed }));

  // ── ④ bash 块：与工具块同名不同类 —— 自己的标题/槽色/默认折叠（默认展开）────────────
  check('bash 块自带可见身份（角标 `bash · user`）+ 标题是命令行 + 正文只有输出',
    view.bash?.label === 'bash · user' && view.bash?.command === '$ git status --short'
      && view.bash?.output?.includes('M a.mjs') && view.bash?.output?.includes('M b.mjs') && !view.bash?.output?.includes('git status'),
    JSON.stringify(view.bash));
  check('bash 块默认**展开**（与工具块的长输出默认折叠**相反**）',
    view.bash?.collapsed === 'false', JSON.stringify({ collapsed: view.bash?.collapsed }));

  // ── ⑤ 槽色按类型：user / assistant / tool / bash 各自一色，且都在既有调色板里 ──────
  const slotColors = [view.colors.user, view.colors.assistant, view.colors.tool, view.colors.bash];
  check('四种块的槽色两两不同（user/assistant/tool/bash 各自一色）',
    new Set(slotColors).size === 4, JSON.stringify(view.colors));
  check('四个槽色都取自 `web/slot.css` 既有调色板（不发明新语言）',
    slotColors.every((value) => view.palette.includes(value)),
    JSON.stringify({ slotColors, palette: view.palette }));

  // ── ⑥ 红线：复制助手正文不许把工具输出带进去 ─────────────────────────────────────
  check('助手正文（卡面取样）**不含**工具输出（工具输出只在它自己的块里）',
    view.annotateKind === 'message' && typeof view.assistantBodyText === 'string'
      && view.assistantBodyText.includes('THINK-BODY') && view.assistantBodyText.includes('ASSIST-BODY')
      && !view.assistantBodyText.includes('long line') && !view.assistantBodyText.includes('git status')
      && !view.toolCardText.includes('ASSIST-BODY'),
    JSON.stringify({ annotateKind: view.annotateKind, assistantBodyText: view.assistantBodyText, toolHasAssistantBody: view.toolCardText.includes('ASSIST-BODY') }));

  check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));

  await ui.screenshot(screenshotFile);
  print('flat blocks view', view);
  print('screenshot', screenshotFile);
  print('RESULT', `flat blocks PASS（${checks} checks；webRoot=${webRoot}）`);
} finally {
  await ui.close();
}
