#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanBrowserSpawnIsolation } from './browser-spawn-scan.mjs';
import { assertOneEngine, cleanupStep, describeEngineRoot, engineCensus, finishCleanup, listenerRows, oneEngineProblems, processAlive, processTable, removeSandbox, runArms, sameDirectory, unparsedEngineRootRows } from './harness.mjs';
import { OUR_ENGINE_SHAPES, SHAPE_INVENTORY, censusForShape, censusWithSecondOwnEngine, censusWithoutOwnToken, handleForShape, syntheticListenerRowsOf, windowsEngineShapeArms } from './fixtures/windows-engine-shapes.mjs';
import { RUN_ID, RUN_TOKEN_NAME, SANDBOX_PREFIX, boot, readRunToken, waitFor } from './ui-harness.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = path.dirname(fileURLToPath(import.meta.url));

// ── portability: no gate may do its own process management ────────────────────────────────
//
// The rule is old: a gate must ask `test/harness.mjs` for the listening pid / the command
// line / the teardown, because that module is where the platform branch lives (PowerShell on
// Windows, `ss` + `/proc` elsewhere). A gate that shells out to `ss` or reads `/proc` itself
// silently stops being portable.
//
// What was wrong until 2026-09-21 was the REACH, in two independent ways:
//
//   1. the scope was a HARDCODED list of 16 filenames, all in `test/` itself. Anything one
//      directory down was invisible -- and `test/fixtures/sandbox-mini-harness.mjs` is a real
//      harness: it spawns the sandbox entry, and in `--mode guard` it drives
//      `test/sandbox-guard.mjs` and waits for the guard's `sandbox-start` IPC message. That
//      fixture harness leaked a sandbox for hours with this gate looking straight past it.
//      Any gate added after the list was written was equally invisible until somebody
//      remembered to append a name (the list had been hand-extended twice: 12 -> 13 -> 16).
//   2. the patterns only matched two spellings. `test/drag-select-cost.mjs` does its whole
//      POSIX teardown by enumerating `/proc` and reading process-group state, and it writes it
//      as `const PROC_ROOT = '/proc'` -- no `/proc/` with a trailing slash anywhere, so even
//      had it been on the list the old regex would have seen a clean file.
//
// So the list is gone, replaced by two derived sets:
//
//   · SCANNED = every `.mjs` under `test/`, recursively (so `test/fixtures/**` is in).
//   · FAMILY  = the subset that takes part in the sandbox machinery. Derived, reported, and
//     asserted to have grown -- the point is that it grows by itself when a gate is added,
//     not that a human remembered it.
//
// Numbers may change (that is what "derived" means); the assertions below may not be relaxed.
const PLATFORM_LAYER = new Set([
  // Where the platform-specific calls are SUPPOSED to live. The rule is "call the layer, do
  // not re-implement it", so the layer itself is out of scope -- named here, never hidden.
  'harness.mjs',          // shared harness: owns `ss` / `/proc` and the win32 branches
  'sandbox-guard.mjs',    // guard: owns the POSIX process-group read
  'harness-contract.mjs', // this gate: defines the patterns below, so they appear verbatim here
]);

