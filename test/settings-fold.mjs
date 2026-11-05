#!/usr/bin/env node
// test/settings-fold.mjs —— 配置页 v1（服务端权威 ＋ 落盘 ＋ 一页 UI；第一项＝思考折叠的全局默认）的机械门。
//
// 判据出处：`docs/design-settings.md`（业主 2026-09-21 三次裁定的汇总）＋ `/tmp/settings-v1-task.md` §2 的七条门。
// 四臂，每臂钉一半事实（照 `test/annotate.mjs` 的「服务端臂 + 前端臂」先例）：
//
//   臂 S（服务端，**真 A 宿主 + 真逻辑 worker**，高位随机端口沙箱）：
//     ⑦ GET /settings 回**生效值**（默认 ⊕ 已存）＋默认值＋已存值＋出处；文件不存在 ⇒ `exists:false`、`stored:{}`。
//     ④ PATCH 未知 key / 非法值 / 非对象 body / 空 body ⇒ **诚实 400**，且侧车文件**逐字节未变**
//        （前后 sha256 对照；"文件还不存在" 也算一种逐字节未变）；写错方法 ⇒ 405。
//     ① PATCH 合法值 ⇒ 200 回新生效值，文件真落盘（形状 `{version, values}`）。
//     ② 落盘跨进程：**测试进程**里另一个 `createUiSettingsStore` 读同一个文件 ⇒ 读到同一个值。
//
//   臂 U（真 Chromium + 假 API，但那半边的 `/api/settings` 直接调**真仓库模块** `server/ui-settings.mjs`，
//         背后是**真文件**）：
//     ① 两端红绿：设置=收起 ⇒ thinking 块**默认就是收起的**；改回展开 ⇒ 默认展开（两方向各 ≥3 次，
//        每一轮都在 `web/settings.html` 上真点选项 ⇒ 真 PATCH）。
//     ② 落盘：改设置 ⇒ **刷新页面** ⇒ 仍生效。
//     ⑤ 优先级：某会话手动点过 ＋ 全局默认收起 ⇒ **手动赢** 且刷新后仍在；**没点过的隔壁会话**仍听全局默认。
//
//   臂 B（真 Chromium，**全新 user-data-dir / 空白 profile**，另一条 origin = 空 localStorage）：
//     ③ 「跟人走」：换浏览器上下文仍读到同一个服务端值。
//
//   臂 T（TUI 一致性，硬要求 ⑦；纯静态，读 pi 自己的文档与代码）：
//     pi 的 `hideThinkingBlock` **默认 false = 思考默认可见**（`docs/settings.md` 的表格行；
//     `dist/core/settings-manager.js` 的 `getHideThinkingBlock()` 是 `?? false`）
//     ⇒ 我们的默认 `'expanded'`（= 不收起思考）与它一致。**对不齐这条门就红**（那一档要停下报总台，不许自定）。
//
//   臂 ⑧／⑨（2026-09-25 补；真 Chromium，接在臂 U 同一个浏览器上下文上）：派单点名的那两个缺口 ——
//     ⑧ **独立页的「读不到」那一档**（404 与 500 各一档）：这个错误分支此前只有**浮层**有门
//        （`test/settings-panel.mjs` 臂 C/⑧），独立页这条路没有任何断言盖它。判据与浮层同口径：
//        四条状态行**如实显示那条错误**（含服务端码与原文）、控件**全被禁用**、**不假成功**（不画生效值
//        ＋ 一个 `PATCH /settings` 都不发）、以及**恢复路径**（页面有页内重试就走它，没有就走真用户手上
//        那条 = 刷新页面）⇒ 真重读、照服务端生效值重画。
//     ⑨ **封存那张卡的几何**（1200×760 与 420×820）：上次只跑了一次性探针、不是门。这里写成机械判据 ——
//        四张卡的**顺序**、封存那一行在**可滚动内容盒**内可达、`scrollIntoView` 之后四边都在视口内、
//        **没有横向溢出**（文档/正文/`main` 内容盒 ＋ 每张卡左右都在视口内）。
//     红半**门内自跑**（照 `test/settings-panel.mjs` 臂 B/D 的先例，按「断言其红」记账、不进 `failed`）：
//       臂 R1（副本里把 `web/settings.js` 的 `load()` 错误分支换成「用本地默认值假装成功」）⇒ ⑧ 的前四条
//       全被违反；臂 R2（副本里删掉 `web/settings.html` 的封存卡）⇒ ⑨ 的前三条里那三条全被违反。
//
//   臂 P（**对称性**，2026-09-25 补；纯静态）：两个面（独立页 `web/settings.js` / 浮层 `web/settings-panel.mjs`）
//     声明的设置键集合**必须相等**，而且**必须等于服务端默认值表**（`UI_SETTINGS_DEFAULTS` 的键）——
//     「同一项设置在一个面上能改、在另一个面上连看都看不到」正是 `959a587` 造出来的那个不对称。
//     判据（两面的权威关系、为什么独立页仍是产品面之一）写在 `docs/design-settings.md` §11。
//
// 红绿对照（同一把尺子量两个版本；副本要带上 node_modules）：
//   · 前端那半改回（`web/render.js` 的 thinking 默认写死 `false`）：
//       `SOPHO_SETTINGS_WEB=<去掉 setThinkingDefaultFold 用法的 web/ 副本> node test/settings-fold.mjs` ⇒ 臂 U 红。
//   · 服务端那半改回（`server/base-logic.mjs` 去掉 `/settings` 路由）：
//       `SOPHO_SETTINGS_ROOT=<去掉那条路由的仓库副本> node test/settings-fold.mjs` ⇒ 臂 S 红。
//   · 独立页的错误分支被吞掉（副本里把 `web/settings.js` 的 `load()` catch 整段去掉）—— 2026-09-25 实测：
//       `SOPHO_SETTINGS_WEB=<那个副本> node test/settings-fold.mjs` ⇒ `FAIL (62 passed, 5 failed)`、`EXIT=1`，
//       红的恰是 **⑧ 那 4 条**（404/500 各两条：如实报错、封存那行也如实）＋ 一条「臂 R1 的副本建不起来」的自报。
//   · 独立页少一张卡（副本里删掉 `settings.html` 的封存卡）—— 2026-09-25 实测：
//       `SOPHO_SETTINGS_WEB=<那个副本> node test/settings-fold.mjs` ⇒ `FAIL (43 passed, 24 failed)`、`EXIT=1`，
//       其中 **⑨ 的 6 条**全红（横向溢出那条**仍绿** ⇒ 它不是「随便什么都会红」），⑧／④b 连带红。
//
// 沙箱纪律：高位随机端口（绝不用 7331/7321）；临时 ASSIST_HOME / 日志 / 浏览器 profile；
// 不碰真 profile；不 pkill（只按自己 spawn 的 pid 停）。
//
// 用法：CHROME_BIN=/usr/bin/chromium node test/settings-fold.mjs

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { finishCleanup, removeSandbox } from './harness.mjs';
import { boot, readBody, sendJson, waitFor as uiWaitFor } from './ui-harness.mjs';
import { hostStatus, poll, request, reserveHighPort, sleep, writeMinimalHome } from './perf-verify-lib.mjs';
import { createUiSettingsStore, UI_SETTINGS_DEFAULTS, UI_SETTINGS_VERSION } from '../server/ui-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 红绿对照：把这两只 env 指到**副本**（同一把尺子量两个版本）。
const serverRoot = process.env.SOPHO_SETTINGS_ROOT ? path.resolve(process.env.SOPHO_SETTINGS_ROOT) : root;
const webRoot = process.env.SOPHO_SETTINGS_WEB ? path.resolve(process.env.SOPHO_SETTINGS_WEB) : path.join(serverRoot, 'web');
const BASE_ENTRY = path.join(serverRoot, 'server', 'base.mjs');

