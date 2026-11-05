#!/usr/bin/env node
// test/serve-app-host.mjs —— 机械门：`bin/serve.sh` 的 **B（app）宿主默认值**真的绑在 `0.0.0.0` 上。
//
// 为什么要有它（业主 2026-09-23 裁定，`5681dcf`）：那一行原来是
//   `APP_HOST=${SOPHO_APP_HOST:-${SOPHO_HOST:-0.0.0.0}}`
// —— 没给 `SOPHO_APP_HOST` 时**继承 A 的宿主**，而 A 的默认是 `127.0.0.1` ⇒ 裸 `npm run serve`
// 起的 B 只绑回环，arc 上「网页连不上」。改成 `${SOPHO_APP_HOST:-0.0.0.0}` 后，app 默认对局域网；
// 想让 B 也只回环的沙箱必须**显式**给 `SOPHO_APP_HOST=127.0.0.1`（那条路仍然可用，本门也钉住）。
// `test:serveports` 只管「serve/stop 端口成对、Linux 与 Windows 同值」，**不管这一条宿主默认值**
// —— 所以单靠它，这一行可以悄悄退回继承写法而门全绿。
//
// 这道门怎么证（**都不看日志字符串**）：
//   ① 读事实：`bin/serve.sh` 里那一条 `APP_HOST=…` 的**原文**（打进报告当证据），以及它前后的
//      两条链子 —— 解析出来的值真被交给 app（`SOPHO_APP_HOST="$APP_HOST"`）、A 的宿主仍是
//      `SOPHO_HOST="$HOST"`。
//   ② 真起进程：把那条赋值的**原文**交给**真 bash**、在受控 env 下解析（`${VAR:-default}` 的语义
//      由 bash 说了算，不在 JS 里重写一遍），再拿这个宿主**真起** `server/app.mjs`（临时
//      ASSIST_HOME + 高位随机端口，绝不碰 7331/7321 与真实 profile），读**真绑定**：Windows
//      `netstat -ano` 的 `LocalAddress`、POSIX `ss -ltnp` 的第 4 列（`test/harness.mjs` 的
//      `listenerRows` 是唯一平台分叉点，门不许自己去调 `ss`）。判据三条：绑定地址那列 == 期望宿主、
//      端口 == 我们给的那个、**监听者 pid == 我们 spawn 的 child.pid**；cmdline 核对后才按 pid 收。
//      另加一条**用户可见**的臂：绑 `0.0.0.0` 时必须能从**本机的局域网地址**真连上（业主看到的就是
//      这个现象）；只绑 `127.0.0.1` 时同一个地址**不该**有网页应答。
//   ③ 脚本自己那条校验也真跑：`SOPHO_PORT == SOPHO_APP_PORT` ⇒ 真 `bash bin/serve.sh` 必须非 0
//      退出、指名说清、**零进程零日志**（那条校验在 `ss` 之前）。
//
// ⚠️ 顺序是刻意的：「那一行不许再出现 `SOPHO_HOST`」这句**形状**断言放在真绑定那几臂**之后**
//   （见文件末尾）—— 反证臂必须红在**实测的监听行**上（那是用户看到的事实），不许红在一句字串比较上。
//
// 反证臂：`node test/serve-app-host.mjs --reverse-arm=inherit`
//   在**副本** `bin/serve.sh` 上把那一行改回旧写法（`${SOPHO_APP_HOST:-${SOPHO_HOST:-0.0.0.0}}`），
//   再跑同一批判据 ⇒ 臂①（只给回环的 `SOPHO_HOST`，app 必须绑 `0.0.0.0`）必红，红在**实测的监听行**。
//   （`npm run test:serveapphost:reverse`）
//
// 臂⑦（**手起那条路**，2026-09-25 业主裁定「与两个启动脚本统一」后加的）：**不设** `SOPHO_APP_HOST`，
//   让 `server/app.mjs` 走它**自己**的兜底 ⇒ 必须同样绑 `0.0.0.0`。臂①~③ 都把脚本解析出来的宿主显式喂给
//   app ⇒ `server/app.mjs:17` 那条兜底从来没被跑过 ✗（它可以悄悄退回继承写法而门全绿）——这就是加臂⑦的原因。
//   反证臂：`node test/serve-app-host.mjs --reverse-arm=js-inherit`（在**副本** `server/app.mjs` 上把那条
//   兜底改回 `SOPHO_APP_HOST || SOPHO_HOST || '127.0.0.1'`）⇒ 臂⑦a 必红在**实测的监听行**上。
//   （`npm run test:serveapphost:reverse-js`）
//
// 臂⑥（Windows 侧静态臂）：本机是 Linux，`bin/serve-win.ps1` 真跑不了（PowerShell 不起来，见下）⇒ 这一臂只读
//   它的**原文**，断言 Windows 的 app-host 口径与 Linux 同一套：未显式给 `$AppHost` 时一律 `0.0.0.0`、那条
//   赋值**不引用** `SOPHO_HOST`、旧口径的 `$HostWasExplicit` 已清掉。它不是「Windows 上起过服」的证据。
//   反证臂：`node test/serve-app-host.mjs --reverse-arm=win-inherit` —— 在副本上把那条赋值改回旧写法
//   （`if ($HostWasExplicit) { $BindHost } else { '0.0.0.0' }`），臂⑥ 必红（这一臂只能红在原文上，因为没有
//   PowerShell 可起；Linux 那条退路仍然红在实测监听行，见上）。
//
// ⚠️ 本机（Windows）上这道门**不跑整份 `bin/serve.sh`**：那个脚本的起停判据是 Linux `ss` 的
//   `pid=` 与 procfs 的 cmdline，两者在 Windows/MSYS 上不属于同一套 pid 空间（MSYS pid ≠ Windows
//   pid），给它架一套假的「端口主人」比不测更坏。所以 Windows 上走的是「那一行的真解析 + 真 app
//   进程 + 真绑定」；整份脚本的端到端只在 POSIX 上才有意义（见交付报告的「没验到什么」）。
//
// 用法：
//   node test/serve-app-host.mjs                    # 正证
//   node test/serve-app-host.mjs --reverse-arm=inherit
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerRows, processAlive, processCommandLine, removeSandbox, stopOwnedListener } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE_SH = path.join(root, 'bin', 'serve.sh');
const SERVE_WIN = path.join(root, 'bin', 'serve-win.ps1');
const APP_ENTRY = path.join(root, 'server', 'app.mjs');
const SANDBOX = await mkdtemp(path.join(os.tmpdir(), 'sopho-serveapphost-'));
const REVERSE = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').slice('--reverse-arm='.length) || null;
// `5681dcf` 之前那一行（2026-09-23 业主裁定改掉的）—— 反证臂拿它当退路。
const INHERITED_APP_HOST_LINE = 'APP_HOST=${SOPHO_APP_HOST:-${SOPHO_HOST:-0.0.0.0}}';
// `bin/serve-win.ps1` 对齐之前那条 app-host 赋值（2026-09-24 统一口径改掉的）—— win 反证臂拿它当退路。
const INHERITED_WIN_APP_HOST_LINE = "if (-not $AppHost) { $AppHost = if ($HostWasExplicit) { $BindHost } else { '0.0.0.0' } }";
// `server/app.mjs` 自己那条兜底在 2026-09-25 统一之前的样子（`SOPHO_APP_HOST || SOPHO_HOST || '127.0.0.1'`）
// —— `--reverse-arm=js-inherit` 拿它当退路。
const INHERITED_APP_JS_HOST_LINE = "const host = process.env.SOPHO_APP_HOST || process.env.SOPHO_HOST || '127.0.0.1';";
const RESERVED_PORTS = new Set([7331, 7321]);

