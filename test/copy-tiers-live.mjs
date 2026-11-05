#!/usr/bin/env node
// test/copy-tiers-live.mjs —— **主产品页**（`web/index.html` ＋ `web/render.js` 工具卡的「复制」按钮）的
// **三级降级**门，外加「两处用的是同一份共用实现」这条结构性判据。真 Chromium ＋ 真剪贴板 ＋ 真鼠标。
//
// 为什么要有它（这一单的根因，逐字）：
//   · 设计器页（`web/designer.js`）早就把复制做成**三级降级**（① `navigator.clipboard` → ② `execCommand`
//     兼容路径 → ③ 只读、已全选的手动框），因为业主 2026-09-25 实测报回来过
//     「复制失败：can't access property "writeText", navigator.clipboard is undefined（可以用「导出 JSON」下载）」；
//   · 而**主产品页**工具卡上的「复制」只有两级（①→②），两级都失败就只剩一句「复制失败」—— **没有第三条出路**。
//     同一条根因（`navigator.clipboard` 只在**安全上下文**存在：HTTPS 或 localhost / 127.0.0.1；
//     从**局域网 IP ＋ 明文 HTTP** 打开时那一格是 `undefined`），两处实现、一处漏了。
//   修法：三级降级抽进共用实现 `web/copy-text.js`（经典脚本，挂 `window.sophoCopyText`），两个页面都调它。
//   ⚠️ 这一单碰到的**产品文件**：新增 `web/copy-text.js`；`web/render.js` 的 `copyVerbatim()` 换成调它；
//      `web/index.html` 加了一行 `<script src="/copy-text.js"></script>` ＋ 最小一组手动框 DOM/样式；
//      `web/designer.js` 的三级降级换成调它、`web/designer.html` 加同一行 `<script>`。
//
// 这道门量的是**能红的事实**：
//   ① 正常上下文（`http://127.0.0.1` ＝安全上下文）真鼠标点「复制」⇒ 走 **① clipboard**（按钮的
//      `data-copy-path=clipboard`），而且**真剪贴板**里就是那段命令全文（用注入脚本捕获到的**原生描述符**
//      读回，不是我们自己的桩；Windows 会把 `\n` 存成 `\r\n` ⇒ 只归一化这一件事）—— 按钮上**不出现**
//      「复制失败」，手动框没弹；
//   ② 模拟「局域网 IP ＋ 明文 HTTP」（在**页面脚本之前**注入：`Navigator.prototype.clipboard` 的 getter
//      返回 `undefined` ＋ `window.isSecureContext=false`）⇒ 点「复制」**不出现「复制失败」**（业主报的
//      就是这一格），退到 **② `execCommand`**，**真剪贴板**里是这一臂的命令全文（先放的哨兵被覆盖）；
//   ③ ② 也被拒（测试侧把 `document.execCommand` 打死）⇒ 弹 **③ 只读、已全选的手动框**：内容**逐字节等于**
//      源文本、按钮**不谎称**「已复制」（写的是「请手动复制」）、文案说清为什么（不在安全上下文 /
//      `navigator.clipboard` 不在场 / `execCommand` 返回 false）与怎么办（Ctrl+C ／ 展开态自己选中复制）；
//      **Esc** 与「关掉」都能收起、且把框里的副本清掉；
//   ③b ① **在 1.5 s 上界内没有回应**（测试侧把 `writeText` 换成永不 settle 的 promise —— 前人实测过
//      「没授权、没有用户激活时它既不 resolve 也不 reject」）⇒ 不许无限等：上界到了就往下走，
//      落到 ② 或 ③ 都行，但**不许**是「点了没反应」，也**不许**是「复制失败」；
//   ④ 静态：两处都**真的接到**共用实现上（`render.js` / `designer.js` 都调 `sophoCopyText.copyText`，
//      两个 HTML 都引 `/copy-text.js`），三级都在**那一份**文件里（不是各写一遍）。
//
// 反证臂（各自必红；改的都是临时目录里的**副本**，真 `web/**` 一个字节不动）：
//   `--reverse-arm=two-tier`     —— 把**主产品**这一侧退回「只有 ①②两级」的旧实现（`copyVerbatim()` 里
//                                   不调共用实现，两级都失败就 `path:'manual'` 且**没有框**）⇒ 这一单要修的
//                                   那件事原样回来：`main:manual-*` 必红（「只改设计器、不给主产品补第③级」）。
//   `--reverse-arm=no-fallback`  —— 把**共用实现**里 ②③ 两段（`execCommand` ＋ 手动框）换成 `throw`
//                                   （回到业主报的「只调 clipboard、失败就报复制失败」）⇒
//                                   `main:nonsecure-*` / `main:manual-*` 必红。
//
// 用法（本机 Windows 的 CHROME_BIN 见下）：
//   CHROME_BIN='C:/Users/user/AppData/Local/Chromium/Application/chrome.exe' node test/copy-tiers-live.mjs
//   CHROME_BIN=... node test/copy-tiers-live.mjs --reverse-arm=two-tier
//   CHROME_BIN=... node test/copy-tiers-live.mjs --reverse-arm=no-fallback
//
// 沙箱纪律：高位随机端口 ＋ 临时浏览器 profile ＋ 临时 `web/` 副本；不碰真 profile、不用 7331/7321、
// **绝不 pkill**（只按本次 spawn 的 pid 收尾）；日志落自己的沙箱。

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { finishCleanup, removeSandbox } from './harness.mjs';
import { boot, readBody, sendJson, waitFor, WEB_ROOT } from './ui-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').slice('--reverse-arm='.length) || null;
const ARTIFACT_DIR = process.env.SOPHO_COPYTIERS_SHOT_DIR
  ? path.resolve(process.env.SOPHO_COPYTIERS_SHOT_DIR)
  : path.join(process.env.TEMP || process.env.TMPDIR || os.tmpdir(), ARM ? `sopho-copy-tiers-arm-${ARM}` : 'sopho-copy-tiers');

