// M-41 网页门：`session.notice`（插件 notify）必须**可见**，且不污染消息区。
//
// 真 Chromium + 假 API/SSE。注入的是服务端真实事件名 `session.notice`（经 `/api/test/event` 广播到
// 该会话的假 SSE），断言：
//   · 通知行出现、级别样式可区分、多行 pre-wrap 原样保留；
//   · info 约 8 秒自动消失；warning/error 留到被下一条替换或被 × 关掉；
//   · 同一条会话里只有一条通知行（后到者替换，不堆叠）；
//   · **绝不进 `#messages`**，且注入前后 `#messages` 子节点顺序逐一相同（`test:liveorder` 守的同一件事）；
//   · 切到「问题」页时通知行照常可见（不被吞）。
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boot, sendJson, readBody, waitFor } from './ui-harness.mjs';

const ids = { a: '11111111-1111-4111-8111-111111111111' };
const T = Date.now() - 3_600_000;
const artifacts = path.join(os.tmpdir(), 'sopho-notice-ui');
const screenshot = path.join(artifacts, 'session-notice-1200x760.png');

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

const messagesPayload = (id) => ({
  messages: [
    { entryId: 'e1', role: 'user', parts: [{ type: 'text', text: '第一条' }] },
    { entryId: 'e2', role: 'assistant', parts: [{ type: 'text', text: '第二条' }], stopReason: 'stop' },
    { entryId: 'e3', role: 'user', parts: [{ type: 'text', text: '第三条' }] },
  ],
  extras: [],
  compaction: { atIndex: null, note: '' },
  observability: null,
});

