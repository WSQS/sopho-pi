#!/usr/bin/env node
// test/designer-cli.mjs —— `bin/designer.mjs`（提案 C：把 CDP 配方封成一条 CLI）的机械门。
//
// 判据出处：业主 2026-09-28 拍板「做提案 C ✓」时逐条点名的三件：
//   ① 用**现成的** `design/samples/two-pane/main-screen.json` 跑 CLI ⇒ 断言**真产出**文件（HTML/SVG，`--png` 时加 PNG）
//      且内容含文档里的元素；
//   ② 给一份**坏文档** ⇒ 断言**非零退出 ＋ 有原因 ＋ 不产出半成品**；
//   ③ **反证臂**：CLI 吞掉页面里抛的错（假装成功）⇒ 必红。
// 另外两条本门自己加的（都是交付口径，不是"大概对"）：
//   · **收尾要干净**：CLI 打印的 work 目录必须真的不在盘上、它起的 Chromium pid 必须真的没了（`processAlive` 读一次）；
//   · **回执不许编**：CLI 打印的「N 字节」必须与盘上那个文件的真实大小逐个相等（产物路径也逐个对上）。
//
// 这道门怎么跑（真 Chromium ＋ CLI 子进程 ＋ 真文件）：
//   `node bin/designer.mjs <文档> --out <目录> …` 是一个**真子进程**（`spawnSync`），它自己起真 Chromium、
//   自己起静态服务、自己说 CDP、把产物写到盘上；门这边只做两件事：**跑它**、**量盘上的东西**。
//   ⇒ 门不需要浏览器底座（浏览器是 CLI 起的），但它要求 `CHROME_BIN` 指向真 Chromium（与别的门同一条约定）。
//
// ⚠️ **本门的沙箱路径必须短**（2026-09-25 核实）：Chromium 的单例 socket 建在
//   `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket`，整条路径必须 **< 108 字节**（Linux
//   `sockaddr_un.sun_path` 是 108，含结尾 NUL）；而 `bin/designer.mjs` 的 work 目录就是
//   `$TMPDIR/designer-cli-<pid>-<6>` ⇒ socket 路径 = `len(work) + 49`。超了 Chromium **自己**
//   `LOG(FATAL)` 并当场 **SIGABRT**（实测：socket 路径 107 正常、108 崩）——CLI 把它**误报**成
//   「调试端点 30s 没起来」（这是 `bin/**` 那侧的缺陷，见 `docs/ops/handoff.md` 的引注与报告）。
//   本门自己的路径因此按「`len(work) + 49 < 108`」摆（`dzcli-*` ＋ `$TMPDIR/t`，见 `inheritedTmp`），
//   并有 `cli:work-path-fits-chromium-singleton-socket` 这条机械防线盯着 —— 别再把沙箱路径加长。
//
// 反证臂（各自必红；各改 `bin/designer.mjs` 的一份**副本**，真 `bin/**` 一个字节不动）：
//   `--reverse-arm=cli-swallows-errors` —— `pageResultOrThrow()` 里那行抛出换成「什么都不做」
//     ⇒ 坏文档会被**假装成功**（退 0、还写出产物）⇒ `cli:bad-doc-exit` / `cli:bad-doc-no-half-products` 必红。
//   `--reverse-arm=cli-no-isolation` —— `browserEnv()` 那行换成「把继承来的环境原样交出去」
//     ⇒ 那份私有的 `home/ tmp/ xdg-config/ xdg-cache/` 布局不见了 ⇒ `cli:isolation` 必红。
//   `--reverse-arm=multi-allstates-first-only` —— 规划里 `chosen = states;` 换成 `chosen = states.slice(0, 1);`
//     ⇒ `--all-states` 只出每一屏的第一态 ⇒ `cli:multi-count` / `cli:multi-content` 必红。
//   `--reverse-arm=artifact-name-without-target` —— `artifactName()` 里那行换成不带屏/状态的 `design-<基名>.<ext>`
//     ⇒ 多份产物盖成一堆同名文件（本 CLI 会把撞车当场拒掉，于是盘上什么也没有）⇒ 同样两格必红。
//   `--reverse-arm=cli-ignores-signal-exit` —— `departed()` 那行去掉 `signalCode`（= 2026-09-25 那个真缺陷本身）
//     ⇒ 被信号杀掉时 `exitCode` 是 `null`、永远等不到退出 ⇒ `cli:receipt-signal-death` 必红。
//   `--reverse-arm=cli-only-watches-direct-child` —— `stopBrowser()` 入口那个条件只剩「直接子进程退没退」
//     ⇒ 逃出进程组的那一支不被等、也不被按 pid 补刀 ⇒ `cli:cleanup-tree` 必红。
//   `--reverse-arm=cli-long-temp-root` —— `tempRoot()` 里 `const fits = …` 换成 `const fits = true;`
//     ⇒ 长 `TMPDIR` 照旧被当成工作根、Chromium 自己 SIGABRT ⇒ `cli:work-short-root` 必红。
//   ⚠️ 副本要跟一份 `web/` 的副本一起放在沙箱里（CLI 是从**自己文件的位置**找 `../web` 的 ——
//     与别的反证臂「改的是临时目录里 web/ 的副本」同一个口径）。
//
// 用法：CHROME_BIN=<chromium> node test/designer-cli.mjs [--reverse-arm=cli-swallows-errors|cli-no-isolation|multi-allstates-first-only|artifact-name-without-target|cli-ignores-signal-exit|cli-only-watches-direct-child|cli-long-temp-root]
// 真名（`package.json`；前两个是本名，后两个是给「按 designerui 那套手感敲」的人的别名，跑的是**同一个门**）：
//   npm run test:designer-cli                    ／ npm run test:designercli（别名：上一版报告里那个名字）
//   npm run test:designer-cli:reverse-swallow     ／ npm run test:designerui:reverse-cli（别名：按 designerui 那套手感敲的名字）
//   npm run test:designer-cli:reverse-noisolation （`cli-no-isolation` 臂）
//   npm run test:designer-cli:reverse-allstates   （`multi-allstates-first-only` 臂）
//   npm run test:designer-cli:reverse-flatname    （`artifact-name-without-target` 臂）
//   2026-09-25 加的三条：
//   npm run test:designer-cli:reverse-signal      （`cli-ignores-signal-exit` 臂）
//   npm run test:designer-cli:reverse-treekill    （`cli-only-watches-direct-child` 臂）
//   npm run test:designer-cli:reverse-longtmp     （`cli-long-temp-root` 臂）
//
// 纪律：本门**不自己做进程管理** —— 「谁还引用着那个 work 目录」一律问 `test/harness.mjs` 的
// `processesReferencingPath()`（跨平台分叉住那一层，见 `test/harness-contract.mjs`）。
//
// 沙箱：本门自己的临时目录（mkdtemp）＋ 收尾走 `test/harness.mjs` 的 `removeSandbox`/`finishCleanup`；
// CLI 自己那个 work 目录由它自己删（门只**核**它真的删了）——**绝不 pkill**，产物目录都在本门沙箱里。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { finishCleanup, processAlive, processesReferencingPath, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'bin', 'designer.mjs');
const SAMPLE = path.join(root, 'design', 'samples', 'two-pane', 'main-screen.json');
const DOC = JSON.parse(readFileSync(SAMPLE, 'utf8'));
const DOC_IDS = [];
(function walk(element) { DOC_IDS.push(element.id); for (const child of element.children ?? []) walk(child); }(DOC.screens[0].root));
// 画布今天**不认识** `type:"instance"`（`web/designer.js:135` 的 `TYPES` 里没有它，也没有 `components` 的读者）
// ⇒ 实例节点在画布里被画成**零高**（HTML 里有 `<div data-id="rp-m3">`，但它没有内容 ⇒ `getBoundingClientRect().height == 0`）
// ⇒ 屏 SVG 里**唯独它没有** `<rect data-id>`（SVG 发射器要求 `w>0 && h>0`）。这是二期的事（本单不动画布）。
// 下面把「缺席的**恰好**是这些实例节点」也钉成判据 —— 别的元素少一个照样红；将来画布学会画实例、
// 它出现在 SVG 里，这条集相等也会红（那时该来这里把口径换成「实例也要在」）。
const INSTANCE_IDS = [];
(function walk(element) { if (element.type === 'instance') INSTANCE_IDS.push(element.id); for (const child of element.children ?? []) walk(child); }(DOC.screens[0].root));
const ROOT_SIZE = { w: Number(DOC.screens[0].root.size?.w?.value ?? 0), h: Number(DOC.screens[0].root.size?.h?.value ?? 0) };
const STATE_COUNT = DOC.screens.reduce((total, screen) => total + (screen.states ?? []).length, 0);
const TRANSITION_COUNT = (DOC.transitions ?? []).length;
// 转移图里**画得出来**的转移：两端都得指得到一个（屏, 状态）节点 —— 页面 `flowSvg()` 里就这一条规矩
// （`byKey.get(`${from.screen}/${from.state}`)`），指不出来的它是 `continue` **静默跳过**。
// ⚠️ 2026-09-25 实测：`design/samples/two-pane/main-screen.json` 那份稿的 4 条转移**只写了 `screen`、没写 `state`**
//    （冻结 v0 里 `from`/`to` 是 `{screen, state}`）⇒ 页面的转移图里 0 根箭头，而且它**一声不响**。
//    下面这批期望值全从文档算出来，所以那份样例再改也不会把「样例改了」当成「CLI 坏了」。
const DOC_STATE_KEYS = new Set();
for (const screen of DOC.screens) for (const st of (screen.states ?? [])) DOC_STATE_KEYS.add(`${screen.id}/${st.id}`);
const RESOLVABLE_TRANSITIONS = (DOC.transitions ?? []).filter((transition) =>
  DOC_STATE_KEYS.has(`${transition.from?.screen}/${transition.from?.state}`)
  && DOC_STATE_KEYS.has(`${transition.to?.screen}/${transition.to?.state}`));
const UNRESOLVABLE_TRANSITIONS = (DOC.transitions ?? []).filter((transition) => !RESOLVABLE_TRANSITIONS.includes(transition));
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;