/** `server/app.mjs` 的 entry：`--reverse-arm=js-inherit` 时在**副本**上把那条兜底改回旧写法，拿副本当 entry 起。
 *  （为什么必须起副本：臂⑦ 要让 app 走**它自己**的兜底 —— 现有的臂①②③ 都是把 `bin/serve.sh` 解析出来的宿主
 *  显式喂给 app，所以 `server/app.mjs:17` 那条兜底从来没有被跑过 ⇒ 它可以悄悄退回继承写法而门全绿。） */
async function appEntryForArm() {
  const source = await readFile(APP_ENTRY, 'utf8');
  if (REVERSE !== 'js-inherit') return { entry: APP_ENTRY, note: '工作树里的 server/app.mjs' };
  const line = /^const host = process\.env\.SOPHO_APP_HOST.*$/m.exec(source)?.[0];
  assert.ok(line, 'server/app.mjs 里找不到那条 host 兜底 —— js 反证臂无从下手（改过那一行？）');
  assert.notEqual(line, INHERITED_APP_JS_HOST_LINE, `js 反证臂无处可退：那一行已经等于旧写法（${line}）`);
  const patched = source.replace(line, INHERITED_APP_JS_HOST_LINE);
  const entry = path.join(SANDBOX, 'app-inherit.mjs');
  await writeFile(entry, patched, 'utf8');
  return { entry, note: `反证臂 js-inherit：${line} ⇒ ${INHERITED_APP_JS_HOST_LINE}` };
}

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 受控 env：本机的 `SOPHO_*` / agent-dir 变量一个都不带进来（否则「没设」这件事就说不清）。 */
function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('SOPHO_') || name === 'ASSIST_HOME' || name === 'PI_CODING_AGENT_DIR' || name === 'HOME') delete env[name];
  }
  return env;
}

