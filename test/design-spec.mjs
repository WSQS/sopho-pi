#!/usr/bin/env node
// test/design-spec.mjs —— 「精确规定页面设计」的闭环门：**规格文档 ⇄ 冻稿 ⇄ 真产品 ⇄ 真 token**。
//
// 它守的是什么（一句话）：**同一份数字只许有一个源**。规格文档（spec/screens/<屏>.md）的几何表声明了一个数，
// 冻稿（spec/screens/<屏>.html）里必须**量得到**同一个数，而真文件（web/index.html、web/slot.css）里的
// 声明必须**逐字**是那条 —— 三处任何一个漂了，本门就红。业主 2026-09-24 的口径：「能够精确定义页面设计
// 是更加重要的」；本门就是「精确」这两个字的机械落地。
//
// 九组断言＋一组场景（全部真 Chromium；`CHROME_BIN=<chromium>`；视口 1200×760）：
// （编号里 ⑧ 就是「场景」那一组，所以「几组断言」比末位编号少一 —— 同 `docs/history/design-spec.md` §4 的口径）
//   ① 几何表：文档声明的数 == 冻稿实测的数（整数项零容差；带小数的项按文档给的容差，理由写在文档里）。
//   ② 几何表的**真源**：文档声明的数 == 从真文件那条声明里读出来的数（`rem`×16；`min()/max()` 取第一个数；
//      无单位 `line-height` × 同一条规则里的 `font-size`）。文档里写 26px、真代码其实 24px ⇒ 红。
//   ③ token 表：21 个 token 在「真文件 :root == 文档 == 冻稿声明 == 冻稿计算值」四处逐值相等。
//   ④ 真源对照表：每条「选择器{属性}」的声明，在真文件与冻稿里都**逐字**相同（空白压成单空格、去尾 `;`）。
//   ⑤ 状态断言表：默认 / 悬停（真鼠标）/ 焦点（focus）/ 错误（改属性）/ 禁用 —— 每一态当场摆出来再量。
//   ⑥ 不变量：整页无 `box-shadow`、无渐变；入场动效 ≤150ms，`prefers-reduced-motion: reduce` 下为 0s。
//   ⑦ **冻稿 ≡ 真产品页**：同一个尺子（同一组探针）量两个页面 —— 真页面（`web/` + 假 API）点开设置浮层，
//      与冻稿逐项相等。这一组是防「冻稿自己漂了、文档跟着漂」的那条腿（①③④ 只能证明「抄本与真文件一致」，
//      不能证明「抄本真的长得像那一屏」）。
//   ⑧ **场景（scene）**：同一屏有「设置窗开着 / 关着」两种场景 ⇒ 冻稿用 `?scene=<id>` 渲染指定场景。
//      逐个场景重新打开冻稿，量「场景表」里那两列：**渲染的元素**逐条量得到盒子、**不渲染的元素**逐条量不到；
//      并量那一场景要断言的「关键几何」（条目 id）—— 两个场景的 DOM 与几何必须不同且各自正确。
//   ⑨ **取值层（生成物）**：几何表里有几条的数**不再手写在产品里**，而是由规格文档生成
//      （`bin/gen-design-values.mjs` ⇒ `web/generated/design-values.css` 的 `--design-*`），
//      产品那几处声明写成 `var(--design-…, <原来的字面量>)`。这一组逐条钉：① 生成物是**确定**的
//      （重跑两次字节相同、盘上那份 == 刚生成的 —— 手改了生成物这里就红）；② 每个变量在生成物里的值
//      == 文档声明的数；③ 产品那条声明**必须经 `var(--design-…)` 取值**（改回硬编码就红）；
//      ④ 那条声明里 `var()` 的**降级支**与文档声明的数一致（生成物拿不到时不会降到另一个数）。
//      ② 也因此**顺着 `var()` 读下去**：它比的是产品**实际用的那个数**（拿不到生成物才用降级支那个字面量）。
//   ⑩ **规格里不许出现 `@layer`**（fail-closed，接住 `parseRules()` 的**跳层盲区**）：
//      `parseRules()` 整块跳过 `@layer` ⇒ 层里的规格规则对它不存在，而 ④ 在**冻稿**那一侧把「没找到」
//      当作合格 ⇒ 搬进层里的规则**静默判绿**（2026-09-27 副本实测：改错值仍 237 绿；不加层则当场红）。
//      本仓规格不用层（理由与代价写在 ⑩ 那段注释里）。
//
// 反证臂（各自必红；改的都是**副本**，原件一个字节不动 —— 冻稿副本写在 `spec/screens/.mutant-*.html`（跑完即删），
// 真实现副本是 `web/` 的临时拷贝（跑完即删））：
//   npm run test:designspec:reverse-border    —— 改**冻稿副本**：`.settings-panel` 的 `border: 1px` → `4px` ⇒ ①(`G-08`) 必红
//   npm run test:designspec:reverse-token     —— 改**冻稿副本**的 `--accent` ⇒ ③(token 以真源为基准) 必红
//   npm run test:designspec:reverse-product   —— 改**真实现副本**（`web/index.html` 的拷贝）：面板宽 `min(560px, 100%)` →
//        `min(561px, 100%)` ⇒ ②(`real:G-06`) ＋ ⑦(`product:G-06`) 必红，而 ①(`G-06`，只量冻稿) 必须**仍然绿** ——
//        这一条证明「规格真的约束到**产品**」，而不只是约束那张抄本。
//   npm run test:designspec:reverse-realtoken —— 改**真实现副本**的 `:root` `--accent` ⇒ ③ 与 ⑦ 的用色探针必红 ——
//        这一条证明 token 基准来自**真源**（`web/`），不是来自冻稿那份抄本。
//   npm run test:designspec:reverse-novalue  —— 让**在场的规格**是 `563px`（副本），而生成物是按**另一份**
//        规格（`560px`，今天那份）生成的 ⇒ ⑨(`gen-value:G-06`) 与 ②(`real:G-06`) 必红 ——
//        盘上那个状态就是「**生成器不读在场规格、写死旧值**」留下的样子（生成物 560 ≠ 规格 563）。
//   npm run test:designspec:reverse-hardcoded —— 把**真实现副本**里 `.settings-panel` 的宽改回硬编码
//        `min(560px, 100%)`（不经 `var()`）⇒ ⑨(`gen-used:G-06`) 与 ④(`src:.settings-panel{width}`) 必红，
//        而**渲染一模一样**（560px）⇒ 这一条证明的是「产品确实从生成物取值」，不是「值恰好对」。
//   npm run test:designspec:reverse-sealrow —— 把**在场的规格副本**里 G-36（「压缩即封存」那张卡片的状态行最小高）
//        的声明值 `16px` 改错成 `17px`（**规格副本**；真仓 spec/ 一个字节不动）⇒ ①(`G-36`) 与 ②(`real:G-36`) 必红，
//        而只读 G-20 的那三条（① ② ④）必须**仍然绿** —— 这一条把 89127d5 那次**一次性**的副本实验
//        （规格副本 G-36 `16px → 17px`）变成常驻臂：证明新登记的 G-36 不是空条目，它真的钉住那一行。
//   npm run test:designspec:reverse-layer   —— 把**冻稿副本**里 `.settings-panel-card` 那条规则整条包进
//        `@layer spec-blind { … }` ⇒ ⑩(`layer:forbidden`) 必红并点名 —— 没有这条牙时会发生什么（改错值仍然全绿）
//        写在 ⑩ 那段注释里。
// 八条臂都断言「**预期的那一条**确实红了」，而不是「红没红都算对」。
//
// 真源从哪读：默认 `web/index.html`（内联 `<style>` 的 `:root` 与那批规则）＋ `web/slot.css`；
// **取值层**（生成物）从 `web/generated/design-values.css` 读（⑨ 那组，以及 ② 顺着 `var()` 读下去时用它）。
// 反证臂用 `SOPHO_DESIGNSPEC_WEBROOT=<目录>` 把「真源」连同「真页面那一臂要起的站」一起指到 `web/` 的**副本**上。
// （本仓**没有** `web/app.css` —— 基础调色板住在 `web/index.html` 的内联 `<style>` 里，见 `docs/design-spec.md` §2。）
//
// 报红要能**指路**（是文档的数错、还是产品的数错）：结算处会把每条红的几何项按
// 「文档声明 / 真文件声明 / 冻稿实测 / 真页面实测」四列并列打出来，再给一句判定（`reportDiagnosis()`）。
//
// 用法：CHROME_BIN='C:/Users/user/AppData/Local/Chromium/Application/chrome.exe' node test/design-spec.mjs
//      [--reverse-arm=border|token|product|realtoken|novalue|hardcoded|sealrow|layer] [--observe] [--web-root=<目录>]
//
// 沙箱纪律（`test/harness.mjs` / `test/ui-harness.mjs`）：高位随机端口、临时 profile、私有 TMPDIR/home/XDG；
// 不碰真 profile、不用 7331/7321、绝不 pkill（收尾只按本次 spawn 的精确 pid）。截图落在
// `$TEMP/sopho-design-spec/`（不入仓；本仓 git 里没有任何 PNG 的先例）。

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { boot, sendJson } from './ui-harness.mjs';
import { createUiSettingsStore, UI_SETTINGS_FILE_NAME } from '../server/ui-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN = process.env.SOPHO_DESIGNSPEC_SCREEN || 'settings-overlay';
const CANONICAL_SPEC_FILE = path.join(root, 'spec', 'screens', `${SCREEN}.md`);
// 规格文档也能换（`SOPHO_DESIGNSPEC_SPEC`；反证臂 `novalue` 就是这么把「在场的规格」换成 563px 的副本的）
let SPEC_FILE = process.env.SOPHO_DESIGNSPEC_SPEC
  ? path.resolve(process.env.SOPHO_DESIGNSPEC_SPEC)
  : CANONICAL_SPEC_FILE;
let DRAFT_FILE = process.env.SOPHO_DESIGNSPEC_DRAFT
  ? path.resolve(process.env.SOPHO_DESIGNSPEC_DRAFT)
  : path.join(root, 'spec', 'screens', `${SCREEN}.html`);
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const OBSERVE = process.argv.includes('--observe');
// 「真源」＝真实现（`web/`）住在哪。默认就是本仓的 `web/`；反证臂会把它指到一份**临时拷贝**上
// （`--web-root=` 与 `SOPHO_DESIGNSPEC_WEBROOT=` 等价，给「本仓没有 web/ 也要能量」的场合留个口）。
const REAL_WEB_ROOT = path.resolve(process.argv.find((arg) => arg.startsWith('--web-root='))?.split('=')[1]
  || process.env.SOPHO_DESIGNSPEC_WEBROOT
  || path.join(root, 'web'));
const VIEWPORT = { width: 1200, height: 760 };
const ARTIFACT_DIR = path.join(process.env.TEMP || process.env.TMPDIR || os.tmpdir(), 'sopho-design-spec');