/** 真产品文件：只**记录**（跑前跑后各取一次 sha256）—— 本门对真仓没有写路径（写都在沙箱副本里），
 * 而真仓是共享工作区；真正的硬判据是「服务根在本门沙箱里」（见下面 `sandbox:served-root-is-sandboxed`）。 */
const REAL_PRODUCT_FILES = [
  'web/index.html', 'web/render.js', 'web/designer.js', 'web/designer.html', 'web/app.js', 'web/copy-text.js',
  'server/base.mjs', 'server/base-logic.mjs',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

// ── 夹具：一条会话 ＋ 一张**带全文的** bash 工具卡（摘要 != 全文 ⇒ `.tool-copy` 才在）─────────────
const LONG_FIRST_LINE = `set -euo pipefail; export PROJECT_ROOT="/srv/${'p'.repeat(200)}"; cd "$PROJECT_ROOT"`;
const LONG_COMMAND = [
  LONG_FIRST_LINE,
  'for f in */; do',
  '  echo "== $f"',
  '  rg -n --hidden --glob "!node_modules" -e "PREFIX_ONLY" "$f" | tee out.txt',
  'done',
].join('\n');
const SESSION = '5c0p7c0p-0000-4000-8000-c0p7c0p7c0p7';
const CALL = 'call-copy-1';
const sessions = [{
  id: SESSION, name: '复制这条路', parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
  unread: false, modifiedAt: '2026-09-25T08:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}];
const historyMessages = [
  { entryId: 'u-1', parentId: null, timestamp: '2026-09-25T08:00:01.000Z', kind: 'message', role: 'user', content: [{ type: 'text', text: '跑一下' }], text: '跑一下', images: [], stopReason: null, errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [] },
  {
    entryId: 'a-1', parentId: 'u-1', timestamp: '2026-09-25T08:00:02.000Z', kind: 'message', role: 'assistant',
    content: [], text: '', images: [], stopReason: 'toolUse', errorMessage: null, toolCallId: null, toolName: null, isError: false, aborted: false, extras: [],
    parts: [
      { type: 'tool', toolCallId: CALL, name: 'bash', args: { command: LONG_COMMAND }, status: 'done-success', isError: false, result: 'COPY-TIERS-RESULT' },
    ],
  },
];

// ── 断言簿（一次把红列全，最后统一判）──────────────────────────────────────────────────────────
let checks = 0;
const failures = [];
const problems = [];
const screenshots = [];
function check(id, name, ok, detail) {
  checks += 1;
  process.stdout.write(`${ok ? '✓' : '✗'} [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  if (!ok) failures.push({ id, name, detail });
  return ok;
}

// ── 反证臂：改**副本** ─────────────────────────────────────────────────────────────────────────
// `two-tier`：把**主产品**这一侧换成**修前那份实现**（逐字：`git show HEAD:web/render.js` 里的
// `copyVerbatim()` 后半段）—— 只有 ①②两级，两级都失败就 `flash('复制失败')`、**没有第三条出路**。
// 行数组 ＋ 双引号拼接：那段代码里同时有反引号、`${}` 与单引号，写成模板字面量得一层层转义。
const TWO_TIER_FROM = [
  "  const outcome = await copy.copyText(text, {",
  "    label: '命令全文',",
  "    hint: '在工具卡的展开态里自己选中命令复制',",
  "  }).catch((error) => {",
  "    // 兜底的兜底：共用实现自己逐级都把错误收在里面了，真不该走到这里 —— 走到了也**如实**说，",
  "    // 不装成功，也不让它变成一条未捕获的 rejection。",
  "    console.error(`复制命令时共用实现抛了：${error?.message ?? String(error)}`);",
  "    return null;",
  "  });",
  "  if (!outcome) { flash('复制失败'); return false; }",
  "  button.dataset.copyPath = outcome.path;",
  "  button.title = `复制命令：走的是 ${outcome.path} 路径（${outcome.bytes} 字节）`;",
  "  console.log(`[render] 复制命令：走 ${outcome.path} 路径（${outcome.bytes} 字节）`);",
  "  if (outcome.path === 'manual') { flash('请手动复制'); return false; }",
  "  flash('已复制');",
  "  return outcome.ok;",
  "}",
].join('\n');
const TWO_TIER_TO = [
  '  try {',
  "    if (navigator.clipboard?.writeText) {",
  '      await navigator.clipboard.writeText(text);',
  "      flash('已复制');",
  '      return true;',
  '    }',
  '  } catch { /* 落到下面那条老路 */ }',
  '  try {',
  "    const scratch = document.createElement('textarea');",
  '    scratch.value = text;',
  "    scratch.setAttribute('readonly', 'true');",
  "    scratch.style.cssText = 'position:absolute;left:-10000px;top:0;';",
  '    document.body.append(scratch);',
  '    scratch.select();',
  "    const ok = document.execCommand?.('copy') === true;",
  '    scratch.remove();',
  "    if (ok) { flash('已复制'); return true; }",
  '  } catch { /* 见下面的失败分支 */ }',
  "  flash('复制失败');",
  '  return false;',
  '}',
].join('\n');

const NO_FALLBACK_FROM = `    if (copyViaExecCommand(text)) return { path: 'execCommand', ok: true, text, bytes, reasons };`;
const NO_FALLBACK_TO = `    throw new Error('反证臂：兼容路径与手动框都被拿掉了（直接调 clipboard）');`;

const ARM_MUTANTS = {
  // ── 这一单要修的那件事原样回来：主产品只有两级、两级都失败就没有出路 ─────────────────────────
  'two-tier': {
    what: '把**主产品**这一侧退回「只有 ①② 两级」的旧实现（`copyVerbatim()` 不调共用实现；两级都失败就'
      + ' `path:\'manual\'` 而**没有那个框**）',
    file: 'render.js',
    from: TWO_TIER_FROM,
    to: TWO_TIER_TO,
    expect: ['main:manual-panel', 'main:manual-bytes', 'main:manual-why', 'main:manual-esc', 'main:manual-reopen', 'main:manual-close'],
  },
  // ── 共用实现的 ②③ 拿掉（业主报的那条错）──────────────────────────────────────────────────
  'no-fallback': {
    what: '把**共用实现**里 ②③ 两段（`execCommand` 兼容路径 ＋ 手动框）换成 `throw` ⇒ 回到「只调 clipboard、'
      + '失败就报复制失败」',
    file: 'copy-text.js',
    from: NO_FALLBACK_FROM,
    to: NO_FALLBACK_TO,
    expect: ['main:nonsecure-no-failure', 'main:nonsecure-path', 'main:nonsecure-bytes', 'main:manual-panel', 'main:manual-bytes', 'main:manual-why', 'main:manual-esc'],
  },
};

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-copy-tiers-'));
const webRoot = path.join(sandbox, 'web');
await cp(WEB_ROOT, webRoot, { recursive: true });
await mkdir(ARTIFACT_DIR, { recursive: true });

if (ARM) {
  const arm = ARM_MUTANTS[ARM];
  if (!arm) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
  const target = path.join(webRoot, arm.file);
  const text = await readFile(target, 'utf8');
  if (!text.includes(arm.from)) throw new Error(`反证臂 ${ARM} 的改写没命中（接缝形状变了？）：${arm.what}`);
  await writeFile(target, text.replace(arm.from, arm.to), 'utf8');
  process.stdout.write(`反证臂 ${ARM} —— ${arm.what}（跑在副本上：web/${arm.file}）\n`);
}

const hashesBefore = new Map();
for (const file of REAL_PRODUCT_FILES) hashesBefore.set(file, await sha256(path.join(root, file)).catch(() => '(读不到)'));

// ── 假 API（只喂这一页要的那些端点）──────────────────────────────────────────────────────────
const routes = async (request, response, url) => {
  const pathname = url.pathname;
  if (pathname === '/api/host') { sendJson(response, 200, { ok: true }); return true; }
  if (pathname === '/api/devices') { sendJson(response, 200, { exists: true, devices: [] }); return true; }
  if (pathname === '/api/settings') { sendJson(response, 200, { settings: {}, warnings: [] }); return true; }
  if (pathname === '/api/annotations') { sendJson(response, 200, { annotations: [] }); return true; }
  if (pathname === '/api/tree') { sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } }); return true; }
  if (pathname === '/api/tree/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
    response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
    return true;
  }
  const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|models|seen|draft|events|questions))?$/.exec(pathname);
  if (match) {
    if (match[1] !== SESSION) { sendJson(response, 404, { message: 'not found' }); return true; }
    const action = match[2] ?? null;
    if (action === null) {
      if (request.method === 'PATCH') { sendJson(response, 200, { name: sessions[0].name }); return true; }
      sendJson(response, 200, { name: sessions[0].name, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null });
      return true;
    }
    if (action === 'messages') { sendJson(response, 200, { messages: historyMessages, extras: [], compaction: { atIndex: null }, observability: null }); return true; }
    if (action === 'commands') { sendJson(response, 200, { streaming: false, commands: [] }); return true; }
    if (action === 'models') { sendJson(response, 200, { models: [], current: null }); return true; }
    if (action === 'seen') { sendJson(response, 200, { ok: true }); return true; }
    if (action === 'draft') { sendJson(response, 200, { text: '' }); return true; }
    if (action === 'questions') { sendJson(response, 200, { questions: [], counts: { open: 0, answered: 0, closed: 0, total: 0 } }); return true; }
    if (action === 'events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false, pendingMessages: 0 })}\n\n`);
      return true;
    }
  }
  if (pathname === '/api/test/noop' && request.method === 'POST') { await readBody(request); sendJson(response, 200, { ok: true }); return true; }
  return false;
};

