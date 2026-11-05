#!/usr/bin/env node
// 沙箱卫生门（sandbox hygiene gate）—— 2026-09-18 夜「37 个孤儿」事故的机械锚点。
//
// 事故形状（详见 docs/handoff.md 的「沙箱卫生」一节）：
//   测试 harness 把 `server/base.mjs` 当普通子进程起；POSIX 上普通子进程不随父进程死，
//   而 base.mjs / worker.mjs 都不监视自己的父进程 —— harness 被 SIGKILL 后，宿主连同
//   generation worker 被 init / systemd --user 收养，永远活着（生产机上一次攒了 37 个、
//   3.8 GiB RSS，把整机拖死）。Windows 因为 libuv 的 job object 看不见这个洞。
//
// 这道门要机械地证明三件事（对应兜底三层）：
//   第一层 同生共死   `guard-lifetime` + `real-host-sigkill`：harness 一消失，整棵树自己退。
//   第二层 寿命上限   `guard-lifetime`：没人叫停时，守卫到点自杀并带走整棵树。
//   第三层 独立扫描   `sweep-deleted-worktree` / `sweep-adopted-orphan` /
//                     `sweep-refuses-production` / `sweep-relative-parent` / `old-spawn-no-guard`：
//                     守卫自己也死了的情况由 `bin/sandbox-sweep.mjs` 兜。
//   反面对照 `old-spawn-no-guard`：**不走守卫**的旧起法在 POSIX 上必然留下孤儿 ——
//   那一条就是"修前红"的机械复现（Windows 上它会被 job object 掩盖，门里如实打印）。
//
// 2026-09-19 的收紧（本门新增的一对正反例，都钉在第三层）：
//   `sweep-deleted-worktree`（正 → 反）：**worktree 被删 ≠ 里面是孤儿**。当天另一条子会话的
//     generation worker `pid 102969` 被 `bin/sandbox-sweep.mjs --apply` 杀掉，而它的宿主
//     （它的父）`pid 102957` 一直活着 —— 触发的是 `entry-dir-missing`（那条会话的 worktree
//     被删了）。原始日志 `/tmp/refetch-logs/sandbox-hygiene.log`。现在"父链还活着" ⇒ 只报告
//     不杀，并把父 pid + cmdline 打出来。
//   `sweep-adopted-orphan`（反 → 正）：收紧**不得削弱**原本要防的事。2026-09-18 夜那 37 个
//     孤儿（3.8 GiB，把生产实例拖死）正是"worktree 被删 + harness 早已不在（树被 init /
//     `systemd --user` 收养）"；这一条必须仍能被认成孤儿并按精确 pid 清掉。
//
// 纪律：随机高位端口、临时 home/workspace、只按精确 pid 杀、绝不 pkill、
//       绝不用 7331/7321、绝不碰真 profile 或 arcsopho。
//       ⚠️ `bin/sandbox-sweep.mjs` 是**整机**扫描，这台机子上还有别的会话的沙箱 —— 所以本门
//       调 `--apply` 一律带 `--only-pid <本门自己造的 pid>`：枪口只对自己那一侧。
//
// 跑法：
//   node test/sandbox-hygiene.mjs --case all
//   node test/sandbox-hygiene.mjs --case guard-lifetime
//   --case guard-lifetime | old-spawn-no-guard | real-host-sigkill | sweep-deleted-worktree
//         | sweep-adopted-orphan | sweep-refuses-production | sweep-refuses-production-env
//         | sweep-relative-parent | sweep-browser-marker | sweep-browser-orphan | sweep-stale-dirs
//         | sweep-dir-prefixes
//   npm script：`test:sandbox-hygiene`（= `--case all`）／`test:sandbox-hygiene:reverse`（反证臂）
//
// 反证臂（`--reverse-arm=<名字>`，本仓既有写法：在**副本**上把产品改回旧行为，再拿副本里的
// **真门**打它，断言它**必红**；真树一个字节不动）：
//   `exit-truncates-pipe` —— 把 `bin/sandbox-sweep.mjs` 的出口改回旧行为 `process.exit(exitCode)`。
//   为什么它值一条臂：2026-09-27 之前本门 `old-spawn-no-guard` 那条「至少要被认出来」的红，
//   根因就是这一行 —— POSIX 上 stdout 接**管道**（本门用 `execFile` 读，就是管道）时写入是异步的，
//   `process.exit()` 把还没冲出去的那截**静默掐掉**：同一份 221053 B 的文档重定向到文件一个字节不少，
//   走管道只到 131072 B（`| wc -c`）/ 146176 B（`execFile`）—— 到多少看读端多快，但**总归到不齐**。
//   ⇒ 那份 JSON 停在半截、解析不出来 ⇒ 下游把 `orphans` 当空集 ⇒ 一条**真孤儿**看起来是
//   「没被认出来」。臂有牙 = 把这一行改回去，门就红在那条断言上
//   （`the orphan must at least be recognized by bin/sandbox-sweep.mjs`）。
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cleanupStep, listenerPid, processInfoOf, processTable } from './harness.mjs';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');
const guardEntry = path.join(testDir, 'sandbox-guard.mjs');
const sweepEntry = path.join(root, 'bin', 'sandbox-sweep.mjs');
const miniHarnessEntry = path.join(testDir, 'fixtures', 'sandbox-mini-harness.mjs');
const standInHost = path.join(testDir, 'fixtures', 'sandbox-stand-in-host.mjs');
const standInWorker = path.join(testDir, 'fixtures', 'sandbox-stand-in-worker.mjs');
const standInBrowser = path.join(testDir, 'fixtures', 'sandbox-stand-in-browser.mjs');
const isWindows = process.platform === 'win32';

