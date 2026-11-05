#!/usr/bin/env node
// test/designer-export.mjs —— 导出器的**真浏览器**门：导出的 HTML / SVG 在真 Chromium 里量出来的几何，
// 必须等于**文档里的数**（`getBoundingClientRect`），而且**一个外部请求都不许发**。
//
// 它守的是什么（一句话）：`designer/` 那两条导出实现（HTML 用 CSS flex/grid、SVG 用自己的小布局引擎）
// 是**两份独立实现**；本门拿**同一组期望数字**（从文档语义算出来的，写在下面 `GEOMETRY` 表里，算式写在 why）
// 分别量它们 ⇒ 两条路必须对同一份文档说同一件事，否则就是其中一条把语义翻错了。
//
// 断言组：
//   ① 自由布局：子元素的实测（相对屏的原点）== `box` 里的数（逐条）；
//   ② 尺寸三档：`fixed` == value；`fill` == 父容器内容区（column 里 240-2*12=216 / 320-2*12=296；
//      row 里 280-2*10-60-12=188）；`content` == 文字本身量出来的宽（Range），且**不等于** fill 的那个数；
//   ③ row/column/grid 的 gap / padding / 列宽：逐个格位的数；
//   ④ 样式与 token：`getComputedStyle` 量出来的颜色/字号/字重/圆角/边框/对齐 == 文档里写的（含别名链）；
//   ⑤ **零外部请求**：CDP 网络层收一次完整加载的全部请求 URL —— 只许是本机服务与 data:；
//   ⑥ SVG 与 HTML **说同一件事**：同一组元素在两边的实测盒子逐项相等；
//   ⑦ 转移图：每根箭头的 `data-transition` 都在文档的 `transitions` 里、一根不多一根不少
//      （「图上有、数据里没有」不可能发生）；**标签**贴在自己那条线上（中心到那条 path ≤ 18px）、
//      互不重叠（逐对相交面积为 0）、有不透明底、层在所有连线之上；
//   ⑧ PNG：真浏览器截一张导出的 HTML，断言是合法 PNG 且尺寸 == 视口。
//   ⑨ F1 叠层：`free` 容器里的**容器**孩子也要被绝对定位 —— 拿一份「遮罩盖住页面」的文档，
//      用 `elementFromPoint` 采样实测遮罩真的压在页面之上（并核同一形状的兄弟：`row` 里的嵌套容器）。
//   ⑩ **「改前」那一份必红**：从**钉死的提交**（`692f33c` = 修复合进 master 之前）用
//      `git show <rev>:designer/*` 造一份副本，同一份探针文档再量一次 —— F1 那条（`lfix:before-bug`）
//      与标签位置那条（`flowlabel:before-overlap`）在改前**必须红**。这就是修复的牙：
//      改前那一版只活在历史里，这里随时能再造一次（造法与 `design/samples/f1-flow-before/evidence.mjs` 共用）。
//
// 反证臂（各自必红；改的都是 `designer/` 的**副本**，真目录一个字节不动）——
//   ⚠️ 前四条改**文件**，第五条只改**环境变量**（`SOPHO_DESIGNER_BEFORE_COMMIT`，不碰任何文件）：
//   npm run test:designerexport:reverse-fill   —— 把 `fill` 当 `fixed` 处理 ⇒ ②的 fill 那几条必红
//   npm run test:designerexport:reverse-arrow  —— 凭空画一根箭头（不经 `transitions`）⇒ ⑦必红
//   npm run test:designerexport:reverse-container  —— 把 F1 的修复拿掉（free 里的容器孩子不绝对定位）⇒ ⑨必红
//   npm run test:designerexport:reverse-labels     —— 把转移图的标签全画到同一个点 ⇒ ⑦的标签那两条必红
//   npm run test:designerexport:reverse-beforeafter —— 把「改前」当成改后那份（拿修复合并点当「改前」）⇒ ⑩必红
// 臂的做法：把 `designer/` 拷一份、按锚点改一行（或只换一个环境变量）、**用同一个门再跑一遍**（子进程），
// 断言「预期的那几条确实红了」（不是「红没红都算对」）。
//
// 用法：CHROME_BIN='C:/Users/user/AppData/Local/Chromium/Application/chrome.exe' node test/designer-export.mjs
//
// 沙箱纪律：真 Chromium 走 `test/ui-harness.mjs` 的 `boot()`（它自己管私有 TMPDIR/home/XDG 与收尾）、
// 高位随机端口、只按本次 spawn 的 pid 停；临时 web 根与改过的 `designer/` 副本都落在自己的沙箱里、
// 用 `test/harness.mjs` 的 `removeSandbox` 收（绝不用 pkill）。

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { removeSandbox } from './harness.mjs';
import { boot } from './ui-harness.mjs';
// 「改前」副本的**唯一一处**造法：`git show <BEFORE_COMMIT>:designer/*` 写进沙箱。同一个函数也被
// `design/samples/f1-flow-before/evidence.mjs`（可单独跑、可复跑的证据脚本）用 —— 门与证据共用一条出处，
// 免得两边各写一份「改前」造法、日后各说各话。
import { BEFORE_COMMIT, FIXED_MERGE_COMMIT, materializeBeforeCopy } from '../design/samples/f1-flow-before/evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const THIS_FILE = path.join(here, 'designer-export.mjs');
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const DESIGNER_ROOT = path.resolve(process.env.SOPHO_DESIGNER_ROOT || path.join(root, 'designer'));
const VIEWPORT = { width: 1200, height: 760 };
const EPSILON = 0.01;
/** 标签盒中心到「它自己那条路径」的最大允许距离（px）—— 实现里的 `FLOW_LABEL.offset = 16`，这一格就是门里的 N。 */
const LABEL_MAX_PX = 18;

