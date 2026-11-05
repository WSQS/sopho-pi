#!/usr/bin/env node
// bin/sandbox-sweep.mjs —— 沙箱孤儿扫描器（第三层兜底，只读优先）。
//
// 背景见 docs/handoff.md 的「沙箱卫生」一节：harness 被 SIGKILL 时，POSIX 上
// `server/base.mjs` 及其 generation worker 会被 init / systemd --user 收养而永远活着。
// 第一层（同生共死）与第二层（寿命上限）都在 `test/sandbox-guard.mjs` 里；但**守卫自己
// 也可能被 SIGKILL**，所以还需要一个能事后认出来的、独立于守卫的第三者。
//
// 纪律（与仓库既有约定一致）：
//   · 默认 **--dry-run 只列**，什么也不杀；`--apply` 才动手。
//   · 只用**精确 pid**，绝不 pkill / killall（模式常常出现在你自己那条命令行里）。
//   · 杀之前**再核一次** `/proc/<pid>/cmdline`（POSIX）/ CIM CommandLine（Windows），
//     对不上就不杀。
//   · **不删任何目录**（也就没有 glob 删目录的问题）：本工具只终止进程。
//   · 明确拒绝生产形状：入口不在沙箱路径下、端口是 7331/7321、ASSIST_HOME 指向真 profile。
//
//   跑法：
//     node bin/sandbox-sweep.mjs                    # 只列（--dry-run 就是默认）：打印
//                                                   # "我会杀谁 / 我为什么跳过谁"，零副作用
//     node bin/sandbox-sweep.mjs --dry-run          # 同上，显式写法
//     node bin/sandbox-sweep.mjs --json             # 机器可读（每次只打一个 JSON 文档）
//     node bin/sandbox-sweep.mjs --verbose          # 连被拒绝的（protected）也列出来
//     node bin/sandbox-sweep.mjs --apply            # 按 pid 逐个 TERM（KILL 兜底）
//     node bin/sandbox-sweep.mjs --apply --kill-suspects
//     node bin/sandbox-sweep.mjs --fail-on-found    # 找到孤儿就 exit 1（给门用）
//     node bin/sandbox-sweep.mjs --keep-pid 1234,5678      # 这几个 pid 永不碰（保护）
//     node bin/sandbox-sweep.mjs --only-pid 1234,5678 --apply
//                          ^ 只允许动这几个 pid，别的一律只报告不杀（共享机器上跑 --apply
//                            时必须带上它：本工具是**整机**扫描，别的会话的沙箱也在机子上）
//     --min-age-seconds / --max-age-seconds 调判据的年龄门限
//     --no-dir-report                            跳过「沙箱目录残留」那段只读统计（默认会报）
//
// 判定规则（逐条给理由，输出里带 reason 码）：
//   候选    = argv[0] 是 node（node / node.exe）且它后面那个非选项 argv 以
//             `server/{base,worker,app}.mjs` 结尾 —— 即"node 正在执行的那个脚本"。
//             不是"命令行里出现过这个路径"（`--entry <...>/server/base.mjs` 这类 harness
//             自己的命令行会被误当沙箱根），也不是"命令行里任意位置有个 node"（那样
//             `timeout 900 env K=V node …/server/base.mjs` 这个 wrapper 会被当成沙箱根）
//   候选 ②（2026-09-21 加）= **浏览器树**：命令行里带着一个**本机临时目录下的浏览器 profile 路径**
//             （`--user-data-dir=<tmp>/…`；Firefox 是 `--profile <tmp>/…`）。
//             ⚠️ **只按这个沙箱标记认，绝不按进程名**：这台机器上命令行含 `headless` 的进程有 35 个，
//             全是用户自己的（VS Code 的 copilot `--headless`、Steam 的 chromium 系 helper）—— 按
//             `chrome`/`chromium`/`headless` 匹配必然误伤用户的编辑器。用户自己的浏览器 profile
//             也**不在临时目录里**（Steam 用 `~/.local/share/Steam/config/htmlcache`，VS Code 用
//             `~/.config/Code`，copilot 那条根本不带 profile 旗标），所以「临时目录下的浏览器 profile」
//             就是本仓测试沙箱的形状：本仓 chromium 门一律 `--user-data-dir=<mkdtemp>/chromium`
//             （45 处），Firefox 门用 `--profile <mkdtemp>/firefox-profile`。
//   沙箱形状 = 入口是**绝对路径**，且其所在目录里有名为 `.sopho-wt` 的路径段，或在 os.tmpdir() 之下
//             （候选 ② 的 profile 路径必须**在 os.tmpdir() 之下**，这一条本身就是形状判据）
//   保护（永不动）= 非沙箱形状 / 相对入口 / 端口含 7331,7321 / ASSIST_HOME|PI_CODING_AGENT_DIR|SOPHO_AGENT_DIR
//                   含 `.pi/profiles` / 显式 --keep-pid / 不在 --only-pid 里
//   ★ 收养前置门（2026-09-19 加，本工具唯一的一次误杀之后）：**父链还活着就一律不杀**。
//     只有进程真的已经被收养（PPID=1，或父进程是 init / `systemd --user` / WSL 的每会话
//     `/init` 这类 subreaper，或父 pid 已不在进程表里）才谈得上"孤儿" —— 否则它的父还在，
//     它就有主。现场：2026-09-19 本机，另一条子会话的 generation worker pid 102969 被
//     `--apply` 杀掉，而它的宿主（它的父）pid 102957 一直活着；触发的是下面这条
//     `entry-dir-missing`（那条会话的 worktree 被删了）。原始日志：
//     /tmp/refetch-logs/sandbox-hygiene.log（`sweep-deleted-worktree apply: terminated 102969`）。
//     复现/反向自检见 test/sandbox-hygiene.mjs 的 `sweep-deleted-worktree`（活父 ⇒ 拒杀）
//     与 `sweep-adopted-orphan`（真孤儿 ⇒ 必须仍能杀）。
//   决定性孤儿（--apply 会杀；**全部要求已收养**）：
//     entry-dir-missing   入口脚本所在目录已不存在（worktree 被删了）且父链已不在 ⇒ 真孤儿
//     host-gone           worker.mjs 的父链已经没了（它唯一的客户 base 没了）
//     port-not-listening  base/app 声明的端口没人监听（POSIX 才读得到 environ）
//     escaped-lifetime-cap 父链确定消失（ppid=1 / 父已不在进程表）且 存活时间 > --max-age-seconds
//                          （守卫的寿命上限本该杀掉它 —— 它逃了）。**不**用年龄单独判被 subreaper
//                          收养的进程：被 `systemd --user` 收养、目录还在的 nohup 化沙箱 A/B
//                          与"活着的兄弟"长得一模一样（见下面那条 ⚠️），所以口径保持窄。
//   仅报告（绝不杀）：
//     parent-alive        父链还活着 ⇒ 哪怕 entry-dir-missing / port-not-listening /
//                         worker-父不是宿主 这些信号都在，也**只报告不杀**，并在输出里
//                         写出父 pid 与它的 cmdline（"这两个 pid 属于活着的父 pid=P ⇒ 跳过"）
//     parent-gone         已收养、但只有"父没了"这一条证据：base/app 本来就可以被 nohup 化
//                         （bin/serve.sh），单凭"父没了"不足以判死；要显式 --kill-suspects
//     adopted-subreaper   已收养（subreaper 不是 pid 1）：同上，只报告，**不**参与 --kill-suspects
//
// ⚠️ 为什么不把「父没了」当决定性判据：`bin/serve.sh` 用 nohup 起 A/B，父 shell 启动完就
//    退出了 —— 一对**正在被测试使用**的沙箱 A/B 看起来就是「父已被收养」。按它杀会打掉
//    别人正在跑的 s0b。所以 base/app 必须有更强的证据（目录没了 / 端口没人听 / 超过寿命上限）。
// ⚠️ 反过来也成立（2026-09-19）：父**还活着**时，上面那些"更强证据"同样不够 —— 活着的父
//    意味着这棵树现在有主。误杀的代价（打掉别人正在跑的沙箱）比漏杀的代价大，所以门开在
//    这一侧：宁可漏，不可误。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MIN_AGE_SECONDS = 60;
// 守卫的默认寿命上限是 20 分钟（test/sandbox-guard.mjs DEFAULT_LIFETIME_MS）。一个还活着的
// 沙箱进程超过 2× 上限，按构造就该是"逃出守卫"的残留。
const DEFAULT_MAX_AGE_SECONDS = 40 * 60;
const PRODUCTION_PORTS = new Set([7331, 7321]);
const SANDBOX_ENTRY_RE = /(?:^|[\\/])server[\\/](base|worker|app)\.mjs$/;