/** 报告里要贴的**原始行**。POSIX 上返回空数组：`listenerRows` 的 `raw` 本身就是 `ss -ltnp` 那一行。
 *  Windows 上补一行 `netstat -ano`（业主点名的那条判据载体）。
 *  判据仍然只认 `listenerRows`：它取的是 Windows 的枚举值（`LocalAddress`），而 `netstat` 的
 *  STATE 列在非英文系统上会被本地化（拿它当判据会漏行）——所以这里只当**证据**打出来。 */
function rawEvidenceLines(port) {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  return (result.stdout || '').split(/\r?\n/)
    .filter((line) => line.trim().split(/\s+/)[1]?.endsWith(`:${port}`));
}

async function reserveHighPort(taken = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 15000); candidate < 62000; candidate += 1) {
    if (RESERVED_PORTS.has(candidate) || taken.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const listener = net.createServer();
      listener.once('error', () => resolve(false));
      listener.listen(candidate, '127.0.0.1', () => listener.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

function get(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve({ status: response.statusCode });
    });
    request.on('error', (error) => resolve({ error: error.code || error.message }));
    request.on('timeout', () => { request.destroy(); resolve({ error: 'timeout' }); });
  });
}

/** 反证臂：只在**副本**上把那一行改回旧写法（先核「改到了东西」，没改到就抛，不许悄悄跑成绿）。 */
async function serveScriptForArm() {
  const original = await readFile(SERVE_SH, 'utf8');
  if (REVERSE === null || REVERSE === 'win-inherit' || REVERSE === 'js-inherit') return { text: original, file: SERVE_SH, note: '工作树里的 bin/serve.sh' };
  if (REVERSE !== 'inherit') throw new Error(`unknown --reverse-arm=${REVERSE}`);
  const line = /^APP_HOST=.*$/m.exec(original)?.[0];
  assert.ok(line, 'bin/serve.sh 里找不到那条 APP_HOST 赋值 —— 反证臂无从下手（改过那一行？）');
  assert.notEqual(line, INHERITED_APP_HOST_LINE, `反证臂无处可退：那一行已经等于旧写法（${line}）`);
  const patched = original.replace(line, INHERITED_APP_HOST_LINE);
  const file = path.join(SANDBOX, 'serve-inherit.sh');
  await writeFile(file, patched, 'utf8');
  return { text: patched, file, note: `反证臂 inherit：${line} ⇒ ${INHERITED_APP_HOST_LINE}` };
}

