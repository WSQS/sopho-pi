#!/usr/bin/env node
// test/settings-token-width.mjs —— 「长无断点 token 撑宽」这条用户级缺陷在**设置这两面**上的机械门
// （真 Chromium ＋ 假 API ＋ **真仓库模块 `server/ui-settings.mjs` ＋ 真临时侧车文件**；两个视口 1200×760 / 420×820）。
//
// 为什么有这道门（同族先例：`test/questions-token-width.mjs`）：
//   业主报的「问题页长 token 把右栏顶宽」在 `33993b8` 修掉后，那一单顺手做了同族排查并**点名**了设置浮层的状态行；
//   本门把它钉住，并且**两个面一起钉**——
//     · 会话页的**设置浮层**：`web/index.html` 里 `.settings-panel-state`；
//     · 独立设置页 `/settings.html`：`web/settings.css` 里 `.settings-state`（自己一套 CSS，同一类缺陷）。
//
// 真凶（本门在修前量到的原始读数，见交付报告）：
//   `.settings-panel-state` / `.settings-state` 都**只**有 `margin/min-height/line-height/color`
//   ⇒ 没有 `min-width: 0`（grid 项默认 `min-width: auto` = min-content）、也没有 `overflow-wrap: anywhere`
//   ⇒ 状态行里那段无断点长 token 的 min-content 经两三条隐式 `auto` 轨道逐级传上去，把容器顶宽：
//     · 浮层（1200×760）：`.settings-panel` `clientWidth 541 / scrollWidth 1661`（**横向滚 1120px**）、
//       四个状态行 `clientWidth 496 → 1615`、子树里 **36** 个元素越出面板左右边界（× 关闭键被推到面板右边界外 1078px）；
//     · 独立页（1200×760）：`documentElement.scrollWidth 2017 / innerWidth 1200` —— **整页真横向滚**（817px）。
//   修法（**最小**，只治撑宽）：给这两个状态行各加 `min-width: 0; overflow-wrap: anywhere;`
//   ⇒ 断在 min-content 的源头那一层。两条**都要**，本门第 3/4 条会当场说清为什么：
//     · 只加 `min-width: 0`：面板不再横向滚，但文字**溢出自己的盒子**（实测状态行 `scrollWidth 1591 / clientWidth 496`）；
//     · 只加 `overflow-wrap: anywhere`：几何干净，但 computed `min-width` 还是 `auto`（没有断在源头那一层，
//       换一种「非文字」的长内容又会复现）。
//
// 可达形状（**不是纯注入**）：状态行会原样回显**服务端的错误人话**（`web/settings-panel.mjs` 的 `load()` /
//   `paint*`、`web/settings.js` 同款）。真形状：侧车文件坏掉时 `server/ui-settings.mjs` 的 `UiSettingsFileError`
//   回的 500 message 是 `${file} is invalid: …: "${长值}"` —— **文件全路径 ＋ 出错的那个值原样回显**。
//   本门就地摆一个真临时侧车（版本对、值非法且**无断点**）⇒ 真模块真 500 ⇒ 四个状态行都带上那段长 token。
//   （「纯注入」对照也在门里：探针直接把同一段 token 写进状态行 —— 两条的几何同族，量到的是同一件事。）
//
// 三个面（每个视口都量）：**臂 C** = 会话页 composer 的状态行 `#notice`（**未点开会话**那一档；修法只有
//   `overflow-wrap: anywhere` 一条 ⇒ 那一档不量 computed min-width）、**臂 A** = 设置浮层、**臂 B** = 独立设置页。
// 四类断言（每个视口都量，三个面都量）：
//   ① **整页**不横向溢出（`documentElement.scrollWidth ≤ innerWidth`，且 `window.scrollTo(9999,0)` 之后
//      `scrollX` 仍是 0 —— 真滚不动，不是「数字好看但能滚」）；
//   ② 容器（浮层 `.settings-panel` / 独立页 `.settings-page`）**自身**不横向溢出（`scrollWidth ≤ clientWidth + 1`）；
//   ③ **每个状态行自身**不横向溢出，且它的**文字**也没跑出容器右边界（`Range.getBoundingClientRect()`）；
//   ④ 容器子树里**没有任何元素**的可视边界越出容器左右两边（`getBoundingClientRect()` 对 `overflow: visible`
//      的 grid 项不可靠时才要看它；这里两条都量）；
//   ＋ computed `min-width` 必须是 `0px`（浮层/独立页那两处）、`overflow-wrap` 必须是 `anywhere`（三处都量）。
//   ⚠️ `③` 里的「**文字右边界**」是加固后的口径：只数字树越界会**放过半修**（实测只加 `min-width:0` 时子树越界 0，
//      而文字右边界出界 1057、元素自身 scrollWidth 1591/496）⇒ 每一档都同时量「元素自身」与「它的文字」。
//
// 红半是**两重**的：
//   · 臂 P（非空探针，同页面）：把修法按「修前的 computed 值」（`min-width: auto; overflow-wrap: normal`）注入回去
//     ⇒ 同一把尺子必须当场量到溢出（面板横向滚 > 100px、文字出界）；撤掉探针 ⇒ 立刻恢复干净。
//     没有这一条，绿臂可能只是「尺子量不到」。
//   · 臂 R（反证臂，门内自跑）：副本 `web/` 里把**三处**修法都删掉 ⇒ 每个面上**适用的判据**必须两个视口全被违反
//     （浮层那一面**不含**①：`.settings-panel` 自己 `overflow:auto`，它把撑宽的子树夹在自己里面 —— 原始读数见
//     臂 R 里那条 `[留档]`。`#notice` 与独立页那两面的 ①②③④ 全都被违反。）
//
// 用法：CHROME_BIN=/usr/bin/chromium npm run test:settingstokenwidth
//   `--reverse-arm=<name>` 可以只跑某一条反证臂（`P` / `R`），修别的东西时省时间。
// 沙箱：高位随机端口 ＋ 临时浏览器 profile（`test/ui-harness.mjs` 的 `boot`）＋ 自己 mkdtemp 的 web 副本；
//   不碰真数据面、不用 7331/7321、不 pkill。

