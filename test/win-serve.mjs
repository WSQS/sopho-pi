import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

// ── 保留端口安全：判据按**归属**拆（2026-09-26）────────────────────────────────
//
// 原先收尾处只有一句硬断言：「7331/7321 上监听者的 pid 跑前跑后不变」。那断的是**别人的**状态：
// 7331/7321 是**活实例**（A/B）的产品端口，跑在上面的是**别的线**的进程（真机原始读数就是
// `reservedBeforeAfter=7331:67284,7321:80188`）—— 它们只要在这道门的时间窗里重启一次，本门就会
// 红在一个它没有所有权的进程上。本仓口径：**门不许断言自己没有所有权的状态**。拆法：
//
//   · **本门名下**（硬判据 ⇒ 红了就是本门的错）：
//       ① 本门请求的每一个端口都不许落在保留端口上 —— `pickOwnPortPair` 选完当场断言，收尾再对
//          本门用过的**全部**端口断言一次。「请求的端口」就是完整判据：serve-win.ps1 把 -Port/-AppPort
//          原样交给 node（SOPHO_PORT/SOPHO_APP_PORT），本门的监听者只可能绑在这几个端口上。
//       ② 门正跑着的时候，保留端口的监听者不许是**本门自己的 pid**（A/B/worker）。就在 /host 把这三个
//          pid 都核实成活着的那个时刻读 —— 那时它们的归属最硬（pidfile=监听者 pid ＋ /host 的 pid）。
//       收尾时 `ownPids` **故意为空**：本门的 A/B/worker 已在 STOP/TIMEOUT/WMI 臂里逐条核实消失、端口
//       已释放，此刻保留端口上剩下的监听者按构造就是别人的；若它的 pid 恰好等于本门用过的某个 pid，
//       那是 Windows 的 pid 复用、仍是别人的进程 ⇒ 一律不判定（那正是本仓要避免的「红在别人的动作上」）。
//   · **共享的那一半**（只记录）：那两条端口上**别人的**监听者是谁、pid 变没变 —— 写进
//       `PORT SAFETY EVIDENCE ...`（带 `foreignListenerPidChanged` 与归属说明），**不参与判定**。
//
// 判据本身是纯函数（下面两个），自检臂 `--self-check` 用**同一份**判据喂合成输入验它还有没有牙：
// 拆归属最容易做的事就是**把断言删掉**、然后一切照旧绿，所以这条臂本身也得是机械可跑的
// （任何平台都能跑，见 package.json 的 `test:winserve:selfcheck`）。
export const RESERVED_PORTS = [7331, 7321];

/**
 * 「本门名下」的违反项。纯函数：只吃端口号与 pid，喂合成输入就能验它有没有牙。
 *   ① 本门请求的端口落在保留端口上 ⇒ 违反（本门自己起的 A/B 不许落在保留端口上）；
 *   ② 保留端口上的监听者是**本门自己的** pid ⇒ 违反（本门起的监听者不许落在保留端口上）。
 * 共享那一半（别人的监听者是谁、变了没）不在这里 —— 它只进证据行，见 foreignReservedPortReadings。
 */
export function ownPortViolations({ reservedPorts, ownRequestedPorts = [], ownPids = [], listenerByPort = {} }) {
  const violations = [];
  for (const port of reservedPorts) {
    if (ownRequestedPorts.includes(port)) violations.push(`本门请求的端口落在保留端口上：${port}`);
  }
  for (const port of reservedPorts) {
    const listener = Number(listenerByPort[port] ?? 0);
    if (listener !== 0 && ownPids.includes(listener)) {
      violations.push(`保留端口 ${port} 上的监听者 pid ${listener} 是**本门自己**起的（A/B/worker）`);
    }
  }
  return violations;
}

/** 共享那一半的读数（那两条端口上别人的监听者是谁、pid 变了没）—— 只进证据行，**不参与判定**。 */
export function foreignReservedPortReadings({ reservedPorts, before = {}, after = {} }) {
  return reservedPorts.map((port) => {
    const wasPid = Number(before[port] ?? 0);
    const isPid = Number(after[port] ?? 0);
    return { port, before: wasPid, after: isPid, changed: wasPid !== isPid };
  });
}