/** Windows 静态臂要读的那个文件；`--reverse-arm=win-inherit` 时只在**副本**上把 app-host 默认值改回旧写法。 */
async function serveWinScriptForArm() {
  const original = await readFile(SERVE_WIN, 'utf8');
  if (REVERSE !== 'win-inherit') return { text: original, file: SERVE_WIN, note: '工作树里的 bin/serve-win.ps1' };
  const line = /^if \(-not \$AppHost\) \{ \$AppHost = '.*?' \}$/m.exec(original)?.[0];
  assert.ok(line, 'bin/serve-win.ps1 里找不到 app-host 默认值那条赋值 —— win 反证臂无从下手（改过那一行？）');
  assert.notEqual(line, INHERITED_WIN_APP_HOST_LINE, `win 反证臂无处可退：那一行已经等于旧写法（${line}）`);
  const patched = original.replace(line, INHERITED_WIN_APP_HOST_LINE);
  const file = path.join(SANDBOX, 'serve-win-inherit.ps1');
  await writeFile(file, patched, 'utf8');
  return { text: patched, file, note: `反证臂 win-inherit：${line} ⇒ ${INHERITED_WIN_APP_HOST_LINE}` };
}

/** 臂⑥：Windows 的 app-host 口径 —— 只读原文（没有 PowerShell 可起，见文件头）。 */
function assertWindowsAppHostStatic(text, file) {
  print('被验的 Windows 脚本', `${file}`);
  assert.ok(text.includes('[string]$AppHost = $env:SOPHO_APP_HOST'),
    `${file}: $AppHost 参数必须仍以 $env:SOPHO_APP_HOST 为默认（显式给的那份才优先）`);
  assert.ok(!/\$HostWasExplicit/.test(text),
    `${file}: 旧口径的 $HostWasExplicit 必须清掉（2026-09-23 裁定之后它是死代码），实测仍在`);
  assert.ok(!/\$AppHost = if\b/.test(text),
    `${file}: app 宿主默认值**不许**再按「A 的宿主显式给过没有」分支（旧口径 $AppHost = if ($HostWasExplicit) …；业主裁定：app 默认对局域网）`);
  const match = /if \(-not \$AppHost\) \{ \$AppHost = '([^']+)' \}/.exec(text);
  assert.ok(match, `${file}: 找不到「未显式给 AppHost 时的默认值」那条赋值（拼写变过？这道门要刻意跟着改；期望与 bin/serve.sh 同口径的 0.0.0.0）`);
  print('Windows 那一行的原文', match[0]);
  assert.equal(match[1], '0.0.0.0',
    `${file}: 未显式给 AppHost 时 app 宿主必须默认 0.0.0.0（与 bin/serve.sh 同口径，2026-09-24 统一），实测 '${match[1]}'`);
  assert.ok(!/SOPHO_HOST/.test(match[0]),
    `${file}: app 宿主默认值**不许**引用 SOPHO_HOST（不许再继承 A 的宿主），实测 ${match[0]}`);
}

// ── ① 读事实：那一行的原文，以及它前后的两条链子 ─────────────────────────────────
const script = await serveScriptForArm();
const winScript = await serveWinScriptForArm();
print('被验的脚本', `${script.file}（${script.note}）`);
const appHostExpression = /^APP_HOST=(.+)$/m.exec(script.text)?.[1] ?? null;
assert.ok(appHostExpression, `${script.file}: 找不到 APP_HOST= 那一行（拼写变过？这道门要刻意跟着改）`);
print('那一行的原文', `APP_HOST=${appHostExpression}`);
assert.ok(/\bSOPHO_APP_HOST\b/.test(appHostExpression),
  `app 的宿主默认值必须提到 SOPHO_APP_HOST（显式给的那一份优先），实测那一行是 APP_HOST=${appHostExpression}`);
assert.ok(script.text.includes('SOPHO_APP_HOST="$APP_HOST"'),
  'bin/serve.sh 必须把解析出来的宿主显式交给 app 的 env（SOPHO_APP_HOST="$APP_HOST"）—— 否则上面那一行与真绑定之间断链');
assert.ok(script.text.includes('SOPHO_HOST="$HOST"'),
  'bin/serve.sh 必须把 A 的宿主交给 base 的 env（SOPHO_HOST="$HOST"）—— A 仍然只默认绑回环');
print('链子', 'A: SOPHO_HOST="$HOST" ；B: SOPHO_APP_HOST="$APP_HOST"');

