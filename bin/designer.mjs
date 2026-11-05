#!/usr/bin/env node
// bin/designer.mjs —— 把「用**真 Chromium ＋ CDP** 驱动 `/designer.html` 的 `window.sophoDesigner`」封成一条命令。
//
// 为什么要有它（业主 2026-09-28 逐字，本单＝提案 C）：
//   「现在 agent 对编辑页面的使用还是需要**通过对文件进行 json 编辑**才行，后续应该考虑**直接在 webui 当中介入**，
//    这也就意味着需要**让 agent 可以操控编辑器，编辑节点**」。
//   ⇒ 上一单已经把「可编程控制面」放进了编辑器页（`window.sophoDesigner`，与鼠标**同一条**提交/撤销/渲染路径，
//     见 `docs/design/designer-agent.md`）。本单把那条 CDP 配方封成 CLI：agent 一条命令就能「把一份设计文档
//     变成 HTML/SVG/PNG/规范 JSON/转移图」，而且**产物是从真浏览器里当场渲染出来的**，不是第二份实现。
//
// 它做五件事（与 `docs/design/designer-agent.md` §2 那五步逐条对应）：
//   ① 起一个只服务 `<仓库>/web` 的静态服务（`127.0.0.1` ＋ **高位随机端口**，不占 7321/7331）；
//   ② 起**真 Chromium**（`--headless=new` ＋ 临时 `--user-data-dir`，POSIX 上让它**自己一个进程组**，
//     收尾按**进程组 ＋ 精确 pid** 结束整棵树，**绝不 pkill**）；
//   ③ 说 CDP：把文档交给 `window.sophoDesigner.setDoc()` —— **与「导入 JSON」同一个校验器**（本 CLI 不另写一份）；
//   ④ 点编辑器页**自己的导出菜单**（`[data-export=…]`，与鼠标点的是同一条路、同一份实现）导出 HTML/SVG(/PNG/转移图)，
//      规范 JSON 走公开 API `exportDoc()`（与菜单里那一项**同一串字节**）；
//   ⑤ 把字节落到 `--out`，并把**产物路径**打印出来。
//
// 三条硬口径（都有判据）：
//   · **零宿主改动**：本文件不碰 `server/**`、不开任何顶层路由、不改任何产品文件（`web/index.html` / `slot.css` /
//     `app.js` / `render.js` 都不动）。它只是一个**客户端**：起浏览器、说 CDP、读写文件。
//   · **如实**：文档不合法 ⇒ **非零退出**并把页面给的**原因逐字**打印（绝不「跑完了、其实没导出」）；
//     Chromium 起不来 / CDP 断开 / 页面超时 ⇒ 如实报 ＋ 按 pid 收尾；**要么全部产物都写出来、要么一个都不写**
//     （先把字节全拿到内存里，最后才落盘 —— 所以失败不会留下半成品）。
//   · **不碰你的东西**：`--out` 里已有同名文件 ⇒ **拒绝覆盖**（退 5），要覆盖得显式 `--force`；
//     浏览器的 profile / TMPDIR / HOME / XDG 全部指向本次运行的私有工作目录，跑完删掉（不往共享临时目录
//     或你真 `~/.config/chromium` 里写 —— 与 `test/harness.mjs` 的 `browserSandboxEnv()` 同一条口径）。
//     工作根要放在 Chromium **建得下它的单例 socket** 的地方（`len(work)+49 < 108`，POSIX）—— 继承来的
//     TMPDIR 放不下就换短根；换不了就照跑，但失败时如实报（见 `tempRoot()` 那段）。
//
// 用法：
//   node bin/designer.mjs <文档.json> --out <目录> [--screen <id|name>] [--state <id|name>]
//                        [--all-screens] [--all-states] [--png] [--json] [--flow] [--force]
//                        [--timeout-ms N] [--keep-work] [--check-twice]
//   node bin/designer.mjs --help
//
//   默认导出 HTML ＋ SVG（**文档的第 0 屏 · 第 0 状态**，与页面顶栏「导出 ▾」里那两项同一件事）；
//   `--png` 再加 PNG（由页面里的 canvas 光栅化）、`--json` 再加规范 JSON（**整份文档**）、
//   `--flow` 再加转移图 SVG（**整份文档**，节点 = 屏×状态、箭头 = `transitions` 的一条数据）。
//
//   多屏多状态：HTML / SVG / PNG 是**当前屏 · 当前状态**的（页面自己那条「所见即所得」的口径）⇒ 要别的屏/状态，
//   就得**切过去再导**。本 CLI 用的就是页面自己铺好的那条路：`window.sophoDesigner.openScreen(screenId, stateId?)`
//   （与点左栏那两行**同一个函数**），切一次、导一份：
//     · `--screen <id|name>` 只出那一屏（缺省 = 文档第 0 屏）；`--state <id|name>` 只出那一个状态
//       （缺省 = 选中那一屏的第 0 个状态）；
//     · `--all-screens` 每屏都出（每屏用**它自己**的第 0 个状态）；`--all-states` 对选中的屏**每个状态**都出；
//       `--all-screens --all-states` ⇒ 每个屏的每个状态各出一份。两者与 `--screen`/`--state` 互斥（同时给是用法错）。
//     · 屏/状态用 **id 或名字**都能指（id 精确匹配优先；名字撞车了会如实报「有歧义，请给 id」）。
//     · 产物名**确定且能区分**：`design-<文档基名>.<屏 id>.<状态 id>.{html,svg,png}`（id 里的字符转义规则见
//       `idSegment()` 那段注释）；`--json` / `--flow` 是**整份文档**，各只有一份：
//       `design-<文档基名>.json` / `design-<文档基名>.flow.svg`。
//     · 无效的 `--screen` / `--state`（文档里没有那个 id 也没有那个名字）⇒ 退 **2**，并**列出有哪些屏/状态**。
//
//   硬口径（都有门的断言钉着）：**要么全写、要么一个都不写**（所有字节先在内存里拿全，最后才落盘）；
//   页面抛的错**绝不吞**（`pageResultOrThrow()`）；切屏之后**回读**当前屏/状态，对不上就当失败（产物会是错的）；
//   `--check-twice`：**同一项导出两次**，两份字节必须**逐字节相同**（写盘的是第一份）—— 确定性自检。
//
// 退出码（含义写在这里，别靠猜 —— 文档 `docs/design/designer-agent.md` §7 抄着同一张表）：
//   0 = 要的产物都写出来了；2 = 用法错（参数 / 找不到文件 / 不是 .json / 不是合法 JSON /
//       --screen|--state 指不到东西 / --screen 与 --all-screens 这类互斥组合 / 产物名撞车）；
//   3 = 文档不合法（**页面自己的** `setDoc` 拒了它，原因逐字打印，一个字节都不产出）；
//   4 = 环境失败（`CHROME_BIN` 指不到 / Chromium 起不来 / CDP 连不上 / 页面没 ready / 超时）；
//   5 = `--out` 里已有同名产物且没给 `--force`（**不覆盖**）；
//   6 = 页面自己报的导出失败 / 切屏后回读的屏·状态与要求的不一致（页面那条「如实报」的 catch 触发了，原因逐字打印）；
//   1 = 其它未预期错误（含 `--check-twice` 量到「同一项两次导出字节不同」）。

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WEB_ROOT = path.join(REPO, 'web');

