// M-26 / M-27 门：工具输出与 thinking 块加折叠开关（按钮派，不加 TUI 快捷键映射）。
// 默认：工具长输出折叠、thinking 展开。
// 改（2026-09-20）：折叠态不再是「一重画就回默认」—— 它搬到了**会话级容器**里
// （`web/render.js` 的 rememberCollapseState / readCollapseState，按 entryId / toolCallId 索引）。
// 所以本门现在断言的是：**同一切会话内重画保持**、**切走再切回来还记得**、**会话之间不串**。
// （用户报告：「收起思考」点了之后，逻辑一结束就重置——根因就是状态原来只活在 DOM 节点上。）
import { boot, sendJson, waitFor } from './ui-harness.mjs';

const ids = { a: '44444444-4444-4444-8444-444444444444', b: '55555555-5555-4555-8555-555555555555' };
const longResult = Array.from({ length: 30 }, (_, index) => `long line ${index}`).join('\n');
const sessions = [
  { id: ids.a, name: '折叠 A', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: ids.b, name: '折叠 B', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-19T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];
const messagesA = [
  { role: 'user', text: '问题' },
  { role: 'assistant', parts: [
    { type: 'thinking', text: '这是一段思考内容。'.repeat(3) },
    { type: 'tool', name: 'short', status: 'done-success', result: 'ok' },
    { type: 'tool', name: 'long', status: 'done-success', result: longResult },
    { type: 'text', text: '答案 A' },
  ] },
];
const messagesB = [
  { role: 'user', text: 'B 的问题' },
  { role: 'assistant', parts: [{ type: 'tool', name: 'b-tool', status: 'done-success', result: 'B ok' }, { type: 'text', text: '答案 B' }] },
];
let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const screenshotFile = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-v22-message-fold-1200x760.png`;

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
      const id = match[1];
      if (match[2] === 'messages') return sendJson(response, 200, { messages: id === ids.a ? messagesA : messagesB, extras: [], compaction: { atIndex: null }, observability: null }), true;
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
      const session = sessions.find((entry) => entry.id === detail[1]);
      if (!session) return sendJson(response, 404, { message: 'missing' }), true;
      return sendJson(response, 200, { name: session.name, cwd: 'C:/work/fold', archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
    }
    return false;
  },
});

const view = () => ui.evaluate(`(() => {
  const thinking=document.querySelector('.message-thinking'); const toggle=thinking?.querySelector('.thinking-toggle'); const body=thinking?.querySelector('.thinking-body');
  const cards=Array.from(document.querySelectorAll('.tool-card')).map((card)=>{const t=card.querySelector('.tool-toggle'); return {name:card.querySelector('.tool-name').textContent, collapsed:card.dataset.collapsed, outputHidden:card.querySelector('.tool-output').hidden, toggle:t.textContent, aria:t.getAttribute('aria-expanded'), slot:getComputedStyle(t).borderLeftWidth, lines:card.querySelector('.tool-result').textContent.split('\\n').length};});
  return {
    thinking: thinking ? { collapsed: thinking.dataset.collapsed, bodyHidden: body.hidden, bodyText: body.textContent, toggle: toggle.textContent, aria: toggle.getAttribute('aria-expanded'), slot: getComputedStyle(toggle).borderLeftWidth, tag: toggle.tagName } : null,
    cards,
    userText: document.querySelector('.message-user')?.textContent,
  };
})()`);
const open = async (id) => {
  await ui.evaluate(`document.querySelector('[data-session-id="${id}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), `session ${id} did not open`);
  await ui.frames(3);
};

try {
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.tree-session').length === 2`), 'tree did not render');
  await open(ids.a);
  const controls = await ui.evaluate(`({tools:document.querySelectorAll('.tool-toggle').length, thinking:document.querySelectorAll('.thinking-toggle').length})`);
  check('折叠开关在岗（2 个工具 + 1 个 thinking 按钮）', controls.tools === 2 && controls.thinking === 1, JSON.stringify(controls));

  const initial = await view();
  check('M-27 thinking 默认展开、内容在、开关是按钮且不吃 3px 槽', initial.thinking.collapsed === 'false' && initial.thinking.bodyHidden === false && initial.thinking.aria === 'true' && initial.thinking.bodyText.includes('这是一段思考内容') && initial.thinking.slot === '0px' && initial.thinking.tag === 'BUTTON', JSON.stringify(initial.thinking));
  check('M-26 短工具输出默认展开', initial.cards[0].name === 'short' && initial.cards[0].collapsed === 'false' && initial.cards[0].outputHidden === false, JSON.stringify(initial.cards[0]));
  check('M-26 长工具输出（30 行）默认折叠', initial.cards[1].name === 'long' && initial.cards[1].collapsed === 'true' && initial.cards[1].outputHidden === true && initial.cards[1].lines === 30, JSON.stringify(initial.cards[1]));
  check('M-26 折叠开关也是按钮、不吃 3px 槽', initial.cards[0].slot === '0px' && initial.cards[1].slot === '0px' && initial.cards[0].aria === 'true' && initial.cards[1].aria === 'false', JSON.stringify(initial.cards.map((c) => ({ name: c.name, slot: c.slot, aria: c.aria }))));

  await ui.evaluate(`document.querySelector('.thinking-toggle').click()`);
  await ui.frames(2);
  const thinkingCollapsed = await view();
  check('M-27 点一下 thinking 折叠（正文隐藏、aria=false）', thinkingCollapsed.thinking.collapsed === 'true' && thinkingCollapsed.thinking.bodyHidden === true && thinkingCollapsed.thinking.aria === 'false' && /展开思考/.test(thinkingCollapsed.thinking.toggle), JSON.stringify(thinkingCollapsed.thinking));

  await ui.evaluate(`document.querySelectorAll('.tool-card')[1].querySelector('.tool-toggle').click()`);
  await ui.frames(2);
  const longExpanded = await view();
  check('M-26 点一下长工具输出展开（正文显示）', longExpanded.cards[1].collapsed === 'false' && longExpanded.cards[1].outputHidden === false && longExpanded.cards[1].aria === 'true' && /收起输出/.test(longExpanded.cards[1].toggle), JSON.stringify(longExpanded.cards[1]));

  await ui.evaluate(`document.querySelectorAll('.tool-card')[1].querySelector('.tool-toggle').click()`);
  await ui.frames(2);
  const longRecollapsed = await view();
  check('M-26 再点一下收起（回到折叠）', longRecollapsed.cards[1].collapsed === 'true' && longRecollapsed.cards[1].outputHidden === true, JSON.stringify(longRecollapsed.cards[1]));

  // 把 A 改成非默认态（thinking 折叠、长工具输出「展开后又被收起」），再切到 B、切回 A：
  // B 不继承 A 的状态；A **记得**自己点过的折叠态（会话级容器，2026-09-20 修）。
  // 同一会话内的重画也要保持 —— 这里点一下工具开关就会触发一次正文重画。
  const beforeSwitch = await view();
  check('切会话前 A 处于非默认态（thinking 折叠）', beforeSwitch.thinking.collapsed === 'true', JSON.stringify(beforeSwitch.thinking));

  await open(ids.b);
  const onB = await view();
  check('切到 B 后不串 A 的折叠态（B 没有 thinking 块、自己的工具默认展开）', onB.thinking === null && onB.cards[0].name === 'b-tool' && onB.cards[0].collapsed === 'false', JSON.stringify({ thinking: onB.thinking, cards: onB.cards.map((c) => [c.name, c.collapsed]) }));

  await open(ids.a);
  const backA = await view();
  check('切回 A 记得自己点过的折叠态（thinking 仍折叠、长工具输出仍折叠）', backA.thinking.collapsed === 'true' && backA.thinking.bodyHidden === true && backA.cards[1].collapsed === 'true', JSON.stringify({ thinking: backA.thinking.collapsed, cards: backA.cards.map((c) => [c.name, c.collapsed]) }));
  // 同一会话内重画也保持：再点一次长工具输出（展开）→ 这一段会重建正文 → 断言仍然是展开。
  await ui.evaluate(`document.querySelectorAll('.tool-card')[1].querySelector('.tool-toggle').click()`);
  await ui.frames(2);
  const expandedA = await view();
  check('A 里长工具输出再点开（非默认态）', expandedA.cards[1].collapsed === 'false' && expandedA.cards[1].outputHidden === false, JSON.stringify(expandedA.cards[1]));
  await open(ids.b);
  await open(ids.a);
  const afterRedrawA = await view();
  check('A 重画后（切走再切回）非默认态仍在（折叠态不再一重画就回默认）', afterRedrawA.thinking.collapsed === 'true' && afterRedrawA.cards[1].collapsed === 'false', JSON.stringify({ thinking: afterRedrawA.thinking.collapsed, cards: afterRedrawA.cards.map((c) => [c.name, c.collapsed]) }));
  check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));

  await ui.screenshot(screenshotFile);
  print('fold view', afterRedrawA);
  print('screenshots', { fold: screenshotFile });
  print('RESULT', `M-26/M-27 message fold PASS (${checks} checks)`);
} finally {
  await ui.close();
}
