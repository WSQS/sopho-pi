#!/usr/bin/env node
// test/settings-panel.mjs —— 「设置」浮层（业主 2026-09-22 逐字要求）的机械门。
//
// 判据出处：业主原话 ① **「配置改成叫设置」** ② **「我希望设置是一个悬浮窗，而不是打开一个新窗口」**；
// 第三条（本门第二版加的）来自交付评审：**「读不到要显示那条错误、失败要可见、不许假成功」**
// —— 线上现在正是这条路（活宿主不认顶层 `GET/PATCH /settings` ⇒ 404）。形状与门见 `docs/design-settings.md` §10。
//
// 四臂（臂 D 是第二版补的：**反证臂的记账**）：
//
//   臂 A（真 Chromium ＋ 假 API；那半边的 `/api/settings` 是**真仓库模块 `server/ui-settings.mjs` ＋ 真文件**）：
//     ① 点「设置」⇒ **不导航**（`location.href` 一字不变、没有新的 load 事件）：浮层就地出现；
//     ② 形状：遮罩盖满视口、面板**居中**（560px／圆角）、`role="dialog"` ＋ `aria-modal="true"` ＋ 右上 ×、
//        入口 `aria-expanded="true"`（激活态）；内容都在（2026-09-25 起是**四项**：思考折叠两个 radio、
//        维护者会话输入框/保存按钮、对话内「推荐回复」总开关、「压缩即封存」总开关；文字是「设置」不是「配置」）；
//     ③ 键盘可达：开时焦点在框内；`Tab` 在框内循环（末位 → 首位）；
//     ④ 改一项（真鼠标点「默认收起」）⇒ **真发出 `PATCH /settings`**（body 逐字）且侧车文件**逐字节**变成预期；
//        页面画的是**服务端回的**生效值；
//     ⑤ `Esc` 关、点**遮罩**关：两种都关掉、`location` 仍未变、焦点还给入口；
//     ⑥ 窄宽 420px：浮层自己的东西不溢出不遮挡（四边在视口内／页面无横向溢出／面板无横向滚动／控件都在
//        面板的**可滚动内容盒**内）。⚠（2026-09-25）：面板加第4张卡片后 1200×760 起就超过 `max-height`
//        ⇒ 面板自己纵向滚动；旧判据把「可见框内」当「不溢出」会在最后一张卡片上变红 —— 那是**新事实**，
//        所以纵向改为量可滚动内容盒（横向判据与「无横向溢出」一条未改）。
//     ⑦ `prefers-reduced-motion: reduce`（CDP 真开）⇒ 不动画；默认偏好下**是**有动画的（证明量的是那条媒体查询）；
//     ⑧ `GET /settings` 500 ⇒ 状态行**如实显示那条错误**、控件禁用、**重试按钮出现**；
//        服务端恢复后点**重试** ⇒ 真重读、错误消失、画上服务端生效值；
//     ⑨ 一份真源：浮层改完（collapsed）后，独立页 `/settings.html` 读到**同一个值**；
//     ⑩ **全程零未捕获异常**：两路见证（harness 的 `exceptionThrown`/`console.error` ＋ 装在每个新文档上的
//        带行号收集器），且按阶段记账（哪一页出的问题一眼看得见）。
//
//   臂 C（**线上现状**：设置端点整个不存在 —— 顶层 `GET /settings` ⇒ 404 非 JSON 体 `not found`）：
//     页面照常起来（树/SSE 都在）、零未捕获异常、浮层里**可见那条错误**（带 `服务端 404`）、控件禁用、
//     重试按钮在；把服务端换成正常后再点重试 ⇒ 就地读到生效值。
//
//   臂 B（**反证臂**，门内自跑）：副本里把入口换回「跳新页」（`<a href="/settings.html">`）⇒
//     六条**预期被违反**的事**必须全被违反**（否则判红并报「反证臂没红」）。⚠️ 预期红**不进** `failed`：
//     它们按「断言其红」记账（第二版修的就是这条 —— 别再把它和产品红混在一个计数里）。
//
//   臂 D（**反证臂 · 封存那一行**，2026-09-25 加，同样是「断言其红」）：副本里各拆一处 ——
//     `drop-row` 删掉整张卡片（四条绿全被违反）／`drop-write` 撤掉写回（后三条被违反、第一条仍绿）。
//     这两条就是「那一行真在、并且真写回」的反证：没有它们，绿臂可能是假绿。
//
// 截图（真 Chromium）：`$TEMP/sopho-settings-panel-{closed,open,420x820,500,404}.png`。
//
// 沙箱：高位随机端口 ＋ 临时浏览器 profile ＋ 临时 ASSIST_HOME；不碰真 profile、不用 7331/7321、不 pkill。
//
// 用法：CHROME_BIN=/usr/bin/chromium node test/settings-panel.mjs

import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { finishCleanup, removeSandbox } from './harness.mjs';
import { boot, readBody, sendJson, waitFor as uiWaitFor } from './ui-harness.mjs';
import { createUiSettingsStore, UI_SETTINGS_VERSION } from '../server/ui-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');

const FOLD_KEY = 'thinking.defaultFold';
const SEAL_KEY = 'seal.autoOnCompaction';
const SESSION_A = '1a1a1a1a-1111-4111-8111-111111111111';
const SESSION_B = '2b2b2b2b-2222-4222-8222-222222222222';

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-settings-panel-'));

/** 侧车文件的**逐字节**预期（形状与 `server/base-logic.mjs` 的 `atomicWriteJson` 一致）。 */
const expectedFileBytes = (values) => `${JSON.stringify({ version: UI_SETTINGS_VERSION, values }, null, 2)}\n`;

const screenshots = {
  closed: path.join(os.tmpdir(), 'sopho-settings-panel-closed-1200x760.png'),
  open: path.join(os.tmpdir(), 'sopho-settings-panel-open-1200x760.png'),
  narrow: path.join(os.tmpdir(), 'sopho-settings-panel-420x820.png'),
  serverError: path.join(os.tmpdir(), 'sopho-settings-panel-500-1200x760.png'),
  missing: path.join(os.tmpdir(), 'sopho-settings-panel-404-1200x760.png'),
};

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
  { id: SESSION_A, name: '浮层门 A', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-22T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: SESSION_B, name: '浮层门 B', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-22T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];

/**
 * 每个臂一份自己的假 API（侧车文件也随之分开）。`settingsMode` 是设置端点当下的形态：
 *   · `'ok'`           —— 正常（真 store 真文件）；
 *   · `'missing-404'`  —— **线上现状**：顶层路径在宿主那层回 404，体是**非 JSON** 的 `not found`；
 *   · `'broken-500'`   —— 侧车坏了：500 ＋ JSON 错误体（真模块的 `ui_settings_invalid` 形状）。
 */