// ── 取值层（生成物）：哪条条目由哪个 `--design-*` 承载 ＋ 生成器住在哪 ──────────────────────────
//
// 这张**镜像表**必须与 `bin/gen-design-values.mjs` 的 ITEMS 表一致：改名 / 少一条 / 多一条，
// ⑨ 那组（`gen:set` / `gen-used` / `gen-value`）当场红 —— 两处不是「两份抄本」，一处错另一处就叫。
const GENERATED_ITEMS = [
  { entry: 'G-06', name: '--design-settings-panel-width' },
  { entry: 'G-12', name: '--design-settings-panel-gap' },
  { entry: 'G-09', name: '--design-slot-width' },
  { entry: 'G-23', name: '--design-slot-width' },
  { entry: 'G-22', name: '--design-tree-session-height' },
  { entry: 'G-27', name: '--design-header-min-height' },
];
const GENERATOR_FILE = path.join(root, 'bin', 'gen-design-values.mjs');

/** 声明文本 ⇒ 长度数值（`rem`×16；否则取第一个数）—— 与 `declarationNumber` 同一条口径，供 ⑨ 比降级支用。 */
const lengthNumber = (text) => {
  const converted = String(text).replace(/(-?\d*\.?\d+)rem/g, (_, n) => `${Number(n) * 16}px`);
  const m = /-?\d*\.?\d+/.exec(converted);
  return m ? Number(m[0]) : null;
};

// ── 断言簿（一次把所有红条目列全，最后统一判；与 test/settings-panel.mjs 同形）────────────────────
let checks = 0;
const failures = [];
const problems = [];
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
function check(id, name, ok, detail) {
  if (ok) {
    checks += 1;
    process.stdout.write(`✓ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
    return true;
  }
  failures.push({ id, name });
  process.stdout.write(`✗ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  return false;
}

// ── 极小的 CSS 规则解析器（够用即可；@media 递归，@keyframes 跳过）────────────────────────────────
function parseRules(css, context = []) {
  // 先剥注释：CSS 注释里出现 `{`/`}`/`;`/`:` 会把「按深度配对」与「按 `;` 切声明」两处都带偏
  // （实测：`web/index.html` 里 `.settings-overlay` 前面那段注释会被当成它的选择器表的一部分 ⇒ 查不到）。
  css = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules = [];
  const flushRule = (body, prelude) => {
    const decls = {};
    for (const chunk of body.split(';')) {
      const cut = chunk.indexOf(':');
      if (cut < 0) continue;
      const prop = chunk.slice(0, cut).trim().toLowerCase();
      const value = chunk.slice(cut + 1).trim();
      if (prop) decls[prop] = value;
    }
    const selectors = prelude.split(',').map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    rules.push({ selectors, decls, context });
  };
  let i = 0;
  let buffer = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch !== '{') {
      buffer += ch;
      i += 1;
      continue;
    }
    const prelude = buffer;
    buffer = '';
    // 找配对 '}'：体里可能还有嵌套（@media 里还有规则，@keyframes 里还有帧）
    let j = i + 1;
    let nested = 0;
    let body = '';
    for (; j < css.length; j += 1) {
      if (css[j] === '{') nested += 1;
      else if (css[j] === '}') {
        if (nested === 0) break;
        nested -= 1;
      }
      body += css[j];
    }
    const trimmed = prelude.trim();
    if (trimmed.startsWith('@')) {
      if (/^@media|^@supports/.test(trimmed)) rules.push(...parseRules(body, [...context, trimmed]));
      // @keyframes：内部是 0%/100% 的帧，不是选择器 —— 跳过（本门不量动画帧）
    } else if (trimmed) {
      flushRule(body, trimmed);
    }
    i = j + 1;
  }
  return rules;
}

function styleBlocks(html) {
  // 先剥 HTML 注释：注释文本里可能**写着** `<style>`（本冻稿的 :root 上面那段就写了）——
  // 不剥的话正则会从那句 `<style>` 开始捕获，把注释残句当成第一条规则的选择器（实测踩到过）。
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const out = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(cleaned))) out.push(m[1]);
  return out.join('\n');
}

/** 在规则表里找「选择器表逐字等于 selectorList」的规则；带 prop 时优先挑**真有这个属性**的那一条
    （同一个选择器在真文件里会分几条规则写：`.tree-session { height: 26px }` 与 `.tree-session { --slot: … }`
     是两条；不按属性挑的话永远只能摸到前面那一条）。 */
function findRule(rules, selectorList, prop = null) {
  const want = selectorList.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
  const single = selectorList.includes(',') ? null : want;
  const candidates = [];
  for (const rule of rules) {
    if (rule.selectors.join(', ') === want) candidates.push({ rule, rank: 0 });
    else if (single && rule.selectors.includes(single)) candidates.push({ rule, rank: 1 });
  }
  if (candidates.length === 0) return null;
  if (prop) {
    const withProp = candidates.find((candidate) => candidate.rule.decls[prop] !== undefined);
    if (withProp) return withProp.rule;
  }
  return candidates.sort((a, b) => a.rank - b.rank)[0].rule;
}

/** 「取值层」（生成物）：`--design-*` 名字 ⇒ 生成物里的值。由规格文档生成
    （`bin/gen-design-values.mjs` ⇒ `web/generated/design-values.css`）；在下面读完真文件后填上。
    为什么 ② 要顺着 `var()` 读下去：产品那几处声明写成 `var(--design-…, <原来的字面量>)`，
    **实际生效的是生成物里的那个数**（拿不到生成物才降到那个字面量）—— 只读字面量会把
    「产品实际用的数」看错。生成物里没这个名字 ⇒ 就用字面量（与浏览器的降级支同一条口径）。 */
let generatedText = null;
const generatedTokens = new Map();
function resolveGeneratedVar(raw) {
  const found = /var\(\s*(--design-[\w-]+)/.exec(raw);
  if (!found) return null;
  const name = found[1];
  return { name, value: generatedTokens.has(name) ? generatedTokens.get(name) : null };
}

/** 从『文件#选择器.属性』里取出声明的数值（`rem`×16；`min()/max()` 取第一个数；无单位 line-height × font-size；
    `var(--design-…)` 先按生成物替换成那个值）。 */
function declarationNumber(realRules, source) {
  const cut = source.indexOf('#');
  const file = source.slice(0, cut);
  const rest = source.slice(cut + 1);
  const dot = rest.lastIndexOf('.');
  const selectorList = rest.slice(0, dot);
  const prop = rest.slice(dot + 1);
  const rules = realRules[file];
  if (!rules) throw new Error(`真源文件没读过：${file}`);
  const rule = findRule(rules, selectorList, prop);
  if (!rule) throw new Error(`真文件 ${file} 里没有选择器「${selectorList}」`);
  const raw = rule.decls[prop];
  if (raw === undefined) throw new Error(`真文件 ${file} 的「${selectorList}」没有属性 ${prop}（它有：${Object.keys(rule.decls).join(', ')}）`);
  let value = raw.replace(/!important/gi, '').trim();
  const via = resolveGeneratedVar(value);
  if (via && via.value !== null && via.value !== '') {
    value = value.replace(new RegExp(`var\\(\\s*${via.name}\\b[^)]*\\)`), via.value);
  }
  if (prop === 'line-height' && !/[a-z%]/i.test(value)) {
    const fontSize = rule.decls['font-size'];
    if (!fontSize) throw new Error(`${selectorList} 的 line-height 无单位，但同一条规则里没有 font-size`);
    value = `${Number(value) * Number(fontSize.replace('px', ''))}px`;
  }
  const converted = value.replace(/(-?\d*\.?\d+)rem/g, (_, n) => `${Number(n) * 16}px`);
  const m = /-?\d*\.?\d+/.exec(converted);
  if (!m) throw new Error(`从「${raw}」里取不出数`);
  return { number: Number(m[0]), raw, prop, selectorList, file, via };
}

// ── Markdown 表解析（表头逐字固定；这是本门与文档之间的契约面）────────────────────────────────────
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
  const rows = raw.slice(2).map((line) => {
    const values = cells(line);
    const row = {};
    header.forEach((name, index) => { row[name] = values[index] ?? ''; });
    return row;
  });
  return { header, rows };
}

// ── 场景表（`## 场景表`）：**原始**格文本（每列里的选择器都带反引号、用中文顿号分隔 ⇒ 不能用 `rowsOf`
//   的 `cells()` —— 它会把首尾的反引号当外层脱掉，把顿号推进反引号里）。───────────────────────────
function sceneRows(text) {
  const at = text.indexOf('## 场景表');
  if (at < 0) throw new Error('规格文档里找不到 ## 场景表');
  const lines = text.slice(at).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^\s*\|/.test(lines[i])) i += 1;
  const raw = [];
  for (; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) raw.push(lines[i]);
  const header = raw[0].split('|').slice(1, -1).map((cell) => cell.trim());
  const quoted = (cell) => [...String(cell).matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
  return raw.slice(2).map((line) => {
    const cells = line.split('|').slice(1, -1);
    const row = {};
    header.forEach((name, index) => { row[name] = cells[index] ?? ''; });
    return {
      id: String(row['场景 id'] ?? '').replace(/`/g, '').trim(),
      name: String(row['中文名'] ?? '').replace(/`/g, '').trim(),
      how: String(row['如何到达'] ?? '').replace(/`/g, '').trim(),
      elements: quoted(row['渲染的元素'] ?? ''),
      hidden: quoted(row['不渲染的元素'] ?? ''),
      assertionIds: quoted(row['该场景要断言的关键几何'] ?? ''),
    };
  });
}

// ── 探针：把文档里那一列小语法翻成 CDP 里能跑的表达式 ────────────────────────────────────────────
function probeExpression(probe) {
  let m;
  if ((m = /^rect\((.+)\)\.(left|top|width|height|right|bottom)$/.exec(probe))) {
    const [, sel, word] = m;
    return `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect(); return b[${JSON.stringify(word)}]; })()`;
  }
  if ((m = /^style\((.+)\)\.(\w+)$/.exec(probe))) {
    const [, sel, prop] = m;
    return `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; return getComputedStyle(n)[${JSON.stringify(prop)}]; })()`;
  }
  if ((m = /^centeredX\((.+)\)$/.exec(probe))) {
    const [, sel] = m;
    return `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect(); return (b.left + b.width / 2) - innerWidth / 2; })()`;
  }
  if ((m = /^centeredY\((.+)\)$/.exec(probe))) {
    const [, sel] = m;
    return `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect(); return (b.top + b.height / 2) - innerHeight / 2; })()`;
  }
  if ((m = /^lineCount\((.+)\)$/.exec(probe))) {
    const [, sel] = m;
    return `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = document.createRange(); r.selectNodeContents(n); return r.getClientRects().length; })()`;
  }
  if ((m = /^textRectHeight\((.+)\)$/.exec(probe))) {
    const [, sel] = m;
    return `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = document.createRange(); r.selectNodeContents(n); const rects = [...r.getClientRects()]; return rects.length ? Math.max(...rects.map((x) => x.height)) : null; })()`;
  }
  if ((m = /^attr\((.+)\)\.([\w-]+)$/.exec(probe))) {
    const [, sel, name] = m;
    return `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const v = n.getAttribute(${JSON.stringify(name)}); return v === null ? '' : v; })()`;
  }
  if ((m = /^count\((.+)\)$/.exec(probe))) {
    const [, sel] = m;
    return `(() => document.querySelectorAll(${JSON.stringify(sel)}).length)()`;
  }
  throw new Error(`看不懂的探针语法：${probe}`);
}

/** 数字（带单位也认）；不是数字就原样回字符串。 */
function asNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const m = /-?\d*\.?\d+/.exec(value);
  return m ? Number(m[0]) : null;
}

// 颜色归一：`#rrggbb` / `rgb(r,g,b)` / `rgba(r,g,b,a)` ⇒ {r,g,b,a}
function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(text);
  if (m) {
    const hex = m[1];
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
  }
  if ((m = /^#([0-9a-f]{3})$/.exec(text))) {
    const [r, g, b] = m[1].split('');
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16), a: 1 };
  }
  if ((m = /^rgba?\(([^)]+)\)$/.exec(text))) {
    const parts = m[1].split(',').map((p) => p.trim());
    return { r: Number(parts[0]), g: Number(parts[1]), b: Number(parts[2]), a: parts[3] === undefined ? 1 : Number(parts[3]) };
  }
  return null;
}
function sameColor(a, b) {
  const x = normalizeColor(a);
  const y = normalizeColor(b);
  if (!x || !y) return false;
  return x.r === y.r && x.g === y.g && x.b === y.b && Math.abs(x.a - y.a) < 0.005;
}
function shortNumber(value) { return Number(Number(value).toFixed(6)); }

