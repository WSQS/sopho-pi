#!/usr/bin/env node
// bin/gen-design-values.mjs —— 把**规格文档里的那几个数**变成产品的取值来源（生成物层）。
//
// 为什么要有它（工单 C 的**前置**，业主口径逐字：「你的两个页面应该是**共存的**…让我们**直接开始推进 C**」）：
//   「C ＝ 在真实现上动手」的唯一前置是：**产品的那几个数必须来自规格**。
//   规格文档（`spec/screens/<屏>.md`）是「精确规定页面设计」这件事的唯一真源（`docs/design-spec.md`）；
//   只要产品的数字还是**手写在 CSS 里**的，在真页面上改一次设计就**绕过了真源**（门会红，而没人知道
//   该改文档还是改代码）。所以先铺这一层：产品那几处声明改写成 `var(--design-…, <原来的字面量>)`，
//   值由本脚本从规格文档生成。之后「改规格 ⇒ 重跑本脚本 ⇒ 真页面跟着变」是**一条路**，不是两份抄本。
//
// 这个脚本只做一件事，规则一句话：
//   **生成值 ＝ 规格文档几何表里那一行的「声明值」，逐字**（单位照文档）。
//   它不发明任何数、不做换算、不加壳 —— 数的**唯一**人类来源就是那张表。
//   ⚠️ 因此「哪些条目可生成」这件事**只有一份判断**，就是下面那张 ITEMS 表（工单 ① 的清单在这里落地）：
//      能被 CSS 自定义属性表达、且替换后**牵动不了别的语义**的，才是这一层的成员；不适合的在报告里
//      逐条写明不做的理由（例如 `role` / 个数 / 字体度量 / 由布局算出来的数）。
//   判据的代价写在报告里，不写在这里假装它「自动」。
//
// 用法：
//   node bin/gen-design-values.mjs                      # 重写 web/generated/design-values.css（一键重跑）
//   node bin/gen-design-values.mjs --check              # 只比：盘上那份是不是当前规格的生成结果（不写）
//   node bin/gen-design-values.mjs --stdout             # 打到标准输出（不写盘）
//   node bin/gen-design-values.mjs --screen=<屏名>       # 换屏（默认 settings-overlay）
//   node bin/gen-design-values.mjs --spec=<文件>         # 换规格文档（反证臂 / 副本实验用）
//   node bin/gen-design-values.mjs --out=<文件>          # 换落点（默认 web/generated/design-values.css）
//
// 出口：0 = 与规格一致；1 = 规格里读不到那条条目 / 值不是长度 / 同一个变量的两条条目互相矛盾 /
//       （`--check` 时）盘上那份与当前规格不一致。**不写半份文件**（先算完再落盘），且落盘是**原子**的
//       （同目录 temp ⇒ rename）：这份生成物有活的读者，裸 `writeFile`（先截断再写）会让读者读到 0 字节 ——
//       2026-09-27 实测，判据与读数见 test/gen-values-freshness.mjs 的 `landing:no-partial-read`。
//
// 谁写 / 谁读（2026-09-27 钉的）：写者只有本脚本（人手动跑一次 `npm run gen:designvalues`）；读者有四类 ——
//   · 静态服务：`server/app.mjs` 的 `serveStatic` 每个请求 `await readFile(filePath)`、`cache-control: no-store`
//     （页面 `web/index.html` 的 `<link href="/generated/design-values.css">`；编辑页预览 iframe 加载的真页面）；
//   · 编辑页：`web/design.js` 的 `readGenerated()`（`GENERATED_URL`，`cache: 'no-store'`）拉了与规格逐条比；
//   · 门：`test/design-spec.mjs`（`gen:ondisk`）与 `test/gen-values-freshness.mjs` 自己 `readFile` 它；
//   · `gen:designvalues:check`（本脚本 `--check`）也 `readFile` 盘上那份来比。
//   写与读会不会在时间上重叠：**会** —— 写者是人手动跑的一次性命令，而页面 / iframe / 门可能正开着读它。

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** 哪几个条目可生成（工单 ①：判据 ＝ 「能被 CSS 自定义属性表达、且改动不牵动布局语义」）。
    一个变量可以被**多条**条目要求（最左槽宽同时是 G-09 与 G-23 的同一条声明）——
    那时两条的「声明值」必须逐字相同，否则本脚本报错退出（不猜谁对）。 */
