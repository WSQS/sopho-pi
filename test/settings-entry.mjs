#!/usr/bin/env node
// test/settings-entry.mjs —— 「设置入口」的机械门（左栏底栏那一个）。
//
// 判据出处：业主 2026-09-22 的两条逐字要求 —— **「配置改成叫设置」** ＋ **「我希望设置是一个悬浮窗，
// 而不是打开一个新窗口」**；形状与取舍见 `docs/design-settings.md` §2/§7bis/§8/§10。UI Style
//（`docs/v2.1-lessons.md`「Chat Page」）说左栏自上而下是 **顶栏 / 会话树 / 归档会话栏 / 底栏**，
// 且「底栏：置底」—— 入口就落在那个**底栏**里。
//
// ⚠️ 本门 2026-09-22 **改口径**（不是放宽）：先前它钉的是「点它 ⇒ 真导航到 `/settings.html`」；
//    业主改成浮层后，那条要求本身被撤了 —— 于是①改成钉**相反**的事实（**点它不许导航**、浮层就地出现），
//    其余各条（底栏几何、低对比同档、3px 槽、一份真源）**一字未放宽**。
//    深一层的行为（PATCH 逐字节落盘、Esc/遮罩关、Tab 陷阱、窄宽 420px、reduced-motion、读不到就如实报）
//    在 `test/settings-panel.mjs`；本门只钉**入口本身**与它当场能看见的结果。
//
// 两臂，每臂钉一半事实（照 `test/settings-fold.mjs` / `test/annotate.mjs` 的先例）：
//
//   臂 ①（真 Chromium + 假 API，那半边的 `/api/settings` 是**真仓库模块 ＋ 真文件**）：
//     ② 结构：入口在**精确选择器** `aside.tree > .tree-footer > #tree-settings` 上，且它是
//        左栏**最后一个**可见子元素（底栏置底：footer 底边 == 左栏底边）；
//        底栏的成员是**显式列举**的（`#tree-connection` ＋ `#tree-settings`，多一个就判红 ——
//        这就是「把新入口显式列进允许集合，而不是放宽判定」）；
//        既有状态行 `#tree-connection` 的文本**一字未变**（它被 `test/s1a2-v21-style.mjs` 逐字钉着）。
//     ③ 低对比同档：入口文字色 == 邻座控件（`.tree-nav` 里 `#tree-search-toggle` 那条）的文字色，且不是亮色；悬停提亮。
//     ④ 槽原语：入口有 3px 最左槽、槽色在既有调色板里（「所有元素都加槽」）。
//     ① 行为（业主那条的正面）：**真鼠标点一下** ⇒ **没有导航**（新 load 事件没来、`location.href` 一字不变）
//        ＋ 浮层**就地**出现（遮罩/面板都可见、入口 `aria-expanded="true"`、呈激活态）；
//        `Esc` 关 ⇒ 浮层收起、`aria-expanded="false"`、**焦点还给入口**、`location` 仍未变。
//     ⑤ 一份真源：先把服务端写成 `collapsed`（**不是**它的默认 `expanded`）⇒ 开浮层 ⇒ 浮层画的是
//        **服务端给的生效值**（那个 radio 被选中 ＋ 状态行说明来自服务端）。
//     ⑥ 旧入口保留：浮层里留着指向 `/settings.html` 的**指路链接**（深链/兜底不删）。
//
//   臂 ②（静态，读同一份 `web/`）：入口是 `web/index.html` 里的**静态 `<button>`**
//     （`aria-controls="settings-overlay"`、**没有** `href`/`target` ⇒ 它不是一个导航控件），
//     且 `web/app.js` / `render.js` / `mentions.mjs` 里**不 select 这个入口**（入口的 JS 只在
//     `web/settings-panel.mjs` 一处：它不是一个页面级新状态，只是一个浮层的开关）。
//
//   臂 ③（红绿对照，外部跑）：把入口换回「跳新页」或去掉（**提交树里改名那笔**的 `web/` 副本）⇒ 臂 ① **必红**。
//     ⚠️ **别拿 HEAD 取副本**（浮层也在 HEAD 里 ⇒ 会假绿）：
//     `mkdir -p /tmp/se-red && git archive 27be4d2 web | tar -x -C /tmp/se-red`（`27be4d2` = 改名那笔）
//     `SOPHO_SETTINGS_ENTRY_WEB=/tmp/se-red/web node test/settings-entry.mjs`
//
// 沙箱：高位随机端口 + 临时浏览器 profile + 临时 ASSIST_HOME（`test/ui-harness.mjs` 的 boot）；
// 不碰真实 profile、不用 7331/7321、不 pkill（只按本次 spawn 的 pid 停）。
//
// 用法：CHROME_BIN=/usr/bin/chromium node test/settings-entry.mjs

