#!/usr/bin/env node
// test/designer-freshness.mjs —— 「**导出物是不是旧的**」门（形状照着 `test/gen-values-freshness.mjs`）。
//
// 为什么要有它：中立文档是上游，导出物是下游（`docs/designer-exporters.md` 的接法提案）。
// 「改了文档、忘了重跑导出器」是**新多出来**的那种漂（多一层上游就多一个漂源），而它在产品上看不出来
// —— 拿的还是旧的 HTML/SVG。本门把它变成一条**不用浏览器、一两秒**就能跑的红/绿。
//
// 两个口径（必须一致；口径不一致也判红：那是判据自己坏了，不是「差不多」）：
//   ① 导出器**自己的** `--check`（`npm run gen:designer:check` 的同一个判据：盘上那份 == 刚渲染的，逐字节）；
//   ② 本门自己再渲染一遍 `designer/fixtures/demo.json`，与盘上逐个文件比（打出两侧的 sha256 ＋ 字节数，
//      不一致时打出**第一处不同的那一行**）。
// 再加一条**诊断**：导出物里嵌的文档摘要（`sha256:<hex>`）必须等于当前文档规范字节的 sha256 ——
// 红了的时候它能直接说「这份导出物对应的是哪一版文档」，而不是只说「不相等」。
//
// 用法：
//   node test/designer-freshness.mjs                       # 规范目录：designer/generated
//   node test/designer-freshness.mjs --dir=<目录>           # 换「盘上那一份」住哪（反证臂用）
//   node test/designer-freshness.mjs --reverse-arm=onebyte  # 反证臂：拷一份、手改一个字节 ⇒ 必红
//
// 出口：0 = 新鲜（且若选了臂，臂也红到位）；1 = 不新鲜 / 两口径不一致 / 臂没红到位。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { removeSandbox } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const DESIGNER_ROOT = path.resolve(process.env.SOPHO_DESIGNER_ROOT || path.join(root, 'designer'));
const CANONICAL_DIR = path.join(DESIGNER_ROOT, 'generated');
const DOC_RELATIVE = 'designer/fixtures/demo.json';
const DOC_FILE = path.join(DESIGNER_ROOT, 'fixtures', 'demo.json');
const EXPORTER = path.join(DESIGNER_ROOT, 'export.mjs');
const VIEWPORT = { w: 1200, h: 760 };
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const argOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const failures = [];
const problems = [];
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
function check(id, name, ok, detail) {
  if (ok) {
    process.stdout.write(`✓ [${id}] ${name} —— ${detail}\n`);
    return true;
  }
  failures.push(id);
  process.stdout.write(`✗ [${id}] ${name} —— ${detail}\n`);
  return false;
}

let dir = path.resolve(argOf('dir') || CANONICAL_DIR);
let sandbox = null;
if (ARM) {
  if (ARM !== 'onebyte') throw new Error(`不认识的反证臂：${ARM}（可选：onebyte）`);
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'designer-freshness-'));
  dir = path.join(sandbox, 'generated');
  await cp(CANONICAL_DIR, dir, { recursive: true });
  const target = path.join(dir, 'demo.html');
  const original = await readFile(target, 'utf8');
  // 「手改一个字节」＝ 把 HTML 里嵌的**文档摘要**最后一个 hex 位改掉。那就是「这份导出物其实是按另一版
  // 文档生成的」这件事的最小形态（也正是 freshness:digest 要抓的那一种旧）；而 freshness:bytes 抓的是
  // 任何字节改动（例如有人把 `--fg` 的颜色改了一笔）。两种旧都能被本门判红，这里挑后者做不到的那一种。
  const digestHit = /sha256:([0-9a-f]{64})/.exec(original);
  if (!digestHit) throw new Error('反证臂 onebyte：副本的 HTML 里找不到嵌入的文档摘要');
  const flipped = `${digestHit[1].slice(0, -1)}${digestHit[1].endsWith('f') ? 'e' : 'f'}`;
  await writeFile(target, original.replace(`sha256:${digestHit[1]}`, `sha256:${flipped}`), 'utf8');
  print('反证臂 onebyte', `手改一个字节（HTML 里嵌的文档摘要 ${digestHit[1].slice(-4)} ⇒ ${flipped.slice(-4)}）后的副本：${dir}（真 designer/generated 一个字节没动）`);
}