// ── 浏览器 ────────────────────────────────────────────────────────────────────────────────────
let ui = null;
const localProblems = [];
async function evalIn(expression) { return ui.evaluate(expression); }
async function frames(count = 3) { await ui.frames(count); await sleep(60); }
async function box(selector) {
  return evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, width: r.width, height: r.height };
  })()`);
}
async function mouse(type, x, y, extra = {}) {
  await ui.browser.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
}
/** **真鼠标**点一下（`execCommand` 那条路依赖**用户激活**，页面里 `.click()` 拿不到）。 */
async function clickSelector(selector) {
  const target = await box(selector);
  if (!target) throw new Error(`点不到：${selector}（元素不在）`);
  await mouse('mousePressed', target.cx, target.cy, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', target.cx, target.cy, { button: 'left', buttons: 0, clickCount: 1 });
  await frames(2);
}
async function pressEscape() {
  await ui.browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await ui.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await frames(2);
}
const CARD = `#messages .tool-card[data-tool-call-id="${CALL}"]`;
const COPY = `${CARD} .tool-copy`;

/** Windows 剪贴板把 `\n` 存成 `\r\n`（实测）⇒ 只归一化这一件事。 */
const sameClipboardText = (read, expected) => typeof read === 'string'
  && read.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n');