function normDeclaration(value) {
  return value.replace(/\s+/g, ' ').trim().replace(/;$/, '');
}

/**
 * 一条几何断言怎么算「相符」（① 与 ⑦ 用同一条尺子 —— 文档声明的值 vs 实测值）：
 *   · 颜色 ⇒ 按 RGBA 比（`#0f1013` 与 `rgb(15,16,19)` 是同一种说法）；
 *   · 两侧都是数 ⇒ 按文档给的容差比（整数项零容差）；
 *   · 其余字面量（`role` / `aria-modal` / 计数以外的字符串）⇒ **逐字**比（压空白、忽略大小写）。
 * 量不到（元素不在 / 属性缺）一律判 false —— 缺属性会拿到 `''`，它与任何声明的字面量都不相等。
 */
function valueMatches(measured, declared, tolerance) {
  if (measured === null || measured === undefined) return false;
  const measuredText = String(measured).trim();
  const declaredText = String(declared).trim();
  const declaredColor = normalizeColor(declaredText);
  const measuredColor = normalizeColor(measuredText);
  if (declaredColor || measuredColor) return Boolean(declaredColor && measuredColor) && sameColor(measuredText, declaredText);
  const declaredNumber = asNumber(declaredText);
  const measuredNumber = asNumber(measuredText);
  if (declaredNumber !== null && measuredNumber !== null) return Math.abs(measuredNumber - declaredNumber) <= tolerance + 1e-9;
  return normDeclaration(declaredText.toLowerCase()) === normDeclaration(measuredText.toLowerCase());
}

// ── 反证臂：在**副本**上改一处（原冻稿 / 原真实现一个字节不动）────────────────────────────────────
//
// `draft` ⇒ 改冻稿的副本；`web` ⇒ 把 `web/` 拷一份到临时目录、在**副本**里改一行，再把「真源」与
// 「真页面那一臂要起的站」一起指到那份副本上（`SOPHO_DESIGNSPEC_WEBROOT` 同一机制，人可以手动用）。
// `expect` = 必须红的 id；`expectGreen` = 必须**仍然绿**的 id；`expectMatch` = 必须至少命中一条的正则。
const ARM_MUTANTS = {
  border: {
    what: '把**冻稿副本**里 `.settings-panel` 的 `border: 1px solid #4a4d56` 改成 `4px`',
    draft: { file: 'spec/screens/settings-overlay.html', from: 'padding: .8rem .85rem .85rem; border: 1px solid #4a4d56; border-radius: 6px;', to: 'padding: .8rem .85rem .85rem; border: 4px solid #4a4d56; border-radius: 6px;' },
    expect: ['G-08'],
    skipProduct: true, // 只改冻稿 ⇒ 量的就是「文档 vs 冻稿」那一条腿（原语义不变）
  },
  token: {
    what: '把**冻稿副本**里 `--accent: #8abeb7` 改成 `--accent: #ff00ff`',
    draft: { file: 'spec/screens/settings-overlay.html', from: '--accent: #8abeb7;', to: '--accent: #ff00ff;' },
    expect: ['token:--accent'],
    skipProduct: true,
  },
  product: {
    what: '把**真实现副本**（`web/` 的拷贝）里 `web/index.html` 的 `.settings-panel` 宽从 `min(var(--design-settings-panel-width, 560px), 100%)` 改成 `min(561px, 100%)`',
    web: { file: 'index.html', from: 'width: min(var(--design-settings-panel-width, 560px), 100%)', to: 'width: min(561px, 100%)' },
    expect: ['real:G-06', 'product:G-06'],
    expectGreen: ['G-06'], // 只量冻稿的那一条必须仍然绿：证明这一臂打的是**产品**，不是那张抄本
  },
  realtoken: {
    what: '把**真实现副本**里 `web/index.html` 的 `:root` `--accent: #8abeb7` 改成 `--accent: #ff00ff`',
    web: { file: 'index.html', from: '--accent: #8abeb7;', to: '--accent: #ff00ff;' },
    expect: ['token:--accent', 'token-computed:--accent'],
    expectMatch: [/^product-state:.*borderTopColor$/], // 真页面用色跟着真源变 ⇒ 与文档不符
  },
  // ⑨ 取值层那两条臂（2026-09-26，`wt/c-da406814`）：一条打**生成物那一边**，一条打**产品那一边**。
  novalue: {
    what: '把**在场的规格**（副本）里 G-06 的声明值改成 `563px`，而生成物按**另一份**规格（`560px`，今天那份）生成 —— '
      + '盘上那个状态就是「**生成器不读在场规格、写死旧值**」留下的样子（生成物 560 ≠ 规格 563）',
    spec: { file: 'spec/screens/settings-overlay.md', from: '| G-06 | 面板 `#settings-panel` | 宽 | 560px |', to: '| G-06 | 面板 `#settings-panel` | 宽 | 563px |' },
    generate: { spec: 'canonical' },
    expect: ['gen-value:G-06', 'real:G-06'],
  },
  hardcoded: {
    what: '把**真实现副本**里 `.settings-panel` 的宽改回硬编码 `min(560px, 100%)`（不经生成物取值）—— '
      + '**渲染一模一样**，所以这一臂证明的是「产品确实从生成物取值」，不是「值恰好对」',
    web: { file: 'index.html', from: 'width: min(var(--design-settings-panel-width, 560px), 100%)', to: 'width: min(560px, 100%)' },
    expect: ['gen-used:G-06', 'src:.settings-panel{width}'],
  },
  // 「压缩即封存」那两条（G-35/G-36）的常驻反证臂（2026-09-25）：89127d5 当时只做了**一次性**的副本实验
  // （规格副本 G-36 `16px → 17px` ⇒ ①`G-36` ＋ ②`real:G-36` 红）；这一臂就是那次实验的常驻化。
  // 它打的是**规格自己**（①「文档 vs 冻稿」＋ ②「文档 vs 真文件声明」两条腿都要红），
  // 并顺手钉住「只打 G-36 那一行」：G-20 与那条共用声明的 ④ 必须仍然绿（G-36 与 G-20 共用
  // `.settings-panel-state { min-height }` —— 这一臂改的是**文档那一格**，不是那条共用声明）。
  sealrow: {
    what: '把**在场的规格副本**里 G-36（封存状态行 `#settings-panel-seal-state` 最小高）的声明值从 `16px` 改成 `17px` '
      + '—— 规格自己与自己不一致 ⇒ ①(`G-36`，文档 17px vs 冻稿 16px) 与 ②(`real:G-36`，文档 17px vs 真文件 1rem) 必红',
    spec: { file: 'spec/screens/settings-overlay.md', from: '| G-36 | 封存状态行 `#settings-panel-seal-state` | 最小高 | 16px |', to: '| G-36 | 封存状态行 `#settings-panel-seal-state` | 最小高 | 17px |' },
    expect: ['G-36', 'real:G-36'],
    expectGreen: ['G-20', 'real:G-20', 'src:.settings-panel-state{min-height}'],
  },
  // ⑩ 的常驻反证臂（2026-09-27，`wt/layer-04c54b90`）：把一条**被闸校验的**规格规则
  // （`.settings-panel-card` —— ④ 真源对照表逐字钉着它的 `border-radius` 与 `padding`）从平铺**搬进 `@layer`**。
  // 没有 ⑩ 这条牙时会怎样：`parseRules()` 整块跳过 `@layer` ⇒ 冻稿那一侧「找不到就当作没写」
  // ⇒ **一条都不红**（把值一起改错也是这样 —— 本笔在副本里实测过，237 绿 / 0 红）。
  // 这条臂现在必须红在 ⑩(`layer:forbidden`) 上，并点名是哪个文件。
  // 规则本身**渲染不变**（没有任何未分层规则与 `.settings-panel-card` 抢同一批属性）
  // ⇒ 剩下的 236 条不受牵连（跑完看「实际红」只有这一条）。
  layer: {
    what: '把**冻稿副本**里 `.settings-panel-card` 那条规则整条包进 `@layer spec-blind { … }`'
      + '—— 规格规则住进层里，`parseRules()` 就再也看不见它 ⇒ ⑩(`layer:forbidden`) 必红并点名',
    draft: {
      file: 'spec/screens/settings-overlay.html',
      from: '.settings-panel-card { display: grid; gap: .38rem; padding: .45rem .5rem .5rem; border: 1px solid var(--line); border-radius: 2px; background: var(--raised); }',
      to: '@layer spec-blind { .settings-panel-card { display: grid; gap: .38rem; padding: .45rem .5rem .5rem; border: 1px solid var(--line); border-radius: 2px; background: var(--raised); } }',
    },
    expect: ['layer:forbidden'],
    skipProduct: true, // 只改冻稿 ⇒ 量的是「规格里出现了层」这一条（原语义不变）
  },
};
let mutantPath = null;
const scratchDirs = [];
let runWebRoot = REAL_WEB_ROOT;
if (ARM) {
  const arm = ARM_MUTANTS[ARM];
  if (!arm) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
  print('反证臂', `${ARM} —— ${arm.what}`);
  if (arm.draft) {
    const canonical = await readFile(DRAFT_FILE, 'utf8');
    // ⚠️ 命中**恰好一处**才改（`String.replace` 配字符串只改第一处）—— 同 `test/designer-ui.mjs`：
    // 接缝出现两次时，臂会改到别处、旧接缝一动没动 ⇒ 臂「跑了」却红不到它该红的那条（假臂）。
    // （`arm.draft.file` 是给 `test:armseams` 的静态声明，指向接缝**在仓里**住的那个文件；这里的守卫
    //  量的是**实际读进来的那份**（默认就是它；`SOPHO_DESIGNSPEC_DRAFT` 可换副本）。）
    const draftHits = canonical.split(arm.draft.from).length - 1;
    if (draftHits !== 1) throw new Error(`反证臂 ${ARM} 的 from 在 ${path.relative(root, DRAFT_FILE)} 里出现 ${draftHits} 次（要求恰好 1 次）：${arm.what} —— 把那段写成唯一的（否则 String.replace 会改到别处，臂就成了假臂）`);
    const mutated = canonical.replace(arm.draft.from, arm.draft.to);
    if (mutated === canonical) throw new Error(`反证臂 ${ARM} 的改写没命中（源码形状变了？）：${arm.what}`);
    mutantPath = path.join(root, 'spec', 'screens', `.mutant-${ARM}.html`);
    await writeFile(mutantPath, mutated, 'utf8');
    DRAFT_FILE = mutantPath;
    print('冻稿副本', `${path.relative(root, mutantPath)}（跑完即删）`);
  }
  if (arm.web) {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'sopho-design-spec-web-'));
    await cp(REAL_WEB_ROOT, scratch, { recursive: true });
    const target = path.join(scratch, arm.web.file);
    const canonical = await readFile(target, 'utf8');
    const mutated = canonical.replace(arm.web.from, arm.web.to);
    if (mutated === canonical) throw new Error(`反证臂 ${ARM} 的改写没命中（真实现的形状变了？）：${arm.what}`);
    await writeFile(target, mutated, 'utf8');
    scratchDirs.push(scratch);
    runWebRoot = scratch;
    print('真实现副本', `${scratch} —— 改的是 ${arm.web.file}，原件 web/ 一个字节没动（跑完即删）`);
  }
  // `arm.spec`：把**在场的规格**换成一份副本（真仓库的 spec 一个字节不动）。
  if (arm.spec) {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'sopho-design-spec-spec-'));
    scratchDirs.push(scratch);
    const canonical = await readFile(CANONICAL_SPEC_FILE, 'utf8');
    // ⚠️ 命中**恰好一处**才改（同 `test/designer-ui.mjs`）：接缝出现两次 ⇒ 臂改到别处 = 假臂。
    const specHits = canonical.split(arm.spec.from).length - 1;
    if (specHits !== 1) throw new Error(`反证臂 ${ARM} 的 from 在 ${path.relative(root, CANONICAL_SPEC_FILE)} 里出现 ${specHits} 次（要求恰好 1 次）：${arm.what} —— 把那段写成唯一的（否则 String.replace 会改到别处，臂就成了假臂）`);
    const mutated = canonical.replace(arm.spec.from, arm.spec.to);
    if (mutated === canonical) throw new Error(`反证臂 ${ARM} 的规格改写没命中（规格文档的形状变了？）：${arm.what}`);
    SPEC_FILE = path.join(scratch, `${SCREEN}.md`);
    await writeFile(SPEC_FILE, mutated, 'utf8');
    print('规格副本', `${SPEC_FILE} —— 改的是几何表那一格（真仓库的 spec 一个字节没动，跑完即删）`);
  }
  // `arm.generate`：把 `web/` 拷一份，并**重跑生成器**填上它的取值层（`--spec=canonical` ＝ 用今天那份规格，
  // 于是生成物与「在场的规格」不同 —— 这正是「生成器不读在场规格」的效果）。
  if (arm.generate) {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'sopho-design-spec-web-'));
    await cp(REAL_WEB_ROOT, scratch, { recursive: true });
    scratchDirs.push(scratch);
    const target = path.join(scratch, 'generated', 'design-values.css');
    await mkdir(path.dirname(target), { recursive: true });
    const generatedFrom = arm.generate.spec === 'canonical' ? CANONICAL_SPEC_FILE : SPEC_FILE;
    execFileSync(process.execPath, [GENERATOR_FILE, `--screen=${SCREEN}`, `--spec=${generatedFrom}`, `--out=${target}`], { encoding: 'utf8' });
    runWebRoot = scratch;
    print('生成物副本', `${target} ← ${path.relative(root, generatedFrom).split(path.sep).join('/')}（生成物的生成来源与在场规格不是同一份，跑完即删）`);
  }
}

