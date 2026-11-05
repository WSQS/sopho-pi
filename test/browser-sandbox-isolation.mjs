#!/usr/bin/env node
// test/browser-sandbox-isolation.mjs —— 「门的浏览器既不往**共享 /tmp**、也不往**用户真实 home** 写东西」这条的门。
//
// 跑法（**故意不注册成 npm script** —— 与 test/ui-sandbox-cleanup.mjs 同一个理由：别和别的 landing 抢 package.json）：
//   node test/browser-sandbox-isolation.mjs                 # 机械扫描读数 + 2 轮绿臂 + 1 条反证臂，本机 ~15 s
//   node test/browser-sandbox-isolation.mjs --rounds 5
//   node test/browser-sandbox-isolation.mjs --reverse-child # 反证臂的**子进程**那一半（父臂自己会起，不用手敲）
//
// ── 背景（2026-09-23 派单 chromium-isolation；原始读数见交付报告） ────────────────────────────
// ① 每 `boot()` 一次，真 Chromium 都在**继承来的 TMPDIR** 里建两个 `org.chromium.Chromium.*`：
//    一个装 ProcessSingleton 的 `SingletonSocket`，一个装 `chromium_chrome_url_fetcher_`。门不隔离 TMPDIR
//    ⇒ 它们落在**共享 /tmp**（本机 2026-09-23 实测那里已积到 6500+ 个，无从归因到哪一次跑）。
// ② crashpad handler 的命令行是 `--database=$XDG_CONFIG_HOME/chromium/Crash Reports`（没设 XDG 时是
//    `$HOME/.config/chromium/Crash Reports`）——**与 `--user-data-dir` 无关**。不重定向 HOME/XDG ⇒ 门的浏览器
//    把崩溃库指到用户真实 home，并且**真的写**（`Crash Reports/settings.dat`；本机实测三道未隔离的门 3/3 都改到了）。
// 修法：`test/harness.mjs` 的 `browserSandboxEnv(root)`（私有 HOME/TMPDIR/XDG），每个浏览器 spawn 点都带上它；
// 机械保证在 `test/harness-contract.mjs`（`npm run test:harness` / `test:prepush` 会拦）。
//
// ── 本门钉的读数 ─────────────────────────────────────────────────────────────────────
//  ① 机械扫描（`test/browser-spawn-scan.mjs`）：`test/**` 里每个起真浏览器的 spawn 点都带 `env: browserSandboxEnv(...)`，
//     一个不落；认到的点数有下界（不然扫描器会静默变瞎）。
//  ② 绿（**有归属**）：隔离后 `boot()` 一次 ⇒ 那两个 `org.chromium.Chromium.*` 出现在**本门自己的** TMPDIR
//     （`<sandbox>/tmp`）里（在浏览器还活着的时候读；这是**正控制**：不出现就是隔离没生效）。
//     ⚠️ 共享 `/tmp` 里的同名增量**只记录、不断言**（2026-09-25 修）：`os.tmpdir()` 是**全机共享**的，
//     而且 `org.chromium.Chromium.*` 这个形状**不是本门独有的**（用户自己开着 Chromium、任何未隔离的外来
//     进程都会建同名目录；本机实测累计 6500+ 个）⇒ 在并发行为者下拿共享 /tmp 做 before/after 全机计数无效：
//     别人建一个就把本门记成“漏了”。本门对共享 /tmp **没有所有权**，量不了。
//  ③ 绿（机制，全部**有归属**）：crashpad handler 的 `--database` **落在本次自己的沙箱里**；
//     本次那棵树（自己 spawn 的 pid 的（传递）子孙 ∪ 命令行带本沙箱路径的进程）里**没有任何进程**引用用户真实
//     chromium home。这两条就是「本门没往用户真实 chromium home 写」的归属判据。
//     ⚠️ 用户三处 chromium 目录（`.config/chromium`、`.config/chromium-headless`、`.cache/chromium`）的
//     「文件集合 + mtime + size 不变」**只记录、不断言**（2026-09-25 修）：那是**用户的文件**，用户自己开着
//     浏览器就会改它 —— 本门对它只有**只读观察、没有写路径**。快照比较器不是死读数这一半由 ④ 的 decoy（一份
//     **本门自己造的** home）硬证。
//  ④ 红（反证，**确定性**）：子进程里 `SOPHO_BROWSER_ISOLATION=off`，把继承环境换成本门自己 mkdtemp 出来的 decoy
//     （`HOME`/`TMPDIR` = decoy，XDG 两个变量**删掉** —— 与这台机器上真实门的环境同形）⇒
//     ①那两个目录出现在**继承的 TMPDIR** 里（增量 > 0）；②crashpad 的 `--database` 变成**那一份 home** 的
//     `chromium/Crash Reports`，同一套 home 快照比较器**看得见**它被写（⇒ ③那个「不变」的读数不是恒绿的死读数）。
//     ⚠️ 为什么用 decoy 而不是真共享 /tmp / 真 home：本门**自己不许**往共享 /tmp 与用户 home 写东西
//     （那正是本门要拦的行为），所以反证臂把「继承来的那一份环境」显式换成形状相同的 decoy ⇒ 两条硬判据
//     （污染落在**继承来的 TMPDIR**、同一套 home 快照比较器看得见 decoy home 被写）都落在本门自己造的
//     decoy 上，全部有归属；共享 /tmp 在同一窗口里的增量只记录。
//  ⑤ 收尾兜底路径的**确定性自检**：迟写者/不罢休的写者各一次 ⇒ 「删完再核」与「到点如实交出剩余路径」两分支每跑必走。
//  ⑥ 自清：本门造过的 decoy 目录、`boot()` 出来的沙箱、子进程，全部按**自己的精确路径 / 精确 pid** 收拾干净
//     （不收别人的任何残留；不用 pkill/pgrep；不动活实例；不用 7331/7321）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBrowserSpawnIsolation } from './browser-spawn-scan.mjs';
import { BROWSER_SANDBOX_ENV_KEYS, browserSandboxEnv, browserSandboxPaths, crashpadDatabaseOf, finishCleanup, processAlive, processTable, removeSandbox, removeSandboxConverged } from './harness.mjs';
import { boot } from './ui-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = os.tmpdir();
const REAL_HOME = os.homedir();
const CHROMIUM_TEMP_PREFIX = 'org.chromium.Chromium.';
// 只读观察对象：crashpad 的库与那两个临时目录都落在这三处（`.cache/chromium` 一起看着，防「换个地方写」）。
const HOME_WATCH = ['.config/chromium', '.config/chromium-headless', '.cache/chromium'];
const REAL_CHROMIUM_HOME = path.join(REAL_HOME, '.config', 'chromium');
const argv = process.argv.slice(2);
const rounds = Number(argv.includes('--rounds') ? argv[argv.indexOf('--rounds') + 1] : 2);
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 只读观察：文件集合 + mtime + size（不读内容、不写、不删） ──────────────────────────────
function snapshotTree(directory) {
  const rows = new Map();
  const walk = (current, base) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      rows.set(path.relative(base, full), `${entry.isDirectory() ? 'd' : 'f'}:${stat.mtimeMs}:${stat.size}`);
      if (entry.isDirectory()) walk(full, base);
    }
  };
  walk(directory, directory);
  return rows;
}
const snapshotWatchedHomes = (home) => HOME_WATCH.map((relative) => ({ relative, tree: snapshotTree(path.join(home, relative)) }));
function diffTrees(before, after) {
  const changed = [];
  for (const [key, value] of after) if (before.get(key) !== value) changed.push(`${key}${before.has(key) ? '(mtime/size)' : '(新增)'}`);
  for (const key of before.keys()) if (!after.has(key)) changed.push(`${key}(消失)`);
  return changed;
}
const diffWatchedHomes = (before, after) => before
  .map((entry, index) => ({ relative: entry.relative, changed: diffTrees(entry.tree, after[index].tree) }))
  .filter((entry) => entry.changed.length > 0);