const failures = [];
const problems = [];
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
function check(id, name, ok, detail) {
  if (ok) {
    process.stdout.write(`✓ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
    return true;
  }
  failures.push(id);
  process.stdout.write(`✗ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  return false;
}

// ── 期望几何（**从文档语义算出来的数**，写在这里当判据；不是从导出物里读回来的）────────────────────
const GEOMETRY = [
  // ① 自由布局：box 逐字
  { screen: 'home', id: 'home-title', x: 16, y: 12, w: 200, h: 24, why: 'free + box 逐字', svgBox: false },
  { screen: 'home', id: 'home-card', x: 16, y: 48, w: 160, h: 60, why: 'free + box 逐字' },
  { screen: 'home', id: 'home-input', x: 16, y: 120, w: 160, h: 28, why: 'free + box 逐字' },
  { screen: 'home', id: 'home-button', x: 188, y: 120, w: 80, h: 28, why: 'free + box 逐字' },
  { screen: 'settings', id: 'settings-panel', x: 20, y: 20, w: 240, h: 160, why: 'free + box 逐字' },
  { screen: 'settings', id: 'settings-row-a', x: 32, y: 32, w: 216, h: 32, why: 'x/y = 20+padding12；w fill = 240-2*12 = 216；h fixed 32' },
  { screen: 'settings', id: 'settings-row-b', x: 32, y: 72, w: 216, h: 32, why: 'y = 32+32(上一行)+gap8 = 72；w 同 fill' },
  { screen: 'settings', id: 'settings-hint', x: 32, y: 112, w: null, h: null, why: 'y = 72+32+8 = 112；w/h 是 content，由文字决定（下面单独量）', svgBox: false },
  { screen: 'wide', id: 'wide-panel', x: 10, y: 10, w: 320, h: 100, why: 'free + box 逐字' },
  { screen: 'wide', id: 'wide-row-a', x: 22, y: 22, w: 296, h: 32, why: 'w fill = 320-2*12 = 296（与 settings 那条差 80 == 父容器差 80）' },
  { screen: 'grid', id: 'grid-panel', x: 10, y: 10, w: 280, h: 180, why: 'free + box 逐字' },
  { screen: 'grid', id: 'grid-a', x: 20, y: 20, w: 125, h: 40, why: '列宽 = (280-2*10-10)/2 = 125；原点 10+padding10' },
  { screen: 'grid', id: 'grid-b', x: 155, y: 20, w: 125, h: 40, why: 'x = 20 + 125 + gap10' },
  { screen: 'grid', id: 'grid-c', x: 20, y: 70, w: 125, h: 40, why: 'y = 20 + 40 + gap10' },
  { screen: 'grid', id: 'grid-d', x: 155, y: 70, w: 125, h: 40, why: '第二列第二行' },
  { screen: 'row', id: 'row-panel', x: 10, y: 10, w: 280, h: 100, why: 'free + box 逐字' },
  { screen: 'row', id: 'row-fixed', x: 20, y: 20, w: 60, h: 40, why: 'w fixed 60；原点 10+padding10' },
  { screen: 'row', id: 'row-fill', x: 92, y: 20, w: 188, h: 40, why: 'w fill = 280-2*10 - 60 - gap12 = 188；x = 20+60+12' },
];

const SCREENS = ['home', 'settings', 'wide', 'grid', 'row'];
const STAGE = { home: [400, 300], settings: [400, 300], wide: [400, 300], grid: [300, 200], row: [300, 120] };

/** 每个元素的文字（`text` 字段；没写就不在表里）—— 默认树与状态树一起走。 */
function textMap(doc) {
  const map = new Map();
  const walk = (element) => {
    if (element.text !== undefined) map.set(element.id, element.text);
    for (const child of element.children ?? []) walk(child);
  };
  for (const screen of doc.screens) {
    walk(screen.root);
    for (const state of screen.states ?? []) if (state.root) walk(state.root);
  }
  return map;
}

/** 要导出哪些「一棵树」：每屏的默认树（`screens[].root`）＋ 每个「有自己树的状态」（`states[j].root`）。
    键 `${屏}@@${状态}` 与转移图里的节点键同一套写法。 */
function expectedViews(doc) {
  const views = [];
  for (const screen of doc.screens) {
    const states = Array.isArray(screen.states) ? screen.states : [];
    views.push({ key: `${screen.id}@@${states[0]?.id ?? 'default'}`, screen, tree: screen.root, state: states[0] ?? null });
    for (const state of states.slice(1)) {
      if (state.root === undefined) continue;
      views.push({ key: `${screen.id}@@${state.id}`, screen, tree: state.root, state });
    }
  }
  return views;
}

const treeElementCount = (tree, walker) => {
  let count = 0;
  walker(tree, () => { count += 1; });
  return count;
};

/** 每个视图的元素个数（文档里那棵树的节点数；两条实现都要画全）。 */
function elementCounts(doc) {
  const counts = new Map();
  const walk = (element, visit) => { visit(element); for (const child of element.children ?? []) walk(child, visit); };
  for (const view of expectedViews(doc)) counts.set(view.key, treeElementCount(view.tree, walk));
  return counts;
}

// ── 叠层探针文档（F1）──────────────────────────────────────────────────────────────────────────
// 「遮罩盖住页面」的形状：root(free) 有两个**容器**孩子 —— 页面本体 `page` 与遮罩 `mask`，两层都写
// `box(0,0,400,300)`（后写的遮罩该压在前面那层上）。
//   修前：容器孩子在 free 里被补了一条 `position:relative`（同一属性后写的赢）⇒ 退回正常流、两层**竖着堆**
//         （mask 实测 y=300），`elementFromPoint` 在遮罩范围内命中的是下面的页面本体。
//   修后：两层都在 y=0，遮罩真的压在页面上（门用 `elementFromPoint` 采样实测，不是看代码）。
// 屏 `nested` 是同一形状的**兄弟**：`row` 容器里的嵌套容器**必须**留着 `position:relative`，否则它自己那棵
// 自由布局子树里的 `box` 会一路找到 `.designer-screen`，落点全错（这一条保证修复没有把 relative 一起拿掉）。
const LAYERS_DOC = {
  $schema: 'https://sopho.invalid/schema/designer/0.1.0.json',
  version: '0.1.0',
  name: '叠层探针',
  tokens: {},
  screens: [
    {
      id: 'overlay',
      name: '叠层',
      states: [{ id: 'default', name: '默认' }],
      root: {
        id: 'overlay-root',
        type: 'container',
        size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } },
        layout: { mode: 'free' },
        children: [
          {
            id: 'page',
            type: 'container',
            box: { x: 0, y: 0, w: 400, h: 300 },
            layout: { mode: 'column', gap: 0, padding: 0 },
            style: { background: '#ffffff' },
            children: [
              { id: 'page-title', type: 'text', size: { w: { mode: 'fill' }, h: { mode: 'fixed', value: 40 } }, style: { color: '#111111', fontSize: 16 }, text: '页面本体' },
              { id: 'page-body', type: 'rect', size: { w: { mode: 'fill' }, h: { mode: 'fill' } }, style: { background: '#eeeeee' } },
            ],
          },
          {
            id: 'mask',
            type: 'container',
            box: { x: 0, y: 0, w: 400, h: 300 },
            layout: { mode: 'free' },
            style: { background: 'rgba(0,0,0,0.5)' },
            children: [
              { id: 'mask-panel', type: 'rect', box: { x: 120, y: 100, w: 160, h: 100 }, style: { background: '#ffffff' } },
            ],
          },
        ],
      },
    },
    {
      id: 'nested',
      name: '嵌套容器',
      states: [{ id: 'default', name: '默认' }],
      root: {
        id: 'nested-root',
        type: 'container',
        size: { w: { mode: 'fixed', value: 300 }, h: { mode: 'fixed', value: 260 } },
        layout: { mode: 'free' },
        children: [
          {
            id: 'nested-row',
            type: 'container',
            box: { x: 50, y: 180, w: 200, h: 60 },
            layout: { mode: 'row', gap: 10, padding: 0 },
            style: { background: '#dddddd' },
            children: [
              { id: 'nested-spacer', type: 'rect', size: { w: { mode: 'fixed', value: 60 }, h: { mode: 'fill' } }, style: { background: '#cccccc' } },
              {
                id: 'nested-cell',
                type: 'container',
                size: { w: { mode: 'fill' }, h: { mode: 'fill' } },
                layout: { mode: 'free' },
                children: [
                  { id: 'nested-leaf', type: 'rect', box: { x: 10, y: 10, w: 50, h: 20 }, style: { background: '#ff0000' } },
                ],
              },
            ],
          },
        ],
      },
    },
  ],
  transitions: [],
};

