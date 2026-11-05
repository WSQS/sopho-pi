import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chmod, cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -- browser sandbox: a private TMPDIR and a private home for every spawned browser ------------
//
// Why this lives here (2026-09-23, chromium-isolation): every gate that spawns a real browser
// used to hand it the *inherited* environment, and chromium writes outside its `--user-data-dir`:
//
//   · Temp directories. Every launch creates two `org.chromium.Chromium.*` directories in the
//     **inherited TMPDIR**: one holding the ProcessSingleton `SingletonSocket`, one holding the
//     `chromium_chrome_url_fetcher_` files. A gate that does not redirect TMPDIR drops those in
//     the **shared /tmp** (measured on this machine: 6500+ of them, with no way to tell which run
//     produced which). Measured rule: with `--headless=new --no-sandbox …
//     --user-data-dir=<sandbox>`, TMPDIR decides where they land (TMP/TEMP are only consulted when
//     TMPDIR is unset; they are set here anyway because Windows uses them).
//   · crashpad. `chrome_crashpad_handler` is started with
//     `--database=$XDG_CONFIG_HOME/chromium/Crash Reports` (or `$HOME/.config/chromium/Crash Reports`
//     when XDG_CONFIG_HOME is unset) -- **not** derived from `--user-data-dir`. Without a HOME/XDG
//     redirect a gate points the crash database at the user's real home and really writes there
//     (`Crash Reports/settings.dat`; measured with three unisolated gates on this machine).
//     Redirecting HOME *or* XDG_CONFIG_HOME is enough; both are redirected here.
//     ⚠️ `--crash-dumps-dir=<dir>` does **not** change that `--database` on Chromium 153
//     (controlled A/B in the delivery report) -- do not use it as the isolation switch.
//
// The rule: a gate spawns a browser with `env: browserSandboxEnv(<its own sandbox root>)`.
// `test/harness-contract.mjs` scans every browser spawn site in `test/` for exactly that, so a new
// gate cannot quietly go back to the inherited environment. `SOPHO_BROWSER_ISOLATION=off` exists
// only for the reverse arms of `test/browser-sandbox-isolation.mjs` (a detector that cannot go red
// is not a detector); no gate may depend on it.
export const BROWSER_SANDBOX_DIRS = Object.freeze({
  home: 'home',
  tmp: 'tmp',
  xdgConfig: 'xdg-config',
  xdgCache: 'xdg-cache',
});

// Every variable `browserSandboxEnv` overrides. Kept as data so the gate can assert the set it
// actually redirected instead of trusting a comment.
export const BROWSER_SANDBOX_ENV_KEYS = Object.freeze(
  process.platform === 'win32'
    ? ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']
    : ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'],
);

// Where the private home/tmp/XDG dirs of a browser sandbox live (pure: no filesystem writes).
export function browserSandboxPaths(root) {
  const base = path.resolve(root);
  return {
    home: path.join(base, BROWSER_SANDBOX_DIRS.home),
    tmp: path.join(base, BROWSER_SANDBOX_DIRS.tmp),
    xdgConfig: path.join(base, BROWSER_SANDBOX_DIRS.xdgConfig),
    xdgCache: path.join(base, BROWSER_SANDBOX_DIRS.xdgCache),
  };
}

// The env for one spawned browser: private home, private tmp, private XDG. `extra` can add
// or override single variables (the reverse arms use it to point at a decoy home / decoy tmp).
//
// ⚠️ TMPDIR has a hard length budget on POSIX. Chromium's ProcessSingleton puts its socket at
// `<TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket`, and `sockaddr_un.sun_path` is only 108
// bytes (104 on macOS): one byte over and chrome dies at startup with a FATAL
// `process_singleton_posix.cc: Socket path too long` -- which a caller sees only as "the devtools
// endpoint never came up" 30 s later (measured on this machine: `test/switch-perf-v21-v22.mjs`
// passed `/tmp/sopho-switch-perf/chrome-v22-r1-1200x760-<ts>` as its root). So the budget is checked
// here and an over-long root fails **immediately and by name**, instead of leaving a mystery to the
// gate author. The fix is always the same: hand this function a shorter sandbox root.
const SINGLETON_SOCKET_BUDGET = 1 + 'org.chromium.Chromium.'.length + 6 + 1 + 'SingletonSocket'.length;
const SUN_PATH_LIMIT = process.platform === 'darwin' ? 104 : 108;
const SUN_PATH_MARGIN = 8;