function parseArgs(argv) {
  const options = {
    apply: false,
    json: false,
    failOnFound: false,
    minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
    keepPids: new Set(),
    onlyPids: new Set(),
    verbose: false,
    killSuspects: false,
    dirReport: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--fail-on-found') options.failOnFound = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--kill-suspects') options.killSuspects = true;
    else if (arg === '--no-dir-report') options.dirReport = false;
    else if (arg === '--min-age-seconds') options.minAgeSeconds = Number(take());
    else if (arg === '--max-age-seconds') options.maxAgeSeconds = Number(take());
    else if (arg === '--keep-pid') for (const pid of take().split(',')) options.keepPids.add(Number(pid));
    else if (arg === '--only-pid') for (const pid of take().split(',')) options.onlyPids.add(Number(pid));
    else if (arg === '-h' || arg === '--help') { process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 30).join('\n') + '\n'); process.exit(0); }
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const isWindows = process.platform === 'win32';

function powershell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result.stdout ?? '';
}

/** pid -> { localPort, pids[] } for every listening socket. */
function listeners() {
  const byPid = new Map();
  const byPort = new Map();
  if (isWindows) {
    const raw = powershell('Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { "$($_.LocalPort)|$($_.OwningProcess)" }');
    for (const line of raw.split(/\r?\n/)) {
      const [port, pid] = line.trim().split('|');
      if (!port || !pid) continue;
      const key = Number(pid);
      if (!byPid.has(key)) byPid.set(key, []);
      byPid.get(key).push(Number(port));
      byPort.set(Number(port), key);
    }
    return { byPid, byPort };
  }
  const result = spawnSync('ss', ['-H', '-ltnp'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return { byPid, byPort };
  for (const line of String(result.stdout).split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const local = fields[3];
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!Number.isInteger(port)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1]);
      if (!byPid.has(pid)) byPid.set(pid, []);
      if (!byPid.get(pid).includes(port)) byPid.get(pid).push(port);
      byPort.set(port, pid);
    }
  }
  return { byPid, byPort };
}

/** The environment of a running pid, as far as this platform allows. */
function environOf(pid) {
  if (isWindows) return null;
  try {
    const raw = readFileSync(`/proc/${Number(pid)}/environ`, 'utf8');
    const env = {};
    for (const entry of raw.split('\0')) {
      const index = entry.indexOf('=');
      if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1);
    }
    return env;
  } catch {
    return null;
  }
}

const POSIX_HZ = 100; // Linux USER_HZ; /proc/<pid>/stat starttime is in these ticks.
const bootAgeSeconds = os.uptime();

// Windows command lines are a single string; split on spaces but honour double quotes.
// Backslash is a path separator here, so it is NOT an escape character.
function splitArgv(cmdline) {
  const argv = [];
  let current = '';
  let quoted = false;
  for (const ch of cmdline) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ' ' && !quoted) {
      if (current) argv.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) argv.push(current);
  return argv;
}

function snapshot() {
  const processes = [];
  if (isWindows) {
    const raw = powershell('Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $age = try { [int]((Get-Date) - $_.CreationDate).TotalSeconds } catch { -1 }; "$($_.ProcessId)`t$($_.ParentProcessId)`t$age`t$($_.CommandLine)" }');
    for (const line of raw.split(/\r?\n/)) {
      const parts = line.split('\t');
      if (parts.length < 4) continue;
      const cmdline = parts.slice(3).join('\t');
      processes.push({ pid: Number(parts[0]), ppid: Number(parts[1]), ageSeconds: Number(parts[2]), cmdline, argv: splitArgv(cmdline), env: null });
    }
    return processes;
  }
  let names = [];
  try {
    names = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return processes;
  }
  for (const name of names) {
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(after[1]);
      const startTicks = Number(after[19]);
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.length === 0) continue;
      processes.push({ pid, ppid, ageSeconds: Math.max(0, Math.round(bootAgeSeconds - startTicks / POSIX_HZ)), cmdline: argv.join(' '), argv, env: null });
    } catch {
      // The process exited between readdir and read; skip it.
    }
  }
  return processes;
}

// Adopters / subreapers. A process whose parent is one of these has lost its original parent
// chain; that is the ONLY situation in which this tool is willing to terminate anything
// (2026-09-19: it used to terminate a live sibling's worker whose parent was still running).
//   · pid 1 (init)
//   · `systemd --user` -- the adopter observed on this machine (PPid: 855)
//   · WSL's per-session `/init`
function isInitLike(process) {
  if (!process) return false;
  if (process.pid === 1) return true;
  return /^(?:init|systemd|systemd-shim)$/i.test(path.basename(process.argv?.[0] ?? ''));
}

