#!/usr/bin/env node
// test/questions-token-width.mjs —— 问题页「长无断点 token 撑宽」这条用户报告的机械门
// （真 Chromium + 假 API，两个视口：1200×760 / 420×820）。
//
// 用户原话：**「在问题页面，似乎没有做宽度限制，导致问题如果长了，会把页面顶宽」**。
//
// 修前的真实几何（本门在修前跑出的原始数字，见交付报告）：
//   · 1200×760：`#questions-list`（右栏 896px）`clientWidth 896 / scrollWidth 1838`
//     —— 列表内部横向滚 **942px**；三张 `.question-item` 全被撑到 **1810px**；
//   · 420×820：`#questions-list` `clientWidth 405 / scrollWidth 1838` —— 横向滚 **1433px**，`.question-item` 1810px。
//   页面根（`documentElement.scrollWidth`）本身没溢出 —— 因为 `#questions-list` 是 `overflow:auto`，
//   被撑宽的是**右栏内部**（用户看到那条横向滚动条、卡片伸到栏外）。所以本门**两条都量**：
//   整页宽度 + 出问题的那个元素自身（只量整页会放过它 —— 事先就写清楚了）。
//
// 真凶是**候选按钮**那一行（不是题面/背景 —— 那两块本来就有 `overflow-wrap:anywhere` + `min-width:0`）：
//   `.question-options button { white-space: nowrap; max-width:100%; overflow:hidden; text-overflow:ellipsis }`
//   —— `nowrap` 让按钮的 **min-content = 整条 token**；而 `.question-options`（grid 项，`min-width:auto`）
//   把这条 min-content 逐级传上去 ⇒ `#questions-list` 的隐式 `auto` 轨道被撑到 token 宽度。
//   修法：给 `.question-options` 加 `min-width: 0`（断在 min-content 源头那一层）。
//   ⚠️ 把 `min-width:0` 加在 `.question-item` 上**不够**（实测轨道仍 1838，本门第 4 条会当场说清）。
//
// 本门的红半是**确定性**的：
//   · 断言 3 直接量 `getComputedStyle('.question-options').minWidth === '0px'` —— 撤掉修法这里必红；
//   · 断言 1/2 量两个视口下整页 + `#questions-pane` + `#questions-list` + 每张 `.question-item` 的横向溢出 —— 撤掉修法这里必红；
//   · 断言 5（非空探针）在**同一个页面里**把 `.question-options` 的 `min-width` 改回 `auto`，要求这次
//     `#questions-list` **真的**横向溢出（>100px），再撤掉探针要求恢复干净 —— 证明「本门的尺子真的量得到这条缺陷」，
//     不是靠「什么都没量到」通过的。
//
// ★本门原先**结构上少的那一层：文字右边界**（补这一层的理由与现场在下）——
//   上面五层**全都在量盒子**：整页 `scrollWidth`、右栏/列表 `scrollWidth`、每张 `.question-item` 的
//   `scrollWidth`、子树里每个元素的 `getBoundingClientRect()`。可是「**盒子**老老实实待在栏内、**文字**
//   却跑出栏外」是**另一类**现场：一个 `overflow:hidden` 的**半修**（把「顶宽」那条路封住、却没让文字
//   折行）就能让上面五条**全部为绿** —— 而长 token 仍然跑在栏外（用户看到的还是那件事）。
//   所以这里补上一层与 `test/settings-token-width.mjs` 的 ③ **同口径**的断言：用
//   `Range.getBoundingClientRect()` 取**文字**的右边界，要求它不越出容器（`#questions-list`）右边界、
//   也不越出视口右边界。**只量 `overflow-x: visible` 的元素**：`overflow:hidden`/`clip` 的元素是**故意**
//   裁剪（`.question-options button` 就是 `nowrap + ellipsis + overflow:hidden`，它文字右边界本来就出界
//   910px —— 那是设计），不能算「文字出界」。
//   这一层**有牙的证据**是**臂 R**（门内自跑）：在 `web/` 副本里造一个「**盒子逐字段不变、只有文字出界**」
//   的现场（钉死轨道 ＋ 一处 `overflow:hidden` 半修 ＋ 把 `.question-text` 的 `overflow-wrap:anywhere`
//   撤成 `normal`）⇒ ★新层必红，而**旧层六条全绿**（臂 R 把每条旧判据逐条判出来并留档 —— 「哪些红、
//   哪些绿」是留档的原始读数，不是形容词）。
//   红半同样是确定性的：**撤掉 ★新层 这一条判据**，那份读数上其余每一条判据都成立 ⇒ 门会通过、
//   这个现场**抓不到**（臂 R 里有一条 check 专门钉这句话；另有一次「真的把这一条从门里去掉再跑一遍」
//   的收据在交付报告里）。
//
// 用法：CHROME_BIN=/usr/bin/chromium npm run test:questionswidth
// 沙箱：随机高位端口 + 私有 TMPDIR/home/XDG（`test/ui-harness.mjs` 的 `boot`），不碰真实数据面，不 pkill；
//   臂 R 另用一份自己 mkdtemp 的 `web/` 副本（`test/settings-token-width.mjs` 同一套纪律：自己建、
//   自己删、删完复核）。