import { cp, mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { removeSandbox } from './harness.mjs';
import { boot, readBody, sendJson, waitFor } from './ui-harness.mjs';
import { createUiSettingsStore } from '../server/ui-settings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = path.join(ROOT, 'web');
const SESSION_A = '1a1a1a1a-1111-4111-8111-111111111111';

// 状态行里那段长 token：**无断点**，足以把 min-content 顶到 ~1500px（比任何一个容器都宽得多）。
const LONG_VALUE = `deadbeef-${'f'.repeat(220)}`;

const VIEWPORTS = [
  { label: '宽屏 1200×760', width: 1200, height: 760 },
  { label: '窄屏 420×820', width: 420, height: 820 },
];

const artifacts = path.join(os.tmpdir(), 'sopho-settings-token-width');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-settings-token-'));
await mkdir(artifacts, { recursive: true });

let checks = 0;
const problems = [];
// 一次把所有红条目列完（`settings-panel.mjs` 同款）：撤掉修法时一整段红一目了然，
// 不必「修一条跑一次」。**前置**（等不到元素、副本建不起来）仍然是直接抛的硬错。
const failures = [];
const check = (name, ok, detail) => {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (ok) { checks += 1; process.stdout.write(`✓ ${name} —— ${text}\n`); return true; }
  failures.push(name);
  process.stdout.write(`✗ ${name} —— ${text}\n`);
  return false;
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

// ───────────────────────── 假 API（`/api/settings` 走**真模块 ＋ 真文件**）─────────────────────────
//
// 侧车文件里摆一个**版本对、值非法且无断点**的项 ⇒ 真 `UiSettingsFileError` ⇒ 500 的 message
// 就是 `${file} is invalid: …: "${LONG_VALUE}"`（≈ 500 字符，里面那段 token 一个断点都没有）。
const settingsFile = path.join(sandbox, 'ui-settings.json');
const settingsStore = createUiSettingsStore({
  file: settingsFile,
  writeJson: async (target, value) => {
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  },
});
await writeFile(settingsFile, `${JSON.stringify({ version: 1, values: { 'annotations.notifySession': LONG_VALUE } }, null, 2)}\n`, 'utf8');

const rows = [{ id: SESSION_A, name: '设置宽度 A', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-22T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } }];

// 侧车坏掉时服务端**当下**回什么（真模块真 500，体走它的 `toJSON()`）—— 本门要先把它钉下来，
// 否则「状态行里真有长 token」这件事没有证据（可能只是页面没读到设置）。
const brokenReply = await (async () => {
  try { await settingsStore.read(); return null; } catch (error) { return { status: error.statusCode, body: error.toJSON() }; }
})();

const routes = async (request, response, url) => {
  const pathname = url.pathname;
  if (pathname === '/api/host') { sendJson(response, 200, { ok: true }); return true; }
  if (pathname === '/api/devices') { sendJson(response, 200, { exists: true, devices: [] }); return true; }
  if (pathname === '/api/settings') {
    try {
      if (request.method === 'GET') { sendJson(response, 200, await settingsStore.read()); return true; }
      sendJson(response, 200, await settingsStore.patch(JSON.parse(await readBody(request))));
    } catch (error) {
      sendJson(response, error?.statusCode ?? 500, typeof error?.toJSON === 'function' ? error.toJSON() : { message: String(error?.message ?? error) });
    }
    return true;
  }
  if (pathname === '/api/tree') { sendJson(response, 200, { sessions: rows, unread: { count: 0 } }); return true; }
  if (pathname === '/api/tree/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
    response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: rows })}\n\n`);
    return true;
  }
  const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(pathname);
  if (match) {
    const action = match[2] ?? null;
    if (action === null) { sendJson(response, 200, { name: rows[0].name, cwd: sandbox, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }); return true; }
    if (action === 'messages') { sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null }); return true; }
    if (action === 'commands') { sendJson(response, 200, { streaming: false, commands: [] }); return true; }
    if (action === 'seen') { sendJson(response, 200, { ok: true }); return true; }
    if (action === 'draft') { sendJson(response, 200, { text: '' }); return true; }
    if (action === 'events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false, queue: { steering: [], followUp: [] } })}\n\n`);
      return true;
    }
  }
  return false;
};