/** POSIX（Linux/macOS）—— 进程组、`/proc` 这些只在它上面有。 */
const POSIX = process.platform !== 'win32';
/** Chromium 单例 socket 的路径上界：`sockaddr_un.sun_path` 是 108 字节（**含结尾 NUL**，Linux）。 */
const SOCKET_PATH_LIMIT = 108;
/** 本次工作目录的名字前缀（收尾/诊断时按它认自己那一份）。 */
const WORK_PREFIX = 'designer-cli-';
/**
 * socket 路径有多长：Chromium 把单例 socket 建在 `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket`，
 * 而本 CLI 交给浏览器的 `$TMPDIR` 是 `<work>/tmp` ⇒ 整条路径 = `len(work) + 49`（实测逐字对得上）。
 */
const socketPathLength = (work) => work.length + 49;

/** 退出码表（上面注释里的那张，用到的是这一份）。 */
const EXIT = Object.freeze({ ok: 0, internal: 1, usage: 2, badDoc: 3, env: 4, exists: 5, pageFailed: 6 });

/** 带退出码的错：只有这一种错会被顶层翻译成「打印原因 ＋ 退出码」。 */
class CliError extends Error {
  constructor(message, code = EXIT.internal) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => process.stdout.write(`${text}\n`);
const warn = (text) => process.stderr.write(`${text}\n`);

// ── 用法 / 参数 ───────────────────────────────────────────────────────────────────────────
const USAGE = `用法：node bin/designer.mjs <文档.json> --out <目录> [--screen <id|name>] [--state <id|name>]
                     [--all-screens] [--all-states] [--png] [--json] [--flow] [--force]
                     [--timeout-ms N] [--keep-work] [--check-twice]

  <文档.json>        要出的那份设计文档（冻结 v0 形状；由编辑器页自己的 setDoc 校验）
  --out <目录>       产物目录（不存在就建；**已有同名产物则拒绝覆盖**，除非加 --force）

  HTML / SVG / PNG 是「**当前屏 · 当前状态**」（页面自己那条口径）⇒ 要别的屏/状态就得先切过去（本 CLI 走
  window.sophoDesigner.openScreen()，与点左栏那两行同一个函数）；--json / --flow 是**整份文档**。
  --screen <id|name> 只出这一屏（缺省 = 文档第 0 屏）；id 或**名字**都行
  --state <id|name>  只出选中的那一屏的这一个状态（缺省 = 那一屏的第 0 个状态）
  --all-screens      每一屏都出（每屏用**它自己**的第 0 个状态；与 --screen 互斥）
  --all-states       选中的那些屏的**每一个状态**都出（与 --state 互斥）
  --png              额外导出 PNG（页面里的 canvas 光栅化）
  --json             额外导出**规范 JSON**（整份文档；与页面「导出 JSON」同一串字节，只出一份）
  --flow             额外导出**转移图 SVG**（整份文档，只出一份）
  --force            允许覆盖 --out 里的同名产物（默认**不覆盖**：设计稿不是构建产物）
  --timeout-ms N     等浏览器/页面/每次导出的上界（默认 30000）
  --keep-work        保留本次的临时工作目录（profile/TMPDIR/HOME，排查失败时有用）
  --check-twice      **确定性自检**：每一项导出**两次**，两份字节必须逐字节相同（写盘的是第一份）
  --help             打印这张表

环境变量：
  CHROME_BIN             Chromium/Chrome 可执行文件（缺省 /usr/bin/chromium）
  DESIGNER_CLI_TMP_ROOT  **显式**指定工作根（设了就不自动换根；缺省：先用继承来的 TMPDIR，它放不下
                         Chromium 的单例 socket 时自动换短根，并把「换到哪儿」打出来）

工作目录（work）：它装着浏览器那份私有的 TMPDIR/HOME/XDG 与「chromium/」profile，收尾是**整棵树真的没了**
才删、删完还会复核一次。Chromium 把它的单例 socket 建在「<work>/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket」，
POSIX 上整条路径必须 **< 108 字节**（sockaddr_un.sun_path，含结尾 NUL）⇒ 继承来的 TMPDIR 太长时本 CLI
会换一个短根（len(work)+49 那个数就是这条路径的长度）；一个短根都换不了时，失败会如实快报（含
signalCode 与 Chromium 自己那行「FATAL: … Socket path too long」）。

产物名（确定性；屏/状态 id 里除 A-Za-z0-9_- 之外的字符按 UTF-8 字节写成 %XX）：
  HTML/SVG/PNG       design-<文档基名>.<屏 id>.<状态 id>.{html,svg,png}   （每一份「屏×状态」各一套）
  规范 JSON/转移图   design-<文档基名>.json  /  design-<文档基名>.flow.svg （整份文档，各一份）

退出码：0 全部产物写好；2 用法错（含 --screen/--state 指不到东西、--screen 与 --all-screens 互斥组合）；
        3 文档不合法（原因见输出）；4 环境失败（Chromium/CDP/页面超时）；
        5 --out 里已有同名产物且没给 --force；6 页面自己报的导出失败（或切屏后回读对不上）；1 其它未预期错误。`;

function parseArgs(argv) {
  const options = { doc: null, out: null, kinds: new Set(['html', 'svg']), force: false, timeoutMs: 30000, keepWork: false, help: false,
    screen: null, state: null, allScreens: false, allStates: false, checkTwice: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--out') { options.out = argv[i + 1] ?? null; i += 1; continue; }
    if (arg === '--screen') { options.screen = argv[i + 1] ?? null; i += 1; continue; }
    if (arg === '--state') { options.state = argv[i + 1] ?? null; i += 1; continue; }
    if (arg === '--all-screens') { options.allScreens = true; continue; }
    if (arg === '--all-states') { options.allStates = true; continue; }
    if (arg === '--png') { options.kinds.add('png'); continue; }
    if (arg === '--json') { options.kinds.add('json'); continue; }
    if (arg === '--flow') { options.kinds.add('flow'); continue; }
    if (arg === '--check-twice') { options.checkTwice = true; continue; }
    if (arg === '--force') { options.force = true; continue; }
    if (arg === '--keep-work') { options.keepWork = true; continue; }
    if (arg === '--timeout-ms') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new CliError(`--timeout-ms 要一个正数，收到 ${JSON.stringify(argv[i + 1])}`, EXIT.usage);
      options.timeoutMs = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new CliError(`不认识的参数 ${JSON.stringify(arg)}（--help 看用法）`, EXIT.usage);
    if (options.doc !== null) throw new CliError(`只接一份文档，多了 ${JSON.stringify(arg)}（--help 看用法）`, EXIT.usage);
    options.doc = arg;
  }
  return options;
}

// ── 小工具：临时目录 / 端口 / 私有浏览器环境 ────────────────────────────────────────────────
/**
 * 候选工作根，**按顺序**试：继承来的临时目录（TMPDIR/TEMP）**放第一位** —— 调用方说了算，只要放得下就用它
 * （测试沙箱就靠这条把自己的 work 目录圈在自己那一份里）；放不下才轮到短根。
 */
function tempRootCandidates() {
  const list = [];
  const push = (dir) => { if (typeof dir === 'string' && dir.length > 0 && !list.includes(dir)) list.push(dir); };
  push(os.tmpdir());
  if (POSIX) { push('/tmp'); push('/var/tmp'); push('/dev/shm'); }
  return list;
}

/**
 * [SEAM:cli-work-root] 工作根要挑一个 Chromium **放得下它的单例 socket** 的地方。
 * 为什么必须挑（2026-09-25 实测）：socket 路径 ≥ 108 字节时 Chromium **自己**
 * `FATAL … process_singleton_posix.cc:313 Socket path too long` 并当场 **SIGABRT**（work 58 ⇒ 107 正常、
 * work 59 ⇒ 108 崩）—— 而旧代码只看 `exitCode`（信号死时为 `null`），于是一次 ~200 ms 的崩溃被读成
 * 「调试端点 30 s 没起来」＋收尾说「Chromium 可能还在」（两条都是假的，真原因就在它已经捕获却没打印的 stderr 里）。
 * 口径：**能放下的根就按顺序用第一个**；一个也放不下就回退（并把「放不下」这件事说出来，失败时如实快报）。
 * `DESIGNER_CLI_TMP_ROOT` 是给人和门的一个**显式**口子：设了就不自动换根（你说用哪个就用哪个）。
 */
function tempRoot() {
  const name = `${WORK_PREFIX}${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const pinned = (process.env.DESIGNER_CLI_TMP_ROOT ?? '').trim();
  const roots = pinned ? [pinned] : tempRootCandidates();
  const attempts = [];
  for (const root of roots) {
    const work = path.join(root, name);
    const socketLen = POSIX ? socketPathLength(work) : null;
    const fits = socketLen === null || socketLen < SOCKET_PATH_LIMIT;
    let error = null;
    try { mkdirSync(work, { recursive: true }); } catch (cause) { error = cause?.message ?? String(cause); }
    attempts.push({ root, work, socketLen, fits, created: error === null, error });
    if (error === null && fits) {
      return { work, root, socketLen, fits: true, pinned: Boolean(pinned), attempts, relocated: attempts.length > 1 };
    }
    if (error === null) rmSync(work, { recursive: true, force: true });   // 放不下的根不留空壳
  }
  // 一个也放不下（或都建不出来）：回退到第一个**建得出来**的根；连那个也没有就用继承来的那个，让它自己去报错。
  const fallback = attempts.find((attempt) => attempt.created)
    ?? { root: os.tmpdir(), work: path.join(os.tmpdir(), name), socketLen: POSIX ? socketPathLength(path.join(os.tmpdir(), name)) : null };
  mkdirSync(fallback.work, { recursive: true });
  return { ...fallback, fits: false, pinned: Boolean(pinned), attempts, relocated: false };
}

/**
 * 起浏览器时给它一份**私有**环境（HOME / TMPDIR / TEMP / XDG_* 全指向本次工作目录）——
 * 与 `test/harness.mjs` 的 `browserSandboxEnv()` 同一条口径，理由也一样（实测踩过）：
 *   · 不隔离 TMPDIR ⇒ 每次起浏览器都往**共享临时目录**里丢 `org.chromium.Chromium.*`；
 *   · 不隔离 HOME/XDG ⇒ crashpad 的 `--database` 指向你真 `~/.config/chromium/Crash Reports` 并真的往里写。
 * 本文件在 `bin/`，不受 `test/harness-contract.mjs` 那条扫描管 —— 但**照样照做**：这不是为了过门。
 */
function browserEnv(work) {
  const dirs = { home: path.join(work, 'home'), tmp: path.join(work, 'tmp'), xdgConfig: path.join(work, 'xdg-config'), xdgCache: path.join(work, 'xdg-cache') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_CACHE_HOME: dirs.xdgCache,
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = dirs.home;
    env.LOCALAPPDATA = path.join(dirs.home, 'AppData', 'Local');
  }
  return { env, dirs };
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/** 只服务 `<仓库>/web` 的静态服务（与产品侧 `server/app.mjs` 给 `/designer.html` 那条口径一致：站点根就是 `web/`）。 */
function serveWeb() {
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
    } catch { response.writeHead(400).end(); return; }
    const file = path.resolve(WEB_ROOT, `.${pathname}`);
    if (file !== WEB_ROOT && !file.startsWith(`${WEB_ROOT}${path.sep}`)) { response.writeHead(403).end(); return; }
    try {
      const body = readFileSync(file);
      response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404).end(); }
  });
  return server;
}

// ── CDP 客户端（几十行；不引第三方库，用 Node 内置 WebSocket）────────────────────────────────
function connectCdp(wsUrl, { timeoutMs }) {
  const socket = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
  const waiters = [];
  const events = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return;
      if (message.error) waiter.reject(new Error(`CDP ${waiter.method} 失败：${message.error.message}（code ${message.error.code}）`));
      else waiter.resolve(message.result);
      return;
    }
    events.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.method !== message.method) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message.params);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', (error) => reject(new Error(`CDP 连接失败：${error?.message ?? String(error)}`)));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (sequence += 1);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} 在 ${timeoutMs}ms 内没有回应`));
    }, timeoutMs);
    pending.set(id, {
      method,
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    ready,
    send,
    events,
    close: () => { try { socket.close(); } catch { /* 已经关了 */ } },
  };
}