const chromiumTempNames = () => new Set(readdirSync(TMP).filter((name) => name.startsWith(CHROMIUM_TEMP_PREFIX)));
const tempDelta = (before) => [...chromiumTempNames()].filter((name) => !before.has(name));
// 同一个形状，但落在**本门自己的**私有 TMPDIR 里（`<sandbox>/tmp`，见 `browserSandboxEnv`）。
// 这是唯一**有归属**的那一半读数：共享 /tmp 里同名目录归别人（用户自己的 Chromium、任何未隔离的
// 外来进程都会建同名目录 —— 本机 2026-09-23 实测累计 6500+ 个），本门量不了；本门能自证的是
// 「chromium 那两个 `org.chromium.Chromium.*` 出现在**本门给它的** TMPDIR 里」。
const chromiumTempNamesUnder = (directory) => {
  let names = [];
  try { names = readdirSync(directory); } catch { names = []; }
  return new Set(names.filter((name) => name.startsWith(CHROMIUM_TEMP_PREFIX)));
};

// ── 进程表观察：本次那棵树（自己 pid 的（传递）子孙 ∪ 命令行带本沙箱路径的进程） ────────────────
// 认领口径与 `test/ui-harness.mjs` 的收尾一致（两条腿都要：子进程可能已被 reparent，而命令行里带沙箱
// 路径的又可能是刚 fork 出来的）。看进程一律经过 `test/harness.mjs` 的 `processTable`（跨平台；
// 本文件里不出现 procfs 字面量 —— `test/harness-contract.mjs` 钉的纪律）。
async function treeOf(pid, marker) {
  const table = await processTable();
  const live = new Map(table.filter((row) => row.state !== 'Z').map((row) => [row.pid, row]));
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
  for (const row of live.values()) if ((row.commandLine ?? '').includes(marker)) owned.add(row.pid);
  return [...owned].map((row) => live.get(row)).filter(Boolean);
}
const crashpadHandlersIn = (rows) => rows.filter((row) => /chrome_crashpad_handler/.test(row.commandLine ?? ''));
// 崩溃处理器是被 reparent 的（本机实测 ppid=1，见交付报告）⇒ 光靠 pid 树那条腿认不到它。
// 本门在这里用**带内标记**认：它的 `--database` 落在本门自己的沙箱/decoy 目录里（那两个路径是自己
// mkdtemp 出来的，别人不可能指过去）。
const crashpadHandlersUnder = (rows, ...prefixes) => crashpadHandlersIn(rows)
  .filter((row) => prefixes.some((prefix) => (crashpadDatabaseOf(row.commandLine) ?? '').startsWith(prefix)));

let problems = [];
let primaryError = null;
let checks = 0;
const failures = [];
function check(name, ok, detail) {
  checks += 1;
  if (!ok) failures.push(name);
  process.stdout.write(`${ok ? '✓' : '✗'} ${name} —— ${detail}\n`);
}