// ───────────────────────── 一处量法（两个面共用同一把尺子）─────────────────────────
//
// `rootSel` = 容器（浮层是 `.settings-panel`、独立页是 `.settings-page`）；
// `stateSel` = 状态行（`.settings-panel-state` / `.settings-state`）。两个面各量**所有**状态行，不只第一条。
const measureExpr = (rootSel, stateSel) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSel)});
  const rootRect = root.getBoundingClientRect();
  const box = (node) => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, over: node.scrollWidth - node.clientWidth });
  const outside = [];
  for (const node of root.querySelectorAll('*')) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const rightOver = rect.right - rootRect.right;
    const leftOver = rootRect.left - rect.left;
    if (rightOver > 1 || leftOver > 1) {
      const style = getComputedStyle(node);
      outside.push({ tag: node.tagName.toLowerCase(), id: node.id || null, cls: typeof node.className === 'string' ? node.className : '', rightOver: Math.round(rightOver), leftOver: Math.round(leftOver), minWidth: style.minWidth, overflowWrap: style.overflowWrap, text: (node.textContent || '').slice(0, 32) });
    }
  }
  return {
    viewport: { innerWidth: innerWidth, innerHeight: innerHeight },
    html: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
    bodyScrollWidth: document.body.scrollWidth,
    root: { ...box(root), left: Math.round(rootRect.left), right: Math.round(rootRect.right), width: Math.round(rootRect.width) },
    states: [...root.querySelectorAll(${JSON.stringify(stateSel)})].map((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const textRect = range.getBoundingClientRect();
      return {
        id: node.id,
        ...box(node),
        textRight: Math.round(textRect.right),
        textRightOver: Math.round(textRect.right - rootRect.right),
        height: Math.round(node.getBoundingClientRect().height),
        minWidth: getComputedStyle(node).minWidth,
        overflowWrap: getComputedStyle(node).overflowWrap,
        textLength: (node.textContent || '').length,
      };
    }),
    outside,
    // 「真的能滚么」：整页滚到头之后还停在哪（> 0 = 整页真的能横向滚；数字好看 ≠ 滚不动）。
    scrollXAtEnd: (() => { window.scrollTo(9999, 0); const x = window.scrollX; window.scrollTo(0, 0); return Math.round(x); })(),
  };
})()`;

const measure = (page, rootSel, stateSel) => page.evaluate(measureExpr(rootSel, stateSel));

/** 一个面上的判据（①整页 ②容器自身 ③那一行自身 ＋ **它的文字右边界** ④子树越界）＋ computed 那两条。
 *
 *  ⚠️ `minWidth: false` 是给 `#notice` 那一档的：那里的修法**只有** `overflow-wrap: anywhere`（实测 `min-width: 0`
 *  单加与未修逐字节相同 —— 它的瓶颈不是 grid 项的 `min-width:auto`，是文字本身没有断点）⇒ 不该拿 min-width 当它的判据。
 *  ⚠️ `③` 里的「文字右边界」是**加固后的口径**：只数字树越界会**放过半修**（实测只加 `min-width:0` 时子树越界 0，
 *  而文字右边界出界 1057）—— 所以这一条必须同时量元素自身与它的文字。 */
