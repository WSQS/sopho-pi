// test/tui-tool-diff.mjs —— M-25 的前端那一半：把服务端**已经透传上来的**工具 `details` 画成逐行 +/-。
//
// 背景（`docs/tui-parity.md` §2.2 M-25 / §3：「服务端已补（`2100b69`）… 剩的是前端那一块」）：
//   `server/base-logic.mjs` 的 `detailsWire()` 把 `ToolResultMessage.details` 透传并配到 tool 卡上
//   （`call.part.details`，形状 `{status,value,bytes,truncated,note,preview}`），服务端门
//   `npm run test:projection -- --item M-25` 已验。网页侧 `grep -rn "diff" web/` 修前 0 命中 —— 本门钉的是
//   **网页真的按 pi 的 diff 语义画出了 ±**，以及**画不出来的时候如实说清**。
//
// 判据分正反两面（数据都在夹具里，逐字已知）：
//   正：`details.status==='known'` 的 edit diff ⇒ 逐行 `+`/`-`/上下文/`...` 省略行都画出来，
//       行号与 tab 拼法照 pi 的 `renderDiff`（前缀+行号+空格+内容，tab→3 空格），头部统计**从这份
//       字符串数出来**、`firstChangedLine` 照实报；
//   反：`oversized`（超限被省略的那份 details）⇒ 只画说明 + 原文预览，**一行假 ± 都不许有**；
//       没有 details / details 里没有 diff（bash 的 truncation 那种）⇒ 不画这块（不许编）。
//
// 只起自己 spawn 的 A、只按那个 pid 停；高位随机端口、临时 Chromium profile；不碰真 profile；不 pkill。
import { boot, sendJson, waitFor } from './ui-harness.mjs';

const SESSION = '25252525-2525-4525-8525-252525252525';

// 形状就是 pi `generateDiffString` 产出的那一种（`dist/core/tools/edit-diff.js`）：行号右对齐到同宽、
// 变更前/后各若干上下文行、中间跳过的部分写成 ` <空格>...`。fixture 里刻意把四种行都放进去。
const EDIT_DIFF = [
  '     ...',
  '  55 \tvirtual void _draw() {}',
  '  56 \t// 帧内绘制：清掉上一帧的命令再调 _draw()。',
  '- 59 \t// --- 由 Application / Screen 驱动（不是给用户的 API）---',
  '- 60 ',
  '+ 59 \t// --- 由 Application 驱动 ---',
  '+ 60 \t// 新增一行',
  '  61 \tvoid _propagate_tree_changed();',
].join('\n');
// 统计口径（数出来的，不是猜的）：+2 / -2 / 上下文 3（55、56、61）/ 省略 1（`...`）。
const LONG_DIFF = Array.from({ length: 60 }, (_, index) => `+ ${index + 1} line ${index + 1}`).join('\n');

const sessions = [{
  id: SESSION, name: 'diff 门', parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
  unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}];

