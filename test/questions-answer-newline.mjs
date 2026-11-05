#!/usr/bin/env node
// test/questions-answer-newline.mjs —— 问题页「手动回答框 ＋ 关闭原因框」的**换行／随内容长高**门
// （真 Chromium ＋ 真 CDP 键盘事件 ＋ 假 API；底座与 `test/manager-questions-ui.mjs` 同一套 `ui-harness.mjs`）。
//
// 业主原话（2026-10-05）：**「问题页面，手动回答的框无法通过 shift+enter 换行，添加上这个功能。」**
// 业主原话（2026-10-06）：**「两件都做 —— ① 回答框改成『随内容长高』（设上限，不再钉死 26px）；
//   ②『关闭原因』框也修成 Shift+Enter 换行（同一条守卫 ＋ 换多行 ＋ 门里加断言）。」**
// ⚠️ 本门的一条**换口径**（业主明确撤回了旧口令「不加自动增高」）：旧断言
//   `answer-control-stays-one-row`（框高 24–28px，锚住「不许长高」）**不再成立**，已换成三件事 ——
//   `answer-control-empty-stays-26px`（空的时候仍是 26px 一档）／`answer-control-grows-with-content`（有内容会长高）／
//   `answer-control-caps-and-scrolls`（到上限 5 行 = 122px 就不再长，改由框内滚动）。
//   这不是悄悄放宽：旧的「不许长高」那一半被**业主点名作废**，新的三件事各有自己的红半（见反证臂 ②）。
//
// ── 为什么是「真浏览器 ＋ 真按键」，而不是假 DOM 里断一次 keydown ──────────────────────────────
// 「Shift+Enter 换行」这件事，一半是**我们**（keydown 里不拦默认行为 ⇒ 让它落到控件上）、
// 一半是**浏览器**（默认动作：往多行控件的光标处插一个 `\n`）。假 DOM 里没有这一半 ——
// `web/test` 的假 DOM 里 `keydown` 派发出去只会调用监听器，没有插入动作，**量不到值有没有多一行**。
// 所以本门用 `Input.dispatchKeyEvent`（真 `keyDown` ＋ `text`，走浏览器输入管线），
// **不是** `node.value = …`（那种写法把「谁把 `\n` 放进去的」这件事整个跳过）。
// 「随内容长高」同理：量的是**渲染出来的框盒高**（`getBoundingClientRect`），不是某个变量。
//
// ── 五条腿（每条都有自己的红半）────────────────────────────────────────────────────────
//   ① 控件形状：回答框与「关闭原因」框都必须是**多行控件**（`<textarea>`）—— 单行 `<input type="text">`
//      里 `\n` 无处可去（浏览器根本不往单行框里插换行）。改前两者都是 `<input type="text">`。
//   ② `Shift+Enter` ⇒ 值里**多了且只多一个** `\n`，且**一笔写都没发**（提交次数 0、条目不动）——
//      回答框与关闭原因框各一条。
//   ③ `Enter` ⇒ **今天的既有行为一字不变**（回答框提交答案；关闭原因框提交**这次关闭**）。
//   ④ 随内容长高（回答框 ＋ 关闭原因框**同源一处**）：空 ⇒ 26px；有内容 ⇒ 跟着长；到上限（5 行 = 122px）
//      ⇒ 不再长、改由框内滚动（`scrollHeight > clientHeight`）。
//   ＋「留得住」那一半：答完 / 关完之后，已答页那条留痕**真的是两行**（`white-space: pre-wrap` 且
//      渲染高度 > 同样文字折成一行的对照高度）—— 不是「textContent 里有 `\n`」就算数
//      （白空间会把 `\n` 折回一行，`textContent` 照样带着 `\n`，那是**假绿**）。
//
// ── 三条反证臂（每条都真打红；「臂崩 ≠ 臂红」）──────────────────────────────────────────
// 只在 `web/` 的**副本**上改一处（产品原件一个字节不动），再拿**同一套断言**去量那份副本。
//   ① `--reverse-arm=no-newline-guard`：删掉 `web/app.js` 那条 Shift+Enter 守卫 ⇒ 换行那一整条腿（回答 ＋ 关闭原因）
//      必红，而「Enter 照样提交」「随内容长高」必须仍然**绿**。
//   ② `--reverse-arm=no-autogrow`：删掉 `autoGrowField` 里「量高度并撑开」那三行 ⇒ 框回到底部固定高（26px），
//      三条「随内容长高」必红，而换行那几条腿必须仍然**绿**。
//   ③ `--reverse-arm=no-close-reason-guard`：把 `MULTILINE_FIELDS` 里 `close-reason` 那一格拿掉
//      ⇒ 只有**关闭原因框**那条换行断言必红，回答框那条必须仍然**绿**（证明守卫是同源一份、臂是外科式的）。
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupStep, removeSandbox } from './harness.mjs';
import { boot, readBody, sendJson, waitFor } from './ui-harness.mjs';

const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;