/** ② 解析事实：把那一行原文交给**真 bash**（不在这里重写 `${VAR:-default}` 的语义）。 */
function resolveAppHost(variables) {
  const result = spawnSync('bash', ['-c', `APP_HOST=${appHostExpression}\nprintf '%s' "$APP_HOST"\n`], {
    env: { ...cleanEnv(), ...variables },
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `bash 起不来（${result.error?.message}）—— bin/serve.sh 本来就要求 POSIX shell`);
  assert.equal(result.status, 0, `用真 bash 解析那一行失败：status=${result.status} stderr=${(result.stderr || '').trim()}`);
  return result.stdout;
}

const appEntry = await appEntryForArm();
const openHandles = [];
let launched = null;

/** 起一个真 app（只起 B：它的监听地址与 A 在不在无关），断言**真绑定**那一行。
 *  `omitAppHost` ⇒ **不设** `SOPHO_APP_HOST`，让 app 走它**自己**的兜底（臂⑦ 用；`entry` 可指向反证副本）。 */
async function startAppArm({ label, variables, expected, what, entry = appEntry.entry, omitAppHost = false }) {
  const port = await reserveHighPort();
  const upstreamPort = await reserveHighPort(new Set([port]));
  const resolved = omitAppHost ? null : resolveAppHost(variables);
  if (omitAppHost) {
    print(`${label} 不设 SOPHO_APP_HOST（走 app 自己的兜底）`, `SOPHO_HOST=${variables.SOPHO_HOST ?? '(未设)'} ⇒ 期望 app 自己兜到 ${expected}`);
  } else {
    print(`${label} 用真 bash 解析那一行`, `SOPHO_HOST=${variables.SOPHO_HOST ?? '(未设)'} SOPHO_APP_HOST=${variables.SOPHO_APP_HOST ?? '(未设)'} ⇒ APP_HOST=${resolved}`);
  }
  const home = path.join(SANDBOX, `home-${label}`);
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  const logPath = path.join(SANDBOX, `app-${label}.log`);
  const log = await open(logPath, 'w');
  openHandles.push(log);
  const childEnv = {
    ...cleanEnv(), HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
    PI_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'), PI_OFFLINE: '1',
    SOPHO_APP_PORT: String(port),
    SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(upstreamPort),
    SOPHO_WEB_ROOT: path.join(root, 'web'),
  };
  // `omitAppHost` 时**故意不设**它 —— 否则量到的永远是「显式给的那份」，而不是 app 自己的兜底。
  if (!omitAppHost) childEnv.SOPHO_APP_HOST = resolved;
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', log.fd, log.fd],
  });
  // 一 spawn 就登记：下面任何一条断言的失败都不能把进程留在那里（收尾按 pid + cmdline 核对后才杀）。
  launched = { label, port, pid: child.pid, child, entry };
  const deadline = Date.now() + 20_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await listenerRows(port);
    if (rows.length > 0) break;
    if (child.exitCode !== null) {
      const tail = (await readFile(logPath, 'utf8')).trim().split('\n').slice(-8).join(' | ');
      throw new Error(`${label}：app 进程在监听之前就退了（exit=${child.exitCode}）log=${tail}`);
    }
    await sleep(100);
  }
  assert.ok(rows.length > 0, `${label}：app 没有在端口 ${port} 上监听（20s）—— 期望绑 ${expected}`);
  for (const row of rows) print(`${label} 判据行（${process.platform === 'win32' ? 'Get-NetTCPConnection 枚举值' : 'ss -ltnp 原文'}）`, row.raw);
  for (const line of rawEvidenceLines(port)) print(`${label} 证据行（netstat -ano）`, line.trim());
  for (const row of rows) {
    // 这一条就是判据：**绑定地址那一列**（不是日志字符串）。
    assert.equal(row.address, expected,
      `${label}：${what} —— 绑定地址那列必须是 ${expected}，实测 ${row.address}（原始行：${row.raw}）`);
    assert.equal(row.port, port, `${label}：监听行的端口必须就是我们给的那个 ${port}（原始行：${row.raw}）`);
  }
  const pid = rows[0].pid;
  assert.equal(pid, child.pid,
    `${label}：监听行报的 pid=${pid} 必须就是我们 spawn 的那个 child.pid=${child.pid}（并发起进程？）`);
  const commandLine = (await processCommandLine(pid).catch(() => '')) || '';
  assert.ok(commandLine.replaceAll('\\', '/').includes(entry.replaceAll('\\', '/')),
    `${label}：pid ${pid} 的 cmdline 必须是我们起的那个 entry（${entry}），实测 ${commandLine || '(读不到)'}`);
  print(`${label} pid 身份`, `pid=${pid} cmdline=${commandLine}`);
  // 顺带把「那一行解析出来的值」也钉住（放在真绑定断言**之后**：反证臂要红在上面那一条）。
  if (!omitAppHost) assert.equal(resolved, expected, `${label}：${what}（真 bash 解析那一行得到的值是 ${resolved}，期望 ${expected}）`);
  return { label, port, pid, child, resolved, entry };
}