import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { finishCleanup, removeSandbox } from './harness.mjs';
import { boot, readBody, sendJson, waitFor as uiWaitFor } from './ui-harness.mjs';
import { createUiSettingsStore } from '../server/ui-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 红绿对照：把这只 env 指到**副本**（同一把尺子量两个版本）。
const webRoot = process.env.SOPHO_SETTINGS_ENTRY_WEB ? path.resolve(process.env.SOPHO_SETTINGS_ENTRY_WEB) : path.join(root, 'web');

const SETTING = 'thinking.defaultFold';
const SESSION_A = '1a1a1a1a-1111-4111-8111-111111111111';
const SESSION_B = '2b2b2b2b-2222-4222-8222-222222222222';

// 底栏的成员是**显式列举**的：结构与几何都用这一份（别的门没钉它，本门就把它钉住）。
const FOOTER_REQUIRED = ['#tree-connection', '#tree-settings'];

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-settings-entry-'));
const UI_SETTINGS_FILE = path.join(sandbox, 'home', 'ui-settings.json');
await mkdir(path.dirname(UI_SETTINGS_FILE), { recursive: true });

let checks = 0;
const failures = [];
const problems = [];
/** 不中断：一次把所有红条目列全，最后统一判。 */
function check(name, ok, detail) {
  if (ok) {
    checks += 1;
    process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
    return true;
  }
  failures.push(name);
  process.stdout.write(`✗ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  return false;
}
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ───────────────────────── 夹具 ＋ 假 API（`/api/settings` 是真模块 + 真文件） ─────────────────────────
const rows = [
  { id: SESSION_A, name: '入口门 A', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-22T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: SESSION_B, name: '入口门 B', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-22T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];
const uiSettings = createUiSettingsStore({
  file: UI_SETTINGS_FILE,
  writeJson: async (file, value) => {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  },
});
const settingsReads = [];
const settingsWrites = []; // 本门**不该**写设置：它只验入口与「落点画的是服务端值」，改动一律记下来

async function fakeRoutes(request, response, url) {
  const pathname = url.pathname;
  if (pathname === '/api/host') { sendJson(response, 200, { ok: true }); return true; }
  if (pathname === '/api/devices') { sendJson(response, 200, { exists: true, devices: [] }); return true; }
  if (pathname === '/api/settings') {
    if (request.method === 'GET') {
      const view = await uiSettings.read();
      settingsReads.push({ at: new Date().toISOString(), method: 'GET', effective: view.settings[SETTING], exists: view.exists });
      sendJson(response, 200, view);
      return true;
    }
    // 页面上的 radio 一旦被点就会 PATCH —— 本门不点，所以这一支**只记账 + 诚实 405**。
    settingsWrites.push({ at: new Date().toISOString(), method: request.method, body: await readBody(request) });
    sendJson(response, 405, { error: 'method_not_allowed' });
    return true;
  }
  if (pathname === '/api/tree') { sendJson(response, 200, { sessions: rows, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } }); return true; }
  if (pathname === '/api/tree/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
    response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: rows })}\n\n`);
    return true;
  }
  const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(pathname);
  if (match) {
    const row = rows.find((item) => item.id === match[1]);
    if (!row) { sendJson(response, 404, { message: 'not found' }); return true; }
    const action = match[2] ?? null;
    if (action === null) { sendJson(response, 200, { name: row.name, cwd: sandbox, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }); return true; }
    if (action === 'messages') { sendJson(response, 200, { sessionId: match[1], messages: [], extras: [], compaction: { atIndex: null }, observability: null }); return true; }
    if (action === 'commands') { sendJson(response, 200, { streaming: false, commands: [] }); return true; }
    if (action === 'seen') { sendJson(response, 200, { ok: true }); return true; }
    if (action === 'draft') { sendJson(response, 200, { text: '' }); return true; }
    if (action === 'events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false, pendingMessages: 0, queue: { steering: [], followUp: [] } })}\n\n`);
      return true;
    }
  }
  return false;
}