export function browserSandboxEnv(root, extra = {}) {
  if (process.env.SOPHO_BROWSER_ISOLATION === 'off') return { ...process.env, ...extra };
  const dirs = browserSandboxPaths(root);
  const localAppData = path.join(dirs.home, 'AppData', 'Local');
  if (process.platform !== 'win32' && dirs.tmp.length + SINGLETON_SOCKET_BUDGET + SUN_PATH_MARGIN > SUN_PATH_LIMIT) {
    throw new Error(`browser sandbox root is too long for chromium's singleton socket: TMPDIR would be ${dirs.tmp} `
      + `(${dirs.tmp.length + SINGLETON_SOCKET_BUDGET} bytes for <TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket, `
      + `limit ${SUN_PATH_LIMIT} with ${SUN_PATH_MARGIN} bytes of margin). Chromium would abort with `
      + `"Socket path too long". Pass browserSandboxEnv a shorter root (a mkdtemp sandbox, not a deep work dir).`);
  }
  for (const dir of [dirs.home, dirs.tmp, dirs.xdgConfig, dirs.xdgCache, ...(process.platform === 'win32' ? [localAppData] : [])]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const env = {
    ...process.env,
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_CACHE_HOME: dirs.xdgCache,
    ...extra,
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = dirs.home;
    env.LOCALAPPDATA = localAppData;
  }
  return env;
}

// `chrome_crashpad_handler --database=…` out of a raw command line (null when there is none).
//
// The value is taken up to the next ` --flag` (or end of line), not up to the next space: the path
// itself contains a space (`…/Crash Reports`), and `processCommandLine` joins the NUL-separated
// argv with spaces, so a `\S+` match would silently truncate it to `…/Crash`. The gate asserts on
// this string: an isolated browser must not name the user's real chromium home.
export function crashpadDatabaseOf(commandLine) {
  const match = /(?:^|\s)--database=(.+?)(?=\s--|$)/.exec(commandLine ?? '');
  if (!match) return null;
  const value = match[1].trim();
  return (value.startsWith('"') && value.endsWith('"') && value.length > 1) ? value.slice(1, -1) : value;
}

// -- runArms: a red arm must not hide the arms after it ---------------------------------------
//
// Why this exists (2026-09-21, two real incidents on this repo):
//   · `test/tree-scale.mjs` threw on its ③b assertion and died, so *every later arm never ran* --
//     the only arm covering the non-compact-JSONL fallback (⑦c) was hidden, and a real 500
//     regression from a deleted `projectTreeLineByParse` slipped past the gate.
//   · `test/swap-window-inflight.mjs` reported one serial verdict, so a reader could not tell
//     which scenario was actually covered.
// The shape that fixes it: every arm is wrapped in its own try/catch, a failing arm is recorded
// and the loop continues, and the exit code becomes non-zero only at the end (after every arm has
// run). Arms are `[name, async () => { ... }]` tuples (order is preserved; state shared across arms
// lives in the caller's scope). The return value of an arm, if any, is printed as its key numbers:
//
//   const { failed } = await runArms([
//     ['① scenario one', async () => { ...assert...; return { keyNumber: 3 }; }],
//     ['② scenario two', async () => { ... }],
//   ], { title: 'my-gate' });
//   // prints, per arm:  ✓ arm ① scenario one — {"keyNumber":3}      or  ✗ arm ② scenario two — <msg>
//   // then a summary table:
//   //   ──── my-gate: 2 arm(s) — 1 green / 1 red ────
//   //   PASS  ① scenario one (12 ms) {"keyNumber":3}
//   //   FAIL  ② scenario two (3 ms) <msg>
//   // process.exitCode is already 1 when `failed` is non-empty.
//
// `process.exitCode` is used, never `process.exit`: the calling gate still has to run its own
// cleanup (`removeSandbox`/`finishCleanup`), and killing the process here would leak its sandbox.
export async function runArms(arms, options = {}) {
  const {
    title = 'arms',
    write = (line) => process.stdout.write(`${line}\n`),
    onFailures = null,
  } = options;
  const results = [];
  for (const arm of arms) {
    const [name, run] = Array.isArray(arm) ? arm : [arm.name, arm.run];
    const startedAt = Date.now();
    try {
      const detail = await run();
      results.push({ name, ok: true, detail: detail ?? null });
      write(`✓ arm ${name}${detail === null || detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    } catch (error) {
      results.push({ name, ok: false, error });
      write(`✗ arm ${name} — ${error instanceof Error ? error.message : String(error)}`);
    }
    results[results.length - 1].ms = Date.now() - startedAt;
  }
  const failed = results.filter((result) => !result.ok);
  write('');
  write(`──── ${title}: ${results.length} arm(s) — ${results.length - failed.length} green / ${failed.length} red ────`);
  for (const result of results) {
    const note = result.ok
      ? (result.detail === null || result.detail === undefined ? '' : ` ${typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail)}`)
      : ` ${result.error instanceof Error ? result.error.message : String(result.error)}`;
    write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name} (${result.ms} ms)${note}`);
  }
  if (typeof onFailures === 'function' && failed.length > 0) await onFailures(failed);
  if (failed.length > 0) process.exitCode = 1;
  return { results, failed };
}

// -- sandbox cleanup: a cleanup failure must never replace the real failure -------------------
//
// `rm(dir, { recursive: true, force: true })` only swallows ENOENT. When something is still
// writing inside the sandbox (a session flush, a chromium user-data-dir) the final rmdir can
// throw ENOTEMPTY/EACCES/EBUSY/EPERM instead -- and a throw from a `finally` block *replaces*
// the error the `try` was already propagating, with no `cause`. The gate then looks red for a
// cleanup artifact while the real assertion failure is gone. test/s0b.mjs fixed this first;
// these helpers carry the same contract to every gate: collect cleanup problems, keep the
// primary error, and treat cleanup as a failure of the run only when the run itself passed.
const SANDBOX_RM_OPTIONS = { recursive: true, force: true, maxRetries: 8, retryDelay: 50 };

// 收敛式删除的预算（环境变量可调：CI 想收紧就调小，慢机想放宽就调大）。
const sandboxRemoveBudget = () => ({
  passes: Number(process.env.SOPHO_TEST_RM_PASSES ?? 6),
  pauseMs: Number(process.env.SOPHO_TEST_RM_PAUSE_MS ?? 200),
  quietMs: Number(process.env.SOPHO_TEST_RM_QUIET_MS ?? 300),
  pollMs: Number(process.env.SOPHO_TEST_RM_POLL_MS ?? 25),
});

export async function cleanupStep(problems, label, action) {
  try {
    await action();
  } catch (error) {
    problems.push(`${label}: ${error.stderr || error.message}`);
  }
}

// -- 「删沙箱」的共享入口：收敛式（删 → 稳定空窗复核 → 又出现就再删，有上界；仍留着如实记账） -------
//
// Why the one-pass version was not enough (2026-09-23, second round of the browser-isolation line):
// a late writer recreates the path **after** the `rm`. Measured on this machine: a chromium crashpad
// handler is reparented (`ppid=1`), its command line carries neither the engine's profile dir nor the
// browser pid tree, so the teardown never saw it -- and it rebuilt `decoy-home/.config/chromium/...`
// after the removal. One-pass `rm` therefore left a directory behind while the gate stayed green
// (silent litter, exactly the class of behaviour this line exists to stop). test/ui-sandbox-cleanup.mjs
// had already nailed the "delete, then keep re-checking" shape; this is that shape moved into the
// shared entry point, so **every** gate calling `removeSandbox` inherits it instead of each gate
// re-inventing it.
//
// Contract (unchanged): this never throws at the caller. Problems are collected into `problems` and
// `finishCleanup` turns them into a red only when the run itself was already green, so cleanup can
// never replace the real failure. A path that survives every pass is reported with its name.
// `SOPHO_TEST_RM_PASSES=1` restores the old one-pass behaviour -- only reverse arms may use it.
export async function removeSandboxConverged(directory, options = {}) {
  const { label = 'remove sandbox', onPass = null, budget: override } = options;
  const budget = { ...sandboxRemoveBudget(), ...(override ?? {}) };
  const problems = [];
  const readings = [];
  let existed = false;
  for (let pass = 1; pass <= budget.passes; pass += 1) {
    if (existsSync(directory)) {
      existed = true;
      try {
        await rm(directory, SANDBOX_RM_OPTIONS);
      } catch (error) {
        if (error?.code !== 'ENOENT') problems.push(`${label}: rm ${directory} 失败：${error.message}`);
      }
    }
    // 「删完再核」：连续 quietMs 都是空的才算干净（迟写者锚定的是「路径被删掉」这个事件，不是时间）。
    let quiet = true;
    const deadline = Date.now() + budget.quietMs;
    while (Date.now() < deadline) {
      await sleep(budget.pollMs);
      if (existsSync(directory)) { quiet = false; break; }
    }
    const reading = { pass, 还在: existsSync(directory), 空窗干净: quiet };
    readings.push(reading);
    if (onPass) onPass(reading);
    if (quiet && !existsSync(directory)) {
      return { removed: existed, passes: pass, reappeared: pass > 1, readings, problems };
    }
    await sleep(budget.pauseMs);
  }
  const remaining = existsSync(directory);
  return { removed: existed && !remaining, passes: budget.passes, reappeared: true, remaining, readings, problems };
}

export async function removeSandbox(directory, problems, label = 'remove sandbox', options = {}) {
  const result = await removeSandboxConverged(directory, {
    label,
    budget: options.budget,
    onPass: options.onPass ?? ((reading) => process.stderr.write(`[harness] ${label}：第 ${reading.pass} 遍 —— ${reading.还在 ? '还在盘上' : '已不在'}${reading.空窗干净 ? '' : '（空窗里又出现了）'}\n`)),
  });
  for (const problem of result.problems) problems.push(problem);
  if (result.remaining) problems.push(`${label}: ${directory} 删了 ${result.passes} 遍仍在盘上（迟写者又把它建回来；可用 SOPHO_TEST_RM_PASSES/SOPHO_TEST_RM_QUIET_MS 调预算）`);
  return result;
}

export function finishCleanup(primaryError, problems) {
  if (problems.length > 0) process.stderr.write(`cleanup problems (secondary): ${problems.join('; ')}\n`);
  if (primaryError) throw primaryError;
  assert.deepEqual(problems, [], 'the run passed, so cleanup must not have failed');
}

// -- 反证臂的通用机械：把**交付物副本**改一处，再拿**真门**去打那份副本，断言它必红 ----------------------
//
// 为什么必须打副本：反证臂要证的是「这一处一改，这道门就红」，不是「我手动把门弄红了」。拿真树去改就
// 污染正在交付的东西 —— 这条不是理论：本仓实测踩过「用 `git checkout --` 还原反证臂时，把**未提交**的
// 交付改动一起还原掉」。
//
// 为什么副本要建在**仓库根里面**（`.sopho-<tag>-sandbox-<n>/`）：`.mjs` 是 ESM，但 `node_modules`
// 靠向上查找解析 —— 建在仓外就跑不起来。（`test/design-edit.mjs` 的 `.sopho-designedit-sandbox-*`
// 是同一条先例；`.gitignore` 按同样形状收录，跑完即删。）
//
// 契约：`mutate(copyRoot)` 负责改副本（命中不了要自己抛，不许静默跳过）；本函数用**子进程**跑同一个
// 门文件，把 `envKey` 指向副本 ⇒ 门必须红（退出码非 0）**且**输出里要出现 `expect` 的原文。
// 门居然绿了、或红在别处 ⇒ **这条反证臂是假臂**，这里如实抛错（不粉饰）。
// 返回 `{ ok, exitCode, redLine, output, problems }` —— 只在真的红到位时 `ok:true`。
export async function runGateOnMutatedCopy({
  root,
  tag,
  dirs,
  mutate,
  gateFile,
  expect,
  envKey = 'SOPHO_DEBUG_GATE_ROOT',
  timeoutMs = 15 * 60 * 1000,
}) {
  const copyRoot = path.join(root, `.sopho-${tag}-sandbox-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
  const problems = [];
  let result = null;
  try {
    for (const dir of dirs) await cp(path.join(root, dir), path.join(copyRoot, dir), { recursive: true });
    await mutate(copyRoot);
    let exitCode = 0;
    let output = '';
    try {
      const reply = await execFileAsync(process.execPath, [gateFile], {
        env: { ...process.env, [envKey]: copyRoot },
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
      });
      output = `${reply.stdout}\n${reply.stderr}`;
    } catch (error) {
      exitCode = typeof error.code === 'number' ? error.code : 1;
      output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    }
    const redLine = output.split('\n').find((line) => line.includes(expect)) ?? null;
    if (exitCode === 0) {
      throw new Error(`反证臂是假的：改了这一处，门居然还是绿的（退出码 0）。预期红在：${expect}`);
    }
    if (redLine === null) {
      throw new Error(`反证臂红是红了，但**没红在预期那条**上（退出码 ${exitCode}）；预期输出里应出现：${expect}\n---- 门输出（末 4000 字）----\n${output.slice(-4000)}`);
    }
    result = { ok: true, exitCode, redLine, output };
  } finally {
    await removeSandbox(copyRoot, problems, `remove reverse-arm copy ${path.basename(copyRoot)}`);
  }
  return { ...result, problems };
}

/** 某个端口上的**监听行**：要「绑定地址」那一列的门问这里，不要自己去调 `ss` / 读 procfs
 *  ——平台分叉只住这个文件（规则与自检见 `test/harness-contract.mjs` 的那一节）。
 *  返回 `[{ address, port, pid, state, raw }]`：
 *  · Windows：`Get-NetTCPConnection` 的 `LocalAddress`（`0.0.0.0` / `127.0.0.1` / `::`）；
 *  · 其它：`ss -H -ltnp` 输出的**第 4 列**（本地地址），`*` 归一成 `0.0.0.0` —— `ss` 用 `*`
 *    表示「本族的任意地址」，对一个 AF_INET 套接字它就是 `0.0.0.0`。
 *  没人在听就是空数组（不是 0 行的假成功）。`raw` 是那一行原文，门可以直接打进报告当证据。 */
export async function listenerRows(port) {
  const selectedPort = Number(port);
  if (process.platform === 'win32') {
    const script = `Get-NetTCPConnection -State Listen -LocalPort ${selectedPort} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess,State | ConvertTo-Json -Compress`;
    let stdout;
    try {
      ({ stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
    } catch (error) {
      // 与 `listenerPid` 一直以来的口径一致：没有人听时 PowerShell 可能非 0 退出且**一个字都没有**
      // ——那是「没人在听」，不是错误（其它错误照旧抛，不许静默）。
      if (error?.code === 1 && !error?.stdout?.trim()) return [];
      throw error;
    }
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      address: String(row.LocalAddress ?? ''),
      port: Number(row.LocalPort),
      pid: Number(row.OwningProcess),
      state: String(row.State ?? ''),
      raw: JSON.stringify(row),
    }));
  }
  const { stdout } = await execFileAsync('ss', ['-H', '-ltnp', `sport = :${selectedPort}`]);
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const fields = text.split(/\s+/);
    const local = fields[3] ?? '';
    const cut = local.lastIndexOf(':');
    const address = cut < 0 ? '' : local.slice(0, cut);
    rows.push({
      address: address === '*' ? '0.0.0.0' : address.replace(/^\[(.*)\]$/, '$1'),
      port: cut < 0 ? NaN : Number(local.slice(cut + 1)),
      pid: Number(text.match(/pid=(\d+)/)?.[1] ?? 0),
      state: fields[0] ?? '',
      raw: text,
    });
  }
  return rows;
}

export async function listenerPid(port) {
  const rows = await listenerRows(port);
  return rows.map((row) => row.pid).find((pid) => Number.isInteger(pid) && pid > 0) ?? 0;
}

export async function processCommandLine(pid) {
  if (process.platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" -ErrorAction SilentlyContinue).CommandLine`;
    return (await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).stdout.trim();
  }
  return (await readFile(`/proc/${Number(pid)}/cmdline`, 'utf8')).split('\0').join(' ');
}

// -- 进程表：所有「看进程」的事都从这里走（平台分支只住这个文件） -----------------------------
//
// 纪律（`test/harness-contract.mjs`）：门不许自己读 `/proc` 或调 `ss`，要问这一层 —— 它是
// POSIX（`/proc`）与 Windows（PowerShell CIM）唯一分叉的地方，跨平台才不会因为一处硬编码而
// 拴死。收尾时要「等自己那棵树退到空集」（见 `test/ui-harness.mjs`），所以除了单个 pid 的
// `processCommandLine`，还需要一张表：pid + 父 pid + 进程组 + 名字 + 状态 + 命令行。
// `pgid` 是「按进程组收尾」那条路要的（`test/drag-select-cost.mjs`）；`name` 是「按可执行名
// 数进程」那条路要的（`test/switch-perf-v21-v22.mjs`）—— 两条都在 POSIX 上是 `/proc/<pid>/stat`
// 同一个文件里的字段（comm 与 pgrp），Linux 与 Windows 各给一份。
//
// POSIX 的 `/proc/<pid>/stat` 固定形状：`pid (comm) state ppid pgrp session …`。comm 带括号、
// 里面可能还有空格与括号，所以从**第一个** '(' 到**最后一个** ')' 之间才是名字。
function parsePosixStat(stat) {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  const tail = stat.slice(close + 2).split(' ');
  return {
    name: stat.slice(open + 1, close),
    state: tail[0],
    ppid: Number(tail[1]),
    pgid: Number(tail[2]),
  };
}

export async function processTable({ withCommandLine = true } = {}) {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((row) => ({
        pid: Number(row.ProcessId),
        ppid: Number(row.ParentProcessId ?? 0),
        pgid: null,           // Windows 上 POSIX 进程组不是可读的概念（`processGroupId` 同样返回 null）
        state: '',            // Windows 没有 zombie 这个状态
        name: String(row.Name ?? ''),
        commandLine: withCommandLine ? String(row.CommandLine ?? '') : '',
      }))
      .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
  }
  const rows = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => null);
    if (!stat) continue;
    rows.push({
      ...parsePosixStat(stat),
      pid: Number(entry),
      commandLine: withCommandLine ? (await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')).split('\0').join(' ') : '',
    });
  }
  return rows;
}