const ITEMS = [
  { entry: 'G-06', name: '--design-settings-panel-width' },
  { entry: 'G-12', name: '--design-settings-panel-gap' },
  { entry: 'G-09', name: '--design-slot-width' },
  { entry: 'G-23', name: '--design-slot-width' },
  { entry: 'G-22', name: '--design-tree-session-height' },
  { entry: 'G-27', name: '--design-header-min-height' },
];

// ── 规格文档：只认「表头是列名、行以 | 开头」这一种表（与 test/design-spec.mjs 的契约面同一形状）──
function rowsOf(text, heading) {
  const at = text.indexOf(heading);
  if (at < 0) throw new Error(`规格文档里找不到小节「${heading}」`);
  const lines = text.slice(at).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^\s*\|/.test(lines[i])) i += 1;
  const raw = [];
  for (; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) raw.push(lines[i]);
  if (raw.length < 2) throw new Error(`小节「${heading}」下面没找到表`);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/^`([\s\S]*)`$/, '$1'));
  const header = cells(raw[0]);
  return raw.slice(2).map((line) => {
    const values = cells(line);
    const row = {};
    header.forEach((name, index) => { row[name] = values[index] ?? ''; });
    return row;
  });
}

/** 生成值只收「一条完整的长度声明」：一个数 + 单位。别的一律报错（不猜、不当它是 px）。 */
const LENGTH = /^-?\d*\.?\d+(px|rem|em|%)$/;

function declaredValues(specText) {
  const byId = new Map();
  for (const row of rowsOf(specText, '## 几何表')) {
    const id = (row['id'] ?? '').trim();
    if (id) byId.set(id, { declared: (row['声明值'] ?? '').trim(), element: (row['元素'] ?? '').trim(), property: (row['属性'] ?? '').trim() });
  }
  return byId;
}

/** 规格文档 ⇒ 这一层的 `:root` 声明（名字 → 值 + 值由哪几条条目要求）。 */
function valuesFromSpec(specText) {
  const byId = declaredValues(specText);
  const order = [];
  const vars = new Map();
  for (const item of ITEMS) {
    const row = byId.get(item.entry);
    if (!row) throw new Error(`规格文档几何表里没有条目 ${item.entry}（这条映射该更新了）`);
    if (!LENGTH.test(row.declared)) {
      throw new Error(`条目 ${item.entry} 的「声明值」不是一条完整长度（读到 ${JSON.stringify(row.declared)}）—— 这一层只搬长度，不换算`);
    }
    if (!vars.has(item.name)) {
      vars.set(item.name, { value: row.declared, entries: [] });
      order.push(item.name);
    }
    const found = vars.get(item.name);
    if (found.value !== row.declared) {
      throw new Error(`同一个变量 ${item.name} 被两条条目要求成不同的数：${found.entries.join('、')} 要 ${found.value}，${item.entry} 要 ${row.declared}（不猜谁对）`);
    }
    found.entries.push(item.entry);
  }
  return order.map((name) => ({ name, ...vars.get(name) }));
}

const BANNER = (specRelative, extraNote) => `\
/* web/generated/design-values.css —— **生成物，不要手改**。
 *
 * 来源（唯一真源）：${specRelative} 的「几何表」——每个 \`--design-*\` 的值就是那一行的「声明值」，**逐字**搬过来。
${extraNote} * 生成器：bin/gen-design-values.mjs（一键重跑 \`npm run gen:designvalues\`；重跑两次字节相同、结果确定）。
 *
 * 谁在用它：web/index.html 的 .settings-panel / .tree-session / header，web/slot.css 的最左槽原语。
 * 那几处声明写成 \`var(--design-…, <原来的字面量>)\`：生成物在场时取的是这里的值；
 * \`<原来的字面量>\` 只是生成物拿不到时的降级（与铺这一层之前逐字相同，见 web/app.js 的
 * 「拿不到就降级、页面继续」那条口径）。
 *
 * 手改这一份没有意义：\`npm run test:designspec\` 会重跑生成器并与盘上这份**逐字节**比。
 */
`;