const SETTING = 'thinking.defaultFold';
// ④b / 臂 P 这一节量的那一项（`959a587` 只把它加进了浮层）：
const SEAL_KEY = 'seal.autoOnCompaction';
const SESSION_A = '1a1a1a1a-1111-4111-8111-111111111111';
const SESSION_B = '2b2b2b2b-2222-4222-8222-222222222222';

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-settings-'));
const HOME = path.join(sandbox, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const WORKSPACE = path.join(sandbox, 'workspace');
const UI_SETTINGS_FILE = path.join(HOME, 'ui-settings.json');
const BASE_LOG = path.join(sandbox, 'base.log');

let checks = 0;
const failures = [];
const problems = [];
/** 不中断：一次把所有红条目列全（报告里一眼看全貌），最后统一判。 */
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

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
/** 侧车文件的现状：不存在 ⇒ `{exists:false}`（"还不存在"也是可比的逐字节事实）。 */
async function uiSettingsFileState() {
  try {
    const bytes = await readFile(UI_SETTINGS_FILE);
    return { exists: true, sha256: sha256(bytes), text: bytes.toString('utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, sha256: null, text: null };
    throw error;
  }
}

// ───────────────────────── 夹具（臂 U 的假 API 伺服的内容） ─────────────────────────
const rows = [
  { id: SESSION_A, name: '配置门 A', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-21T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: SESSION_B, name: '配置门 B', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-21T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];
const messagesFor = (id, tag) => ([
  { entryId: `${tag}-user-1`, role: 'user', text: `${id} 的问题` },
  { entryId: `${tag}-asst-1`, role: 'assistant', parts: [
    { type: 'thinking', text: `${tag} 的思考：默认折叠态由服务端设置决定。`.repeat(3) },
    { type: 'text', text: `${tag} 的答案。` },
  ] },
]);
const sessionsState = new Map([
  [SESSION_A, { messages: messagesFor(SESSION_A, 'A') }],
  [SESSION_B, { messages: messagesFor(SESSION_B, 'B') }],
]);

// ───────────────────────── 臂 U 的假 API（`/api/settings` 是真模块 + 真文件） ─────────────────────────
/**
 * ⑧ 那一节用的注入开关（形状照 `test/settings-panel.mjs` 的 `settingsMode`）：
 *   · `'ok'`          —— 正常（真仓库模块 ＋ 真文件）；**默认**，其它臂读到的都是它；
 *   · `'missing-404'` —— **活宿主的形状**：顶层路径整个不认 ⇒ 404 ＋ **纯文本**体；
 *   · `'broken-500'`  —— 侧车坏了 ⇒ 500 ＋ JSON 错误体。
 * 只在 ⑧ / 臂 R1 里临时拨走，跑完一律拨回 `ok`（`finally` 里拨，别让后面读到坏值）。
 */
let settingsMode = 'ok';

const uiSettings = createUiSettingsStore({
  file: UI_SETTINGS_FILE,
  writeJson: async (file, value) => {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  },
});
const settingsPresses = []; // 浏览器这一侧打过的 PATCH：原始证据

async function fakeRoutes(request, response, url) {
  const pathname = url.pathname;
  if (pathname === '/api/host') { sendJson(response, 200, { ok: true }); return true; }
  if (pathname === '/api/devices') { sendJson(response, 200, { exists: true, devices: [] }); return true; }

  if (pathname === '/api/settings') {
    if (settingsMode === 'missing-404') {
      // 活宿主的形状：**顶层**路径不认 ⇒ 404 ＋ 纯文本（**不是** JSON ⇒ 前端必须照旧把它说成人话）。
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('not found\n');
      return true;
    }
    if (settingsMode === 'broken-500') {
      sendJson(response, 500, { error: 'ui_settings_invalid', message: 'ui-settings.json is invalid: 门里故意摆的坏文件' });
      return true;
    }
    if (request.method === 'GET') { sendJson(response, 200, await uiSettings.read()); return true; }
    if (request.method === 'PATCH') {
      const raw = await readBody(request);
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      try {
        const view = await uiSettings.patch(body);
        settingsPresses.push({ at: new Date().toISOString(), method: 'PATCH', body, status: 200, effective: view.settings[SETTING] });
        sendJson(response, 200, view);
      } catch (error) {
        settingsPresses.push({ at: new Date().toISOString(), method: 'PATCH', body, status: error?.statusCode ?? 500, error: error?.code ?? String(error) });
        sendJson(response, error?.statusCode ?? 500, typeof error?.toJSON === 'function' ? error.toJSON() : { error: 'internal', message: String(error) });
      }
      return true;
    }
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
    const session = sessionsState.get(match[1]);
    if (!row || !session) { sendJson(response, 404, { message: 'not found' }); return true; }
    const action = match[2] ?? null;
    if (action === null) { sendJson(response, 200, { name: row.name, cwd: WORKSPACE, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }); return true; }
    if (action === 'messages') { sendJson(response, 200, { sessionId: match[1], messages: session.messages, extras: [], compaction: { atIndex: null }, observability: null }); return true; }
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
const FACT_EXPR = `(() => [...document.querySelectorAll('#messages .message-thinking')].map((node) => ({
  collapsed: node.dataset.collapsed ?? null,
  hidden: node.querySelector('.thinking-body')?.hidden ?? null,
  aria: node.querySelector('.thinking-toggle')?.getAttribute('aria-expanded') ?? null,
  label: node.querySelector('.thinking-toggle')?.textContent ?? null,
})))()`;
const WAIT_THINKING_EXPR = `(async () => { const t = Date.now(); while (Date.now() - t < 8000) { if (document.querySelector('#messages .message-thinking')) return true; await new Promise((r) => setTimeout(r, 40)); } return false; })()`;

// ⚠️ 导航一律带一个**每次不同的查询串**：`/#<uuid>` 只改 hash 是**同文档**导航，`Page.loadEventFired`
// 不会来（第一次写这道门就栽在这里 —— 整个浏览器臂挂住）。带查询串 ⇒ 真换文档 + 真 load。
let navigationSeq = 0;
const nextUrl = (page, pathname, hash = '') => `http://127.0.0.1:${page.port}${pathname}?g=${++navigationSeq}${hash}`;

async function navigate(page, url) {
  const loaded = page.browser.once('Page.loadEventFired');
  await page.browser.send('Page.navigate', { url });
  // 等 load，但**不无限等**：导航失败要变成一条红断言，而不是把整道门挂死。
  await Promise.race([loaded, sleep(15_000)]);
}
async function reload(page) {
  const loaded = page.browser.once('Page.loadEventFired');
  await page.browser.send('Page.reload', { ignoreCache: true });
  await Promise.race([loaded, sleep(15_000)]);
}
/** 打开某条会话的会话页（深链 `#<uuid>`：树先落地、再开会话），等正文里出现 thinking 块。 */
async function openSession(page, sessionId) {
  await navigate(page, nextUrl(page, '/', `#${sessionId}`));
  await page.evaluate(WAIT_THINKING_EXPR);
  return page.evaluate(FACT_EXPR);
}
/** 打开配置页，等它把**服务端给的生效值**画上去（`#settings-fold` 上的 data-effective）。 */
async function openSettingsPage(page) {
  await navigate(page, nextUrl(page, '/settings.html'));
  await uiWaitFor(() => page.evaluate(`document.querySelector('#settings-fold')?.dataset.effective ?? null`), 'settings page did not paint an effective value');
  return page.evaluate(`(() => ({
    effective: document.querySelector('#settings-fold')?.dataset.effective ?? null,
    checked: document.querySelector('input[name="thinking-default-fold"]:checked')?.value ?? null,
    state: document.querySelector('#settings-state')?.textContent ?? null,
    kind: document.querySelector('#settings-state')?.dataset.kind ?? null,
  }))()`);
}
/** 在配置页上点一个选项（走真 `change` ⇒ 真 PATCH），等它画回**服务端给的**生效值。 */
async function pressSetting(page, value) {
  await page.evaluate(`(() => { const radio = document.querySelector('input[name="thinking-default-fold"][value=${JSON.stringify(value)}]'); if (!radio) throw new Error('no radio for ${value}'); radio.click(); return radio.checked; })()`);
  await uiWaitFor(() => page.evaluate(`(() => { const node = document.querySelector('#settings-state'); return node?.dataset.kind === 'ok' && document.querySelector('#settings-fold')?.dataset.effective === ${JSON.stringify(value)}; })()`), `settings page did not settle on ${value}`);
  return page.evaluate(`(() => ({
    effective: document.querySelector('#settings-fold')?.dataset.effective ?? null,
    checked: document.querySelector('input[name="thinking-default-fold"]:checked')?.value ?? null,
    state: document.querySelector('#settings-state')?.textContent ?? null,
  }))()`);
}
/** 在会话页上点第 `index` 个 thinking 块（走真 click ⇒ 既有「乙」的 localStorage 记忆）。
 *  ⚠️ 落盘是 **200 ms 防抖**（`render.js` 的 `schedulePersistCollapse`，既有「乙」的设计；
 *  `test/web-collapse-state.mjs` 的 ⑩ 也等它）—— 这里等到真落盘（拿原文当证据），
 *  不然「刷新」会跑在防抖前面，量的就不是产品承诺的那件事。 */
async function clickThinking(page, index = 0) {
  const before = await page.evaluate(FACT_EXPR);
  await page.evaluate(`(() => { const node = document.querySelectorAll('#messages .message-thinking')[${index}]; if (!node) throw new Error('no thinking block'); node.querySelector('.thinking-toggle').click(); return true; })()`);
  await sleep(60);
  const after = await page.evaluate(FACT_EXPR);
  const persisted = await uiWaitFor(() => readLocalStorage(page).then((value) => value ?? null), 'collapse state was not persisted to localStorage', 5000);
  return { before, after, persisted };
}
const readLocalStorage = (page) => page.evaluate(`(() => { const text = localStorage.getItem('sopho.collapse.v1'); return text ? JSON.parse(text) : null; })()`);

// ④b 「压缩即封存」那一行在**独立页**上的事实（这一节量的是对称性的那半边）。
const SEAL_FACT_EXPR = `(() => ({
  exists: !!document.querySelector('#settings-seal-auto'),
  disabled: document.querySelector('#settings-seal-auto')?.disabled ?? null,
  checked: document.querySelector('#settings-seal-auto')?.checked ?? null,
  state: document.querySelector('#settings-seal-state')?.textContent ?? null,
  kind: document.querySelector('#settings-seal-state')?.dataset.kind ?? null,
  title: document.querySelector('#settings-seal-title')?.textContent ?? null,
}))()`;
/** 打开配置页，等压缩即封存那一行画出结果（`data-kind` 不是「正在读取…」那一档）。
 *  ⚠️ 等不到**不抛**：那一行整个不在时（红半边）要把现状交回给下面那几条**逐条断言红**，
 *  而不是抛出去中断整条浏览器臂（报告里才看得全账）。 */
async function openSealCard(page) {
  await navigate(page, nextUrl(page, '/settings.html'));
  await uiWaitFor(() => page.evaluate(`(() => { const kind = document.querySelector('#settings-seal-state')?.dataset.kind ?? null; return kind === 'ok' || kind === 'error' ? kind : null; })()`), 'settings page did not paint the seal row').catch(() => {});
  return page.evaluate(SEAL_FACT_EXPR);
}
/** 在配置页上把封存开关拨到 `value`（真 `click` ⇒ 真 `change` ⇒ 真 PATCH），等它画回服务端生效值。
 *  元素不在 ⇒ 不点、也不抛，把现状交回去让断言红。 */
async function pressSeal(page, value) {
  const clicked = await page.evaluate(`(() => { const box = document.querySelector('#settings-seal-auto'); if (!box) return false; if (box.checked !== ${JSON.stringify(value)}) box.click(); return true; })()`);
  if (!clicked) return page.evaluate(SEAL_FACT_EXPR);
  await uiWaitFor(() => page.evaluate(`(() => { const box = document.querySelector('#settings-seal-auto'); return box && box.checked === ${JSON.stringify(value)} && document.querySelector('#settings-seal-state')?.dataset.kind === 'ok'; })()`), `settings page did not settle seal=${value}`).catch(() => {});
  return page.evaluate(SEAL_FACT_EXPR);
}

// ══════════ ⑧ 独立页的「读不到」（404／500）＋ ⑨ 封存卡的几何＋它们的反证臂（2026-09-25 补） ══════════
//
// 为什么补这两件（派单：`020ef59` 自己如实列出的两个缺口）：
//   · **独立页的「读不到」那一档没有门**：新卡（`seal.autoOnCompaction`）与另三项共用同一条 `load()`
//     错误分支（四条状态行一起写），而 404/500 只在**浮层**有门（`test/settings-panel.mjs` 臂 C/⑧）。
//     这里把独立页这条路补上，判据与浮层同口径：状态行**如实显示那条错误**、控件**全被禁用**、
//     **不假成功**（不画生效值 ＋ 一个 `PATCH /settings` 都不发）、以及**恢复路径**。
//   · **新卡的几何没进门**：上次只跑了一次性探针（不是门）。这里写成机械判据（能量到数、能红）。
//
// 同一组谓词两处用：绿臂逐条断言「真」，反证臂（臂 R1/R2）断言「必须被违反」——
// 红半因此钉在同一批**具名**断言上（每条谓词有 `id`），不是另写一套判据。

/** 「读不到」两档的注入规格（404 = 端点整个不存在、非 JSON 体；500 = 侧车坏了、JSON 错误体）。 */
const READ_FAILURE_SPECS = [
  { mode: 'missing-404', code: '404', why: '端点整个不存在（活宿主的形状：404 ＋ 纯文本体）', message: /not found/ },
  { mode: 'broken-500', code: '500', why: '侧车坏了（500 ＋ JSON 错误体）', message: /坏文件/ },
];

/** 独立页当下的原始读数（⑧ 与臂 R1 共用同一把尺子）。 */
const STANDALONE_FACT_EXPR = `(() => {
  const text = (node) => (node ? node.textContent : null);
  const kind = (node) => (node?.dataset?.kind ?? null);
  const disabled = (sel) => document.querySelector(sel)?.disabled ?? null;
  const checked = (sel) => document.querySelector(sel)?.checked ?? null;
  const radios = [...document.querySelectorAll('input[name="thinking-default-fold"]')];
  const retry = [...document.querySelectorAll('button, a')]
    .filter((node) => /重试/.test(node.textContent ?? '') && node.getClientRects().length > 0)
    .map((node) => ({ tag: node.tagName, id: node.id || null, text: (node.textContent ?? '').trim() }));
  return {
    href: location.href,
    pathname: location.pathname,
    effective: document.querySelector('#settings-fold')?.dataset.effective ?? null,
    radios: radios.map((node) => ({ value: node.value, checked: node.checked, disabled: node.disabled })),
    notify: { input: disabled('#settings-notify-input'), save: disabled('#settings-notify-save') },
    suggestions: { disabled: disabled('#settings-suggestions-enabled'), checked: checked('#settings-suggestions-enabled'), state: text(document.querySelector('#settings-suggestions-state')), kind: kind(document.querySelector('#settings-suggestions-state')) },
    seal: { exists: !!document.querySelector('#settings-seal-auto'), disabled: disabled('#settings-seal-auto'), checked: checked('#settings-seal-auto'), state: text(document.querySelector('#settings-seal-state')), kind: kind(document.querySelector('#settings-seal-state')) },
    states: {
      fold: { text: text(document.querySelector('#settings-state')), kind: kind(document.querySelector('#settings-state')) },
      notify: { text: text(document.querySelector('#settings-notify-state')), kind: kind(document.querySelector('#settings-notify-state')) },
      suggestions: { text: text(document.querySelector('#settings-suggestions-state')), kind: kind(document.querySelector('#settings-suggestions-state')) },
      seal: { text: text(document.querySelector('#settings-seal-state')), kind: kind(document.querySelector('#settings-seal-state')) },
    },
    retryControls: retry,
  };
})()`;

/**
 * 在独立页上制造一次「读不到」，量它当下的样子，然后**走恢复路径**再量一次。
 * 恢复路径**不写死**：页面**有**页内重试控件就走它（真 `click`、不刷新文档），**没有**就走真用户
 * 手上那条 —— 刷新页面（并如实报出用的是哪条）。`PATCH` 全程记账（读不到时一个都不许发）。
 */
async function collectStandaloneReadFailure(page, spec) {
  const pressesBefore = settingsPresses.length;
  settingsMode = spec.mode;
  await navigate(page, nextUrl(page, '/settings.html'));
  // 等它把「读不到」那句话画上来。⚠️ 等不到**不抛**：红半要逐条断言红，而不是把这一节中断掉。
  await uiWaitFor(() => page.evaluate(`(() => { const node = document.querySelector('#settings-state'); return node?.dataset.kind === 'error' ? true : null; })()`), `standalone page did not report the ${spec.mode} read error`, 5000).catch(() => {});
  const facts = await page.evaluate(STANDALONE_FACT_EXPR);
  const pressesAtFailure = settingsPresses.length;
  // ⚠️ 「location 没变」量的是**这一页这一次失败时的 URL**（不是导航前那一页的）：恢复路径不许换文档。
  const hrefAtFailure = await page.evaluate('location.href');

  settingsMode = 'ok';
  const path = facts.retryControls.length > 0 ? 'in-page-retry' : 'reload';
  if (path === 'in-page-retry') {
    await page.evaluate(`(() => { const node = [...document.querySelectorAll('button, a')].find((item) => /重试/.test(item.textContent ?? '')); node.click(); return true; })()`);
  } else {
    await reload(page);
  }
  await uiWaitFor(() => page.evaluate(`document.querySelector('#settings-fold')?.dataset.effective ?? null`), `standalone page did not recover after ${spec.mode}`).catch(() => {});
  const after = await page.evaluate(STANDALONE_FACT_EXPR);
  return { spec, facts, after, path, pressesBefore, pressesAtFailure, pressesAfter: settingsPresses.length, hrefAtFailure, hrefAfter: await page.evaluate('location.href') };
}

/** 独立页「读不到」的**同一组谓词**：绿臂断言「真」，臂 R1 断言「被违反」（`id` 是红半点名用的）。 */
function standaloneReadFailurePredicates(collected, serverView) {
  const { spec, facts, after } = collected;
  const code = spec.code;
  const lines = ['fold', 'notify', 'suggestions', 'seal'].map((key) => facts.states[key]);
  const recoveryName = collected.path === 'in-page-retry' ? '页内**重试**' : '刷新页面（这一页没有页内重试控件）';
  return [
    {
      id: 'state-honest',
      name: `⑧ 独立页读不到（${code}：${spec.why}）⇒ 四条状态行**如实显示那条错误**（原文逐字在里面），「思考折叠」那条还带着服务端码 —— 不是「正在读取…」、也不算成功`,
      ok: lines.every((line) => line?.kind === 'error' && /读不到设置/.test(line?.text ?? '') && spec.message.test(line?.text ?? ''))
        && (facts.states.fold.text ?? '').includes(code),
      detail: { states: facts.states },
    },
    {
      id: 'controls-disabled',
      name: `⑧ 独立页读不到（${code}）⇒ 控件**全被禁用**（思考折叠两个 radio ＋ 维护者会话输入/保存 ＋ 推荐回复 ＋ 压缩即封存）`,
      ok: facts.radios.length === 2 && facts.radios.every((item) => item.disabled === true)
        && facts.notify.input === true && facts.notify.save === true
        && facts.suggestions.disabled === true && facts.seal.disabled === true,
      detail: { radios: facts.radios, notify: facts.notify, suggestions: facts.suggestions, seal: facts.seal },
    },
    {
      id: 'no-fake-success',
      name: `⑧ 独立页读不到（${code}）⇒ **不假成功**（#settings-fold 上没有 data-effective、勾选一个都没有），且**一个 PATCH /settings 都没发**`,
      ok: facts.effective === null && facts.radios.every((item) => item.checked === false)
        && facts.suggestions.checked === false && facts.seal.checked === false
        && collected.pressesAtFailure === collected.pressesBefore,
      detail: { effective: facts.effective, radios: facts.radios, suggestions: facts.suggestions, seal: facts.seal, patches: { before: collected.pressesBefore, atFailure: collected.pressesAtFailure } },
    },
    {
      id: 'seal-row-honest',
      name: `⑧ 独立页读不到（${code}）· **封存那一行**也如实显示同一条错误并禁用（不是只把「思考折叠」那一行说了 —— 这正是本单要盖的那张新卡）`,
      ok: facts.seal.exists === true && facts.seal.kind === 'error'
        && /读不到设置/.test(facts.seal.state ?? '') && spec.message.test(facts.seal.state ?? '')
        && facts.seal.disabled === true,
      detail: facts.seal,
    },
    {
      id: 'recovery',
      name: `⑧ 独立页读不到（${code}）之后有**恢复路径**（${recoveryName}）⇒ 真重读、照服务端生效值重画（四条状态行都 'ok'、location 一字未变、没有多发 PATCH）`,
      ok: ['fold', 'notify', 'suggestions', 'seal'].every((key) => after.states[key]?.kind === 'ok')
        && after.effective === serverView.settings[SETTING]
        && after.radios.some((item) => item.checked === true && item.value === after.effective)
        && after.seal.disabled === false && after.seal.checked === serverView.settings[SEAL_KEY]
        && after.href === collected.hrefAtFailure
        && collected.pressesAfter === collected.pressesAtFailure,
      detail: { path: collected.path, effective: after.effective, serverFold: serverView.settings[SETTING], sealChecked: after.seal.checked, serverSeal: serverView.settings[SEAL_KEY], states: after.states, href: { atFailure: collected.hrefAtFailure, after: after.href }, patches: { atFailure: collected.pressesAtFailure, after: collected.pressesAfter } },
    },
  ];
}

async function runStandaloneReadFailureArms(page) {
  for (const spec of READ_FAILURE_SPECS) {
    let collected;
    try {
      collected = await collectStandaloneReadFailure(page, spec);
    } catch (error) {
      check(`⑧ 独立页读不到（${spec.code}）· 这一节没跑完`, false, String(error?.stack ?? error));
      continue;
    } finally {
      settingsMode = 'ok';
    }
    print(`⑧ 独立页读不到（${spec.code}）的原始读数`, { facts: collected.facts, after: collected.after, path: collected.path, patches: { before: collected.pressesBefore, atFailure: collected.pressesAtFailure, after: collected.pressesAfter } });
    for (const item of standaloneReadFailurePredicates(collected, await uiSettings.read())) check(item.name, item.ok, item.detail);
  }
}

// ── ⑨ 封存那张卡的几何（1200×760 / 420×820） ──────────────────────────────────
/** 独立页的几何读数：可滚动内容盒 = 整页（`documentElement`）。 */
const STANDALONE_GEOMETRY_EXPR = `(() => {
  const rect = (node) => { const r = node.getBoundingClientRect(); return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }; };
  const cards = [...document.querySelectorAll('main.settings-page section.settings-card')].map((node) => {
    const heading = node.querySelector('h2');
    return { titleId: heading?.id ?? null, title: heading?.textContent ?? null, labelledby: node.getAttribute('aria-labelledby'), rect: rect(node) };
  });
  const main = document.querySelector('main.settings-page');
  const sealBox = document.querySelector('#settings-seal-auto');
  const sealTitle = document.querySelector('#settings-seal-title');
  const sealState = document.querySelector('#settings-seal-state');
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { docScrollWidth: document.documentElement.scrollWidth, docScrollHeight: document.documentElement.scrollHeight, bodyScrollWidth: document.body.scrollWidth, scrollY: window.scrollY },
    main: main ? { rect: rect(main), scrollWidth: main.scrollWidth, clientWidth: main.clientWidth } : null,
    cards,
    seal: sealBox ? {
      title: sealTitle ? rect(sealTitle) : null,
      box: rect(sealBox),
      state: sealState ? rect(sealState) : null,
      boxVisibleBeforeScroll: (() => { const r = sealBox.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight; })(),
    } : null,
  };
})()`;

/** 「这一页把封存那行画完了没有」：画好了 / 这一行整个不在（红半）—— 都不挂等。 */
const SEAL_SETTLE_EXPR = `(() => {
  const state = document.querySelector('#settings-seal-state');
  if (state && state.dataset.kind === 'ok') return 'painted';
  if (!document.querySelector('#settings-seal-auto')) return 'absent';
  return null;
})()`;

async function collectStandaloneSealGeometry(page, viewport) {
  await page.resize(viewport.width, viewport.height);
  await navigate(page, nextUrl(page, '/settings.html'));
  await uiWaitFor(() => page.evaluate(SEAL_SETTLE_EXPR), `standalone settings page did not settle the seal row at ${viewport.width}x${viewport.height}`, 5000).catch(() => {});
  const geometry = await page.evaluate(STANDALONE_GEOMETRY_EXPR);
  const reached = await page.evaluate(`(() => {
    const box = document.querySelector('#settings-seal-auto');
    if (!box) return null;
    box.scrollIntoView({ block: 'center' });
    const r = box.getBoundingClientRect();
    return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1), scrollY: window.scrollY, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  })()`);
  return { viewport, geometry, reached };
}

/** 封存卡几何的**同一组谓词**：绿臂断言「真」，臂 R2 断言「被违反」（`id` 是红半点名用的）。 */
function sealGeometryPredicates(reading) {
  const { viewport, geometry, reached } = reading;
  const tag = `${viewport.width}×${viewport.height}`;
  const inViewport = (r) => !!r && r.width > 0 && r.height > 0 && r.left >= -0.5 && r.right <= viewport.width + 0.5;
  const order = geometry.cards.map((card) => card.titleId).join(',');
  const expectedOrder = 'settings-fold-title,settings-notify-title,settings-suggestions-title,settings-seal-title';
  return [
    {
      id: 'order',
      name: `⑨ ${tag} · 四张卡片**顺序**是 思考折叠 → 维护者会话 → 推荐回复 → 压缩即封存（封存卡**在最后**、一张不多不少、纵向不重叠）`,
      ok: order === expectedOrder && geometry.cards.every((card) => card.labelledby === card.titleId)
        && geometry.cards.every((card, index) => index === 0 || card.rect.top >= geometry.cards[index - 1].rect.bottom - 1),
      detail: { order, titles: geometry.cards.map((card) => card.title), tops: geometry.cards.map((card) => card.rect.top), bottoms: geometry.cards.map((card) => card.rect.bottom) },
    },
    {
      id: 'no-h-overflow',
      name: `⑨ ${tag} · 量到的视口就是 ${tag}，且**没有横向溢出**（文档/正文/main 内容盒都不横向滚，四张卡左右都在视口内）`,
      ok: geometry.viewport.width === viewport.width && geometry.viewport.height === viewport.height
        && geometry.scroll.docScrollWidth <= viewport.width && geometry.scroll.bodyScrollWidth <= viewport.width
        && geometry.main !== null && geometry.main.scrollWidth <= geometry.main.clientWidth
        && geometry.cards.length > 0 && geometry.cards.every((card) => inViewport(card.rect)),
      detail: { measuredViewport: geometry.viewport, requestedViewport: viewport, scroll: geometry.scroll, main: geometry.main, cards: geometry.cards.map((card) => card.rect) },
    },
    {
      id: 'seal-in-content-box',
      name: `⑨ ${tag} · 封存那一行（标题／勾选框／状态行）在**可滚动内容盒**内（左右在视口内、下沿不超过文档内容高度 ⇒ 不是被某个 overflow 盒子裁掉的）`,
      ok: geometry.seal !== null
        && [geometry.seal.title, geometry.seal.box, geometry.seal.state].every((r) => inViewport(r))
        && geometry.seal.box.bottom <= geometry.scroll.docScrollHeight + 1 && geometry.seal.state.bottom <= geometry.scroll.docScrollHeight + 1,
      detail: { seal: geometry.seal, docScrollHeight: geometry.scroll.docScrollHeight },
    },
    {
      id: 'seal-visible-after-scroll',
      name: `⑨ ${tag} · 滚过去**真的看得到**（scrollIntoView 之后勾选框四边都在视口内；页面确实滚了、或它本来就可见）`,
      ok: reached !== null && reached.top >= -0.5 && reached.bottom <= viewport.height + 0.5 && inViewport(reached)
        && (reached.scrollY > 0 || geometry.seal?.boxVisibleBeforeScroll === true),
      detail: { reached, boxVisibleBeforeScroll: geometry.seal?.boxVisibleBeforeScroll ?? null },
    },
  ];
}

async function runStandaloneSealGeometryArm(page) {
  for (const viewport of [{ width: 1200, height: 760 }, { width: 420, height: 820 }]) {
    let reading;
    try {
      reading = await collectStandaloneSealGeometry(page, viewport);
    } catch (error) {
      check(`⑨ ${viewport.width}×${viewport.height} · 这一节没跑完`, false, String(error?.stack ?? error));
      continue;
    }
    print(`⑨ ${viewport.width}×${viewport.height} · 封存卡几何原始读数`, reading);
    await page.screenshot(path.join(os.tmpdir(), `sopho-settings-fold-seal-${viewport.width}x${viewport.height}.png`)).catch(() => {});
    for (const item of sealGeometryPredicates(reading)) check(item.name, item.ok, item.detail);
  }
  await page.resize(1200, 760).catch(() => {});
}

// ── 臂 R1 / R2：反证臂（副本里各拆一处；按「断言其红」记账，不进 `failed`） ──────────────
/** 把 `web/` 拷一份、按 `patch` 拆一处（同一把尺子量两个版本；照 `test/settings-panel.mjs` 臂 B/D 的先例）。 */
async function makeWebMutant(label, patch) {
  const mutantRoot = path.join(sandbox, `mutant-${label}`);
  await cp(webRoot, mutantRoot, { recursive: true });
  const what = await patch(mutantRoot);
  return { root: mutantRoot, label, what };
}

/** 臂 R1：副本里把 `load()` 的错误分支换成「用本地默认值假装成功」⇒ ⑧ 的前四条必须全被违反。 */
async function runReadFailureMutantArm() {
  let mutant = null;
  const violated = [];
  const cleanupProblems = [];
  const readings = [];
  let page = null;
  try {
    mutant = await makeWebMutant('read-fake-success', async (dir) => {
      const file = path.join(dir, 'settings.js');
      const source = await readFile(file, 'utf8');
      const target = /    for \(const radio of NODE\.radios\) radio\.disabled = true;\n[\s\S]*?    setSealState\(`读不到设置：\$\{error\.message\}`, 'error'\);\n/;
      if (!target.test(source)) throw new Error(`反证臂（读不到）：副本里没找到 load() 的错误分支（${file}）`);
      const replacement = '    // 反证臂：读不到时**用本地默认值假装成功**（本仓不这么做；新臂必须红在这上面）\n'
        + "    paint({ settings: { [KEY]: 'expanded', [NOTIFY_KEY]: '', [SUGGESTIONS_KEY]: true, [SEAL_KEY]: true }, stored: {} });\n";
      await writeFile(file, source.replace(target, replacement));
      return `把 web/settings.js 的 load() 错误分支换成「用本地默认值假装成功」（${file}）`;
    });
    page = await boot({ routes: fakeRoutes, width: 1200, height: 760, webRoot: mutant.root });
    print('臂 R1（反证臂）· 沙箱', { port: page.port, webRoot: mutant.root });
    for (const spec of READ_FAILURE_SPECS) {
      const collected = await collectStandaloneReadFailure(page, spec);
      const items = standaloneReadFailurePredicates(collected, await uiSettings.read());
      for (const item of items) if (!item.ok) violated.push(`${spec.code}/${item.id}`);
      readings.push({ code: spec.code, path: collected.path, states: collected.facts.states, controls: { radios: collected.facts.radios, notify: collected.facts.notify, suggestions: collected.facts.suggestions, seal: collected.facts.seal }, effective: collected.facts.effective });
    }
    print('臂 R1（反证臂）· 副本上的原始读数（读不到时**没有**如实报错、控件没禁用、还画了生效值）', readings);
  } catch (error) {
    // 副本没建成 / 这一节没跑完：也记一条违反（外层那条 check 因此红）—— 红半验不了不许静默。
    violated.push(`臂 R1 中断：${String(error?.stack ?? error)}`);
  } finally {
    settingsMode = 'ok';
    if (page) {
      // ⚠️ 传**本臂自己的**数组：反证臂的页面读数不该混进全局 `problems`（那不是产品红）；
      // 但它自己的收尾失败照样进这条红通道（下面拼进 violated）。
      await page.close(cleanupProblems).catch(() => {});
      await removeSandbox(page.sandbox, cleanupProblems, 'remove settings-fold R1 sandbox').catch(() => {});
    }
  }
  for (const message of cleanupProblems) violated.push(`臂 R1 收尾：${message}`);
  return { mutant, violated, pageProblems: page?.pageProblems?.slice() ?? [], cleanupProblems };
}

/** 臂 R2：副本里删掉封存那张卡 ⇒ ⑨ 的「顺序」「在内容盒内」「滚过去可见」必须全被违反。 */
async function runSealGeometryMutantArm() {
  let mutant = null;
  const violated = [];
  const cleanupProblems = [];
  const readings = [];
  let page = null;
  try {
    mutant = await makeWebMutant('seal-card-dropped', async (dir) => {
      const html = path.join(dir, 'settings.html');
      const source = await readFile(html, 'utf8');
      const target = /\n    <section class="settings-card" aria-labelledby="settings-seal-title">[\s\S]*?<\/section>\n/;
      if (!target.test(source)) throw new Error(`反证臂（几何）：副本里没找到「压缩即封存」那张卡片（${html}）`);
      await writeFile(html, source.replace(target, '\n'));
      // 顺带：给这张卡的引用加个不会抛的替身 —— 只为让这个副本**不因缺卡而崩**（缺卡本身会先在
      // `paintSeal` 里 null 解引用），与几何断言无关。少了这一处，量的会是「页面抛异常」而不是
      // 「卡片不在」，红的原因就不干净了。
      const js = path.join(dir, 'settings.js');
      const jsSource = await readFile(js, 'utf8');
      const anchor = "  sealState: document.querySelector('#settings-seal-state'),\n};";
      if (!jsSource.includes(anchor)) throw new Error(`反证臂（几何）：副本里没找到 NODE 表尾（${js}）`);
      const stub = `${anchor}\n// 反证臂：卡片被删掉 ⇒ 用不会抛的替身顶住这两条引用（与几何断言无关）\nif (!NODE.sealToggle) NODE.sealToggle = { disabled: true, checked: false, dataset: {}, addEventListener() {} };\nif (!NODE.sealState) NODE.sealState = { textContent: '', dataset: {} };`;
      await writeFile(js, jsSource.replace(anchor, stub));
      return `删掉 web/settings.html 的「压缩即封存」那张卡（${html}）＋给它的引用加不抛的替身（${js}）`;
    });
    page = await boot({ routes: fakeRoutes, width: 1200, height: 760, webRoot: mutant.root });
    print('臂 R2（反证臂）· 沙箱', { port: page.port, webRoot: mutant.root });
    for (const viewport of [{ width: 1200, height: 760 }, { width: 420, height: 820 }]) {
      const reading = await collectStandaloneSealGeometry(page, viewport);
      for (const item of sealGeometryPredicates(reading)) if (!item.ok) violated.push(`${viewport.width}×${viewport.height}/${item.id}`);
      readings.push({ viewport, order: reading.geometry.cards.map((card) => card.titleId), seal: reading.geometry.seal, reached: reading.reached, scroll: reading.geometry.scroll });
    }
    print('臂 R2（反证臂）· 副本上的原始读数（封存卡整个不在 ⇒ 顺序/内容盒/可见三条没有素材）', readings);
  } catch (error) {
    violated.push(`臂 R2 中断：${String(error?.stack ?? error)}`);
  } finally {
    if (page) {
      await page.close(cleanupProblems).catch(() => {});
      await removeSandbox(page.sandbox, cleanupProblems, 'remove settings-fold R2 sandbox').catch(() => {});
    }
  }
  for (const message of cleanupProblems) violated.push(`臂 R2 收尾：${message}`);
  return { mutant, violated, pageProblems: page?.pageProblems?.slice() ?? [], cleanupProblems };
}

async function openBrowser(label) {
  const page = await boot({ routes: fakeRoutes, width: 1200, height: 760, webRoot });
  print(`browser ${label}`, { port: page.port, userDataDir: path.join(page.sandbox, 'chromium'), chrome: page.version?.Browser ?? null });
  return page;
}

// ───────────────────────── 臂 S 的宿主（真 A） ─────────────────────────
async function startBase() {
  const port = await reserveHighPort();
  const logHandle = await open(BASE_LOG, 'w');
  const child = spawn(process.execPath, [BASE_ENTRY], {
    cwd: serverRoot,
    env: {
      ...process.env,
      HOME,
      ASSIST_HOME: HOME,
      SOPHO_AGENT_DIR: HOME,
      PI_CODING_AGENT_DIR: HOME,
      PI_CODING_AGENT_SESSION_DIR: SESSIONS,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: WORKSPACE,
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '2',
    },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        sleep(15_000).then(() => false),
      ]);
      if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await logHandle.close().catch(() => {});
  };
  return { port, child, stop };
}

// ═══════════════════════════ 臂 T：TUI 一致性（⑦） ═══════════════════════════
async function runTuiConsistencyArm() {
  const piPackage = '@earendil-works/pi-coding-agent';
  const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve(piPackage))));
  const docsPath = path.join(packageRoot, 'docs', 'settings.md');
  const managerPath = path.join(packageRoot, 'dist', 'core', 'settings-manager.js');
  const docsText = await readFile(docsPath, 'utf8');
  const managerText = await readFile(managerPath, 'utf8');
  const docLineIndex = docsText.split('\n').findIndex((line) => line.includes('`hideThinkingBlock`'));
  const docLine = docLineIndex >= 0 ? docsText.split('\n')[docLineIndex].trim() : '';
  const docDefault = /`hideThinkingBlock`\s*\|\s*boolean\s*\|\s*`([^`]*)`/.exec(docLine)?.[1] ?? null;
  const getterLineIndex = managerText.split('\n').findIndex((line) => line.includes('getHideThinkingBlock()'));
  const getter = /getHideThinkingBlock\(\)\s*\{\s*return\s+([^;]+);/.exec(managerText)?.[1]?.trim() ?? null;
  print('臂 T · pi 的 hideThinkingBlock（原始出处）', {
    packageRoot,
    docs: `${docsPath}:${docLineIndex + 1}`,
    docLine,
    manager: `${managerPath}:${getterLineIndex + 1}`,
    getter,
    ours: UI_SETTINGS_DEFAULTS[SETTING],
  });
  check('⑦ pi 文档说 `hideThinkingBlock` 默认 `false`（= 思考默认**可见**）', docDefault === 'false', JSON.stringify({ docDefault, docLine: docLine.slice(0, 200) }));
  check('⑦ pi 代码 `getHideThinkingBlock()` 是 `?? false`（文档与代码同一口径）', getter === 'this.settings.hideThinkingBlock ?? false', JSON.stringify(getter));
  check('⑦ 我们的默认 `expanded`（= 不收起思考）与 pi 的 `false` 同义 ⇒ 默认与 TUI 一致',
    UI_SETTINGS_DEFAULTS[SETTING] === 'expanded',
    JSON.stringify({ ours: UI_SETTINGS_DEFAULTS[SETTING], pi: `hideThinkingBlock=${docDefault}` }));
}

// ═════════════════════════ 臂 P：对称性（纯静态） ═════════════════════════
// 两个面声明的键集合**必须相等**，且等于服务端默认值表的键。收集口径是各自源码里那一行
// `const <NAME>_KEY = '<键>'`（两个文件都是这个形状）；**不去猜渲染出来的 DOM** —— 那由臂 U 的
// ④b 用真浏览器另外钉。
async function runParityArm() {
  const collect = async (file) => {
    const text = await readFile(path.join(webRoot, file), 'utf8');
    return [...text.matchAll(/^const \w*KEY = '([^']+)'/gm)].map((match) => match[1]).sort();
  };
  const pageKeys = await collect('settings.js');
  const panelKeys = await collect('settings-panel.mjs');
  const serverKeys = Object.keys(UI_SETTINGS_DEFAULTS).sort();
  print('臂 P · 两个面各自声明的设置键（原始收集）', { 'web/settings.js': pageKeys, 'web/settings-panel.mjs': panelKeys, 'UI_SETTINGS_DEFAULTS': serverKeys });
  check('臂 P ① 独立页与浮层声明的设置键**集合相等**（一边加了一项、另一边没加 ⇒ 这里红）',
    pageKeys.length > 0 && JSON.stringify(pageKeys) === JSON.stringify(panelKeys),
    JSON.stringify({ pageKeys, panelKeys }));
  check('臂 P ② 两个面的键集都**等于服务端默认值表**的键（服务端有的每一项两个面都画得到 ⇒ 没有第三个面）',
    JSON.stringify(pageKeys) === JSON.stringify(serverKeys) && JSON.stringify(panelKeys) === JSON.stringify(serverKeys),
    JSON.stringify({ pageKeys, panelKeys, serverKeys }));
}

// ═══════════════════════════ 臂 S：服务端（真 A + 真 worker） ═══════════════════════════
let base = null;

async function runServerArm() {
  await mkdir(HOME, { recursive: true });
  await mkdir(SESSIONS, { recursive: true });
  await writeMinimalHome(HOME, WORKSPACE);
  base = await startBase();
  const status = await poll('base ready', () => hostStatus(base.port).catch((error) => ({ error: error.message })), (value) => !value.error, 30_000);
  print('sandbox', { tmp: sandbox, uiSettingsFile: UI_SETTINGS_FILE, baseLog: BASE_LOG, basePort: base.port, basePid: base.child.pid, logicVersion: status.logicVersion, serverRoot, webRoot, uiSettingsVersion: UI_SETTINGS_VERSION });

  const api = (pathname, options = {}) => request(base.port, pathname, { timeoutMs: 30_000, method: options.method ?? 'GET', body: options.body === undefined ? null : JSON.stringify(options.body) });

  // ⑦ 未改过：生效值 = 服务端默认，`stored` 空、`exists:false`。
  const freshState = await uiSettingsFileState();
  const fresh = await api('/settings');
  print('GET /settings（没改过）', { status: fresh.statusCode, value: fresh.value, file: freshState });
  check('⑦ GET /settings ⇒ 200，生效值 = 服务端默认 expanded（默认 ⊕ 已存）',
    fresh.statusCode === 200 && fresh.value?.settings?.[SETTING] === 'expanded' && fresh.value?.defaults?.[SETTING] === 'expanded',
    JSON.stringify({ status: fresh.statusCode, settings: fresh.value?.settings, defaults: fresh.value?.defaults }));
  check('⑦ 没改过 ⇒ `stored:{}` / `exists:false`；`file` 是**我们自己的侧车**（不是 pi 的 settings.json）',
    JSON.stringify(fresh.value?.stored) === '{}' && fresh.value?.exists === false && fresh.value?.file === UI_SETTINGS_FILE && !/[\\/]settings\.json$/.test(fresh.value?.file ?? ''),
    JSON.stringify({ stored: fresh.value?.stored, exists: fresh.value?.exists, file: fresh.value?.file }));
  check('④ 还没写过文件时侧车确实不存在（坏输入之后也不许"顺手建一个"）', freshState.exists === false, JSON.stringify(freshState));

  // ④ 坏输入各来一发：诚实 400，且文件（此刻还不存在）逐字节未变。
  const beforeBad = await uiSettingsFileState();
  const badInputs = {
    unknownKey: await api('/settings', { method: 'PATCH', body: { 'thinking.unknown': 'collapsed' } }),
    badValue: await api('/settings', { method: 'PATCH', body: { [SETTING]: 'Collapsed' } }),
    badValueType: await api('/settings', { method: 'PATCH', body: { [SETTING]: true } }),
    badBodyArray: await api('/settings', { method: 'PATCH', body: ['collapsed'] }),
    emptyBody: await api('/settings', { method: 'PATCH', body: {} }),
    wrongMethod: await api('/settings', { method: 'PUT' }),
  };
  const afterBad = await uiSettingsFileState();
  print('坏输入各来一发', Object.fromEntries(Object.entries(badInputs).map(([key, reply]) => [key, { status: reply.statusCode, body: reply.value }])));
  check('④ 未知 key ⇒ 400 unknown_setting_key', badInputs.unknownKey.statusCode === 400 && badInputs.unknownKey.value?.error === 'unknown_setting_key', JSON.stringify(badInputs.unknownKey.value));
  check('④ 非法值（大小写不对）⇒ 400 invalid_setting_value', badInputs.badValue.statusCode === 400 && badInputs.badValue.value?.error === 'invalid_setting_value', JSON.stringify(badInputs.badValue.value));
  check('④ 非法值（不是字符串）⇒ 400 invalid_setting_value', badInputs.badValueType.statusCode === 400 && badInputs.badValueType.value?.error === 'invalid_setting_value', JSON.stringify(badInputs.badValueType.value));
  check('④ 非对象 body ⇒ 400 invalid_settings_body', badInputs.badBodyArray.statusCode === 400 && badInputs.badBodyArray.value?.error === 'invalid_settings_body', JSON.stringify(badInputs.badBodyArray.value));
  check('④ 空 body ⇒ 400 empty_settings_patch', badInputs.emptyBody.statusCode === 400 && badInputs.emptyBody.value?.error === 'empty_settings_patch', JSON.stringify(badInputs.emptyBody.value));
  check('④ 写错方法 ⇒ 405 method_not_allowed', badInputs.wrongMethod.statusCode === 405 && badInputs.wrongMethod.value?.error === 'method_not_allowed', JSON.stringify(badInputs.wrongMethod.value));
  check('④ 坏输入一个字节都没落盘（前后都是 ENOENT）',
    beforeBad.exists === false && afterBad.exists === false,
    JSON.stringify({ before: beforeBad, after: afterBad }));

  // ① 合法 PATCH：200 + 新生效值 + 真落盘。
  const patched = await api('/settings', { method: 'PATCH', body: { [SETTING]: 'collapsed' } });
  const afterPatch = await uiSettingsFileState();
  print('PATCH collapsed', { status: patched.statusCode, value: patched.value, file: { exists: afterPatch.exists, sha256: afterPatch.sha256, text: afterPatch.text } });
  check('① PATCH collapsed ⇒ 200，回**新的生效值**',
    patched.statusCode === 200 && patched.value?.settings?.[SETTING] === 'collapsed' && patched.value?.stored?.[SETTING] === 'collapsed' && patched.value?.exists === true,
    JSON.stringify({ status: patched.statusCode, settings: patched.value?.settings, stored: patched.value?.stored }));
  let parsedFile = null;
  try { parsedFile = JSON.parse(afterPatch.text ?? 'null'); } catch {}
  check('② 侧车真落盘（`{version, values}` 形状；服务端默认值**不**写进文件）',
    afterPatch.exists === true && parsedFile?.version === UI_SETTINGS_VERSION && parsedFile?.values?.[SETTING] === 'collapsed' && Object.keys(parsedFile.values).length === 1,
    JSON.stringify(parsedFile));
  const reread = await api('/settings');
  check('⑦ GET 与 PATCH 回同一个生效值（服务端权威，不是各存一份）',
    reread.statusCode === 200 && reread.value?.settings?.[SETTING] === 'collapsed' && reread.value?.stored?.[SETTING] === 'collapsed',
    JSON.stringify(reread.value));

  // ④ 有文件之后再来一次坏输入：这次比的是真 sha256。
  const beforeBad2 = await uiSettingsFileState();
  const badAfterWrite = await api('/settings', { method: 'PATCH', body: { [SETTING]: 'collapsed', nope: 1 } });
  const afterBad2 = await uiSettingsFileState();
  print('坏输入（有文件之后）', { reply: { status: badAfterWrite.statusCode, body: badAfterWrite.value }, before: beforeBad2.sha256, after: afterBad2.sha256 });
  check('④ 整批要么全过要么全拒：混了未知 key 的批 ⇒ 400（已存的那一项也不动）',
    badAfterWrite.statusCode === 400 && badAfterWrite.value?.error === 'unknown_setting_key',
    JSON.stringify({ status: badAfterWrite.statusCode, error: badAfterWrite.value?.error }));
  check('④ 400 前后侧车文件**逐字节未变**（sha256 对照）',
    beforeBad2.exists === true && afterBad2.exists === true && beforeBad2.sha256 === afterBad2.sha256,
    JSON.stringify({ before: beforeBad2.sha256, after: afterBad2.sha256 }));

  // ② 落盘跨进程：测试进程里另建一个仓库读同一个文件。
  const foreign = createUiSettingsStore({ file: UI_SETTINGS_FILE, writeJson: async () => { throw new Error('read-only probe'); } });
  const foreignView = await foreign.read();
  print('另一个进程（测试进程）读同一个侧车', foreignView);
  check('② 另一个进程读同一个侧车 ⇒ 读到同一个值（不是宿主/worker 的内存态）',
    foreignView.settings[SETTING] === 'collapsed' && foreignView.stored[SETTING] === 'collapsed' && foreignView.exists === true,
    JSON.stringify({ settings: foreignView.settings, stored: foreignView.stored }));

  // 部署面（任务书 §3）：端点落在**逻辑层**（顶层路径 ⇒ 宿主兜底 proxy 到 current worker）
  // ⇒ `POST /reload-code` 换一代之后，新 worker 读**同一份侧车**，生效值不变（宿主一字未改）。
  const reloaded = await api('/reload-code', { method: 'POST', body: { reason: 'settings-fold-gate' } });
  const afterReloadGeneration = await api('/settings');
  print('POST /reload-code → 新代仍读同一份侧车', { reload: reloaded.value, generation: afterReloadGeneration.value });
  check('部署面 · 逻辑层：POST /reload-code 换一代（logicVersion 变了）后，同一份侧车仍被新股读出生效值',
    reloaded.statusCode === 200 && typeof reloaded.value?.logicVersion === 'string' && reloaded.value.logicVersion !== status.logicVersion
    && afterReloadGeneration.statusCode === 200 && afterReloadGeneration.value?.settings?.[SETTING] === 'collapsed',
    JSON.stringify({ before: status.logicVersion, after: reloaded.value?.logicVersion, settings: afterReloadGeneration.value?.settings }));
}

// ═══════════════════════════ 臂 U / B：浏览器 ═══════════════════════════
async function runBrowserArms() {
  const browsers = [];
  try {
    const pageA = await openBrowser('A（臂 U 主浏览器）');
    browsers.push(pageA);

    // 臂 S 写下的 collapsed 由**前端**读出来 ⇒ 先把「前端读服务端值」这条钉住（跨进程证据）。
    const firstPaint = await openSession(pageA, SESSION_A);
    const firstLocalStorage = await readLocalStorage(pageA);
    print('臂 S 写 collapsed 之后，浏览器第一次开会话 A', { facts: firstPaint, localStorage: firstLocalStorage });
    check('① 服务端 collapsed ⇒ 会话页里 thinking 块**默认就是收起的**（第一次打开、localStorage 还是空的）',
      firstPaint.length === 1 && firstPaint[0].collapsed === 'true' && firstPaint[0].hidden === true && firstPaint[0].aria === 'false' && firstLocalStorage === null,
      JSON.stringify({ facts: firstPaint, localStorage: firstLocalStorage }));

    // ① 两端红绿：每一轮都在**配置页**上改设置（真 PATCH），再回会话页读默认态。两个方向各 3 次。
    const rounds = [];
    for (let round = 1; round <= 3; round += 1) {
      const settingsBefore = await openSettingsPage(pageA);
      const pressedExpanded = await pressSetting(pageA, 'expanded');
      const sessionExpanded = await openSession(pageA, SESSION_A);
      check(`① 第 ${round} 轮 · 设置=展开 ⇒ thinking 默认展开`,
        sessionExpanded.length === 1 && sessionExpanded[0].collapsed === 'false' && sessionExpanded[0].hidden === false,
        JSON.stringify(sessionExpanded));

      const settingsBack = await openSettingsPage(pageA);
      const pressedCollapsed = await pressSetting(pageA, 'collapsed');
      const sessionCollapsed = await openSession(pageA, SESSION_A);
      check(`① 第 ${round} 轮 · 设置=收起 ⇒ thinking 默认收起`,
        sessionCollapsed.length === 1 && sessionCollapsed[0].collapsed === 'true' && sessionCollapsed[0].hidden === true,
        JSON.stringify(sessionCollapsed));
      check(`① 第 ${round} 轮 · 配置页**照服务端说的**画（勾与生效值一致，不是自己推算）`,
        settingsBefore.effective === settingsBefore.checked && pressedExpanded.effective === 'expanded' && pressedExpanded.checked === 'expanded'
        && settingsBack.effective === settingsBack.checked && pressedCollapsed.effective === 'collapsed' && pressedCollapsed.checked === 'collapsed',
        JSON.stringify({ settingsBefore, pressedExpanded, settingsBack, pressedCollapsed }));
      rounds.push({ round, expanded: { pressed: pressedExpanded, facts: sessionExpanded }, collapsed: { pressed: pressedCollapsed, facts: sessionCollapsed } });
    }
    print('① 两端红绿（3 轮原文）', rounds);

    // ── ④b 对称性（2026-09-25）：`seal.autoOnCompaction` 那一行**独立页也得有**，与浮层同口径 ——
    //   只画服务端生效值（不推算）、写回真 PATCH、以回读为准、落盘逐字节可查。
    //   红半：`SOPHO_SETTINGS_WEB=<去掉那一行的 web/ 副本>` ⇒ 这一节必红（原文在报告里）。
    const fileBeforeSeal = await uiSettingsFileState();
    const sealBefore = await openSealCard(pageA);
    const patchesBeforeSeal = settingsPresses.length;
    const sealOff = await pressSeal(pageA, false);
    const patchOff = settingsPresses.slice(patchesBeforeSeal).find((entry) => SEAL_KEY in (entry.body ?? {})) ?? null;
    const fileOff = await uiSettingsFileState();
    print('④b 独立页上的封存那一行（拨到关）', { before: sealBefore, off: sealOff, patch: patchOff, file: { sha256: fileOff.sha256, text: fileOff.text } });
    check('④b 独立页也有「压缩即封存」那一行，且画的是**服务端生效值**（默认 true ⇒ 勾上、可用、状态行说「生效中：开」）',
      sealBefore.exists === true && sealBefore.disabled === false && sealBefore.checked === true && sealBefore.kind === 'ok'
      && /压缩即封存/.test(sealBefore.title ?? '') && /生效中：开/.test(sealBefore.state ?? ''),
      JSON.stringify(sealBefore));
    check('④b 在独立页上关掉它 ⇒ **真发出 `PATCH /settings`**，body 逐字 `{"seal.autoOnCompaction":false}`（真布尔，不是 `"false"` 字符串冒充）',
      patchOff !== null && patchOff.status === 200 && JSON.stringify(patchOff.body) === `{"${SEAL_KEY}":false}`,
      JSON.stringify(patchOff));
    let parsedOff = null;
    try { parsedOff = JSON.parse(fileOff.text ?? 'null'); } catch {}
    let parsedBeforeSeal = null;
    try { parsedBeforeSeal = JSON.parse(fileBeforeSeal.text ?? 'null'); } catch {}
    check('④b 侧车文件按预期变（封存那项真落盘为 false，而另一项**一字未动**）',
      parsedOff?.values?.[SEAL_KEY] === false && parsedOff?.values?.[SETTING] === parsedBeforeSeal?.values?.[SETTING] && parsedOff?.version === UI_SETTINGS_VERSION,
      JSON.stringify({ file: parsedOff, foldBefore: parsedBeforeSeal?.values?.[SETTING], foldAfter: parsedOff?.values?.[SETTING] }));
    check('④b 界面画的是**服务端回的生效值**（勾掉了 ＋ 状态行说「已保存在服务端」，不是拿本地勾选当结果）',
      sealOff.checked === false && sealOff.kind === 'ok' && /生效中：关/.test(sealOff.state ?? '') && /已保存在服务端/.test(sealOff.state ?? ''),
      JSON.stringify(sealOff));
    const sealReopened = await openSealCard(pageA);
    check('④b 重新打开独立页 ⇒ 仍是从服务端读到的 false（服务端权威，不是页面的内存态）',
      sealReopened.checked === false && sealReopened.kind === 'ok' && /已保存在服务端/.test(sealReopened.state ?? ''),
      JSON.stringify(sealReopened));
    const patchesBeforeOn = settingsPresses.length;
    const sealOn = await pressSeal(pageA, true);
    const patchOn = settingsPresses.slice(patchesBeforeOn).find((entry) => SEAL_KEY in (entry.body ?? {})) ?? null;
    const fileOn = await uiSettingsFileState();
    let parsedOn = null;
    try { parsedOn = JSON.parse(fileOn.text ?? 'null'); } catch {}
    print('④b 拨回开（原始）', { on: sealOn, patch: patchOn, file: parsedOn });
    check('④b 开回来 ⇒ PATCH body 逐字 `{"seal.autoOnCompaction":true}`，文件里也变回 true',
      patchOn !== null && JSON.stringify(patchOn.body) === `{"${SEAL_KEY}":true}` && sealOn.checked === true && parsedOn?.values?.[SEAL_KEY] === true,
      JSON.stringify({ patch: patchOn, on: sealOn, values: parsedOn?.values }));

    // ② 落盘：改设置 ⇒ **刷新页面** ⇒ 仍生效（容器里没记过这条键 ⇒ 只能来自服务端）。
    await openSettingsPage(pageA);
    await pressSetting(pageA, 'collapsed');
    const beforeReload = await openSession(pageA, SESSION_A);
    const localStorageBeforeReload = await readLocalStorage(pageA);
    await reload(pageA);
    await pageA.evaluate(WAIT_THINKING_EXPR);
    const afterReload = await pageA.evaluate(FACT_EXPR);
    const fileAfterReload = await uiSettingsFileState();
    print('② 刷新前后', { beforeReload, afterReload, localStorage: localStorageBeforeReload, file: { exists: fileAfterReload.exists, sha256: fileAfterReload.sha256, text: fileAfterReload.text } });
    check('② 改设置 ⇒ 刷新页面 ⇒ 仍生效（收起状态没弹回展开）',
      afterReload.length === 1 && afterReload[0].collapsed === 'true' && afterReload[0].hidden === true,
      JSON.stringify(afterReload));
    check('② 刷新后服务端侧车就是那个值（落盘，不是内存）',
      (() => { try { return JSON.parse(fileAfterReload.text).values[SETTING] === 'collapsed'; } catch { return false; } })(),
      JSON.stringify({ file: UI_SETTINGS_FILE, text: fileAfterReload.text }));

    // ⑤ 优先级：全局默认收起 ＋ 某会话手动展开过 ⇒ 手动赢，且刷新后仍在；没点过的隔壁会话仍听全局默认。
    await openSettingsPage(pageA);
    const globalCollapsed = await pressSetting(pageA, 'collapsed');
    const sessionBeforeManual = await openSession(pageA, SESSION_A);
    const manual = await clickThinking(pageA, 0);
    print('⑤ 手动点一下（全局默认收起）', { globalCollapsed, sessionBeforeManual, manual });
    check('⑤ 全局默认收起时手动点一下 ⇒ 这一条**就地展开**（手动压过全局默认）',
      manual.before[0]?.collapsed === 'true' && manual.after[0]?.collapsed === 'false' && manual.after[0]?.hidden === false,
      JSON.stringify(manual));
    const persistedValues = Object.values(manual.persisted?.scopes ?? {}).flatMap((entries) => Object.values(entries ?? {}));
    check('⑤ 手动那一下被记成**显式展开**（localStorage 里存的是 `false`，而全局默认是收起）',
      manual.persisted?.v === 1 && persistedValues.includes(false),
      JSON.stringify({ persisted: manual.persisted, persistedValues }));
    await reload(pageA);
    await pageA.evaluate(WAIT_THINKING_EXPR);
    const afterManualReload = await pageA.evaluate(FACT_EXPR);
    print('⑤ 刷新后', afterManualReload);
    check('⑤ 刷新后手动的那一条**仍在展开**（既有「乙」的 localStorage 没被弄坏）',
      afterManualReload.length === 1 && afterManualReload[0].collapsed === 'false' && afterManualReload[0].hidden === false,
      JSON.stringify(afterManualReload));
    const neighbor = await openSession(pageA, SESSION_B);
    print('⑤ 隔壁会话（没手动点过）', neighbor);
    check('⑤ 隔壁会话（没点过）仍听**全局默认**（收起）—— 手动只影响它自己那一条',
      neighbor.length === 1 && neighbor[0].collapsed === 'true' && neighbor[0].hidden === true,
      JSON.stringify(neighbor));

    // ③ 「跟人走」：全新 user-data-dir / 空白 profile（第二个 Chromium 进程，另一条 origin ⇒ 空 localStorage）。
    await openSettingsPage(pageA);
    await pressSetting(pageA, 'collapsed');
    const pageB = await openBrowser('B（空白 profile）');
    browsers.push(pageB);
    const freshSeesCollapsed = await openSession(pageB, SESSION_A);
    const freshLocalStorage = await readLocalStorage(pageB);
    print('③ 空白 profile 读到 collapsed', { facts: freshSeesCollapsed, localStorage: freshLocalStorage });
    check('③ 全新浏览器上下文（空 localStorage）读到同一个值 collapsed',
      freshSeesCollapsed.length === 1 && freshSeesCollapsed[0].collapsed === 'true' && freshLocalStorage === null,
      JSON.stringify({ facts: freshSeesCollapsed, localStorage: freshLocalStorage }));

    await openSettingsPage(pageA);
    await pressSetting(pageA, 'expanded');
    const freshReloaded = await openSession(pageB, SESSION_A);
    print('③ 空白 profile 再读一次（服务端已改成 expanded）', freshReloaded);
    check('③ 服务端一改，空白 profile 也跟着变（跟的是服务端，不是它自己的缓存）',
      freshReloaded.length === 1 && freshReloaded[0].collapsed === 'false',
      JSON.stringify(freshReloaded));

    // ── ⑧ 独立页的「读不到」那一档（404 与 500 各一档；接在同一浏览器上下文上） ──
    //    放在末未这条「零未捕获异常」检查**之前**：读不到那一档自己也不该抛（401/500 那两条也在两路见证里）。
    await runStandaloneReadFailureArms(pageB);

    // ── ⑨ 封存那张卡的几何（1200×760 与 420×820） ──
    await runStandaloneSealGeometryArm(pageB);

    print('浏览器这一侧打过的 PATCH 原文', settingsPresses);
    print('页面异常（console.error / 未捕获异常）', { A: pageA.pageProblems, B: pageB.pageProblems });
    check('页面全程没有未捕获异常 / console.error',
      pageA.pageProblems.length === 0 && pageB.pageProblems.length === 0,
      JSON.stringify({ A: pageA.pageProblems, B: pageB.pageProblems }));
  } finally {
    // `ui-harness.boot()` 的沙箱（临时 user-data-dir + 假 API 服务器）由调用方负责收 ——
    // 不收就会在 /tmp 里攒一堆 `sopho-ui-*`（本门每轮起两个浏览器，不收拾最明显）。
    for (const page of browsers) {
      // 传 problems：收尾自己失败也进这条判红通道，不静默。
      await page.close(problems).catch(() => {});
      await removeSandbox(page.sandbox, problems, 'remove settings-fold browser sandbox');
    }
  }
}

let primaryError;
try {
  await runTuiConsistencyArm();
  await runParityArm();
  await runServerArm();
  await runBrowserArms();

  // 臂 R1 / R2（反证臂，**门内自跑**）：副本里各拆一处 ⇒ 预期那几条**具名**新断言全被违反。
  // 它们的红是**预期红**（断言其红）——只有「竟然没红」才判门红；不进 `failed` 计数。
  const armR1 = await runReadFailureMutantArm();
  const whatR1 = armR1.mutant ? armR1.mutant.what : '（副本没建成 —— 见 violated 里那条中断）';
  const expectedR1 = READ_FAILURE_SPECS
    .flatMap((spec) => ['state-honest', 'controls-disabled', 'no-fake-success', 'seal-row-honest'].map((id) => `${spec.code}/${id}`))
    .sort();
  check(`臂 R1（反证臂 · 独立页「读不到」）· 副本里${whatR1} ⇒ 预期那 ${expectedR1.length} 条新断言**全被违反**（如实显示错误／控件禁用／不假成功／封存那行也如实），两条恢复仍绿`,
    JSON.stringify([...armR1.violated].sort()) === JSON.stringify(expectedR1),
    { patched: whatR1, violated: [...armR1.violated].sort(), expected: expectedR1, pageProblems: armR1.pageProblems, cleanupProblems: armR1.cleanupProblems });

  const armR2 = await runSealGeometryMutantArm();
  const whatR2 = armR2.mutant ? armR2.mutant.what : '（副本没建成 —— 见 violated 里那条中断）';
  const expectedR2 = [{ width: 1200, height: 760 }, { width: 420, height: 820 }]
    .flatMap((viewport) => ['order', 'seal-in-content-box', 'seal-visible-after-scroll'].map((id) => `${viewport.width}×${viewport.height}/${id}`))
    .sort();
  check(`臂 R2（反证臂 · 封存卡的几何）· 副本里${whatR2} ⇒ 预期那 ${expectedR2.length} 条新断言**全被违反**（顺序／在内容盒内／滚过去可见），横向溢出那条仍绿`,
    JSON.stringify([...armR2.violated].sort()) === JSON.stringify(expectedR2),
    { patched: whatR2, violated: [...armR2.violated].sort(), expected: expectedR2, pageProblems: armR2.pageProblems, cleanupProblems: armR2.cleanupProblems });

  print('记账（预期红 / 产品红 分开）', { '臂 R1': { expected: expectedR1.length, violated: armR1.violated.length }, '臂 R2': { expected: expectedR2.length, violated: armR2.violated.length } });
} catch (error) {
  primaryError = error;
  process.stdout.write(`\n✗ settings-fold gate threw: ${error?.stack ?? error}\n`);
} finally {
  await base?.stop().catch(() => {});
  await removeSandbox(sandbox, problems, 'remove settings-fold sandbox');
  try {
    finishCleanup(primaryError, problems);
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`\n✗ ${error?.message ?? error}\n`);
  }
}

const ok = failures.length === 0 && primaryError === undefined;
print('RESULT', ok ? `settings fold PASS (${checks} checks)` : `settings fold FAIL (${checks} passed, ${failures.length} failed)`);
print('failed', failures);
if (!ok) process.exitCode = 1;