// ── 读规格文档 + 真文件（真实现从 `runWebRoot` 读：默认本仓 `web/`，反证臂下是它的副本）────────────
const specText = await readFile(SPEC_FILE, 'utf8');
const draftFile = DRAFT_FILE;
print('真源 web root', runWebRoot);
const indexHtml = await readFile(path.join(runWebRoot, 'index.html'), 'utf8');
const slotCss = await readFile(path.join(runWebRoot, 'slot.css'), 'utf8');
const realRules = {
  'web/index.html': parseRules(styleBlocks(indexHtml)),
  'web/slot.css': parseRules(slotCss),
};

// 「取值层」（生成物）：由规格文档生成（`bin/gen-design-values.mjs`），产品那几处声明从它取值。
// ② 顺着 `var()` 读下去、⑨ 那组逐条钉的就是它 —— 见本文件头部 ⑨ 那一段。
const generatedFile = path.join(runWebRoot, 'generated', 'design-values.css');
generatedText = await readFile(generatedFile, 'utf8').catch(() => null);
print('取值层（生成物）', generatedText === null ? `${generatedFile} —— 读不到（⑨ 那组会红）` : `${generatedFile}（${Buffer.byteLength(generatedText)} B）`);
for (const [prop, value] of Object.entries(findRule(parseRules(generatedText ?? ''), ':root')?.decls ?? {})) {
  if (prop.startsWith('--design-')) generatedTokens.set(prop, value.trim());
}
const draftText = await readFile(draftFile, 'utf8');
const draftRules = parseRules(styleBlocks(draftText));

const geometryTable = rowsOf(specText, '## 几何表');
const tokenTable = rowsOf(specText, '## token 表');
const stateTable = rowsOf(specText, '### 状态断言表');
const sourceTable = rowsOf(specText, '## 真源对照表');

// 真文件里的 token 集（`:root`）
const realTokens = {};
for (const file of ['web/index.html', 'web/slot.css']) {
  const rootRule = findRule(realRules[file], ':root');
  for (const [prop, value] of Object.entries(rootRule?.decls ?? {})) {
    if (prop.startsWith('--')) realTokens[prop] = value.trim();
  }
}
const draftTokens = {};
{
  const rootRule = findRule(draftRules, ':root');
  for (const [prop, value] of Object.entries(rootRule?.decls ?? {})) {
    if (prop.startsWith('--')) draftTokens[prop] = value.trim();
  }
}

// ─────────────── ⑩ 规格里不许出现 `@layer`（fail-closed：接住 `parseRules()` 的**跳层盲区**）───────────────
//
// 为什么必须 fail-closed，而不是「让 `parseRules()` 递归进层」（本题的 (a) 案）：
// `parseRules()`（本文件上面那段）**整块跳过 `@layer`** —— 它只递归 `@media`/`@supports`，别的一律不进。
// 于是层里的规则对它**不存在**；而 ④ 真源对照表在**冻稿**那一侧把「没找到」当作**合格**
// （`draftDecl === undefined || …`）⇒ 把一条规格规则搬进层里、顺手把它的值改错，本门**一条都不红**。
// 2026-09-27 在**副本**里实测过（真树一个字节没动）：
//   · `.settings-panel-card` 那条规则整条包进 `@layer spec-blind { … }` ＋ `border-radius: 2px → 2.0px`
//     （渲染完全相同）⇒ **237 绿 / 0 红**，而 ④ 那两行自己打印的是「冻稿 **(没有这条)**」——
//     它**看见了**自己在冻稿里找不到，却仍然判绿；
//   · 同一处**只改值、不加层** ⇒ `src:.settings-panel-card{border-radius}` 当场红。两次都跑过，不是推的。
// 别的组不会被这样骗过（所以盲区是**窄而实**的）：②／④ 的真文件那一侧／⑨ 读不到规则会抛错判红，
// ③ 少一个 token 也判红，①⑤⑥⑦⑧ 全是真 Chromium 实测（层照样生效）—— 真正**静默**的只有
// 「冻稿那一侧的声明文本」这条腿。
//
// 为什么不选 (a)「递归进层」：层会带来**优先级语义**（同一选择器在层里、层外各一条时谁生效）。
// `findRule()` 是按「选择器逐字相等 ＋ 有那个属性」挑规则的，它**不认层序** ⇒ 一旦规格里出现分层，
// 这道门就得长期维护「层内/层外谁赢」，否则会在该红的地方判绿（或反过来）。而本仓规格**不需要层**：
// 冻稿是「单文件、零外部请求、几何与用色逐字冻结」的静态定格，没有层序要表达；产品那一侧的层序
// （`web/slot.css` 的 `@layer slot-off`，逐元素撤销开关）由 `test/designer-ui.mjs` 的 `slot:off-switch`
// 与它的反证臂 `slot-off-layer-dropped` 钉，与本门无关。⇒ 本仓口径：**规格规则不许住进层里**
// （今天 `spec/**` 一个 `@layer` 都没有 —— 全仓只 `web/slot.css` 那一处，见上）。
//
// 两处都查（一处是「整个 `spec/` 树」，一处是「本门真正解析的那段 CSS」）：
//   · **粗**：`spec/**` 递归、逐字节找 `@layer`（不认扩展名、不剥注释）—— 将来规格里多一个 `.css`、
//     或把层写进注释里假装没有，这里都接得住。**跳过隐藏文件**（`.` 开头）：本门自己的反证臂夹具
//     就是 `spec/screens/.mutant-*.html`（门写、跑完删；中途被杀会留下），把「上一次崩溃的临时件」
//     当成规格内容判红是误报；而隐藏文件本来就不是规格内容，且**本门真正解析的那一份**
//     （下面那条「准」）无论叫什么名字都会被查到 ⇒ 跳过它不打开任何盲区。
//   · **准**：`styleBlocks(draftText)`（＝ `DRAFT_FILE` 里那段 CSS，本门解析器实际吃进去的字节）
//     里找 `@layer` —— 点名到「这个门解析的这一段」，也让反证臂能把层塞进**副本**冻稿来证明这条牙有牙。
// 代价（故意的）：在 `spec/` 的**散文**里写 `@layer` 这三个字也会判红 —— 规格里不该出现这个词。
// 注意**语句形**（`@layer a, b;`，不带块）同样在内：它不改变渲染，但 `parseRules()` 会把**紧跟它后面
// 的那条规则**当成 prelude 的一部分（prelude 以 `@` 开头 ⇒ 整条被丢）—— 实测同样静默判绿。
const LAYER_TOKEN = '@layer';
const layerHits = [];
{
  const walkSpec = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // 隐藏文件：理由见上面「粗」那一段
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walkSpec(target); continue; }
      if (!entry.isFile()) continue;
      const text = await readFile(target, 'utf8');
      text.split(/\r?\n/).forEach((line, index) => {
        if (line.includes(LAYER_TOKEN)) layerHits.push(`${path.relative(root, target).split(path.sep).join('/')}:${index + 1}`);
      });
    }
  };
  await walkSpec(path.join(root, 'spec'));
  const parsedDraftCss = styleBlocks(draftText);
  const parsedHits = parsedDraftCss.split(LAYER_TOKEN).length - 1;
  if (parsedHits > 0) layerHits.push(`${path.relative(root, draftFile).split(path.sep).join('/')}（本门解析的那段 CSS）里 ${parsedHits} 处`);
}
check('layer:forbidden', `规格里不许出现 \`${LAYER_TOKEN}\`（规格规则住进层里 ⇒ \`parseRules()\` 看不见它 ⇒ ④ 冻稿那一侧会**静默**判绿）`,
  layerHits.length === 0,
  layerHits.length
    ? `出现 ${layerHits.length} 处：${layerHits.join('、')}`
    : `spec/ 整棵树 0 处；本门解析的冻稿 CSS（${path.relative(root, draftFile).split(path.sep).join('/')}）也 0 处`);