// A fresh worktree has no node_modules of its own; `test/s0b.mjs` and `test/win-serve.mjs`
// link the main tree's copy. Do the same so the real-host arm can actually boot.
const nodeModulesPath = path.join(root, 'node_modules');
if (!existsSync(nodeModulesPath)) {
  const mainModules = path.join(path.dirname(path.resolve(root)), '..', 'sopho-pi', 'node_modules');
  const main = existsSync(mainModules) ? mainModules : path.join(path.dirname(root), 'node_modules');
  if (!existsSync(main)) throw new Error(`no node_modules in ${root} and none to link at ${main}; run npm ci here first`);
  if (isWindows) {
    await execFileAsync('cmd.exe', ['/d', '/c', 'mklink', '/J', nodeModulesPath, main.replaceAll('/', '\\')]);
  } else {
    await symlink(main, nodeModulesPath, 'dir');
  }
  process.stdout.write(`node_modules: linked ${nodeModulesPath} -> ${main}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KNOWN_CASES = new Set([
  'guard-lifetime', 'old-spawn-no-guard', 'real-host-sigkill', 'sweep-deleted-worktree',
  'sweep-adopted-orphan', 'sweep-refuses-production', 'sweep-refuses-production-env', 'sweep-relative-parent',
  'sweep-browser-marker', 'sweep-browser-orphan', 'sweep-stale-dirs', 'sweep-dir-prefixes',
]);
// Parse (and validate) the case BEFORE creating the sandbox: `--case <typo>` must fail without
// leaving an empty temp dir behind. (`parseArgs` is a hoisted function declaration, so calling it
// here is fine -- but `KNOWN_CASES` above it must be a plain top-level const, not declared further
// down: a `const` below this line would be in its temporal dead zone and throw.)
const options = parseArgs(process.argv.slice(2));
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1b-hygiene-'));
const createdPids = new Set();

// ── 反证臂的声明与派发 ─────────────────────────────────────────────────────────────────────────
// 为什么副本要带**整份门**（而不是只覆盖 sweep 的入口）：本门按 `import.meta.url` 推出 `root`
// （= 副本根）⇒ `sweepEntry`（= `<副本>/bin/sandbox-sweep.mjs`）自然指到那份被改过的 sweep ——
// **产品代码里不需要任何「给我指到别处」的接缝**（那种接缝本身就是假绿的入口）。副本必须建在
// **仓库根里面**：`.mjs` 是 ESM，`node_modules` 靠向上查找解析。
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').slice('--reverse-arm='.length) || null;
// 一个管道容量的实测值（本机 = 131072 = 2 × 64 KiB）：
// `node -e "process.stdout.write('x'.repeat(N)); process.exit(0)" | wc -c` ⇒ N ≤ 131072 时一个字节不少；
// N = 200000 / 1000000 时只到 131072，而真 sweep 走门的 `execFile` 时是 146176 ——「到多少」随读端
// 快慢变，所以臂的判据只能是「**到不齐**」，不是「恰好 131072」。
const PIPE_CAPACITY_BYTES = 131072;
// 夹具要把文档顶到这条线以上（留出余量），旧行为的伤害才一定发生。
const DOC_SIZE_MARGIN_BYTES = PIPE_CAPACITY_BYTES * 2;
const REVERSE_ARMS = {
  'exit-truncates-pipe': {
    // 接缝就是 `bin/sandbox-sweep.mjs` 出口那一行（`file:` 由 `bin/check-arm-seams.mjs` 机械核对）。
    expect: 'the orphan must at least be recognized by bin/sandbox-sweep.mjs',
    file: 'bin/sandbox-sweep.mjs',
    from: 'process.exitCode = exitCode;',
    to: 'process.exit(exitCode); // 反证臂 exit-truncates-pipe：旧行为 —— 管道上的输出会被掐掉',
  },
};
if (ARM !== null) await runReverseArm(ARM);

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function parseArgs(argv) {
  const options = { case: 'all' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--case') options.case = argv[index + 1];
    else if (argv[index].startsWith('--case=')) options.case = argv[index].slice('--case='.length);
  }
  // A typo used to select no case at all and still print RESULT PASS. Say so instead.
  if (options.case !== 'all' && !KNOWN_CASES.has(options.case)) {
    throw new Error(`unknown --case ${JSON.stringify(options.case)}; known: all | ${[...KNOWN_CASES].join(' | ')}`);
  }
  return options;
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

function killPid(pid, signal) {
  // Exact pid only, never a name or a glob (repo discipline).
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitGone(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

async function reserveHighPort() {
  for (let candidate = 44000 + Math.floor(Math.random() * 15000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321) continue;
    const available = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

// 看进程一律经过 `test/harness.mjs`（`listenerPid` / `processInfoOf` / `processTable`）——
// 平台分支只住那一个文件，本文件里不出现 `ss` 或 procfs 字面量（纪律见 `test/harness-contract.mjs`）。
// 下面两个薄封装只把 harness 的「读不到 ⇒ null」翻成本文件一直以来的「读不到 ⇒ ''/0」，
// 不含任何平台分叉。
const commandLineOf = async (pid) => ((await processInfoOf(pid))?.commandLine ?? '').trim();
const ppidOf = async (pid) => (await processInfoOf(pid))?.ppid ?? 0;

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function waitForFile(file, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readJson(file);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`${file} never appeared`);
}

// A pid existing is NOT the same as the process being up: node can be killed between
// fork() and finishing module resolution. The stand-in workers print a ready line, so wait
// for that instead of guessing a sleep.
async function waitForLogLine(file, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = await readFile(file, 'utf8').catch(() => '');
    if (pattern.test(text)) return text;
    await sleep(50);
  }
  throw new Error(`${file} never matched ${pattern}; log=\n${text}`);
}

async function runSweep(args, env = {}) {
  const result = await execFileAsync(process.execPath, [sweepEntry, ...args, '--json'], { encoding: 'utf8', cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } })
    .catch((error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
  const stdout = String(result.stdout);
  // The sweep pretty-prints its JSON, so take the outermost object by brace matching
  // (lines can be large; the log tail stays the last few lines for the failure message).
  const start = stdout.indexOf('{');
  let parsed = null;
  if (start !== -1) {
    for (let end = stdout.lastIndexOf('}'); end > start; end = stdout.lastIndexOf('}', end - 1)) {
      try { parsed = JSON.parse(stdout.slice(start, end + 1)); break; } catch {}
    }
  }
  const meaningful = stdout.split('\n').filter((line) => line.trim() && !/^[\s{}\[\]"}]*$/.test(line)).slice(-3);
  const summary = meaningful.join(' | ') || stdout.trim().split('\n').slice(-2).join(' | ');
  // `json === null` 有两种**截然不同**的意思：「sweep 说没有孤儿」与「那份文档根本没到齐」。
  // 2026-09-27 之前本门在 `old-spawn-no-guard` 上一直红的就是第二种（根因见 `bin/sandbox-sweep.mjs`
  // 出口那段）：下游把 `orphans` 当空集 ⇒ 一条**真孤儿**看起来是「没被认出来」。
  // 这一条**只打印、不改判定**（判定仍旧是那句 `the orphan must at least be recognized …`）：
  // 把原始证据留在日志里，让「哪一层坏了」一眼可见。
  if (parsed === null && stdout.trim() !== '') {
    print('runSweep unreadable', {
      args: args.join(' '),
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(String(result.stderr ?? '')),
      stderrTail: String(result.stderr ?? '').slice(-300),
      head: stdout.slice(0, 60),
      tail: stdout.slice(-60),
    });
  }
  return { json: parsed, stdout, stderr: String(result.stderr), summary };
}

// ── 反证臂的小工具 + 臂本体（派发在文件上半部分，紧挨着 `createdPids`）──────────────────────────
/** 拿**管道**读某一份 sweep 的 `--json`：量它到了几个字节，并说它能不能整份解析出来。 */
async function sweepOverPipe(sweepFile) {
  const reply = await execFileAsync(process.execPath, [sweepFile, '--dry-run', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
    .catch((error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
  const stdout = String(reply.stdout ?? '');
  let parseable = false;
  try { JSON.parse(stdout); parseable = true; } catch {}
  return { bytes: Buffer.byteLength(stdout), parseable };
}

/**
 * 臂的「确定性」夹具。
 * 旧行为 `process.exit(exitCode)` 的伤害是**有前提**的：那份文档得大到管道装不下（一处实测：
 * ≤ 131072 B 一个字节不少，200000 B 的文档只到 131072 ~ 146176 B）。安静机器上 sweep 那份 JSON
 * 可能只有几 KB ⇒ 旧行为**红不起来** ⇒ 臂就成了「看机器忙不忙」的摆设。所以臂自己造一格「大」：
 * 起**一个**便宜的、形状像「临时目录下的浏览器 profile 树」的进程（命令行里带
 * `--user-data-dir=<tmpdir>/…`，这正是 `bin/sandbox-sweep.mjs` 认浏览器树的唯一标记），
 * 命令行上挂八段 64 KiB 的填充（≥ 512 KiB）—— sweep 会把它的 cmdline 原样写进报告（`protected`
 * 或 `browserTrees[].rootRecord`），那份文档因此**必然**大过 `DOC_SIZE_MARGIN_BYTES`。
 * 收尾按**精确 pid**（本门整条纪律就是「按 pid，绝不 pkill / 模式匹配」）。
 */
async function spawnDocumentBloat(dir) {
  const profileDir = path.join(dir, 'chromium');
  await mkdir(profileDir, { recursive: true });
  const filler = 'B'.repeat(64 * 1024);
  // ⚠️ `--` 不能省：`node -e <code> --user-data-dir=…` 会被 node 自己当成一个**未知选项**
  //    （`bad option: --user-data-dir=…`，进程当场退，夹具静默失效）。`--` 之后才是脚本参数，
  //    而进程命令行的**原文**（procfs 里那条）仍然逐字带着那个标记（sweep 就是在**文本**上认它的）。
  return spawn(process.execPath, [
    '-e', 'setInterval(() => {}, 1000);',
    '--',
    `--user-data-dir=${profileDir}`,
    ...Array.from({ length: 8 }, (_, index) => `filler${index}:${filler}`),
  ], { stdio: 'ignore' });
}

/** 拿**副本里的真门**跑本臂盯的那一条 case（`old-spawn-no-guard`）。 */
async function runGateCopy(gateFile) {
  let exitCode = 0;
  let output = '';
  try {
    const reply = await execFileAsync(process.execPath, [gateFile, '--case', 'old-spawn-no-guard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 });
    output = `${reply.stdout}\n${reply.stderr}`;
  } catch (error) {
    exitCode = typeof error.code === 'number' ? error.code : 1;
    output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  }
  return { exitCode, output };
}

async function runReverseArm(name) {
  const arm = REVERSE_ARMS[name];
  if (!arm) {
    process.stdout.write(`✗ 未知的反证臂：${JSON.stringify(name)}（认识的：${Object.keys(REVERSE_ARMS).join(', ')}）\n`);
    process.exit(2);
  }
  const copyRoot = path.join(root, `.sopho-sandhyg-sandbox-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
  const gateName = path.basename(fileURLToPath(import.meta.url));
  const copyGate = path.join(copyRoot, 'test', gateName);
  const copySweep = path.join(copyRoot, 'bin', 'sandbox-sweep.mjs');
  const problems = [];
  let bloat = null;
  let beforeProbe = null;
  let afterProbe = null;
  let control = null;
  let mutation = null;
  let mutated = null;
  let failure = null;
  try {
    // 只拷这一臂真正用到的文件（整棵 test/ 有 6 MB，没必要）：门本体 + harness + 守卫 + fixtures
    // + sweep。副本里**一个字节都不改**，改的只有第 ③ 步那一行。
    await mkdir(path.join(copyRoot, 'test'), { recursive: true });
    await mkdir(path.join(copyRoot, 'bin'), { recursive: true });
    await cp(fileURLToPath(import.meta.url), copyGate);
    await cp(path.join(testDir, 'harness.mjs'), path.join(copyRoot, 'test', 'harness.mjs'));
    await cp(path.join(testDir, 'sandbox-guard.mjs'), path.join(copyRoot, 'test', 'sandbox-guard.mjs'));
    await cp(path.join(testDir, 'fixtures'), path.join(copyRoot, 'test', 'fixtures'), { recursive: true });
    await cp(sweepEntry, copySweep);

    bloat = await spawnDocumentBloat(path.join(sandbox, 'doc-bloat'));
    createdPids.add(bloat.pid);

    // ① 前提：**没被改过**的那份 sweep，它的文档走管道必须**整份到齐**、且**大到装不进管道**
    //    （否则旧行为的伤害根本不会发生，整条臂就是假的）。
    beforeProbe = await sweepOverPipe(copySweep);
    if (!beforeProbe.parseable || beforeProbe.bytes <= DOC_SIZE_MARGIN_BYTES) {
      throw new Error(`反证臂的前提不成立：未改动的 sweep 走管道到了 ${beforeProbe.bytes} B（parseable=${beforeProbe.parseable}）—— 必须 > ${DOC_SIZE_MARGIN_BYTES} B 且整份可解析，才谈得上「旧行为会丢字节」（确定性夹具失效了？）`);
    }

    // ② 控制臂（**期望绿**）：副本一个字节没改 ⇒ 后面的红不是「副本/入口」造成的。
    control = await runGateCopy(copyGate);
    if (control.exitCode !== 0) throw new Error(`控制臂就红了（退出码 ${control.exitCode}）：副本自己有问题，红不能再归因于这次变异\n${control.output.slice(-1500)}`);

    // ③ 变异：把产品改回旧行为，并**读回来核**它真的落地了（「变异没落地却把空跑当证据」是本仓踩过的坑）。
    const before = await readFile(copySweep, 'utf8');
    if (!before.includes(arm.from)) throw new Error(`反证臂 ${name} 的改写没命中：副本 bin/sandbox-sweep.mjs 里找不到 ${JSON.stringify(arm.from)}（接缝形状变了？）`);
    await writeFile(copySweep, before.replace(arm.from, arm.to), 'utf8');
    const after = await readFile(copySweep, 'utf8');
    mutation = { file: copySweep, from: arm.from, to: arm.to, landed: after.includes(arm.to) && !after.includes(arm.from), bytesBefore: before.length, bytesAfter: after.length };
    print('reverse-arm mutation', mutation);
    if (!mutation.landed) throw new Error(`反证臂 ${name} 的变异**没落地**（读回副本核对不通过）`);

    // ④ 机制的直接证据（确定性，不经过门）：同一份文档走管道，现在**到不齐**了 ——
    //    「到几个字节」随读端快慢变（实测 131072 / 146176），所以判据是「解析不出来 ＋
    //    到的比整份少」，不是某个固定数字。
    afterProbe = await sweepOverPipe(copySweep);
    if (afterProbe.parseable || afterProbe.bytes >= beforeProbe.bytes) {
      throw new Error(`反证臂的机制没复现：改回旧行为后，管道上到了 ${afterProbe.bytes} B（parseable=${afterProbe.parseable}），整份是 ${beforeProbe.bytes} B —— 预期「解析不出来且到的比整份少」`);
    }

    // ⑤ 红半：拿**副本里的真门**打它。
    mutated = await runGateCopy(copyGate);
  } catch (error) {
    failure = error;
  } finally {
    if (bloat !== null) {
      killPid(bloat.pid, 'SIGTERM');
      if (!(await waitGone(bloat.pid, 6000))) { killPid(bloat.pid, 'SIGKILL'); await waitGone(bloat.pid, 3000); }
      if (alive(bloat.pid)) problems.push(`确定性夹具进程 pid=${bloat.pid} 没收掉`);
    }
    try { await rm(copyRoot, { recursive: true, force: true }); } catch (error) { problems.push(`rm ${copyRoot} 失败：${error.message}`); }
    if (existsSync(copyRoot)) problems.push(`反证臂副本没删干净：${copyRoot}`);
    // 反证臂这条路不走文件末尾那个 `finally`（它属于 case 派发），本门自己的沙箱在这里收。
    try { await rm(sandbox, { recursive: true, force: true }); } catch (error) { problems.push(`rm 本门沙箱 ${sandbox} 失败：${error.message}`); }
  }

  process.stdout.write(`\n──── 反证臂 ${name}：预期红在 ${JSON.stringify(arm.expect)} ────\n`);
  let ok = true;
  if (failure !== null) {
    ok = false;
    process.stdout.write(`✗ 反证臂 ${name} 没跑完：${failure.message}\n`);
  } else {
    process.stdout.write(`✓ 前提：未改动的 sweep 走管道 ${beforeProbe.bytes} B 全到齐且可解析（管道容量 ${PIPE_CAPACITY_BYTES} B · 夹具余量线 ${DOC_SIZE_MARGIN_BYTES} B）\n`);
    process.stdout.write(`✓ 控制臂（副本一个字节没改）：门退出码 0 —— 副本本身是绿的，红不能归因于「副本/入口」\n`);
    process.stdout.write(`✓ 变异落地：${JSON.stringify(arm.from)} → ${JSON.stringify(arm.to)}（文件 ${mutation.bytesBefore} → ${mutation.bytesAfter} B，读回副本核对通过）\n`);
    process.stdout.write(`✓ 机制的直接证据：同一份文档改回旧行为后走管道只到了 ${afterProbe.bytes} / ${beforeProbe.bytes} B（被静默掐掉 ${beforeProbe.bytes - afterProbe.bytes} B），JSON 解析不出来\n`);
    const redLine = mutated.output.split('\n').find((line) => line.includes(arm.expect)) ?? null;
    if (mutated.exitCode === 0) {
      ok = false;
      process.stdout.write(`✗ 反证臂是假的：把这一行改回旧行为，门居然还是绿的（退出码 0）\n`);
    } else if (redLine === null) {
      ok = false;
      process.stdout.write(`✗ 反证臂红是红了（退出码 ${mutated.exitCode}），但**没红在预期那条**上：${JSON.stringify(arm.expect)}\n`);
    } else if (!/AssertionError|ERR_ASSERTION/.test(mutated.output)) {
      ok = false;
      process.stdout.write('✗ 反证臂是崩不是红：输出里没有 AssertionError（「臂崩 ≠ 臂红」）\n');
    } else {
      process.stdout.write(`✓ 反证臂红到位（退出码 ${mutated.exitCode}）—— 这是**期望**的结果，不是缺陷\n  红的那一行：${redLine}\n`);
    }
    process.stdout.write(`  门输出（末 2000 字）：\n${mutated.output.slice(-2000)}\n`);
  }
  for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
  process.exit(ok && problems.length === 0 ? 0 : 1);
}

function pidSet(records) {
  return new Set((records ?? []).map((record) => record.pid));
}

async function cleanupByPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  createdPids.add(pid);
  if (!alive(pid)) return;
  killPid(pid, 'SIGTERM');
  if (!(await waitGone(pid, 6000))) {
    killPid(pid, 'SIGKILL');
    await waitGone(pid, 3000);
  }
}

// ---------------------------------------------------------------------------
// 第一层 + 第二层：守卫。在真机上造出"harness 被 SIGKILL"。
// ---------------------------------------------------------------------------

/** Runs a mini-harness, waits for its facts, hands them to `body`, then reaps everything. */
async function withMiniHarness(name, { mode, entry, env, port, lifetimeMs, childCwd, onReady }) {
  const dir = path.join(sandbox, name);
  await mkdir(dir, { recursive: true });
  const factsPath = path.join(dir, 'facts.json');
  const logPath = path.join(dir, 'sandbox.log');
  const args = [miniHarnessEntry, '--mode', mode, '--entry', entry, '--facts', factsPath, '--log', logPath, '--label', name, '--cwd', childCwd ?? root];
  if (mode === 'guard') args.push('--guard', guardEntry);
  if (lifetimeMs) args.push('--lifetime-ms', String(lifetimeMs));
  const logHandle = await open(path.join(dir, 'harness.log'), 'a');
  const harness = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  createdPids.add(harness.pid);
  const facts = await waitForFile(factsPath);
  createdPids.add(facts.sandboxPid);
  if (facts.guardPid) createdPids.add(facts.guardPid);
  facts.harnessLog = path.join(dir, 'harness.log');
  facts.sandboxLog = logPath;
  facts.factsFile = factsPath;
  facts.guardRecord = `${factsPath}.guard.json`;
  try {
    return await onReady({ harness, facts, dir, entry, port });
  } finally {
    await logHandle.close().catch(() => {});
    for (const pid of [facts.guardPid, facts.sandboxPid, facts.harnessPid].filter(Boolean).reverse()) await cleanupByPid(pid);
  }
}