// -- 「现场有几个浏览器引擎」的读数（「一次 boot() 只起一个引擎」那条判据的底座） -----------------------
//
// 为什么这一层要有它：判「一次 boot() 之后现场多没多出第二个引擎」必须**读整张进程表**，而读进程表
// 的平台分叉只住本文件（纪律见 `test/harness-contract.mjs`）。所以这里只回答「**这一行**是不是一个
// 引擎根」与「现场有哪些引擎根」；**谁是谁的**（本次 run 的 / 别人的）不由这里判 —— 那要靠带内标记
// （`test/ui-harness.mjs` 在沙箱根上写的运行令牌），由调用方传进来判。
//
// 认「引擎根」的口径 = 命令行里带 `--user-data-dir=` 且**不带** `--type=`（与 `bin/sandbox-sweep.mjs`
// / `test/browser-spawn-scan.mjs` 同一条「认旗标不认进程名」的口径）。实测（2026-09-25，本机）：
//   · chromium 的 zygote / gpu-process / renderer / utility 子进程一律带 `--type=`，只有**主进程**
//     不带 ⇒ 「不带 --type=」把子树摘掉，留下的是每个引擎恰好一个根；
//   · `chrome_crashpad_handler` 不带 `--user-data-dir`（它的 `--database` 才指向沙箱）；
//   · ⚠️ `--user-data-dir` **不是**浏览器的专属旗标：本机实测用户自己的
//     `/usr/share/code/code --user-data-dir=/home/…/.config/Code` 与 Steam 的 `steamwebhelper` 都带它
//     ⇒ 它只能用来定「根」，**不能**用来定「是谁的」；归属一律由调用方按带内令牌判。
// ⚠️ Windows 形状（2026-09-25，另一台机＝Windows/winbox 的维护者报的假红；夹具与逐行读数见
// `test/fixtures/windows-engine-shapes.mjs`）：命令行是「参数用空格连起来」的**一条字符串**
// （POSIX 上 `/proc/<pid>/cmdline` 的 NUL 被换成空格、Windows 上是 CIM 给的原文），所以
// **引号是唯一还留下的参数边界证据**。旧口径是一个正则 `(?:^|\s)--user-data-dir=(.+?)(?=\s--|$)`，
// 它在三种 Windows 形状上判错：
//   · `--user-data-dir=C:\…\chromium about:blank` —— 旗标后面还跟着位置参数；旧正则的值
//     「取到下一个 ` --`」⇒ 把 `about:blank` 一起吞进 profileDir（Linux 上之所以没露馅，是因为
//     chromium 在 `--user-data-dir` 后又追加了一批 `--noerrdialogs --no-first-run --ozone-platform=…`
//     开关 = 2026-09-25 实测 `/proc/<pid>/cmdline`；那是**它的 argv 布局**，不是可以依赖的保证）；
//   · `"--user-data-dir=C:\Users\John Smith\…\chromium"` —— 路径里有空格时，win32 上
//     node/libuv 给**整个参数**加引号 ⇒ 旗标前面是 `"` 而不是空白/行首 ⇒ 旧正则**认不出这一行**
//     （自己那颗引擎凭空消失：`mine` 0 个，且没有任何诊断）；
//   · `--user-data-dir="C:\…\chromium" about:blank` —— 引号值 ＋ 尾巴 ⇒ 旧正则「去引号」那条
//     判定（要求以 `"` 结尾）不成立，值里同时留着引号与尾巴 ⇒ 沙箱推断错 ⇒ 判成 `foreign`。
// 所以这一层改成「先按空白与引号**拆参数**，再在参数串里找 `--flag=值`」：值的边界由引号决定，
// 旗标的边界由参数边界决定，三种形状一次全解。
//
// 拆参数用不了「argv 的本义」：POSIX 上一个**不带引号**的 argv 元素可以含空格（实测：chromium 给
// crashpad 传的 `--database=<…>/Crash Reports` 就是一个元素）⇒ 这里拆出来的会比 argv 多。所以
// `crashpadDatabaseOf`（本文件上面那条）**不**走这里，它保留「取到下一个 ` --`」的老口径。
/** 一条命令行 → 参数串（只按空白与双引号拆，不做任何平台假设；引号本身不落进参数）。 */
function commandLineTokens(commandLine) {
  const tokens = [];
  let current = '';
  let quoted = false;
  for (const char of String(commandLine ?? '')) {
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && (char === ' ' || char === '\t' || char === '\n' || char === '\r')) {
      if (current.length > 0) { tokens.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** 参数串里 `--flag=值` 的值（第一个命中的；没有／值为空 ⇒ null）。 */
function flagValueOf(tokens, flag) {
  const prefix = `${flag}=`;
  for (const token of tokens) {
    if (token.startsWith(prefix) && token.length > prefix.length) return token.slice(prefix.length);
  }
  return null;
}

const PROCESS_TYPE_PREFIX = '--type=';

/** 进程表里的一行 → 引擎根 `{ pid, ppid, pgid, name, state, commandLine, userDataDir, debugPort }`；
 *  不是引擎根（带 `--type=`、或没有 `--user-data-dir=`）⇒ null。`debugPort` 取不到就是 null。
 *  纯函数（只吃一行），所以门可以拿它去判**副本**里的读数，不碰真树。 */
export function browserEngineRootOf(row) {
  const commandLine = String(row?.commandLine ?? '');
  const tokens = commandLineTokens(commandLine);
  if (tokens.some((token) => token.startsWith(PROCESS_TYPE_PREFIX))) return null;
  const userDataDir = flagValueOf(tokens, '--user-data-dir');
  if (userDataDir === null) return null;
  const rawPort = flagValueOf(tokens, '--remote-debugging-port');
  const debugPort = rawPort !== null && /^\d+$/.test(rawPort) ? Number(rawPort) : null;
  return {
    pid: row.pid,
    ppid: row.ppid,
    pgid: row.pgid,
    name: row.name ?? '',
    state: row.state ?? '',
    commandLine,
    userDataDir,
    debugPort,
  };
}

/** 现场所有引擎根（`table` 可传入，省得调用方自己再读一遍）。**不判归属** —— 返回的是全机读数，
 *  调用方按带内标记分成「本次 run 的」与「别人的」，两份都要如实报出来。 */
export async function browserEngineRoots({ table = null } = {}) {
  const rows = table ?? await processTable();
  return rows.map(browserEngineRootOf).filter((root) => root !== null);
}

/** `--user-data-dir` 的值 → 它的**父目录**（= 那个沙箱根；取不到 ⇒ null）。
 *  两个细节都是 Windows 形状要的：
 *   · 尾部多余的分隔符先去掉（`C:\…\chromium\` 与 `…\chromium` 是**同一个**目录）；
 *   · 拆路径按**值自己**的形状（盘符 / UNC ⇒ `path.win32` 的规矩，`/…` ⇒ `path.posix` 的规矩），
 *     不按 `process.platform`。为什么：读**别的平台形状**的进程表时（夹具驱动就这么干），值的形状
 *     才是它自己的规矩；本机跑起来时两者一致。相对路径（两边都不像）⇒ 用宿主平台的分隔符。 */
export function parentDirectoryOf(value) {
  const text = String(value ?? '');
  if (text.length === 0) return null;
  const windowsShaped = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(text);
  const impl = windowsShaped ? path.win32 : (text.startsWith('/') ? path.posix : path);
  const trimmed = text.replace(windowsShaped ? /[\\/]+$/ : /\/+$/, '');
  if (trimmed.length === 0) return null;
  const parent = impl.dirname(trimmed);
  return parent === trimmed ? null : parent; // 根目录没有父目录 ⇒ null（不假装是它自己）
}

/** 两个路径原文是不是**同一个目录**（不是一个字符串）：Windows 形状的值 ⇒ 两种分隔符等价、大小写
 *  不敏感、尾部多余分隔符不算（Windows 的文件系统就是这么认的）；POSIX 形状 ⇒ 只去尾部多余分隔符
 *  （大小写是敏感的）。
 *  ⚠️ 这里**不是**在放宽判据：`sameDirectory` 只用来回答「引擎报的 profile 就是句柄那个目录吗」，
 *  换一个目录仍然判 false（反证臂见 `test/harness-contract.mjs` 的 ⑤组）。按字符串比会在
 *  `C:/a\b` 与 `c:\A\b\` 上假红 —— 而本件修的正是 Windows 形状上的假红。 */
export function sameDirectory(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) return false;
  const windowsShaped = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(left) || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(right);
  if (windowsShaped) {
    const fold = (value) => value.replace(/[\\/]+$/, '').replaceAll('/', '\\').toLowerCase();
    return fold(left) === fold(right);
  }
  const fold = (value) => value.replace(/\/+$/, '');
  return fold(left) === fold(right);
}

/** 带 `--user-data-dir`（认根那条旗标）却**认不出引擎根**的行 —— Windows 上「自己那颗引擎凭空消失」
 *  时唯一能说出为什么的读数（例如整个参数被引号包住）。只读、只列：**绝不**参与归属判定。
 *  `--type=` 的子进程是**故意**不算根的，所以它们不进这张表（免得把自家 renderer 说成「认不出」）。 */
export function unparsedEngineRootRows({ rows = null } = {}) {
  return (rows ?? [])
    .filter((row) => {
      const commandLine = String(row?.commandLine ?? '');
      if (!commandLine.includes('--user-data-dir')) return false;
      if (commandLineTokens(commandLine).some((token) => token.startsWith(PROCESS_TYPE_PREFIX))) return false;
      return browserEngineRootOf(row) === null;
    })
    .map((row) => ({ pid: row.pid, ppid: row.ppid, name: row.name ?? '', commandLine: String(row.commandLine ?? '').slice(0, 240) }));
}

/** 一行引擎根的**归属读数**：`{ ...root, sandbox, tokenId, owner, reason }`。归属判据只有一条
 *  （存该引擎 profile 的那个沙箱根上的令牌 id 是否等于 `runId`），但**理由原文**要留着 ——
 *  它只用于把红报告说清楚，不参与判定。读不到令牌（没有 / 坏了 / 目录不存在 / 抛了）一律
 *  算 `foreign`：认领口径不放宽，也绝不因此判红（别人的东西只记录）。 */
async function scoutEngineRoot(root, { runId, tokenIdOf }) {
  const sandbox = parentDirectoryOf(root.userDataDir);
  let tokenId = null;
  let failure = null;
  if (sandbox !== null) {
    try { tokenId = (await tokenIdOf(sandbox))?.id ?? null; } catch (error) { failure = error?.message ?? String(error); }
  }
  const owner = tokenId !== null && tokenId === runId ? 'mine' : 'foreign';
  const reason = failure !== null ? `读令牌抛了（沙箱 ${sandbox}）：${failure}`
    : sandbox === null ? '命令行里的 profile 路径取不到父目录'
      : tokenId === null ? `沙箱 ${sandbox} 上没有运行令牌（不是本仓本次 run 建的）`
        : tokenId === runId ? `沙箱 ${sandbox} 的令牌 id == 本次 run`
          : `沙箱 ${sandbox} 的令牌 id=${tokenId} ≠ 本次 run`;
  return { ...root, sandbox, tokenId, owner, reason };
}

/** 引擎人口普查：把全机引擎根按**调用方给的带内标记**分成两组 —— `mine`（本次 run 的）与
 *  `foreign`（别人的）。归属判据只有一条：存该引擎 profile 的那个沙箱根上的令牌 id 是否等于 `runId`。
 *  `tokenIdOf(directory)` 由调用方给（`test/ui-harness.mjs` 的 `readRunToken`）—— 本层不认识令牌文件
 *  的格式，只认「一个目录 → 一个 `{ id }`」这个接口。两组都返回原始读数（含 `tokenId`）。
 *
 *  多跑出来的两份**只读账**（判红时用，不参与判定）：
 *   · `scouted` —— **每一行**引擎根连同它的 `{ sandbox, tokenId, owner, reason }`（把「为什么它被算成
 *     别人的」写在现场里）；
 *   · `unparsed` —— 命令行里带 profile 旗标、却认不出引擎根的行（`unparsedEngineRootRows`）；
 *   · `commandLineMissing` —— 命令行读不到的行数（Windows 上 CIM 偶发，见 `docs/ops/handoff.md`）。
 *
 *  ⚠️ **为什么不能按「全机几个 chromium」数**：本机实测（2026-09-25）同一时刻真的有**别人的引擎**在跑
 *  （原始读数：一个 `/tmp/sopho-ui-<随机>/chromium` 主进程带 8 个 `--type=` 子进程，属于别一个进程 spawn 的），
 *  而且在我量「boot 前后」的那个窗口里它还在生/灭自己的进程与监听者 ⇒ 按全机数或按「两次列清单做差集」
 *  都会把别人的东西算到自己头上（假红）。带内标记是唯一不靠格式假设的认领口径。 */
export async function engineCensus({ runId, tokenIdOf, table = null } = {}) {
  assert.ok(typeof tokenIdOf === 'function', 'engineCensus 需要 tokenIdOf(directory) —— 令牌格式由调用方拥有');
  const rows = table ?? await processTable();
  const mine = [];
  const foreign = [];
  const scouted = [];
  for (const root of await browserEngineRoots({ table: rows })) {
    const record = await scoutEngineRoot(root, { runId, tokenIdOf });
    scouted.push(record);
    (record.owner === 'mine' ? mine : foreign).push(record);
  }
  return {
    mine,
    foreign,
    scouted,
    unparsed: unparsedEngineRootRows({ rows }),
    commandLineMissing: rows.filter((row) => String(row?.commandLine ?? '').length === 0).length,
  };
}

/** 引擎根的一行原文（判红时点名用：pid / 调试端口 / profileDir / 令牌 / 命令行）。
 *  归属与理由由 `engineSceneReport` 接在后面打（不在这一行里：已有的反证臂按这一行的原文点名）。 */
export function describeEngineRoot(root) {
  return `pid=${root.pid} debugPort=${root.debugPort ?? '(无)'} profileDir=${root.userDataDir} 令牌=${root.tokenId ?? '(无)'} cmdline=${(root.commandLine ?? '').slice(0, 240)}`;
}

// -- 「一次 boot() 只起一个引擎」的机械判据 -----------------------------------------------------
//
// 为什么（2026-09-25）：这条前提一直靠**自觉** —— 「一次 boot() 起一个引擎（一个 A + 它的 worker +
// 一个浏览器树）」写在各门的注释里，却没有机械判据；而本仓已经实测过「一次 boot 之后现场多出不止一个
// 进程树/监听者」的后果（按基线做差集认领 ⇒ 认错 ⇒ 删掉还在跑的东西）。这里把它变成会红的断言。
//
// 三条都各自能红：
//   ① 引擎根恰好一个，且它就是句柄指名的那个（pid / profileDir / 调试端口 三条都对得上）；多一个就点名。
//   ② 监听者恰好是这个引擎的：`handle.port`（静态服务，跑在**门进程里**）恰好一条且 pid == 本门 pid；
//      `handle.debugPort` 恰好一条且 pid == 引擎根；本次 run 的引擎根调试端口集合恰好 `[handle.debugPort]`。
//   ③ 句柄能**唯一指名**：引擎根的命令行里必须出现句柄的 profileDir（收尾按 pid + cmdline 核对，
//      **绝不** pkill / `pgrep -f` —— 模式会匹到自己的命令行上）。
//
// ⚠️ 口径边界（不许当成「扫到了」，写在这里因为它们不是实现细节）：
//   · 同一棵浏览器树里 chromium 自己 fork 的 zygote / renderer / gpu / utility **不算**第二个引擎
//     （它们带 `--type=`，被 `browserEngineRootOf` 摘掉）；crashpad handler 也不算（它不带
//     `--user-data-dir`）。
//   · 「别人的引擎」不算 —— 归属只看带内令牌 id == `runId`。判据要能在有别人同时跑测试的机器上绿。
//   · 认根靠**旗标**，所以一个命令行里带浏览器旗标的非浏览器进程也会被算成引擎根（这是本仓既有口径：
//     `test/browser-spawn-scan.mjs` / `bin/sandbox-sweep.mjs` 同样认旗标不认进程名）。
//
// `handle` 就是 `boot()` 返回的句柄（`{ port, debugPort, profileDir, cleanup: { pid } }`）；
// `serverPid` 默认是本进程 —— 静态服务的监听者就是**调用方自己**（`boot()` 在同进程里 listen）。
// 成功时返回原始读数 `{ mine, foreign, scouted, unparsed, serverRows, debugRows }`（给门打回报告用）。
//
// 判据原文抽成了纯函数 `oneEngineProblems`（下面），`assertOneEngine` = 读现场 + 喂给它。为什么：
// Windows 那条路在 Linux 上跑不了（进程表、监听行都是平台分叉），而「判据自己对不对」必须能在任何
// 平台上被**合成读数**钉住（`test/harness-contract.mjs` 的 ⑤ 组臂就是拿它做的）。

/** 判红时的**现场报告**（多行）：把扫到的每一行连同归属理由打出来，并把「认得出旗标、认不出引擎根」
 *  的行也列清楚。
 *  为什么非有不可（2026-09-25）：那台 Windows 机器上报回来的就是一句「本次 run 的引擎根 0 个 → ? 个」，
 *  现场什么也没说 —— 判据认不出自己的引擎时，它必须自己说清「我扫到了谁、把谁算成了谁的、
 *  哪一行带着 profile 旗标却认不出来」。外来引擎与认不出归属的进程在这里**只是被列出来**，
 *  绝不参与判定。 */
export function engineSceneReport(census) {
  const scouted = census?.scouted ?? [];
  const lines = [`现场读数（本 run 的引擎根 ${(census?.mine ?? []).length} 个 / 别人的引擎 ${(census?.foreign ?? []).length} 个）：`];
  for (const row of scouted) lines.push(`  · ${describeEngineRoot(row)} 归属=${row.owner ?? '?'}（${row.reason ?? '无理由记录'}）`);
  const unparsed = census?.unparsed ?? [];
  if (unparsed.length > 0) {
    lines.push(`带 profile 旗标、但认不出引擎根的行 ${unparsed.length} 条（照原样列出，**不参与判定**）：`);
    for (const row of unparsed.slice(0, 8)) lines.push(`  · pid=${row.pid} name=${row.name || '(无名)'} cmdline=${row.commandLine}`);
    if (unparsed.length > 8) lines.push(`  · …还有 ${unparsed.length - 8} 条`);
  }
  // ⚠️ 只在 Windows 上提这一条：POSIX 上「命令行空」的默认原因完全不同 —— 内核线程（几百个）根本
  // 没有 argv，而自家 chromium 的 `/proc/<pid>/cmdline` 读得到 ⇒ 在那边这一行是纯噪声，不能把
  // 「内核线程」说成「读不到的引擎」。Windows 上它是一条真存在的现象（CIM 偶发，见 docs/ops/handoff.md）。
  if (process.platform === 'win32' && (census?.commandLineMissing ?? 0) > 0) {
    lines.push(`另有 ${census.commandLineMissing} 行命令行读不到（Windows 上 CIM 偶发，见 docs/ops/handoff.md）—— 这种进程完全不在候选里`);
  }
  if (scouted.length === 0) lines.push('  现场**一个引擎根都没扫到**：要么这次真没有引擎在跑，要么进程表本身读不到（见上面那条）。');
  return lines.join('\n');
}

/** 「一次 boot() 只起一个引擎」的**判据原文（纯函数）**：吃**读数**，不看现场。
 *  `listenerRowsByPort` = 端口 → 那次读数（`listenerRows()` 的返回）；**缺**一条端口的读数按空数组
 *  判 —— 偏红，不偏绿（少读一条账不能变成「没问题」）。
 *  返回问题清单（原文，给红报告用）；空数组 = 这次 boot() 合规。 */
export function oneEngineProblems({ census, handle, listenerRowsByPort = null, serverPid = process.pid } = {}) {
  const mine = census?.mine ?? [];
  const expectedPid = Number(handle?.cleanup?.pid ?? NaN);
  const rowsOf = (port) => {
    if (listenerRowsByPort === null) return [];
    if (typeof listenerRowsByPort.get === 'function') return listenerRowsByPort.get(Number(port)) ?? [];
    return listenerRowsByPort[Number(port)] ?? [];
  };
  const problems = [];
  const named = mine.find((root) => root.pid === expectedPid) ?? null;
  const extras = mine.filter((root) => root.pid !== expectedPid);
  if (mine.length !== 1) {
    problems.push(`本次 run 的引擎根应有 1 个，实测 ${mine.length} 个${mine.length === 0 ? '（一个都没有）' : `：${mine.map(describeEngineRoot).join(' ｜ ')}`}`);
  }
  if (extras.length > 0) problems.push(`多出来的引擎（不是句柄指名的 pid ${expectedPid}）：${extras.map(describeEngineRoot).join(' ｜ ')}`);
  if (named === null) {
    problems.push(`句柄指名的 pid ${expectedPid} 不在本次 run 的引擎根里`);
  } else {
    // 路径按**平台自己的同一个目录**判（Windows 上 `C:/a\b` 与 `c:\A\b\` 是同一个目录）：
    // 这里判的是「引擎报的 profile 就是句柄那个目录吗」，不是「两个字符串长得一样吗」。
    if (!sameDirectory(named.userDataDir, handle.profileDir)) problems.push(`引擎根的 profileDir=${named.userDataDir} ≠ 句柄的 ${handle.profileDir}`);
    if (named.debugPort !== handle.debugPort) problems.push(`引擎根的调试端口=${named.debugPort ?? '(无)'} ≠ 句柄的 ${handle.debugPort}`);
    if (!named.commandLine.includes(String(handle.profileDir))) problems.push(`pid ${named.pid} 的命令行里没有句柄的 profileDir ${handle.profileDir} ⇒ 收尾按 pid+cmdline 核对时认不出它`);
  }
  const serverRows = rowsOf(handle.port);
  if (serverRows.length !== 1) problems.push(`静态服务端口 ${handle.port} 的监听行应有 1 条，实测 ${serverRows.length} 条：${JSON.stringify(serverRows.map((row) => row.raw))}`);
  else if (serverRows[0].pid !== serverPid) problems.push(`静态服务端口 ${handle.port} 的监听 pid=${serverRows[0].pid} ≠ 本门 pid ${serverPid}（它不是本次 run 自己起的那个服务）`);
  const debugRows = rowsOf(handle.debugPort);
  if (debugRows.length !== 1) problems.push(`调试端口 ${handle.debugPort} 的监听行应有 1 条，实测 ${debugRows.length} 条：${JSON.stringify(debugRows.map((row) => row.raw))}`);
  else if (debugRows[0].pid !== expectedPid) problems.push(`调试端口 ${handle.debugPort} 的监听 pid=${debugRows[0].pid} ≠ 引擎根 pid ${expectedPid}`);
  for (const root of mine) {
    if (root.debugPort === null) { problems.push(`引擎根 ${describeEngineRoot(root)} 的命令行里没有 --remote-debugging-port ⇒ 无从核对它的监听行`); continue; }
    const rows = rowsOf(root.debugPort);
    if (rows.length !== 1 || rows[0].pid !== root.pid) problems.push(`引擎根 pid ${root.pid} 的调试端口 ${root.debugPort} 监听行=${JSON.stringify(rows.map((row) => row.raw))}（应恰好 1 条且 pid=${root.pid}）`);
  }
  const ports = [...new Set(mine.map((root) => root.debugPort))].sort((a, b) => Number(a) - Number(b));
  if (ports.length !== 1 || ports[0] !== handle.debugPort) problems.push(`本次 run 的引擎调试端口集合=${JSON.stringify(ports)}（应恰好 [${handle.debugPort}]）`);
  // 最后一条是**现场**（多行）：认不出自己的引擎时必须自己说清为什么 —— 只报「0 → ? 个」是本件要修的
  // 那件事。放在最后：前面那几条原文（尤其「多出来的引擎（不是句柄指名的 pid …）：pid=…」）要保持
  // 「一行一条、可被模式点名」的形状（反证臂就在抓那一行）。
  if (problems.length > 0) problems.push(`\n${engineSceneReport(census)}`);
  return problems;
}

export async function assertOneEngine(handle, { runId, tokenIdOf, label = '一次 boot() 只许起一个引擎', serverPid = process.pid } = {}) {
  const census = await engineCensus({ runId, tokenIdOf, table: null });
  const ports = [...new Set([handle.port, handle.debugPort, ...census.mine.map((root) => root.debugPort)])]
    .filter((port) => Number.isInteger(Number(port)));
  const listenerRowsByPort = new Map();
  for (const port of ports) listenerRowsByPort.set(Number(port), await listenerRows(port));
  const problems = oneEngineProblems({ census, handle, listenerRowsByPort, serverPid });
  if (problems.length > 0) throw new Error(`${label} —— ${problems.join(' ｜ ')}`);
  return {
    mine: census.mine,
    foreign: census.foreign,
    scouted: census.scouted,
    unparsed: census.unparsed,
    serverRows: listenerRowsByPort.get(Number(handle.port)) ?? [],
    debugRows: listenerRowsByPort.get(Number(handle.debugPort)) ?? [],
  };
}

/** 单个进程的一行事实：`{ pid, ppid, pgid, name, state, commandLine }`；进程没了 ⇒ null。
 *  要「父 pid / 进程组 / 名字」而不想为每一次轮询付一张全表的价（`test/sandbox-hygiene.mjs`
 *  的 `ppidOf` 就在 100 ms 的等条件循环里）时用这个，别自己再读一遍 procfs。
 *  Windows：`pgid` 恒为 null、`state` 恒为 ''（没有这两个概念），其余来自 CIM 的同一条查询。 */
export async function processInfoOf(pid) {
  const selected = Number(pid);
  if (!Number.isInteger(selected) || selected <= 0) return null;
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter "ProcessId = ${selected}" -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row) return null;
    return {
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId ?? 0),
      pgid: null,
      state: '',
      name: String(row.Name ?? ''),
      commandLine: String(row.CommandLine ?? ''),
    };
  }
  const stat = await readFile(`/proc/${selected}/stat`, 'utf8').catch(() => null);
  if (!stat) return null;
  return {
    ...parsePosixStat(stat),
    pid: selected,
    commandLine: (await readFile(`/proc/${selected}/cmdline`, 'utf8').catch(() => '')).split('\0').join(' '),
  };
}