const predicates = (which, label, reading, { minWidth = true } = {}) => ([
  { id: '①整页不横向溢出', ok: reading.html.scrollWidth <= reading.viewport.innerWidth && reading.scrollXAtEnd === 0, detail: { html: reading.html, innerWidth: reading.viewport.innerWidth, scrollXAtEnd: reading.scrollXAtEnd } },
  { id: '②容器自身不横向溢出', ok: reading.root.over <= 1, detail: reading.root },
  { id: '③每个状态行自身不横向溢出、文字也在容器内', ok: reading.states.length > 0 && reading.states.every((state) => state.over <= 1 && state.textRightOver <= 1), detail: reading.states },
  { id: '④子树里没有元素越出容器左右边界', ok: reading.outside.length === 0, detail: reading.outside.slice(0, 6) },
  ...(minWidth ? [{ id: '※computed min-width = 0px', ok: reading.states.every((state) => state.minWidth === '0px'), detail: reading.states.map((state) => ({ id: state.id, minWidth: state.minWidth })) }] : []),
  { id: '※computed overflow-wrap = anywhere', ok: reading.states.every((state) => state.overflowWrap === 'anywhere'), detail: reading.states.map((state) => ({ id: state.id, overflowWrap: state.overflowWrap })) },
].map((item) => ({ ...item, face: which, label })));

const assertFace = (which, label, reading, options = {}) => {
  for (const item of predicates(which, label, reading, options)) check(`${which}（${label}）${item.id}`, item.ok, item.detail);
};

async function waitTree(page) {
  await waitFor(() => page.evaluate(`document.querySelector('[data-session-id="${SESSION_A}"]') !== null`), '树没渲染出来');
}

/** 未点开会话时那条**真通知**：等它真的带上那段长 token（不是空的尺子）。 */
async function waitNoticeLongToken(page) {
  await waitFor(() => page.evaluate(`document.querySelector('#notice').textContent.includes(${JSON.stringify(LONG_VALUE)})`), '`#notice` 里没有那段长 token');
}

/** 点开一条会话（浮层那一面要它；也是 `#notice` 那一档的**第二档**：通知被模式提示行替掉）。 */
async function openSession(page) {
  await page.evaluate(`document.querySelector('[data-session-id="${SESSION_A}"] .tree-select').click()`);
  await waitFor(() => page.evaluate(`document.querySelector('#prompt').disabled === false`), '会话没打开');
  await page.frames(2);
}

// ═══════════════════ 臂 C：composer 的状态行 `#notice`（**未点开会话**那一档）═══════════════════
//
// 可达形状（**真路径**，不是注入）：页面自己那次 `GET /settings` 读失败 ⇒ `web/app.js` 把「读配置失败（…）：500 …」
// 做成**全局通知**，正文就是服务端那句人话（含文件全路径 ＋ 出错的那个值）⇒ 落进 `#notice`（`#composer` 是 grid，
// 它是那条 `grid-column: 1 / -1` 的项）。⚠️ `web/app.js` 一行没动：修法只在 CSS。
const NOTICE_FACE = '臂 C（composer 状态行 #notice）';

async function runNoticeArm(page) {
  await waitNoticeLongToken(page);
  const text = await page.evaluate(`document.querySelector('#notice').textContent`);
  check('（臂 C 前置）未点开会话时 `#notice` 里**真有**那段无断点长 token（可达形状：页面自己那次 GET /settings 读失败 ⇒ 全局通知，不是注入）',
    text.includes(LONG_VALUE),
    { length: text.length, head: text.slice(0, 48), tail: text.slice(-40) });

  // 档①：未点开会话（两个视口）
  for (const viewport of VIEWPORTS) {
    await page.resize(viewport.width, viewport.height);
    await page.frames(4);
    const reading = await measure(page, '#composer', '#notice');
    print(`臂 C 档①（未点开会话）读数 ${viewport.label}`, reading);
    await page.screenshot(path.join(artifacts, `notice-${viewport.width}x${viewport.height}.png`));
    assertFace(`${NOTICE_FACE}·档①未点开会话`, viewport.label, reading, { minWidth: false });
  }

  // 非空探针：同一页面里把那条声明改回**修前值**（`overflow-wrap: normal`）⇒ 当场量到溢出；撤掉即恢复。
  await page.resize(1200, 760);
  await page.frames(3);
  await page.evaluate(`(() => { const style = document.createElement('style'); style.id = 'notice-token-probe'; style.textContent = '#notice { overflow-wrap: normal; }'; document.head.append(style); })()`);
  await page.frames(4);
  const probed = await measure(page, '#composer', '#notice');
  print('臂 C 档① 探针读数（`#notice { overflow-wrap: normal }`）', probed);
  check('臂 C（非空探针）：撤掉 `#notice` 的修法 ⇒ 同一把尺子**当场**量到溢出（整页被顶宽 > 100px、文字右边界出容器）',
    probed.html.scrollWidth - probed.viewport.innerWidth > 100 && probed.states.some((state) => state.textRightOver > 100),
    { html: probed.html, innerWidth: probed.viewport.innerWidth, scrollXAtEnd: probed.scrollXAtEnd, root: probed.root, states: probed.states.map((state) => ({ id: state.id, over: state.over, textRightOver: state.textRightOver })) });
  await page.evaluate(`document.getElementById('notice-token-probe').remove()`);
  await page.frames(4);
  const restored = await measure(page, '#composer', '#notice');
  check('臂 C（撤掉探针）：立刻恢复干净（同一页面、同一把尺子）',
    restored.html.scrollWidth <= restored.viewport.innerWidth && restored.scrollXAtEnd === 0 && restored.root.over <= 1 && restored.states.every((state) => state.over <= 1 && state.textRightOver <= 1) && restored.outside.length === 0,
    { html: restored.html, scrollXAtEnd: restored.scrollXAtEnd, root: restored.root, states: restored.states.map((state) => ({ id: state.id, over: state.over, textRightOver: state.textRightOver })), outside: restored.outside.length });

  // 档②：点开会话 ⇒ 同一条状态行换成**模式提示行**（真路径的第二档）。修法不许把常态那一行弄成两行。
  await openSession(page);
  const second = await measure(page, '#composer', '#notice');
  print('臂 C 档②（点开会话之后）读数 宽屏 1200×760', second);
  check('臂 C 档②（点开会话之后）：同一行换成模式提示行 ⇒ 整页/自身/文字都干净',
    second.html.scrollWidth <= second.viewport.innerWidth && second.scrollXAtEnd === 0 && second.root.over <= 1 && second.states.every((state) => state.over <= 1 && state.textRightOver <= 1),
    { html: second.html, scrollXAtEnd: second.scrollXAtEnd, root: second.root, states: second.states.map((state) => ({ id: state.id, over: state.over, textRightOver: state.textRightOver })) });
  check('臂 C 档②（零外观影响）：普通状态行仍是**一行**（`overflow-wrap` 不把常态文案折行）',
    second.states.every((state) => state.height > 0 && state.height <= 20),
    { states: second.states.map((state) => ({ id: state.id, height: state.height, text: state.id ? null : null })) });
}