function isSandboxPath(target) {
  const segments = path.resolve(target).split(/[\\/]+/).filter(Boolean);
  if (segments.includes('.sopho-wt')) return true;
  const tmp = path.resolve(os.tmpdir());
  const resolved = path.resolve(target);
  return resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`);
}

// A sandbox root is the script node is EXECUTING (`node <script>`), not merely a path that
// appears somewhere in a command line. Otherwise every process whose arguments mention an
// entry path -- `test/fixtures/sandbox-mini-harness.mjs --entry <...>/server/base.mjs`, an
// editor, a grep -- would be mistaken for a sandbox root. Observed live in this repo's own
// gate: the mini-harness was reported as a host.
const NODE_BASENAME_RE = /^node(?:\.exe)?$/i;
function entryOf(argv) {
  if (argv.length < 2) return null;
  // argv[0] is the image the kernel actually executed (with a shebang, the kernel puts the
  // interpreter there). A wrapper such as `timeout 900 env K=V node server/base.mjs` has
  // argv[0]='timeout': it is NOT the sandbox root, and counting it as one made the sweep
  // willing to kill the wrapper (found by the WSL verification agent). Only a real node
  // image counts.
  if (!NODE_BASENAME_RE.test(path.basename(argv[0]))) return null;
  for (let next = 1; next < argv.length; next += 1) {
    if (argv[next].startsWith('-')) continue;
    return SANDBOX_ENTRY_RE.test(argv[next]) ? argv[next] : null;
  }
  return null;
}

function envGet(env, keys) {
  if (!env) return null;
  for (const key of keys) if (env[key]) return env[key];
  return null;
}

function declaredPorts(env) {
  if (!env) return [];
  const ports = [];
  for (const key of ['SOPHO_PORT', 'SOPHO_APP_PORT', 'SOPHO_BASE_PORT']) {
    const value = Number(env[key]);
    if (Number.isInteger(value) && value > 0) ports.push({ key, port: value });
  }
  return ports;
}

function classify(candidate, table, listenerIndex) {
  const entry = entryOf(candidate.argv);
  if (!entry) return null;
  const kindToken = SANDBOX_ENTRY_RE.exec(entry)[1];
  const kind = kindToken === 'base' ? 'host' : kindToken;
  const entryDir = path.dirname(entry);
  const env = candidate.env ?? environOf(candidate.pid);
  const home = envGet(env, ['ASSIST_HOME', 'PI_CODING_AGENT_DIR', 'SOPHO_AGENT_DIR']);
  const ports = declaredPorts(env);
  const listening = listenerIndex.byPid.get(candidate.pid) ?? [];
  const ageSeconds = candidate.ageSeconds;

  const record = {
    pid: candidate.pid,
    kind,
    entry,
    cmdline: candidate.cmdline,
    ppid: candidate.ppid,
    parent: table.get(candidate.ppid)?.cmdline ? { pid: candidate.ppid, cmdline: table.get(candidate.ppid).cmdline } : null,
    ageSeconds,
    home,
    declaredPorts: ports,
    listeningPorts: listening,
    sandboxLooking: path.isAbsolute(entry) && isSandboxPath(entryDir),
    protected: null,
    orphan: false,
    reasons: [],
    notes: [],
  };

  if (options.keepPids.has(candidate.pid)) {
    record.protected = 'keep-pid';
    return record;
  }
  if (!path.isAbsolute(entry)) {
    // A relative entry (`node server/base.mjs` with an unknown cwd) cannot be located, so it
    // can neither be proven a sandbox nor have its directory tested. Refuse.
    record.protected = 'relative-entry';
    return record;
  }
  if (!record.sandboxLooking) {
    record.protected = 'not-a-sandbox-path';
    return record;
  }
  if (listening.some((port) => PRODUCTION_PORTS.has(port)) || ports.some(({ port }) => PRODUCTION_PORTS.has(port))) {
    record.protected = 'production-port';
    return record;
  }
  if (home && /(?:^|[\\/])\.pi[\\/]profiles(?:[\\/]|$)/.test(home)) {
    record.protected = 'production-profile';
    return record;
  }

  const entryDirExists = existsSync(entryDir);
  // "The parent is a live host" must use the SAME precise rule as classification -- the
  // script the parent is executing -- not a regex over the whole command line. A relative
  // entry (`node server/base.mjs`, which is how the live deployment starts A) has a space
  // before `server`, and a naive `(^|[\\/])server[\\/]base\.mjs` therefore says "no host":
  // the worker was then judged `host-gone` and `--apply` killed a live worker of a live
  // host. Found by the WSL verification agent, kept as test/sandbox-hygiene.mjs
  // case `sweep-relative-parent`.
  const parentCandidate = table.get(candidate.ppid);
  const parentEntry = parentCandidate ? entryOf(parentCandidate.argv) : null;
  const parentIsLiveHost = kind === 'worker' && parentCandidate !== undefined && parentEntry !== null && /server[\\/]base\.mjs$/.test(parentEntry);
  const oldEnough = ageSeconds >= options.minAgeSeconds;
  // ── 收养前置门（2026-09-19）────────────────────────────────────────────────
  // Only a process whose original parent chain is GONE is an orphan. If the parent is alive
  // this process currently has an owner, so it is never a decisive orphan -- not even when
  // its entry directory has been deleted. That misjudgment killed a live sibling's
  // generation worker (pid 102969) on this machine while its host (its parent, pid 102957)
  // was still running. See the header for the raw log.
  //
  // Two strengthens are needed for "the parent chain is gone", and they are deliberately NOT
  // the same variable:
  //   · adopted            -- permission to terminate at all: pid 1, any init/subreaper
  //                           (`systemd --user`, WSL's `/init`), or a ppid that is not in the
  //                           process table any more.
  //   · parentChainVanished -- the NARROWER set that `escaped-lifetime-cap` (age alone) may use:
  //                           pid 1 / no parent at all. A 40-minute-old sandbox that was
  //                           `nohup`-ed by `bin/serve.sh` and adopted by `systemd --user` is
  //                           indistinguishable from a live sibling (that is the documented
  //                           nohup trap), so age alone must not kill it.
  const parentChainVanished = candidate.ppid <= 0 || candidate.ppid === 1 || parentCandidate === undefined;
  const adopted = parentChainVanished || isInitLike(parentCandidate);
  const parentDescr = parentCandidate
    ? `pid=${parentCandidate.pid} (${JSON.stringify(parentCandidate.cmdline.slice(0, 160))})`
    : `pid=${candidate.ppid} (no longer in the process table)`;
  if (!adopted) {
    if (!entryDirExists) {
      record.reasons.push('entry-dir-missing-parent-alive');
      record.notes.push(`entry dir ${entryDir} no longer exists (worktree deleted?) but the parent is alive`);
    }
    if (kind === 'worker' && !parentIsLiveHost) {
      record.reasons.push('worker-parent-not-host');
      record.notes.push(`parent ${parentDescr} is alive but is not server/base.mjs`);
    }
    if (kind !== 'worker' && ports.length > 0) {
      const unlistened = ports.filter(({ port }) => !listening.includes(port));
      if (unlistened.length === ports.length && oldEnough) {
        record.reasons.push('port-not-listening-parent-alive');
        record.notes.push(`declared ${ports.map(({ key, port }) => `${key}=${port}`).join(',')} but listens on ${listening.length ? listening.join(',') : 'nothing'} while the parent is alive`);
      }
    }
    if (record.reasons.length > 0) {
      // Refused out loud: the operator must be able to see which pid was left alone and why,
      // and that its parent is a live process. Nothing here can ever reach `--apply`.
      record.refusedLiveParent = true;
      record.reasons.unshift('parent-alive');
      record.notes.push(`SKIP: this pid belongs to a live parent chain --> ${parentDescr}; a tree whose parent is alive is in use and is NEVER killed (not even with --kill-suspects)`);
    }
    return record;
  }

  // ── 已收养（原本的父链不在）：下面才是决定性孤儿判据 ──────────────────────
  if (!entryDirExists) {
    record.orphan = true;
    record.reasons.push('entry-dir-missing');
    record.notes.push(`entry dir ${entryDir} no longer exists (worktree deleted?) and the parent chain is gone`);
  }
  if (kind === 'worker' && !parentIsLiveHost) {
    record.orphan = true;
    record.reasons.push('host-gone');
    record.notes.push(`parent ${parentDescr} is not a live server/base.mjs and this worker has been re-parented`);
  }
  if (kind !== 'worker' && ports.length > 0) {
    const unlistened = ports.filter(({ port }) => !listening.includes(port));
    if (unlistened.length === ports.length && oldEnough) {
      record.orphan = true;
      record.reasons.push('port-not-listening');
      record.notes.push(`declared ${ports.map(({ key, port }) => `${key}=${port}`).join(',')} but listens on ${listening.length ? listening.join(',') : 'nothing'}`);
    }
  }
  if (parentChainVanished && ageSeconds > options.maxAgeSeconds) {
    record.orphan = true;
    record.reasons.push('escaped-lifetime-cap');
    record.notes.push(`parent chain vanished (${parentDescr}) and age ${ageSeconds}s > max-age ${options.maxAgeSeconds}s (the guard's lifetime cap should have killed it)`);
  }
  if (!record.orphan && candidate.ppid === 1) {
    record.reasons.push('parent-gone');
    record.notes.push('parent is init; base/app may legitimately be nohup-ed (bin/serve.sh), so this alone is not decisive');
  } else if (!record.orphan) {
    // Adopted by a subreaper (or a ppid that is off the process table). Same reasoning as
    // `parent-gone`, kept as its own code on purpose: --kill-suspects escalates `parent-gone`
    // only, so widening that reach (e.g. to every `systemd --user`-adopted nohup'ed sandbox)
    // would have to be a deliberate act.
    record.reasons.push('adopted-subreaper');
    record.notes.push(`adopted by ${parentDescr}; that alone is not decisive (bin/serve.sh nohups live sandboxes), so this is reported and never escalated`);
  }
  if (!record.orphan && candidate.ppid === 1 && !oldEnough) {
    record.reasons.push('young');
    record.notes.push(`age ${ageSeconds}s < min-age ${options.minAgeSeconds}s; not judged yet`);
  }
  if (!entryDirExists) {
    // Also report what it listens on, so an operator can confirm the tree is gone after apply.
    record.notes.push(`listening: ${listening.length ? listening.join(',') : 'none'}`);
  }
  return record;
}