/** 选会话 + 等那张 `bash` 卡（每次重载后都要重来一遍）。 */
async function openCard() {
  await waitFor(async () => (await evalIn(`!!document.querySelector('[data-session-id="${SESSION}"]') && !!window.sophoCopyText`)) === true, '主界面没起来（或共用复制脚本没加载）', 10_000);
  await evalIn(`document.querySelector('[data-session-id="${SESSION}"] .tree-select').click()`);
  await waitFor(async () => (await evalIn(`!!document.querySelector(${JSON.stringify(COPY)})`)) === true, '工具卡（带全文的 bash）没渲染出来', 10_000);
  await frames(3);
}

/** 点复制前挂一个 MutationObserver，把按钮文案**变过的每一个值**都记下来（flash 只显示 1.2 s，
 *  单次采样会漏掉「复制失败」那一瞬 —— 这一条正是本单要钉的）。 */
async function watchButtonLabels() {
  // 上一次 flash（「已复制」/「请手动复制」/「复制失败」）会挂 1.2 s ⇒ 先等它回到默认文案，再开始记；
  // 不然上一臂那个残留值会被当成「这一臂记到的文案」（实测踩到过：c 臂的 labels 里混着 b 臂的「已复制」）。
  await waitFor(async () => (await evalIn(`document.querySelector(${JSON.stringify(COPY)}).textContent`)) === '复制',
    '复制按钮的文案没回到默认（上一次 flash 还挂着？）', 4000);
  await evalIn(`(() => {
    const button = document.querySelector(${JSON.stringify(COPY)});
    window.__labels = [button.textContent];
    window.__labelObserver?.disconnect();
    window.__labelObserver = new MutationObserver(() => {
      if (window.__labels[window.__labels.length - 1] !== button.textContent) window.__labels.push(button.textContent);
    });
    window.__labelObserver.observe(button, { childList: true, subtree: true, characterData: true });
    return true;
  })()`);
}
const buttonState = () => evalIn(`(() => {
  const button = document.querySelector(${JSON.stringify(COPY)});
  return {
    labels: [...(window.__labels ?? [])], text: button.textContent,
    path: button.dataset.copyPath ?? null, title: button.title ?? null,
    copyCount: document.querySelectorAll('.tool-copy').length,
    panelHidden: document.querySelector('#copy-panel').hidden,
    panelValue: document.querySelector('#copy-text').value,
  };
})()`);
const readNativeClipboard = () => evalIn(`(async () => {
  try { return { ok: true, text: await window.__nativeClipboardDesc.get.call(navigator).readText() }; }
  catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
})()`);
const writeNativeClipboard = (text) => evalIn(`(async () => {
  try { await window.__nativeClipboardDesc.get.call(navigator).writeText(${JSON.stringify(text)}); return 'ok'; }
  catch (error) { return 'write-failed: ' + String((error && error.message) || error); }
})()`);
const manualState = () => evalIn(`(() => {
  const panel = document.querySelector('#copy-panel');
  const area = document.querySelector('#copy-text');
  const button = document.querySelector(${JSON.stringify(COPY)});
  return {
    panelHidden: panel.hidden, value: area.value, readOnly: area.readOnly,
    selectedAll: document.activeElement === area && area.selectionStart === 0 && area.selectionEnd === area.value.length,
    lead: document.querySelector('#copy-lead').textContent,
    why: document.querySelector('#copy-why').textContent,
    labels: [...(window.__labels ?? [])], buttonText: button.textContent, path: button.dataset.copyPath ?? null,
    bodyHasFailure: document.body.textContent.includes('复制失败'),
  };
})()`);