await mkdir(ARTIFACT_DIR, { recursive: true });

// ───────────────────────────────── 冻稿那一侧 ─────────────────────────────────
let draftPage = null;
const geometryReadings = [];
/** 每条几何项的**真文件声明**读数（id → declarationNumber() 的结果 / null / {error}）。 */
const sourceReadings = new Map();
/** 每条几何项在**真页面**里量到的值（id → 实测值；真页面那一臂没跑则空）。 */
const productReadings = new Map();
/** 冻稿 `:root` 上算出来的 token 值（③ 的第四处）。 */
let computedTokenValues = {};
try {
  draftPage = await boot({ webRoot: root, width: VIEWPORT.width, height: VIEWPORT.height });
  const draftUrl = `http://127.0.0.1:${draftPage.port}/${path.relative(root, draftFile).split(path.sep).join('/')}`;
  const loaded = draftPage.browser.once('Page.loadEventFired');
  await draftPage.browser.send('Page.navigate', { url: draftUrl });
  await loaded;
  print('冻稿 URL', draftUrl);

  // ① 几何表：文档 == 冻稿实测
  for (const row of geometryTable.rows) {
    const id = row['id'];
    const declaredText = row['声明值'];
    const declared = asNumber(declaredText);
    const tolerance = asNumber(row['容差']);
    const measured = await draftPage.evaluate(probeExpression(row['探针']));
    const numeric = asNumber(measured);
    geometryReadings.push({ id, declared, declaredText, measured: numeric, raw: measured, tolerance, element: row['元素'], property: row['属性'], probe: row['探针'], source: row['真源'] });
    const gap = measured === null || measured === undefined ? '量不到（元素不在 / 选择器没命中）'
      : numeric === null ? '非数字项 ⇒ 逐字比' : `差 ${(numeric - declared).toFixed(4)}`;
    check(id, `${row['元素']} · ${row['属性']}（文档 ${declaredText}）`, valueMatches(measured, declaredText, tolerance),
      `冻稿实测 ${measured}（${gap}，容差 ${tolerance}）`);
  }

  // ② 几何表的真源：文档 == 真文件声明里读出来的数（id 加 `real:` 前缀，与 ① 的冻稿条目分得清 ——
  // 「只量冻稿的那一条仍然绿」是反证臂 product 的判据之一）
  for (const row of geometryTable.rows) {
    const id = `real:${row['id']}`;
    if (!row['真源'] || row['真源'] === '—') { sourceReadings.set(row['id'], null); continue; }
    let info = null;
    try { info = declarationNumber(realRules, row['真源']); } catch (error) { sourceReadings.set(row['id'], { error: error.message }); check(id, `真源 ${row['真源']}`, false, error.message); continue; }
    sourceReadings.set(row['id'], info);
    const viaText = info.via ? `；其中 ${info.via.name} 顺着生成物读出 ${info.via.value ?? '(生成物里没有这个名字 ⇒ 用降级支)'}` : '';
    check(id, `真源 ${row['真源']} = ${info.raw}`, valueMatches(info.number, row['声明值'], 0),
      `真文件里读出 ${info.number}（声明原文「${normDeclaration(info.raw)}」${viaText}），文档写 ${row['声明值']}`);
  }

  // ③ token 表：真文件 == 文档 == 冻稿声明 == 冻稿计算值
  for (const row of tokenTable.rows) {
    const token = row['token'];
    const declared = row['值'];
    const real = realTokens[token];
    const seam = [real === undefined ? '真文件没有' : `真 ${real}`, `文档 ${declared}`, `冻稿声明 ${draftTokens[token] ?? '(缺)'}`].join(' / ');
    if (!(token in realTokens)) { check(`token:${token}`, 'token 存在', false, seam); continue; }
    const declaredOk = normDeclaration(declared) === normDeclaration(real);
    const draftOk = draftTokens[token] !== undefined && normDeclaration(draftTokens[token]) === normDeclaration(real);
    check(`token:${token}`, `token 值四处一致`, declaredOk && draftOk, seam);
  }
  const computedTokens = await draftPage.evaluate(`(() => { const s = getComputedStyle(document.documentElement); const out = {}; for (const name of ${JSON.stringify(Object.keys(realTokens))}) out[name] = s.getPropertyValue(name).trim(); return out; })()`);
  computedTokenValues = computedTokens;
  for (const token of Object.keys(realTokens)) {
    check(`token-computed:${token}`, `token 计算值 == 真文件`, normDeclaration(computedTokens[token] ?? '') === normDeclaration(realTokens[token]),
      `计算 ${computedTokens[token]} / 真文件 ${realTokens[token]}`);
  }

  // ④ 真源对照表：声明逐字相等（真文件 ⇄ 文档；冻稿里若有同一条也必须逐字相同）
  for (const row of sourceTable.rows) {
    const [file, selectorList] = row['真源文件'].split(/\s+/);
    const prop = row['属性'];
    const expected = row['声明（逐字）'];
    const rule = findRule(realRules[file], row['选择器'], prop);
    const realDecl = rule?.decls[prop];
    const realOk = realDecl !== undefined && normDeclaration(realDecl) === normDeclaration(expected);
    const draftRule = findRule(draftRules, row['选择器'], prop);
    const draftDecl = draftRule?.decls[prop];
    const draftOk = draftDecl === undefined || normDeclaration(draftDecl) === normDeclaration(expected);
    check(`src:${row['选择器']}{${prop}}`, `声明逐字相等（${file}）`, realOk && draftOk,
      `真文件 ${realDecl ?? '(缺)'} / 文档 ${expected} / 冻稿 ${draftDecl ?? '(没有这条)'}`);
  }

  // ⑨ 取值层（生成物）：几何表里那几条的**数不在产品里**，而是由规格文档生成成 `--design-*`
  //    （`bin/gen-design-values.mjs` ⇒ `web/generated/design-values.css`），产品从它取值。
  //    逐条钉：生成物是**确定**的（重跑两次字节相同；盘上那份 == 刚生成的 —— 手改了生成物 / 改了
  //    规格没重跑，两件事都在这里红）；每个变量的值 == 文档声明的数；产品那条声明**必须经 `var(--design-…)`
  //    取值**（改回硬编码就红）；那条 `var()` 的**降级支**与文档声明的数一致。
  {
    const specRelative = path.join('spec', 'screens', `${SCREEN}.md`).split(path.sep).join('/');
    const head = (generatedText ?? '').split('\n').slice(0, 12).join('\n');
    check('gen:file', '生成物在，且写明来源（规格文档 ＋ 生成器）',
      generatedText !== null && head.includes(specRelative) && head.includes('bin/gen-design-values.mjs'),
      generatedText === null ? `${generatedFile} 读不到` : `头部写了 ${specRelative} / bin/gen-design-values.mjs`);

    // 确定性：同一个规格生成两次 ⇒ 字节相同。跑的是**真生成器**（本仓的 bin/gen-design-values.mjs）。
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'sopho-design-spec-gen-'));
    scratchDirs.push(scratch);
    const runs = [path.join(scratch, 'once.css'), path.join(scratch, 'twice.css')];
    for (const target of runs) execFileSync(process.execPath, [GENERATOR_FILE, `--screen=${SCREEN}`, `--spec=${SPEC_FILE}`, `--out=${target}`], { encoding: 'utf8' });
    const [onceText, twiceText] = await Promise.all(runs.map((target) => readFile(target, 'utf8')));
    check('gen:deterministic', '重跑生成器两次 ⇒ 字节相同（结果确定）', onceText === twiceText,
      `两次都 ${Buffer.byteLength(onceText)} B`);
    check('gen:ondisk', '盘上那一份 == 按当前规格刚生成的（手改了生成物 / 改了规格没重跑 ⇒ 这里就红）',
      generatedText === onceText,
      generatedText === null ? '盘上那份读不到' : `盘上 ${Buffer.byteLength(generatedText)} B / 刚生成 ${Buffer.byteLength(onceText)} B`);
    const expectedNames = [...new Set(GENERATED_ITEMS.map((item) => item.name))].sort();
    check('gen:set', '生成物的 `:root` 里恰好是这几个 `--design-*`（不多不少）',
      JSON.stringify([...generatedTokens.keys()].sort()) === JSON.stringify(expectedNames),
      `生成物 ${JSON.stringify([...generatedTokens.keys()])} / 预期 ${JSON.stringify(expectedNames)}`);

    for (const item of GENERATED_ITEMS) {
      const row = geometryTable.rows.find((candidate) => candidate['id'] === item.entry);
      const declared = row?.['声明值'] ?? '';
      const tolerance = asNumber(row?.['容差']) ?? 0;
      const generated = generatedTokens.get(item.name);
      const generatedNumber = generated === undefined ? null : lengthNumber(generated);
      const declaredNumber = lengthNumber(declared);
      check(`gen-value:${item.entry}`, `${item.name} 的值 == 文档 ${item.entry} 的声明值（${declared}）`,
        generatedNumber !== null && declaredNumber !== null && Math.abs(generatedNumber - declaredNumber) <= tolerance + 1e-9,
        `生成物 ${generated ?? '(没有这个名字)'} / 文档 ${declared}`);
      // 产品那一侧：读**声明原文**（不顺着 var 读），看它是否经 `var(--design-…)` 取值、降级支是不是文档那个数。
      const truth = row?.['真源'] ?? '—';
      const hash = truth.indexOf('#');
      const dot = truth.lastIndexOf('.');
      const rule = hash < 0 ? null : findRule(realRules[truth.slice(0, hash)], truth.slice(hash + 1, dot), truth.slice(dot + 1));
      const text = hash < 0 ? null : rule?.decls[truth.slice(dot + 1)] ?? null;
      const usesVar = text !== null && new RegExp(`var\\(\\s*${item.name}\\b`).test(text);
      check(`gen-used:${item.entry}`, `产品那条声明经 var(${item.name}) 取值（${truth}）`, usesVar,
        `声明原文「${text ?? '(读不到)'}」`);
      const fallback = text === null ? null : new RegExp(`var\\(\\s*${item.name}\\b\\s*,\\s*([^)]*)\\)`).exec(text)?.[1] ?? null;
      const fallbackNumber = fallback === null ? null : lengthNumber(fallback);
      check(`gen-fallback:${item.entry}`, `那条 var() 的降级支与文档声明的数一致（生成物拿不到时不会降到别的数）`,
        fallbackNumber !== null && declaredNumber !== null && Math.abs(fallbackNumber - declaredNumber) <= tolerance + 1e-9,
        `降级支 ${fallback === null ? '(声明里没写降级支)' : fallback.trim()} / 文档 ${declared}`);
    }
  }

  // 截图：默认态（其余三态在下面的状态循环之后单独拍）。反证臂下名字带 `mutant-`：
  // 免得跑了反证臂就把“正常的那张”截图盖成突变体的（这会让人把突变成色当成产品色 —— 真踩到过）。
  await draftPage.screenshot(path.join(ARTIFACT_DIR, `${SCREEN}-${ARM ? `mutant-${ARM}` : 'draft'}-default-${VIEWPORT.width}x${VIEWPORT.height}.png`));
  if (!ARM) {
    // 默认态的放大裁切：让「选中项边框 = --accent（#8abeb7）/ 未选中 = --line（#292b31）」看得见。
    const rect = await draftPage.evaluate(`(() => { const b = document.querySelector('#settings-panel-fold').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    const shot = await draftPage.browser.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8), width: rect.width + 16, height: rect.height + 16, scale: 3 } });
    await writeFile(path.join(ARTIFACT_DIR, `${SCREEN}-draft-default-zoom.png`), Buffer.from(shot.data, 'base64'));
  }

  // ⑤ 状态断言表：按表顺序执行（默认态的行必须排最前）
  const stateReadings = [];
  for (const row of stateTable.rows) {
    const action = row['摆法'];
    const probe = row['探针'];
    const expected = row['期望'];
    const tolerance = asNumber(row['容差']) ?? 0;
    let applied = '（默认）';
    if (action.startsWith('悬停:')) {
      const sel = action.slice('悬停:'.length);
      const point = await draftPage.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      if (!point) { check(`state:${row['状态']}:${probe}`, '悬停目标存在', false, sel); continue; }
      await draftPage.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 });
      await new Promise((r) => setTimeout(r, 120));
      applied = `鼠标移到 (${point.x},${point.y})`;
    } else if (action.startsWith('聚焦:')) {
      const sel = action.slice('聚焦:'.length);
      await draftPage.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (n) n.focus(); return true; })()`);
      applied = 'focus()';
    } else if (action.startsWith('属性:')) {
      const rest = action.slice('属性:'.length);
      const slash = rest.indexOf('/');
      const sel = rest.slice(0, slash);
      const [attr, value] = rest.slice(slash + 1).split('=');
      await draftPage.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (n) n.setAttribute(${JSON.stringify(attr)}, ${JSON.stringify(value)}); return true; })()`);
      applied = `${attr}="${value}"`;
    } else if (action.startsWith('禁用:')) {
      const sel = action.slice('禁用:'.length);
      await draftPage.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (n) n.disabled = true; return true; })()`);
      applied = 'disabled = true';
    } else if (action !== '默认') {
      throw new Error(`看不懂的摆法：${action}`);
    }
    const measured = await draftPage.evaluate(probeExpression(probe));
    // 与 ①⑦ 用同一条尺子（颜色按 RGBA、数字按容差、其余逐字）—— ⑤ 与 ⑦ 不该是两把尺。
    const ok = valueMatches(measured, expected, tolerance);
    stateReadings.push({ state: row['状态'], action: applied, probe, expected, measured, ok });
    check(`state:${row['状态']}:${probe}`, `${row['状态']}态 · ${probe}（摆法：${applied}）`, ok, `实测 ${measured}，期望 ${expected}`);
  }

  // ⑥ 不变量：无阴影、无渐变、动效 ≤150ms、reduced-motion 下不动
  const invariants = await draftPage.evaluate(`(() => {
    const bad = [];
    let maxDuration = 0;
    for (const node of document.querySelectorAll('*')) {
      const s = getComputedStyle(node);
      if (s.boxShadow && s.boxShadow !== 'none') bad.push({ kind: 'box-shadow', node: node.tagName + '.' + node.className, value: s.boxShadow });
      if (/gradient/i.test(s.backgroundImage || '')) bad.push({ kind: 'gradient', node: node.tagName + '.' + node.className, value: s.backgroundImage });
      for (const d of [s.transitionDuration, s.animationDuration].join(',').split(',')) {
        const m = /([\\d.]+)\\s*(m?s)/.exec(d.trim());
        if (m) maxDuration = Math.max(maxDuration, Number(m[1]) * (m[2] === 'ms' ? 0.001 : 1));
      }
    }
    return { bad, maxDuration };
  })()`);
  check('inv:forbidden', '整页无 box-shadow / 无渐变', invariants.bad.length === 0, invariants.bad.length ? JSON.stringify(invariants.bad) : '0 处');
  const overlayAnim = await draftPage.evaluate(`(() => { const n = document.querySelector('#settings-overlay'); n.dataset.state = 'open'; const s = getComputedStyle(n); return { overlay: s.animationDuration, panel: getComputedStyle(n.querySelector('.settings-panel')).animationDuration }; })()`);
  const animSeconds = [overlayAnim.overlay, overlayAnim.panel].map((d) => Number(/([\d.]+)(m?s)/.exec(d)[1]) * (/([\d.]+)ms/.test(d) ? 0.001 : 1));
  check('inv:duration', '入场动效 ≤150ms', animSeconds.every((d) => d <= 0.15), `overlay=${overlayAnim.overlay} panel=${overlayAnim.panel}`);
  await draftPage.browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await draftPage.evaluate(`(() => { const n = document.querySelector('#settings-overlay'); const s = getComputedStyle(n); return { overlay: s.animationDuration, panel: getComputedStyle(n.querySelector('.settings-panel')).animationDuration }; })()`);
  await draftPage.browser.send('Emulation.setEmulatedMedia', { features: [] });
  check('inv:reduced-motion', 'prefers-reduced-motion: reduce ⇒ 完全不动', Number(/([\d.]+)/.exec(reduced.overlay)[1]) === 0 && Number(/([\d.]+)/.exec(reduced.panel)[1]) === 0,
    `overlay=${reduced.overlay} panel=${reduced.panel}`);
  await draftPage.evaluate(`(() => { delete document.querySelector('#settings-overlay').dataset.state; return true; })()`);

  // ⑧ 场景（`## 场景表`）：冻稿用 `?scene=<id>` 渲染指定场景 —— 逐场景量「渲染的元素 / 不渲染的元素」
  //    与「该场景要断言的关键几何」；两个场景的 DOM 与几何必须**不同且各自正确**。
  //    每个场景都**重新导航**一份干净冻稿（不沿用上面被状态循环改过的那一份）。
  const scenes = sceneRows(specText);
  check('scene:table', '规格文档的场景表读到了（每个场景都有 id / 中文名 / 渲染的元素 / 关键几何）',
    scenes.length >= 2 && scenes.every((scene) => scene.id && scene.name && scene.elements.length > 0 && scene.assertionIds.length > 0),
    scenes.map((scene) => `${scene.id}（${scene.elements.length} 元素 / ${scene.assertionIds.length} 条关键几何）`).join('、'));
  const sceneReadings = {};
  for (const scene of scenes) {
    const sceneLoaded = draftPage.browser.once('Page.loadEventFired');
    await draftPage.browser.send('Page.navigate', { url: `${draftUrl}?scene=${encodeURIComponent(scene.id)}` });
    await sceneLoaded;
    const applied = await draftPage.evaluate(`document.documentElement.dataset.scene`);
    const boxes = await draftPage.evaluate(`(() => {
      const box = (sel) => {
        const n = document.querySelector(sel);
        if (!n) return { matched: false, rects: 0, width: 0 };
        return { matched: true, rects: n.getClientRects().length, width: n.getBoundingClientRect().width };
      };
      const present = ${JSON.stringify(scene.elements)};
      const absent = ${JSON.stringify(scene.hidden)};
      return { present: Object.fromEntries(present.map((sel) => [sel, box(sel)])), absent: Object.fromEntries(absent.map((sel) => [sel, box(sel)])) };
    })()`);
    // ⚠️ 冻结的是**一个**静态态：有几个元素组的选择器是**条件态**（错误态、`status-unread` 变体等）——
    //   它们在规格里是一个名字（所以列在场景表里），但冻稿里当前没有匹配的节点。"没匹配"与"匹配了但没盒子"
    //   必须分开看：前者如实列出来（不是嘴上说渲染了），后者才是真的没渲染。
    const missing = scene.elements.filter((sel) => boxes.present[sel].matched && boxes.present[sel].rects === 0);
    const unmatched = scene.elements.filter((sel) => !boxes.present[sel].matched);
    const extra = scene.hidden.filter((sel) => boxes.absent[sel].matched && boxes.absent[sel].rects > 0);
    check(`scene:${scene.id}:applied`, `冻稿带 ?scene=${scene.id} ⇒ 真的渲染这个场景（html[data-scene] 实测）`,
      applied === scene.id, `html[data-scene]=${applied}`);
    check(`scene:${scene.id}:rendered`, `${scene.id}：「渲染的元素」逐条量得到盒子（冻稿里没有那个条件态节点的如实列出）；「不渲染的元素」逐条量不到`,
      missing.length === 0 && extra.length === 0,
      missing.length || extra.length
        ? `该渲染却没盒子：${JSON.stringify(missing)}；该不渲染却渲染了：${JSON.stringify(extra)}`
        : `匹配并渲染 ${scene.elements.length - unmatched.length} 条｜冻结态里没有节点的 ${JSON.stringify(unmatched)}｜`
          + `不渲染的 ${scene.hidden.length} 条都符合（遮罩 rects=${boxes.present['#settings-overlay']?.rects ?? boxes.absent['#settings-overlay']?.rects}）`);
    const geometry = [];
    for (const id of scene.assertionIds) {
      const row = geometryTable.rows.find((item) => item['id'] === id);
      if (!row) { geometry.push({ id, ok: false, why: '几何表里没有这条 id' }); continue; }
      const measured = await draftPage.evaluate(probeExpression(row['探针']));
      geometry.push({ id, probe: row['探针'], declared: row['声明值'], measured, ok: valueMatches(measured, row['声明值'], asNumber(row['容差']) ?? 0) });
    }
    sceneReadings[scene.id] = { boxes, geometry };
    check(`scene:${scene.id}:geometry`, `${scene.id}：该场景里要断言的关键几何逐条 == 文档声明的数`,
      geometry.every((item) => item.ok), JSON.stringify(geometry));
    await draftPage.screenshot(path.join(ARTIFACT_DIR, `${SCREEN}-scene-${scene.id}-${VIEWPORT.width}x${VIEWPORT.height}.png`));
  }
  {
    const openScene = scenes[0];
    const closedScene = scenes.find((scene) => scene.id === 'settings-closed') ?? scenes[scenes.length - 1];
    const openOverlay = sceneReadings[openScene.id].boxes.present['#settings-overlay']
      ?? sceneReadings[openScene.id].boxes.absent['#settings-overlay'] ?? { rects: 0, width: 0 };
    const closedOverlay = sceneReadings[closedScene.id].boxes.absent['#settings-overlay']
      ?? sceneReadings[closedScene.id].boxes.present['#settings-overlay'] ?? { rects: 0, width: 0 };
    const closedPanel = sceneReadings[closedScene.id].boxes.absent['#settings-panel']
      ?? sceneReadings[closedScene.id].boxes.present['#settings-panel'] ?? { rects: 0, width: 0 };
    check('scene:open-vs-closed-differ', '两个场景**实测不同且各自正确**：open 里遮罩渲染；closed 里遮罩与面板都不渲染，而底下（左栏会话行）几何可量',
      openOverlay.rects > 0 && openOverlay.width === VIEWPORT.width && closedOverlay.rects === 0 && closedPanel.rects === 0
        && sceneReadings[closedScene.id].geometry.some((item) => item.id === 'G-22' && item.ok),
      `open 遮罩 ${JSON.stringify(openOverlay)}｜closed 遮罩 ${JSON.stringify(closedOverlay)}｜closed 面板 ${JSON.stringify(closedPanel)}`);
  }
} finally {
  if (draftPage) await draftPage.close(problems);
}

