// test/ui-harness.mjs —— web/ 前端契约门共用的「真 Chromium + 假 API + 静态服务」底座。
// 它只负责起停与 CDP 语法糖；每个门的假 API 由调用方用 routes() 提供。
// 纪律与 test/harness.mjs 一致：随机高位端口、临时 user-data-dir、**私有 TMPDIR/home/XDG**
// （`browserSandboxEnv`，见下面 spawn 处与 `test/browser-sandbox-isolation.mjs`）、只按本次 spawn 的 pid 停。
// 收尾纪律（2026-09-22）：等自己这棵树真的退出 → 删**自己的**沙箱（运行令牌校验）→ 删完再核；
// 判归属一律靠**带内标记**（精确 pid / 自己的 profile 目录 / 运行令牌），不靠「清单做差集」。
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, browserSandboxPaths, processStateOf, processTable, quiesceCdpPage } from './harness.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_ROOT = path.join(ROOT, 'web');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

export async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

export async function waitFor(fn, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(40);
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function cdp(wsUrl, pageProblems) {
  const socket = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      pageProblems.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      pageProblems.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    send(method, params = {}) {
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    once(method) {
      return new Promise((resolve) => {
        const listener = (params) => {
          listeners.get(method).delete(listener);
          resolve(params);
        };
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(listener);
      });
    },
    close() { socket.close(); },
  };
}

// ── 收尾：等自己这棵浏览器真的退出 → 删 → 删完再核 ──────────────────────────────────
//
// 为什么（2026-09-22，派单 uiharness-leak；原始输出见交付报告与 test/ui-sandbox-cleanup.mjs 的注释）：
//   · 老 `close()` 只 `SIGTERM` **本次 spawn 的主 pid**、等它 exit 就返回。实测**主进程 exit 那一刻
//     仍有 1–3 个自有进程活着**（zygote / utility；8/8 次），它们是 chromium 的子树，退出前还会往
//     profile 里落最后一笔（`Default/Network Persistent State`、`Default/Cache/Cache_Data/*`…）。
//     调用方紧接着 `rm` 沙箱（实测 rm 只要 2–54 ms）⇒ 目录又被建回来：
//     `/tmp/sopho-ui-*/chromium/Default/…`（本机实测累计到过 65 个 / 486 MB）。
//   · 另一个方向更彻底：用这个底座的 25 个门（不含本件新加的那道）里有 20 个**从来没删过**沙箱（只 `await close()`），
//     每次跑都留下整棵 profile（实测 test/tui-tool-diff.mjs 8/8 次 +1，每个 ~3 MB）。
//   两件都在这里收：`boot()` 自己知道 spawn 的精确 pid、自己的 profile 目录、自己的沙箱路径 —— 它来等、来删、来核。
//
// 认领口径（本仓纪律）：**按本次自己 spawn 的精确 pid + 自己那个 profile 目录**（`<sandbox>/chromium`）✓；
//   **不拿整条沙箱路径当认领标记** ✗ —— 多引擎的门里它是共用的（2026-09-21 实测：Firefox 的收尾
//   把还在跑的整棵 Chromium 杀了）。自扫 /proc，**绝不 pgrep / pkill 任何模式**。
// 删目录的口径（2026-09-22 总台追加：不靠自觉，要落进代码）：**只删「本次 run 令牌匹配」的目录**
//   （令牌 `RUN_TOKEN_NAME` 写在自己每个沙箱根上，见下面 `removeOwnedRunDirectory` /
//   `scanSandboxDirectories`）；令牌对不上一律不删、只如实记账；
//   **不靠「两次列清单做差集」认领自己的东西** ✗（2026-09-22 那次误删就是这么来的：一边完整路径
//   `/tmp/x`、一边纯目录名 `x` ⇒ 差集判「全不同」⇒ 全被当成自己的；令牌是带内标记，不靠格式假设）。

// ── 运行令牌（2026-09-22 总台追加：不靠自觉，要落进代码） ──────────────────────────────
// 只许删「**本次 run 自己创造**」的路径：本次 run 在自己 mkdtemp 出来的**每个**沙箱根上写一个令牌
// 文件；收尾只删「令牌里的 id == 本次 run 的 id」的目录；扫到没有令牌 / 令牌不是本次的 ⇒
// **一个字节都不动**，如实记账并跳过（同族纪律：绝不清理别人的残留）。
// 为什么不拿「两次列清单做差集」认领：那依赖「两次清单格式一致」这种**假设**，而 2026-09-22 的
// 一次误删就是这么来的（一边完整路径 `/tmp/x`、一边纯目录名 `x` ⇒ 差集判「全不同」⇒ 全被当成自己的）；
// 令牌是**带内标记**，不依赖任何格式假设。
export const RUN_ID = `${process.pid}-${randomUUID()}`;
export const RUN_STARTED_AT = new Date().toISOString();
export const RUN_TOKEN_NAME = '.sopho-ui-run.json';
export const SANDBOX_PREFIX = 'sopho-ui-';

// 读某个目录的令牌；没有/坏了都当 null（= 别人的/历史残留）。
export async function readRunToken(directory) {
  const raw = await readFile(path.join(directory, RUN_TOKEN_NAME), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const token = JSON.parse(raw);
    return typeof token?.id === 'string' ? token : null;
  } catch { return null; }
}

async function writeRunToken(directory, extra = {}) {
  const token = { id: RUN_ID, pid: process.pid, startedAt: RUN_STARTED_AT, directory, ...extra };
  await writeFile(path.join(directory, RUN_TOKEN_NAME), `${JSON.stringify(token, null, 2)}\n`, 'utf8');
  return token;
}

// 本次 run 的**清单文件**（写在 tmp 下的隐藏文件，每个 run 一个，按 RUN_ID 命名）。
// 为什么除了「沙箱里的令牌」还要这个：`rm` 会把令牌一起删掉，而「删完再核」那一步要认领的正是
// 「被删掉之后又被写回来」的那条**同一路径**—— 那时沙箱里已经没有令牌了。清单记的是本 run
// **自己建过的精确路径**（`mkdtemp` 那一刻登记），仍然是**带内记录**，不是「两次列清单做差集」。
const runManifestPath = () => path.join(os.tmpdir(), `.sopho-ui-run-${RUN_ID}.json`);

async function readRunManifest() {
  const raw = await readFile(runManifestPath(), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const manifest = JSON.parse(raw);
    return Array.isArray(manifest?.directories) ? manifest : null;
  } catch { return null; }
}

async function writeRunManifest(manifest) {
  await writeFile(runManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

let exitHookInstalled = false;
// 进程真的要走了才清算本 run 的清单：清单**必须活满整个 run**（「删了又被写回来」那一步还要靠它认领），
// 但不能给 /tmp 留杂物 —— 退出钩子里：记录的目录全没了 ⇒ 删掉清单文件；还留着 ⇒ 那条就是残留，
// 大声报出来并把清单留着（可归因：里面写着本 run 的 id / pid / 时刻）。同步 API，退出钩子里才可靠。
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(runManifestPath(), 'utf8')); } catch { manifest = null; }
    if (!manifest || !Array.isArray(manifest.directories)) return;
    const left = manifest.directories.filter((directory) => existsSync(directory));
    if (left.length === 0) { try { rmSync(runManifestPath(), { force: true }); } catch {} return; }
    process.stderr.write(`[ui-harness 收尾] run ${manifest.id} 结束时仍有残留：${left.join(' / ')}（清单 ${runManifestPath()}）\n`);
  });
}

