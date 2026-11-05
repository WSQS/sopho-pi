#!/usr/bin/env node
// test/plugin-values-freshness.mjs —— 「生成物新鲜度」门：**盘上那份 == 按当前插件源码刚重跑出来的**（逐字节）。
//
// 为什么要有它（本单的硬要求，一句话）：「插件常量被改而生成物没改」**必须**红 —— 否则前端就拿着一个
// 与插件不匹配的数在说谎，而**没人会看见**。取值层那条链是「插件源码 ⇒ 生成物 ⇒ 前端」：
//   pi-extensions/assistant/index.ts 的 DEFAULT_BASH_TIMEOUT_S / SOPHO_BASH_TIMEOUT / 关掉判据
//     ⇒ bin/gen-plugin-values.mjs ⇒ web/generated/plugin-values.js ⇒ web/render.js 的工具卡那一行。
// 生成物一旦是旧的，工具卡上的「本机缺省 N s」就是错的数。本门把这件事变成一条**不用浏览器、一秒**的红/绿。
//
// 它**不另写一套比较**（同一件事两个实现就是下一处会漂的地方）：直接跑**真生成器自己的** `--check`
// （`bin/gen-plugin-values.mjs --check`，＝`npm run gen:pluginvalues:check` 那个判据）；另外**再渲染一次**
// 打到 stdout 只为**取证**（两侧的 sha256 ＋ 字节数；不一致时把第一处不同的行、以及生成器自己那句话原样打出来）。
// 两个口径必须一致 —— 生成器说「一致」而字节不同（或反过来）也判红：那是**门的判据自己坏了**。
//
// 用法：
//   node test/plugin-values-freshness.mjs                          # 真仓库（插件源码与生成物都在规范路径）
//   node test/plugin-values-freshness.mjs --out=<文件>              # 把「盘上那一份」指到别处（反证臂用）
//   node test/plugin-values-freshness.mjs --reverse-arm=onebyte    # 反证臂①：手改生成物一个字节 ⇒ 必红
//   node test/plugin-values-freshness.mjs --reverse-arm=plugin-drift # 反证臂②：把**插件源码副本**的常量改掉、
//                                                                  # 生成物不动 ⇒ 「插件改了忘了重生成」必红
//
// 出口：0 = 新鲜（且若选了臂，臂也红到位）；1 = 不新鲜 / 两口径不一致 / 臂没红到位。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = path.join(root, 'bin', 'gen-plugin-values.mjs');
const SOURCE_RELATIVE = path.join('pi-extensions', 'assistant', 'index.ts').split(path.sep).join('/');
const CANONICAL_OUT = path.join(root, 'web', 'generated', 'plugin-values.js');
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const argOf = (name) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const problems = [];
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const print = (label, value) => process.stdout.write(`${label}: ${value}\n`);
let failures = 0;
function check(id, name, ok, detail) {
  if (ok) {
    process.stdout.write(`✓ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
    return true;
  }
  failures += 1;
  process.stdout.write(`✗ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  return false;
}

const sandboxes = [];

/** 反证臂清单（`--reverse-arm=<名>`）。`plugin-drift` 那条带 `file:` → `from:` → `to:`（成对声明的接缝，
 *  `bin/check-arm-seams.mjs` 会扫到它）；`onebyte` 改的是**产物副本**（不是源），本门扫的是
 *  test/** 里声明的臂、不扫「产物 vs 源」这条关系 ⇒ 进不了扫描，故本文件在
 *  `bin/arm-seam-coverage.json` 里记 `partial`（同 `test/gen-values-freshness.mjs` 的记法）。 */
const ARM_MUTANTS = {
  onebyte: {
    what: '把「盘上那份」换成**手改一个字节**的副本（`= 1800;` ⇒ `= 1801;`）⇒ 两条新鲜度断言必红',
    expect: ['freshness:bytes', 'freshness:check-agrees'],
  },
  'plugin-drift': {
    what: '把**插件源码副本**的常量改掉（`DEFAULT_BASH_TIMEOUT_S = 1800;` ⇒ `= 1200;`）而生成物不动 ⇒ `freshness:check-agrees` 必红（＝「改了插件忘了重生成」必红）',
    file: SOURCE_RELATIVE,
    from: 'const DEFAULT_BASH_TIMEOUT_S = 1800;',
    to: 'const DEFAULT_BASH_TIMEOUT_S = 1200;',
    expect: ['freshness:check-agrees'],
  },
};
if (ARM && !ARM_MUTANTS[ARM]) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);

/** 反证臂 `onebyte`：把生成物拷一份出来，**手改一个字节**（`= 1800;` ⇒ `= 1801;`），再拿它当「盘上那份」。 */
let outFile = path.resolve(argOf('out') || CANONICAL_OUT);
if (ARM === 'onebyte') {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-pluginvalues-'));
  sandboxes.push(sandbox);
  outFile = path.join(sandbox, 'plugin-values.js');
  const canonical = await readFile(CANONICAL_OUT, 'utf8');
  if (!canonical.includes('= 1800;')) throw new Error('反证臂 onebyte 的改写没命中（生成物里没有 `= 1800;`？）');
  await writeFile(outFile, canonical.replace('= 1800;', '= 1801;'), 'utf8');
  print('反证臂 onebyte', `手改一个字节（= 1800; ⇒ = 1801;）后的副本：${outFile}（真仓库那份一个字节没动）`);
}

// ── 两个口径：① 真生成器自己的 `--check`；② 门自己再渲染一次逐字节比 ──────────────────────────────
const checkRun = spawnSync(process.execPath, [GENERATOR, `--out=${outFile}`, '--check'], { encoding: 'utf8', timeout: 60000 });
const renderRun = spawnSync(process.execPath, [GENERATOR, '--stdout'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
if (renderRun.status !== 0) {
  print('生成器 --stdout 失败', JSON.stringify({ exit: renderRun.status, stderr: (renderRun.stderr ?? '').trim() }));
  process.exit(1);
}
const onDisk = await readFile(outFile).catch(() => null);
const fresh = Buffer.from(renderRun.stdout ?? '', 'utf8');
const identical = onDisk !== null && onDisk.equals(fresh);
const checkSaysFresh = checkRun.status === 0;

print('插件源码（唯一来源）', SOURCE_RELATIVE);
print('盘上那一份', `${outFile}${onDisk === null ? '（读不到）' : `（${onDisk.length} B；sha256 ${sha256(onDisk).slice(0, 12)}…）`}`);
print('刚渲染出来', `${fresh.length} B；sha256 ${sha256(fresh).slice(0, 12)}…`);
print('生成器自己的 --check', `exit=${checkRun.status}｜${(checkRun.stdout || checkRun.stderr || '').trim().split(/\r?\n/)[0] ?? ''}`);

// 第一处不同（红的时候要看得见**哪一行**变了，不是只说"不相等"）
let firstDiff = null;
if (!identical && onDisk !== null) {
  const left = onDisk.toString('utf8').split(/\r?\n/);
  const right = fresh.toString('utf8').split(/\r?\n/);
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    if (left[at] !== right[at]) { firstDiff = { line: at + 1, onDisk: left[at] ?? '(没有这一行)', fresh: right[at] ?? '(没有这一行)' }; break; }
  }
}

check('freshness:bytes', `盘上那份 web/generated/plugin-values.js == 按 ${SOURCE_RELATIVE} 刚重跑出来的（**逐字节**）`,
  identical,
  identical
    ? `${fresh.length} B｜sha256 ${sha256(fresh).slice(0, 12)}…（两侧相同）`
    : `盘上 ${onDisk === null ? '读不到' : `${onDisk.length} B（sha256 ${sha256(onDisk).slice(0, 12)}…）`} / 刚渲染 ${fresh.length} B（sha256 ${sha256(fresh).slice(0, 12)}…）`
      + `｜第一处不同在第 ${firstDiff?.line} 行：盘上 ${JSON.stringify(firstDiff?.onDisk)} / 刚渲染 ${JSON.stringify(firstDiff?.fresh)}`);
check('freshness:check-agrees', '生成器自己的 `--check`（`npm run gen:pluginvalues:check` 的同一个判据）与上面这一条**口径一致**（它说一致就得真一致；说没跟上就得真不同）',
  checkSaysFresh === identical,
  `--check exit=${checkRun.status}（＝“${checkSaysFresh ? '一致' : '没跟上'}”）｜字节比较＝“${identical ? '相同' : '不同'}”`);

// ── 溯源：生成物里的那个数**真的**是从插件源码里读出来的（不是门自己也写死一个 1800 跟它对）──────
// 这一条与上面两条不同：它不看「盘上那份」，只看「源码 ⇒ 刚渲染」这一跳 —— 从源码里读那个数，
// 再断言刚渲染出来的字节里**逐字**有 `= <那个数>;`。改了源码里的数而生成器读对了，这一条跟着变。
const sourceText = await readFile(path.join(root, SOURCE_RELATIVE), 'utf8');
const sourceNumber = /const DEFAULT_BASH_TIMEOUT_S = (\d+);/.exec(sourceText)?.[1] ?? null;
const renderedNumber = /export const BASH_DEFAULT_TIMEOUT_S = (\d+);/.exec(fresh.toString('utf8'))?.[1] ?? null;
check('source:value-traced-to-plugin', `刚渲染出的 BASH_DEFAULT_TIMEOUT_S 逐字等于插件源码里那个数（源码 ${sourceNumber} ⇒ 生成物 ${renderedNumber}）`,
  sourceNumber !== null && renderedNumber === sourceNumber,
  JSON.stringify({ sourceNumber, renderedNumber }));

let armOk = null;
if (ARM === 'onebyte') {
  const redIds = [];
  if (!identical) redIds.push('freshness:bytes');
  if (!checkSaysFresh) redIds.push('freshness:check-agrees');
  const expected = ARM_MUTANTS.onebyte.expect;
  armOk = expected.every((id) => redIds.includes(id));
  process.stdout.write(`\n──── 反证臂 onebyte：预期红 ${JSON.stringify(expected)} / 实际红 ${JSON.stringify(redIds)} ────\n`);
  process.stdout.write(`  红：[freshness:bytes] 逐字节比 —— 第一处不同在第 ${firstDiff?.line} 行：盘上 ${JSON.stringify(firstDiff?.onDisk)} / 刚渲染 ${JSON.stringify(firstDiff?.fresh)}\n`);
  process.stdout.write(`  红：[freshness:check-agrees] 生成器自己的 --check —— exit=${checkRun.status}｜${(checkRun.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''}\n`);
  process.stdout.write(armOk
    ? '✓ 反证臂 onebyte 红到位（手改一个字节 ⇒ 两条都红）—— 这是**期望**的结果，不是缺陷\n'
    : `✗ 反证臂 onebyte **没红到位**：实际红 ${JSON.stringify(redIds)} ⇒ 这道门是个假门\n`);
}
if (ARM === 'plugin-drift') {
  // 反证臂 plugin-drift：**插件源码副本**的常量改掉（1200），生成物（真仓库那份，1800）不动。
  // 这一臂判的就是「改了插件而忘了重新生成 ⇒ 必红」。
  const drift = ARM_MUTANTS['plugin-drift'];
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-pluginvalues-drift-'));
  sandboxes.push(sandbox);
  const canonicalSource = await readFile(path.join(root, SOURCE_RELATIVE), 'utf8');
  if (!canonicalSource.includes(drift.from)) throw new Error(`反证臂 ${ARM} 的改写没命中（插件形状变了？）：${drift.what}`);
  const mutatedSourceFile = path.join(sandbox, 'index.ts');
  await writeFile(mutatedSourceFile, canonicalSource.replace(drift.from, drift.to), 'utf8');
  // 「盘上那份」仍是真仓库那份（1800）—— 只把**源码**换成副本（1200）。
  const driftCheck = spawnSync(process.execPath, [GENERATOR, `--source=${mutatedSourceFile}`, `--out=${CANONICAL_OUT}`, '--check'], { encoding: 'utf8', timeout: 60000 });
  const driftRender = spawnSync(process.execPath, [GENERATOR, `--source=${mutatedSourceFile}`, '--stdout'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const driftSaysFresh = driftCheck.status === 0;
  const driftNumber = /export const BASH_DEFAULT_TIMEOUT_S = (\d+);/.exec(driftRender.stdout ?? '')?.[1] ?? null;
  const canonicalStillOld = (await readFile(CANONICAL_OUT, 'utf8')).includes('= 1800;');
  const driftRenderedNew = driftNumber === '1200';
  const redIds = driftSaysFresh ? [] : ['freshness:check-agrees'];
  armOk = !driftSaysFresh && canonicalStillOld && driftRenderedNew && drift.expect.every((id) => redIds.includes(id));
  process.stdout.write(`\n──── 反证臂 plugin-drift：预期红 ${JSON.stringify(drift.expect)} / 实际红 ${JSON.stringify(redIds)} ────\n`);
  process.stdout.write(`  装置自证：源码副本（1200）生成器渲染出 BASH_DEFAULT_TIMEOUT_S=${driftNumber}（期望 1200）：${driftRenderedNew}｜真仓库生成物仍是 1800：${canonicalStillOld}\n`);
  process.stdout.write(`  红：[freshness:check-agrees] 生成器 --check（源码副本 1200 vs 盘上 1800）—— exit=${driftCheck.status}｜${(driftCheck.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''}\n`);
  process.stdout.write(armOk
    ? '✓ 反证臂 plugin-drift 红到位（插件改了、生成物没跟 ⇒ 门红）—— 这是**期望**的结果，不是缺陷\n'
    : '✗ 反证臂 plugin-drift **没红到位** ⇒ 这道门咬不住「改了插件忘了重生成」那个 bug 类\n');
}
if (!ARM) {
  process.stdout.write(`\n──── test/plugin-values-freshness.mjs：3 条断言 —— ${3 - failures} 绿 / ${failures} 红 ────\n`);
  if (failures > 0) process.stdout.write('（怎么修：跑一次 `npm run gen:pluginvalues`；不要手改 web/generated/plugin-values.js）\n');
}

for (const sandbox of sandboxes) await removeSandbox(sandbox, problems, 'plugin-values-freshness sandbox');
for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
// 反证臂下："预期的那几条红了"才算过（所以进程出口是 0）；基线跑则"零红 + 沙箱干净"才算过。
process.exitCode = (ARM ? armOk === true : failures === 0) && problems.length === 0 ? 0 : 1;