function makeSettingsApi(homeDir) {
  const file = path.join(homeDir, 'ui-settings.json');
  const store = createUiSettingsStore({
    file,
    writeJson: async (target, value) => {
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(temporary, target);
    },
  });
  const state = { file, store, settingsMode: 'ok', writes: [], reads: 0 };
  state.routes = async (request, response, url) => {
    const pathname = url.pathname;
    if (pathname === '/api/host') { sendJson(response, 200, { ok: true }); return true; }
    if (pathname === '/api/devices') { sendJson(response, 200, { exists: true, devices: [] }); return true; }
    if (pathname === '/api/settings') {
      if (state.settingsMode === 'missing-404') {
        // 活宿主的形状：顶层路径不认 ⇒ 404 ＋ 纯文本（**不是** JSON ⇒ 前端必须照旧把它说成人话）。
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('not found\n');
        return true;
      }
      if (state.settingsMode === 'broken-500') {
        sendJson(response, 500, { error: 'ui_settings_invalid', message: 'ui-settings.json is invalid: 门里故意摆的坏文件' });
        return true;
      }
      if (request.method === 'GET') {
        state.reads += 1;
        sendJson(response, 200, await store.read());
        return true;
      }
      const body = await readBody(request);
      state.writes.push({ at: new Date().toISOString(), method: request.method, body });
      let parsed;
      try { parsed = JSON.parse(body); } catch { sendJson(response, 400, { error: 'invalid_settings_body', message: 'body must be JSON' }); return true; }
      try {
        // **真**校验/真落盘：走仓库自己的 store（未知 key / 非法值 ⇒ 诚实 400，文件不写）。
        sendJson(response, 200, await store.patch(parsed));
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, typeof error?.toJSON === 'function' ? error.toJSON() : { message: String(error?.message ?? error) });
      }
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
      if (action === null) { sendJson(response, 200, { name: row.name, cwd: homeDir, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }); return true; }
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
  };
  return state;
}

// ───────────────────────── 浏览器小工具（CDP，派真事件） ─────────────────────────
async function mouseClick(page, selector, { waitLoadMs = 700 } = {}) {
  const point = await uiWaitFor(() => page.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const r = node.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`), `${selector} did not become clickable`);
  const loaded = page.browser.once('Page.loadEventFired');
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 });
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  const fired = await Promise.race([loaded.then(() => true), sleep(waitLoadMs).then(() => false)]);
  return { point, loadEventFired: fired };
}

async function mouseClickPoint(page, x, y, { waitLoadMs = 500 } = {}) {
  const loaded = page.browser.once('Page.loadEventFired');
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  const fired = await Promise.race([loaded.then(() => true), sleep(waitLoadMs).then(() => false)]);
  return { x, y, loadEventFired: fired };
}

/** 真键盘：`rawKeyDown` 让浏览器跑默认动作（`Tab` 移焦点 / `Esc` 关浮层都靠它）。 */
async function keyPress(page, { key, code, windowsVirtualKeyCode, modifiers = 0 }) {
  await page.browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers });
  await page.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers });
  await sleep(60);
}
const pressEscape = (page) => keyPress(page, { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
const pressTab = (page, shift = false) => keyPress(page, { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });

/**
 * 未捕获异常/未处理拒绝的**带行号收集器**（装在每个新文档上）。
 * 为什么需要它：`ui-harness` 的 `pageProblems` 只记 `exception.description`（没行号、没 URL），
 * 而「读不到设置时到底哪一行抛了」恰恰要靠这个定位（第一版就是靠它把 `app.js:9` 揪出来的）。
 */
const PROBLEM_COLLECTOR_SOURCE = `
  window.__sophoProblems = [];
  addEventListener('error', (event) => {
    window.__sophoProblems.push({ kind: 'error', message: String(event.message), href: location.href, file: event.filename || null, line: event.lineno ?? null, col: event.colno ?? null, stack: (event.error && event.error.stack) || null });
  });
  addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.__sophoProblems.push({ kind: 'unhandledrejection', message: String((reason && reason.message) || reason), href: location.href, file: null, line: null, col: null, stack: (reason && reason.stack) || null });
  });
`;
const readProblems = (page) => page.evaluate('window.__sophoProblems ?? null');

/**
 * 导航并等**应用真的就绪**（不是只等 load）：
 * · `load` 事件**不等**顶层 await（第二版实测：`/slot.css` 延迟 400ms 时 load 只花 65ms）
 *   ⇒ 早导航会把页面自己的启动 fetch 取消掉、并在别的门里偶发红（那条已按诊断修在 `web/app.js`）；
 * · 所以这里等 `style[data-slot-language="v2.2"]`（app.js 顶层跑完的标志）＋（在会话页上）树流已连。
 */
async function navigateApp(page, pathname) {
  const loaded = page.browser.once('Page.loadEventFired');
  await page.browser.send('Page.navigate', { url: `http://127.0.0.1:${page.port}${pathname}` });
  await Promise.race([loaded, sleep(15_000)]);
  if (pathname.startsWith('/settings.html')) {
    await uiWaitFor(() => page.evaluate(`document.querySelector('#settings-fold') !== null`), 'standalone settings page did not load');
    return;
  }
  await uiWaitFor(() => page.evaluate(`document.querySelector('style[data-slot-language="v2.2"]') !== null`), 'app.js did not finish booting');
  await uiWaitFor(() => page.evaluate(`document.querySelector('#tree-connection')?.textContent?.includes('已连接') ?? false`), 'tree SSE did not connect');
}

const EMPTY_RECT = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
const state = async (page) => {
  const now = await page.evaluate(STATE_EXPR);
  return { ...now, panelRect: now.panelRect ?? EMPTY_RECT, overlayRect: now.overlayRect ?? EMPTY_RECT, triggerRect: now.triggerRect ?? EMPTY_RECT };
};