try {
  ui = await boot({ routes, webRoot, width: 1200, height: 760 });

  // 注入脚本（在**每一次**页面脚本之前跑）：留一份**原生描述符**，好在「这一页已经没有 clipboard 了」
  // 时把**真剪贴板**读回来/写哨兵（不是我们自己的桩 —— 派单原话）。
  await ui.browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__nativeClipboardDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');`,
  });
  await ui.browser.send('Browser.grantPermissions', {
    origin: `http://127.0.0.1:${ui.port}`,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });
  await ui.browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  // ═══ 1. 静态：两处都接到**同一份**共用实现上，三级都在那一份文件里 ═══════════════════════════
  const productHtml = await readFile(path.join(webRoot, 'index.html'), 'utf8');
  const designerHtml = await readFile(path.join(webRoot, 'designer.html'), 'utf8');
  const renderJs = await readFile(path.join(webRoot, 'render.js'), 'utf8');
  const designerJs = await readFile(path.join(webRoot, 'designer.js'), 'utf8');
  const sharedJs = await readFile(path.join(webRoot, 'copy-text.js'), 'utf8');
  const tiers = {
    clipboard: sharedJs.includes('clipboard.writeText(text)'),
    compat: sharedJs.includes(`document.execCommand('copy')`),
    helper: sharedJs.includes(`area.dataset.copyHelper = 'compat'`),
    manual: sharedJs.includes('function openManualCopy') && sharedJs.includes('select()'),
  };
  check('static:shared-tiers', '三级都在**那一份共用实现**里（`navigator.clipboard` / `document.execCommand(\'copy\')` ＋'
    + ' 用完移除的临时 textarea / 只读已全选的手动框）', Object.values(tiers).every(Boolean), JSON.stringify(tiers));
  const wiring = {
    productScript: productHtml.includes('src="/copy-text.js"'),
    productPanel: productHtml.includes('id="copy-panel"') && productHtml.includes('id="copy-text"'),
    productCalls: renderJs.includes('sophoCopyText') && renderJs.includes('copy.copyText(text'),
    // 「主产品自己不再留一份实现」：旧那份的特征（`function copyViaExecCommand` ＋ 那把远处的 scratch textarea）都没了。
    productNoOwnTiers: !renderJs.includes('function copyViaExecCommand') && !renderJs.includes('scratch.style.cssText'),
    designerScript: designerHtml.includes('src="/copy-text.js"'),
    designerCalls: designerJs.includes('window.sophoCopyText') && designerJs.includes('shared.copyText(text'),
    designerNoOwnTiers: !designerJs.includes('function copyViaExecCommand') && !designerJs.includes(`area.dataset.copyHelper = 'compat'`),
  };
  check('static:two-pages-use-shared', '**两个页面**都引 `/copy-text.js` 并调它（各自不再留一份自己的两级/三级实现）；'
    + '主产品的手动框 DOM 在 `web/index.html` 里', Object.values(wiring).every(Boolean), JSON.stringify(wiring));

  // ═══ 2. a 臂：正常上下文 ⇒ ① clipboard（真剪贴板读回）══════════════════════════════════════
  const reloaded = ui.browser.once('Page.loadEventFired');
  await ui.browser.send('Page.navigate', { url: `http://127.0.0.1:${ui.port}/` });
  await reloaded;
  await frames(4);
  await ui.browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await openCard();
  const securePrep = await evalIn(`({ secure: window.isSecureContext, clip: typeof navigator.clipboard, native: typeof window.__nativeClipboardDesc?.get })`);
  check('main:secure-prep', 'a 臂的前提：页面是**安全上下文**（`127.0.0.1`）、原生的 `navigator.clipboard` 在场、'
    + '注入脚本留的原生描述符也在', securePrep.secure === true && securePrep.clip === 'object' && securePrep.native === 'function', JSON.stringify(securePrep));
  const source = await evalIn(`document.querySelector(${JSON.stringify(CARD)} + ' .tool-command').textContent`);
  const poison = '哨兵①：复制成了就必须覆盖掉这一串';
  await writeNativeClipboard(poison);
  await watchButtonLabels();
  await clickSelector(COPY);
  await sleep(300);
  await ui.screenshot(path.join(ARTIFACT_DIR, 'copy-tiers-secure.png'));
  screenshots.push(path.join(ARTIFACT_DIR, 'copy-tiers-secure.png'));
  const secure = await buttonState();
  const secureRead = await readNativeClipboard();
  print('a · 正常上下文（原始读数）', { path: secure.path, labels: secure.labels, title: secure.title, clipboardBytes: secureRead.text?.length, sourceBytes: source.length });
  check('main:secure-path', 'a) 正常上下文点「复制」⇒ 走 **① clipboard**（`data-copy-path=clipboard`、按钮说「已复制」）、'
    + '**不出现「复制失败」**、手动框没弹（③ 根本用不上）',
    secure.path === 'clipboard' && secure.labels.includes('已复制') && !secure.labels.includes('复制失败') && secure.panelHidden === true,
    JSON.stringify({ path: secure.path, labels: secure.labels, panelHidden: secure.panelHidden }));
  check('main:secure-bytes', 'a) **真剪贴板**（原生描述符读回）里就是**命令全文**：换行按 CRLF→LF 归一化后逐字节相等，'
    + '且**不是**首行/摘要、哨兵被覆盖',
    sameClipboardText(secureRead.text, source) && secureRead.text !== poison && secureRead.text.trimEnd() !== LONG_FIRST_LINE.slice(0, 240),
    JSON.stringify({ ok: secureRead.ok, rawBytes: secureRead.text?.length, sourceBytes: source.length, crlf: secureRead.text?.includes('\r\n') ?? null, stillPoison: secureRead.text === poison, error: secureRead.error ?? null }));

  // ═══ 2b. d 臂：① 在 1.5 s 上界内**没有回应** ⇒ 不许无限等（测试侧把 writeText 换成一个**永不 settle** 的
  //      promise，模拟「浏览器没授权 / 文档没聚焦」时那个「点了没反应」）════════════════════════════════
  const writeTextStubbed = await evalIn(`(() => {
    const proto = Object.getPrototypeOf(navigator.clipboard);
    window.__writeTextDesc = Object.getOwnPropertyDescriptor(proto, 'writeText');
    Object.defineProperty(proto, 'writeText', { configurable: true, writable: true, value: () => new Promise(() => {}) });
    return typeof navigator.clipboard.writeText;
  })()`);
  check('main:budget-prep', 'd 臂的前提：`navigator.clipboard.writeText` 被测试换成**永不 settle** 的 promise（原生描述符留在 '
    + '`window.__writeTextDesc` 里；这一臂之后还原）—— 这正是前人实测到的「没授权、没有用户激活时它既不 resolve 也不 reject」',
    writeTextStubbed === 'function', JSON.stringify({ writeText: writeTextStubbed }));
  const budgetPoison = '哨兵④：① 没回应，往下走 ② 的时候真剪贴板里还是这一串';
  // ⚠️ 这一臂里 `Clipboard.prototype.writeText` **已经被上面那段换成永不 settle 的了** ⇒ 写哨兵不能再走它，
  // 要用之前捕获的那份原生描述符（`__writeTextDesc.value`）直接调（读回走 `readText`，没被动）。
  const budgetPoisoned = await evalIn(`(async () => {
    try { await window.__writeTextDesc.value.call(navigator.clipboard, ${JSON.stringify(budgetPoison)}); return 'ok'; }
    catch (error) { return 'write-failed: ' + String((error && error.message) || error); }
  })()`);
  check('main:budget-prep2', 'd 臂的哨兵用**原生的那个 writeText**（前面捕获的描述符）写进去了（待会儿 ② 成了就必然被覆盖）',
    budgetPoisoned === 'ok', JSON.stringify({ budgetPoisoned }));
  await watchButtonLabels();
  const budgetStartedAt = Date.now();
  await clickSelector(COPY);
  await sleep(2600); // 上界 1.5 s ＋ ② 那条同步链 ＋ 让 flash 落定
  const budgetElapsed = Date.now() - budgetStartedAt;
  const budgeted = await buttonState();
  const budgetRead = await readNativeClipboard();
  const budgetManual = budgeted.path === 'manual' ? await manualState() : null;
  print('d · ① 没有回应（原始读数）', { elapsedMs: budgetElapsed, path: budgeted.path, labels: budgeted.labels, clipboardBytes: budgetRead.text?.length, sourceBytes: source.length, why: budgetManual?.why ?? null });
  check('main:budget-no-hang', 'd) ① 一直没回应**也不许无限等**：1.5 s 上界到了就往下走（实测这一下用满 ≥1500 ms，最终落到 ② 或 ③ ——'
    + ' 不是「点了没反应」），全程没有「复制失败」',
    budgetElapsed >= 1500 && ['execCommand', 'manual'].includes(budgeted.path) && !budgeted.labels.includes('复制失败'),
    JSON.stringify({ elapsedMs: budgetElapsed, path: budgeted.path, labels: budgeted.labels }));
  check('main:budget-outcome', 'd) 上界之后那两级**都对得起人**：走到 ② ⇒ 按钮说「已复制」且**真剪贴板**里是命令全文（哨兵被覆盖）；'
    + '走到 ③ ⇒ 手动框弹着、内容逐字节相等、按钮写「请手动复制」不谎称已复制，且 `why` 如实写「等了 1500 ms 也没有回应」',
    budgeted.path === 'execCommand'
      ? (budgeted.labels.includes('已复制') && sameClipboardText(budgetRead.text, source))
      : (budgetManual?.panelHidden === false && budgetManual.value === source && !budgeted.labels.includes('已复制') && budgetManual.why.includes('等了 1500 ms')),
    JSON.stringify({ path: budgeted.path, labels: budgeted.labels, clipboardBytes: budgetRead.text?.length, stillPoison: budgetRead.text === budgetPoison, panelValueBytes: budgetManual?.value?.length ?? null, why: budgetManual?.why ?? null }));
  if (budgetManual && budgetManual.panelHidden === false) await pressEscape();
  await evalIn(`(() => { const proto = Object.getPrototypeOf(navigator.clipboard); if (window.__writeTextDesc) Object.defineProperty(proto, 'writeText', window.__writeTextDesc); return true; })()`);

  // ═══ 3. b 臂：模拟「局域网 IP ＋ 明文 HTTP」⇒ ② execCommand（真剪贴板读回）═════════════════
  await ui.browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get() { return undefined; } });
      Object.defineProperty(window, 'isSecureContext', { configurable: true, get() { return false; } });
    })();`,
  });
  const reloaded2 = ui.browser.once('Page.loadEventFired');
  await ui.browser.send('Page.navigate', { url: `http://127.0.0.1:${ui.port}/` });
  await reloaded2;
  await frames(4);
  await ui.browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await openCard();
  const simulated = await evalIn(`({ clip: String(navigator.clipboard), secure: window.isSecureContext, native: typeof window.__nativeClipboardDesc?.get })`);
  check('main:nonsecure-simulated', 'b 臂的前提（注入脚本在**页面脚本之前**跑）：`navigator.clipboard` 是 **undefined**、'
    + '`window.isSecureContext` 是 **false** —— 这就是「局域网 IP ＋ 明文 HTTP」打开时浏览器给的那两格（不是改产品代码装出来的）',
    simulated.clip === 'undefined' && simulated.secure === false && simulated.native === 'function', JSON.stringify(simulated));
  const source2 = await evalIn(`document.querySelector(${JSON.stringify(CARD)} + ' .tool-command').textContent`);
  const poison2 = '哨兵②：兼容路径成了就必须覆盖掉这一串';
  const poisoned = await writeNativeClipboard(poison2);
  check('main:nonsecure-prep', 'b 臂的前提钉死：真剪贴板里先放了一串**哨兵**（复制成了就必然被覆盖）', poisoned === 'ok', JSON.stringify({ poisoned, sourceBytes: source2.length }));
  await watchButtonLabels();
  await clickSelector(COPY);
  await sleep(300);
  await ui.screenshot(path.join(ARTIFACT_DIR, 'copy-tiers-nonsecure.png'));
  screenshots.push(path.join(ARTIFACT_DIR, 'copy-tiers-nonsecure.png'));
  const nonSecure = await buttonState();
  const nonSecureRead = await readNativeClipboard();
  print('b · 非安全上下文（原始读数）', { path: nonSecure.path, labels: nonSecure.labels, clipboardBytes: nonSecureRead.text?.length, sourceBytes: source2.length });
  check('main:nonsecure-no-failure', 'b) 非安全上下文点「复制」⇒ **按钮文案里从来没过「复制失败」**（业主报的就是这一格），'
    + '而且页面上（含手动框）也没有那句',
    !nonSecure.labels.includes('复制失败') && nonSecure.labels.includes('已复制') && nonSecure.panelHidden === true,
    JSON.stringify({ labels: nonSecure.labels, text: nonSecure.text, path: nonSecure.path }));
  check('main:nonsecure-path', "b) 它**没有**去碰剪贴板 API（那一格根本不存在），而是退到 **② 兼容路径** "
    + "`document.execCommand('copy')`：`data-copy-path=execCommand`、按钮说「已复制」、手动框没弹",
    nonSecure.path === 'execCommand' && nonSecure.labels.includes('已复制') && nonSecure.panelHidden === true,
    JSON.stringify({ path: nonSecure.path, labels: nonSecure.labels, panelHidden: nonSecure.panelHidden, title: nonSecure.title }));
  check('main:nonsecure-bytes', 'b) **真剪贴板**（原生描述符读回，不是我们自己的桩）里就是这一臂的命令全文 —— 哨兵被覆盖，'
    + '归一化 CRLF 后逐字节相等', sameClipboardText(nonSecureRead.text, source2) && nonSecureRead.text !== poison2,
    JSON.stringify({ ok: nonSecureRead.ok, rawBytes: nonSecureRead.text?.length, sourceBytes: source2.length, stillPoison: nonSecureRead.text === poison2, error: nonSecureRead.error ?? null }));

  // ═══ 4. c 臂：② 也被拒 ⇒ ③ 只读、已全选的手动框 ═══════════════════════════════════════════
  const stubbed = await evalIn(`(() => { document.execCommand = () => false; return document.execCommand(); })()`);
  check('main:manual-prep', 'c 臂的前提钉死：`document.execCommand` 被测试打死（返回 false）—— 模拟「兼容路径也被浏览器拒绝」', stubbed === false, JSON.stringify({ stub: stubbed }));
  const poison3 = '哨兵③：到了手动框这一步，剪贴板里应该还是这一串（产品不许假装已复制）';
  await writeNativeClipboard(poison3);
  await watchButtonLabels();
  await clickSelector(COPY);
  await frames(3);
  const manual = await manualState();
  const manualRead = await readNativeClipboard();
  print('c · 手动框（原始读数）', { panelHidden: manual.panelHidden, selectedAll: manual.selectedAll, readOnly: manual.readOnly, labels: manual.labels, whyBytes: manual.why.length, leadBytes: manual.lead.length });
  check('main:manual-panel', 'c) 兼容路径也失败 ⇒ **弹手动框**（不是死胡同）：面板可见、里面是**只读** textarea、**内容全选**、'
    + '按钮**不谎称**「已复制」（写的是「请手动复制」）、也不写「复制失败」、剪贴板里那串哨兵原样没动',
    manual.panelHidden === false && manual.readOnly === true && manual.selectedAll === true && manual.path === 'manual'
    && !manual.labels.includes('已复制') && !manual.labels.includes('复制失败') && !manual.bodyHasFailure
    && manualRead.text === poison3,
    JSON.stringify({ panelHidden: manual.panelHidden, readOnly: manual.readOnly, selectedAll: manual.selectedAll, labels: manual.labels, path: manual.path, clipboardStillPoison: manualRead.text === poison3 }));
  check('main:manual-bytes', 'c) 框里的内容**逐字节等于**源文本（命令全文；直接 Ctrl+C 就能拿走 —— 这一条没有 CRLF 那层，DOM 字符串不过系统剪贴板）',
    manual.value === source2, JSON.stringify({ same: manual.value === source2, bytes: manual.value?.length, sourceBytes: source2.length }));
  check('main:manual-why', 'c) 文案**如实**：说清为什么（「不在安全上下文（在 HTTPS 或 localhost / 127.0.0.1 之外打开…）」＋ 逐级 '
    + '`navigator.clipboard` / `execCommand`）与怎么办（Ctrl+C ＋ 展开态自己选中复制）',
    manual.lead.includes('不在安全上下文') && manual.lead.includes('剪贴板 API') && manual.lead.includes('Ctrl+C')
    && manual.lead.includes('命令全文') && manual.lead.includes('展开态') && manual.why.includes('navigator.clipboard') && manual.why.includes('execCommand'),
    JSON.stringify({ lead: manual.lead, why: manual.why }));
  await ui.screenshot(path.join(ARTIFACT_DIR, 'copy-tiers-manual-panel.png'));
  screenshots.push(path.join(ARTIFACT_DIR, 'copy-tiers-manual-panel.png'));
  // Esc 与「关掉」是同一个出口 —— 两条**各自都量**：先按 Esc 收起来（并验证真收干净），
  // 再重新点一次「复制」（这时浮层已经不在，这一下踩到的是真按钮）⇒ 框又开、
  // 再用「关掉」收一次。两条路都要求「收起 ＋ 清掉副本」。
  const beforeEsc = await evalIn(`(() => ({ hidden: document.querySelector('#copy-panel').hidden, value: document.querySelector('#copy-text').value }))()`);
  await pressEscape();
  const escClosed = await evalIn(`(() => ({ hidden: document.querySelector('#copy-panel').hidden, value: document.querySelector('#copy-text').value }))()`);
  check('main:manual-esc', 'c) 键盘 **Esc** 关得掉（与「关掉」同一个出口）：收起面板、框里的副本一起清掉'
    + '（先把「按之前确实开着」钉进同一条断言 —— 不然面板根本没弹时这一条会假绿）',
    beforeEsc.hidden === false && beforeEsc.value === source2 && escClosed.hidden === true && escClosed.value === '',
    JSON.stringify({ beforeEsc: { hidden: beforeEsc.hidden, bytes: beforeEsc.value?.length }, escClosed }));
  await clickSelector(COPY);
  await frames(3);
  const reopened = await evalIn(`(() => ({ hidden: document.querySelector('#copy-panel').hidden, value: document.querySelector('#copy-text').value }))()`);
  check('main:manual-reopen', 'c) 收起之后再点一次「复制」⇒ 框又开（不是一次性的），且里面又是那份文本（这是下面那次「关掉」的前提）',
    reopened.hidden === false && reopened.value === source2, JSON.stringify({ hidden: reopened.hidden, bytes: reopened.value?.length }));
  await clickSelector('#copy-close');
  await frames(2);
  const closed = await evalIn(`(() => ({ hidden: document.querySelector('#copy-panel').hidden, value: document.querySelector('#copy-text').value }))()`);
  check('main:manual-close', 'c) 点「关掉」⇒ 收起面板，框里的副本一起清掉（不留副本）',
    reopened.hidden === false && closed.hidden === true && closed.value === '', JSON.stringify({ reopened: { hidden: reopened.hidden }, ...closed }));

  // ═══ 5. 全程零未捕获异常 / 零 console.error ═══════════════════════════════════════════════
  check('page:clean', '全程零未捕获异常、零 console.error', ui.pageProblems.length === 0 && localProblems.length === 0,
    JSON.stringify([...ui.pageProblems, ...localProblems]));
} catch (error) {
  check('page:arm', '主产品那一臂跑完（没在断言之前抛异常）', false, error?.stack ?? String(error));
} finally {
  if (ui) await ui.close(problems);
}

