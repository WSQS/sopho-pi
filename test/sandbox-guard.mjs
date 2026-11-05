#!/usr/bin/env node
// 沙箱守卫（sandbox guard）—— 沙箱进程树的「同生共死」+「寿命上限」兜底。
//
// 为什么存在（2026-09-18 夜的事故，见 docs/handoff.md 的「沙箱卫生」一节）：
//   测试 harness 把 `server/base.mjs` 当普通子进程起。POSIX 上普通子进程**不会**随父进程
//   消失而死，而 `server/base.mjs` 与 `server/worker.mjs` 都**不监视自己的父进程** ——
//   于是 harness 被 SIGKILL 后，宿主连同它的 generation worker 永远活着（被 init /
//   systemd --user 收养）。生产机上那次因此攒下 37 个孤儿、3.8 GiB RSS。
//   Windows 掩盖了这个洞：libuv 会把 node 起的子进程放进一个以「起它的进程」为属主的
//   job object，属主一死整棵树跟着死（实测，见 docs/handoff.md）。同一个 bug 在 Linux 上
//   表现为孤儿、在 Windows 上看不见。
//
// 守卫做三件事：
//   1. 同生共死：它由 harness 以「stdin 是管道 + 带 IPC 通道」的方式拉起。harness 一消失，
//      IPC 通道断开（`disconnect`，不会误触发）和/或 stdin 到 EOF（需显式 `--watch-stdin`，
//      因为 `stdio:'ignore'` 会立刻 EOF），任意一个都让守卫拆除整棵树。
//   2. 寿命上限：即使没有任何人叫停，`--lifetime-ms` 到点也自杀。默认 20 分钟，依据见
//      docs/handoff.md。
//   3. 整棵树一起杀：POSIX 用子进程自己的**进程组**（`detached` 起，`kill(-pgid)`）；
//      Windows 用 `taskkill /PID <pid> /T /F`。**只按 pid，不按名字，不用 glob**
//      （仓库纪律：绝不用 pkill / killall）。
//
// 用法（harness 侧）：
//   const guard = spawn(process.execPath, [
//     sandboxGuardPath,
//     '--entry', path.join(root, 'server', 'base.mjs'),
//     '--label', 's1b-host-51234',
//     '--lifetime-ms', String(lifetimeMs),
//     '--watch-stdin',
//     '--record', factsPath,
//   ], { cwd: root, env: sandboxEnv, stdio: ['pipe', logFd, logFd, 'ipc'] });
//   // 等 IPC 的 { type:'sandbox-start', pid } 拿到沙箱根的真实 pid（= base.mjs 的 pid）。
//
// 沙箱根的 stdout/stderr 直接继承守卫的 fd 1/2（于是仍然写进 harness 打开的那个日志文件，
// 日志格式与从前一致）。守卫自己只往 fd 1 打 `[sandbox-guard]` 前缀的行 —— 拆树的原因就写在
// 那里，日志本身即证据。
//
// 退出码：沙箱自己退出时沿用它的退出码；守卫主动拆树时为 0；守卫自身出错为非 0。
import { spawn, spawnSync } from 'node:child_process';
import { fstatSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LIFETIME_MS = 20 * 60 * 1000;
const DEFAULT_GRACE_MS = 5000;

function parseArgs(argv) {
  const options = { entry: null, label: 'sandbox', lifetimeMs: null, graceMs: DEFAULT_GRACE_MS, record: null, watchStdin: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === '--entry') options.entry = take();
    else if (arg === '--label') options.label = take();
    else if (arg === '--lifetime-ms') options.lifetimeMs = Number(take());
    else if (arg === '--grace-ms') options.graceMs = Number(take());
    else if (arg === '--record') options.record = take();
    else if (arg === '--watch-stdin') options.watchStdin = true;
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!options.entry) throw new Error('--entry <script> is required');
  if (options.lifetimeMs === null) {
    const fromEnv = Number(process.env.SOPHO_SANDBOX_LIFETIME_MS);
    options.lifetimeMs = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_LIFETIME_MS;
  }
  if (!Number.isFinite(options.lifetimeMs) || options.lifetimeMs <= 0) throw new Error('--lifetime-ms must be a positive number');
  if (!Number.isFinite(options.graceMs) || options.graceMs < 0) throw new Error('--grace-ms must be >= 0');
  return options;
}