/** 页面里抛出的错要能被读成人话（`exceptionDetails.exception.description` 是那一行栈的头部）。 */
function pageErrorMessage(details) {
  const text = details?.exception?.description ?? details?.text ?? '(页面没有给描述)';
  return String(text).split('\n')[0].trim();
}

/**
 * [SEAM:cli-page-error] —— 页面里抛出的错（CDP 回执里的 `exceptionDetails`）**必须**当成这次调用的失败。
 * 反证臂 `cli-swallows-errors` 把下面这一行换成「什么都不做」（`if (details) return;`）⇒ 坏文档会被**假装成功**、
 * CLI 退 0 ⇒ 门里 `cli:bad-doc-exit` / `cli:bad-doc-no-half-products` 必红。
 */
function pageResultOrThrow(reply, what, code = EXIT.pageFailed) {
  const details = reply?.exceptionDetails;
  if (details) throw new CliError(`${what}：页面抛了 —— ${pageErrorMessage(details)}`, code);
  return reply?.result?.value;
}

// ── 页面侧：捕获「页面自己发的那次下载」──────────────────────────────────────────────────────
// 页面导出的唯一出口是 `downloadBlob()`（`URL.createObjectURL` ＋ `<a download>` ＋ `anchor.click()`）。
// 我们**不改页面**：只是在一份注入脚本里把 `HTMLAnchorElement.prototype.click` 包一层，把那次下载
// 记在 `window.__dzCli.downloads` 里（不真的落盘），随后从页面里 `fetch(blob:)` 把字节读回来。
// ⇒ 产物 = 页面**当场**渲染出来的字节，本 CLI 一个像素都不自己算。
const CAPTURE_SOURCE = `(() => {
  const state = { downloads: [], pageErrors: [] };
  window.__dzCli = state;
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(...args) {
    if (this.download && typeof this.href === 'string' && this.href.startsWith('blob:')) {
      state.downloads.push({ name: this.download, href: this.href, at: Date.now() });
      return undefined;
    }
    return originalClick.apply(this, args);
  };
  window.addEventListener('error', (event) => state.pageErrors.push(String(event.message ?? event.error)));
  window.addEventListener('unhandledrejection', (event) => state.pageErrors.push(String(event.reason)));
})();`;