async function caseGuardLifetime() {
  // No harness death involved: the point is that nobody ever asks, and the cap fires.
  const dir = path.join(sandbox, 'lifetime');
  await mkdir(dir, { recursive: true });
  const recordPath = path.join(dir, 'guard.json');
  const factsPath = path.join(dir, 'stand-in.json');
  const logHandle = await open(path.join(dir, 'sandbox.log'), 'a');
  const lifetimeMs = 4000;
  const guard = spawn(process.execPath, [
    guardEntry,
    '--entry', standInHost,
    '--label', 'lifetime',
    '--lifetime-ms', String(lifetimeMs),
    '--watch-stdin',
    '--record', recordPath,
  ], {
    cwd: root,
    env: { ...process.env, SANDBOX_STAND_IN_CHILD: standInWorker, SANDBOX_STAND_IN_FACTS: factsPath },
    stdio: ['pipe', logHandle.fd, logHandle.fd, 'ipc'],
  });
  createdPids.add(guard.pid);
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('guard never reported sandbox-start')), 20_000);
    guard.on('message', (message) => { if (message?.type === 'sandbox-start') { clearTimeout(timer); resolve(message); } });
    guard.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`guard exited early code=${code} signal=${signal}`)); });
  });
  createdPids.add(started.pid);
  const standIn = await waitForFile(factsPath);
  createdPids.add(standIn.childPid);
  assert.equal(started.pid, standIn.hostPid, 'guard must report the sandbox root pid it actually spawned');
  assert.ok(alive(standIn.hostPid) && alive(standIn.childPid), 'both the stand-in root and its child must be running');

  const exit = await Promise.race([
    new Promise((resolve) => guard.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(lifetimeMs + 15_000).then(() => null),
  ]);
  assert.ok(exit, `guard must exit on its own after the ${lifetimeMs}ms cap`);
  const record = await readJson(recordPath);
  const log = await readFile(path.join(dir, 'sandbox.log'), 'utf8');
  const gone = { host: await waitGone(standIn.hostPid, 8000), child: await waitGone(standIn.childPid, 8000) };
  print('guard-lifetime', {
    lifetimeMs,
    guardExit: exit,
    reason: record?.reason,
    survivors: record?.survivors,
    hostGone: gone.host,
    childGone: gone.child,
    capEvidence: log.split('\n').filter((line) => line.includes('tearing down') || line.includes('reason=lifetime')).slice(-3),
  });
  assert.equal(record?.reason, 'lifetime', 'the record must name the lifetime cap as the reason');
  assert.ok(gone.host, 'the stand-in root must be gone');
  assert.ok(gone.child, "the root's child must be gone too (the cap kills the tree, not just the root)");
  assert.match(log, /reason=lifetime/, 'the sandbox log must carry the reason');
  await logHandle.close().catch(() => {});
  return { lifetimeMs, reason: record.reason };
}

async function caseRealHostSigkill() {
  // The end-to-end one: a REAL server/base.mjs (with its REAL forked generation worker)
  // under the guard; the harness is SIGKILLed.
  const port = await reserveHighPort();
  const home = path.join(sandbox, 'real-host', 'home');
  const workspace = path.join(home, 'workspace');
  await mkdir(workspace, { recursive: true });
  const env = {
    HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home,
    PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'),
    PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(port),
    SOPHO_DEFAULT_CWD: workspace, SOPHO_NO_TOOLS: '1',
  };
  return withMiniHarness('real-host', {
    mode: 'guard',
    entry: path.join(root, 'server', 'base.mjs'),
    env,
    port,
    onReady: async ({ harness, facts }) => {
      const host = await pollHost(port);
      const hostPid = host.pid;
      const workerPid = host.currentWorkerPid;
      createdPids.add(hostPid);
      createdPids.add(workerPid);
      const listener = await listenerPid(port);
      print('real-host-sigkill before', { harnessPid: facts.harnessPid, guardPid: facts.guardPid, hostPid, workerPid, listener, generationId: host.currentGenerationId });
      assert.equal(facts.sandboxPid, hostPid, 'the pid the guard reported must be the one that answers /host');
      assert.equal(listener, hostPid, 'the port owner must be the host we started');
      assert.ok(alive(hostPid) && alive(workerPid), 'host and worker must both be alive');

      // False-positive guard: a LIVE sandbox must never be reported as an orphan.
      const sweepBefore = await runSweep(['--dry-run', '--min-age-seconds', '1', '--max-age-seconds', '1']);
      assert.ok(!pidSet(sweepBefore.json?.orphans).has(hostPid), `a live sandbox host must not be listed as an orphan (${sweepBefore.summary})`);
      assert.ok(!pidSet(sweepBefore.json?.orphans).has(workerPid), `a live sandbox worker must not be listed as an orphan (${sweepBefore.summary})`);
      print('real-host-sigkill live-sweep', { orphans: [...pidSet(sweepBefore.json?.orphans)], note: 'live sandbox is not an orphan' });

      print('real-host-sigkill action', `SIGKILL harness pid ${facts.harnessPid} (the guard must survive and reap)`);
      const startedReap = Date.now();
      killPid(facts.harnessPid, 'SIGKILL');
      // 60 s, not 25: on a loaded machine (another suite doing 200 reloads) taskkill + the
      // port check took >25 s once and produced a false failure. Measured on an idle machine:
      // ~14 s on Windows, ~0.3 s on Linux. Either way this is a bound on a leak that used to
      // last days.
      const deadline = Date.now() + 60_000;
      let state;
      while (Date.now() < deadline) {
        state = { host: alive(hostPid), worker: alive(workerPid), port: await listenerPid(port) !== 0, guard: facts.guardPid ? alive(facts.guardPid) : null };
        if (!state.host && !state.worker && !state.port && !state.guard) break;
        await sleep(250);
      }
      const record = await readJson(facts.guardRecord);
      const log = await readFile(facts.sandboxLog, 'utf8').catch(() => '');
      print('real-host-sigkill after', { ...state, reason: record?.reason ?? null, elapsedMs: Date.now() - startedReap });
      print('real-host-sigkill log tail', log.trim().split('\n').slice(-6));
      assert.ok(!state.host, `host pid ${hostPid} must die with the harness`);
      assert.ok(!state.worker, `worker pid ${workerPid} must die with the harness`);
      assert.ok(!state.port, `port ${port} must become free`);
      assert.ok(facts.guardPid && !state.guard, 'the guard must exit once it has torn the tree down');
      assert.match(log, /tearing down: reason=parent-(disconnect|eof)/, 'the log must name parent-disconnect/parent-eof as the reason');
      return { hostPid, workerPid, port, reason: record.reason };
    },
  });
}

async function pollHost(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await new Promise((resolve) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/host' }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => { try { resolve({ statusCode: response.statusCode, value: JSON.parse(text) }); } catch { resolve(null); } });
      });
      request.once('error', () => resolve(null));
      request.end();
    });
    // "listening" is not "ready": wait until the generation worker has really reported in,
    // or a just-restarted worker would be captured on its way out.
    if (last?.statusCode === 200 && Number(last.value.currentWorkerPid) > 0 && last.value.workerCount === 1) return last.value;
    await sleep(50);
  }
  throw new Error(`/host never answered ready on ${port}; last=${JSON.stringify(last)}`);
}

async function caseOldSpawnNoGuard() {
  // The defect itself, mechanically: the pre-fix launch style, no guard at all.
  // On POSIX the tree survives its harness (this is the red state); on Windows libuv's job
  // object hides it, and we say so instead of pretending the arm passed.
  const port = await reserveHighPort();
  const dir = path.join(sandbox, 'legacy-wt');
  const serverDir = path.join(dir, 'server');
  await mkdir(serverDir, { recursive: true });
  await cp(standInHost, path.join(serverDir, 'base.mjs'));
  await cp(standInWorker, path.join(serverDir, 'worker.mjs'));
  const factsPath = path.join(dir, 'stand-in.json');
  const env = {
    HOME: path.join(dir, 'home'), ASSIST_HOME: path.join(dir, 'home'), SOPHO_AGENT_DIR: path.join(dir, 'home'),
    PI_CODING_AGENT_DIR: path.join(dir, 'home'), PI_OFFLINE: '1',
    SOPHO_PORT: String(port),
    SANDBOX_STAND_IN_CHILD: path.join(serverDir, 'worker.mjs'),
    SANDBOX_STAND_IN_FACTS: factsPath,
  };
  return withMiniHarness('old-spawn', {
    mode: 'legacy',
    entry: path.join(serverDir, 'base.mjs'),
    env,
    port,
    onReady: async ({ facts }) => {
      const standIn = await waitForFile(factsPath);
      createdPids.add(standIn.hostPid);
      createdPids.add(standIn.childPid);
      assert.equal(standIn.hostPid, facts.sandboxPid, 'the legacy arm must run the copied server/base.mjs');
      // The child must have FINISHED STARTING before we judge anything: a pid is not a
      // loaded process.
      await waitForLogLine(facts.sandboxLog, /stand-in-worker/);
      const hostPpidBefore = await ppidOf(standIn.hostPid);
      print('old-spawn-no-guard before', { harnessPid: facts.harnessPid, hostPid: standIn.hostPid, childPid: standIn.childPid, hostPpid: hostPpidBefore });
      assert.equal(hostPpidBefore, facts.harnessPid, 'the host is a plain child of the harness (no guard in between)');

      killPid(facts.harnessPid, 'SIGKILL');
      const samples = [];
      for (const at of [1000, 3000, 6000]) {
        await sleep(at - (samples.at(-1)?.at ?? 0));
        samples.push({ at, host: alive(standIn.hostPid), child: alive(standIn.childPid) });
      }
      const survived = samples.at(-1).host || samples.at(-1).child;
      const hostPpidAfter = await ppidOf(standIn.hostPid);
      const reasons = survived ? (await runSweep(['--dry-run', '--min-age-seconds', '1', '--max-age-seconds', '1'])).json : null;
      print('old-spawn-no-guard after', {
        harnessPid: facts.harnessPid,
        samples,
        survived,
        hostPpidAfter,
        hostCmdline: (await commandLineOf(standIn.hostPid)).slice(0, 200),
        sweepVerdict: reasons ? { orphans: [...pidSet(reasons.orphans)], suspects: (reasons.suspects ?? []).map((r) => ({ pid: r.pid, reasons: r.reasons })) } : null,
      });
      if (isWindows) {
        print('old-spawn-no-guard note', "Windows: libuv puts node-spawned children in a job object owned by the spawning process, so the tree dies with the harness -- the defect is invisible here. This arm is only conclusive on POSIX (run it in WSL).");
      } else {
        assert.ok(survived, 'POSIX: a plain child must survive a SIGKILLed harness -- that is the defect this fix exists for');
        const flagged = pidSet(reasons?.orphans).has(standIn.hostPid) || (reasons?.suspects ?? []).some((r) => r.pid === standIn.hostPid);
        assert.ok(flagged, 'the orphan must at least be recognized by bin/sandbox-sweep.mjs');
      }
      return { survived, hostPpidAfter };
    },
  });
}