// ── 反证臂 ────────────────────────────────────────────────────────────────────────────────────
const ARM_SPECS = {
  'fill-as-fixed': {
    file: 'toHtml.mjs',
    anchor: "  if (parentMode === 'row' || parentMode === 'column') {\n    const isMain = (parentMode === 'row') === (axis === 'w');\n    return isMain ? [['flex', '1 1 0'], [AXIS_PROP[axis], 'auto']] : [['align-self', 'stretch']];\n  }\n  return [[axis === 'w' ? 'justify-self' : 'align-self', 'stretch']];",
    replace: "  return [[AXIS_PROP[axis], '0px']]; // 反证臂：整段 fill 语义换成「一个确定的数」（当一个 fixed 处理）",
    why: '把 fill 当 fixed 处理',
    expectRed: ['geo:settings/settings-row-a', 'geo:wide/wide-row-a', 'geo:row/row-fill', 'svg-vs-html:settings/settings-row-a'],
  },
  'hardcoded-arrow': {
    file: 'toSvg.mjs',
    anchor: '  const arrowParts = [];',
    replace: "  const arrowParts = [];\n  arrowParts.push('<path class=\"designer-arrow\" d=\"M 0 0 L 40 40\" fill=\"none\" stroke=\"#b00020\" stroke-width=\"1.5\"/>'); // 反证臂：凭空画一根箭头（不经 transitions）",
    why: '不经 transitions 直接画一根箭头',
    expectRed: ['flow:arrow-count', 'flow:arrow-backed'],
  },
  'container-relative-in-free': {
    file: 'toHtml.mjs',
    anchor: "      if (parentMode !== 'free') declarations.push(['position', 'relative']);",
    replace: "      declarations.push(['position', 'relative']); // 反证臂：把 F1 的修复拿掉（free 里的容器孩子也补 relative）",
    why: '把 F1 的修复拿掉（回到「free 里的容器孩子不被绝对定位」）',
    expectRed: ['lfix:absolute-box', 'lfix:elementfrompoint'],
  },
  'labels-one-point': {
    file: 'toSvg.mjs',
    anchor: 'function labelCandidatesAlong(geometry) {',
    replace: 'function labelCandidatesAlong(geometry) {\n  return [{ x: 0, y: 0 }]; // 反证臂：把所有标签画到同一个点',
    why: '把转移图的标签全画到同一个点',
    expectRed: ['flow:label-on-own-path', 'flow:label-no-overlap'],
  },
  // 这条臂**不改文件**：它换的是「改前取哪个提交」这个环境变量 —— 把「改前」故意造错（造出改后那份）。
  // 若下面两条 `*:before-*` 在「改前 == 改后」时还绿，它们就是假断言（红没红都算对）。
  'before-copy-is-after': {
    env: { SOPHO_DESIGNER_BEFORE_COMMIT: FIXED_MERGE_COMMIT },
    why: `把「改前」当成改后那份（用修复合并点 \`${FIXED_MERGE_COMMIT}\` 当「改前」）`,
    expectRed: ['lfix:before-bug', 'flowlabel:before-overlap'],
  },
};