// ── 产物命名（本 CLI 自己定，**确定性**：同名策略才有意义）─────────────────────────────────
// 页面给的产物名带时间戳（`design-<屏名>-<状态名>-YYYYMMDD-HHMMSS.<ext>`），CLI 另起一套确定性名字。
// 多屏多状态之后，**名字必须能区分**（否则后一份把前一份盖掉，回执说的跟盘上的就不是一回事），
// 所以 HTML / SVG / PNG 一律带屏/状态：
//     `design-<文档基名>.<屏 id>.<状态 id>.{html,svg,png}`
// `--json` 与 `--flow` 是**整份文档**（不是某一屏/某一状态）⇒ 不带屏/状态后缀，各只有一份：
//     `design-<文档基名>.json` / `design-<文档基名>.flow.svg`
// 屏/状态 id 是自由字符串，所以要做**单射**的转义（转义规则也就是文档 `docs/design/designer-agent.md` §7 里那一行）：
//   · 保留 `A-Za-z0-9`、`_`、`-`；
//   · **一切其它字符**（含 `.` 与非 ASCII）按 **UTF-8 字节** 写成 `%XX`（大写十六进制）。
//   · 为什么连 `.` 也不留：它就是分隔符 —— 留着它屏 `a.b` + 状态 `c` 与屏 `a` + 状态 `b.c` 会撞成同一个名字。
const ARTIFACT_EXT = { html: 'html', svg: 'svg', png: 'png', json: 'json', flow: 'flow.svg' };
const SAFE_ID_CHAR = /^[A-Za-z0-9_-]$/;
const ID_ESCAPE_ENCODER = new TextEncoder();
function idSegment(value) {
  const bytes = ID_ESCAPE_ENCODER.encode(String(value ?? ''));
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    out += byte < 0x80 && SAFE_ID_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}
function artifactName(docBase, kind, target) {
  if (kind === 'json' || kind === 'flow') return `design-${docBase}.${ARTIFACT_EXT[kind]}`;
  return `design-${docBase}.${idSegment(target.screenId)}.${idSegment(target.stateId)}.${ARTIFACT_EXT[kind]}`;
}

// ── 目标规划（`--screen` / `--state` / `--all-screens` / `--all-states`）──────────────────────
// 规划吃的是**这份文档自己的屏表**（setDoc 之后的屏表也就是它：id/名字一个不改）。
// 文档连 `screens` 数组都不是 ⇒ 返回 `null`：那一份交给**页面自己的 setDoc** 去拒（本 CLI 不另写一份校验器）。
const PER_TARGET_KINDS = ['html', 'svg', 'png'];
const DOC_KINDS = ['json', 'flow'];
/** 如实报「有哪些屏/状态」用的小工具（错误信息里点名，不让人去猜）。 */
const screenLabel = (screen) => `${screen.id}${screen.name ? `（${screen.name}）` : ''}`;
const stateLabel = (st) => `${st.id}${st.name ? `（${st.name}）` : ''}`;
const labelList = (items, label) => (items.length > 0 ? items.map(label).join(' / ') : '（一个都没有）');
function planTargets(doc, options) {
  const screens = (Array.isArray(doc?.screens) ? doc.screens : []).filter((screen) => screen && typeof screen.id === 'string');
  if (screens.length === 0) return null;

  const pickScreen = (value) => {
    const byId = screens.filter((screen) => screen.id === value);
    if (byId.length === 1) return byId[0];
    const byName = screens.filter((screen) => screen.name === value);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new CliError(`--screen 给的是 ${JSON.stringify(value)}：这份文档里有 ${byName.length} 个屏都叫这个名字（${labelList(byName, screenLabel)}）—— 名字有歧义，请给 id`, EXIT.usage);
    }
    throw new CliError(`--screen 给的是 ${JSON.stringify(value)}：这份文档里没有这个屏 id、也没有这个屏名。\n  这份文档有的屏（${screens.length} 个）：${labelList(screens, screenLabel)}`, EXIT.usage);
  };
  const statesOf = (screen) => (Array.isArray(screen.states) ? screen.states : []).filter((st) => st && typeof st.id === 'string');
  const pickState = (screen, states, value) => {
    const byId = states.filter((st) => st.id === value);
    if (byId.length === 1) return byId[0];
    const byName = states.filter((st) => st.name === value);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new CliError(`--state 给的是 ${JSON.stringify(value)}：屏 ${screenLabel(screen)} 上有 ${byName.length} 个状态都叫这个名字（${labelList(byName, stateLabel)}）—— 名字有歧义，请给 id`, EXIT.usage);
    }
    throw new CliError(`--state 给的是 ${JSON.stringify(value)}：屏 ${screenLabel(screen)} 上没有这个状态 id、也没有这个状态名。\n  这一屏有的状态（${states.length} 个）：${labelList(states, stateLabel)}`, EXIT.usage);
  };

  const chosenScreens = options.allScreens ? screens : [options.screen === null ? screens[0] : pickScreen(options.screen)];
  const targets = [];
  for (const screen of chosenScreens) {
    const states = statesOf(screen);
    if (states.length === 0) {
      throw new CliError(`屏 ${screenLabel(screen)} 一个状态都没有 —— 出不了「那一屏的某一份」（这份文档的 screens[].states 是空的）`, EXIT.usage);
    }
    let chosen;
    if (options.allStates) {
      chosen = states;
    } else if (options.state !== null) {
      chosen = [pickState(screen, states, options.state)];
    } else {
      chosen = [states[0]];
    }
    for (const st of chosen) targets.push({ screenId: screen.id, stateId: st.id, screenName: screen.name ?? null, stateName: st.name ?? null });
  }
  return targets;
}
/** 产物清单（顺序确定：先按屏/状态、再按格式；整份文档的那几份跟在最后）＋**产物名撞车就拒**（不静默覆盖）。 */
function buildArtifacts(outDir, docBase, targets, kinds) {
  const list = [];
  for (const target of targets) {
    for (const kind of kinds.filter((candidate) => PER_TARGET_KINDS.includes(candidate))) {
      list.push({ kind, target, file: path.join(outDir, artifactName(docBase, kind, target)) });
    }
  }
  for (const kind of kinds.filter((candidate) => DOC_KINDS.includes(candidate))) {
    list.push({ kind, target: null, file: path.join(outDir, artifactName(docBase, kind, null)) });
  }
  const seen = new Map();
  for (const entry of list) {
    const previous = seen.get(entry.file);
    if (previous) {
      throw new CliError(`产物名撞车：${entry.file}\n  · ${previous}\n  · ${describeTarget(entry.target)}\n`
        + '（屏/状态 id 转义之后仍然后一份盖前一份 ⇒ 一个字节都不写；这份文档里是不是有两个屏/状态叫同一个 id？）', EXIT.internal);
    }
    seen.set(entry.file, describeTarget(entry.target));
  }
  return list;
}
const describeTarget = (target) => (target ? `屏 ${target.screenId} · 状态 ${target.stateId}` : '整份文档');