// ───────────────────────── 浏览器小工具 ─────────────────────────
const RAIL_EXPR = `(() => {
  const aside = document.querySelector('aside.tree');
  if (!aside) return { aside: null };
  const rect = (node) => { const r = node.getBoundingClientRect(); return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }; };
  const visible = (node) => getComputedStyle(node).display !== 'none';
  const children = Array.from(aside.children).filter(visible);
  const footer = aside.querySelector(':scope > .tree-footer');
  const entry = aside.querySelector(':scope > .tree-footer > #tree-settings');
  const connection = aside.querySelector('#tree-connection');
  const navLink = document.querySelector('#tree-search-toggle');
  const entryStyle = entry ? getComputedStyle(entry) : null;
  const overlaps = children.flatMap((left, index) => {
    const a = rect(left);
    return children.slice(index + 1).filter((right) => {
      const b = rect(right);
      return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
    }).map((right) => [left.id || left.className, right.id || right.className]);
  });
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    aside: rect(aside),
    asideScroll: { clientHeight: aside.clientHeight, scrollHeight: aside.scrollHeight },
    lastChild: (() => { const node = children.at(-1); return node ? (node.id || node.className) : null; })(),
    children: children.map((node) => ({ name: node.id || node.className, ...rect(node) })),
    overlaps,
    footer: footer ? { ...rect(footer), children: Array.from(footer.children).map((node) => (node.id ? '#' + node.id : '.' + node.className)) } : null,
    entry: entry ? {
      selectorHit: 'aside.tree > .tree-footer > #tree-settings',
      ...rect(entry),
      tag: entry.tagName,
      href: entry.getAttribute('href'),
      target: entry.getAttribute('target'),
      ariaControls: entry.getAttribute('aria-controls'),
      ariaExpanded: entry.getAttribute('aria-expanded'),
      text: entry.textContent,
      whiteSpace: entryStyle.whiteSpace,
      color: entryStyle.color,
      slotWidth: entryStyle.borderInlineStartWidth,
      slotStyle: entryStyle.borderInlineStartStyle,
      slotColor: entryStyle.borderInlineStartColor,
    } : null,
    navLink: navLink ? { text: navLink.textContent, color: getComputedStyle(navLink).color, slotColor: getComputedStyle(navLink).borderInlineStartColor } : null,
    connection: connection ? { text: connection.textContent, ...rect(connection), slotWidth: getComputedStyle(connection).borderInlineStartWidth } : null,
  };
})()`;

// 浮层的事实：入口点完之后当场看得见的那几样（深一层的行为在 `test/settings-panel.mjs`）。
const OVERLAY_EXPR = `(() => {
  const overlay = document.querySelector('#settings-overlay');
  const panel = document.querySelector('#settings-panel');
  const entry = document.querySelector('#tree-settings');
  const radios = panel ? [...panel.querySelectorAll('input[name="settings-panel-thinking-default-fold"]')] : [];
  return {
    href: location.href,
    pathname: location.pathname,
    overlayHidden: overlay ? overlay.hidden : null,
    overlayVisible: !!overlay && overlay.getClientRects().length > 0,
    panelVisible: !!panel && panel.getClientRects().length > 0,
    radioCount: radios.length,
    checked: radios.find((node) => node.checked)?.value ?? null,
    foldState: panel?.querySelector('#settings-panel-fold-state')?.textContent ?? null,
    foldKind: panel?.querySelector('#settings-panel-fold-state')?.dataset.kind ?? null,
    notifyInput: !!panel?.querySelector('#settings-panel-notify-input'),
    deepLink: panel?.querySelector('a[href="/settings.html"]')?.getAttribute('href') ?? null,
    entryExpanded: entry?.getAttribute('aria-expanded') ?? null,
    entryColor: entry ? getComputedStyle(entry).color : null,
    activeElementId: document.activeElement?.id ?? null,
  };
})()`;
/** 等到浮层把**服务端给的生效值**画上去，再读那些事实。 */
const overlayFact = (page) => uiWaitFor(() => page.evaluate(`(() => { const panel = document.querySelector('#settings-panel'); const state = panel?.querySelector('#settings-panel-fold-state'); return state?.dataset.kind === 'ok' ? ${OVERLAY_EXPR} : null; })()`), 'overlay did not paint a server value');

