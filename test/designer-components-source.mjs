#!/usr/bin/env node
// test/designer-components-source.mjs —— **「组件（`components`）只有一个真源」**那道门。
//
// ── 为什么要有它 ─────────────────────────────────────────────────────────────────────────────────
// 2026-10-05 那一单把「工具块」做成一等可复用单元（Figma 的 component）⇒ 中立文档顶层多了一个
// `components[]`（真源 `design/samples/two-pane/main-screen.json` 里的 `tool-card` ＋ 4 个变体），
// 屏幕树里多了 `type:"instance"` 的**引用**。这就多出一个「第二份真源」的口子：
// 谁要是从 `doc.components`（或组件树）另抄一份出去（另写一个 json / 另做一套读数），
// 「一份设计只有一个 json 真源」那条口径就破了 —— 而**当时没有任何门看着 `.mjs`**。
//
// ── 与既有门的重叠（只补没覆盖的那一半，不另造一套）────────────────────────────────────────────
// `test/designer-sample.mjs` 的 `live:one-document` 已经钉住：**live 集合里每一份带元素树的 `.json` 都与真源逐字节同源**
//   —— 那是「**产出的 json** 只有一份」。
// 本门补的是**另一半**：**读它的代码**只有名单里那几个 —— 「**谁在读 `components`**」。
//   两者合起来才是完整的「一个真源」：产物只有一份（既有门）＋ 读它的模块只有名单里那几个（本门）。
//   本门**不**重复扫 `.json`，也不重复 `live:one-document` 的任何判据。
//
// ── 判据（默认拒，不是默认放过）────────────────────────────────────────────────────────────────
// 扫遍仓内 live 的 `.mjs`/`.js`/`.cjs`（跳过 `node_modules`/`.git`/`attempts/`/`logs/`/`.sopho-*` 沙箱，
// **排除注释行**——与兄弟门 `designer-sample.mjs` 的 `live:no-stale-input` 同一套「注释行」口径：
// 一行以可选空白加 `//` 或 `*` 开头就不算代码），逐行找「碰 `components` 这个文档字段」的四类写法：
//   · `.components`（属性访问，例：`doc.components`）
//   · `["components"]` / `['components']`（下标访问）
//   · 行首缩进处的对象键 `components:`（写：把组件定义装进文档）
//   · 解构简写 `{ components }` / `{ components, … }`（读：`const { components } = doc`）
// ⇒ **任何不在许可名单里的文件命中 ⇒ 红**（新读者必须显式进名单：改这里，不是悄悄过）。
// ⇒ 名单里每一条**必须真的命中**（名单腐坏/过期 ⇒ 红）。
// ⇒ 扫描必须够到东西（语料文件数 < 门槛 ⇒ 红：扫描失去 reach = 假绿）。
//
// 许可名单（`WHITELIST`）**以实测为准**（`grep` 出来的就这三个；`toHtml.mjs`/`toSvg.mjs` 是
// 经 `expandTree(tree, doc)` **间接**读的，它们自己不碰字段 ⇒ 不在名单里，也不该在）：
//   · `designer/expand.mjs`  —— 摊平器：读 `doc.components` 找被引用的组件（渲染器的唯一入口）
//   · `designer/validate.mjs` —— 校验器：读 `doc.components` 判「ref/变体/覆盖指不指得到」与 id 唯一
//   · `design/samples/two-pane/merge.mjs` —— **唯一写者**：把组件定义（`TOOL_CARD_COMPONENT`）装进这一份文档
//
// ── 反证臂（必红；改的是**沙箱副本**，真仓一个字节不动）──────────────────────────────────────────
//   `npm run test:designercomponents:reverse-foreign` —— 把整棵扫描语料拷进沙箱，再塞一个**不在名单里**的模块
//   读一次 `doc.components` ⇒ `components:whitelisted` 必红（而 `components:no-stale-entry` / `components:scan-reach`
//   仍绿 —— 证明它红的是「外来读者」，不是名单腐坏或扫描失败）。
//
// 用法：node test/designer-components-source.mjs [--root=<目录>] [--reverse-arm=foreign-reader]

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { removeSandboxConverged } from './harness.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const here = path.dirname(THIS_FILE);
const REPO_ROOT = path.resolve(here, '..');
const argOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const ARM = argOf('reverse-arm');
const ROOT = path.resolve(argOf('root') || process.env.SOPHO_DESIGNER_COMPONENTS_ROOT || REPO_ROOT);
/** 这份门自己：扫的时候跳过（它的正则/名单里逐字写着 `components`，不跳就是自己咬自己）。 */
const SELF_RELATIVE = path.relative(REPO_ROOT, THIS_FILE).split(path.sep).join('/');