// ── 真仓的文件读数 ────────────────────────────────────────────────────────────────────────
// ⚠️ 判据**按归属**（2026-09-25 修）：
//   · **本门名下**（硬判据，是**观察**而不是本地常量）：`ui.staticRoot` = `boot()` 真正解析出来的
//     服务根（`test/ui-harness.mjs` 的返回值里带它），必须在本门自己的 mkdtemp 沙箱里
//     ⇒ 产品代码在页面里能写到的最深处就是这个沙箱，真仓没有出现在任何服务/写路径上。
//     将来谁把交给 `boot()` 的服务根改回 `WEB_ROOT`，它当场红。
//   · 真仓那几份的 sha256 前后比较改成**只记录**：本门对真仓**没有写路径**（每一处写都由沙箱
//     `sandbox` 拼出：副本、浏览器 profile、截图），而真仓是**共享工作区**（人的终端、别的 landing
//     的脚本随时会改它）⇒ 拿它做前后对比就是把**别人的写**算在本门头上（同一个坑
//     `test/pre-push.mjs` 第 4 节 2026-09-25 踩过）。
{
  const servedRoot = ui?.staticRoot ?? null;
  check('sandbox:served-root-is-sandboxed', '真页面服务的是**本门沙箱里**的 web/ 副本（真仓没进任何服务/写路径）',
    typeof servedRoot === 'string' && !path.relative(sandbox, servedRoot).startsWith('..') && path.resolve(servedRoot) !== path.resolve(WEB_ROOT),
    JSON.stringify({ servedRoot, sandbox, WEB_ROOT, handedWebRoot: webRoot }));
  const changed = [];
  for (const file of REAL_PRODUCT_FILES) {
    const before = hashesBefore.get(file);
    const after = await sha256(path.join(root, file)).catch(() => '(读不到)');
    if (before !== after) changed.push(`${file}（${String(before).slice(0, 8)} → ${String(after).slice(0, 8)}）`);
  }
  print('sandbox:real-files-observation（**只记录、不断言**）', changed.length === 0
    ? `${REAL_PRODUCT_FILES.length} 份真产品文件在本门这一轮里 sha256 没变（反证臂改的是临时目录里的副本）`
    : { 变了: changed, 归属: '真仓是共享工作区（本门对真仓没有写路径）—— 别人的写不是本门的副作用' });
}