async function caseSweepDeletedWorktree() {
  // 2026-09-19 的收紧：**worktree 被删 ≠ 里面是孤儿**。这一条形状（父 harness 仍活着、
  // 它的 worktree 却被删掉）就是当天的误杀现场：另一条子会话的 generation worker
  // `pid 102969` 被 `bin/sandbox-sweep.mjs --apply` 杀掉，而它的宿主（它的父）`pid 102957`
  // 一直活着，触发的是 `entry-dir-missing`。原始日志 /tmp/refetch-logs/sandbox-hygiene.log：
  //   `sweep-deleted-worktree apply: {"terminated":[102969,219747], … entry:"…/child-a2ee47ab/server/worker.mjs"}`
  //   紧接着本门自己的安全断言就红了：`the sweep terminated pids this gate did not create: 102969`。
  // 所以这一条现在断言**相反**的结论：父链还活着 ⇒ 只报告不杀（输出里带父 pid + cmdline）。
  // 真孤儿那一半（必须仍能杀）在 `sweep-adopted-orphan`。
  const port = await reserveHighPort();
  const dir = path.join(sandbox, 'doomed-wt');
  const serverDir = path.join(dir, 'server');
  await mkdir(serverDir, { recursive: true });
  await cp(standInHost, path.join(serverDir, 'base.mjs'));
  await cp(standInWorker, path.join(serverDir, 'worker.mjs'));
  const factsPath = path.join(sandbox, 'doomed-stand-in.json');
  const env = {
    HOME: path.join(dir, 'home'), ASSIST_HOME: path.join(dir, 'home'), SOPHO_AGENT_DIR: path.join(dir, 'home'),
    PI_CODING_AGENT_DIR: path.join(dir, 'home'), PI_OFFLINE: '1',
    SOPHO_PORT: String(port),
    SANDBOX_STAND_IN_CHILD: path.join(serverDir, 'worker.mjs'),
    SANDBOX_STAND_IN_FACTS: factsPath,
  };
  return withMiniHarness('doomed', {
    mode: 'legacy',
    entry: path.join(serverDir, 'base.mjs'),
    env,
    port,
    onReady: async ({ facts }) => {
      const standIn = await waitForFile(factsPath);
      createdPids.add(standIn.hostPid);
      createdPids.add(standIn.childPid);
      assert.equal(standIn.hostPid, facts.sandboxPid);
      await waitForLogLine(facts.sandboxLog, /stand-in-worker/);
      // Delete the "worktree" while the tree still runs == the production incident. Doing
      // this before the child finished loading its entry would just make it die of
      // MODULE_NOT_FOUND, which is a different (and much less interesting) failure mode.
      const beforeRm = { host: alive(standIn.hostPid), child: alive(standIn.childPid) };
      let rmError = null;
      await rm(dir, { recursive: true, force: true }).catch((error) => { rmError = error.message; });
      const afterRm = { host: alive(standIn.hostPid), child: alive(standIn.childPid) };
      const harnessAlive = alive(facts.harnessPid);
      const hostPpid = await ppidOf(standIn.hostPid);
      const childPpid = await ppidOf(standIn.childPid);
      print('sweep-deleted-worktree rm', {
        dir, beforeRm, afterRm, dirStillExists: existsSync(dir), rmError,
        harnessPid: facts.harnessPid, harnessAlive, hostPpid, childPpid,
      });
      assert.ok(!existsSync(dir), 'the worktree must really be gone');
      assert.ok(afterRm.host && afterRm.child, `and the tree must still be running (before=${JSON.stringify(beforeRm)} after=${JSON.stringify(afterRm)} rmError=${rmError})`);
      assert.ok(harnessAlive, 'the parent harness must still be alive -- that is the whole point of this arm');
      assert.equal(hostPpid, facts.harnessPid, 'the host is a plain child of the live harness (no guard in between)');

      const dry = await runSweep(['--dry-run', '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const orphanPids = pidSet(dry.json?.orphans);
      const protectedByPid = new Map((dry.json?.protected ?? []).map((record) => [record.pid, record.protected]));
      const refusedByPid = new Map((dry.json?.refusedLiveParent ?? []).map((record) => [record.pid, record]));
      const standInLog = await readFile(facts.sandboxLog, 'utf8').catch(() => '');
      print('sweep-deleted-worktree dry-run', {
        hostPid: standIn.hostPid, childPid: standIn.childPid, harnessPid: facts.harnessPid, harnessAlive,
        orphans: [...orphanPids],
        wouldKill: dry.json?.wouldKill,
        hostRefusal: refusedByPid.get(standIn.hostPid) ?? null,
        childRefusal: refusedByPid.get(standIn.childPid) ?? null,
        hostProtected: protectedByPid.get(standIn.hostPid) ?? null,
        childProtected: protectedByPid.get(standIn.childPid) ?? null,
        summary: dry.summary,
      });
      const why = `(host alive=${alive(standIn.hostPid)} child alive=${alive(standIn.childPid)} harness alive=${harnessAlive}; ${dry.summary}; stand-in log=${JSON.stringify(standInLog.trim().slice(-300))})`;
      // The 2026-09-19 property: a tree whose parent chain is alive is IN USE and is never an orphan.
      assert.ok(!orphanPids.has(standIn.hostPid), `a sandbox whose parent is alive must never be an orphan, deleted worktree or not ${why}`);
      assert.ok(!orphanPids.has(standIn.childPid), `neither may its worker ${why}`);
      assert.ok((dry.json?.wouldKill ?? []).every((record) => record.pid !== standIn.hostPid && record.pid !== standIn.childPid), 'the dry-run would-kill list must not name them either');
      assert.ok(dry.json.orphans.every((record) => record.pid !== process.pid), 'the sweep must not list itself');
      // 明确拒绝（这是本次修的核心可见面）：必须写清哪个 pid 属于哪个活着的父。
      assert.ok(refusedByPid.has(standIn.hostPid) && refusedByPid.has(standIn.childPid), `both pids must be reported as refused-with-a-live-parent ${why}`);
      assert.equal(refusedByPid.get(standIn.hostPid).parentPid, facts.harnessPid, 'the host must name the live harness as its parent');
      assert.equal(refusedByPid.get(standIn.childPid).parentPid, standIn.hostPid, 'the worker must name the live host as its parent');
      for (const pid of [standIn.hostPid, standIn.childPid]) {
        assert.ok(refusedByPid.get(pid).reasons.includes('entry-dir-missing-parent-alive'), `the refusal must name the deleted entry dir as the signal it refused to act on (pid ${pid})`);
        assert.match(refusedByPid.get(pid).notes.join('\n'), /SKIP: this pid belongs to a live parent chain/, 'the refusal must be printed with its reason and its parent');
      }

      // 真杀路径：连最响的 --kill-suspects 也不许碰它们。
      // `--only-pid` 把本门这颗子弹限制在"本门自己造的 pid"上：本工具是**整机**扫描，
      // 这台机子上还有别的会话的沙箱（平行子会话很多）。
      const scope = ['--only-pid', [standIn.hostPid, standIn.childPid].join(',')];
      const applied = await runSweep(['--apply', ...scope, '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const escalated = await runSweep(['--apply', '--kill-suspects', ...scope, '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const actions = [...(applied.json?.actions ?? []), ...(escalated.json?.actions ?? [])];
      // `skipped` actions are other pids being left alone (out of --only-pid scope) -- not a kill.
      const killed = new Set(actions.filter((action) => action.action !== 'skipped').map((action) => action.pid));
      const stillAlive = { host: alive(standIn.hostPid), child: alive(standIn.childPid), harness: alive(facts.harnessPid) };
      print('sweep-deleted-worktree apply', {
        killed: [...killed],
        actions: actions.map((action) => ({ pid: action.pid, action: action.action, verdict: action.verdict, detail: action.detail ?? null })),
        stillAlive,
      });
      assert.equal(killed.size, 0, 'a live-parent tree must not be killed, not even under --apply --kill-suspects');
      assert.ok(stillAlive.host && stillAlive.child && stillAlive.harness, 'host, worker and their parent harness must all still be alive');
      return { hostPid: standIn.hostPid, childPid: standIn.childPid, hostPpid, killed: [...killed], stillAlive };
    },
  });
}

async function caseSweepAdoptedOrphan() {
  // 反向自检：2026-09-19 的收紧**不得削弱**它原本要防的事。2026-09-18 夜那 37 个孤儿
  // （3.8 GiB RSS，把生产实例连同整机拖死）正是这条形状：worktree 已被删、里面的
  // base+worker 早已被 init / `systemd --user` 收养（原父进程 = 那个被 SIGKILL 的 harness
  // 早就不在了），却还活着一天多。这里机械复现同一形状，与上一条 case 只差一个变量：
  // **父链在不在**。父链真的没了 ⇒ 门必须仍能认成孤儿、并按精确 pid 清掉。
  const port = await reserveHighPort();
  const dir = path.join(sandbox, 'adopted-wt');
  const serverDir = path.join(dir, 'server');
  await mkdir(serverDir, { recursive: true });
  await cp(standInHost, path.join(serverDir, 'base.mjs'));
  await cp(standInWorker, path.join(serverDir, 'worker.mjs'));
  const factsPath = path.join(sandbox, 'adopted-stand-in.json');
  const env = {
    HOME: path.join(dir, 'home'), ASSIST_HOME: path.join(dir, 'home'), SOPHO_AGENT_DIR: path.join(dir, 'home'),
    PI_CODING_AGENT_DIR: path.join(dir, 'home'), PI_OFFLINE: '1',
    SOPHO_PORT: String(port),
    SANDBOX_STAND_IN_CHILD: path.join(serverDir, 'worker.mjs'),
    SANDBOX_STAND_IN_FACTS: factsPath,
  };
  return withMiniHarness('adopted', {
    mode: 'legacy',
    entry: path.join(serverDir, 'base.mjs'),
    env,
    port,
    onReady: async ({ facts }) => {
      const standIn = await waitForFile(factsPath);
      createdPids.add(standIn.hostPid);
      createdPids.add(standIn.childPid);
      assert.equal(standIn.hostPid, facts.sandboxPid);
      await waitForLogLine(facts.sandboxLog, /stand-in-worker/);
      await rm(dir, { recursive: true, force: true });
      assert.ok(!existsSync(dir), 'the worktree must really be gone');
      // 真孤儿的制造：把 harness SIGKILL 掉（这一步就是 POSIX 上"修前"的形状）。
      killPid(facts.harnessPid, 'SIGKILL');
      const harnessGone = await waitGone(facts.harnessPid, 8000);
      // 等内核真的完成再收养：ppid 还指着那个死了的 harness 时，门（正确地）只会拒杀。
      let hostPpid = await ppidOf(standIn.hostPid);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && hostPpid === facts.harnessPid) { await sleep(100); hostPpid = await ppidOf(standIn.hostPid); }
      const parentCmdline = hostPpid ? await commandLineOf(hostPpid) : '';
      const state = {
        harnessPid: facts.harnessPid, harnessGone, dirGone: !existsSync(dir),
        hostPid: standIn.hostPid, childPid: standIn.childPid, hostPpid,
        hostParentCmdline: parentCmdline.slice(0, 160),
        hostAlive: alive(standIn.hostPid), childAlive: alive(standIn.childPid),
      };
      print('sweep-adopted-orphan adoption', state);
      assert.ok(harnessGone, 'the harness must really be dead');
      if (isWindows) {
        print('sweep-adopted-orphan note', 'Windows: libuv puts node-spawned children in the job object of the spawning process, so the tree dies with its harness and this arm is vacuous here. It is conclusive on POSIX (run it under WSL).');
        return { ...state, platform: 'win32', vacuous: true };
      }
      assert.ok(state.hostAlive && state.childAlive, 'POSIX: the tree must outlive its SIGKILLed harness -- that is the defect this whole gate exists for');
      assert.notEqual(hostPpid, facts.harnessPid, 'the kernel must have re-parented the host off the dead harness');

      const dry = await runSweep(['--dry-run', '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const byPid = new Map((dry.json?.orphans ?? []).map((record) => [record.pid, record]));
      const refusedByPid = new Map((dry.json?.refusedLiveParent ?? []).map((record) => [record.pid, record]));
      print('sweep-adopted-orphan dry-run', {
        hostPid: standIn.hostPid, childPid: standIn.childPid, hostPpid,
        orphans: [...pidSet(dry.json?.orphans)], refusedLiveParent: [...refusedByPid.keys()],
        hostReasons: byPid.get(standIn.hostPid)?.reasons ?? null,
        wouldKill: dry.json?.wouldKill,
      });
      assert.ok(byPid.has(standIn.hostPid), `the adopted host must STILL be a decisive orphan (the tightening must not weaken this) ${dry.summary}`);
      assert.ok(byPid.get(standIn.hostPid).reasons.includes('entry-dir-missing'), 'entry-dir-missing stays decisive once the parent chain is gone');
      // 它的 worker 的父（宿主）还活着 ⇒ 只报告不杀：目标是宿主，宿主一死 worker 就跟着走。
      assert.ok(!byPid.has(standIn.childPid), 'the worker of a still-live host must be refused (parent-alive): the host is the target, not the worker');
      assert.ok(refusedByPid.has(standIn.childPid), 'and that refusal must be printed with its live parent');

      const onlyPid = [standIn.hostPid, standIn.childPid].join(',');
      const applied = await runSweep(['--apply', '--only-pid', onlyPid, '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const terminated = new Set((applied.json?.actions ?? []).filter((action) => action.action === 'terminated').map((action) => action.pid));
      let gone = { host: await waitGone(standIn.hostPid, 8000), child: await waitGone(standIn.childPid, 8000) };
      print('sweep-adopted-orphan apply', {
        terminated: [...terminated],
        actions: (applied.json?.actions ?? []).map((action) => ({ pid: action.pid, action: action.action, verdict: action.verdict, detail: action.detail ?? null })),
        gone,
      });
      assert.ok(terminated.has(standIn.hostPid), 'the sweep must terminate the adopted host itself (by exact pid), not leave it to something else');
      // The safety property that matters most: only pids this gate created. On this machine
      // the live production pair (7331/7321) is running, plus other sessions' sandboxes.
      const foreign = [...terminated].filter((pid) => !createdPids.has(pid));
      assert.equal(foreign.length, 0, `the sweep terminated pids this gate did not create: ${foreign.join(',')}`);
      if (!gone.child) {
        // 宿主被 TERM 掉而 worker 还没退 ⇒ 第二轮：现在 worker 也被收养了，门仍必须收掉它。
        const second = await runSweep(['--apply', '--only-pid', String(standIn.childPid), '--min-age-seconds', '1', '--max-age-seconds', '1']);
        gone = { host: gone.host, child: await waitGone(standIn.childPid, 8000) };
        print('sweep-adopted-orphan second sweep', {
          orphan: [...pidSet(second.json?.orphans)],
          actions: (second.json?.actions ?? []).map((action) => ({ pid: action.pid, action: action.action, detail: action.detail ?? null })),
          gone,
        });
      }
      assert.ok(gone.host, 'the adopted host must be gone');
      assert.ok(gone.child, 'the worker must be gone too (taken down with its host, or by a second sweep once it too had been adopted)');
      return { hostPid: standIn.hostPid, childPid: standIn.childPid, hostPpid, terminated: [...terminated], gone };
    },
  });
}

// Safety arm. What must NEVER be touched, in order of how load-bearing each rule is:
//   1. a live production instance actually LISTENING on 7331/7321 (portable, always checked
//      against real listeners -- this one is true on every platform);
//      ⚠️ 归属（2026-09-25）：那些 pid 是**别人的**（活的 arcsopho 实例）。本门的硬判据是
//      「sweep 自己拒了它（`protected` + 理由）且动作账里从来没它（`!touched`）」；
//      「它现在还活着」只**记录** —— 主人重启/停了生产实例不是本门的失败。
//   2. an entry that is not on a sandbox path (`.sopho-wt` or the OS temp dir);
//   3. an entry given as a RELATIVE path: it cannot even be located, so it is refused rather
//      than guessed at. (On this machine the live pair is launched exactly this way, which is
//      why the sweep reports them as `relative-entry`.)
//   4. POSIX only: the declared port / ASSIST_HOME read out of a process's environment
//      (`processEnvironment` in `test/harness.mjs`). Windows has no equivalent (that read
//      honestly returns null there), so those two rules simply cannot fire on Windows --
//      said out loud below rather than papered over.
async function caseSweepRefusesProduction() {
  const fakeProd = path.join(sandbox, 'fake-prod');
  const serverDir = path.join(fakeProd, 'server');
  await mkdir(serverDir, { recursive: true });
  await cp(standInHost, path.join(serverDir, 'base.mjs'));
  await cp(standInWorker, path.join(serverDir, 'worker.mjs'));
  const factsPath = path.join(sandbox, 'fake-prod-stand-in.json');
  const profileHome = path.join(fakeProd, 'home', '.pi', 'profiles', 'assistant');
  const env = {
    HOME: path.join(fakeProd, 'home'), ASSIST_HOME: profileHome, SOPHO_AGENT_DIR: path.join(fakeProd, 'home'),
    PI_CODING_AGENT_DIR: path.join(fakeProd, 'home'), PI_OFFLINE: '1',
    // 7331/7321 are the production ports and must be refused. Nothing binds them here: the
    // real instances are never contacted.
    SOPHO_PORT: '7331',
    SANDBOX_STAND_IN_CHILD: 'server/worker.mjs',
    SANDBOX_STAND_IN_FACTS: factsPath,
  };
  const liveProduction = [];
  for (const port of [7331, 7321]) {
    const pid = await listenerPid(port);
    if (pid) liveProduction.push({ port, pid });
  }
  return withMiniHarness('fake-prod', {
    mode: 'legacy',
    // Relative on purpose: `node server/base.mjs` with cwd = the fake prod dir.
    entry: 'server/base.mjs',
    childCwd: fakeProd,
    env,
    onReady: async ({ facts }) => {
      const standIn = await waitForFile(factsPath);
      createdPids.add(standIn.hostPid);
      createdPids.add(standIn.childPid);
      await waitForLogLine(facts.sandboxLog, /stand-in-worker/);
      const dry = await runSweep(['--dry-run', '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const orphanPids = pidSet(dry.json?.orphans);
      const protectedByPid = new Map((dry.json?.protected ?? []).map((record) => [record.pid, record.protected]));
      const liveReported = liveProduction.map(({ port, pid }) => ({ port, pid, protected: protectedByPid.get(pid) ?? null, isOrphan: orphanPids.has(pid) }));
      print('sweep-refuses-production dry-run', {
        platform: process.platform,
        relativeEntryControl: { pid: standIn.hostPid, protected: protectedByPid.get(standIn.hostPid) ?? null, isOrphan: orphanPids.has(standIn.hostPid) },
        liveProduction: liveReported,
        refused: [...protectedByPid.keys()],
        orphans: [...orphanPids],
      });
      assert.ok(!orphanPids.has(standIn.hostPid), 'a relative-entry control must never be listed as an orphan (it cannot even be located)');
      assert.equal(protectedByPid.get(standIn.hostPid), 'relative-entry', 'a relative entry must be refused as `relative-entry`');
      for (const record of liveReported) {
        assert.ok(!record.isOrphan, `the live production instance on port ${record.port} (pid ${record.pid}) must never be listed as an orphan`);
        assert.ok(record.protected, `the live production instance on port ${record.port} (pid ${record.pid}) must be refused with a reason`);
      }
      if (liveProduction.length === 0) print('sweep-refuses-production note', 'no live listener on 7331/7321 on this machine, so the live-production assertion is vacuous here');

      // Even the loud escalation must not touch them. `--only-pid` keeps this gate's bullet to
      // the pids it created itself: the sweep is a MACHINE-WIDE scan and other sessions'
      // sandboxes live on the same box (2026-09-19: one of them was killed from this gate).
      const scope = ['--only-pid', [standIn.hostPid, standIn.childPid].join(',')];
      const applied = await runSweep(['--apply', '--kill-suspects', ...scope, '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const touched = new Set((applied.json?.actions ?? []).filter((action) => action.action !== 'skipped').map((action) => action.pid));
      // 判据**按归属**（2026-09-25 修）：
      //   · 本门名下（硬判据）：sweep 对生产实例的**拒绝**必须成立 —— 它的报告里它们带 `protected` 理由，
      //     且 `--apply` 的动作账里**从来没有它们**（`!touched.has(pid)`）；下面 `alive(...)` 只当**记录**：
      //     7331/7321 上跑的是**别人的**进程（活的 arcsopho 实例），主人随时会重启它 ——
      //     拿「它还活着」当本门的判据，就会让本门红在一个它没有所有权的进程上。
      const stillAlive = { host: alive(standIn.hostPid), child: alive(standIn.childPid), production: liveProduction.map(({ port, pid }) => ({ port, pid, alive: alive(pid) })) };
      print('sweep-refuses-production apply', { touched: [...touched], stillAlive });
      assert.ok(!touched.has(standIn.hostPid) && !touched.has(standIn.childPid), 'the relative-entry refusal must hold even under --apply --kill-suspects');
      // 枪口只对自己那一侧（**有归属**的不变式）：sweep 报出来的非 skipped 动作**只能是本门自己造的 pid**。
      assert.ok([...touched].every((pid) => pid === standIn.hostPid || pid === standIn.childPid),
        `the sweep must never act on a pid this gate did not create: ${[...touched].filter((pid) => pid !== standIn.hostPid && pid !== standIn.childPid).join(',')}`);
      assert.ok(stillAlive.host && stillAlive.child, 'the refused stand-in must still be alive');
      for (const record of stillAlive.production) {
        assert.ok(!touched.has(record.pid), `the sweep must never record an action for the live production pid ${record.pid} (it was refused as protected)`);
      }
      {
        const gone = stillAlive.production.filter((record) => !record.alive);
        if (gone.length > 0) print('sweep-refuses-production note', `生产实例的 pid 在本次窗口里不在了：${gone.map((record) => `${record.port}:${record.pid}`).join(', ')} —— `
          + '那是**别人的**进程（主人重启/停了它），本门对它没有所有权；本门能自证的是「sweep 的动作账里没有它」，上面那条硬判据已经钉住');
      }

      if (isWindows) {
        print('sweep-refuses-production note', 'Windows: another process\'s environment cannot be read, so the env-derived rules (`--production-port` from SOPHO_PORT, `--production-profile` from ASSIST_HOME) do not apply there. The rules that DO hold on Windows are checked above: an actual listener on 7331/7321, a non-sandbox entry path, and a relative entry.');
        return { hostPid: standIn.hostPid, protected: protectedByPid.get(standIn.hostPid), platform: 'win32', envRulesUnavailable: true };
      }
      return { hostPid: standIn.hostPid, protected: protectedByPid.get(standIn.hostPid), platform: process.platform };
    },
  });
}

// POSIX-only: the env-derived refusals. Kept separate because Windows cannot run it at all.
async function caseSweepRefusesProductionEnv() {
  const dir = path.join(sandbox, 'env-prod');
  const serverDir = path.join(dir, 'server');
  await mkdir(serverDir, { recursive: true });
  await cp(standInHost, path.join(serverDir, 'base.mjs'));
  await cp(standInWorker, path.join(serverDir, 'worker.mjs'));
  const factsPath = path.join(sandbox, 'env-prod-stand-in.json');
  const env = {
    HOME: path.join(dir, 'home'),
    ASSIST_HOME: path.join(dir, 'home', '.pi', 'profiles', 'assistant'),
    SOPHO_AGENT_DIR: path.join(dir, 'home'), PI_CODING_AGENT_DIR: path.join(dir, 'home'), PI_OFFLINE: '1',
    SOPHO_PORT: '7331',
    SANDBOX_STAND_IN_CHILD: path.join(serverDir, 'worker.mjs'),
    SANDBOX_STAND_IN_FACTS: factsPath,
  };
  return withMiniHarness('env-prod', {
    mode: 'legacy',
    entry: path.join(serverDir, 'base.mjs'),
    env,
    onReady: async ({ facts }) => {
      const standIn = await waitForFile(factsPath);
      createdPids.add(standIn.hostPid);
      createdPids.add(standIn.childPid);
      await waitForLogLine(facts.sandboxLog, /stand-in-worker/);
      // Deleted worktree + declared production port + real-profile ASSIST_HOME: every
      // decisive orphan signal is present, and it must STILL be refused.
      await rm(dir, { recursive: true, force: true });
      const dry = await runSweep(['--dry-run', '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const protectedByPid = new Map((dry.json?.protected ?? []).map((record) => [record.pid, record.protected]));
      const applied = await runSweep(['--apply', '--only-pid', String(standIn.hostPid), '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const touched = new Set((applied.json?.actions ?? []).filter((action) => action.action !== 'skipped').map((action) => action.pid));
      print('sweep-refuses-production-env', {
        hostPid: standIn.hostPid,
        hostProtected: protectedByPid.get(standIn.hostPid) ?? null,
        orphans: [...pidSet(dry.json?.orphans)],
        touched: [...touched],
        hostAlive: alive(standIn.hostPid),
      });
      assert.equal(protectedByPid.get(standIn.hostPid), 'production-port', 'a declared 7331 must be refused');
      assert.ok(!touched.has(standIn.hostPid), 'the env refusal must hold under --apply');
      assert.ok(alive(standIn.hostPid), 'the production-shaped stand-in must still be alive');
      return { hostPid: standIn.hostPid, protected: protectedByPid.get(standIn.hostPid) };
    },
  });
}

// Regression arm for a real false positive found by `wsl.exe -d ArchLinux` verification on
// 2026-09-18: `bin/serve.sh` (and any hand-typed start) launches A with a RELATIVE entry,
// `node server/base.mjs`, while base forks its worker with an ABSOLUTE path. A
// "is the parent a live host?" regex over the whole command line sees a space before
// `server` and answers NO -- so the live worker was judged `host-gone` and `--apply` killed
// it (the host then forked a replacement: a kill/rebirth loop). Nothing may be touched here.
async function caseSweepRelativeParent() {
  const dir = path.join(sandbox, 'rel-parent');
  const serverDir = path.join(dir, 'server');
  await mkdir(serverDir, { recursive: true });
  await cp(standInHost, path.join(serverDir, 'base.mjs'));
  await cp(standInWorker, path.join(serverDir, 'worker.mjs'));
  const factsPath = path.join(dir, 'stand-in.json');
  const env = {
    HOME: path.join(dir, 'home'), ASSIST_HOME: path.join(dir, 'home'), SOPHO_AGENT_DIR: path.join(dir, 'home'),
    PI_CODING_AGENT_DIR: path.join(dir, 'home'), PI_OFFLINE: '1',
    // Absolute, exactly like `server/base.mjs`'s `fork(workerEntry)`.
    SANDBOX_STAND_IN_CHILD: path.join(serverDir, 'worker.mjs'),
    SANDBOX_STAND_IN_FACTS: factsPath,
  };
  return withMiniHarness('rel-parent', {
    mode: 'legacy',
    // Relative on purpose, with cwd = the "deployment" root -- the shape bin/serve.sh uses.
    entry: 'server/base.mjs',
    childCwd: dir,
    env,
    onReady: async ({ facts }) => {
      const standIn = await waitForFile(factsPath);
      createdPids.add(standIn.hostPid);
      createdPids.add(standIn.childPid);
      await waitForLogLine(facts.sandboxLog, /stand-in-worker/);
      const dry = await runSweep(['--dry-run', '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const orphanPids = pidSet(dry.json?.orphans);
      const protectedByPid = new Map((dry.json?.protected ?? []).map((record) => [record.pid, record.protected]));
      const applied = await runSweep(['--apply', '--only-pid', [standIn.hostPid, standIn.childPid].join(','), '--min-age-seconds', '1', '--max-age-seconds', '1']);
      const touched = new Set((applied.json?.actions ?? []).filter((action) => action.action !== 'skipped').map((action) => action.pid));
      print('sweep-relative-parent', {
        hostPid: standIn.hostPid, childPid: standIn.childPid,
        hostProtected: protectedByPid.get(standIn.hostPid) ?? null,
        childVerdict: orphanPids.has(standIn.childPid) ? 'orphan' : (protectedByPid.has(standIn.childPid) ? 'protected' : 'not-a-candidate'),
        touched: [...touched],
        alive: { host: alive(standIn.hostPid), child: alive(standIn.childPid) },
      });
      if (!orphanPids.has(standIn.childPid) && !protectedByPid.has(standIn.childPid)) {
        print('sweep-relative-parent note', 'Windows frequently withholds another process\'s CommandLine from Win32_Process (observed: the worker comes back with an empty one), so the worker is not even a candidate here and this arm is vacuous on Windows. It is conclusive on POSIX, where a process command line is always readable -- run it under WSL.');
      }
      // The host is refused because a relative entry cannot be located...
      assert.equal(protectedByPid.get(standIn.hostPid), 'relative-entry', 'a relative entry must be refused');
      // ...but the WORKER must NOT be called host-gone: its parent is alive and IS a host.
      assert.ok(!orphanPids.has(standIn.childPid), 'a live worker of a live host must never be `host-gone`, however the host was launched');
      assert.ok(!touched.has(standIn.childPid), 'the sweep must not terminate that worker');
      assert.ok(alive(standIn.childPid) && alive(standIn.hostPid), 'both must still be alive');
      return { hostPid: standIn.hostPid, childPid: standIn.childPid, touched: [...touched] };
    },
  });
}

// 第二类候选（2026-09-21 加）：**浏览器树**，只按命令行里的沙箱标记认
// （`--user-data-dir=<本机临时目录>/…`；Firefox 是 `--profile <本机临时目录>/…`），
// **绝不按进程名** —— 这台机器上命令行含 `headless` 的进程有 30+ 个，全是用户自己的
// （VS Code 的 copilot、Steam 的 chromium 系 helper）。
//
// 本臂把「标记」与「进程名」彻底解耦：正例与反例用的是**同一个替身、同一条 node 命令行**，
// 唯一的差别就是那个标记在不在 ⇒ 只要判别里有一处按名字匹配，两边必有一边错。
//
// 对照/安全臂全走**受控进程**（本门自己 spawn 的替身），对用户自己的进程**只看不碰**：
//   · 不带 profile 旗标但含 `headless`（copilot 的形状）⇒ 必须认不出；
//   · `--user-data-dir=<$HOME>/…`（VSCode / Steam 的形状）⇒ 必须认不出；
//   · 这台机器上真实存在的「含 headless 且不带 profile」的进程 ⇒ 必须一个都不在候选里；
//   · 父（本门）还活着 ⇒ `--apply` / `--apply --kill-suspects` 都不许碰它。
async function caseSweepBrowserMarker() {
  const markerDir = path.join(sandbox, 'marker-tree');
  const profileDir = path.join(markerDir, 'chromium');
  await mkdir(profileDir, { recursive: true });
  const debugPort = await reserveHighPort();
  const baseArgs = ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`];
  // 替身不能继承本会话的真实 profile：否则 `production-profile` 保护会（正确地）先拦住它，
  // 这一臂就量不到它本来要量的东西了。
  const fakeHome = path.join(sandbox, 'fake-home');
  await mkdir(fakeHome, { recursive: true });

  const started = [];
  const startFake = async (label, args) => {
    const child = spawn(process.execPath, [standInBrowser, ...args], {
      cwd: root,
      env: {
        ...process.env, SANDBOX_STAND_IN_CHILD: standInWorker,
        HOME: fakeHome, ASSIST_HOME: fakeHome, PI_CODING_AGENT_DIR: fakeHome, SOPHO_AGENT_DIR: fakeHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    createdPids.add(child.pid);
    const ready = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`${label}: stand-in browser never reported ready (buffer=${buffer.slice(-200)})`)), 15_000);
      child.stdout.on('data', (data) => {
        buffer += String(data);
        const line = buffer.split('\n').find((entry) => entry.includes('stand-in-browser'));
        if (!line) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      });
    });
    if (ready.childPid) createdPids.add(ready.childPid);
    started.push({ label, child, ready });
    return { child, ready };
  };

  // 正例：带沙箱标记（根 + 一个也带同一标记的子进程，照抄真 chromium 树的形状）。
  const marked = await startFake('marked', [...baseArgs, `--user-data-dir=${profileDir}`, 'about:blank']);
  // 反例 ①：同一替身、同一命令行，但**不带** profile 旗标（copilot 那种 --headless）。
  const plain = await startFake('plain-headless', [...baseArgs, 'about:blank']);
  // 反例 ②：带 profile 旗标但路径**不在临时目录下**（VSCode / Steam 的形状；只写进 argv，不碰那个目录）。
  const homeShape = await startFake('home-shape', [...baseArgs, `--user-data-dir=${path.join(os.homedir(), '.config', 'Code')}`, 'about:blank']);

  // 这台机器上真存在的「含 headless、不带 profile」的进程（例如用户自己的 copilot）。
  // 自己扫进程表（`processTable`），不用 pgrep -f（模式会出现在自己那条命令行上，本仓踩过四次）。
  const realHeadless = [];
  if (!isWindows) {
    for (const row of await processTable()) {
      const cmdline = row.commandLine ?? '';
      if (!cmdline || !/headless/i.test(cmdline)) continue;
      if (/--user-data-dir=|--profile[= ]/.test(cmdline)) continue;
      realHeadless.push({ pid: row.pid, cmdline: cmdline.slice(0, 140) });
    }
  }

  // min-age 0：这一臂量的是「父活着 ⇒ 只报不杀」，不是年龄门限。
  const minAge = ['--min-age-seconds', '0', '--max-age-seconds', '999999'];
  const dry = await runSweep(['--dry-run', ...minAge, '--no-dir-report']);
  const trees = dry.json?.browserTrees ?? [];
  const tree = trees.find((entry) => entry.profileDir === profileDir) ?? null;
  const protectedByPid = new Map((dry.json?.protected ?? []).map((record) => [record.pid, record.protected]));
  const inOrphans = pidSet(dry.json?.orphans);
  const inRefused = pidSet(dry.json?.refusedLiveParent);
  // 「不是候选」的判定：报告里任何一张表都不许提到它。表就是这几张，所以这是可判的。
  const mentioned = (pid) => Boolean(tree && tree.processCount > 0 && tree.memberPids.includes(pid))
    || trees.some((entry) => entry.rootPid === pid)
    || inOrphans.has(pid) || inRefused.has(pid)
    || protectedByPid.has(pid)
    || pidSet(dry.json?.suspects).has(pid)
    || new Set((dry.json?.wouldKill ?? []).map((record) => record.pid)).has(pid);

  print('sweep-browser-marker dry-run', {
    marked: { pid: marked.child.pid, childPid: marked.ready.childPid, tree },
    plain: { pid: plain.child.pid, mentioned: mentioned(plain.child.pid) },
    homeShape: { pid: homeShape.child.pid, mentioned: mentioned(homeShape.child.pid) },
    realHeadlessWithoutProfile: realHeadless.slice(0, 4),
    realHeadlessMentioned: realHeadless.filter((entry) => mentioned(entry.pid)).length,
    candidateCounts: { node: dry.json?.nodeCandidates ?? null, browser: dry.json?.browserCandidates ?? null, trees: trees.length },
  });

  // 正例：带标记的那个必须被认成候选，而且认得是**这棵树里的根**。
  assert.ok(tree, `a process whose command line names a sandbox profile UNDER the temp dir must be a candidate ${dry.summary}`);
  assert.equal(tree.rootPid, marked.child.pid, 'the tree root must be the member no parent carries the same profile path for');
  assert.equal(tree.processCount, 2, 'the whole tree must be grouped (root + the child that carries the same profile path)');
  assert.equal(tree.rootRecord?.kind, 'browser', 'it must be classified as a browser-tree process, not as a node sandbox root');
  assert.equal(tree.rootRecord?.profileDir, profileDir, 'the record must name the sandbox profile path it was recognised by');
  assert.ok(tree.rootRecord?.reasons.includes('debug-port-not-listening-parent-alive'), `its declared debug port is not listening and its parent is alive, so it must be refused with that reason: ${JSON.stringify(tree.rootRecord?.reasons)}`);
  assert.ok(inRefused.has(marked.child.pid), 'that refusal must be printed with its live parent');
  assert.ok(!inOrphans.has(marked.child.pid), 'a tree whose parent is alive must never be an orphan');
  assert.equal(protectedByPid.get(marked.ready.childPid), 'browser-tree-member', 'a member is refused as such (its parent is the root, and the root owns the tree)');

  // 反例：两条不含沙箱标记的都不行。这一条红了就是会误伤用户的进程。
  assert.ok(!mentioned(plain.child.pid), `a \`--headless\` process with NO sandbox profile flag must not appear anywhere in the report (that is the user's copilot shape) ${dry.summary}`);
  assert.ok(!mentioned(homeShape.child.pid), 'a browser profile outside the temp dir (VSCode / Steam shape) must not appear either');
  assert.equal(realHeadless.filter((entry) => mentioned(entry.pid)).length, 0, `no real headless process without a temp profile may be a candidate; saw ${JSON.stringify(realHeadless.slice(0, 3))}`);
  if (isWindows) print('sweep-browser-marker note', 'Windows: the real-`headless` arm scanned nothing here; the two controlled arms above are conclusive on both platforms.');

  // 安全臂（受控实验）：父（本门）还活着 ⇒ `--apply` 不许碰它，连最响的 --kill-suspects 也不许。
  const scope = ['--only-pid', [marked.child.pid, marked.ready.childPid, plain.child.pid, homeShape.child.pid].join(',')];
  const applied = await runSweep(['--apply', ...scope, ...minAge, '--no-dir-report']);
  const escalated = await runSweep(['--apply', '--kill-suspects', ...scope, ...minAge, '--no-dir-report']);
  const actions = [...(applied.json?.actions ?? []), ...(escalated.json?.actions ?? [])];
  const killed = new Set(actions.filter((action) => action.action !== 'skipped').map((action) => action.pid));
  const aliveAfterApply = { root: alive(marked.child.pid), member: alive(marked.ready.childPid), plain: alive(plain.child.pid), homeShape: alive(homeShape.child.pid) };
  print('sweep-browser-marker apply', {
    killed: [...killed],
    actions: actions.map((action) => ({ pid: action.pid, action: action.action, detail: action.detail ?? null })),
    aliveAfterApply,
  });
  assert.equal(killed.size, 0, 'a browser tree whose parent is alive must not be terminated, not even under --apply --kill-suspects');
  assert.ok(Object.values(aliveAfterApply).every(Boolean), `all four stand-in processes must still be alive: ${JSON.stringify(aliveAfterApply)}`);

  // 最贵的那个形状（2026-09-19 的误杀现场的形状，搬到这里）：profile 目录被删、父还活着 ⇒ 只报告不杀。
  await rm(profileDir, { recursive: true, force: true });
  assert.ok(!existsSync(profileDir), 'the profile dir must really be gone for this arm');
  const afterRm = await runSweep(['--dry-run', ...minAge, '--no-dir-report']);
  const rootAfterRm = (afterRm.json?.refusedLiveParent ?? []).find((record) => record.pid === marked.child.pid) ?? null;
  const appliedAfterRm = await runSweep(['--apply', ...scope, ...minAge, '--no-dir-report']);
  const killedAfterRm = new Set((appliedAfterRm.json?.actions ?? []).filter((action) => action.action !== 'skipped').map((action) => action.pid));
  print('sweep-browser-marker deleted-profile', {
    refused: rootAfterRm,
    orphanPids: [...pidSet(afterRm.json?.orphans)],
    killedAfterRm: [...killedAfterRm],
    alive: { root: alive(marked.child.pid), member: alive(marked.ready.childPid) },
  });
  assert.ok(rootAfterRm, 'a tree whose sandbox profile was deleted while its parent lives must be REPORTED as refused-with-a-live-parent');
  assert.ok(rootAfterRm.reasons.includes('profile-dir-missing-parent-alive'), `the refusal must name the deleted profile dir as the signal it refused to act on: ${JSON.stringify(rootAfterRm.reasons)}`);
  assert.ok(!pidSet(afterRm.json?.orphans).has(marked.child.pid), 'and it must NOT be called an orphan while its parent is alive');
  assert.equal(killedAfterRm.size, 0, 'nothing may be killed on that signal either');
  assert.ok(alive(marked.child.pid) && alive(marked.ready.childPid), 'the stand-in tree must still be alive');

  for (const { child, ready } of started) {
    await cleanupByPid(child.pid);
    if (ready.childPid) await cleanupByPid(ready.childPid);
  }
  return {
    rootPid: marked.child.pid, memberPid: marked.ready.childPid, treeProcessCount: tree.processCount,
    plainPid: plain.child.pid, homeShapePid: homeShape.child.pid, realHeadlessWithoutProfile: realHeadless.length,
    killed: [...killed], aliveAfterApply,
  };
}

// 【只读报告】沙箱**目录**残留：sweep 多报一句「N 个目录 / X 字节」，**绝不删**
// （这个工具根本没有删目录的代码路径）。前缀是从 test/ 里**推导**出来的
// （每个门都用 `mkdtemp(path.join(os.tmpdir(), <前缀>))`），所以用户自己的
// `/tmp/org.chromium.Chromium.*`（本机 6500+ 个，Chromium 从进程内部建的临时目录，
// 从来不由任何门创建）永远算不进去。两个 delta 把它变成机械判定：
//   ① 造一个**带门前缀**的目录 ⇒ 它在报告里、且字节被算进去；
//   ② 造一个**用户形状**（org.chromium.*）的目录 ⇒ 报告里必须一个字段都不变。
//
// ⚠️ 2026-09-25 修：那两个 delta 原来是拿**全机共享的** `os.tmpdir()` 做**前后对比**（count/bytes）——
//   那是**本门没有所有权**的读数：同一台机器上**别的会话/别的门同时跑**，建一个带门前缀的沙箱
//   （或把字节写进去/删掉一个）就会让 delta 变，于是本门红在一个它从来没有过的目录上。
//   修法：给 sweep 子进程一个**本门自己的私有 TMPDIR**（`mkdtemp` 在 `sandbox` 里，收尾一起没），
//   两个探针目录也建在那里面 ⇒ count/bytes/dirs **全部**是本门名下、可确定复现的读数；
//   前缀那一半仍然来自 test/ 源码推导（与 TMPDIR 无关），所以这条臂的意思一点没变。
//   归属写明：报告里出现的目录只可能是本门造的那两个（私有 TMPDIR 里没有别人的东西）。
async function caseSweepStaleDirs() {
  // 私有 TMPDIR：sweep 的 `sandboxDirUsage()` 读 `os.tmpdir()` ⇒ 只看得到本门自己造的东西。
  const tmp = await mkdtemp(path.join(sandbox, 'sweep-tmp-'));
  const sweepEnv = { TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const suffix = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  // `sopho-ui-` 是 test/ui-harness.mjs 真实使用的 mkdtemp 前缀 ⇒ 一定在推导出来的集合里。
  const gateDir = path.join(tmp, `sopho-ui-hygiene-${suffix}`);
  // 用户自己浏览时的 Chromium 临时目录形状（同名 `org.chromium.Chromium.*`）。
  const userDir = path.join(tmp, `org.chromium.Chromium.hygiene-${suffix}`);
  const payload = Buffer.alloc(64 * 1024, 7);
  await mkdir(gateDir, { recursive: true });
  await writeFile(path.join(gateDir, 'payload.bin'), payload);
  await mkdir(userDir, { recursive: true });
  await writeFile(path.join(userDir, 'payload.bin'), payload);

  try {
    const both = await runSweep(['--dry-run'], sweepEnv);           // 两个探针目录都在
    const usage = both.json?.staleSandboxDirs ?? {};
    const prefixes = usage.prefixes ?? [];
    const dirsWithBoth = usage.dirs ?? [];
    const readUsage = (result) => ({ count: result.json?.staleSandboxDirs?.count ?? -1, bytes: result.json?.staleSandboxDirs?.bytes ?? -1, dirs: result.json?.staleSandboxDirs?.dirs ?? [] });
    print('sweep-stale-dirs', {
      privateTmp: tmp, prefixesDerived: prefixes.length, hasSophoUiPrefix: prefixes.includes('sopho-ui-'),
      gateDir: { path: gateDir, counted: dirsWithBoth.includes(gateDir) },
      userDir: { path: userDir, counted: dirsWithBoth.includes(userDir) },
      baseline: { count: usage.count, bytes: usage.bytes, entriesScanned: usage.entriesScanned, truncated: usage.truncated },
      countedSample: dirsWithBoth.slice(0, 3),
      note: '私有 TMPDIR ⇒ 报告里的目录全部归本门（本门自己造的探针）；sweep 只报数，从不删目录；探针目录都是本门自己 rm 的',
    });
    assert.ok(prefixes.includes('sopho-ui-'), 'the derived prefix set must include the prefixes the gates actually use');
    assert.equal(usage.count, dirsWithBoth.length, 'the reported count must be the number of directories it actually names');
    assert.ok(dirsWithBoth.includes(gateDir), `a directory carrying a gate prefix must be counted (${gateDir})`);
    // 正控制（归属）：私有 TMPDIR 里带门前缀的目录**只有本门造的那一个** ⇒ 下面的 delta 才真的
    // 只量本门自己那格（不是全机读数）。
    assert.deepEqual(dirsWithBoth, [gateDir], `the private TMPDIR must contain exactly the probe this gate made, nothing else (got ${JSON.stringify(dirsWithBoth)})`);
    // ② 用户形状的目录：从报告里去掉它，读数必须一动不动。
    await rm(userDir, { recursive: true, force: true });
    const withoutUser = readUsage(await runSweep(['--dry-run'], sweepEnv));
    print('sweep-stale-dirs user-shape', { count: withoutUser.count, countedUserDir: withoutUser.dirs.includes(userDir), inUsage: JSON.stringify(withoutUser.dirs.filter((dir) => /org\.chromium/.test(dir))) });
    assert.ok(!withoutUser.dirs.includes(userDir), 'a user-shaped directory (org.chromium.*) must never be counted');
    assert.equal(withoutUser.count, usage.count, 'removing a user-shaped directory must not change the count (it was never in it)');
    assert.equal(withoutUser.bytes, usage.bytes, 'and it must not change the byte total either');
    assert.equal(withoutUser.dirs.filter((dir) => /org\.chromium/.test(dir)).length, 0, 'no counted directory may be a user Chromium temp dir');
    // ① 门前缀的目录：删掉它，计数必须减 1、字节必须减少 ≥ 64 KiB。
    await rm(gateDir, { recursive: true, force: true });
    const withoutBoth = readUsage(await runSweep(['--dry-run'], sweepEnv));
    print('sweep-stale-dirs gate-shape', { count: withoutBoth.count, bytes: withoutBoth.bytes, countedGateDir: withoutBoth.dirs.includes(gateDir) });
    assert.ok(!withoutBoth.dirs.includes(gateDir), 'the gate-shaped directory must be gone from the report once it is removed');
    assert.equal(usage.count - withoutBoth.count, 1, 'removing a gate-shaped directory must lower the count by exactly one');
    assert.ok(usage.bytes - withoutBoth.bytes >= payload.length, `and its bytes must have been counted (delta ${usage.bytes - withoutBoth.bytes} < ${payload.length})`);
    // 只读：报告结构里没有任何「删/移除」字段。
    assert.ok(!Object.keys(usage).some((key) => /delet|remov|unlink/i.test(key)), `the dir report must have no delete/remove field: ${Object.keys(usage).join(',')}`);
    return {
      prefixesDerived: prefixes.length,
      gateDirCounted: true,
      userDirCounted: false,
      gateDirDelta: { count: usage.count - withoutBoth.count, bytes: usage.bytes - withoutBoth.bytes },
      userDirDelta: { count: usage.count - withoutUser.count, bytes: usage.bytes - withoutUser.bytes },
    };
  } finally {
    await rm(gateDir, { recursive: true, force: true }).catch(() => {});
    await rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
}
// 【推导面／整类漏报】门**实际会建的沙箱目录前缀**必须逐格都能被 `bin/sandbox-sweep.mjs` 推导出来。
// 为什么单开一条臂：`sweep-stale-dirs` 只钉了一格（`sopho-ui-`），于是整整一类漏报没人守 ——
// 「门会建、推导集认不出」的目录**永远不会出现在报告里**（报告是只读的：看不见就等于没有）。
// 2026-09-28 本机实测的这一类（都真在 /tmp 上躺着，或随时会）：
//   · `test/designer-ui.mjs` 的 artifact 目录 `/tmp/sopho-designer-ui`（实测 108 个文件）
//   · `test/design-edit.mjs` 的 `/tmp/sopho-design-edit`（8 个）、`test/design-spec.mjs` 的
//     `/tmp/sopho-design-spec`（18 个）—— 三者根都写成 `process.env.TEMP ||
//     process.env.TMPDIR || os.tmpdir()` 这种**就地**临时根，旧推导只认字面量 `os.tmpdir()`
//   · `test/live-segments.mjs` 的 `/tmp/sopho-live-segments`（同上，根是 `… || '/tmp'`）
//   · `test/wt-reclaim.mjs` 的 `/tmp/wtreclaim-gate-*` 与 `/tmp/wtreclaim-arm-*`（第二个参数是
//     **三元表达式**，旧推导只认「紧跟逗号的那个字面量」⇒ 整格漏掉）
// 机制（**不抄任何前缀名字**）：读 test/ 下每个 .mjs，只取**建目录的调用**
//   （`mkdir`/`mkdirSync`/`mkdtemp`/`mkdtempSync`），把它的路径实参按同文件 `const` 回代，
//   再取其中「就地临时根 + 前缀表达式」里的字面量。新门／新写法会被自动抓进来。
// 非空转：临时种一个**形状新**的假门文件，要求推导集**当场**认得出它、删掉后**当场**认不出 ——
//   两条都过，才排除「一张冻住的名字表」这种假通过。
// 另加一条不变量：`bin/sandbox-sweep.mjs` **只报不删**（2026-09-28 核过：全文 0 个删除动词）。
const SWEEP_DELETE_VERB_RE = /\b(?:rm|rmdir|unlink|rmSync|rmdirSync|unlinkSync)\s*\(/;
const TEMP_ROOT_MARKER_RE = /os\.tmpdir\(\)|TMPDIR|\bTEMP\b|['"`]\/tmp['"`]/;
const BARE_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/** 实参切分：平衡括号 + 引号（本臂自己的那份，只用来定位，不执行任何东西）。 */
function callArgumentsOf(source, openIndex) {
  const args = [];
  let depth = 0;
  let start = openIndex + 1;
  let quote = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (quote !== null) {
      if (ch === '\\') { index += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) { args.push(source.slice(start, index)); return args; }
      continue;
    }
    if (ch === ',' && depth === 1) { args.push(source.slice(start, index)); start = index + 1; }
  }
  return null;
}

/** 「门实际会建的沙箱目录前缀」→ 站点。锚点是**建目录的调用点**，不是「文件里出现的任何字符串」。
 * ⚠️ 这是**下界**（故意）：只认「建目录的实参（按 `const` 回代）是 `path.join(<就地临时根>, <前缀>)`」这一形状。
 *   更宽的机制（前缀是**隐式父目录**，如 `mkdir(path.join(WORK,'logs'))` 而 `WORK` 自己就在临时根下；
 *   或前缀经 `path.join(TMP, PREFIX)` 这种别名根）由 **sweep 那边**扫「所有 `path.join` 」兜住
 *   （实测 `/tmp/sopho-switch-perf` 就是这么被数进去的）。这里不跟到那一层：跟着往上找第一段会
 *   把 `logs` 那种**段名**误当成前缀，反而造出假要求。 */
async function gateSandboxDirPrefixes() {
  const found = new Map();
  const files = [];
  const collect = (directory, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { collect(full, depth + 1); continue; }
      if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  collect(testDir, 0);
  for (const file of files) {
    const source = await readFile(file, 'utf8').catch(() => '');
    const constants = new Map();
    for (const declaration of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
      if (!constants.has(declaration[1])) constants.set(declaration[1], declaration[2]);
    }
    const resolve = (expr, depth = 0) => {
      const text = expr.trim();
      if (depth < 3 && BARE_IDENTIFIER_RE.test(text) && constants.has(text)) return resolve(constants.get(text), depth + 1);
      return text;
    };
    const note = (raw, index) => {
      const prefix = raw.split('$')[0];   // 模板前缀截到第一个插值
      if (prefix.length < 3 || prefix.includes('/') || prefix.includes('\\')) return;
      if (!found.has(prefix)) found.set(prefix, []);
      found.get(prefix).push(`${path.relative(root, file)}:${source.slice(0, index).split('\n').length}`);
    };
    for (const call of source.matchAll(/\b(?:mkdir|mkdirSync|mkdtemp|mkdtempSync)\s*\(/g)) {
      const args = callArgumentsOf(source, call.index + call[0].length - 1);
      if (args === null || args.length === 0) continue;
      const target = resolve(args[0]);
      for (const join of target.matchAll(/path\.join\s*\(/g)) {
        const joinArgs = callArgumentsOf(target, join.index + join[0].length - 1);
        if (joinArgs === null || joinArgs.length < 2) continue;
        if (!TEMP_ROOT_MARKER_RE.test(joinArgs[0].trim())) continue;   // 只认**就地**的临时根
        const second = joinArgs[1].trim();
        if (BARE_IDENTIFIER_RE.test(second)) {
          const binding = constants.get(second);
          const literal = typeof binding === 'string' ? binding.match(/^\s*['"`]([^'"`]+)['"`]/) : null;
          if (literal) note(literal[1], call.index);
          continue;
        }
        for (const literal of second.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) note(literal[1] ?? literal[2] ?? literal[3], call.index);
      }
    }
  }
  return found;
}

async function caseSweepDirPrefixes() {
  const sweepSource = await readFile(sweepEntry, 'utf8');
  const deleteVerbLines = sweepSource.split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => SWEEP_DELETE_VERB_RE.test(line));

  const before = await runSweep(['--dry-run']);
  const beforePrefixes = before.json?.staleSandboxDirs?.prefixes ?? [];
  const beforeSet = new Set(beforePrefixes);
  const gates = await gateSandboxDirPrefixes();
  const gatePrefixes = [...gates.keys()].sort();
  const missing = gatePrefixes.filter((prefix) => !beforeSet.has(prefix));
  print('sweep-dir-prefixes', {
    prefixesDerived: beforePrefixes.length,
    gateDirPrefixes: gatePrefixes.length,
    missing,
    scanErrors: before.json?.staleSandboxDirs ? [] : [before.summary],
    deleteVerbsInSweep: deleteVerbLines.map(({ number, line }) => `${number}: ${line}`),
    note: '推导集必须认全「门的建目录前缀」：漏一格的后果是那一格残留**永远不上报**（报告只读，看不见＝没有）',
  });
  assert.equal(deleteVerbLines.length, 0, `bin/sandbox-sweep.mjs must stay report-only and must never delete: ${JSON.stringify(deleteVerbLines)}`);
  assert.ok(gatePrefixes.length > 0, 'the gate-source scan found no directory prefix at all -- the scan itself is broken, so this arm would be vacuous');
  assert.ok(beforeSet.size > 0, `the sweep must report a derived prefix set (got ${before.summary})`);
  assert.deepEqual(missing, [], `these prefixes are used by gates to CREATE directories but the sweep cannot derive them, so those leftovers would never be reported: ${JSON.stringify(missing.map((prefix) => ({ prefix, sites: gates.get(prefix) })))}`);

  // 非空转：种一个「形状新」的假门（artifact 写法：就地 TEMP || TMPDIR || os.tmpdir()），推导集必须
  // **当场**认得出它；删掉后必须**当场**又不认。两条都要有，才排除「名字表 / 缓存」。
  const probePrefix = `sweep-dir-prefix-probe-${process.pid}-`;
  const probeFile = path.join(testDir, `.sweep-dir-prefix-probe-${process.pid}.mjs`);
  await writeFile(probeFile, [
    '// planted by test/sandbox-hygiene.mjs (case sweep-dir-prefixes); removed in a finally.',
    "import os from 'node:os';",
    "import path from 'node:path';",
    "import { mkdir } from 'node:fs/promises';",
    `const ARTIFACT_DIR = path.join(process.env.TEMP || process.env.TMPDIR || os.tmpdir(), '${probePrefix}');`,
    'await mkdir(ARTIFACT_DIR, { recursive: true });',
    '',
  ].join('\n'), 'utf8');
  let duringSet = new Set();
  let seenByGateScan = false;
  const problems = [];
  try {
    const during = await runSweep(['--dry-run']);
    duringSet = new Set(during.json?.staleSandboxDirs?.prefixes ?? []);
    seenByGateScan = (await gateSandboxDirPrefixes()).has(probePrefix);
  } finally {
    // 收尾**不写成裸 `rm`**：本仓有机械规矩（`test/harness-contract.mjs`：`finally` 里的裸 rm 会「替换掉
    // 真正的失败」）。`cleanupStep` 只把问题记进 `problems`、从不抛 ⇒ 真断言红了不会被清理盖住；
    // 绿 run 时下面那条断言再把「没收干净」如实判红（同族口径见 `test/ui-sandbox-cleanup.mjs` 的 ⑦）。
    await cleanupStep(problems, 'remove the planted probe', () => rm(probeFile, { force: true }));
  }
  assert.ok(!existsSync(probeFile), `the planted probe must be gone again: ${probeFile}`);
  assert.deepEqual(problems, [], `removing the planted probe must not report problems: ${JSON.stringify(problems)}`);
  const after = await runSweep(['--dry-run']);
  const afterSet = new Set(after.json?.staleSandboxDirs?.prefixes ?? []);
  print('sweep-dir-prefixes planted-probe', {
    probeFile,
    probePrefix,
    seenByGateScanWhilePlanted: seenByGateScan,
    seenByDerivationWhilePlanted: duringSet.has(probePrefix),
    seenByDerivationAfterRemoval: afterSet.has(probePrefix),
    sameSetAsBefore: afterSet.size === beforeSet.size && [...beforeSet].every((prefix) => afterSet.has(prefix)),
    cleanupProblems: problems,
  });
  assert.ok(seenByGateScan, 'the gate-source scan must see a freshly planted gate file (otherwise this arm proves nothing)');
  assert.ok(duringSet.has(probePrefix), 'the derivation must pick a freshly planted gate up from the sources -- a frozen list of names would not');
  assert.ok(!afterSet.has(probePrefix), 'the probe prefix must disappear once the planted file is gone (the derivation re-reads the tree every run)');
  // 保留硬断言（逐条给理由）：`beforeSet` / `afterSet` 不是**全机**读数，而是**本门这棵树**的
  // `test/**` 源码的函数（`sandboxDirPrefixes()` 只读本仓 `test/`，与 /tmp 内容无关）⇒ 它是**本门名下的**
  // 状态；同一个 run 里唯一会改 `test/` 的就是本门自己那两个动作（种/删探针文件，上面两条已经钉住）。
  // 这一条挡的是“推导集被缓存/冻住”那类回归（探针在→认得出、探针走→认不出还不够，还得保证两次读的是同一棵树）。
  assert.deepEqual([...afterSet].sort(), [...beforeSet].sort(), 'the derivation must be deterministic: the same tree must give the same prefix set');
  return {
    prefixesDerived: beforePrefixes.length,
    gateDirPrefixes: gatePrefixes.length,
    missing: missing.length,
    probe: { prefix: probePrefix, seenWhilePlanted: true, seenAfterRemoval: false },
    deleteVerbsInSweep: deleteVerbLines.length,
  };
}
// 反向自检：上面那一半证明「父还活着 ⇒ 只报不杀」，这一半证明**它仍能真清掉一棵被收养的浏览器树**
// （与 node 侧的 `sweep-adopted-orphan` 一一对应）—— 2026-09-21 清掉的正是这样一棵 10 进程 / 1GB
// 的树：起它的门早就没了，profile 目录也早被删了，只有进程还在。
//
// 造形状用受控替身：观察者（本门）起一个 **launcher**（替身自身），launcher 再起一个带同一
// 沙箱标记的子进程；然后把 launcher SIGKILL 掉 ⇒ 子进程被收养 ⇒ 删掉 profile 目录 ⇒ 它必须
// 被认成决定性孤儿，并且 `--apply --only-pid` 必须按精确 pid 真的把它清掉。
async function caseSweepBrowserOrphan() {
  const markerDir = path.join(sandbox, 'orphan-tree');
  const profileDir = path.join(markerDir, 'chromium');
  await mkdir(profileDir, { recursive: true });
  const factsPath = path.join(markerDir, 'facts.json');
  const fakeHome = path.join(sandbox, 'orphan-home');
  await mkdir(fakeHome, { recursive: true });
  const debugPort = await reserveHighPort();

  const launcher = spawn(process.execPath, [
    standInBrowser, '--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], {
    cwd: root,
    env: {
      ...process.env, SANDBOX_STAND_IN_CHILD: standInBrowser, SANDBOX_STAND_IN_FACTS: factsPath,
      HOME: fakeHome, ASSIST_HOME: fakeHome, PI_CODING_AGENT_DIR: fakeHome, SOPHO_AGENT_DIR: fakeHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  createdPids.add(launcher.pid);
  const facts = await waitForFile(factsPath);
  const browserPid = facts.childPid;
  createdPids.add(browserPid);
  await waitForLogLine(factsPath, /stand-in-browser/);
  assert.equal(facts.pid, launcher.pid, 'the facts file must describe the launcher the gate spawned');
  assert.ok(alive(browserPid), 'the browser-tree member must be running');

  // 被收养的制造：SIGKILL 掉起它的那条进程（这一步没有守卫 —— 浏览器树本来也没有守卫）。
  killPid(launcher.pid, 'SIGKILL');
  const launcherGone = await waitGone(launcher.pid, 8000);
  let browserPpid = await ppidOf(browserPid);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && browserPpid === launcher.pid) { await sleep(100); browserPpid = await ppidOf(browserPid); }
  const state = { launcherPid: launcher.pid, launcherGone, browserPid, browserPpid, alive: alive(browserPid) };
  print('sweep-browser-orphan adoption', state);
  if (isWindows) {
    print('sweep-browser-orphan note', 'Windows: libuv puts node-spawned children in the job object of the spawning process, so the tree dies with its launcher and this arm is vacuous here. It is conclusive on POSIX (run it under WSL).');
    return { ...state, platform: 'win32', vacuous: true };
  }
  assert.ok(launcherGone, 'the launcher must really be dead');
  assert.ok(state.alive, 'POSIX: the browser tree must outlive the process that started it');
  assert.notEqual(browserPpid, launcher.pid, 'the kernel must have re-parented it off the dead launcher');

  // profile 目录也没了（= 那棵被清掉的树的形状：门早死了，沙箱目录也早删了）。
  await rm(profileDir, { recursive: true, force: true });
  assert.ok(!existsSync(profileDir), 'the profile dir must really be gone');

  const minAge = ['--min-age-seconds', '0', '--max-age-seconds', '999999'];
  const dry = await runSweep(['--dry-run', ...minAge, '--no-dir-report']);
  const orphan = (dry.json?.orphans ?? []).find((record) => record.pid === browserPid) ?? null;
  print('sweep-browser-orphan dry-run', {
    orphan,
    orphanPids: [...pidSet(dry.json?.orphans)],
    browserTrees: (dry.json?.browserTrees ?? []).map((tree) => ({ profileDir: tree.profileDir, rootPid: tree.rootPid, processCount: tree.processCount })),
  });
  assert.ok(orphan, `an adopted browser tree whose sandbox profile is gone must be a decisive orphan ${dry.summary}`);
  assert.equal(orphan.kind, 'browser', 'and it must be classified as a browser tree');
  assert.ok(orphan.reasons.includes('profile-dir-missing'), `the reason must name the missing profile dir: ${JSON.stringify(orphan.reasons)}`);

  const applied = await runSweep(['--apply', '--only-pid', String(browserPid), ...minAge, '--no-dir-report']);
  const terminated = new Set((applied.json?.actions ?? []).filter((action) => action.action === 'terminated').map((action) => action.pid));
  const gone = await waitGone(browserPid, 8000);
  const foreign = [...terminated].filter((pid) => !createdPids.has(pid));
  print('sweep-browser-orphan apply', {
    terminated: [...terminated],
    actions: (applied.json?.actions ?? []).map((action) => ({ pid: action.pid, action: action.action, verdict: action.verdict, detail: action.detail ?? null })),
    gone, foreign,
  });
  assert.ok(terminated.has(browserPid), 'the sweep must terminate the adopted browser root by exact pid');
  assert.equal(foreign.length, 0, `the sweep terminated pids this gate did not create: ${foreign.join(',')}`);
  assert.ok(gone, 'the leaked browser tree must really be gone afterwards');
  return { ...state, terminated: [...terminated], gone };
}

const results = {};
try {
  print('sandbox', { sandbox, root, platform: process.platform, case: options.case });
  if (options.case === 'all' || options.case === 'guard-lifetime') results.guardLifetime = await caseGuardLifetime();
  if (options.case === 'all' || options.case === 'old-spawn-no-guard') results.oldSpawnNoGuard = await caseOldSpawnNoGuard();
  if (options.case === 'all' || options.case === 'sweep-deleted-worktree') results.sweepDeletedWorktree = await caseSweepDeletedWorktree();
  if (options.case === 'all' || options.case === 'sweep-adopted-orphan') results.sweepAdoptedOrphan = await caseSweepAdoptedOrphan();
  if (options.case === 'all' || options.case === 'sweep-refuses-production') results.sweepRefusesProduction = await caseSweepRefusesProduction();
  if (options.case === 'all' || options.case === 'real-host-sigkill') results.realHostSigkill = await caseRealHostSigkill();
  if (options.case === 'all' || options.case === 'sweep-relative-parent') results.sweepRelativeParent = await caseSweepRelativeParent();
  if (options.case === 'all' || options.case === 'sweep-browser-marker') results.sweepBrowserMarker = await caseSweepBrowserMarker();
  if (options.case === 'all' || options.case === 'sweep-browser-orphan') results.sweepBrowserOrphan = await caseSweepBrowserOrphan();
  if (options.case === 'all' || options.case === 'sweep-stale-dirs') results.sweepStaleDirs = await caseSweepStaleDirs();
  if (options.case === 'all' || options.case === 'sweep-dir-prefixes') results.sweepDirPrefixes = await caseSweepDirPrefixes();
  if (options.case === 'all' || options.case === 'sweep-refuses-production-env') {
    if (isWindows) print('sweep-refuses-production-env', 'SKIPPED: Windows cannot read another process environment');
    else results.sweepRefusesProductionEnv = await caseSweepRefusesProductionEnv();
  }
  print('summary', results);
  print('RESULT', 'sandbox-hygiene PASS');
} finally {
  // Reap everything this gate created, by exact pid, TERM then KILL.
  const leftovers = [...createdPids].filter((pid) => alive(pid));
  if (leftovers.length > 0) {
    process.stderr.write(`cleanup: ${leftovers.length} pid(s) still alive, terminating by exact pid: ${leftovers.join(',')}\n`);
    for (const pid of leftovers) await cleanupByPid(pid);
  }
  const stillAlive = [...createdPids].filter((pid) => alive(pid));
  if (stillAlive.length > 0) process.stderr.write(`cleanup problems (secondary): still alive after TERM+KILL: ${stillAlive.join(',')}\n`);
  await rm(sandbox, { recursive: true, force: true }).catch((error) => process.stderr.write(`cleanup: rm sandbox failed: ${error.message}\n`));
}