// ── 口径 ①：导出器自己的 `--check` ─────────────────────────────────────────────────────────────
const checkRun = spawnSync(process.execPath, [EXPORTER, `--doc=${DOC_FILE}`, `--out=${dir}`, '--check'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
print('文档（唯一上游）', DOC_RELATIVE);
print('盘上的导出物', `${dir}（${(await readdir(dir).catch(() => [])).length} 个文件）`);
print('导出器自己的 --check', `exit=${checkRun.status}｜${(checkRun.stdout || checkRun.stderr || '').trim().split(/\r?\n/)[0] ?? ''}`);

// ── 口径 ②：本门自己再渲染一遍，逐文件逐字节比 ────────────────────────────────────────────────
const canonical = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'canonical.mjs')).href);
const designer = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toHtml.mjs')).href);
const svg = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toSvg.mjs')).href);
const diffModule = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'diff.mjs')).href);
const doc = JSON.parse(await readFile(DOC_FILE, 'utf8'));
const base = 'demo';
const expected = new Map([
  [`${base}.json`, designer.renderDocumentJson(doc)],
  [`${base}.html`, designer.renderDocumentHtml(doc, { viewport: VIEWPORT })],
  [`${base}.flow.svg`, svg.renderFlowSvg(doc)],
]);
for (const screen of doc.screens) {
  expected.set(`${base}.screen.${screen.id}.svg`, svg.renderScreenSvg(doc, screen.id, { viewport: VIEWPORT }));
  for (const state of (Array.isArray(screen.states) ? screen.states : []).slice(1)) {
    if (state.root === undefined) continue; // 没有自己那棵树的状态与默认树共用 ⇒ 不产文件
    expected.set(`${base}.screen.${screen.id}.${state.id}.svg`, svg.renderScreenSvg(doc, screen.id, { viewport: VIEWPORT, state: state.id }));
  }
}

const onDiskNames = (await readdir(dir).catch(() => [])).sort();
const nameMismatch = JSON.stringify(onDiskNames) === JSON.stringify([...expected.keys()].sort());
check('freshness:set', '盘上的文件集合 == 导出器该产的集合（不多一个、不少一个）',
  nameMismatch, `盘上 ${JSON.stringify(onDiskNames)} / 期望 ${JSON.stringify([...expected.keys()].sort())}`);

let bytesOk = true;
const firstDiffs = [];
const rows = [];
for (const [name, text] of expected) {
  const onDisk = await readFile(path.join(dir, name)).catch(() => null);
  const fresh = Buffer.from(text, 'utf8');
  const same = onDisk !== null && onDisk.equals(fresh);
  bytesOk = bytesOk && same;
  rows.push(`${name}: ${onDisk === null ? '盘上没有' : `${onDisk.length} B sha256 ${sha(onDisk).slice(0, 12)}…`} / 刚渲染 ${fresh.length} B sha256 ${sha(fresh).slice(0, 12)}…${same ? ' ⇒ 相同' : ''}`);
  if (!same && onDisk !== null) {
    const left = onDisk.toString('utf8').split(/\r?\n/);
    const right = text.split(/\r?\n/);
    let at = 0;
    while (at < Math.max(left.length, right.length) && left[at] === right[at]) at += 1;
    firstDiffs.push(`${name}: 第 ${at + 1} 行 —— 盘上 ${JSON.stringify(left[at] ?? '(没有这一行)')} / 刚渲染 ${JSON.stringify(right[at] ?? '(没有这一行)')}`);
  }
}
check('freshness:bytes', `盘上的 ${base}.* 每一个 == 按 ${DOC_RELATIVE} 刚渲染出来的（**逐字节**）`,
  bytesOk, bytesOk ? '全部相同' : `${firstDiffs.join('；')}`);