/** 用户可见的那一条：从**本机局域网地址**发一发真 HTTP GET（绑 0.0.0.0 必须通）。 */
async function probeLanAddress({ arm, mustAnswer }) {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address);
  if (lan.length === 0) {
    print('局域网探活', 'SKIP：本机没有非回环 IPv4（这只是证据，不是判据）');
    return;
  }
  const answers = [];
  for (const address of lan.slice(0, 3)) {
    const result = await get(`http://${address}:${arm.port}/app-host`);
    answers.push(`${address}:${arm.port} ⇒ ${result.status ? `HTTP ${result.status}` : result.error}`);
  }
  print('局域网探活', answers.join(' | '));
  if (mustAnswer) {
    assert.ok(answers.some((line) => line.includes('HTTP 200')),
      `${arm.label}：绑了 0.0.0.0 就必须能从局域网地址连上（业主看到的现象就是这个），实测 ${answers.join(' | ')}`);
  } else {
    assert.ok(!answers.some((line) => line.includes('HTTP 200')),
      `${arm.label}：只绑 ${arm.resolved} 时局域网地址**不该**有网页应答，实测 ${answers.join(' | ')}`);
  }
}

const checks = [];
const check = (name, detail) => { checks.push(name); print(`✓ ${name}`, detail); };

