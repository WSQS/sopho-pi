#!/usr/bin/env node
// test/designer-sample-anchor.mjs —— **样例真源**（`design/samples/two-pane/main-screen.json`）那 4 条转移带上
// `from.anchor.selector` 之后的两件判据（业主 2026-09-26 第 3 条的**数据那一半**）。
//
// 为什么要有它（渲染那一半已在主干：`designer/toSvg.mjs` 的 `anchorBoxOf()` / `edgePointToward()`，读的就是
// `transition.from.anchor.selector`）：`docs/design/designer-exporters.md:511` 明说**散文里的选择器不会被自动
// 摘进 anchor** ⇒ 那一步是**人工数据**。人工数据最容易「悄悄漂」：锚点被删（起点退回节点中心）、指到一个不是
// 控件的东西（容器/矩形/文字）、或者**散文说 A、锚点却指 B** —— 而没有门看着，都不会有人发现。
//
// ── 判据（①③ 纯 Node；②④ 真 Chromium 里量）──────────────────────────────────────────────────
//   ① **散文 ↔ 锚点三条名字必须一致（机器判，不靠自觉）**：
//      · `anchor:map-keys`：每条转移在 `merge.mjs` 的 `TRANSITION_ANCHORS` 表里**都有且只有一行**（fail-closed）；
//      · `anchor:prose-and-element`：散文 `trigger` 里那个 `#id` ↔ 表里同一行的 `prose`、**装进文档的 `anchor`**
//        ↔ 表里同一行的 `element` ⇒ 三者一致 ⇒ 「散文说 A、锚点却指 B」**当场红**；
//      · `anchor:selector-real-control`：装进文档的 `anchor` 认得出 `#<元素 id>`、在 **from 屏/状态树**里指到一个
//        **真实存在**的元素、且那个元素是**控件**（`button`/`input`）；
//      · `anchor:prose-real-id`：每条 `trigger` 里恰好一个 `#id`，且它今天仍是 `web/index.html` 上一个真 id
//        （散文不能对着一个已被改名的真控件）。
//      ⚠️ 为什么要有桥：散文写的是**真页面**（`web/index.html`）的 CSS id，而 `anchor.selector` 只认**稿里那棵树**
//      上的元素 id —— 两层名字本来就**不是一套**（硬把两者相比只会 100% 误报）。桥＝`merge.mjs` 的
//      `TRANSITION_ANCHORS{prose, element}`（**唯一**写 anchor 值的地方；对照表另见 `README` §8.1）。
//   ② `9ab6abf` 那条 `anchor:plain-byte-identical-to-before` 的口径**不许放宽**：把这份真源的 4 个 anchor 去掉
//      之后渲染的整张 SVG，必须与「读 anchor 之前那一版实现」（钉死提交 `PRE_COMMIT`，`git show` 进沙箱）
//      对**同一份去掉 anchor 的文档**渲染出来的结果**逐字节相同**。
//      ⚠ 2026-10-05（元素组件那一单）：真源带了新字段（`components` / `type:"instance"` / `style.border`），
//      改前那一版实现**读不懂**（旧 schema `additionalProperties:false` 当场拒收）⇒ 现在喂给它的是
//      一份**投影到新特性之前**的文档（只留屏/状态/转移；flow SVG 与元素树无关）。
//      新增 `anchor:projection-flow-invariant` 机械证明「投影没有改变 flow SVG」⇒ 比对的仍是 anchor 这件事。
//   ③ 带上 anchor 之后：4 根箭头的 `d` 起点**不再是** from 节点中心（每根都与「去掉 anchor」那版不同）。
//   ④ **真 Chromium**：每根箭头的**真实起点**（`getPointAtLength(0)`）落在「那个控件在屏 SVG 里量到的盒子」
//      按**逐轴比例**映进「量到的节点框」之后朝目标那一侧的**边**上；终点仍是目标节点中心；标签仍贴在自己那条线上。
//
// ── 反证臂（必红；改的是**样例副本**，真样例一个字节不动）──────────────────────────────────────
// 臂写在下面 `ARM_SPECS[].edits` 里，形状是 `{ file, from, to, what }`（字符串字面量）—— 与仓库其它门同形 ⇒
// 常驻门 `test:armseams`（`bin/check-arm-seams.mjs`）会**静态**核每条 `from` 在仓里逐字找得到（臂崩 ≠ 臂红）。
//   npm run test:designersampleanchor:reverse-drift      —— 把表里 `t-questions-open` 那行的 `element` 改到别的控件 ⇒ `anchor:prose-and-element` 必红；
//   npm run test:designersampleanchor:reverse-bad-anchor —— 把锚点（表与文档同步）改到一个**容器** `#rp-tabs` ⇒ `anchor:selector-real-control` 必红；
//   npm run test:designersampleanchor:reverse-noanchor   —— 删掉 4 个 anchor（回到「起点 = 节点中心」）⇒ ①③④ 里那几条必红。
//
// 用法：CHROME_BIN='...' node test/designer-sample-anchor.mjs [--sample-root=<目录>]
//
// 沙箱纪律：真 Chromium 走 `test/ui-harness.mjs` 的 `boot()`（自己管私有 TMPDIR/home/XDG 与收尾）、
// 高位随机端口、只按本次 spawn 的 pid 停（绝不 pkill）；临时 web 根、`designer/` 改前副本、样例副本都落在
// 自己的沙箱里，用 `test/harness.mjs` 的收尾函数清（删完复核）。

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { removeSandbox, removeSandboxConverged } from './harness.mjs';
import { boot } from './ui-harness.mjs';
// 「改前」副本的唯一造法（与 `test/designer-export.mjs` / `test/designer-anchor-flow.mjs` 共用一条出处）。
import { materializeBeforeCopy } from '../design/samples/f1-flow-before/evidence.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const here = path.dirname(THIS_FILE);
const root = path.resolve(here, '..');
const DESIGNER_ROOT = path.join(root, 'designer');
const WEB_INDEX = path.join(root, 'web', 'index.html');
const argOf = (name) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};
const ARM = argOf('reverse-arm');
const SAMPLE_ROOT = path.resolve(argOf('sample-root') || process.env.SOPHO_DESIGNER_SAMPLE_ROOT || path.join(root, 'design', 'samples', 'two-pane'));
/** 「改前」= 本笔（读 `from.anchor`）之前的主干提交：`633329e^1`（`designer-anchor-flow.mjs` 用同一个）。 */
const PRE_COMMIT = 'd14291e83a96ef9298f2782eb324c2389a56f1ba';
/** 起点/几何那条判据的容差（px）：实现里 `num()` 保留 3 位小数，实测量在同一量级。 */
const EPSILON = 0.02;
/** 与 `test/designer-anchor-flow.mjs` / `test/designer-export.mjs` 同一条上界：标签中心到它自己那条路径的距离。 */
const LABEL_MAX_PX = 18;
/** 「触发」必须是一个**控件**：容器/矩形/文字都不能当起点锚（业主那句是「从具体控件出来」）。 */
const CONTROL_TYPES = new Set(['button', 'input']);