/** 打开浮层并等到四个状态行真的带上那段长 token（读不到设置的路径）。 */
async function openPanelWithLongToken(page) {
  await page.evaluate(`document.querySelector('#tree-settings').click()`);
  await waitFor(() => page.evaluate(`document.querySelector('#settings-overlay').hidden === false`), '浮层没打开');
  await waitFor(() => page.evaluate(`document.querySelectorAll('.settings-panel-state').length === 4 && [...document.querySelectorAll('.settings-panel-state')].every((n) => n.textContent.includes(${JSON.stringify(LONG_VALUE)}))`), '四个状态行没带上那段长 token');
}

async function goto(page, pathname) {
  const loaded = page.browser.once('Page.loadEventFired');
  await page.browser.send('Page.navigate', { url: `http://127.0.0.1:${page.port}${pathname}` });
  await loaded;
}

// ═════════════════ 臂 C/A/B：修法在场（真 web/；顺序不能换：`#notice` 那一档必须在点开会话之前）═════════════════
async function runGreenArm() {
  const page = await boot({ routes, width: 1200, height: 760, webRoot: WEB_ROOT });
  try {
    print('臂 C/A/B · 沙箱', { port: page.port, webRoot: WEB_ROOT });
    // 前置（硬错，不是断言）：先把「侧车坏掉 ⇒ 真 500」这件事钉死（否则下面的长 token 可能是别的原因来的）。
    if (brokenReply?.status !== 500 || brokenReply.body?.error !== 'ui_settings_invalid' || !brokenReply.body.message.includes(LONG_VALUE) || !brokenReply.body.message.includes(settingsFile)) {
      throw new Error(`前置不过：真模块 ＋ 真侧车（值非法且无断点）没有回出预期的 500 —— ${JSON.stringify({ status: brokenReply?.status, error: brokenReply?.body?.error, hasToken: brokenReply?.body?.message?.includes(LONG_VALUE) ?? false })}`);
    }
    check('（前置）真模块 ＋ 真侧车（值非法且无断点）⇒ 真 500，message 里带文件全路径 ＋ 那段长 token',
      true,
      { status: brokenReply.status, error: brokenReply.body.error, messageLength: brokenReply.body.message.length, hasToken: true });

    // ── 臂 C：composer 的状态行 `#notice`（**必须在点开会话之前** —— 点开会话会把那条通知换成模式提示行）──
    await waitTree(page);
    await runNoticeArm(page);

    // ── 臂 A：会话页的设置浮层 ────────────────────────────────────────────────
    await openPanelWithLongToken(page);
    const panelText = await page.evaluate(`document.querySelector('#settings-panel-notify-state').textContent`);
    check('（臂 A 前置）浮层状态行里**真有**那段无断点长 token（不是空的尺子）',
      panelText.includes(LONG_VALUE),
      { length: panelText.length, head: panelText.slice(0, 60), tail: panelText.slice(-40) });
    for (const viewport of VIEWPORTS) {
      await page.resize(viewport.width, viewport.height);
      await page.frames(4);
      const reading = await measure(page, '#settings-panel', '.settings-panel-state');
      print(`臂 A 读数 ${viewport.label}`, reading);
      await page.screenshot(path.join(artifacts, `panel-${viewport.width}x${viewport.height}.png`));
      assertFace('臂 A（设置浮层）', viewport.label, reading);
    }

    // ── 臂 B：独立设置页（自己一套 CSS）──────────────────────────────────────
    await goto(page, '/settings.html');
    await waitFor(() => page.evaluate(`document.querySelectorAll('.settings-state').length === 4 && [...document.querySelectorAll('.settings-state')].every((n) => n.textContent.includes(${JSON.stringify(LONG_VALUE)}))`), '独立页四个状态行没带上那段长 token');
    for (const viewport of VIEWPORTS) {
      await page.resize(viewport.width, viewport.height);
      await page.frames(4);
      const reading = await measure(page, '.settings-page', '.settings-state');
      print(`臂 B 读数 ${viewport.label}`, reading);
      await page.screenshot(path.join(artifacts, `standalone-${viewport.width}x${viewport.height}.png`));
      assertFace('臂 B（独立设置页）', viewport.label, reading);
    }
    return page;
  } catch (error) {
    await page.close(problems).catch(() => {});
    throw error;
  }
}

