// test/fixtures/windows-engine-shapes.mjs —— Windows 形状的**合成进程表行** ＋ 一条确定性驱动。
//
// 拿它干什么：不起浏览器、不读 procfs、不碰端口、不写盘 —— 只把「Windows 上进程命令行会长什么样」
// 一条条喂给 `test/harness.mjs` 的解析/归属判据（`browserEngineRootOf` / `engineCensus`），
// 看它们把「本次 run 自己的引擎」判成什么。使用者：
//   · `test/harness-contract.mjs` 的 ⑤ 组臂（入册，跟着 `npm run test:harness` 跑）；
//   · **也可以直接跑**（这就是「改前复现」那条路 —— 把同一个驱动指向**另一个版本**的字节）：
//
//       node test/fixtures/windows-engine-shapes.mjs                       # 打当前 test/harness.mjs
//       git show HEAD:test/harness.mjs > /tmp/h/harness.mjs
//       cp test/fixtures/windows-engine-shapes.mjs /tmp/h/
//       node /tmp/h/windows-engine-shapes.mjs /tmp/h/harness.mjs          # 打 HEAD 的字节
//
// 为什么要有它（2026-09-25，另一台机＝Windows/winbox 的维护者报的假红）：那边的正臂报
// 「本次 run 的引擎根 0 个」，而 Linux 上起真外来引擎复跑是**全绿** ⇒ 判别本身没坏，问题在
// **Windows 形状的命令行**上。那台机器够不着（没有 devices.json 条目、没有现场日志），所以这里把
// 「Windows 上命令行会长什么样」一条条写下来，让判据在**任何平台**上都能被确定性地驱动。
//
// ⚠️ 两条要如实说清的边界（报告里的「没验到什么」写的就是这两件）：
//   1. **这是合成夹具，不是真 Windows 现场。** 它证明的是「这些形状下判据怎么判」，不能替代在那台
//      机器上真跑一遍。逐形状的 `note` 写了它的依据与它在旧字节（HEAD）上的读数。
//   2. 归属那一层要**按行自己的路径形状**拆目录（`C:\…` vs `/…`）。所以有几行在 Linux 上打**旧**
//      字节会红，而旧字节在 Windows 上本来就对（那边 `path.dirname` 是 win32）—— 这种行标
//      `headOnWindows: 'ok'`，**不是**那台机器上的证据。真正的 Windows 形状缺陷标 `headOnWindows: 'red'`
//      （它们的成因是**纯字符串**的形状：旗标前面是 `"`、值后面还跟着位置参数 —— 解析里没有任何
//      平台分支，所以 Windows 上判得和这里一模一样）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const RUN_ID = '24136-9c2f7b30-1c4a-4e37-8b0d-6f9a3c1d2e55';   // 本次 run（形状同 ui-harness 的 `${pid}-${uuid}`）
export const OTHER_RUN_ID = '1177-4f8e2a10-9c3d-4b21-a7e5-0d2b6c8f1a33'; // 别人的 / 上一次 run 的

// 下面这些字面量照着维护者那台机的形状写：用户名 `user`、`%TEMP%` = `C:\Users\user\AppData\Local\Temp`
// （依据：本仓 docs/history/cutover-winbox-execution-2026-09-19.md 的原始输出里的真实路径）。
const CHROME_EXE = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
const WIN_TEMP = 'C:\\Users\\user\\AppData\\Local\\Temp';
const SPACE_TEMP = 'C:\\Users\\John Smith\\AppData\\Local\\Temp';   // 用户名带空格的那台机（见 win-whole-arg-quoted）
const SANDBOX = `${WIN_TEMP}\\sopho-ui-3Kd9Qa`;                     // 本次 run 的沙箱（令牌 id = RUN_ID）
const PROFILE = `${SANDBOX}\\chromium`;
const SPACE_SANDBOX = `${SPACE_TEMP}\\sopho-ui-Qq7Zz1`;             // 本次 run 的**另一个**沙箱（只为演示引号形状）
const SPACE_PROFILE = `${SPACE_SANDBOX}\\chromium`;
const FOREIGN_PROFILE = 'C:\\Users\\user\\AppData\\Local\\io.github.clash-verge-rev.clash-verge-rev\\EBWebView'; // 别人的引擎（Tauri/WebView2）
const STALE_SANDBOX = `${WIN_TEMP}\\sopho-ui-Old123`;               // 上一次 run 的残留（%TEMP% 里那 393 个之一）
const POSIX_SANDBOX = '/tmp/sopho-ui-3Kd9Qa';
export const OWN_PID = 70001;            // 快照里**自己那颗引擎**的 pid（写死 —— 夹具要确定性；其余行按行序递增）
export const SECOND_OWN_PID = 70100;     // 「自己多起来的」第二个引擎的 pid