const forbidden = [
  { label: 'ss', pattern: /(?:execFileSync|execFileAsync|execFile|spawnSync|spawn)\s*\(\s*['"]ss['"]/ },
  // The procfs root as a literal: `'/proc'`, `'/proc/'`, or a template that starts with it.
  // Reaches pid-addressed reads (`/proc/${pid}/cmdline`), enumeration (`'/proc'` assigned to a
  // constant and handed to readdir) and metrics reads alike -- all of them are POSIX-only.
  { label: '/proc', pattern: /['"`]\/proc(?:['"`]|\/)/ },
];

// Pre-existing POSIX-only gates. Each entry names the rules THAT file is allowed to break:
// a rule it breaks without declaring it is still a violation (so a debt file cannot hide a
// newly added one), and an entry whose rule no longer fires is a failure too -- this list may
// only shrink. The honest follow-up is to move each of these onto `test/harness.mjs`; until
// then they are named here rather than being silently skipped.
//
// 2026-09-25: the list is EMPTY. Every one of the 15 pre-existing entries was moved onto the layer
// (listenerPid / listenerRows / processCommandLine / processInfoOf / processGroupId /
// processEnvironment / processTable / systemMemoryMiB / createProcessSampler / stopOwnedListener),
// so no gate reads `ss` or procfs itself any more. The mechanism below is kept, and its red arm
// now builds its declared map locally (see self-test ③) -- a gate that can no longer go red is
// not a gate, even when there is no debt left to declare.
const portabilityDebt = new Map([
]);

// Why this gate runs the scanner over a temporary copy as well: a detector that never goes red
// is not a detector. The arms below are built on COPIES of the real files, so the real tree is
// never touched, and one of them is the harness the old hardcoded list could never see.
async function scanPortability(directory, files, debt = portabilityDebt) {
  const violations = [];
  for (const relative of files) {
    const source = await readFile(path.join(directory, relative), 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      for (const rule of forbidden) {
        if (rule.pattern.test(line)) {
          violations.push({ file: relative, line: index + 1, rule: rule.label, text: line.trim() });
        }
      }
    });
  }
  const declared = (violation) => (debt.get(violation.file) ?? []).includes(violation.rule);
  const unlisted = violations.filter((violation) => !declared(violation));
  const fired = new Set(violations.filter(declared).map((violation) => `${violation.file}:${violation.rule}`));
  // Only the debt entries for files actually in this scan: the self-test scans single copies,
  // so a global sweep here would report every real debt file as "stale" in the probe arms.
  const inScope = new Set(files);
  const stale = [];
  for (const [file, rules] of debt) {
    if (!inScope.has(file)) continue;
    for (const rule of rules) if (!fired.has(`${file}:${rule}`)) stale.push(`${file}:${rule}`);
  }
  return { violations, unlisted, stale };
}

const format = (entries) => entries.map((entry) => `${entry.file}:${entry.line}: ${entry.rule}: ${entry.text}`).join('\n');

const scanned = [];
for await (const relative of walkFiles(root)) {
  if (!relative.endsWith('.mjs')) continue;
  if (PLATFORM_LAYER.has(relative)) continue;
  scanned.push(relative);
}
scanned.sort();
for (const file of portabilityDebt.keys()) {
  assert.ok(scanned.includes(file), `the portability debt list names ${file}, which is not scanned any more -- delete that entry`);
}

const portability = await scanPortability(root, scanned);
assert.deepEqual(portability.unlisted, [], `portable harness violations (${portability.unlisted.length}); ask test/harness.mjs (listenerPid / processCommandLine / stopOwnedListener) instead of using ss or /proc directly:\n${format(portability.unlisted)}`);
assert.deepEqual(portability.stale, [], `portability debt entries whose rule no longer fires -- delete them (this list may only shrink):\n${portability.stale.join('\n')}`);

// ── browser sandbox isolation: every spawned browser must get a private env ───────────────────
//
// Why (2026-09-23, chromium-isolation; raw readings in the delivery report): a gate that hands the
// spawned browser the *inherited* environment leaks in two places that are easy to miss, because
// neither of them is under `--user-data-dir`:
//   · the two `org.chromium.Chromium.*` temp directories (ProcessSingleton socket +
//     `chromium_chrome_url_fetcher_`) go to the inherited TMPDIR -- the shared /tmp for a gate;
//   · `chrome_crashpad_handler --database=$HOME/.config/chromium/Crash Reports` points the crash
//     database at the user's real home and writes there (`settings.dat`).
// The rule is one line per spawn site: `env: browserSandboxEnv(<the gate's own sandbox root>)`
// (`test/harness.mjs`). This section is what makes the rule mechanical instead of a habit: it walks
// every `.mjs` under `test/` and refuses a browser spawn that does not carry that envelope.
const BROWSER_SCAN_EXEMPT = new Set([
  'browser-spawn-scan.mjs',   // defines the rule, spawns nothing
]);
const browserSites = [];
const browserViolations = [];
for (const relative of scanned) {
  if (BROWSER_SCAN_EXEMPT.has(relative)) continue;
  const source = await readFile(path.join(root, relative), 'utf8');
  const { sites, violations } = scanBrowserSpawnIsolation(source, relative);
  browserSites.push(...sites);
  browserViolations.push(...violations);
}
const realBrowserSites = browserSites.filter((site) => !site.standIn);
assert.deepEqual(browserViolations, [],
  `browser spawn sites without a private environment (${browserViolations.length}); pass env: browserSandboxEnv(<your sandbox root>) from test/harness.mjs so the browser writes neither to the shared /tmp nor to the user's real home:\n${browserViolations.map((violation) => `${violation.file}:${violation.line}: ${violation.text}`).join('\n')}`);
// A detector that finds nothing is worse than no detector: the known browser-spawning suites are
// 40+ files (50 of them were the ones fixed by this rule). Without this floor the scan would go
// silently green the day the pattern stops matching.
assert.ok(realBrowserSites.length >= 40,
  `only ${realBrowserSites.length} browser spawn site(s) recognised under test/ (expected 40+); the matcher or the gate family changed -- fix the matcher rather than lowering this floor:\n${browserSites.map((site) => `${site.file}:${site.line}`).join(', ')}`);

// The family, derived rather than listed: a file is in it when it starts a sandbox entry,
// drives the guard, uses the shared harness, speaks the guard's own command-line protocol, or
// is named like one of those (the two `*-guard` gates that only read sources are named that
// way on purpose). A gate is not "in the family" by being written down somewhere.
const FAMILY_MARKERS = [
  { label: 'starts a sandbox entry', pattern: /server[\\/](?:base|worker|app)\.mjs/ },
  { label: 'drives test/sandbox-guard.mjs', pattern: /sandbox-guard\.mjs/ },
  { label: 'uses test/harness.mjs', pattern: /from\s+['"](?:\.\/|\.\.\/)harness\.mjs['"]/ },
  { label: 'speaks the guard protocol', pattern: /['"]--watch-stdin['"]|['"]--lifetime-ms['"]|['"]--record['"]/ },
  { label: 'names a browser sandbox profile', pattern: /--(?:user-data-dir|profile)[= ]/ },
];
const FAMILY_NAME = /(?:^|[-_.])(?:harness|guard)(?:[-_.]|$)/i;
const family = [];
for (const relative of scanned) {
  // harness-contract.mjs is the platform layer above, so it never reaches this loop; nothing
  // else is filtered -- a new file has to match nothing here to stay out of the family.
  const source = await readFile(path.join(root, relative), 'utf8');
  const reasons = FAMILY_MARKERS.filter(({ pattern }) => pattern.test(source)).map(({ label }) => label);
  if (FAMILY_NAME.test(path.basename(relative))) reasons.push('named *harness* / *guard*');
  if (reasons.length > 0) family.push({ file: relative, reasons });
}
// The one the hardcoded 16-name list could not see, one directory down. It is the acceptance
// target for this whole section: if a change makes it invisible again, this goes red.
const MISSED_HARNESS = 'fixtures/sandbox-mini-harness.mjs';
assert.ok(scanned.includes(MISSED_HARNESS), `${MISSED_HARNESS} is not scanned any more -- the scope must cover the whole test/ tree, fixtures included`);
assert.ok(family.some(({ file }) => file === MISSED_HARNESS), `${MISSED_HARNESS} must be recognised as harness family`);

// ── 「一次 boot() 只起一个引擎」：机械判据 + 三条臂 ────────────────────────────────────────────
//
// 为什么（2026-09-25）：这条前提一直靠**自觉** —— 「一次 `boot()` 起一个引擎（一个 A + 它的 worker
// + 一个浏览器树）」写在各门的注释里，却没有机械判据；而本仓已经实测过「一次 boot 之后现场多出不止
// 一个进程树/监听者」的后果。这里把「恰好一个」变成会红的断言。
//
// 落点（如实记）：派单写的是「`test/harness.mjs` 里给 `boot()` 加自检」，但 `boot()` **不在**
// `test/harness.mjs` —— 它在 `test/ui-harness.mjs`（web/ 前端契约门共用的底座）。本件纪律只允许动
// `test/harness.mjs` + `test/harness-contract.mjs`，所以：**读数原语与判据原文**加在 `test/harness.mjs`
// （`browserEngineRootOf` / `engineCensus` / `assertOneEngine`，三条判据与口径边界写在那边的注释里），
// **臂**加在本文件。这个落点还顺带避开了一个坑：判据站在被测物**外面**看现场，而不是用 `boot()`
// 自己的收尾账本给自己打分（后者是自证）。
//
// 四条臂：三条必须绿（①边界 ②正臂 ③收尾腿）、一条必须红（④反证）—— 一条不能红的判据不是判据：
//   ① 边界（必须绿）：造一个「别人的引擎」（替身进程 + 带**别人令牌**的沙箱）⇒ 判据不许因为它变红。
//      本机实测别人的引擎**真的**同时存在（派单前探针的原始读数：一个 `/tmp/sopho-ui-<随机>` 主进程
//      带 8 个 `--type=` 子进程、属于别一个进程），按「全机 chromium 数量」写就是假红机。
//   ② 正臂（必须绿）：一次真 `boot()` ⇒ 判据绿，并打出原始读数（引擎根 / 监听行 / 自己那棵树）。
//   ③ 收尾腿（必须绿）：`close()` 之后本次 run 的引擎根回到 0 个、两条端口 0 行，且**别人的引擎
//      还活着**（收尾只按 pid + cmdline 认领，不许误伤别人的进程）。
//   ④ 反证（必须红）：把 `ui-harness.mjs` + `harness.mjs` 拷进一个临时副本，在**副本**里让 `boot()`
//      自己起**第二个**引擎（profile = `<沙箱>/chromium2`、端口另取一个），拿**真判据**打那份副本
//      ⇒ 必须红，且点名多出来的 pid / 端口 / profileDir。打副本而不是改真树：反证臂要证的是「这一处
//      一改、真判据就红」，拿真树去改就污染正交付的东西（本仓踩过）。副本建在 `os.tmpdir()`（这三份
//      文件只 import node 内建 ⇒ 不需要 node_modules），跑完删掉。
const cleanupProblems = [];
let primaryError = null;

const engineArms = { baseline: null, boundary: null, positive: null, teardown: null, reverse: null };
const engineOwnedPaths = [];
let engineHandle = null;
let engineStandIn = null;
try {
  const census = () => engineCensus({ runId: RUN_ID, tokenIdOf: readRunToken });

  // ⓪ 基线：boot() 之前本次 run 的引擎根必须是 0 个。有的话，后面每一条「恰好一个」都会变成「恰好两个」
  //    —— 这条基线接住的正是「本 run 早先起的引擎没收干净」。
  const baseline = await census();
  engineArms.baseline = { mine: baseline.mine.length, foreign: baseline.foreign.length };
  process.stdout.write(`engine census: boot() 之前 —— 本次 run 的引擎根 ${baseline.mine.length} 个 / 别人的引擎 ${baseline.foreign.length} 个${baseline.foreign.length ? `（例如 ${describeEngineRoot(baseline.foreign[0])}）` : ''}\n`);
  assert.equal(baseline.mine.length, 0, `boot() 之前本次 run 的引擎根必须是 0 个（实测 ${baseline.mine.length} 个）—— 本 run 早先起的引擎没收干净：${baseline.mine.map(describeEngineRoot).join(' ｜ ')}`);

  // ① 边界臂：一个**持有别人令牌**的引擎根（替身进程，真 chromium 不必）—— 它不算本次 run 的引擎。
  //    替身的命令行里带浏览器旗标（`--headless=new` + `--user-data-dir=`）⇒ 按本仓既有「认旗标不认
  //    进程名」的口径，它就是一个引擎根；令牌 id 不是本次 run ⇒ 必须被判成 `foreign`。
  const foreignSandbox = await mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX));
  engineOwnedPaths.push(foreignSandbox);
  const foreignTokenId = `not-this-run-${randomUUID()}`;
  await writeFile(path.join(foreignSandbox, RUN_TOKEN_NAME), `${JSON.stringify({ id: foreignTokenId, pid: process.pid, startedAt: new Date().toISOString(), directory: foreignSandbox, note: 'harness-contract 造的「别人的引擎」，不是本次 run 的' }, null, 2)}\n`, 'utf8');
  engineStandIn = spawn(process.execPath, [
    path.join(root, 'fixtures', 'sandbox-stand-in-browser.mjs'),
    '--headless=new',
    `--user-data-dir=${path.join(foreignSandbox, 'chromium')}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  await waitFor(async () => (await census()).foreign.some((row) => row.pid === engineStandIn.pid), `替身引擎（pid ${engineStandIn.pid}）没能在引擎人口普查里出现`, 8000);
  engineArms.boundary = { pid: engineStandIn.pid, sandbox: foreignSandbox, tokenId: foreignTokenId };

  // ② 正臂：一次真 boot() ⇒ 判据必须绿；顺带把「这一次 boot() 到底起了几样东西」按原始读数打出来。
  engineHandle = await boot({ routes: async () => false });
  const positive = await assertOneEngine(engineHandle, { runId: RUN_ID, tokenIdOf: readRunToken, label: '正臂：一次 boot() 只许起一个引擎' });
  const treeRows = (await processTable()).filter((row) => (row.commandLine ?? '').includes(engineHandle.sandbox));
  engineArms.positive = {
    port: engineHandle.port,
    debugPort: engineHandle.debugPort,
    pid: engineHandle.cleanup.pid,
    profileDir: engineHandle.profileDir,
    sandbox: engineHandle.sandbox,
    mine: positive.mine.map(describeEngineRoot),
    foreign: positive.foreign.length,
    tree: treeRows.map((row) => `${row.pid}:${row.name}`),
  };
  assert.ok(positive.foreign.some((row) => row.pid === engineStandIn.pid), `边界臂：替身引擎（pid ${engineStandIn.pid}）必须被算成「别人的引擎」，实测 foreign=${JSON.stringify(positive.foreign.map(describeEngineRoot))}`);
  assert.ok(!positive.mine.some((row) => row.pid === engineStandIn.pid), '边界臂：替身引擎不许被算成本次 run 的引擎 —— 归属必须只看带内令牌 id，不看进程名/端口');
  process.stdout.write(`engine census: 正臂 boot() —— 本次 run 的引擎根 ${positive.mine.length} 个 [${positive.mine.map(describeEngineRoot).join(' ｜ ')}]\n`);
  process.stdout.write(`engine census: 正臂 boot() —— 别人的引擎 ${positive.foreign.length} 个（边界臂的替身 pid=${engineStandIn.pid}、令牌=${foreignTokenId} 在内；判据不许因为它变红）\n`);
  process.stdout.write(`engine census: 正臂 boot() —— 静态服务端口 ${engineHandle.port} 的监听行 ${JSON.stringify(positive.serverRows.map((row) => row.raw))}\n`);
  process.stdout.write(`engine census: 正臂 boot() —— 调试端口 ${engineHandle.debugPort} 的监听行 ${JSON.stringify(positive.debugRows.map((row) => row.raw))}\n`);
  process.stdout.write(`engine census: 正臂 boot() —— 这一次 boot() 起的东西（命令行带它自己的沙箱 ${engineHandle.sandbox}）共 ${treeRows.length} 个：${treeRows.map((row) => `${row.pid}:${row.name}`).join(' ')}\n`);

  // ③ 收尾腿：close() 之后回到 0 个 / 0 行，且**不许误伤别人的引擎**。
  const closed = await engineHandle.close();
  engineHandle = null;
  assert.deepEqual(closed.survivors, [], `收尾之后不许剩下自有进程：${JSON.stringify(closed.survivors)}`);
  assert.deepEqual(closed.problems, [], `收尾自身不许有问题：${JSON.stringify(closed.problems)}`);
  const afterClose = await census();
  const debugRowsAfter = await listenerRows(engineArms.positive.debugPort);
  const serverRowsAfter = await listenerRows(engineArms.positive.port);
  engineArms.teardown = { mine: afterClose.mine.length, debugRows: debugRowsAfter.length, serverRows: serverRowsAfter.length, treeWaitMs: closed.treeWaitMs };
  assert.equal(afterClose.mine.length, 0, `close() 之后本次 run 的引擎根必须回到 0 个（实测 ${afterClose.mine.length} 个）：${afterClose.mine.map(describeEngineRoot).join(' ｜ ')}`);
  assert.equal(debugRowsAfter.length, 0, `close() 之后调试端口 ${engineArms.positive.debugPort} 不该还有监听行：${JSON.stringify(debugRowsAfter.map((row) => row.raw))}`);
  assert.equal(serverRowsAfter.length, 0, `close() 之后静态服务端口 ${engineArms.positive.port} 不该还有监听行：${JSON.stringify(serverRowsAfter.map((row) => row.raw))}`);
  assert.ok(await processAlive(engineStandIn.pid), '收尾不许误伤别人的引擎（替身在 close() 之后必须还活着）');

  // ④ 反证臂：在副本里让 boot() 自己起第二个引擎 —— 真判据必须红，且点名它。
  const mutantRoot = await mkdtemp(path.join(os.tmpdir(), 'sopho-engine-mutant-'));
  engineOwnedPaths.push(mutantRoot);
  for (const file of ['ui-harness.mjs', 'harness.mjs']) await cp(path.join(root, file), path.join(mutantRoot, file));
  const mutantUiHarness = path.join(mutantRoot, 'ui-harness.mjs');
  const originalSource = await readFile(mutantUiHarness, 'utf8');
  const spawnAnchor = "], { stdio: ['ignore', 'ignore', 'pipe'], env: browserSandboxEnv(sandbox) });";
  const injection = [
    '',
    '  // 反证臂注入（只在副本里）：让**这一次** boot() 自己起第二个引擎 —— profile 换个子目录、端口另取一个。',
    '  spawn(chrome, [\'--headless=new\', \'--no-sandbox\', \'--disable-gpu\', `--remote-debugging-port=${await reservePort()}`, `--user-data-dir=${profileDir}2`, \'about:blank\'], { stdio: [\'ignore\', \'ignore\', \'pipe\'], env: browserSandboxEnv(sandbox) });',
    '',
  ].join('\n');
  const mutantSource = originalSource.replace(spawnAnchor, `${spawnAnchor}${injection}`);
  assert.notEqual(mutantSource, originalSource, `反证臂注入没命中：副本的 ui-harness.mjs 里找不到锚点 ${JSON.stringify(spawnAnchor)} —— boot() 的 spawn 语句变了，这条臂要同步改（不许静默跳过）`);
  await writeFile(mutantUiHarness, mutantSource, 'utf8');
  const probeFile = path.join(mutantRoot, 'reverse-probe.mjs');
  await writeFile(probeFile, [
    '#!/usr/bin/env node',
    '// 反证臂专用探针（只活在临时副本里，不入库）：拿**真判据**打「boot() 自己起了两个引擎」的副本。',
    "import { boot, RUN_ID, readRunToken } from './ui-harness.mjs';",
    "import { assertOneEngine, finishCleanup } from './harness.mjs';",
    'const handle = await boot({ routes: async () => false, webRoot: process.argv[2] });',
    'let primary = null;',
    'try {',
    "  const report = await assertOneEngine(handle, { runId: RUN_ID, tokenIdOf: readRunToken, label: '反证臂：副本里 boot() 自己起了两个引擎' });",
    '  primary = new Error(`反证臂是假的：改了这一处，判据居然还是绿的（本次 run 的引擎根 ${report.mine.length} 个）`);',
    '} catch (error) {',
    '  primary = error;',
    '}',
    'const cleanup = await handle.close();',
    'finishCleanup(primary, [...cleanup.problems]);',
    '',
  ].join('\n'), 'utf8');
  let mutantExitCode = 0;
  let mutantOutput = '';
  try {
    const reply = await execFileAsync(process.execPath, [probeFile, path.join(root, 'web')], { maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000 });
    mutantOutput = `${reply.stdout}\n${reply.stderr}`;
  } catch (error) {
    mutantExitCode = typeof error.code === 'number' ? error.code : 1;
    mutantOutput = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  }
  const extraLine = (mutantOutput.split('\n').find((line) => line.includes('多出来的引擎')) ?? '').trim();
  // 点名的是**多出来的那个**（不是句柄那个）—— 从「多出来的引擎（…）：」后面取 pid/端口。
  const namedExtra = /多出来的引擎（不是句柄指名的 pid \d+）：pid=(\d+) debugPort=(\d+)/.exec(extraLine);
  engineArms.reverse = { exitCode: mutantExitCode, extraLine, named: namedExtra ? `pid=${namedExtra[1]} debugPort=${namedExtra[2]}` : null };
  process.stdout.write(`engine census: 反证臂（副本里 boot() 自己起第二个引擎）—— 退出码 ${mutantExitCode}；判据点名的那一行：${extraLine || '(没有出现「多出来的引擎」这条)'}\n`);
  assert.notEqual(mutantExitCode, 0, `反证臂：副本里的判据必须红（退出码非 0），实测 0。副本输出末 2000 字：\n${mutantOutput.slice(-2000)}`);
  assert.ok(extraLine.length > 0, `反证臂：红是红了，但没红在「多出来的引擎」那条上（退出码 ${mutantExitCode}）。副本输出末 2000 字：\n${mutantOutput.slice(-2000)}`);
  assert.match(extraLine, /多出来的引擎（不是句柄指名的 pid \d+）：pid=\d+ debugPort=\d+ profileDir=\S*chromium2/, `反证臂：点名的不是注入的第二个引擎（要带 pid / 调试端口 / profileDir=…/chromium2）：${extraLine}`);
} catch (error) {
  if (primaryError === null) primaryError = error;
} finally {
  await cleanupStep(cleanupProblems, '引擎臂：关掉正臂那个 boot()', async () => {
    if (!engineHandle) return;
    const cleanup = await engineHandle.close();
    for (const problem of cleanup.problems) cleanupProblems.push(`正臂 close(): ${problem}`);
    engineHandle = null;
  });
  // 边界臂的替身：**按精确 pid** 停（绝不 pkill / pgrep -f —— 模式会匹到自己那条命令行上）。
  await cleanupStep(cleanupProblems, '引擎臂：停掉边界臂的替身（按精确 pid）', async () => {
    if (!engineStandIn || !await processAlive(engineStandIn.pid)) return;
    process.kill(engineStandIn.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!await processAlive(engineStandIn.pid)) return;
      await sleep(40);
    }
    process.kill(engineStandIn.pid, 'SIGKILL');
  });
  for (const owned of engineOwnedPaths) await removeSandbox(owned, cleanupProblems, `引擎臂的沙箱 ${path.basename(owned)}`);
}

// ── ⑤ Windows 形状：拿**合成进程表行**做确定性驱动（不起浏览器、不读 procfs、不碰端口） ──────────────
//
// 为什么单独一组（2026-09-25，另一台机＝Windows/winbox 的维护者报的假红）：引擎普查在 Linux 上全绿，
// 而那边报回来的是「本次 run 的引擎根 0 个 → ? 个」。那台机器够不着（没有 devices.json 条目、没有现场
// 日志），所以把「Windows 上命令行会长什么样」写成**合成行夹具**（`test/fixtures/windows-engine-shapes.mjs`），
// 拿**真判据**在任何平台上判。夹具自己也能直接跑（拿同一条驱动去打**另一个版本**的字节）：
//   node test/fixtures/windows-engine-shapes.mjs /tmp/h/harness.mjs
//
// 这一组只用**纯读数**（`oneEngineProblems` 吃 census ＋合成监听行）⇒ 它不会被「要起浏览器」的臂挡住；
// 四条反证保证「新形状」没有把牙磨掉：认不出自己那颗（⇒ 必红且必须**说清现场**）／自己多起一个
// （⇒ 必红且点名）／把外来的算成自己的（⇒ 必红）／profileDir 换一个目录（⇒ 必红 —— `sameDirectory`
// 不是放宽，是「同一个目录」按平台的规矩认）。
//
// ⚠️ 如实记：这是**合成夹具，不是真 Windows 现场**；它钉的是「这些形状下判据怎么判」，不能替代在那台
// 机器上真跑一遍（逐形状的依据与 HEAD 读数写在夹具的 `note` / `headOnWindows` 里）。
const ownJudgementOf = async (shapeId, { census, rows }) => ({
  problems: oneEngineProblems({
    census,
    handle: handleForShape(shapeId),
    listenerRowsByPort: syntheticListenerRowsOf(shapeId),
  }),
  census,
  rows,
});
const windowsArms = await runArms([
  ...windowsEngineShapeArms({ engineCensus }),
  ['⑤a 判据吃 Windows 形状的「自己那颗」⇒ 五条形状都必须绿', async () => {
    const details = [];
    for (const shapeId of SHAPE_INVENTORY) {
      const { census, rows } = await censusForShape({ engineCensus }, shapeId);
      const { problems } = await ownJudgementOf(shapeId, { census, rows });
      assert.deepEqual(problems, [], `形状 ${shapeId}：Windows 形状下自己的引擎必须被判据接受，实测问题：\n${problems.join('\n')}`);
      details.push(shapeId);
    }
    return { shapes: details };
  }],
  ['⑤b 反证：认不出自己那颗（令牌不在）⇒ 必红，**且必须说清现场**', async () => {
    const shapeId = 'win-unquoted-junk-tail';
    const { census, rows } = await censusWithoutOwnToken({ engineCensus }, shapeId);
    assert.equal(census.mine.length, 0, `令牌不在时本 run 的引擎根必须是 0 个，实测 ${census.mine.length} 个`);
    const { problems } = await ownJudgementOf(shapeId, { census, rows });
    const message = problems.join(' ｜ ');
    assert.ok(problems.length > 0, '认不出自己那颗引擎时必须判红');
    assert.match(message, /本次 run 的引擎根应有 1 个，实测 0 个/, `红的原因要点到「一个都没有」：${message.slice(0, 400)}`);
    // 「具体、可诊断」是硬要求（维护者那边拿到的就是一句「0 → ? 个」）：现场读数里必须有每一行的
    // pid ＋ profileDir ＋ 归属理由，而不是一个数字。
    assert.match(message, /现场读数（本 run 的引擎根 0 个/, `红报告必须带现场读数：${message.slice(0, 400)}`);
    assert.match(message, new RegExp(`pid=${rows[0].pid} `), '现场读数必须点名本 run 那一行的 pid');
    assert.match(message, /沙箱 .* 上没有运行令牌/, '现场读数必须写出「判成别人的」那条理由');
    assert.match(message, /归属=foreign/, '现场读数必须写出每一行的归属');
    return { problems: problems.length, namesOwnRow: true, namesReason: true };
  }],
  ['⑤c 反证：本 run 自己多起一个引擎（同一个沙箱的 chromium2）⇒ 必红且点名', async () => {
    const shapeId = 'win-whole-arg-quoted';
    const { census, rows } = await censusWithSecondOwnEngine({ engineCensus }, shapeId);
    assert.equal(census.mine.length, 2, `多起来的那个引擎带着本 run 的令牌，必须被算成 mine（实测 ${census.mine.length} 个）`);
    const { problems } = await ownJudgementOf(shapeId, { census, rows });
    const message = problems.join(' ｜ ');
    assert.ok(problems.length > 0, '自己多起一个引擎时必须判红');
    assert.match(message, /多出来的引擎（不是句柄指名的 pid 70001）：pid=70100/, `红报告必须点名多出来的那个 pid：${message.slice(0, 400)}`);
    return { problems: problems.length, namedExtraPid: 70100 };
  }],
  ['⑤d 反证：把**外来的**引擎算成自己的 ⇒ 必红（判据不是橡皮章）', async () => {
    const shapeId = 'win-unquoted-junk-tail';
    const { census, rows } = await censusForShape({ engineCensus }, shapeId);
    const stolen = census.foreign[0];
    assert.ok(stolen, '夹具里必须有别人的引擎（clash / 残留 / Steam）');
    const misclaimed = { ...census, mine: [...census.mine, stolen], foreign: census.foreign.slice(1) };
    const { problems } = await ownJudgementOf(shapeId, { census: misclaimed, rows });
    const message = problems.join(' ｜ ');
    assert.ok(problems.length > 0, '把外来的算成自己时必须判红');
    assert.match(message, new RegExp(`多出来的引擎（不是句柄指名的 pid 70001）：pid=${stolen.pid}`), `红报告必须点名被误认的那一行：${message.slice(0, 400)}`);
    return { problems: problems.length, misclaimedPid: stolen.pid };
  }],
  ['⑤e 反证：句柄的 profileDir 换成**另一个**目录 ⇒ 必红（`sameDirectory` 不是放宽）', async () => {
    const shapeId = 'win-forward-slashes';
    const shape = OUR_ENGINE_SHAPES[shapeId];
    // 同一目录、另一种拼法 ⇒ 不算红（Windows 的规矩）；另一个目录 ⇒ 必须红。
    assert.equal(sameDirectory(shape.profileDir, shape.handleProfileDir), true, '同一个目录的不同拼法（正斜杠 vs 反斜杠）必须判 true');
    assert.equal(sameDirectory(shape.handleProfileDir, `${shape.sandbox}\\chromium2`), false, '另一个目录必须判 false');
    const { census, rows } = await censusForShape({ engineCensus }, shapeId);
    const shifted = { ...census, mine: census.mine.map((row) => ({ ...row, userDataDir: `${shape.sandbox}\\chromium2` })) };
    const { problems } = await ownJudgementOf(shapeId, { census: shifted, rows });
    const message = problems.join(' ｜ ');
    assert.ok(problems.length > 0, '引擎报的 profileDir 是另一个目录时必须判红');
    assert.match(message, /引擎根的 profileDir=.* ≠ 句柄的 /, `红报告必须点到 profileDir 不一致：${message.slice(0, 400)}`);
    return { problems: problems.length, sameDirSameDirectory: true, otherDirRed: true };
  }],
  ['⑤f 「认得出旗标、认不出引擎根」的行要被列出来（自己的 `--type=` 子进程除外）', async () => {
    const synthetic = [
      { pid: 91, ppid: 1, name: 'chrome.exe', commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --user-data-dir=' },
      { pid: 92, ppid: 91, name: 'chrome.exe', commandLine: '"C:\\…\\chrome.exe" --type=renderer --user-data-dir=' },
    ];
    const listed = unparsedEngineRootRows({ rows: synthetic });
    assert.deepEqual(listed.map((row) => row.pid), [91], `认不出的行必须被列出来，自家 --type= 子进程不许被列：${JSON.stringify(listed.map((row) => row.pid))}`);
    const { census } = await censusForShape({ engineCensus }, 'win-unquoted-junk-tail');
    assert.deepEqual(census.unparsed.map((row) => row.pid), [], `正常快照里认得出自己的引擎 ⇒ 这份读数不许瞎报：${JSON.stringify(census.unparsed.map((row) => row.pid))}`);
    assert.equal(census.commandLineMissing, 1, '夹具里那一行读不到命令行的进程应当被计数');
    return { listed: [91], commandLineMissing: census.commandLineMissing };
  }],
], { title: '⑤ Windows 形状的引擎判据（合成夹具，不是真 Windows 现场）' });

const engineSummary = `边界臂（别人的引擎 pid=${engineArms.boundary?.pid ?? '?'} 不算）${engineArms.boundary ? '✓' : '✗'}`
  + `；正臂（本次 run 的引擎根 ${engineArms.baseline?.mine ?? '?'} → ${engineArms.positive?.mine.length ?? '?'} 个，pid=${engineArms.positive?.pid ?? '?'} debugPort=${engineArms.positive?.debugPort ?? '?'}）${engineArms.positive ? '✓' : '✗'}`
  + `；收尾腿（close 后引擎根 ${engineArms.teardown?.mine ?? '?'} 个 / 调试端口 ${engineArms.teardown?.debugRows ?? '?'} 行 / 静态服务 ${engineArms.teardown?.serverRows ?? '?'} 行）`
  + `；反证臂（副本里起两个引擎）退出码 ${engineArms.reverse?.exitCode ?? '?'}，点名 ${engineArms.reverse?.named ?? '(无)'}`
  + `；Windows 形状夹具（**合成行**，不是真 Windows 现场）${windowsArms.results.length - windowsArms.failed.length}/${windowsArms.results.length} 绿`;
process.stdout.write(`engine census: 判据「一次 boot() 只起一个引擎」—— ${engineSummary}\n`);

// ── self-test: red on a copy that violates, green on a copy that does not ──────────────────
// Every arm reads real source and writes only under its own temp sandbox, which is removed
// through test/harness.mjs like any other gate's.
const probeDir = await mkdtemp(path.join(os.tmpdir(), 'harness-contract-'));
const selfTest = { probeDir, clean: 0, dirty: [], debtProbe: [] };
try {
  const source = await readFile(path.join(root, MISSED_HARNESS), 'utf8');
  await mkdir(path.dirname(path.join(probeDir, MISSED_HARNESS)), { recursive: true });
  // This gate sits in PLATFORM_LAYER, so the spellings below may appear verbatim in its source.
  const injection = [
    "import { execFileSync } from 'node:child_process';",
    "import { readFileSync } from 'node:fs';",
    "const injectedProc = readFileSync('/proc/' + process.pid + '/cmdline', 'utf8');",
    "const injectedSs = execFileSync('ss', ['-ltnp']);",
  ].join('\n');

  // ① negative arm: a verbatim copy of the previously-missed harness must stay green.
  await writeFile(path.join(probeDir, MISSED_HARNESS), source, 'utf8');
  const clean = await scanPortability(probeDir, [MISSED_HARNESS]);
  selfTest.clean = clean.violations.length;
  assert.deepEqual(clean.unlisted, [], `negative arm: a COMPLIANT family copy must stay green, but the scanner flagged it:\n${format(clean.unlisted)}`);
  assert.deepEqual(clean.stale, [], 'negative arm: the copy must not disturb the debt bookkeeping');

  // ② positive arm: the same copy with a direct /proc read and a direct ss call must be caught,
  //    even though it lives under fixtures/ -- which is exactly where the old list stopped looking.
  await writeFile(path.join(probeDir, MISSED_HARNESS), `${source}\n${injection}\n`, 'utf8');
  const dirty = await scanPortability(probeDir, [MISSED_HARNESS]);
  selfTest.dirty = dirty.unlisted.map((violation) => `${violation.file}:${violation.line}: ${violation.rule}`);
  for (const rule of ['ss', '/proc']) {
    assert.ok(dirty.unlisted.some((violation) => violation.rule === rule), `positive arm: an injected direct ${rule} call in a copy of ${MISSED_HARNESS} must be a violation (a detector that cannot go red is not a detector); got ${JSON.stringify(selfTest.dirty)}`);
  }

  // ③ the debt bookkeeping must still excuse a DECLARED rule while catching an UNDECLARED one
  //    in the same file. The real debt table is empty now (every POSIX-only gate was moved onto
  //    test/harness.mjs), so the declared map is built here: a copy of a migrated gate, told that
  //    `ss` is allowed in it. The injected /proc read was never declared and must still be caught.
  //    (This keeps the mechanism honest with zero real debt -- a detector that cannot go red is
  //    not a detector.)
  const debtSource = await readFile(path.join(root, 'runtime-isolation.mjs'), 'utf8');
  await writeFile(path.join(probeDir, 'runtime-isolation.mjs'), `${debtSource}\n${injection}\n`, 'utf8');
  const probeDebt = new Map([['runtime-isolation.mjs', ['ss']]]);
  const debtProbe = await scanPortability(probeDir, ['runtime-isolation.mjs'], probeDebt);
  selfTest.debtProbe = debtProbe.unlisted.map((violation) => `${violation.file}:${violation.line}: ${violation.rule}`);
  assert.ok(debtProbe.unlisted.some((violation) => violation.rule === '/proc'), `a declared map must not excuse a rule that file did not declare; got ${JSON.stringify(selfTest.debtProbe)}`);
  assert.ok(!debtProbe.unlisted.some((violation) => violation.rule === 'ss'), 'the declared rule must still be excused (otherwise the list is decorative)');
  assert.deepEqual(debtProbe.stale, [], `the probe debt map must not disturb the stale check; got ${JSON.stringify(debtProbe.stale)}`);

  // ④ browser-env scanner self-test, on COPIES of a real gate: the compliant copy must stay green,
  //    and the same copy with the envelope stripped must be caught. A scanner that cannot go red is
  //    not a scanner (this is the red half of the browser-sandbox rule; the end-to-end one lives in
  //    test/browser-sandbox-isolation.mjs).
  const browserGateSource = await readFile(path.join(root, 'text-wrap.mjs'), 'utf8');
  const cleanBrowserScan = scanBrowserSpawnIsolation(browserGateSource, 'text-wrap.mjs');
  selfTest.browserClean = { sites: cleanBrowserScan.sites.filter((site) => !site.standIn).length, violations: cleanBrowserScan.violations.length };
  assert.ok(selfTest.browserClean.sites >= 1, `negative arm: text-wrap.mjs must be recognised as a browser-spawning gate, saw ${JSON.stringify(selfTest.browserClean)}`);
  assert.deepEqual(cleanBrowserScan.violations, [], `negative arm: a COMPLIANT browser spawn must stay green, but the scanner flagged it:\n${format(cleanBrowserScan.violations.map((violation) => ({ file: violation.file, line: violation.line, rule: 'browser-env', text: violation.text })))}`);
  const stripped = browserGateSource.replace(/env:\s*browserSandboxEnv\([^)]*\),\s*/, '');
  await writeFile(path.join(probeDir, 'text-wrap.mjs'), stripped, 'utf8');
  const mutatedBrowserScan = scanBrowserSpawnIsolation(stripped, 'text-wrap.mjs');
  selfTest.browserMutant = mutatedBrowserScan.violations.map((violation) => `${violation.file}:${violation.line}`);
  assert.equal(stripped === browserGateSource, false, 'positive arm: stripping the envelope must actually change the source');
  assert.ok(mutatedBrowserScan.violations.length >= 1, `positive arm: a browser spawn without env: browserSandboxEnv(...) must be a violation; got ${JSON.stringify(selfTest.browserMutant)}`);
} catch (error) {
  primaryError = error;
} finally {
  await removeSandbox(probeDir, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}

process.stdout.write(`portability self-test: copy of ${MISSED_HARNESS} clean=${selfTest.clean} violation(s); same copy + injected ss + ${'/proc'} => ${JSON.stringify(selfTest.dirty)}; debt probe (runtime-isolation.mjs + injected ${'/proc'}) => unlisted ${JSON.stringify(selfTest.debtProbe)}\n`);
process.stdout.write(`browser-env self-test: text-wrap.mjs clean=${selfTest.browserClean.violations} violation(s) / ${selfTest.browserClean.sites} site(s); same copy with the envelope stripped => ${JSON.stringify(selfTest.browserMutant)}\n`);

// Sandbox cleanup must never replace the failure it was cleaning up after.
// `rm(dir, { recursive: true, force: true })` only swallows ENOENT: a live writer still inside
// the sandbox (a session flush, a chromium user-data-dir) makes the final rmdir throw
// ENOTEMPTY/EACCES/EBUSY/EPERM -- and a throw from a `finally` block *replaces* the error the
// try was already propagating, with no `cause`. The gate then goes red on a cleanup artifact
// while the real assertion failure is gone. Suites must clean up through test/harness.mjs
// (removeSandbox/cleanupStep/finishCleanup: collect the problem, keep the primary error).
//
// Two mechanical rules, and their honest reach:
//   1. no bare rm/rmSync lexically inside a finally block (`removeSandbox(...)`,
//      `cleanupStep(...)`, `attempt(...)`, `.catch(...)`, or an inline try/catch is fine);
//   2. no local `removeSandbox` definition -- the harness owns that name, and the historical
//      local copies retried 50x and then threw, so exhaustion still replaced the real failure.
// A regex cannot follow an indirect helper (a `cleanup()` helper defined elsewhere and called
// from `finally`); batch 2 must audit those by hand.
const CLEANUP_BARE_RM = /\brm\s*\(|\brmSync\s*\(/;
const CLEANUP_COLLECTED = /removeSandbox\s*\(|cleanupStep\s*\(|\battempt\s*\(|\.catch\s*\(|=>\s*rm\s*\(/;
const CLEANUP_LOCAL_HELPER = /^\s*(?:async\s+)?function\s+removeSandbox\b|^\s*const\s+removeSandbox\s*=/;
const cleanupViolations = [];
for await (const relative of walkFiles(root)) {
  if (!relative.endsWith('.mjs')) continue;
  const source = await readFile(path.join(root, relative), 'utf8');
  const lines = source.split(/\r?\n/);
  let depth = 0;
  let inFinally = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (CLEANUP_LOCAL_HELPER.test(line)) {
      cleanupViolations.push(`${relative}:${index + 1}: local removeSandbox helper (can still throw): ${line.trim()}`);
    }
    if (!inFinally && /\bfinally\b/.test(line)) {
      const after = line.slice(line.indexOf('finally'));
      depth = (after.match(/\{/g) || []).length - (after.match(/\}/g) || []).length;
      inFinally = depth > 0;
    } else if (inFinally) {
      const previous = index > 0 ? lines[index - 1].trim() : '';
      const guarded = CLEANUP_COLLECTED.test(line) || /\btry\b/.test(line) || /\btry\s*\{$/.test(previous);
      if (CLEANUP_BARE_RM.test(line) && !guarded) cleanupViolations.push(`${relative}:${index + 1}: bare rm in finally: ${line.trim()}`);
    }
    if (inFinally) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0) inFinally = false;
    }
  }
}

// Batch 2 worklist: suites not yet migrated to test/harness.mjs cleanup. This list may only
// shrink -- the check below refuses an entry that no longer violates either rule, so a
// migration commit must delete its entry in the same change. Batch 2 emptied it: every gate
// now cleans up through test/harness.mjs (cleanupStep/removeSandbox/finishCleanup).
const cleanupBatch2 = new Set([
]);
const unlistedCleanup = cleanupViolations.filter((violation) => !cleanupBatch2.has(violation.split(':')[0]));
const violatedFiles = new Set(cleanupViolations.map((violation) => violation.split(':')[0]));
const staleAllowlist = [...cleanupBatch2].filter((name) => !violatedFiles.has(name));
assert.deepEqual(unlistedCleanup, [], `sandbox cleanup that can replace the real failure (${unlistedCleanup.length}); use removeSandbox/cleanupStep/finishCleanup from test/harness.mjs:\n${unlistedCleanup.join('\n')}`);
assert.deepEqual(staleAllowlist, [], `batch-2 allowlist entries with no violation left -- delete them (this list may only shrink):\n${staleAllowlist.join('\n')}`);

async function* walkFiles(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkFiles(path.join(directory, entry.name), relative);
    else if (entry.isFile()) yield relative;
  }
}

process.stdout.write(`RESULT: harness portability PASS (no direct ss or /proc process management: ${family.length} harness-family files among ${scanned.length} .mjs scanned under test/ -- fixtures/ included, ${PLATFORM_LAYER.size} platform-layer files exempt, ${portabilityDebt.size} declared POSIX-only debt entries); sandbox cleanup PASS (${unlistedCleanup.length} unlisted; ${cleanupBatch2.size} batch-2 entries pending); browser sandbox isolation PASS (${browserViolations.length} unlisted violations among ${browserSites.length} browser spawn site(s) -- ${realBrowserSites.length} real + ${browserSites.length - realBrowserSites.length} stand-in); single engine PASS (${engineSummary})\n`);