import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeSandbox } from './harness.mjs';
import { boot, sendJson, readBody, waitFor, WEB_ROOT } from './ui-harness.mjs';

const ids = { a: '11111111-1111-4111-8111-111111111111' };
const T = Date.now() - 3_600_000;
const artifacts = path.join(os.tmpdir(), 'sopho-questions-token-width');

// 臂 R 的副本沙箱（自己 mkdtemp、自己删、删完复核 —— 与 `test/settings-token-width.mjs` 同纪律）。
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-questions-token-'));
// 修法在场时每个视口的**盒子读数**：臂 R 拿它核对「现场真的是盒子不变」（逐字段相同才算数）。
const fixedBoxes = new Map();

// 三条题：题面 / 背景 / 候选 —— **各造一次、分开量**（用户报告没说清是哪一个，别只试一种）。
// token 一律**无断点**（长路径 / 长 hex / 长 sha），足以把 min-content 顶到 ~1800px。
const LONG_PATH = `C:/Users/user/AppData/Local/Temp/sopho-runtime-cache/${'a'.repeat(180)}/session.jsonl`;
const LONG_HEX = `0x${'deadbeef'.repeat(60)}`;
const LONG_SHA = `sha256:${'f'.repeat(220)}`;

const questions = [
  { id: 'q-token-text', status: 'open', text: `这条题面里有一段长 token：${LONG_PATH} —— 请你判断`, askedAt: T, askedBy: 'agent', priority: 'high', context: null, options: null },
  { id: 'q-token-context', status: 'open', text: '长 token 在背景里的那条', askedAt: T, askedBy: 'agent', priority: 'normal', context: `关键数字（无断点）：${LONG_HEX}`, options: null },
  { id: 'q-token-option', status: 'open', text: '长 token 在候选里的那条', askedAt: T, askedBy: 'agent', priority: 'normal', context: null, options: [LONG_SHA, '短候选'] },
];

const VIEWPORTS = [
  { label: '宽屏 1200×760', width: 1200, height: 760 },
  { label: '窄屏 420×820', width: 420, height: 820 },
];

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

