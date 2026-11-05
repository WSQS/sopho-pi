#!/usr/bin/env node
// test/designer-anchor-flow.mjs —— 「转移图里箭头的**起点**取那个**具体控件**的盒子边」这条判据的门（真 Chromium）。
//
// 它守的是什么（一句话）：转移的 `from` 端带可选 `anchor.selector` 时，那根箭头的起点必须落在
// **那个控件在转移图坐标系里的盒子**朝向目标那一侧的**边**上；没带 anchor 的转移**一个字节不变**。
//
// 判据（都在真浏览器里量）：
//   ① 夹具文档合法；两条转移的箭头 `data-transition` 与文档一一对应（图上有、数据里没有 ⇒ 不可能）。
//   ①b **坏锚点是文档错**（与「转移两端指得到」同一口径）：选择器写法不认识 / 指不到元素 ⇒ 校验器拒收
//      （可粘回的 path），过 CLI ⇒ 退码 3 且 `--out` 里一个字节都不写。
//   ② **不带 anchor** 的那根：整张 SVG 与「改前那一版实现」（钉死提交 `PRE_COMMIT`，`git show` 进沙箱）
//      对同一份**去掉 anchor 的文档**渲染出来的结果**逐字节相同** —— 这就是「向后兼容、今天不变」。
//   ③ 带 anchor 的那根：起点 == **实测**控件盒子（从 `/screen-left.svg` 真 Chromium 量）按**逐轴比例**
//      映进节点框（节点框也从真 SVG 量）之后、朝目标节点中心那条射线穿出盒子的那个点；且这条起点的
//      改动**只影响它自己那根**箭头的 `d`（另一根、节点、标签都不动）；终点仍是目标节点中心。
//   ④ 标签仍然贴在**它自己那条线**上（≤ 18px）—— 换起点不许把标签规则带坏。
//
// 反证臂（必红；改的是 `designer/` 的**副本**，真目录一个字节不动）：
//   npm run test:designeranchor:reverse-noanchor —— 把「读 `from.anchor`」那一步去掉
//     ⇒ 起点退回节点中心 ⇒ ②③ 里那几条必红（证明这条判据有牙）。
//
// 用法：CHROME_BIN='...' node test/designer-anchor-flow.mjs
//
// 沙箱纪律：真 Chromium 走 `test/ui-harness.mjs` 的 `boot()`（自己管私有 TMPDIR/home/XDG 与收尾）、
// 高位随机端口、只按本次 spawn 的 pid 停；临时 web 根与 `designer/` 副本都落在自己的沙箱里、
// 用 `test/harness.mjs` 的 `removeSandbox` 收（绝不用 pkill）。

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { removeSandbox } from './harness.mjs';
import { boot } from './ui-harness.mjs';
// 「改前」副本的唯一造法（与 `test/designer-export.mjs` / 证据脚本共用一条出处）。
import { materializeBeforeCopy } from '../design/samples/f1-flow-before/evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const THIS_FILE = path.join(here, 'designer-anchor-flow.mjs');
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const DESIGNER_ROOT = path.resolve(process.env.SOPHO_DESIGNER_ROOT || path.join(root, 'designer'));
const FIXTURE = path.join(here, 'fixtures', 'designer-anchor.json');
/** 「改前」= 本笔（读 `from.anchor`）之前的主干提交（`git rev-parse HEAD` 于开笔时 = 派单基点）。 */
const PRE_COMMIT = 'd14291e83a96ef9298f2782eb324c2389a56f1ba';
/** 起点那条判据的容差（px）：实现里 `num()` 保留 3 位小数，实测点也在同一量级。 */
const EPSILON = 0.02;
/** 与 `test/designer-export.mjs` 同一条上界：标签中心到它自己那条路径的最大允许距离。 */
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

const ANCHOR_LINE = '    const geometry = arrowGeometryOf(from, to, anchorBoxOf(doc, transition, from, viewport));';
const ARM_SPECS = {
  'no-anchor': {
    file: 'toSvg.mjs',
    anchor: ANCHOR_LINE,
    replace: '    const geometry = arrowGeometryOf(from, to, null); // 反证臂 no-anchor：不读 from.anchor',
    why: '把「读 `from.anchor`」那一步去掉（起点退回节点中心）',
    expectRed: ['anchor:start-on-control-edge', 'anchor:start-not-node-centre', 'anchor:svg-differs-only-in-anchored-path'],
  },
};