// ── 收尾：整棵树**真的没了** → 才删工作目录 → 删完复核（回执只写量到的事实）─────────────────
/**
 * 只读地列出「还引用着这个路径」的进程（Linux `/proc`；**只看，不按名字杀**）。
 * 看两处：**命令行**（`--user-data-dir=<work>/chromium` / crashpad 的 `--database=<work>/…`）与**环境**
 * （浏览器那棵树**全部**继承了 `HOME=<work>/home` / `TMPDIR=<work>/tmp` —— 与 `browserEnv()` 那一条口径同源），
 * 所以「不在命令行里」的那类进程也跑不掉。
 * 为什么需要它（实测踩到）：真 `chrome_crashpad_handler` **自己 setsid**（实测 ppid=1、pgid=它自己）⇒ 它
 * **不在**浏览器那个进程组里，按组杀杀不到它；而它的 shutdown flush 会往 `<work>/chromium/Default/…` 写回来
 * —— 那正是「回执说已删、盘上还在」那条红（受控负载下复现到过：回执「已删」、盘上一个 `chromium/` 还在）。
 * 判据是**本次 work 目录那个唯一的名字**（含 pid ＋ 随机后缀），不是进程名：绝不 `pkill` / `pgrep -f`。
 * 没有 `/proc` 的平台返回 `null`（量不了就说量不了，不拿「应该没了」充数）。
 */
function processesReferencing(work) {
  if (!POSIX || !existsSync('/proc')) return null;
  const found = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline = null;
    try { cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8'); } catch { continue; }
    if (cmdline.includes(work)) { found.push(Number(entry)); continue; }
    let environ = null;
    try { environ = readFileSync(`/proc/${entry}/environ`, 'utf8'); } catch { continue; }
    if (environ.includes(work)) found.push(Number(entry));
  }
  return found;
}
/** 那个进程组还在不在（`kill(-pgid, 0)`；ESRCH ⇒ 组空了）。pid 不是组长时同样是 ESRCH ⇒ 安全的否定。 */
function groupAlive(pid) {
  if (!POSIX || !Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
/**
 * 发一次收尾信号：POSIX 先按**进程组**（`detached` 起的就是组长 ⇒ `-pid` 是整棵树），
 * Windows 用 `taskkill /PID … /T /F`；然后按**精确 pid** 补刀那些逃出进程组、但还引用着本 work 的进程（命令行或环境）。
 */
function signalTree(child, work, signal) {
  const sent = { group: false, pids: [] };
  if (Number.isInteger(child?.pid) && child.pid > 0) {
    if (POSIX) { try { process.kill(-child.pid, signal); sent.group = true; } catch { /* ESRCH：组早没了 */ } }
    else { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); sent.group = true; }
  }
  for (const pid of processesReferencing(work) ?? []) {
    if (pid === process.pid) continue;
    try { process.kill(pid, signal); sent.pids.push(pid); } catch { /* 已经没了 */ }
  }
  return sent;
}
/** 「进程已退出」这件事：`exitCode` 与 `signalCode` **二者必居其一** —— 漏了后者就永远等不到退出。 */
const departed = (child) => !child || child.exitCode !== null || child.signalCode !== null;
/** 「它怎么死的」——回执要写**量到的**那一种，不许一律写「可能还在」。 */
const deathOf = (child) => (child?.signalCode !== null && child?.signalCode !== undefined
  ? `signalCode=${child.signalCode}` : `exitCode=${child?.exitCode ?? '?'}`);

/**
 * 收尾：① 信号那棵树（按组 ＋ 按被 work 路径引用的 pid）；② **等整棵树真的没了**
 * （直接子进程退出 ＋ 进程组空 ＋ 没有别的进程还引用着 work）；③ 才删工作目录；④ 删完**复核**一次。
 * 回执里的每个字段都是量到的：`exited`/`death`/`groupAlive`/`referrers`/`workRemoved`/`workRemovalAttempts`。
 */
async function stopBrowser(child, work, keepWork, { graceMs = 5000, settleMs = 2000, verifyMs = 300 } = {}) {
  const receipt = { pid: child?.pid ?? null, signalled: null, escalated: false, exited: departed(child), death: null,
    groupAlive: null, referrers: null, workRemoved: false, workRemovalAttempts: 0, workVerifiedAfterMs: null, workCameBack: false };
  if (!departed(child) || (processesReferencing(work) ?? []).length > 0) {
    receipt.signalled = signalTree(child, work, 'SIGTERM');
    const waitTreeGone = async (budgetMs) => {
      const deadline = Date.now() + budgetMs;
      for (;;) {
        const referrers = processesReferencing(work) ?? [];
        if (departed(child) && referrers.length === 0 && groupAlive(child?.pid ?? null) !== true) return true;
        if (Date.now() >= deadline) return false;
        await sleep(50);
      }
    };
    if (!(await waitTreeGone(graceMs))) {
      receipt.escalated = true;
      receipt.signalled = signalTree(child, work, 'SIGKILL');
      await waitTreeGone(settleMs);
    }
  }
  receipt.exited = departed(child);
  receipt.death = receipt.exited ? deathOf(child) : null;
  receipt.groupAlive = groupAlive(child?.pid ?? null);
  receipt.referrers = processesReferencing(work);
  if (keepWork) return receipt;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    receipt.workRemovalAttempts = attempt;
    try {
      rmSync(work, { recursive: true, force: true });
    } catch (error) {
      warn(`[designer-cli] 删临时工作目录失败（第 ${attempt} 次）：${error?.message ?? String(error)}`);
    }
    if (!existsSync(work)) { receipt.workRemoved = true; break; }
    await sleep(200);
  }
  if (receipt.workRemoved) {
    // 删完**复核**：说「已删」就得真的是空的 —— 还有人在往里面写时，这一读会看见它。
    await sleep(verifyMs);
    receipt.workVerifiedAfterMs = verifyMs;
    if (existsSync(work)) {
      receipt.workRemoved = false;
      receipt.workCameBack = true;
      warn(`[designer-cli] ⚠ 工作目录删掉之后又被写回来了（还有进程在往里面写）：${work}`);
    }
  }
  return receipt;
}