async function recordRunDirectory(directory) {
  installExitHook();
  const manifest = await readRunManifest() ?? { id: RUN_ID, pid: process.pid, startedAt: RUN_STARTED_AT, directories: [] };
  if (!manifest.directories.includes(directory)) manifest.directories.push(directory);
  await writeRunManifest(manifest);
  return manifest;
}

async function manifestHas(directory) {
  const manifest = await readRunManifest();
  return Boolean(manifest?.directories?.includes(directory));
}

// 只删「本次 run 自己创建」的目录（两种带内证据任一命中）：
//   · 沙箱里的令牌 id == 本次 run 的 id；或
//   · 这条**精确路径**在本次 run 自己的清单里（覆盖「被删了又被写回来」那一步）。
// 两条都不命中 ⇒ 返回 { removed:false }，**一个字节都不动**；调用方拿 reason 去如实记账。
export async function removeOwnedRunDirectory(directory) {
  const token = await readRunToken(directory);
  if (token !== null && token.id !== RUN_ID) return { removed: false, reason: `运行令牌不是本次 run 的（${token.id}）` };
  if (token === null && !await manifestHas(directory)) return { removed: false, reason: `既没有运行令牌、也不在本次 run 的清单里（不是本次 run 建的）` };
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  return { removed: true, token, claimedBy: token === null ? 'manifest' : 'token' };
}