// ── 断言簿（一次把红列全，最后统一判）──────────────────────────────────────────────────────────
let checks = 0;
const checkIds = [];
const failures = [];
const problems = [];
function check(id, name, ok, detail) {
  checks += 1;
  checkIds.push(id);
  process.stdout.write(`${ok ? '✓' : '✗'} [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  if (!ok) failures.push({ id, name, detail });
  return ok;
}
/** 本平台跑不了的判据：**明确印出来**并记进 `skips`（**跳过 ≠ 通过**，绝不当绿）。 */
const skips = [];
function skip(id, name, reason) {
  skips.push(`${id}: ${reason}`);
  process.stdout.write(`⊘ [${id}] ${name} —— 本平台不适用 ⇒ **跳过**（跳过 ≠ 通过）：${reason}\n`);
}

// ── 反证臂：在**副本**上改一处 ─────────────────────────────────────────────────────────────────
// ⚠️ 每条臂都声明 `file:`（它盯的那个接缝住在哪个文件里）—— 给 `test:armseams` 的「声明目标里恰好 1 处」那条
// 静态判据一个落点；施加处另有「命中恰好一处才改」的运行期守卫（见下面 `if (ARM)` 那一段）。
// 两条一起，`String.replace` 配字符串只改第一处这件事就再也骗不了这条臂。
const ARM_MUTANTS = {
  'cli-swallows-errors': {
    what: '让 CLI **吞掉**页面抛的错（`pageResultOrThrow()` 里那行抛出换成「什么都不做」）⇒ 坏文档被假装成功',
    file: 'bin/designer.mjs',
    from: '  if (details) throw new CliError(`${what}：页面抛了 —— ${pageErrorMessage(details)}`, code);',
    to: '  if (details) return;',
    expect: ['cli:bad-doc-exit', 'cli:bad-doc-no-half-products'],
  },
  'cli-no-isolation': {
    what: '让 CLI 把**继承来的环境**原样交给浏览器（`browserEnv()` 那行换成 `{ env: process.env }`）⇒ 私有 home/tmp/xdg 布局不见了',
    file: 'bin/designer.mjs',
    from: '  const { env } = browserEnv(work);',
    to: '  const { env } = { env: process.env };',
    expect: ['cli:isolation'],
  },
  'multi-allstates-first-only': {
    what: '让 `--all-states` **只出每一屏的第一态**（`chosen = states;` 换成 `chosen = states.slice(0, 1);`）⇒ 多状态的屏少出一份、而且那份的内容对不上',
    file: 'bin/designer.mjs',
    from: '      chosen = states;',
    to: '      chosen = states.slice(0, 1);',
    expect: ['cli:multi-count', 'cli:multi-content'],
  },
  'artifact-name-without-target': {
    what: '让 HTML/SVG/PNG 的产物名**不带屏/状态**（`artifactName()` 里那行换成 `design-<基名>.<ext>`）⇒ 多份产物盖成一堆同名文件（本 CLI 现在会把撞车当场拒掉，所以是一份也写不出来）',
    file: 'bin/designer.mjs',
    from: '  return `design-${docBase}.${idSegment(target.screenId)}.${idSegment(target.stateId)}.${ARTIFACT_EXT[kind]}`;',
    to: '  return `design-${docBase}.${ARTIFACT_EXT[kind]}`;',
    expect: ['cli:multi-count', 'cli:multi-content'],
  },
  'cli-long-temp-root': {
    what: '让 CLI **不看**单例 socket 有多长（`tempRoot()` 里那行换成 `const fits = true;`）⇒ 继承来的长 `TMPDIR` 照旧被当成工作根，Chromium 自己 SIGABRT',
    file: 'bin/designer.mjs',
    from: '    const fits = socketLen === null || socketLen < SOCKET_PATH_LIMIT;',
    to: '    const fits = true;',
    expect: ['cli:work-short-root'],
  },
  'cli-ignores-signal-exit': {
    what: '让 CLI **只认 `exitCode`**（`departed()` 里那行去掉 `signalCode`）—— 就是 2026-09-25 那个缺陷本身：被**信号**杀掉的子进程 `exitCode` 是 `null` ⇒ 报成「30 s 超时」、收尾写「可能还在」',
    file: 'bin/designer.mjs',
    from: 'const departed = (child) => !child || child.exitCode !== null || child.signalCode !== null;',
    to: 'const departed = (child) => !child || child.exitCode !== null;',
    expect: ['cli:receipt-signal-death'],
  },
  'cli-only-watches-direct-child': {
    what: '让收尾**只看直接子进程退没退**（`stopBrowser()` 入口那个条件里去掉「还有别的进程引用着 work」那一半）—— 就是 2026-09-25 那个缺陷本身的形状：逃出进程组的那一支（真 `chrome_crashpad_handler` 自己 setsid）不被等、也不被按 pid 补刀 ⇒ 2.5 s 后它把 work 目录写回来',
    file: 'bin/designer.mjs',
    from: '  if (!departed(child) || (processesReferencing(work) ?? []).length > 0) {',
    to: '  if (!departed(child)) {',
    expect: ['cli:cleanup-tree'],
  },
};

// 前缀刻意短（`dzcli-`）：这个沙箱是 CLI「继承来的 TMPDIR」的上级，而 Chromium 单例 socket 的
// 路径上界是 108 字节（见文件头那段）——长前缀会把本门自己顶崩。
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dzcli-'));
let cliPath = CLI;
if (ARM) {
  const arm = ARM_MUTANTS[ARM];
  if (!arm) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
  // 声明与施加处必须指同一个文件：声明漂了的话，臂会「改 A、声明盯 B」——门在 B 里照样绿，而它其实没动 B。
  const declared = path.relative(root, CLI).split(path.sep).join('/');
  if (declared !== arm.file) throw new Error(`反证臂 ${ARM} 声明盯的是 ${arm.file}，实际改的是 ${declared} —— 声明与施加处不一致`);
  const source = readFileSync(CLI, 'utf8');
  if (!source.includes(arm.from)) throw new Error(`反证臂 ${ARM} 的改写没命中（接缝形状变了？）：${arm.what}`);
  // ⚠️ 命中**恰好一处**才改（`String.replace` 配字符串只改第一处）—— 同 `test/designer-ui.mjs`：
  // 接缝若在 `arm.file` 里出现两次，臂就会改到别处、旧接缝一动没动 ⇒ 臂「跑了」却红不到它该红的那条（假臂）。
  const hits = source.split(arm.from).length - 1;
  if (hits !== 1) throw new Error(`反证臂 ${ARM} 的 from 在 ${arm.file} 里出现 ${hits} 次（要求恰好 1 次）：${arm.what} —— 把那段写成唯一的（否则 String.replace 会改到别处，臂就成了假臂）`);
  cliPath = path.join(sandbox, 'bin', 'designer.mjs');
  mkdirSync(path.dirname(cliPath), { recursive: true });
  writeFileSync(cliPath, source.replace(arm.from, arm.to), 'utf8');
  // CLI 从自己文件的位置找 `../web` ⇒ 副本旁边也放一份 web/ 的副本（真 web/** 一个字节不动）
  cpSync(path.join(root, 'web'), path.join(sandbox, 'web'), { recursive: true });
  process.stdout.write(`反证臂 ${ARM} —— ${arm.what}（跑在副本上：${cliPath} ＋ 它旁边的 web/ 副本）\n`);
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 「谁还引用着这个 work 目录」这件事**不在本门里做**：它既是「读整张进程表」又是「读每个进程的环境」，
// 平台分叉只住 `test/harness.mjs`（纪律见 `test/harness-contract.mjs`）⇒ 一律问那一层的
// `processesReferencingPath()`（POSIX 上命令行 ＋ 环境两处都查；量不到时如实回 `null`，不当成「干净」）。


/** 写一个**受控的假浏览器**到本门沙箱里（`CHROME_BIN` 指它）。它们**不是**产品的一部分，只为把两件事
 *  确定性地造出来：①「被信号杀掉」；②「树里有一支自己 setsid 的成员」——见下面那两条判据的注释。 */
function writeFakeChrome(name, source) {
  const file = path.join(sandbox, 'fake-chrome', name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

/** 跑一次 CLI（真子进程）。`env` 用来单独改某一次的环境变量（例如 CHROME_BIN）。
 *  ⚠️ 每次都把它的「**继承来的**临时目录」指到本门沙箱里那一份（`<sandbox>/t`）：
 *  · 好处一：它的 work 目录（`os.tmpdir()` 下建的）就落在本门沙箱里，收尾一起没（不往系统临时目录丢东西）；
 *  · 好处二：`cli:isolation` 于是能**本地、确定性地**量「Chrome 有没有往那个目录里写 `org.chromium.Chromium.*`」
 *    —— 早先那一版数的是**系统临时目录**里的个数，旁边别的浏览器一开就会假红（并发下不稳）。
 *  ⚠️ 这一份的名字必须是**短**的（`t`，不是 `inherited-tmp`）：它直接决定 Chromium 单例 socket 的
 *    路径长度（`len(TMPDIR) + 27 + 49 < 108`）—— 2026-09-25 实测，`inherited-tmp` 那版把路径顶到
 *    119 字节，Chromium 每次起都 SIGABRT（见文件头那段）。 */
function runCli(args, { env = {}, timeout = 240000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...CLI_INHERITED_TMP_ENV, ...env },
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error ?? null,
  };
}

/** CLI 打印的产物行：`[designer-cli] ✓ html <path>（29428 字节，…）`。 */
function artifactLines(output) {
  return [...output.matchAll(/^\[designer-cli\] ✓ (\S+)\s+(.+?)（(\d+) 字节/gm)].map((match) => ({ kind: match[1], file: match[2], bytes: Number(match[3]) }));
}
/** CLI 打印的**最终产物清单**：`  · <path>  29428 字节  html`。 */
function listedLines(output) {
  return [...output.matchAll(/^ {2}· (.+?) {2}(\d+) 字节 {2}(\S+)$/gm)].map((match) => ({ file: match[1], bytes: Number(match[2]), kind: match[3] }));
}
const workOf = (output) => /^\[designer-cli\] work: (.+)$/m.exec(output)?.[1]?.trim() ?? null;
const cleanupPidOf = (output) => Number(/Chromium\(pid=(\d+)\)/.exec(output)?.[1] ?? NaN);

const runs = [];
// 交给 CLI 的「继承来的临时目录」（也用它当 CLI 自己 work 目录的落点）—— `cli:isolation` 量的就是它。
// 名字必须是**短**的：Chromium 的单例 socket 路径 = `len(TMPDIR) + 27 + 49`，必须 < 108（文件头那段）。
// 当前摆法：`/tmp/dzcli-XXXXXX/t` ⇒ 19 + 76 = 95 字节，余量 12 字节。
const inheritedTmp = path.join(sandbox, 't');
mkdirSync(inheritedTmp, { recursive: true });
const CLI_INHERITED_TMP_ENV = { TMPDIR: inheritedTmp, TMP: inheritedTmp, TEMP: inheritedTmp };
const chromeTempEntries = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('org.chromium.Chromium')) : []);
try {
  // ═══ 1. 用法 / --help（不必起浏览器）═══════════════════════════════════════════════════════
  const help = runCli(['--help'], { timeout: 30000 });
  check('cli:help', '`--help` 退 0，把用法与**退出码表**都打出来（0/2/3/4/5/6 六个码逐个有名有姓，而不是让人去猜）',
    help.status === 0 && help.stdout.includes('--out') && help.stdout.includes('--png') && help.stdout.includes('--force')
    && /退出码/.test(help.stdout) && ['0 全部产物写好', '2 用法错', '3 文档不合法', '4 环境失败', '5 --out 里已有同名产物', '6 页面自己报的导出失败']
      .every((line) => help.stdout.includes(line)),
    JSON.stringify({ status: help.status, hasUsage: help.stdout.includes('用法：'), bytes: help.stdout.length }));

  const noArgs = runCli([], { timeout: 30000 });
  check('cli:usage-no-args', '不给参数 ⇒ 退 **2**（用法错）并说清缺什么', noArgs.status === 2 && noArgs.output.includes('缺文档'), JSON.stringify({ status: noArgs.status, out: noArgs.output.trim().slice(0, 160) }));
  const noOut = runCli([SAMPLE], { timeout: 30000 });
  check('cli:usage-no-out', '只给文档、不给 --out ⇒ 退 **2** 并说清缺 --out（不会偷偷写到某个默认目录）',
    noOut.status === 2 && noOut.output.includes('--out'), JSON.stringify({ status: noOut.status, out: noOut.output.trim().slice(0, 160) }));

  // ═══ 2. ① 拿**现成的**样例文档跑一次：HTML ＋ SVG ＋ PNG ＋ JSON ＋ 转移图 ═══════════════════
  const sampleOut = path.join(sandbox, 'out-sample');
  const sample = runCli([SAMPLE, '--out', sampleOut, '--png', '--json', '--flow']);
  runs.push({ label: 'sample', result: sample });
  // ⚠️ 期望值全部**从那份样例文档本身算出来**（不写死"1 屏 / 0 转移 / 112 个元素"）：
  //    `design/samples/two-pane/` 是另一条工作线在维护的活文件（2026-09-25 就从「1 屏」推到了「3 屏 ＋ 4 条转移」）——
  //    写死内容会让「样例改了」看起来像「CLI 坏了」（合并 master 时实测踩过一次）。
  const setDocLine = new RegExp(`setDoc 成功：${DOC.screens.length} 屏 / ${TRANSITION_COUNT} 转移`);
  check('cli:sample-exit', '拿仓里现成的 `design/samples/two-pane/main-screen.json` 跑：**退 0**（要的五项都拿到），并打印文档规模与 setDoc 回执（屏数/转移数与那份文档**本身**逐个相等）',
    sample.status === 0 && sample.output.includes('[designer-cli] 页面 ready') && setDocLine.test(sample.output),
    JSON.stringify({ status: sample.status, signal: sample.signal, docFacts: { screens: DOC.screens.length, transitions: TRANSITION_COUNT },
      head: sample.stdout.split('\n').slice(0, 5) }));

  const printed = artifactLines(sample.stdout);
  const listed = listedLines(sample.stdout);
  const onDisk = printed.map((line) => ({ ...line, exists: existsSync(line.file), size: existsSync(line.file) ? statSync(line.file).size : -1 }));
  check('cli:sample-artifacts', '五项产物**真的在盘上**（路径就是它打印的那个、也在 --out 里）：kind 五个各一份、**字节数逐个等于它打印的数**、都 > 0 —— 回执不是编的',
    printed.length === 5 && onDisk.every((line) => line.exists && line.size === line.bytes && line.bytes > 0)
    && new Set(onDisk.map((line) => line.kind)).size === 5
    && onDisk.every((line) => path.resolve(line.file).startsWith(path.resolve(sampleOut) + path.sep))
    && listed.length === 5 && listed.every((line) => onDisk.some((disk) => disk.file === line.file && disk.bytes === line.bytes)),
    JSON.stringify({ printed, listed }));

  const fileOf = (kind) => onDisk.find((line) => line.kind === kind)?.file ?? null;
  const htmlFile = fileOf('html');
  const svgFile = fileOf('svg');
  const pngFile = fileOf('png');
  const jsonFile = fileOf('json');
  const flowFile = fileOf('flow');
  const html = htmlFile ? readFileSync(htmlFile, 'utf8') : '';
  const svg = svgFile ? readFileSync(svgFile, 'utf8') : '';

  check('cli:html-content', '导出的 HTML 里**有那份文档中「当前屏 · 当前状态」那棵树里的每一个元素**（id 个数从文档算出来，不是写死的）、是合法 HTML（doctype）、且一条 http(s) 外链都没有',
    /^<!doctype html>/i.test(html) && DOC_IDS.length > 0 && DOC_IDS.every((id) => html.includes(`data-id="${id}"`)) && !/https?:\/\//.test(html),
    JSON.stringify({ ids: DOC_IDS.length, missing: DOC_IDS.filter((id) => !html.includes(`data-id="${id}"`)).slice(0, 5), external: /https?:\/\//.test(html) }));

  const svgMissing = DOC_IDS.filter((id) => !svg.includes(`data-id="${id}"`));
  check('cli:svg-content', '导出的 SVG 里**画布认识的那些元素一个不缺**（`<rect data-id=…>`），画布尺寸 == 文档里屏根那个固定尺寸（拿文档算出来的，不是写死的常数）；**唯独实例节点缺席**（画布还不认识 `type:"instance"`，二期）—— 缺席的恰好是它们，别的元素少一个就红',
    svg.includes(`width="${ROOT_SIZE.w}" height="${ROOT_SIZE.h}"`) && DOC_IDS.length > 0
    && JSON.stringify([...svgMissing].sort()) === JSON.stringify([...INSTANCE_IDS].sort()),
    JSON.stringify({ size: ROOT_SIZE, missing: svgMissing.slice(0, 5), instanceIds: INSTANCE_IDS, head: svg.slice(0, 90) }));

  const png = pngFile ? readFileSync(pngFile) : Buffer.alloc(0);
  const pngMagic = [...png.subarray(0, 8)];
  // ⚠️ `ihdr` 只是**回执里的读数**，读之前先看有没有 24 字节：CLI 一失败（`pngFile === null` ⇒ 空 Buffer）
  //    原来会在这里抛 `ERR_BUFFER_OUT_OF_BOUNDS`，把这一条连同后面 15 条断言一起**崩掉** ——
  //    「门红了」应当是一条条红出来，不是异常（实测踩过：2026-09-25 的 TMPDIR 太长那一次）。
  const pngIhdr = png.length >= 24 ? [png.readUInt32BE(16), png.readUInt32BE(20)] : null;
  check('cli:png-bytes', '`--png` 那一份是**真 PNG**（魔数 137 80 78 71 13 10 26 10、IHDR 的宽高 == 文档里屏根的固定尺寸）',
    JSON.stringify(pngMagic) === JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10])
    && pngIhdr !== null && pngIhdr[0] === ROOT_SIZE.w && pngIhdr[1] === ROOT_SIZE.h && png.length > 0,
    JSON.stringify({ magic: pngMagic, ihdr: pngIhdr, bytes: png.length }));

  const exportedJson = jsonFile ? readFileSync(jsonFile, 'utf8') : '';
  let parsedJson = null;
  try { parsedJson = JSON.parse(exportedJson); } catch { parsedJson = null; }
  check('cli:json-content', '`--json` 那一份是**规范 JSON**：解得出、根元素还是那份文档的第 0 屏根（id 逐个相等）、**当前屏那棵树的元素个数逐个相等**、末尾带换行（与页面「导出 JSON」同一串字节那条口径）',
    parsedJson !== null && parsedJson.screens?.[0]?.root?.id === DOC.screens[0].root.id
    && (function count(element) { return 1 + (element.children ?? []).reduce((total, child) => total + count(child), 0); }(parsedJson.screens[0].root)) === DOC_IDS.length
    && exportedJson.endsWith('\n'),
    JSON.stringify({ parsed: parsedJson !== null, root: parsedJson?.screens?.[0]?.root?.id ?? null, expectedRoot: DOC.screens[0].root.id, endsWithNewline: exportedJson.endsWith('\n') }));

  const flow = flowFile ? readFileSync(flowFile, 'utf8') : '';
  check('cli:flow-content', '`--flow` 那一份是转移图 SVG：`data-designer-flow="true"`、节点数 == （屏 × 状态）（两个数都从那份文档算出来）、而且**两端都指得出节点的那些转移**逐条都有 `data-transition`（画不出一根数据里没有的箭头）',
    flow.includes('data-designer-flow="true"') && (flow.match(/data-node=/g) ?? []).length === STATE_COUNT
    && RESOLVABLE_TRANSITIONS.every((transition) => flow.includes(`data-transition="${transition.id}"`))
    && RESOLVABLE_TRANSITIONS.length + UNRESOLVABLE_TRANSITIONS.length === TRANSITION_COUNT,
    JSON.stringify({ nodes: (flow.match(/data-node=/g) ?? []).length, expectedNodes: STATE_COUNT,
      resolvable: RESOLVABLE_TRANSITIONS.map((t) => t.id), unresolvable: UNRESOLVABLE_TRANSITIONS.map((t) => t.id),
      missingResolvable: RESOLVABLE_TRANSITIONS.filter((t) => !flow.includes(`data-transition="${t.id}"`)).map((t) => t.id) }));
  // 页面那条导出路径对「指不出节点」的转移是**静默跳过**的 —— CLI 不许让它静默（也不把退码改掉）。
  const warnedAbout = UNRESOLVABLE_TRANSITIONS.filter((transition) => sample.output.includes(`没有 ${JSON.stringify(transition.id)} 的箭头`));
  const falseAlarms = RESOLVABLE_TRANSITIONS.filter((transition) => sample.output.includes(`没有 ${JSON.stringify(transition.id)} 的箭头`));
  check('cli:flow-honest-warning', '转移图里**画不出来的**那几条，CLI 会**点名说出来**（页面那条路径一声不响地跳过；CLI 拿回页面那份文档自己核一遍）—— 画得出来的那几条**不许误报**；一份文档一条也不缺时**一句警告都没有**',
    warnedAbout.length === UNRESOLVABLE_TRANSITIONS.length && falseAlarms.length === 0
    && (UNRESOLVABLE_TRANSITIONS.length > 0
      ? (sample.stderr.includes(`共 ${UNRESOLVABLE_TRANSITIONS.length} 条转移没画出来`) && sample.status === 0)
      : !sample.stderr.includes('条转移没画出来')),
    JSON.stringify({ unresolvable: UNRESOLVABLE_TRANSITIONS.map((t) => t.id), warnedAbout: warnedAbout.map((t) => t.id), falseAlarms: falseAlarms.map((t) => t.id),
      status: sample.status, warnings: sample.stderr.split('\n').filter((line) => line.includes('⚠')).slice(0, 6) }));

  // 上面那两格在**当前那份样例**上只能行使一半（它 4 条转移全指不出节点）⇒ 另造一份**两端写全**的文档，把另一半跑出来。
  const goodDoc = path.join(sandbox, 'flow-ok.json');
  const withStates = JSON.parse(JSON.stringify(DOC));
  const screenOf = (id) => withStates.screens.find((screen) => screen.id === id);
  for (const transition of withStates.transitions ?? []) {
    transition.from = { screen: transition.from.screen, state: screenOf(transition.from.screen)?.states?.[0]?.id };
    transition.to = { screen: transition.to.screen, state: screenOf(transition.to.screen)?.states?.[0]?.id };
  }
  writeFileSync(goodDoc, `${JSON.stringify(withStates, null, 2)}\n`, 'utf8');
  const flowOkOut = path.join(sandbox, 'out-flow-ok');
  const flowRun = runCli([goodDoc, '--out', flowOkOut, '--flow']);
  runs.push({ label: 'flow-ok', result: flowRun });
  const flowOkFile = path.join(flowOkOut, 'design-flow-ok.flow.svg');
  const flowOk = existsSync(flowOkFile) ? readFileSync(flowOkFile, 'utf8') : '';
  check('cli:flow-arrows', '把同一份稿的转移**两端补全**（`{screen, state}` —— 冻结 v0 的形状）再跑一次 ⇒ 4 条转移的箭头**全都画出来**了（`data-transition` 逐条在）、而且 CLI **一句警告都不打**（上一格那些话是「那份文档的问题」，不是「CLI 的脾气」）',
    flowRun.status === 0 && (withStates.transitions ?? []).every((transition) => flowOk.includes(`data-transition="${transition.id}"`))
    && !flowRun.stderr.includes('条转移没画出来') && !flowRun.stderr.includes('的箭头'),
    JSON.stringify({ status: flowRun.status, transitions: (withStates.transitions ?? []).map((t) => t.id),
      arrows: [...new Set([...flowOk.matchAll(/data-transition="([^"]+)"/g)].map((match) => match[1]))],
      warnings: flowRun.stderr.split('\n').filter((line) => line.includes('⚠')) }));

  // ═══ 3. 覆盖策略：默认**拒绝**、显式 --force 才覆盖 ════════════════════════════════════════
  // ⚠️ 前面几格红了（CLI 根本没产出产物）时 `htmlFile === null`：这一格要**如实红**，**不许**在这里抛
  //    （`path.basename(null)` / `sha256(null)` 都抛 ⇒ 会把后面十几条断言一起吞掉 —— 与 `cli:png-bytes`
  //    那条同一个毛病，实测踩过：2026-09-25 本机 TMPDIR 太长那一次，门 "红了" 但只报了 8 条）。
  const htmlHashBefore = htmlFile === null ? null : sha256(htmlFile);
  const refused = runCli([SAMPLE, '--out', sampleOut, '--png', '--json', '--flow'], { timeout: 60000 });
  check('cli:existing-refused', '同一个 --out 再跑一次、**不给 --force** ⇒ 退 **5**、说清「不覆盖」并把挡路的文件逐个列出来；盘上那份**一个字节没动**（sha256 前后相同）',
    htmlFile !== null && htmlHashBefore !== null && refused.status === 5 && refused.output.includes('不覆盖') && refused.output.includes(path.basename(htmlFile))
    && sha256(htmlFile) === htmlHashBefore,
    JSON.stringify({ status: refused.status, htmlFile, out: refused.output.trim().split('\n').slice(0, 3), same: htmlFile === null ? null : sha256(htmlFile) === htmlHashBefore }));

  const forced = runCli([SAMPLE, '--out', sampleOut, '--png', '--json', '--flow', '--force']);
  runs.push({ label: 'force', result: forced });
  const forcedLines = artifactLines(forced.stdout);
  check('cli:force-overwrites', '加 `--force` ⇒ 退 **0**、先明说自己会覆盖几个、产物照样写好（路径与字节数与盘上逐个对上）—— 设计稿默认不被默默盖掉，要盖得明说',
    forced.status === 0 && /--force：会覆盖 5 个已有产物/.test(forced.stdout) && forcedLines.length === 5
    && forcedLines.every((line) => existsSync(line.file) && statSync(line.file).size === line.bytes && line.bytes > 0),
    JSON.stringify({ status: forced.status, forceLine: /--force：.*/m.exec(forced.stdout)?.[0] ?? null, forced: forcedLines }));

  // ═══ 4. ② 坏文档：非零退出 ＋ 有原因 ＋ 不产出半成品 ═══════════════════════════════════════
  const badDoc = path.join(sandbox, 'bad-doc.json');
  writeFileSync(badDoc, '{"version":"0.1.0"}\n', 'utf8');
  const badOut = path.join(sandbox, 'out-bad');
  const bad = runCli([badDoc, '--out', badOut]);
  runs.push({ label: 'bad-doc', result: bad });
  check('cli:bad-doc-exit', '给一份**坏文档**（合法 JSON、但没有 screens）⇒ **退 3**，并把**页面自己**那句原因逐字打出来（缺 screens ＋ 是 setDoc 拒的 ⇒ 与「导入 JSON」同一个校验器）',
    bad.status === 3 && bad.output.includes('缺 screens（文档顶层要有 screens 数组）') && bad.output.includes('setDoc'),
    JSON.stringify({ status: bad.status, out: bad.output.trim().split('\n').slice(-2) }));
  check('cli:bad-doc-no-half-products', '坏文档这一跑**一个字节都不产出**：--out 目录要么压根没建、要么是空的（不留下半成品）',
    !existsSync(badOut) || readdirSync(badOut).length === 0,
    JSON.stringify({ exists: existsSync(badOut), entries: existsSync(badOut) ? readdirSync(badOut) : [] }));

  const notJson = path.join(sandbox, 'not-json.json');
  writeFileSync(notJson, 'this is not json\n', 'utf8');
  const badJson = runCli([notJson, '--out', path.join(sandbox, 'out-notjson')]);
  check('cli:not-json', '连 JSON 都不是 ⇒ 退 **3** 并说清是解析不了（这一条连浏览器都不用起：先本地解析再看文档语义）',
    badJson.status === 3 && badJson.output.includes('不是合法 JSON'), JSON.stringify({ status: badJson.status, out: badJson.output.trim().slice(0, 140) }));

  // ═══ 5. 环境失败：Chromium 指不到 / 起不来 ⇒ 如实报 ＋ 收干净 ═══════════════════════════════
  const missingChrome = runCli([SAMPLE, '--out', path.join(sandbox, 'out-nochrome')], { env: { CHROME_BIN: path.join(sandbox, 'no-such-chrome.exe') } });
  check('cli:env-missing-chrome', '`CHROME_BIN` 指到一个不存在的路径 ⇒ 退 **4** 并说清该怎么指（不打哑谜、也不假装跑过）',
    missingChrome.status === 4 && missingChrome.output.includes('Chromium 不在') && missingChrome.output.includes('CHROME_BIN'),
    JSON.stringify({ status: missingChrome.status, out: missingChrome.output.trim().slice(0, 160) }));

  const brokenChrome = runCli([SAMPLE, '--out', path.join(sandbox, 'out-brokenchrome')], { env: { CHROME_BIN: process.execPath } });
  runs.push({ label: 'broken-chrome', result: brokenChrome });
  check('cli:env-broken-chrome', '`CHROME_BIN` 指到一个**真存在但起不来**的东西（拿 node 装作浏览器）⇒ 退 **4**、说得出「进程已退出（exitCode=9）」＋ 它的 stderr 末尾，**而且照样打印收尾那一行**',
    brokenChrome.status === 4 && brokenChrome.output.includes('Chromium 起不来') && /exitCode=\d+/.test(brokenChrome.output)
    && brokenChrome.output.includes('bad option: --headless=new') && brokenChrome.output.includes('[designer-cli] cleanup:'),
    JSON.stringify({ status: brokenChrome.status, out: brokenChrome.output.trim().split('\n').slice(-3) }));

  // ═══ 6. 多屏多状态：--screen / --state / --all-screens / --all-states ══════════════════════════
  // 业主 2026-09-28 那条「不再是只出第 0 屏第 0 状态」的判据。样例**写在本门沙箱里**（不往仓库里丢新文件）：
  // 2 屏（甲屏 2 状态、乙屏 1 状态），而且**每一棵树里都有一个只在它那里出现的元素 id** ⇒
  // 于是能逐份断言「这一份的内容对得上这一屏 · 这一状态」，不是只看文件数。
  const rect = (id) => ({ id, type: 'rect', box: { x: 10, y: 10 }, size: { w: { mode: 'fixed', value: 40 }, h: { mode: 'fixed', value: 20 } } });
  const multiRoot = (id, children) => ({ id, type: 'container', name: '屏幕', size: { w: { mode: 'fixed', value: 320 }, h: { mode: 'fixed', value: 200 } }, layout: { mode: 'free' }, children });
  const multiDoc = {
    version: '0.1.0',
    tokens: {},
    transitions: [],
    screens: [
      { id: 's.alpha', name: '甲屏',
        states: [{ id: 'st1', name: '一态' }, { id: 'st.2', name: '二态', root: multiRoot('el-a2-root', [rect('el-a2-only')]) }],
        root: multiRoot('el-a1-root', [rect('el-a1-only')]) },
      { id: 's/beta', name: '乙屏',
        states: [{ id: 's1', name: '默认' }],
        root: multiRoot('el-b-root', [rect('el-b-only')]) },
    ],
  };
  const multiPath = path.join(sandbox, 'multi.json');
  writeFileSync(multiPath, `${JSON.stringify(multiDoc, null, 2)}\n`, 'utf8');
  // 产物名规则（与文档 §7 那一行逐字对应）：`design-<基名>.<屏 id>.<状态 id>.<ext>`；
  // 屏/状态 id 里除 `A-Za-z0-9_-` 之外的字符按 UTF-8 字节写成 %XX —— 这里**不调 CLI 那个函数**，
  // 期望值是本门自己逐字写出来的（才是对照，不然就是「拿实现给自己判卷」）。
  const ESC = { 's.alpha': 's%2Ealpha', 's/beta': 's%2Fbeta', st1: 'st1', 'st.2': 'st%2E2', s1: 's1' };
  const multiTargets = [{ screen: 's.alpha', state: 'st1' }, { screen: 's.alpha', state: 'st.2' }, { screen: 's/beta', state: 's1' }];
  const multiName = (target, ext) => `design-multi.${ESC[target.screen]}.${ESC[target.state]}.${ext}`;

  const multiOut = path.join(sandbox, 'out-multi');
  const multiRun = runCli([multiPath, '--out', multiOut, '--all-screens', '--all-states', '--png', '--json', '--flow']);
  runs.push({ label: 'multi', result: multiRun });
  const multiFiles = existsSync(multiOut) ? readdirSync(multiOut).sort() : [];
  const expectedMulti = [
    ...multiTargets.flatMap((target) => [multiName(target, 'html'), multiName(target, 'svg'), multiName(target, 'png')]),
    'design-multi.json', 'design-multi.flow.svg',
  ].sort();
  const multiPrinted = artifactLines(multiRun.stdout);
  check('cli:multi-count', '`--all-screens --all-states --png --json --flow`：盘上正好是**屏数×状态数×3** 份「屏·状态」产物（2 屏、其中一屏 2 状态 ⇒ 3×3 = 9）＋ 整份文档各一份（json/flow 各 1 份，不跟着屏/状态各来一遍），**文件名逐字**等于规则算出来的那 11 个（屏/状态 id 里的 `.` `/` 都转成 %XX）；回执打印的路径与字节数逐个与盘上相等',
    multiRun.status === 0 && JSON.stringify(multiFiles) === JSON.stringify(expectedMulti)
    && multiPrinted.length === expectedMulti.length
    && multiPrinted.every((line) => existsSync(line.file) && statSync(line.file).size === line.bytes && line.bytes > 0)
    && multiPrinted.map((line) => path.basename(line.file)).sort().join('|') === expectedMulti.join('|'),
    JSON.stringify({ status: multiRun.status, files: multiFiles, expected: expectedMulti, printed: multiPrinted.map((line) => path.basename(line.file)) }));

  const htmlOf = (target) => {
    const file = path.join(multiOut, multiName(target, 'html'));
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const ownedBy = { 'el-a1-only': 's.alpha/st1', 'el-a2-only': 's.alpha/st.2', 'el-b-only': 's/beta/s1' };
  const multiHtml = Object.fromEntries(multiTargets.map((target) => [`${target.screen}/${target.state}`, htmlOf(target)]));
  const contentRows = Object.entries(ownedBy).map(([id, owner]) => ({
    id,
    owner,
    actuallyIn: Object.entries(multiHtml).filter(([, html]) => html.includes(`data-id="${id}"`)).map(([key]) => key),
  }));
  check('cli:multi-content', '每一份 HTML 的内容**对得上它自己那一屏·那一状态**：每个「只在一棵树里出现」的元素 id，**只在它那一份里**（第二态独有的元素不在第一态那份里、乙屏的不在甲屏那两份里）—— 不是只看文件数',
    contentRows.every((row) => row.actuallyIn.length === 1 && row.actuallyIn[0] === row.owner),
    JSON.stringify(contentRows));

  // 名字也能指屏/状态（--screen 甲屏）＋ `--check-twice`（同一项连点两次 ⇒ 同一份字节）
  const multiByNameOut = path.join(sandbox, 'out-multi-byname');
  const multiByName = runCli([multiPath, '--out', multiByNameOut, '--screen', '甲屏', '--all-states', '--png', '--check-twice']);
  runs.push({ label: 'multi-byname', result: multiByName });
  const byNameFiles = existsSync(multiByNameOut) ? readdirSync(multiByNameOut).sort() : [];
  const alphaTargets = [{ screen: 's.alpha', state: 'st1' }, { screen: 's.alpha', state: 'st.2' }];
  const expectedByName = alphaTargets.flatMap((target) => [multiName(target, 'html'), multiName(target, 'png'), multiName(target, 'svg')]).sort();
  check('cli:multi-by-name', '`--screen 甲屏 --all-states`：屏可以用**名字**指（不是只有 id 行）⇒ 只出那一屏的**每一个**状态（2 状态×3 格式 = 6 份，名字逐字对得上；同一份文档里乙屏的东西一份都不出）',
    multiByName.status === 0 && JSON.stringify(byNameFiles) === JSON.stringify(expectedByName),
    JSON.stringify({ status: multiByName.status, files: byNameFiles, expected: expectedByName }));

  // --check-twice 是上一版报告里自己点名的「没验到」那条：`--png` 那一项**没与鼠标点菜单做过逐字节对照**。
  // 完整对照（拿真鼠标点一次再与 CLI 比）**仍然没做**（写进文档 §6），但「**同一次跑里连点两次同一项**
  // ⇒ 同一份字节」这条做到了，而且这里拿盘上那份**重新算 sha256** 与 CLI 自报的两份相同那个哈希对 —— 不是只看它自己说。
  const twiceSelfChecks = [...multiByName.stdout.matchAll(/^\[designer-cli\] · 确定性自检（--check-twice）：(\S+)（屏 (\S+) · 状态 (\S+)） 同一项两次导出的字节逐字节相同（(\d+) 字节，sha256=([0-9a-f]{16})…）/gm)]
    .map((match) => ({ kind: match[1], screen: match[2], state: match[3], bytes: Number(match[4]), hash16: match[5] }));
  const twiceRows = twiceSelfChecks.map((row) => {
    const file = path.join(multiByNameOut, multiName({ screen: row.screen, state: row.state }, row.kind));
    const exists = existsSync(file);
    const bytes = exists ? readFileSync(file) : Buffer.alloc(0);
    const onDiskHash16 = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    return { ...row, file: path.basename(file), exists, onDiskBytes: bytes.length, onDiskHash16, matches: exists && bytes.length === row.bytes && onDiskHash16 === row.hash16 };
  });
  const pngRows = twiceRows.filter((row) => row.kind === 'png');
  check('cli:twice-png', '`--check-twice`：每一项（含 **PNG**）**在同一次跑里连点两次**，CLI 自报两份字节逐字节相同，而且盘上那份的 sha256 与它自报的那个**前 16 位相等**（拿盘上那份重算，不是听它说）—— 补上一版「`--png` 没与鼠标点菜单做过逐字节对照」那条的一半（另一半：拿真鼠标点出来再比，**仍然没做**，见文档 §6）',
    multiByName.status === 0 && twiceSelfChecks.length === 6 && twiceRows.every((row) => row.matches) && pngRows.length === 2,
    JSON.stringify({ status: multiByName.status, selfChecks: twiceRows, png: pngRows.map((row) => row.file) }));

  // 单点：--screen <id> --state <名字>（两者都能用 id 或名字指）
  const multiOneOut = path.join(sandbox, 'out-multi-one');
  const multiOne = runCli([multiPath, '--out', multiOneOut, '--screen', 's/beta', '--state', '默认']);
  runs.push({ label: 'multi-one', result: multiOne });
  const oneFiles = existsSync(multiOneOut) ? readdirSync(multiOneOut).sort() : [];
  const expectedOne = [multiName({ screen: 's/beta', state: 's1' }, 'html'), multiName({ screen: 's/beta', state: 's1' }, 'svg')].sort();
  check('cli:multi-one', '`--screen s/beta --state 默认`（屏给 id、状态给**名字**）⇒ 只出那一屏那一状态的一份 HTML ＋ 一份 SVG（乙屏的东西只出现在这两份里）',
    multiOne.status === 0 && JSON.stringify(oneFiles) === JSON.stringify(expectedOne)
    && oneFiles.length === 2 && existsSync(path.join(multiOneOut, multiName({ screen: 's/beta', state: 's1' }, 'html')))
    && readFileSync(path.join(multiOneOut, multiName({ screen: 's/beta', state: 's1' }, 'html')), 'utf8').includes('data-id="el-b-only"'),
    JSON.stringify({ status: multiOne.status, files: oneFiles, expected: expectedOne }));

  // `--all-screens` 单独用：每屏都用**它自己**的第 0 个状态（不是「全文档的第 0 个状态」）
  const allScreensOut = path.join(sandbox, 'out-multi-allscreens');
  const allScreensRun = runCli([multiPath, '--out', allScreensOut, '--all-screens']);
  runs.push({ label: 'multi-allscreens', result: allScreensRun });
  const allScreensFiles = existsSync(allScreensOut) ? readdirSync(allScreensOut).sort() : [];
  const expectedAllScreens = [
    multiName({ screen: 's.alpha', state: 'st1' }, 'html'), multiName({ screen: 's.alpha', state: 'st1' }, 'svg'),
    multiName({ screen: 's/beta', state: 's1' }, 'html'), multiName({ screen: 's/beta', state: 's1' }, 'svg'),
  ].sort();
  check('cli:multi-all-screens', '`--all-screens` 单独用 ⇒ 每屏各出一份、**每屏用它自己的第 0 个状态**（甲屏只出 `st1`、`st.2` 一份也不出；乙屏出 `s1`）—— 4 份（2 屏×2 格式），名字逐字对得上',
    allScreensRun.status === 0 && JSON.stringify(allScreensFiles) === JSON.stringify(expectedAllScreens),
    JSON.stringify({ status: allScreensRun.status, files: allScreensFiles, expected: expectedAllScreens }));

  // `--state` 单独用（不给 --screen）：作用在**文档的第 0 屏**上（那一屏的第 0 个状态仍然是缺省）
  const stateOnlyOut = path.join(sandbox, 'out-multi-stateonly');
  const stateOnlyRun = runCli([multiPath, '--out', stateOnlyOut, '--state', '一态']);
  runs.push({ label: 'multi-stateonly', result: stateOnlyRun });
  const stateOnlyFiles = existsSync(stateOnlyOut) ? readdirSync(stateOnlyOut).sort() : [];
  const expectedStateOnly = [multiName({ screen: 's.alpha', state: 'st1' }, 'html'), multiName({ screen: 's.alpha', state: 'st1' }, 'svg')].sort();
  check('cli:multi-state-only', '`--state 一态` 不给 `--screen` ⇒ 作用在**文档的第 0 屏**（甲屏）上、只出那一个状态（2 格式）—— 不是「在后面某一屏上碰运气」',
    stateOnlyRun.status === 0 && JSON.stringify(stateOnlyFiles) === JSON.stringify(expectedStateOnly),
    JSON.stringify({ status: stateOnlyRun.status, files: stateOnlyFiles, expected: expectedStateOnly }));

  // 无效参数：如实失败（退 2 ＝ 用法错）、说出有哪些屏/状态、**不产半成品**（这两条连浏览器都不用起）
  const badScreenOut = path.join(sandbox, 'out-bad-screen');
  const badScreen = runCli([multiPath, '--out', badScreenOut, '--screen', '没这个屏']);
  check('cli:screen-unknown', '`--screen` 给一个**不存在**的 id/名字 ⇒ 退 **2**（用法错）、原因逐字、**把这份文档里有的屏逐个列出来**（id ＋ 名字）、**不产半成品**、而且**连浏览器都不起**',
    badScreen.status === 2 && badScreen.output.includes('--screen 给的是') && badScreen.output.includes('没有这个屏 id、也没有这个屏名')
    && badScreen.output.includes('s.alpha（甲屏）') && badScreen.output.includes('s/beta（乙屏）')
    && !existsSync(badScreenOut) && !badScreen.output.includes('[designer-cli] 起浏览器'),
    JSON.stringify({ status: badScreen.status, out: badScreen.output.trim().split('\n') }));

  const badStateOut = path.join(sandbox, 'out-bad-state');
  const badState = runCli([multiPath, '--out', badStateOut, '--screen', 's/beta', '--state', '没这个状态']);
  check('cli:state-unknown', '`--state` 给一个不存在的 id/名字 ⇒ 退 **2**（用法错）、说清是**哪一屏上没有**、列出**这一屏有**的状态（id ＋ 名字）、不产半成品',
    badState.status === 2 && badState.output.includes('--state 给的是') && badState.output.includes('没有这个状态 id、也没有这个状态名')
    && badState.output.includes('屏 s/beta（乙屏）') && badState.output.includes('s1（默认）') && !existsSync(badStateOut),
    JSON.stringify({ status: badState.status, out: badState.output.trim().split('\n') }));

  const conflictOut = path.join(sandbox, 'out-conflict');
  const conflictA = runCli([multiPath, '--out', conflictOut, '--screen', 's.alpha', '--all-screens']);
  const conflictB = runCli([multiPath, '--out', conflictOut, '--state', 'st1', '--all-states']);
  check('cli:flag-conflict', '`--screen` 与 `--all-screens`（以及 `--state` 与 `--all-states`）同时给 ⇒ 退 **2** 并说清互斥（不静默取一半）',
    conflictA.status === 2 && conflictA.output.includes('不能同时给') && conflictB.status === 2 && conflictB.output.includes('不能同时给') && !existsSync(conflictOut),
    JSON.stringify({ a: { status: conflictA.status, out: conflictA.output.trim() }, b: { status: conflictB.status, out: conflictB.output.trim() } }));

  const helpScreens = runCli(['--help'], { timeout: 30000 });
  check('cli:help-screens', '`--help` 里把四个新开关（`--screen <id|name>` / `--state <id|name>` / `--all-screens` / `--all-states`）＋ `--check-twice` ＋ **产物名规则**都打出来（名字不许藏在代码里）',
    helpScreens.status === 0 && ['--screen <id|name>', '--state <id|name>', '--all-screens', '--all-states', '--check-twice', 'design-<文档基名>.<屏 id>.<状态 id>']
      .every((text) => helpScreens.stdout.includes(text)),
    JSON.stringify({ status: helpScreens.status, hasNaming: helpScreens.stdout.includes('design-<文档基名>.<屏 id>.<状态 id>'), bytes: helpScreens.stdout.length }));

  // ═══ 6.5 两处**产品侧真缺陷**的机械判据（2026-09-25 那一单报上来的；修在 `bin/designer.mjs`）═══════════
  // ① 子进程**被信号**杀掉时 `exitCode === null` ⇒ 旧代码永远等不到「进程已退出」：一次 ~200 ms 的
  //    SIGABRT 被读成「调试端点 30 s 没起来」，收尾回执还写「Chromium **可能还在**」——两条都是假的，
  //    真原因就在它**已经捕获却从不打印**的 stderr 里（那行 `FATAL:… Socket path too long`）。
  // ② `SIGTERM` 只打直接子进程时，Chromium 那棵树里**自己 setsid 的**成员活下来（实测：真
  //    `chrome_crashpad_handler` 是 ppid=1、pgid=它自己 ⇒ **不在**那个进程组里），它的 shutdown flush 会把
  //    `<work>/chromium/…` 写回来 ⇒ 回执说「工作目录已删」而盘上还在（受控负载下复现到过：回执「已删」、
  //    盘上一个 `chromium/` 还在）。
  // 这两条都要有**量事实**的判据（pid 真没了 / 目录真不在 / 那个 profile 里不再有任何 chromium* 进程引用它）。
  // 「谁还引用着那个 work 目录」不自己扫：问 `test/harness.mjs` 的 `processesReferencingPath()`（命令行 ＋ 环境，
  // 跨平台分叉在那一层）。
  // 不能读进程表 / 起不了受控假浏览器的平台这三条会**明确印出「跳过 ≠ 通过」**，绝不当绿。
  if (process.platform !== 'linux') {
    skip('cli:work-short-root', '长 `TMPDIR`（socket ≥ 108 字节）⇒ 换短根并如实说换到哪儿',
      `本平台 ${process.platform}：Chromium 的单例 socket 路径上界只在 POSIX 上有`);
    skip('cli:receipt-signal-death', '被信号杀掉的子进程要如实快报（signalCode ＋ stderr 里的 FATAL）',
      `本平台 ${process.platform}：受控假浏览器靠 SIGABRT，是 POSIX 的机制`);
    skip('cli:cleanup-tree', '自己 setsid 的进程成员必须等到真没了才删 work 目录',
      `本平台 ${process.platform}：受控假树靠 shebang 可执行脚本 ＋ SIGABRT，是 POSIX 的机制`);
  } else {
    // ── ① 长 TMPDIR ⇒ 换短根（放不下那条 108 字节上界就干不下去）──────────────────────────────
    const longTmp = path.join(sandbox, 'long-inherited-tmp-name-0123456789');
    mkdirSync(longTmp, { recursive: true });
    const longOut = path.join(sandbox, 'out-longtmp');
    const longRun = runCli([SAMPLE, '--out', longOut], { env: { TMPDIR: longTmp, TMP: longTmp, TEMP: longTmp } });
    runs.push({ label: 'long-tmpdir', result: longRun });
    const longWork = workOf(longRun.output);
    check('cli:work-short-root',
      '继承来的 `TMPDIR` 太长（这一份让 Chromium 的单例 socket 路径 = `len(work)+49` ≥ 108 字节）⇒ CLI **换一个放得下的短根**再把活干完（退 0、产物照出），并把「换根」与新的 socket 路径长度**打出来**（不是硬着头皮去撞、也不是悄悄换）',
      longRun.status === 0 && longWork !== null && longWork.length + 49 < 108 && !longWork.startsWith(longTmp)
      && longRun.stdout.includes('换根') && /socket 路径 = len\(work\)\+49 = \d+ 字节 < 108/.test(longRun.stdout)
      && artifactLines(longRun.stdout).length === 2,
      JSON.stringify({ status: longRun.status, inheritedTmpLen: longTmp.length, work: longWork,
        socketPathLen: longWork === null ? null : longWork.length + 49,
        relocateLine: /\[designer-cli\] · 换根：.*/.exec(longRun.stdout)?.[0] ?? null, artifacts: artifactLines(longRun.stdout).length }));

    // ── ① 被信号杀掉：如实快报（signalCode ＋ 那行 FATAL），不是「30 s 超时」──────────────────────
    const abortChrome = writeFakeChrome('abort-chrome.mjs', String.raw`#!/usr/bin/env node
import path from 'node:path';
const userDataDir = process.argv.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) ?? '';
const socket = path.dirname(userDataDir) + '/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket';
process.stderr.write('FATAL:chrome/browser/process_singleton_posix.cc:313] Socket path too long: ' + socket + '.\n');
setTimeout(() => process.kill(process.pid, 'SIGABRT'), 30);
`);
    const signalOut = path.join(sandbox, 'out-signal-death');
    const signalStarted = Date.now();
    const signalRun = runCli([SAMPLE, '--out', signalOut, '--timeout-ms', '3000'], { env: { CHROME_BIN: abortChrome } });
    const signalElapsedMs = Date.now() - signalStarted;
    runs.push({ label: 'signal-death', result: signalRun });
    const signalCleanup = /\[designer-cli\] cleanup:.*/.exec(signalRun.output)?.[0] ?? null;
    check('cli:receipt-signal-death',
      '浏览器**被信号杀掉**（受控假浏览器：打一行真 `FATAL:… Socket path too long` 然后自己 SIGABRT）⇒ 退 4、**~0.2 s** 就如实报「进程已退出（signalCode=SIGABRT）」并**把那行 FATAL 打出来**，收尾那行也说「已结束（signalCode=SIGABRT）」—— **不许**读成「30 s 超时」、**不许**写「可能还在」（改前实测：37 s ＋ 两处假话）',
      signalRun.status === 4
      && signalRun.output.includes('Chromium 起不来：进程已退出（signalCode=SIGABRT）')
      && signalRun.output.includes('FATAL:chrome/browser/process_singleton_posix.cc:313] Socket path too long')
      && signalElapsedMs < 2500
      && signalCleanup !== null && signalCleanup.includes('已结束') && !signalCleanup.includes('可能还在'),
      JSON.stringify({ status: signalRun.status, elapsedMs: signalElapsedMs, cleanup: signalCleanup,
        tail: signalRun.output.trim().split('\n').slice(-3) }));

    // ── ② 逃出进程组的成员：等整棵树真的没了才删 work 目录；删完复核（回执只写量到的）─────────────
    const treeChrome = writeFakeChrome('tree-chrome.mjs', String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
const userDataDir = process.argv.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) ?? '';
const work = path.dirname(userDataDir);
const script = "const { appendFileSync, mkdirSync } = require('node:fs'); setTimeout(() => { mkdirSync(process.argv[1] + '/chromium', { recursive: true }); appendFileSync(process.argv[1] + '/chromium/flush.txt', 'flush'); }, 2500);";
spawn(process.execPath, ['-e', script, work], { detached: true, stdio: 'ignore' }).unref();
process.exit(1);
`);
    const treeOut = path.join(sandbox, 'out-fake-tree');
    const treeRun = runCli([SAMPLE, '--out', treeOut, '--timeout-ms', '5000'], { env: { CHROME_BIN: treeChrome } });
    runs.push({ label: 'fake-tree', result: treeRun });
    const treeWork = workOf(treeRun.output);
    const treeRefsAtExit = await processesReferencingPath(treeWork);
    await sleep(3200);   // 那支孙进程写在 2.5 s ——「回执说已删、盘上还在」就是在这个窗口里发生的
    const treeRefsLater = await processesReferencingPath(treeWork);
    const treeLeftOver = treeWork !== null && existsSync(treeWork);
    const treeReceipt = /\[designer-cli\] cleanup:.*/.exec(treeRun.output)?.[0] ?? null;
    check('cli:cleanup-tree',
      '假浏览器那棵树里有一支**自己 setsid 的**成员（真 `chrome_crashpad_handler` 的形状：ppid=1、自己一个进程组）会在 2.5 s 后往 work 里写回一笔 ⇒ **收尾必须等整棵树真的没了才删**、删完**复核**：CLI 退出时它和那个目录都真的不在了，3.2 s 后也**没有被写回来**（回执说「已删」⇒ 此刻盘上真的不在）。判据量的是**事实**：问 `test/harness.mjs` 的 `processesReferencingPath()`（命令行**或环境**里还引用着那个 work 目录的进程清单）＋ 目录在不在',
      treeRun.status === 4 && treeWork !== null && Array.isArray(treeRefsAtExit) && treeRefsAtExit.length === 0
      && !treeLeftOver && Array.isArray(treeRefsLater) && treeRefsLater.length === 0
      && treeReceipt !== null && treeReceipt.includes('已删') && treeReceipt.includes('删后复核'),
      JSON.stringify({ status: treeRun.status, work: treeWork, refsAtExit: treeRefsAtExit, leftOverAfter3200ms: treeLeftOver, refsLater: treeRefsLater, receipt: treeReceipt }));
    // 万一这条红了（机制坏了）：门自己按**精确路径**收掉这一次的残留 —— 它可能在 `/tmp`（换根之后）
    for (const leftover of [treeWork, longWork]) {
      if (leftover !== null && existsSync(leftover)) {
        rmSync(leftover, { recursive: true, force: true });
        process.stdout.write(`（收掉残留：${leftover} —— 收后还在？${existsSync(leftover)}）\n`);
      }
    }
  }
  // ═══ 7. 收尾：每个 run 的 work 目录都要真没了；起过的 Chromium pid 都要真没了 ═══════════════
  const cleanupRows = [];
  for (const run of runs) {
    const work = workOf(run.result.output);
    const pid = cleanupPidOf(run.result.output);
    const workRemoved = work !== null && !existsSync(work);
    const pidAlive = Number.isFinite(pid) ? await processAlive(pid) : null;
    cleanupRows.push({ label: run.label, work, workRemoved, pid, pidAlive, refs: await processesReferencingPath(work), cleanupLine: /\[designer-cli\] cleanup:.*/.exec(run.result.output)?.[0] ?? null });
  }
  check('cli:cleanup', '每一次跑过 CLI（成功样本 / --force / 坏文档 / 起不来的浏览器 / 换根那一跑）都**自己收干净**：打印的 work 目录逐个都不在盘上，且它起过的 Chromium pid 逐个都**真的没了**（拿 `processAlive` 读一次，不是"应该没了"）',
    cleanupRows.length >= 3 && cleanupRows.every((row) => row.work !== null && row.workRemoved === true && row.cleanupLine !== null)
    && cleanupRows.every((row) => row.pidAlive === false),
    JSON.stringify(cleanupRows));

  // 「那个 profile/work 目录里不许再有任何 chromium* 进程引用它」—— 拿**事实**量：问 `test/harness.mjs` 的
  // `processesReferencingPath()`（命令行 ＋ 环境；平台分叉归它）。收尾若只杀直接子进程，逃出进程组的那一支
  // （实测：真 crashpad handler 自己 setsid）会留着继续往里面写 —— 这一条就是那个洞的机械判据
  // （受控造形那一条在 `cli:cleanup-tree`）。量不到（harness 回 `null`）时**明确跳过**，不当绿。
  const measurableRows = cleanupRows.filter((row) => Array.isArray(row.refs));
  if (measurableRows.length === 0) {
    skip('cli:cleanup-no-referrers', 'CLI 退出后没有任何进程还引用着它的 work 目录',
      '这台机器上读不到别的进程的命令行/环境（harness 的 `processesReferencingPath()` 回 `null`）—— 量不了就不当绿');
  } else {
    check('cli:cleanup-no-referrers',
      '每一次跑过 CLI 之后，**没有任何进程**还引用着它打印的那个 work 目录（问 harness 的 `processesReferencingPath()`：命令行**或环境**里带着那个路径的进程清单必须为空）—— 不是「应该没了」，是量出来的',
      cleanupRows.length >= 3 && measurableRows.length === cleanupRows.length && measurableRows.every((row) => row.work !== null && row.refs.length === 0),
      JSON.stringify(cleanupRows.map((row) => ({ label: row.label, work: row.work, refs: row.refs }))));
  }

  // 硬约束、**量出来的**：Chromium 的单例 socket 路径必须 < 108 字节（`sockaddr_un.sun_path`，含结尾 NUL）。
  // socket 建在 `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket`，而 CLI 的 work 目录就是那层 `$TMPDIR`
  // 下面的一份 ⇒ `len(work) + 49`。超了 Chromium 自己 `LOG(FATAL)` 并 **SIGABRT**（实测 107 正常 / 108 崩），
  // 而 CLI 会把它**误报**成「调试端点 30s 没起来」（`bin/**` 那侧的缺陷）——所以本门先把「路径够不够短」
  // 当成一条**自己的**断言：谁再把沙箱路径加长，这里当场红，而不是变成 30s 之后一句看不懂的超时。
  const socketPathLen = (work) => work.length + 49;
  const oversize = cleanupRows.filter((row) => row.work !== null && socketPathLen(row.work) >= 108);
  check('cli:work-path-fits-chromium-singleton-socket',
    'CLI 的 work 目录短得够 Chromium 建它的单例 socket（`len(work) + 49 < 108` —— Linux 上 `sun_path` 是 108 字节；超了 Chrome 自己 SIGABRT，CLI 把它误报成「调试端点没起来」）',
    cleanupRows.length > 0 && cleanupRows.every((row) => row.work !== null) && oversize.length === 0,
    JSON.stringify({ inheritedTmp, rows: cleanupRows.map((row) => ({ label: row.label, workLen: row.work?.length ?? null, socketPathLen: row.work ? socketPathLen(row.work) : null })) }));

  const keepOut = path.join(sandbox, 'out-keep');
  const keepRun = runCli([SAMPLE, '--out', keepOut, '--keep-work']);
  const keepWork = workOf(keepRun.stdout);
  const keepEntries = keepWork !== null && existsSync(keepWork) ? readdirSync(keepWork).sort() : [];
  check('cli:keep-work', '`--keep-work` 说保留就真保留（work 目录还在盘上），并说清了那一份不会被删 —— 收尾口径不是"口头承诺"',
    keepRun.status === 0 && keepWork !== null && existsSync(keepWork) && /--keep-work 保留/.test(keepRun.stdout),
    JSON.stringify({ status: keepRun.status, work: keepWork, entries: keepEntries }));
  check('cli:isolation', '浏览器的 TMPDIR / HOME / XDG 全在它**自己**的 work 目录里（`home/` `tmp/` `xdg-config/` `xdg-cache/` ＋ `chromium/` profile 逐个都在那一份里）—— 这就是「不往共享临时目录、也不往真 home 写」那条规矩的**机制**（反证臂 `cli-no-isolation` 把它换成「继承环境原样交出去」⇒ 这一格必红）。⚠️ 量的是**那个私有布局在不在**，**不是** `org.chromium.Chromium.*` 那条症状本身（浏览器退出时 Chrome 自己会把它清掉 ⇒ 退出后数不到，写进文档的「没验到」）',
    ['chromium', 'home', 'tmp', 'xdg-config', 'xdg-cache'].every((dir) => keepEntries.includes(dir)),
    JSON.stringify({ entries: keepEntries, inheritedTmp, orgChromiumInInheritedTmpAfterExit: chromeTempEntries(inheritedTmp) }));
  // 这一份是 `--keep-work` 故意留的（它在本门沙箱里）⇒ 量完自己收掉，不留一坨
  let keptCleaned = false;
  if (keepWork !== null && existsSync(keepWork)) { rmSync(keepWork, { recursive: true, force: true }); keptCleaned = !existsSync(keepWork); }
  check('cli:keep-work-collected', '`--keep-work` 故意留下的那一份由本门自己收掉（它在沙箱里，收尾也会一起没）—— 不留残留',
    keptCleaned === true, JSON.stringify({ work: keepWork, cleaned: keptCleaned }));

  // ═══ 8. 文档：CLI 与退出码要写进那份活文档（不会与代码各说各的）═════════════════════════════
  const agentDoc = readFileSync(path.join(root, 'docs', 'design', 'designer-agent.md'), 'utf8');
  check('cli:doc', '`docs/design/designer-agent.md` 里有这一条 CLI 的用法（`node bin/designer.mjs` ＋ 退出码表 ＋ `--png`/`--force` 这些开关 ＋ 这个门的**本名** `test:designer-cli`）—— 代码与文档不会各说各的',
    agentDoc.includes('node bin/designer.mjs') && agentDoc.includes('退出码') && agentDoc.includes('--force') && agentDoc.includes('--png')
    && agentDoc.includes('test:designer-cli') && agentDoc.includes('test:designer-cli:reverse-noisolation'),
    JSON.stringify({ mentionsCli: agentDoc.includes('node bin/designer.mjs'), hasExitTable: agentDoc.includes('退出码'), hasScriptNames: agentDoc.includes('test:designer-cli') }));
  // 业主 2026-09-28：这一条是那次「看着像门红、其实是 `npm error Missing script`」的机械防线 ——
  // 上一版报告里只写了 `test:designercli`（没连字符），而门自己叫 `test/designer-cli.mjs`。
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const scripts = pkg.scripts ?? {};
  const expectedScripts = {
    'test:designer-cli': 'node test/designer-cli.mjs',
    'test:designer-cli:reverse-swallow': 'node test/designer-cli.mjs --reverse-arm=cli-swallows-errors',
    'test:designer-cli:reverse-noisolation': 'node test/designer-cli.mjs --reverse-arm=cli-no-isolation',
    'test:designercli': 'node test/designer-cli.mjs',
    'test:designerui:reverse-cli': 'node test/designer-cli.mjs --reverse-arm=cli-swallows-errors',
  };
  const wrongScripts = Object.entries(expectedScripts).filter(([name, command]) => scripts[name] !== command).map(([name]) => name);
  check('cli:scripts', '`package.json` 里这个门的**每一个名字**都在、且都指向同一个文件（两个本名 ＋ 三个别名/臂名）—— 钉住那次「`npm error Missing script`」不再重演（名字错了看起来就像门红了）',
    wrongScripts.length === 0,
    JSON.stringify({ missingOrWrong: wrongScripts, present: Object.keys(scripts).filter((name) => name.includes('designer-cli') || name === 'test:designercli' || name === 'test:designerui:reverse-cli') }));

  // 这一单新加的：文档里要有**四个新开关的逐字表** ＋ 产物名规则（含 %XX 转义）＋ `--check-twice`
  const newDocBits = ['--screen <id|name>', '--state <id|name>', '--all-screens', '--all-states', '--check-twice',
    'design-<文档基名>.<屏 id>.<状态 id>', '%XX', 'openScreen'];
  const missingDocBits = newDocBits.filter((text) => !agentDoc.includes(text));
  check('cli:doc-screens', '文档 `docs/design/designer-agent.md` §7 里也有这一单：四个新开关的逐字参数表、产物名规则（`design-<基名>.<屏 id>.<状态 id>` ＋ `%XX` 转义）、`--check-twice`、以及「切屏/切状态走的就是页面自己的 `openScreen`」—— 代码、`--help`、文档三处不会各说各的',
    missingDocBits.length === 0, JSON.stringify({ missing: missingDocBits }));

  // 两条**新**反证臂也要能在 `package.json` 里敲得出来（臂名敲不出来 ≈ 这道门没有那条臂）
  const expectedArms = {
    'test:designer-cli:reverse-allstates': 'node test/designer-cli.mjs --reverse-arm=multi-allstates-first-only',
    'test:designer-cli:reverse-flatname': 'node test/designer-cli.mjs --reverse-arm=artifact-name-without-target',
  };
  const wrongArms = Object.entries(expectedArms).filter(([name, command]) => scripts[name] !== command).map(([name]) => name);
  check('cli:scripts-arms', '两条**新**反证臂（`--all-states` 只出第一态 / 产物名不带屏·状态）在 `package.json` 里各有名字、指向同一个门文件 —— 臂名敲不出来就等于「这道门没那条臂」',
    wrongArms.length === 0, JSON.stringify({ missingOrWrong: wrongArms }));

  // 2026-09-25 这一单新加的三条臂（两处产品侧真缺陷 ＋ 换短根）也要能在 `package.json` 里敲得出来
  const expectedArms2 = {
    'test:designer-cli:reverse-signal': 'node test/designer-cli.mjs --reverse-arm=cli-ignores-signal-exit',
    'test:designer-cli:reverse-treekill': 'node test/designer-cli.mjs --reverse-arm=cli-only-watches-direct-child',
    'test:designer-cli:reverse-longtmp': 'node test/designer-cli.mjs --reverse-arm=cli-long-temp-root',
  };
  const wrongArms2 = Object.entries(expectedArms2).filter(([name, command]) => scripts[name] !== command).map(([name]) => name);
  check('cli:scripts-arms-cleanup', '这一单新加的三条反证臂（`departed()` 漏 `signalCode` / 看不见逃出进程组的成员 / 不看 socket 有多长）在 `package.json` 里各有名字、指向同一个门文件 —— 臂名敲不出来就等于「这道门没那条臂」',
    wrongArms2.length === 0, JSON.stringify({ missingOrWrong: wrongArms2 }));

  // 「工作根要放得下 Chromium 的单例 socket」这条口径要能**从 --help 读出来**（不许只活在代码里）
  const helpWork = runCli(['--help'], { timeout: 30000 });
  check('cli:help-work-root', '`--help` 说清工作根那条硬约束（Chromium 单例 socket 的 108 字节上界 → 放不下就**换短根**）与 `DESIGNER_CLI_TMP_ROOT` 这个**显式**口子 —— 人不必去读源码才知道为什么 work 不在他给的 TMPDIR 里',
    helpWork.status === 0 && helpWork.stdout.includes('DESIGNER_CLI_TMP_ROOT') && helpWork.stdout.includes('108')
    && helpWork.stdout.includes('换一个短根') && helpWork.stdout.includes('sockaddr_un.sun_path'),
    JSON.stringify({ status: helpWork.status, hasEnv: helpWork.stdout.includes('DESIGNER_CLI_TMP_ROOT'), has108: helpWork.stdout.includes('108') }));
  const workDocBits = ['DESIGNER_CLI_TMP_ROOT', '108', 'test:designer-cli:reverse-signal', 'test:designer-cli:reverse-treekill', 'test:designer-cli:reverse-longtmp'];
  const missingWorkDoc = workDocBits.filter((text) => !agentDoc.includes(text));
  check('cli:doc-work-root', '`docs/design/designer-agent.md` 里也写下了这一单的三件事：工作根的 108 字节硬约束与 `DESIGNER_CLI_TMP_ROOT`、以及**三条新反证臂的本名** —— 代码、`--help`、文档三处不会各说各的',
    missingWorkDoc.length === 0, JSON.stringify({ missing: missingWorkDoc }));
} catch (error) {
  check('cli:run', '这一臂跑完（没在断言之前抛异常）', false, error?.stack ?? String(error));
}