/** 本次 run 自己的引擎，**同一个引擎的不同命令行形状**（`profileDir` 是句柄会给的那个值）。 */
export const OUR_ENGINE_SHAPES = {
  'posix-control': {
    what: '对照：Linux 上真跑出来的那一行（2026-09-25 实测 procfs 的 cmdline 原文）',
    note: 'chromium 在 `--user-data-dir` 后面又追加了一批开关（`--noerrdialogs --no-first-run --ozone-platform=headless …`），旧口径「值取到下一个 ` --`」才侥幸没吞到 `about:blank` —— 那是**它的 argv 布局**，不是可以依赖的保证',
    headOnWindows: 'ok',
    commandLine: `/usr/lib/chromium/chromium --headless=new --no-sandbox --disable-gpu --remote-debugging-port=51234 --user-data-dir=${POSIX_SANDBOX}/chromium --noerrdialogs --no-first-run --ozone-platform=headless --ozone-override-screen-size=800,600`,
    sandbox: POSIX_SANDBOX,
    profileDir: `${POSIX_SANDBOX}/chromium`,
    debugPort: 51234,
    tokenId: RUN_ID,
  },
  'win-unquoted-junk-tail': {
    what: 'CIM 原文：`--user-data-dir=` 后面还跟着位置参数 `about:blank`（那台机的 %TEMP% 没有空格 ⇒ 参数不带引号）',
    note: '旧字节：值被吞成 `…\\chromium about:blank`（`path.win32.dirname` 仍然给出对的沙箱 ⇒ 归属是对的，但「引擎报的 profileDir == 句柄的」那条严格断言在那边会红；Linux 上这一行连归属都红了）',
    headOnWindows: 'red',
    commandLine: `${CHROME_EXE} --headless=new --no-sandbox --disable-gpu --remote-debugging-port=51234 --user-data-dir=${PROFILE} about:blank`,
    sandbox: SANDBOX,
    profileDir: PROFILE,
    debugPort: 51234,
    tokenId: RUN_ID,
  },
  'win-whole-arg-quoted': {
    what: '路径里有空格 ⇒ win32 上给**整个参数**加引号：`"--user-data-dir=C:\\Users\\John Smith\\…\\chromium"`（旗标前面是 `"`，不是空白）',
    note: '旧字节：这一行**根本不是引擎根**（旧正则要求旗标前是行首或空白）⇒ 自己那颗引擎凭空消失（`mine` 0 个，且没有任何诊断 —— 维护者报回来的就是这个形状的错误信息）。依据：本仓 docs/history/cutover-winbox-execution-2026-09-19.md 的原始读数里，带空格的 exe 路径被引号包着、不带空格的参数没有引号',
    headOnWindows: 'red',
    commandLine: `${CHROME_EXE} --headless=new --no-sandbox --disable-gpu --remote-debugging-port=51234 "--user-data-dir=${SPACE_PROFILE}" about:blank`,
    sandbox: SPACE_SANDBOX,
    profileDir: SPACE_PROFILE,
    debugPort: 51234,
    tokenId: RUN_ID,
  },
  'win-quoted-value-junk-tail': {
    what: 'chrome 风格的引号值（`--user-data-dir="…"`）＋ 后面还跟着 `about:blank`',
    note: '旧字节：「去引号」那条判定（要求整个值以 `"` 结尾）不成立 ⇒ 值里同时留着引号与尾巴 ⇒ 沙箱推断错 ⇒ 判成 `foreign`（`mine` 0 个）',
    headOnWindows: 'red',
    commandLine: `${CHROME_EXE} --headless=new --no-sandbox --disable-gpu --remote-debugging-port=51234 --user-data-dir="${SPACE_PROFILE}" about:blank`,
    sandbox: SPACE_SANDBOX,
    profileDir: SPACE_PROFILE,
    debugPort: 51234,
    tokenId: RUN_ID,
  },
  'win-forward-slashes': {
    what: '盘符 ＋ 正斜杠（Windows 上两种分隔符等价，`C:/x\\y` 与 `c:\\X\\y\\` 是同一个目录）',
    note: '旧字节在 Windows 上本来就判得对（那边的 `path.dirname` 是 win32）；这一行在 **Linux 上打旧字节**才暴露「沙箱推断用了宿主的 path」这件事 ⇒ 标 `headOnWindows: ok`，**不是**那台机器上的证据',
    headOnWindows: 'ok',
    commandLine: `${CHROME_EXE} --headless=new --no-sandbox --disable-gpu --remote-debugging-port=51234 --user-data-dir=${SANDBOX.replaceAll('\\', '/')}/chromium about:blank`,
    sandbox: SANDBOX,
    // 逐字读数 = 它自己报的那个拼法（正斜杠）；`handleProfileDir` 是句柄会拿的那个拼法（反斜杠）。
    // 两者是**同一个目录**（Windows 的规矩）：归属必须对，`sameDirectory` 也必须判 true —— 那一条的臂
    // 住 `test/harness-contract.mjs`（新加的入口，不在这份只靠旧入口的夹具里）。
    profileDir: `${SANDBOX.replaceAll('\\', '/')}/chromium`,
    handleProfileDir: `${SANDBOX}\\chromium`,
    debugPort: 51234,
    tokenId: RUN_ID,
  },
};