const control = { sessionStreams: new Map(), treeClients: new Set() };
const broadcastSession = (name, data) => {
  for (const streams of control.sessionStreams.values()) {
    for (const response of streams) if (!response.destroyed) response.write(`event: ${name}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  }
};
const treeRow = () => ({
  id: ids.a, name: 'Notice UI A', parentId: null, archived: false, cwd: 'C:/work/a',
  modifiedAt: new Date(T).toISOString(), titleSource: 'auto',
  status: 'idle', statusLabel: '闲置', unread: false, settledAt: T, seenAt: T,
  notify: { notifies: [], waitingFor: [] },
});
const treePayload = () => ({ sessions: [treeRow()], unread: { count: 0 } });

let ui;
try {
  await mkdir(artifacts, { recursive: true });
  ui = await boot({
    width: 1200, height: 760,
    routes: async (request, response, url) => {
      const { pathname } = url;
      if (pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
      if (pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
      if (pathname === '/api/tree') return sendJson(response, 200, treePayload()), true;
      if (pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload())}\n\n`);
        control.treeClients.add(response);
        response.once('close', () => control.treeClients.delete(response));
        return true;
      }
      if (pathname === '/api/test/event' && request.method === 'POST') {
        const { name, data } = JSON.parse((await readBody(request)) || '{}');
        broadcastSession(name, data);
        return sendJson(response, 200, { ok: true, name }), true;
      }
      const questionsMatch = /^\/api\/sessions\/([^/]+)\/questions$/.exec(pathname);
      if (questionsMatch) return sendJson(response, 200, { questions: [], counts: { open: 0, answered: 0, closed: 0, concluded: 0, total: 0 }, filteredCount: 0 }), true;
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|seen|draft|commands))?$/.exec(pathname);
      if (sessionMatch) {
        const id = sessionMatch[1];
        const action = sessionMatch[2] ?? null;
        if (action === 'messages') return sendJson(response, 200, messagesPayload(id)), true;
        if (action === 'seen' && request.method === 'POST') { await readBody(request); return sendJson(response, 200, { ok: true, id, unread: false }), true; }
        if (action === 'draft') { await readBody(request); return sendJson(response, 200, { text: '' }), true; }
        if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ type: 'session.snapshot', isStreaming: false, isCompacting: false, isRetrying: false, queue: { steering: [], followUp: [] } })}\n\n`);
          if (!control.sessionStreams.has(id)) control.sessionStreams.set(id, new Set());
          control.sessionStreams.get(id).add(response);
          response.once('close', () => control.sessionStreams.get(id)?.delete(response));
          return true;
        }
        const row = treeRow();
        return sendJson(response, 200, { name: row.name, cwd: row.cwd, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
      }
      return false;
    },
  });
  const problemsAtStart = ui.pageProblems.length;

  const noticeState = () => ui.evaluate(`(() => {
    const node = document.querySelector('#session-notice');
    const text = document.querySelector('#session-notice-text');
    const messages = document.querySelector('#messages');
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const textStyle = getComputedStyle(text);
    return {
      exists: node !== null,
      hidden: node.hidden,
      level: node.dataset.level ?? null,
      text: text.textContent,
      slotColor: style.borderInlineStartColor || style.borderLeftColor,
      whiteSpace: textStyle.whiteSpace,
      count: document.querySelectorAll('#session-notice').length,
      insideMessages: document.querySelector('#messages #session-notice') !== null,
      visible: !node.hidden && rect.width > 0 && rect.height > 0 && rect.bottom <= innerHeight + 1,
      top: rect.top, bottom: rect.bottom, height: rect.height,
      messagesOrder: Array.from(messages.children).map((child) => child.id || child.dataset.entryId || child.className),
      view: document.querySelector('main').dataset.view ?? null,
      questionsVisible: !document.querySelector('#questions-pane').hidden,
    };
  })()`);
  const click = (selector) => ui.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const broadcast = (level, text, extra = {}) => ui.emit('session.notice', { type: 'session.notice', sessionId: ids.a, level, text, at: new Date().toISOString(), source: 'extension', ...extra });

  await waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${ids.a}"]') !== null`), 'tree did not render');
  await ui.evaluate(`document.querySelector('[data-session-id="${ids.a}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), 'session A did not open');
  await waitFor(() => ui.evaluate(`document.querySelector('#messages').dataset.renderComplete === 'true'`), 'messages did not finish rendering');

  const initialOrder = (await noticeState()).messagesOrder;
  check('注入前：通知行在岗但隐藏（未收到插件通知时不占位）', (await noticeState()).hidden === true, JSON.stringify(initialOrder));

  // ── 1. info：出现 + 文本 + pre-wrap + 不进 #messages + 消息顺序不变 ───────────────
  await broadcast('info', '插件说了一句');
  await waitFor(async () => (await noticeState()).hidden === false, 'notice did not appear');
  const info = await noticeState();
  check('收到 `session.notice` ⇒ 通知行出现、文本正确、data-level=info、white-space=pre-wrap',
    info.exists && info.hidden === false && info.level === 'info' && info.text === '插件说了一句' && info.whiteSpace === 'pre-wrap',
    { level: info.level, text: info.text, whiteSpace: info.whiteSpace });
  check('通知行**不在** `#messages` 里，且注入前后 `#messages` 子节点顺序逐一相同',
    info.insideMessages === false && JSON.stringify(info.messagesOrder) === JSON.stringify(initialOrder),
    { insideMessages: info.insideMessages, before: initialOrder, after: info.messagesOrder });
  const infoSlot = info.slotColor;

  // ── 2. 三种级别样式可区分 ───────────────────────────────────────────────────────
  await broadcast('warning', '小心一点');
  await waitFor(async () => (await noticeState()).level === 'warning', 'warning did not replace');
  const warn = await noticeState();
  await broadcast('warning', '再换一条');
  const replaced = await noticeState();
  check('同一条会话里只有一条通知行（后到者替换，不堆叠）',
    replaced.count === 1 && replaced.text === '再换一条' && replaced.level === 'warning',
    { count: replaced.count, text: replaced.text });
  check('warning 的槽色与 info 不同（级别可区分）', warn.slotColor !== infoSlot, { info: infoSlot, warning: warn.slotColor });

  // ── 3. warning/error 不自动消失（等 1.2s 仍在），error 槽色又可区分 ───────────────
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const warnStays = await noticeState();
  check('warning 不自动消失（1.2s 后仍在）', warnStays.hidden === false && warnStays.text === '再换一条', JSON.stringify(warnStays.text));
  await broadcast('error', '出错了');
  await waitFor(async () => (await noticeState()).level === 'error', 'error did not replace');
  const err = await noticeState();
  check('error 槽色与 info/warning 都不同', err.slotColor !== infoSlot && err.slotColor !== warn.slotColor, { info: infoSlot, warning: warn.slotColor, error: err.slotColor });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check('error 也不自动消失（1.2s 后仍在）', (await noticeState()).hidden === false, JSON.stringify((await noticeState()).text));

  // ── 4. 多行原样保留 ─────────────────────────────────────────────────────────────
  await broadcast('warning', '第一行\n第二行\n第三行');
  await waitFor(async () => (await noticeState()).text.includes('第二行'), 'multiline did not arrive');
  const multi = await noticeState();
  check('多行用 pre-wrap 原样保留（\\n 一字节不改，且消息顺序仍不变）',
    multi.text === '第一行\n第二行\n第三行' && multi.whiteSpace === 'pre-wrap'
    && JSON.stringify(multi.messagesOrder) === JSON.stringify(initialOrder),
    JSON.stringify(multi.text));

  // ── 5. × 关闭 ──────────────────────────────────────────────────────────────────
  await click('#session-notice-close');
  await waitFor(async () => (await noticeState()).hidden === true, 'close button did not hide the notice');
  check('点 × ⇒ 通知行消失', true, 'hidden after close');

  // ── 6. 切到「问题」页：通知行照常可见（不被吞）────────────────────────────────────
  await broadcast('error', '切页后也要看得见');
  await waitFor(async () => (await noticeState()).hidden === false, 'notice did not reappear');
  await click('#view-tab-questions');
  await waitFor(async () => (await noticeState()).view === 'questions', 'did not switch to questions view');
  const inQuestions = await noticeState();
  check('切到问题页 ⇒ 通知行仍可见、在视口内（底栏隐藏也不影响它）',
    inQuestions.view === 'questions' && inQuestions.questionsVisible
    && inQuestions.hidden === false && inQuestions.visible,
    { view: inQuestions.view, hidden: inQuestions.hidden, visible: inQuestions.visible, top: inQuestions.top, bottom: inQuestions.bottom });
  await ui.screenshot(screenshot);
  print('questions view screenshot', screenshot);
  await click('#view-tab-session');
  await waitFor(async () => (await noticeState()).view === 'session', 'did not switch back');

  // ── 7. info 约 8 秒自动消失（最后跑，避免拖慢别的断言）──────────────────────────
  await broadcast('info', '八秒后自动消失');
  await waitFor(async () => (await noticeState()).level === 'info' && !(await noticeState()).hidden, 'info did not appear');
  await new Promise((resolve) => setTimeout(resolve, 8600));
  check('info 约 8 秒自动消失', (await noticeState()).hidden === true, JSON.stringify((await noticeState())));

  const problems = ui.pageProblems.slice(problemsAtStart);
  check('页面无未捕获异常/console.error', problems.length === 0, problems);
  print('checks', checks);
  await ui.close();
  process.stdout.write('notice-ui: PASS\n');
} catch (error) {
  try { await ui?.close(); } catch {}
  if (Array.isArray(ui?.pageProblems) && ui.pageProblems.length > 0) process.stderr.write(`page problems: ${JSON.stringify(ui.pageProblems)}\n`);
  throw error;
}