// 假 API：只实现问题页要用的 GET（读清单）与会话基本壳。条目形状照 `server/base-logic.mjs` 的 `questionWire`
// 投影（askedAt/askedBy 分开给、「问的账」与「这次状态变更的账」不混）。
const treeRow = () => ({ id: ids.a, name: '问题宽度 A', parentId: null, archived: false, cwd: '/work/a', modifiedAt: new Date(T).toISOString(), titleSource: 'auto', status: 'idle', statusLabel: '闲置', unread: false, settledAt: T, seenAt: T, notify: { notifies: [], waitingFor: [] } });
const treePayload = () => ({ sessions: [treeRow()], unread: { count: 0 } });
const messagesPayload = () => ({ messages: [{ entryId: 'e1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { entryId: 'e2', role: 'assistant', parts: [{ type: 'text', text: 'hello' }], stopReason: 'stop' }], extras: [], compaction: { atIndex: null, note: '' }, observability: null });

// 一处量法：整页 + 右栏 + 列表 + 每张卡片，并把「可视化溢出」的真实判据算出来 ——
// `overflow: visible` 的元素用 `getBoundingClientRect()` 的右/左边界（`scrollWidth` 对 `overflow:visible`
// 的 grid 项不可靠：修前 `.question-item` 的 `scrollWidth == clientWidth`，真正的溢出躲在子树里）；
// `#questions-list`（`overflow:auto`）另判 `scrollWidth > clientWidth`（那就是横向滚动条）。
// ⚠️ `page` 必须显式传：臂 R 用的是**副本那一页**（它有自己的浏览器）。默认 `ui` 只给修法在场那一臂用；
// 忘了传就会量到**另一页**（本臂第一版就是这么错的：副本上的读数与修法在场时逐字段相同 —— 因为量的是
// 同一页）。
const measure = (label, page = ui) => page.evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const box = (s) => { const n = q(s); if (!n) return null; return { clientWidth: n.clientWidth, scrollWidth: n.scrollWidth, over: n.scrollWidth - n.clientWidth }; };
  const list = q('#questions-list');
  const listRect = list.getBoundingClientRect();
  const outside = [];
  for (const n of list.querySelectorAll('*')) {
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const rightOver = r.right - listRect.right;
    const leftOver = listRect.left - r.left;
    if (rightOver > 1 || leftOver > 1) {
      const st = getComputedStyle(n);
      outside.push({ tag: n.tagName.toLowerCase(), cls: typeof n.className === 'string' ? n.className : '', rightOver: Math.round(rightOver), leftOver: Math.round(leftOver), whiteSpace: st.whiteSpace, overflow: st.overflow, minWidth: st.minWidth });
    }
  }
  return {
    label: ${JSON.stringify(label)},
    viewport: { innerWidth: innerWidth, innerHeight: innerHeight },
    htmlScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    pageOver: document.documentElement.scrollWidth - innerWidth,
    pane: box('#questions-pane'),
    list: box('#questions-list'),
    listRect: { left: Math.round(listRect.left), right: Math.round(listRect.right) },
    // 每个盒子的 clientWidth —— 臂 R 拿它核对「现场真的是**盒子不变**」（逐字段相同才算数）。
    boxes: (() => {
      const widths = (sel) => Array.from(list.querySelectorAll(sel)).map((n) => n.clientWidth);
      return { list: list.clientWidth, item: widths('.question-item'), text: widths('.question-text'), contextBody: widths('.question-context-body'), meta: widths('.question-meta'), options: widths('.question-options') };
    })(),
    // ★新层：**文字右边界**（Range.getBoundingClientRect()）—— 与 test/settings-token-width.mjs 的 ③ 同口径。
    // 量的是**文字**，不是盒子：盒子老实地待在栏内、文字却跑出栏外的那一类现场，上面所有盒子层都看不见它。
    textOut: (() => {
      const out = [];
      for (const n of list.querySelectorAll('*')) {
        const st = getComputedStyle(n);
        // 自己裁剪（overflow:hidden / clip / scroll）的元素是**故意**让文字出界（.question-options button
        // 就是 nowrap + ellipsis + overflow:hidden，它文字右边界本来就出界 910px）⇒ 那不是「文字出界」，跳过。
        if (st.overflowX !== 'visible') continue;
        // 只量**直接文字**：子树里那些元素的文字由它们自己那一条算（免得同一次越界被记很多遍）。
        if (!Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent.trim() !== '')) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const rightOver = r.right - listRect.right;
        const viewportOver = r.right - innerWidth;
        if (rightOver > 1 || viewportOver > 1) {
          out.push({ tag: n.tagName.toLowerCase(), cls: typeof n.className === 'string' ? n.className : '', id: n.id || null, rightOver: Math.round(rightOver), viewportOver: Math.round(viewportOver), textRight: Math.round(r.right), clientWidth: n.clientWidth, scrollWidth: n.scrollWidth, overflowWrap: st.overflowWrap, text: (n.textContent || '').slice(0, 40) });
        }
      }
      return out;
    })(),
    items: Array.from(document.querySelectorAll('.question-item')).map((n) => {
      const r = n.getBoundingClientRect();
      return { id: n.dataset.questionId, clientWidth: n.clientWidth, scrollWidth: n.scrollWidth, over: n.scrollWidth - n.clientWidth, leftOver: Math.round(listRect.left - r.left), rightOver: Math.round(r.right - listRect.right) };
    }),
    optionMinWidth: q('.question-options') ? getComputedStyle(q('.question-options')).minWidth : null,
    optionBtn: q('.question-options button') ? (() => { const b = q('.question-options button'); const r = b.getBoundingClientRect(); return { clientWidth: b.clientWidth, scrollWidth: b.scrollWidth, rightOver: Math.round(r.right - listRect.right), whiteSpace: getComputedStyle(b).whiteSpace, textOverflow: getComputedStyle(b).textOverflow, overflow: getComputedStyle(b).overflow }; })() : null,
    outside,
  };
})()`);

// 假 API（两个臂共用同一份：修法在场那一臂 ＋ 臂 R 的副本各 boot 一次）。
const routes = async (request, response, url) => {
  const { pathname } = url;
  if (pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
  if (pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
  if (pathname === '/api/tree') return sendJson(response, 200, treePayload()), true;
  if (pathname === '/api/tree/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
    response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload())}\n\n`);
    return true;
  }
  const questionsMatch = /^\/api\/sessions\/([^/]+)\/questions$/.exec(pathname);
  if (questionsMatch) {
    const status = url.searchParams.get('status') || 'open';
    const list = status === 'open' ? questions : [];
    return sendJson(response, 200, { questions: list, counts: { open: status === 'open' ? questions.length : 0, answered: 0, closed: 0, total: questions.length }, filteredCount: list.length }), true;
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|seen|draft|commands))?$/.exec(pathname);
  if (sessionMatch) {
    const action = sessionMatch[2] ?? null;
    if (action === 'messages') return sendJson(response, 200, messagesPayload()), true;
    if (action === 'seen' && request.method === 'POST') { await readBody(request); return sendJson(response, 200, { ok: true }), true; }
    if (action === 'draft') { await readBody(request); return sendJson(response, 200, { text: '' }), true; }
    if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
    if (action === 'events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ type: 'session.snapshot', isStreaming: false, isCompacting: false, isRetrying: false, queue: { steering: [], followUp: [] } })}\n\n`);
      return true;
    }
    return sendJson(response, 200, { name: '问题宽度 A', cwd: '/work/a', archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
  }
  return false;
};

// ═══════════ 臂 R：★新层（文字右边界）的「有牙」证据 —— 副本里造「盒子不变、只有文字出界」的现场 ═══════════
//
// 本门原有的五层全都在量**盒子**：整页 `scrollWidth`、右栏/列表 `scrollWidth`、每张 `.question-item` 的
// `scrollWidth`、子树里每个元素的 `getBoundingClientRect()`。一个元素完全可以「盒子老实地待在栏内、
// **文字**却跑出栏外」—— 那种现场上面五条**全部为绿**，而用户看到的仍是「长 token 顶出栏外」。
// 这一层就是本门原先**结构上少的那一层**，本臂是它的证据（旧层「哪些红、哪些绿」逐条留档）。
//
// 副本里只动三处（**不动 JS**、也不动 `min-width:0` 那一条修法）：
//   ① `#questions-list` 追 `grid-template-columns: minmax(0, 1fr);` —— 把隐式 `auto` 轨道钉死。
//      为什么必须有它：撤掉折行后，隐式 `auto` 轨道**自己也会被 token 的 min-content 撑开**
//      （实测：`.question-item` 853 → 1609、列表横向滚 741px）—— 那是**旧层本来就抓得到**的一类，
//      量不出「少了一层」。把轨道钉死 ⇒ 副本上每个盒子与修法在场时**逐字段相同**（本臂当场核对），
//      现场里就只剩「文字」这一件事。
//   ② `.question-head` 追 `overflow: hidden;` —— 一个**半修**形状：把「顶宽」那条路封住（文字溢出不再
//      长成祖先的 `scrollWidth`），却没让文字折行。这正是「旧层全绿、文字却在栏外」的那种半修。
//   ③ `.question-text` 的 `overflow-wrap: anywhere` → `normal` —— 撤掉本门的症状本体（文字折行）。
const MUTANT_RULES = [
  ['#questions-list', (rule) => `${rule}grid-template-columns: minmax(0, 1fr); `],
  ['.question-head', (rule) => `${rule}overflow: hidden; `],
  ['.question-text', (rule) => {
    if (!rule.includes('overflow-wrap: anywhere')) throw new Error('臂 R：`.question-text` 规则里没有 `overflow-wrap: anywhere`');
    return rule.replace('overflow-wrap: anywhere', 'overflow-wrap: normal');
  }],
];

/** 副本 `web/index.html` 里只改这三处（命中不了就**抛** —— 不许静默跳过）。 */
async function makeTextSpillMutant(dir) {
  const target = path.join(dir, 'index.html');
  let source = await readFile(target, 'utf8');
  const touched = [];
  for (const [selector, rewrite] of MUTANT_RULES) {
    const at = source.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`臂 R：副本里没找到 ${selector} 规则（${target}）`);
    const end = source.indexOf('}', at);
    if (end < 0) throw new Error(`臂 R：${selector} 规则没有收口（${target}）`);
    const rule = source.slice(at, end);
    const next = rewrite(rule);
    if (next === rule) throw new Error(`臂 R：${selector} 的改写没有生效（${target}）`);
    source = source.slice(0, at) + next + source.slice(end);
    touched.push(selector);
  }
  await writeFile(target, source);
  return `副本 index.html 改了 ${touched.join(' / ')}（① 钉死隐式轨道 ② \`.question-head\` 加 overflow:hidden ③ \`.question-text\` 的 overflow-wrap → normal）`;
}