/** 夹具的假文件系统：沙箱根 → 令牌 id。查不到 ⇒ null（= 那个目录上没有令牌文件）。 */
export function tokenReaderOf(entries) {
  const table = new Map(entries.map(([directory, id]) => [foldWindowsPath(directory), id]));
  return (directory) => {
    const id = table.get(foldWindowsPath(directory));
    return id === undefined ? null : { id };
  };
}

// **按 Windows 的路径同一性查**（`\` 与 `/` 等价、大小写不敏感、尾部多余分隔符不算）—— 真 Windows 上
// `readFile()` 就是这么解析的（文件系统本身不区分大小写与分隔符），所以这不是在放水，是在照着那边
// 文件系统的规矩模拟。POSIX 形状的值走同一把折子：本夹具里的 POSIX 行只有一条对照，低小写不影响它。
function foldWindowsPath(value) {
  return String(value).replace(/[\\/]+$/, '').replaceAll('/', '\\').toLowerCase();
}

/** 一次 `boot()` 之后现场的**合成快照**：自己的引擎（按给定形状）＋ 自家子树 ＋ 别人的引擎 ＋ 上一次 run 的残留。
 *  行序、pid、父 pid 都写死（夹具要确定性）；`--type=` 子进程、crashpad、读不到命令行的行都在里面 ——
 *  判据「只数引擎根」是不是真的把子树摘掉了，靠的就是它们。 */