if (process.argv.includes('--self-check')) {
  await reservedPortSafetySelfCheck();
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.log('SKIP test:winserve (Windows-only)');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ps = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'sopho-winserve-'));
const temp = path.join(sandbox, 'temp');
const home = path.join(sandbox, 'home');
const logs = path.join(sandbox, 'logs');
mkdirSync(temp, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(logs, { recursive: true });

function runPowerShell(script, args, { expect = 0, envOverride = {}, timeout = 180_000 } = {}) {
  const result = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args.map(String)], {
    cwd: root,
    env: { ...env, ...envOverride },
    encoding: 'utf8',
    timeout,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  console.log(`$ powershell -File ${path.relative(root, script)} ${args.join(' ')}`);
  console.log(output || '(no output)');
  assert.equal(result.error, undefined, `PowerShell spawn failed: ${result.error?.message}`);
  assert.equal(result.status, expect, `unexpected exit ${result.status}; output:\n${output}`);
  return output;
}

function psValue(code) {
  return execFileSync(ps, ['-NoProfile', '-Command', code], { encoding: 'utf8', timeout: 15_000 }).trim();
}

function listenerPid(port) {
  return Number(psValue(`$c=Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}else{0}`)) || 0;
}

function processExists(pid) {
  return psValue(`if(Get-Process -Id ${pid} -ErrorAction SilentlyContinue){'yes'}else{'no'}`) === 'yes';
}

/**
 * 「本门名下」的保留端口安全断言（**有归属**的硬判据）：读一次保留端口，判据见 ownPortViolations。
 * `reservedPorts` / `readListener` / `say` 可覆盖，只为自检臂能喂合成输入（生产路径用默认值：
 * 真保留端口 + 真 Get-NetTCPConnection 读数 + 真 stdout）。返回本次读数与违反项，供证据行复用。
 */
function assertOwnReservedSafety({ stage, ownRequestedPorts, ownPids, reservedPorts = RESERVED_PORTS, readListener = listenerPid, say = console.log }) {
  const listenerByPort = Object.fromEntries(reservedPorts.map((port) => [port, Number(readListener(port) || 0)]));
  const violations = ownPortViolations({ reservedPorts, ownRequestedPorts, ownPids, listenerByPort });
  say(`OWN PORT SAFETY EVIDENCE stage=${stage} ownRequestedPorts=${ownRequestedPorts.join(',') || '(none)'}`
    + ` ownPids=${ownPids.join(',') || '(none)'}`
    + ` reservedListeners=${reservedPorts.map((port) => `${port}:${listenerByPort[port]}`).join(',')}`
    + ` ownViolations=${violations.length}`);
  assert.deepEqual(violations, [], `本门自己的保留端口安全（有归属的硬判据，stage=${stage}）：\n  ${violations.join('\n  ')}`);
  return { listenerByPort, violations };
}

// ── 自检臂：`node test/win-serve.mjs --self-check`（任何平台都能跑；npm run test:winserve:selfcheck）
// 为什么要有它：拆归属最容易做的事就是**把断言删掉**、然后一切照旧绿。这条臂把输入喂给**同一份**判据
// （下面 Windows 那条路调用的就是它），要求「本门名下」那一半**必须红**、「共享」那一半**不参与判定**。
// 它不碰真的 7331/7321（那上面跑着别人的活实例），而是把**本进程真监听的一个随机高位端口**声明成
// 「保留端口」来当正控制 ⇒ 「我起的监听者落在保留端口上」这条链是真的走了一遍。
async function reservedPortSafetySelfCheck() {
  console.log('SELF-CHECK win-serve reserved-port safety（判据函数与 Windows 那条路共用同一份；输入是造的）');
  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name} —— ${detail}`);
    if (!ok) failures.push(name);
  };

  // ① 正控制：本门请求的端口落在保留端口上 ⇒ 必须判红；没请求 ⇒ 不许红（否则是个恒红的死读数）
  const requestedBad = ownPortViolations({ reservedPorts: RESERVED_PORTS, ownRequestedPorts: [61938, 7331] });
  check('① 本门请求了 7331 ⇒ 判据必报违反（这条判据有牙）', requestedBad.length === 1 && requestedBad[0].includes('7331'), JSON.stringify(requestedBad));
  const requestedClean = ownPortViolations({ reservedPorts: RESERVED_PORTS, ownRequestedPorts: [61938, 61939] });
  check('① 本门没请求保留端口 ⇒ 不报（否则它是个恒红的死读数）', requestedClean.length === 0, JSON.stringify(requestedClean));

  // ② 正控制（真监听者、真 pid）：本进程真监听一个随机高位端口，把**那个**端口声明成「保留端口」，
  //    再让门的断言函数本身（Windows 那条路用的就是它）去跑 ⇒ 必须抛。验的是**断言那句**有没有牙。
  const standIn = net.createServer();
  await new Promise((resolve, reject) => { standIn.once('error', reject); standIn.listen(0, '127.0.0.1', resolve); });
  const standInPort = standIn.address().port;
  const ownPid = process.pid;
  let ownThrew = null;
  try {
    assertOwnReservedSafety({ stage: 'self-check-own-listener', ownRequestedPorts: [], ownPids: [ownPid], reservedPorts: [standInPort], readListener: () => ownPid, say: () => {} });
  } catch (error) { ownThrew = error.message; }
  check(`② 本门自己的 pid（${ownPid}）在「保留端口」${standInPort} 上监听 ⇒ 门的断言必须判红`,
    Boolean(ownThrew) && ownThrew.includes(String(standInPort)), ownThrew ? ownThrew.split('\n')[0] : '（没有抛 ⇒ 这条断言已经没牙）');
  let foreignThrew = null;
  try {
    assertOwnReservedSafety({ stage: 'self-check-foreign-listener', ownRequestedPorts: [], ownPids: [ownPid], reservedPorts: [standInPort], readListener: () => 4, say: () => {} });
  } catch (error) { foreignThrew = error.message; }
  check('② 同一个端口上是**别人的** pid（4）⇒ 门的断言不许红（本门对别人的监听者没有所有权）', foreignThrew === null, foreignThrew ?? '（正确地没抛）');
  await new Promise((resolve) => standIn.close(resolve));

  // ③ 共享那一半：别人的监听者 pid 变了 ⇒ 只记录（foreignListenerPidChanged=true），判据一条不报
  const rows = foreignReservedPortReadings({ reservedPorts: RESERVED_PORTS, before: { 7331: 65548, 7321: 45096 }, after: { 7331: 4711, 7321: 45096 } });
  const changed = rows.filter((row) => row.changed).map((row) => row.port);
  const foreignViolations = ownPortViolations({ reservedPorts: RESERVED_PORTS, ownPids: [ownPid], listenerByPort: Object.fromEntries(rows.map((row) => [row.port, row.after])) });
  check('③ 7331 上别人的 pid 65548→4711 ⇒ 只记 foreignListenerPidChanged=true、判据一条不报', changed.join(',') === '7331' && foreignViolations.length === 0, JSON.stringify({ rows, changed, foreignViolations }));
  const mixed = ownPortViolations({ reservedPorts: RESERVED_PORTS, ownPids: [ownPid], listenerByPort: { 7331: 4711, 7321: ownPid } });
  check('③b 同一批读数里 7321 换成本门自己的 pid ⇒ 必报（证明 ③ 的 0 不是因为它瞎了）', mixed.length === 1 && mixed[0].includes('7321'), JSON.stringify(mixed));

  if (failures.length) {
    console.error(`SELF-CHECK FAILED（${failures.length} 条）：${failures.join('；')}`);
    process.exit(1);
  }
  console.log('PASS win-serve self-check: 「本门名下」那一半有牙（请求了保留端口、或本门自己的 pid 落在保留端口上，都必判红）；「共享」那一半（别人的监听者 pid 变没变）只记录、不判定');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

// 本门自己的端口：**一律**避开保留端口，而且选完当场断言这个不变式（有归属 ⇒ 红了就是本门的错）。
// 为什么在选端口这一步就断言：本门的监听者只可能绑在本门请求的那几个端口上（见文件开头 ① 的理由），
// 所以「本门请求的端口不含保留端口」就是「本门自己起的 A/B 不许落在保留端口上」的完整判据。
async function pickOwnPortPair() {
  let first = await freePort();
  let second = await freePort();
  while (second === first || RESERVED_PORTS.includes(first) || RESERVED_PORTS.includes(second)) {
    first = await freePort();
    second = await freePort();
  }
  assert.ok(first >= 1024 && second >= 1024);
  const violations = ownPortViolations({ reservedPorts: RESERVED_PORTS, ownRequestedPorts: [first, second] });
  assert.deepEqual(violations, [], `本门选中的端口不许落在保留端口上：${violations.join('；')}`);
  return [first, second];
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 5000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(body) }));
    });
    request.on('timeout', () => request.destroy(new Error(`timeout: ${url}`)));
    request.on('error', reject);
  });
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Boolean(await check());
}

// 本门自己的端口：一律避开保留端口（选完当场硬断言，见 pickOwnPortPair）。
const [port, appPort] = await pickOwnPortPair();
// 共享那一半的**跑前**读数（7331/7321 上是谁在监听）——只用于收尾的证据行，不参与判定。
const reservedBefore = Object.fromEntries(RESERVED_PORTS.map((value) => [value, listenerPid(value)]));

const localModules = path.join(root, 'node_modules');
let madeJunction = false;
let started = false;
const env = {
  ...process.env,
  TEMP: temp,
  TMP: temp,
  ASSIST_HOME: home,
  SOPHO_AGENT_DIR: home,
  PI_CODING_AGENT_DIR: home,
  SOPHO_CWD: root,
  SOPHO_HOST: '127.0.0.1',
  SOPHO_APP_HOST: '127.0.0.1',
  SOPHO_PORT: String(port),
  SOPHO_APP_PORT: String(appPort),
  SOPHO_LOG: path.join(logs, 'base.log'),
  SOPHO_ERR_LOG: path.join(logs, 'base.err.log'),
  SOPHO_APP_LOG: path.join(logs, 'app.log'),
  SOPHO_APP_ERR_LOG: path.join(logs, 'app.err.log'),
};

let primaryError;
try {
  try {
    statSync(localModules);
  } catch {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    const commonPath = path.resolve(root, common);
    const mainModules = path.join(path.dirname(commonPath), 'node_modules');
    statSync(mainModules);
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', localModules, mainModules], { stdio: 'pipe' });
    madeJunction = true;
    console.log(`junction: ${localModules} -> ${mainModules}`);
  }

  const startOutput = runPowerShell(
    path.join(root, 'bin', 'serve-win.ps1'),
    ['-Port', port, '-AppPort', appPort, '-BindHost', '127.0.0.1', '-AppHost', '127.0.0.1'],
    { envOverride: { SOPHO_TEST_BASE_START_DELAY_MS: '6000', SOPHO_TEST_PROGRESS_INTERVAL_SECONDS: '2' } },
  );
  started = true;
  assert.match(startOutput, /A WMI Create succeeded ReturnValue=0/);
  assert.match(startOutput, /A still waiting: elapsed=\d+\.\d+s; no listener/);
  assert.match(startOutput, /A started pid=\d+/);
  assert.match(startOutput, /B started pid=\d+/);

  const basePidFile = path.join(temp, `sopho-pi-${port}.pid`);
  const appPidFile = path.join(temp, `sopho-pi-${appPort}.pid`);
  const basePid = Number(readFileSync(basePidFile, 'utf8').trim());
  const appPid = Number(readFileSync(appPidFile, 'utf8').trim());
  const baseListener = listenerPid(port);
  const appListener = listenerPid(appPort);
  console.log(`PID EVIDENCE A pidfile=${basePid} listener=${baseListener}; B pidfile=${appPid} listener=${appListener}`);
  assert.equal(basePid, baseListener, 'A pidfile must equal listener pid');
  assert.equal(appPid, appListener, 'B pidfile must equal listener pid');

  const host = await getJson(`http://127.0.0.1:${port}/host`);
  assert.equal(host.status, 200);
  assert.equal(host.json.pid, basePid);
  const workerPid = Number(host.json.currentWorkerPid);
  assert.ok(workerPid > 0 && processExists(workerPid), `current worker pid must be alive: ${host.json.currentWorkerPid}`);
  console.log(`HTTP EVIDENCE /host status=${host.status} pid=${host.json.pid} workerPid=${workerPid} startedAt=${host.json.startedAt}`);

  // 本门名下的一半（硬判据）：门正跑着的时候，保留端口上不许有**本门自己的**监听者。
  // 选这一时刻的理由：A/B 的 pid 刚被 pidfile 与 /host 双向核实、worker 也确认活着 —— 归属最硬；
  // 此刻这三个 pid 出现在保留端口上，只可能是本门自己把 A/B 放到了保留端口上（那就是本门的错）。
  assertOwnReservedSafety({ stage: 'running', ownRequestedPorts: [port, appPort], ownPids: [basePid, appPid, workerPid] });

  const repeatOutput = runPowerShell(path.join(root, 'bin', 'serve-win.ps1'), ['-Port', port, '-AppPort', appPort, '-BindHost', '127.0.0.1', '-AppHost', '127.0.0.1']);
  assert.match(repeatOutput, /already running/);
  assert.equal(listenerPid(port), basePid, 'idempotent start must keep A pid');
  assert.equal(listenerPid(appPort), appPid, 'idempotent start must keep B pid');
  console.log(`IDEMPOTENCE EVIDENCE A=${basePid} B=${appPid} unchanged=true`);

  const stopOutput = runPowerShell(path.join(root, 'bin', 'stop-win.ps1'), ['-Port', port, '-AppPort', appPort]);
  started = false;
  assert.match(stopOutput, /stopped A\+B/);
  assert.ok(await waitFor(() => listenerPid(port) === 0 && listenerPid(appPort) === 0));
  assert.equal(processExists(basePid), false, 'A process must disappear');
  assert.equal(processExists(appPid), false, 'B process must disappear');
  assert.ok(await waitFor(() => !processExists(workerPid)), 'A worker process must disappear with its host');
  assert.throws(() => statSync(basePidFile), { code: 'ENOENT' });
  assert.throws(() => statSync(appPidFile), { code: 'ENOENT' });
  console.log(`STOP EVIDENCE portsReleased=true hostAppWorkerGone=true pidfilesGone=true`);

  const [timeoutPort, timeoutAppPort] = await pickOwnPortPair();
  const timeoutOutput = runPowerShell(
    path.join(root, 'bin', 'serve-win.ps1'),
    ['-Port', timeoutPort, '-AppPort', timeoutAppPort, '-BindHost', '127.0.0.1', '-AppHost', '127.0.0.1'],
    {
      expect: 1,
      timeout: 30_000,
      envOverride: {
        SOPHO_PORT: String(timeoutPort),
        SOPHO_APP_PORT: String(timeoutAppPort),
        SOPHO_TEST_BASE_START_DELAY_MS: '3000',
        SOPHO_TEST_START_TIMEOUT_SECONDS: '1',
        SOPHO_TEST_PROGRESS_INTERVAL_SECONDS: '1',
        SOPHO_TEST_LATE_CLEANUP_SECONDS: '10',
      },
    },
  );
  assert.match(timeoutOutput, /A start timed out: WMI call succeeded \(ReturnValue=0\)/);
  assert.match(timeoutOutput, /waited=\d+\.\d+s; measuredLongest=62\.425s; productionCap=125s/);
  assert.match(timeoutOutput, /cleanup: killed verified listener pid=\d+/);
  assert.ok(await waitFor(() => listenerPid(timeoutPort) === 0, 5000), 'late A listener must be removed after timeout');
  assert.equal(listenerPid(timeoutAppPort), 0, 'B must never start after A timeout');
  console.log(`SLOW TIMEOUT EVIDENCE waited=reported measuredLongest=62.425s lateListenerKilled=true portsReleased=${timeoutPort},${timeoutAppPort}`);

  const [wmiPort, wmiAppPort] = await pickOwnPortPair();
  const wmiFailureOutput = runPowerShell(
    path.join(root, 'bin', 'serve-win.ps1'),
    ['-Port', wmiPort, '-AppPort', wmiAppPort, '-BindHost', '127.0.0.1', '-AppHost', '127.0.0.1'],
    { expect: 1, envOverride: { SOPHO_TEST_WMI_CURRENT_DIRECTORY: 'Z:\\definitely-missing-sopho' } },
  );
  assert.match(wmiFailureOutput, /A WMI call failed: Win32_Process\.Create ReturnValue=8/);
  assert.match(wmiFailureOutput, /providerResult=.*ReturnValue\s+: 8/s);
  assert.doesNotMatch(wmiFailureOutput, /start timed out/);
  assert.equal(listenerPid(wmiPort), 0);
  assert.equal(listenerPid(wmiAppPort), 0);
  console.log('WMI FAILURE EVIDENCE ReturnValue=8 providerResult preserved timeoutMessage=false');

  const secondStop = runPowerShell(path.join(root, 'bin', 'stop-win.ps1'), ['-Port', port, '-AppPort', appPort], { expect: 1 });
  assert.match(secondStop, /nothing stopped|not running/);
  console.log('FALSE-SUCCESS EVIDENCE second stop exit=1');

  // ── 保留端口安全：收尾只读一次，同一批读数分两半用（本门名下 ⇒ 断言；共享 ⇒ 证据行）────────
  // ① 本门名下：本门用过的**每一个**端口都不许落在保留端口上（pickOwnPortPair 已逐对断言过，这里对全集再断言）。
  // ② 本门名下：`ownPids` 此处**故意为空** —— 本门的 A/B/worker 已在上面逐条核实消失（STOP/TIMEOUT/WMI
  //    证据里的 processExists=false 与端口已释放），此刻保留端口上的监听者按构造就是**别人的**；若它的 pid
  //    恰好等于本门用过的某个 pid，那是 Windows 的 pid 复用、仍不是本门的动作 ⇒ 不判定（只记录）。
  const ownPortsUsed = [port, appPort, timeoutPort, timeoutAppPort, wmiPort, wmiAppPort];
  const reservedAfter = Object.fromEntries(RESERVED_PORTS.map((value) => [value, listenerPid(value)]));
  const ownReserved = assertOwnReservedSafety({
    stage: 'teardown(ownPids 故意为空：本门那几个 pid 已核实消失，pid 对上只能是复用)',
    ownRequestedPorts: ownPortsUsed,
    ownPids: [],
    readListener: (value) => reservedAfter[value],
  });
  // ③ 共享的那一半：**只记录、不判定**。7331/7321 上是别人的监听者（活的 A/B 实例），本门只有只读观察。
  const reservedRows = foreignReservedPortReadings({ reservedPorts: RESERVED_PORTS, before: reservedBefore, after: reservedAfter });
  const foreignListenerPidChanged = reservedRows.some((row) => row.changed);
  const launchers = [path.join(temp, `sopho-run-base-${port}-${appPort}.cmd`), path.join(temp, `sopho-run-app-${port}-${appPort}.cmd`)]
    .map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.match(launchers, new RegExp(`SOPHO_PORT=${port}`));
  assert.match(launchers, new RegExp(`SOPHO_APP_PORT=${appPort}`));
  // 本门自己的启动器里不许出现保留端口（两个变量 × 两个保留端口，交叉组合一并管住）。
  assert.doesNotMatch(launchers, /(SOPHO_PORT|SOPHO_APP_PORT)=(7331|7321)\b/);
  console.log(`PORT SAFETY EVIDENCE requested=${ownPortsUsed.join(',')} ownViolations=${ownReserved.violations.length}`
    + ` reservedForeign=${reservedRows.map((row) => `${row.port}:${row.before}->${row.after}${row.changed ? '(changed)' : '(unchanged)'}`).join(',')}`
    + ` foreignListenerPidChanged=${foreignListenerPidChanged}`
    + ` attribution=7331/7321 上是**别人的**监听者（活的 A/B 实例）；本门对它们没有所有权、只有只读观察，`
    + `${foreignListenerPidChanged ? '它们在本门这段时间里变过 pid —— 那是别人重启了，不是本门的动作' : '它们在本门这段时间里 pid 没变'}；这一行**不参与判定**`);
  console.log('PASS win-serve: WMI diagnostics, slow-start progress, measured timeout evidence, late-listener cleanup, pid identity, idempotence, exact stop, reserved-port safety (own half asserted, foreign half recorded)');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  if (started) {
    try { runPowerShell(path.join(root, 'bin', 'stop-win.ps1'), ['-Port', port, '-AppPort', appPort]); } catch (error) { console.error(`cleanup stop failed: ${error.message}`); }
  }
  if (madeJunction) {
    try { execFileSync('cmd.exe', ['/d', '/c', 'rmdir', localModules], { stdio: 'pipe' }); } catch (error) { console.error(`junction cleanup failed: ${error.message}`); }
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