// ── 收尾：只收**本门自己造过的精确路径**（mkdtemp 的 decoy / 每次 boot 的沙箱）；别人的一个字节都不动 ──
// 「删完再核」现在**不再由本门自己实现**，而是用共享层 `test/harness.mjs` 的 `removeSandboxConverged`
// （同一个形状：删 → 稳定空窗复核 → 又出现就再删（有上界）→ 仍留着把**剩余路径**交出来）；
// 本门只负责“把自己造过的路径列出来 + 把问题记进自己的账”（臂⑤ **每跑必走一次**那条路）。
const createdPaths = new Set();
const rememberPath = (...paths) => { for (const p of paths) createdPaths.add(p); };
async function removeCreatedPaths(targets, label, { bucket = problems, budget = {} } = {}) {
  const results = [];
  for (const target of targets.filter((candidate) => candidate && existsSync(candidate))) {
    results.push({ target, ...(await removeSandboxConverged(target, { label, budget, onPass: (reading) => print(`  · ${label}（第 ${reading.pass} 遍）`, reading) })) });
  }
  for (const result of results) for (const problem of result.problems ?? []) bucket.push(problem);
  const remaining = results.filter((result) => result.remaining).map((result) => result.target);
  return {
    removed: results.filter((result) => result.removed).length,
    reappeared: results.some((result) => result.reappeared),
    passes: results.reduce((max, result) => Math.max(max, result.passes ?? 0), 0),
    ...(remaining.length > 0 ? { remaining } : {}),
  };
}

// 迟写者（**进程内**、确定性、锚定事件）：一直盯到 target **被删掉**，然后才落笔；recreateTimes 笔。
// 与 `test/ui-sandbox-cleanup.mjs` 的迟写者同一条口径：锚事件而不是时间，所以比「睡一会儿再写」稳。
function lateWriterAfterRemoval(target, { recreateTimes = 1, everyMs = 0, watchMs = 15_000, pollMs = 1 } = {}) {
  const state = { stopped: false, written: 0, error: null };
  state.stop = () => { state.stopped = true; };
  state.done = (async () => {
    const deadline = Date.now() + watchMs;
    while (existsSync(target) && !state.stopped && Date.now() < deadline) await sleep(pollMs);
    for (let index = 0; index < recreateTimes && !state.stopped; index += 1) {
      try {
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, `late-${index + 1}`), 'late write\n');
        state.written += 1;
      } catch (error) {
        state.error = error;   // 与 rm 擦肩而过（ENOENT）只记一笔继续
      }
      if (everyMs > 0) await sleep(everyMs);
    }
  })();
  return state;
}

// ── ① 机械扫描：每个起浏览器的 spawn 点都带私有环境信封 ────────────────────────────────────
async function scanSpawnSites() {
  const sites = [];
  const violations = [];
  const walk = async (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.mjs') || entry.name === 'browser-spawn-scan.mjs') continue;
      const result = scanBrowserSpawnIsolation(await readFile(full, 'utf8'), path.relative(ROOT, full));
      sites.push(...result.sites);
      violations.push(...result.violations);
    }
  };
  await walk(path.join(ROOT, 'test'));
  return { sites, violations, real: sites.filter((site) => !site.standIn) };
}

// ── ②③ 绿臂：隔离后 boot 一次（机制观察在浏览器活着时做；污染读数在 close 之后取） ──────────────
async function isolatedBootRound(round) {
  const homeBefore = snapshotWatchedHomes(REAL_HOME);
  const tempBefore = chromiumTempNames();
  const startedAt = Date.now();
  const page = await boot({ routes: async () => false });
  rememberPath(page.sandbox);
  const isolation = browserSandboxPaths(page.sandbox);
  let facts = null;
  let observed = null;
  try {
    await page.evaluate('document.title = "sandbox-isolation"');
    const table = await processTable();
    const claimed = await treeOf(page.cleanup.pid, page.sandbox);
    const handlers = crashpadHandlersUnder(table, page.sandbox);
    observed = {
      claimedProcesses: claimed.length,
      handlerPids: handlers.map((row) => row.pid),
      handlerDatabases: handlers.map((row) => crashpadDatabaseOf(row.commandLine)),
      referencesRealHome: claimed.filter((row) => (row.commandLine ?? '').includes(REAL_CHROMIUM_HOME)).map((row) => `${row.pid}: ${(row.commandLine ?? '').slice(0, 120)}`),
      // 机制观察要在浏览器**还活着**的时候做（那些目录是它自己在跑的时候建的）。这里取的是
      // **绝对集合**而不是前后差：沙箱是刚才 `boot()` 建的，那些目录在 boot 里就已经出现了
      // ⇒ 拿“boot 之后”当基准只会得到空集（踩过）。
      ownTmpNames: [...chromiumTempNamesUnder(isolation.tmp)],
    };
    facts = await page.close(problems);
  } catch (error) {
    await page.close(problems).catch(() => {});
    throw error;
  }
  const tempAdded = tempDelta(tempBefore);
  const reading = {
    round, ms: Date.now() - startedAt,
    sandbox: page.sandbox, isolation,
    // 本门名下（硬判据的载体）：隔离后 chromium 的临时目录出现在**本门自己的** TMPDIR 里。
    ownTmpNames: observed.ownTmpNames,
    // 共享 /tmp 的同名增量：**只记录**（归别人，见 `chromiumTempNamesUnder` 上面那段）。
    sharedTmpDelta: tempAdded.length, tempAdded,
    handlerCount: observed.handlerPids.length, handlerDatabases: observed.handlerDatabases,
    claimedProcesses: observed.claimedProcesses, referencesRealHome: observed.referencesRealHome,
    // 用户真实 chromium 目录的前后快照：**只记录**（本门对它有只读观察，没有写路径；用户自己开着浏览器
    // 就会改它 —— 那是**别人**的写）。机制那一半由 `handlerDatabases` / `referencesRealHome` 硬判。
    homeChanges: diffWatchedHomes(homeBefore, snapshotWatchedHomes(REAL_HOME)),
    cleanupOk: facts.ok, cleanupProblems: facts.problems, sandboxGone: !existsSync(page.sandbox),
  };
  print(`  · 第 ${round} 轮读数`, reading);
  return reading;
}