// ── 反证臂的接缝（`from` 必须逐字在仓里找得到、且在 `file` 里恰好一处；见 `test:armseams`）──────
const ARM_MUTANTS = {
  'no-newline-guard': {
    what: '把 `web/app.js` 里 Shift+Enter 那条守卫删掉 —— Shift+Enter 退化成改前的行为（照样提交，框里不落 `\\n`）',
    file: 'web/app.js',
    from: "  if (event.shiftKey && MULTILINE_FIELDS.has(input.dataset.field)) return;\n",
    to: '',
    expect: ['shift-enter-adds-exactly-one-newline', 'shift-enter-does-not-submit', 'answer-body-keeps-real-newline', 'answered-trail-renders-two-lines',
      'close-reason-shift-enter-adds-exactly-one-newline', 'close-reason-shift-enter-does-not-submit', 'closed-reason-trail-renders-two-lines'],
    expectGreen: ['answer-control-is-multiline', 'answer-control-empty-stays-26px', 'answer-control-grows-with-content', 'answer-control-caps-and-scrolls', 'answer-box-growth-does-not-overflow-card',
      'enter-still-submits-single-line-answer', 'close-reason-control-is-multiline', 'close-reason-grows-with-content', 'close-reason-enter-still-submits'],
  },
  'no-autogrow': {
    what: '把 `web/app.js` 的 `autoGrowField` 里「量高度并撑开」那三行删掉 —— 框回到底部固定高（26px），「随内容长高」必红',
    file: 'web/app.js',
    from: "  node.style.height = 'auto';\n  const needed = node.scrollHeight + border;\n  node.style.height = `${Math.max(min, Math.min(needed, cap))}px`;\n",
    to: '',
    expect: ['answer-control-grows-with-content', 'answer-control-caps-and-scrolls', 'close-reason-grows-with-content'],
    expectGreen: ['answer-control-is-multiline', 'answer-control-empty-stays-26px',
      'answer-box-growth-does-not-overflow-card',
      'shift-enter-adds-exactly-one-newline', 'shift-enter-does-not-submit', 'answer-body-keeps-real-newline', 'answered-trail-renders-two-lines',
      'enter-still-submits-single-line-answer', 'close-reason-control-is-multiline',
      'close-reason-shift-enter-adds-exactly-one-newline', 'close-reason-shift-enter-does-not-submit', 'closed-reason-trail-renders-two-lines',
      'close-reason-enter-still-submits'],
  },
  'no-close-reason-guard': {
    what: '把 `web/app.js` 的 `MULTILINE_FIELDS` 里 `close-reason` 那一格拿掉 —— 关闭原因框退化成改前的行为（Shift+Enter 照样提交这次关闭、框里不落 `\\n`）',
    file: 'web/app.js',
    from: "const MULTILINE_FIELDS = new Set(['answer', 'close-reason']);",
    to: "const MULTILINE_FIELDS = new Set(['answer']);",
    expect: ['close-reason-shift-enter-adds-exactly-one-newline', 'close-reason-shift-enter-does-not-submit', 'closed-reason-trail-renders-two-lines'],
    expectGreen: ['answer-control-is-multiline', 'answer-control-empty-stays-26px', 'answer-control-grows-with-content', 'answer-control-caps-and-scrolls', 'answer-box-growth-does-not-overflow-card',
      'shift-enter-adds-exactly-one-newline', 'shift-enter-does-not-submit', 'answer-body-keeps-real-newline', 'answered-trail-renders-two-lines',
      'enter-still-submits-single-line-answer', 'close-reason-control-is-multiline', 'close-reason-grows-with-content', 'close-reason-enter-still-submits'],
  },
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sandbox = path.join(os.tmpdir(), `sopho-questions-newline-${process.pid}`);
const webRoot = ARM ? path.join(sandbox, 'web-copy') : path.join(root, 'web');
const artifacts = path.join(os.tmpdir(), 'sopho-questions-newline');
// 反证臂那一跑的产物自带 `arm-<名字>` 后缀：两跑写同一个文件名时，后跑（通常是臂）会把正跑那张
// 截图**覆盖**掉 —— 那时留档里那张图是变异后的页面，看的人会把它当成修好之后的证据（本仓踩过这种）。
const shotName = (base) => (ARM ? `${base}.arm-${ARM}.png` : base);
const screenshotQuestions = path.join(artifacts, shotName('questions-answer-1200x760.png'));
const screenshotAnswered = path.join(artifacts, shotName('answered-newline-1200x760.png'));

if (ARM) {
  // 臂的**准备**自己失败（认不出的臂 / `from` 没命中 / 改写没落地 / 拷贝失败）也要先把自己建的
  // `web-copy` 删干净再抛 —— 那时还没进下面那个 `try`，`finally` 里的收尾不会跑（本仓因为这种
  // 「在模块顶部抛」留下过沙箱：一条命中 0 次的臂把拷的 `web-copy/` 留在了 `/tmp`）。
  try {
    const arm = ARM_MUTANTS[ARM];
    if (!arm) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
    const relative = path.relative(path.join(root, 'web'), path.join(root, arm.file));
    if (relative.startsWith('..')) throw new Error(`反证臂 ${ARM} 的 file 不在 web/ 里：${arm.file}`);
    await mkdir(sandbox, { recursive: true });
    await cp(path.join(root, 'web'), webRoot, { recursive: true });
    const target = path.join(webRoot, relative);
    const text = await readFile(target, 'utf8');
    const hits = text.split(arm.from).length - 1;
    if (hits !== 1) throw new Error(`反证臂 ${ARM} 的 from 在 ${arm.file} 里出现 ${hits} 次（要求恰好 1 次）：${JSON.stringify(arm.from)}`);
    await writeFile(target, text.replace(arm.from, arm.to), 'utf8');
    const mutated = await readFile(target, 'utf8');
    if (mutated.includes(arm.from) || mutated === text) throw new Error(`反证臂 ${ARM} 的改写没落地：${arm.file}`);
    process.stdout.write(`反证臂 ${ARM}：${arm.what}\n  跑在副本上：${path.join('web-copy', relative)}\n`);
  } catch (error) {
    const problems = [];
    await removeSandbox(sandbox, problems);
    if (problems.length > 0) process.stderr.write(`反证臂准备失败后的收尾问题：${problems.join('; ')}\n`);
    throw error;
  }
}

// ── 夹具：一个会话、五条未答问题 ────────────────────────────────────────────────────────────
//   q1 走「真键盘的两行答案」（Shift+Enter 换行 ＋ Enter 提交）；q2 走「Enter 照样提交一句话」；
//   q3 走「关闭原因框 Shift+Enter 换行 ＋ Enter 提交这次关闭」；q4 走「关闭原因框 Enter 照样提交」；
//   growth 只用来量「随内容长高」（用 `Input.insertText` 一次插多行，不碰 Shift+Enter 那条守卫，
//   这样它在臂 ①③ 里也保持绿 —— 那两条臂只该打动换行那一条腿）。
const sessionId = '11111111-1111-4111-8111-111111111111';
const qids = { first: 'q-0000aaaa', second: 'q-0000bbbb', third: 'q-0000cccc', fourth: 'q-0000dddd', growth: 'q-0000eeee' };
const T = Date.now() - 3_600_000;
const store = [
  { id: qids.first, op: 'ask', text: '换行门：这条要用手动回答框答（两行）', options: null, priority: 'normal', by: 'agent', at: T, context: '夹具背景：验「Shift+Enter 插的换行真的留得住」——不是「看着像换行」。' },
  { id: qids.second, op: 'ask', text: '换行门：这条只验 Enter 的既有行为没变', options: null, priority: 'normal', by: 'agent', at: T + 60_000, context: '夹具背景：一句话回答（不带换行），用来证「Enter 还是提交一次」这条腿没被本笔改动碰坏。' },
  { id: qids.third, op: 'ask', text: '换行门：「关闭原因」框这条要用手动键答（两行）', options: null, priority: 'normal', by: 'agent', at: T + 120_000, context: '夹具背景：验「关闭原因框 Shift+Enter 换行」且关上之后留痕真的是两行。' },
  { id: qids.fourth, op: 'ask', text: '换行门：「关闭原因」框这条只验 Enter 照样提交这次关闭', options: null, priority: 'normal', by: 'agent', at: T + 180_000, context: '夹具背景：关闭原因框按 Enter 提交（今天的既有行为）一字不动；顺带在这一条上量「关闭原因框随内容长高」。' },
  { id: qids.growth, op: 'ask', text: '换行门：这条只用来量「随内容长高、到上限转框内滚动」', options: null, priority: 'normal', by: 'agent', at: T + 240_000, context: '夹具背景：框高的判据只跟「框里有没有内容」有关，与怎么把内容放进去无关。' },
];
const stateOf = (id) => {
  const out = {
    id, status: 'open', text: null, options: null, priority: null, at: null, by: null, askedAt: null, askedBy: null,
    answer: null, answeredAt: null, answerBy: null, closeReason: null, closedAt: null, closedBy: null,
    context: null, updatedAt: null, updatedBy: null,
  };
  for (const row of store.filter((entry) => entry.id === id)) {
    if (typeof row.text === 'string') out.text = row.text;
    if (Number.isFinite(row.at)) out.at = row.at;
    if (typeof row.by === 'string') out.by = row.by;
    if (row.op === 'ask') {
      out.status = 'open';
      out.askedAt = Number.isFinite(row.at) ? row.at : null;
      out.askedBy = row.by ?? null;
      out.options = Array.isArray(row.options) ? row.options : null;
      out.priority = row.priority ?? null;
      out.context = typeof row.context === 'string' ? row.context : null;
    }
    if (row.op === 'answer') {
      out.status = 'answered';
      out.answer = String(row.answer ?? '');
      out.answeredAt = Number.isFinite(row.at) ? row.at : null;
      out.answerBy = row.by ?? null;
    }
    if (row.op === 'close') {
      out.status = 'closed';
      out.closeReason = String(row.closeReason ?? '');
      out.closedAt = Number.isFinite(row.at) ? row.at : null;
      out.closedBy = row.by ?? null;
    }
  }
  return out;
};
const questionsPayload = (status) => {
  const wire = [...new Set(store.map((entry) => entry.id))].map(stateOf);
  const counts = { open: 0, answered: 0, closed: 0, concluded: 0, total: wire.length };
  for (const row of wire) { counts[row.status] += 1; if (row.status !== 'open') counts.concluded += 1; }
  const filtered = wire.filter((row) => (status === 'all' ? true : status === 'open' ? row.status === 'open' : row.status !== 'open'));
  return { questions: filtered, counts, filteredCount: filtered.length };
};
const treePayload = () => ({
  sessions: [{ id: sessionId, name: 'Newline fixture', parentId: null, archived: false, cwd: '/work/fixture', status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: new Date(T).toISOString(), notify: { notifies: [], waitingFor: [] } }],
  unread: { count: 0 },
});
const control = { answerRequests: [], closeRequests: [], questionStatuses: [] };

// ── 检查（不抛错，逐条记账）：反证臂要按 id 分辨「哪条红」────────────────────────────────
const results = [];
const checks = { passed: 0, failed: 0 };
const check = (id, ok, detail) => {
  results.push({ id, ok });
  if (ok) { checks.passed += 1; process.stdout.write(`✓ ${id} —— ${detail}\n`); }
  else { checks.failed += 1; process.stdout.write(`✗ ${id}\n  实测：${detail}\n`); }
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

let ui;
try {
  await mkdir(artifacts, { recursive: true });
  ui = await boot({
    width: 1200,
    height: 760,
    webRoot,
    routes: async (request, response, url) => {
      const { pathname } = url;
      if (pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
      if (pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
      if (pathname === '/api/tree') return sendJson(response, 200, treePayload()), true;
      if (pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload())}\n\n`);
        return true;
      }
      if (pathname === '/control/state') return sendJson(response, 200, { answers: control.answerRequests, questionStatuses: control.questionStatuses, store }), true;
      const questionsMatch = /^\/api\/sessions\/([^/]+)\/questions$/.exec(pathname);
      if (questionsMatch) {
        if (request.method === 'GET') {
          const status = url.searchParams.get('status') || 'open';
          control.questionStatuses.push(status);
          return sendJson(response, 200, questionsPayload(status)), true;
        }
        const raw = await readBody(request);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 坏输入由下面如实拒 */ }
        const op = body.op;
        const qid = typeof body.qid === 'string' ? body.qid : null;
        if (op !== 'answer' && op !== 'close') return sendJson(response, 400, { error: 'invalid_op', message: 'op must be one of ask, answer, close' }), true;
        // 记账**先于**校验：本门要能断言「前端一次都没发」这件事本身。
        const record = { method: request.method, path: pathname, contentType: request.headers['content-type'], body };
        if (op === 'answer') control.answerRequests.push(record);
        else control.closeRequests.push(record);
        if (!qid || !store.some((entry) => entry.id === qid)) return sendJson(response, 404, { error: 'question_not_found', message: `no question with id ${qid}`, id: qid }), true;
        const at = Date.now();
        // 服务端**原样**存下文本（不折行、不去 `\n`）—— 这是「留得住」的服务端那一半。
        if (op === 'answer') store.push({ id: qid, op: 'answer', text: stateOf(qid).text, answer: String(body.text ?? ''), by: 'user', at });
        else store.push({ id: qid, op: 'close', text: stateOf(qid).text, closeReason: String(body.reason ?? ''), by: 'user', at });
        const status = op === 'answer' ? 'answered' : 'closed';
        return sendJson(response, 200, { ok: true, id: qid, status, at, by: 'user', question: stateOf(qid) }), true;
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|seen|draft|commands))?$/.exec(pathname);
      if (sessionMatch) {
        const action = sessionMatch[2] ?? null;
        if (action === 'messages') return sendJson(response, 200, { messages: [{ role: 'user', text: '夹具消息' }], extras: [], compaction: { atIndex: null, note: '' }, observability: null }), true;
        if (action === 'seen' && request.method === 'POST') return sendJson(response, 200, { ok: true, id: sessionMatch[1], unread: false }), true;
        if (action === 'draft') { await readBody(request); return sendJson(response, 200, { text: '' }), true; }
        if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
          return true;
        }
        return sendJson(response, 200, {
          name: 'Newline fixture', cwd: '/work/fixture', archived: false,
          runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null,
        }), true;
      }
      return false;
    },
  });
  const problemsAtStart = ui.pageProblems.length;

  // ── 真键盘：走 `Input.dispatchKeyEvent`（`keyDown` ＋ `text`）⇒ 浏览器自己会做默认动作 ─────────
  const pressKey = async ({ key, code, keyCode, modifiers = 0, text }) => {
    await ui.browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
    await ui.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
    await ui.frames(3);
  };
  // Enter 的 `text` 给 `\r`（物理按键就是这个），浏览器据此做它的默认动作。
  const pressEnter = (modifiers = 0) => pressKey({ key: 'Enter', code: 'Enter', keyCode: 13, modifiers, text: '\r' });
  const pressShiftEnter = () => pressEnter(8);

  const focusField = (qid, field) => ui.evaluate(`(() => {
    const node = document.querySelector('[data-question-id="'+${JSON.stringify(qid)}+'"] [data-field="'+${JSON.stringify(field)}+'"]');
    if (!node) return false;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    return document.activeElement === node;
  })()`);
  // 一手读数：值 ＋ 渲染出来的框盒高 ＋ 滚动量（「长高到上限转框内滚动」这条就靠后两项）。
  const readField = (qid, field) => ui.evaluate(`(() => {
    const node = document.querySelector('[data-question-id="'+${JSON.stringify(qid)}+'"] [data-field="'+${JSON.stringify(field)}+'"]');
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const css = getComputedStyle(node);
    return {
      value: node.value, tagName: node.tagName, focused: document.activeElement === node, selectionStart: node.selectionStart,
      h: Math.round(box.height * 100) / 100, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      css: { whiteSpace: css.whiteSpace, overflowY: css.overflowY, minHeight: css.minHeight, maxHeight: css.maxHeight, lineHeight: css.lineHeight },
    };
  })()`);
  const readAnswer = (qid) => readField(qid, 'answer');
  const focusAnswer = (qid) => focusField(qid, 'answer');
  const readClose = (qid) => readField(qid, 'close-reason');
  const focusClose = (qid) => focusField(qid, 'close-reason');
  // `Input.insertText` 一次插多行（含 `\n`）：这是**粘贴式**插入，不经过 keydown ⇒ 与 Shift+Enter 那条
  // 守卫无关；「随内容长高」的判据只该被「框里有没有内容」打动（见反证臂 ②）。
  const typeText = (text) => ui.browser.send('Input.insertText', { text }).then(() => ui.frames(2));
  const click = (selector) => ui.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const waitReady = () => waitFor(async () => (await ui.evaluate(`document.querySelector('#questions-list')?.dataset.load`)) === 'ready', '问题页没有读到 ready');
  const answerOf = (qid) => control.answerRequests.filter((item) => item.body?.qid === qid).at(-1) ?? null;
  const closeOf = (qid) => control.closeRequests.filter((item) => item.body?.qid === qid).at(-1) ?? null;

  // ── 0. 打开会话 + 问题页 ────────────────────────────────────────────────────────────
  await waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), '左栏没渲染出来');
  await ui.evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), '会话没打开');
  await click('#view-tab-questions');
  await waitReady();
  await waitFor(async () => (await ui.evaluate(`document.querySelectorAll('#questions-list .question-item').length`)) === 5, '五条未答没画出来');

  // 改前/改后都打这一行：这是「控件今天到底是什么」的一手读数（交付报告里逐字贴它）。
  const shape = await ui.evaluate(`(() => {
    const node = document.querySelector('#questions-list [data-field="answer"]');
    if (!node) return { missing: true };
    const css = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return {
      tagName: node.tagName, type: node.getAttribute('type'), rows: node.getAttribute('rows'),
      placeholder: node.placeholder, disabled: node.disabled,
      css: { whiteSpace: css.whiteSpace, resize: css.resize, height: css.height, minHeight: css.minHeight, maxHeight: css.maxHeight, lineHeight: css.lineHeight, overflowY: css.overflowY, padding: css.padding },
      box: { w: Math.round(box.width), h: Math.round(box.height) },
    };
  })()`);
  print('回答控件的真实读数（shape）', shape);
  await ui.screenshot(screenshotQuestions);

  check('answer-control-is-multiline', shape.tagName === 'TEXTAREA',
    `tagName=${shape.tagName}（单行 <input type="text"> 里 \`\\n\` 无处可去 ⇒ 多行控件是换行的最小必要前提）`);
  // ⚠️ 换口径（业主 2026-10-06 明确撤回旧口令「不加自动增高」）：旧断言 `answer-control-stays-one-row`
  // 断的是「24–28px 且**不许长高**」；今天只保留它的前一半 —— **空**框仍是 26px（下面这条），
  // 「有内容会长高」「到上限转滚动」由后面两条各管一半。
  check('answer-control-empty-stays-26px', shape.box.h <= 28 && shape.box.h >= 24,
    `空框盒高 ${shape.box.h}px / width ${shape.box.w}px（与改前的单行框同一档 26px；不许被全局 \`textarea\` 那条 min-height:3.5rem 撑成两行）`);

  // ── ④ 随内容长高（回答框）：空 26px ⇒ 一行 26px ⇒ 三行跟着长 ⇒ 到上限 5 行 = 122px 不再长、框内滚 ──
  const focusGrowth = await focusAnswer(qids.growth);
  await typeText('一行');
  const g1 = await readAnswer(qids.growth);
  await typeText('\n二行');
  await typeText('\n三行');
  const g3 = await readAnswer(qids.growth);
  await typeText('\n四行\n五行\n六行');
  const g6 = await readAnswer(qids.growth);
  await typeText('\n七行');
  const g7 = await readAnswer(qids.growth);
  print('回答框随内容长高的读数', { focused: focusGrowth, g1: g1?.h ?? null, g3: g3?.h ?? null, g6: g6?.h ?? null, g7: g7?.h ?? null, 六行滚动: { scrollHeight: g6?.scrollHeight ?? null, clientHeight: g6?.clientHeight ?? null, overflowY: g6?.css?.overflowY ?? null } });

  // 长的框不许把卡片/右栏撑宽（业主：它在问题卡里 —— 量一下卡与右栏有没有被挤 / 溢出）。
  // 量的是**真的长到上限那一下**：`#questions-list` 没横向溢出、卡片不宽于列表容器。
  const layout = await ui.evaluate(`(() => {
    const list = document.querySelector('#questions-list');
    const item = document.querySelector('[data-question-id="'+${JSON.stringify(qids.growth)}+'"]');
    const box = document.querySelector('[data-question-id="'+${JSON.stringify(qids.growth)}+'"] [data-field="answer"]');
    return {
      listClientWidth: list.clientWidth, listScrollWidth: list.scrollWidth,
      itemWidth: Math.round(item.getBoundingClientRect().width),
      boxWidth: Math.round(box.getBoundingClientRect().width),
    };
  })()`);
  print('长到上限时卡片/列表的宽度读数', layout);

  const CAP = 122; // 24px 行高 × 5 行 ＋ 2px 边框 —— 与 `web/index.html` 那条 `max-height` 同一个数
  check('answer-control-grows-with-content',
    g1?.h <= 28 && g3 !== null && g3.h > g1.h && Math.abs(g3.h - 74) <= 2,
    JSON.stringify({ 一行高: g1?.h ?? null, 三行高: g3?.h ?? null, 期望三行: 74 }));
  check('answer-box-growth-does-not-overflow-card',
    layout.listScrollWidth <= layout.listClientWidth + 1 && layout.itemWidth <= layout.listClientWidth + 1,
    JSON.stringify(layout));
  check('answer-control-caps-and-scrolls',
    g6 !== null && Math.abs(g6.h - CAP) <= 2 && g7 !== null && Math.abs(g7.h - CAP) <= 2
    && g6.scrollHeight > g6.clientHeight && g6.css?.overflowY === 'auto',
    JSON.stringify({ 六行高: g6?.h ?? null, 七行高: g7?.h ?? null, 期望上限: CAP, 六行scrollHeight: g6?.scrollHeight ?? null, 六行clientHeight: g6?.clientHeight ?? null, overflowY: g6?.css?.overflowY ?? null }));

  // ── ① Shift+Enter ⇒ 值里多了且只多一个 `\n`，且**一次写都没发**（回答框）──────────────────────
  const focused = await focusAnswer(qids.first);
  await typeText('第一行');
  const before = await readAnswer(qids.first);
  const writesBefore = control.answerRequests.length;
  await pressShiftEnter();
  const afterShiftEnter = await readAnswer(qids.first);
  const writesAfterShiftEnter = control.answerRequests.length;
  print('回答框 Shift+Enter 前后', { focused, before: before?.value, after: afterShiftEnter?.value ?? null, selectionStart: afterShiftEnter?.selectionStart ?? null, writesBefore, writesAfterShiftEnter });

  const added = afterShiftEnter === null ? null : afterShiftEnter.value.slice((before?.value ?? '').length);
  check('shift-enter-adds-exactly-one-newline',
    added === '\n' && afterShiftEnter?.value.split('\n').length - 1 === 1,
    JSON.stringify({ value: afterShiftEnter?.value ?? null, 新增的那一段: added, 换行数: afterShiftEnter ? afterShiftEnter.value.split('\n').length - 1 : null }));
  check('shift-enter-does-not-submit',
    writesAfterShiftEnter === writesBefore,
    JSON.stringify({ 提交次数: writesAfterShiftEnter - writesBefore, 请求: control.answerRequests.map((item) => item.body) }));

  // ── ② Enter ⇒ 今天的既有行为：提交一发，且 `body.text` 逐字带上真键盘敲出来的 `\n` ────────
  await typeText('第二行');
  const twoLines = await readAnswer(qids.first);
  await pressEnter();
  await waitFor(() => answerOf(qids.first) !== null, 'Enter 那笔答案没发出去（既有行为被改坏了？）');
  const firstWrite = answerOf(qids.first);
  print('Enter 提交的 body', firstWrite?.body);
  print('真键盘敲出来的两行', twoLines?.value ?? null);

  check('answer-body-keeps-real-newline',
    JSON.stringify(firstWrite?.body) === JSON.stringify({ op: 'answer', qid: qids.first, text: '第一行\n第二行' })
    && firstWrite?.path === `/api/sessions/${sessionId}/questions`
    && firstWrite?.method === 'POST',
    JSON.stringify({ body: firstWrite?.body ?? null, 期望: { op: 'answer', qid: qids.first, text: '第一行\n第二行' }, path: firstWrite?.path ?? null, 框里的值: twoLines?.value ?? null }));

  // ── ③ q2：Enter 的既有行为（一句话、不带换行）—— 反证臂里这一条必须仍然绿 ──────────────────
  await waitFor(async () => (await ui.evaluate(`document.querySelectorAll('#questions-list .question-item').length`)) === 4, '答完之后 q1 没从未答消失');
  const focusedSecond = await focusAnswer(qids.second);
  await typeText('一句话回答');
  await pressEnter();
  await waitFor(() => answerOf(qids.second) !== null, 'Enter 在第二条上没提交');
  const secondWrite = answerOf(qids.second);
  print('第二条 Enter 提交的 body', secondWrite?.body);
  check('enter-still-submits-single-line-answer',
    focusedSecond && JSON.stringify(secondWrite?.body) === JSON.stringify({ op: 'answer', qid: qids.second, text: '一句话回答' })
    && control.answerRequests.length === 2,
    JSON.stringify({ body: secondWrite?.body ?? null, 笔数: control.answerRequests.length, focused: focusedSecond }));

  // ── ⑤「关闭原因」框：多行控件 ＋ Shift+Enter 换行（不提交）＋ Enter 仍提交这次关闭 ──────────────
  await click(`[data-question-id="${qids.third}"] button[data-action="close"]`);
  await waitFor(() => ui.evaluate(`document.querySelector('[data-question-id="${qids.third}"] [data-field="close-reason"]') !== null`), '关闭确认行没出现（q3）');
  const closeShape = await readClose(qids.third);
  check('close-reason-control-is-multiline', closeShape?.tagName === 'TEXTAREA',
    `tagName=${closeShape?.tagName ?? null}（改前它是单行 <input type="text">；单行框里 \`\\n\` 无处可去）`);

  const closeFocused = await focusClose(qids.third);
  await typeText('原因第一行');
  const closeBefore = await readClose(qids.third);
  const closeWritesBefore = control.closeRequests.length;
  await pressShiftEnter();
  const closeAfter = await readClose(qids.third);
  const closeWritesAfter = control.closeRequests.length;
  print('关闭原因框 Shift+Enter 前后', { focused: closeFocused, before: closeBefore?.value ?? null, after: closeAfter?.value ?? null, writesBefore: closeWritesBefore, writesAfter: closeWritesAfter });

  const closeAdded = closeAfter === null ? null : closeAfter.value.slice((closeBefore?.value ?? '').length);
  check('close-reason-shift-enter-adds-exactly-one-newline',
    closeAdded === '\n' && closeAfter?.value.split('\n').length - 1 === 1,
    JSON.stringify({ value: closeAfter?.value ?? null, 新增的那一段: closeAdded, 换行数: closeAfter ? closeAfter.value.split('\n').length - 1 : null }));
  check('close-reason-shift-enter-does-not-submit',
    closeWritesAfter === closeWritesBefore && closeOf(qids.third) === null,
    JSON.stringify({ 提交次数: closeWritesAfter - closeWritesBefore, 请求: control.closeRequests.map((item) => item.body) }));

  // 把这两行原因提交上去（真键盘），供下面「留痕真的是两行」那一条量渲染高度。
  await typeText('原因第二行');
  const closeTwo = await readClose(qids.third);
  await pressEnter();
  await waitFor(() => closeOf(qids.third) !== null, '关闭原因框的 Enter 没提交这次关闭（既有行为被改坏了？）');
  print('关闭原因框 Enter 提交的 body', closeOf(qids.third)?.body);

  // ── ⑥ q4：关闭原因框 Enter 仍提交一次 ＋ 随内容长高（这条不碰 Shift+Enter，臂 ①③ 里保持绿）──────
  await click(`[data-question-id="${qids.fourth}"] button[data-action="close"]`);
  await waitFor(() => ui.evaluate(`document.querySelector('[data-question-id="${qids.fourth}"] [data-field="close-reason"]') !== null`), '关闭确认行没出现（q4）');
  const focusedFourth = await focusClose(qids.fourth);
  await typeText('一行');
  const c1 = await readClose(qids.fourth);
  await typeText('\n二行\n三行');
  const c3 = await readClose(qids.fourth);
  print('关闭原因框随内容长高的读数', { h1: c1?.h ?? null, h3: c3?.h ?? null, value: c3?.value ?? null });
  check('close-reason-grows-with-content',
    c1?.h <= 28 && c3 !== null && c3.h > c1.h && Math.abs(c3.h - 74) <= 2,
    JSON.stringify({ 一行高: c1?.h ?? null, 三行高: c3?.h ?? null, 期望三行: 74 }));

  await pressEnter();
  await waitFor(() => closeOf(qids.fourth) !== null, '关闭原因框 Enter 在第四条上没提交');
  const fourthWrite = closeOf(qids.fourth);
  print('第四条 Enter 提交的 body', fourthWrite?.body);
  check('close-reason-enter-still-submits',
    focusedFourth && JSON.stringify(fourthWrite?.body) === JSON.stringify({ op: 'close', qid: qids.fourth, reason: '一行\n二行\n三行' })
    && fourthWrite?.path === `/api/sessions/${sessionId}/questions`,
    JSON.stringify({ body: fourthWrite?.body ?? null, 期望: { op: 'close', qid: qids.fourth, reason: '一行\n二行\n三行' }, focused: focusedFourth }));

  // ── ⑦ 「留得住」的界面那一半：已答页那两条留痕**真的是两行**（回答 ＋ 关闭原因）─────────────────
  await click('#questions-filter-answered');
  await waitFor(async () => (await ui.evaluate(`document.querySelector('#questions-list')?.dataset.status`)) === 'answered'
    && (await ui.evaluate(`document.querySelector('[data-question-id="${qids.first}"] .question-trail') !== null`)), '已答页没画出 q1 的留痕');
  // 量**渲染高度**：只量「textContent 里有没有 `\n`」会被白空间把换行折掉骗过去（那串 `\n` 还在）。
  const trailProbe = (qid, prefix) => ui.evaluate(`(() => {
    const item = document.querySelector('.question-item[data-question-id="'+${JSON.stringify(qid)}+'"]');
    if (!item) return { missing: true };
    const node = [...item.querySelectorAll('.question-trail')].find((entry) => entry.textContent.startsWith(${JSON.stringify(prefix)}));
    if (!node) return { missing: true };
    const clone = node.cloneNode(true);
    clone.textContent = node.textContent.replace(/\\n/g, '，');
    node.after(clone);
    const twoLineHeight = node.getBoundingClientRect().height;
    const oneLineHeight = clone.getBoundingClientRect().height;
    clone.remove();
    return { text: node.textContent, whiteSpace: getComputedStyle(node).whiteSpace, twoLineHeight, oneLineHeight };
  })()`);
  const answerTrail = await trailProbe(qids.first, '回答：');
  const reasonTrail = await trailProbe(qids.third, '原因：');
  print('已答页留痕（回答那一行）的真实读数', answerTrail);
  print('已答页留痕（关闭原因那一行）的真实读数', reasonTrail);
  await ui.screenshot(screenshotAnswered);

  check('answered-trail-renders-two-lines',
    answerTrail.text === '回答：第一行\n第二行' && answerTrail.whiteSpace === 'pre-wrap' && answerTrail.twoLineHeight > answerTrail.oneLineHeight,
    JSON.stringify({ text: answerTrail.text ?? null, whiteSpace: answerTrail.whiteSpace ?? null, 两行高: answerTrail.twoLineHeight ?? null, 折成一行的对照高: answerTrail.oneLineHeight ?? null }));
  check('closed-reason-trail-renders-two-lines',
    reasonTrail.text === '原因：原因第一行\n原因第二行' && reasonTrail.whiteSpace === 'pre-wrap' && reasonTrail.twoLineHeight > reasonTrail.oneLineHeight,
    JSON.stringify({ text: reasonTrail.text ?? null, whiteSpace: reasonTrail.whiteSpace ?? null, 两行高: reasonTrail.twoLineHeight ?? null, 折成一行的对照高: reasonTrail.oneLineHeight ?? null }));

  // ── ⑧ 页面自身不许有未捕获异常 / console.error ────────────────────────────────────────
  const unexpected = ui.pageProblems.slice(problemsAtStart);
  check('page-has-no-uncaught-errors', unexpected.length === 0, JSON.stringify({ problems: unexpected }));

  print('answer requests', control.answerRequests.map((item) => item.body));
  print('close requests', control.closeRequests.map((item) => item.body));
  print('questions GET statuses', control.questionStatuses);
  print('screenshots', { questions: screenshotQuestions, answered: screenshotAnswered });
} catch (error) {
  process.exitCode = 1;
  process.stdout.write(`\n✗ FAIL（异常，不是断言红）：${error?.stack || error}\n`);
} finally {
  const cleanupProblems = [];
  try { const cleanup = await ui?.close(cleanupProblems); if (cleanup) print('cleanup', { ok: cleanup.ok, removed: cleanup.removed, problems: cleanup.problems }); } catch (error) { process.stdout.write(`cleanup: ${error}\n`); }
  // 反证臂那份 `web-copy` 是本门自己建的 —— 按共享口径收敛式删（删 → 空窗复核 → 还在就再删）。
  if (ARM) await cleanupStep(cleanupProblems, 'remove web-copy sandbox', () => removeSandbox(sandbox, cleanupProblems));
  const red = results.filter((row) => !row.ok).map((row) => row.id);
  if (ARM) {
    const arm = ARM_MUTANTS[ARM];
    const notRed = arm.expect.filter((id) => !red.includes(id));
    const wronglyRed = (arm.expectGreen ?? []).filter((id) => red.includes(id));
    print(`反证臂 ${ARM} 结果`, { what: arm.what, expect: arm.expect, expectGreen: arm.expectGreen ?? [], actuallyRed: red });
    if (notRed.length === 0 && wronglyRed.length === 0 && cleanupProblems.length === 0) {
      print('RESULT', `反证臂 ${ARM} 红到位（这是**期望**的结果，不是缺陷）：它该打动的那条腿每条断言都红了，其余腿仍绿`);
    } else {
      print('RESULT', `反证臂 ${ARM} **没红到位**：没红的是 ${JSON.stringify(notRed)}；本该留绿却红了 ${JSON.stringify(wronglyRed)}；收尾问题 ${JSON.stringify(cleanupProblems)} ⇒ 这道门是个假门`);
      process.exitCode = 1;
    }
  } else {
    if (cleanupProblems.length > 0) { process.exitCode = 1; print('RESULT', `收尾不干净：${JSON.stringify(cleanupProblems)}`); }
    else if (red.length > 0) { process.exitCode = 1; print('RESULT', `问题页回答框换行门 FAIL：红了 ${JSON.stringify(red)}`); }
    else print('RESULT', `问题页回答框换行门 PASS（${checks.passed} 项）`);
  }
}