export function snapshotRows(shapeId) {
  const shape = OUR_ENGINE_SHAPES[shapeId];
  assert.ok(shape, `夹具里没有这个形状：${shapeId}`);
  const rows = [
    { name: 'chrome.exe', ppid: 1, commandLine: shape.commandLine },                                     // ← 自己的引擎根（形状可变）
    { name: 'chrome.exe', ppid: 0, commandLine: `${CHROME_EXE} --type=renderer --user-data-dir="${shape.profileDir}" --remote-debugging-port=${shape.debugPort} --lang=en-US` },  // 自家 renderer（带 --type= ⇒ 不算根）
    { name: 'chrome.exe', ppid: 0, commandLine: `${CHROME_EXE} --type=utility --utility-sub-type=network.mojom.NetworkService --user-data-dir=${shape.profileDir} --noerrdialogs` }, // 自家 utility
    { name: 'chrome_crashpad_handler.exe', ppid: 1, commandLine: `chrome_crashpad_handler --monitor-self --database="${shape.sandbox}\\xdg-config\\chromium\\Crash Reports" --annotation=plat=Win64` }, // crashpad（不带 --user-data-dir ⇒ 不算根）
    { name: 'clash-verge.exe', ppid: 1, commandLine: `"C:\\Program Files\\Clash Verge\\clash-verge.exe" --user-data-dir="${FOREIGN_PROFILE}"` },                          // 别人的引擎（维护者现场那条 pid=25936 的形状）
    { name: 'chrome.exe', ppid: 1, commandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --user-data-dir=${STALE_SANDBOX}\\chromium about:blank` }, // 上一次 run 的残留（%TEMP% 里那 393 个之一）
    { name: 'svchost.exe', ppid: 1, commandLine: '' },                                                    // CIM 偶发读不到命令行（docs/ops/handoff.md 记过）
    { name: 'steamwebhelper.exe', ppid: 1, commandLine: '"C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win7x64\\steamwebhelper.exe" --user-data-dir="C:\\Program Files (x86)\\Steam\\config\\htmlcache"' }, // 用户自己的、带同样旗标的进程（只记录）
  ];
  return rows.map((row, index) => ({ pid: OWN_PID + index, pgid: null, state: '', ...row }));
}

/** 快照里那几个具名角色（断言用；不许靠「第几行」猜）。 */
export function rolesOf(rows) {
  const find = (needle) => rows.find((row) => row.commandLine.includes(needle));
  return {
    ownPid: rows[0].pid,
    clash: find('clash-verge'),
    stale: find('sopho-ui-Old123'),
    renderer: find('--type=renderer'),
    crashpad: find('chrome_crashpad_handler'),
    steam: find('steamwebhelper'),
  };
}

/** 每个形状的**假令牌表**（真令牌文件写在沙箱根上，见 `test/ui-harness.mjs` 的 `RUN_TOKEN_NAME`）。 */
const TOKEN_ENTRIES = {
  'posix-control': [[POSIX_SANDBOX, RUN_ID]],
  'win-unquoted-junk-tail': [[SANDBOX, RUN_ID]],
  'win-whole-arg-quoted': [[SPACE_SANDBOX, RUN_ID]],
  'win-quoted-value-junk-tail': [[SPACE_SANDBOX, RUN_ID]],
  'win-forward-slashes': [[SANDBOX, RUN_ID]],
};

/** 把「自己的引擎换成形状 X」的快照交给 `engineCensus`，返回原始普查读数。 */
export async function censusForShape(harness, shapeId, { runId = RUN_ID } = {}) {
  const rows = snapshotRows(shapeId);
  return {
    rows,
    census: await harness.engineCensus({ runId, tokenIdOf: tokenReaderOf(TOKEN_ENTRIES[shapeId]), table: rows }),
  };
}

/** 形状 X 对应的**合成句柄**（就是 `boot()` 会给的那些字段：`port` = 静态服务、`debugPort` = 引擎的、
 *  `cleanup.pid` = 本 run 那颗引擎的 pid）。 */
export function handleForShape(shapeId, { port = 51000 } = {}) {
  const shape = OUR_ENGINE_SHAPES[shapeId];
  assert.ok(shape, `夹具里没有这个形状：${shapeId}`);
  return { port, debugPort: shape.debugPort, profileDir: shape.profileDir, sandbox: shape.sandbox, cleanup: { pid: OWN_PID } };
}

/** 与 `handleForShape` 配套的**合成监听行**（每个端口一条；真实路径里这一份是 `listenerRows()` 的返回）。 */
export function syntheticListenerRowsOf(shapeId, { port = 51000, serverPid = process.pid } = {}) {
  const shape = OUR_ENGINE_SHAPES[shapeId];
  assert.ok(shape, `夹具里没有这个形状：${shapeId}`);
  return new Map([
    [port, [{ address: '127.0.0.1', port, pid: serverPid, state: 'LISTEN', raw: `synth static service :${port}` }]],
    [shape.debugPort, [{ address: '127.0.0.1', port: shape.debugPort, pid: OWN_PID, state: 'LISTEN', raw: `synth devtools :${shape.debugPort}` }]],
  ]);
}

/** win32 上 node/libuv 的规矩：参数里有空白才给**整个参数**加引号（没空白就不加）。夹具里自己拼
 *  命令行时按这条来 —— 否则「带空格的路径」会变成一行本来就拼错了的命令行。 */
function flagArg(name, value) {
  const text = `${name}=${value}`;
  return /\s/.test(text) ? `"${text}"` : text;
}

/** 快照 ＋ 一个**自己多起来的**第二个引擎（句柄没指名的那个：同一个沙箱下的 `chromium2`）。
 *  反证臂用它 —— 就是「一次 `boot()` 自己起了两个引擎」在合成夹具里的同形。 */
export async function censusWithSecondOwnEngine(harness, shapeId) {
  const shape = OUR_ENGINE_SHAPES[shapeId];
  const rows = [...snapshotRows(shapeId), {
    pid: SECOND_OWN_PID, ppid: 1, name: 'chrome.exe', state: '', pgid: null,
    commandLine: `${CHROME_EXE} --headless=new --no-sandbox ${flagArg('--user-data-dir', `${shape.sandbox}\\chromium2`)} ${flagArg('--remote-debugging-port', '51235')} about:blank`,
  }];
  return { rows, census: await harness.engineCensus({ runId: RUN_ID, tokenIdOf: tokenReaderOf(TOKEN_ENTRIES[shapeId]), table: rows }) };
}

/** 令牌表里**没有**本 run 的沙箱（= 令牌文件没写上 / 读不到 / 被删）—— 「自己那颗引擎认不出来」在
 *  合成夹具里的同形：本 run 的引擎根必须是 0 个。 */
export async function censusWithoutOwnToken(harness, shapeId) {
  const rows = snapshotRows(shapeId);
  return { rows, census: await harness.engineCensus({ runId: RUN_ID, tokenIdOf: tokenReaderOf([[STALE_SANDBOX, OTHER_RUN_ID]]), table: rows }) };
}

/** 形状清单：**只许增、不许静默减** —— 少一个形状（或者少一条依据/读数说明）这条驱动自己就会红。 */
export const SHAPE_INVENTORY = Object.freeze([
  'posix-control',
  'win-unquoted-junk-tail',
  'win-whole-arg-quoted',
  'win-quoted-value-junk-tail',
  'win-forward-slashes',
]);

/**
 * 驱动本体：返回 `[[臂名, 函数], …]`（`test/harness-contract.mjs` 把它喂给 `runArms`）。
 * `harness` = 一个至少带 `engineCensus` 的对象（`test/harness-contract.mjs` 把它喂进来；直接跑时是
 * `import` 整个模块）—— **注入**，所以同一条驱动能打任何版本的字节（见文件头的两条命令）。
 * 旧字节也有的那两个入口（`engineCensus` / `browserEngineRootOf`）就是这一份用的全部；新加的判据原文
 * （`oneEngineProblems` 等）的臂住 `test/harness-contract.mjs`。
 */
export function windowsEngineShapeArms(harness) {
  const arms = [];
  for (const shapeId of SHAPE_INVENTORY) {
    const shape = OUR_ENGINE_SHAPES[shapeId];
    arms.push([`⑤${shapeId}：Windows 形状下「自己那颗引擎」必须被认出来（归属＋逐字 profileDir）`, async () => {
      const { rows, census } = await censusForShape(harness, shapeId);
      const { ownPid, clash, stale, steam, renderer, crashpad } = rolesOf(rows);
      assert.equal(census.mine.length, 1, `本 run 的引擎根应有 1 个（形状 ${shapeId}），实测 ${census.mine.length} 个 —— 行原文：${shape.commandLine}`);
      assert.equal(census.mine[0].pid, ownPid, `认出来的不是自己的那一行（形状 ${shapeId}）：${JSON.stringify(census.mine.map((row) => row.pid))}`);
      assert.equal(census.mine[0].userDataDir, shape.profileDir, `profileDir 的逐字读数不对（形状 ${shapeId}）`);
      // 自家子树不算引擎根（判据的前提之一：`--type=` 子进程与 crashpad 必须被摘掉）。
      const rootPids = new Set([...census.mine, ...census.foreign].map((row) => row.pid));
      assert.ok(!rootPids.has(renderer.pid) && !rootPids.has(crashpad.pid), `自家子树（renderer pid=${renderer.pid} / crashpad pid=${crashpad.pid}）不算引擎根（形状 ${shapeId}）`);
      const foreignPids = census.foreign.map((row) => row.pid).sort((a, b) => a - b);
      assert.deepEqual(foreignPids, [clash.pid, stale.pid, steam.pid].sort((a, b) => a - b), `别人的引擎应恰好是那三条（形状 ${shapeId}），实测 ${JSON.stringify(census.foreign.map((row) => ({ pid: row.pid, tokenId: row.tokenId })))}`);
      return { shape: shapeId, headOnWindows: shape.headOnWindows, own: `pid=${ownPid}`, mine: census.mine.length, foreign: census.foreign.length };
    }]);
  }
  arms.push(['⑤z 归属只认带内令牌：把本 run 的 id 换掉 ⇒ 自己那颗必须变成 foreign（夹具不是橡皮章）', async () => {
    const { census } = await censusForShape(harness, 'win-unquoted-junk-tail', { runId: 'another-run-entirely' });
    assert.equal(census.mine.length, 0, `令牌 id 不是本次 run 时，本 run 的引擎根必须是 0 个，实测 ${census.mine.length} 个`);
    assert.ok(census.foreign.some((row) => row.pid === OWN_PID), '换了令牌 id 之后，那一行必须落在 foreign 里（归属判据真的看令牌）');
    return { mine: 0, foreign: census.foreign.length };
  }]);
  arms.push(['⑤y 形状清单不许静默缺项（少一个形状 / 少一条依据，这条驱动自己红）', async () => {
    for (const shapeId of SHAPE_INVENTORY) {
      const shape = OUR_ENGINE_SHAPES[shapeId];
      assert.ok(shape, `SHAPE_INVENTORY 里列了 ${shapeId}，但 OUR_ENGINE_SHAPES 里没有它`);
      for (const field of ['what', 'note', 'headOnWindows', 'commandLine', 'sandbox', 'profileDir', 'debugPort', 'tokenId']) {
        assert.ok(shape[field] !== undefined && shape[field] !== '', `形状 ${shapeId} 缺字段 ${field}（依据/读数必须写在夹具里，不许只留一行命令）`);
      }
      assert.ok(['ok', 'red'].includes(shape.headOnWindows), `形状 ${shapeId} 的 headOnWindows=${shape.headOnWindows}，只许是 ok / red`);
    }
    assert.deepEqual(Object.keys(OUR_ENGINE_SHAPES).sort(), [...SHAPE_INVENTORY].sort(), 'OUR_ENGINE_SHAPES 与 SHAPE_INVENTORY 必须一一对应（多出来的形状也要入册）');
    return { shapes: SHAPE_INVENTORY.length };
  }]);
  return arms;
}

// ── 直接跑（「改前复现」那条路） ────────────────────────────────────────────────────────────────
// 用法：node test/fixtures/windows-engine-shapes.mjs [另一个版本的 harness.mjs]
// 打印每个形状一行读数（`mine` 几个、归属落在谁身上），任一臂红 ⇒ 退出码 1。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness.mjs');
  const harness = await import(`file://${target}`);
  process.stdout.write(`windows-engine-shapes：拿 ${target} 跑 ${SHAPE_INVENTORY.length} 个 Windows 形状（合成夹具，不是真 Windows 现场）\n`);
  let failed = 0;
  for (const [name, run] of windowsEngineShapeArms(harness)) {
    try {
      const detail = await run();
      process.stdout.write(`PASS  ${name} ${JSON.stringify(detail)}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  process.stdout.write(`${failed === 0 ? 'ALL GREEN' : `${failed} FAILED`} —— ${target}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