// 本次 run 的清单：如果里面登记的**每条路径都已经不在盘上了**，就把清单文件删掉（不给 /tmp 留杂物）；
// 还有没删掉的 ⇒ 留着那条记录（它确实是本 run 建的，归账归在本 run 头上）并如实报出来。
export async function dropRunManifestIfClean() {
  const manifest = await readRunManifest();
  if (!manifest) return { dropped: false, remaining: [] };
  const remaining = manifest.directories.filter((directory) => existsSync(directory));
  if (remaining.length > 0) return { dropped: false, remaining };
  await rm(runManifestPath(), { force: true }).catch(() => {});
  return { dropped: !existsSync(runManifestPath()), remaining: [] };
}

// **只读**盘点：把 tmp 下的 sopho-ui-* 按令牌分成「本次 run 的」与「别人的/历史的」。
// ⚠️ 这是**分类**不是差集认领；返回的行不带任何「该不该删」的决定，删不删由调用方按 `mine` 走
// `removeOwnedRunDirectory`（且非 mine 的一律不删）。
export async function scanSandboxDirectories(tmpDir = os.tmpdir()) {
  const names = readdirSync(tmpDir).filter((name) => name.startsWith(SANDBOX_PREFIX)).sort();
  const rows = [];
  for (const name of names) {
    const directory = path.join(tmpDir, name);
    const token = await readRunToken(directory);
    const mine = token?.id === RUN_ID || (token === null && await manifestHas(directory));
    rows.push({ name, directory, mine, tokenId: token?.id ?? null, tokenPid: token?.pid ?? null, startedAt: token?.startedAt ?? null, claimedBy: token ? 'token' : (mine ? 'manifest' : null) });
  }
  return rows;
}

// 上界都可以用环境变量收紧（门在 CI 上跑得快，别为一次收尾停 10 s）。
const settleBudget = () => ({
  treeMs: Number(process.env.SOPHO_UI_SETTLE_TREE_MS ?? 10_000),      // 等整棵树退出的上界
  killMs: Number(process.env.SOPHO_UI_SETTLE_KILL_MS ?? 5_000),      // SIGKILL 之后再等一个上界
  pollMs: Number(process.env.SOPHO_UI_SETTLE_POLL_MS ?? 25),
  quietMs: Number(process.env.SOPHO_UI_RECHECK_QUIET_MS ?? 200),      // 「删完再核」要求连续这么久的空窗
  recheckMs: Number(process.env.SOPHO_UI_RECHECK_MS ?? 2_000),        // 「删完再核」的总上界
});

// 看进程一律经过 `test/harness.mjs`（`processTable` / `processStateOf` / `processAlive`）——
// 那边是 POSIX 与 Windows 唯一分叉的地方；本文件里不出现 procfs 字面量（`test/harness-contract.mjs` 钉的纪律）。

// 自己 + 祖先链：收尾认领自有进程时排除（免得把门自己 / 自己的 shell 算进去）。
async function selfAndAncestors() {
  const table = await processTable({ withCommandLine: false });
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const chain = new Set([process.pid]);
  let current = process.pid;
  for (let depth = 0; depth < 64; depth += 1) {
    const row = byPid.get(current);
    if (!row || !Number.isInteger(row.ppid) || row.ppid <= 1 || chain.has(row.ppid)) break;
    chain.add(row.ppid);
    current = row.ppid;
  }
  return chain;
}