/** 某个 pid 的**进程组 id**（`setpgid`/`detached` 起的浏览器树按组收尾时要的那个数）。
 *  POSIX 取 `/proc/<pid>/stat` 的 pgrp；Windows 没有可读的等价物 ⇒ null（不许假装 0）。
 *  pid 不存在 / 读不到 ⇒ null。 */
export async function processGroupId(pid) {
  if (process.platform === 'win32') return null;
  const selected = Number(pid);
  if (!Number.isInteger(selected) || selected <= 0) return null;
  const stat = await readFile(`/proc/${selected}/stat`, 'utf8').catch(() => null);
  if (!stat) return null;
  const pgid = parsePosixStat(stat).pgid;
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

/** 某个 pid 的**环境变量**（`['KEY=value', …]`）；进程没了 / 读不到 ⇒ null。
 *  Windows 上**没有**读别的进程环境这一说（CIM 不暴露）⇒ 恒 null，而不是空数组 —— 调用方据此
 *  说明「这条规则在这台机器上不可能命中」，不许把「读不到」说成「没有」。 */
export async function processEnvironment(pid) {
  if (process.platform === 'win32') return null;
  const selected = Number(pid);
  if (!Number.isInteger(selected) || selected <= 0) return null;
  const raw = await readFile(`/proc/${selected}/environ`, 'utf8').catch(() => null);
  if (raw === null) return null;
  return raw.split('\0').filter((entry) => entry.length > 0);
}

/**
 * 「谁还引用着这个路径」—— **命令行或环境**里带着它的进程，`[{ pid, via }]`（`via` = `'commandLine'` / `'environment'`）。
 *
 * 为什么住在这一层（2026-09-25，`test/harness-contract.mjs` 打回一次）：这既是「读整张进程表」又是「读每个进程的环境」——
 * 两件事的平台分叉（POSIX 的 procfs / Windows 的 CIM）只住本文件。门要问，不许自己扫。
 * 它**只读**，拿到的 pid 由调用方决定怎么处理；**绝不按进程名杀**（本仓踩过四次）。
 *
 * 语义（如实，不把「量不到」说成「没有」）：
 *   · POSIX：两处都查（命令行 ＋ 环境）；没有 procfs 的 POSIX ⇒ **null**（量不了）；
 *   · Windows：CIM 只给得出**命令行** ⇒ 环境**根本没查**（别把返回的空数组读成「环境也干净」）；
 *   · 单个进程读不到（别的用户 / `hidepid` / 刚好在退）⇒ 那一个**不谎报**成命中，也不代表它干净。
 *
 * 用途（一手例子）：收尾时判「本次那个 work 目录还有没有进程引用着」—— 自己 setsid 逃出进程组的
 * 子进程（真 `chrome_crashpad_handler` 就是：实测 ppid=1、pgid=它自己）也跑不掉，因为浏览器那棵树
 * 全部继承了 `HOME=<work>/home` / `TMPDIR=<work>/tmp`，环境里就带着那个路径。
 */
export async function processesReferencingPath(target, { table = null } = {}) {
  const needle = typeof target === 'string' ? target : '';
  if (needle.length === 0) return [];
  let rows;
  try {
    rows = table ?? await processTable({ withCommandLine: true });
  } catch {
    return null;   // 没有 procfs（非 Linux 的 POSIX）⇒ 量不了
  }
  const found = [];
  for (const row of rows) {
    if (row.commandLine.includes(needle)) { found.push({ pid: row.pid, via: 'commandLine' }); continue; }
    const environment = await processEnvironment(row.pid);
    if (environment !== null && environment.some((entry) => entry.includes(needle))) found.push({ pid: row.pid, via: 'environment' });
  }
  return found;
}

/** 整机内存读数（MiB）：`{ totalMiB, availableMiB, usedMiB }`；读不到 ⇒ null（不假装 0）。
 *  POSIX 走 `/proc/meminfo` 的 MemTotal/MemAvailable；Windows 走 `Win32_OperatingSystem` 的
 *  TotalVisibleMemorySize/FreePhysicalMemory（两边都是 kB）。 */
export async function systemMemoryMiB() {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const row = JSON.parse(trimmed);
    const totalKb = Number(row.TotalVisibleMemorySize);
    const freeKb = Number(row.FreePhysicalMemory);
    if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb)) return null;
    return { totalMiB: totalKb / 1024, availableMiB: freeKb / 1024, usedMiB: Math.round((totalKb - freeKb) / 1024) };
  }
  const text = await readFile('/proc/meminfo', 'utf8').catch(() => null);
  if (text === null) return null;
  const totalKb = Number(/MemTotal:\s+(\d+)/.exec(text)?.[1] ?? NaN);
  const availableKb = Number(/MemAvailable:\s+(\d+)/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb)) return null;
  return { totalMiB: totalKb / 1024, availableMiB: availableKb / 1024, usedMiB: Math.round(totalKb / 1024 - availableKb / 1024) };
}