const close = (a, b) => Math.abs(a - b) <= EPSILON;
const isZero = (value) => Math.abs(value) <= EPSILON;
/** 从导出文本里取某条转移那根箭头的 `d`（属性顺序由 `renderFlowSvg` 定：class → data-transition → …）。 */
const pathDOf = (text, id) => {
  const match = new RegExp(`<path class="designer-arrow" data-transition="${id}"[^>]*\\bd="([^"]*)"`).exec(text);
  return match === null ? null : match[1];
};
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
/** 点是否落在盒子边界上（四条边里有一条贴住，且点在盒子范围内）。 */
const onBoundaryOf = (point, box) => {
  const inX = point.x >= box.x - EPSILON && point.x <= box.x + box.w + EPSILON;
  const inY = point.y >= box.y - EPSILON && point.y <= box.y + box.h + EPSILON;
  if (!inX || !inY) return false;
  return close(point.x, box.x) || close(point.x, box.x + box.w) || close(point.y, box.y) || close(point.y, box.y + box.h);
};

if (ARM) {
  const spec = ARM_SPECS[ARM];
  if (!spec) {
    process.stderr.write(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_SPECS).join(', ')}）\n`);
    process.exit(2);
  }
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'designer-anchor-arm-'));
  print('反证臂', `${ARM} —— ${spec.why}（改的是 designer/ 的**副本**：${sandbox}）`);
  const mutantRoot = path.join(sandbox, 'designer');
  await cp(DESIGNER_ROOT, mutantRoot, { recursive: true });
  const target = path.join(mutantRoot, spec.file);
  const original = await readFile(target, 'utf8');
  if (!original.includes(spec.anchor)) throw new Error(`反证臂锚点在 ${spec.file} 里找不到了（源码变了吗？）：${JSON.stringify(spec.anchor)}`);
  const mutated = original.replace(spec.anchor, spec.replace);
  if (mutated === original) throw new Error('反证臂的改写没生效（一个字节没变）');
  await writeFile(target, mutated, 'utf8');
  const child = spawnSync(process.execPath, [THIS_FILE], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SOPHO_DESIGNER_ROOT: mutantRoot },
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
  await removeSandbox(sandbox, problems, 'designer-anchor 反证臂沙箱');
  for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
  process.exitCode = ok && problems.length === 0 ? 0 : 1;
} else {
  const svg = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toSvg.mjs')).href);
  const validate = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'validate.mjs')).href);
  const doc = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const report = validate.validateDocument(doc, { source: 'test/fixtures/designer-anchor.json' });
  check('anchor:doc-valid', '夹具文档（两条转移：一条带 anchor、一条不带）合法',
    report.ok, `${report.errors.length} 错 / ${report.warnings.length} 警告${report.errors.length ? `：${report.errors.map((error) => `${error.code}@${error.path}`).join(', ')}` : ''}`);
  if (!report.ok) process.exit(1);
  if (DESIGNER_ROOT !== path.join(root, 'designer')) print('designer 根', `${DESIGNER_ROOT}（⚠️ 不是仓库里那一份）`);

  // 「去掉 anchor」的那份对照文档：逐字段删掉，别的一字不动。
  const plainDoc = JSON.parse(JSON.stringify(doc));
  for (const transition of plainDoc.transitions) delete transition.from.anchor;
  const flowAnchored = svg.renderFlowSvg(doc);
  const flowPlainNew = svg.renderFlowSvg(plainDoc);

  // ①b 坏锚点 = 文档错（选择器指不到 / 写法不认识）—— 这两份拷贝共用下面那个临时落点
  const unknownSelectorDoc = JSON.parse(JSON.stringify(doc));
  unknownSelectorDoc.transitions[0].from.anchor.selector = '#nope';
  const unsupportedSelectorDoc = JSON.parse(JSON.stringify(doc));
  unsupportedSelectorDoc.transitions[0].from.anchor.selector = '.foo';

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'designer-anchor-'));
  const badAnchorSandbox = path.join(sandbox, 'bad-anchor-cli');
  const webRoot = path.join(sandbox, 'web');
  let page = null;
  let primaryError = null;
  try {
    await mkdir(badAnchorSandbox, { recursive: true });
    const unknownReport = validate.validateDocument(unknownSelectorDoc, { source: '(anchor 指不到元素)' });
    check('anchor:unknown-element-rejected', '锚点选择器指不到元素（`#nope`）⇒ **校验器就拒收**（`anchor-element-unknown`，path `transitions[0].from.anchor.selector` 可粘回），不留给导出器在渲染时才炸',
      unknownReport.ok === false && unknownReport.errors.some((error) => error.code === 'anchor-element-unknown' && error.path === 'transitions[0].from.anchor.selector'),
      JSON.stringify(unknownReport.errors.map((error) => `${error.code}@${error.path}`)));
    const unsupportedReport = validate.validateDocument(unsupportedSelectorDoc, { source: '(anchor 写法不认识)' });
    check('anchor:unsupported-selector-rejected', '不认识的写法（`.foo`）⇒ 校验器拒收（`anchor-selector-unsupported`）—— 只认 `#<元素 id>`，不猜',
      unsupportedReport.ok === false && unsupportedReport.errors.some((error) => error.code === 'anchor-selector-unsupported'),
      JSON.stringify(unsupportedReport.errors.map((error) => `${error.code}@${error.path}`)));
    const badAnchorFile = path.join(badAnchorSandbox, 'bad-anchor.json');
    await writeFile(badAnchorFile, JSON.stringify(unknownSelectorDoc, null, 2), 'utf8');
    const badAnchorOut = path.join(badAnchorSandbox, 'bad-anchor-out');
    const badAnchorRun = spawnSync(process.execPath, [path.join(DESIGNER_ROOT, 'export.mjs'), `--doc=${badAnchorFile}`, `--out=${badAnchorOut}`], { encoding: 'utf8' });
    const badAnchorFiles = await readdir(badAnchorOut).catch(() => []);
    check('anchor:cli-refused', '同一份坏锚点文档过 CLI：退码 3、`--out` 里一个字节都没写（导出物只有「全部正确」一种状态）',
      badAnchorRun.status === 3 && badAnchorFiles.length === 0,
      `exit=${badAnchorRun.status}｜out=${JSON.stringify(badAnchorFiles)}｜stderr 首行：${(badAnchorRun.stderr ?? '').split('\n')[0]}`);

    // ② 「改前那一版实现」对同一份去掉 anchor 的文档渲染 ⇒ 必须与现在逐字节相同
    const beforeDir = path.join(sandbox, 'before-designer');
    await materializeBeforeCopy(beforeDir, { commit: PRE_COMMIT });
    const beforeSvg = await import(pathToFileURL(path.join(beforeDir, 'toSvg.mjs')).href);
    const flowPlainBefore = beforeSvg.renderFlowSvg(plainDoc);
    check('anchor:plain-byte-identical-to-before', `不带 anchor 的文档：现在渲染的整张 SVG 与「改前那一版」（\`git show ${PRE_COMMIT.slice(0, 7)}:designer/toSvg.mjs\`）**逐字节相同**（${Buffer.byteLength(flowPlainNew)} B）`,
      flowPlainNew === flowPlainBefore,
      flowPlainNew === flowPlainBefore ? `sha 同值` : `字节不同：改前 ${Buffer.byteLength(flowPlainBefore)} B / 现在 ${Buffer.byteLength(flowPlainNew)} B`);

    const plainD = pathDOf(flowPlainNew, 't-plain');
    const plainDOfAnchoredId = pathDOf(flowPlainNew, 't-anchored');
    const anchoredD = pathDOf(flowAnchored, 't-anchored');
    check('anchor:plain-path-node-centre', '对照那根（不带 anchor）的 `d` 仍是老样子：起点 = from 节点中心 (122,60)、终点 = to 节点中心 (382,60)',
      plainD === 'M 122 60 L 382 60', JSON.stringify(plainD));
    check('anchor:no-anchor-path-unchanged', '同一份文档里，带 anchor 那条在**去掉 anchor 之后**也走老路（起点 = 节点中心）',
      plainDOfAnchoredId === 'M 122 60 L 382 60', JSON.stringify(plainDOfAnchoredId));
    check('anchor:anchored-path-expected', '带 anchor 那根的起点 == 控件的盒子（#left-panel，屏坐标系 20,40,80,32）按逐轴比例（节点 180×56 ÷ 屏 360×112 = 0.5）映进节点框后的右边中点 (82,60)',
      anchoredD === 'M 82 60 L 382 60', JSON.stringify(anchoredD));

    // ③ 起点那条改动**只**落在带 anchor 那根箭头的 `d` 上（节点框与对照那根箭头逐字节不动）
    // 注：两张 SVG 嵌的文档摘要本来就不同（带 anchor 的文档与去掉 anchor 的文档不是同一份）⇒ 这里比**节点段**与两根箭头。
    const nodeSectionOf = (text) => text.slice(text.indexOf('<g class="designer-flow-node"'), text.indexOf('<path class="designer-arrow"'));
    check('anchor:svg-differs-only-in-anchored-path', '两张 SVG 的**节点段**与**对照那根箭头**逐字节相同；差别只落在带 anchor 那根箭头的 `d` 上（它的标签位置跟着变，那是它自己那条线的后果，不是另一根被动过）',
      nodeSectionOf(flowAnchored) === nodeSectionOf(flowPlainNew)
      && pathDOf(flowAnchored, 't-plain') === pathDOf(flowPlainNew, 't-plain')
      && pathDOf(flowAnchored, 't-anchored') !== pathDOf(flowPlainNew, 't-anchored'),
      JSON.stringify({
        nodeSectionEqual: nodeSectionOf(flowAnchored) === nodeSectionOf(flowPlainNew),
        plainArrowEqual: pathDOf(flowAnchored, 't-plain') === pathDOf(flowPlainNew, 't-plain'),
        anchoredArrowDiffers: pathDOf(flowAnchored, 't-anchored') !== pathDOf(flowPlainNew, 't-anchored'),
      }));

    // ── 真 Chromium：从真 SVG 量控件盒子、节点框、箭头起点 ─────────────────────────────────────
    await mkdir(webRoot, { recursive: true });
    const served = new Map([
      ['/flow-anchored.svg', flowAnchored],
      ['/flow-plain.svg', flowPlainNew],
      ['/screen-left.svg', svg.renderScreenSvg(doc, 'left')],
    ]);
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><meta charset="utf-8"><title>anchor</title>', 'utf8');
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
      width: 900,
      height: 420,
    });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const navigate = async (pathname) => {
      const loaded = page.browser.once('Page.loadEventFired');
      await page.browser.send('Page.navigate', { url: `http://127.0.0.1:${page.port}${pathname}` });
      const won = await Promise.race([loaded.then(() => true), sleep(10000).then(() => false)]);
      if (!won) print('⚠️ 导航没有等到 load 事件（10s 上界）', pathname);
      await page.evaluate('document.readyState');
    };

    // 屏 SVG：量锚点控件在**屏坐标系**里的真盒子 + 画布尺寸（viewBox）
    await navigate('/screen-left.svg');
    const screenProbe = await page.evaluate(`(() => {
      const svg = document.querySelector('svg');
      const base = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const scale = base.width / vb.width;
      const el = document.querySelector('[data-el-id="left-panel"]');
      const r = el.getBoundingClientRect();
      return { canvas: { w: vb.width, h: vb.height }, panel: { x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, w: r.width / scale, h: r.height / scale } };
    })()`);

    // 转移图：量节点框、每根箭头的 `d` 与**真起点/终点**（`getPointAtLength`，用户单位 = viewBox 单位）、标签
    await navigate('/flow-anchored.svg');
    const flowProbe = await page.evaluate(`(() => {
      const svg = document.querySelector('svg');
      const base = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const scale = base.width / vb.width;
      const userRect = (r) => ({ x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, w: r.width / scale, h: r.height / scale });
      const nodeBox = (key) => { const el = document.querySelector('.designer-flow-node[data-node-key="' + key + '"] rect'); return el ? userRect(el.getBoundingClientRect()) : null; };
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
        const p = paths.find((item) => item.id === id);
        let best = Infinity;
        if (p) {
          const path = [...document.querySelectorAll('path.designer-arrow')].find((item) => item.getAttribute('data-transition') === id);
          const total = path.getTotalLength();
          for (let i = 0; i <= 200; i += 1) {
            const point = path.getPointAtLength((total * i) / 200);
            best = Math.min(best, Math.hypot(base.left + point.x - centre.x, base.top + point.y - centre.y));
          }
        }
        return { id, distance: Math.round(best * 100) / 100 };
      });
      return { scale, nodes: { left: nodeBox('left@@default'), right: nodeBox('right@@default') }, paths, labels };
    })()`);

    const transitionIds = doc.transitions.map((transition) => transition.id).sort();
    const probedIds = flowProbe.paths.map((item) => item.id).sort();
    check('anchor:arrow-backing', '箭头的 `data-transition` 与文档里的 transitions 一一对应（图上有、数据里没有 ⇒ 不可能）',
      JSON.stringify(probedIds) === JSON.stringify(transitionIds) && !flowProbe.paths.some((item) => !item.id),
      `图 ${JSON.stringify(probedIds)} / 文档 ${JSON.stringify(transitionIds)}`);

    // 期望的「控件盒子的边」：屏里量到的控件盒子，按逐轴比例映进**量到的**节点框
    const fromNode = flowProbe.nodes.left;
    const toNode = flowProbe.nodes.right;
    const mapped = {
      x: fromNode.x + screenProbe.panel.x * (fromNode.w / screenProbe.canvas.w),
      y: fromNode.y + screenProbe.panel.y * (fromNode.h / screenProbe.canvas.h),
      w: screenProbe.panel.w * (fromNode.w / screenProbe.canvas.w),
      h: screenProbe.panel.h * (fromNode.h / screenProbe.canvas.h),
    };
    const target = centreOf(toNode);
    const expected = edgePointToward(mapped, target);

    const anchoredPath = flowProbe.paths.find((item) => item.id === 't-anchored');
    const plainPath = flowProbe.paths.find((item) => item.id === 't-plain');
    const fromCentre = centreOf(fromNode);

    check('anchor:screen-panel-golden', '屏 SVG 里实测 #left-panel 的盒子 == 文档里那个盒子 (20,40,80,32)（量出来的，不是估算）',
      close(screenProbe.panel.x, 20) && close(screenProbe.panel.y, 40) && close(screenProbe.panel.w, 80) && close(screenProbe.panel.h, 32),
      JSON.stringify(screenProbe));
    check('anchor:start-on-control-edge', `带 anchor 那根的**真实起点**落在**那个控件盒子**（按逐轴比例映进节点框：x∈[${mapped.x},${(mapped.x + mapped.w).toFixed(3)}] / y∈[${mapped.y},${(mapped.y + mapped.h).toFixed(3)}]）朝向目标那一侧的**边**上`,
      anchoredPath !== undefined && onBoundaryOf(anchoredPath.start, mapped),
      JSON.stringify({ start: anchoredPath?.start, mapped, expected, onBoundary: anchoredPath ? onBoundaryOf(anchoredPath.start, mapped) : null }));
    check('anchor:start-not-node-centre', '带 anchor 那根的起点**不再是** from 节点中心（实测起点 ≠ 节点中心；对照那根仍等于节点中心）',
      anchoredPath !== undefined && plainPath !== undefined
      && !(isZero(anchoredPath.start.x - fromCentre.x) && isZero(anchoredPath.start.y - fromCentre.y))
      && close(plainPath.start.x, fromCentre.x) && close(plainPath.start.y, fromCentre.y),
      JSON.stringify({ anchoredStart: anchoredPath?.start, plainStart: plainPath?.start, nodeCentre: fromCentre }));
    check('anchor:start-equals-documented-rule', '带 anchor 那根的起点 == 「从控件盒子中心朝目标节点中心引一条射线、取它穿出盒子的那个点」这条写死的规则算出来的点（终点仍是目标节点中心）',
      anchoredPath !== undefined && close(anchoredPath.start.x, expected.x) && close(anchoredPath.start.y, expected.y)
      && close(anchoredPath.end.x, target.x) && close(anchoredPath.end.y, target.y),
      JSON.stringify({ start: anchoredPath?.start, expected, end: anchoredPath?.end, target }));
    const worstLabel = Math.max(...flowProbe.labels.map((entry) => (entry.distance === null ? Infinity : entry.distance)));
    check('anchor:label-on-own-path', `换了起点之后，标签仍然贴在**它自己那条线**上（标签盒中心到那条 path 的最近距离 ≤ ${LABEL_MAX_PX}px，实测最大 ${worstLabel}）`,
      flowProbe.labels.length === doc.transitions.length && flowProbe.labels.every((entry) => entry.distance !== null && entry.distance <= LABEL_MAX_PX),
      JSON.stringify(flowProbe.labels));

    print('实测量', JSON.stringify({
      canvas: screenProbe.canvas,
      controlBoxOnScreen: screenProbe.panel,
      nodeBox: fromNode,
      targetNodeBox: toNode,
      mappedControlBox: mapped,
      anchoredStart: anchoredPath?.start,
      plainStart: plainPath?.start,
      fromNodeCentre: fromCentre,
    }));

    process.stdout.write(`\n──── test/designer-anchor-flow.mjs：${failures.length === 0 ? '全部绿' : `${failures.length} 条红`} ────\n`);
    if (failures.length > 0) process.stdout.write(`红的：${JSON.stringify(failures)}\n`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (page) await page.close(problems);
    await removeSandbox(sandbox, problems, 'designer-anchor 沙箱');
    for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
    if (primaryError) {
      process.stderr.write(`主错误：${primaryError.stack ?? primaryError.message}\n`);
      process.exitCode = 1;
    } else {
      if (failures.length === 0 && problems.length === 0) process.stdout.write('RESULT: designer anchor PASS\n');
      process.exitCode = failures.length === 0 && problems.length === 0 ? 0 : 1;
    }
  }
}