// 「自己这棵树」= 本次 spawn 的 pid ∪ 它的（传递）子孙 ∪ 命令行里带**本次这次 spawn 自己认领的那些路径**的进程。
// 三条腿都要：
//   · pid 树：子进程退出前会被 reparent 到 init（父链断掉）；
//   · 认领路径：crashpad 那类不带 profile 旗标的成员（实测本机：`chrome_crashpad_handler` 会被 setsock/reparent，
//     `ppid=1`，pid 树与「本引擎 profile 目录」两条腿都跟不到它）—— 它命令行里的 `--database` 指向的正是
//     **本次 run 自己创建的目录**（`<sandbox>/{home,tmp,xdg-config,xdg-cache}`，见 `browserSandboxEnv`）。
//     ⚠️ 认领路径的**范围**：只允许本次这次 spawn 自己创建的那些（`claimMarkers`，由 `boot()` 算好传进来）。
//     早先那条「绝不拿整条沙箱路径当认领标记」的纪律针对的是**多引擎共用一条沙箱**的门（2026-09-21 实测：
//     Firefox 的收尾把还在跑的整棵 Chromium 杀了）；`boot()` 一次只起一个引擎、沙箱也是它自己 mkdtemp 的，
//     所以这里用「自己这次的路径」是安全的（`SOPHO_UI_CLAIM=off` 可以退回只靠 pid 树 + profile 目录两条腿）。
async function ownedProcesses({ pid, profileDir, claimMarkers = null, exclude }) {
  const markers = (claimMarkers ?? [profileDir]).filter(Boolean);
  const table = await processTable();
  const live = new Map(table.filter((row) => row.state !== 'Z' && !exclude.has(row.pid)).map((row) => [row.pid, row]));
  const children = new Map();
  for (const row of live.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const owned = new Set();
  if (live.has(pid)) owned.add(pid);
  const stack = [pid];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()) ?? []) {
      if (owned.has(child)) continue;
      owned.add(child);
      stack.push(child);
    }
  }
  for (const row of live.values()) {
    if (owned.has(row.pid)) continue;
    if (markers.some((marker) => (row.commandLine ?? '').includes(marker))) owned.add(row.pid);
  }
  return [...owned];
}

// 残留现场的原始证据：列几个名字出来（不静默说「有残留」却不给是什么）。
async function listTree(root, limit = 40) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      out.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return out;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', onExit);
  });
}