// ═══════════════════════════ 臂 P：非空探针（同一页面里把修法改回去）═══════════════════════════
async function runProbeArm(page) {
  await goto(page, '/settings.html');
  await waitFor(() => page.evaluate(`document.querySelectorAll('.settings-state').length === 4 && [...document.querySelectorAll('.settings-state')].every((n) => n.textContent.includes(${JSON.stringify(LONG_VALUE)}))`), '独立页状态行没有长 token');
  await page.resize(1200, 760);
  await page.frames(3);
  const before = await measure(page, '.settings-page', '.settings-state');
  check('臂 P（修法在场）：独立页干净 —— 容器自身 0 溢出',
    before.root.over === 0 && before.states.every((state) => state.over === 0),
    { root: before.root, states: before.states.map((state) => ({ id: state.id, cw: state.clientWidth, sw: state.scrollWidth })) });

  // 探针注入的就是**修前的 computed 值**（同选择器的后到规则）：`min-width: auto` ＋ `overflow-wrap: normal`。
  await page.evaluate(`(() => { const style = document.createElement('style'); style.id = 'settings-token-probe'; style.textContent = '.settings-state { min-width: auto; overflow-wrap: normal; }'; document.head.append(style); })()`);
  await page.frames(4);
  const probed = await measure(page, '.settings-page', '.settings-state');
  print('臂 P 读数（探针：min-width:auto; overflow-wrap:normal）', probed);
  check('臂 P（非空探针）：撤掉修法 ⇒ 同一把尺子**当场**量到溢出（容器横向滚 > 100px、状态行文字出界）',
    probed.root.over > 100 && probed.states.some((state) => state.textRightOver > 100),
    { root: probed.root, states: probed.states.map((state) => ({ id: state.id, over: state.over, textRightOver: state.textRightOver })), outside: probed.outside.length });

  await page.evaluate(`document.getElementById('settings-token-probe').remove()`);
  await page.frames(4);
  const restored = await measure(page, '.settings-page', '.settings-state');
  check('臂 P（撤掉探针）：立刻恢复干净（同一页面、同一把尺子）',
    restored.root.over === 0 && restored.states.every((state) => state.over === 0 && state.textRightOver <= 1) && restored.outside.length === 0,
    { root: restored.root, states: restored.states.map((state) => ({ id: state.id, over: state.over, textRightOver: state.textRightOver })), outside: restored.outside.length });
}

// ═══════════ 臂 R：反证臂（副本里把三处修法都删掉 ⇒ 每个面**适用的**判据必须全被违反）═══════════════
//
// 三处修法各自要删的那一段（`#notice` 只有一条 —— 见臂 C 的说明：`min-width` 在那一条 grid 项上不是瓶颈）。
const STRIPPED_DECLS = [
  ['index.html', '.settings-panel-state', 'min-width: 0; overflow-wrap: anywhere;'],
  ['index.html', '#notice', 'overflow-wrap: anywhere;'],
  ['settings.css', '.settings-state', 'min-width: 0; overflow-wrap: anywhere;'],
];

async function makeWebMutant(label, patch) {
  const mutantRoot = path.join(sandbox, `mutant-${label}`);
  await cp(WEB_ROOT, mutantRoot, { recursive: true });
  const what = await patch(mutantRoot);
  return { root: mutantRoot, label, what };
}