async function runTextSpillArm() {
  const mutantRoot = path.join(sandbox, 'web-text-spill');
  await cp(WEB_ROOT, mutantRoot, { recursive: true });
  const what = await makeTextSpillMutant(mutantRoot);
  print('臂 R（★新层的有牙证据）· 副本', { root: mutantRoot, what });
  const page = await boot({ routes, width: 1200, height: 760, webRoot: mutantRoot });
  try {
    await waitFor(() => page.evaluate(`document.querySelector('[data-session-id="${ids.a}"]') !== null`), '臂 R：树没渲染出来');
    await page.evaluate(`document.querySelector('[data-session-id="${ids.a}"] .tree-select').click()`);
    await waitFor(() => page.evaluate(`document.querySelector('#prompt').disabled === false`), '臂 R：会话没打开');
    await page.evaluate(`document.querySelector('#view-tab-questions').click()`);
    await waitFor(() => page.evaluate(`document.querySelectorAll('.question-item').length === ${questions.length}`), '臂 R：题没渲染出来');
    for (const vp of VIEWPORTS) {
      await page.resize(vp.width, vp.height);
      await page.frames(4);
      const m = await measure(`臂 R 现场 ${vp.label}`, page);
      print(`readings 臂 R（盒子不变、只有文字出界）${vp.label}`, JSON.stringify(m));
      await page.screenshot(path.join(artifacts, `text-spill-${vp.width}x${vp.height}.png`));

      // (a) 现场真的是「盒子不变」：每个盒子的 clientWidth 与修法在场时逐字段相同。
      const fixed = fixedBoxes.get(vp.label);
      check(`臂 R（${vp.label}）现场真的是「盒子不变」：副本上每个盒子的 clientWidth 与修法在场时**逐字段相同**`,
        JSON.stringify(m.boxes) === JSON.stringify(fixed),
        { 副本: m.boxes, 修法在场: fixed });

      // (b) 旧层逐条留档（这也是**红半**：这些旧判据全绿 ⇒ 撤掉 ★新层 这条判据，门在这个现场上一条红都没有）。
      const oldLayers = [
        { id: '旧①整页不被顶宽', ok: m.htmlScrollWidth <= m.viewport.innerWidth, detail: { htmlScrollWidth: m.htmlScrollWidth, innerWidth: m.viewport.innerWidth } },
        { id: '旧②右栏 #questions-pane 不横向溢出', ok: m.pane.scrollWidth <= m.pane.clientWidth + 1, detail: m.pane },
        { id: '旧③#questions-list 不横向溢出', ok: m.list.scrollWidth <= m.list.clientWidth + 1, detail: m.list },
        { id: '旧④每张 .question-item 不横向溢出', ok: m.items.length === 3 && m.items.every((it) => it.scrollWidth <= it.clientWidth + 1 && it.rightOver <= 1 && it.leftOver <= 1), detail: m.items },
        { id: '旧⑤子树里没有元素的盒子越出列表两边', ok: m.outside.length === 0, detail: m.outside },
        { id: '旧⑥computed `.question-options` 的 min-width 仍是 0px', ok: m.optionMinWidth === '0px', detail: { optionMinWidth: m.optionMinWidth } },
      ];
      check(`臂 R（${vp.label}）★红半（确定性）：撤掉 ★新层 这条判据后，本现场上**其余每一条判据都成立** ⇒ 门会通过、这个现场**抓不到**`,
        oldLayers.every((item) => item.ok),
        oldLayers.map((item) => ({ 判据: item.id, 判定: item.ok ? '绿' : '红', 读数: item.detail })));

      // (c) ★新层红：撤掉折行的那一行（`.question-text`）的**文字**右边界跑出栏外。
      const textRow = m.textOut.find((item) => item.cls === 'question-text');
      check(`臂 R（${vp.label}）★新层红：\`.question-text\`（撤掉 \`overflow-wrap:anywhere\` 的那一行）的**文字右边界**越出 #questions-list 右边界 > 100px（而盒子一个也没越界 —— 这正是旧层看不见它的原因）`,
        Boolean(textRow) && textRow.rightOver > 100,
        { 新层读数: textRow ?? null, 修法在场时: 'textOut 为空（本臂的对照臂里逐视口都这么判）', 旧层越界元素数: m.outside.length });
    }
  } finally {
    await page.close([]).catch(() => {});
  }
  return mutantRoot;
}