const failures = [];
const problems = [];
function check(id, name, ok, detail) {
  process.stdout.write(`${ok ? '✓' : '✗'} [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  if (!ok) failures.push(id);
  return ok;
}

const close = (a, b) => Math.abs(a - b) <= EPSILON;
const isZero = (value) => Math.abs(value) <= EPSILON;
const centreOf = (box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
/** 与实现里 `edgePointToward()` **同一条规则**的独立一份（本门自己算一遍，再去和实测量对）。 */
function edgePointToward(box, aim) {
  const c = centreOf(box);
  const dx = aim.x - c.x;
  const dy = aim.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const tx = dx > 0 ? (box.x + box.w - c.x) / dx : dx < 0 ? (box.x - c.x) / dx : Infinity;
  const ty = dy > 0 ? (box.y + box.h - c.y) / dy : dy < 0 ? (box.y - c.y) / dy : Infinity;
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}
/** 与实现里 `anchorBoxOf()` 同一套「逐轴比例 + 夹进节点框」的映射（独立一份）。 */
function mapControlIntoNode(control, canvas, node) {
  const scaleX = node.w / canvas.w;
  const scaleY = node.h / canvas.h;
  const rawX = node.x + control.x * scaleX;
  const rawY = node.y + control.y * scaleY;
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
  const x = clamp(rawX, node.x, node.x + node.w);
  const y = clamp(rawY, node.y, node.y + node.h);
  return {
    x,
    y,
    w: Math.max(0, Math.min(rawX + control.w * scaleX, node.x + node.w) - x),
    h: Math.max(0, Math.min(rawY + control.h * scaleY, node.y + node.h) - y),
  };
}
const onBoundaryOf = (point, box) => {
  const inX = point.x >= box.x - EPSILON && point.x <= box.x + box.w + EPSILON;
  const inY = point.y >= box.y - EPSILON && point.y <= box.y + box.h + EPSILON;
  if (!inX || !inY) return false;
  return close(point.x, box.x) || close(point.x, box.x + box.w) || close(point.y, box.y) || close(point.y, box.y + box.h);
};
const pathDOf = (text, id) => {
  const match = new RegExp(`<path class="designer-arrow" data-transition="${id}"[^>]*\\bd="([^"]*)"`).exec(text);
  return match === null ? null : match[1];
};
/** 散文里出现的真页面选择器（只认 `#<真 id>`；真 id 是 `[A-Za-z0-9_-]`）。 */
const proseIdsOf = (text) => [...new Set([...String(text).matchAll(/#([A-Za-z0-9_-]+)/g)].map((match) => match[1]))];
const stripHash = (value) => String(value).replace(/^#/, '');

/** 把真源**投影**到「本单新特性之前」的格式：只留 flow SVG 真正读的那几样
 *  （屏 id/name、状态 id/name、转移）。
 *  为什么需要它：`anchor:plain-byte-identical-to-before` 要把文档喂给**改前那一版实现**（`PRE_COMMIT`），
 *  而它读不懂本单的新字段（`components` / `type:"instance"` / `style.border` —— 它的 schema 是旧的、
 *  `additionalProperties:false` ⇒ 当场拒收）。而 **flow SVG 只是 screens × states ＋ transitions 的函数**，
 *  与元素树无关 ⇒ 喂它一份「它读得懂、且 flow SVG 与真源逐字节相同」的文档，量的仍然只是 anchor 这件事。
 *  「逐字节相同」由下面的 `anchor:projection-flow-invariant` 机械证明，不是嘴上说的。 */
function projectToLegacy(doc) {
  return {
    $schema: doc.$schema,
    version: doc.version,
    name: doc.name,
    tokens: doc.tokens,
    screens: (doc.screens ?? []).map((screen) => ({
      id: screen.id,
      name: screen.name,
      states: (screen.states ?? []).map((state) => ({ id: state.id, name: state.name })),
      root: { id: `projected-${screen.id}`, type: 'container', size: { w: { mode: 'fixed', value: 1 }, h: { mode: 'fixed', value: 1 } }, layout: { mode: 'free' } },
    })),
    transitions: JSON.parse(JSON.stringify(doc.transitions ?? [])),
  };
}

// ── 反证臂 ────────────────────────────────────────────────────────────────────────────────────
// 臂改的是**样例副本**：整棵样例树拷到 `design/samples/.sopho-sample-anchor-arm-<随机>/`（**必须是这个深度** ——
// 那份样例的 `merge.mjs` 里相对导入是 `../../../designer/...`，仓外或别的深度都解析不到）。真样例一个字节不动。
// ⚠️ `edits` 里每条 `{ file, from, to, what }` 的 `from`/`to`/`what` 都是**字符串字面量**、且 `from` 在仓里逐字
// 找得到 —— 这是 `test:armseams`（`bin/check-arm-seams.mjs`）的接缝形状；别改成动态拼串（那门会当场红）。
// ⚠️ 臂**必须**能红（`expect` 里的 id 真出现在子进程输出里）；`applyEdits` 没命中会抛，绝不静默跳过。
const ARM_SPECS = {
  drift: {
    why: '把表里 `t-questions-open` 那一行的 `element` 改到「标注」页签（`#rp-tab-annotations`）'
      + '—— 表（唯一来源）与**盘上那份文档**不再一致：散文说「问题」、文档还是「问题」，但表已指「标注」',
    expectRed: ['anchor:prose-and-element'],
    edits: [
      { file: 'design/samples/two-pane/merge.mjs', from: "element: '#rp-tab-questions' }", to: "element: '#rp-tab-annotations' }", what: '表里 t-questions-open 的 element → #rp-tab-annotations（与装进文档的 anchor 不一致）' },
    ],
  },
  'bad-anchor': {
    why: '把 `t-questions-open` 的锚点（**表与文档同步**改）指到一个**容器**（`#rp-tabs`）'
      + '—— 锚点必须指得到**控件**，不是「能算出盒子的任何东西」',
    expectRed: ['anchor:selector-real-control'],
    edits: [
      { file: 'design/samples/two-pane/merge.mjs', from: "element: '#rp-tab-questions' }", to: "element: '#rp-tabs' }", what: '表里 t-questions-open 的 element → 容器 #rp-tabs' },
      { file: 'design/samples/two-pane/main-screen.json', from: '"anchor": {\n          "selector": "#rp-tab-questions"\n        }', to: '"anchor": {\n          "selector": "#rp-tabs"\n        }', what: '文档里 t-questions-open 的 anchor → 容器 #rp-tabs（与表一致，好让 selector-real-control 单独红）' },
    ],
  },
  'no-anchor': {
    why: '删掉真源里 4 条转移的 `from.anchor`（回到「起点 = 节点中心」那条老路）',
    expectRed: ['anchor:all-transitions-anchored', 'anchor:prose-and-element', 'anchor:selector-real-control', 'anchor:anchored-paths-differ', 'anchor:start-on-control-edge', 'anchor:start-not-node-centre'],
    edits: [
      { file: 'design/samples/two-pane/main-screen.json', from: ',\n        "anchor": {\n          "selector": "#lp-foot-settings"\n        }', to: '', what: '删掉 t-settings-open 的锚点' },
      { file: 'design/samples/two-pane/main-screen.json', from: ',\n        "anchor": {\n          "selector": "#set-panel-close"\n        }', to: '', what: '删掉 t-settings-close 的锚点' },
      { file: 'design/samples/two-pane/main-screen.json', from: ',\n        "anchor": {\n          "selector": "#rp-tab-questions"\n        }', to: '', what: '删掉 t-questions-open 的锚点' },
      { file: 'design/samples/two-pane/main-screen.json', from: ',\n        "anchor": {\n          "selector": "#q-rp-tab-session"\n        }', to: '', what: '删掉 t-questions-close 的锚点' },
    ],
  },
};

if (ARM && !ARM_SPECS[ARM]) {
  process.stderr.write(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_SPECS).join(', ')}）\n`);
  process.exit(2);
}

/** 把一条臂的 `edits` 逐条打进**副本的对应文件**（按 `file` 分组；没命中就抛，绝不静默跳过 = 臂崩 ≠ 臂红）。
 *  ⚠️ `edit.file` 是**仓根相对**的完整路径（`design/samples/two-pane/…`）—— 那是交付门的
 *  `resolveDeclaredFile()` 要的形状（`'main-screen.json'` 这种短名在仓里有两个尾巴 ⇒ **歧义** ⇒ 门红）。
 *  落到**副本**里时把 `design/samples/two-pane/` 前缀去掉（副本的根就是样例根）。 */
async function applyEdits(sampleDir, edits) {
  const sampleRepoDir = path.relative(root, SAMPLE_ROOT).split(path.sep).join('/');
  const byFile = new Map();
  for (const edit of edits) {
    const declared = edit.file ?? `${sampleRepoDir}/main-screen.json`;
    const rel = declared.startsWith(`${sampleRepoDir}/`) ? declared.slice(sampleRepoDir.length + 1) : declared;
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push(edit);
  }
  for (const [rel, list] of byFile) {
    const full = path.join(sampleDir, rel);
    let text = await readFile(full, 'utf8');
    for (const edit of list) {
      if (!text.includes(edit.from)) throw new Error(`反证臂改写没命中（接缝形状变了？）[${rel}]：${JSON.stringify(edit.from)}`);
      text = text.replace(edit.from, edit.to);
    }
    await writeFile(full, text, 'utf8');
  }
}

// ── 反证臂：拷样例 → 改副本 → 用 `--sample-root` 跑本文件本体 ────────────────────────────────────
if (ARM) {
  const spec = ARM_SPECS[ARM];
  // ⚠️ 副本必须落在 `design/samples/<名字>/` 这个深度（那份样例的 `merge.mjs` 相对导入是 `../../../designer/...`）。
  const dest = await mkdtemp(path.join(root, 'design', 'samples', '.sopho-sample-anchor-arm-'));
  process.stdout.write(`反证臂 ${ARM}：${spec.why}\n  副本（真样例一个字节不动）：${path.relative(root, dest)}\n`);
  const armProblems = [];
  let child = null;
  let ok = false;
  try {
    await cp(SAMPLE_ROOT, dest, { recursive: true });
    await applyEdits(dest, spec.edits);
    child = spawnSync(process.execPath, [THIS_FILE, `--sample-root=${dest}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, SOPHO_DESIGNER_SAMPLE_ROOT: dest },
    });
    const redIds = [...(child.stdout ?? '').matchAll(/^✗ \[([^\]]+)\]/gm)].map((match) => match[1]);
    const missing = spec.expectRed.filter((id) => !redIds.includes(id));
    const redLines = (child.stdout ?? '').split('\n').filter((line) => line.startsWith('✗'));
    process.stdout.write(`\n──── 反证臂 ${ARM}：预期红 ${JSON.stringify(spec.expectRed)} / 实际红 ${JSON.stringify(redIds)}（子进程 exit=${child.status}）────\n`);
    for (const id of spec.expectRed) process.stdout.write(`  ${redIds.includes(id) ? '红' : '没红'}：[${id}]\n`);
    process.stdout.write(`\n子进程里那些红**逐字**长这样（报告要原文）：\n${redLines.map((line) => `  ${line}`).join('\n')}\n`);
    ok = child.status !== 0 && missing.length === 0;
    process.stdout.write(ok
      ? `✓ 反证臂 ${ARM} 红到位（真样例一个字节没动）\n`
      : `✗ 反证臂 ${ARM} **没红到位**：缺 ${JSON.stringify(missing)}（子进程 exit=${child.status}）⇒ 这道门是个假门\n`);
    if (!ok) process.stdout.write(`${redLines.join('\n')}\n`);
    process.stderr.write(child.stderr ?? '');
  } catch (error) {
    process.stderr.write(`反证臂 ${ARM} 主错误：${error?.stack ?? error}\n`);
  } finally {
    process.exitCode = ok ? 0 : 1;
    const result = await removeSandboxConverged(dest, { label: `designer-sample-anchor 反证臂 ${ARM} 副本` });
    for (const problem of result.problems) armProblems.push(problem);
    if (result.remaining) armProblems.push(`反证臂副本 ${dest} 删了 ${result.passes} 遍仍在盘上`);
    if (armProblems.length > 0) process.stdout.write(`cleanup problems (secondary): ${armProblems.join('; ')}\n`);
    if (process.exitCode === 0 && armProblems.length > 0) process.exitCode = 1;
  }
} else {
  // ── 本体 ───────────────────────────────────────────────────────────────────────────────────
  const sampleFile = path.join(SAMPLE_ROOT, 'main-screen.json');
  const source = path.relative(root, sampleFile).split(path.sep).join('/');
  const doc = JSON.parse(await readFile(sampleFile, 'utf8'));
  const merge = await import(pathToFileURL(path.join(SAMPLE_ROOT, 'merge.mjs')).href);
  const anchorMap = merge.TRANSITION_ANCHORS;
  const validate = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'validate.mjs')).href);
  const toSvg = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toSvg.mjs')).href);

  const transitions = Array.isArray(doc.transitions) ? doc.transitions : [];
  const report = validate.validateDocument(doc, { source });
  check('anchor:doc-valid', `真源 ${source} 通过校验（0 个错）`, report.ok,
    `${report.errors.length} 错 / ${report.warnings.length} 警告${report.errors.length ? `：${report.errors.map((error) => `${error.code}@${error.path}`).join(', ')}` : ''}`);

  const screenById = new Map((doc.screens ?? []).map((screen) => [screen.id, screen]));
  const missingAnchors = transitions.filter((transition) => transition.from?.anchor?.selector === undefined).map((transition) => transition.id);
  check('anchor:all-transitions-anchored', `每一条转移的 \`from\` 都带上了锚点（${transitions.length} 条都带）`,
    transitions.length > 0 && missingAnchors.length === 0,
    missingAnchors.length === 0 ? `${transitions.length} 条都带` : `没带的：${JSON.stringify(missingAnchors)}`);

  // ① 表：每条转移都有且只有一行（fail-closed）
  const mapKeys = Object.keys(anchorMap);
  const transitionIds = transitions.map((transition) => transition.id);
  const missingRows = transitionIds.filter((id) => !mapKeys.includes(id));
  const extraRows = mapKeys.filter((id) => !transitionIds.includes(id));
  check('anchor:map-keys', '`TRANSITION_ANCHORS` 与真源里的转移 id **一一对应**（每条转移都有且只有一行 —— fail-closed，少一行就红）',
    transitionIds.length > 0 && missingRows.length === 0 && extraRows.length === 0,
    `表 ${JSON.stringify([...mapKeys].sort())} / 文档 ${JSON.stringify([...transitionIds].sort())}`
    + `${missingRows.length ? `｜表里没有的转移：${JSON.stringify(missingRows)}` : ''}${extraRows.length ? `｜多出来的行：${JSON.stringify(extraRows)}` : ''}`);

  // ① **散文 ↔ 锚点三条名字必须一致**（桥＝表；这一格就是「散文说 A、锚点却指 B」的机器牙）
  const bridgeProblems = [];
  for (const transition of transitions) {
    const row = anchorMap[transition.id];
    if (row === undefined) { bridgeProblems.push(`${transition.id}：表里没有这一行`); continue; }
    const prose = proseIdsOf(transition.trigger);
    const wantProse = stripHash(row.prose);
    if (prose.length !== 1 || prose[0] !== wantProse) {
      bridgeProblems.push(`${transition.id}：散文里的 #id ${JSON.stringify(prose)} ≠ 表里同一行的 prose ${JSON.stringify(row.prose)}`);
    }
    const anchorId = validate.anchorElementId(transition.from?.anchor?.selector ?? null);
    const wantElement = stripHash(row.element);
    if (anchorId === null) {
      bridgeProblems.push(`${transition.id}：装进文档的 from.anchor.selector 认不出（读到 ${JSON.stringify(transition.from?.anchor?.selector)}）`);
    } else if (anchorId !== wantElement) {
      bridgeProblems.push(`${transition.id}：装进文档的 anchor #${anchorId} ≠ 表里同一行的 element #${wantElement}（散文说的是 ${JSON.stringify(row.prose)}）`);
    }
  }
  check('anchor:prose-and-element', '散文 `trigger` 里那个 `#id` ↔ 表里同一行的 `prose`、**装进文档的 `anchor`** ↔ 表里同一行的 `element` —— 三者必须一致（散文说 A、锚点却指 B ⇒ 当场红）',
    bridgeProblems.length === 0,
    bridgeProblems.length === 0
      ? transitions.map((transition) => `${transition.id}: ${anchorMap[transition.id].prose} → ${anchorMap[transition.id].element}`).join('；')
      : bridgeProblems.join('；'));

  // ① 锚点侧：装进文档的锚点得认得出、指得到 from 屏/状态树里的一个元素、且那个元素是**控件**。
  const anchorProblems = [];
  for (const transition of transitions) {
    const selector = transition.from?.anchor?.selector ?? null;
    const elementId = validate.anchorElementId(selector);
    if (elementId === null) {
      anchorProblems.push(`${transition.id}：from.anchor.selector 认不出（读到 ${JSON.stringify(selector)}）—— 只认 \`#<元素 id>\``);
      continue;
    }
    const screen = screenById.get(transition.from.screen);
    const tree = screen ? validate.stateTreeOf(screen, transition.from.state) : null;
    const element = tree ? validate.findElementById(tree, elementId) : null;
    if (element === null) {
      anchorProblems.push(`${transition.id}：锚点 #${elementId} 在 from 屏 ${transition.from.screen}/${transition.from.state} 的树里找不到`);
    } else if (!CONTROL_TYPES.has(element.type)) {
      anchorProblems.push(`${transition.id}：锚点 #${elementId} 的 type=${JSON.stringify(element.type)} 不是控件（${[...CONTROL_TYPES].join('/')}）`);
    }
  }
  check('anchor:selector-real-control', '每一条转移装进文档的 `from.anchor.selector` 都认得出、都在 from 屏/状态树里指到一个**真实存在**的元素、且那个元素是**控件**（`button`/`input`）—— 起点锚必须落在「具体控件」上',
    anchorProblems.length === 0,
    anchorProblems.length === 0
      ? transitions.map((transition) => `${transition.id}: #${validate.anchorElementId(transition.from.anchor.selector)}`).join('；')
      : anchorProblems.join('；'));

  // ① 散文侧：每条 trigger 里恰好一个 `#id`，且它是 `web/index.html` 上一个真 id。
  const webText = await readFile(WEB_INDEX, 'utf8');
  const proseProblems = [];
  for (const transition of transitions) {
    const prose = proseIdsOf(transition.trigger);
    if (prose.length !== 1) {
      proseProblems.push(`${transition.id}：trigger 里的 #id 读到 ${JSON.stringify(prose)}（要恰好一个）`);
      continue;
    }
    if (!webText.includes(`id="${prose[0]}"`)) {
      proseProblems.push(`${transition.id}：散文里的 #${prose[0]} 在 web/index.html 里找不到 \`id="${prose[0]}"\`（真页面改名了？）`);
    }
  }
  check('anchor:prose-real-id', '每一条 `trigger` 里恰好一个 `#id`，且那个 id 今天仍是 `web/index.html` 上**一个真 id**（散文不能悄悄对着一个已被改名的真控件）',
    proseProblems.length === 0,
    proseProblems.length === 0
      ? transitions.map((transition) => `${transition.id}: #${proseIdsOf(transition.trigger)[0]}`).join('；')
      : proseProblems.join('；'));

  let page = null;
  let primaryError = null;
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'designer-sample-anchor-'));
  try {
    if (report.ok) {
      // ② 「不带 anchor 的文档 ⇒ 与改前那一版实现逐字节相同」（`9ab6abf` 那条口径，**在真样例上再钉一遍**）
      const plainDoc = JSON.parse(JSON.stringify(doc));
      for (const transition of plainDoc.transitions) delete transition.from.anchor;
      const flowPlainNew = toSvg.renderFlowSvg(plainDoc, { source });
      // 投影版（去掉 components/instance/border）：给改前那一版实现读。
      const projectedPlain = projectToLegacy(doc);
      for (const transition of projectedPlain.transitions) delete transition.from.anchor;
      const flowProjected = toSvg.renderFlowSvg(projectedPlain, { source });
      // 投影版与真源版的**几何/内容**必须逐字节相同；唯一允许不同的是导出物里嵌的那份文档摘要
      //（`sha256:<docDigest>`）—— 投影出来的是**另一份文档**，它自己的摘要本来就不同。
      const withoutDigest = (text) => text.replace(/sha256:[0-9a-f]{64}/g, 'sha256:<digest>');
      check('anchor:projection-flow-invariant', '投影到「新特性之前」的格式（只留屏/状态/转移）**不改变** flow SVG（除了导出物里嵌的文档摘要本身）—— 所以下面那条 before-比对量的仍然只是 anchor 这件事，与元素树无关',
        withoutDigest(flowPlainNew) === withoutDigest(flowProjected),
        withoutDigest(flowPlainNew) === withoutDigest(flowProjected) ? `去掉摘要后两边都是 ${Buffer.byteLength(withoutDigest(flowProjected))} B` : `字节不同：真源 ${Buffer.byteLength(flowPlainNew)} B / 投影 ${Buffer.byteLength(flowProjected)} B`);
      const beforeDir = path.join(sandbox, 'before-designer');
      await materializeBeforeCopy(beforeDir, { commit: PRE_COMMIT });
      const beforeSvg = await import(pathToFileURL(path.join(beforeDir, 'toSvg.mjs')).href);
      const flowPlainBefore = beforeSvg.renderFlowSvg(projectedPlain, { source });
      check('anchor:plain-byte-identical-to-before', `这份真源**去掉 anchor** 之后：现在渲染的整张 flow SVG 与「改前那一版」（\`git show ${PRE_COMMIT.slice(0, 7)}:designer/toSvg.mjs\`，喂同一份**投影到旧格式**的文档）**逐字节相同**（${Buffer.byteLength(flowProjected)} B）`,
        flowProjected === flowPlainBefore,
        flowProjected === flowPlainBefore ? 'sha 同值' : `字节不同：改前 ${Buffer.byteLength(flowPlainBefore)} B / 现在 ${Buffer.byteLength(flowProjected)} B`);

      const flowAnchored = toSvg.renderFlowSvg(doc, { source });
      const unchanged = transitions.filter((transition) => pathDOf(flowAnchored, transition.id) === pathDOf(flowPlainNew, transition.id)).map((transition) => transition.id);
      check('anchor:anchored-paths-differ', `带上 anchor 之后，${transitions.length} 根箭头的 \`d\` 起点**都不再是** from 节点中心（每根都与「去掉 anchor」那版不同）`,
        transitions.length > 0 && unchanged.length === 0,
        unchanged.length === 0
          ? transitions.map((transition) => `${transition.id}: ${pathDOf(flowAnchored, transition.id)}`).join('｜')
          : `与去掉 anchor 那版相同的：${JSON.stringify(unchanged)}`);

      // ── ④ 真 Chromium：量控件盒子、节点框、箭头起点/终点、标签 ──────────────────────────────
      const screenIds = [...new Set(transitions.map((transition) => transition.from.screen))];
      const served = new Map([['/flow.svg', flowAnchored]]);
      for (const screenId of screenIds) served.set(`/screen-${screenId}.svg`, toSvg.renderScreenSvg(doc, screenId, { source }));
      const webRoot = path.join(sandbox, 'web');
      await mkdir(webRoot, { recursive: true });
      await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><meta charset="utf-8"><title>sample-anchor</title>', 'utf8');
      page = await boot({
        routes: async (request, response, url) => {
          const text = served.get(url.pathname);
          if (text === undefined) return false;
          const body = Buffer.from(text, 'utf8');
          response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
          response.end(body);
          return true;
        },
        webRoot,
        width: 1000,
        height: 420,
      });
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const navigate = async (pathname) => {
        const loaded = page.browser.once('Page.loadEventFired');
        await page.browser.send('Page.navigate', { url: `http://127.0.0.1:${page.port}${pathname}` });
        const won = await Promise.race([loaded.then(() => true), sleep(10000).then(() => false)]);
        if (!won) process.stdout.write(`⚠️ 导航没有等到 load 事件（10s 上界）：${pathname}\n`);
        await page.evaluate('document.readyState');
      };
      const probeControl = (elementId) => page.evaluate(`(() => {
        const svg = document.querySelector('svg');
        const base = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const scale = base.width / vb.width;
        const el = document.querySelector('[data-el-id="' + ${JSON.stringify(elementId)} + '"]');
        if (el === null) return { canvas: { w: vb.width, h: vb.height }, control: null };
        const r = el.getBoundingClientRect();
        return { canvas: { w: vb.width, h: vb.height }, control: { x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, w: r.width / scale, h: r.height / scale } };
      })()`);

      const screenProbe = {};
      const anchorElements = new Map();
      for (const transition of transitions) {
        const elementId = validate.anchorElementId(transition.from?.anchor?.selector ?? null);
        anchorElements.set(transition.id, elementId);
        if (elementId === null) continue;
        // ⚠️ 一个屏可以有好几个不同的锚点控件（main 上就是「设置」与「问题」页签两个）⇒ 键里带上元素 id，
        //    别只按屏缓存（那会把第二条转移的控件盒子错量成第一条的）。
        const probeKey = `${transition.from.screen}::${elementId}`;
        if (screenProbe[probeKey] !== undefined) continue;
        await navigate(`/screen-${transition.from.screen}.svg`);
        screenProbe[probeKey] = await probeControl(elementId);
      }

      const keys = [...new Set(transitions.flatMap((transition) => [`${transition.from.screen}@@${transition.from.state}`, `${transition.to.screen}@@${transition.to.state}`]))];
      await navigate('/flow.svg');
      const flowProbe = await page.evaluate(`(() => {
        const svg = document.querySelector('svg');
        const base = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const scale = base.width / vb.width;
        const userRect = (r) => ({ x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, w: r.width / scale, h: r.height / scale });
        const keys = ${JSON.stringify(keys)};
        const nodes = {};
        for (const key of keys) {
          const el = document.querySelector('.designer-flow-node[data-node-key="' + key + '"] rect');
          nodes[key] = el ? userRect(el.getBoundingClientRect()) : null;
        }
        const paths = [...document.querySelectorAll('path.designer-arrow')].map((p) => {
          const total = p.getTotalLength();
          const start = p.getPointAtLength(0);
          const end = p.getPointAtLength(total);
          return { id: p.getAttribute('data-transition'), d: p.getAttribute('d'), start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
        });
        const labels = [...document.querySelectorAll('.designer-arrow-label')].map((label) => {
          const r = label.getBoundingClientRect();
          const centre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          const id = label.getAttribute('data-transition');
          const path = [...document.querySelectorAll('path.designer-arrow')].find((item) => item.getAttribute('data-transition') === id);
          let best = Infinity;
          if (path) {
            const total = path.getTotalLength();
            for (let i = 0; i <= 240; i += 1) {
              const point = path.getPointAtLength((total * i) / 240);
              best = Math.min(best, Math.hypot(base.left + point.x - centre.x, base.top + point.y - centre.y));
            }
          }
          return { id, distance: Number.isFinite(best) ? Math.round(best * 100) / 100 : null };
        });
        return { nodes, paths, labels };
      })()`);

      const probedIds = flowProbe.paths.map((item) => item.id).sort();
      check('anchor:arrow-backing', '箭头的 `data-transition` 与文档里的 transitions 一一对应（图上有、数据里没有 ⇒ 不可能）',
        JSON.stringify(probedIds) === JSON.stringify([...transitionIds].sort()) && !flowProbe.paths.some((item) => !item.id),
        `图 ${JSON.stringify(probedIds)} / 文档 ${JSON.stringify([...transitionIds].sort())}`);

      const edgeFailures = [];
      const centreFailures = [];
      const endFailures = [];
      const readings = [];
      for (const transition of transitions) {
        const fromKey = `${transition.from.screen}@@${transition.from.state}`;
        const toKey = `${transition.to.screen}@@${transition.to.state}`;
        const fromNode = flowProbe.nodes[fromKey];
        const toNode = flowProbe.nodes[toKey];
        const measured = flowProbe.paths.find((item) => item.id === transition.id);
        const elementId = anchorElements.get(transition.id);
        const screen = elementId === null ? null : screenProbe[`${transition.from.screen}::${elementId}`];
        const control = screen?.control ?? null;
        // 起点/终点这两条**与「有没有量到控件」无关**（缺锚点时它们正是要红的读者）⇒ 先算，别被 `continue` 跳过。
        if (!fromNode || !toNode || !measured) {
          edgeFailures.push(`${transition.id}：量不到（节点/箭头缺一个：node=${Boolean(fromNode)}/${Boolean(toNode)} path=${Boolean(measured)}）`);
          continue;
        }
        const fromCentre = centreOf(fromNode);
        const target = centreOf(toNode);
        if (isZero(measured.start.x - fromCentre.x) && isZero(measured.start.y - fromCentre.y)) centreFailures.push(`${transition.id}：起点仍是 from 节点中心 ${JSON.stringify(fromCentre)}`);
        if (!close(measured.end.x, target.x) || !close(measured.end.y, target.y)) endFailures.push(`${transition.id}：终点 ${JSON.stringify(measured.end)} ≠ 目标节点中心 ${JSON.stringify(target)}`);
        if (!screen || !control) {
          edgeFailures.push(`${transition.id}：量不到锚点控件盒子（锚点 selector 认不出或不在 from 屏里；读到的 control=${control === null ? 'null' : JSON.stringify(control)}）`);
          continue;
        }
        const mapped = mapControlIntoNode(control, screen.canvas, fromNode);
        const expected = edgePointToward(mapped, target);
        const onEdge = onBoundaryOf(measured.start, mapped);
        if (!onEdge || !close(measured.start.x, expected.x) || !close(measured.start.y, expected.y)) edgeFailures.push(`${transition.id}：起点 ${JSON.stringify(measured.start)} 不在控件盒子（映进节点框后 ${JSON.stringify(mapped)}；应为 ${JSON.stringify(expected)}）朝目标那一侧的边上`);
        readings.push({
          id: transition.id,
          anchor: elementId === null ? null : `#${elementId}`,
          controlBoxOnScreen: { x: Math.round(control.x * 1000) / 1000, y: Math.round(control.y * 1000) / 1000, w: Math.round(control.w * 1000) / 1000, h: Math.round(control.h * 1000) / 1000 },
          mappedControlBox: mapped,
          measuredStart: measured.start,
          nodeCentre: fromCentre,
          startMinusNodeCentre: { x: Math.round((measured.start.x - fromCentre.x) * 1000) / 1000, y: Math.round((measured.start.y - fromCentre.y) * 1000) / 1000 },
          expectedStart: expected,
        });
      }
      check('anchor:start-on-control-edge', '每根箭头的**真实起点**（`getPointAtLength(0)`）都落在「那个控件在屏 SVG 里量到的盒子」按**逐轴比例**映进**量到的节点框**之后朝目标那一侧的**边**上',
        transitions.length > 0 && edgeFailures.length === 0, edgeFailures.length === 0 ? `${transitions.length} 条都落在控件盒子的边上` : edgeFailures.join('；'));
      check('anchor:start-not-node-centre', '每根箭头的起点**都不再是** from 节点中心（实测起点 ≠ 节点中心）',
        transitions.length > 0 && centreFailures.length === 0, centreFailures.length === 0 ? `${transitions.length} 条都不在节点中心` : centreFailures.join('；'));
      check('anchor:end-at-target-centre', '每根箭头的**终点仍是**目标节点中心（换起点没有动终点）',
        transitions.length > 0 && endFailures.length === 0, endFailures.length === 0 ? `${transitions.length} 条终点都在目标节点中心` : endFailures.join('；'));

      const worstLabel = flowProbe.labels.length === 0 ? Infinity : Math.max(...flowProbe.labels.map((entry) => (entry.distance === null ? Infinity : entry.distance)));
      check('anchor:label-on-own-path', `换了起点之后，标签仍然贴在**它自己那条线**上（标签盒中心到那条 path 的最近距离 ≤ ${LABEL_MAX_PX}px，实测最大 ${worstLabel}）`,
        flowProbe.labels.length === transitions.length && flowProbe.labels.every((entry) => entry.distance !== null && entry.distance <= LABEL_MAX_PX),
        JSON.stringify(flowProbe.labels));

      process.stdout.write(`实测量：${JSON.stringify(readings, null, 1)}\n`);
    } else {
      process.stdout.write('（真源不合法 ⇒ 跳过渲染/几何那几条；上面 `anchor:doc-valid` 已经红了）\n');
    }

    process.stdout.write(`\n──── test/designer-sample-anchor.mjs：${failures.length === 0 ? '全部绿' : `${failures.length} 条红`} ────\n`);
    if (failures.length > 0) process.stdout.write(`红的：${JSON.stringify(failures)}\n`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (page) await page.close(problems);
    await removeSandbox(sandbox, problems, 'designer-sample-anchor 沙箱');
    for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
    if (primaryError) {
      process.stderr.write(`主错误：${primaryError.stack ?? primaryError.message}\n`);
      process.exitCode = 1;
    } else {
      if (failures.length === 0 && problems.length === 0) process.stdout.write('RESULT: designer sample anchor PASS\n');
      process.exitCode = failures.length === 0 && problems.length === 0 ? 0 : 1;
    }
  }
}