const options = parseArgs(process.argv.slice(2));
const isWindows = process.platform === 'win32';

function note(message) {
  if (options.quiet) return;
  process.stdout.write(`[sandbox-guard ${options.label}] ${message}\n`);
}

// `process.send` throws ERR_IPC_CHANNEL_CLOSED once the harness is gone -- which is
// exactly the moment we are reacting to, so it must never be fatal.
function sendToHarness(message) {
  if (!process.connected) return;
  try {
    process.send?.(message);
  } catch {}
}

// POSIX only: the process group of a pid, from field 5 of /proc/<pid>/stat. The comm
// field is parenthesised and may itself contain spaces and parentheses, so parse after
// the last ')'.
function pgidOf(pid) {
  if (isWindows) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function pgidMembers(pgid) {
  // `ps -g` is not portable (GNU treats -g as session-or-group); filter -eo ourselves.
  const result = spawnSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  return String(result.stdout)
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && Number(parts[1]) === pgid)
    .map((parts) => Number(parts[0]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeRecord(patch) {
  if (!options.record) return;
  try {
    await mkdir(path.dirname(options.record), { recursive: true });
    let previous = {};
    try {
      previous = JSON.parse(await readFile(options.record, 'utf8'));
    } catch {}
    await writeFile(options.record, `${JSON.stringify({ ...previous, ...patch }, null, 2)}\n`);
  } catch (error) {
    note(`could not write record ${options.record}: ${error.message}`);
  }
}

// `detached` on POSIX puts the sandbox root in its own session/process group, so the whole
// tree (host + its forked generation workers) can be signalled as a unit. On Windows we do
// NOT detach: libuv's job object then already kills the tree when this guard exits, and
// `taskkill /T` covers the explicit path.
const child = spawn(process.execPath, [options.entry], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: !isWindows,
});
const childPid = child.pid;
const childPgid = isWindows ? null : pgidOf(childPid);
const ownPgid = isWindows ? null : pgidOf(process.pid);

note(`started pid=${childPid} pgid=${childPgid ?? '-'} entry=${options.entry} lifetimeMs=${options.lifetimeMs} watchStdin=${options.watchStdin}`);
await writeRecord({
  label: options.label,
  entry: options.entry,
  guardPid: process.pid,
  sandboxPid: childPid,
  sandboxPgid: childPgid,
  lifetimeMs: options.lifetimeMs,
  startedAt: new Date().toISOString(),
  reason: null,
  exitedAt: null,
});

process.send?.({ type: 'sandbox-start', label: options.label, pid: childPid, pgid: childPgid, entry: options.entry, lifetimeMs: options.lifetimeMs });
let finishing = false;
let reason = null;
let childExit = null;
const childExited = new Promise((resolve) => {
  child.once('exit', (code, signal) => {
    childExit = { code, signal };
    resolve(childExit);
  });
  child.once('error', (error) => {
    childExit = { code: null, signal: null, error: error.message };
    resolve(childExit);
  });
});

// Group-kill on POSIX, tree-kill on Windows. Refuses to group-kill when the sandbox root
// shares OUR process group: that group contains the guard (and maybe the harness), so it
// would be a self-inflicted wound for no benefit.
// Returns { gracefulRefused } -- Windows has no real SIGTERM, so `taskkill /T` without /F is
// refused for console-less node processes; there is no point waiting out the grace window
// for a signal the OS just told us it will not deliver. Skipping that wait shortens the
// window in which a half-torn-down tree is still alive.
function killTreeOnce(signal) {
  if (isWindows) {
    const force = signal === 'SIGKILL';
    const args = ['/PID', String(childPid), '/T'];
    if (force) args.push('/F');
    const result = spawnSync('taskkill', args, { encoding: 'utf8' });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error) note(`taskkill failed: ${result.error.message}`);
    else if (result.status !== 0 && !/not found|no running instance/i.test(text)) {
      note(`taskkill (${force ? '/F' : 'graceful'}) exit=${result.status} ${text.trim()}`);
    }
    return { gracefulRefused: !force };
  }
  if (childPgid !== null && ownPgid !== null && childPgid !== ownPgid && childPgid > 0) {
    try { process.kill(-childPgid, signal); } catch (error) { if (error?.code !== 'ESRCH') note(`group kill ${signal} failed: ${error.message}`); }
    return { gracefulRefused: false };
  }
  note(`refusing group kill (sandbox pgid ${childPgid} vs guard pgid ${ownPgid}); killing the exact pid only`);
  try { process.kill(childPid, signal); } catch (error) { if (error?.code !== 'ESRCH') note(`pid kill ${signal} failed: ${error.message}`); }
  return { gracefulRefused: false };
}

async function finish(why) {
  if (finishing) return;
  finishing = true;
  reason = why;
  note(`tearing down: reason=${why} childPid=${childPid} childPgid=${childPgid ?? '-'}`);
  const { gracefulRefused } = killTreeOnce('SIGTERM');
  if (gracefulRefused) note('the OS refused the graceful pass, going straight to the forceful one');
  const deadline = Date.now() + options.graceMs;
  while (!gracefulRefused && Date.now() < deadline && alive(childPid)) await sleep(50);
  killTreeOnce('SIGKILL');
  await Promise.race([childExited, sleep(2000)]);

  // Report every survivor in the group: "the tree never really started" must stay
  // distinguishable from "the tree refused to die".
  let survivors = [];
  if (childPgid !== null && childPgid !== ownPgid) {
    const deadline2 = Date.now() + 3000;
    while (Date.now() < deadline2) {
      survivors = pgidMembers(childPgid).filter((pid) => alive(pid));
      if (survivors.length === 0) break;
      await sleep(100);
    }
  }
  if (survivors.length > 0) note(`WARNING survivors in process group ${childPgid}: ${survivors.join(',')}`);
  await writeRecord({ reason, childExit, exitedAt: new Date().toISOString(), survivors });
  sendToHarness({ type: 'sandbox-guard-done', label: options.label, reason, sandboxPid: childPid, survivors });
  note(`done: reason=${why} sandboxAlive=${alive(childPid)} survivors=${survivors.length}`);
  // Propagate the sandbox's own exit code only when the sandbox exited by itself. After a
  // teardown that WE initiated the code is meaningless (Windows reports 1 for every
  // TerminateProcess), and a gate must not read that as a guard failure.
  if (why === 'sandbox-exit' && childExit && typeof childExit.code === 'number') process.exit(childExit.code);
  process.exit(0);
}

// 1. same-life: the harness's stdio. `disconnect` cannot fire spuriously; stdin EOF needs an
//    explicit opt-in because `stdio: 'ignore'` yields an immediate EOF.
if (process.connected) {
  process.on('disconnect', () => { void finish('parent-disconnect'); });
} else {
  note('no IPC channel: parent-disconnect detection is OFF (spawn with an ipc stdio entry)');
}
if (options.watchStdin) {
  // Only a pipe carries the "the harness is gone" signal. `stdio: 'ignore'` gives
  // /dev/null (immediate EOF) and an inherited terminal would EOF at the wrong time; in
  // both cases watching would tear the sandbox down immediately.
  const stdinIsPipe = (() => {
    try {
      const stat = fstatSync(0);
      return stat.isFIFO() || stat.isSocket();
    } catch {
      return false;
    }
  })();
  if (stdinIsPipe) {
    note('watching stdin for EOF (harness stdin is a pipe)');
    process.stdin.resume();
    process.stdin.on('end', () => { void finish('parent-eof'); });
    process.stdin.on('close', () => { void finish('parent-eof'); });
    process.stdin.on('error', () => { void finish('parent-eof'); });
  } else {
    note('--watch-stdin ignored: fd 0 is not a pipe, so EOF there would not mean the harness died');
  }
}

// 2. lifetime cap.
const lifetimeTimer = setTimeout(() => { void finish('lifetime'); }, options.lifetimeMs);
lifetimeTimer.unref?.();

// 3. a signal aimed at the guard tears the tree down too, instead of orphaning it.
process.on('SIGTERM', () => { void finish('signal:SIGTERM'); });
process.on('SIGINT', () => { void finish('signal:SIGINT'); });

// The sandbox root exiting on its own is the normal path: reap whatever it left behind
// (a host can exit while its generation workers are still alive) and stop.
void childExited.then(() => {
  clearTimeout(lifetimeTimer);
  void finish('sandbox-exit');
});