// ── candidate ②: browser trees, recognised ONLY by a sandbox profile path ──────────────────
// See the header for why the process NAME may not be used (35 `headless` processes on this
// machine are the user's own). Two spellings cover every browser gate in this repo:
//   `--user-data-dir=<tmp>/…` (chromium and its subprocesses) and Firefox's `--profile <tmp>/…`.
// The value must resolve to a path UNDER os.tmpdir(): that is the sandbox shape. A user's own
// browser names `~/.local/share/Steam/…`, `~/.config/Code`, or no profile flag at all, so it
// cannot match -- and neither can `/tmp/org.chromium.Chromium.*` (those are Chromium's own
// throwaway dirs, created from inside the process, never passed on a command line).
// Detection runs on the command-line TEXT, not on individual argv entries, because a browser
// may rewrite its own argv: on this machine every chromium process reports `/proc/<pid>/cmdline`
// as ONE entry holding the whole command line (`/usr/lib/chromium/chromium --headless=new …
// --user-data-dir=/tmp/sopho-ui-xxxx/chromium …`), with no NUL between the flags. Matching on
// the text sees both spellings (`--user-data-dir=<dir>` and Firefox's `--profile <dir>`) and
// both shapes (split argv and the rewritten blob).
const PROFILE_FLAG_RE = /(?:^|\s)(--(?:user-data-dir|disk-cache-dir|crash-dumps-dir|profile))(?:\s+|=)("[^"]*"|\S+)/g;
const DEBUG_PORT_FLAG_RE = /(?:^|\s)--remote-debugging-port=(\d+)/;

function sandboxProfileOf(cmdline) {
  const tmp = path.resolve(os.tmpdir());
  const text = String(cmdline ?? '');
  PROFILE_FLAG_RE.lastIndex = 0;
  for (let match = PROFILE_FLAG_RE.exec(text); match !== null; match = PROFILE_FLAG_RE.exec(text)) {
    const value = match[2].replace(/^"|"$/g, '');
    if (!value || value.startsWith('-')) continue;
    const profileDir = path.resolve(value);
    if (profileDir === tmp || !profileDir.startsWith(`${tmp}${path.sep}`)) continue;
    return { profileDir, flag: match[1] };
  }
  return null;
}

function declaredDebugPort(cmdline) {
  const match = DEBUG_PORT_FLAG_RE.exec(String(cmdline ?? ''));
  return match ? Number(match[1]) : null;
}