let navigationSeq = 0;
// ⚠️ 导航一律带一个**每次不同的查询串**：只改 hash 是同文档导航，`Page.loadEventFired` 不会来。
const nextUrl = (page, pathname, hash = '') => `http://127.0.0.1:${page.port}${pathname}?g=${++navigationSeq}${hash}`;

async function navigate(page, url) {
  const loaded = page.browser.once('Page.loadEventFired');
  await page.browser.send('Page.navigate', { url });
  // 等 load，但**不无限等**（导航失败要变成一条红断言，而不是把整道门挂死）。
  await Promise.race([loaded, sleep(15_000)]);
  await page.evaluate(`document.readyState`);
}

/** 真鼠标点一个元素（CDP Input 派事件，不是 `el.click()`）：等一次真 load（等不到就说明没导航）。 */
async function mouseClick(page, selector, { waitLoadMs = 3000 } = {}) {
  const point = await uiWaitFor(() => page.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const r = node.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`), `${selector} did not become clickable`);
  const loaded = page.browser.once('Page.loadEventFired');
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 });
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  const fired = await Promise.race([loaded.then(() => true), sleep(waitLoadMs).then(() => false)]);
  await page.evaluate(`document.readyState`);
  return { point, loadEventFired: fired };
}

/** 真键盘 `Esc`（`rawKeyDown` 让浏览器跑默认动作）。 */
async function pressEscape(page) {
  const event = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await page.browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
  await page.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  await sleep(80);
}

/** 把指针移到元素上（只为取 `:hover` 的计算样式，不点击）。 */
async function mouseHover(page, selector) {
  const point = await page.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 });
  await sleep(120);
  return page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color`);
}

/** CDP 里活着的 page target（id + url）：同标签页跳转 ⇒ target 集合不变；`target=_blank` ⇒ 多一个 id。 */
async function pageTargets(page) {
  const list = await (await fetch(`http://127.0.0.1:${page.debugPort}/json/list`)).json();
  return list.filter((target) => target.type === 'page').map((target) => ({ id: target.id, url: target.url }));
}

// ═══════════════════════════ 臂 ②：静态（入口是一个静态 `<button>`，不带导航） ═══════════════════════════
const WEB_SCRIPTS = ['app.js', 'render.js', 'mentions.mjs'];