const STATE_EXPR = `(() => {
  const overlay = document.querySelector('#settings-overlay');
  const panel = document.querySelector('#settings-panel');
  const trigger = document.querySelector('#tree-settings');
  const rect = (node) => { const r = node.getBoundingClientRect(); return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }; };
  const visible = (node) => !!node && !node.hidden && node.getClientRects().length > 0;
  const radios = [...document.querySelectorAll('input[name="settings-panel-thinking-default-fold"]')];
  const style = (node) => node ? getComputedStyle(node) : null;
  return {
    href: location.href,
    pathname: location.pathname,
    appBooted: !!document.querySelector('style[data-slot-language="v2.2"]'),
    slotStyleUnavailable: document.querySelector('style[data-slot-language="v2.2"]')?.dataset.unavailable ?? null,
    overlayHidden: overlay ? overlay.hidden : null,
    overlayVisible: visible(overlay),
    overlayState: overlay?.dataset.state ?? null,
    panelVisible: visible(panel),
    triggerExpanded: trigger?.getAttribute('aria-expanded') ?? null,
    triggerTag: trigger?.tagName ?? null,
    triggerText: trigger?.textContent ?? null,
    triggerRect: trigger ? rect(trigger) : null,
    triggerColor: style(trigger)?.color ?? null,
    activeElementInsidePanel: !!panel && !!document.activeElement && (panel === document.activeElement || panel.contains(document.activeElement)),
    activeElementId: document.activeElement?.id ?? null,
    role: panel?.getAttribute('role') ?? null,
    ariaModal: panel?.getAttribute('aria-modal') ?? null,
    hasClose: !!document.querySelector('#settings-panel-close'),
    retryHidden: document.querySelector('#settings-panel-retry')?.hidden ?? null,
    radioCount: radios.length,
    radioValues: radios.map((node) => ({ value: node.value, checked: node.checked, disabled: node.disabled })),
    notifyInput: (() => { const node = document.querySelector('#settings-panel-notify-input'); return node ? { value: node.value, disabled: node.disabled, placeholder: node.placeholder } : null; })(),
    notifySave: (() => { const node = document.querySelector('#settings-panel-notify-save'); return node ? { disabled: node.disabled, text: node.textContent } : null; })(),
    suggestionsToggle: (() => { const node = document.querySelector('#settings-panel-suggestions-enabled'); return node ? { checked: node.checked, disabled: node.disabled } : null; })(),
    suggestionsState: (() => { const node = document.querySelector('#settings-panel-suggestions-state'); return node ? { text: node.textContent, kind: node.dataset.kind ?? null } : null; })(),
    sealToggle: (() => { const node = document.querySelector('#settings-panel-seal-auto'); return node ? { checked: node.checked, disabled: node.disabled } : null; })(),
    sealState: (() => { const node = document.querySelector('#settings-panel-seal-state'); return node ? { text: node.textContent, kind: node.dataset.kind ?? null } : null; })(),
    foldState: (() => { const node = document.querySelector('#settings-panel-fold-state'); return node ? { text: node.textContent, kind: node.dataset.kind ?? null } : null; })(),
    notifyState: (() => { const node = document.querySelector('#settings-panel-notify-state'); return node ? { text: node.textContent, kind: node.dataset.kind ?? null } : null; })(),
    overlayRect: overlay ? rect(overlay) : null,
    panelRect: panel ? rect(panel) : null,
    panelScroll: panel ? { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight } : null,
    panelControls: (() => {
      if (!panel) return [];
      // ⚠（2026-09-25，封存那行加进来后）：面板现在是**四张卡片**，1200×760 下已经超过
      // max-height:100% ⇒ 面板自己**纵向滚动**（overflow:auto）。旧判据把「控件在面板
      // **可见**框内」当成「不溢出」，最后一张卡片的控件会合理地落在滚动区外 ⇒ 那是新事实，不是溢出。
      // 所以这里量的是**可滚动内容盒**：横向仍在面板边框内（横向溢出照样判红），纵向在
      // [scrollTop, scrollTop + scrollHeight] 这段内容里（控件没有被裁掉、只是可以滚到）。
      const outer = panel.getBoundingClientRect();
      const contentTop = outer.top - panel.scrollTop;
      return [...panel.querySelectorAll('button, input')].filter((node) => node.getClientRects().length > 0).map((node) => {
        const r = node.getBoundingClientRect();
        return { id: node.id || node.name || node.tagName, inside: r.left >= outer.left - 1 && r.right <= outer.right + 1 && r.top >= contentTop - 1 && r.bottom <= contentTop + panel.scrollHeight + 1 };
      });
    })(),
    overlayBg: style(overlay)?.backgroundColor ?? null,
    panelRadius: style(panel)?.borderTopLeftRadius ?? null,
    panelSlot: panel ? { width: style(panel).borderInlineStartWidth, color: style(panel).borderInlineStartColor } : null,
    scroll: { docWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, overlayScrollWidth: overlay?.scrollWidth ?? null, overlayClientWidth: overlay?.clientWidth ?? null },
    animation: { overlay: style(overlay)?.animationName ?? null, panel: style(overlay) ? style(panel)?.animationName ?? null : null },
  };
})()`;

const waitPanel = (page, message = 'panel did not appear') => uiWaitFor(() => state(page).then((now) => (now.panelVisible ? now : null)), message);
const waitPainted = (page, message = 'panel did not paint server values') => uiWaitFor(() => state(page).then((now) => (now.radioValues.length === 2 && now.radioValues.every((item) => item.disabled === false) ? now : null)), message);

/** 把面板里的一个控件滚进**面板自己**的视口再点。
    ⚠（2026-09-25）：面板现在是四张卡片，1200×760 下就超过 `max-height: 100%` ⇒ 面板自己纵向滚动，
    最后那一张卡片与底部的「重试读取」都落在滚动区外 —— 真用户也会先滚到它再点（与 `openPanel` 滚入口同一套理由）。 */