/** 等浏览器调试端点起来（拿到一个页目标的 ws 地址）。 */
async function waitForDebugTarget(debugPort, { timeoutMs, child, stderrTail }) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = '还没试';
  const stderrSuffix = () => (stderrTail() ? `\n它的 stderr 末尾（真原因常常就在这几行里）：\n${stderrTail()}` : '（它一个字都没往 stderr 打）');
  while (Date.now() < deadline) {
    if (child?.spawnError) {
      throw new CliError(`Chromium 起不来：${child.spawnError.message}`, EXIT.env);
    }
    // ⚠️ 被**信号**杀掉的子进程 `exitCode` 仍是 `null`（`signalCode` 才是那一半）—— 只看 `exitCode` 就永远
    //    等不到「进程已退出」，一次 ~200 ms 的 SIGABRT 会被读成「30 s 没起来」（2026-09-25 实测踩过）。
    if (departed(child)) {
      throw new CliError(`Chromium 起不来：进程已退出（${deathOf(child)}）${stderrSuffix()}`, EXIT.env);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
      lastReason = `调试端点起来了，但没有 page 目标（收到 ${targets.length} 个）`;
    } catch (error) {
      lastReason = error?.message ?? String(error);
    }
    await sleep(100);
  }
  // 超时那条错里也要带**量到的**事实：进程到底退了没有（怎么退的）＋它已经打出来的 stderr 尾部。
  throw new CliError(`Chromium 的调试端点在 ${timeoutMs}ms 内没起来（127.0.0.1:${debugPort}）：${lastReason}`
    + (departed(child) ? `；进程**已经退出**（${deathOf(child)}）` : '；进程还在（一直没退）')
    + stderrSuffix(), EXIT.env);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────────────────