const messages = [
  { entryId: 'u1', role: 'user', text: '改一下这个文件', content: [{ type: 'text', text: '改一下这个文件' }], images: [] },
  {
    entryId: 'a1', role: 'assistant',
    parts: [
      { type: 'tool', toolCallId: 'call_edit', name: 'edit', args: { path: 'src/screen.cpp' }, status: 'done-success', result: 'File edited successfully', details: { status: 'known', value: { diff: EDIT_DIFF, firstChangedLine: 59 }, bytes: 260, truncated: false, note: null, preview: null } },
      { type: 'tool', toolCallId: 'call_big', name: 'edit', args: { path: 'src/huge.cpp' }, status: 'done-success', result: 'File edited successfully', details: { status: 'oversized', value: null, bytes: 70028, truncated: true, note: 'details 有 70028 字节，超过上限 65536：正文被省略（截成半截 JSON 没法用），下面是前 2000 字符的原文预览', preview: '{"diff":"PARITY-BIG-DIFF\\nxxxxxxxx' } },
      { type: 'tool', toolCallId: 'call_write', name: 'write', args: { file_path: 'src/new.cpp', content: 'int main() {\n  return 0;\n}\n' }, status: 'done-success', result: 'File written', details: { status: 'absent', value: null, bytes: null, truncated: false, note: null, preview: null } },
      { type: 'tool', toolCallId: 'call_bash', name: 'bash', args: { command: 'grep -c x a.txt' }, status: 'done-success', result: '#1 grep -c x a.txt', details: { status: 'known', value: { truncation: { truncated: true, truncatedBy: 'lines', outputLines: 3, totalLines: 900 } }, bytes: 78, truncated: false, note: null, preview: null } },
      { type: 'tool', toolCallId: 'call_none', name: 'read', args: { path: 'a.txt' }, status: 'done-success', result: 'read ok' },
      { type: 'tool', toolCallId: 'call_long', name: 'edit', args: { path: 'src/long.cpp' }, status: 'done-success', result: 'File edited successfully', details: { status: 'known', value: { diff: LONG_DIFF, firstChangedLine: 1 }, bytes: 1200, truncated: false, note: null, preview: null } },
      { type: 'text', text: '改完了。' },
    ],
    content: [],
  },
];

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const screenshotFile = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-tui-tool-diff-1200x760.png`;

const ui = await boot({
  routes: async (request, response, url) => {
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0 } }), true;
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return true;
    }
    const match = /^\/api\/sessions\/([^/]+)\/(messages|events|commands|seen)$/.exec(url.pathname);
    if (match) {
      if (match[2] === 'messages') return sendJson(response, 200, { messages, extras: [], compaction: { atIndex: null }, observability: null }), true;
      if (match[2] === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
      if (match[2] === 'seen') return sendJson(response, 200, { ok: true }), true;
      if (match[2] === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return true;
      }
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      return sendJson(response, 200, { name: 'diff 门', cwd: '/home/user/code/ai/sopho-pi', archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
    }
    return false;
  },
});

// 一张工具卡在页面上长什么样：卡片直接子元素的签名（`test/wrap-sweep.mjs` 钉成恰好 2 个）+ 它
// `.tool-output` 里的 diff / details 两块的结构。
const view = () => ui.evaluate(`(() => {
  const cards = Array.from(document.querySelectorAll('.tool-card'));
  const pick = (name) => cards.find((card) => card.querySelector('.tool-name').textContent === name) ?? null;
  const byCall = (id) => cards.find((card) => card.dataset.toolCallId === id) ?? null;
  const describe = (card) => {
    if (!card) return null;
    const diff = card.querySelector('.tool-diff');
    return {
      name: card.querySelector('.tool-name').textContent,
      collapsed: card.dataset.collapsed,
      outputHidden: card.querySelector('.tool-output').hidden,
      childSignature: Array.from(card.children).map((child) => child.tagName.toLowerCase() + '.' + child.className).join('|'),
      diffInsideOutput: diff ? diff.parentElement.classList.contains('tool-output') : null,
      diffSource: diff ? diff.dataset.source : null,
      diffAdded: diff ? diff.dataset.added : null,
      diffRemoved: diff ? diff.dataset.removed : null,
      diffHead: diff ? diff.querySelector('.tool-diff-head').textContent : null,
      lines: diff ? Array.from(diff.querySelectorAll('.tool-diff-line')).map((line) => ({ kind: line.dataset.diff, text: line.textContent })) : [],
      details: card.querySelector('.tool-details') ? {
        status: card.querySelector('.tool-details').dataset.status,
        note: card.querySelector('.tool-details .tool-details-note').textContent,
        preview: card.querySelector('.tool-details-preview')?.textContent ?? null,
      } : null,
      result: card.querySelector('.tool-result').textContent,
    };
  };
  return {
    edit: describe(byCall('call_edit')),
    long: describe(byCall('call_long')),
    write: describe(byCall('call_write')),
    bash: describe(byCall('call_bash')),
    read: describe(byCall('call_none')),
    count: cards.length,
  };
})()`);

try {
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.tree-session').length === 1`), 'tree did not render');
  await ui.evaluate(`document.querySelector('[data-session-id="${SESSION}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.tool-card').length === 6`), 'tool cards did not render');
  await ui.frames(3);

  const all = await view();
  check('六张工具卡都在（夹具没被吃掉）', all.count === 6, `count=${all.count}`);

  // ── 正：edit 的逐行 +/- ────────────────────────────────────────────────────
  const expectedLines = [
    { kind: 'skip', text: '⋮ ...' },
    { kind: 'context', text: '  55    virtual void _draw() {}' },
    { kind: 'context', text: '  56    // 帧内绘制：清掉上一帧的命令再调 _draw()。' },
    { kind: 'remove', text: '- 59    // --- 由 Application / Screen 驱动（不是给用户的 API）---' },
    { kind: 'remove', text: '- 60 ' },
    { kind: 'add', text: '+ 59    // --- 由 Application 驱动 ---' },
    { kind: 'add', text: '+ 60    // 新增一行' },
    { kind: 'context', text: '  61    void _propagate_tree_changed();' },
  ];
  const edit = all.edit;
  // 平铺（`3d242e9`）之后每张工具卡顶上多了一行 `.message-role` 角标（「块自带可见身份」）——
  // 与兄弟门 `test/tui-message-images.mjs` / `test/flat-blocks.mjs` 同口径。断言其余部分一字未放宽。
  check('正：edit 卡上画出了 `.tool-diff`，而且在 `.tool-output` 里（卡片直接子元素次序不变；多出的是角标与标注控件）',
    edit?.diffSource === 'details' && edit.diffInsideOutput === true && edit.childSignature === 'div.message-role|div.tool-call|div.tool-output|div.annotate',
    JSON.stringify({ source: edit?.diffSource, inOutput: edit?.diffInsideOutput, children: edit?.childSignature }));
  check('正：逐行都画出来了，增/删/上下文/省略四类各归各类（行号与 tab→三空格的拼法与 pi 的 renderDiff 一致）',
    edit?.lines.length === expectedLines.length && edit.lines.every((line, index) => line.kind === expectedLines[index].kind && line.text === expectedLines[index].text),
    JSON.stringify(edit?.lines));
  check('正：头部统计**从这份 diff 数出来**（+2 −2 · 上下文 3 行 · 省略 1 处）且首变更行照实报',
    edit?.diffAdded === '2' && edit?.diffRemoved === '2' && /\+2 −2/.test(edit.diffHead) && /上下文 3 行/.test(edit.diffHead) && /省略 1 处/.test(edit.diffHead) && /首变更行 59/.test(edit.diffHead),
    JSON.stringify(edit?.diffHead));
  check('正：常规长度的 diff 默认**摊开**（不点折叠就能看见 —— TUI 里 diff 就是直接看的）',
    edit?.collapsed === 'false' && edit?.outputHidden === false,
    JSON.stringify({ collapsed: edit?.collapsed, hidden: edit?.outputHidden }));

  // ── 反：超限的 details 不许当 diff 画 ──────────────────────────────────────
  const big = (await view()).edit;
  const bigCard = await ui.evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('.tool-card'));
    const card = cards.find((c) => (c.querySelector('.tool-args')?.textContent ?? '').includes('huge.cpp'));
    if (!card) return null;
    return {
      hasDiff: Boolean(card.querySelector('.tool-diff')),
      hasDiffLines: card.querySelectorAll('.tool-diff-line').length,
      detailsStatus: card.querySelector('.tool-details')?.dataset.status ?? null,
      note: card.querySelector('.tool-details .tool-details-note')?.textContent ?? null,
      preview: card.querySelector('.tool-details-preview')?.textContent ?? null,
      result: card.querySelector('.tool-result').textContent,
    };
  })()`);
  check('反：`oversized` 的 details 只画说明 + 原文预览，**一行 ± 都没有**（不拿半截 JSON 当 diff）',
    bigCard?.hasDiff === false && bigCard?.hasDiffLines === 0 && bigCard?.detailsStatus === 'oversized' &&
      /超过上限 65536/.test(bigCard.note ?? '') && /原文预览/.test(bigCard.preview ?? '') && (bigCard.preview ?? '').includes('PARITY-BIG-DIFF'),
    JSON.stringify(bigCard));
  check('反：超限时结果文本照旧在（不是拿说明把结果顶掉）', bigCard?.result === 'File edited successfully', JSON.stringify(bigCard?.result));

  const bash = await ui.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.tool-card')).find((c) => c.querySelector('.tool-name').textContent === 'bash');
    return { hasDiff: Boolean(card.querySelector('.tool-diff')), hasDetails: Boolean(card.querySelector('.tool-details')), result: card.querySelector('.tool-result').textContent };
  })()`);
  check('反：details 说 known 但里面没有 diff 的（bash truncation）⇒ 不画 diff、不画说明块，也不拿 details 凑',
    bash.hasDiff === false && bash.hasDetails === false && bash.result === '#1 grep -c x a.txt', JSON.stringify(bash));

  const read = await ui.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.tool-card')).find((c) => c.querySelector('.tool-name').textContent === 'read');
    return { hasDiff: Boolean(card.querySelector('.tool-diff')), result: card.querySelector('.tool-result').textContent };
  })()`);
  check('反：完全没有 `details` 字段的工具（read）⇒ 一个空壳都不长', read.hasDiff === false && read.result === 'read ok', JSON.stringify(read));

  // ── write：pi 的 write 不产 diff，用参数里的内容画全量新增（并说清那不是差量）───────────
  const afterLong = await view();
  const write = afterLong.write;
  check('write：用工具参数里的 `content` 画逐行新增（data-source=write），行数与内容逐字对上',
    write?.diffSource === 'write' && write.lines.length === 3 && write.lines.every((line, index) => line.kind === 'add' && line.text === ['+1 int main() {', '+2   return 0;', '+3 }'][index]),
    JSON.stringify(write?.lines));
  check('write：头部说清「逐行都是新增；不是与旧文件的差量」（不冒充当差量）',
    /write 全量内容/.test(write?.diffHead ?? '') && /不是与旧文件的差量/.test(write?.diffHead ?? '') && /\+3 −0/.test(write?.diffHead ?? ''),
    JSON.stringify(write?.diffHead));

  // ── 超长 diff：默认跟着卡片收起，点开能看全 ─────────────────────────────────
  check('超长 diff（60 行）默认跟着卡片收起（阈值 40 行），不是无声地画 60 行',
    afterLong.long?.collapsed === 'true' && afterLong.long.outputHidden === true && afterLong.long.lines.length === 60,
    JSON.stringify({ collapsed: afterLong.long?.collapsed, lines: afterLong.long?.lines.length }));
  await ui.evaluate(`document.querySelector('[data-tool-call-id="call_long"] .tool-toggle').click()`);
  await ui.frames(2);
  const expanded = await view();
  check('点开之后 60 行都在（收起只是默认态，不是丢内容）',
    expanded.long?.collapsed === 'false' && expanded.long.lines.length === 60 && expanded.long.lines.filter((line) => line.kind === 'add').length === 60,
    JSON.stringify({ collapsed: expanded.long?.collapsed, lines: expanded.long?.lines.length }));

  check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));

  await ui.screenshot(screenshotFile);
  print('edit diff view', { head: expanded.edit?.diffHead, lines: expanded.edit?.lines.length });
  print('write view', expanded.write);
  print('screenshots', { diff: screenshotFile });
  print('RESULT', `M-25 tool diff frontend PASS (${checks} checks)`);
} finally {
  await ui.close();
}