// One record per marked process. Only the tree ROOT (the process whose parent does not carry the
// same profile path) is ever a target: the members' parents are the root itself, so they are
// refused as `browser-tree-member` and show up only under --verbose. Killing children one by one
// while the browser is alive would be theatre -- the root owns the tree.
function classifyBrowser(candidate, table, listenerIndex, treeSize) {
  const marker = sandboxProfileOf(candidate.cmdline);
  if (!marker) return null;
  const parentCandidate = table.get(candidate.ppid);
  const parentMarker = parentCandidate ? sandboxProfileOf(parentCandidate.cmdline) : null;
  const isTreeRoot = !parentMarker || parentMarker.profileDir !== marker.profileDir;
  const env = candidate.env ?? environOf(candidate.pid);
  const home = envGet(env, ['ASSIST_HOME', 'PI_CODING_AGENT_DIR', 'SOPHO_AGENT_DIR']);
  const debugPort = declaredDebugPort(candidate.cmdline);
  const listening = listenerIndex.byPid.get(candidate.pid) ?? [];
  const record = {
    pid: candidate.pid,
    kind: 'browser',
    entry: marker.profileDir,
    profileDir: marker.profileDir,
    profileFlag: marker.flag,
    treeRoot: isTreeRoot,
    treeSize,
    debugPort,
    cmdline: candidate.cmdline,
    ppid: candidate.ppid,
    parent: parentCandidate?.cmdline ? { pid: candidate.ppid, cmdline: parentCandidate.cmdline } : null,
    ageSeconds: candidate.ageSeconds,
    home,
    declaredPorts: debugPort ? [{ key: '--remote-debugging-port', port: debugPort }] : [],
    listeningPorts: listening,
    sandboxLooking: true,
    protected: null,
    orphan: false,
    reasons: [],
    notes: [],
  };

  if (options.keepPids.has(candidate.pid)) {
    record.protected = 'keep-pid';
    return record;
  }
  if (listening.some((port) => PRODUCTION_PORTS.has(port)) || PRODUCTION_PORTS.has(debugPort)) {
    record.protected = 'production-port';
    return record;
  }
  if (home && /(?:^|[\\/])\.pi[\\/]profiles(?:[\\/]|$)/.test(home)) {
    record.protected = 'production-profile';
    return record;
  }
  if (!isTreeRoot) {
    record.protected = 'browser-tree-member';
    record.notes.push(`member of the browser tree rooted at profile ${marker.profileDir} (${treeSize} process(es) share it); the root is the target, a member never is`);
    return record;
  }

  // Same adoption gate as the node sandbox roots: a live parent chain means the tree is in use.
  const parentCandidateExists = parentCandidate !== undefined;
  const parentChainVanished = candidate.ppid <= 0 || candidate.ppid === 1 || !parentCandidateExists;
  const adopted = parentChainVanished || isInitLike(parentCandidate);
  const parentDescr = parentCandidate
    ? `pid=${parentCandidate.pid} (${JSON.stringify(parentCandidate.cmdline.slice(0, 160))})`
    : `pid=${candidate.ppid} (no longer in the process table)`;
  const oldEnough = candidate.ageSeconds >= options.minAgeSeconds;
  const profileDirExists = existsSync(marker.profileDir);
  const portUnlistened = debugPort !== null && !listening.includes(debugPort);

  if (!adopted) {
    if (!profileDirExists) {
      record.reasons.push('profile-dir-missing-parent-alive');
      record.notes.push(`sandbox profile ${marker.profileDir} no longer exists but the parent is alive`);
    }
    if (portUnlistened && oldEnough) {
      record.reasons.push('debug-port-not-listening-parent-alive');
      record.notes.push(`declares --remote-debugging-port=${debugPort} but listens on ${listening.length ? listening.join(',') : 'nothing'} while the parent is alive`);
    }
    if (record.reasons.length > 0) {
      record.refusedLiveParent = true;
      record.reasons.unshift('parent-alive');
      record.notes.push(`SKIP: this browser tree belongs to a live parent chain --> ${parentDescr}; a tree whose parent is alive is in use and is NEVER killed (not even with --kill-suspects)`);
    }
    return record;
  }

  if (!profileDirExists) {
    record.orphan = true;
    record.reasons.push('profile-dir-missing');
    record.notes.push(`sandbox profile ${marker.profileDir} is gone and the parent chain is gone`);
  }
  if (portUnlistened && oldEnough) {
    record.orphan = true;
    record.reasons.push('debug-port-not-listening');
    record.notes.push(`declares --remote-debugging-port=${debugPort} but listens on ${listening.length ? listening.join(',') : 'nothing'}`);
  }
  if (parentChainVanished && candidate.ageSeconds > options.maxAgeSeconds) {
    record.orphan = true;
    record.reasons.push('escaped-lifetime-cap');
    record.notes.push(`parent chain vanished (${parentDescr}) and age ${candidate.ageSeconds}s > max-age ${options.maxAgeSeconds}s`);
  }
  if (!record.orphan && candidate.ppid === 1) {
    record.reasons.push('parent-gone');
    record.notes.push('parent is init; reported and left alone unless --kill-suspects is given');
  } else if (!record.orphan) {
    record.reasons.push('adopted-subreaper');
    record.notes.push(`adopted by ${parentDescr}; that alone is not decisive, so this is reported and never escalated`);
  }
  return record;
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Is this pid's parent chain gone RIGHT NOW? (Fresh snapshot: never kill on stale evidence.) */
function adoptedNow(pid) {
  const fresh = new Map(snapshot().map((process) => [process.pid, process]));
  const self = fresh.get(pid);
  if (!self) return false;
  const parent = fresh.get(self.ppid);
  return self.ppid <= 0 || parent === undefined || isInitLike(parent);
}

async function terminate(record, graceMs = 5000) {
  // Re-verify immediately before killing: the cmdline must still carry the entry we
  // judged. Never kill on stale evidence. For a browser tree the "entry" is the sandbox
  // profile directory, so the same rule reads: the command line must still name it.
  const stillEntry = isWindows
    ? powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId = ${record.pid}" -ErrorAction SilentlyContinue).CommandLine`).trim()
    : (() => { try { return readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { return ''; } })();
  if (!stillEntry.includes(record.entry)) {
    return { pid: record.pid, action: 'skipped', detail: `cmdline changed or process gone (cmdline=${JSON.stringify(stillEntry.slice(0, 160))})` };
  }
  // Second re-verify, and the one this tool got wrong on 2026-09-19: the process must STILL
  // have lost its parent chain. If a parent turned up -- or an older caller handed us a
  // record judged before the adoption gate existed -- refuse.
  if (!adoptedNow(record.pid)) {
    return { pid: record.pid, action: 'skipped', detail: 'refused: its parent chain is alive at kill time (only adopted orphans may be terminated)' };
  }
  killPid(record.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && alive(record.pid)) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive(record.pid)) {
    killPid(record.pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { pid: record.pid, action: alive(record.pid) ? 'failed' : 'terminated', signal: 'SIGTERM+SIGKILL' };
}

const table = new Map();
const processes = snapshot();
for (const process of processes) table.set(process.pid, process);
const listenerIndex = listeners();

// How many processes share each sandbox profile path: that is the size of a browser tree, and
// it is printed so an operator can see "10 processes / the one tree" instead of ten rows.
const browserTrees = new Map();
for (const process of processes) {
  const marker = sandboxProfileOf(process.cmdline);
  if (!marker) continue;
  if (!browserTrees.has(marker.profileDir)) browserTrees.set(marker.profileDir, []);
  browserTrees.get(marker.profileDir).push(process.pid);
}

const records = processes.map((process) => classify(process, table, listenerIndex) ?? classifyBrowser(process, table, listenerIndex, browserTrees.get(sandboxProfileOf(process.cmdline)?.profileDir)?.length ?? 1)).filter(Boolean);
const protectedRecords = records.filter((record) => record.protected);
const orphans = records.filter((record) => record.orphan);
const suspects = records.filter((record) => !record.orphan && !record.protected && record.reasons.length > 0);
const refusedLiveParent = records.filter((record) => record.refusedLiveParent);
// `--only-pid` says which pids this run may terminate; everything else is reported only. The
// sweep is a MACHINE-WIDE scan and other sessions' sandboxes live on the same box.
const inOnlyPidScope = (record) => options.onlyPids.size === 0 || options.onlyPids.has(record.pid);

// ── read-only: sandbox DIRECTORIES that no live process is using any more ────────────────
// Reports a number; never deletes anything (this tool has no directory deletion at all).
// The prefixes are DERIVED from the gates themselves (every gate names its sandbox with
// `mkdtemp(path.join(os.tmpdir(), '<prefix>'))` or a `--work` dir under the temp dir), so a
// new gate's directories are counted without anybody updating a list here. That derivation is
// also what keeps the USER's own temporaries out: `/tmp/org.chromium.Chromium.*` (1518 of them
// on this machine) is created from inside Chromium, not by any gate, so no derived prefix
// matches it.
// 口径（2026-09-28 扩面；机械规矩钉在 `test/sandbox-hygiene.mjs` 的 `sweep-dir-prefixes` 臂）：
//   · **临时根**必须**就地**写出 `os.tmpdir()`，或就地出现 `TMPDIR` / `TEMP` / `'/tmp'`
//     （artifact 目录的 `process.env.TEMP || process.env.TMPDIR || os.tmpdir()` 正是这样）。
//     以前只认字面量 `os.tmpdir()` ⇒ `/tmp/sopho-designer-ui`、`/tmp/sopho-design-edit`、
//     `/tmp/sopho-design-spec`、`/tmp/sopho-live-segments` 这些**真躺在 /tmp 里**的残留
//     一格都数不到（本机 2026-09-28 实测：前三个目录存在，108 / 8 / 18 个文件）。
//     ⚠️ 故意**不**追 `const TMP = os.tmpdir()` 这种别名：那样会把本门自己的探针
//     （`test/sandbox-hygiene.mjs` 里 `const tmp = os.tmpdir()` + `path.join(tmp, …)`）
//     也吸进推导集，`org.chromium.Chromium.hygiene-` 这种**用户形状**的前缀一进集合，
//     用户自己的 Chromium 临时目录就会被算成门的残留 —— 那正是要挡住的事。
//   · **前缀表达式**可以是字面量、模板（截到第一个 `${`）、同文件的 `const NAME = '<字面量>'`，
//     也可以是**更复杂的表达式** —— 那就把里面每一个字符串/模板字面量都当候选
//     （`test/wt-reclaim.mjs` 的 `ONLY_ARM ? `wtreclaim-arm-${ONLY_ARM}-` : 'wtreclaim-gate-'`
//     是两格前缀，以前只认「紧跟逗号的那个字面量」时整格漏掉）。
//   · 依旧**不硬编码任何名字**：新门只要照这个形状写，它的目录就会被数进去。
/** 从 `open` 处的 `(` 开始，按平衡括号 + 引号切出调用实参（顶层逗号分隔）。 */
function callArgumentTexts(source, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
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

// A temp root must be written out IN PLACE: the text mentions os.tmpdir()/TMPDIR/TEMP//tmp --
// NOT the exact call `path.join(os.tmpdir(), …)` the old derivation demanded, and deliberately
// not a same-file alias (see the note above: aliases drag this gate's own decoy probes in).
const TMP_ROOT_RE = /os\.tmpdir\(\)|TMPDIR|\bTEMP\b|['"`]\/tmp['"`]/;
const BARE_IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const STRING_LITERAL_RE = /'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g;

function sandboxDirPrefixes() {
  const prefixes = new Set();
  const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test');
  // A template prefix (`sopho-a29-footprint-${label}-`) is cut at the first interpolation:
  // everything before it is still a real prefix of the directory that gets created.
  const addPrefix = (raw) => {
    if (typeof raw !== 'string') return;
    const prefix = raw.split('$')[0];
    if (prefix.length >= 3 && !prefix.includes('/') && !prefix.includes('\\')) prefixes.add(prefix);
  };
  const walk = (directory, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.name.endsWith('.mjs')) continue;
      let source = '';
      try { source = readFileSync(full, 'utf8'); } catch { continue; }
      // Same-file constants, kept so a prefix written as a constant resolves: `6706b70`
      // moved `sopho-ui-` into `export const SANDBOX_PREFIX = 'sopho-ui-'` and the old
      // literal-only derivation lost it on the spot -> `sweep-stale-dirs`'s
      // `hasSophoUiPrefix:false` went red.
      const constants = new Map();
      for (const declaration of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
        if (!constants.has(declaration[1])) constants.set(declaration[1], declaration[2]);
      }
      const isTempRoot = (expr) => TMP_ROOT_RE.test(expr.trim());
      for (const join of source.matchAll(/path\.join\s*\(/g)) {
        const args = callArgumentTexts(source, join.index + join[0].length - 1);
        if (args === null || args.length < 2) continue;
        if (!isTempRoot(args[0])) continue;
        const second = args[1].trim();
        if (BARE_IDENT_RE.test(second)) {
          // A prefix written as a same-file constant: resolve it, but only when the binding
          // really STARTS with a string literal.
          const binding = constants.get(second);
          const literal = typeof binding === 'string' ? binding.match(/^\s*['"`]([^'"`]+)['"`]/) : null;
          if (literal) addPrefix(literal[1]);
          continue;
        }
        // A complex expression (ternary / concatenation): every literal inside it is a candidate
        // prefix -- `ONLY_ARM ? \`wtreclaim-arm-${ONLY_ARM}-\` : 'wtreclaim-gate-'` is two
        // prefixes in one expression, and the literal-only rule dropped the whole cell.
        for (const literal of second.matchAll(STRING_LITERAL_RE)) addPrefix(literal[1] ?? literal[2] ?? literal[3]);
      }
    }
  };
  try { walk(testDir, 0); } catch {}
  return prefixes;
}

const DIR_REPORT_ENTRY_CAP = 200_000;
const DIR_REPORT_DIR_CAP = 600;

function sandboxDirUsage(prefixes, livePaths, cmdlines) {
  const tmp = path.resolve(os.tmpdir());
  const counted = [];
  let bytes = 0;
  let entriesScanned = 0;
  let truncated = false;
  // "In use" evidence, both cheap and read-only: the sandbox is an ancestor of a path a live
  // process was given on its command line (gates pass `--facts <sandbox>/…`, browsers name
  // `<sandbox>/chromium`), or it is one of the paths a classified record names directly.
  const insideLive = (target) => [...livePaths].some((live) => live === target || live.startsWith(`${target}${path.sep}`) || target.startsWith(`${live}${path.sep}`))
    || cmdlines.some((cmdline) => cmdline.includes(`${target}${path.sep}`));
  const sizeOf = (directory) => {
    let total = 0;
    const stack = [directory];
    while (stack.length > 0) {
      const current = stack.pop();
      let list = [];
      try { list = readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of list) {
        if (entriesScanned >= DIR_REPORT_ENTRY_CAP) { truncated = true; return total; }
        entriesScanned += 1;
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) { try { total += statSync(full).size; } catch {} }
      }
    }
    return total;
  };
  let candidates = [];
  try { candidates = readdirSync(tmp, { withFileTypes: true }); } catch { return { count: 0, bytes: 0, prefixes: [...prefixes].sort(), entriesScanned: 0, truncated: false, dirs: [], note: 'could not read the temp dir' }; }
  for (const entry of candidates) {
    if (counted.length >= DIR_REPORT_DIR_CAP) { truncated = true; break; }
    if (!entry.isDirectory()) continue;
    if (![...prefixes].some((prefix) => entry.name.startsWith(prefix))) continue;
    const full = path.join(tmp, entry.name);
    if (insideLive(full)) continue;
    counted.push(full);
    bytes += sizeOf(full);
  }
  return { count: counted.length, bytes, prefixes: [...prefixes].sort(), entriesScanned, truncated, dirs: counted.sort(),
    note: 'attribution is by directory-name prefix only (derived from test/): a sandbox whose owner names none of its paths on its command line (the gate doing the scanning, for instance) can still be counted. This is a report; nothing here is ever deleted.' };
}

// Paths a live sandbox is using right now: the browser profiles themselves, their parent
// (the mkdtemp directory), each node sandbox's declared home, and its entry directory's
// parent. A directory on this list is in use, so it is never called stale.
function liveSandboxPaths(records) {
  const live = new Set();
  const tmp = path.resolve(os.tmpdir());
  const underTmp = (value) => typeof value === 'string' && value.startsWith(`${tmp}${path.sep}`);
  for (const record of records) {
    if (record.profileDir) {
      if (underTmp(record.profileDir)) live.add(record.profileDir);
      const parent = path.dirname(record.profileDir);
      if (underTmp(parent)) live.add(parent);
    }
    if (record.home) { const parent = path.dirname(record.home); if (underTmp(parent)) live.add(parent); }
    if (record.entry && /server[\\/](?:base|worker|app)\.mjs$/.test(record.entry)) {
      const sandboxRoot = path.dirname(path.dirname(record.entry));
      if (underTmp(sandboxRoot)) live.add(sandboxRoot);
    }
  }
  return live;
}

const dirReport = options.dirReport
  ? sandboxDirUsage(sandboxDirPrefixes(), liveSandboxPaths(records), processes.map((process) => process.cmdline))
  : { skipped: true };

// Each browser tree as one row: the profile path it was recognised by, how many processes carry
// it, which of them is the root, and the root's full record. The members are listed by pid only --
// they are never targets (their parent is the root, and the root owns the tree).
const browserTreeReport = [...browserTrees].map(([profileDir, pids]) => {
  const treeRecords = records.filter((record) => record.kind === 'browser' && record.profileDir === profileDir);
  const root = treeRecords.find((record) => record.treeRoot) ?? null;
  return {
    profileDir,
    processCount: pids.length,
    rootPid: root?.pid ?? null,
    memberPids: treeRecords.filter((record) => !record.treeRoot).map((record) => record.pid),
    rootRecord: root,
  };
});

const report = {
  mode: options.apply ? 'apply' : 'dry-run',
  scanned: processes.length,
  candidates: records.length,
  nodeCandidates: records.filter((record) => record.kind !== 'browser').length,
  browserCandidates: records.filter((record) => record.kind === 'browser').length,
  browserTrees: browserTreeReport,
  staleSandboxDirs: dirReport,
  minAgeSeconds: options.minAgeSeconds,
  maxAgeSeconds: options.maxAgeSeconds,
  orphans,
  suspects,
  protected: protectedRecords,
  // "who I would kill / who I refuse and why" -- the point of the default dry-run.
  wouldKill: options.apply ? [] : orphans.filter(inOnlyPidScope).map((record) => ({ pid: record.pid, kind: record.kind, reasons: record.reasons })),
  outOfOnlyPidScope: orphans.filter((record) => !inOnlyPidScope(record)).map((record) => record.pid),
  refusedLiveParent: refusedLiveParent.map((record) => ({
    pid: record.pid,
    kind: record.kind,
    parentPid: record.ppid,
    parentCmdline: record.parent?.cmdline ?? null,
    reasons: record.reasons.filter((reason) => reason !== 'parent-alive'),
    notes: record.notes,
  })),
  actions: [],
};

if (options.apply) {
  // `--kill-suspects` is the loud, opt-in escalation. Only suspects that carry a real
  // orphan signal (`parent-gone`) are eligible; `young` on its own is never enough.
  const suspectsToKill = options.killSuspects ? suspects.filter((record) => record.reasons.includes('parent-gone') && !record.refusedLiveParent) : [];
  if (suspectsToKill.length > 0 && !options.json) {
    process.stdout.write(`sandbox-sweep: --kill-suspects given, escalating ${suspectsToKill.length} suspect(s) to termination\n`);
  }
  for (const record of [...orphans, ...suspectsToKill]) {
    if (!inOnlyPidScope(record)) {
      // Say it out loud instead of silently dropping it: on a shared machine the orphans of
      // ANOTHER session are in this list, and they are not ours to kill.
      report.actions.push({ pid: record.pid, action: 'skipped', detail: 'out of --only-pid scope (reported, not touched)', entry: record.entry, reasons: record.reasons, verdict: record.orphan ? 'orphan' : 'suspect' });
      continue;
    }
    report.actions.push({ ...(await terminate(record)), entry: record.entry, reasons: record.reasons, verdict: record.orphan ? 'orphan' : 'suspect' });
  }
}

const fmt = (record) => [
  `pid=${record.pid}`,
  `kind=${record.kind}`,
  `ppid=${record.ppid}`,
  `age=${record.ageSeconds}s`,
  `listen=${record.listeningPorts.length ? record.listeningPorts.join(',') : '-'}`,
  `reasons=${record.reasons.join(',') || '-'}`,
].join(' ');

if (options.json) {
  // Exactly ONE JSON document per run, whichever mode: consumers must be able to parse the
  // whole stdout. (Two objects used to be printed in apply mode, which broke the gate.)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`sandbox-sweep: scanned ${processes.length} processes, ${report.candidates} sandbox-shaped candidates (${report.nodeCandidates} host/worker/app roots, ${report.browserCandidates} browser-tree processes in ${report.browserTrees.length} tree(s))\n`);
  for (const record of orphans) process.stdout.write(`ORPHAN  ${fmt(record)}\n        entry=${record.entry}\n        ${record.notes.join('\n        ')}\n`);
  for (const record of suspects) process.stdout.write(`SUSPECT ${fmt(record)}\n        entry=${record.entry}\n        ${record.notes.join('\n        ')}\n`);
  if (options.verbose) for (const record of protectedRecords) process.stdout.write(`PROTECTED ${fmt(record)} protected=${record.protected} entry=${record.entry}\n`);
  for (const action of report.actions) process.stdout.write(`APPLY ${action.action} pid=${action.pid} verdict=${action.verdict}${action.detail ? ` (${action.detail})` : ''} entry=${action.entry}\n`);
  process.stdout.write(`sandbox-sweep: ${orphans.length} orphan(s), ${suspects.length} suspect(s), ${protectedRecords.length} protected, mode=${report.mode}\n`);
  if (options.dirReport) {
    const usage = report.staleSandboxDirs;
    process.stdout.write(`sandbox-sweep: stale sandbox DIRECTORIES (read-only, never deleted): ${usage.count} dir(s), ${usage.bytes} byte(s)${usage.truncated ? ' (lower bound: scan capped)' : ''} -- prefixes derived from test/: ${usage.prefixes.join(' ')}\n`);
  }
  if (report.browserTrees.length > 0) {
    for (const tree of report.browserTrees) process.stdout.write(`sandbox-sweep: browser tree ${tree.profileDir} -- ${tree.processCount} process(es), root pid=${tree.rootPid ?? '-'}\n`);
  }
  if (!options.apply) {
    const scoped = orphans.filter(inOnlyPidScope);
    process.stdout.write(`sandbox-sweep: dry-run: WOULD TERM ${scoped.length} pid(s) by exact pid: ${scoped.map((record) => record.pid).join(',') || '-'} (cmdline + adoption re-checked at kill time)\n`);
    if (options.onlyPids.size > 0 && report.outOfOnlyPidScope.length > 0) {
      process.stdout.write(`sandbox-sweep: dry-run: SKIP ${report.outOfOnlyPidScope.join(',')} -- orphan(s) but outside --only-pid scope\n`);
    }
    for (const record of refusedLiveParent) {
      process.stdout.write(`sandbox-sweep: dry-run: SKIP pid=${record.pid} (${record.kind}) -- its parent pid=${record.ppid} is ALIVE (${JSON.stringify((record.parent?.cmdline ?? '').slice(0, 120))}); refused: ${record.reasons.join(',')}\n`);
    }
    if (orphans.length > 0 && scoped.length > 0) {
      process.stdout.write(`sandbox-sweep: dry-run only. Re-run with --apply to TERM these ${scoped.length} pid(s) (exact pid, cmdline re-checked).\n`);
    }
  }
}

const failed = report.actions.filter((action) => action.action === 'failed').length;
const survivors = report.actions.filter((action) => action.action !== 'skipped' && alive(action.pid)).length;
// ── 出口：**绝不** `process.exit(...)`（反证臂 `--reverse-arm=exit-truncates-pipe` 改的就是这一行）──
// 2026-09-27 实测（`test/sandbox-hygiene.mjs` 的 `old-spawn-no-guard` 一直在红的那条）：
//   · `node bin/sandbox-sweep.mjs --dry-run --json > 文件`   ⇒ 221053 字节，且能解析
//   · 同一份输出 `... --json | wc -c`                         ⇒ **131072**（＝ 2 × 64 KiB）
//   · 同一份输出被门的 `execFile` 读（也是管道）                ⇒ **146176**，JSON 停在半截
// 合成对照：`node -e "process.stdout.write('x'.repeat(N)); process.exit(0)" | wc -c` ⇒ N=131072 一个字节
// 不少，N=200000 / 1000000 只到 131072。差别就在管道：POSIX 上 stdout 接**管道**时写入是**异步**的，
// 而 `process.exit()` 立刻掐掉事件循环 ⇒ 还没冲进管道缓冲区的那一截**静默丢掉**。到多少字节取决于
// 读端多快（131072 / 146176 就是这么来的），但**总归到不齐**。`--json` 的契约（见上面那段）是
// 「每次恰好一份可解析的 JSON 文档」，这份输出却停在半截（实测断在一个 browser 记录的 `"cmdline": `
// 中间）——
// 消费方（门用 `execFile`，也就是管道）解析不出来，于是 `orphans` 被当成空集，一条**真孤儿**
// 看起来就是「没被认出来」。这正是本工具最不该有的形状：**只读报告，看不见＝没有**。
// 改法：只设 `process.exitCode`，让 node 自己把 stdout 冲干净再退 —— 本脚本不留任何句柄
// （没有 server / interval，`spawnSync` 也不留），所以天然退出，不会悬挂。
const exitCode = options.apply
  ? (failed > 0 || survivors > 0 ? 1 : 0)
  : (options.failOnFound && orphans.length > 0 ? 1 : 0);
// 反证臂 `--reverse-arm=exit-truncates-pipe`（test/sandbox-hygiene.mjs）把这一行改回旧行为
// `process.exit(exitCode);` ⇒ 那条红必须复现。接缝就这一行，逐字。
process.exitCode = exitCode;