// ── ④ 反证臂的子进程那一半：撤掉隔离（继承环境 = decoy），看污染落在哪 ─────────────────────────
// 它只做「今天那道门做的事」：直接 `boot()`，环境就是继承来的那一份。打印成一行 JSON 给父臂断言。
async function reverseChild() {
  const tempBefore = chromiumTempNames();
  const homeBefore = snapshotTree(path.join(REAL_HOME, '.config', 'chromium'));
  const page = await boot({ routes: async () => false });
  let report = null;
  try {
    await page.evaluate('document.title = "unisolated"');
    const table = await processTable();
    const handlers = crashpadHandlersUnder(table,
      path.join(REAL_HOME, '.config', 'chromium'),
      path.join(REAL_HOME, '.config', 'chromium-headless'),
      path.join(REAL_HOME, '.cache', 'chromium'));
    report = {
      sandbox: page.sandbox,
      tmpdir: process.env.TMPDIR ?? null,
      home: process.env.HOME ?? null,
      xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null,
      handlerCount: handlers.length,
      handlerDatabases: handlers.map((row) => crashpadDatabaseOf(row.commandLine)),
      isolationOff: process.env.SOPHO_BROWSER_ISOLATION === 'off',
    };
    await page.close([]);
  } catch (error) {
    await page.close([]).catch(() => {});
    throw error;
  }
  const tempAdded = tempDelta(tempBefore);
  report.childTmpDelta = tempAdded.length;
  report.childTempAdded = tempAdded;
  report.childHomeChanges = diffTrees(homeBefore, snapshotTree(path.join(REAL_HOME, '.config', 'chromium'))).slice(0, 8);
  report.sandboxGone = !existsSync(page.sandbox);
  process.stdout.write(`REVERSE-CHILD ${JSON.stringify(report)}\n`);
}