async function revealInPanel(page, selector) {
  await page.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node) node.scrollIntoView({ block: 'center' }); })()`);
  await sleep(80);
}

/** 把入口滚进视口再点（窄宽 420px 时左栏自己带滚动轴，底栏可能在视口外）——真用户也会这么做。 */
async function openPanel(page) {
  const visible = await page.evaluate(`(() => { const node = document.querySelector('#settings-overlay'); return !!node && node.hidden === false; })()`);
  if (!visible) {
    await page.evaluate(`(() => { const node = document.querySelector('#tree-settings'); if (node) node.scrollIntoView({ block: 'nearest' }); })()`);
    await page.frames(2).catch(() => {});
  }
  return mouseClick(page, '#tree-settings');
}

// ═══════════════════════════ 臂 A / C：真浏览器 ═══════════════════════════
async function runRealArm({ label, settingsMode = 'ok', full = true }) {
  const api = makeSettingsApi(await mkdtemp(path.join(sandbox, `home-${label}-`)));
  api.settingsMode = settingsMode;
  let page = null;
  const armFailures = [];
  const armChecks = [];
  const record = (name, ok, detail) => {
    armChecks.push({ name, ok });
    if (!ok) armFailures.push({ name, detail });
    print(`臂 ${label} · ${ok ? '✓' : '✗'} ${name}`, detail);
    return ok;
  };
  const problemsFound = [];
  const drain = async (phase) => {
    const now = await readProblems(page).catch(() => null);
    if (Array.isArray(now)) for (const item of now) problemsFound.push({ phase, ...item });
  };
  let harnessProblems = [];
  try {
    page = await boot({ routes: api.routes, width: 1200, height: 760, webRoot });
    await page.browser.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBLEM_COLLECTOR_SOURCE });
    print(`臂 ${label} · 沙箱`, { port: page.port, settingsMode, chromium: page.version?.Browser ?? null, uiSettingsFile: api.file });
    await navigateApp(page, '/?g=1');
    await drain('初载（/?g=1）');
    if (label === 'A') await page.screenshot(screenshots.closed);
    await runPanelSteps({ page, api, record, label, full, drain, problemsFound });
  } catch (error) {
    // 不中断：把“本臂后面整段做不下去”也变成一条红条目。
    record('（本臂后续步骤中断）', false, String(error?.stack ?? error));
  } finally {
    if (page) harnessProblems = page.pageProblems.slice();
    if (page) {
      // 传 problems：收尾自己失败也进这条判红通道，不静默。
      await page.close(problems).catch(() => {});
      await removeSandbox(page.sandbox, problems, `remove settings-panel ${label} sandbox`);
    }
  }
  return { checks: armChecks, failures: armFailures, ok: armFailures.length === 0, problems: problemsFound, harnessProblems };
}

async function runPanelSteps({ page, api, record, label, full, drain, problemsFound }) {
  // ── ① 点入口 ⇒ 不导航 + 就地开 ──────────────────────────────────────────────
  const before = await state(page);
  const hrefBefore = before.href;
  const targetsBefore = await pageTargets(page);
  const click = await mouseClick(page, '#tree-settings');
  const targetsAfter = await pageTargets(page);
  const opened = await waitPanel(page);
  print(`臂 ${label} · 点入口的原始证据`, { hrefBefore, click, targetsBefore, targetsAfter, after: { href: opened.href, pathname: opened.pathname, overlayVisible: opened.overlayVisible, panelVisible: opened.panelVisible, triggerExpanded: opened.triggerExpanded, activeElementId: opened.activeElementId } });
  record('① 点「设置」⇒ **没有导航**（没来新的 load 事件、`location.href` 一个字符都没变、page target id 集合一个不多一个不少）—— 业主要的正是这条',
    click.loadEventFired === false && opened.href === hrefBefore && opened.pathname === '/'
    && targetsBefore.length === targetsAfter.length
    && JSON.stringify(targetsBefore.map((t) => t.id)) === JSON.stringify(targetsAfter.map((t) => t.id)),
    { loadEventFired: click.loadEventFired, hrefBefore, hrefAfter: opened.href, pathname: opened.pathname, targetsBefore, targetsAfter });
  record('① 浮层**就地出现**（遮罩 + 面板都可见、入口呈激活态 `aria-expanded="true"`）',
    before.overlayVisible === false && opened.overlayVisible === true && opened.panelVisible === true && opened.triggerExpanded === 'true',
    { overlayVisibleBefore: before.overlayVisible, overlayVisible: opened.overlayVisible, panelVisible: opened.panelVisible, triggerExpanded: opened.triggerExpanded, triggerTag: opened.triggerTag, triggerText: opened.triggerText });

  // ── ② 形状 ────────────────────────────────────────────────────────────────
  const viewportCenter = { x: 1200 / 2, y: 760 / 2 };
  const panelCenter = { x: (opened.panelRect.left + opened.panelRect.right) / 2, y: (opened.panelRect.top + opened.panelRect.bottom) / 2 };
  record('② 形状：遮罩盖住整个视口、面板**居中**（约 560px 宽、圆角）、`role="dialog"` ＋ `aria-modal="true"` ＋ 右上角 ×',
    opened.overlayRect.left <= 0.5 && opened.overlayRect.top <= 0.5 && opened.overlayRect.right >= 1199.5 && opened.overlayRect.bottom >= 759.5
    && Math.abs(panelCenter.x - viewportCenter.x) <= 2 && Math.abs(panelCenter.y - viewportCenter.y) <= 2
    && Math.abs(opened.panelRect.width - 560) <= 2
    && parseFloat(opened.panelRadius) >= 4
    && opened.role === 'dialog' && opened.ariaModal === 'true' && opened.hasClose === true,
    { overlayRect: opened.overlayRect, panelRect: opened.panelRect, panelCenter, viewportCenter, radius: opened.panelRadius, role: opened.role, ariaModal: opened.ariaModal, hasClose: opened.hasClose });
  record('② 内容是**那四项**（思考折叠的两个 radio ＋ 维护者会话输入框/保存按钮 ＋ 「推荐回复」总开关 ＋ 「压缩即封存」总开关），文字是「设置」不是「配置」',
    opened.radioCount === 2 && opened.radioValues.map((item) => item.value).join(',') === 'expanded,collapsed'
    && opened.notifyInput !== null && opened.notifySave !== null
    && opened.suggestionsToggle !== null && opened.suggestionsToggle.disabled === false
    && opened.sealToggle !== null && opened.sealToggle.disabled === false
    && opened.triggerText.trim() === '设置'
    && opened.overlayBg.startsWith('rgba('),
    { radioValues: opened.radioValues, notifyInput: opened.notifyInput, notifySave: opened.notifySave, suggestionsToggle: opened.suggestionsToggle, sealToggle: opened.sealToggle, triggerText: opened.triggerText, overlayBg: opened.overlayBg, panelSlot: opened.panelSlot });

  // ── ③ 键盘可达 ────────────────────────────────────────────────────────────
  const painted = await waitPainted(page);
  record('③ 开时焦点在框内（面板自身 `tabindex="-1"` 接焦点，`Tab` 自然进到第一个控件）',
    painted.activeElementInsidePanel === true,
    { activeElementId: painted.activeElementId, activeElementInsidePanel: painted.activeElementInsidePanel });
  await pressTab(page);
  const tabbed = await state(page);
  // 「末位」不写死是哪个控件（面板会长出新项，2026-09-23 就多了一个「推荐回复」开关）：
  // 按**与组件同一个可聚焦判据**（排除 `[hidden]`／禁用）现算最后一个，把它 focus 上再按 `Tab`
  // ⇒ 必须回到首位（关闭按钮）。判据一个字没放宽，只是不再依赖「谁是最后一个」这个事实。
  const lastFocusable = await page.evaluate(`(() => {
    const panel = document.querySelector('#settings-panel');
    const items = [...panel.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((node) => node.getClientRects().length > 0);
    const last = items[items.length - 1] ?? null;
    if (last) last.focus();
    return { id: last?.id ?? null, count: items.length };
  })()`);
  await pressTab(page);
  const wrapped = await state(page);
  record('③ `Tab` 在框内循环（焦点陷阱）：在**末位**控件上按 `Tab` ⇒ 回**首位**（关闭按钮），焦点没漏到背后页面',
    wrapped.activeElementInsidePanel === true && wrapped.activeElementId === 'settings-panel-close'
    && lastFocusable.id !== null && lastFocusable.id !== 'settings-panel-close',
    { afterFirstTab: tabbed.activeElementId, lastFocusable, afterWrapTab: wrapped.activeElementId, insidePanel: wrapped.activeElementInsidePanel });

  if (!full) {
    // 臂 C 只要上面这些（+ 下面那两条“读不到”的断言由调用点自己收尾）就够了。
    record('（臂 C 到此为止：结构/键盘那几条已在上面量过）', true, 'ok');
    return;
  }

  // ── ④ 改一项 ⇒ 真 PATCH + 侧车文件逐字节 ────────────────────────────────────
  const writesBefore = api.writes.length;
  const patchClick = await mouseClick(page, 'input[name="settings-panel-thinking-default-fold"][value="collapsed"]', { waitLoadMs: 500 });
  const patched = await uiWaitFor(() => state(page).then((now) => (now.foldState.kind === 'ok' && now.radioValues.some((item) => item.value === 'collapsed' && item.checked) ? now : null)), 'radio PATCH did not land').catch(() => state(page));
  const fileText = await readFile(api.file, 'utf8').catch(() => null);
  const expectedBytes = expectedFileBytes({ [FOLD_KEY]: 'collapsed' });
  print(`臂 ${label} · PATCH 的原始证据`, { patchClick, writes: api.writes.slice(writesBefore), file: api.file, fileText, expectedBytes, foldState: patched.foldState, radioValues: patched.radioValues });
  record('④ 改一项 ⇒ **真发出 `PATCH /settings`**，body 逐字 `{"thinking.defaultFold":"collapsed"}`',
    api.writes.length === writesBefore + 1 && api.writes[writesBefore].method === 'PATCH'
    && api.writes[writesBefore].body === JSON.stringify({ [FOLD_KEY]: 'collapsed' }),
    { writes: api.writes.slice(writesBefore) });
  record('④ 侧车文件**逐字节**变成预期（服务端默认值不写进文件；形状 `{version, values}`）',
    fileText === expectedBytes,
    { file: api.file, actual: fileText, expected: expectedBytes });
  record('④ 界面画的是**服务端回的生效值**（`collapsed` 被选中 ＋ 状态行说「已保存在服务端」，不是本地推算的）',
    patched.radioValues.some((item) => item.value === 'collapsed' && item.checked) && patched.foldState.kind === 'ok' && /已保存在服务端/.test(patched.foldState.text),
    { foldState: patched.foldState, radioValues: patched.radioValues });
  if (label === 'A') await page.screenshot(screenshots.open);

  // ── ④b 「压缩即封存」那一行：生效值 / 真 PATCH / 服务端回读 ───────────────────────
  // ⚠️ 面板现在**四张卡片**，1200×760 下这一行落在滚动区外 ⇒ 先把它滚进视口再真鼠标点
  // （真用户也会这么做；这不是“放宽断言”—— 行仍在面板内容里、只是要滚到）。
  const sealBefore = (await state(page)).sealToggle;
  record('④b 封存那一行在，且画的是**服务端生效值**（默认 true ⇒ 勾上、可用；不靠本地推算）',
    sealBefore !== null && sealBefore.disabled === false && sealBefore.checked === true,
    { sealToggle: sealBefore, sealState: painted.sealState });
  await revealInPanel(page, '#settings-panel-seal-auto');
  const sealWritesBefore = api.writes.length;
  const sealClick = await mouseClick(page, '#settings-panel-seal-auto', { waitLoadMs: 500 });
  const sealAfter = await uiWaitFor(() => state(page).then((now) => (now.sealState?.kind === 'ok' && now.sealToggle?.checked === false ? now : null)), 'seal PATCH did not land').catch(() => state(page));
  const sealFileText = await readFile(api.file, 'utf8').catch(() => null);
  const sealExpected = expectedFileBytes({ [FOLD_KEY]: 'collapsed', [SEAL_KEY]: false });
  print(`臂 ${label} · 封存那一行的 PATCH 原始证据`, { sealClick, writes: api.writes.slice(sealWritesBefore), file: api.file, fileText: sealFileText, expected: sealExpected, sealState: sealAfter.sealState, sealToggle: sealAfter.sealToggle });
  record('④b 改它 ⇒ **真发出 `PATCH /settings`**，body 逐字 `{"seal.autoOnCompaction":false}`（真布尔，不是 `"false"` 字符串冒充）',
    api.writes.length === sealWritesBefore + 1 && api.writes[sealWritesBefore].method === 'PATCH'
    && api.writes[sealWritesBefore].body === JSON.stringify({ [SEAL_KEY]: false }),
    { writes: api.writes.slice(sealWritesBefore) });
  record('④b 侧车文件**逐字节**变成预期（封存那项真的落盘，与另一项共存）',
    sealFileText === sealExpected,
    { file: api.file, actual: sealFileText, expected: sealExpected });
  record('④b 界面画的是**服务端回的生效值**（勾掉 ＋ 状态行说「已保存在服务端」，不是本地推算）',
    sealAfter.sealToggle?.checked === false && sealAfter.sealState?.kind === 'ok' && /已保存在服务端/.test(sealAfter.sealState?.text ?? ''),
    { sealState: sealAfter.sealState, sealToggle: sealAfter.sealToggle });

  // ── ⑤ Esc 关 / 点遮罩关 ───────────────────────────────────────────────────
  await pressEscape(page);
  const afterEsc = await state(page);
  record('⑤ `Esc` 关：浮层收起、入口回到 `aria-expanded="false"`、**焦点还给入口**、`location` 仍未变',
    afterEsc.overlayHidden === true && afterEsc.overlayVisible === false && afterEsc.panelVisible === false && afterEsc.triggerExpanded === 'false'
    && afterEsc.activeElementId === 'tree-settings' && afterEsc.href === hrefBefore,
    { overlayHidden: afterEsc.overlayHidden, overlayVisible: afterEsc.overlayVisible, panelVisible: afterEsc.panelVisible, triggerExpanded: afterEsc.triggerExpanded, activeElementId: afterEsc.activeElementId, href: afterEsc.href, hrefBefore });

  await openPanel(page);
  const reopened = await waitPanel(page, 'panel did not reopen');
  const maskClick = await mouseClickPoint(page, 8, 8, { waitLoadMs: 500 });
  const afterMask = await state(page);
  print(`臂 ${label} · 点遮罩的原始证据`, { maskPoint: { x: 8, y: 8 }, maskClick, panelRect: reopened.panelRect, afterMask: { overlayHidden: afterMask.overlayHidden, href: afterMask.href } });
  record('⑤ 点**遮罩**（面板外那一点）关：浮层收起、没有导航（点在框里/从框里拖出去松手都不该关 —— 这条量的是「只在遮罩本身」）',
    afterMask.overlayHidden === true && maskClick.loadEventFired === false && afterMask.href === hrefBefore,
    { overlayHidden: afterMask.overlayHidden, loadEventFired: maskClick.loadEventFired, href: afterMask.href });

  // ── ⑥ 窄宽 420px ─────────────────────────────────────────────────────────
  await page.resize(420, 820);
  await openPanel(page);
  const narrow = await waitPanel(page, 'panel did not appear at 420px');
  print(`臂 ${label} · 窄宽 420×820 的几何`, { panelRect: narrow.panelRect, overlayRect: narrow.overlayRect, scroll: narrow.scroll, panelScroll: narrow.panelScroll, panelControls: narrow.panelControls });
  record('⑥ 窄宽 420px 下**浮层自己的东西**不溢出不遮挡：四边都在视口内、页面无横向溢出、面板自己无横向滚动、每个控件都在面板框内',
    narrow.panelRect.left >= 0 && narrow.panelRect.right <= 420 && narrow.panelRect.top >= 0 && narrow.panelRect.bottom <= 820
    && narrow.scroll.docWidth <= narrow.scroll.innerWidth
    && narrow.scroll.overlayScrollWidth <= narrow.scroll.overlayClientWidth
    && narrow.panelScroll.scrollWidth <= narrow.panelScroll.clientWidth
    && narrow.panelControls.length >= 4 && narrow.panelControls.every((item) => item.inside),
    { panelRect: narrow.panelRect, scroll: narrow.scroll, panelScroll: narrow.panelScroll, panelControls: narrow.panelControls });
  if (label === 'A') await page.screenshot(screenshots.narrow);
  await page.resize(1200, 760);

  // ── ⑦ prefers-reduced-motion ─────────────────────────────────────────────
  const animatedDefault = (await state(page)).animation;
  await page.browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = (await state(page)).animation;
  await page.browser.send('Emulation.setEmulatedMedia', { features: [] });
  print(`臂 ${label} · prefers-reduced-motion 下的 computed animation-name`, { animatedDefault, reduced });
  record('⑦ `prefers-reduced-motion: reduce` ⇒ 不动画（遮罩与面板的 `animation-name` 都是 `none`），默认偏好下**是**有动画的（证明量的是那条媒体查询）',
    reduced.overlay === 'none' && reduced.panel === 'none' && animatedDefault.overlay !== 'none' && animatedDefault.panel !== 'none',
    { animatedDefault, reduced });

  // ── ⑨ 一份真源：独立页读到同一个值 ─────────────────────────────────────────
  await pressEscape(page);
  await drain('⑨ 导航去 /settings.html 之前（会话页整段互动）');
  await navigateApp(page, '/settings.html?g=2');
  // ⚠️ “元素在”不等于“画上了”：`data-effective` 是 `GET /settings` 回来之后才写的 ⇒ 必须等它。
  const standalone = await uiWaitFor(() => page.evaluate(`(() => { const fold = document.querySelector('#settings-fold'); return fold?.dataset.effective ? { effective: fold.dataset.effective, checked: document.querySelector('input[name="thinking-default-fold"]:checked')?.value ?? null, pathname: location.pathname } : null; })()`), 'standalone settings page did not paint an effective value').catch(() => null);
  print(`臂 ${label} · 独立页 /settings.html 读到什么`, { standalone, settingsReads: api.reads, writes: api.writes });
  record('⑨ 一份真源：浮层里改完（collapsed）后，独立页 `/settings.html` 读到**同一个值**（同一份服务端设置，不许各存一份）',
    standalone !== null && standalone.effective === 'collapsed' && standalone.checked === 'collapsed' && standalone.pathname === '/settings.html',
    standalone);

  // ── ⑧ 读不到 ⇒ 如实说 + 可见重试 ───────────────────────────────────────────
  await drain('⑨ 独立页 /settings.html 那一段');
  await navigateApp(page, '/?g=3');
  api.settingsMode = 'broken-500';
  await openPanel(page);
  const failed = await uiWaitFor(() => state(page).then((now) => (now.foldState?.kind === 'error' ? now : null)), 'panel did not show the read error').catch(() => state(page));
  print('臂 A · 读不到设置（500）的原始证据', { foldState: failed.foldState, notifyState: failed.notifyState, radioValues: failed.radioValues, notifyInput: failed.notifyInput, retryHidden: failed.retryHidden });
  record('⑧ 读不到（`GET /settings` ⇒ 500）⇒ 状态行**如实显示那条错误**、控件禁用、**重试按钮出现** —— **不假成功**、不默认成 expanded',
    failed.foldState?.kind === 'error' && /读不到设置/.test(failed.foldState?.text ?? '') && /500|坏文件/.test(failed.foldState?.text ?? '')
    && failed.radioValues.every((item) => item.disabled === true && item.checked === false)
    && failed.notifyInput?.disabled === true && failed.retryHidden === false,
    { foldState: failed.foldState, radioValues: failed.radioValues, notifyInput: failed.notifyInput, retryHidden: failed.retryHidden });
  await page.screenshot(screenshots.serverError);
  record('⑧ 封存那一行也**如实显示同一条错误**并禁用（不是只把「思考折叠」那一行说了）',
    failed.sealState?.kind === 'error' && /读不到设置/.test(failed.sealState?.text ?? '') && failed.sealToggle?.disabled === true && failed.sealToggle?.checked === false,
    { sealState: failed.sealState, sealToggle: failed.sealToggle });
  // 服务端恢复 ⇒ 点**重试**（不关浮层、不刷新页面）⇒ 就地读到生效值
  const hrefBeforeRetry = (await state(page)).href;
  api.settingsMode = 'ok';
  await revealInPanel(page, '#settings-panel-retry');
  const retryClick = await mouseClick(page, '#settings-panel-retry', { waitLoadMs: 500 });
  const retried = await waitPainted(page, 'retry did not re-read the settings');
  print('臂 A · 点重试的原始证据', { retryClick, hrefBeforeRetry, retried: { checked: retried.radioValues.find((item) => item.checked)?.value ?? null, foldState: retried.foldState, retryHidden: retried.retryHidden, href: retried.href } });
  record('⑧ **重试保留**：服务端恢复后点「重试读取」⇒ 真重读、错误消失、画上服务端生效值（面板没被关掉、`location` 没变）',
    retried.radioValues.some((item) => item.value === 'collapsed' && item.checked) && retried.foldState.kind === 'ok' && retried.retryHidden === true && retried.href === hrefBeforeRetry,
    { radioValues: retried.radioValues, foldState: retried.foldState, retryHidden: retried.retryHidden, href: retried.href, hrefBeforeRetry });
  record('⑧ 重试后封存那一行也画上服务端生效值（关 ＋ 已保存在服务端，因为前面真 PATCH 过关）',
    retried.sealState?.kind === 'ok' && retried.sealToggle?.disabled === false && retried.sealToggle?.checked === false && /已保存在服务端/.test(retried.sealState?.text ?? ''),
    { sealState: retried.sealState, sealToggle: retried.sealToggle });
  await pressEscape(page);

  // ── ⑩ 全程零未捕获异常（两路见证） ──────────────────────────────────────────
  await drain('末（读不到 + 重试那一臂全程）');
  const harnessProblems = page.pageProblems.slice();
  print('臂 A · 未捕获异常的带行号原始收集', { harness: harnessProblems, collected: problemsFound });
  record('⑩ 全程**零未捕获异常/未处理拒绝**（两路见证：harness 的 exceptionThrown/console.error ＋ 页内带行号收集器）',
    harnessProblems.length === 0 && problemsFound.length === 0,
    { harness: harnessProblems, collected: problemsFound });
}

// ═══════════════════════════ 臂 C：设置端点整个不存在（线上现状） ═══════════════════════════
async function runMissingSettingsArm() {
  const api = makeSettingsApi(await mkdtemp(path.join(sandbox, 'home-C-')));
  api.settingsMode = 'missing-404';
  let page = null;
  const armFailures = [];
  const armChecks = [];
  const record = (name, ok, detail) => {
    armChecks.push({ name, ok });
    if (!ok) armFailures.push({ name, detail });
    print(`臂 C · ${ok ? '✓' : '✗'} ${name}`, detail);
    return ok;
  };
  const found = [];
  try {
    page = await boot({ routes: api.routes, width: 1200, height: 760, webRoot });
    await page.browser.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBLEM_COLLECTOR_SOURCE });
    print('臂 C · 沙箱（设置端点整个不存在）', { port: page.port, uiSettingsFile: api.file });
    // 初载时 `GET /settings` 就是 404 ⇒ 会话页必须照常起来（app.js 的启动读不能把页面拖垮）
    await navigateApp(page, '/?g=1');
    const alive = await state(page);
    const treeRows = await page.evaluate(`document.querySelectorAll('.tree-session').length`);
    record('ⓐ 端点不存在（404 非 JSON 体）时**会话页照常可用**（app.js 顶层跑完、树行已画、树流已连、浮层仍是关着的）—— 启动那次 `GET /settings` 的 404 不把页面拖垮',
      alive.appBooted === true && alive.panelVisible === false && treeRows >= 2,
      { appBooted: alive.appBooted, panelVisible: alive.panelVisible, treeRows });
    const click = await mouseClick(page, '#tree-settings');
    const opened = await waitPanel(page);
    const failed = await uiWaitFor(() => state(page).then((now) => (now.foldState?.kind === 'error' ? now : null)), 'panel did not show the 404 error').catch(() => state(page));
    print('臂 C · 读不到设置（404 非 JSON）的原始证据', { click, foldState: failed.foldState, notifyState: failed.notifyState, radioValues: failed.radioValues, notifyInput: failed.notifyInput, retryHidden: failed.retryHidden });
    record('ⓑ 浮层里**可见那条错误**（服务端 404 ＋ 把非 JSON 体当人话说出来）、控件禁用、重试按钮在 —— 一个字都不许吞',
      opened.panelVisible === true
      && failed.foldState?.kind === 'error' && /读不到设置/.test(failed.foldState?.text ?? '') && failed.foldState.text.includes('404') && failed.foldState.text.includes('not found')
      && failed.radioValues.every((item) => item.disabled === true && item.checked === false)
      && failed.notifyInput?.disabled === true && failed.retryHidden === false,
      { foldState: failed.foldState, notifyState: failed.notifyState, radioValues: failed.radioValues, notifyInput: failed.notifyInput, retryHidden: failed.retryHidden });
    await page.screenshot(screenshots.missing);
    // 服务端升级好（或换代之后），点重试 ⇒ 就地读到生效值
    api.settingsMode = 'ok';
    await revealInPanel(page, '#settings-panel-retry');
    const retryClick = await mouseClick(page, '#settings-panel-retry', { waitLoadMs: 500 });
    const retried = await waitPainted(page, 'retry did not re-read the settings');
    print('臂 C · 点重试的原始证据', { retryClick, retried: { checked: retried.radioValues.find((item) => item.checked)?.value ?? null, foldState: retried.foldState, retryHidden: retried.retryHidden } });
    record('ⓒ 服务端好了之后点「重试读取」⇒ 就地读到生效值（不用关浮层、不用刷新）',
      retried.foldState.kind === 'ok' && retried.retryHidden === true && retried.radioValues.some((item) => item.value === 'expanded' && item.checked),
      { radioValues: retried.radioValues, foldState: retried.foldState, retryHidden: retried.retryHidden });
    const pageProblems = page.pageProblems.slice();
    const collected = await readProblems(page).catch(() => null);
    print('臂 C · 未捕获异常的带行号原始收集', { harness: pageProblems, collected });
    record('ⓓ 全程**零未捕获异常/未处理拒绝**（404 这条路**本身**就不该抛 —— 评审点名的就是这条）',
      pageProblems.length === 0 && Array.isArray(collected) && collected.length === 0,
      { harness: pageProblems, collected });
    await pressEscape(page);
  } catch (error) {
    record('（臂 C 后续步骤中断）', false, String(error?.stack ?? error));
  } finally {
    if (page) {
      // 传 problems：收尾自己失败也进这条判红通道，不静默。
      await page.close(problems).catch(() => {});
      await removeSandbox(page.sandbox, problems, 'remove settings-panel C sandbox');
    }
  }
  return { ok: armFailures.length === 0, failures: armFailures, checks: armChecks };
}

// ═══════════════════════════ 臂 B：反证臂（必须**断言它红**） ═══════════════════════════
/** 把 `web/` 拷一份，并把入口换回「跳新页」——红绿对照用的**同一把尺子**。 */
async function makeNavigationMutant() {
  const mutantRoot = path.join(sandbox, 'mutant-web');
  await cp(webRoot, mutantRoot, { recursive: true });
  const file = path.join(mutantRoot, 'index.html');
  const html = await readFile(file, 'utf8');
  const before = /<button id="tree-settings"[^>]*>设置<\/button>/.exec(html)?.[0] ?? null;
  const after = '<a id="tree-settings" class="tree-settings" href="/settings.html" title="网页设置（思考折叠的默认）">设置</a>';
  if (!before) throw new Error(`mutant: 没找到入口那一段（${file}）`);
  await writeFile(file, html.replace(before, after));
  return { root: mutantRoot, patched: { before, after } };
}

/**
 * 反证臂：单独跑一遍「点入口」并逐条**断言那六件事被违反**。
 * ⚠️ 它**不进** `failed`：它的红是**预期红**；只有「竟然没红」才判门红。
 */
async function runMutantArm(mutant) {
  const api = makeSettingsApi(await mkdtemp(path.join(sandbox, 'home-B-')));
  let page = null;
  const violations = [];
  try {
    page = await boot({ routes: api.routes, width: 1200, height: 760, webRoot: mutant.root });
    await page.browser.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBLEM_COLLECTOR_SOURCE });
    await navigateApp(page, '/?g=1');
    const hrefBefore = (await state(page)).href;
    const click = await mouseClick(page, '#tree-settings', { waitLoadMs: 3000 });
    const after = await state(page);
    const panelVisible = after.panelVisible;
    const shapeBad = !(after.overlayRect.left <= 0.5 && after.overlayRect.right >= 1199.5 && Math.abs(after.panelRect.width - 560) <= 2 && after.role === 'dialog' && after.ariaModal === 'true' && after.hasClose === true);
    const contentBad = !(after.radioCount === 2 && after.notifyInput !== null && after.notifySave !== null && after.triggerText?.trim() === '设置');
    const focusBad = after.activeElementInsidePanel !== true;
    let trapBad = true;
    try { await pressTab(page); trapBad = (await state(page)).activeElementId !== 'settings-panel-close'; } catch { trapBad = true; }
    const expectedViolations = [
      { name: '①「点它**不导航**」', violated: click.loadEventFired === true || after.href !== hrefBefore, evidence: { loadEventFired: click.loadEventFired, hrefBefore, hrefAfter: after.href, pathname: after.pathname } },
      { name: '①「浮层**就地出现**（遮罩/面板可见 ＋ 入口 aria-expanded=true）」', violated: !(panelVisible === true && after.overlayVisible === true && after.triggerExpanded === 'true'), evidence: { panelVisible, overlayVisible: after.overlayVisible, triggerExpanded: after.triggerExpanded } },
      { name: '②「形状：遮罩铺满视口／面板居中 560px／role=dialog／aria-modal／×」', violated: shapeBad, evidence: { overlayRect: after.overlayRect, panelRect: after.panelRect, role: after.role, ariaModal: after.ariaModal, hasClose: after.hasClose } },
      { name: '②「两项内容都在」', violated: contentBad, evidence: { radioCount: after.radioCount, notifyInput: after.notifyInput, notifySave: after.notifySave, triggerText: after.triggerText } },
      { name: '③「开时焦点在框内」', violated: focusBad, evidence: { activeElementId: after.activeElementId, inside: after.activeElementInsidePanel } },
      { name: '③「`Tab` 在框内循环（末位 → 首位）」', violated: trapBad, evidence: { activeElementIdAfterTab: (await state(page)).activeElementId } },
    ];
    for (const item of expectedViolations) if (item.violated) violations.push(item);
    print('臂 B（反证臂）· 六条预期被违反的原始证据', expectedViolations.map((item) => ({ name: item.name, violated: item.violated, evidence: item.evidence })));
  } catch (error) {
    print('臂 B（反证臂）· 后续步骤中断', String(error?.stack ?? error));
  } finally {
    if (page) {
      // 传 problems：收尾自己失败也进这条判红通道，不静默。
      await page.close(problems).catch(() => {});
      await removeSandbox(page.sandbox, problems, 'remove settings-panel B sandbox');
    }
  }
  return { violations, expected: 6 };
}

// ═══════════════════════════ 臂 D：反证臂（封存那一行） ═══════════════════════════
/**
 * 反证臂（2026-09-25 加，与臂 B 同一套「**断言它红**」的记账）：
 * 在 `web/` 的**副本**里拆掉「封存那一行」这件活的一件 —— 两条臂各拆一处：
 *   · `drop-row`   —— 从 `index.html` 删掉整张「压缩即封存」卡片 ⇒ 四条绿全被违反；
 *   · `drop-write` —— 从 `settings-panel.mjs` 撤掉 `sealToggle` 的 change 写回 ⇒ 后三条被违反（第一条仍绿）。
 * ⚠️ 它的红是**预期红**，不进 `failed`；只有「竟然没红」才判门红。
 */
async function runSealMutantArm(mode) {
  const mutantRoot = path.join(sandbox, `mutant-seal-${mode}`);
  await cp(webRoot, mutantRoot, { recursive: true });
  const patched = {};
  if (mode === 'drop-row') {
    const file = path.join(mutantRoot, 'index.html');
    const html = await readFile(file, 'utf8');
    const before = /\n      <section class="settings-panel-card" aria-labelledby="settings-panel-seal-title">[\s\S]*?<\/section>/.exec(html)?.[0] ?? null;
    if (!before) throw new Error('反证臂（封存/drop-row）：副本里没找到「压缩即封存」那张卡片');
    await writeFile(file, html.replace(before, ''));
    patched.file = file; patched.what = '删掉整张「压缩即封存」卡片';
  } else {
    const file = path.join(mutantRoot, 'settings-panel.mjs');
    const source = await readFile(file, 'utf8');
    const before = "  sealToggle?.addEventListener('change', (event) => { void saveSeal(event.target.checked === true); });";
    if (!source.includes(before)) throw new Error('反证臂（封存/drop-write）：副本里没找到写回那一行');
    await writeFile(file, source.replace(before, '  // 反证臂：写回被撤掉（勾了不改服务端）'));
    patched.file = file; patched.what = '撤掉 sealToggle 的 change 写回';
  }

  const api = makeSettingsApi(await mkdtemp(path.join(sandbox, `home-seal-${mode}-`)));
  let page = null;
  const violations = [];
  try {
    page = await boot({ routes: api.routes, width: 1200, height: 760, webRoot: mutantRoot });
    await page.browser.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBLEM_COLLECTOR_SOURCE });
    await navigateApp(page, '/?g=1');
    await mouseClick(page, '#tree-settings');
    await waitPanel(page);
    await waitPainted(page);

    const before = await state(page);
    const rowPainted = before.sealToggle !== null && before.sealToggle.disabled === false && before.sealToggle.checked === true;
    if (!rowPainted) violations.push({ name: '绿①「封存那一行在且画的是服务端生效值（默认 true ⇒ 勾上、可用）」', evidence: { sealToggle: before.sealToggle, sealState: before.sealState } });

    const writesBefore = api.writes.length;
    if (before.sealToggle !== null) {
      await revealInPanel(page, '#settings-panel-seal-auto');
      await mouseClick(page, '#settings-panel-seal-auto', { waitLoadMs: 500 });
      await uiWaitFor(() => state(page).then((now) => (now.sealState?.kind === 'ok' && now.sealToggle?.checked === false ? now : null)), 'seal checkbox did not settle').catch(() => null);
    }
    const wrote = api.writes.slice(writesBefore);
    const after = await state(page);
    const fileText = await readFile(api.file, 'utf8').catch(() => null);
    const expected = expectedFileBytes({ [SEAL_KEY]: false });
    const bodyOk = wrote.length === 1 && wrote[0].method === 'PATCH' && wrote[0].body === JSON.stringify({ [SEAL_KEY]: false });
    const paintedOk = after.sealToggle?.checked === false && after.sealState?.kind === 'ok' && /已保存在服务端/.test(after.sealState?.text ?? '');
    if (!bodyOk) violations.push({ name: '绿②「改它 ⇒ 真发出 PATCH /settings，body 逐字 {\"seal.autoOnCompaction\":false}」', evidence: { writes: wrote } });
    if (fileText !== expected) violations.push({ name: '绿③「侧车文件逐字节变成预期」', evidence: { actual: fileText, expected } });
    if (!paintedOk) violations.push({ name: '绿④「界面画的是服务端回的生效值（勾掉 ＋ 已保存在服务端）」', evidence: { sealToggle: after.sealToggle, sealState: after.sealState } });
    print(`反证臂（封存/${mode}）· 被违反的绿条目`, violations.map((item) => item.name));
  } catch (error) {
    violations.push({ name: `反证臂（封存/${mode}）中断`, evidence: String(error?.stack ?? error) });
  } finally {
    if (page) {
      await page.close(problems).catch(() => {});
      await removeSandbox(page.sandbox, problems, `remove settings-panel seal-${mode} sandbox`);
    }
  }
  return { mode, patched, violations };
}

async function pageTargets(page) {
  const list = await (await fetch(`http://127.0.0.1:${page.debugPort}/json/list`)).json();
  return list.filter((target) => target.type === 'page').map((target) => ({ id: target.id, url: target.url }));
}