async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { log(USAGE); return EXIT.ok; }
  if (!options.doc) throw new CliError(`缺文档（第一个位置参数）：--help 看用法`, EXIT.usage);
  if (!options.out) throw new CliError('缺 --out <目录>（产物写哪儿）：--help 看用法', EXIT.usage);

  const docPath = path.resolve(options.doc);
  if (!existsSync(docPath)) throw new CliError(`找不到文档 ${docPath}`, EXIT.usage);
  if (path.extname(docPath).toLowerCase() !== '.json') throw new CliError(`文档要是 .json（收到 ${path.basename(docPath)}）`, EXIT.usage);
  const raw = readFileSync(docPath, 'utf8');
  let localDoc = null;
  try {
    localDoc = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`文档不是合法 JSON（${error?.message ?? String(error)}）`, EXIT.badDoc);
  }

  // 互斥组合先说清楚（不静默取一半）
  if (options.allScreens && options.screen !== null) throw new CliError('--screen 与 --all-screens 不能同时给（前者只出一屏、后者每屏都出）：--help 看用法', EXIT.usage);
  if (options.allStates && options.state !== null) throw new CliError('--state 与 --all-states 不能同时给（前者只出一个状态、后者每个状态都出）：--help 看用法', EXIT.usage);

  const outDir = path.resolve(options.out);
  const docBase = path.basename(docPath, path.extname(docPath));
  const kinds = ['html', 'svg', 'png', 'json', 'flow'].filter((kind) => options.kinds.has(kind));
  // 规划：文档有可用的屏表就在**起浏览器之前**把它算出来（无效的 --screen/--state 退 2，不白起一次浏览器；
  // 也拿它先查一遍同名产物）。文档连 screens 都不是 ⇒ `null`，交给页面自己的 setDoc 去拒。
  let targets = planTargets(localDoc, options);
  let plan = targets === null ? null : buildArtifacts(outDir, docBase, targets, kinds);

  // **先查再跑**：已有同名产物就当场拒绝（不覆盖是默认；也免得白起一次浏览器）
  const existing = (plan ?? []).filter((entry) => existsSync(entry.file));
  if (existing.length > 0 && !options.force) {
    throw new CliError(`--out 里已经有同名产物，**不覆盖**（要覆盖就加 --force）：\n${existing.map((entry) => `  · ${entry.file}`).join('\n')}`, EXIT.exists);
  }
  if (existing.length > 0) log(`[designer-cli] --force：会覆盖 ${existing.length} 个已有产物`);

  const chromeBin = process.env.CHROME_BIN || '/usr/bin/chromium';
  if (!existsSync(chromeBin)) {
    throw new CliError(`Chromium 不在 ${chromeBin} —— 用 CHROME_BIN 指过去（例如 CHROME_BIN='C:/Users/<你>/AppData/Local/Chromium/Application/chrome.exe'）`, EXIT.env);
  }

  const workInfo = tempRoot();
  const work = workInfo.work;
  log(`[designer-cli] 文档：${docPath}（${Buffer.byteLength(raw)} 字节）`);
  log(`[designer-cli] work: ${work}`);
  if (workInfo.relocated) {
    log(`[designer-cli] · 换根：继承的临时目录（${os.tmpdir()}）放不下 Chromium 的单例 socket ⇒ 换到短根 ${workInfo.root}`
      + `（socket 路径 = len(work)+49 = ${workInfo.socketLen} 字节 < ${SOCKET_PATH_LIMIT}）`);
  }
  if (!workInfo.fits) {
    warn(`[designer-cli] ⚠ 工作根 ${workInfo.root} 放不下 Chromium 的单例 socket：socket 路径 = len(work)+49 = ${workInfo.socketLen} 字节 ≥ ${SOCKET_PATH_LIMIT}`
      + `（${workInfo.pinned ? 'DESIGNER_CLI_TMP_ROOT 是你自己指定的，不替你换' : '没有别的可用的短根'}）`
      + '—— Chromium 多半会自己 LOG(FATAL) 并 SIGABRT；真起不来时下面会如实快报（含 signalCode 与它的 stderr 尾部）');
  }

  const { env } = browserEnv(work);
  const staticPort = await reservePort();
  const debugPort = await reservePort();
  const server = serveWeb();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(staticPort, '127.0.0.1', resolve);
  });

  let stderrText = '';
  const child = spawn(chromeBin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(work, 'chromium')}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env,
    // [SEAM:cli-process-group] 浏览器**自己一个进程组**（POSIX 的 `detached`）⇒ 收尾能按组把整棵树停掉
    // （`process.kill(-pid, …)`），与 `test/sandbox-guard.mjs` 同一个手法。不 detached 的实测后果：真 Chromium
    // 那棵树挂在**调用它的进程的**进程组里（pgid ≠ 它自己的 pid）⇒ 事后按组清是不成立的（`kill(-pid)` 直接 ESRCH）。
    detached: POSIX });
  child.on('error', (error) => { child.spawnError = error; });
  child.stderr?.on('data', (chunk) => { stderrText = `${stderrText}${chunk}`.slice(-4000); });
  log(`[designer-cli] 起浏览器：${chromeBin}（pid=${child.pid}）`);
  if (child.spawnError) {
    throw new CliError(`Chromium 起不来：${child.spawnError.message}`, EXIT.env);
  }

  let cdp = null;
  let cleanupReceipt = null;
  try {
    const target = await waitForDebugTarget(debugPort, { timeoutMs: options.timeoutMs, child, stderrTail: () => stderrText.trim() });
    cdp = connectCdp(target.webSocketDebuggerUrl, { timeoutMs: options.timeoutMs });
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SOURCE });

    const evaluate = async (expression, what, code) => {
      let reply = null;
      try {
        reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      } catch (error) {
        throw new CliError(`${what}：CDP 调用失败 —— ${error?.message ?? String(error)}`, EXIT.env);
      }
      return pageResultOrThrow(reply, what, code);
    };

    const loaded = await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticPort}/designer.html` }).then(() => true, () => false);
    if (!loaded) throw new CliError('页面导航没发出去（CDP Page.navigate 失败）', EXIT.env);

    const readyDeadline = Date.now() + options.timeoutMs;
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        ready = (await cdp.send('Runtime.evaluate', { expression: 'window.__dzReady === true && typeof window.sophoDesigner === "object"', returnByValue: true })).result?.value === true;
      } catch { ready = false; }
      if (ready) break;
      if (departed(child)) throw new CliError(`浏览器在页面 ready 之前就退出了（${deathOf(child)}）${stderrText.trim() ? `；stderr 末尾：${stderrText.trim()}` : '（它一个字都没往 stderr 打）'}`, EXIT.env);
      await sleep(100);
    }
    if (!ready) throw new CliError(`/designer.html 在 ${options.timeoutMs}ms 内没有 ready（window.__dzReady / window.sophoDesigner 没出现）`, EXIT.env);
    log('[designer-cli] 页面 ready：/designer.html 上的 window.sophoDesigner 在场');

    // ③ 把文档交给**页面自己**的 setDoc（与「导入 JSON」同一个校验器）
    let receipt = null;
    try {
      receipt = await evaluate(`window.sophoDesigner.setDoc(${JSON.stringify(raw)})`, 'setDoc 把文档交给页面', EXIT.badDoc);
    } catch (error) {
      if (error instanceof CliError && error.code === EXIT.badDoc) {
        // 只留页面那一句（CDP 的描述会带 `Error: ` 前缀，嵌在我们的包装里读起来很难看）
        const reason = String(error.message).split('页面抛了 —— ').pop().replace(/^Error:\s*/, '');
        throw new CliError(`文档不合法 —— 页面自己的 setDoc 拒了它（与「导入 JSON」同一个校验器）：${reason}`, EXIT.badDoc);
      }
      throw error;
    }
    log(`[designer-cli] setDoc 成功：${receipt?.screens ?? '?'} 屏 / ${receipt?.transitions ?? '?'} 转移（当前屏「${receipt?.screenId ?? '?'}」· 状态「${receipt?.stateId ?? '?'}」，规范字节 ${receipt?.bytes ?? '?'}）`);

    // 文档连 `screens` 都不是 ⇒ 上面那一步已经把它拒了（退 3）；能走到这里就说明页面手里那份文档是可用的。
    // 保险：若是那个分支，现在拿**页面手里那份**（`getDoc()`）再规划一次 —— 用的还是同一个纯函数，不是第二份实现。
    if (plan === null) {
      const docBack = await evaluate('window.sophoDesigner.getDoc()', '读回文档（规划屏/状态）');
      targets = planTargets(docBack, options);
      plan = buildArtifacts(outDir, docBase, targets ?? [], kinds);
    }
    log(`[designer-cli] 目标：${(targets ?? []).length} 个「屏 · 状态」（html/svg/png 按它逐个出）`
      + `＋ 整份文档的 ${(plan ?? []).filter((entry) => !entry.target).length} 份（json/flow）`
      + `${options.checkTwice ? '；--check-twice：每一项导出两次，两份字节必须逐字节相同' : ''}`);

    // ④ 导出（点页面自己的菜单 / 走公开 API）
    //    · HTML / SVG / PNG 是**当前屏 · 当前状态**的 ⇒ 每一份「屏×状态」先 `openScreen()` 切过去、回读确认、再导；
    //    · `--json` / `--flow` 是**整份文档**（与切到哪一屏无关），各导一份。
    //    每一份都先在内存里拿全（`artifacts`），最后才落盘 ⇒ 中途失败不会留下半套。
    const artifacts = [];
    const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
    /** 页面导出一次（点菜单那一项 / 走 `exportDoc()`），把字节读回来。 */
    const pageExport = async (kind) => {
      if (kind === 'json') {
        const text = await evaluate('window.sophoDesigner.exportDoc()', 'exportDoc() 取规范 JSON');
        return { pageName: '(exportDoc()：与菜单里「规范 JSON」同一串字节)', bytes: Buffer.from(String(text), 'utf8') };
      }
      const before = await evaluate('window.__dzCli.downloads.length', '读下载计数');
      await evaluate(`(() => {
        document.querySelector('#dz-export-toggle').click();
        document.querySelector('#dz-export-items [data-export="${kind}"]').click();
        return true;
      })()`, `点导出菜单（${kind}）`);
      let status = null;
      const deadline = Date.now() + options.timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await evaluate(`(() => {
          const status = document.querySelector('#dz-status');
          return { total: window.__dzCli.downloads.length, status: status ? status.textContent : '', kind: status ? (status.dataset.kind ?? null) : null };
        })()`, `读 ${kind} 的导出状态`);
        if (snapshot.total > before) { status = snapshot; break; }
        if (snapshot.kind === 'error') {
          throw new CliError(`页面导出 ${kind} 失败（页面自己如实报的）：${snapshot.status}`, EXIT.pageFailed);
        }
        await sleep(50);
      }
      if (status === null) {
        const text = await evaluate(`document.querySelector('#dz-status')?.textContent ?? ''`, '读状态栏').catch(() => '');
        throw new CliError(`页面在 ${options.timeoutMs}ms 内没有产出 ${kind}（状态栏：${text}）`, EXIT.pageFailed);
      }
      const payload = await evaluate(`(async () => {
        const list = window.__dzCli.downloads;
        const entry = list[list.length - 1];
        const view = new Uint8Array(await (await fetch(entry.href)).arrayBuffer());
        let binary = '';
        for (const byte of view) binary += String.fromCharCode(byte);
        return { name: entry.name, bytes: view.length, base64: btoa(binary) };
      })()`, `读回 ${kind} 的字节（${status.status}）`);
      return { pageName: payload.name, bytes: Buffer.from(payload.base64, 'base64') };
    };
    /**
     * [SEAM:cli-check-twice] —— `--check-twice`：**同一项导出两次**，两份字节必须逐字节相同。
     * 这是上一版报告里自己点名的「没验到」那条的一半：`--png` 那一项**没与「鼠标点菜单」做过逐字节对照** ——
     * 完整对照（拿真鼠标点一次再与 CLI 比）**仍然没做**（见 `docs/design/designer-agent.md` §6），
     * 但「同一次跑里同一项连点两次 ⇒ 同一份字节」这条能做到，而且它正是「这个导出到底是不是确定性的」那个问题。
     */
    const exportOnce = async (kind, where) => {
      const first = await pageExport(kind);
      if (!options.checkTwice) return first;
      const second = await pageExport(kind);
      if (first.bytes.length !== second.bytes.length || !first.bytes.equals(second.bytes)) {
        throw new CliError(`--check-twice：同一项（${kind}${where}）两次导出的字节不同 —— `
          + `第一次 ${first.bytes.length} 字节 sha256=${sha256(first.bytes)}；第二次 ${second.bytes.length} 字节 sha256=${sha256(second.bytes)}`
          + ' ⇒ 产物不是确定性的，不当成成功，一个字节都不写', EXIT.internal);
      }
      log(`[designer-cli] · 确定性自检（--check-twice）：${kind}${where} 同一项两次导出的字节逐字节相同（${first.bytes.length} 字节，sha256=${sha256(first.bytes).slice(0, 16)}…）`);
      return first;
    };
    // 逐份导出；`plan` 的顺序 = 先每一份「屏×状态」的 HTML/SVG/PNG（按屏/状态切过去），再整份文档的 JSON/转移图。
    let current = null;
    for (const entry of plan ?? []) {
      const started = Date.now();
      const where = entry.target ? `（屏 ${entry.target.screenId} · 状态 ${entry.target.stateId}）` : '（整份文档）';
      if (entry.target && (!current || current.screenId !== entry.target.screenId || current.stateId !== entry.target.stateId)) {
        // 与点左栏那两行**同一条路**（页面自己的 API）：切屏 / 切状态是页面自己的事
        await evaluate(`window.sophoDesigner.openScreen(${JSON.stringify(entry.target.screenId)}, ${JSON.stringify(entry.target.stateId)})`,
          `openScreen(${entry.target.screenId}, ${entry.target.stateId})`);
        const live = await evaluate('window.sophoDesigner.getState()', '回读当前屏 · 状态');
        if (live?.screenId !== entry.target.screenId || live?.stateId !== entry.target.stateId) {
          throw new CliError(`要求切到屏 ${entry.target.screenId} · 状态 ${entry.target.stateId}，页面回读的却是屏 ${live?.screenId} · 状态 ${live?.stateId}`
            + ' —— 页面没切过去，这一份导出来会是别的屏/状态，不当成成功，一个字节都不写', EXIT.pageFailed);
        }
        current = entry.target;
        log(`[designer-cli] 切到屏 ${entry.target.screenId}（${entry.target.screenName ?? ''}）· 状态 ${entry.target.stateId}（${entry.target.stateName ?? ''}）`);
      }
      const exported = await exportOnce(entry.kind, where);
      artifacts.push({ kind: entry.kind, file: entry.file, target: entry.target, pageName: exported.pageName, bytes: exported.bytes });
      log(`[designer-cli] ✓ ${entry.kind.padEnd(4)} ${entry.file}（${exported.bytes.length} 字节，${Date.now() - started}ms；${entry.target ? `屏 ${entry.target.screenId} · 状态 ${entry.target.stateId}` : '整份文档'}；页面给的产物名 ${exported.pageName}）`);
    }

    // 页面自己的未捕获异常：如实报出来（不当成成功的一部分）
    const pageErrors = await evaluate('window.__dzCli.pageErrors.slice(0, 10)', '读页面自己的未捕获异常').catch(() => []);
    if (Array.isArray(pageErrors) && pageErrors.length > 0) {
      warn(`[designer-cli] ⚠ 页面抛过 ${pageErrors.length} 次：${pageErrors.map((text) => String(text).split('\n')[0]).join(' / ')}`);
    }

    // 转移图里那些**画不出来的**转移，页面那条导出路径是**静默跳过**的（`flowSvg()` 里 `if (!from || !to) continue;`）。
    // 我们不替页面改行为（也不把退码改掉：产物就是页面给的），但**不许让它静默** —— 拿页面交回来的那份文档自己核一遍，
    // 缺哪条就点名哪条（上游那个根因通常是「两端少写了 `state`」——冻结 v0 里 `from`/`to` 是 `{screen, state}`）。
    const flowArtifact = artifacts.find((artifact) => artifact.kind === 'flow');
    if (flowArtifact) {
      const docBack = await evaluate('window.sophoDesigner.getDoc()', '读回文档（核转移图里的箭头）');
      const flowText = flowArtifact.bytes.toString('utf8');
      const allTransitions = docBack?.transitions ?? [];
      const missing = allTransitions.filter((transition) => !flowText.includes(`data-transition="${transition.id}"`));
      for (const transition of missing) {
        warn(`[designer-cli] ⚠ 转移图里没有 ${JSON.stringify(transition.id)} 的箭头 —— 页面那条导出路径遇到「两端有一头指不出节点」的转移是**静默跳过**的（两端要写成 {screen, state}；这份文档给的是 from=${JSON.stringify(transition.from)} → to=${JSON.stringify(transition.to)}）`);
      }
      if (missing.length > 0) {
        warn(`[designer-cli] ⚠ 共 ${missing.length} 条转移没画出来（文档里一共 ${allTransitions.length} 条）—— 产物照常写出（那是页面给的），这一行只是把它**说出来**`);
      }
    }

    // ⑤ 落盘：**要么全写、要么一个都不写** —— 字节已经在内存里了，这一步只做「先逐份查空、再写」。
    const empty = artifacts.filter((artifact) => artifact.bytes.length === 0);
    if (empty.length > 0) {
      throw new CliError(`页面给出的产物里有 0 字节的（${empty.map((artifact) => artifact.kind).join(' / ')}）—— 不当成成功，一个字节也不写`, EXIT.pageFailed);
    }
    mkdirSync(outDir, { recursive: true });
    for (const artifact of artifacts) {
      writeFileSync(artifact.file, artifact.bytes);
    }
    log(`[designer-cli] 产物（${artifacts.length} 个，都在 ${outDir}）：`);
    for (const artifact of artifacts) {
      log(`  · ${artifact.file}  ${artifact.bytes.length} 字节  ${artifact.kind}`);
    }
    return EXIT.ok;
  } finally {
    if (cdp) cdp.close();
    try { server.close(); } catch { /* 已经关了 */ }
    cleanupReceipt = await stopBrowser(child, work, options.keepWork);
    const groupText = cleanupReceipt.groupAlive === null ? '（本平台量不了）' : (cleanupReceipt.groupAlive ? '**还在**' : '已空');
    const refsText = cleanupReceipt.referrers === null ? '（本平台量不了）' : `${cleanupReceipt.referrers.length} 个`;
    log(`[designer-cli] cleanup: ${cleanupReceipt.workRemoved || options.keepWork ? 'ok' : 'partial'} —— Chromium(pid=${cleanupReceipt.pid}) ${cleanupReceipt.exited ? `已结束${cleanupReceipt.death ? `（${cleanupReceipt.death}）` : ''}` : '**可能还在**'}`
      + `；进程组 ${groupText}；命令行/环境里还引用着这个 work 目录的进程 ${refsText}`
      + `；工作目录 ${options.keepWork ? '按 --keep-work 保留' : (cleanupReceipt.workRemoved ? `已删（删后复核 ${cleanupReceipt.workVerifiedAfterMs}ms 仍是空的）` : (cleanupReceipt.workCameBack ? '**删了又被写回来**' : '**没删掉**'))}（${work}）`);
  }
}

// ── 顶层：把 CliError 翻译成「原因 ＋ 退出码」；其它异常如实按 1 报（不假装成功）────────────────
try {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  const code = error instanceof CliError ? error.code : EXIT.internal;
  warn(`[designer-cli] 失败（exit ${code}）：${error?.message ?? String(error)}`);
  if (!(error instanceof CliError)) warn(error?.stack ?? String(error));
  process.exitCode = code;
}