// ───────────────────────────────── 真产品页那一侧（冻稿 ≡ 真页面）─────────────────────────────────
//
// 真页面要的东西：**真实现**（`runWebRoot` 下的 `web/` 本体）＋ 一小撮假 API（树 / 会话）。
// 设置端点走**仓库自己的** store（`server/ui-settings.mjs`）＋ 临时侧车文件（临时 home，与
// `test/settings-panel.mjs` 的臂 A 同一套做法）——本臂量的是**几何与用色**，不是设置语义
// （那由 `npm run test:settingspanel` 钉）。
const PRODUCT_SESSION = '3c3c3c3c-3333-4333-8333-333333333333';
const PRODUCT_NOTIFY_SESSION = '01a09d8a-0379-7464-b71e-1602cde9c742';
const productRows = [
  {
    id: PRODUCT_SESSION, name: '设计冻结门的会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
    unread: false, modifiedAt: '2026-09-24T08:00:00.000Z', notify: { notifies: [], waitingFor: [] },
  },
  // 未读/在跑两条是给「槽色按状态」那两条状态断言用的（真页面里得有这两行，探针才量得到）。
  {
    id: '4d4d4d4d-4444-4444-8444-444444444444', name: '在跑的那条（真页面夹具）', parentId: null, archived: false, status: 'working', statusLabel: '工作中',
    unread: false, modifiedAt: '2026-09-24T07:30:00.000Z', notify: { notifies: [], waitingFor: [] },
  },
  {
    id: '5e5e5e5e-5555-4555-8555-555555555555', name: '有未读的那条（真页面夹具）', parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
    unread: true, modifiedAt: '2026-09-24T07:00:00.000Z', notify: { notifies: [], waitingFor: [] },
  },
];
// 设置：真 store ＋ 临时文件（把默认态种成跟冻稿冻结的那一态一样：展开 / 有维护者会话 / 推荐回复开）。
const settingsHome = await mkdtemp(path.join(os.tmpdir(), 'sopho-design-spec-home-'));
scratchDirs.push(settingsHome);
const settingsFile = path.join(settingsHome, UI_SETTINGS_FILE_NAME);
const settingsStore = createUiSettingsStore({
  file: settingsFile,
  writeJson: async (target, value) => {
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  },
});
await settingsStore.patch({
  'thinking.defaultFold': 'expanded',
  'annotations.notifySession': PRODUCT_NOTIFY_SESSION,
  'suggestions.enabled': true,
});
print('真页面夹具', `侧车 ${settingsFile}（真 store 写的）`);
const productRoutes = async (request, response, url) => {
  const p = url.pathname;
  if (p === '/api/host') return sendJson(response, 200, { ok: true }), true;
  if (p === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] }), true;
  if (p === '/api/settings') return sendJson(response, 200, await settingsStore.read()), true;
  if (p === '/api/tree') return sendJson(response, 200, { sessions: productRows, unread: { count: 0 } }), true;
  if (p === '/api/tree/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
    response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: productRows })}\n\n`);
    return true;
  }
  const m = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|annotations))?$/.exec(p);
  if (m) {
    const action = m[2] ?? null;
    if (action === null) { sendJson(response, 200, { name: productRows[0].name, cwd: root, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }); return true; }
    if (action === 'messages') { sendJson(response, 200, { sessionId: m[1], messages: [], extras: [], compaction: { atIndex: null }, observability: null }); return true; }
    if (action === 'commands') { sendJson(response, 200, { streaming: false, commands: [] }); return true; }
    if (action === 'seen') { sendJson(response, 200, { ok: true }); return true; }
    if (action === 'draft') { sendJson(response, 200, { text: '' }); return true; }
    if (action === 'annotations') { sendJson(response, 200, { exists: true, items: [], total: 0, counts: { open: 0, done: 0 } }); return true; }
    if (action === 'events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
      return true;
    }
  }
  return false;
};

// 真页面那一臂：默认跑；只有「只改冻稿」的那两条旧臂（border / token）跳过它（它们量的是另一条腿）。
const SKIP_PRODUCT = Boolean(ARM && ARM_MUTANTS[ARM]?.skipProduct);
if (!SKIP_PRODUCT) {
  let productPage = null;
  try {
    productPage = await boot({ webRoot: runWebRoot, width: VIEWPORT.width, height: VIEWPORT.height, routes: productRoutes });
    await productPage.evaluate(`fetch('/api/tree').then((r) => r.json())`).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    const point = await productPage.evaluate(`(() => { const n = document.querySelector('#tree-settings'); if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    if (!point) throw new Error('真页面里找不到 #tree-settings');
    await productPage.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 });
    await productPage.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await productPage.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    // 等浮层开 + 设置读到（状态行不再写「正在读取…」）+ 入场动效走完（120ms）
    for (let i = 0; i < 100; i += 1) {
      const ready = await productPage.evaluate(`(() => { const o = document.querySelector('#settings-overlay'); const s = document.querySelector('#settings-panel-fold-state'); return !!o && !o.hidden && !!s && !s.textContent.includes('正在读取'); })()`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 400));
    check('product:open', '真页面里设置浮层已打开且设置已读到', await productPage.evaluate(`(() => { const o = document.querySelector('#settings-overlay'); const s = document.querySelector('#settings-panel-fold-state'); return !!o && !o.hidden && !!s && s.dataset.kind === 'ok'; })()`), '点 #tree-settings（真鼠标）');

    // ⑦ 冻稿 ≡ 真页面：同一组几何探针 + 状态探针
    let productMatches = 0;
    let productChecked = 0;
    for (const row of geometryTable.rows) {
      const expression = probeExpression(row['探针']);
      const productValue = await productPage.evaluate(expression);
      productReadings.set(row['id'], productValue);
      const draftValue2 = geometryReadings.find((g) => g.id === row['id'])?.raw;
      const tolerance = asNumber(row['容差']) ?? 0;
      productChecked += 1;
      // 这一条比的是「冻稿实测 ≡ 真页面实测」（同一条尺子），不是再比一次文档。
      const ok = valueMatches(productValue, draftValue2, tolerance);
      if (ok) productMatches += 1;
      check(`product:${row['id']}`, `冻稿 ≡ 真页面 · ${row['元素']} ${row['属性']}`, ok, `冻稿 ${draftValue2} / 真页面 ${productValue}`);
    }
    print('冻稿 ≡ 真页面', `${productMatches}/${productChecked} 条几何探针逐项相等（另有 ${stateTable.rows.length} 条状态探针）`);
    // 截图要在**状态探针之前**拍：那几条会改页面当场状态（错误态/禁用）——
    // 拍晚了两张截图就不是同一态，人就对不上了。
    await productPage.screenshot(path.join(ARTIFACT_DIR, `${SCREEN}-product-default-${VIEWPORT.width}x${VIEWPORT.height}.png`));
    // 状态探针也在真页面上跑一遍（默认 / 错误 / 禁用 / 焦点 / 悬停）
    for (const row of stateTable.rows) {
      const action = row['摆法'];
      const probe = row['探针'];
      const expected = row['期望'];
      const tolerance = asNumber(row['容差']) ?? 0;
      if (action.startsWith('悬停:')) {
        const sel = action.slice('悬停:'.length);
        const pt = await productPage.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
        if (pt) { await productPage.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', clickCount: 0 }); await new Promise((r) => setTimeout(r, 120)); }
      } else if (action.startsWith('聚焦:')) {
        await productPage.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(action.slice('聚焦:'.length))}); if (n) n.focus(); return true; })()`);
      } else if (action.startsWith('属性:')) {
        const rest = action.slice('属性:'.length);
        const slash = rest.indexOf('/');
        const [attr, value] = rest.slice(slash + 1).split('=');
        await productPage.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(rest.slice(0, slash))}); if (n) n.setAttribute(${JSON.stringify(attr)}, ${JSON.stringify(value)}); return true; })()`);
      } else if (action.startsWith('禁用:')) {
        await productPage.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(action.slice('禁用:'.length))}); if (n) n.disabled = true; return true; })()`);
      }
      const measured = await productPage.evaluate(probeExpression(probe));
      const ok = valueMatches(measured, expected, tolerance);
      check(`product-state:${row['状态']}:${probe}`, `真页面同一态 · ${probe}`, ok, `真页面 ${measured}，文档期望 ${expected}`);
    }
    print('pageProblems(真页面)', productPage.pageProblems.length ? JSON.stringify(productPage.pageProblems) : '0 条');
  } catch (error) {
    check('product:arm', '冻稿 ≡ 真页面那一臂跑完', false, error.message);
  } finally {
    if (productPage) await productPage.close(problems);
  }
}

// ───────────────────────────────── 截图：悬停 / 焦点 / 错误三态 ─────────────────────────────────
if (!ARM) {
  let shotPage = null;
  try {
    shotPage = await boot({ webRoot: root, width: VIEWPORT.width, height: VIEWPORT.height });
    const loaded = shotPage.browser.once('Page.loadEventFired');
    await shotPage.browser.send('Page.navigate', { url: `http://127.0.0.1:${shotPage.port}/${path.relative(root, DRAFT_FILE).split(path.sep).join('/')}` });
    await loaded;
    // 三态那几处的视觉差异本质上很小（选项悬停只把 1px 边框从 #292b31 提到 #4a4d56；
    // 输入框焦点是一条 1px 的 #555862 描边）——在整屏 1200×760 的图里人眼对不出来。
    // 所以除了整屏图，每个态再拍一张**放大裁切**（只框住那一块，×3），让“看得见”与门量到的数对得上。
    const clipShot = async (file, selector, scale = 3, pad = 8) => {
      const rect = await shotPage.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
      if (!rect) throw new Error(`裁切目标不存在：${selector}`);
      const shot = await shotPage.browser.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale },
      });
      await writeFile(file, Buffer.from(shot.data, 'base64'));
    };
    const hover = await shotPage.evaluate(`(() => { const n = document.querySelector('#settings-panel-fold .settings-panel-option:nth-of-type(2)'); const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    await shotPage.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover.x, y: hover.y, button: 'none', clickCount: 0 });
    await new Promise((r) => setTimeout(r, 120));
    await shotPage.screenshot(path.join(ARTIFACT_DIR, `${SCREEN}-draft-hover-${VIEWPORT.width}x${VIEWPORT.height}.png`));
    await clipShot(path.join(ARTIFACT_DIR, `${SCREEN}-draft-hover-zoom.png`), '#settings-panel-fold');
    await shotPage.evaluate(`(() => { const n = document.querySelector('#settings-panel-notify-input'); n.focus(); return true; })()`);
    await shotPage.screenshot(path.join(ARTIFACT_DIR, `${SCREEN}-draft-focus-${VIEWPORT.width}x${VIEWPORT.height}.png`));
    await clipShot(path.join(ARTIFACT_DIR, `${SCREEN}-draft-focus-zoom.png`), '#settings-panel-notify-input');
    await shotPage.evaluate(`(() => { document.querySelector('#settings-panel-fold-state').setAttribute('data-kind', 'error'); document.querySelector('#settings-panel-fold-state').textContent = '读不到设置：门里摆的错误态（服务端 404）'; document.querySelector('#settings-panel-notify-save').disabled = true; return true; })()`);
    await shotPage.screenshot(path.join(ARTIFACT_DIR, `${SCREEN}-draft-error-${VIEWPORT.width}x${VIEWPORT.height}.png`));
    await clipShot(path.join(ARTIFACT_DIR, `${SCREEN}-draft-error-zoom.png`), '#settings-panel-fold-state');
    print('截图目录', ARTIFACT_DIR);
  } catch (error) {
    check('shots', '三态截图拍完', false, error.message);
  } finally {
    if (shotPage) await shotPage.close(problems);
  }
}

// ───────────────────────── 指路：红的是**文档的数错**还是**产品的数错** ─────────────────────────
//
// 只说「对不上」不够用：读的人要知道**改哪一边**。这里把每条红的几何项按
// 「文档声明 / 真文件声明 / 冻稿实测 / 真页面实测」四列并列打出来，再给一句判定。
function attributionFor(reading) {
  const declaredText = reading.declaredText;
  const tolerance = reading.tolerance ?? 0;
  const draftOk = valueMatches(reading.raw, declaredText, tolerance);
  const source = sourceReadings.get(reading.id) ?? null;
  const hasSource = Boolean(reading.source && reading.source !== '—' && !source?.error);
  const sourceOk = hasSource ? valueMatches(source.number, declaredText, tolerance) : null;
  const product = productReadings.get(reading.id);
  const hasProduct = product !== undefined;
  const productOk = hasProduct ? valueMatches(product, declaredText, tolerance) : null;
  const differs = [];
  if (sourceOk === false) differs.push('真文件声明');
  if (!draftOk) differs.push('冻稿实测');
  if (productOk === false) differs.push('真页面实测');
  let verdict;
  if (differs.length === 0) verdict = '（这条其实三处都对得上 —— 红的是别的组，看上面那条 check 的三列）';
  else if (!draftOk && sourceOk === true && productOk !== false) verdict = '**冻稿抄本**漂了（真文件与文档一致）⇒ 改冻稿，不是改产品或改文档';
  else if (draftOk && sourceOk === false && productOk !== true) verdict = `**产品**变了（真文件声明与文档 ${declaredText} 不符，而冻稿与文档一致）⇒ 要么把产品改回，要么按新数把规格文档 ＋ 冻稿一起更新`;
  else if (sourceOk === false && productOk === true && draftOk) verdict = `**真文件声明**与文档不符，但真页面实测与文档一致 ⇒ 声明与实效对不上的那一处（别的规则盖住？）要看清楚再改`;
  else if (!draftOk && sourceOk === false) verdict = `**文档的数**与两处实现都不一致 ⇒ 先定哪个对：文档对 ⇒ 产品与冻稿都要改；实现对 ⇒ 文档与冻稿按实现更新`;
  else if (draftOk && sourceOk === true && productOk === false) verdict = `真文件声明与文档一致，但**真页面实测**不同 ⇒ 查选择器命中 / 优先级 / 运行时算出来的数（或者是真实现里**别的规则**盖住了这条声明）`;
  else verdict = `对不上的那一侧：${differs.join('、')} ⇒ 按上面四列自己定（文档 / 真文件 / 冻稿 / 真页面）`;
  return { draftOk, sourceOk, productOk, differs, verdict };
}

function reportDiagnosis() {
  if (failures.length === 0) return;
  const redFor = (id) => failures.some((f) => f.id === id || f.id === `real:${id}` || f.id === `product:${id}`);
  process.stdout.write('\n──── 指路：红的是哪一侧（四列并列）────\n');
  let printed = 0;
  for (const g of geometryReadings) {
    if (!redFor(g.id)) continue;
    const who = [failures.some((f) => f.id === g.id) ? '①文档 vs **冻稿**' : null,
      failures.some((f) => f.id === `real:${g.id}`) ? '②文档 vs **真文件声明**' : null,
      failures.some((f) => f.id === `product:${g.id}`) ? '⑦**冻稿 vs 真页面**' : null].filter(Boolean).join(' / ');
    const source = sourceReadings.get(g.id) ?? null;
    const product = productReadings.get(g.id);
    const sourceText = source?.error ? `(读不到：${source.error})`
      : source ? `${normDeclaration(source.raw)}（读出 ${shortNumber(source.number)}）`
      : '—';
    process.stdout.write(`── [${g.id}] ${g.element} · ${g.property}（探针 ${g.probe}）｜红的是 ${who}\n`);
    process.stdout.write(`   文档声明 ${g.declaredText} ｜ 真文件声明 ${sourceText} ｜ 冻稿实测 ${g.raw} ｜ 真页面实测 ${product === undefined ? '(这一臂没跑)' : product}\n`);
    process.stdout.write(`   ⇒ 判定：${attributionFor(g).verdict}\n`);
    printed += 1;
  }
  for (const name of Object.keys(realTokens)) {
    const draftRed = failures.some((f) => f.id === `token:${name}`);
    const computedRed = failures.some((f) => f.id === `token-computed:${name}`);
    if (!draftRed && !computedRed) continue;
    const real = realTokens[name];
    const declared = (tokenTable.rows.find((r) => r['token'] === name) ?? {})['值'];
    const draftDecl = draftTokens[name];
    const computed = computedTokenValues[name];
    const verdict = normDeclaration(declared ?? '') !== normDeclaration(real)
      ? `**真源变了**（真文件 ${real} 与文档 ${declared ?? '(表里没有这个 token)'} 不符）⇒ 要么把 token 改回，要么按新值更新文档 ＋ 冻稿`
      : draftDecl === undefined ? '**冻稿没抄这个 token** ⇒ 补进冻稿'
      : normDeclaration(draftDecl) !== normDeclaration(real) ? `**冻稿抄本**过期（冻稿写的 ${draftDecl} ≠ 真源 ${real}）⇒ 改冻稿`
      : normDeclaration(computed ?? '') !== normDeclaration(real) ? '**冻稿声明与它在页面上算出来的值不一致**（少见：`var()` 指向了别的 token？）⇒ 查冻稿的 `:root` 与用它的那条规则'
      : '真文件与文档都对得上，但这条还是红了 ⇒ 看上面那条 check 的原话';
    process.stdout.write(`── [token:${name}]${computedRed ? '（含计算值那条）' : ''} ── 真文件 ${real} ｜ 文档 ${declared ?? '(表里没有)'} ｜ 冻稿声明 ${draftDecl ?? '(缺)'} ｜ 冻稿计算 ${computed ?? '(缺)'}\n   ⇒ 判定：${verdict}\n`);
    printed += 1;
  }
  const srcRed = failures.filter((f) => f.id.startsWith('src:'));
  for (const f of srcRed) {
    process.stdout.write(`── [${f.id}] 真源对照表（逐字）── 上面那行已经并列打了「真文件 / 文档 / 冻稿」三列；\n   ⇒ 判定：真文件与写作不一致 ⇒ 先看是**产品改了声明**还是**文档/冻稿抄错了**（选择器或属性名写错也走这一条）\n`);
    printed += 1;
  }
  if (printed === 0) process.stdout.write('（红的都不在几何表 / token 表 / 真源对照表里（状态、不变量那几条）—— 它们各自那行已经并列打了三列）\n');
}

// ───────────────────────────────── 实测数字表 + 结算 ─────────────────────────────────
const row = (line) => process.stdout.write(`${line}\n`);
print('实测数字表', '（文档声明 vs 真实现 vs 冻稿实测）');
row('| id | 元素 | 属性 | 文档声明 | 真文件声明（读出） | 冻稿实测 | 真页面实测 | 差（冻稿−文档） | 容差 |');
row('|---|---|---|---|---|---|---|---|---|');
for (const g of geometryReadings) {
  const source = sourceReadings.get(g.id) ?? null;
  const product = productReadings.get(g.id);
  const sourceText = source?.error ? '(读不到)' : source ? `${normDeclaration(source.raw)}（${shortNumber(source.number)}${source.via ? ` ←${source.via.name}` : ''}）` : '—';
  const diff = g.measured === null || g.declared === null ? 'n/a' : (g.measured - g.declared).toFixed(4);
  row(`| ${g.id} | ${g.element} | ${g.property} | ${g.declaredText} | ${sourceText} | ${g.raw} | ${product === undefined ? '(没跑)' : product} | ${diff} | ${g.tolerance} |`);
}
row(`（${geometryReadings.length} 条几何项；${tokenTable.rows.length} 个 token；${stateTable.rows.length} 条状态断言；${sourceTable.rows.length} 条真源声明）`);

reportDiagnosis();

// 收尾：删掉的都是本门自己建的副本/临时件（原冻稿与 `web/` 一个字节不动）
for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
if (mutantPath) await rm(mutantPath, { force: true });

if (ARM) {
  const arm = ARM_MUTANTS[ARM];
  const redIds = failures.map((f) => f.id);
  const missing = arm.expect.filter((id) => !redIds.includes(id));
  const wrongRed = (arm.expectGreen ?? []).filter((id) => redIds.includes(id));
  const unmatched = (arm.expectMatch ?? []).filter((re) => !redIds.some((id) => re.test(id)));
  process.stdout.write(`\n──── 反证臂 ${ARM}：预期红 ${JSON.stringify(arm.expect)}${arm.expectGreen ? ` 预期仍绿 ${JSON.stringify(arm.expectGreen)}` : ''}${arm.expectMatch ? ` 预期命中 ${JSON.stringify(arm.expectMatch.map(String))}` : ''} / 实际红 ${JSON.stringify(redIds)} ────\n`);
  if (missing.length === 0 && wrongRed.length === 0 && unmatched.length === 0) {
    process.stdout.write(`✓ 反证臂 ${ARM} 红到位（预期的每一条都红了${arm.expectGreen ? '，该绿的那条也绿着' : ''}）—— 这是**期望**的结果，不是缺陷\n`);
  } else {
    if (missing.length) process.stdout.write(`✗ 反证臂 ${ARM} **没红到位**：预期的 ${JSON.stringify(missing)} 不在红的名单里 ⇒ 这个门是个假门\n`);
    if (wrongRed.length) process.stdout.write(`✗ 反证臂 ${ARM} **把不该红的也弄红了**：${JSON.stringify(wrongRed)}（这一臂要证明的是「只打产品」，抄本不该被牵连）\n`);
    if (unmatched.length) process.stdout.write(`✗ 反证臂 ${ARM} 预期要命中的 ${JSON.stringify(unmatched.map(String))} 一条都没红\n`);
    process.exitCode = 1;
  }
} else {
  process.stdout.write(`\n──── test/design-spec.mjs：${checks} 条断言 —— ${checks - failures.length} 绿 / ${failures.length} 红 ────\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stdout.write(`FAIL  [${f.id}] ${f.name}\n`);
    process.exitCode = 1;
  } else if (problems.length > 0) {
    for (const p of problems) process.stdout.write(`cleanup problems (secondary): ${p}\n`);
    process.exitCode = 1;
  }
  if (OBSERVE) {
    process.stdout.write('（--observe：只观测、不判死 —— 上面那些红不影响退出码）\n');
    process.exitCode = 0;
  }
}