// -- 进程级采样：CPU 时间 + RSS（`test/a29-tree-leak.mjs` / `test/abandoned-request-cost.mjs` 等共用） --
//
// 为什么不能只看 `/host` 的 workerHeapUsedBytes：那是 **V8 视角**；「进程还在烧 CPU」要看内核
// 给的 utime+stime。两条一起看才能区分「堆没涨但还在算」和「真停了」。
//
// 这一层是平台分叉唯一的家（纪律见 `test/harness-contract.mjs`）：POSIX 读 `/proc/<pid>/stat{,m}`；
// Windows 用**常驻** PowerShell 采样器（每次 `Get-Process` 只要 ~50 ms，起一次进程要 1-2 s，
// 逐次 spawn powershell 会把「采样本身」变成干扰）。调用方一律 `const sampler = createProcessSampler()`
// 拿 `{ kind, sample(pids) -> Map<pid, {cpuMs,rssBytes}|null>, stop() }`。
export function createProcessSampler() {
  if (process.platform !== 'win32') {
    return {
      kind: 'procfs',
      async sample(pids) {
        const out = new Map();
        for (const pid of pids) {
          try {
            const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
            const tail = statText.slice(statText.lastIndexOf(')') + 2).trim().split(/\s+/);
            const utime = Number(tail[11]);
            const stime = Number(tail[12]);
            const statm = await readFile(`/proc/${pid}/statm`, 'utf8');
            const rssPages = Number(statm.trim().split(/\s+/)[1]);
            out.set(pid, { cpuMs: (utime + stime) * 10, rssBytes: rssPages * 4096 });
          } catch {
            out.set(pid, null);
          }
        }
        return out;
      },
      async stop() {},
    };
  }

  const script = `
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $out = foreach ($p in $line.Split(" ")) {
    $proc = Get-Process -Id ([int]$p) -ErrorAction SilentlyContinue
    if ($proc) { [pscustomobject]@{ pid = [int]$p; cpuMs = [math]::Round(([double]$proc.CPU) * 1000, 1); rssBytes = [int64]$proc.WorkingSet64 } }
    else { [pscustomobject]@{ pid = [int]$p; cpuMs = $null; rssBytes = $null } }
  }
  Write-Output ($out | ConvertTo-Json -Compress)
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiters = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      newline = buffer.indexOf('\n');
    }
  });
  const roundTrip = (pids) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('powershell sampler did not answer in 20000ms')), 20_000);
    waiters.push((line) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(line);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const map = new Map();
        for (const item of list) map.set(item.pid, item.cpuMs === null ? null : { cpuMs: item.cpuMs, rssBytes: item.rssBytes });
        resolve(map);
      } catch (error) {
        reject(new Error(`powershell sampler returned unparsable line: ${line.slice(0, 200)} (${error.message})`));
      }
    });
    child.stdin.write(`${pids.join(' ')}\n`);
  });
  let queue = Promise.resolve();
  return {
    kind: 'powershell',
    sample(pids) {
      queue = queue.then(() => roundTrip(pids), () => roundTrip(pids));
      return queue;
    },
    async stop() {
      try { child.stdin.end(); } catch {}
      await sleep(120);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

// 单个 pid 的状态：POSIX 是 `Z`/`R`/`S`…；Windows 只分「在」与「不在」（返回 `S`）。没了 ⇒ null。
export async function processStateOf(pid) {
  if (process.platform === 'win32') {
    const script = `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { 'up' }`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return stdout.trim() === 'up' ? 'S' : null;
  }
  const stat = await readFile(`/proc/${Number(pid)}/stat`, 'utf8').catch(() => null);
  if (!stat) return null;
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
}

// 活着且不是僵尸。
export async function processAlive(pid) {
  const state = await processStateOf(pid);
  return state !== null && state !== 'Z';
}

export async function stopOwnedListener(port, expectedEntry, expectedPid) {
  assert.ok(Number.isInteger(Number(expectedPid)) && Number(expectedPid) > 0, `refusing to stop port ${port}: spawned pid is missing`);
  const listener = await listenerPid(port);
  if (!listener) return;
  assert.equal(listener, Number(expectedPid), `refusing to stop port ${port}: listener pid ${listener} is not spawned pid ${expectedPid}`);
  const commandLine = await processCommandLine(listener);
  assert.ok(commandLine.includes(expectedEntry), `refusing to stop pid ${listener}: command line is not ${expectedEntry}`);
  process.kill(listener, 'SIGTERM');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await listenerPid(port) === 0) return;
    await sleep(40);
  }
  throw new Error(`pid ${listener} did not release port ${port}`);
}

export async function installShellCommand(directory, name, source) {
  const script = `${directory}/${name}${process.platform === 'win32' ? '.sh' : ''}`;
  await writeFile(script, source, 'utf8');
  await chmod(script, 0o755);
  if (process.platform !== 'win32') return script;

  const output = `${directory}/${name}.exe`;
  const bash = process.env.SOPHO_TEST_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe';
  const escape = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const csharp = `using System; using System.Diagnostics; using System.Linq;
public class Shim { public static int Main(string[] args) {
  if (args.Any(a => a.Contains("sleep 30"))) { System.Threading.Thread.Sleep(30000); return 0; }
  var p = new Process(); p.StartInfo.FileName = "${escape(bash)}";
  p.StartInfo.Arguments = "\\\"${escape(script)}\\\" " + String.Join(" ", args.Select(a => "\\\"" + a.Replace("\\\"", "\\\\\\\"") + "\\\""));
  p.StartInfo.UseShellExecute = false; p.StartInfo.RedirectStandardInput = true;
  p.StartInfo.RedirectStandardOutput = true; p.StartInfo.RedirectStandardError = true; p.Start();
  p.StandardInput.Close(); p.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput());
  p.StandardError.BaseStream.CopyTo(Console.OpenStandardError()); p.WaitForExit(); return p.ExitCode;
} }`;
  const command = `Add-Type -TypeDefinition @'\n${csharp}\n'@ -OutputAssembly '${output.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  return output;
}

export async function quiesceCdpPage(browser) {
  if (!browser) return;
  try {
    await browser.send('Page.navigate', { url: 'about:blank' });
    await sleep(120);
  } catch {}
}

export async function stopSpawnedListener(child, port, expectedEntry) {
  if (!child || !port) return;
  await stopOwnedListener(port, expectedEntry, child.pid);
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2000),
    ]);
  }
}