if (argv.includes('--reverse-child')) {
  await reverseChild();
} else {
  // 前缀写成 `mkdtemp(path.join(os.tmpdir(), '<前缀>'))` 这个形状：`bin/sandbox-sweep.mjs` 就是靠扫
  // test/ 里这个形状**推导**出「门用的沙箱前缀」的（它只报数、不删）。写成 `TMP` 这类别名它就推不出来。
  const decoyRoot = await mkdtemp(path.join(os.tmpdir(), 'sopho-browser-isolation-'));
  rememberPath(decoyRoot);
  try {
    // ① 机械扫描
    const scan = await scanSpawnSites();
    print('① 机械扫描', { 真浏览器spawn点: scan.real.length, 替身: scan.sites.length - scan.real.length, 缺信封的: scan.violations.length });
    check('① `test/**` 里每个起真浏览器的 spawn 点都带 `env: browserSandboxEnv(...)`（缺一个就红）',
      scan.violations.length === 0, JSON.stringify(scan.violations.map((violation) => `${violation.file}:${violation.line}`)));
    check('① 扫描器认到的点数有下界（不然它会静默变瞎）', scan.real.length >= 40, `${scan.real.length} site(s)`);
    // 信封本身也得对：声明的每一个变量都真的被重定向了（不是只改了 TMPDIR 就完事）。
    const probeEnv = browserSandboxEnv(path.join(decoyRoot, 'env-probe'));
    const stillInherited = BROWSER_SANDBOX_ENV_KEYS.filter((key) => probeEnv[key] === process.env[key] || probeEnv[key] === undefined);
    check('① `browserSandboxEnv` 覆盖了它声明的每一个变量（HOME/TMPDIR/TMP/TEMP/XDG_*）',
      stillInherited.length === 0, JSON.stringify({ declared: BROWSER_SANDBOX_ENV_KEYS, stillInherited }));

    // ②③ 绿臂：N 轮隔离 boot
    const readings = [];
    for (let round = 1; round <= rounds; round += 1) readings.push(await isolatedBootRound(round));
    // ── ② 判据按**归属**拆（2026-09-25）：
    //   · **本门名下**（硬判据，且是正控制）：chromium 那两个 `org.chromium.Chromium.*` 出现在**本门给它
    //     的** TMPDIR（`<sandbox>/tmp`）里 —— 不出现就说明隔离没生效（那就真写到继承来的那份 TMPDIR
    //     里去了），所以这条不是空话。
    //   · **共享 /tmp 的同名增量只记录**：`os.tmpdir()` 是**全机共享**的，`org.chromium.Chromium.*`
    //     这个形状**不是本门独有的**（用户自己开着 Chromium、任何未隔离的外来进程都会建同名目录；本机
    //     2026-09-23 实测累计 6500+ 个）⇒ 在并发行为者下 before/after 对比完全机计数无效：别人的浏览器
    //     建一个就把本门记成“漏了”。本门对共享 /tmp **没有所有权**，只能把归属写清楚。
    const ownCounts = readings.map((reading) => reading.ownTmpNames.length);
    check(`② 隔离后 boot ${rounds} 次：chromium 的 \`org.chromium.Chromium.*\` 每次都出现在**本门自己的** TMPDIR（<sandbox>/tmp）里`,
      ownCounts.every((count) => count >= 1),
      JSON.stringify(readings.map((reading) => ({ ownTmpNames: reading.ownTmpNames, tmp: reading.isolation.tmp }))));
    {
      const sharedDeltas = readings.map((reading) => reading.sharedTmpDelta);
      const names = readings.flatMap((reading) => reading.tempAdded);
      print('② 共享 /tmp 的同名增量（**只记录、不断言**）', {
        每轮增量: sharedDeltas, 本轮新增名字: [...new Set(names)].slice(0, 12),
        归属: '别人的：这个形状不是本门独有的（用户自己的 Chromium、未隔离的外来进程都会建同名目录）—— 本门对共享 /tmp 没有所有权，所以这里不判定；本门自己那些的归属证据在上面那条（它们在 <sandbox>/tmp 里）',
      });
    }
    check('② 每次收尾都自报干净（cleanup.ok 且沙箱真的没了）',
      readings.every((reading) => reading.cleanupOk === true && reading.sandboxGone === true),
      JSON.stringify(readings.map((reading) => ({ ok: reading.cleanupOk, gone: reading.sandboxGone, problems: reading.cleanupProblems }))));
    check('③ 每次 boot 都真的有 crashpad handler 在跑（否则这一条是空的）',
      readings.every((reading) => reading.handlerCount >= 1), JSON.stringify(readings.map((reading) => reading.handlerCount)));
    check('③ 每个 crashpad handler 的 `--database` 都落在**本次自己的沙箱**里（不再指向用户 `~/.config/chromium`）',
      readings.every((reading) => reading.handlerDatabases.length >= 1
        && reading.handlerDatabases.every((database) => typeof database === 'string' && database.startsWith(path.join(reading.isolation.xdgConfig, 'chromium')))),
      JSON.stringify(readings.map((reading) => ({ sandbox: reading.sandbox, databases: reading.handlerDatabases }))));
    check('③ 本次那棵树里没有任何进程引用用户真实 chromium home',
      readings.every((reading) => reading.referencesRealHome.length === 0),
      JSON.stringify(readings.flatMap((reading) => reading.referencesRealHome)));
    // ③ 的另一半原来硬断言「用户三处 chromium 目录（文件集合 + mtime + size）不变」—— 那断的是**别人的文件**：
    // 用户自己开着 Chromium 就会改它（而且那是**用户自己的** cwd/浏览），本门对它有**只读观察、没有写路径**。
    // “本门没写它”这句话的归属判据在上面两条（崩溃库落在本门沙箱里 ＋ 本门那棵树没有任何进程引用它）；
    // 快照比较器**不是死读数**这一半由 ④ 的 decoy（一份**本门自己造的** home）硬证。所以这里改成**只记录**。
    {
      const changed = readings.flatMap((reading) => reading.homeChanges.map((entry) => `${entry.relative}: ${entry.changed.slice(0, 3).join(', ')}`));
      print('③ 用户真实 chromium 目录观感（**只记录、不断言**）', changed.length === 0
        ? `本门这 ${rounds} 轮里三处目录的文件集合+mtime+size 没变（${readings.length} 轮）`
        : { 变了: changed, 归属: '用户自己的文件（或另一个开着 Chromium 的进程）在此窗口里写过 —— 不是本门的副作用：本门对这三处只有只读观察' });
    }

    // ④ 反证臂：隔离off + 继承环境 = decoy ⇒ 污染必须出现在 decoy 里（确定性红）。
    //    为什么在**子进程**里跑：被测的是「门在继承环境下会怎样」，所以继承环境必须真的是那一份 decoy
    //    （而不是在 spawn 处再补一层 override —— 那就变成测 override 了）。子进程里的 `browserSandboxEnv`
    //    走的是 `SOPHO_BROWSER_ISOLATION=off` 这条真实分支。
    const decoyTmp = path.join(decoyRoot, 'decoy-tmp');
    const decoyHome = path.join(decoyRoot, 'decoy-home');
    mkdirSync(decoyTmp, { recursive: true, mode: 0o700 });
    mkdirSync(decoyHome, { recursive: true, mode: 0o700 });
    const childEnv = { ...process.env, SOPHO_BROWSER_ISOLATION: 'off', HOME: decoyHome, TMPDIR: decoyTmp, TMP: decoyTmp, TEMP: decoyTmp };
    // 与这台机器上真实门的环境同形：XDG_CONFIG_HOME / XDG_CACHE_HOME **没设** ⇒ 崩溃库从 `$HOME/.config` 推。
    delete childEnv.XDG_CONFIG_HOME;
    delete childEnv.XDG_CACHE_HOME;
    const sharedTmpBefore = chromiumTempNames();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reverse-child'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    const line = stdout.split('\n').find((entry) => entry.startsWith('REVERSE-CHILD '));
    let childReport = null;
    try { childReport = line ? JSON.parse(line.slice('REVERSE-CHILD '.length)) : null; } catch (error) { childReport = { parseError: error.message }; }
    const sharedTmpAddedByChild = tempDelta(sharedTmpBefore);
    print('④ 反证臂（子进程读数）', { exitCode, childReport, 共享TMP增量: sharedTmpAddedByChild, stderrTail: stderr.trim().split('\n').slice(-2).join(' / ').slice(0, 300) });
    check('④ 反证：撤掉隔离 ⇒ 那两个 `org.chromium.Chromium.*` 落在**继承的 TMPDIR** 里（增量 > 0；真实门跑的时候那个 TMPDIR 就是共享 /tmp）',
      childReport?.childTmpDelta >= 1, JSON.stringify({ exitCode, childTmpDelta: childReport?.childTmpDelta, names: childReport?.childTempAdded }));
    check('④ 反证：撤掉隔离 ⇒ crashpad 的 `--database` 指向**那一份 home** 的 `chromium/Crash Reports`（⇒ 绿臂里「真实 home 不变」不是恒绿的死读数）',
      (childReport?.handlerDatabases ?? []).some((database) => typeof database === 'string' && database.startsWith(path.join(decoyHome, '.config', 'chromium'))),
      JSON.stringify({ handlerDatabases: childReport?.handlerDatabases, decoyHome }));
    check('④ 反证：同一套 home 快照比较器**看得见**那一份 home 被写（crashpad 的 settings.dat）',
      (childReport?.childHomeChanges ?? []).length > 0, JSON.stringify(childReport?.childHomeChanges));
    check('④ 反证臂的子进程自己也收干净了（它自己的沙箱没了）',
      childReport?.sandboxGone === true, JSON.stringify({ sandboxGone: childReport?.sandboxGone, sandbox: childReport?.sandbox }));
    // 反证臂的子进程其 TMPDIR 就是那份 decoy ⇒ 两条有关的硬判据都落在**本门自己造的 decoy** 上：
    //   · `childTmpDelta >= 1`（那些目录落在**继承来的** TMPDIR 里）；
    //   · `childHomeChanges.length > 0`（同一套 home 快照比较器看得见 decoy home 被写）。
    // 共享 /tmp 在同一窗口里的同名增量**只记录**：那是别人的（用户自己的 Chromium 就会建）——
    // 在并发行为者下“共享 /tmp 增量仍是 0”这种全机前后对比无效（理由见 ② 那一段）。
    print('④ 反证臂窗口内共享 /tmp 的同名增量（**只记录、不断言**）', {
      增量: sharedTmpAddedByChild.length, 名字: sharedTmpAddedByChild.slice(0, 12),
      归属: '别人的；反证臂自己的污染在上面两条硬判据里（落在 decoy 的 TMPDIR / decoy 的 home 里）',
    });
    assert.ok(childReport?.childTmpDelta >= 1, '反证臂没量到污染 —— 本门的判定力就是假的');
    assert.ok((childReport?.handlerDatabases ?? []).some((database) => typeof database === 'string' && database.startsWith(path.join(decoyHome, '.config'))), '反证臂没量到「崩溃库指向那一份 home」—— 本门的判定力就是假的');

    // ⑤ 收尾兜底路径的**确定性自检**（2026-09-23 总台验收后加）。
    // 为什么：那条「收敛式删除 + 到点判红」的路只在特定条件下才被执行 —— 本件就先踩过一次：
    // 一个 ReferenceError（`收尾兜底抛了：sleep is not defined`）藏在里面，只在我自己一条编辑间隙的
    // 未提交态/别人机器上炸过。现在这条路**每跑必走两次**，而且两条分支各自断言到读数的确定性那一半：
    //   · ⑤a 迟写者写一笔 ⇒ 收敛式删除必须**看见**它（passes ≥ 2）并把它收干净；
    //   · ⑤b 不罢休的写者 ⇒ 兜底必须**有界返回**并**如实交出剩余路径**（那就是判红的口）。
    const selfTestBucket = [];
    const lateTarget = path.join(decoyRoot, 'selftest-late');
    const stubbornTarget = path.join(decoyRoot, 'selftest-stubborn');
    rememberPath(lateTarget, stubbornTarget);
    mkdirSync(lateTarget, { recursive: true });
    mkdirSync(stubbornTarget, { recursive: true });
    const lateWriter = lateWriterAfterRemoval(lateTarget, { recreateTimes: 1 });
    const stubbornWriter = lateWriterAfterRemoval(stubbornTarget, { recreateTimes: 1_000_000, everyMs: 25 });
    let lateResult = null;
    let stubbornResult = null;
    try {
      lateResult = await removeCreatedPaths([lateTarget], '⑤a 迟写者（自检）', { budget: { quietMs: 500 }, bucket: selfTestBucket });
      await lateWriter.done;
      stubbornResult = await removeCreatedPaths([stubbornTarget], '⑤b 不罢休的写者（自检）', { budget: { passes: 2, pauseMs: 100, quietMs: 150 }, bucket: selfTestBucket });
      stubbornWriter.stop();
      await stubbornWriter.done;
    } finally {
      lateWriter.stop();
      stubbornWriter.stop();
      await Promise.race([Promise.allSettled([lateWriter.done, stubbornWriter.done]), sleep(2000)]);
    }
    print('⑤ 兜底路径自检读数', { late: lateResult, lateWritten: lateWriter.written, lateError: lateWriter.error?.message ?? null, stubborn: stubbornResult, stubbornWritten: stubbornWriter.written, stubbornError: stubbornWriter.error?.message ?? null });
    check('⑤ 兜底路径**真的被走到**：迟写者写回来的那条被收敛式删除收掉（passes ≥ 2、剩余 0）',
      lateResult?.passes >= 2 && lateResult.remaining === undefined && !existsSync(lateTarget),
      JSON.stringify({ late: lateResult, written: lateWriter.written, lateTarget }));
    check('⑤ 不罢休的写者 ⇒ 兜底**有界返回**（passes 到点）并**如实交出剩余路径**（remaining 非空 = 门会判红的那一半）',
      stubbornResult?.passes === 2 && stubbornResult.remaining?.length === 1,
      JSON.stringify({ stubborn: stubbornResult }));
    check('⑤ 自检没污染真问题账：局部 bucket 为空（自检的删除/判红都走自己的账）',
      selfTestBucket.length === 0, JSON.stringify(selfTestBucket));
    // 自检自己造的两条路径自己收（写者已停 ⇒ 这一次必须一次收敛）。
    const selfTestDisposal = await removeCreatedPaths([lateTarget, stubbornTarget], '⑤ 自检自己的收尾', { bucket: selfTestBucket });
    check('⑤ 自检自己收干净（写者停了之后一次收敛）',
      selfTestDisposal.remaining === undefined && !existsSync(lateTarget) && !existsSync(stubbornTarget),
      JSON.stringify(selfTestDisposal));
    assert.ok(lateResult?.passes >= 2, '迟写者那条没走到收敛路径 —— 这条自检就是假的');
    assert.ok(stubbornResult?.remaining?.length === 1, '不罢休的写者那条没量到「如实交出剩余」—— 这条自检就是假的');

    // ⚠️ ⑥⑦ 这两个形状都靠 POSIX 的 bash + `ppid=1`（reparent 到 init）；win32 上造不出来，
    // 所以那两个臂在 win32 上**跳过并如实说明**（不当绿也不当红）—— 本件只在 Linux 上验过。
    if (process.platform === 'win32') {
      print('⑥⑦ 在 win32 上跳过', { reason: "bash 起进程 + ppid=1 这个形状造不出来（本件只在 Linux 上验过）" });
    } else {
      // ⑥ 「会被 reparent 的迟写者」（crashpad handler 那种形状）＋ 认领的第三条腿
      //   形状：命令行里带**本次 run 自己创建的路径**（`--database=<沙箱>/xdg-config/chromium/Crash Reports`，
      //   和真 handler 的旗标一样）＋ 起它的 shell 立刻退出 ⇒ 它被 reparent 到 init（`ppid=1`），
      //   pid 树与「本引擎 profile 目录」两条腿都跟不到它。
      //   绿半：`close()` 必须按「本次 run 自己创建的路径」把它认出来并收掉；
      //   红半（撤掉那条认领腿，`SOPHO_UI_CLAIM=off`）：它必须**活下来**（⇒ 这条腿是承重的，不是装饰）。
      const plantReparentedWriter = async (marker) => {
        // `--` 不能省：node 会把没隔开的 `--database=…` 当成自己的选项、报错即退（实测）。
      const child = spawn('bash', ['-c', `node -e 'setInterval(()=>{},1000)' -- --database=${JSON.stringify(marker)} >/dev/null 2>&1 & echo $!`], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        await new Promise((resolve) => child.once('exit', resolve));
        const pid = Number(out.trim().split('\n').filter(Boolean).pop());
        // 等它真的被 reparent（有上界）：ppid=1 之后，这次收尾只能靠认领路径那条腿。
        const deadline = Date.now() + 10_000;
        let row = null;
        while (Date.now() < deadline) {
          row = (await processTable()).find((candidate) => candidate.pid === pid) ?? null;
          if (row && row.ppid === 1) break;
          await sleep(50);
        }
        return { pid, row, reparented: row?.ppid === 1, commandLine: row?.commandLine ?? '' };
      };
      const ranWriterUnder = async ({ isolated, label }) => {
        if (!isolated) process.env.SOPHO_UI_CLAIM = 'off';
        let page = null;
        let planted = null;
        try {
          page = await boot({ routes: async () => false });
          rememberPath(page.sandbox);
          planted = await plantReparentedWriter(`${page.isolation.xdgConfig}/chromium/Crash Reports`);
          const before = { pid: planted.pid, ppid: planted.row?.ppid ?? null, 带本沙箱路径: planted.commandLine.includes(page.isolation.xdgConfig), claimMarkers: page.cleanup.claimMarkers };
          const facts = await page.close(problems);
          const aliveAfterClose = await processAlive(planted.pid);
          print(`  · ${label} 现场`, { ...before, aliveAfterClose, survivors: facts.survivors, removed: facts.removed });
          return { before, aliveAfterClose, facts };
        } finally {
          if (page) await page.close(problems).catch(() => {});
          if (planted?.pid) {
            // 无论哪一派，这条自己起的东西都按**精确 pid** 收掉（红半里它就是要活下来的那个）。
            try { process.kill(planted.pid, 'SIGKILL'); } catch {}
            for (let attempt = 0; attempt < 40 && await processAlive(planted.pid); attempt += 1) await sleep(50);
          }
          delete process.env.SOPHO_UI_CLAIM;
        }
      };
      const claimedRun = await ranWriterUnder({ isolated: true, label: '⑥ 认领腿开' });
      check('⑥ 会的 reparent 的迟写者被 `close()` 按「本次 run 自己创建的路径」认出来并收掉（绿半）',
        claimedRun.before?.['带本沙箱路径'] === true && claimedRun.before?.ppid === 1 && claimedRun.aliveAfterClose === false,
        JSON.stringify(claimedRun.before));
      check('⑥ 认领口径里真的有「本次 run 自己创建的路径」（沙箱根 + 四个私有目录）',
        Array.isArray(claimedRun.before?.claimMarkers) && claimedRun.before.claimMarkers.some((marker) => marker.endsWith('/xdg-config')) && claimedRun.before.claimMarkers.some((marker) => marker.endsWith('/tmp')),
        JSON.stringify(claimedRun.before?.claimMarkers));
      const unclaimedRun = await ranWriterUnder({ isolated: false, label: '⑥ 认领腿关（反证）' });
      check('⑥ 反证：撤掉那条认领腿（`SOPHO_UI_CLAIM=off`）⇒ 同一个迟写者**活下来**（⇒ 这条腿是承重的，不是装饰）',
        unclaimedRun.aliveAfterClose === true && (unclaimedRun.before?.claimMarkers ?? []).length === 1,
        JSON.stringify({ aliveAfterClose: unclaimedRun.aliveAfterClose, claimMarkers: unclaimedRun.before?.claimMarkers }));
      assert.ok(claimedRun.aliveAfterClose === false, '认领腿没把 reparent 的迟写者收掉 —— 绿半是假的');
      assert.ok(unclaimedRun.aliveAfterClose === true, '撤掉认领腿之后它竟然也被收掉了 —— 红半量不到东西');

      // ⑦ 共享层那个入口（`test/harness.mjs` 的 `removeSandbox`，121 处调用）也是收敛式的
      //   —— 这是「所有走这个底座的门自动继承」那条派单要求的机械证据：迟写者写一笔 ⇒ 看见并收掉；
      //   不罢休的写者 ⇒ **如实记问题**（那就是判红的口）。
      const sharedTarget = path.join(decoyRoot, 'selftest-shared');
      mkdirSync(sharedTarget, { recursive: true });
      rememberPath(sharedTarget);
      const sharedWriter = lateWriterAfterRemoval(sharedTarget, { recreateTimes: 1 });
      const sharedProblems = [];
      const sharedResult = await removeSandbox(sharedTarget, sharedProblems, '⑦ 共享入口（自检）');
      await sharedWriter.done;
      print('  · ⑦ 共享入口读数', { result: { passes: sharedResult.passes, removed: sharedResult.removed, reappeared: sharedResult.reappeared, remaining: sharedResult.remaining }, problems: sharedProblems, written: sharedWriter.written });
      check('⑦ 共享层 `removeSandbox` 也是收敛式的：迟写者写回来的那条被收掉（passes ≥ 2、剩余 0、不记问题）',
        sharedResult.passes >= 2 && sharedResult.remaining === undefined && !existsSync(sharedTarget) && sharedProblems.length === 0,
        JSON.stringify({ passes: sharedResult.passes, remaining: sharedResult.remaining, problems: sharedProblems }));
      const stubbornShared = path.join(decoyRoot, 'selftest-shared-stubborn');
      mkdirSync(stubbornShared, { recursive: true });
      rememberPath(stubbornShared);
      const stubbornSharedWriter = lateWriterAfterRemoval(stubbornShared, { recreateTimes: 1_000_000, everyMs: 25 });
      const stubbornSharedProblems = [];
      let stubbornSharedResult = null;
      try {
        stubbornSharedResult = await removeSandbox(stubbornShared, stubbornSharedProblems, '⑦ 共享入口·不罢休的写者（自检）', { budget: { passes: 2, pauseMs: 100, quietMs: 150 } });
        stubbornSharedWriter.stop();
        await stubbornSharedWriter.done;
      } finally {
        stubbornSharedWriter.stop();
        await Promise.race([stubbornSharedWriter.done, sleep(2000)]);
      }
      print('  · ⑦ 共享入口·不罢休的写者读数', { passes: stubbornSharedResult?.passes ?? null, remaining: stubbornSharedResult?.remaining ?? null, problems: stubbornSharedProblems, written: stubbornSharedWriter.written });
      check('⑦ 共享层入口在删不掉时**如实记问题**（带路径）—— 那就是 finishCleanup 判红的口',
        stubbornSharedProblems.length === 1 && stubbornSharedProblems[0].includes(stubbornShared) && stubbornSharedResult?.remaining === true,
        JSON.stringify({ problems: stubbornSharedProblems, remaining: stubbornSharedResult?.remaining }));
      const stubbornSharedDisposal = await removeCreatedPaths([stubbornShared], '⑦ 自检自己的收尾', { bucket: stubbornSharedProblems });
      check('⑦ 自检自己收干净（写者停了一次收敛）',
        stubbornSharedDisposal.remaining === undefined && !existsSync(stubbornShared), JSON.stringify(stubbornSharedDisposal));
      assert.ok(sharedResult.passes >= 2, '共享入口没走到收敛路径 —— 这条自检就是假的');
      assert.ok(stubbornSharedProblems.length === 1, '共享入口没把「删不掉」如实记成问题 —— 那条判断是假的');
    }

  } catch (error) {
    primaryError = error;
  } finally {
    const disposal = await removeCreatedPaths([...createdPaths], '收尾兜底（精确路径）')
      .catch((error) => { problems.push(`收尾兜底抛了：${error.message}`); return null; });
    check('⑥ 自清：本门自己造的 decoy / boot 沙箱一条不剩（收敛式：又出现就再删，仍留着判红）',
      disposal !== null && disposal.remaining === undefined,
      JSON.stringify(disposal ?? { 抛了: true }));
    if (disposal?.remaining?.length > 0) {
      problems.push(`收尾兜底：本门自己造的 ${disposal.remaining.length} 条路径删了 ${disposal.passes ?? '若干'} 遍仍留着（可能有自家迟写者/reparent 的 handler 又把它建回来）：${disposal.remaining.join(' / ')}`);
    }
  }
  let thrown = null;
  try {
    finishCleanup(primaryError, problems);
  } catch (error) {
    thrown = error;
  }
  const ok = primaryError === null && thrown === null && failures.length === 0;
  process.stdout.write(`RESULT: browser-sandbox-isolation ${ok ? 'PASS' : 'FAIL'} (${checks} checks)` +
    `${failures.length ? `; 失败的判据=${JSON.stringify(failures)}` : ''}` +
    `${primaryError ? `; 原始错误=${primaryError.message}` : ''}` +
    `${thrown ? `; ${thrown.message}` : ''}\n`);
  if (!ok) process.exitCode = 1;
}