let ui;
try {
  await mkdir(artifacts, { recursive: true });
  ui = await boot({
    width: 1200, height: 760,
    routes,
  });

  // ── 0. 打开会话 → 切到问题页 → 三条题都渲染出来 ──────────────────────────────────
  await waitFor(() => ui.evaluate(`document.querySelector('[data-session-id="${ids.a}"]') !== null`), '树没渲染出来');
  await ui.evaluate(`document.querySelector('[data-session-id="${ids.a}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelector('#prompt').disabled === false`), '会话没打开');
  await ui.evaluate(`document.querySelector('#view-tab-questions').click()`);
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.question-item').length === ${questions.length}`), '三条问题没渲染出来');
  const rendered = await ui.evaluate(`(() => ({
    count: document.querySelectorAll('.question-item').length,
    hasPath: document.querySelector('[data-question-id="q-token-text"]').textContent.includes(${JSON.stringify(LONG_PATH.slice(0, 60))}),
    hasHex: document.querySelector('[data-question-id="q-token-context"]').textContent.includes(${JSON.stringify(LONG_HEX.slice(0, 40))}),
    hasSha: document.querySelector('[data-question-id="q-token-option"]').textContent.includes(${JSON.stringify(LONG_SHA.slice(0, 40))}),
  }))()`);
  check('（前置）三条长 token 的题都渲染出来了，且 token 真的进了 DOM（不是空的尺子）',
    rendered.count === 3 && rendered.hasPath && rendered.hasHex && rendered.hasSha,
    JSON.stringify(rendered));

  // ── 1. 两个视口：整页 + 右栏 + 列表 + 每张卡片都不许横向溢出 ─────────────────────
  for (const vp of VIEWPORTS) {
    await ui.resize(vp.width, vp.height);
    await ui.frames(4);
    const m = await measure(vp.label);
    fixedBoxes.set(vp.label, m.boxes);   // 臂 R 用它核对「现场真的是盒子不变」（修法在场那一份读数）
    print(`readings ${vp.label}`, JSON.stringify(m));
    await ui.screenshot(path.join(artifacts, `questions-token-${vp.width}x${vp.height}.png`));
    check(`（${vp.label}）整页不被顶宽：documentElement.scrollWidth ≤ innerWidth`,
      m.htmlScrollWidth <= m.viewport.innerWidth,
      JSON.stringify({ htmlScrollWidth: m.htmlScrollWidth, innerWidth: m.viewport.innerWidth, pageOver: m.pageOver }));
    check(`（${vp.label}）右栏（#questions-pane）自身不横向溢出`,
      m.pane.scrollWidth <= m.pane.clientWidth + 1,
      JSON.stringify(m.pane));
    check(`（${vp.label}）出问题的那个元素（#questions-list）自身不横向溢出（无横向滚动条）`,
      m.list.scrollWidth <= m.list.clientWidth + 1,
      JSON.stringify(m.list));
    check(`（${vp.label}）每张 .question-item 自身不横向溢出（三张都在栏内）`,
      m.items.length === 3 && m.items.every((item) => item.scrollWidth <= item.clientWidth + 1 && item.rightOver <= 1 && item.leftOver <= 1),
      JSON.stringify(m.items));
    check(`（${vp.label}）列表子树里没有任何元素的可视边界越出列表两边（长 token 不许顶出去）`,
      m.outside.length === 0,
      JSON.stringify(m.outside));
    // ★本门原先少的那一层：**文字右边界**（`Range.getBoundingClientRect()`）—— 与 `test/settings-token-width.mjs`
    // 的 ③ 同口径。盒子层全绿时它仍能说话：半修（容器 `overflow:hidden` 封住顶宽）下，盒子一个也不越界，
    // 而文字已经跑在栏外（见臂 R）。它只在**不自己裁剪文字**的元素上量（`overflow:hidden` 的候选按钮
    // `nowrap + ellipsis` 是**设计**，它文字右边界本来就出界 910px，不算「文字出界」）。
    check(`（${vp.label}）★新层（文字右边界）：列表里所有「不自己裁剪文字」的元素，其**文字**右边界都在栏内（不越出 #questions-list 右边界，也不越出视口）`,
      m.textOut.length === 0,
      JSON.stringify(m.textOut));
  }

  // ── 2. 修法在场的**直接**证据：候选容器 `min-width` 就是 0 ──────────────────────
  // 撤掉修法 ⇒ 这里读回 `auto`/`normal` ⇒ 必红（不依赖几何抖动）。
  const afterResize = await measure('min-width 断言点');
  check('修法在场：`.question-options` 的 computed min-width = 0px（撤掉就必红）',
    afterResize.optionMinWidth === '0px',
    JSON.stringify({ optionMinWidth: afterResize.optionMinWidth }));

  // ── 3. 非空探针：把修法在同一页面里改回 `auto` ⇒ 列表必须真的横向溢出 ──────────────
  // 这一条防「本门其实量不到这条缺陷」。探针注入的是同选择器的后到规则（`min-width:auto` = 加修法前的初值）。
  await ui.resize(1200, 760);
  await ui.frames(3);
  await ui.evaluate(`(() => { const s = document.createElement('style'); s.id = 'token-width-probe'; s.textContent = '.question-options { min-width: auto; }'; document.head.append(s); })()`);
  await ui.frames(4);
  const probed = await measure('探针：min-width:auto');
  print('readings 探针（min-width:auto）', JSON.stringify(probed));
  check('非空探针：把 `.question-options` 改回 `min-width:auto` ⇒ #questions-list 真的横向溢出（>100px）',
    probed.list.over > 100 && probed.items.every((item) => item.clientWidth > probed.list.clientWidth + 100),
    JSON.stringify({ list: probed.list, items: probed.items }));
  await ui.evaluate(`document.getElementById('token-width-probe').remove()`);
  await ui.frames(4);
  const restored = await measure('探针撤掉后');
  check('撤掉探针 ⇒ 立刻恢复干净（同一页面，同一把尺子）',
    restored.list.over === 0 && restored.items.every((item) => item.over === 0),
    JSON.stringify({ list: restored.list, items: restored.items }));

  // ── 4. 臂 R：★新层（文字右边界）的「有牙」证据（副本里造「盒子不变、只有文字出界」的现场）──────
  const mutantRoot = await runTextSpillArm();
  print('臂 R 沙箱（跑完由收尾统一删）', mutantRoot);

  print('screenshots', artifacts);
  print('RESULT', `questions token width PASS (${checks} checks)`);
} catch (error) {
  process.exitCode = 1;
  process.stdout.write(`\n✗ FAIL: ${error?.stack || error}\n`);
} finally {
  try { await ui?.close(); } catch (error) { process.stdout.write(`cleanup: ${error}\n`); }
  const cleanupProblems = [];
  try { await removeSandbox(sandbox, cleanupProblems, 'remove questions-token-width sandbox'); } catch (error) { cleanupProblems.push(String(error?.message ?? error)); }
  if (cleanupProblems.length > 0) { process.exitCode = 1; process.stdout.write(`cleanup problems: ${cleanupProblems.join(' / ')}\n`); }
}