// ── 诊断：导出物里嵌的文档摘要 == 当前文档的摘要 ──────────────────────────────────────────────
const digest = canonical.docDigest(doc);
const digestReports = [];
let digestOk = true;
for (const [name, text] of expected) {
  if (!name.endsWith('.html') && !name.endsWith('.svg')) continue;
  const onDisk = await readFile(path.join(dir, name), 'utf8').catch(() => null);
  const result = onDisk === null
    ? { ok: false, message: `${name}: 盘上没有` }
    : diffModule.checkExportFreshness(doc, onDisk, name);
  digestOk = digestOk && result.ok;
  digestReports.push(result.message);
}
check('freshness:digest', '导出物里嵌的文档摘要 == 当前文档规范字节的 sha256（红了能直接说「这份对应哪一版文档」）',
  digestOk, `当前文档 sha256:${digest.slice(0, 12)}…｜${digestReports.map((line) => line.split(': ').at(-1)).join('；')}`);

// ── 两口径必须一致 ────────────────────────────────────────────────────────────────────────────
const checkSaysFresh = checkRun.status === 0;
const bytesSaysFresh = bytesOk && digestOk;
check('freshness:agrees', '导出器自己的 `--check` 与上面的逐字节比**口径一致**（它说一致就得真一致；说没跟上就得真不同）',
  checkSaysFresh === bytesSaysFresh,
  `--check exit=${checkRun.status}（＝“${checkSaysFresh ? '一致' : '没跟上'}”）｜字节比＝“${bytesSaysFresh ? '相同' : '不同'}”`);

process.stdout.write(`\n──── 逐文件读数 ────\n${rows.join('\n')}\n`);

let armOk = null;
if (ARM) {
  const redIds = failures.slice();
  // 「口径一致」那一条在臂里应该**仍然绿**：两条口径都说「没跟上」⇒ 它们是一致的。
  // 这正是它与「字节比」分开的意义 —— 它比的是「两条判据说不说同一句话」，不是「文件新不新」。
  const expectRed = ['freshness:bytes', 'freshness:digest'];
  armOk = expectRed.every((id) => redIds.includes(id)) && !redIds.includes('freshness:agrees');
  process.stdout.write(`\n──── 反证臂 onebyte：预期红 ${JSON.stringify(expectRed)} ＋ 「freshness:agrees 仍然绿」 / 实际红 ${JSON.stringify(redIds)} ────\n`);
  for (const line of firstDiffs) process.stdout.write(`  红：[freshness:bytes] ${line}\n`);
  process.stdout.write(`  红：[freshness:digest] ${digestReports.find((line) => line.includes('旧的')) ?? digestReports.join('；')}\n`);
  process.stdout.write(`  绿：[freshness:agrees] --check exit=${checkRun.status}（说“${checkSaysFresh ? '一致' : '没跟上'}”）vs 字节比“${bytesSaysFresh ? '相同' : '不同'}” ⇒ 两条口径说的是同一句话\n`);
  process.stdout.write(armOk
    ? '✓ 反证臂 onebyte 红到位（手改一个字节 ⇒ 字节比与文档摘要都红；两条口径**一致地**说「没跟上」）—— 这是**期望**的结果，不是缺陷\n'
    : `✗ 反证臂 onebyte **没红到位**：实际红 ${JSON.stringify(redIds)} ⇒ 这道门是个假门\n`);
  await removeSandbox(sandbox, problems, 'designer-freshness 反证臂沙箱');
} else {
  process.stdout.write(`\n──── test/designer-freshness.mjs：4 条断言 —— ${4 - failures.length} 绿 / ${failures.length} 红 ────\n`);
  if (failures.length > 0) process.stdout.write('（怎么修：跑一次 `npm run gen:designer`；不要手改 designer/generated/ 里的文件）\n');
}

for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
process.exitCode = (ARM ? armOk === true : failures.length === 0) && problems.length === 0 ? 0 : 1;