// routes(request, response, url) 返回 true 表示已处理；否则回落到 web/ 静态文件。
// `webRoot` 可选：默认本仓 `web/`；修前对照门可以指到另一份快照（同一把尺子量两个版本）。
// 返回值里带 `staticRoot`（= `path.resolve(webRoot)`）：这是**实际服务的那个根**的读数，
// 调用方可以据此断言「本门服务的是自己沙箱里的副本」（2026-09-25：
// `test/copy-tiers-live.mjs` / `test/designer-ui.mjs` / `test/design-edit.mjs` 的真仓读数
// 改成只记录后，那一条**有归属**的判据就靠它 —— 判的是真派出去的那个值，不是本地那个常量）。
export async function boot({ routes, width = 1200, height = 760, webRoot = WEB_ROOT } = {}) {
  const staticRoot = path.resolve(webRoot);
  const sandbox = await mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX));
  const profileDir = path.join(sandbox, 'chromium');
  // 令牌先写、并在本次 run 自己的清单里登记这条精确路径：从这一刻起这个目录就是「本次 run 的」，
  // 收尾才有权删它（且只能删它 —— 清单里没有的、令牌不是本次的，一律不删）。
  const runToken = await writeRunToken(sandbox, { profileDir });
  await recordRunDirectory(sandbox);
  const port = await reservePort();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      if (routes && await routes(request, response, url)) return;
      if (request.method === 'GET' || request.method === 'HEAD') {
        const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
        const file = path.resolve(staticRoot, `.${pathname}`);
        if (!file.startsWith(`${staticRoot}${path.sep}`)) return response.writeHead(403).end();
        try {
          const content = await readFile(file);
          response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
          response.end(content);
        } catch { response.writeHead(404).end(); }
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error?.stack || error));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reservePort();
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  // 私有 TMPDIR + 私有 home/XDG：这个浏览器不许往共享 /tmp 丢 `org.chromium.Chromium.*`，也不许把
  // crashpad 的 `--database` 指到用户真实 `~/.config/chromium`（原因与实测见 `test/harness.mjs` 的
  // `browserSandboxEnv`；`test/browser-sandbox-isolation.mjs` 是钉这条的门）。
  const isolation = browserSandboxPaths(sandbox);
  // 收尾认领的第三条腿：**本次这次 spawn 自己创建的路径**（沙箱根 + 它下面那四个私有目录）。
  // 为什么需要它：crashpad handler 会 setsid/reparent（本机实测 ppid=1），pid 树与 profile 目录两条腿
  // 都跟不到它；而它的 `--database` 正指向 `<沙箱>/xdg-config/...`（隔离后就看得见了）。
  // `SOPHO_UI_CLAIM=off` 只给反证臂用（退回 pid 树 + profile 目录两条腿），门不许依赖它。
  const claimMarkers = process.env.SOPHO_UI_CLAIM === 'off'
    ? [profileDir]
    : [profileDir, sandbox, isolation.home, isolation.tmp, isolation.xdgConfig, isolation.xdgCache];
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: browserSandboxEnv(sandbox) });

  // ── 收尾账本 + 三段动作（等 / 删 / 核）都在 spawn 之后立刻定下来：
  //    这样「waitFor 等不到调试端口」「CDP 没起来」这类**boot 自己失败**的路也能收干净。
  const budget = settleBudget();
  const selfPids = await selfAndAncestors();
  const cleanup = {
    mode: process.env.SOPHO_UI_SETTLE ?? 'settle',
    sandbox, profileDir, pid: child.pid, runId: runToken.id, claimMarkers,
    closed: false, ok: null, treeWaitMs: 0, sigkilled: [], survivors: [],
    removed: 0, reappeared: 0, residue: [], notes: [], problems: [],
  };
  let browser = null;

  const note = (message) => {
    cleanup.notes.push(message);
    process.stderr.write(`[ui-harness] ${message}\n`);
  };
  // 「如实记账」= 每次都落一条带路径的 stderr（门自己吞不吞是门的事），并进 problems 供门判红。
  const record = (message, problems) => {
    cleanup.problems.push(message);
    process.stderr.write(`[ui-harness 收尾] ${sandbox}：${message}\n`);
    if (Array.isArray(problems)) problems.push(`ui-harness 收尾：${message}`);
  };

  // 等到「一个自有进程都不剩」为止（有上界）。返回 null = 这台机器问不到进程表。
  const waitTreeGone = async ({ ms, pollMs }) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const survivors = await ownedProcesses({ pid: child.pid, claimMarkers, exclude: selfPids });
      if (survivors === null) return null;
      if (survivors.length === 0) return [];
      if (Date.now() >= deadline) return survivors;
      await sleep(pollMs);
    }
  };

  // ① 等它真的退出：`SIGTERM` 只按**本次 spawn 的精确 pid**；然后等**整棵树**（有上界），
  //    到点按**精确 pid** 升级 `SIGKILL`，再等一个有上界的时间；还活着 ⇒ 明确的红（带着 pid 名单）。
  const stopSpawnedTree = async (problems) => {
    const startedAt = Date.now();
    if (process.platform === 'win32') {
      // Windows：等主进程退；退不掉就按同一棵树 `taskkill /PID <本次 spawn 的 pid> /T /F`。
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      let exited = await waitForChildExit(child, budget.treeMs);
      if (!exited) {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (error) { record(`Windows taskkill /T 失败：${error?.message}`, problems); }
        exited = await waitForChildExit(child, budget.killMs);
      }
      cleanup.treeWaitMs = Date.now() - startedAt;
      if (!exited) record(`Windows：${budget.treeMs + budget.killMs} ms 内主进程 ${child.pid} 没退（taskkill /T 也无效）`, problems);
      else note(`Windows：这一层拿不到「整棵树」，已按本次 spawn 的 pid ${child.pid} 的 /T 收（只按精确 pid）`);
      await waitForChildExit(child, budget.killMs);
      return;
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let survivors = await waitTreeGone({ ms: budget.treeMs, pollMs: budget.pollMs });
    if (survivors && survivors.length > 0) {
      for (const pid of survivors) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') record(`SIGKILL pid ${pid} 失败：${error.message}`, problems); }
      }
      cleanup.sigkilled = [...survivors];
      survivors = await waitTreeGone({ ms: budget.killMs, pollMs: budget.pollMs });
    }
    cleanup.treeWaitMs = Date.now() - startedAt;
    cleanup.survivors = survivors ? [...survivors] : [];
    if (survivors === null) {
      note(`这台机器问不到进程表：认领不了「整棵树」，只等主进程 ${child.pid} 退（上界 ${budget.treeMs} ms）`);
    } else if (survivors.length > 0) {
      record(`等 ${cleanup.treeWaitMs} ms（上界 ${budget.treeMs}+${budget.killMs} ms、SIGKILL 也用过）后仍有 ${survivors.length} 个自有进程活着：${survivors.join(',')}`, problems);
    }
    // 主进程的 exit 事件也要收（避免僵尸）；上界内没等到就再记一笔。
    if (!await waitForChildExit(child, budget.killMs)) record(`主进程 ${child.pid} 在 ${budget.killMs} ms 内没报 exit`, problems);
  };

  // ② 再删：只删本次 run 自己的那个目录（令牌校验走 `removeOwnedRunDirectory`）。
  //    令牌对不上 ⇒ 一个字节都不动，并把这件事**如实记到 problems**。
  const removeSandboxDir = async (problems, label) => {
    const result = await removeOwnedRunDirectory(sandbox).catch((error) => ({ removed: false, reason: `rm 抛了：${error.message}` }));
    if (result.removed) cleanup.removed += 1;
    else record(`${label}：拒绝/没能删除 ${sandbox} —— ${result.reason}（一个字节都没动）`, problems);
    return result;
  };

  // ③ 删完再核：目录没了、且连续 `quietMs` 都是空的，才算干净；又出现就再删并**如实记账**；
  //    在上界内清不掉 ⇒ 明确的红（带残留名单）。
  //    顺序与共享层同一个口径：**先给迟写者落地窗口**（=这里前面的 `stopSpawnedTree`：它等整棵树退到空集，
  //    那段时间就是落地窗口）→ 删 → 复核 → 又出现就再删（有上界）→ 仍留着如实判红。每次删除/空窗都落一条读数。
  const verifyGone = async (problems, label = '删完复核') => {
    const limit = Date.now() + budget.recheckMs;
    let quietSince = Date.now();
    let passes = 0;
    for (;;) {
      await sleep(budget.pollMs);
      if (existsSync(sandbox)) {
        cleanup.reappeared += 1;
        cleanup.residue = await listTree(sandbox);
        note(`${label}：删掉之后 ${sandbox} 又出现（第 ${cleanup.reappeared} 次；${cleanup.residue.length} 项，例如 ${cleanup.residue.slice(0, 4).join(' / ') || '(空)'}）`);
        if (Date.now() >= limit) {
          record(`${label}：${budget.recheckMs} ms 内又出现 ${cleanup.reappeared} 次、最后一次没能删掉（残留 ${cleanup.residue.length} 项：${cleanup.residue.slice(0, 8).join(' / ')}）`, problems);
          return false;
        }
        await removeSandboxDir(problems, `${label}·又出现后再删`);
        quietSince = Date.now();
        continue;
      }
      if (Date.now() - quietSince >= budget.quietMs) {
        passes += 1;
        note(`${label}：空窗读数 —— 第 ${passes} 轮复核时沙箱已不在，且连续 ${budget.quietMs} ms（删除 ${cleanup.removed} 次、又出现 ${cleanup.reappeared} 次）都干净`);
        return true;
      }
      if (Date.now() >= limit) {
        record(`${label}：${budget.recheckMs} ms 上界内没等到一段 ${budget.quietMs} ms 的稳定空窗`, problems);
        return false;
      }
    }
  };

  // 收尾总账。`problems` 可选：门把它的 cleanup 数组传来 ⇒ 收尾失败会进那条通道（`finishCleanup` 会判红）。
  // 幂等（notice-ui 这类门会连着 close() 两次），第二次只复核。
  // `SOPHO_UI_SETTLE` 只给**反证臂**用：`off` = 今天的形状（只停主进程、不删不核）、`nowait` = 先删后等、
  // `noverify` = 删完不核；不设（或 `settle`）= 正常路径（等 → 删 → 核）。门不许依赖反证模式。
  const close = async (problems) => {
    if (!cleanup.closed) {
      cleanup.closed = true;
      await quiesceCdpPage(browser);
      if (browser) browser.close();
      if (cleanup.mode === 'off') {
        // 反证臂专用：**今天的形状** —— 只按精确 pid SIGTERM 主进程、等它 exit 就返回；不等整棵树、不删、不核。
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await waitForChildExit(child, budget.killMs);
        note('mode=off（反证臂）：只停主进程就返回，沙箱原样留着');
      } else if (cleanup.mode === 'nowait') {
        // 反证臂专用：**清理先于浏览器退出**（正是这个 bug 的形状）—— 先删，再等它退；
        // 退的时候它还会往已经删掉的 profile 路径里落最后一笔 ⇒ 目录又被建回来。
        await removeSandboxDir(problems, '先删（反证臂）');
        await stopSpawnedTree(problems);
        note('mode=nowait（反证臂）：先删后等退出');
      } else if (cleanup.mode === 'noverify') {
        // 反证臂专用：等退出、也删了，但**不核**（“删完再核”那一步在不在，门要能看出来）。
        await stopSpawnedTree(problems);
        await removeSandboxDir(problems, '删（反证臂）');
        note('mode=noverify（反证臂）：删完不核');
      } else {
        await stopSpawnedTree(problems);       // ① 等它真的退出
        await removeSandboxDir(problems, '删'); // ② 再删
        await verifyGone(problems);             // ③ 删完再核
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    } else if (cleanup.mode === 'settle') {
      await verifyGone(problems, '第二次 close 复核');
    }
    // 收尾时**不**动本 run 的清单：它要活到进程结束（「删了又被写回来」那一步还要靠它认领这条路径）；
    // 清算在 `process.on('exit')` 里：全没了 ⇒ 删掉清单文件；还留着 ⇒ 大声报出残留 + 留清单可归因。
    if (existsSync(sandbox)) note(`收尾结束沙箱仍在：${sandbox}（本次 run 的清单里留着这条路径）`);
    cleanup.ok = cleanup.problems.length === 0;
    return cleanup;
  };

  try {
    // 每次探针都自带超时（`AbortSignal.timeout`）：除了 `waitFor` 的总上界，单发 fetch 也不许挂住 ——
    // 否则「等调试端口」会变成一个没有上界的 await（收尾逻辑要的是确定性，不是运气）。
    const probeMs = Number(process.env.SOPHO_UI_PROBE_TIMEOUT_MS ?? 2000);
    const version = await waitFor(async () => {
      const result = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(probeMs) }).catch(() => null);
      return result?.ok ? result.json() : null;
    }, 'chromium remote debugger did not start', Number(process.env.SOPHO_UI_BOOT_TIMEOUT_MS ?? 8000));

    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${port}/`, { method: 'PUT', signal: AbortSignal.timeout(probeMs) })).json();
    const pageProblems = [];
    browser = cdp(target.webSocketDebuggerUrl, pageProblems);
    await browser.ready;
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const loaded = browser.once('Page.loadEventFired');
    await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await loaded;

    const evaluate = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
      return result.result.value;
    };
    const screenshot = async (file) => {
      const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      await writeFile(file, Buffer.from(shot.data, 'base64'));
    };
    const frames = (count = 2) => evaluate(`new Promise(resolve=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
    const resize = async (nextWidth, nextHeight) => {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: nextWidth, height: nextHeight, deviceScaleFactor: 1, mobile: false });
      await sleep(150);
    };
    const emit = (name, data = {}) => evaluate(`fetch('/api/test/event',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify({ name, data }))}}).then(r=>r.json())`);

    return { port, server, sandbox, profileDir, isolation: browserSandboxPaths(sandbox), staticRoot, runId: runToken.id, chrome, debugPort, version, browser, pageProblems, evaluate, screenshot, frames, resize, emit, close, cleanup, waitFor };
  } catch (error) {
    // boot 自己失败（调试端口等不到、CDP 没起来…）也要收干净：调用方拿不到句柄，只有这里能收。
    // 收尾自己的失败只记账（stderr + cleanup.problems），**不换掉**这个原始错误。
    note(`boot 自己失败（${error?.message}）⇒ 就地收尾：等整棵树退出 → 删沙箱 → 复核`);
    await close();
    throw error;
  }
}