if (ARM) {
  const spec = ARM_SPECS[ARM];
  if (!spec) {
    process.stderr.write(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_SPECS).join(', ')}）\n`);
    process.exit(2);
  }
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'designer-export-arm-'));
  print('反证臂', `${ARM} —— ${spec.why}（${spec.file ? `改的是 designer/ 的**副本**：${sandbox}` : '改的是**环境变量**、不碰任何文件'}）`);
  const env = { ...process.env, ...spec.env };
  if (spec.file) {
    const mutantRoot = path.join(sandbox, 'designer');
    await cp(DESIGNER_ROOT, mutantRoot, { recursive: true });
    const target = path.join(mutantRoot, spec.file);
    const original = await readFile(target, 'utf8');
    if (!original.includes(spec.anchor)) throw new Error(`反证臂锚点在 ${spec.file} 里找不到了（源码变了吗？）：${JSON.stringify(spec.anchor)}`);
    const mutated = original.replace(spec.anchor, spec.replace);
    if (mutated === original) throw new Error('反证臂的改写没生效（一个字节没变）');
    await writeFile(target, mutated, 'utf8');
    env.SOPHO_DESIGNER_ROOT = mutantRoot;
  }
  const child = spawnSync(process.execPath, [THIS_FILE], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const redIds = [...(child.stdout ?? '').matchAll(/^✗ \[([^\]]+)\]/gm)].map((match) => match[1]);
  const missing = spec.expectRed.filter((id) => !redIds.includes(id));
  process.stdout.write(`\n──── 反证臂 ${ARM}：预期红 ${JSON.stringify(spec.expectRed)} / 实际红 ${JSON.stringify(redIds)}（子进程 exit=${child.status}）────\n`);
  for (const id of spec.expectRed) process.stdout.write(`  ${redIds.includes(id) ? '红' : '没红'}：[${id}]\n`);
  const ok = child.status !== 0 && missing.length === 0;
  process.stdout.write(ok
    ? `✓ 反证臂 ${ARM} 红到位（${spec.why} ⇒ 预期的那几条都红了；真 designer/ 一个字节没动）\n`
    : `✗ 反证臂 ${ARM} **没红到位**：缺 ${JSON.stringify(missing)}（子进程 exit=${child.status}）⇒ 这道门是个假门\n`);
  if (!ok) process.stdout.write(`${(child.stdout ?? '').split('\n').filter((line) => line.startsWith('✗')).join('\n')}\n`);
  await removeSandbox(sandbox, problems, 'designer-export 反证臂沙箱');
  for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
  process.exitCode = ok && problems.length === 0 ? 0 : 1;
} else {
  // ── 正常跑：渲染 → 真浏览器量 → 断言 ──────────────────────────────────────────────────────────
  const designer = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toHtml.mjs')).href);
  const svg = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toSvg.mjs')).href);
  const canonical = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'canonical.mjs')).href);
  const validate = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'validate.mjs')).href);
  const doc = JSON.parse(await readFile(path.join(DESIGNER_ROOT, 'fixtures', 'demo.json'), 'utf8'));
  const report = validate.validateDocument(doc, { source: 'designer/fixtures/demo.json' });
  if (!report.ok) {
    process.stderr.write(`${validate.formatReport(report)}\n`);
    process.exit(3);
  }
  if (DESIGNER_ROOT !== path.join(root, 'designer')) print('designer 根', `${DESIGNER_ROOT}（⚠️ 不是仓库里那一份）`);

  const TEXTS = textMap(doc);
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'designer-export-'));
  const webRoot = path.join(sandbox, 'web');
  await mkdir(webRoot, { recursive: true });
  const source = 'designer/fixtures/demo.json';
  const html = designer.renderDocumentHtml(doc, { viewport: VIEWPORT, source });
  const flowSvg = svg.renderFlowSvg(doc, { source });
  const screenSvgs = new Map(SCREENS.map((id) => [id, svg.renderScreenSvg(doc, id, { viewport: VIEWPORT, source })]));
  // 有自己那棵树的状态（`states[j].root`）各一张：文件名字与导出器一致（`…screen.<屏>.<状态>.svg`）
  const stateViews = expectedViews(doc).filter((view) => view.key.split('@@')[1] !== 'default');
  const stateSvgs = new Map(stateViews.map((view) => [view.key, svg.renderScreenSvg(doc, view.screen.id, { viewport: VIEWPORT, state: view.state.id, source })]));
  await writeFile(path.join(webRoot, 'index.html'), html, 'utf8');
  await writeFile(path.join(webRoot, 'demo.html'), html, 'utf8');
  await writeFile(path.join(webRoot, 'demo.flow.svg'), flowSvg, 'utf8');
  const layersHtml = designer.renderDocumentHtml(LAYERS_DOC, { viewport: VIEWPORT, source: 'test/designer-export.mjs:layers' });
  await writeFile(path.join(webRoot, 'layers.html'), layersHtml, 'utf8');
  // ── 「改前」副本（F1 ＋ 标签位置那两条修复之前的 `designer/`）────────────────────────────────────
  // 从**钉死的提交** `git show <rev>:designer/*` 写进本门自己的沙箱 —— 真 `designer/` 一个字节不动。
  // 同一份探针文档分别喂「改前」「改后」两条实现 ⇒ 下面 `lfix:before-bug` / `flowlabel:before-overlap`
  // 断「那条判据在改前**必红**」（这就是修复的牙，不是「红没红都算对」）。
  // `SOPHO_DESIGNER_BEFORE_COMMIT` 是给反证臂留的口子：把它指到改后那份，这两条就必须红。
  const beforeCommit = process.env.SOPHO_DESIGNER_BEFORE_COMMIT || BEFORE_COMMIT;
  const beforeDir = path.join(sandbox, 'before-designer');
  await materializeBeforeCopy(beforeDir, { commit: beforeCommit });
  const beforeHtml = await import(pathToFileURL(path.join(beforeDir, 'toHtml.mjs')).href);
  const beforeSvg = await import(pathToFileURL(path.join(beforeDir, 'toSvg.mjs')).href);
  const layersBeforeHtml = beforeHtml.renderDocumentHtml(LAYERS_DOC, { viewport: VIEWPORT, source: `before(${beforeCommit}):layers` });
  const flowBeforeSvg = beforeSvg.renderFlowSvg(doc, { source: `before(${beforeCommit})` });
  await writeFile(path.join(webRoot, 'layers-before.html'), layersBeforeHtml, 'utf8');
  for (const [id, text] of screenSvgs) await writeFile(path.join(webRoot, `demo.screen.${id}.svg`), text, 'utf8');
  for (const [key, text] of stateSvgs) await writeFile(path.join(webRoot, `demo.screen.${key.replace('@@', '.')}.svg`), text, 'utf8');

  const served = [];
  let page = null;
  let primaryError = null;
  try {
    // SVG 必须用 `image/svg+xml` 端上去：`ui-harness` 的静态兜底不认 .svg（走 octet-stream ⇒
    // 浏览器会**下载**它而不是渲染 ⇒ 页面不会导航、量不到东西）。这一层是本门自己的路由，
    // 一个字都不改共享底座。
    const svgFiles = new Map([
      ['/demo.flow.svg', flowSvg],
      ['/flow-before.svg', flowBeforeSvg],
      ...SCREENS.map((id) => [`/demo.screen.${id}.svg`, screenSvgs.get(id)]),
      ...[...stateSvgs].map(([key, text]) => [`/demo.screen.${key.replace('@@', '.')}.svg`, text]),
    ]);
    page = await boot({
      routes: async (request, response, url) => {
        served.push(url.pathname);
        const text = svgFiles.get(url.pathname);
        if (text === undefined) return false;
        const body = Buffer.from(text, 'utf8');
        response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
        response.end(body);
        return true;
      },
      webRoot,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const navigate = async (pathname) => {
      const loaded = page.browser.once('Page.loadEventFired');
      await page.browser.send('Page.navigate', { url: `http://127.0.0.1:${page.port}${pathname}` });
      const won = await Promise.race([loaded.then(() => true), sleep(10000).then(() => false)]);
      if (!won) print('⚠️ 导航没有等到 load 事件（10s 上界）', pathname);
      await page.evaluate('document.readyState');
    };

    // ⑤ 一次完整加载的**全部**请求 URL（CDP 网络层；collector 递归注册，事件不丢）
    const requests = [];
    await page.browser.send('Network.enable');
    const collect = () => page.browser.once('Network.requestWillBeSent').then((params) => { requests.push(params.request.url); return collect(); });
    collect();
    await navigate('/index.html');

    // ①②③ 自由布局 / 三档尺寸 / gap·padding·列宽 —— 先在 HTML 一次量全（相对各屏 stage 的原点）
    const htmlBox = await page.evaluate(`(() => {
      const out = { stages: {}, stageList: [], elements: {}, missing: [] };
      for (const stage of document.querySelectorAll('.designer-screen')) {
        const id = stage.getAttribute('data-screen-id');
        const state = stage.getAttribute('data-state');
        const base = stage.getBoundingClientRect();
        const ids = [...stage.querySelectorAll('[data-el-id]')].map((el) => el.getAttribute('data-el-id'));
        out.stageList.push({ screen: id, state, w: base.width, h: base.height, ids });
        if (state === 'default') out.stages[id] = { w: base.width, h: base.height };
        for (const el of stage.querySelectorAll('[data-el-id]')) {
          const r = el.getBoundingClientRect();
          out.elements[el.getAttribute('data-el-id')] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
        }
      }
      return out;
    })()`);
    const close = (a, b) => Math.abs(a - b) <= EPSILON;
    const boxOk = (measured, expected) => measured !== undefined && measured !== null
      && close(measured.x, expected.x) && close(measured.y, expected.y)
      && (expected.w === null || close(measured.w, expected.w))
      && (expected.h === null || close(measured.h, expected.h));
    const show = (measured) => (measured === undefined || measured === null ? '(量不到)' : JSON.stringify(measured));

    for (const screen of SCREENS) {
      const stage = htmlBox.stages[screen];
      const [w, h] = STAGE[screen];
      check(`stage:${screen}`, `屏 ${screen} 的画布尺寸 == root 的 fixed 尺寸（${w}×${h}）`,
        Boolean(stage) && close(stage.w, w) && close(stage.h, h), stage ? `${stage.w}×${stage.h}` : '(没有这个 stage)');
    }

    // ③b 状态树：多出来的那几节 = 每个「有自己那棵树」的状态；画的是**它自己那棵树**（不是默认那棵）
    const viewKeys = expectedViews(doc).map((view) => view.key);
    const stageKeys = htmlBox.stageList.map((stage) => `${stage.screen}@@${stage.state}`);
    check('states:stage-set', '页面上的节 == 每屏的默认树（1 节）＋ 每个有自己那棵树的状态（各 1 节）—— 不多不少',
      JSON.stringify([...stageKeys].sort()) === JSON.stringify([...viewKeys].sort()),
      `页面 ${JSON.stringify(stageKeys)} / 期望 ${JSON.stringify(viewKeys)}`);
    const treeIds = (root) => { const ids = []; const walk = (el) => { ids.push(el.id); for (const child of el.children ?? []) walk(child); }; walk(root); return ids; };
    const stateChecks = stateViews.map((view) => {
      const stage = htmlBox.stageList.find((item) => item.screen === view.screen.id && item.state === view.state.id);
      const expectedIds = treeIds(view.tree);
      const defaultStage = htmlBox.stageList.find((item) => item.screen === view.screen.id && item.state === 'default');
      const overlap = defaultStage ? expectedIds.filter((id) => defaultStage.ids.includes(id)) : [];
      return { view, stage, expectedIds, overlap };
    });
    check('states:tree-used', '状态那一节里的元素 id == 那个状态自己那棵树（不是默认那棵），且与默认树的 id 零重叠',
      stateChecks.length > 0 && stateChecks.every((item) => item.stage !== undefined
        && JSON.stringify([...item.stage.ids].sort()) === JSON.stringify([...item.expectedIds].sort()) && item.overlap.length === 0),
      stateChecks.map((item) => `${item.view.key}：id=${JSON.stringify(item.stage?.ids ?? null)} / 期望 ${JSON.stringify(item.expectedIds)} / 与默认树重叠 ${JSON.stringify(item.overlap)}`).join('｜') || '没有状态树（不合预期：demo.json 带一个）');
    const STATE_GEOMETRY = [
      { id: 'home-loading-hint', x: 16, y: 12, w: 240, h: 24, why: '状态树 · free + box 逐字', svgBox: false },
      { id: 'home-loading-bar', x: 16, y: 48, w: 368, h: 8, why: '状态树 · free + box 逐字' },
    ];
    for (const entry of STATE_GEOMETRY) {
      check(`geo-state:${entry.id}`, `状态树里的 ${entry.id}：HTML 实测 == 文档算出来的（${entry.why}）`,
        boxOk(htmlBox.elements[entry.id], entry), `HTML 实测 ${show(htmlBox.elements[entry.id])}`);
    }

    // SVG：每屏导出的那一个 .svg 都在真浏览器里量一遍（量出来的是 SVG 坐标系里的落点）
    const svgBox = {};
    for (const screen of SCREENS) {
      await navigate(`/demo.screen.${screen}.svg`);
      svgBox[screen] = await page.evaluate(`(() => {
        const root = document.querySelector('svg');
        const base = root.getBoundingClientRect();
        const vb = root.getAttribute('viewBox').split(/\\s+/).map(Number);
        const out = { scale: base.width / vb[2], elements: {}, texts: {} };
        for (const el of document.querySelectorAll('[data-el-id]')) {
          const id = el.getAttribute('data-el-id');
          if (el.tagName.toLowerCase() === 'text') { out.texts[id] = el.textContent; continue; }
          if (out.elements[id]) continue;
          const r = el.getBoundingClientRect();
          out.elements[id] = { x: (r.left - base.left) / out.scale, y: (r.top - base.top) / out.scale, w: r.width / out.scale, h: r.height / out.scale };
        }
        return out;
      })()`);
    }
    for (const screen of SCREENS) {
      check(`svg-scale:${screen}`, `导出的屏 SVG（${screen}）在浏览器里是 1:1 渲染的（否则下面量出来的数没有意义）`,
        close(svgBox[screen].scale, 1), `scale=${svgBox[screen].scale}`);
    }

    for (const entry of GEOMETRY) {
      const htmlMeasured = htmlBox.elements[entry.id];
      const svgMeasured = svgBox[entry.screen]?.elements[entry.id];
      const expectedText = `{x:${entry.x},y:${entry.y},w:${entry.w},h:${entry.h}}`;
      check(`geo:${entry.screen}/${entry.id}`, `${entry.screen} · ${entry.id}：HTML 实测 == 文档算出来的 ${expectedText}（${entry.why}）`,
        boxOk(htmlMeasured, entry), `HTML 实测 ${show(htmlMeasured)}`);
      if (entry.svgBox === false) {
        // `text` 型元素在 SVG 里是 <text>：它没有「盒子」，只有字形（ink）的包围盒 ——
        // 拿几何盒子去量它本来就不对。改断「它被画出来了，而且文字就是文档里那句」。
        check(`svg:${entry.screen}/${entry.id}`, `SVG · ${entry.id}：<text> 型没有盒子（只有字形包围盒）⇒ 改断「文字就是文档里那句」`,
          svgBox[entry.screen].texts[entry.id] === TEXTS.get(entry.id),
          `SVG 里的文字=${JSON.stringify(svgBox[entry.screen].texts[entry.id])} / 文档=${JSON.stringify(TEXTS.get(entry.id))}`);
        continue;
      }
      check(`svg:${entry.screen}/${entry.id}`, `SVG · ${entry.id}：实测 == 同一组期望（两条独立实现对同一份语义）`,
        boxOk(svgMeasured, entry), `SVG 实测 ${show(svgMeasured)}`);
      check(`svg-vs-html:${entry.screen}/${entry.id}`, `SVG 与 HTML 对 ${entry.id} 说同一件事（逐项相等）`,
        Boolean(htmlMeasured && svgMeasured) && ['x', 'y', 'w', 'h'].every((axis) => close(htmlMeasured[axis], svgMeasured[axis])),
        `HTML ${show(htmlMeasured)} / SVG ${show(svgMeasured)}`);
    }

    // ③b 状态 SVG（真浏览器里量那张独立文档）：画的是那棵状态树，不是默认那棵
    const svgState = {};
    for (const view of stateViews) {
      await navigate(`/demo.screen.${view.key.replace('@@', '.')}.svg`);
      svgState[view.key] = await page.evaluate(`(() => {
        const root = document.querySelector('svg');
        const base = root.getBoundingClientRect();
        const vb = root.getAttribute('viewBox').split(/\\s+/).map(Number);
        const scale = base.width / vb[2];
        const out = { scale, state: root.getAttribute('data-designer-state'), ids: [], elements: {}, texts: [] };
        for (const el of document.querySelectorAll('[data-el-id]')) {
          const id = el.getAttribute('data-el-id');
          if (!out.ids.includes(id)) out.ids.push(id);
          if (el.tagName.toLowerCase() === 'text') { out.texts.push(el.textContent); continue; }
          const r = el.getBoundingClientRect();
          out.elements[id] = { x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, w: r.width / scale, h: r.height / scale };
        }
        return out;
      })()`);
    }
    const stateSvgReport = stateChecks.map(({ view, expectedIds }) => {
      const measured = svgState[view.key];
      const stateText = TEXTS.get(expectedIds.at(1) ?? expectedIds[0]) ?? '';
      return {
        key: view.key,
        state: measured?.state,
        ids: JSON.stringify([...measured?.ids ?? []].sort()),
        expected: JSON.stringify([...expectedIds].sort()),
        stateText,
        defaultSvgHasStateText: screenSvgs.get(view.screen.id)?.includes(stateText) ?? false,
        geoOk: STATE_GEOMETRY.filter((entry) => entry.svgBox !== false).every((entry) => boxOk(measured?.elements?.[entry.id], entry)),
      };
    });
    check('states:svg', '每个状态各一张 SVG：`data-designer-state` == 那个状态、`data-el-id` 集 == 那棵树、几何还是文档里的数、文字就是那棵树的文字',
      stateSvgReport.length > 0 && stateSvgReport.every((item) => item.state === item.key.split('@@')[1] && item.ids === item.expected && item.geoOk),
      stateSvgReport.map((item) => `${item.key}：state=${item.state}｜ids ${item.ids}（期望 ${item.expected}）｜几何 ${item.geoOk ? '对' : '不对'}`).join('；') || '没有状态 SVG');
    check('states:svg-distinct', '状态 SVG 与同一屏的默认 SVG 是**两份不同产物**（默认那张里没有状态树的文字）',
      stateSvgReport.length > 0 && stateSvgReport.every((item) => item.defaultSvgHasStateText === false && item.stateText !== ''),
      stateSvgReport.map((item) => `${item.key}：默认图含状态文字=${item.defaultSvgHasStateText}｜状态文字=${JSON.stringify(item.stateText)}`).join('；'));

    // ② `content`：宽高 == 那段文字自己量出来的宽高（而且**不是** fill 会给出的 216）
    await navigate('/index.html');
    const contentProbe = await page.evaluate(`(() => {
      const el = document.querySelector('[data-el-id="settings-hint"]');
      if (!el) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { boxWidth: box.width, boxHeight: box.height, textWidth: r.width, textHeight: r.height, lineHeight: parseFloat(getComputedStyle(el).lineHeight), text: el.textContent };
    })()`);
    check('geo:settings/hint-content', 'settings-hint（w/h 都是 content）：宽 == 它那段文字量出来的 advance 宽；高 == 一行行盒（computed line-height）；而且宽 != 216（216 是 fill 会给的数）',
      contentProbe !== null && close(contentProbe.boxWidth, contentProbe.textWidth) && close(contentProbe.boxHeight, contentProbe.lineHeight) && !close(contentProbe.boxWidth, 216),
      `盒子 ${contentProbe?.boxWidth}×${contentProbe?.boxHeight} / 文字宽 ${contentProbe?.textWidth} / line-height ${contentProbe?.lineHeight}｜文字=${JSON.stringify(contentProbe?.text)}`);

    // ④ 样式与 token（含别名链 --fg-muted ⇒ --fg）
    const styles = await page.evaluate(`(() => {
      const pick = (id) => { const el = document.querySelector('[data-el-id="' + id + '"]'); if (!el) return null; const cs = getComputedStyle(el); return { color: cs.color, background: cs.backgroundColor, borderRadius: cs.borderRadius, borderWidth: cs.borderTopWidth, borderStyle: cs.borderTopStyle, fontSize: cs.fontSize, fontWeight: cs.fontWeight, textAlign: cs.textAlign }; };
      return { title: pick('home-title'), card: pick('home-card'), button: pick('home-button'), hint: pick('settings-hint'), input: pick('home-input') };
    })()`);
    check('style:token-color', 'home-title 的 color 经 token 解析成 --fg 的值（#e6e6e6 ⇒ rgb(230, 230, 230)）',
      styles?.title?.color === 'rgb(230, 230, 230)', `${styles?.title?.color}`);
    check('style:token-alias', 'settings-hint 的 color 经**别名链**（--fg-muted ⇒ --fg）解析成同一个值',
      styles?.hint?.color === 'rgb(230, 230, 230)', `${styles?.hint?.color}`);
    check('style:card', 'home-card：background=--card 的值、borderRadius=8px、borderWidth=1px/solid（逐项 getComputedStyle）',
      styles?.card?.background === 'rgb(21, 23, 27)' && styles?.card?.borderRadius === '8px' && styles?.card?.borderWidth === '1px' && styles?.card?.borderStyle === 'solid',
      JSON.stringify(styles?.card));
    check('style:title-type', 'home-title：fontSize=20px、fontWeight=700（文档里的数原样落到 CSS）',
      styles?.title?.fontSize === '20px' && styles?.title?.fontWeight === '700', `fontSize=${styles?.title?.fontSize} fontWeight=${styles?.title?.fontWeight}`);
    check('style:button-align', 'home-button：textAlign=center',
      styles?.button?.textAlign === 'center', `${styles?.button?.textAlign}`);
    check('style:input-value', 'home-input（真 <input readonly>）：value == 文档里的 text（元素种类落到真控件，几何仍由 box 决定）',
      styles?.input?.borderWidth === '0px' && await page.evaluate("document.querySelector('[data-el-id=\"home-input\"]').value") === '搜索',
      `borderWidth=${styles?.input?.borderWidth}｜value=${JSON.stringify(await page.evaluate("document.querySelector('[data-el-id=\"home-input\"]').value"))}`);

    // ⑤ 零外部请求
    const localPrefix = `http://127.0.0.1:${page.port}/`;
    const external = requests.filter((url) => !url.startsWith(localPrefix) && !url.startsWith('data:') && !url.startsWith('about:'));
    check('net:no-external', '一次完整加载的全部请求都是本机服务（没有一个外部 URL）',
      external.length === 0, `请求 ${requests.length} 个：${JSON.stringify(requests)}${external.length ? `｜外部：${JSON.stringify(external)}` : ''}`);
    const resourceEntries = await page.evaluate("performance.getEntriesByType('resource').map(e => e.name)");
    check('net:no-resource-entries', '页面的 resource 计时条目里也没有外部 URL（第二种口径）',
      resourceEntries.every((url) => url.startsWith(localPrefix) || url.startsWith('data:')), JSON.stringify(resourceEntries));
    const textual = [/@import/, /@font-face/, /<link\b/, /<script\b/, /\bsrc\s*=\s*["']?https?:/, /href\s*=\s*["']?https?:/, /url\(\s*["']?https?:/];
    const hits = textual.filter((pattern) => pattern.test(html)).map((pattern) => String(pattern));
    check('net:no-external-text', '导出的 HTML 里没有任何外链写法（@import / @font-face / <link> / <script> / http(s) 的 src·href·url()）',
      hits.length === 0, `命中的模式：${JSON.stringify(hits)}`);

    // ⑦ 转移图：箭头一根不少、一根不多，且每根都挂着一个**文档里真实存在**的转移 id
    await navigate('/demo.flow.svg');
    const flow = await page.evaluate(`(() => {
      const svg = document.querySelector('svg');
      const root = svg.getBoundingClientRect();
      const paths = [...document.querySelectorAll('path.designer-arrow')];
      const labelEls = [...document.querySelectorAll('.designer-arrow-label')];
      const order = [...svg.querySelectorAll('*')];
      const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      const distanceToPath = (label, path) => {
        const r = label.getBoundingClientRect();
        const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const total = path.getTotalLength();
        let best = Infinity;
        for (let i = 0; i <= 200; i += 1) {
          const p = path.getPointAtLength((total * i) / 200);
          best = Math.min(best, Math.hypot(root.left + p.x - center.x, root.top + p.y - center.y));
        }
        return Math.round(best * 100) / 100;
      };
      return {
        arrowCount: paths.length,
        withTransition: paths.filter((a) => a.getAttribute('data-transition')).map((a) => a.getAttribute('data-transition')),
        without: paths.filter((a) => !a.getAttribute('data-transition')).length,
        labels: labelEls.map((t) => t.getAttribute('data-transition')),
        nodes: [...document.querySelectorAll('.designer-flow-node')].map((n) => n.getAttribute('data-node-key')),
        labelBoxes: labelEls.map((label) => ({ id: label.getAttribute('data-transition'), ...rectOf(label) })),
        labelDistances: labelEls.map((label) => {
          const path = paths.find((p) => p.getAttribute('data-transition') === label.getAttribute('data-transition'));
          return { id: label.getAttribute('data-transition'), distance: path ? distanceToPath(label, path) : null };
        }),
        labelBackgrounds: labelEls.map((label) => {
          const bg = label.querySelector('.designer-arrow-label-bg');
          if (!bg) return null;
          const cs = getComputedStyle(bg);
          return { fill: cs.fill, fillOpacity: cs.fillOpacity, opacity: cs.opacity };
        }),
        labelLayerIsLast: (() => { const layer = svg.querySelector('.designer-flow-labels'); return Boolean(layer && svg.lastElementChild === layer); })(),
        labelsAfterAllPaths: labelEls.length > 0 && Math.min(...labelEls.map((l) => order.indexOf(l))) > Math.max(...paths.map((p) => order.indexOf(p))),
      };
    })()`);
    const transitionIds = doc.transitions.map((transition) => transition.id).sort();
    const arrowIds = [...flow.withTransition].sort();
    check('flow:arrow-count', '箭头根数 == 文档里 transitions 的条数（图上有、数据里没有 ⇒ 不可能）',
      flow.arrowCount === doc.transitions.length, `箭头 ${flow.arrowCount} 根 / transitions ${doc.transitions.length} 条`);
    check('flow:arrow-backed', '每根箭头都带一个**文档里真实存在**的 data-transition（没有凭空画的箭头）',
      flow.without === 0 && arrowIds.length === transitionIds.length && arrowIds.every((id, index) => id === transitionIds[index]),
      `带 id 的箭头 ${JSON.stringify(arrowIds)} / 无 id 的箭头 ${flow.without} 根 / 文档 ${JSON.stringify(transitionIds)}`);
    const expectedNodes = doc.screens.flatMap((screen) => {
      const states = screen.states?.length ? screen.states : [{ id: 'default' }];
      return states.map((state) => `${screen.id}@@${state.id}`);
    }).sort();
    const nodeKeys = [...flow.nodes].sort();
    check('flow:nodes', '节点数 == 屏×状态（每个 (屏,状态) 一个节点，键就是 transition 两端指的那个键）',
      JSON.stringify(nodeKeys) === JSON.stringify(expectedNodes), `节点 ${JSON.stringify(nodeKeys)} / 期望 ${JSON.stringify(expectedNodes)}`);
    check('flow:labels', '每根箭头都有它那句话（trigger 是箭头的文字，不是平台事件名）',
      JSON.stringify([...flow.labels].sort()) === JSON.stringify(transitionIds), `标签 ${JSON.stringify([...flow.labels].sort())}`);

    // ⑦b 转移图的标签：贴在自己那条线上、互不重叠、有不透明底、层在连线之上（业主 2026-09-28 报的两条）
    const areaOf = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    let flowLabelPairs = 0;
    let flowLabelWorstOverlap = 0;
    for (let i = 0; i < flow.labelBoxes.length; i += 1) {
      for (let j = i + 1; j < flow.labelBoxes.length; j += 1) {
        flowLabelPairs += 1;
        flowLabelWorstOverlap = Math.max(flowLabelWorstOverlap, areaOf(flow.labelBoxes[i], flow.labelBoxes[j]));
      }
    }
    const flowLabelWorstDistance = Math.max(...flow.labelDistances.map((entry) => (entry.distance === null ? Infinity : entry.distance)));
    check('flow:label-on-own-path', `转移图里每个标签都贴在**它自己那条线**上：标签盒中心到**那条** path（200 点采样）的最近距离 ≤ ${LABEL_MAX_PX}px（实测最大 ${flowLabelWorstDistance}）`,
      flow.labelDistances.length === doc.transitions.length && flow.labelDistances.every((entry) => entry.distance !== null && entry.distance <= LABEL_MAX_PX),
      JSON.stringify({ max: flowLabelWorstDistance, each: flow.labelDistances }));
    check('flow:label-no-overlap', `转移图里任意两个标签的矩形不相交（逐对算相交面积，${flowLabelPairs} 对全为 0）—— 同一区域里的标签是**沿路径错开**的，不是叠在一处`,
      flowLabelPairs >= 1 && flowLabelWorstOverlap === 0,
      JSON.stringify({ pairs: flowLabelPairs, worstOverlap: flowLabelWorstOverlap, boxes: flow.labelBoxes }));
    check('flow:label-opaque', '转移图里每个标签都有**不透明底**：`.designer-arrow-label-bg` 的 computed fill 是实色，且 fill × fill-opacity × opacity 的 alpha == 1',
      flow.labelBackgrounds.length === doc.transitions.length
      && flow.labelBackgrounds.every((entry) => entry !== null && entry.fill.startsWith('rgb') && Number(entry.fillOpacity) === 1 && Number(entry.opacity) === 1),
      JSON.stringify(flow.labelBackgrounds));
    check('flow:label-layer', '层序是一条写死的规则「屏卡 < 连线 < 标签」：全部箭头 path 都在标签之前（SVG 的绘制顺序 = 文档顺序），且标签组是 SVG 的**最后一个**子节点',
      flow.labelLayerIsLast && flow.labelsAfterAllPaths,
      JSON.stringify({ labelLayerIsLast: flow.labelLayerIsLast, labelsAfterAllPaths: flow.labelsAfterAllPaths }));

    // ⑨ F1 叠层：`free` 容器里的**容器**孩子也要被绝对定位（真 Chromium 的 elementFromPoint 采样）
    await navigate('/layers.html');
    const layers = await page.evaluate(`(() => {
      const out = { stages: {}, hits: [] };
      for (const stage of document.querySelectorAll('.designer-screen')) {
        const base = stage.getBoundingClientRect();
        const boxes = {};
        for (const el of stage.querySelectorAll('[data-el-id]')) {
          const r = el.getBoundingClientRect();
          boxes[el.getAttribute('data-el-id')] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
        }
        out.stages[stage.getAttribute('data-screen-id')] = boxes;
      }
      const overlay = document.querySelector('.designer-screen[data-screen-id="overlay"]');
      if (overlay) {
        const base = overlay.getBoundingClientRect();
        out.hits = [[350, 250], [200, 150], [10, 10]].map(([x, y]) => {
          const hit = document.elementFromPoint(base.left + x, base.top + y);
          const owner = hit ? hit.closest('[data-el-id]') : null;
          return { x, y, hitId: owner ? owner.getAttribute('data-el-id') : null };
        });
      }
      return out;
    })()`);
    const boxEquals = (measured, expected) => Boolean(measured)
      && close(measured.x, expected.x) && close(measured.y, expected.y) && close(measured.w, expected.w) && close(measured.h, expected.h);
    const overlayBoxes = layers.stages.overlay ?? {};
    check('lfix:absolute-box', 'F1 · 遮罩与页面本体两层都写 `box(0,0,400,300)`：实测**两层都在 y=0**（容器孩子真被绝对定位，不是退回正常流竖着堆）',
      boxEquals(overlayBoxes.mask, { x: 0, y: 0, w: 400, h: 300 }) && boxEquals(overlayBoxes.page, { x: 0, y: 0, w: 400, h: 300 }),
      JSON.stringify({ mask: overlayBoxes.mask ?? null, page: overlayBoxes.page ?? null }));
    check('lfix:elementfrompoint', 'F1 · 遮罩真的压在页面之上：在遮罩范围内采 3 个点，`elementFromPoint` 命中的都是**遮罩那棵树**里的元素（不是下面的页面本体）',
      layers.hits.length === 3 && layers.hits.every((entry) => entry.hitId === 'mask' || entry.hitId === 'mask-panel'),
      JSON.stringify(layers.hits));
    const nestedBoxes = layers.stages.nested ?? {};
    check('lfix:nested-container-relative', 'F1 的兄弟：`row` 容器里的**嵌套容器**必须留着 `position:relative` —— 嵌套容器自己那棵自由布局子树里的 `box` 要相对它（不是相对屏）落：实测 nested-leaf == (50+60+10)+10, 180+10',
      boxEquals(nestedBoxes['nested-leaf'], { x: 130, y: 190, w: 50, h: 20 }),
      JSON.stringify({ nestedLeaf: nestedBoxes['nested-leaf'] ?? null }));

    // ⑩ 「改前」那一份：同一条判据**必须红**（F1 ＋ 标签位置两条修复的牙）。
    //    「改前」= 从钉死提交 `git show <rev>:designer/toHtml.mjs` / `toSvg.mjs` 造的副本；探针文档与上面同一份。
    await navigate('/layers-before.html');
    const layersBefore = await page.evaluate(`(() => {
      const out = { stages: {}, hits: [] };
      for (const stage of document.querySelectorAll('.designer-screen')) {
        const base = stage.getBoundingClientRect();
        const boxes = {};
        for (const el of stage.querySelectorAll('[data-el-id]')) {
          const r = el.getBoundingClientRect();
          boxes[el.getAttribute('data-el-id')] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
        }
        out.stages[stage.getAttribute('data-screen-id')] = boxes;
      }
      const overlay = document.querySelector('.designer-screen[data-screen-id="overlay"]');
      if (overlay) {
        const base = overlay.getBoundingClientRect();
        out.hits = [[350, 250], [200, 150]].map(([x, y]) => {
          const hit = document.elementFromPoint(base.left + x, base.top + y);
          const owner = hit ? hit.closest('[data-el-id]') : null;
          return { x, y, hitId: owner ? owner.getAttribute('data-el-id') : null };
        });
      }
      return out;
    })()`);
    const overlayBefore = layersBefore.stages.overlay ?? {};
    check('lfix:before-bug', `F1 的**改前**副本（\`git show ${beforeCommit.slice(0, 7)}:designer/toHtml.mjs\`）测出来是**坏的**：遮罩被顶到页面下面（mask.y=300）、\`elementFromPoint\` 命中下面那层页面本体 ⇒ 同一条判据在改前必红（这就是修复的牙）`,
      boxEquals(overlayBefore.mask, { x: 0, y: 300, w: 400, h: 300 }) && layersBefore.hits.length === 2 && layersBefore.hits.every((entry) => entry.hitId === 'page-body'),
      JSON.stringify({ mask: overlayBefore.mask ?? null, hits: layersBefore.hits }));
    await navigate('/flow-before.svg');
    const flowBeforeProbe = await page.evaluate(`(() => {
      const boxes = [...document.querySelectorAll('.designer-arrow-label')].map((label) => { const r = label.getBoundingClientRect(); return { id: label.getAttribute('data-transition'), x: r.left, y: r.top, w: r.width, h: r.height }; });
      const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      let worst = 0;
      for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) worst = Math.max(worst, area(boxes[i], boxes[j]));
      return { count: boxes.length, worstOverlap: Math.round(worst * 100) / 100, boxes };
    })()`);
    check('flowlabel:before-overlap', `标签位置的**改前**副本（\`git show ${beforeCommit.slice(0, 7)}:designer/toSvg.mjs\`）测出来有标签**完全叠在一处**（最大相交面积 = ${flowBeforeProbe.worstOverlap} > 0；改后这一条是 ${flowLabelWorstOverlap}）⇒ 同一条判据在改前必红（这就是修复的牙）`,
      flowBeforeProbe.count === doc.transitions.length && flowBeforeProbe.worstOverlap > 0,
      JSON.stringify({ count: flowBeforeProbe.count, worstOverlap: flowBeforeProbe.worstOverlap, boxes: flowBeforeProbe.boxes }));

    // ⑧ PNG：真浏览器截一张导出的 HTML
    await navigate('/demo.html');
    const shotPath = path.join(sandbox, 'demo.png');
    await page.screenshot(shotPath);
    const png = await readFile(shotPath);
    const isPng = png.length > 24 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const width = isPng ? png.readUInt32BE(16) : null;
    const height = isPng ? png.readUInt32BE(20) : null;
    check('png:screenshot', `真 Chromium 把导出的 HTML 截成了合法 PNG，且尺寸 == 视口（${VIEWPORT.width}×${VIEWPORT.height}）`,
      isPng && width === VIEWPORT.width && height === VIEWPORT.height, `${png.length} B｜PNG=${isPng}｜${width}×${height}`);

    // ⑥ 每个元素都画出来了 + 导出物嵌的文档摘要 == 当前文档的摘要
    const counts = elementCounts(doc);
    const htmlCounts = Object.fromEntries(htmlBox.stageList.map((stage) => [`${stage.screen}@@${stage.state}`, stage.ids.length]));
    check('art:all-elements-html', '导出的 HTML 里每个视图（屏·状态）都画全了元素（个数 == 文档里那棵树的节点数）',
      [...counts.keys()].every((key) => htmlCounts[key] === counts.get(key)),
      [...counts.keys()].map((key) => `${key}: ${htmlCounts[key]}/${counts.get(key)}`).join('｜'));
    // SVG 里 button/input 会画两笔（rect ＋ text），text 只画一笔 ⇒ 这里的期望个数要把那两笔算进去
    const svgMarks = (tree) => { let marks = 0; const walk = (element) => { marks += (element.type === 'button' || element.type === 'input') ? 2 : 1; for (const child of element.children ?? []) walk(child); }; walk(tree); return marks; };
    const views = expectedViews(doc);
    const svgCountReport = views.map((view) => {
      const text = view.key.split('@@')[1] === 'default' ? screenSvgs.get(view.screen.id) : stateSvgs.get(view.key);
      return { key: view.key, marks: (text.match(/data-el-id="/g) ?? []).length, expected: svgMarks(view.tree) };
    });
    check('art:all-elements-svg', '每张 SVG（包括状态那几张）的元素笔数 == 该视图应有笔数（button/input 各两笔，其余一笔）',
      svgCountReport.every((item) => item.marks === item.expected),
      svgCountReport.map((item) => `${item.key}: ${item.marks}/${item.expected}`).join('｜'));
    // 产物文件名集合：直接跑一次**真 CLI** 应该看到什么 —— 门自己算的期望与真脚本写的逐项对上
    const cliOut = path.join(sandbox, 'cli-out');
    const cliRun = spawnSync(process.execPath, [path.join(DESIGNER_ROOT, 'export.mjs'), `--doc=${path.join(DESIGNER_ROOT, 'fixtures', 'demo.json')}`, `--out=${cliOut}`], { encoding: 'utf8' });
    const cliFiles = (await readdir(cliOut).catch(() => [])).sort();
    const expectedFiles = ['demo.json', 'demo.html', 'demo.flow.svg',
      ...SCREENS.map((id) => `demo.screen.${id}.svg`),
      ...stateViews.map((view) => `demo.screen.${view.key.replace('@@', '.')}.svg`)].sort();
    check('art:files', '导出器 CLI 写出来的文件集合 == 该有的那几份（中立 JSON ＋ HTML ＋ 转移图 ＋ 每屏一张 ＋ 有自己那棵树的状态各一张，不多不少）',
      cliRun.status === 0 && JSON.stringify(cliFiles) === JSON.stringify(expectedFiles),
      `exit=${cliRun.status}｜盘上 ${JSON.stringify(cliFiles)} / 期望 ${JSON.stringify(expectedFiles)}`);
    const digest = canonical.docDigest(doc);
    const htmlDigest = await page.evaluate("document.querySelector('meta[name=\"designer-doc-digest\"]').getAttribute('content')");
    check('art:digest-html', 'HTML 里嵌的文档摘要 == 当前文档规范字节的 sha256（「这份导出物对应哪一版文档」可判）',
      htmlDigest === `sha256:${digest}`, `${htmlDigest}`);
    const svgDigests = [...SCREENS.map((screen) => screenSvgs.get(screen)), ...stateSvgs.values()].filter((text) => text.includes(`sha256:${digest}`));
    check('art:digest-svg', '每张屏 SVG（含状态那张）与转移图里嵌的文档摘要也是同一个 sha256',
      svgDigests.length === SCREENS.length + stateSvgs.size && flowSvg.includes(`sha256:${digest}`), `${svgDigests.length}/${SCREENS.length + stateSvgs.size}`);
    print('本机服务真的被请求过的路径', served.reduce((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {}));
    print('CDP 收到的请求 URL', requests);

    process.stdout.write(`\n──── test/designer-export.mjs：${failures.length === 0 ? '全部绿' : `${failures.length} 条红`} ────\n`);
    if (failures.length > 0) process.stdout.write(`红的：${JSON.stringify(failures)}\n`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (page) await page.close(problems);
    await removeSandbox(sandbox, problems, 'designer-export 沙箱');
    for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
    if (primaryError) {
      process.stderr.write(`主错误：${primaryError.stack ?? primaryError.message}\n`);
      process.exitCode = 1;
    } else {
      if (failures.length === 0 && problems.length === 0) process.stdout.write('RESULT: designer export PASS\n');
      process.exitCode = failures.length === 0 && problems.length === 0 ? 0 : 1;
    }
  }
}