// ── 结算 / 反证臂断言 ───────────────────────────────────────────────────────────────────────
if (ARM) {
  const arm = ARM_MUTANTS[ARM];
  const redIds = failures.map((failure) => failure.id);
  process.stdout.write(`\n──── 反证臂 ${ARM}：预期红 ${JSON.stringify(arm.expect)} / 实际红 ${JSON.stringify(redIds)} ────\n`);
  for (const failure of failures) {
    process.stdout.write(`  红：[${failure.id}] ${failure.name} —— ${typeof failure.detail === 'string' ? failure.detail : JSON.stringify(failure.detail)}\n`);
  }
  const notRed = arm.expect.filter((id) => !redIds.includes(id));
  if (notRed.length === 0) {
    process.stdout.write(`✓ 反证臂 ${ARM} 红到位（预期的每一条都红了）—— 这是**期望**的结果，不是缺陷\n`);
  } else {
    process.stdout.write(`✗ 反证臂 ${ARM} **没红到位**：没红的是 ${JSON.stringify(notRed)} ⇒ 这道门是个假门\n`);
    process.exitCode = 1;
  }
} else {
  process.stdout.write(`\n──── test/designer-cli.mjs：${checks} 条断言 —— ${checks - failures.length} 绿 / ${failures.length} 红${skips.length > 0 ? ` / ${skips.length} 条本平台跳过（跳过 ≠ 通过）` : ''} ────\n`);
  for (const note of skips) process.stdout.write(`SKIP  ${note}\n`);
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stdout.write(`FAIL  [${failure.id}] ${failure.name} —— ${typeof failure.detail === 'string' ? failure.detail : JSON.stringify(failure.detail)}\n`);
    }
    process.exitCode = 1;
  } else if (problems.length > 0) {
    for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
    process.exitCode = 1;
  }
}

await removeSandbox(sandbox, problems, 'designer-cli sandbox');
finishCleanup(null, problems);