// ═══════════════════════════ 跑 ═══════════════════════════
let primaryError;
const accounting = {};
try {
  const armA = await runRealArm({ label: 'A' });
  for (const item of armA.checks) if (item.ok) checks += 1; else failures.push(`臂 A · ${item.name}`);
  accounting.armA = { green: armA.checks.filter((item) => item.ok).length, red: armA.failures.length };

  const armC = await runMissingSettingsArm();
  for (const item of armC.checks) if (item.ok) checks += 1; else failures.push(`臂 C · ${item.name}`);
  accounting.armC = { green: armC.checks.filter((item) => item.ok).length, red: armC.failures.length };

  const mutant = await makeNavigationMutant();
  print('臂 B（反证臂）· 换了哪一处', mutant.patched);
  const armB = await runMutantArm(mutant);
  accounting.armB = { violated: armB.violations.length, expected: armB.expected, countsTowardGate: '预期红（断言其红）——不进 failed' };
  check('臂 B（反证臂）· 入口换成「跳新页」（副本）⇒ **六条预期全被违反**（含①「不导航」那条）—— 这就是这条门的牙',
    armB.violations.length === armB.expected,
    { violated: armB.violations.map((item) => item.name), expected: armB.expected });

  // 臂 D：封存那一行的反证臂（两条：撤掉那一行 / 撤掉写回）—— 同样按「断言它红」记账
  const sealRed = {};
  for (const mode of ['drop-row', 'drop-write']) {
    const result = await runSealMutantArm(mode);
    const expectedCount = mode === 'drop-row' ? 4 : 3;
    sealRed[mode] = { patched: result.patched, violated: result.violations.map((item) => item.name), expected: expectedCount };
    check(`臂 D（反证臂 · ${mode}）· 副本里「${result.patched.what}」⇒ **预期那 ${expectedCount} 条绿全被违反**（含「真要有一个 PATCH」那条）`,
      result.violations.length === expectedCount && (mode !== 'drop-write' || !result.violations.some((item) => item.name.startsWith('绿①'))),
      sealRed[mode]);
  }
  accounting.armD = sealRed;
} catch (error) {
  primaryError = error;
  process.stdout.write(`\n✗ settings-panel gate threw: ${error?.stack ?? error}\n`);
} finally {
  await removeSandbox(sandbox, problems, 'remove settings-panel sandbox');
  try {
    finishCleanup(primaryError, problems);
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`\n✗ ${error?.message ?? error}\n`);
  }
}

print('截图', screenshots);
print('记账（预期红 / 产品红 分开）', accounting);
const ok = failures.length === 0 && primaryError === undefined;
print('RESULT', ok ? `settings panel PASS (${checks} checks)` : `settings panel FAIL (${checks} passed, ${failures.length} failed)`);
print('failed', failures);
if (!ok) process.exitCode = 1;