const EXTENSIONS = /\.(mjs|js|cjs)$/;
/** 不扫的目录名（逐段匹配）：依赖、git、历史/探针归档、日志、一次性沙箱副本。 */
const SKIP_SEGMENTS = new Set(['node_modules', '.git', 'attempts', 'logs']);
const skipDir = (name) => SKIP_SEGMENTS.has(name) || name.startsWith('.sopho');
/** 扫描语料的下限：低于它说明扫描失去 reach（目录名改了/根指错了）⇒ 判红，不假装绿。 */
const MIN_SCANNED_FILES = 50;

/** 四类「碰 `components` 字段」的写法。门自己那份的写法在注释/字符串里逐字出现 ⇒ 靠 `SELF_RELATIVE` 跳过。 */
const FIELD_PATTERNS = [
  /\.components\b/,
  /\[\s*['"]components['"]\s*\]/,
  /(?:^|[^\w$.'"`])components\s*:/,
  /[{,]\s*components\s*[,}]/,
];

/** 许可名单：**只有这些模块**可以碰 `components`（以实测为准；理由逐条写在上面文件头）。 */
const WHITELIST = [
  { file: 'designer/expand.mjs', why: '摊平器：读 doc.components 找被引用的组件（渲染器的唯一入口）' },
  { file: 'designer/validate.mjs', why: '校验器：读 doc.components 判 ref/变体/覆盖指不指得到与 id 唯一' },
  { file: 'design/samples/two-pane/merge.mjs', why: '唯一写者：把组件定义（TOOL_CARD_COMPONENT）装进这一份文档' },
];

const failures = [];
const problems = [];
function check(id, name, ok, detail) {
  process.stdout.write(`${ok ? '✓' : '✗'} [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  if (!ok) failures.push(id);
  return ok;
}

/** 一行算不算「代码行」：与 `test/designer-sample.mjs` 的 `live:no-stale-input` 同一套口径（注释行不算）。 */
const isCommentLine = (line) => /^\s*(\/\/|\*)/.test(line);

/** 一个文件里命中「碰 components 字段」的**代码行**（注释行不算）。返回 `[{ line, text }]`。 */
export function fieldHits(text) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    if (isCommentLine(line)) return;
    if (FIELD_PATTERNS.some((pattern) => pattern.test(line))) hits.push({ line: index + 1, text: line.trim() });
  });
  return hits;
}

/** 扫一棵树里 live 的 `.mjs`/`.js`/`.cjs`（相对路径，`/` 分隔，按字典序）。 */
export async function scanFiles(root) {
  const out = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skipDir(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (EXTENSIONS.test(entry.name)) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  await walk(root);
  return out.sort();
}

async function runChecks() {
  process.stdout.write(`扫描根：${ROOT}（live 的 .mjs/.js/.cjs；跳过 ${JSON.stringify([...SKIP_SEGMENTS])} 与 .sopho-*）\n`);
  process.stdout.write(`这份门自己（跳过）：${SELF_RELATIVE}\n`);
  const files = (await scanFiles(ROOT)).filter((relative) => relative !== SELF_RELATIVE);
  const whitelistSet = new Set(WHITELIST.map((entry) => entry.file));

  const matches = [];
  for (const relative of files) {
    const text = await readFile(path.join(ROOT, relative), 'utf8').catch(() => null);
    if (text === null) continue;
    const hits = fieldHits(text);
    if (hits.length > 0) matches.push({ file: relative, hits });
  }
  const foreign = matches.filter((entry) => !whitelistSet.has(entry.file));
  const matchedFiles = new Set(matches.map((entry) => entry.file));
  const missingEntries = WHITELIST.filter((entry) => !matchedFiles.has(entry.file)).map((entry) => entry.file);

  process.stdout.write(`\n──── 命中「碰 components 字段」的代码（${matches.length} 个文件）────\n`);
  for (const entry of matches) {
    process.stdout.write(`  ${whitelistSet.has(entry.file) ? '名单内' : '**名单外**'} ${entry.file}\n`);
    for (const hit of entry.hits) process.stdout.write(`      L${hit.line}: ${hit.text}\n`);
  }
  process.stdout.write(`\n──── 许可名单（${WHITELIST.length} 条）────\n`);
  for (const entry of WHITELIST) process.stdout.write(`  ${entry.file} —— ${entry.why}\n`);

  check('components:scan-reach', `扫描够到东西：扫到 ${files.length} 个 live 的 .mjs/.js/.cjs 文件（≥ ${MIN_SCANNED_FILES}）—— 扫描失去 reach（根指错/目录名改了）就红，不假装绿`,
    files.length >= MIN_SCANNED_FILES, `${files.length} 个文件`);

  // 匹配器自己的正控制：四类写法都得认出来，注释行与「近似但不是」的形状都不许误报（改了正则这条就红）。
  const matcherCases = [
    { text: 'const a = doc.components;', hit: true },
    { text: "const a = doc['components'];", hit: true },
    { text: 'const { components } = doc;', hit: true },
    { text: 'components: [TOOL_CARD_COMPONENT],', hit: true },
    { text: '// doc.components', hit: false },
    { text: '  * doc.components', hit: false },
    { text: 'const a = doc.component;', hit: false },
    { text: "const a = 'https://x/components';", hit: false },
  ];
  const matcherWrong = matcherCases.filter((item) => (fieldHits(item.text).length > 0) !== item.hit).map((item) => `${JSON.stringify(item.text)} 应为 ${item.hit ? '命中' : '不命中'}`);
  check('components:matcher', '匹配器认得出那四类写法（属性/下标/对象键/解构），且**注释行**与「近似但不是」（`doc.component`、URL 里的 `/components`）不误报 —— 改了正则这条就红',
    matcherWrong.length === 0, matcherWrong.length === 0 ? `${matcherCases.length}/${matcherCases.length} 条都对` : matcherWrong.join('；'));

  check('components:whitelisted', '**只有许可名单里的模块**碰 `components` 这个文档字段（默认拒：新读者必须显式进名单，不许悄悄多一个「第二份真源」）',
    foreign.length === 0,
    foreign.length === 0
      ? `名单内命中 ${matches.length} 个：${matches.map((entry) => entry.file).join('、')}`
      : `名单外命中 ${foreign.length} 个：${foreign.map((entry) => `${entry.file}（L${entry.hits[0].line}: ${entry.hits[0].text}）`).join('；')}`);

  check('components:no-stale-entry', '许可名单里**每一条都真的碰过** `components`（名单过期/腐坏 ⇒ 红，不静默放过）',
    missingEntries.length === 0,
    missingEntries.length === 0 ? `${WHITELIST.length}/${WHITELIST.length} 条都命中` : `名单里这些没命中：${JSON.stringify(missingEntries)}`);
}

// ── 反证臂 ────────────────────────────────────────────────────────────────────────────────────
// 臂把**整棵扫描语料**（同一套 `scanFiles`）拷进 `os.tmpdir()` 的沙箱（保持相对路径），再塞一个
// **不在名单里**的模块读一次 `doc.components`，然后用 `--root=<沙箱>` 跑本文件本体。
// 真仓一个字节不动；沙箱按精确路径收（`removeSandboxConverged`）。
const ARM_SPECS = {
  'foreign-reader': {
    why: '整棵扫描语料拷进沙箱，再塞一个不在名单里的模块（`design/samples/two-pane/second-source.mjs`）读一次 `doc.components`',
    expectRed: ['components:whitelisted'],
    expectGreen: ['components:no-stale-entry', 'components:scan-reach', 'components:matcher'],
    async mutate(dest) {
      for (const relative of await scanFiles(ROOT)) {
        const target = path.join(dest, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, await readFile(path.join(ROOT, relative), 'utf8'), 'utf8');
      }
      const offender = path.join(dest, 'design', 'samples', 'two-pane', 'second-source.mjs');
      await mkdir(path.dirname(offender), { recursive: true });
      await writeFile(offender, '// 不在许可名单里的模块，悄悄读了一次组件字段（= 第二份真源的口子）\nexport const peek = (doc) => doc.components;\n', 'utf8');
    },
  },
};

if (ARM && !ARM_SPECS[ARM]) {
  process.stderr.write(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_SPECS).join(', ')}）\n`);
  process.exit(2);
}

if (!ARM) {
  await runChecks();
  process.stdout.write(`\n──── test/designer-components-source.mjs：${failures.length === 0 ? '全部绿' : `${failures.length} 条红`} ────\n`);
  if (failures.length > 0) process.stdout.write(`红的：${JSON.stringify(failures)}\n`);
  for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
  process.exitCode = failures.length === 0 && problems.length === 0 ? 0 : 1;
} else {
  const spec = ARM_SPECS[ARM];
  process.stdout.write(`反证臂 ${ARM}：${spec.why}\n`);
  const dest = await mkdtemp(path.join(os.tmpdir(), 'designer-components-arm-'));
  process.stdout.write(`  沙箱（真仓一个字节不动）：${dest}\n`);
  let child = null;
  const armProblems = [];
  let ok = false;
  try {
    await spec.mutate(dest);
    child = spawnSync(process.execPath, [THIS_FILE, `--root=${dest}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, SOPHO_DESIGNER_COMPONENTS_ROOT: dest },
    });
    const redIds = [...(child.stdout ?? '').matchAll(/^✗ \[([^\]]+)\]/gm)].map((match) => match[1]);
    const missing = spec.expectRed.filter((id) => !redIds.includes(id));
    const wronglyRed = spec.expectGreen.filter((id) => redIds.includes(id));
    const redLines = (child.stdout ?? '').split('\n').filter((line) => line.startsWith('✗'));
    process.stdout.write(`\n──── 反证臂 ${ARM}：预期红 ${JSON.stringify(spec.expectRed)} / 实际红 ${JSON.stringify(redIds)}（子进程 exit=${child.status}）────\n`);
    for (const id of spec.expectRed) process.stdout.write(`  ${redIds.includes(id) ? '红' : '没红'}：[${id}]\n`);
    for (const id of spec.expectGreen) process.stdout.write(`  ${redIds.includes(id) ? '**不该红却红了**' : '仍绿'}：[${id}]\n`);
    process.stdout.write(`\n子进程里那些红**逐字**长这样（报告要原文）：\n${redLines.map((line) => `  ${line}`).join('\n')}\n`);
    ok = child.status !== 0 && missing.length === 0 && wronglyRed.length === 0;
    process.stdout.write(ok
      ? `✓ 反证臂 ${ARM} 红到位（名单外的读者 ⇒ 这条必红；名单腐坏/扫描失败那两条仍绿；真仓一个字节没动）\n`
      : `✗ 反证臂 ${ARM} **没红到位**：缺 ${JSON.stringify(missing)}／不该红却红 ${JSON.stringify(wronglyRed)}（子进程 exit=${child.status}）⇒ 这道门是个假门\n`);
    if (!ok) process.stdout.write(`${redLines.join('\n')}\n`);
    process.stderr.write(child.stderr ?? '');
  } catch (error) {
    process.stderr.write(`反证臂 ${ARM} 主错误：${error?.stack ?? error}\n`);
  } finally {
    const result = await removeSandboxConverged(dest, { label: `designer-components 反证臂 ${ARM} 沙箱` });
    for (const problem of result.problems) armProblems.push(problem);
    if (result.remaining) armProblems.push(`反证臂沙箱 ${dest} 删了 ${result.passes} 遍仍在盘上`);
    for (const problem of armProblems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
    process.exitCode = ok && armProblems.length === 0 ? 0 : 1;
  }
}