function renderGenerated(specText, specRelative, extraNote = '') {
  const values = valuesFromSpec(specText);
  const lines = values.map((item) => `  /* ${item.entries.join(' · ')} */ ${item.name}: ${item.value};`);
  return `${BANNER(specRelative, extraNote)}:root {\n${lines.join('\n')}\n}\n`;
}

/** 落盘：**先写同目录临时文件、再 `rename` 换上去**（原子写）。
 *
 * 为什么不能用裸 `writeFile`（2026-09-27 实测）：这份生成物有**活的读者** —— 静态服务每个请求
 * `readFile` 一次、`cache-control: no-store`（`server/app.mjs` 的 `serveStatic`；页面 `web/index.html`
 * 的 `<link>` 走的就是它）、编辑页 `web/design.js` 的 `readGenerated()`、以及两道门（`test:designspec`
 * / `test:genvalues`）直接读它。而生产里改写它的那一刻是**人在终端跑 `npm run gen:designvalues`** ——
 * 读者完全可能正开着。裸 `writeFile` 是「先截断、再写」：本仓实测 32 路并发读者 × 8 轮，**10/10 次跑**都量到过
 * **0 字节**（5–22 次/跑；其中一次还是走**真静态服务**的 GET 读到的）⇒ 页面拿到空样式表（那几个 `var(--design-…, 字面量)` 全走降级支）、
 * 编辑页把「生成物没跟上」误报成 stale。判据与读数：`test/gen-values-freshness.mjs` 的
 * `landing:no-partial-read`（反证臂 `tornwrite` 用「分两块写 ＋ 中间停 400 ms」把中间态变成必定发生）。
 *
 * temp 与目标**同目录**（跨设备 rename 会 EXDEV）；临时名带 pid 与时间戳 —— 同时跑两份不会互相覆盖。
 * `rename` 在同一个文件系统上是原子的：读者要么看到**完整的旧那份**、要么看到**完整的新那份**。 */
async function atomicWriteFile(file, text) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, file);
}

const specRelative = path.join('spec', 'screens', `${argOf('screen') || 'settings-overlay'}.md`);
const canonicalSpecFile = path.join(root, specRelative);
const specFile = path.resolve(argOf('spec') || canonicalSpecFile);
const outFile = path.resolve(argOf('out') || path.join(root, 'web', 'generated', 'design-values.css'));

const specText = await readFile(specFile, 'utf8').catch((error) => {
  process.stderr.write(`读不到规格文档 ${specFile}：${error.message}\n`);
  process.exit(1);
});

let rendered;
try {
  // `--spec=` 指到别的文件时（反证臂 / 副本实验）把这件事写进生成物 —— 不假装这份是规范路径那份生成的。
  const extraNote = specFile === canonicalSpecFile ? ''
    : ` * ⚠️ 这一份是按 --spec=${specFile.split(path.sep).join('/')} 生成的（不是上面那份规范路径）。\n`;
  rendered = renderGenerated(specText, specRelative.split(path.sep).join('/'), extraNote);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

if (hasFlag('stdout')) {
  process.stdout.write(rendered);
} else if (hasFlag('check')) {
  const current = await readFile(outFile, 'utf8').catch(() => null);
  if (current === null) {
    process.stderr.write(`${outFile} 不存在 —— 跑一次 \`npm run gen:designvalues\`\n`);
    process.exit(1);
  }
  if (current !== rendered) {
    process.stderr.write(`${outFile} 与当前规格（${specRelative}）生成的**不一致** —— 跑一次 \`npm run gen:designvalues\`\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ ${path.relative(root, outFile).split(path.sep).join('/')} 与 ${specRelative} 一致（${Buffer.byteLength(rendered)} B）\n`);
} else {
  await mkdir(path.dirname(outFile), { recursive: true });
  await atomicWriteFile(outFile, rendered);
  const values = valuesFromSpec(specText);
  process.stdout.write(`✓ 生成 ${path.relative(root, outFile).split(path.sep).join('/')} ← ${specRelative}`
    + `（${values.length} 个变量：${values.map((item) => `${item.name}=${item.value}`).join('、')}）\n`);
}