async function runReverseArm() {
  const violated = [];
  const counts = new Map();   // `面/判据 id` ⇒ 在两个视口里被违反了几次（各都要 2 次）
  const readings = [];
  const record = (face, items) => {
    for (const item of items) {
      if (item.ok) continue;
      const key = `${face}/${item.id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      violated.push(`${face}·${item.label}·${item.id}`);
    }
  };
  let mutant = null;
  let page = null;
  try {
    mutant = await makeWebMutant('token-fix-stripped', async (dir) => {
      const touched = [];
      for (const [file, selector, needle] of STRIPPED_DECLS) {
        const target = path.join(dir, file);
        const source = await readFile(target, 'utf8');
        // 只删**这一条规则里**的那一段声明字面量，别的一字不动。
        const anchor = `${selector} {`;
        const at = source.indexOf(anchor);
        if (at < 0) throw new Error(`反证臂：副本里没找到 ${selector} 规则（${target}）`);
        const end = source.indexOf('}', at);
        const rule = source.slice(at, end);
        if (!rule.includes(needle)) throw new Error(`反证臂：副本里 ${selector} 没有 \`${needle}\`（${target}）`);
        await writeFile(target, source.slice(0, at) + rule.replace(needle, '') + source.slice(end));
        touched.push(`${selector}（${file}）去掉 \`${needle}\``);
      }
      return `副本里 ${touched.join(' ＋ ')}`;
    });
    print('臂 R（反证臂）· 副本', { root: mutant.root, what: mutant.what });
    page = await boot({ routes, width: 1200, height: 760, webRoot: mutant.root });
    // 副本上的**前置**：长 token 仍要真在两处状态行里（否则红的原因不干净）。
    await waitTree(page);
    await waitNoticeLongToken(page);
    const noticeText = await page.evaluate(`document.querySelector('#notice').textContent`);
    if (!noticeText.includes(LONG_VALUE)) violated.push('臂 R 中断：副本上 `#notice` 里没有那段长 token');
    for (const viewport of VIEWPORTS) {
      await page.resize(viewport.width, viewport.height);
      await page.frames(4);
      const noticeReading = await measure(page, '#composer', '#notice');
      record('notice', predicates('臂 R（#notice·档①未点开会话）', viewport.label, noticeReading, { minWidth: false }));
      readings.push({ face: 'notice', viewport: viewport.label, html: noticeReading.html, innerWidth: noticeReading.viewport.innerWidth, scrollXAtEnd: noticeReading.scrollXAtEnd, root: noticeReading.root, states: noticeReading.states.map((state) => ({ id: state.id, cw: state.clientWidth, sw: state.scrollWidth, textRight: state.textRight, textRightOver: state.textRightOver, overflowWrap: state.overflowWrap })), outside: noticeReading.outside.length });
    }
    await openSession(page);
    await openPanelWithLongToken(page);
    const text = await page.evaluate(`document.querySelector('#settings-panel-notify-state').textContent`);
    if (!text.includes(LONG_VALUE)) violated.push('臂 R 中断：副本上状态行里没有那段长 token');
    for (const viewport of VIEWPORTS) {
      await page.resize(viewport.width, viewport.height);
      await page.frames(4);
      const panelReading = await measure(page, '#settings-panel', '.settings-panel-state');
      record('panel', predicates('臂 R（浮层）', viewport.label, panelReading));
      readings.push({ face: 'panel', viewport: viewport.label, html: panelReading.html, innerWidth: panelReading.viewport.innerWidth, scrollXAtEnd: panelReading.scrollXAtEnd, root: panelReading.root, states: panelReading.states.map((state) => ({ id: state.id, cw: state.clientWidth, sw: state.scrollWidth, minWidth: state.minWidth })), outside: panelReading.outside.length });
    }
    await goto(page, '/settings.html');
    await waitFor(() => page.evaluate(`document.querySelectorAll('.settings-state').length === 4 && [...document.querySelectorAll('.settings-state')].every((n) => n.textContent.includes(${JSON.stringify(LONG_VALUE)}))`), '反证臂：独立页状态行没有长 token');
    for (const viewport of VIEWPORTS) {
      await page.resize(viewport.width, viewport.height);
      await page.frames(4);
      const pageReading = await measure(page, '.settings-page', '.settings-state');
      record('standalone', predicates('臂 R（独立页）', viewport.label, pageReading));
      readings.push({ face: 'standalone', viewport: viewport.label, html: pageReading.html, innerWidth: pageReading.viewport.innerWidth, scrollXAtEnd: pageReading.scrollXAtEnd, root: pageReading.root, states: pageReading.states.map((state) => ({ id: state.id, cw: state.clientWidth, sw: state.scrollWidth, minWidth: state.minWidth })), outside: pageReading.outside.length });
    }
    print('臂 R（反证臂）· 副本上的原始读数（两条声明被删掉之后）', readings);
    // 反证臂的判据：**每一条适用的判据**都要在两个视口里**全被违反**（各 2/2）——
    // 少被违反一条，就说明那把尺子在那个面上/那个视口里没在量它。
    //
    // ⚠️ 这里**故意不含**「①整页」在浮层那一面上的那一格：`.settings-panel` 自己就是 `overflow: auto`
    //    ⇒ 它把撑宽的子树**自己夹住**（原始读数：副本上浮层 `scrollWidth 1661 / clientWidth 541`，
    //    而同一刻 `documentElement.scrollWidth` 仍是 1200）⇒ 浮层这一面**结构上**不可能靠①变红。
    //    ① 在浮层那一面仍然**断言**（修法在场时它必须是干净的：面板一旦不再自己夹住，这条就红），
    //    只是它不能当反证臂的「必须被违反」判据。
    const REVERSE_FACE_LABELS = { notice: '#notice（未点开会话）', panel: '浮层', standalone: '独立页' };
    const REVERSE_EXPECTED = {
      // `#notice` 那一档**不含** min-width（它的修法只有 `overflow-wrap`：实测 min-width 单加无效），
      // **也不含 ④子树越界** —— 这一档的缺陷是**文字**出界而不是**元素**出界：副本上两个视口的
      // `outside.length` 都是 **0**，而出界的是文字（`textRight 1778 / 1470`）、整页 1778 / 1470。
      // 这正是「只数字树越界会放过」那条洞的现场读数（④ 仍然是绿臂里的断言，只是不能当反证臂的「必须被违反」判据）。
      notice: ['①整页不横向溢出', '②容器自身不横向溢出', '③每个状态行自身不横向溢出、文字也在容器内', '※computed overflow-wrap = anywhere'],
      panel: ['②容器自身不横向溢出', '③每个状态行自身不横向溢出、文字也在容器内', '④子树里没有元素越出容器左右边界', '※computed min-width = 0px', '※computed overflow-wrap = anywhere'],
      standalone: ['①整页不横向溢出', '②容器自身不横向溢出', '③每个状态行自身不横向溢出、文字也在容器内', '④子树里没有元素越出容器左右边界', '※computed min-width = 0px', '※computed overflow-wrap = anywhere'],
    };
    for (const [face, ids] of Object.entries(REVERSE_EXPECTED)) {
      for (const id of ids) {
        const key = `${face}/${id}`;
        check(`臂 R（反证臂）：删掉修法后「${REVERSE_FACE_LABELS[face]}」上的「${id}」两个视口**全被违反**（否则这条尺子是假的）`,
          (counts.get(key) ?? 0) === 2,
          { 被违反次数: counts.get(key) ?? 0, 两个视口的原始读数: readings.filter((row) => row.face === face).map((row) => ({ viewport: row.viewport, html: row.html, innerWidth: row.innerWidth, root: row.root, states: row.states, outside: row.outside })) });
      }
    }
    // 附：不算判据、只作**已核实的事实**留档 —— 浮层那一面在副本上 ① 仍是干净的（它自己夹住自己）。
    print('[留档] 反证臂副本上浮层那一面的「①整页」读数（结构上不会被违反，故不列入上面的判据）',
      readings.filter((row) => row.face === 'panel').map((row) => ({ viewport: row.viewport, documentScrollWidth: row.html.scrollWidth, innerWidth: row.innerWidth, panelScrollWidth: row.root.scrollWidth, panelClientWidth: row.root.clientWidth })));

  } catch (error) {
    violated.push(`臂 R 中断：${String(error?.stack ?? error)}`);
    check('臂 R（反证臂）跑完', false, violated);
  } finally {
    if (page) await page.close(problems).catch(() => {});
  }
  return { mutant, violated, readings };
}

// ═══════════════════════════ 主流程 ═══════════════════════════
const arm = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) ?? '').split('=')[1] ?? 'all';

try {
  let page = null;
  try {
    page = await runGreenArm();
    if (arm === 'all' || arm === 'P') await runProbeArm(page);
  } finally {
    if (page) await page.close(problems).catch(() => {});
  }
  if (arm === 'all' || arm === 'R') await runReverseArm();
  if (problems.length > 0) throw new Error(`收尾问题：${problems.join(' / ')}`);
  if (failures.length > 0) throw new Error(`门红：${failures.length} 条断言不成立 —— ${failures.join(' / ')}`);
  print('screenshots', artifacts);
  print('RESULT', `settings token width PASS (${checks} checks)`);
  process.exitCode = 0;
} catch (error) {
  process.exitCode = 1;
  process.stdout.write(`\n✗ FAIL: ${error?.stack || error}\n`);
} finally {
  await removeSandbox(sandbox, problems, 'remove settings-token-width sandbox').catch(() => {});
}