// ── 结算 / 反证臂断言 ───────────────────────────────────────────────────────────────────────
if (ARM) {
  const arm = ARM_MUTANTS[ARM];
  const redIds = failures.map((failure) => failure.id);
  process.stdout.write(`\n──── 反证臂 ${ARM}：预期红 ${JSON.stringify(arm.expect)} / 实际红 ${JSON.stringify(redIds)} ────\n`);
  for (const failure of failures) {
    process.stdout.write(`  红：[${failure.id}] ${failure.name} —— ${typeof failure.detail === 'string' ? failure.detail : JSON.stringify(failure.detail)}\n`);
  }
  if (arm.expect.every((id) => redIds.includes(id))) {
    process.stdout.write(`✓ 反证臂 ${ARM} 红到位（预期的每一条都红了）—— 这是**期望**的结果，不是缺陷\n`);
  } else {
    process.stdout.write(`✗ 反证臂 ${ARM} **没红到位**：预期的 ${JSON.stringify(arm.expect)} 不在红的名单里 ⇒ 这道门是个假门\n`);
    process.exitCode = 1;
  }
} else {
  process.stdout.write(`\n──── test/copy-tiers-live.mjs：${checks} 条断言 —— ${checks - failures.length} 绿 / ${failures.length} 红 ────\n`);
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stdout.write(`FAIL  [${failure.id}] ${failure.name} —— ${typeof failure.detail === 'string' ? failure.detail : JSON.stringify(failure.detail)}\n`);
    }
    process.exitCode = 1;
  } else if (problems.length > 0) {
    for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
    process.exitCode = 1;
  }
}
if (screenshots.length > 0) process.stdout.write(`截图（${screenshots.length} 张）：${screenshots.join(' / ')}\n`);

await removeSandbox(sandbox, problems, 'copy-tiers sandbox');
finishCleanup(null, problems);