async function runStaticArm() {
  const html = await readFile(path.join(webRoot, 'index.html'), 'utf8');
  const tag = /<button\b[^>]*\bid="tree-settings"[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? null;
  print('臂 ② · web/index.html 里的入口标签原文', { file: path.join(webRoot, 'index.html'), tag, line: html.split('\n').findIndex((line) => line.includes('id="tree-settings"')) + 1 });
  check('② 入口是 `web/index.html` 里的静态 `<button id="tree-settings" … aria-controls="settings-overlay">设置</button>`（提交树里就有，不是 JS 造的）',
    tag !== null && /aria-controls="settings-overlay"/.test(tag) && /\btype="button"/.test(tag) && />设置<\/button>/.test(tag),
    JSON.stringify({ tag }));
  check('② 它**不是**一个导航控件：标签里没有 `href`、没有 `target`（业主那条「不是打开一个新窗口」在静态侧就有证据）',
    tag !== null && !/\bhref\s*=/.test(tag) && !/\btarget\s*=/.test(tag),
    JSON.stringify({ tag }));
  renderCheckOverlayMarkup(html);

  const references = [];
  for (const name of WEB_SCRIPTS) {
    const text = await readFile(path.join(webRoot, name), 'utf8').catch(() => '');
    for (const [index, line] of text.split('\n').entries()) if (line.includes('tree-settings')) references.push(`${name}:${index + 1}: ${line.trim().slice(0, 120)}`);
  }
  const panelSource = await readFile(path.join(webRoot, 'settings-panel.mjs'), 'utf8').catch(() => '');
  print('臂 ② · web/*.js 里对入口的引用', { scripts: WEB_SCRIPTS, references, panelSelectsEntry: panelSource.includes("querySelector('#tree-settings')") });
  check('② 入口的 JS 只在**一处**（`web/settings-panel.mjs` 排他地 select 它）：app/render/mentions 里零引用 ⇒ 它不是一个页面级新状态',
    references.length === 0 && panelSource.includes("querySelector('#tree-settings')"),
    JSON.stringify({ references, panelSelectsEntry: panelSource.includes("querySelector('#tree-settings')") }));
}

/** 浮层那句静态声明是不是真的（`#settings-overlay`/`#settings-panel` 在提交树里，不是 JS 造出来的）。 */
function renderCheckOverlayMarkup(html) {
  const hasOverlay = /<div id="settings-overlay"/.test(html) && /id="settings-panel"/.test(html) && /id="settings-panel-close"/.test(html);
  check('② 浮层是**静态 DOM**（`#settings-overlay` / `#settings-panel` / 关闭按钮都在 `web/index.html` 里）＋ 面板是 `role="dialog"` ＋ `aria-modal="true"`',
    hasOverlay && /role="dialog"/.test(html) && /aria-modal="true"/.test(html),
    JSON.stringify({ hasOverlay }));
}

// ═══════════════════════════ 臂 ①：浏览器（真 Chromium + 假 API） ═══════════════════════════
async function runBrowserArm() {
  let page = null;
  try {
    page = await boot({ routes: fakeRoutes, width: 1200, height: 760, webRoot });
    print('臂 ① · 沙箱', { port: page.port, debugPort: page.debugPort, webRoot, userDataDir: path.join(page.sandbox, 'chromium'), chromium: page.version?.Browser ?? null, uiSettingsFile: UI_SETTINGS_FILE });

    await navigate(page, nextUrl(page, '/', `#${SESSION_A}`));
    await uiWaitFor(() => page.evaluate(`document.querySelector('#tree-connection')?.textContent?.includes('已连接') ?? false`), 'tree SSE did not connect');
    const rail = await page.evaluate(RAIL_EXPR);
    print('臂 ① · 左栏几何（1200×760 原文）', { aside: rail.aside, lastChild: rail.lastChild, children: rail.children, overlaps: rail.overlaps, footer: rail.footer, entry: rail.entry, navLink: rail.navLink, connection: rail.connection });

    // ② 结构：精确选择器 + 底栏（最后一个可见子元素、贴住左栏底边）+ 底栏成员显式列举
    check('② 入口命中精确选择器 `aside.tree > .tree-footer > #tree-settings`（`<button>`，文字「设置」，`aria-controls` 指着浮层，**没有 href**）',
      rail.entry !== null && rail.entry.tag === 'BUTTON' && rail.entry.href === null && rail.entry.text.trim() === '设置'
      && rail.entry.ariaControls === 'settings-overlay' && rail.entry.ariaExpanded === 'false',
      JSON.stringify(rail.entry));
    check('② 它就在**左栏底栏**里：`.tree-footer` 是 `aside.tree` 的最后一个可见子元素，且贴住左栏底边（底栏置底）',
      rail.lastChild === 'tree-footer' && rail.footer !== null && Math.abs(rail.footer.bottom - rail.aside.bottom) <= 1 && Math.abs(rail.footer.top - rail.entry.top) <= 1,
      JSON.stringify({ lastChild: rail.lastChild, aside: rail.aside, footer: rail.footer, entry: rail.entry }));
    check(`② 底栏的成员**恰好**是显式列举的那些（${FOOTER_REQUIRED.join(' + ')}）—— 多一个成员就判红（新增元素必须显式登记，不是放宽判定）`,
      rail.footer !== null && JSON.stringify(rail.footer.children) === JSON.stringify(FOOTER_REQUIRED),
      JSON.stringify({ actual: rail.footer?.children, required: FOOTER_REQUIRED }));
    check('② 既有状态行 `#tree-connection` 的文本**一字未变**（它被 test/s1a2-v21-style.mjs 逐字钉着）：仍是「● 已连接 · N 个会话」，行里没有混进入口文字',
      rail.connection !== null && /^[●○] (已|未)连接 · \d+ 个会话$/.test(rail.connection.text) && !rail.connection.text.includes('设置'),
      JSON.stringify(rail.connection));
    check('② 加入口没有引起左栏子元素相交（`childOverlaps` 为空）',
      rail.overlaps.length === 0,
      JSON.stringify(rail.overlaps));

    // 红绿对照那一臂（入口被拿掉）：后面的点击 / 浮层那组**无从谈起**，一次列清楚、不假装能点。
    if (rail.entry === null) {
      check('① 左栏底栏里没有入口 ⇒ 点击 / 浮层这一组臂无从谈起（本组整体按红算）', false,
        JSON.stringify({ lastChild: rail.lastChild, children: rail.children, footer: rail.footer }));
    } else {
      // ③ 低对比同档 + 悬停提亮
      const hoverColor = await mouseHover(page, '#tree-settings');
      print('臂 ① · 悬停前后的文字色', { rest: rail.entry.color, hover: hoverColor, navLink: rail.navLink });
      check('③ 低对比、与邻座控件同档：入口文字色 == 左栏导航里那条「搜索」按钮的文字色（且不是亮色 `--bright`）',
        rail.navLink !== null && rail.entry.color === rail.navLink.color && rail.entry.color !== 'rgb(227, 232, 228)',
        JSON.stringify({ entry: rail.entry.color, navLink: rail.navLink?.color }));
      check('③ 悬停提亮（可交互的既成观感：`.tree-settings:hover`）',
        hoverColor !== rail.entry.color,
        JSON.stringify({ rest: rail.entry.color, hover: hoverColor }));

      // ④ 槽原语
      check('④ 入口带 3px 最左槽、槽色在既有调色板里（「所有元素都加槽」）',
        rail.entry.slotWidth === '3px' && rail.entry.slotStyle === 'solid' && rail.entry.slotColor === rail.navLink.slotColor,
        JSON.stringify({ entry: { width: rail.entry.slotWidth, style: rail.entry.slotStyle, color: rail.entry.slotColor }, navLink: rail.navLink.slotColor }));
      check('④ 入口标签是单行（`white-space: nowrap`）—— 底栏只有 28px，文案换行就会溢出那条栏',
        rail.entry.whiteSpace === 'nowrap',
        JSON.stringify({ whiteSpace: rail.entry.whiteSpace, text: rail.entry.text }));

      try {
        // ⑤ 一份真源：先把服务端写成 collapsed（**不是**它的默认 expanded）⇒ 开浮层
        await uiSettings.patch({ [SETTING]: 'collapsed' });
      const patchedAt = new Date().toISOString();
      const serverBefore = await uiSettings.read();
      print('臂 ① · 开之前：服务端的生效值（真模块 + 真文件）', { settings: serverBefore.settings, stored: serverBefore.stored, exists: serverBefore.exists, file: serverBefore.file });

      // ① 真鼠标点一下 ⇒ **不导航** + 就地开浮层（业主那条「不是打开一个新窗口」就是这条）
      const hrefBefore = await page.evaluate(`location.href`);
      const targetsBefore = await pageTargets(page);
      const clicked = await mouseClick(page, '#tree-settings');
      const targetsAfter = await pageTargets(page);
      const opened = await overlayFact(page);
      print('臂 ① · 点入口的原始证据', { patchedAt, hrefBefore, clicked, pageTargetsBefore: targetsBefore, pageTargetsAfter: targetsAfter, settingsReads, settingsWrites, opened });
      check('① 点它 ⇒ **没有导航**：新 load 事件没来、`location.href` 一个字符都没变、CDP 的 page target **id 集合一个不多一个不少**（连新标签页也没开）',
        clicked.loadEventFired === false && opened.href === hrefBefore && opened.pathname === '/'
        && targetsBefore.length === targetsAfter.length
        && JSON.stringify(targetsBefore.map((target) => target.id)) === JSON.stringify(targetsAfter.map((target) => target.id)),
        JSON.stringify({ loadEventFired: clicked.loadEventFired, hrefBefore, hrefAfter: opened.href, pathname: opened.pathname, targetsBefore, targetsAfter }));
      check('① 浮层**就地出现**：遮罩与面板都可见、两个 radio 与维护者会话输入框都在、入口呈激活态（`aria-expanded="true"` ＋ 文字色提亮）',
        opened.overlayVisible === true && opened.panelVisible === true && opened.radioCount === 2 && opened.notifyInput === true
        && opened.entryExpanded === 'true' && opened.entryColor === 'rgb(227, 232, 228)',
        JSON.stringify({ overlayVisible: opened.overlayVisible, panelVisible: opened.panelVisible, radioCount: opened.radioCount, notifyInput: opened.notifyInput, entryExpanded: opened.entryExpanded, entryColor: opened.entryColor }));
      check('① 开时焦点在框内（键盘可达：Tab 自然能进到控件上）',
        opened.activeElementId === 'settings-panel',
        JSON.stringify({ activeElementId: opened.activeElementId }));

      // ⑤ 浮层画的是**服务端给的**生效值（服务端说 collapsed，浮层就得是 collapsed）
      check('⑤ 浮层显示的是**服务端给的生效值**：服务端说 collapsed ⇒ 那个 radio 被选中 ＋ 状态行说明来自服务端（不是它自己推算/默认 expanded）',
        opened.checked === 'collapsed' && opened.foldKind === 'ok' && /已保存在服务端/.test(opened.foldState ?? ''),
        JSON.stringify({ checked: opened.checked, foldKind: opened.foldKind, foldState: opened.foldState }));

      // ① `Esc` 关 ⇒ 焦点还给入口、`location` 仍未变
      await pressEscape(page);
      const closed = await page.evaluate(OVERLAY_EXPR);
      print('臂 ① · `Esc` 关的原始证据', closed);
      check('① `Esc` 关：浮层收起、入口回到 `aria-expanded="false"`、**焦点还给入口**、`location` 仍未变',
        closed.overlayHidden === true && closed.overlayVisible === false && closed.panelVisible === false
        && closed.entryExpanded === 'false' && closed.activeElementId === 'tree-settings' && closed.pathname === '/',
        JSON.stringify({ overlayHidden: closed.overlayHidden, overlayVisible: closed.overlayVisible, panelVisible: closed.panelVisible, entryExpanded: closed.entryExpanded, activeElementId: closed.activeElementId, pathname: closed.pathname }));

      // ⑥ 旧入口保留：浮层里留着指向 `/settings.html` 的指路链接（深链/兜底不删）
      await mouseClick(page, '#tree-settings');
      const reopened = await overlayFact(page);
      print('臂 ① · 重开浮层（看那份直链）', { deepLink: reopened.deepLink, radioCount: reopened.radioCount });
      check('⑥ 旧入口保留：浮层里有指向 `/settings.html` 的**指路链接**（这条直链没被删）',
        reopened.deepLink === '/settings.html',
        JSON.stringify({ deepLink: reopened.deepLink, radioCount: reopened.radioCount }));
      await pressEscape(page);
      } catch (error) {
        // 红绿对照那一臂（副本里入口还是那个 `<a href>`）走到这里：浮层那一组**无从谈起**，
        // 一次列清楚、不假装能点（本组整体按红算）。
        check('① 这一组（不导航 / 就地开浮层 / Esc 关 / 指路链接）无从谈起 —— 入口不是那个开浮层的按钮', false,
          JSON.stringify({ tag: rail.entry?.tag ?? null, href: rail.entry?.href ?? null, ariaControls: rail.entry?.ariaControls ?? null, reason: String(error?.message ?? error) }));
      }
    }

    print('臂 ① · 页面异常（console.error / 未捕获异常）', page.pageProblems);
    check('① 全程没有未捕获异常 / console.error',
      page.pageProblems.length === 0,
      JSON.stringify(page.pageProblems));
  } finally {
    if (page) {
      // 传 problems：收尾自己失败（等不到整棵树退出 / 删完又出现）也进这条判红通道，不静默。
      await page.close(problems).catch(() => {});
      await removeSandbox(page.sandbox, problems, 'remove settings-entry browser sandbox');
    }
  }
}

let primaryError;
try {
  await runStaticArm();
  await runBrowserArm();
} catch (error) {
  primaryError = error;
  process.stdout.write(`\n✗ settings-entry gate threw: ${error?.stack ?? error}\n`);
} finally {
  await removeSandbox(sandbox, problems, 'remove settings-entry sandbox');
  try {
    finishCleanup(primaryError, problems);
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`\n✗ ${error?.message ?? error}\n`);
  }
}

const ok = failures.length === 0 && primaryError === undefined;
print('RESULT', ok ? `settings entry PASS (${checks} checks)` : `settings entry FAIL (${checks} passed, ${failures.length} failed)`);
print('failed', failures);
if (!ok) process.exitCode = 1;