async function stopArm(arm) {
  await stopOwnedListener(arm.port, arm.entry, arm.pid);
  launched = null;
  assert.equal(await processAlive(arm.pid), false, `${arm.label} 收尾：app 进程必须已经不在`);
  print(`${arm.label} 收尾`, `port=${arm.port} pid=${arm.pid} 已退、端口已放`);
}
let primaryError = null;
const cleanupProblems = [];
try {
  // 臂①（核心）：只设一个**回环**的 SOPHO_HOST、不设 SOPHO_APP_HOST ⇒ app 真的绑 0.0.0.0。
  const loopbackHostOnly = await startAppArm({
    label: '臂①',
    variables: { SOPHO_HOST: '127.0.0.1' },
    expected: '0.0.0.0',
    what: '只给回环的 SOPHO_HOST 时，app 仍必须默认对局域网（不许继承 A 的宿主）',
  });
  await probeLanAddress({ arm: loopbackHostOnly, mustAnswer: true });
  check('臂① 只给回环 SOPHO_HOST ⇒ 真 app 绑 0.0.0.0（且局域网地址真能连上）', `port=${loopbackHostOnly.port} pid=${loopbackHostOnly.pid}`);
  await stopArm(loopbackHostOnly);

  // 臂②：什么都不给（裸 `npm run serve` 的口径）⇒ 也是 0.0.0.0。
  const nothingGiven = await startAppArm({
    label: '臂②',
    variables: {},
    expected: '0.0.0.0',
    what: '什么都不给（裸 npm run serve）时 app 必须绑 0.0.0.0',
  });
  check('臂② 什么都不给 ⇒ 真 app 绑 0.0.0.0', `port=${nothingGiven.port} pid=${nothingGiven.pid}`);
  await stopArm(nothingGiven);

  // 臂③：显式 SOPHO_APP_HOST=127.0.0.1（沙箱那条路）⇒ 仍必须只绑回环。
  const explicitLoopback = await startAppArm({
    label: '臂③',
    variables: { SOPHO_HOST: '127.0.0.1', SOPHO_APP_HOST: '127.0.0.1' },
    expected: '127.0.0.1',
    what: '显式给 SOPHO_APP_HOST=127.0.0.1 时 app 必须只绑回环',
  });
  await probeLanAddress({ arm: explicitLoopback, mustAnswer: false });
  check('臂③ 显式回环那条路仍在 ⇒ 真 app 只绑 127.0.0.1', `port=${explicitLoopback.port} pid=${explicitLoopback.pid}`);
  await stopArm(explicitLoopback);

  // 臂⑦（**手起那条路**）：不设 `SOPHO_APP_HOST` ⇒ app 必须走它**自己**的兜底。
  //   为什么要有它：臂①~③ 都是把 `bin/serve.sh` 解析出来的宿主**显式喂**给 app ⇒ `server/app.mjs:17`
  //   那条兜底从来没有被跑过 ✗ ⇒ 它可以悄悄退回「继承 SOPHO_HOST / 兜底回环」而门全绿（2026-09-25 业主裁定
  //   统一之前的洞；那时手起 `node server/app.mjs` 会跟着 A 绑回环 ⇒ 局域网连不上网页）。
  const jsLoopbackHostOnly = await startAppArm({
    label: '臂⑦a',
    variables: { SOPHO_HOST: '127.0.0.1' },
    expected: '0.0.0.0',
    omitAppHost: true,
    what: '手起 app（不设 SOPHO_APP_HOST）且只给回环的 SOPHO_HOST 时，app 仍必须默认对局域网（不许继承 A 的宿主）',
  });
  await probeLanAddress({ arm: jsLoopbackHostOnly, mustAnswer: true });
  check('臂⑦a 手起（不设 SOPHO_APP_HOST）＋ 只给回环 SOPHO_HOST ⇒ 真 app 绑 0.0.0.0（且局域网地址真能连上）', `port=${jsLoopbackHostOnly.port} pid=${jsLoopbackHostOnly.pid}`);
  await stopArm(jsLoopbackHostOnly);

  const jsNothingGiven = await startAppArm({
    label: '臂⑦b',
    variables: {},
    expected: '0.0.0.0',
    omitAppHost: true,
    what: '手起 app 且什么都不给时也必须绑 0.0.0.0',
  });
  check('臂⑦b 手起 ＋ 什么都不给 ⇒ 真 app 绑 0.0.0.0', `port=${jsNothingGiven.port} pid=${jsNothingGiven.pid}`);
  await stopArm(jsNothingGiven);

  // 臂④：脚本自己那条校验（端口相等必须被拒）——真跑脚本，且必须**零进程零日志**。
  const equalPort = await reserveHighPort();
  const guardLog = path.join(SANDBOX, 'guard-base.log');
  const guardAppLog = path.join(SANDBOX, 'guard-app.log');
  const guard = spawnSync('bash', [script.file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...cleanEnv(),
      HOME: path.join(SANDBOX, 'home-guard'),
      ASSIST_HOME: path.join(SANDBOX, 'home-guard'),
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(equalPort),
      SOPHO_APP_PORT: String(equalPort),
      SOPHO_LOG: guardLog,
      SOPHO_APP_LOG: guardAppLog,
    },
  });
  print('臂④ 真跑 bin/serve.sh（端口相等）', `exit=${guard.status} stderr=${(guard.stderr || '').trim()}`);
  assert.equal(guard.status, 1, `端口相等时 bin/serve.sh 必须非 0 退出，实测 exit=${guard.status}`);
  assert.match(guard.stderr || '', /SOPHO_PORT and SOPHO_APP_PORT must differ/,
    '拒绝时必须在 stderr 里指名说清是哪两个变量（不能只说一句「不能相同」）');
  const strayRows = await listenerRows(equalPort);
  assert.deepEqual(strayRows, [], `被拒的那一次不许留下任何监听者，实测 ${JSON.stringify(strayRows)}`);
  const logsWritten = await Promise.all([guardLog, guardAppLog].map((file) => readFile(file, 'utf8').then(() => true, () => false)));
  assert.deepEqual(logsWritten, [false, false], '被拒的那一次连日志文件都不该建（那条校验在起进程之前）');
  check('臂④ 端口相等 ⇒ 真脚本拒绝（exit=1、指名说清、零进程零日志）', `exit=${guard.status} stderr=${(guard.stderr || '').trim()}`);

  // ⑤ 形状：那一行**不许再出现** `SOPHO_HOST`（「不继承 A 的宿主」这句话的字面钉）。
  //    刻意排在真绑定那几臂之后：反证臂要红在**实测的监听行**上，而不是红在一句字串比较上。
  assert.ok(!/\bSOPHO_HOST\b/.test(appHostExpression),
    `app 的宿主默认值**不许**继承 SOPHO_HOST（业主 2026-09-23 裁定：app 默认对局域网；要回环请显式给 SOPHO_APP_HOST=127.0.0.1），实测那一行是 APP_HOST=${appHostExpression}`);
  check('⑤ 那一行的形状：提到 SOPHO_APP_HOST、不再出现 SOPHO_HOST', `APP_HOST=${appHostExpression}`);

  // ⑦ 形状（对应臂⑦）：`server/app.mjs` 那条兜底**不许**再出现 `SOPHO_HOST`、默认必须是 `0.0.0.0`。
  //    刻意排在真绑定那几臂之后：`--reverse-arm=js-inherit` 要红在**臂⑦a 实测的监听行**上，而不是红在一句字串比较上。
  const appSource = await readFile(APP_ENTRY, 'utf8');
  const appHostLine = /^const host = process\.env\.SOPHO_APP_HOST.*$/m.exec(appSource)?.[0] ?? null;
  assert.ok(appHostLine, 'server/app.mjs 里找不到那条 host 兜底（拼写变过？这道门要刻意跟着改）');
  print('server/app.mjs 那一行的原文', appHostLine);
  assert.ok(/\bSOPHO_APP_HOST\b/.test(appHostLine),
    `server/app.mjs 的宿主兜底必须提到 SOPHO_APP_HOST（显式给的那份才优先），实测 ${appHostLine}`);
  assert.ok(/0\.0\.0\.0/.test(appHostLine),
    `server/app.mjs 的宿主兜底必须是 0.0.0.0（与 bin/serve.sh / serve-win.ps1 同口径），实测 ${appHostLine}`);
  assert.ok(!/\bSOPHO_HOST\b/.test(appHostLine),
    `server/app.mjs 的宿主兜底**不许**继承 SOPHO_HOST（业主 2026-09-25 裁定与两个启动脚本统一；要回环请显式给 SOPHO_APP_HOST=127.0.0.1），实测 ${appHostLine}`);
  check('⑦ server/app.mjs 那条兜底：提到 SOPHO_APP_HOST、默认 0.0.0.0、不再出现 SOPHO_HOST', appHostLine);

  // ⑥ Windows 侧静态臂：本机是 Linux，PowerShell 起不来 ⇒ 只读原文（见文件头）。刻意排在真绑定之后：
  //    `--reverse-arm=inherit` 仍要红在臂①实测的监听行上；这条静态臂的退路是另一个模式 `win-inherit`。
  assertWindowsAppHostStatic(winScript.text, winScript.file);
  check('⑥ Windows 侧：app 宿主默认 0.0.0.0、不引用 SOPHO_HOST、旧 $HostWasExplicit 已清（静态原文断言）', winScript.file);

  print('RESULT', `serve app host PASS (${checks.length} checks)${REVERSE ? `（--reverse-arm=${REVERSE}：这一臂就是那句退路的证据）` : ''}`);
} catch (error) {
  primaryError = error;
} finally {
  if (launched) {
    await cleanupStep(cleanupProblems, `stop ${launched.label}`, async () => {
      await stopOwnedListener(launched.port, launched.entry, launched.pid);
      print(`${launched.label} 收尾（失败路径）`, `port=${launched.port} pid=${launched.pid} 已退、端口已放`);
    });
  }
  await cleanupStep(cleanupProblems, 'close logs', async () => {
    for (const handle of openHandles) await handle.close().catch(() => {});
  });
  await removeSandbox(SANDBOX, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
