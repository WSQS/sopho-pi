#!/usr/bin/env node
// test/designer-ui.mjs —— 设计器 **B 半（画布与编辑 UI）** 的机械门：真 Chromium ＋ 真页面 ＋ 真鼠标。
//
// 判据出处（派单原话，工单 B）：M1＋M2 全部 —— 空白起／自由容器（拖拽移动、拖角缩放、吸附与对齐线、
// 多选与对齐）、属性面板（位置/尺寸三档、间距/内边距/对齐/列数、颜色/背景/圆角/边框/字号/字重/字体/文本对齐，
// **改属性 ⇒ 画布当场变**）、容器语义（free|row|column|grid；row/column/grid 真的用 flex/grid；
// fill 撑满、content 随内容）、多屏＋状态（每屏独立内容、每屏多个状态可分别编辑）、转移（在数据里加一条
// transition ⇒ 画布上出现箭头；改/删 ⇒ 跟着变/消失；**箭头只是视图**）、撤销/重做（多步，含屏/状态切换）、
// 导出/导入 JSON（往返**逐字节相同**）、预览（同一份文档、静态、零外部请求）。
//
// 这道门量的是什么（每一条都是**能红**的事实，不是「大概对」）：
//
//   · **DOM 实测几何 == 属性面板里的数**：面板那几个「实测」读数由 `getBoundingClientRect()` 写上去，
//     断言把它们与**画布上那一刻的矩形**逐项比（落点、拖完、缩完各比一次）。
//   · **row 排布**：切成 row ⇒ 子元素实测 y 相同、x 递增（量盒子，不是看样式表）。
//   · **fill 撑满**：唯一子元素 w=fill ⇒ 实测宽 ≈ 父容器**内容宽**（`clientWidth - padding`）。
//   · **content 随内容**：换成 content ⇒ 实测宽 > 0 且 < 父容器内容宽。
//   · **撤销/重做回到完全相同的几何**：拖前/拖后各取一次序列化字节 ＋ 实测矩形；撤销后逐项相等、重做后逐项相等；
//     另有一条「撤销没有重载页面」（撤销前后 `window` 上的标记与 `__dz` 对象身份都还在 ⇒ 未保存状态没丢）。
//   · **多屏 / 状态不串**：屏 1 的内容在切走再切回后一字不变；状态 2 里拖动 ⇒ 状态 1 的几何一字不变。
//   · **箭头由数据生成**：transitions 空 ⇒ 0 根箭头；加一条 ⇒ 1 根（带箭头 marker、端点在两张屏卡上、
//     触发文字写在箭头上）；改 to-screen ⇒ 路径跟着变；两条 ⇒ 2 根；删掉 ⇒ 少一根。
//   · **分割符（divider）是可拉伸的分隔**：工具栏放一个 ⇒ 数据里多一个 `type="divider"`、DOM 里是一个**真
//     `<hr class="dz-el-divider">`；在 row/column 容器里长边实测 ≈ 容器内容宽（容器变宽 ⇒ 它跟着变），
//     方向/粗细/颜色改一下实测跟着变；导出 HTML 里它仍是**真元素**（内联 border、没有 position:absolute）。
//   · **转移的配置界面**：流程视图里有「＋ 添加转移」⇒ 一张表单（从：屏+状态 → 到：屏+状态 → 触发）⇒
//     确定 ⇒ 箭头**立刻出现**且 `data-arrow` 就是那条数据的 id；点箭头 ⇒ 同一张表单带回原值；改触发 ⇒
//     箭头上的字跟着变；删掉 ⇒ 箭头消失；空态有一句人话；缺屏 / 从=到 一律**如实拒绝**。
//   · **往返确定**：导出 ⇒ 导入 ⇒ 再导出，两次导出**逐字节相同**（三轮都试）；下载到的字节 == 导出串；
//     复制到剪贴板的字节 == 导出串；导入一份改过的 JSON ⇒ 文档真被换掉且再导出 == 它的规范形。
//   · **复制 JSON 是三级降级**（本单；业主实测报回来的那条 `navigator.clipboard is undefined`）：正常上下文走①
//     剪贴板 API（**真剪贴板**读回 == 导出串）；在**页面脚本之前**把 `navigator.clipboard` 拿掉、
//     `window.isSecureContext` 改成 false（模拟局域网 IP ＋ 明文 HTTP）⇒ 点复制**不出现「复制失败」**、
//     退到② `document.execCommand('copy')`，**真剪贴板**里是导出串（先放的哨兵被覆盖）；再把 execCommand
//     也打死 ⇒ ③ **只读、已全选**的手动框弹出来，框里的字节 == 导出串，文案说清安全上下文 / Ctrl+C / 导出 JSON。
//   · **预览零外部请求**：开预览前挂 `PerformanceObserver`，开预览 + 关预览这一段里**没有一条** http(s)/blob
//     资源请求（占位图是内联 data URI），且预览里没有编辑器的手柄/选中框。
//
//   · **属性面板跟着父容器换语汇**（本单）：父容器 free ⇒ 「自由定位」（X/Y ＋ 尺寸三档），且**没有**容器布局那几格；
//     父容器 row/column/grid ⇒ 「自动排布」（`size` 三档 ＋ 主轴/交叉轴标注）、**整组没有** `box`（不是禁用假装的）；
//     选中容器自身 ⇒ 它的 `layout` ＋ 自己的 `size`。
//   · **竖分割符 ⇒ 两栏各自自适应**（本单，两条语义钉死并实测）：两个 `fill` 兄弟在主轴**平分剩余空间**；
//     分割符**占主轴 == thickness、不参与拉伸** ⇒ 两栏宽 ＋ 分割符宽 == 父宽；改父宽 / 改 thickness 都跟着变。
//
//   · **可编程控制面 `window.sophoDesigner`**（本单；业主：让 agent **直接在 webui 里操控编辑器、编辑节点**）：
//     用 API 建「两栏 ＋ 竖分割符 ＋ 一个按钮」⇒ 断言**画布 DOM 实测几何**与文档一致（没有第二份布局引擎）；
//     `updateNode` 改宽度 ⇒ 实测跟着变；`addTransition` ⇒ 箭头出现（`data-arrow` 就是那条数据的 id）；
//     `undo()` 一次 ⇒ 回到**完全相同**的几何与逐字节相同的文档；17 种非法输入 ⇒ **有原因的错** ＋ 文档逐字节未变；
//     ⑥ **API 改一次 ＋ 鼠标真拖一次 ⇒ 两笔改动在同一个撤销栈里**（验「同一条提交路径」）；
//     `moveNode` / `removeNode` 的**成功路径**各跑一次（搬进另一栏、删掉分割符、删一棵子树 ⇒
//     文档、画布实测几何、撤销栈三样都对 —— 上一单只量了它们的拒绝路径）。
//     API 清单 / CDP 驱动配方在 `docs/design/designer-agent.md`（本单新增）。
//
//   反证臂（十四条，各自必红；改的都是 **web/ 的副本**，真 `web/**`／`server/**`／`spec/**` 一个字节不动）：
//     `--reverse-arm=fill-as-fixed`  —— 把 `fill` 当 `fixed` 处理 ⇒ `layout:fill` 必红；
//     `--reverse-arm=painted-arrows` —— 箭头写死一份、不听 `transitions` ⇒ `arrows:none` / `arrows:delete` 必红；
//     `--reverse-arm=undo-reload`    —— 撤销实现成 `location.reload()` ⇒ `undo:geometry` / `undo:marker` 必红。
//     `--reverse-arm=divider-as-line` —— 分割符实现成「固定一像素、不随容器伸展」⇒ `divider:stretch-*` / `divider:vertical` 必红。
//     `--reverse-arm=tform-no-write`  —— 转移表单「只改画布、不写 transitions」⇒ `tform:ok-creates` 必红。
//     `--reverse-arm=neutral-slot-default` —— 新建元素默认带 3px 槽 ⇒ `neutral:new-*` 必红。
//     `--reverse-arm=panel-ignores-parent` —— 属性面板不看父容器（一律自由定位）⇒ `panel:auto-vocab` / `panel:hidden-not-usable` 必红。
//     `--reverse-arm=divider-no-place` —— 分割符从流里拿掉（不占主轴）⇒ 两栏各占一半、总宽溢出 ⇒ `cols:sum-eq-parent` 等必红。
//     `--reverse-arm=clipboard-no-fallback` —— 复制 JSON 的 ②③ 两级（兼容路径与手动框）**都拿掉**（共用实现 `copy-text.js`
//       里那一段换成 `throw`）⇒ `clip:nonsecure-*` / `clip:manual-*` 必红（业主实测报回来的就是这条错）。
//     `--reverse-arm=api-bypass-commit` —— 控制面绕过提交路径（直接改文档、不进撤销栈）⇒
//       `api:one-history-entry` / `api:undo-restores` / `api:same-undo-stack` 必红。
//     `--reverse-arm=api-swallow-errors` —— 非法输入被静默吞掉（`apiGuard()` 不抛）⇒
//       `api:reject-invalid` / `api:reject-no-write` / `api:reject-visible` 必红。
//     `--reverse-arm=arrows-under-cards` —— 把连线层的 `z-index` 塞回卡的下面（层序反了）⇒
//       `flow:z-order` / `flow:arrows-visible-over-cards` 必红（业主报的「箭头在窗口后面」）。
//     `--reverse-arm=labels-one-point` —— 画布上的标签全画到同一个点 ⇒ `labels:on-own-path` / `labels:no-overlap` 必红；
//       而导出件那两条（`flowlabel:*`）**留绿**（两条实现各管各的）。
//     `--reverse-arm=exportlabel-one-point` —— 导出件里的标签全画到同一个点 ⇒ `flowlabel:*` 必红、`labels:*` 留绿。
//   本单（锚点没生效的**原因**：`data-anchor-fallback` 封闭集 ＋ 页面上那句提示）的六条臂：
//     `--reverse-arm=anchor-fallback-reason-{missing,othertree,hidden,badsel}` —— 每一类原因各打瞎一次
//       （错报成另一类）⇒ 那一类 `anchor:fallback-reason-*` 必红；
//     `--reverse-arm=anchor-fallback-marker-dropped` —— 把 path 上那个标记整个拿掉 ⇒ 四类 ＋ `anchor:fallback-markers-exact` 必红，
//       而 `anchor:fallback-hint-visible` **留绿**（标记与人的提示是两件事）；
//     `--reverse-arm=anchor-fallback-hint-dropped` —— 把页面上那句提示拿掉 ⇒ `anchor:fallback-hint-visible` 必红，
//       而四类标记那几条**留绿**。
//
//     `--reverse-arm=indent-per-level-slot` —— 图层缩进改回「**每层一段槽**」（＝ 2026-09-27 那版的画法）⇒
//       `layers:indent-blank`（缩进区里不许有按层生成的槽/引导元素）、`layers:indent-step`（逐层步进要与会话树
//       同值）与 `layers:indent-source`（源码里那行与会话树同形）必红（业主 2026-09-27 更正：缩进要留白）。
//     `--reverse-arm=slot-hardcoded` —— **行自身**那条槽的颜色写死（`designer.css` 的 `solid var(--slot)`
//       换成硬编码色）⇒ `layers:slot-color`（实测色 == 运行时读到的 `--slot-*` 解析值）与 `layers:slot-source`
//       （源码里是 `var(--slot)`）必红；而槽的几何（`layers:slot-width`）**留绿**（只动颜色）。
//     `--reverse-arm=fold-cosmetics-only` —— 折叠做成「**只用 CSS 把子行藏起来**」（子行还在 DOM 里）⇒
//       `layers:fold-hides` / `layers:fold-deep` 必红；而 `layers:fold-aria` **留绿**（`aria-expanded` 没说错话，
//       只是实现偷懒）—— 这一条本身就在证明「子行真的不在 DOM 里」跟「aria 没撒谎」是两件事。
//     `--reverse-arm=fold-aria-lying` —— 折叠控件的 `aria-expanded` 写死 `true`（折叠了也说自己开着）⇒
//       `layers:fold-aria` 必红、`layers:fold-hides` 留绿。
//     `--reverse-arm=dz-row-dead-slot-token` —— 把 `.dz-row` 里那句**从来没生效过**的
//       `border-left: 3px solid var(--dz-slots)` 加回来（＝给槽色另开一个不在 `--slot-*` 里的 token）⇒
//       `layers:list-row-slot-source` 的**源码腿**必红；实测色那条腿**不会红**（那句本来就是死的）。
//     `--reverse-arm=slot-off-layer-dropped` —— 把 `[data-slot="off"]` 从 `@layer slot-off` 里拿出来
//       （＝退回裸 `!important`：(0,1,0) 压不过 `button:not(…)×7` 的 (0,7,1)）⇒ `slot:off-switch` 必红。
//
// 用法：CHROME_BIN=<chromium> node test/designer-ui.mjs [--reverse-arm=fill-as-fixed|…|clipboard-no-fallback|export-stale-cache|export-silent-failure|export-broken|api-bypass-commit|api-swallow-errors|arrows-under-cards|labels-one-point|exportlabel-one-point|anchor-fallback-reason-missing|anchor-fallback-reason-othertree|anchor-fallback-reason-hidden|anchor-fallback-reason-badsel|anchor-fallback-marker-dropped|anchor-fallback-hint-dropped|indent-per-level-slot|slot-hardcoded|fold-cosmetics-only|fold-aria-lying|dz-row-dead-slot-token|slot-off-layer-dropped]
//
// 沙箱：高位随机端口 ＋ 临时浏览器 profile ＋ 临时 `web/` 副本（`test/ui-harness.mjs` 的 boot）；
// 不碰真 profile、不用 7331/7321、**绝不 pkill**（只按本次 spawn 的 pid 收尾）。
//

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { finishCleanup, removeSandbox } from './harness.mjs';
import { boot, sendJson, WEB_ROOT } from './ui-harness.mjs';
import { createUiSettingsStore, UI_SETTINGS_FILE_NAME } from '../server/ui-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 1440, height: 900 };
const SNAP = 6; // 与 web/designer.js 的 SNAP 同值（吸附最多再动这么多）
const ARTIFACT_DIR = path.join(process.env.TEMP || process.env.TMPDIR || os.tmpdir(), 'sopho-designer-ui');
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;

/** 真产品文件（门一个字节都不许改它们；跑前跑后各取一次 sha256）。 */
const REAL_PRODUCT_FILES = [
  'web/index.html', 'web/slot.css', 'web/app.js', 'web/render.js',
  'server/base.mjs', 'server/base-logic.mjs', 'server/app.mjs', 'spec/screens/settings-overlay.md',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 断言簿（一次把红列全，最后统一判）──────────────────────────────────────────────────────────
let checks = 0;
const checkIds = [];
const failures = [];
const problems = [];
const screenshots = [];
function check(id, name, ok, detail) {
  checks += 1;
  checkIds.push(id);
  const line = `${ok ? '✓' : '✗'} [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  process.stdout.write(`${line}\n`);
  if (!ok) failures.push({ id, name, detail });
  return ok;
}

// ── 反证臂：在**副本**上改一处 ─────────────────────────────────────────────────────────────────
const ARM_MUTANTS = {
  'fill-as-fixed': {
    what: '把 `fill` 当 `fixed` 处理（`axisCss()` 里 fill 那一行换成按 value 写死 px）',
    file: 'designer.js',
    from: "  if (mode === 'fill') { applyFill(dom, axis, css, ctx); return; }",
    to: "  if (mode === 'fill') { dom.style[css] = `${value}px`; return; }",
    expect: ['layout:fill'],
  },
  'painted-arrows': {
    what: '把箭头换成**写死的一份**（不听 `transitions`）——「画布上画了一根数据里没有的箭头」',
    file: 'designer.js',
    from: "  return state.doc.transitions.map((transition) => transitionArrow(transition)).filter(Boolean);",
    to: "  return [{ id: 'painted', from: 0, to: 1, self: false, label: '手绘', fromState: null, toState: null }];",
    expect: ['arrows:none', 'arrows:delete'],
  },
  'undo-reload': {
    what: '把撤销实现成**重载页面**（未保存状态被丢掉）',
    file: 'designer.js',
    from: "  if (state.historyIndex <= 0) return;\n  state.historyIndex -= 1;",
    to: "  if (state.historyIndex <= 0) return;\n  location.reload();\n  state.historyIndex -= 1;",
    expect: ['undo:geometry', 'undo:marker'],
  },
  // ── 本单（分割符 / 转移表单）的两条反证臂 ──────────────────────────────────────────────
  'divider-as-line': {
    what: '把分割符实现成「**固定一像素的细矩形、不随容器伸展**」（`dividerSizeShim()` 里长轴那一行换成固定 1px）',
    file: 'designer.js',
    from: "  const long = { mode: 'fill' };",
    to: "  const long = { mode: 'fixed', value: 1 };",
    expect: ['divider:stretch-row', 'divider:follows-container', 'divider:stretch-column', 'divider:vertical'],
  },
  'tform-no-write': {
    what: '把转移表单做成「**只改画布、不写 `transitions`**」（`submitTransitionForm()` 里写数据那一行换成不写）',
    file: 'designer.js',
    from: "      state.doc.transitions = [...(state.doc.transitions ?? []), { id, from: { screen: fromScreen.id, state: fromState }, to: { screen: toScreen.id, state: toState }, trigger }];",
    to: "      void id; // 只改画布、不写 transitions",
    expect: ['tform:ok-creates'],
  },
  // ── 中立默认（业主 2026-09-27：新建元素不许带我们的皮肤）的反证臂 ──────────────────────
  'neutral-slot-default': {
    what: '把「新建元素**中立**」改回**默认就带一条 3px 槽**（`newElementStyle()` 换成一份皮肤）',
    file: 'designer.js',
    from: "function newElementStyle() {\n  return undefined;\n}",
    to: "function newElementStyle() {\n  return { color: '#8abeb7', borderLeftWidth: 3 };\n}",
    expect: ['neutral:new-rect', 'neutral:new-text', 'neutral:new-button', 'neutral:new-input', 'neutral:not-in-style', 'neutral:export'],
  },
  // ── 本单（属性面板随上下文 / 分割符占位）的两条反证臂 ─────────────────────────────────
  'panel-ignores-parent': {
    what: '让属性面板**不看父容器**（`placementVocab()` 一律返回 `free`）⇒ auto 父容器下也照旧显示并允许改 `box`',
    file: 'designer.js',
    from: "  if (parentMode === 'free') return 'free';\n  if (parentMode === 'root') return 'root';\n  return 'auto';",
    to: "  return 'free';",
    expect: ['panel:auto-vocab', 'panel:hidden-not-usable'],
  },
  'divider-no-place': {
    what: '把分割符**从流里拿掉**（`dividerPosition()` 返回 `absolute`）⇒ 它不再占主轴，两个 `fill` 兄弟各占一半（忽略分割符）',
    file: 'designer.js',
    from: "function dividerPosition() {\n  return 'relative';\n}",
    to: "function dividerPosition() {\n  return 'absolute';\n}",
    expect: ['cols:sum-eq-parent', 'cols:follows-parent', 'cols:follows-thickness'],
  },
  // ── 本单（复制 JSON 三级降级）的反证臂：把 ②③ 拿掉，回到业主报的那条错 ────────────────
  // ⚠️ 2026-09-25 起三级降级是**共用实现**（`web/copy-text.js`，主产品页的「复制」也调它）——
  //   接缝因此不在这份 `designer.js` 里，反证臂改的是那一份共用文件（门必须跟着改，不然是个假门）。
  'clipboard-no-fallback': {
    what: '把**兼容路径（execCommand）与手动框都拿掉**（共用实现 `copy-text.js` 里 ②③ 那一段换成 `throw`）⇒ 回到业主实测报回来的那条'
      + '「只调 `navigator.clipboard.writeText`、失败就报复制失败」',
    file: 'copy-text.js',
    from: "    if (copyViaExecCommand(text)) return { path: 'execCommand', ok: true, text, bytes, reasons };\n    reasons.push(\"document.execCommand('copy') 返回 false（浏览器不让这条兼容路径复制）\");\n    const nodes = resolveNodes(ids);\n    if (openManualCopy(text, reasons, { label, hint, nodes })) return { path: 'manual', ok: false, text, bytes, reasons };",
    to: "    throw new Error('反证臂：兼容路径与手动框都被拿掉了（直接调 clipboard）');",
    expect: ['clip:nonsecure-no-failure', 'clip:nonsecure-path', 'clip:nonsecure-bytes', 'clip:manual-panel', 'clip:manual-bytes', 'clip:manual-why', 'clip:manual-esc'],
  },
  // ── 本单（导出接到编辑器页上）的三条反证臂 ──────────────────────────────────────
  'export-stale-cache': {
    what: '把「每次导出都当场重跑」换成「**把第一次的结果缓存起来再发一次**」（`buildExport()` 里那一行）',
    file: 'designer.js',
    from: "async function buildExport(kind) {\n  return renderExport(kind);\n}",
    to: "async function buildExport(kind) {\n  window.__dzStale = window.__dzStale ?? {};\n  window.__dzStale[kind] = window.__dzStale[kind] ?? renderExport(kind);\n  return window.__dzStale[kind];\n}",
    expect: ['export:fresh-svg', 'export:fresh-html'],
  },
  'export-silent-failure': {
    what: '让导出失败**静默**（`runExport()` 的 catch 换成「只写一句完成」、不报原因）',
    file: 'designer.js',
    from: "    const reason = error instanceof Error ? error.message : String(error);\n    lastExport = { kind, ok: false, name: null, bytes: 0, reason };\n    setStatus(`导出 ${label} 失败：${reason}`, 'error');\n    node.exportMenu.dataset.error = reason;",
    to: "    void error;\n    lastExport = { kind, ok: true, name: null, bytes: 0, reason: null };\n    setStatus('已导出（完成）', 'ok');",
    expect: ['export:fail-honest', 'export:fail-no-download'],
  },
  'export-broken': {
    what: '把导出器本身**拿掉**（`renderExport()` 开头就抛）—— 看「导出失败」那条路是不是**如实报**（不是静默）',
    file: 'designer.js',
    from: "async function renderExport(kind) {\n  switch (kind) {",
    to: "async function renderExport(kind) {\n  throw new Error('反证臂 export-broken：导出器被拿掉（这一步就是缺的那一步）');\n  switch (kind) {",
    expect: ['export:html-valid', 'export:svg-valid', 'export:svg-geometry', 'export:png-bytes', 'export:png-pixels',
      'export:json-bytes', 'export:flow-arrow', 'export:fresh-svg', 'export:fresh-html', 'export:fail-recovers'],
    expectGreen: ['export:fail-honest', 'export:fail-no-download'],
  },
  // ── 本单（可编程控制面 `window.sophoDesigner`）的两条反证臂 ────────────────────────────────
  'api-bypass-commit': {
    what: '让控制面**绕过提交路径**（`apiMutate()` 换成「直接改文档对象 ＋ 重渲染、**不进撤销栈**」）——'
      + '「一次 API 改动 = 一条历史」与「API 与鼠标在同一个撤销栈里」必红',
    file: 'designer.js',
    from: "function apiMutate(mutator) {\n  changeModel(mutator);\n}",
    to: "function apiMutate(mutator) {\n  mutator();\n  renderAll();\n}",
    expect: ['api:one-history-entry', 'api:undo-restores', 'api:same-undo-stack'],
  },
  'api-swallow-errors': {
    what: '让非法输入**被静默吞掉**（`apiGuard()` 里那行抛出换成「什么都不做」）——'
      + '「非法输入 ⇒ 有原因的错」与「文档逐字节未变」必红',
    file: 'designer.js',
    from: "function apiGuard(ok, reason) {\n  if (!ok) throw new Error(reason);\n}",
    to: "function apiGuard(ok, reason) {\n  void ok;\n  void reason;\n}",
    expect: ['api:reject-invalid', 'api:reject-no-write', 'api:reject-visible'],
  },
  // ── 本单（转移两端必须写全 `{screen, state}`）的反证臂 ─────────────────────────────────
  // 接缝就是那**一份**共享实现（`transitionEndIssue()`）：把查 `state` 那一行的条件换成 `false`
  // ⇒ 缺 `state` 的文档会被静默收下（正是 2026-09-25 那个坑：转移图里一根箭头都画不出来、页面上没任何提示）。
  'no-transition-end-check': {
    what: '把「转移两端必须显式写 `state`」这条校验拿掉（共享实现里查 `state` 那一行的条件换成 `false`）'
      + '⇒ 缺 `state` 的文档被静默收下',
    file: 'designer.js',
    from: "  if (typeof value.state !== 'string' || value.state.length === 0) {",
    to: '  if (false) {',
    expect: ['tends:doc-reject-missing-state', 'tends:doc-reject-no-write', 'tends:import-reject-missing-state', 'tends:add-reject-missing-state'],
  },
  // ── 本单（流程图的层序 ＋ 标签位置）的三条反证臂 ────────────────────────────────────────
  'arrows-under-cards': {
    what: '把**层序反回去**（`designer.css` 里连线层那一行 `z-index: var(--dz-layer-arrows)` 换成 `z-index: 0`）——'
      + '于是不透明的屏卡又铺在连线上面（业主原话：「箭头的层级在窗口的后面」）',
    file: 'designer.css',
    from: 'z-index: var(--dz-layer-arrows);',
    to: 'z-index: 0;',
    expect: ['flow:z-order', 'flow:arrows-visible-over-cards'],
  },
  'labels-one-point': {
    what: '把**画布上的标签全画到同一个点**（`labelCandidatesOnPath()` 直接返回一个固定点）——'
      + '于是「贴在自己那条线上」与「互不相交」两条都该红（业主原话：「箭头上的字体位置有问题，现在都叠在一起了」）',
    file: 'designer.js',
    from: 'function labelCandidatesOnPath(path, zoom) {\n  const total = path.getTotalLength();',
    to: 'function labelCandidatesOnPath(path, zoom) {\n  return [{ x: 0, y: 0 }]; // 反证臂 labels-one-point：画布上的标签全挤到同一个点\n  const total = path.getTotalLength();',
    expect: ['labels:on-own-path', 'labels:no-overlap'],
    // 导出件那条实现**不该**被这条臂碰到（它走的是 `labelCandidatesOnCurve`）—— 这一条本身就是
    // 「两条实现各管各的」的正证，所以它必须**留绿**。
    expectGreen: ['flowlabel:on-own-path', 'flowlabel:no-overlap'],
  },
  'exportlabel-one-point': {
    what: '把**导出转移图里的标签全画到同一个点**（`labelCandidatesOnCurve()` 直接返回一个固定点）——'
      + '导出件（`*.flow.svg`）里那两条断言必红；而画布上那两条应该**留绿**（两条实现各管各的）',
    file: 'designer.js',
    from: 'function labelCandidatesOnCurve(curve) {\n  const points = [];',
    to: 'function labelCandidatesOnCurve(curve) {\n  return [{ x: 0, y: 0 }]; // 反证臂 exportlabel-one-point：导出件里的标签全挤到同一个点\n  const points = [];',
    expect: ['flowlabel:on-own-path', 'flowlabel:no-overlap'],
    expectGreen: ['labels:on-own-path', 'labels:no-overlap'],
  },
  // ── 本单（流程画布自由缩放）的两条反证臂 ────────────────────────────────────────
  'zoom-mutates-model': {
    what: '把视图缩放**做成改文档**（`applyFlowZoom()` 里施加变换那一行换成往 `state.doc.tokens` 写一个键、'
      + '不再给画布上变换）⇒「缩放是纯视图（文档字节一字不动）」与「画布真的放大」两条都该红',
    file: 'designer.js',
    from: '  node.flowCards.style.transform = `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`;',
    to: "  state.doc.tokens = { ...(state.doc.tokens ?? {}), '--dz-view-zoom': String(viewTransform.scale) };",
    expect: ['zoom:pure-view', 'zoom:invariants-50', 'zoom:invariants-200'],
  },
  'zoom-labels-ignore': {
    what: '让**标签度量不跟着缩放**（`labelZoom()` 换成常数 1）—— 字号 / 边距 / 避让距离都不再随档位放大，'
      + '于是 50% 档下挤在一起、「贴在自己那条线上」也超出按档位放大的上界 ⇒ 必红',
    file: 'designer.js',
    from: 'function labelZoom() {\n  return viewTransform.scale;\n}',
    to: 'function labelZoom() {\n  return 1; // 反证臂 zoom-labels-ignore：标签度量不跟着缩放\n}',
    expect: ['zoom:invariants-50'],
  },
  // ── 本单（流程画布**点击拖动平移**）的反证臂 ─────────────────────────────────
  // 接缝：缩放与平移**共用那一行**施加点（`[SEAM:view-zoom]` / `[SEAM:view-pan]`）。
  // 把 `translate(...)` 那一半**摘掉** ⇒ 拖动不改视图：①②（真的移动、位移 == 拖动像素）与
  // ③（平移后命中测试跟着走：平移前看到的那根箭头 / 那张卡头，在新位置按真点应该还是它）
  // 与 ④（平移＋缩放叠加的解析式）必红；而 `pan:pure-view` **留绿**（它量的正是「文档一字不动」——
  // 这条臂没有往模型里写东西，所以它本来就不该红）。
  'pan-ignored': {
    what: '把"应用平移"那一步去掉（`applyFlowZoom()` 里唯一那行施加点的 `translate(...)` 那一半摘掉，'
      + '只留 `scale(...)`）⇒ 拖动不改视图、命中测试不跟着平移走',
    file: 'designer.js',
    from: '  node.flowCards.style.transform = `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`;',
    to: '  node.flowCards.style.transform = `scale(${viewTransform.scale})`;',
    expect: ['pan:drag-moves-canvas', 'pan:compose-50', 'pan:compose-200', 'pan:hit-arrow', 'pan:hit-test-arrow', 'pan:hit-card', 'pan:hit-test-card'],
    expectGreen: ['pan:pure-view'],
  },
  // ── 本单（流程画布：转移起点锚 —— 起点落在**控件盒子的边**上）的反证臂 ──────────────────────
  // 接缝：`[SEAM:anchor]`（`paintArrows()` 里算起点那一行）＋它的两个邻居 —— `[SEAM:anchor-box]`
  // （`anchorBoxOnCanvas()` 的量法与可见性判定）与 `[SEAM:anchor-name]`（选择器只认 `#<元素 id>` 那条口径）。
  'anchor-as-default': {
    what: '把**锚点起点换回卡片上那个默认起点**（`[SEAM:anchor]` 那一行换成 `const start = cardStart;`）——'
      + '正是「箭头还是从**容器**（卡片）出来、不是从那个**控件**出来」那个形状 ⇒ 起点那三条几何判据必红',
    file: 'designer.js',
    from: '      const start = anchorBox === null ? cardStart : edgePointToward(anchorBox, end);',
    to: '      const start = cardStart; // 反证臂 anchor-as-default：锚点盒子被无视（起点一律落在卡片上那个默认点）',
    expect: ['anchor:start-on-box-edge', 'anchor:start-edge-point-toward-target', 'anchor:container-and-root-honored'],
  },
  'anchor-self-as-default': {
    what: '只把**自环**那一支的锚点拿掉（自环分支的条件 `if (anchorBox === null) {` 换成 `if (true) {`）——自环的起点/终点回到卡片上边那两个点',
    file: 'designer.js',
    from: '      if (anchorBox === null) {',
    to: '      if (true) { // 反证臂 anchor-self-as-default：自环那一支不看锚点',
    expect: ['anchor:self-start-on-box-edge'],
  },
  'anchor-fallback-off-by-body': {
    what: '把**退回落点**从卡片上那个默认起点改成按**屏内容可见区**（`.dz-card-body`）算 —— 于是「没带锚点的转移逐像素不变」'
      + '与三条「该退回」同时红（退回不是「画到别处」，是「退回改动前那个点」）',
    file: 'designer.js',
    from: '      const cardStart = {\n        x: (forward ? a.right : a.left) - svgRect.left,\n        y: a.top - svgRect.top + a.height / 2,\n      };',
    to: '      const cardStart = (() => {\n        const v = fromCard.querySelector(".dz-card-body").getBoundingClientRect(); // 反证臂 anchor-fallback-off-by-body\n        return { x: (forward ? v.right : v.left) - svgRect.left, y: v.top - svgRect.top + v.height / 2 };\n      })();',
    expect: ['anchor:plain-unchanged', 'anchor:missing-falls-back', 'anchor:hidden-falls-back', 'anchor:badselector-falls-back'],
  },
  'anchor-ignores-visibility': {
    what: '**不看可见性**（`anchorBoxOnCanvas()` 里「锚点控件的实测矩形与屏内容可见区求交要有正面积」那一步拿掉）——'
      + '在画出来的屏内容里看不见的控件也照样从它出发',
    file: 'designer.js',
    from: '  if (!(right - left > 0) || !(bottom - top > 0)) return null;',
    to: '  if (false) return null; // 反证臂 anchor-ignores-visibility：不看在画出来的屏内容里看不看得见',
    expect: ['anchor:hidden-falls-back'],
  },
  'anchor-falls-back-to-root': {
    what: '**找不到锚点元素就退回屏内容的第一个元素**（查元素那一行加一个 `?? body.querySelector(...)` 兜底）——'
      + '「指不到 ⇒ 退回默认起点」这条立刻红（它会从**屏根框**的边上出去）',
    file: 'designer.js',
    from: '  const dom = body ? findCardElement(body, id) : null;',
    to: '  const dom = body ? (findCardElement(body, id) ?? body.querySelector("[data-id]")) : null; // 反证臂 anchor-falls-back-to-root',
    expect: ['anchor:missing-falls-back'],
  },
  'anchor-any-selector': {
    what: '**写法不认时就改用任意选择器**（`anchorTargetId()` 返回 `null` 时拿 `fromCard.querySelector(selector)` 兜底）——'
      + '`[data-id="el-input-name"]` 那种写法会被当锚点用 ⇒「不猜」那条必红',
    file: 'designer.js',
    from: "  const id = anchorTargetId(anchor.selector);\n  if (id === null) return null;\n  const body = fromCard.querySelector('.dz-card-body');\n  const dom = body ? findCardElement(body, id) : null;",
    to: "  const id = anchorTargetId(anchor.selector);\n  const body = fromCard.querySelector('.dz-card-body');\n  const dom = body ? (findCardElement(body, id) ?? fromCard.querySelector(anchor.selector)) : null; // 反证臂 anchor-any-selector：写法不认就改用任意选择器",
    expect: ['anchor:badselector-falls-back'],
  },
  'anchor-container-falls-back': {
    what: '**容器/屏根锚点一律退回默认起点**（查到元素之后加一句「是 `container` 就 `return null`」）——'
      + '「容器也能当锚点（与导出器 `anchorBoxOf()` 同一条：它不做类型限制）」那条必红',
    file: 'designer.js',
    from: '  const dom = body ? findCardElement(body, id) : null;\n  if (!body || !dom) return null;\n  const rect = dom.getBoundingClientRect();',
    to: '  const dom = body ? findCardElement(body, id) : null;\n  if (!body || !dom) return null;\n  if (dom.dataset.type === "container") return null; // 反证臂 anchor-container-falls-back：容器/屏根锚点一律退回\n  const rect = dom.getBoundingClientRect();',
    expect: ['anchor:container-and-root-honored'],
  },
  'anchor-stale-box': {
    what: '**盒子只量一次就缓存住**（那次 `getBoundingClientRect()` 改成按元素 id 缓存）——缩放 / 平移之后起点留在旧位置 ⇒ 50% 与 200% 两条必红'
      + '（100% 基线仍绿：那时缓存刚写进去、与实测一致）',
    file: 'designer.js',
    from: '  const rect = dom.getBoundingClientRect();\n  const view = body.getBoundingClientRect();',
    to: '  const cache = (window.__dzAnchorBoxCache = window.__dzAnchorBoxCache ?? {});\n  const rect = (cache[id] = cache[id] ?? dom.getBoundingClientRect()); // 反证臂 anchor-stale-box：盒子只量一次\n  const view = body.getBoundingClientRect();',
    expect: ['anchor:tiers-50', 'anchor:tiers-200'],
  },
  'anchor-dropped-in-canonical': {
    what: '**规范序列化把未知键静默丢掉**（`orderedKeys()` 里把未知键原样挂回去的那一圈删掉）—— `from.anchor` 就是这么丢的：'
      + '导出 ⇒ 再导入之后锚点全没了 ⇒ 往返那条必红',
    file: 'designer.js',
    from: '  for (const key of Object.keys(source ?? {})) {\n    if (keys.includes(key)) continue;\n    if (source[key] === undefined) continue;\n    out[key] = source[key];\n  }',
    to: '  // 反证臂 anchor-dropped-in-canonical：未知键（含 from.anchor）被静默丢掉',
    expect: ['anchor:doc-roundtrip'],
  },
  // ── 本单（锚点没生效的**原因**：`data-anchor-fallback` 的封闭集 ＋ 那句看得见的提示）的反证臂 ────────────
  // 每一类原因**各打瞎一次**：每条臂只改一处，让那一个注释/原因值失真 ⇒ 它**自己那一条**判据必红
  // （另外几条跟着红是允许的；关键是不能「有个提示就算过」）。接缝见 `[SEAM:anchor-fallback-reason]`
  // （`anchorFallbackReason()` / `docHasElementId()`）与 `[SEAM:anchor-fallback]` / `[SEAM:anchor-fallback-hint]`。
  'anchor-fallback-reason-missing': {
    what: '把「文档里别处有没有这个 id」那一层做成**一律说「有」**（`docHasElementId()` 开头就 `return true`）——'
      + '于是真·缺元素（`#el-nope`）会被错报成 `not-in-screen-tree` ⇒「missing 这一类」那条判据必红',
    file: 'designer.js',
    from: 'function docHasElementId(id) {\n  const stack = [];',
    to: 'function docHasElementId(id) {\n  return true; // 反证臂 anchor-fallback-reason-missing：一律说「文档里别处有」\n  const stack = [];',
    expect: ['anchor:fallback-reason-missing'],
  },
  'anchor-fallback-reason-othertree': {
    what: '把「文档里别处有没有这个 id」那一层做成**一律说「没有」**（`docHasElementId()` 里那个比较恒为 `false`）——'
      + '于是「在文档里、但不在 from 那一屏的树里」会被错报成 `missing` ⇒ 那一类判据必红',
    file: 'designer.js',
    from: '    if (element.id === id) return true;',
    to: '    if (element.id === id) return false; // 反证臂 anchor-fallback-reason-othertree：一律说「文档里别处没有」',
    expect: ['anchor:fallback-reason-not-in-screen-tree'],
  },
  'anchor-fallback-reason-hidden': {
    what: '把「元素在卡片里、但画出来的屏内容里没有可见位置」那一支写成 `missing`（`return \'not-visible\';` 换掉）——'
      + '于是溢出屏外那个元素的原因错报 ⇒ 那一类判据必红',
    file: 'designer.js',
    from: "  return 'not-visible';",
    to: "  return 'missing'; // 反证臂 anchor-fallback-reason-hidden：看不见也算「文档里没有」",
    expect: ['anchor:fallback-reason-not-visible'],
  },
  'anchor-fallback-reason-badsel': {
    what: '把「选择器写法不认」那一支写成 `missing`（`if (id === null) return \'bad-selector\';` 换成 `return \'missing\';`）——'
      + '于是写法错与元素不存在混成一类 ⇒ 那一类判据必红',
    file: 'designer.js',
    from: "  if (id === null) return 'bad-selector';",
    to: "  if (id === null) return 'missing'; // 反证臂 anchor-fallback-reason-badsel：写法不认也算「文档里没有」",
    expect: ['anchor:fallback-reason-bad-selector'],
  },
  'anchor-fallback-marker-dropped': {
    what: '把 path 上那个**机械标记整个拿掉**（那一行换成 `void fallbackReason;`）—— 退回照旧、提示照旧，但'
      + '「怎么读出来」这一层没了 ⇒ 四类原因 ＋ 「一个不多一个不少」那条全红（而**提示**那条应当留绿：两件事各管各的）',
    file: 'designer.js',
    from: '    if (fallbackReason !== null) path.dataset.anchorFallback = fallbackReason;',
    to: '    if (fallbackReason !== null) void fallbackReason; // 反证臂 anchor-fallback-marker-dropped：标记不写了',
    expect: ['anchor:fallback-reason-missing', 'anchor:fallback-reason-not-in-screen-tree', 'anchor:fallback-reason-not-visible',
      'anchor:fallback-reason-bad-selector', 'anchor:fallback-markers-exact'],
    expectGreen: ['anchor:fallback-hint-visible'],
  },
  'anchor-fallback-hint-dropped': {
    what: '把**页面上那句提示**整个拿掉（`renderFlowWarn()` 里把锚点那半句拼进去的那两行删掉）—— 机器读得到、人看不见了 ⇒ '
      + '“页面上看得见”那条必红（而四类标记那几条应当留绿：标记还在）',
    file: 'designer.js',
    from: '  const anchors = anchorFallbackWarningText(anchorFallbacks);\n  if (anchors !== null) lines.push(anchors);',
    to: '  // 反证臂 anchor-fallback-hint-dropped：锚点那半句不写了',
    expect: ['anchor:fallback-hint-visible'],
    expectGreen: ['anchor:fallback-reason-missing', 'anchor:fallback-reason-not-in-screen-tree', 'anchor:fallback-reason-not-visible',
      'anchor:fallback-reason-bad-selector', 'anchor:fallback-markers-exact'],
  },
  // ── 本单（图层面板：缩进留白与会话树同形 ＋ 折叠子项）的四条反证臂 ───────────────────────────
  // 业主 2026-09-27 更正（逐字）：「你的缩进是有了但是**缩进之后，左侧应该是空白的，和我们的会话树一样**，
  // 而不是**还存在槽位**」。
  'indent-per-level-slot': {
    what: '把缩进改回「**每层一段槽**」（＝ 2026-09-27 那版的画法）：`layerRow()` 里那行缩进不再写 margin，'
      + '改成按层生成 `.dz-indent-slot` 元素 —— 缩进区里又有东西了，且步进量也不再和会话树同值',
    file: 'designer.js',
    from: '  row.style.marginInlineStart = `${Math.min(depth, 6) * .65}rem`;',
    to: "  row.style.marginInlineStart = '0rem';\n  for (let level = 0; level < depth; level += 1) { const slot = document.createElement('i'); slot.className = 'dz-indent-slot'; row.appendChild(slot); }",
    expect: ['layers:indent-blank', 'layers:indent-step', 'layers:indent-source'],
    expectGreen: ['layers:slot-width', 'layers:slot-color', 'layers:slot-source'],
  },
  'slot-hardcoded': {
    what: '把**行自身**那条槽的颜色写死（`designer.css` 的 `.dz-layers .dz-layer` 里 `solid var(--slot)` 换成硬编码色）'
      + ' —— 槽还在、宽也还是 `--design-slot-width`，但色不再是 `--slot-*` 那套 token',
    file: 'designer.css',
    from: '  border-inline-start: var(--design-slot-width, 3px) solid var(--slot);',
    to: '  border-inline-start: var(--design-slot-width, 3px) solid #8abeb7;',
    expect: ['layers:slot-color', 'layers:slot-source'],
    expectGreen: ['layers:slot-width', 'layers:indent-blank', 'layers:indent-step'],
  },
  'fold-cosmetics-only': {
    what: '把折叠做成「**只用 CSS 把子行藏起来**」（`renderLayers()` 里那一行不再往下走 ⇒ 换成「照往下走、'
      + '只给直接子行挂 `display:none`」）—— 子行还在 DOM 里，只是看不见',
    file: 'designer.js',
    from: "  walkTree(currentTree(), (element, depth) => {\n    node.layers.appendChild(layerRow(element, depth));\n    // [SEAM:layer-fold] —— 折叠掉的那一支不再往下走（子行**根本不进 DOM**）。\n    return isLayerFolded(element.id) ? false : undefined;\n  });",
    to: "  walkTree(currentTree(), (element, depth, parent) => {\n    const row = layerRow(element, depth);\n    // 反证臂 fold-cosmetics-only：折叠只把子行**用 CSS 藏起来** —— 它们还在 DOM 里\n    if (parent !== null && isLayerFolded(parent.id)) row.style.display = 'none';\n    node.layers.appendChild(row);\n  });",
    expect: ['layers:fold-hides', 'layers:fold-deep'],
    expectGreen: ['layers:fold-aria'],
  },
  'fold-aria-lying': {
    what: '让折叠控件的 `aria-expanded` **不说实话**（`layerFoldCell()` 里那一行换成常量 `true`）—— 折叠真的生效了'
      + '（子行确实不渲染），但它还声称自己展开着',
    file: 'designer.js',
    from: "  fold.setAttribute('aria-expanded', String(!folded));",
    to: "  fold.setAttribute('aria-expanded', 'true'); // 反证臂 fold-aria-lying：折了也说自己展开着",
    expect: ['layers:fold-aria'],
    expectGreen: ['layers:fold-hides', 'layers:fold-unfold'],
  },
  // ── 本单（两处**既有**缺陷）的两条反证臂 ──────────────────────────────────────────────────
  // ① `--dz-slots` 死 token：`.dz-row` 里那句另开调色板的声明（被 `slot.css` 的 `!important` 压着、
  //   从来没画出来过）。把它加回来 ⇒ 源码那条腿红（测量的那条腿不会红，因为它本来就是死的）。
  'dz-row-dead-slot-token': {
    what: '把 `.dz-row` 里那句**从来没生效过**的 `border-left: 3px solid var(--dz-slots)` 加回来'
      + '（＝又给槽色开了个不在 `--slot-*` 里的 token）—— 视觉上不会变（那句是死的），红的是源码那条腿',
    file: 'designer.css',
    from: '  border: 1px solid transparent;\n  background: var(--dz-raised); color: var(--dz-text); font-size: 11px; cursor: pointer; text-align: left;',
    to: '  border: 1px solid transparent; border-left: 3px solid var(--dz-slots);\n  background: var(--dz-raised); color: var(--dz-text); font-size: 11px; cursor: pointer; text-align: left;',
    expect: ['layers:list-row-slot-source'],
  },
  // ② 撤销开关把 `@layer` 层拿掉（退回裸 `!important`：(0,1,0) 压不过 `button:not(…)×7` 的 (0,7,1)）。
  'slot-off-layer-dropped': {
    what: '把 `[data-slot="off"]` 从 `@layer slot-off` 里拿出来 ⇒ 退回与特异性挂钩的裸 `!important`'
      + '（(0,1,0) 压不过大名单里按钮那条 (0,7,1)、也压不过 `#send` 那种 (1,0,0)）',
    file: 'slot.css',
    from: '@layer slot-off {\n  [data-slot="off"] {\n    border-inline-start-width: 0 !important;\n  }\n}',
    to: '[data-slot="off"] {\n  border-inline-start-width: 0 !important;\n}',
    expect: ['slot:off-switch'],
  },
};

const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-designer-ui-'));
const webRoot = path.join(sandbox, 'web');
await cp(path.join(root, 'web'), webRoot, { recursive: true });
await mkdir(ARTIFACT_DIR, { recursive: true });

if (ARM) {
  const arm = ARM_MUTANTS[ARM];
  if (!arm) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
  const target = path.join(webRoot, arm.file);
  const text = await readFile(target, 'utf8');
  if (!text.includes(arm.from)) throw new Error(`反证臂 ${ARM} 的改写没命中（接缝形状变了？）：${arm.what}`);
  // ⚠️ 命中**恰好一处**才改（`String.replace` 配字符串只改第一处）—— 本仓真踩过：
  // 2026-09-27 新加的函数里有一行与要改的旧接缝**逐字相同** ⇒ 臂改的是新函数、旧接缝一动没动 ⇒
  // 臂「跑了」但预期的那条没红（`anchor-falls-back-to-root` 当场红在这里）。`test:armseams` 只查「串还在不在」，
  // 看不见「改的是第几处」—— 所以这行守在**施加处**。
  const hits = text.split(arm.from).length - 1;
  if (hits !== 1) throw new Error(`反证臂 ${ARM} 的 from 在 web/${arm.file} 里出现 ${hits} 次（要求恰好 1 次）：${arm.what} —— 把那段写成唯一的（否则 String.replace 会改到别处，臂就成了假臂）`);
  await writeFile(target, text.replace(arm.from, arm.to), 'utf8');
  process.stdout.write(`反证臂 ${ARM} —— ${arm.what}（跑在副本上：web/${arm.file}）\n`);
}

const hashesBefore = new Map();
for (const file of REAL_PRODUCT_FILES) hashesBefore.set(file, await sha256(path.join(root, file)).catch(() => '(读不到)'));

// ── 浏览器底座 ─────────────────────────────────────────────────────────────────────────────────
let page = null;
let evalBroken = null;
async function evalIn(expression) {
  if (evalBroken) throw evalBroken;
  try {
    return await page.evaluate(expression);
  } catch (error) {
    evalBroken = error;
    throw error;
  }
}
async function safeEval(expression) {
  try {
    return await evalIn(expression);
  } catch {
    return null;
  }
}
async function frames(count = 2) {
  await page.frames(count);
  await sleep(30);
}
async function box(selector) {
  return evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  })()`);
}
async function mouse(type, x, y, extra = {}) {
  await page.browser.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
}
async function clickPoint(point, { modifiers = 0 } = {}) {
  await mouse('mousePressed', point.x, point.y, { button: 'left', buttons: 1, clickCount: 1, modifiers });
  await mouse('mouseReleased', point.x, point.y, { button: 'left', buttons: 0, clickCount: 1, modifiers });
  await frames(2);
}
async function clickSelector(selector, options = {}) {
  const target = await box(selector);
  if (!target) throw new Error(`点不到：${selector}（元素不在）`);
  await clickPoint({ x: target.cx, y: target.cy }, options);
}
async function safeClickSelector(selector, options = {}) {
  try {
    await clickSelector(selector, options);
  } catch {
    /* 反证臂里页面可能刚被重载：这里的失败本身就是要看的红，别让它把断言簿打断 */
  }
}
async function dragPoints(from, to, { steps = 10, modifiers = 0 } = {}) {
  await mouse('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1, modifiers });
  for (let step = 1; step <= steps; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const y = from.y + ((to.y - from.y) * step) / steps;
    await mouse('mouseMoved', x, y, { button: 'left', buttons: 1, modifiers });
  }
  await mouse('mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1, modifiers });
  await frames(2);
}
async function setControl(selector, value) {
  return evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'no element' };
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  })()`);
}
async function groupCheck(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`group:${name}`, `分组 ${name} 跑完`, false, error?.stack ?? String(error));
  }
}
async function shot(name) {
  const file = path.join(ARTIFACT_DIR, `${ARM ? `${ARM}-` : ''}${name}.png`);
  await page.screenshot(file);
  screenshots.push(file);
  return file;
}
/** 画布上那一刻的「DOM 实测矩形 + 面板读数」——「实测 == 面板里的数」这条判据的取数口。 */
async function canvasGeometry(selector) {
  return evalIn(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const frame = document.querySelector('#dz-frame');
    const fr = frame.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const one = (sel) => { const n = document.querySelector(sel); return n ? (n.value ?? n.textContent) : null; };
    return {
      id: el.dataset.id,
      x: Math.round(r.left - fr.left - frame.clientLeft),
      y: Math.round(r.top - fr.top - frame.clientTop),
      w: Math.round(r.width),
      h: Math.round(r.height),
      panelX: one('#dz-panel [data-field="box-x"]'),
      panelY: one('#dz-panel [data-field="box-y"]'),
      measureW: one('#dz-panel [data-measure="w"]'),
      measureH: one('#dz-panel [data-measure="h"]'),
    };
  })()`);
}
const geometryOfId = (id) => canvasGeometry(`#dz-frame .dz-el[data-id="${id}"]`);
const geometryOfRect = () => canvasGeometry('#dz-frame .dz-el[data-type="rect"]');

try {
  page = await boot({ width: VIEWPORT.width, height: VIEWPORT.height, webRoot });
  const loaded = page.browser.once('Page.loadEventFired');
  await page.browser.send('Page.navigate', { url: `http://127.0.0.1:${page.port}/designer.html` });
  await loaded;
  await frames(4);

  // ═══ 1. 空白起 ═══════════════════════════════════════════════════════════════════════════
  await groupCheck('blank', async () => {
    const info = await evalIn(`(() => {
      const doc = window.__dz ? window.__dz.doc() : null;
      return {
        ready: window.__dzReady === true,
        version: doc?.version ?? null,
        schema: doc?.$schema ?? null,
        screens: doc?.screens?.length ?? -1,
        states: doc?.screens?.[0]?.states?.length ?? -1,
        rootType: doc?.screens?.[0]?.root?.type ?? null,
        rootLayout: doc?.screens?.[0]?.root?.layout?.mode ?? null,
        rootChildren: doc?.screens?.[0]?.root?.children?.length ?? -1,
        transitions: doc?.transitions?.length ?? -1,
        domElements: document.querySelectorAll('#dz-frame .dz-el').length,
        canvasVisible: document.querySelector('#dz-canvas').hidden === false,
      };
    })()`);
    check('blank:doc', '空白文档：1 屏 / 1 状态 / 根是 free 容器 / 0 子元素 / 0 转移（version=0.1.0、$schema 在）',
      info.ready && info.version === '0.1.0' && typeof info.schema === 'string' && info.screens === 1 && info.states === 1
      && info.rootType === 'container' && info.rootLayout === 'free' && info.rootChildren === 0 && info.transitions === 0,
      JSON.stringify(info));
    check('blank:dom', '画布上只有根容器一个元素（DOM 实测），编辑视图是开着的', info.domElements === 1 && info.canvasVisible, JSON.stringify(info));
    await shot('01-blank');
  });

  let rectId = null;
  let rectAfterDrop = null;

  // ═══ 2. 从工具栏拖一个矩形出来（真鼠标：按下工具 → 拖到画布 → 松手）══════════════════════
  await groupCheck('tool-drag', async () => {
    const tool = await box('[data-tool="rect"]');
    const frame = await box('#dz-frame');
    await dragPoints({ x: tool.cx, y: tool.cy }, { x: frame.left + 150, y: frame.top + 120 }, { steps: 12 });
    const after = await evalIn(`(() => {
      const rects = [...document.querySelectorAll('#dz-frame .dz-el[data-type="rect"]')];
      return {
        count: rects.length,
        id: rects[0]?.dataset.id ?? null,
        children: window.__dz.doc().screens[0].root.children.length,
        selected: window.__dz.selection().length,
      };
    })()`);
    rectId = after.id;
    check('tool-drag:adds', '工具栏「矩形」拖到画布 ⇒ 文档里多了一个 rect 子元素（DOM 一个、数据一个、它被选中）',
      after.count === 1 && after.children === 1 && after.selected === 1, JSON.stringify(after));
    rectAfterDrop = await geometryOfId(rectId);
    check('tool-drag:geometry-eq-panel', '落点处：**DOM 实测几何 == 属性面板里的数**（x/y 逐项相等；面板那两个「实测」读数逐字相等）',
      rectAfterDrop
      && Number(rectAfterDrop.panelX) === rectAfterDrop.x && Number(rectAfterDrop.panelY) === rectAfterDrop.y
      && rectAfterDrop.measureW === `实测 ${rectAfterDrop.w}px` && rectAfterDrop.measureH === `实测 ${rectAfterDrop.h}px`,
      JSON.stringify(rectAfterDrop));
    await shot('02-tool-drag-rect');
  });

  // ═══ 3. 拖拽移动（真鼠标；含吸附）＋ 拖角缩放 ═══════════════════════════════════════════
  await groupCheck('drag-resize', async () => {
    const before = await geometryOfId(rectId);
    const target = await box(`#dz-frame .dz-el[data-id="${rectId}"]`);
    const delta = { x: 37, y: 23 };
    await dragPoints({ x: target.cx, y: target.cy }, { x: target.cx + delta.x, y: target.cy + delta.y });
    const moved = await geometryOfId(rectId);
    check('drag:move', '拖动移动：实测位移 ≈ 鼠标位移（吸附最多再动 6px），且 DOM 实测几何 == 面板里的数',
      moved
      && Math.abs((moved.x - before.x) - delta.x) <= SNAP && Math.abs((moved.y - before.y) - delta.y) <= SNAP
      && Number(moved.panelX) === moved.x && Number(moved.panelY) === moved.y,
      JSON.stringify({ before: { x: before.x, y: before.y }, moved: { x: moved.x, y: moved.y }, delta }));

    const handle = await box('#dz-frame .dz-handle[data-role="resize-se"]');
    const frame = await box('#dz-frame');
    check('drag:handle-on-element', '缩放手柄长在选中元素身上（手柄中心落在元素的右下角附近）',
      handle !== null && Math.abs(handle.cx - (frame.left + moved.x + moved.w)) < 10
      && Math.abs(handle.cy - (frame.top + moved.y + moved.h)) < 10,
      JSON.stringify({ handle: handle && { cx: handle.cx, cy: handle.cy }, corner: [frame.left + moved.x + moved.w, frame.top + moved.y + moved.h] }));

    const resize = { x: 31, y: 17 };
    await dragPoints({ x: handle.cx, y: handle.cy }, { x: handle.cx + resize.x, y: handle.cy + resize.y }, { steps: 8 });
    const resized = await geometryOfId(rectId);
    check('drag:resize', '拖角缩放：实测宽/高各增 ≈ 拖的像素，且与面板上那两个数逐项相同',
      resized && Math.abs(resized.w - (moved.w + resize.x)) <= 1 && Math.abs(resized.h - (moved.h + resize.y)) <= 1
      && Number(resized.panelX) === resized.x && resized.measureW === `实测 ${resized.w}px`,
      JSON.stringify({ before: { w: moved.w, h: moved.h }, after: { w: resized.w, h: resized.h }, resize }));

    // 吸附与对齐线：把元素拖到左边缘附近（左边缘落在 3px 处）⇒ 吸附到 x=0
    const t2 = await box(`#dz-frame .dz-el[data-id="${rectId}"]`);
    const shift = 3 - (t2.left - frame.left);
    await dragPoints({ x: t2.cx, y: t2.cy }, { x: t2.cx + shift, y: t2.cy }, { steps: 6 });
    const snapped = await evalIn(`(() => ({
      geometry: (() => {
        const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(rectId)}]');
        const fr = document.querySelector('#dz-frame').getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left - fr.left) };
      })(),
      guides: document.querySelectorAll('#dz-frame .dz-guide').length,
    }))()`);
    check('drag:snap', '拖到父容器左边缘附近 ⇒ 吸附到 x=0（吸附真的把位置吸住了）', snapped.geometry.x === 0, JSON.stringify(snapped));
  });

  // ═══ 4. 属性面板：改属性 ⇒ 画布当场变 ═══════════════════════════════════════════════════
  await groupCheck('props-live', async () => {
    await evalIn(`(() => {
      const input = document.querySelector('#dz-panel [data-field="style-background"]');
      input.value = '#ff0000';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const background = await evalIn(`getComputedStyle(document.querySelector('#dz-frame .dz-el[data-type="rect"]')).backgroundColor`);
    check('props:live', '在属性面板把「背景」改成 #ff0000 ⇒ 画布上那个元素的 computed background-color 当场就是 rgb(255, 0, 0)',
      background === 'rgb(255, 0, 0)', JSON.stringify({ background }));

    await setControl('#dz-panel [data-field="size-w-value"]', '210');
    const geo = await geometryOfId(rectId);
    check('props:size', '改「尺寸 W」⇒ 实测宽当场变成 210px（面板的实测读数也跟着变）',
      geo.w === 210 && geo.measureW === '实测 210px', JSON.stringify({ w: geo.w, measureW: geo.measureW }));

    await setControl('#dz-panel [data-field="style-fontSize"]', '18');
    await setControl('#dz-panel [data-field="style-textAlign"]', 'center');
    await setControl('#dz-panel [data-field="element-name"]', '主矩形');
    const styleState = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-type="rect"]');
      const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, textAlign: cs.textAlign };
    })()`);
    check('props:style-others', '字号 / 文本对齐这几格也能改（computed 跟着变）',
      styleState.fontSize === '18px' && styleState.textAlign === 'center', JSON.stringify(styleState));
  });

  // ═══ 5. 容器语义：row ⇒ 水平排布；grid ⇒ 真网格 ═════════════════════════════════════════
  let textId = null;
  await groupCheck('layout-row', async () => {
    await clickSelector('[data-tool="rect"]'); // 只点一下 ⇒ 落到当前容器的级联位置
    const two = await evalIn('window.__dz.doc().screens[0].root.children.length');
    await clickSelector('.dz-layer[data-layer="el-1"]');
    await setControl('#dz-panel [data-field="layout-mode"]', 'row');
    await setControl('#dz-panel [data-field="layout-gap"]', '0');
    const measured = await evalIn(`(() => {
      const root = document.querySelector('#dz-frame .dz-el[data-id="el-1"]');
      const kids = [...root.children].filter((c) => c.classList.contains('dz-el'));
      return {
        display: getComputedStyle(root).display,
        direction: getComputedStyle(root).flexDirection,
        count: kids.length,
        rects: kids.map((k) => { const r = k.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; }),
      };
    })()`);
    const ys = measured.rects.map((r) => r.y);
    const xs = measured.rects.map((r) => r.x);
    check('layout:row', '切成 row ⇒ 容器真的是 flex(row)，子元素实测 **y 相同、x 递增**（量的是盒子）',
      two === 2 && measured.display === 'flex' && measured.direction === 'row' && measured.count === 2
      && new Set(ys).size === 1 && xs[0] < xs[1], JSON.stringify({ two, ...measured }));
    await shot('03-row');
  });

  await groupCheck('layout-fill', async () => {
    const kids = await evalIn(`(() => {
      const root = document.querySelector('#dz-frame .dz-el[data-id="el-1"]');
      return [...root.children].filter((c) => c.classList.contains('dz-el')).map((k) => k.dataset.id);
    })()`);
    const victim = kids.find((id) => id !== rectId);
    await clickSelector(`#dz-frame .dz-el[data-id="${victim}"]`);
    await clickSelector('#dz-panel .dz-inline button:last-child'); // 「删掉」
    await clickSelector(`#dz-frame .dz-el[data-id="${rectId}"]`);
    await setControl('#dz-panel [data-field="size-w-mode"]', 'fill');
    const filled = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(rectId)}]');
      const root = document.querySelector('#dz-frame .dz-el[data-id="el-1"]');
      const cs = getComputedStyle(root);
      const content = root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const r = el.getBoundingClientRect();
      return { childW: Math.round(r.width), content: Math.round(content), grow: getComputedStyle(el).flexGrow, remaining: root.children.length };
    })()`);
    check('layout:fill', '子元素 w=fill ⇒ **实测宽 ≈ 父容器内容宽**（flex-grow 真的拿走了剩余空间）',
      filled.remaining === 1 && Math.abs(filled.childW - filled.content) <= 1 && filled.grow === '1',
      JSON.stringify(filled));

    // content：加一个文本元素，w=content ⇒ 实测宽 > 0 且 < 父宽
    await clickSelector('[data-tool="text"]');
    textId = await evalIn(`(() => {
      const els = [...document.querySelectorAll('#dz-frame .dz-el[data-type="text"]')];
      return els[els.length - 1]?.dataset.id ?? null;
    })()`);
    await setControl('#dz-panel [data-field="size-w-mode"]', 'content');
    const contentMode = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(textId)}]');
      const root = document.querySelector('#dz-frame .dz-el[data-id="el-1"]');
      return { w: Math.round(el.getBoundingClientRect().width), parent: Math.round(root.clientWidth), grow: getComputedStyle(el).flexGrow };
    })()`);
    check('layout:content', 'text 的 w=content ⇒ 实测宽 > 0 且 < 父容器宽（没有去抢剩余空间）',
      contentMode.w > 0 && contentMode.w < contentMode.parent && contentMode.grow === '0', JSON.stringify(contentMode));
    await shot('04-fill-content');

    // column：容器换成 column ⇒ 子元素 x 相同、y 递增
    await clickSelector('.dz-layer[data-layer="el-1"]');
    await setControl('#dz-panel [data-field="layout-mode"]', 'column');
    const column = await evalIn(`(() => {
      const root = document.querySelector('#dz-frame .dz-el[data-id="el-1"]');
      const kids = [...root.children].filter((c) => c.classList.contains('dz-el'));
      const rects = kids.map((k) => { const r = k.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; });
      return { direction: getComputedStyle(root).flexDirection, rects };
    })()`);
    check('layout:column', '切成 column ⇒ flex-direction=column，子元素实测 **x 相同、y 递增**',
      column.direction === 'column' && column.rects.length === 2
      && new Set(column.rects.map((r) => r.x)).size === 1 && column.rects[0].y < column.rects[1].y,
      JSON.stringify(column));

    // grid：2 列 ⇒ 真的是 display:grid 且两条轨道
    await setControl('#dz-panel [data-field="layout-mode"]', 'grid');
    await setControl('#dz-panel [data-field="layout-columns"]', '2');
    const grid = await evalIn(`(() => {
      const root = document.querySelector('#dz-frame .dz-el[data-id="el-1"]');
      const cs = getComputedStyle(root);
      return { display: cs.display, columns: cs.gridTemplateColumns };
    })()`);
    check('layout:grid', '切成 grid + 2 列 ⇒ 容器真的是 display:grid 且 grid-template-columns 是 2 条轨道',
      grid.display === 'grid' && grid.columns.trim().split(/\s+/).length === 2, JSON.stringify(grid));
    await setControl('#dz-panel [data-field="layout-mode"]', 'free');
  });

  // ═══ 6. 多选与对齐 ═══════════════════════════════════════════════════════════════════════
  await groupCheck('align', async () => {
    const [a, b] = await evalIn('window.__dz.doc().screens[0].root.children.map((c) => c.id)');
    const setup = async (id, x, y, w, h) => {
      await clickSelector(`.dz-layer[data-layer="${id}"]`);
      await setControl('#dz-panel [data-field="box-x"]', String(x));
      await setControl('#dz-panel [data-field="box-y"]', String(y));
      await setControl('#dz-panel [data-field="size-w-mode"]', 'fixed');
      await setControl('#dz-panel [data-field="size-w-value"]', String(w));
      await setControl('#dz-panel [data-field="size-h-mode"]', 'fixed');
      await setControl('#dz-panel [data-field="size-h-value"]', String(h));
      await frames(1);
    };
    await setup(a, 40, 40, 120, 60);
    await setup(b, 260, 140, 140, 40);
    const placed = await evalIn(`(() => {
      const fr = document.querySelector('#dz-frame').getBoundingClientRect();
      const one = (id) => { const el = document.querySelector('#dz-frame .dz-el[data-id="' + id + '"]'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left - fr.left), y: Math.round(r.top - fr.top) }; };
      return { a: one(${JSON.stringify(a)}), b: one(${JSON.stringify(b)}) };
    })()`);
    check('align:panel-position', '属性面板里填 X/Y/W/H ⇒ 画布上真的落在那些数上（面板是双向的，不是只读展示）',
      placed.a.x === 40 && placed.a.y === 40 && placed.b.x === 260 && placed.b.y === 140, JSON.stringify(placed));

    const boxA = await box(`#dz-frame .dz-el[data-id="${a}"]`);
    const boxB = await box(`#dz-frame .dz-el[data-id="${b}"]`);
    await clickPoint({ x: boxA.cx, y: boxA.cy });
    await clickPoint({ x: boxB.cx, y: boxB.cy }, { modifiers: 8 }); // shift 点第二个（多选）
    const selected = await evalIn('window.__dz.selection()');
    check('align:multi-select', '画布上点一个、按住 shift 再点一个 ⇒ 选中 2 个（面板这时才出现对齐按钮）',
      selected.length === 2, JSON.stringify(selected));
    await clickSelector('#dz-panel [data-align="left"]');
    const aligned = await evalIn(`(() => {
      const fr = document.querySelector('#dz-frame').getBoundingClientRect();
      return ${JSON.stringify([a, b])}.map((id) => {
        const el = document.querySelector('#dz-frame .dz-el[data-id="' + id + '"]');
        return Math.round(el.getBoundingClientRect().left - fr.left);
      });
    })()`);
    check('align:left', '点「左」⇒ 两个元素实测左边缘相等（对齐真的落到几何上）', new Set(aligned).size === 1, JSON.stringify(aligned));
    await clickSelector('#dz-panel [data-align="top"]');
    const alignedTop = await evalIn(`(() => {
      const fr = document.querySelector('#dz-frame').getBoundingClientRect();
      return ${JSON.stringify([a, b])}.map((id) => {
        const el = document.querySelector('#dz-frame .dz-el[data-id="' + id + '"]');
        return Math.round(el.getBoundingClientRect().top - fr.top);
      });
    })()`);
    check('align:top', '点「上」⇒ 两个元素实测上边缘相等', new Set(alignedTop).size === 1, JSON.stringify(alignedTop));
    // 复原到不重叠的位置（后面还要用这两块）
    await clickSelector(`.dz-layer[data-layer="${b}"]`);
    await setControl('#dz-panel [data-field="box-x"]', '260');
    await setControl('#dz-panel [data-field="box-y"]', '140');
  });

  // ═══ 7. 撤销 / 重做 ═══════════════════════════════════════════════════════════════════════
  await groupCheck('undo', async () => {
    await clickSelector(`#dz-frame .dz-el[data-id="${rectId}"]`);
    const before = await geometryOfId(rectId);
    const beforeText = await evalIn('window.__dz.serialize()');
    const target = await box(`#dz-frame .dz-el[data-id="${rectId}"]`);
    await dragPoints({ x: target.cx, y: target.cy }, { x: target.cx + 44, y: target.cy + 29 });
    const after = await geometryOfId(rectId);

    // 「撤销不是重载页面」：先在 window 上放一个标记，撤销之后它必须还在
    await evalIn(`(() => { window.__dzMarker = 'marker-1'; window.__dzIdentity = window.__dz; return true; })()`);
    await safeClickSelector('#dz-undo');
    await sleep(250);
    const undone = await safeEval(`(() => ({
      marker: window.__dzMarker ?? null,
      sameObject: window.__dzIdentity === window.__dz,
      geometry: (() => {
        const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(rectId)}]');
        if (!el) return null;
        const fr = document.querySelector('#dz-frame').getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left - fr.left), y: Math.round(r.top - fr.top), w: Math.round(r.width), h: Math.round(r.height) };
      })(),
      text: window.__dz.serialize(),
    }))()`);
    check('undo:geometry', '拖完按撤销 ⇒ **实测几何回到完全相同的值**，序列化字节也回到拖之前那一份',
      undone && undone.geometry && undone.geometry.x === before.x && undone.geometry.y === before.y
      && undone.geometry.w === before.w && undone.geometry.h === before.h && undone.text === beforeText,
      JSON.stringify({ before: { x: before.x, y: before.y }, after: after && { x: after.x, y: after.y }, undone: undone && undone.geometry }));
    check('undo:marker', '撤销**不是重载页面**：撤销之后 window 上的标记还在、`__dz` 还是同一个对象（未保存状态没丢）',
      undone && undone.marker === 'marker-1' && undone.sameObject === true,
      JSON.stringify(undone && { marker: undone.marker, sameObject: undone.sameObject }));

    await safeClickSelector('#dz-redo');
    const redone = await geometryOfId(rectId).catch(() => null);
    check('redo:geometry', '重做 ⇒ 实测几何回到拖完那一刻（与撤销前逐项相等）',
      redone && after && redone.x === after.x && redone.y === after.y && redone.w === after.w && redone.h === after.h,
      JSON.stringify({ after: after && { x: after.x, y: after.y }, redone: redone && { x: redone.x, y: redone.y } }));

    // 多步撤销：三次改动（拖一次 / 改一次属性 / 加一个元素）⇒ 连撤三次回到那一串改动之前的字节
    const baseText = await evalIn('window.__dz.serialize()');
    const base = await geometryOfId(rectId);
    const historyBefore = await evalIn('window.__dz.historyIndex()');
    const t1 = await box(`#dz-frame .dz-el[data-id="${rectId}"]`);
    const c0 = await evalIn('window.__dz.commits()');
    await dragPoints({ x: t1.cx, y: t1.cy }, { x: t1.cx + 18, y: t1.cy + 11 });
    const c1 = await evalIn('window.__dz.commits()');
    await setControl('#dz-panel [data-field="style-background"]', '#00ff00');
    const c2 = await evalIn('window.__dz.commits()');
    await clickSelector('[data-tool="rect"]');
    const c3 = await evalIn('window.__dz.commits()');
    const midText = await evalIn('window.__dz.serialize()');
    const historyAfter = await evalIn('window.__dz.historyIndex()');
    await safeClickSelector('#dz-undo');
    await safeClickSelector('#dz-undo');
    await safeClickSelector('#dz-undo');
    const backText = await safeEval('window.__dz.serialize()');
    const historyBack = await safeEval('window.__dz.historyIndex()');
    const back = await geometryOfId(rectId).catch(() => null);
    check('undo:multi-step', '三处改动（拖一次 / 改一次属性 / 加一个元素）⇒ 连撤三次回到**逐字节相同**的文档，几何也一模一样',
      midText !== baseText && backText === baseText && back && back.x === base.x && back.y === base.y,
      JSON.stringify({ changed: midText !== baseText, restored: backText === baseText, base: { x: base.x, y: base.y }, back: back && { x: back.x, y: back.y }, history: { before: historyBefore, after: historyAfter, back: historyBack }, commits: { c0, drag: c1 - c0, style: c2 - c1, add: c3 - c2 } }));
    await shot('05-undo');
  });

  // ═══ 8. 多屏 ═════════════════════════════════════════════════════════════════════════════
  let screenOneSignature = null;
  await groupCheck('screens', async () => {
    screenOneSignature = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(rectId)}]');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), w: Math.round(r.width) };
    })()`);
    await clickSelector('#dz-add-screen');
    const fresh = await evalIn(`(() => ({
      screens: window.__dz.doc().screens.length,
      elements: document.querySelectorAll('#dz-frame .dz-el').length,
      children: window.__dz.doc().screens.find((s) => s.id === window.__dz.screenId()).root.children.length,
    }))()`);
    check('screens:independent', '加一屏 ⇒ 切过去是**空的**（1 个根元素、0 子元素），没把上一屏的内容带过来',
      fresh.screens === 2 && fresh.elements === 1 && fresh.children === 0, JSON.stringify(fresh));
    await clickSelector('[data-tool="button"]');
    const onSecond = await evalIn(`document.querySelectorAll('#dz-frame .dz-el[data-type="button"]').length`);
    await clickSelector('.dz-row[data-screen="screen-1"]');
    const back = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(rectId)}]');
      const r = el.getBoundingClientRect();
      return { buttons: document.querySelectorAll('#dz-frame .dz-el[data-type="button"]').length, x: Math.round(r.left), w: Math.round(r.width), screenId: window.__dz.screenId() };
    })()`);
    check('screens:switch-back', '切回第 1 屏 ⇒ 它的内容**一字不串**（第 2 屏那个按钮这里一个都没有；矩形几何与切走前一模一样）',
      onSecond === 1 && back.buttons === 0 && back.screenId === 'screen-1'
      && back.x === screenOneSignature.x && back.w === screenOneSignature.w,
      JSON.stringify({ onSecond, back, screenOneSignature }));
    await shot('06-back-to-screen-1');
  });

  // ═══ 9. 状态（同一屏的变体，可分别编辑）══════════════════════════════════════════════════
  await groupCheck('states', async () => {
    const stateOneGeometry = await geometryOfRect();
    await clickSelector('#dz-add-state');
    const afterAdd = await evalIn(`(() => ({
      states: window.__dz.doc().screens[0].states.length,
      ownTree: Boolean(window.__dz.doc().screens[0].states.at(-1).root),
      ids: window.__dz.doc().screens.find((s) => s.id === window.__dz.screenId()).states.map((st) => st.id),
    }))()`);
    check('states:add', '加一个状态 ⇒ 它自带一棵树（同屏变体；不是「标签切换」），切过去能看到同一份起点的内容',
      afterAdd.states === 2 && afterAdd.ownTree === true, JSON.stringify(afterAdd));

    const target = await box('#dz-frame .dz-el[data-type="rect"]');
    await clickPoint({ x: target.cx, y: target.cy });
    await dragPoints({ x: target.cx, y: target.cy }, { x: target.cx - 60, y: target.cy + 45 });
    const stateTwoGeometry = await geometryOfRect();
    await clickSelector(`.dz-row[data-state="${afterAdd.ids[0]}"]`);
    const backToOne = await geometryOfRect();
    await clickSelector(`.dz-row[data-state="${afterAdd.ids[1]}"]`);
    const backToTwo = await geometryOfRect();
    check('states:isolated', '在状态 2 里拖那个矩形 ⇒ 状态 1 的几何**一点没变**；再切回状态 2 ⇒ 改动还在（两份内容不串）',
      stateTwoGeometry && stateOneGeometry && stateTwoGeometry.x !== stateOneGeometry.x
      && backToOne.x === stateOneGeometry.x && backToOne.y === stateOneGeometry.y
      && backToTwo.x === stateTwoGeometry.x && backToTwo.y === stateTwoGeometry.y,
      JSON.stringify({ stateOne: stateOneGeometry, stateTwo: stateTwoGeometry, backToOne, backToTwo }));
    await shot('07-states');
    await clickSelector(`.dz-row[data-state="${afterAdd.ids[0]}"]`);
  });

  // ═══ 10. 转移（箭头由数据生成）════════════════════════════════════════════════════════════
  await groupCheck('arrows', async () => {
    await clickSelector('#dz-view-flow');
    const view = await evalIn(`(() => ({
      flowVisible: document.querySelector('#dz-flow').hidden === false,
      cards: document.querySelectorAll('#dz-flow .dz-card').length,
      arrows: document.querySelectorAll('#dz-arrows .dz-arrow-path').length,
      specs: window.__dz.arrowSpecs().length,
    }))()`);
    check('arrows:none', '数据里 0 条 transition ⇒ 流程画布上 **0 根箭头**（画布不会自己长出箭头来）',
      view.flowVisible && view.cards === 2 && view.arrows === 0 && view.specs === 0, JSON.stringify(view));
    await shot('08-multi-screen-no-arrow');

    await clickSelector('#dz-add-transition');
    await frames(4);
    const one = await evalIn(`(() => {
      const svg = document.querySelector('#dz-arrows').getBoundingClientRect();
      const path = document.querySelector('#dz-arrows .dz-arrow-path');
      if (!path) return { paths: 0 };
      const nums = path.getAttribute('d').match(/-?\\d+(?:\\.\\d+)?/g).map(Number);
      const fromCard = document.querySelector('#dz-flow .dz-card[data-screen="screen-1"]').getBoundingClientRect();
      const toCard = document.querySelector('#dz-flow .dz-card[data-screen="screen-2"]').getBoundingClientRect();
      return {
        paths: document.querySelectorAll('#dz-arrows .dz-arrow-path').length,
        arrowIds: [...document.querySelectorAll('#dz-arrows .dz-arrow-path')].map((p) => p.dataset.arrow),
        labels: [...document.querySelectorAll('#dz-arrows .dz-arrow-label')].map((t) => t.textContent),
        marker: path.getAttribute('marker-end'),
        start: [svg.left + nums[0], svg.top + nums[1]],
        end: [svg.left + nums[nums.length - 2], svg.top + nums[nums.length - 1]],
        fromEdge: [fromCard.right, fromCard.top + fromCard.height / 2],
        toEdge: [toCard.left, toCard.top + toCard.height / 2],
        transitions: window.__dz.doc().transitions.length,
        transitionIds: window.__dz.doc().transitions.map((t) => t.id),
      };
    })()`);
    check('arrows:add', '往数据里加一条 transition ⇒ 画布上**出现一根箭头**：带着那条 transition 的 id、带箭头 marker、两端分别落在两张屏卡上、触发文字写在箭头上',
      one.paths === 1 && one.transitions === 1 && one.marker === 'url(#dz-arrowhead)'
      && one.arrowIds.length === 1 && one.arrowIds[0] === one.transitionIds[0]
      && Math.abs(one.start[0] - one.fromEdge[0]) <= 3 && Math.abs(one.start[1] - one.fromEdge[1]) <= 3
      && Math.abs(one.end[0] - one.toEdge[0]) <= 3 && Math.abs(one.end[1] - one.toEdge[1]) <= 3
      && one.labels.includes('点一下'),
      JSON.stringify(one));
    await shot('09-arrow-from-data');

    const beforeD = await evalIn(`document.querySelector('#dz-arrows .dz-arrow-path')?.getAttribute('d') ?? null`);
    await setControl('#dz-transitions [data-transition] [data-field="to-screen"]', 'screen-1');
    await frames(4);
    const afterChange = await evalIn(`(() => ({
      d: document.querySelector('#dz-arrows .dz-arrow-path')?.getAttribute('d') ?? null,
      spec: window.__dz.arrowSpecs()[0] ?? null,
    }))()`);
    check('arrows:follows-data', '改那条 transition 的 to.screen ⇒ 箭头路径跟着变（真相在 transitions，图上只是它的视图）',
      afterChange.d !== null && afterChange.d !== beforeD && afterChange.spec.from === afterChange.spec.to,
      JSON.stringify({ beforeD, afterD: afterChange.d, spec: afterChange.spec }));

    await setControl('#dz-transitions [data-transition] [data-field="to-screen"]', 'screen-2');
    await frames(4);
    await clickSelector('#dz-add-transition');
    await frames(4);
    const twoArrows = await evalIn(`document.querySelectorAll('#dz-arrows .dz-arrow-path').length`);
    check('arrows:count-follows', '再加一条 transition ⇒ 画布上变成 2 根箭头（根数 == 数据的条数）', twoArrows === 2, JSON.stringify({ twoArrows }));

    await clickSelector('#dz-transitions [data-transition]:last-child button');
    await frames(4);
    const afterDelete = await evalIn(`(() => ({
      arrows: document.querySelectorAll('#dz-arrows .dz-arrow-path').length,
      arrowIds: [...document.querySelectorAll('#dz-arrows .dz-arrow-path')].map((p) => p.dataset.arrow),
      transitions: window.__dz.doc().transitions.length,
      transitionIds: window.__dz.doc().transitions.map((t) => t.id),
    }))()`);
    check('arrows:delete', '删掉一条 transition ⇒ 对应的那根箭头**消失**：剩下的箭头数 == 剩下的 transition 数，而且每根箭头的 id 就是那条数据的 id（画布上认不出「数据里没有的箭头」）',
      afterDelete.arrows === 1 && afterDelete.transitions === 1
      && afterDelete.arrowIds.length === 1 && afterDelete.arrowIds[0] === afterDelete.transitionIds[0],
      JSON.stringify(afterDelete));

    await clickSelector('#dz-transitions [data-transition] button');
    await frames(4);
    const allGone = await evalIn(`document.querySelectorAll('#dz-arrows .dz-arrow-path').length`);
    check('arrows:empty-again', '把最后一条也删掉 ⇒ 画布上 0 根箭头（与最初的状态逐项相同）', allGone === 0, JSON.stringify({ allGone }));
    await clickSelector('#dz-view-edit');
  });

  // ═══ 11. 导出 / 导入：往返逐字节相同 ══════════════════════════════════════════════════════
  await groupCheck('json-roundtrip', async () => {
    await clickSelector('#dz-add-transition');
    await setControl('#dz-transitions [data-transition] [data-field="trigger"]', '提交表单');
    await frames(2);
    const first = await evalIn('window.__dz.serialize()');
    const rounds = await evalIn(`(() => {
      const t1 = window.__dz.serialize();
      const t2 = window.__dz.serialize(window.__dz.parse(t1));
      const t3 = window.__dz.serialize(window.__dz.parse(t2));
      return { same12: t1 === t2, same23: t2 === t3, length: t1.length, head: t1.slice(0, 60) };
    })()`);
    check('json:roundtrip-byte-identical', '导出 ⇒ 导入 ⇒ 再导出：**两串逐字节相同**（三轮都试；缩进 2 格、末尾一个换行、键序固定）',
      rounds.same12 && rounds.same23, JSON.stringify(rounds));

    await evalIn(`(() => {
      window.__downloads = [];
      const original = HTMLAnchorElement.prototype.click;
      window.__restoreAnchorClick = () => { HTMLAnchorElement.prototype.click = original; };
      HTMLAnchorElement.prototype.click = function () { window.__downloads.push({ href: this.href, download: this.download }); };
      return true;
    })()`);
    await clickSelector('#dz-export');
    const download = await evalIn(`(async () => {
      const entry = window.__downloads[0] ?? null;
      if (!entry) return { ok: false };
      const text = await (await fetch(entry.href)).text();
      return { ok: true, name: entry.download, text, scheme: entry.href.split(':')[0] };
    })()`);
    check('json:download', '「导出 JSON」真的发一次下载：文件名 design.json，且下载到的**字节 == 导出串**',
      download.ok && download.name === 'design.json' && download.text === first && download.scheme === 'blob',
      JSON.stringify({ ok: download.ok, name: download.name, same: download.text === first, bytes: download.text?.length }));

    await evalIn(`(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
      return true;
    })()`);
    await clickSelector('#dz-copy');
    await frames(2);
    const copied = await evalIn('window.__copied');
    check('json:copy', '「复制 JSON」写进剪贴板的**字节 == 导出串**', copied === first, JSON.stringify({ same: copied === first, bytes: copied?.length }));

    const imported = await evalIn(`(() => {
      const doc = JSON.parse(window.__dz.serialize());
      doc.screens.push({
        id: 'imported-screen', name: '导入的屏',
        states: [{ id: 'imported-state', name: '默认' }],
        root: { id: 'imported-root', type: 'container', size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, layout: { mode: 'row' }, children: [
          { id: 'imported-child', type: 'rect', size: { w: { mode: 'fill' }, h: { mode: 'content' } } },
        ] },
      });
      doc.transitions.push({ id: 'tr-imported', from: { screen: 'screen-1', state: 'state-1' }, to: { screen: 'imported-screen', state: 'imported-state' }, trigger: '导入的箭头' });
      return window.__dz.serialize(doc);
    })()`);
    const feedFile = async (text) => evalIn(`(async () => {
      const data = new DataTransfer();
      data.items.add(new File([${JSON.stringify(text)}], 'design.json', { type: 'application/json' }));
      const input = document.querySelector('#dz-import');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await feedFile(imported);
    await page.waitFor(async () => (await safeEval('window.__dz.doc().screens.length')) === 3, '导入没有生效', 6000);
    const afterImport = await evalIn(`(() => ({
      screens: window.__dz.doc().screens.length,
      transitions: window.__dz.doc().transitions.length,
      text: window.__dz.serialize(),
      cards: document.querySelectorAll('#dz-flow .dz-card').length,
    }))()`);
    check('json:import', '导入一份改过的 JSON（多一屏 + 一条转移）⇒ 文档真的被换掉（3 屏 / 2 转移 / 3 张屏卡），再导出 == 它的规范形',
      afterImport.screens === 3 && afterImport.transitions === 2 && afterImport.text === imported,
      JSON.stringify({ screens: afterImport.screens, transitions: afterImport.transitions, sameBytes: afterImport.text === imported }));

    await feedFile(first);
    await page.waitFor(async () => (await safeEval('window.__dz.doc().screens.length')) === 2, '回滚导入没生效', 6000);
  });

  // ═══ 12. 预览（同一份文档、静态、零外部请求）══════════════════════════════════════════════
  await groupCheck('preview', async () => {
    await evalIn(`(() => {
      window.__resources = [];
      window.__resObserver = new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__resources.push(entry.name); });
      window.__resObserver.observe({ entryTypes: ['resource'] });
      return true;
    })()`);
    await clickSelector(`#dz-frame .dz-el[data-id="${rectId}"]`);
    const canvas = await geometryOfId(rectId);
    await clickSelector('#dz-preview-open');
    await frames(4);
    const preview = await evalIn(`(() => {
      const stage = document.querySelector('#dz-preview-stage');
      const el = stage.querySelector('.dz-el[data-id=${JSON.stringify(rectId)}]');
      const r = el?.getBoundingClientRect();
      return {
        visible: document.querySelector('#dz-preview').hidden === false,
        sameElement: !!el,
        w: r ? Math.round(r.width) : null,
        h: r ? Math.round(r.height) : null,
        staticFlags: stage.querySelectorAll('[data-static="true"]').length,
        elements: stage.querySelectorAll('.dz-el').length,
        chrome: stage.querySelectorAll('.dz-handle, .dz-overlay, .dz-selected, .dz-guide').length,
        summary: document.querySelector('#dz-preview-summary')?.textContent ?? null,
      };
    })()`);
    check('preview:static-render', '预览用**同一份文档**渲染：同一个元素 id 在场、尺寸与画布上逐项相同、元素带 data-static、没有手柄/选中框',
      preview.visible && preview.sameElement && preview.w === canvas.w && preview.h === canvas.h
      && preview.staticFlags === preview.elements && preview.chrome === 0,
      JSON.stringify({ preview, canvas: { w: canvas.w, h: canvas.h } }));
    await shot('10-preview');

    await clickSelector('#dz-preview-close');
    const resources = await evalIn(`(() => { window.__resObserver.disconnect(); return window.__resources; })()`);
    const external = (resources ?? []).filter((name) => /^https?:/i.test(name) || name.startsWith('blob:'));
    check('preview:zero-requests', '开预览 + 关预览这一段里**没有一条 http(s)/blob 资源被请求**（占位图是内联 data URI）',
      external.length === 0, JSON.stringify({ external, captured: (resources ?? []).length }));
  });

  // ═══ 13. 分割符（divider）：**可拉伸的分隔**，不是「画上去的一条线」═════════════════════
  let divContainerId = null;
  let dividerId = null;
  await groupCheck('divider', async () => {
    await clickSelector('#dz-view-edit');
    await clickSelector('#dz-new'); // 空白起：1 屏 / free 根 / 0 子元素（这一节要一份干净的画布）
    await frames(4);

    // 一个 row 容器（400×200、无间距/内边距），后面把分割符放进去
    await clickSelector('[data-tool="container"]');
    divContainerId = await evalIn('window.__dz.selection()[0]');
    await setControl('#dz-panel [data-field="size-w-mode"]', 'fixed');
    await setControl('#dz-panel [data-field="size-w-value"]', '400');
    await setControl('#dz-panel [data-field="size-h-mode"]', 'fixed');
    await setControl('#dz-panel [data-field="size-h-value"]', '200');
    await setControl('#dz-panel [data-field="layout-mode"]', 'row');
    await setControl('#dz-panel [data-field="layout-gap"]', '0');
    await setControl('#dz-panel [data-field="layout-padding"]', '0');
    await frames(2);

    // 工具栏「分割符」：点一下 ⇒ 落进当前选中的容器
    await clickSelector('[data-tool="divider"]');
    await frames(2);
    const dropped = await evalIn(`(() => {
      const container = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(divContainerId)}]');
      const dom = container?.querySelector('.dz-el-divider') ?? null;
      const containerEl = window.__dz.doc().screens[0].root.children.find((c) => c.id === ${JSON.stringify(divContainerId)});
      const data = containerEl?.children?.[0] ?? null;
      return {
        domTag: dom?.tagName ?? null,
        domCount: document.querySelectorAll('#dz-frame .dz-el-divider').length,
        aria: dom?.getAttribute('aria-orientation') ?? null,
        type: data?.type ?? null,
        orientation: data?.orientation ?? null,
        thickness: data?.thickness ?? null,
        color: data?.color ?? null,
        hasSize: data ? Object.prototype.hasOwnProperty.call(data, 'size') : null,
        serialized: JSON.stringify(data),
      };
    })()`);
    dividerId = await evalIn('window.__dz.selection()[0]');
    check('divider:drop', '工具栏「分割符」落进容器 ⇒ 数据里多一个 `type="divider"`（带 orientation/thickness/color），画布上它是一个**真元素 `<hr class="dz-el-divider">`**（不是 div 画的一条线），而且它没有自己的 `size`',
      dropped.domTag === 'HR' && dropped.domCount === 1 && dropped.aria === 'horizontal'
      && dropped.type === 'divider' && dropped.orientation === 'horizontal' && dropped.thickness === 1
      && typeof dropped.color === 'string' && dropped.hasSize === false,
      JSON.stringify(dropped));

    const measureDivider = () => evalIn(`(() => {
      const container = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(divContainerId)}]');
      const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(dividerId)}]');
      if (!container || !el) return null;
      const cs = getComputedStyle(container);
      const ecs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        containerW: Math.round(container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
        containerH: Math.round(container.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
        display: cs.display, direction: cs.flexDirection,
        borderTopWidth: ecs.borderTopWidth, borderLeftWidth: ecs.borderLeftWidth,
        borderTopColor: ecs.borderTopColor, borderLeftColor: ecs.borderLeftColor,
        orientation: el.dataset.orientation,
      };
    })()`);

    const row = await measureDivider();
    check('divider:stretch-row', '横分割符在 row 容器里 ⇒ 长边**实测 ≈ 容器内容宽**（flex 真的把它拉满了），短边 = thickness（实测 1px，厚度是那条 border 给的）',
      row && row.display === 'flex' && row.direction === 'row' && row.w === row.containerW && row.w === 400 && row.h === 1,
      JSON.stringify(row));

    // 容器一变宽，分割符**跟着伸展**（这才是「可拉伸的分隔」，不是画上去的一条线）
    await clickSelector(`.dz-layer[data-layer="${divContainerId}"]`);
    await setControl('#dz-panel [data-field="size-w-value"]', '300');
    await frames(2);
    const narrowed = await measureDivider();
    check('divider:follows-container', '把容器宽从 400 改成 300 ⇒ 分割符的实测宽**跟着变成 300**（它是布局里的一个元素，所以会跟着容器伸展）',
      narrowed && narrowed.w === 300 && narrowed.w !== row.w && narrowed.containerW === 300,
      JSON.stringify({ before: row && { w: row.w }, after: narrowed && { w: narrowed.w, containerW: narrowed.containerW } }));

    await setControl('#dz-panel [data-field="layout-mode"]', 'column');
    await frames(2);
    const column = await measureDivider();
    check('divider:stretch-column', '同一个横分割符在 column 容器里 ⇒ 仍然**沿交叉轴 stretch 满宽**（实测宽 ≈ 内容宽 300，短边仍 1px）',
      column && column.direction === 'column' && column.w === 300 && column.w === column.containerW && column.h === 1,
      JSON.stringify(column));

    // 方向改成竖的 ⇒ 长边变高（跟着容器伸展）、短边变宽（= thickness）
    await clickSelector(`#dz-frame .dz-el[data-id="${dividerId}"]`);
    await setControl('#dz-panel [data-field="divider-orientation"]', 'vertical');
    await frames(2);
    const vertical = await measureDivider();
    check('divider:vertical', '分割符「方向」改成竖 ⇒ 实测高 ≈ **容器内容高**（200，长边跟着容器）、实测宽 = thickness（厚度那条 border 落到左边）',
      vertical && vertical.orientation === 'vertical' && vertical.h === vertical.containerH && vertical.h === 200 && vertical.w === 1
      && vertical.borderLeftWidth === '1px' && vertical.borderTopWidth === '0px',
      JSON.stringify(vertical));

    await setControl('#dz-panel [data-field="divider-thickness"]', '4');
    await frames(2);
    const thick = await measureDivider();
    check('divider:thickness', '「粗细」改成 4 ⇒ 短边实测 **4px**（thickness 真的落到几何上，不是只改了个数字）',
      thick && thick.w === 4 && thick.borderLeftWidth === '4px' && thick.h === 200,
      JSON.stringify(thick));

    await setControl('#dz-panel [data-field="divider-color"]', '#ff0000');
    await frames(2);
    const colored = await measureDivider();
    check('divider:color', '「颜色」改成 #ff0000 ⇒ 那条 border 的 computed 颜色当场变（分割符的用色也在数据里）',
      colored && colored.borderLeftColor === 'rgb(255, 0, 0)' && colored.borderLeftWidth === '4px',
      JSON.stringify(colored));
    await shot('11-divider-in-container');

    // 坏值：粗细 0 ⇒ **可读报错** + 拒不写进文档（不许静默兜底）
    await setControl('#dz-panel [data-field="divider-thickness"]', '0');
    await frames(1);
    const badThickness = await evalIn(`(() => ({
      status: document.querySelector('#dz-status').textContent,
      kind: document.querySelector('#dz-status').dataset.kind ?? null,
      inDoc: window.__dz.doc().screens[0].root.children.find((c) => c.id === ${JSON.stringify(divContainerId)})?.children?.[0]?.thickness ?? null,
    }))()`);
    check('divider:reject-thickness', '面板里把「粗细」填 0 ⇒ **如实报错**（状态栏逐字写着「必须是正数」）且文档里那条 thickness 仍然是 4（没有被静默改成 1）',
      badThickness.kind === 'error' && badThickness.status.includes('必须是正数') && badThickness.inDoc === 4,
      JSON.stringify(badThickness));

    // 导出 HTML：分割符是**真元素**，不是绝对定位的一条线
    await evalIn('(() => { window.__dzHtmlForCheck = window.__dz.exportHtml(); return true; })()');
    const parsed = await evalIn(`(() => {
      const html = window.__dzHtmlForCheck;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const el = doc.querySelector('.dz-el-divider');
      return {
        htmlLength: html.length,
        head: html.slice(0, 40),
        tag: el?.tagName ?? null,
        style: el?.getAttribute('style') ?? null,
        aria: el?.getAttribute('aria-orientation') ?? null,
        external: html.includes('http://') || html.includes('https://'),
        dividers: doc.querySelectorAll('.dz-el-divider').length,
      };
    })()`);
    // 它自己的行内样式里要看得见「一条真 border」：style=solid、粗细 4px、颜色 rgb(255,0,0)，且它**不是**绝对定位的
    const styleOk = /border-style:\s*solid/.test(parsed.style ?? '')
      && /(^|;\s*)(border-width:\s*0px 0px 0px 4px|border-left-width:\s*4px)(;|$)/.test(parsed.style ?? '')
      && /(border-color|border-left-color):\s*rgb\(255,\s*0,\s*0\)/.test(parsed.style ?? '');
    check('divider:html-real-element', '「导出 HTML」里分割符是一个**真元素 `<hr class="dz-el-divider">`**（不是绝对定位的一条线、也不是背景色画的细矩形）：它自己的行内样式里有一条真 border（solid / 4px / 颜色都在）、骨架里有 `flex: 1 1 0`、没有 position:absolute；导出件里一条 http(s) 外链都没有',
      parsed.tag === 'HR' && parsed.dividers === 1 && parsed.aria === 'vertical' && styleOk
      && /flex:\s*1 1/.test(parsed.style ?? '') && !/position:\s*absolute/.test(parsed.style ?? '')
      && parsed.external === false && parsed.head.startsWith('<!doctype html>'),
      JSON.stringify({ ...parsed, styleOk }));

    // 导出的 JSON 往返仍然逐字节确定（带 divider 的文档）
    const roundtrip = await evalIn(`(() => {
      const t1 = window.__dz.serialize();
      const t2 = window.__dz.serialize(window.__dz.parse(t1));
      return { same: t1 === t2, hasDivider: t1.includes('"divider"'), hasFields: t1.includes('"orientation"') && t1.includes('"thickness"') && t1.includes('"color"') };
    })()`);
    check('divider:roundtrip', '带分割符的文档导出 ⇒ 导入 ⇒ 再导出仍然**逐字节相同**，而且 `orientation`/`thickness`/`color` 三格都在 JSON 里',
      roundtrip.same && roundtrip.hasDivider && roundtrip.hasFields, JSON.stringify(roundtrip));

    // 导入坏值（orientation 不是那两个 / thickness 不是正数）⇒ 可读报错 + 文档不变
    const feedJson = async (text) => evalIn(`(async () => {
      const data = new DataTransfer();
      data.items.add(new File([${JSON.stringify(text)}], 'bad.json', { type: 'application/json' }));
      const input = document.querySelector('#dz-import');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const validDoc = await evalIn('window.__dz.serialize()');
    const badOrientation = await evalIn(`(() => {
      const doc = JSON.parse(window.__dz.serialize());
      const container = doc.screens[0].root.children[0];
      container.children[0].orientation = 'diagonal';
      return JSON.stringify(doc);
    })()`);
    const beforeJson = await evalIn('window.__dz.serialize()');
    await feedJson(badOrientation);
    // 导入是异步的（`file.text()` 在后面一串 task 里）⇒ 等状态栏真的出现「导入失败」，否则读到的可能是上一格遗留的状态
    await page.waitFor(async () => String(await safeEval('document.querySelector("#dz-status")?.textContent ?? ""')).includes('导入失败'),
      '导入失败的状态没出现', 6000).catch(() => {});
    const badOrientationResult = await evalIn(`(() => ({
      status: document.querySelector('#dz-status').textContent,
      kind: document.querySelector('#dz-status').dataset.kind ?? null,
      doc: window.__dz.serialize(),
      dividers: document.querySelectorAll('#dz-frame .dz-el-divider').length,
    }))()`);
    check('divider:reject-orientation', '导入一份 `orientation: "diagonal"` 的文档 ⇒ **如实报错**（逐字说出只能 horizontal / vertical）且文档**一个字节没换**（画布上还是那个分割符）',
      badOrientationResult.kind === 'error' && badOrientationResult.status.includes('orientation')
      && badOrientationResult.status.includes('horizontal') && badOrientationResult.status.includes('vertical')
      && badOrientationResult.doc === beforeJson && badOrientationResult.dividers === 1,
      JSON.stringify({ status: badOrientationResult.status, unchanged: badOrientationResult.doc === beforeJson, dividers: badOrientationResult.dividers }));

    const badThicknessDoc = await evalIn(`(() => {
      const doc = JSON.parse(window.__dz.serialize());
      doc.screens[0].root.children[0].children[0].thickness = 0;
      return JSON.stringify(doc);
    })()`);
    await feedJson(badThicknessDoc);
    await page.waitFor(async () => String(await safeEval('document.querySelector("#dz-status")?.textContent ?? ""')).includes('导入失败'),
      '导入失败的状态没出现', 6000).catch(() => {});
    const badThicknessResult = await evalIn(`(() => ({
      status: document.querySelector('#dz-status').textContent,
      kind: document.querySelector('#dz-status').dataset.kind ?? null,
      doc: window.__dz.serialize(),
    }))()`);
    check('divider:reject-import-thickness', '导入一份 `thickness: 0` 的文档 ⇒ **如实报错**（逐字说出必须是正数）且文档没被换掉',
      badThicknessResult.kind === 'error' && badThicknessResult.status.includes('thickness')
      && badThicknessResult.status.includes('正数') && badThicknessResult.doc === beforeJson && validDoc === beforeJson,
      JSON.stringify({ status: badThicknessResult.status, unchanged: badThicknessResult.doc === beforeJson }));
  });

  // ═══ 14. 转移的配置界面：流程视图里的显眼入口 ＋ 一张明确的表单 ═════════════════════════
  await groupCheck('tform', async () => {
    await clickSelector('#dz-add-screen'); // 转移要有「到哪儿」：补出第二屏
    await frames(2);
    await clickSelector('#dz-view-flow');
    await frames(4);

    const empty = await evalIn(`(() => ({
      transitions: window.__dz.doc().transitions.length,
      noteHidden: document.querySelector('#dz-flow-empty').hidden,
      noteText: document.querySelector('#dz-flow-empty').textContent.trim(),
      btnText: document.querySelector('#dz-flow-add-transition').textContent.trim(),
      btnWide: document.querySelector('#dz-flow-add-transition').getBoundingClientRect().width,
      arrows: document.querySelectorAll('#dz-arrows .dz-arrow-path').length,
    }))()`);
    check('tform:empty-state', '没有转移时，流程视图里有一句**人话**（「还没有转移：点「＋ 添加转移」选一个屏」）＋ 一个显眼的「＋ 添加转移」按钮（不是一片空白让人猜）',
      empty.transitions === 0 && empty.noteHidden === false && empty.noteText.includes('还没有转移')
      && empty.noteText.includes('＋ 添加转移') && empty.btnText === '＋ 添加转移' && empty.btnWide > 0 && empty.arrows === 0,
      JSON.stringify(empty));
    await shot('12-flow-empty');

    await clickSelector('#dz-flow-add-transition');
    await frames(2);
    const opened = await evalIn(`(() => {
      const value = (sel) => { const el = document.querySelector(sel); return el ? el.value : null; };
      return {
        visible: document.querySelector('#dz-tform').hidden === false,
        mode: document.querySelector('#dz-tform').dataset.mode ?? null,
        title: document.querySelector('#dz-tform-title').textContent,
        hasFour: ['#dz-tform-from-screen', '#dz-tform-from-state', '#dz-tform-to-screen', '#dz-tform-to-state'].every((s) => document.querySelector(s) && document.querySelector(s).options.length > 0),
        trigger: document.querySelector('#dz-tform-trigger') !== null,
        fromScreen: value('#dz-tform-from-screen'),
        toScreen: value('#dz-tform-to-screen'),
        delHidden: document.querySelector('#dz-tform-delete').hidden,
      };
    })()`);
    check('tform:opens', '点「＋ 添加转移」⇒ 出现一张**明确的表单**：「从：屏 ▾ ＋ 状态 ▾」→「到：屏 ▾ ＋ 状态 ▾」→「触发」，而且它一打开就指向**另一个屏**（不是从=到）',
      opened.visible && opened.mode === 'new' && opened.title.includes('添加转移') && opened.hasFour && opened.trigger
      && opened.fromScreen && opened.toScreen && opened.fromScreen !== opened.toScreen && opened.delHidden === true,
      JSON.stringify(opened));
    await shot('13-tform-open');

    // 非法 1：缺屏
    await setControl('#dz-tform-to-screen', '');
    await frames(1);
    await clickSelector('#dz-tform-ok');
    await frames(2);
    const missingScreen = await evalIn(`(() => ({
      open: document.querySelector('#dz-tform').hidden === false,
      error: document.querySelector('#dz-tform-error').textContent.trim(),
      transitions: window.__dz.doc().transitions.length,
      arrows: document.querySelectorAll('#dz-arrows .dz-arrow-path').length,
    }))()`);
    check('tform:reject-missing-screen', '「到」没选屏就点确定 ⇒ **如实拒绝**（表单留在原地、错误逐字写着要选屏），`transitions` 一条都没加、画布上也没有箭头',
      missingScreen.open && missingScreen.error.includes('屏') && missingScreen.transitions === 0 && missingScreen.arrows === 0,
      JSON.stringify(missingScreen));

    // 非法 2：从=到（同屏同状态）
    const ids = await evalIn(`(() => ({
      screens: window.__dz.doc().screens.map((s) => s.id),
      states: window.__dz.doc().screens.map((s) => s.states.map((st) => st.id)),
    }))()`);
    await setControl('#dz-tform-from-screen', ids.screens[0]);
    await setControl('#dz-tform-from-state', ids.states[0][0]);
    await setControl('#dz-tform-to-screen', ids.screens[0]);
    await setControl('#dz-tform-to-state', ids.states[0][0]);
    await clickSelector('#dz-tform-ok');
    await frames(2);
    const sameEnds = await evalIn(`(() => ({
      open: document.querySelector('#dz-tform').hidden === false,
      error: document.querySelector('#dz-tform-error').textContent.trim(),
      transitions: window.__dz.doc().transitions.length,
    }))()`);
    check('tform:reject-same', '「从」和「到」选成**同屏同状态**就点确定 ⇒ **如实拒绝并说明**（不静默创建一条原地不动的废转移）',
      sameEnds.open && sameEnds.error.includes('同一条') && sameEnds.transitions === 0,
      JSON.stringify(sameEnds));

    // 合法：选源/目标 + 写触发 ⇒ 确定 ⇒ 箭头出现
    await setControl('#dz-tform-from-screen', ids.screens[0]);
    await setControl('#dz-tform-from-state', ids.states[0][0]);
    await setControl('#dz-tform-to-screen', ids.screens[1]);
    await setControl('#dz-tform-to-state', ids.states[1][0]);
    await setControl('#dz-tform-trigger', '点提交');
    await clickSelector('#dz-tform-ok');
    await frames(6);
    const created = await evalIn(`(() => ({
      formHidden: document.querySelector('#dz-tform').hidden,
      transitions: window.__dz.transitions(),
      paths: [...document.querySelectorAll('#dz-arrows .dz-arrow-path')].map((p) => p.dataset.arrow),
      labels: [...document.querySelectorAll('#dz-arrows .dz-arrow-label')].map((t) => ({ arrow: t.dataset.arrow, text: t.textContent })),
      noteHidden: document.querySelector('#dz-flow-empty').hidden,
    }))()`);
    const firstTransitionId = created.transitions[0]?.id ?? null;
    const createdOk = check('tform:ok-creates', '填完源/目标/触发 ⇒ 确定 ⇒ `transitions` 里真的多一条（trigger 就是写的那句）、画布上**立刻出现**那根箭头，且箭头的 `data-arrow` **就是这条数据的 id**（表单关掉、空态提示跟着收起来）',
      created.formHidden === true && created.transitions.length === 1 && firstTransitionId !== null
      && created.transitions[0].trigger === '点提交'
      && created.transitions[0].from.screen === ids.screens[0] && created.transitions[0].to.screen === ids.screens[1]
      && created.paths.length === 1 && created.paths[0] === firstTransitionId
      && created.labels.some((l) => l.arrow === firstTransitionId && l.text === '点提交')
      && created.noteHidden === true,
      JSON.stringify(created));
    await shot('14-arrow-from-form');

    if (createdOk) {
      const arrowHitPoint = () => evalIn(`(() => {
        const path = document.querySelector('#dz-arrows .dz-arrow-path');
        const svg = document.querySelector('#dz-arrows');
        if (!path || !svg) return null;
        const total = path.getTotalLength();
        const base = svg.getBoundingClientRect();
        for (const t of [0.5, 0.44, 0.56, 0.38, 0.62, 0.3, 0.7, 0.25, 0.75]) {
          const p = path.getPointAtLength(total * t);
          const x = base.left + p.x;
          const y = base.top + p.y;
          const owner = document.elementFromPoint(x, y)?.closest?.('[data-arrow]') ?? null;
          if (owner) return { x, y, id: owner.getAttribute('data-arrow'), tag: owner.tagName, cls: owner.getAttribute('class') };
        }
        return null;
      })()`);
      const hit = await arrowHitPoint();
      check('tform:arrow-clickable', '箭头的**路径上取一个真点**（getPointAtLength + elementFromPoint）⇒ 命中的就是那根箭头（它带着这条数据的 id，点得到）',
        hit !== null && hit.id === firstTransitionId, JSON.stringify(hit));

      if (hit) {
        await clickPoint({ x: hit.x, y: hit.y });
        await frames(3);
        const prefilled = await evalIn(`(() => {
          const value = (sel) => { const el = document.querySelector(sel); return el ? el.value : null; };
          return {
            visible: document.querySelector('#dz-tform').hidden === false,
            mode: document.querySelector('#dz-tform').dataset.mode ?? null,
            title: document.querySelector('#dz-tform-title').textContent,
            fromScreen: value('#dz-tform-from-screen'),
            fromState: value('#dz-tform-from-state'),
            toScreen: value('#dz-tform-to-screen'),
            toState: value('#dz-tform-to-state'),
            trigger: value('#dz-tform-trigger'),
            delHidden: document.querySelector('#dz-tform-delete').hidden,
          };
        })()`);
        check('tform:arrow-prefill', '点箭头 ⇒ 打开的是**同一张表单**，而且**带回原值**（从/到/触发逐项等于那条数据），「删掉这条」也出现了',
          prefilled.visible && prefilled.mode === 'edit' && prefilled.title.includes(firstTransitionId)
          && prefilled.fromScreen === created.transitions[0].from.screen && prefilled.fromState === created.transitions[0].from.state
          && prefilled.toScreen === created.transitions[0].to.screen && prefilled.toState === created.transitions[0].to.state
          && prefilled.trigger === '点提交' && prefilled.delHidden === false,
          JSON.stringify({ prefilled, data: created.transitions[0] }));
        await shot('15-tform-prefilled');

        await setControl('#dz-tform-trigger', '改成这个');
        await clickSelector('#dz-tform-ok');
        await frames(6);
        const edited = await evalIn(`(() => ({
          transitions: window.__dz.transitions(),
          labels: [...document.querySelectorAll('#dz-arrows .dz-arrow-label')].map((t) => t.textContent),
          paths: [...document.querySelectorAll('#dz-arrows .dz-arrow-path')].map((p) => p.dataset.arrow),
        }))()`);
        check('tform:edit', '在表单里改「触发」⇒ 确定 ⇒ 改的是**那条数据**（id 不变、trigger 变成新的），箭头上的文字当场跟着变',
          edited.transitions.length === 1 && edited.transitions[0].id === firstTransitionId
          && edited.transitions[0].trigger === '改成这个' && edited.labels.includes('改成这个')
          && !edited.labels.includes('点提交') && edited.paths[0] === firstTransitionId,
          JSON.stringify(edited));

        const hit2 = await arrowHitPoint();
        if (hit2) await clickPoint({ x: hit2.x, y: hit2.y });
        await frames(3);
        const reopened = await evalIn(`(() => ({
          open: document.querySelector('#dz-tform').hidden === false,
          trigger: document.querySelector('#dz-tform-trigger')?.value ?? null,
          delHidden: document.querySelector('#dz-tform-delete').hidden,
        }))()`);
        check('tform:reopen-prefill', '改完再点那根箭头 ⇒ 表单带回**改过之后**的值（说明它读的就是数据，不是一张画布上的贴纸）',
          reopened.open && reopened.trigger === '改成这个' && reopened.delHidden === false, JSON.stringify({ reopened, hit2 }));

        await clickSelector('#dz-tform-delete');
        await frames(6);
        const deleted = await evalIn(`(() => ({
          transitions: window.__dz.doc().transitions.length,
          arrows: document.querySelectorAll('#dz-arrows .dz-arrow-path').length,
          hits: document.querySelectorAll('#dz-arrows .dz-arrow-hit').length,
          labels: document.querySelectorAll('#dz-arrows .dz-arrow-label').length,
          formHidden: document.querySelector('#dz-tform').hidden,
          noteHidden: document.querySelector('#dz-flow-empty').hidden,
          noteText: document.querySelector('#dz-flow-empty').textContent.trim(),
        }))()`);
        check('tform:delete', '点箭头 ⇒ 「删掉这条」⇒ `transitions` 少一条、那根箭头（连同它的点击热区与文字）**消失**、空态提示回来（画布上认不出「数据里没有的箭头」）',
          deleted.transitions === 0 && deleted.arrows === 0 && deleted.hits === 0 && deleted.labels === 0
          && deleted.formHidden === true && deleted.noteHidden === false,
          JSON.stringify(deleted));
        await shot('16-tform-deleted');
      }
    }

    // 逃生口：取消 / Esc 关掉表单，什么也不写
    await clickSelector('#dz-flow-add-transition');
    await frames(2);
    const reopen = await evalIn('document.querySelector("#dz-tform").hidden === false');
    await clickSelector('#dz-tform-cancel');
    await frames(2);
    const cancelled = await evalIn(`(() => ({
      formHidden: document.querySelector('#dz-tform').hidden,
      transitions: window.__dz.doc().transitions.length,
    }))()`);
    check('tform:cancel', '「取消」关掉表单 ⇒ `transitions` 一条都没加（表单是数据的一个视图，取消就是什么都不发生）',
      reopen === true && cancelled.formHidden === true && cancelled.transitions === 0, JSON.stringify({ reopen, ...cancelled }));

    await clickSelector('#dz-view-edit');
  });

  // ═══ 15. 中立默认：新建出来的元素**不许**带我们的皮肤；而「3px 槽」要做就能做出来 ════════
  await groupCheck('neutral', async () => {
    await clickSelector('#dz-view-edit');
    await clickSelector('#dz-new'); // 空白起
    await frames(4);
    for (const tool of ['rect', 'text', 'button', 'input']) {
      await clickSelector(`[data-tool="${tool}"]`);
      await frames(1);
    }
    const ids = await evalIn('window.__dz.doc().screens[0].root.children.map((c) => c.id)');
    const readAll = () => evalIn(`(() => {
      const one = (type) => {
        const el = document.querySelector('#dz-frame .dz-el[data-type="' + type + '"]');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          inline: el.getAttribute('style') ?? '',
          bg: cs.backgroundColor,
          borders: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
          leftColor: cs.borderLeftColor,
          radius: cs.borderTopLeftRadius,
          fontSize: cs.fontSize,
          fontFamily: cs.fontFamily,
        };
      };
      const children = window.__dz.doc().screens[0].root.children;
      return {
        rect: one('rect'), text: one('text'), button: one('button'), input: one('input'),
        styleKeys: children.map((c) => (c.style ? Object.keys(c.style) : [])),
        noStyleKey: children.every((c) => !('style' in c)),
      };
    })()`);
    const neutral = await readAll();
    const isNeutral = (m) => Boolean(m) && m.bg === 'rgba(0, 0, 0, 0)' && m.borders.every((w) => w === '0px')
      && m.radius === '0px' && m.fontSize === '14px' && /system-ui/.test(m.fontFamily) && !/mono/i.test(m.fontFamily)
      && !/border/.test(m.inline) && !/background/.test(m.inline);
    check('neutral:new-rect', '新建一个矩形 ⇒ 它是**中立的**：实测背景透明、四边 0px、圆角 0、字号 14px ＋ 系统字体栈（不是我们面板那套 13px 等宽）—— 不是「sopho-pi 的一行」',
      isNeutral(neutral.rect), JSON.stringify(neutral.rect));
    check('neutral:new-text', '新建一个文本 ⇒ 同样中立（背景透明 / 无边框 / 14px 系统字体）',
      isNeutral(neutral.text), JSON.stringify(neutral.text));
    check('neutral:new-button', '新建一个**按钮** ⇒ 没有那条 3px 的槽（实测 border-left 0px、不是 slot.css 那条 `!important` 画的 3px）、背景透明、圆角 0',
      isNeutral(neutral.button), JSON.stringify(neutral.button));
    check('neutral:new-input', '新建一个**输入** ⇒ 同上（裸 `input` 也是被产品那条槽规则命中的标签）',
      isNeutral(neutral.input), JSON.stringify(neutral.input));
    check('neutral:not-in-style', '这些中立**不是写进元素 `style` 的皮肤**：新建出来的四个元素数据里一个 `style` 键都没有（中立是编辑器画布的基线，不是数据）',
      neutral.noStyleKey === true && neutral.styleKeys.every((keys) => keys.length === 0), JSON.stringify({ noStyleKey: neutral.noStyleKey, styleKeys: neutral.styleKeys }));

    await clickSelector(`.dz-layer[data-layer="${ids[1]}"]`);
    await frames(2);
    const selected = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(ids[1])}]');
      return {
        selectedClass: el.classList.contains('dz-selected'),
        inline: el.getAttribute('style') ?? '',
        outlinIsCss: getComputedStyle(el).outlineStyle !== 'none',
        hasStyleKey: 'style' in window.__dz.doc().screens[0].root.children[1],
      };
    })()`);
    check('neutral:selection-is-editor-only', '选中时那个框是**编辑器自己的高亮**：DOM 上挂 `.dz-selected`（outline 由样式表给），元素的 `style` 里仍然没有 border / background、数据里也没有 `style` 键',
      selected.selectedClass === true && selected.outlinIsCss === true && selected.hasStyleKey === false
      && !/border/.test(selected.inline) && !/background/.test(selected.inline),
      JSON.stringify(selected));
    await shot('17-blank-new-element');

    await evalIn('(() => { window.__dzHtmlNeutral = window.__dz.exportHtml(); return true; })()');
    const exported = await evalIn(`(() => {
      const html = window.__dzHtmlNeutral;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const rect = doc.querySelector('.dz-el-rect');
      return {
        style: rect ? rect.getAttribute('style') : null,
        buttons: doc.querySelectorAll('.dz-el-button').length,
        neutralFont: html.includes('font: 14px/1.5') && html.includes('system-ui'),
        monoFont: html.includes('ui-monospace'),
      };
    })()`);
    check('neutral:export', '「导出 HTML」里那些新建元素也是中立的（行内样式里没有 background / border），且导出件自己的字体也是 14px ＋ 系统字体栈（没有把我们面板的 13px 等宽带出去）',
      exported.style !== null && !/background/.test(exported.style) && !/border/.test(exported.style)
      && exported.buttons === 1 && exported.neutralFont === true && exported.monoFont === false,
      JSON.stringify(exported));

    await clickSelector('#dz-preview-open');
    await frames(3);
    const inPreview = await evalIn(`(() => {
      const stage = document.querySelector('#dz-preview-stage');
      const rect = stage.querySelector('.dz-el-rect');
      const button = stage.querySelector('.dz-el-button');
      if (!rect || !button) return { found: false };
      const rcs = getComputedStyle(rect);
      const bcs = getComputedStyle(button);
      return {
        found: true,
        rectBg: rcs.backgroundColor,
        rectBorders: [rcs.borderTopWidth, rcs.borderRightWidth, rcs.borderBottomWidth, rcs.borderLeftWidth],
        rectFont: rcs.fontSize,
        buttonLeft: bcs.borderLeftWidth,
        buttonBg: bcs.backgroundColor,
      };
    })()`);
    await clickSelector('#dz-preview-close');
    // 预览没关掉的话，后面所有画布点击都会被那层盖住（选中不了、面板也就不会出现那几格）⇒ 等它真的关掉
    await page.waitFor(async () => (await safeEval('document.querySelector("#dz-preview").hidden')) === true, '预览没有关掉', 6000).catch(() => {});
    check('neutral:preview', '预览里也是中立的（同一个渲染器、同一个中立基线：矩形的背景透明、四边 0，按钮没有那条 3px 槽）',
      inPreview.found === true && inPreview.rectBg === 'rgba(0, 0, 0, 0)' && inPreview.rectBorders.every((w) => w === '0px')
      && inPreview.rectFont === '14px' && inPreview.buttonLeft === '0px' && inPreview.buttonBg === 'rgba(0, 0, 0, 0)',
      JSON.stringify(inPreview));

    // 「槽」不是被删掉了：用属性面板（单边边框 ＋ 颜色）把它**做出来**
    //   选中一律走**图层行**：画布上那几个元素是相互叠着的（矩形被按钮盖住），按中心点点中的不一定是你要的那个
    await clickSelector(`.dz-layer[data-layer="${ids[2]}"]`); // 按钮
    await frames(2);
    await setControl('#dz-panel [data-field="style-color"]', '#8abeb7');
    await setControl('#dz-panel [data-field="style-borderLeftWidth"]', '3');
    await frames(2);
    const buttonSlot = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(ids[2])}]');
      const cs = getComputedStyle(el);
      return {
        left: cs.borderLeftWidth, leftColor: cs.borderLeftColor, leftStyle: cs.borderLeftStyle,
        other: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth],
        inline: el.getAttribute('style') ?? '',
      };
    })()`);
    check('slot:made-on-button', '用属性面板给**按钮**做一条 3px 槽（左 = 3 ＋ 文字色 #8abeb7）⇒ 实测 border-left 真是 3px / rgb(138, 190, 183)（元素自己的边框盖过了产品那条 `!important` 的槽），且其余三边仍是 0（没有凭空长出三条 3px 实线）',
      buttonSlot.left === '3px' && buttonSlot.leftColor === 'rgb(138, 190, 183)' && buttonSlot.leftStyle === 'solid'
      && buttonSlot.other.every((w) => w === '0px'), JSON.stringify(buttonSlot));

    await clickSelector(`.dz-layer[data-layer="${ids[0]}"]`); // 矩形
    await frames(2);
    await setControl('#dz-panel [data-field="style-color"]', '#8abeb7');
    await setControl('#dz-panel [data-field="style-borderLeftWidth"]', '3');
    await setControl('#dz-panel [data-field="style-borderTopWidth"]', '2');
    await frames(2);
    const rectSlot = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(ids[0])}]');
      const cs = getComputedStyle(el);
      return {
        left: cs.borderLeftWidth, leftColor: cs.borderLeftColor, top: cs.borderTopWidth, topStyle: cs.borderTopStyle,
        right: cs.borderRightWidth, bottom: cs.borderBottomWidth,
        json: window.__dz.doc().screens[0].root.children[0].style ?? null,
      };
    })()`);
    check('slot:made-on-rect', '同一个面板给矩形做「左 3px ＋ 上 2px」⇒ 实测就是**那两条边**（左 3 / 上 2，右·下仍是 0）—— 单边边框真的单边',
      rectSlot.left === '3px' && rectSlot.top === '2px' && rectSlot.topStyle === 'solid'
      && rectSlot.right === '0px' && rectSlot.bottom === '0px', JSON.stringify(rectSlot));
    check('slot:json-minimal', '做出来的槽**就是数据里的那几格**：`style = { color, borderLeftWidth, borderTopWidth }`（左 = 3、上 = 2、颜色是那个值），没有额外的皮肤字段',
      rectSlot.json && rectSlot.json.color === '#8abeb7' && String(rectSlot.json.borderLeftWidth) === '3'
      && String(rectSlot.json.borderTopWidth) === '2' && Object.keys(rectSlot.json).length === 3,
      JSON.stringify(rectSlot.json));
    await shot('18-slot-made-by-panel');
  });

  // ═══ 15.5 属性面板**跟着父容器换语汇**（作业单①：现在正是「改了没反应」的来源）════════════
  await groupCheck('panel-ctx', async () => {
    await clickSelector('#dz-add-screen'); // 另起一屏，别搅到前面那屏
    await frames(2);

    // (a) 父容器是 free：画布往屏根（free）里放一个矩形
    await clickSelector('[data-tool="rect"]');
    await frames(2);
    const freePanel = await evalIn(`(() => {
      const q = (f) => !!document.querySelector('#dz-panel [data-field="' + f + '"]');
      const text = document.querySelector('#dz-panel').textContent;
      return {
        boxX: q('box-x'), boxY: q('box-y'), sizeW: q('size-w-mode'), sizeWValue: q('size-w-value'),
        layoutMode: q('layout-mode'), gap: q('layout-gap'), padding: q('layout-padding'),
        align: q('layout-align'), columns: q('layout-columns'),
        vocab: [...document.querySelectorAll('#dz-panel .dz-group')].map((g) => g.dataset.vocab ?? null),
        titles: [...document.querySelectorAll('#dz-panel .dz-group > h3')].map((h) => h.textContent),
        hasFreeTitle: [...document.querySelectorAll('#dz-panel .dz-group > h3')].some((h) => h.textContent.includes('自由定位')),
        hasAutoTitle: [...document.querySelectorAll('#dz-panel .dz-group > h3')].some((h) => h.textContent.includes('自动排布')),
      };
    })()`);
    check('panel:free-vocab', '父容器是 free ⇒ 面板给的是「自由定位（父容器是自由容器）」那一套：有 `box`（X/Y）＋尺寸三档；**没有** 容器布局那几格（模式/间距/内边距/对齐/列数，它们属于容器或 auto 语义）',
      freePanel.boxX === true && freePanel.boxY === true && freePanel.sizeW === true && freePanel.sizeWValue === true
      && freePanel.layoutMode === false && freePanel.gap === false && freePanel.padding === false
      && freePanel.align === false && freePanel.columns === false
      && freePanel.vocab.includes('free') && freePanel.hasFreeTitle === true && freePanel.hasAutoTitle === false,
      JSON.stringify(freePanel));
    await shot('19-panel-free');

    // (b) 造一个 row 容器，再往里放一个矩形 ⇒ 父容器是 auto
    await clickSelector('[data-tool="container"]');
    const rowId = await evalIn('window.__dz.selection()[0]');
    await setControl('#dz-panel [data-field="layout-mode"]', 'row');
    await setControl('#dz-panel [data-field="layout-gap"]', '0');
    await setControl('#dz-panel [data-field="layout-padding"]', '0');
    await frames(2);
    await clickSelector('[data-tool="rect"]'); // 当前选中的是 row 容器 ⇒ 落进它里面
    await frames(2);
    const autoPanel = await evalIn(`(() => {
      const q = (f) => !!document.querySelector('#dz-panel [data-field="' + f + '"]');
      const text = document.querySelector('#dz-panel').textContent;
      const labels = [...document.querySelectorAll('#dz-panel .dz-axis > span:first-child')].map((s) => ({ text: s.textContent, role: s.dataset.role ?? null }));
      return {
        boxX: q('box-x'), boxY: q('box-y'), sizeW: q('size-w-mode'), sizeH: q('size-h-mode'), sizeWValue: q('size-w-value'),
        vocab: [...document.querySelectorAll('#dz-panel .dz-group')].map((g) => g.dataset.vocab ?? null),
        labels,
        hasAutoTitle: [...document.querySelectorAll('#dz-panel .dz-group > h3')].some((h) => h.textContent.includes('自动排布')),
        hasFreeTitle: [...document.querySelectorAll('#dz-panel .dz-group > h3')].some((h) => h.textContent.includes('自由定位')),
      };
    })()`);
    check('panel:auto-vocab', '父容器是 row ⇒ 面板换成「自动排布（父容器是 row / column / grid）」那一套：有 `size` 三档（Fixed / Hug / Fill）＋**主轴 / 交叉轴**标注；**没有** `box`（X/Y 整组不出现）',
      autoPanel.boxX === false && autoPanel.boxY === false && autoPanel.sizeW === true && autoPanel.sizeH === true && autoPanel.sizeWValue === true
      && autoPanel.vocab.includes('auto') && autoPanel.hasAutoTitle === true && autoPanel.hasFreeTitle === false
      && autoPanel.labels.length === 2 && autoPanel.labels.some((l) => l.role === '主轴') && autoPanel.labels.some((l) => l.role === '交叉轴'),
      JSON.stringify(autoPanel));
    await shot('20-panel-auto');

    // 不可用项**不会被当成可用**：box 那几格整组不在 ⇒ 试图改它也点不到、文档里那个 box.x 一个字节不变
    const attempt = await setControl('#dz-panel [data-field="box-x"]', '999');
    await frames(1);
    const boxAfter = await evalIn(`(() => {
      const walk = (n) => { if (n.id === window.__dz.selection()[0]) return n; for (const c of n.children ?? []) { const r = walk(c); if (r) return r; } return null; };
      const screen = window.__dz.doc().screens.find((s) => s.id === window.__dz.screenId());
      return walk(screen.root)?.box ?? null;
    })()`);
    check('panel:hidden-not-usable', 'auto 父容器下 `box` 那几格**整组不出现**（不是「禁用但装成可改」）：`[data-field="box-x"]` 不在面板里、`setControl` 明确返回 no element，文档里那个 `box.x` 一个字节没变',
      attempt.ok === false && boxAfter !== null && Number(boxAfter.x) !== 999,
      JSON.stringify({ attempt, boxAfter }));

    // (c) 选中**容器自身**：显示它的 layout ＋ 它自己的 size
    await clickSelector(`.dz-layer[data-layer="${rowId}"]`);
    await frames(2);
    const containerPanel = await evalIn(`(() => {
      const q = (f) => !!document.querySelector('#dz-panel [data-field="' + f + '"]');
      const text = document.querySelector('#dz-panel').textContent;
      return {
        mode: q('layout-mode'), gap: q('layout-gap'), padding: q('layout-padding'), align: q('layout-align'), columns: q('layout-columns'),
        sizeW: q('size-w-mode'), boxX: q('box-x'),
        vocab: [...document.querySelectorAll('#dz-panel .dz-group')].map((g) => g.dataset.vocab ?? null),
        hasContainerTitle: [...document.querySelectorAll('#dz-panel .dz-group > h3')].some((h) => h.textContent.includes('容器布局')),
      };
    })()`);
    check('panel:container-vocab', '选中**容器自身** ⇒ 面板给它的 `layout`（模式/间距/内边距/对齐/列数）＋它自己的 `size`，而且这些格带着「容器布局」这条分区标题（不是和自由定位那套混成一堆）',
      containerPanel.mode === true && containerPanel.gap === true && containerPanel.padding === true && containerPanel.align === true && containerPanel.columns === true
      && containerPanel.sizeW === true && containerPanel.boxX === true
      && containerPanel.vocab.includes('container') && containerPanel.vocab.includes('free') && containerPanel.hasContainerTitle === true,
      JSON.stringify(containerPanel));
    await shot('21-panel-container');
  });

  // ═══ 15.6 「竖分割符 ⇒ 两栏各自自适应」：结构 ＋ 两条**钉死并实测**的语义 ═══════════════════
  await groupCheck('cols', async () => {
    await clickSelector('#dz-add-screen'); // 另起一屏，专门搭两栏
    await frames(2);

    // 外层容器 row（宽 640 / 高 300，无间距无内边距）
    await clickSelector('[data-tool="container"]');
    const rowId = await evalIn('window.__dz.selection()[0]');
    await setControl('#dz-panel [data-field="size-w-mode"]', 'fixed');
    await setControl('#dz-panel [data-field="size-w-value"]', '640');
    await setControl('#dz-panel [data-field="size-h-mode"]', 'fixed');
    await setControl('#dz-panel [data-field="size-h-value"]', '300');
    await setControl('#dz-panel [data-field="layout-mode"]', 'row');
    await setControl('#dz-panel [data-field="layout-gap"]', '0');
    await setControl('#dz-panel [data-field="layout-padding"]', '0');
    await frames(2);

    // 子 1：容器 w=fill
    await clickSelector('[data-tool="container"]');
    const leftId = await evalIn('window.__dz.selection()[0]');
    await setControl('#dz-panel [data-field="size-w-mode"]', 'fill');
    await setControl('#dz-panel [data-field="size-h-mode"]', 'fill');
    await frames(2);

    // 子 2：竖分割符（thickness 4），加在 row 里（所以先选回 row）
    await clickSelector(`.dz-layer[data-layer="${rowId}"]`);
    await clickSelector('[data-tool="divider"]');
    const dividerId = await evalIn('window.__dz.selection()[0]');
    await setControl('#dz-panel [data-field="divider-orientation"]', 'vertical');
    await setControl('#dz-panel [data-field="divider-thickness"]', '4');
    await frames(2);

    // 子 3：容器 w=fill（排在分割符后面）
    await clickSelector(`.dz-layer[data-layer="${rowId}"]`);
    await clickSelector('[data-tool="container"]');
    const rightId = await evalIn('window.__dz.selection()[0]');
    await setControl('#dz-panel [data-field="size-w-mode"]', 'fill');
    await setControl('#dz-panel [data-field="size-h-mode"]', 'fill');
    await frames(2);

    const measureCols = () => evalIn(`(() => {
      const row = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(rowId)}]');
      const left = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(leftId)}]');
      const divider = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(dividerId)}]');
      const right = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(rightId)}]');
      if (!row || !left || !divider || !right) return null;
      const cs = getComputedStyle(row);
      const content = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const w = (el) => Math.round(el.getBoundingClientRect().width);
      const dcs = getComputedStyle(divider);
      return {
        content: Math.round(content), leftW: w(left), dividerW: w(divider), rightW: w(right),
        sum: w(left) + w(divider) + w(right),
        leftFlex: getComputedStyle(left).flex, rightFlex: getComputedStyle(right).flex,
        dividerFlex: dcs.flex, dividerBox: dcs.boxSizing, dividerBorderLeft: dcs.borderLeftWidth,
        dividerPosition: dcs.position,
        order: [...row.children].filter((c) => c.classList.contains('dz-el')).map((c) => c.dataset.id),
      };
    })()`);

    const wide = await measureCols();
    check('cols:equal-split', '两个 `fill` 兄弟在 row 的主轴上**平分剩余空间**（实测左宽 == 右宽）—— 语义是「等分」，不是按 `size.value` 权重（v0 没有 grow 权重字段）',
      wide && wide.leftFlex === '1 1 0px' && wide.rightFlex === '1 1 0px' && wide.leftW === wide.rightW && wide.leftW > 0,
      JSON.stringify({ leftW: wide?.leftW, rightW: wide?.rightW, leftFlex: wide?.leftFlex, rightFlex: wide?.rightFlex }));
    check('cols:sum-eq-parent', '两栏宽 ＋ 分割符宽 **== 父容器内容宽**（分割符**占位、不参与拉伸** ⇒ 不会溢出）',
      wide && wide.sum === wide.content && wide.content === 640 && wide.dividerPosition === 'relative',
      JSON.stringify({ content: wide?.content, sum: wide?.sum, leftW: wide?.leftW, dividerW: wide?.dividerW, rightW: wide?.rightW, dividerPosition: wide?.dividerPosition }));
    check('cols:divider-is-thickness', '分割符在 row 里的**主轴占位 == thickness**（实测宽 4，`flex: 0 0 auto` ＋ `content-box` 的那条 border 就是它的占位）',
      wide && wide.dividerW === 4 && wide.dividerBorderLeft === '4px' && /^0 0/.test(wide.dividerFlex) && wide.dividerBox === 'content-box',
      JSON.stringify({ dividerW: wide?.dividerW, borderLeft: wide?.dividerBorderLeft, flex: wide?.dividerFlex, box: wide?.dividerBox }));
    await shot('22-two-columns');

    // 改父宽 640 → 500 ⇒ 两栏跟着变（这就是「自动适应」）
    await clickSelector(`.dz-layer[data-layer="${rowId}"]`);
    await setControl('#dz-panel [data-field="size-w-value"]', '500');
    await frames(2);
    const narrow = await measureCols();
    check('cols:follows-parent', '把外层容器宽从 640 改成 500 ⇒ **两栏各自跟着变窄**（实测左==右、且都小于改之前），两栏宽 ＋ 分割符宽仍 == 父宽 500（这就是「两个容器各自自动适应」）',
      narrow && narrow.content === 500 && narrow.sum === 500 && narrow.leftW === narrow.rightW && narrow.leftW < wide.leftW,
      JSON.stringify({ content: narrow?.content, sum: narrow?.sum, leftW: narrow?.leftW, rightW: narrow?.rightW, wasLeftW: wide?.leftW }));
    await shot('23-two-columns-narrow');

    // 改 thickness 4 → 10 ⇒ 分割符跟着变、两栏再让出那 6px
    await clickSelector(`#dz-frame .dz-el[data-id="${dividerId}"]`);
    await setControl('#dz-panel [data-field="divider-thickness"]', '10');
    await frames(2);
    const thick = await measureCols();
    check('cols:follows-thickness', '把分割符 `thickness` 从 4 改成 10 ⇒ 分割符实测宽 **跟着变 10**、两栏再各让出 3px，总和仍 == 父宽 500（分割符占位与拉伸互不干扰）',
      thick && thick.dividerW === 10 && thick.sum === 500 && thick.leftW === thick.rightW && thick.leftW < narrow.leftW,
      JSON.stringify({ dividerW: thick?.dividerW, content: thick?.content, sum: thick?.sum, leftW: thick?.leftW, rightW: thick?.rightW, wasLeftW: narrow?.leftW }));
    await shot('24-two-columns-thick-divider');
  });

  // ═══ 15.7 复制 JSON：**三级降级**（安全上下文 → 兼容路径 → 手动框）════════════════════════════
  // 业主原话（逐字）：「复制失败：can't access property "writeText", navigator.clipboard is undefined
  // （可以用「导出 JSON」下载）」—— 根因：`navigator.clipboard` **只在安全上下文存在**（HTTPS 或
  // localhost / 127.0.0.1），从**局域网 IP ＋ 明文 HTTP** 打开时它是 `undefined`，而旧实现直接调了
  // `.writeText`。这一组把三级各量一遍：
  //   a) 正常上下文 ⇒ 走 ① clipboard，且**真剪贴板读回 == 导出串**（Windows 会把 `\n` 存成 `\r\n`：
  //      见 `sameClipboardText`，只在这一件事上归一化，别的一律逐字节比）；
  //   b) 模拟非安全上下文（`Page.addScriptToEvaluateOnNewDocument` 在**页面脚本之前**把
  //      `navigator.clipboard` 拿掉、把 `window.isSecureContext` 改成 false，模拟的正是「局域网 IP ＋
  //      明文 HTTP」）⇒ 点复制：**不出现「复制失败」**、退到 ②，且**真剪贴板**里是这一臂的导出串
  //      （先放一串哨兵：复制成了就必然被覆盖）；
  //   c) 同一个非安全页面里再把兼容路径打死（测试侧 `document.execCommand = () => false`）⇒ ③ 手动框：
  //      只读 textarea、内容全选、框里**逐字节**是导出串、文案如实（安全上下文 / Ctrl+C / 导出 JSON）。
  // ⚠️ 这一组会**重新导航**页面（注入脚本必须在页面脚本之前生效），所以它排在所有页面交互之后。
  await groupCheck('clipboard-fallback', async () => {
    /** Windows 剪贴板把 `\n` 存成 `\r\n`（实测；原始读数写进逐条 detail 里）⇒ 只归一化这一件事。 */
    const sameClipboardText = (read, expected) => typeof read === 'string'
      && read.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n');
    const readNativeClipboard = () => evalIn(`(async () => {
      try { return { ok: true, text: await window.__nativeClipboardDesc.get.call(navigator).readText() }; }
      catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
    })()`);
    /** a 臂用：那一臂里原生的 `navigator.clipboard` 就在场（还没被注入脚本拿掉）。 */
    const readClipboardApi = () => evalIn(`(async () => {
      try { return { ok: true, text: await navigator.clipboard.readText() }; }
      catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
    })()`);
    const copyState = () => evalIn(`(() => {
      const status = document.querySelector('#dz-status');
      const panel = document.querySelector('#dz-copy-panel');
      const area = document.querySelector('#dz-copy-text');
      return {
        text: status.textContent, kind: status.dataset.kind ?? null, path: status.dataset.copyPath ?? null,
        title: status.title ?? null, trace: window.__dz.copyTrace(),
        panelHidden: panel.hidden, value: area.value, readOnly: area.readOnly,
        selectedAll: document.activeElement === area && area.selectionStart === 0 && area.selectionEnd === area.value.length,
        lead: document.querySelector('#dz-copy-lead').textContent,
        why: document.querySelector('#dz-copy-why').textContent,
      };
    })()`);

    // ── a) 正常上下文：走 ① 现代 API（真剪贴板；CDP 授权 ＋ focus 模拟，不然 headless 里读不回）
    await page.browser.send('Browser.grantPermissions', {
      origin: `http://127.0.0.1:${page.port}`,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    await page.browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const restored = await evalIn(`(() => {
      delete navigator.clipboard; // 上一组（json-roundtrip）插进去的假对象是自有属性：删掉，让原生的那一格回来
      return { clip: typeof navigator.clipboard, secure: window.isSecureContext, inProto: 'clipboard' in Navigator.prototype, panel: !!document.querySelector('#dz-copy-panel') };
    })()`);
    check('clip:secure-api', 'a 臂的前提：页面是**安全上下文**、原生的 `navigator.clipboard` 在场（把上一组插进去的假对象删掉）、手动框在 DOM 里但关着',
      restored.clip === 'object' && restored.secure === true && restored.inProto === true && restored.panel === true,
      JSON.stringify(restored));
    const exportSecure = await evalIn('window.__dz.serialize()');
    await clickSelector('#dz-copy');
    await frames(2);
    const secure = await copyState();
    const secureRead = await readClipboardApi();
    check('clip:secure-path', 'a) 正常上下文点「复制 JSON」⇒ 走的是**剪贴板 API（①）**那条路径：`data-copy-path=clipboard`、状态栏如实说「已复制」、**不出现「复制失败」**、手动框没弹（③ 根本用不上）',
      secure.path === 'clipboard' && secure.trace?.path === 'clipboard' && secure.text.includes('已复制')
      && !secure.text.includes('复制失败') && secure.panelHidden === true && secure.value === '',
      JSON.stringify({ path: secure.path, trace: secure.trace?.path, status: secure.text, title: secure.title, panelHidden: secure.panelHidden }));
    check('clip:secure-bytes', 'a) **真剪贴板**里就是导出串（`navigator.clipboard.readText()` 读回；Windows 剪贴板把 `\\n` 存成 `\\r\\n` ⇒ 按 CRLF→LF 归一化后逐字节相等，原始读数一并报出）',
      sameClipboardText(secureRead.text, exportSecure),
      JSON.stringify({ ok: secureRead.ok, rawLen: secureRead.text?.length, exportLen: exportSecure.length, crlf: secureRead.text ? secureRead.text.includes('\r\n') : null, error: secureRead.error ?? null }));

    // ── b) 模拟「局域网 IP ＋ 明文 HTTP」：页面脚本之前就把那两格做成浏览器在非安全上下文里的样子
    await page.browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        // 只给这道门用的钩子：原生描述符留一份，好在「页面已经没有 clipboard 了」时把**真剪贴板**读回来
        window.__nativeClipboardDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
        Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get() { return undefined; } });
        Object.defineProperty(window, 'isSecureContext', { configurable: true, get() { return false; } });
      })();`,
    });
    const reloaded = page.browser.once('Page.loadEventFired');
    await page.browser.send('Page.navigate', { url: `http://127.0.0.1:${page.port}/designer.html` });
    await reloaded;
    await frames(4);
    await page.browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.waitFor(async () => (await safeEval('window.__dzReady === true')) === true, '重载后设计器没起来', 6000);
    const simulated = await evalIn(`(() => ({ clip: String(navigator.clipboard), secure: window.isSecureContext, nativeDesc: typeof window.__nativeClipboardDesc?.get }))()`);
    check('clip:nonsecure-simulated', 'b 臂的前提（注入脚本在**页面脚本之前**跑）：`navigator.clipboard` 是 **undefined**、`window.isSecureContext` 是 **false** —— 这就是「局域网 IP ＋ 明文 HTTP」打开时浏览器给的那两格（不是改产品代码装出来的）',
      simulated.clip === 'undefined' && simulated.secure === false && simulated.nativeDesc === 'function',
      JSON.stringify(simulated));
    // 让这一臂的导出串与 a 臂**不同**（免得「剪贴板里还是 a 臂那一串」也能蒙混过去）：加一屏
    await clickSelector('#dz-add-screen');
    await frames(2);
    const exportNonSecure = await evalIn('window.__dz.serialize()');
    const poison = await evalIn(`(async () => {
      try { await window.__nativeClipboardDesc.get.call(navigator).writeText('哨兵：复制成了就必须覆盖掉这一串'); return 'ok'; }
      catch (error) { return 'write-failed: ' + String((error && error.message) || error); }
    })()`);
    check('clip:nonsecure-prep', 'b 臂的前提钉死：这一臂的导出串与 a 臂**不是同一串**（多了一屏），而且真剪贴板里先放了一串**哨兵**（复制成了就必然被覆盖）',
      exportNonSecure !== exportSecure && poison === 'ok',
      JSON.stringify({ different: exportNonSecure !== exportSecure, poison, secureLen: exportSecure.length, nonSecureLen: exportNonSecure.length }));
    await clickSelector('#dz-copy');
    await frames(2);
    const nonSecure = await copyState();
    const nonSecureRead = await readNativeClipboard();
    check('clip:nonsecure-no-failure', 'b) 非安全上下文点「复制 JSON」⇒ **不出现「复制失败」**（业主报的就是这一格），状态栏有一句人话',
      !nonSecure.text.includes('复制失败') && nonSecure.text.length > 0,
      JSON.stringify({ status: nonSecure.text, kind: nonSecure.kind }));
    check('clip:nonsecure-path', "b) 它**没有**去碰剪贴板 API（那一格根本不存在），而是退到**兼容路径** `document.execCommand('copy')`：`data-copy-path=execCommand`、状态栏说「已复制」、手动框没弹",
      nonSecure.path === 'execCommand' && nonSecure.trace?.path === 'execCommand' && nonSecure.text.includes('已复制') && nonSecure.panelHidden === true,
      JSON.stringify({ path: nonSecure.path, trace: nonSecure.trace?.path, status: nonSecure.text, panelHidden: nonSecure.panelHidden }));
    check('clip:nonsecure-bytes', 'b) **真剪贴板**（用注入脚本捕获到的原生描述符读回，不是我们自己的桩）里就是这一臂的导出串 —— 哨兵被覆盖，归一化 CRLF 后逐字节相等',
      sameClipboardText(nonSecureRead.text, exportNonSecure),
      JSON.stringify({ ok: nonSecureRead.ok, rawLen: nonSecureRead.text?.length, exportLen: exportNonSecure.length, stillSentinel: nonSecureRead.text ? nonSecureRead.text.startsWith('哨兵') : null, error: nonSecureRead.error ?? null }));

    // ── c) 兼容路径也被拒绝（测试侧把 execCommand 打死）⇒ ③ 手动框
    const stubbed = await evalIn(`(() => { document.execCommand = () => false; return document.execCommand(); })()`);
    check('clip:manual-prep', 'c 臂的前提钉死：`document.execCommand` 被测试打死（返回 false）—— 模拟「兼容路径也被浏览器拒绝」',
      stubbed === false, JSON.stringify({ stub: stubbed }));
    await evalIn(`window.__nativeClipboardDesc.get.call(navigator).writeText('哨兵②：兼容路径也没成，剪贴板里应该还是这一串')`);
    await clickSelector('#dz-copy');
    await frames(3);
    const manual = await copyState();
    const manualRead = await readNativeClipboard();
    check('clip:manual-panel', 'c) 兼容路径也失败 ⇒ **弹手动框**（不是死胡同）：面板可见、里面是**只读** textarea、**内容全选**、状态栏**不谎称**「已复制」（说的是「没能自动复制…请按 Ctrl+C」）',
      manual.panelHidden === false && manual.readOnly === true && manual.selectedAll === true && manual.path === 'manual'
      && !manual.text.includes('复制失败') && !manual.text.includes('已复制'),
      JSON.stringify({ panelHidden: manual.panelHidden, readOnly: manual.readOnly, selectedAll: manual.selectedAll, path: manual.path, status: manual.text, clipboardUntouched: manualRead.text ? manualRead.text.startsWith('哨兵②') : null }));
    check('clip:manual-bytes', 'c) 框里的内容**逐字节等于**导出串（业主直接 Ctrl+C 就能拿走；这一条没有 CRLF 那层——DOM 里的字符串不经过系统剪贴板）',
      manual.value === exportNonSecure,
      JSON.stringify({ same: manual.value === exportNonSecure, bytes: manual.value?.length, exportLen: exportNonSecure.length }));
    check('clip:manual-why', 'c) 文案**如实**：说清「不在安全上下文（HTTPS / localhost / 127.0.0.1 之外）⇒ 浏览器不提供剪贴板 API」与怎么办（Ctrl+C / 「导出 JSON」下载），下面还逐级写明为什么（① 没有 `navigator.clipboard`、② `execCommand` 返回 false）',
      manual.lead.includes('不在安全上下文') && manual.lead.includes('剪贴板 API') && manual.lead.includes('Ctrl+C')
      && manual.lead.includes('导出 JSON') && manual.why.includes('navigator.clipboard') && manual.why.includes('execCommand'),
      JSON.stringify({ lead: manual.lead, why: manual.why }));
    await shot('25-copy-manual-panel');
    // Esc 与「关掉」是同一个出口 —— 两条都量（先量 Esc，再量按钮）
    await clickSelector('#dz-copy');
    await frames(2);
    const reopened = await evalIn(`document.querySelector('#dz-copy-panel').hidden === false && document.querySelector('#dz-copy-text').value.length > 0`);
    await page.browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await page.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await frames(2);
    const escClosed = await evalIn(`(() => ({ hidden: document.querySelector('#dz-copy-panel').hidden, value: document.querySelector('#dz-copy-text').value }))()`);
    check('clip:manual-esc', 'c) 键盘 **Esc** 也关得掉（与「关掉」同一个出口）：Esc 之后面板收起来、导出串一起清掉',
      reopened === true && escClosed.hidden === true && escClosed.value === '',
      JSON.stringify({ reopened, ...escClosed }));
    await clickSelector('#dz-copy');
    await frames(2);
    await clickSelector('#dz-copy-close');
    await frames(2);
    const closed = await evalIn(`(() => ({ hidden: document.querySelector('#dz-copy-panel').hidden, value: document.querySelector('#dz-copy-text').value }))()`);
    check('clip:manual-close', 'c) 点「关掉」⇒ 面板收起来，框里的导出串也一起清掉（不留副本）',
      closed.hidden === true && closed.value === '', JSON.stringify(closed));
  });

  // ═══ 15c. 导出：HTML / SVG / PNG / 规范 JSON / 转移图 ════════════════════════════════════
  //  页面内生成（不要新路由、不要 reload）；**每次导出都当场重跑**；失败**如实报**（含哪一步 / 为什么）。
  //  导出物的字节都从 blob URL 读回来（作业单允许的两条路之一：CDP 下载目录 / 读回 blob）。
  await groupCheck('export', async () => {
    // 起点：一份我们控制的文档 —— 一个**红矩形**（看得见，能在 PNG 里量像素）＋ 一段**文字**（SVG 里要有 <text>）
    await clickSelector('#dz-new');
    await frames(2);
    const toolRect = await box('[data-tool="rect"]');
    const toolText = await box('[data-tool="text"]');
    const frameBox = await box('#dz-frame');
    await dragPoints({ x: toolRect.cx, y: toolRect.cy }, { x: frameBox.left + 60, y: frameBox.top + 80 }, { steps: 10 });
    await setControl('#dz-panel [data-field="style-background"]', '#ff0000');
    await setControl('#dz-panel [data-field="box-x"]', '40');
    await setControl('#dz-panel [data-field="box-y"]', '60');
    await setControl('#dz-panel [data-field="element-name"]', '红矩形');
    const rectId2 = await evalIn('window.__dz.selection()[0]');
    await dragPoints({ x: toolText.cx, y: toolText.cy }, { x: frameBox.left + 60, y: frameBox.top + 220 }, { steps: 10 });
    await setControl('#dz-panel [data-field="element-text"]', '画完就出图');
    const textId2 = await evalIn('window.__dz.selection()[0]');
    await clickSelector('#dz-add-screen');   // 第二屏 ⇒ 转移图里两个节点
    await frames(2);
    await clickSelector('#dz-screens [data-screen="screen-1"]');
    await frames(2);
    await clickSelector('#dz-add-transition'); // 一条转移 ⇒ 转移图里一根箭头
    await frames(2);
    const docFacts = await evalIn(`(() => {
      const doc = window.__dz.doc();
      const ids = [];
      const walk = (el) => { ids.push(el.id); (el.children ?? []).forEach(walk); };
      walk(doc.screens.find((s) => s.id === 'screen-1').root);
      const nodes = doc.screens.reduce((sum, s) => sum + Math.max(1, (s.states ?? []).length), 0);
      return { ids, screens: doc.screens.length, nodes, transitions: doc.transitions.map((t) => t.id) };
    })()`);
    const nameOk = (name, extension) => new RegExp('^design-屏-1-默认-\\d{8}-\\d{6}\\.' + extension + '$').test(name ?? '');

    // 下载都走 blob：把 anchor.click 接住（不真弹下载目录），再从 blob URL 读回字节
    await evalIn(`(() => {
      window.__downloads = [];
      const original = HTMLAnchorElement.prototype.click;
      window.__restoreAnchorClick = () => { HTMLAnchorElement.prototype.click = original; };
      HTMLAnchorElement.prototype.click = function () { window.__downloads.push({ href: this.href, download: this.download }); };
      return true;
    })()`);
    /** 点菜单里的一项 ⇒ 等新下载 ⇒ 把那一份的字节/文本读回来（连同 lastExport / 状态栏）。 */
    const exportVia = async (kind, { expectDownload = true } = {}) => {
      const before = Number(await safeEval('window.__downloads.length')) || 0;
      await evalIn(`(() => { document.querySelector('#dz-export-toggle').click(); return true; })()`);
      await frames(1);
      const menuOpen = await evalIn('window.__dz.exportMenuOpen()');
      await clickSelector(`#dz-export-items [data-export="${kind}"]`);
      if (expectDownload) {
        await page.waitFor(async () => Number(await safeEval('window.__downloads.length')) > before,
          `导出 ${kind} 没有发出下载`, ARM ? 3000 : 8000).catch(() => null);
      } else {
        await frames(4);
      }
      const after = await evalIn(`(async () => {
        const total = window.__downloads.length;
        const status = document.querySelector('#dz-status');
        const out = {
          before: ${before}, total, newDownloads: total - ${before},
          status: status.textContent, statusKind: status.dataset.kind ?? null,
          menuOpen: window.__dz.exportMenuOpen(), last: window.__dz.lastExport(),
          menuError: document.querySelector('#dz-export-menu').dataset.error ?? null,
          name: null, bytes: 0, text: null,
        };
        if (total <= ${before}) return out;
        const entry = window.__downloads[total - 1];
        out.name = entry.download;
        const buf = new Uint8Array(await (await fetch(entry.href)).arrayBuffer());
        out.bytes = buf.length;
        out.text = new TextDecoder().decode(buf);
        return out;
      })()`);
      return { menuOpen, ...after };
    };
    const analyzeSvg = async (text) => evalIn(`(() => {
      const parsed = new DOMParser().parseFromString(${JSON.stringify(text ?? '')}, 'image/svg+xml');
      const root = parsed.documentElement;
      return {
        xmlOk: parsed.querySelector('parsererror') === null,
        rootTag: root.tagName,
        width: Number(root.getAttribute('width')), height: Number(root.getAttribute('height')),
        viewBox: root.getAttribute('viewBox'),
        rects: [...parsed.querySelectorAll('rect[data-id]')].map((node) => ({ id: node.getAttribute('data-id'), type: node.getAttribute('data-type'), x: Number(node.getAttribute('x')), y: Number(node.getAttribute('y')), w: Number(node.getAttribute('width')), h: Number(node.getAttribute('height')), fill: node.getAttribute('fill') })),
        texts: [...parsed.querySelectorAll('text[data-id]')].map((node) => ({ id: node.getAttribute('data-id'), text: node.textContent })),
        imageHrefs: [...parsed.querySelectorAll('image')].map((node) => node.getAttribute('href') ?? node.getAttribute('xlink:href') ?? ''),
        external: /(?:href|src)="https?:/i.test(${JSON.stringify(text ?? '')}),
      };
    })()`);

    // ── 菜单本身 ─────────────────────────────────────────────────────────────────────────
    const menuSpec = await evalIn(`(() => {
      const toggle = document.querySelector('#dz-export-toggle');
      toggle.click();
      const items = [...document.querySelectorAll('#dz-export-items [data-export]')];
      return {
        open: document.querySelector('#dz-export-items').hidden === false,
        expanded: toggle.getAttribute('aria-expanded'),
        haspopup: toggle.getAttribute('aria-haspopup'),
        kinds: items.map((b) => b.dataset.export),
        notes: items.map((b) => (b.querySelector('.dz-menu-note')?.textContent ?? '').length),
        unknown: items.filter((b) => !['html', 'svg', 'png', 'json', 'flow'].includes(b.dataset.export)).length,
        declared: window.__dz.exportKinds(),
      };
    })()`);
    check('export:menu-items', '顶栏「导出 ▾」是一张真菜单：点开后 5 项（HTML / SVG / PNG / 规范 JSON / 转移图）、每项带一句说明、aria-expanded 跟着变；**做不到的一项都没摆**（没有第 6 个 data-export）',
      menuSpec.open === true && menuSpec.expanded === 'true' && menuSpec.haspopup === 'menu'
      && JSON.stringify(menuSpec.kinds) === JSON.stringify(menuSpec.declared)
      && JSON.stringify(menuSpec.kinds) === JSON.stringify(['html', 'svg', 'png', 'json', 'flow'])
      && menuSpec.notes.every((length) => length > 0) && menuSpec.unknown === 0,
      JSON.stringify(menuSpec));
    await shot('30-export-menu');
    await page.browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await page.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await frames(2);
    const menuClosed = await evalIn('({ open: window.__dz.exportMenuOpen(), expanded: document.querySelector("#dz-export-toggle").getAttribute("aria-expanded") })');
    check('export:menu-esc', 'Esc 收得起这张菜单（aria-expanded 跟着回到 false）—— 与「再点一下开关」同一个出口',
      menuClosed.open === false && menuClosed.expanded === 'false', JSON.stringify(menuClosed));

    // ── 导出 HTML ────────────────────────────────────────────────────────────────────────
    const htmlOne = await exportVia('html');
    const htmlAnalysis = await evalIn(`(() => {
      const parsed = new DOMParser().parseFromString(${JSON.stringify(htmlOne.text ?? '')}, 'text/html');
      return {
        doctype: /^<!doctype html>/i.test(${JSON.stringify(htmlOne.text ?? '')}),
        parserErrors: parsed.querySelectorAll('parsererror').length,
        elementIds: [...parsed.querySelectorAll('.dz-el')].map((node) => node.dataset.id),
        textCount: parsed.querySelectorAll('.dz-el[data-type="text"]').length,
        external: /https?:\\/\\//.test(${JSON.stringify(htmlOne.text ?? '')}),
        nonDataSrc: [...parsed.querySelectorAll('[src]')].map((node) => node.getAttribute('src')).filter((src) => !src.startsWith('data:')),
        rectLeft: (parsed.querySelector('[data-id="' + ${JSON.stringify(rectId2)} + '"]')?.getAttribute('style') ?? '').match(/left:\\s*([-\\d.]+)px/)?.[1] ?? null,
      };
    })()`);
    check('export:html-valid', '点「导出 HTML」⇒ 真的下载到一个文件（文件名带屏名/状态名/时间戳）：内容是**合法 HTML**（doctype ＋ DOMParser 解得出、零 parsererror）、含当前屏的**每一个元素**（逐 id 对上）、且一条 http(s) 外链都没有',
      htmlOne.newDownloads === 1 && htmlOne.last.ok === true && nameOk(htmlOne.name, 'html')
      && htmlAnalysis.doctype && htmlAnalysis.parserErrors === 0 && htmlAnalysis.external === false
      && JSON.stringify(htmlAnalysis.elementIds) === JSON.stringify(docFacts.ids)
      && htmlAnalysis.textCount === 1 && htmlAnalysis.nonDataSrc.length === 0,
      JSON.stringify({ name: htmlOne.name, last: htmlOne.last, ...htmlAnalysis, expected: docFacts.ids }));
    check('export:html-menu-closed', '点完一项菜单自己收起来（不是「点完还挂着」），且 aria-expanded 回到 false',
      htmlOne.menuOpen === false, JSON.stringify({ menuOpen: htmlOne.menuOpen }));

    // ── 导出 SVG（几何与画布**实测**一致）─────────────────────────────────────────────────
    const svgOne = await exportVia('svg');
    const svgAnalysis = await analyzeSvg(svgOne.text);
    const canvasRect = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-id=${JSON.stringify(rectId2)}]');
      const fr = document.querySelector('#dz-frame').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - fr.left, y: r.top - fr.top, w: r.width, h: r.height, fill: getComputedStyle(el).backgroundColor, frame: { w: fr.width, h: fr.height } };
    })()`);
    const svgRectOne = svgAnalysis.rects.find((rect) => rect.id === rectId2) ?? null;
    check('export:svg-valid', '点「导出 SVG」⇒ 下载到的是一份**合法 SVG**（`image/svg+xml` 解得出、根是 `<svg>`、宽高 == 画布尺寸），而且当前屏的**每一个元素**都在里面（每条 `<rect data-id>` 逐 id 对上）＋文字还在（`<text>` 里有那段话）',
      svgOne.newDownloads === 1 && svgOne.last.ok === true && nameOk(svgOne.name, 'svg')
      && svgAnalysis.xmlOk === true && svgAnalysis.rootTag === 'svg' && svgAnalysis.external === false
      && svgAnalysis.width === canvasRect.frame.w && svgAnalysis.height === canvasRect.frame.h
      && JSON.stringify(svgAnalysis.rects.map((rect) => rect.id)) === JSON.stringify(docFacts.ids)
      && svgAnalysis.texts.some((node) => node.id === textId2 && node.text.includes('画完就出图'))
      && svgAnalysis.imageHrefs.every((href) => href === '' || href.startsWith('data:')),
      JSON.stringify({ name: svgOne.name, ...svgAnalysis, frame: canvasRect.frame }));
    check('export:svg-geometry', 'SVG 里那个红矩形的 x/y/w/h 与**画布上实测的矩形逐项相同**（导出不是另算一份布局：量的是同一套渲染）',
      svgRectOne !== null
      && Math.abs(svgRectOne.x - canvasRect.x) < 0.5 && Math.abs(svgRectOne.y - canvasRect.y) < 0.5
      && Math.abs(svgRectOne.w - canvasRect.w) < 0.5 && Math.abs(svgRectOne.h - canvasRect.h) < 0.5,
      JSON.stringify({ svg: svgRectOne, canvas: { x: canvasRect.x, y: canvasRect.y, w: canvasRect.w, h: canvasRect.h } }));

    // ── 导出 PNG（由那份 SVG 光栅化；解回来量 IHDR 与像素）────────────────────────────────
    const pngOne = await exportVia('png');
    const pngAnalysis = await evalIn(`(async () => {
      const total = window.__downloads.length;
      const last = window.__dz.lastExport();
      // 反证臂（导出器被拿掉）下这里连下载都没有：**不能把测试自己弄崩**，就把它当成「没有可量的 PNG」
      if (total === 0 || last.ok !== true) return { skipped: true, magic: null, ihdr: null, bitmap: null, bytes: 0, inside: null, corner: null };
      const entry = window.__downloads.at(-1);
      const buf = new Uint8Array(await (await fetch(entry.href)).arrayBuffer());
      const view = new DataView(buf.buffer);
      const out = { magic: [...buf.slice(0, 8)], ihdr: [view.getUint32(16), view.getUint32(20)], bytes: buf.length };
      const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
      out.bitmap = [bitmap.width, bitmap.height];
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      out.inside = px(${Math.round(canvasRect.x + canvasRect.w / 2)}, ${Math.round(canvasRect.y + canvasRect.h / 2)});
      out.corner = px(2, 2);
      return out;
    })()`);
    check('export:png-bytes', '点「导出 PNG」⇒ 下载到的是一个**合法 PNG**（魔数 8 个字节对得上、IHDR 的宽高 == 画布尺寸、字节数 > 0）',
      pngOne.newDownloads === 1 && pngOne.last.ok === true && nameOk(pngOne.name, 'png')
      && JSON.stringify(pngAnalysis.magic) === JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10])
      && pngAnalysis.ihdr !== null && pngAnalysis.ihdr[0] === canvasRect.frame.w && pngAnalysis.ihdr[1] === canvasRect.frame.h
      && pngAnalysis.bitmap !== null && JSON.stringify(pngAnalysis.bitmap) === JSON.stringify(pngAnalysis.ihdr) && pngAnalysis.bytes > 0,
      JSON.stringify({ name: pngOne.name, ...pngAnalysis, frame: canvasRect.frame }));
    check('export:png-pixels', '把 PNG 解回来量像素：红矩形**中心那一点真的是红的**（r>200、g<80、b<80）、画布角落里是底色 #15171b —— 不是一张空白图',
      pngAnalysis.inside !== null && pngAnalysis.corner !== null
      && pngAnalysis.inside[0] > 200 && pngAnalysis.inside[1] < 80 && pngAnalysis.inside[2] < 80 && pngAnalysis.inside[3] === 255
      && JSON.stringify(pngAnalysis.corner) === JSON.stringify([21, 23, 27, 255]),
      JSON.stringify({ inside: pngAnalysis.inside, corner: pngAnalysis.corner }));
    await shot('31-export-download');

    // ── 导出规范 JSON：与页面里「导出 JSON」**逐字节**同源 ────────────────────────────────
    const jsonOne = await exportVia('json');
    const liveJson = await evalIn('window.__dz.serialize()');
    const beforeTopBar = Number(await evalIn('window.__downloads.length'));
    await clickSelector('#dz-export');
    await page.waitFor(async () => Number(await safeEval('window.__downloads.length')) > beforeTopBar, '顶栏「导出 JSON」没发下载', 6000).catch(() => null);
    const topBarJson = await evalIn(`(async () => {
      const entry = window.__downloads[window.__downloads.length - 1] ?? null;
      if (!entry) return null;
      return new TextDecoder().decode(new Uint8Array(await (await fetch(entry.href)).arrayBuffer()));
    })()`);
    check('export:json-bytes', '菜单里的「导出 JSON」下载到的字节 **== 页面里「导出 JSON」那一串**（顶层按钮与菜单里那一项是**同一串规范字节**，不是第二份序列化器）',
      jsonOne.newDownloads === 1 && jsonOne.last.ok === true && nameOk(jsonOne.name, 'json')
      && jsonOne.text === liveJson && topBarJson === liveJson,
      JSON.stringify({ menuBytes: jsonOne.text?.length, liveBytes: liveJson.length, topBarBytes: topBarJson.length, same: jsonOne.text === liveJson && topBarJson === liveJson }));

    // ── 导出转移图（节点 = (屏,状态)，箭头 = transitions 的一条数据）────────────────────
    const flowOne = await exportVia('flow');
    const flowAnalysis = await evalIn(`(() => {
      const parsed = new DOMParser().parseFromString(${JSON.stringify(flowOne.text ?? '')}, 'image/svg+xml');
      return {
        xmlOk: parsed.querySelector('parsererror') === null,
        isFlow: parsed.documentElement.getAttribute('data-designer-flow') === 'true',
        nodes: [...parsed.querySelectorAll('[data-node]')].map((node) => node.getAttribute('data-node')),
        arrows: [...parsed.querySelectorAll('[data-transition]')].map((node) => node.getAttribute('data-transition')),
        external: /(?:href|src)="https?:/i.test(${JSON.stringify(flowOne.text ?? '')}),
      };
    })()`);
    check('export:flow-arrow', '点「导出转移图」⇒ 一份合法 SVG：节点数 == （屏 × 状态）（这里是 2）且每个节点带 `data-node`；箭头数 == `transitions` 的条数（这里 1）且每根带 `data-transition` 就是那条数据的 id —— **画不出一根数据里没有的箭头**',
      flowOne.newDownloads === 1 && flowOne.last.ok === true && /^design-flow-\d{8}-\d{6}\.flow\.svg$/.test(flowOne.name ?? '')
      && flowAnalysis.xmlOk === true && flowAnalysis.isFlow === true && flowAnalysis.external === false
      && flowAnalysis.nodes.length === docFacts.nodes && flowAnalysis.arrows.includes(docFacts.transitions[0])
      && flowAnalysis.arrows.filter((id) => id === docFacts.transitions[0]).length >= 1,
      JSON.stringify({ name: flowOne.name, ...flowAnalysis, expectedNodes: docFacts.nodes, expectedTransitions: docFacts.transitions }));

    // ── 新鲜度：改一下文档（把红矩形挪一格）⇒ 再导出 ⇒ 内容必须跟着变（不是缓存的旧稿）──────
    await clickSelector(`#dz-layers [data-layer="${rectId2}"]`);
    await frames(2);
    await setControl('#dz-panel [data-field="box-x"]', '120');
    await frames(2);
    const svgTwo = await exportVia('svg');
    const svgRectTwo = (await analyzeSvg(svgTwo.text)).rects.find((rect) => rect.id === rectId2) ?? null;
    check('export:fresh-svg', '把红矩形从 x=40 挪到 x=120 ⇒ 再点导出 ⇒ SVG 里那个矩形**当场变成 120**（不是把旧稿再发一次），字节也与上一份不同',
      svgTwo.newDownloads === 1 && svgTwo.last.ok === true && svgRectTwo !== null
      && svgRectTwo.x === 120 && svgRectOne !== null && svgRectOne.x === 40 && svgTwo.text !== svgOne.text,
      JSON.stringify({ before: svgRectOne, after: svgRectTwo, sameBytes: svgTwo.text === svgOne.text }));
    const htmlTwo = await exportVia('html');
    const htmlTwoAnalysis = await evalIn(`(() => {
      const parsed = new DOMParser().parseFromString(${JSON.stringify(htmlTwo.text ?? '')}, 'text/html');
      const style = parsed.querySelector('[data-id="' + ${JSON.stringify(rectId2)} + '"]')?.getAttribute('style') ?? '';
      return { left: style.match(/left:\\s*([-\\d.]+)px/)?.[1] ?? null };
    })()`);
    check('export:fresh-html', 'HTML 那一份同理：挪完再导，元素的行内样式里是新的 `left: 120px`（而且两份字节不同）—— 导出按钮不是「把旧稿再下载一次」',
      htmlTwo.newDownloads === 1 && htmlTwoAnalysis.left === '120'
      && htmlOne.text !== htmlTwo.text && htmlAnalysis.rectLeft === '40',
      JSON.stringify({ beforeLeft: htmlAnalysis.rectLeft, afterLeft: htmlTwoAnalysis.left, sameBytes: htmlOne.text === htmlTwo.text }));

    // ── 失败路径：把导出器弄断 ⇒ **如实报**（哪一步 / 为什么）、**一个文件都不发** ──────────────
    await evalIn('(() => { window.__dzSavedRoot = window.__dz.doc().screens[0].root; window.__dz.doc().screens[0].root = null; return true; })()');
    const brokenExport = await exportVia('html', { expectDownload: false });
    check('export:fail-honest', '把文档弄坏（屏根 = null）再点「导出 HTML」⇒ **如实报错**：状态栏说得出**哪一步**（渲染）、也写得出**为什么**（原始错误逐字），`lastExport.ok === false` —— 不谎称成功',
      brokenExport.statusKind === 'error' && brokenExport.status.includes('导出 HTML 失败')
      && brokenExport.status.includes('渲染这一步失败') && (brokenExport.last.reason ?? '').length > 0
      && brokenExport.last.ok === false,
      JSON.stringify({ status: brokenExport.status, last: brokenExport.last }));
    check('export:fail-no-download', '导出失败 **一个文件都不发**（没有假成功的下载、也没有半成品）；菜单上留着 `data-error` 供追溯',
      brokenExport.newDownloads === 0 && brokenExport.menuError !== null,
      JSON.stringify({ newDownloads: brokenExport.newDownloads, menuError: brokenExport.menuError }));
    await shot('32-export-failure');
    await evalIn('(() => { window.__dz.doc().screens[0].root = window.__dzSavedRoot; return true; })()');
    const recovered = await exportVia('html');
    check('export:fail-recovers', '把文档改回来 ⇒ 下一次导出立刻恢复正常（一次失败不会把这一页卡住）：又是新下载、状态栏说成功、内容还是新的那份',
      recovered.last.ok === true && recovered.newDownloads === 1
      && /left:\s*120px/.test(recovered.text ?? '') && recovered.statusKind === 'ok',
      JSON.stringify({ last: recovered.last, name: recovered.name, status: recovered.status }));
  });

  // ═══ 16. 静态自检：接缝在、没有产品依赖、页面不自作主张发请求 ═══════════════════════════════
  await groupCheck('static', async () => {
    const js = await readFile(path.join(root, 'web', 'designer.js'), 'utf8');
    const html = await readFile(path.join(root, 'web', 'designer.html'), 'utf8');
    // 三级降级的**共用实现**（2026-09-25 从这一页抽出去；主产品页 `web/render.js` 也调它）。
    const shared = await readFile(path.join(root, 'web', 'copy-text.js'), 'utf8');
    const seams = ['[SEAM:fill]', '[SEAM:arrows]', '[SEAM:undo]'];
    const missing = seams.filter((seam) => !js.includes(seam));
    check('static:seams', '三条测试接缝都还在（反证臂靠它们；别顺手重命名）', missing.length === 0,
      missing.length ? `缺：${JSON.stringify(missing)}` : seams.join(' / '));
    const newSeams = ['[SEAM:divider]', '[SEAM:tform]'];
    const missingNew = newSeams.filter((seam) => !js.includes(seam));
    check('static:seams-2', '上一单新加的两条接缝也在（`[SEAM:divider]` / `[SEAM:tform]`，分割符与转移表单的反证臂各改一处）',
      missingNew.length === 0, missingNew.length ? `缺：${JSON.stringify(missingNew)}` : newSeams.join(' / '));
    const ownSeams = ['[SEAM:panel-context]', '[SEAM:divider-flow]'];
    const missingOwn = ownSeams.filter((seam) => !js.includes(seam));
    check('static:seams-3', '本单新加的两条接缝也在（`[SEAM:panel-context]` / `[SEAM:divider-flow]`，属性面板随上下文与分割符占位的反证臂各改一处）',
      missingOwn.length === 0, missingOwn.length ? `缺：${JSON.stringify(missingOwn)}` : ownSeams.join(' / '));
    const copySeams = ['[SEAM:copy-fallback]'];
    const missingCopy = copySeams.filter((seam) => !shared.includes(seam));
    check('static:seams-4', '这一单新加的接缝也在（`[SEAM:copy-fallback]`：复制 JSON 的 ②③ 两级的入口，反证臂把它换成 `throw`）'
      + '—— 2026-09-25 起它在**共用实现** `web/copy-text.js` 里（`designer.js` 只留一句指针）',
      missingCopy.length === 0, missingCopy.length ? `缺：${JSON.stringify(missingCopy)}` : copySeams.join(' / '));
    const tiers = {
      clipboard: shared.includes('clipboard.writeText(text)'),
      compat: shared.includes("document.execCommand('copy')"),
      helper: shared.includes("area.dataset.copyHelper = 'compat'"),
      panel: html.includes('id="dz-copy-panel"') && html.includes('id="dz-copy-text"'),
      // 这一页**真的接到**那份共用实现上：引了脚本、且 `copyJsonText()` 调的是它。
      wired: html.includes('src="/copy-text.js"') && js.includes('window.sophoCopyText') && js.includes('shared.copyText(text'),
    };
    check('static:copy-tiers', '复制 JSON 的**三级**都在源码里：① `navigator.clipboard` ② `document.execCommand(\'copy\')` ＋ 临时 textarea（用完移除）③ 手动框 `#dz-copy-panel` / `#dz-copy-text`'
      + '—— ①②③ 在**共用实现** `web/copy-text.js` 里，这一页引它并用它（`dz-*` 那几个 id 由这一页传进去）',
      Object.values(tiers).every(Boolean), JSON.stringify(tiers));
    const exportSeams = ['[SEAM:export-build]', '[SEAM:export-guard]'];
    const missingExport = exportSeams.filter((seam) => !js.includes(seam));
    check('static:seams-5', '这一单新加的两条接缝也在（`[SEAM:export-build]`：每次导出重跑那一行，反证臂 `export-stale-cache` 改它；`[SEAM:export-guard]`：失败如实报那一段，反证臂 `export-silent-failure` 改它）',
      missingExport.length === 0, missingExport.length ? `缺：${JSON.stringify(missingExport)}` : exportSeams.join(' / '));
    const exportKindsInSource = ['html', 'svg', 'png', 'json', 'flow'].every((kind) => js.includes(`case '${kind}':`));
    check('static:export-kinds', '导出的五个格式在源码里就是那五个 `case`（HTML / SVG / PNG / 规范 JSON / 转移图）—— 菜单上也就只摆这五个',
      exportKindsInSource && js.includes('async function runExport(') && js.includes('async function buildExport('),
      JSON.stringify({ exportKindsInSource, runExport: js.includes('async function runExport('), buildExport: js.includes('async function buildExport(') }));
    check('static:no-server', '页面**不发自己的任何网络请求**（没有 fetch / XHR）、也不 import 服务端模块 —— 所以不用新增路由、不用 reload',
      !/\bfetch\s*\(/.test(js) && !/XMLHttpRequest/.test(js) && !/^\s*import\s/m.test(js),
      JSON.stringify({ fetch: (js.match(/\bfetch\s*\(/g) ?? []).length, xhr: /XMLHttpRequest/.test(js), imports: (js.match(/^\s*import\s/gm) ?? []).length }));
    check('static:only-two-links', 'HTML 只引 `/slot.css` 与 `/designer.css` 两份样式（没有对产品页面的任何写入）',
      (html.match(/<link[^>]*href="([^"]+)"/g) ?? []).length === 2 && html.includes('href="/slot.css"') && html.includes('href="/designer.css"'),
      JSON.stringify(html.match(/<link[^>]*>/g)));
    const arrowSeams = ['[SEAM:arrow-layers]', '[SEAM:arrow-labels]'];
    const missingArrow = arrowSeams.filter((seam) => !js.includes(seam));
    check('static:seams-7', '本单新加的两条接缝在源码里（`[SEAM:arrow-layers]`：流程视图的层序（连线/标签两组 ＋ CSS 里的 `--dz-layer-*`）；`[SEAM:arrow-labels]`：标签落在路径哪一点的**唯一**策略）—— 两条反证臂各改一处',
      missingArrow.length === 0, missingArrow.length ? `缺：${JSON.stringify(missingArrow)}` : arrowSeams.join(' / '));
    const css = await readFile(path.join(root, 'web', 'designer.css'), 'utf8');
    check('static:arrow-layer-order', '层序是一条**写死的规则**（不是碰巧落成）：“屏卡 < 连线 < 标签”三档在 `designer.css` 的 `--dz-layer-cards` / `--dz-layer-arrows` 里，且只有一份声明（连线层与卡片层各从变量取值）',
      /--dz-layer-cards:\s*\d+;/.test(css) && /--dz-layer-arrows:\s*\d+;/.test(css)
      && /\.dz-arrows\s*\{[^}]*z-index:\s*var\(--dz-layer-arrows\)/.test(css)
      && /\.dz-flow-cards\s*\{[^}]*z-index:\s*var\(--dz-layer-cards\)/.test(css),
      JSON.stringify({ cards: /--dz-layer-cards:\s*\d+;/.test(css), arrows: /--dz-layer-arrows:\s*\d+;/.test(css) }));
  });

  // ═══ 17. 可编程控制面：`window.sophoDesigner`（agent 不用手改 JSON 也能编辑节点）══════════════
  //
  // 业主 2026-09-28 逐字：「现在 agent 对编辑页面的使用还是需要通过对文件进行 json 编辑才行，后续应该
  // 考虑**直接在 webui 当中介入**，这也就意味着需要**让 agent 可以操控编辑器，编辑节点**」。
  //
  // 这一组量的就是那六件事（逐条对应作业单 ①②③④⑤⑥）：
  //   ① 用 API 建「两栏 ＋ 竖分割符 ＋ 一个按钮」⇒ 断言**画布 DOM 实测几何**与文档一致（没有第二份布局引擎）；
  //   ② `updateNode` 改宽度 ⇒ 实测跟着变（改父宽也重新分配）；
  //   ③ `addTransition` ⇒ 箭头出现，且**由 `transitions` 生成**（`data-arrow` 就是那条数据的 id）；
  //   ④ `undo()` 一次 ⇒ 回到**完全相同**的几何与逐字节相同的文档；
  //   ⑤ 非法输入 17 种 ⇒ **有原因的错** ＋ 文档逐字节未变 ＋ 撤销栈没动；
  //   ⑥ API 改一次 ＋ **鼠标**（真拖拽）再改一次 ⇒ 两笔改动在**同一个撤销栈**里（撤两次按顺序各回一步）。
  const API_REQUIRED = ['getDoc', 'addNode', 'updateNode', 'removeNode', 'moveNode', 'select', 'addScreen', 'addState', 'addTransition', 'undo', 'redo', 'setDoc', 'exportDoc'];
  let apiIds = null;
  await evalIn(`window.__apiGeo = (ids) => {
    const frame = document.querySelector('#dz-frame');
    const fr = frame.getBoundingClientRect();
    const out = {};
    for (const id of ids) {
      const el = document.querySelector('#dz-frame .dz-el[data-id="' + id + '"]');
      if (!el) { out[id] = null; continue; }
      const r = el.getBoundingClientRect();
      out[id] = { x: Math.round(r.left - fr.left), y: Math.round(r.top - fr.top), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName.toLowerCase(), type: el.dataset.type };
    }
    return out;
  }`);
  const apiGeo = (ids) => evalIn(`window.__apiGeo(${JSON.stringify(ids)})`);

  await groupCheck('api-surface', async () => {
    const surface = await evalIn(`(() => {
      const api = window.sophoDesigner;
      if (!api) return { present: false };
      const help = api.help();
      const names = help.map((entry) => entry.name);
      return {
        present: true,
        version: api.version ?? null,
        missing: ${JSON.stringify(API_REQUIRED)}.filter((name) => typeof api[name] !== 'function'),
        missingInHelp: ${JSON.stringify(API_REQUIRED)}.filter((name) => !names.includes(name)),
        thinHelp: help.filter((entry) => typeof entry.signature !== 'string' || entry.signature.length === 0 || typeof entry.note !== 'string' || entry.note.length === 0).map((entry) => entry.name),
        helpCount: help.length,
      };
    })()`);
    check('api:surface', '编辑器页上有一份**有名字、有文档**的控制面：`window.sophoDesigner`（版本字符串 ＋ 13 个方法都是函数），`help()` 逐个给出名字/签名/一句话说明（没有空壳条目）',
      surface.present === true && typeof surface.version === 'string' && surface.missing.length === 0
      && surface.missingInHelp.length === 0 && surface.thinHelp.length === 0 && surface.helpCount >= 13,
      JSON.stringify(surface));

    await clickSelector('#dz-new'); // 从空白起（鼠标那条路）
    await frames(2);
    const blank = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const doc = api.getDoc();
      return {
        screens: doc.screens.length,
        states: doc.screens[0].states.length,
        rootId: doc.screens[0].root.id,
        children: doc.screens[0].root.children.length,
        transitions: doc.transitions.length,
        domCount: document.querySelectorAll('#dz-frame .dz-el').length,
        sameBytes: api.exportDoc() === window.__dz.serialize(),
        state: api.getState(),
      };
    })()`);
    check('api:blank-doc', '空白起：`getDoc()` 交回来的就是画布上那一份（1 屏 / 1 状态 / 空根容器 / 0 转移），`exportDoc()` 与页面里那一串规范字节同一来源',
      blank.screens === 1 && blank.states === 1 && blank.rootId === 'el-1' && blank.children === 0 && blank.transitions === 0
      && blank.domCount === 1 && blank.sameBytes === true && blank.state.screenId === 'screen-1' && blank.state.stateId === 'state-1',
      JSON.stringify(blank));
  });

  await groupCheck('api-build', async () => {
    const built = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const rootId = api.getDoc().screens[0].root.id;
      const cols = api.addNode(rootId, { type: 'container', name: '两栏', layout: { mode: 'row', gap: 0, padding: 0 }, box: { x: 24, y: 24 }, size: { w: { mode: 'fixed', value: 592 }, h: { mode: 'fixed', value: 240 } } });
      const left = api.addNode(cols.id, { type: 'container', name: '左栏', size: { w: { mode: 'fill' }, h: { mode: 'fill' } } });
      const divider = api.addNode(cols.id, { type: 'divider', name: '竖分割符', orientation: 'vertical', thickness: 4, color: '#8abeb7' });
      const right = api.addNode(cols.id, { type: 'container', name: '右栏', size: { w: { mode: 'fill' }, h: { mode: 'fill' } } });
      const button = api.addNode(left.id, { type: 'button', name: '主按钮', text: '提交', box: { x: 16, y: 16 }, size: { w: { mode: 'fixed', value: 140 }, h: { mode: 'fixed', value: 36 } } });
      return { rootId, cols, left, divider, right, button, tree: api.getDoc().screens[0].root.children[0] };
    })()`);
    apiIds = { root: built.rootId, cols: built.cols.id, left: built.left.id, divider: built.divider.id, right: built.right.id, button: built.button.id };
    const receipts = [built.cols, built.left, built.divider, built.right, built.button];
    check('api:add-node', '`addNode()` 一次建一个：五个回执各自 `ok:true`、id 互不相同、`parentId` / `type` / `index` 都说得出（两栏容器 ＋ 竖分割符 ＋ 两个自适应栏 ＋ 一个按钮）',
      receipts.every((receipt) => receipt.ok === true && typeof receipt.id === 'string' && typeof receipt.type === 'string'
        && typeof receipt.parentId === 'string' && Number.isInteger(receipt.index))
      && new Set(receipts.map((receipt) => receipt.id)).size === 5
      && built.left.parentId === apiIds.cols && built.divider.parentId === apiIds.cols && built.right.parentId === apiIds.cols
      && built.button.parentId === apiIds.left
      && [built.left, built.divider, built.right].map((receipt) => receipt.index).join(',') === '0,1,2',
      JSON.stringify(receipts));
    check('api:add-node-doc', '文档里就是那棵树（顺序 = 左栏 / 竖分割符 / 右栏：`layout.mode=row`、两栏 `size.w.mode=fill`、分割符 `orientation=vertical` ＋ `thickness=4` 且**不带 `size`**、按钮 `size.w.value=140`）；新建元素与鼠标新建一样是**中立的**（数据里没有 `style` 键）',
      built.tree.id === apiIds.cols && built.tree.layout.mode === 'row'
      && built.tree.children.map((child) => child.id).join(',') === [apiIds.left, apiIds.divider, apiIds.right].join(',')
      && built.tree.children[0].size.w.mode === 'fill' && built.tree.children[2].size.w.mode === 'fill'
      && built.tree.children[1].type === 'divider' && built.tree.children[1].orientation === 'vertical'
      && built.tree.children[1].thickness === 4 && built.tree.children[1].size === undefined
      && built.tree.children[0].children[0].id === apiIds.button && built.tree.children[0].children[0].size.w.value === 140
      && [built.tree, ...built.tree.children, built.tree.children[0].children[0]].every((element) => element.style === undefined),
      JSON.stringify(built.tree));

    const copy = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const snapshot = api.getDoc();
      snapshot.screens[0].root.children.length = 0; // 想在外面改坏它
      snapshot.screens[0].name = '被改坏了';
      const again = api.getDoc();
      return { after: again.screens[0].root.children.length, name: again.screens[0].name, domCount: document.querySelectorAll('#dz-frame .dz-el').length };
    })()`);
    check('api:getdoc-copy', '`getDoc()` 交出来的是**深拷贝**：在外面怎么改它，编辑器里那一份与画布都不会跟着变（写入只有那几条方法）',
      copy.after === 1 && copy.name === '屏 1' && copy.domCount === 6, JSON.stringify(copy));

    const geo = await apiGeo(Object.values(apiIds));
    const content = await evalIn(`(() => {
      const el = document.querySelector('#dz-frame .dz-el[data-id="' + ${JSON.stringify(apiIds.cols)} + '"]');
      return { w: el.clientWidth, h: el.clientHeight };
    })()`);
    const domCount = await evalIn(`document.querySelectorAll('#dz-frame .dz-el').length`);
    check('api:two-cols-dom', '画布上真的长出那六个 DOM 元素，标签也对得上（分割符是 `<hr>`、按钮是 `<button>`）—— API 建的不是「数据里的空壳」',
      geo[apiIds.cols].tag === 'div' && geo[apiIds.divider].tag === 'hr' && geo[apiIds.divider].type === 'divider'
      && geo[apiIds.button].tag === 'button' && geo[apiIds.left].tag === 'div' && geo[apiIds.right].tag === 'div' && domCount === 6,
      JSON.stringify({ geo, domCount }));
    check('api:two-cols-geometry', '**画布 DOM 实测几何 == 文档**：两栏等宽（两个 `fill` 平分剩余空间）、左 ＋ 分割符 ＋ 右 == 父容器内容宽、分割符实测宽 == 文档里的 `thickness`（4）且实测高 == 父内容高、按钮实测 w/h == 文档里的 140/36 —— 没有第二份布局引擎',
      geo[apiIds.left].w === geo[apiIds.right].w
      && geo[apiIds.left].w + geo[apiIds.divider].w + geo[apiIds.right].w === content.w
      && geo[apiIds.divider].w === 4 && geo[apiIds.divider].h === content.h
      && geo[apiIds.left].h === content.h && geo[apiIds.button].w === 140 && geo[apiIds.button].h === 36
      && geo[apiIds.cols].w === 592 && geo[apiIds.cols].w === content.w,
      JSON.stringify({ geo, content }));
  });

  await groupCheck('api-update', async () => {
    const upd = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const before = api.getState();
      const receipt = api.updateNode(${JSON.stringify(apiIds.button)}, { size: { w: { mode: 'fixed', value: 210 } }, style: { borderLeftWidth: '3', color: '#8abeb7' } });
      const after = api.getState();
      const el = document.querySelector('#dz-frame .dz-el[data-id="' + ${JSON.stringify(apiIds.button)} + '"]');
      const button = api.getDoc().screens[0].root.children[0].children[0].children[0];
      return {
        receipt, before, after,
        measured: { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), borderLeft: getComputedStyle(el).borderLeftWidth },
        docSize: button.size, docStyle: button.style,
      };
    })()`);
    check('api:update-node', '`updateNode(id, patch)` 改完**画布实测跟着变**（按钮宽 140→210），文档里就是 210；顺带把 `style.borderLeftWidth` 写成 3 ⇒ 实测那条左边框真的 3px（API 也做得出「那条槽」）',
      upd.receipt.ok === true && upd.receipt.applied.join(',') === 'size,style'
      && upd.measured.w === 210 && upd.measured.h === 36
      && upd.docSize.w.mode === 'fixed' && upd.docSize.w.value === 210 && upd.docSize.h.value === 36
      && upd.measured.borderLeft === '3px' && upd.docStyle.borderLeftWidth === '3' && upd.docStyle.color === '#8abeb7',
      JSON.stringify(upd));
    check('api:one-history-entry', '一次 API 改动 = **一条**历史条目（与鼠标改一格同一个 `changeModel()`）：historyLength 正好 +1、指针跟着走、`canRedo` 回到 false',
      upd.after.historyLength === upd.before.historyLength + 1 && upd.after.historyIndex === upd.before.historyIndex + 1
      && upd.after.canRedo === false && upd.receipt.historyLength === upd.after.historyLength,
      JSON.stringify({ before: upd.before, after: upd.after, receipt: upd.receipt }));
    await shot('40-api-two-columns');

    const parent = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const receipt = api.updateNode(${JSON.stringify(apiIds.cols)}, { size: { w: { mode: 'fixed', value: 500 } } });
      const el = document.querySelector('#dz-frame .dz-el[data-id="' + ${JSON.stringify(apiIds.cols)} + '"]');
      return { receipt, content: el.clientWidth };
    })()`);
    const geo500 = await apiGeo([apiIds.cols, apiIds.left, apiIds.divider, apiIds.right]);
    check('api:update-parent-follows', '改父容器宽（592→500）⇒ 实测 500，两栏跟着重新分配（左 ＋ 分割符 ＋ 右 == 500、分割符还是 4、两栏仍等宽）—— 语义还是那两条，API 没有绕开渲染',
      parent.receipt.ok === true && geo500[apiIds.cols].w === 500 && parent.content === 500
      && geo500[apiIds.left].w + geo500[apiIds.divider].w + geo500[apiIds.right].w === 500
      && geo500[apiIds.divider].w === 4 && geo500[apiIds.left].w === geo500[apiIds.right].w,
      JSON.stringify({ ...geo500, receipt: parent.receipt }));

    const cleared = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const receipt = api.updateNode(${JSON.stringify(apiIds.button)}, { style: { borderLeftWidth: null } });
      const el = document.querySelector('#dz-frame .dz-el[data-id="' + ${JSON.stringify(apiIds.button)} + '"]');
      const button = api.getDoc().screens[0].root.children[0].children[0].children[0];
      return { receipt, style: button.style, borderLeft: getComputedStyle(el).borderLeftWidth, bytes: api.exportDoc().length };
    })()`);
    check('api:update-clear', 'patch 里写 `null` = **删掉那一格**（`style.borderLeftWidth: null` ⇒ 数据里没有这个键、实测左边框回到 0px），别的格子没被顺手清掉',
      cleared.style.borderLeftWidth === undefined && cleared.style.color === '#8abeb7'
      && cleared.borderLeft === '0px' && cleared.receipt.applied.join(',') === 'style',
      JSON.stringify(cleared));
  });

  await groupCheck('api-screen-state-transition', async () => {
    const built = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const collect = (el) => { const out = [el]; for (const child of (el.children ?? [])) out.push(...collect(child)); return out; };
      const s2 = api.addScreen('屏 2');
      const st2 = api.addState(s2.screenId, '状态 2');
      const screen = api.getDoc().screens.find((candidate) => candidate.id === s2.screenId);
      // ⚠️ 第 0 个状态的树就是 screen.root（不重复写 states[0].root —— 见 docs/design/designer-ui.md §1.1），
      //    只有 j>0 的状态才自带 root。下面两条各拿一棵树（同时把这个约定也量了）。
      const state0HasRoot = screen.states[0].root !== undefined;
      const treeA = collect(screen.root);
      const treeB = collect(screen.states[1].root);
      const overlap = treeA.filter((el) => treeB.some((other) => other.id === el.id)).map((el) => el.id);
      const back = api.openScreen('screen-1', 'state-1');
      const tr = api.addTransition({ from: { screen: 'screen-1', state: 'state-1' }, to: { screen: s2.screenId, state: st2.stateId }, trigger: '点提交' });
      api.setView('flow');
      return { s2, st2, back, tr, state0HasRoot, stateIds: screen.states.map((st) => st.id), counts: [treeA.length, treeB.length], overlap, screens: api.getDoc().screens.length };
    })()`);
    check('api:add-screen', '`addScreen("屏 2")` ⇒ 文档多一屏（带一个默认状态 ＋ 一棵空的根树）并切过去，回执说得出 screenId / stateId / rootId',
      built.s2.ok === true && built.screens === 2 && typeof built.s2.screenId === 'string' && typeof built.s2.stateId === 'string'
      && typeof built.s2.rootId === 'string' && built.s2.name === '屏 2',
      JSON.stringify(built.s2));
    check('api:add-state', '`addState(screenId, "状态 2")` ⇒ 那一屏多一个状态，新状态的树是**拷贝**（元素个数一样，但**元素 id 全部重新分配**：两边不重叠）；而且它遵守那条约定：**第 0 个状态的树就是 `screen.root`**（不重复写 `states[0].root`）',
      built.st2.ok === true && built.stateIds.length === 2 && built.counts[0] === built.counts[1] && built.overlap.length === 0
      && built.st2.current === true && built.st2.name === '状态 2' && built.state0HasRoot === false,
      JSON.stringify({ st2: built.st2, stateIds: built.stateIds, counts: built.counts, overlap: built.overlap, state0HasRoot: built.state0HasRoot }));
    check('api:open-screen', '`openScreen("screen-1", "state-1")` 切回原来那一屏那一个状态（与点左栏那两行同一条路，各自可撤销）',
      built.back.ok === true && built.back.screenId === 'screen-1' && built.back.stateId === 'state-1', JSON.stringify(built.back));
    check('api:add-transition', '`addTransition({from,to,trigger})` ⇒ `transitions` 里真的多一条、回执里 `arrows` 立刻是 1（箭头是那条数据的视图）',
      built.tr.ok === true && typeof built.tr.id === 'string' && built.tr.transitions === 1 && built.tr.arrows === 1
      && built.tr.trigger === '点提交' && built.tr.from.screen === 'screen-1' && built.tr.to.screen === built.s2.screenId,
      JSON.stringify(built.tr));

    await frames(4); // `paintArrows()` 挂在 requestAnimationFrame 上（见 web/designer.js 的 renderFlow）
    const arrows = await evalIn(`(() => ({
      paths: [...document.querySelectorAll('#dz-arrows .dz-arrow-path')].map((p) => p.dataset.arrow),
      markers: [...document.querySelectorAll('#dz-arrows .dz-arrow-path')].map((p) => p.getAttribute('marker-end')),
      labels: [...document.querySelectorAll('#dz-arrows .dz-arrow-label')].map((t) => t.textContent),
      transitions: window.sophoDesigner.getDoc().transitions.map((t) => t.id),
      flowVisible: document.querySelector('#dz-flow').hidden === false,
      view: window.sophoDesigner.getState().view,
    }))()`);
    check('api:add-transition-arrow', 'API 加的那条转移 **画布上真的出现箭头**：带 `marker-end`、`data-arrow` 就是回执里那条数据的 id、触发文字写在箭头旁；根数 == `transitions` 条数（画不出一根数据里没有的箭头）',
      arrows.transitions.join(',') === built.tr.id && arrows.paths.length === 1 && arrows.paths[0] === built.tr.id
      && arrows.markers[0] === 'url(#dz-arrowhead)' && arrows.labels.includes('点提交')
      && arrows.flowVisible === true && arrows.view === 'flow',
      JSON.stringify({ receipt: built.tr, arrows }));
    await shot('41-api-arrow');

    const same = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const before = api.exportDoc();
      const screen = api.getDoc().screens[0];
      let message = null;
      try {
        api.addTransition({ from: { screen: screen.id, state: screen.states[0].id }, to: { screen: screen.id, state: screen.states[0].id }, trigger: '自己到自己' });
      } catch (error) { message = error?.message ?? String(error); }
      return { message, sameBytes: api.exportDoc() === before, transitions: api.getDoc().transitions.length };
    })()`);
    check('api:transition-reject-same', '`addTransition` 也如实拒：`from` 与 `to` 是同屏同状态 ⇒ 抛出**说得出理由**的错、文档逐字节未变（与表单里那条口径同一个）',
      typeof same.message === 'string' && same.message.includes('是同一条') && same.sameBytes === true && same.transitions === 1,
      JSON.stringify(same));
  });

  await groupCheck('api-undo', async () => {
    await evalIn(`window.sophoDesigner.setView('edit')`);
    await frames(2);
    const geoIds = [apiIds.cols, apiIds.left, apiIds.divider, apiIds.right, apiIds.button];
    const run = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const ids = ${JSON.stringify(geoIds)};
      const bytesBefore = api.exportDoc();
      const geoBefore = window.__apiGeo(ids);
      const stBefore = api.getState();
      const receipt = api.updateNode(${JSON.stringify(apiIds.button)}, { size: { w: { mode: 'fixed', value: 260 } } });
      const bytesAfter = api.exportDoc();
      const geoAfter = window.__apiGeo(ids);
      const undone = api.undo();
      const bytesUndone = api.exportDoc();
      const geoUndone = window.__apiGeo(ids);
      const geoUndoneAgain = window.__apiGeo(ids);
      const redone = api.redo();
      return { bytesBefore, geoBefore, stBefore, receipt, bytesAfter, geoAfter, undone, bytesUndone, geoUndone, geoUndoneAgain, redone, bytesRedone: api.exportDoc(), geoRedone: window.__apiGeo(ids) };
    })()`);
    check('api:undo-restores', '`undo()` 一次 ⇒ 回到**完全相同的几何**（逐个元素逐项相同）与**逐字节相同**的文档；改动前后确实不同（这一条自带对照：改完那一份与改前那一份都不一样）',
      run.bytesAfter !== run.bytesBefore && JSON.stringify(run.geoAfter) !== JSON.stringify(run.geoBefore)
      && run.bytesUndone === run.bytesBefore && JSON.stringify(run.geoUndone) === JSON.stringify(run.geoBefore)
      && run.undone.ok === true && run.undone.changed === true && run.undone.historyIndex === run.stBefore.historyIndex
      && run.receipt.historyLength === run.undone.historyLength,
      JSON.stringify({ before: run.geoBefore, after: run.geoAfter, undone: run.geoUndone, bytes: [run.bytesBefore.length, run.bytesAfter.length, run.bytesUndone.length], receipt: run.receipt, undoneReceipt: run.undone }));
    check('api:redo-restores', '`redo()` 一次 ⇒ 又回到改完那一份（字节与几何逐项相同），回执 `changed:true`（撤销/重做与顶栏那两个按钮同一条路）',
      run.redone.ok === true && run.redone.changed === true && run.bytesRedone === run.bytesAfter
      && JSON.stringify(run.geoRedone) === JSON.stringify(run.geoAfter),
      JSON.stringify({ redone: run.redone, sameBytes: run.bytesRedone === run.bytesAfter, sameGeo: JSON.stringify(run.geoRedone) === JSON.stringify(run.geoAfter) }));

    // ⑥ 「同一条提交路径」：API 改一次 ＋ **鼠标**（真拖拽）再改一次 ⇒ 同一个撤销栈
    const b0 = await evalIn('window.sophoDesigner.exportDoc()');
    const g0 = await apiGeo(geoIds);
    const st0 = await evalIn('window.sophoDesigner.getState()');
    const apiChange = await evalIn(`window.sophoDesigner.updateNode(${JSON.stringify(apiIds.button)}, { size: { w: { mode: 'fixed', value: 200 } } })`);
    const b1 = await evalIn('window.sophoDesigner.exportDoc()');
    const g1 = await apiGeo(geoIds);
    const buttonBox = await box(`#dz-frame .dz-el[data-id="${apiIds.button}"]`);
    await dragPoints({ x: buttonBox.cx, y: buttonBox.cy }, { x: buttonBox.cx + 24, y: buttonBox.cy + 12 }, { steps: 8 });
    const b2 = await evalIn('window.sophoDesigner.exportDoc()');
    const g2 = await apiGeo(geoIds);
    const st2 = await evalIn('window.sophoDesigner.getState()');
    const undoOne = await evalIn('window.sophoDesigner.undo()');
    const b3 = await evalIn('window.sophoDesigner.exportDoc()');
    const g3 = await apiGeo(geoIds);
    const undoTwo = await evalIn('window.sophoDesigner.undo()');
    const b4 = await evalIn('window.sophoDesigner.exportDoc()');
    const g4 = await apiGeo(geoIds);
    check('api:same-undo-stack', '**API 与鼠标在同一个撤销栈里**：先用 API 改一次（宽 260→200）、再用**鼠标真拖一下**那个按钮 ⇒ 两笔各占一条历史；`undo()` 一次只回退鼠标那笔（字节与几何 == API 改完那一份）、再 `undo()` 一次回退 API 那笔（回到最初的字节与几何）',
      b0 !== b1 && b1 !== b2 && st2.historyLength === st0.historyLength + 2
      && undoOne.ok === true && undoOne.changed === true && b3 === b1 && JSON.stringify(g3) === JSON.stringify(g1)
      && undoTwo.ok === true && undoTwo.changed === true && b4 === b0 && JSON.stringify(g4) === JSON.stringify(g0),
      JSON.stringify({
        historyLength: [st0.historyLength, st2.historyLength], apiChange,
        undoOne, undoTwo,
        backToApi: [b3 === b1, JSON.stringify(g3) === JSON.stringify(g1)],
        backToStart: [b4 === b0, JSON.stringify(g4) === JSON.stringify(g0)],
        mouseMoved: JSON.stringify(g2[apiIds.button]) !== JSON.stringify(g1[apiIds.button]),
      }));
  });

  await groupCheck('api-illegal', async () => {
    const battery = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const doc = api.getDoc();
      const s0 = doc.screens[0];
      const s1 = doc.screens[1] ?? doc.screens[0];
      const from = { screen: s0.id, state: s0.states[0].id };
      const to = { screen: s1.id, state: (s1.states[0] ?? {}).id };
      const cases = [
        ['bad-type', '元素类型只能是', () => api.addNode(${JSON.stringify(apiIds.root)}, { type: 'nope' })],
        ['unknown-parent', '未知的元素 id', () => api.addNode('el-999', { type: 'rect' })],
        ['bad-key', 'thickness 只有分割符', () => api.updateNode(${JSON.stringify(apiIds.button)}, { thickness: 3 })],
        ['bad-layout', 'layout 只有 container 有', () => api.updateNode(${JSON.stringify(apiIds.button)}, { layout: { mode: 'row' } })],
        ['divider-size', '改不了 "size"', () => api.updateNode(${JSON.stringify(apiIds.divider)}, { size: { w: { mode: 'fill' } } })],
        ['bad-mode', 'size.w.mode 只能是', () => api.updateNode(${JSON.stringify(apiIds.button)}, { size: { w: { mode: 'bogus' } } })],
        ['zero-thickness', 'thickness 必须大于 0', () => api.updateNode(${JSON.stringify(apiIds.divider)}, { thickness: 0 })],
        ['bad-box-key', 'box 里只放 x / y', () => api.updateNode(${JSON.stringify(apiIds.button)}, { box: { x: 1, w: 50 } })],
        ['self-move', '移进它自己', () => api.moveNode(${JSON.stringify(apiIds.cols)}, ${JSON.stringify(apiIds.cols)})],
        ['cycle', '移进它自己的后代', () => api.moveNode(${JSON.stringify(apiIds.cols)}, ${JSON.stringify(apiIds.left)})],
        ['bad-index', '越界', () => api.moveNode(${JSON.stringify(apiIds.button)}, ${JSON.stringify(apiIds.cols)}, 99)],
        ['children', '改不了 "children"', () => api.addNode(${JSON.stringify(apiIds.root)}, { type: 'rect', children: [] })],
        ['root-remove', '是屏根', () => api.removeNode(${JSON.stringify(apiIds.root)})],
        ['bad-doc', 'screens 是空的', () => api.setDoc({ screens: [] })],
        ['bad-select', '未知的元素 id', () => api.select('el-999')],
        ['same-endpoints', '是同一条', () => api.addTransition({ from, to: from, trigger: 'x' })],
        ['unknown-state', '不在屏', () => api.addTransition({ from, to: { screen: to.screen, state: 'state-99' }, trigger: 'x' })],
      ];
      const out = [];
      for (const [name, expect, run] of cases) {
        const before = api.exportDoc();
        const hist = api.getState();
        let message = null;
        try { run(); } catch (error) { message = error?.message ?? String(error); }
        const histAfter = api.getState();
        out.push({
          name, expect, message, threw: message !== null,
          saysWhy: message !== null && message.includes(expect),
          docSame: api.exportDoc() === before,
          histSame: histAfter.historyLength === hist.historyLength && histAfter.historyIndex === hist.historyIndex,
          domCount: document.querySelectorAll('#dz-frame .dz-el').length,
        });
      }
      // 最后再拒一次（确定要被看清的那次调用是哪一条：状态栏里那句话要认得出来）
      let last = null;
      try { api.updateNode('el-999', { name: 'x' }); } catch (error) { last = error?.message ?? String(error); }
      const status = document.querySelector('#dz-status');
      return { cases: out, last, total: cases.length, status: { kind: status.dataset.kind ?? null, text: status.textContent } };
    })()`);
    check('api:reject-invalid', '17 种非法输入（未知 id / 不认识的关键字 / 坏 type / 坏 mode / 0 粗细 / 坏 box 键 / 移进自己 / 成环 / index 越界 / 带 children / 删屏根 / 坏文档 / 选不存在的元素 / 同一条转移 / 未知状态）**每一个都抛错、而且错里说得出理由**（不是一句笼统的「失败了」、也不是静默吞掉）',
      battery.cases.length === 17 && battery.total === 17
      && battery.cases.every((item) => item.threw === true && item.saysWhy === true),
      JSON.stringify(battery.cases.filter((item) => !(item.threw && item.saysWhy))));
    check('api:reject-no-write', '这 17 次非法输入之后，文档**逐字节未变**、撤销栈也**一格没动**、画布 DOM 元素数没变（没有半成品状态）',
      battery.cases.every((item) => item.docSame === true && item.histSame === true && item.domCount === 6),
      JSON.stringify(battery.cases.filter((item) => !(item.docSame && item.histSame && item.domCount === 6))));
    check('api:reject-visible', '被拒的那次调用**站在这一页前面的人也看得见**：状态栏标成 `data-kind=error` 并写着「拒了这次调用：<原因>」（不是只在 agent 的聊天里）',
      battery.status.kind === 'error' && battery.status.text.includes('sophoDesigner')
      && battery.status.text.includes('未知的元素 id "el-999"'),
      JSON.stringify(battery.status));
    await shot('42-api-illegal-rejected');
  });

  await groupCheck('api-move-remove', async () => {
    // 业主 2026-09-28 点名的两条：`moveNode` 与 `removeNode` 的**成功路径**各跑一次
    // （含「移进 / 删掉之后**几何**与**撤销栈**都对」）—— 这两条在上一单里只量了拒绝路径。
    await evalIn(`window.sophoDesigner.setView('edit')`);
    await frames(2);
    const geoIds = [apiIds.root, apiIds.cols, apiIds.left, apiIds.divider, apiIds.right, apiIds.button];
    const run = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const ids = ${JSON.stringify(geoIds)};
      const button = ${JSON.stringify(apiIds.button)};
      const left = ${JSON.stringify(apiIds.left)};
      const right = ${JSON.stringify(apiIds.right)};
      const divider = ${JSON.stringify(apiIds.divider)};
      const cols = ${JSON.stringify(apiIds.cols)};
      const find = (el, id) => (el && el.id === id) ? el : ((el?.children ?? []).reduce((hit, child) => hit ?? find(child, id), null));
      const domParentOf = (id) => { const el = document.querySelector('#dz-frame .dz-el[data-id="' + id + '"]'); return el?.parentElement?.dataset.id ?? null; };
      const bytesBefore = api.exportDoc();
      const geoBefore = window.__apiGeo(ids);
      const stBefore = api.getState();
      const boxBefore = find(api.getDoc().screens[0].root, button).box;
      // ① moveNode 成功路径：把按钮从左栏搬进右栏
      const moveReceipt = api.moveNode(button, right);
      const rootAfterMove = api.getDoc().screens[0].root;
      const leftAfter = find(rootAfterMove, left);
      const rightAfter = find(rootAfterMove, right);
      const geoMoved = window.__apiGeo(ids);
      const stMoved = api.getState();
      const domParentMoved = domParentOf(button);
      const undoMove = api.undo();
      const bytesAfterUndo = api.exportDoc();
      const geoAfterUndo = window.__apiGeo(ids);
      // ② removeNode 成功路径：删掉分割符
      const stBeforeRemove = api.getState();
      const removeReceipt = api.removeNode(divider);
      const rootAfterRemove = api.getDoc().screens[0].root;
      const colsAfterRemove = find(rootAfterRemove, cols);
      const geoRemoved = window.__apiGeo(ids);
      const stRemoved = api.getState();
      const undoRemove = api.undo();
      const removeRestored = { bytes: api.exportDoc() === bytesBefore, geo: JSON.stringify(window.__apiGeo(ids)) === JSON.stringify(geoBefore) };
      // ③ removeNode 删一棵子树：左栏（连它里面那个按钮）
      const subtreeReceipt = api.removeNode(left);
      const subtreeGone = { left: document.querySelector('#dz-frame .dz-el[data-id="' + left + '"]') === null, button: document.querySelector('#dz-frame .dz-el[data-id="' + button + '"]') === null };
      const subtreeChildren = (find(api.getDoc().screens[0].root, cols)?.children ?? []).map((child) => child.id);
      const undoSubtree = api.undo();
      const subtreeRestored = { bytes: api.exportDoc() === bytesBefore, geo: JSON.stringify(window.__apiGeo(ids)) === JSON.stringify(geoBefore) };
      return {
        boxBefore, bytesBefore, geoBefore, stBefore, stBeforeRemove,
        moveReceipt, leftChildrenAfterMove: (leftAfter.children ?? []).length, rightChildrenAfterMove: (rightAfter.children ?? []).map((child) => child.id), geoMoved, stMoved, domParentMoved,
        undoMove, bytesAfterUndo, geoAfterUndo, movedRestored: { bytes: bytesAfterUndo === bytesBefore, geo: JSON.stringify(geoAfterUndo) === JSON.stringify(geoBefore) },
        removeReceipt, colsChildrenAfterRemove: (colsAfterRemove.children ?? []).map((child) => child.id), geoRemoved, stRemoved, undoRemove, removeRestored,
        subtreeReceipt, subtreeGone, subtreeChildren, undoSubtree, subtreeRestored,
      };
    })()`);
    const movedButton = run.geoMoved[apiIds.button];
    const movedRight = run.geoMoved[apiIds.right];
    check('api:move-node', '`moveNode(id, parentId)` 的**成功路径**：把按钮从左栏搬进右栏 ⇒ 回执说得出新父与序号（`parentId`/`index=0`）、文档里两栏的 children 真的换了、**画布实测位置跟着搬到右栏**（实测 x/y == 右栏实测 + 文档里那个 `box`）、只占**一条**历史；`undo()` 一次 ⇒ 字节与几何逐项回到搬之前',
      run.moveReceipt.ok === true && run.moveReceipt.parentId === apiIds.right && run.moveReceipt.index === 0
      && run.leftChildrenAfterMove === 0 && run.rightChildrenAfterMove.join(',') === apiIds.button
      && run.domParentMoved === apiIds.right
      && movedButton !== null && movedRight !== null
      && movedButton.x === movedRight.x + Number(run.boxBefore.x) && movedButton.y === movedRight.y + Number(run.boxBefore.y)
      && movedButton.w === run.geoBefore[apiIds.button].w
      && run.stMoved.historyIndex === run.stBefore.historyIndex + 1 && run.stMoved.canRedo === false
      && run.undoMove.changed === true && run.movedRestored.bytes === true && run.movedRestored.geo === true,
      JSON.stringify({ receipt: run.moveReceipt, domParent: run.domParentMoved, box: run.boxBefore,
        leftChildren: run.leftChildrenAfterMove, rightChildren: run.rightChildrenAfterMove,
        geoBefore: run.geoBefore[apiIds.button], geoMoved: movedButton, rightMoved: movedRight,
        history: { before: run.stBefore, moved: run.stMoved }, restored: run.movedRestored, undo: run.undoMove }));
    check('api:remove-node', '`removeNode(id)` 的**成功路径**：删掉竖分割符 ⇒ 回执说得出父与删了几个（1）、文档里那一栏少了一个、**画布实测跟着变**（分割符 DOM 没了、两栏改成平分 500：各 250）、只占**一条**历史；`undo()` 一次 ⇒ 字节与几何逐项回到删之前（分割符 4px 也在）',
      run.removeReceipt.ok === true && run.removeReceipt.parentId === apiIds.cols && run.removeReceipt.removedElements === 1
      && run.colsChildrenAfterRemove.join(',') === [apiIds.left, apiIds.right].join(',')
      && run.geoRemoved[apiIds.divider] === null
      && run.geoRemoved[apiIds.left].w === 250 && run.geoRemoved[apiIds.right].w === 250
      && run.geoRemoved[apiIds.left].w + run.geoRemoved[apiIds.right].w === run.geoBefore[apiIds.cols].w
      && run.stRemoved.historyIndex === run.stBeforeRemove.historyIndex + 1 && run.stRemoved.canRedo === false
      && run.undoRemove.changed === true && run.removeRestored.bytes === true && run.removeRestored.geo === true,
      JSON.stringify({ receipt: run.removeReceipt, colsChildren: run.colsChildrenAfterRemove, divider: run.geoRemoved[apiIds.divider],
        removed: { left: run.geoRemoved[apiIds.left], right: run.geoRemoved[apiIds.right] }, before: run.geoBefore,
        history: { before: run.stBeforeRemove, removed: run.stRemoved }, restored: run.removeRestored, undo: run.undoRemove }));
    check('api:remove-node-subtree', '`removeNode` 删的是一棵**子树**：删掉左栏（它里面那个按钮）⇒ 回执 `removedElements=2`、DOM 里两个都不在了、文档里那一栏也没了；`undo()` 一次 ⇒ 两个都回来且**几何逐项与删之前相同**（证明副本/历史链没串）',
      run.subtreeReceipt.ok === true && run.subtreeReceipt.removedElements === 2
      && run.subtreeGone.left === true && run.subtreeGone.button === true
      && run.subtreeChildren.join(',') === [apiIds.divider, apiIds.right].join(',')
      && run.undoSubtree.changed === true && run.subtreeRestored.bytes === true && run.subtreeRestored.geo === true,
      JSON.stringify({ receipt: run.subtreeReceipt, gone: run.subtreeGone, children: run.subtreeChildren, restored: run.subtreeRestored, undo: run.undoSubtree }));
  });

  await groupCheck('api-export-setdoc', async () => {
    const beforeDownloads = Number(await evalIn('window.__downloads.length'));
    const apiBytes = await evalIn('window.sophoDesigner.exportDoc()');
    await clickSelector('#dz-export'); // 顶栏那个「导出 JSON」（真鼠标）
    await page.waitFor(async () => Number(await safeEval('window.__downloads.length')) > beforeDownloads, '顶栏「导出 JSON」没发下载', 6000).catch(() => null);
    const downloaded = await evalIn(`(async () => {
      const entry = window.__downloads[window.__downloads.length - 1] ?? null;
      if (!entry) return null;
      return new TextDecoder().decode(new Uint8Array(await (await fetch(entry.href)).arrayBuffer()));
    })()`);
    check('api:export-doc-bytes', '`exportDoc()` 拿到的**就是**「导出 JSON」下载到的那串字节（`serializeDocument()` 是唯一来源：agent 读到的与人下载到的是同一串，不是第二份序列化器）',
      typeof apiBytes === 'string' && apiBytes.length > 0 && downloaded === apiBytes,
      JSON.stringify({ bytes: apiBytes.length, downloaded: downloaded?.length ?? null, same: downloaded === apiBytes }));

    const roundtrip = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const text = api.exportDoc();
      const receipt = api.setDoc(text); // 文本也收（与「导入 JSON」同一个解析器与校验）
      const same = api.exportDoc() === text;
      const undone = api.undo();
      return { receipt, same, restored: api.exportDoc() === text, undone };
    })()`);
    check('api:setdoc-roundtrip', '`setDoc(exportDoc())` 往返**逐字节确定**（与「导入 JSON」同一个解析器与校验），而且**可撤销**（撤销后还是那一串）',
      roundtrip.receipt.ok === true && roundtrip.same === true && roundtrip.restored === true && roundtrip.undone.changed === true,
      JSON.stringify(roundtrip));

    const flow = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const doc = api.getDoc();
      doc.transitions = []; // 把数据里那条转移拿掉
      const receipt = api.setDoc(doc);
      api.setView('flow');
      return { receipt, transitions: api.getDoc().transitions.length };
    })()`);
    await frames(4);
    const arrowsGone = await evalIn(`document.querySelectorAll('#dz-arrows .dz-arrow-path').length`);
    const back = await evalIn('window.sophoDesigner.undo()');
    await frames(4);
    const arrowsBack = await evalIn(`document.querySelectorAll('#dz-arrows .dz-arrow-path').length`);
    check('api:flow-from-data', '把 `transitions` 拿掉（`setDoc`）⇒ 画布上箭头**跟着消失**（0 根），撤销一步 ⇒ 又回来 1 根 —— 箭头只是数据的视图，API 也没绕过它',
      flow.transitions === 0 && arrowsGone === 0 && back.changed === true && arrowsBack === 1,
      JSON.stringify({ transitions: flow.transitions, arrowsGone, back, arrowsBack }));
  });

  // ═══ 17.5 转移两端必须写全（`{screen, state}`）—— 「静默收下、转移图里一根箭头都画不出来」不再可能 ═══
  //
  // 判据（业主 2026-09-28）：`transitions` 的两端**必须显式**写成 `{screen, state}`（口径写在
  // `docs/design/designer-format.md`）；缺 `state` 的文档要被**拒收**（人话 ＋ 可粘回的路径）、且文档一字节不动；
  // 两端写全 ⇒ 通过，而且流程视图/转移图里**箭头数 == 转移数**；`addTransition` 同一个口径（共用一份实现）；
  // 「指不到节点」的转移（形状合法、节点不存在）**不许静默**：流程视图上要有一条可见警告。
  await groupCheck('tends', async () => {
    // 一份已知形状的底稿（2 屏 / 3 状态 / 0 转移）：后面的读数都从它出发，不依赖`前面的组`留下的形状。
    const base = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const doc = api.getDoc();
      doc.screens = [
        { id: 's-a', name: 'A 屏', states: [{ id: 'sa-1', name: '一' }, { id: 'sa-2', name: '二' }],
          root: { id: 'a-root', type: 'container', size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, layout: { mode: 'free' }, children: [] } },
        { id: 's-b', name: 'B 屏', states: [{ id: 'sb-1', name: '一' }],
          root: { id: 'b-root', type: 'container', size: { w: { mode: 'fixed', value: 400 }, h: { mode: 'fixed', value: 300 } }, layout: { mode: 'free' }, children: [] } },
      ];
      doc.transitions = [];
      api.setDoc(doc);
      return { screens: api.getDoc().screens.length, transitions: api.getDoc().transitions.length };
    })()`);
    check('tends:base-doc', '先把文档换成一份已知形状的底稿（2 屏 / 3 状态 / 0 转移）—— 这一组后面的读数都从它出发',
      base.screens === 2 && base.transitions === 0, JSON.stringify(base));

    // ① `setDoc()`（可编程控制面）：缺 `state` 的转移 ⇒ 拒收 ＋ 人话 ＋ 可粘回的路径 ＋ 文档一字节不动
    const rejected = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const before = api.exportDoc();
      const doc = api.getDoc();
      doc.transitions = [
        { id: 'tr-ok', from: { screen: 's-a', state: 'sa-1' }, to: { screen: 's-b', state: 'sb-1' }, trigger: '写全了' },
        { id: 'tr-half', from: { screen: 's-a' }, to: { screen: 's-b', state: 'sb-1' }, trigger: '只写了 screen' },
      ];
      let message = null;
      try { api.setDoc(doc); } catch (error) { message = error?.message ?? String(error); }
      const status = document.querySelector('#dz-status');
      return {
        message, before, after: api.exportDoc(),
        transitions: api.getDoc().transitions.length, arrows: window.__dz.arrowSpecs().length,
        statusKind: status.dataset.kind ?? null, statusText: status.textContent,
      };
    })()`);
    check('tends:doc-reject-missing-state', '`setDoc()` 收一份「两端只写了 `screen`」的文档 ⇒ **拒收**：错里点名 `transitions[1].from`、说清缺少 `"state"` 与`两端都要写成 {screen, state}`、并把那一端原值粘回去（人话 ＋ 可粘回的路径）',
      typeof rejected.message === 'string' && rejected.message.includes('transitions[1].from: 缺少 "state"')
      && rejected.message.includes('两端都要写成 {screen, state}') && rejected.message.includes('{"screen":"s-a"}'),
      JSON.stringify({ message: rejected.message }));
    check('tends:doc-reject-no-write', '被拒那一跑**文档一字节不动**（导出字节前后相同、`transitions` 还是 0 条、画布上 0 根箭头），而且人**在状态栏上看得见**那条拒绝（`data-kind=error` ＋ 带着那条路径）',
      rejected.before === rejected.after && rejected.transitions === 0 && rejected.arrows === 0
      && rejected.statusKind === 'error' && rejected.statusText.includes('transitions[1].from'),
      JSON.stringify({ sameBytes: rejected.before === rejected.after, transitions: rejected.transitions, arrows: rejected.arrows, statusKind: rejected.statusKind, statusText: rejected.statusText }));
    await shot('43-tends-reject-missing-state');

    // ② 「导入 JSON」（真 file input）同一条口径 —— 与 `setDoc()` 共用**同一个**校验器，不是两套
    const beforeImport = await evalIn('window.sophoDesigner.exportDoc()');
    const halfDocText = await evalIn(`(() => {
      const doc = window.sophoDesigner.getDoc();
      doc.transitions = [{ id: 'tr-half', from: { screen: 's-a' }, to: { screen: 's-b', state: 'sb-1' }, trigger: '只写 screen' }];
      return JSON.stringify(doc, null, 2) + '\\n';
    })()`);
    await evalIn(`(async () => {
      const data = new DataTransfer();
      data.items.add(new File([${JSON.stringify(halfDocText)}], 'design.json', { type: 'application/json' }));
      const input = document.querySelector('#dz-import');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await page.waitFor(async () => String(await safeEval('document.querySelector("#dz-status")?.textContent ?? ""')).includes('导入失败'), '导入被拒的状态没出现', 6000).catch(() => {});
    const imported = await evalIn(`(() => {
      const status = document.querySelector('#dz-status');
      return { kind: status.dataset.kind ?? null, text: status.textContent, bytes: window.sophoDesigner.exportDoc() };
    })()`);
    check('tends:import-reject-missing-state', '「导入 JSON」喂同一份缺 `state` 的文档 ⇒ 状态栏**如实报导入失败**、逐字说出同一条口径（`transitions[0].from: 缺少 "state"` ＋ `两端都要写成 {screen, state}`），且文档没被换掉（字节前后相同）',
      imported.kind === 'error' && imported.text.includes('导入失败') && imported.text.includes('transitions[0].from: 缺少 "state"')
      && imported.text.includes('两端都要写成 {screen, state}') && imported.bytes === beforeImport,
      JSON.stringify({ kind: imported.kind, text: imported.text, unchanged: imported.bytes === beforeImport }));

    // ③ `addTransition`（agent 那条入口）同一口径 —— 形状那一层就是同一份实现
    const addRejected = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const before = api.exportDoc();
      let message = null;
      try { api.addTransition({ from: { screen: 's-a' }, to: { screen: 's-b', state: 'sb-1' }, trigger: 'x' }); } catch (error) { message = error?.message ?? String(error); }
      return { message, same: api.exportDoc() === before, transitions: api.getDoc().transitions.length };
    })()`);
    check('tends:add-reject-missing-state', '`addTransition` 只给 `from:{screen:\'s-a\'}`（缺 `state`）⇒ **同一个口径拒收**（错里就是 `两端都要写成 {screen, state}` ＋ 那一端的原值）、文档逐字节未变、也没多出一条转移（一个入口拦、另一个入口放不行）',
      typeof addRejected.message === 'string' && addRejected.message.includes('两端都要写成 {screen, state}')
      && addRejected.message.includes('{"screen":"s-a"}') && addRejected.same === true && addRejected.transitions === 0,
      JSON.stringify(addRejected));

    // ④ 两端写全 ⇒ 通过，而且**箭头数 == 转移数**（流程视图与转移图各量一次）
    const full = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const doc = api.getDoc();
      doc.transitions = [
        { id: 'tr-1', from: { screen: 's-a', state: 'sa-1' }, to: { screen: 's-b', state: 'sb-1' }, trigger: '去 B' },
        { id: 'tr-2', from: { screen: 's-a', state: 'sa-2' }, to: { screen: 's-a', state: 'sa-1' }, trigger: '回一' },
      ];
      const receipt = api.setDoc(doc);
      api.setView('flow');
      return { receipt, specs: window.__dz.arrowSpecs().map((spec) => spec.id), transitions: api.getDoc().transitions.map((t) => t.id), warnHidden: document.querySelector('#dz-flow-warn').hidden };
    })()`);
    await frames(4);
    const fullArrows = await evalIn(`[...document.querySelectorAll('#dz-arrows .dz-arrow-path')].map((path) => path.dataset.arrow)`);
    // 再量一次**转移图（导出那份 SVG，节点 = 屏 · 状态）**：箭头数 == 转移数、且没有那条「指不到节点」的警告
    const fullBeforeDl = Number(await evalIn('window.__downloads.length'));
    await evalIn(`(() => { document.querySelector('#dz-export-toggle').click(); return true; })()`);
    await frames(1);
    await clickSelector('#dz-export-items [data-export="flow"]');
    await page.waitFor(async () => Number(await safeEval('window.__downloads.length')) > fullBeforeDl, '导出转移图没有发出下载', 8000).catch(() => null);
    const fullFlow = await evalIn(`(async () => {
      const entry = window.__downloads[window.__downloads.length - 1] ?? null;
      if (!entry) return null;
      return new TextDecoder().decode(new Uint8Array(await (await fetch(entry.href)).arrayBuffer()));
    })()`);
    const fullArrowPaths = typeof fullFlow === 'string' ? (fullFlow.match(/marker-end="url\(#dz-export-arrowhead\)"/g) ?? []).length : -1;
    const fullNodes = typeof fullFlow === 'string' ? (fullFlow.match(/data-node=/g) ?? []).length : -1;
    check('tends:ok-arrows-eq-transitions', '两端写全 ⇒ `setDoc()` 通过，**流程视图**（2 根 `data-arrow` 逐条对上）与**转移图**（3 个节点 / 2 根带 marker 的箭头，与 2 条转移相等）里都是**箭头数 == 转移数**，警告不出现',
      full.receipt.ok === true && full.transitions.length === 2 && full.specs.length === 2
      && fullArrows.length === 2 && full.transitions.every((id) => fullArrows.includes(id))
      && full.specs.every((id) => full.transitions.includes(id)) && full.warnHidden === true
      && fullNodes === 3 && fullArrowPaths === 2 && typeof fullFlow === 'string' && !fullFlow.includes('data-flow-warning'),
      JSON.stringify({ transitions: full.transitions, specs: full.specs, arrows: fullArrows, warnHidden: full.warnHidden, nodes: fullNodes, arrowPaths: fullArrowPaths }));

    // ⑤ 指不到节点（形状合法、节点不存在）**不许静默**：那一条要被点名，且不许在转移图里长出一根假箭头
    const typo = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const doc = api.getDoc();
      doc.transitions = [
        { id: 'tr-good', from: { screen: 's-a', state: 'sa-1' }, to: { screen: 's-b', state: 'sb-1' }, trigger: '好' },
        { id: 'tr-typo', from: { screen: 's-a', state: 'sa-99' }, to: { screen: 's-b', state: 'sb-1' }, trigger: '状态打错' },
      ];
      const receipt = api.setDoc(doc);
      api.setView('flow');
      const warn = document.querySelector('#dz-flow-warn');
      return { receipt, hidden: warn.hidden, text: warn.textContent.trim(), wide: warn.getBoundingClientRect().width };
    })()`);
    await frames(4);
    check('tends:flow-warn-unresolvable', '一条转移的 `state` 打错（形状合法、节点不存在）⇒ **形状校验收下**（两层各管各的），但流程视图上有一条**看得见的**警告：说清「1 条转移指不到节点」并点名 `tr-typo`（`tr-good` 不许被误报）',
      typo.receipt.ok === true && typo.hidden === false && typo.wide > 0
      && typo.text.includes('1 条转移指不到节点') && typo.text.includes('tr-typo') && !typo.text.includes('tr-good'),
      JSON.stringify({ hidden: typo.hidden, wide: typo.wide, text: typo.text }));
    await shot('44-tends-flow-warning');

    // 同一件事在**导出的转移图**里也要说清（那根箭头不许静默消失）
    const beforeDl = Number(await evalIn('window.__downloads.length'));
    await evalIn(`(() => { document.querySelector('#dz-export-toggle').click(); return true; })()`);
    await frames(1);
    await clickSelector('#dz-export-items [data-export="flow"]');
    await page.waitFor(async () => Number(await safeEval('window.__downloads.length')) > beforeDl, '导出转移图没有发出下载', 8000).catch(() => null);
    const flowText = await evalIn(`(async () => {
      const entry = window.__downloads[window.__downloads.length - 1] ?? null;
      if (!entry) return null;
      return new TextDecoder().decode(new Uint8Array(await (await fetch(entry.href)).arrayBuffer()));
    })()`);
    check('tends:flowsvg-warn-unresolvable', '导出的转移图 SVG 里也不静默：图上有一句 `N 条转移指不到节点，未画：tr-typo`（`data-flow-warning`），而**指不到的那条没有 `data-transition`**（画不出一根数据里没有、也没指出节点的假箭头）',
      typeof flowText === 'string' && flowText.includes('data-flow-warning="1"') && flowText.includes('tr-typo')
      && flowText.includes('data-transition="tr-good"') && !flowText.includes('data-transition="tr-typo"'),
      JSON.stringify({ bytes: flowText?.length ?? null, warning: /data-flow-warning="\d+"/.exec(flowText ?? '')?.[0] ?? null, hasTypoArrow: (flowText ?? '').includes('data-transition="tr-typo"') }));

    await evalIn(`window.sophoDesigner.setView('edit')`);
  });

  await groupCheck('api-static', async () => {
    const js = await readFile(path.join(root, 'web', 'designer.js'), 'utf8');
    const seams = ['[SEAM:api-commit]', '[SEAM:api-guard]'];
    const missing = seams.filter((seam) => !js.includes(seam));
    check('static:seams-6', '本单新加的两条接缝在源码里（`[SEAM:api-commit]`：控制面**唯一的提交点**；`[SEAM:api-guard]`：**唯一的拒绝点**）—— 两条反证臂各改一处',
      missing.length === 0, missing.length ? `缺：${JSON.stringify(missing)}` : seams.join(' / '));
    const declared = API_REQUIRED.filter((name) => js.includes(`\n  ${name}: `));
    const mounts = (js.match(/window\.sophoDesigner = /g) ?? []).length;
    check('static:api-surface', '那 13 个方法在源码里逐个挂在 `window.sophoDesigner` 上（名字就是文档里那套），而且只有**一处**挂载点（不是第二套实现）',
      declared.length === API_REQUIRED.length && mounts === 1,
      JSON.stringify({ missing: API_REQUIRED.filter((name) => !declared.includes(name)), mounts }));
    const doc = await readFile(path.join(root, 'docs', 'design', 'designer-agent.md'), 'utf8').catch(() => null);
    const undocumented = API_REQUIRED.filter((name) => !doc || !doc.includes(`\`${name}(`));
    check('static:api-doc', '`docs/design/designer-agent.md` 在仓里，且 13 个方法在它里面逐个有一行（方法名带签名）—— 代码与文档不会各说各的',
      doc !== null && undocumented.length === 0,
      JSON.stringify({ docPresent: doc !== null, undocumented }));
  });

  // ═══ 17.5 流程图的**层序**＋**标签位置**（业主 2026-09-28 报的两条）════════════════════════════
  //
  // 业主逐字：「1. **箭头的层级在窗口的后面，导致看不清楚**；2. **箭头上的字体位置有问题，现在都叠在一起了**」。
  // 这一组造一张**同时踩到这两条**的样张（4 屏 ／ 5 条转移：**两条端点完全相同**、一条起点相同、
  // 一条**跨卡**（路径压在别的屏卡上）、一条自环），然后**量**：
  //   ① 层序：连线层压在屏卡**之上**（`.dz-arrows` 的 z-index > `#dz-flow-cards`，SVG 内部 连线组 在 标签组 之前）；
  //   ② 「压在屏卡上的那一段真看得见」：沿每根路径采样，落在某张卡矩形里的那些点，`elementFromPoint` 命中的**不是卡**；
  //   ③ 每个标签贴在**它自己那条线**上（标签盒子的中心到那条路径的最近距离 ≤ `LABEL_MAX_PX`）；
  //   ④ 任意两个标签的矩形**不相交**（逐对算相交面积）；
  //   ⑤ 每个标签有**不透明底**（fill 的 alpha 与 fill-opacity 都实量）；
  //   ⑥ 层序改正后**屏卡自己的点击没被抢走**（卡头仍是切屏的按钮，不是弹出转移表单）；
  //   ⑦ 导出的 `*.flow.svg` 走**同一条规则**（把它插回页面里当场量，不是「看着像」）。
  // 反证臂：`arrows-under-cards`（层序反了）／`labels-one-point`（画布上的标签全画到同一个点）／
  //         `exportlabel-one-point`（导出件里同上）。
  const LABEL_MAX_PX = 18; // 实现里的 `LABEL_OFFSET = 16`；这一格就是门里的 N
  await groupCheck('flow-layers-labels', async () => {
    // ── 样张：用 API 建（与鼠标「＋ 屏 / ＋ 状态 / ＋ 转移」同一条提交路径，不手改 JSON）──────────
    await clickSelector('#dz-new');
    await frames(2);
    const built = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const firstState = (id) => (api.getDoc().screens.find((s) => s.id === id).states[0] || {}).id;
      const A = api.getDoc().screens[0].id;
      const A1 = firstState(A);
      const B = api.addScreen('屏 B').screenId;
      const C = api.addScreen('屏 C').screenId;
      const D = api.addScreen('屏 D').screenId;
      const b1 = firstState(B);
      const c1 = firstState(C);
      const d1 = firstState(D);
      api.openScreen(A);
      const a2 = api.addState(A, '加载中').stateId;
      api.openScreen(A);
      const add = (from, to, trigger) => api.addTransition({ from, to, trigger }).id;
      const ids = [
        add({ screen: A, state: A1 }, { screen: B, state: b1 }, '点提交'),
        add({ screen: A, state: A1 }, { screen: B, state: b1 }, '快捷键'),
        add({ screen: A, state: A1 }, { screen: C, state: c1 }, '去设置'),
        add({ screen: D, state: d1 }, { screen: B, state: b1 }, '返回'),
        add({ screen: A, state: A1 }, { screen: A, state: a2 }, '首屏请求发出'),
      ];
      api.setView('flow');
      const doc = api.getDoc();
      const pair = (t) => t.from.screen + '/' + t.from.state + '->' + t.to.screen + '/' + t.to.state;
      return {
        ids, screens: doc.screens.length, transitions: doc.transitions.length,
        screenIds: doc.screens.map((s) => s.id),
        statesOfA: doc.screens.find((s) => s.id === A).states.length,
        sameEndpoints: new Set(doc.transitions.map(pair)).size,
      };
    })()`);
    await frames(8);
    const probe = await evalIn(`(() => {
      const svg = document.querySelector('#dz-arrows');
      const cards = [...document.querySelectorAll('#dz-flow .dz-card')];
      const paths = [...document.querySelectorAll('#dz-arrows .dz-arrow-path')];
      const labels = [...document.querySelectorAll('#dz-arrows .dz-arrow-label')];
      const lines = document.querySelector('#dz-arrows .dz-arrow-lines');
      const labelLayer = document.querySelector('#dz-arrows .dz-arrow-labels');
      const svgRect = svg.getBoundingClientRect();
      const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const alphaOf = (value) => {
        const match = /rgba?\\(([^)]+)\\)/.exec(value || '');
        if (!match) return value === 'none' ? 0 : 1;
        const parts = match[1].split(',');
        return parts.length === 4 ? Number(parts[3]) : 1;
      };
      const centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const distanceToPath = (el, path) => {
        const center = centerOf(el);
        const total = path.getTotalLength();
        let best = Infinity;
        for (let i = 0; i <= 200; i += 1) {
          const p = path.getPointAtLength((total * i) / 200);
          best = Math.min(best, Math.hypot(svgRect.left + p.x - center.x, svgRect.top + p.y - center.y));
        }
        return best;
      };
      let onCard = 0;
      let covered = 0;
      let offscreen = 0;
      const offenders = [];
      for (const path of paths) {
        const total = path.getTotalLength();
        for (let i = 1; i < 24; i += 1) {
          const p = path.getPointAtLength((total * i) / 24);
          const x = svgRect.left + p.x;
          const y = svgRect.top + p.y;
          const inside = cards.some((card) => { const r = card.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
          if (!inside) continue;
          onCard += 1;
          // 视口外的点 elementFromPoint 永远返回 null（那是滚出去的，不是「被卡遮住」）⇒ 如实分开数
          if (x < 1 || y < 1 || x >= window.innerWidth - 1 || y >= window.innerHeight - 1) { offscreen += 1; continue; }
          const hit = document.elementFromPoint(x, y);
          if (hit && !hit.closest('.dz-card')) continue;
          covered += 1;
          if (offenders.length < 3) {
            offenders.push({
              arrow: path.dataset.arrow ?? null, t: Math.round((i / 24) * 100) / 100,
              x: Math.round(x), y: Math.round(y),
              hit: hit ? hit.tagName + '.' + String(hit.getAttribute('class') ?? '').split(' ').slice(0, 2).join('.') : null,
            });
          }
        }
      }
      let worstOverlap = 0;
      let pairs = 0;
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) {
          pairs += 1;
          worstOverlap = Math.max(worstOverlap, area(rectOf(labels[i]), rectOf(labels[j])));
        }
      }
      const backgrounds = labels.map((label) => label.querySelector('.dz-arrow-label-bg'));
      return {
        cards: cards.length, paths: paths.length, labels: labels.length,
        labelTexts: labels.map((label) => label.textContent),
        labelIds: labels.map((label) => label.dataset.arrow ?? null),
        zCards: getComputedStyle(document.querySelector('#dz-flow-cards')).zIndex,
        zArrows: getComputedStyle(svg).zIndex,
        labelsInLayer: labelLayer ? labels.every((label) => labelLayer.contains(label)) : false,
        linesBeforeLabels: !!(lines && labelLayer && (lines.compareDocumentPosition(labelLayer) & Node.DOCUMENT_POSITION_FOLLOWING)),
        pathsInLines: lines ? lines.querySelectorAll('.dz-arrow-path').length : 0,
        hitsInLines: lines ? lines.querySelectorAll('.dz-arrow-hit').length : 0,
        pathsNotInLines: lines ? paths.filter((path) => !lines.contains(path)).length : paths.length,
        onCard, covered, offscreen, offenders,
        distances: labels.map((label) => {
          const path = paths.find((p) => p.dataset.arrow === label.dataset.arrow);
          return { id: label.dataset.arrow ?? null, distance: path ? Math.round(distanceToPath(label, path) * 100) / 100 : null };
        }),
        worstOverlap: Math.round(worstOverlap * 100) / 100, pairs,
        backgroundFills: backgrounds.map((el) => (el ? getComputedStyle(el).fill : null)),
        backgroundAlpha: backgrounds.map((el) => (el ? Math.round(alphaOf(getComputedStyle(el).fill) * Number(getComputedStyle(el).fillOpacity) * 1000) / 1000 : 0)),
      };
    })()`);
    await shot('50-flow-label-sample');

    const labelSet = [...probe.labelIds].sort();
    const transitionSet = [...built.ids].sort();
    check('flow:sample', '样张真的是那两种形状：4 屏／5 条转移，其中**两条端点完全相同**（同一个 from 与 to、不同触发）＋ 一条跨卡 ＋ 一条自环；画布上就是 5 根线 ／ 5 个标签（不是只有一条线的玩具样张）',
      built.screens === 4 && built.transitions === 5 && built.sameEndpoints === 4 && built.statesOfA === 2
      && probe.cards === 4 && probe.paths === 5 && probe.labels === 5,
      JSON.stringify({ built, cards: probe.cards, paths: probe.paths, labels: probe.labels }));

    check('flow:labels-are-views', '每个标签的 `data-arrow` 就是那条转移的 id（标签也是数据的视图：集合逐个相等，数不出「数据里没有的标签」）',
      probe.labelIds.every((id) => id !== null) && JSON.stringify(labelSet) === JSON.stringify(transitionSet),
      JSON.stringify({ labelSet, transitionSet, texts: probe.labelTexts }));

    // ① 层序：三个数（实测 computed）+ SVG 内部的挂载顺序
    check('flow:z-order', '层序是一条**写死的规则**：`.dz-arrows`（连线层）的 z-index **大于** `#dz-flow-cards`（屏卡层），而且 SVG 内部 连线组 在 标签组 **之前**（⇒ 标签压在所有连线上）、全部路径都在连线组里',
      Number(probe.zArrows) > Number(probe.zCards) && probe.linesBeforeLabels && probe.labelsInLayer
      && probe.pathsInLines === probe.paths && probe.hitsInLines === probe.paths && probe.pathsNotInLines === 0,
      JSON.stringify({
        zCards: probe.zCards, zArrows: probe.zArrows, linesBeforeLabels: probe.linesBeforeLabels,
        labelsInLayer: probe.labelsInLayer, pathsInLines: probe.pathsInLines, hitsInLines: probe.hitsInLines, pathsNotInLines: probe.pathsNotInLines,
      }));

    // ② 「看不清楚」那半边：压在屏卡上的那一段必须真的看得见（elementFromPoint 不是卡）
    check('flow:arrows-visible-over-cards', '「箭头被卡遮住」那半边：沿 5 根路径各采样 23 点，**落在某张屏卡矩形里且在视口内**的点至少 1 个（跨卡那条转移保证不会空过；滚出视口的点如实另行计数），且这些点上 `elementFromPoint` 命中的**不是屏卡**（连线真的在卡之上）',
      probe.onCard >= 1 && probe.onCard - probe.offscreen >= 1 && probe.covered === 0,
      JSON.stringify({ onCard: probe.onCard, testable: probe.onCard - probe.offscreen, offscreen: probe.offscreen, covered: probe.covered, offenders: probe.offenders }));

    // ③ 每个标签贴在自己那条线上
    const worstDistance = Math.max(...probe.distances.map((entry) => (entry.distance === null ? Infinity : entry.distance)));
    check('labels:on-own-path', `每个标签都贴在**它自己那条线**上：标签盒子的中心到**那一条路径**（200 点采样）的最近距离 ≤ ${LABEL_MAX_PX}px（实测最大 ${worstDistance}）`,
      probe.distances.length === 5 && probe.distances.every((entry) => entry.distance !== null && entry.distance <= LABEL_MAX_PX),
      JSON.stringify({ max: worstDistance, each: probe.distances }));

    // ④ 任意两个标签不相交（这就是业主报的「都叠在一起」）
    check('labels:no-overlap', '任意两个标签的矩形**不相交**（逐对算相交面积，10 对全为 0）—— 同一区域里的标签是**沿路径错开**的，不是叠在一处',
      probe.pairs >= 10 && probe.worstOverlap === 0, JSON.stringify({ pairs: probe.pairs, worstOverlap: probe.worstOverlap }));

    // ⑤ 不透明底（看得清不靠「卡把它挡住」）
    check('labels:opaque-background', '每个标签都有**不透明底**：`.dz-arrow-label-bg` 的 computed fill 不是 none/透明，且 fill × fill-opacity 的 alpha == 1（5/5）',
      probe.backgroundFills.every((fill) => typeof fill === 'string' && fill.startsWith('rgb'))
      && probe.backgroundAlpha.every((alpha) => alpha === 1),
      JSON.stringify({ fills: probe.backgroundFills, alpha: probe.backgroundAlpha }));

    // 层序改正了 ⇒ 连线压在卡上，会不会把「卡头（切屏）」自己的点击抢走？（本单引入的风险，量一下）
    const middleScreen = built.screenIds[2];
    await clickSelector(`#dz-flow .dz-card[data-screen="${middleScreen}"] .dz-card-head`);
    await frames(3);
    const switched = await evalIn('(() => ({ screen: window.__dz.screenId(), form: document.querySelector("#dz-tform").hidden }))()');
    check('flow:card-head-still-clickable', '连线层压到屏卡之上以后，**屏卡自己的点击没被抢走**：点中间那张卡的头 ⇒ 当前屏真的切到它（而不是弹出转移表单）',
      switched.screen === middleScreen && switched.form === true, JSON.stringify({ switched, expected: middleScreen }));
    await clickSelector(`#dz-flow .dz-card[data-screen="${built.screenIds[0]}"] .dz-card-head`);
    await frames(2);

    // ── ⑥ 导出件（`*.flow.svg`）走同一条规则：把它插回页面里当场量 ────────────────────────────
    const exported = await evalIn(`(async () => {
      const before = window.__downloads.length;
      document.querySelector('#dz-export-toggle').click();
      document.querySelector('#dz-export-items [data-export="flow"]').click();
      const deadline = Date.now() + 8000;
      while (window.__downloads.length <= before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
      const entry = window.__downloads[window.__downloads.length - 1] || null;
      if (!entry) return { ok: false, reason: '导出转移图没有发出下载', downloads: window.__downloads.length - before };
      const text = new TextDecoder().decode(new Uint8Array(await (await fetch(entry.href)).arrayBuffer()));
      const host = document.createElement('div');
      host.id = 'dz-flow-export-probe';
      host.setAttribute('style', 'position:fixed;left:0;top:0;z-index:99;background:#000;');
      host.innerHTML = text;
      document.body.appendChild(host);
      return { ok: true, name: entry.download, bytes: text.length, last: window.__dz.lastExport() };
    })()`);
    await frames(3);
    await shot('51-flow-export-sample');
    const exportProbe = await evalIn(`(() => {
      const host = document.querySelector('#dz-flow-export-probe');
      if (!host) return { mounted: false };
      const svg = host.querySelector('svg');
      if (!svg) return { mounted: true, svg: false };
      const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const alphaOf = (value) => {
        const match = /rgba?\\(([^)]+)\\)/.exec(value || '');
        if (!match) return value === 'none' ? 0 : 1;
        const parts = match[1].split(',');
        return parts.length === 4 ? Number(parts[3]) : 1;
      };
      const svgRect = svg.getBoundingClientRect();
      const paths = [...svg.querySelectorAll('path[data-transition]')];
      const labels = [...svg.querySelectorAll('.designer-arrow-label')];
      const labelLayer = svg.querySelector('.dz-arrow-labels');
      const distanceToPath = (el, path) => {
        const r = el.getBoundingClientRect();
        const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const total = path.getTotalLength();
        let best = Infinity;
        for (let i = 0; i <= 200; i += 1) {
          const p = path.getPointAtLength((total * i) / 200);
          best = Math.min(best, Math.hypot(svgRect.left + p.x - center.x, svgRect.top + p.y - center.y));
        }
        return best;
      };
      let worstOverlap = 0;
      let pairs = 0;
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) {
          pairs += 1;
          worstOverlap = Math.max(worstOverlap, area(rectOf(labels[i]), rectOf(labels[j])));
        }
      }
      const backgrounds = labels.map((label) => label.querySelector('rect'));
      return {
        mounted: true, svg: true, paths: paths.length, labels: labels.length,
        labelIds: labels.map((label) => label.getAttribute('data-transition')),
        labelLayerIsLast: !!(labelLayer && svg.lastElementChild === labelLayer),
        labelsInsideLayer: labelLayer ? labels.every((label) => labelLayer.contains(label)) : false,
        distances: labels.map((label) => {
          const path = paths.find((p) => p.getAttribute('data-transition') === label.getAttribute('data-transition'));
          return { id: label.getAttribute('data-transition'), distance: path ? Math.round(distanceToPath(label, path) * 100) / 100 : null };
        }),
        worstOverlap: Math.round(worstOverlap * 100) / 100, pairs,
        backgroundFills: backgrounds.map((el) => (el ? getComputedStyle(el).fill : null)),
        backgroundAlpha: backgrounds.map((el) => (el ? Math.round(alphaOf(getComputedStyle(el).fill) * Number(getComputedStyle(el).fillOpacity) * 1000) / 1000 : 0)),
      };
    })()`);
    await evalIn(`(() => { const host = document.querySelector('#dz-flow-export-probe'); if (host) host.remove(); return true; })()`);

    const exportWorst = Math.max(...(exportProbe.distances ?? []).map((entry) => (entry.distance === null ? Infinity : entry.distance)));
    check('flowlabel:export-sample', '「导出 ▾ → 转移图」那份 `*.flow.svg`：真的发了一次下载（文件名 `design-flow-<时间戳>.flow.svg`）／插回页面里 5 条路径 ＋ 5 个标签（`data-transition` 逐个就是那 5 条转移）／标签单独一层且是 SVG 的**最后一个**子节点（⇒ 标签压在连线上）',
      exported.ok === true && /^design-flow-\d{8}-\d{6}\.flow\.svg$/.test(exported.name ?? '')
      && exportProbe.paths === 5 && exportProbe.labels === 5 && exportProbe.labelLayerIsLast && exportProbe.labelsInsideLayer
      && JSON.stringify([...exportProbe.labelIds].sort()) === JSON.stringify(transitionSet),
      JSON.stringify({ exported, paths: exportProbe.paths, labels: exportProbe.labels, layerLast: exportProbe.labelLayerIsLast, ids: exportProbe.labelIds }));

    check('flowlabel:on-own-path', `导出的转移图里，每个标签也贴在**它自己那条线**上（同一条规则：中心到路径 ≤ ${LABEL_MAX_PX}px，实测最大 ${exportWorst}）`,
      (exportProbe.labels ?? 0) === 5 && (exportProbe.distances ?? []).every((entry) => entry.distance !== null && entry.distance <= LABEL_MAX_PX),
      JSON.stringify({ max: exportWorst, each: exportProbe.distances }));

    check('flowlabel:no-overlap', '导出的转移图里任意两个标签的矩形也**不相交**（逐对相交面积为 0）—— 两条端点完全相同的转移在导出件里也不叠',
      (exportProbe.pairs ?? 0) >= 10 && exportProbe.worstOverlap === 0,
      JSON.stringify({ pairs: exportProbe.pairs, worstOverlap: exportProbe.worstOverlap }));

    check('flowlabel:opaque-background', '导出的转移图里每个标签也有**不透明底**（`<rect>` 的 computed fill alpha == 1）',
      (exportProbe.backgroundFills ?? []).length === 5 && exportProbe.backgroundFills.every((fill) => typeof fill === 'string' && fill.startsWith('rgb'))
      && exportProbe.backgroundAlpha.every((alpha) => alpha === 1),
      JSON.stringify({ fills: exportProbe.backgroundFills, alpha: exportProbe.backgroundAlpha }));

    await clickSelector('#dz-view-edit');
    await frames(2);
  });

  // ═══ 17.9 流程画布的**自由缩放**（业主 2026-09-26：滚轮直接放大 / 缩小）══════════════════
  //
  // 业主逐字：「设计器页面 流程/箭头页面 中间的部分我希望改成可以**自由缩放**的画布，可以不用拖动
  // 元素，但是可以通过**滚轮直接放大缩小**」。
  //
  // 这一组量的是：① 滚轮**真的**改缩放（真 `Input.dispatchMouseEvent` type=mouseWheel，不是调内部函数）；
  //   ② 缩放是**纯视图变换**：文档字节一字不动、卡片层的**布局**（offsetLeft/offsetTop/offsetWidth）
  //      在三个档位下一字不变，变的只有实测矩形（= 视觉）；
  //   ③ 同一套不变量在 50% / 100% / 200% 三档下**同样成立**：
  //      标签贴在**自己那条线**上（上界按缩放放大）、任意两标签**不相交**、连线仍压在屏卡**之上**（层序）、
  //      屏卡实测宽按同一比例放大；
  //   ④ 缩放态下**命中测试**跟着走：点箭头（按路径上真点 ＋ `elementFromPoint`）打开的是**那一条**转移、
  //      点屏卡头仍然切屏（缩放没把点击目标弄丢）；
  //   ⑤ 上限 / 下限被夹住（[25%, 400%]）、「重置」回到**正好** 100%。
  // 反证臂：`zoom-mutates-model`（把施加变换那一行改成往文档里写键 ⇒ ①②必红）／
  //         `zoom-labels-ignore`（标签度量不跟缩放 ⇒ 50% 档下③必红）。
  const ZOOM_MIN = 0.25; // 与 web/designer.js 的 FLOW_ZOOM_MIN 同值
  const ZOOM_MAX = 4;    // 与 web/designer.js 的 FLOW_ZOOM_MAX 同值
  await evalIn(`window.__dzFlowZoomProbe = () => {
    const svg = document.querySelector('#dz-arrows');
    const cardsEl = document.querySelector('#dz-flow-cards');
    const level = document.querySelector('#dz-flow-zoom-level');
    const cards = [...document.querySelectorAll('#dz-flow .dz-card')];
    const paths = [...document.querySelectorAll('#dz-arrows .dz-arrow-path')];
    const labels = [...document.querySelectorAll('#dz-arrows .dz-arrow-label')];
    const lines = document.querySelector('#dz-arrows .dz-arrow-lines');
    const labelLayer = document.querySelector('#dz-arrows .dz-arrow-labels');
    const svgRect = svg.getBoundingClientRect();
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const distanceToPath = (el, path) => { const c = centerOf(el); const total = path.getTotalLength(); let best = Infinity; for (let i = 0; i <= 200; i += 1) { const p = path.getPointAtLength((total * i) / 200); best = Math.min(best, Math.hypot(svgRect.left + p.x - c.x, svgRect.top + p.y - c.y)); } return best; };
    let onCard = 0; let covered = 0; let offscreen = 0; const offenders = [];
    for (const path of paths) {
      const total = path.getTotalLength();
      for (let i = 1; i < 24; i += 1) {
        const p = path.getPointAtLength((total * i) / 24);
        const x = svgRect.left + p.x; const y = svgRect.top + p.y;
        const inside = cards.some((card) => { const r = card.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
        if (!inside) continue;
        onCard += 1;
        if (x < 1 || y < 1 || x >= window.innerWidth - 1 || y >= window.innerHeight - 1) { offscreen += 1; continue; }
        const hit = document.elementFromPoint(x, y);
        if (hit && !hit.closest('.dz-card')) continue;
        covered += 1;
        if (offenders.length < 3) offenders.push({ arrow: path.dataset.arrow ?? null, x: Math.round(x), y: Math.round(y), hit: hit ? hit.tagName : null });
      }
    }
    let worstOverlap = 0; let pairs = 0;
    for (let i = 0; i < labels.length; i += 1) { for (let j = i + 1; j < labels.length; j += 1) { pairs += 1; worstOverlap = Math.max(worstOverlap, area(rectOf(labels[i]), rectOf(labels[j]))); } }
    const firstCard = rectOf(cards[0]);
    return {
      scale: Number(level.dataset.zoom), text: level.textContent,
      cards: cards.length, paths: paths.length, labels: labels.length,
      cardW: Math.round(firstCard.w * 100) / 100,
      cardTopFromSvg: Math.round((firstCard.y - svgRect.top) * 100) / 100,
      cardsOffsetW: cardsEl.offsetWidth, cardsOffsetH: cardsEl.offsetHeight,
      cardOffsets: cards.map((c) => c.offsetLeft + ',' + c.offsetTop).join('|'),
      onCard, covered, offscreen, offenders,
      ownPath: labels.map((l) => { const own = paths.find((p) => p.dataset.arrow === l.dataset.arrow); return { id: l.dataset.arrow ?? null, distance: own ? Math.round(distanceToPath(l, own) * 100) / 100 : null }; }),
      worstOverlap: Math.round(worstOverlap * 100) / 100, pairs,
      zCards: getComputedStyle(cardsEl).zIndex, zArrows: getComputedStyle(svg).zIndex,
      linesBeforeLabels: !!(lines && labelLayer && (lines.compareDocumentPosition(labelLayer) & Node.DOCUMENT_POSITION_FOLLOWING)),
      docBytes: window.sophoDesigner.exportDoc(),
      docJson: JSON.stringify(window.sophoDesigner.getDoc()),
    };
  }`);
  const flowZoomProbe = () => evalIn('window.__dzFlowZoomProbe()');

  await groupCheck('flow-zoom', async () => {
    // ── 自建一张**够挤**的样张（两条端点完全相同 ＋ 一条跨卡 ＋ 一条自环），走 API（与鼠标同一条提交路径）
    await clickSelector('#dz-new');
    await frames(2);
    const shape = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const firstState = (id) => (api.getDoc().screens.find((s) => s.id === id).states[0] || {}).id;
      const A = api.getDoc().screens[0].id;
      const A1 = firstState(A);
      const B = api.addScreen('屏 B').screenId;
      const C = api.addScreen('屏 C').screenId;
      const D = api.addScreen('屏 D').screenId;
      const b1 = firstState(B); const c1 = firstState(C); const d1 = firstState(D);
      api.openScreen(A);
      const a2 = api.addState(A, '加载中').stateId;
      api.openScreen(A);
      const add = (from, to, trigger) => api.addTransition({ from, to, trigger }).id;
      const ids = [
        add({ screen: A, state: A1 }, { screen: B, state: b1 }, '点提交'),
        add({ screen: A, state: A1 }, { screen: B, state: b1 }, '快捷键'),
        add({ screen: A, state: A1 }, { screen: C, state: c1 }, '去设置'),
        add({ screen: D, state: d1 }, { screen: B, state: b1 }, '返回'),
        add({ screen: A, state: A1 }, { screen: A, state: a2 }, '首屏请求发出'),
      ];
      api.setView('flow');
      return { ids, screens: api.getDoc().screens.length, transitions: api.getDoc().transitions.length, statesOfA: api.getDoc().screens.find((s) => s.id === A).states.length };
    })()`);
    await frames(8);

    // 三个档位：滚轮**真事件** —— 先重置到 100%，再滚到目标。
    // `deltaY = -ln(target) / 灵敏度`（灵敏度 0.002，与实现同值）⇒ 一步正好到目标（不靠多次逼近、不靠内部函数）。
    const setZoomViaWheel = async (target) => {
      await clickSelector('#dz-flow-zoom-reset');
      await frames(2);
      const pane = await box('#dz-flow');
      await mouse('mouseWheel', pane.cx, pane.cy, { deltaX: 0, deltaY: -Math.log(target) / 0.002, button: 'none', buttons: 0 });
      await frames(4);
      return flowZoomProbe();
    };

    const p100 = await setZoomViaWheel(1);
    const p50 = await setZoomViaWheel(0.5);
    const p200 = await setZoomViaWheel(2);

    check('zoom:sample', '缩放样张：4 屏（A 有两个状态）／5 条转移（两条**端点完全相同** ＋ 一条跨卡 ＋ 一条自环）⇒ 画布上 4 张卡 / 5 根线 / 5 个标签（10 对标签）',
      shape.screens === 4 && shape.transitions === 5 && shape.statesOfA === 2
      && p100.cards === 4 && p100.paths === 5 && p100.labels === 5 && p100.pairs === 10,
      JSON.stringify({ shape, cards: p100.cards, paths: p100.paths, labels: p100.labels, pairs: p100.pairs }));

    check('zoom:wheel-scales', '滚轮**真的**改缩放（真 mouseWheel 事件）：三档读数就是 50% / 100% / 200%（`#dz-flow-zoom-level` 的 data-zoom 与显示文字同步）',
      Math.abs(p50.scale - 0.5) < 1e-3 && Math.abs(p100.scale - 1) < 1e-3 && Math.abs(p200.scale - 2) < 1e-3
      && p50.text === '50%' && p100.text === '100%' && p200.text === '200%',
      JSON.stringify({ scales: [p50.scale, p100.scale, p200.scale], texts: [p50.text, p100.text, p200.text] }));

    // ② 纯视图变换：布局（offsetLeft/offsetTop/offsetWidth/Height）与文档字节在三档下一字不变
    check('zoom:pure-view', '缩放**不碰布局、不碰文档**：`.dz-flow-cards` 的 offsetWidth/offsetHeight、每张卡的 offsetLeft,offsetTop、'
      + '以及 `exportDoc()` 的字节与 `getDoc()` 的 JSON，在 50% / 100% / 200% 三档下**逐字相同**（变的只有实测矩形 = 视觉）',
      p50.cardsOffsetW === p100.cardsOffsetW && p50.cardsOffsetH === p100.cardsOffsetH
      && p200.cardsOffsetW === p100.cardsOffsetW && p200.cardsOffsetH === p100.cardsOffsetH
      && p50.cardOffsets === p100.cardOffsets && p200.cardOffsets === p100.cardOffsets
      && p50.docBytes === p100.docBytes && p200.docBytes === p100.docBytes
      && p50.docJson === p100.docJson && p200.docJson === p100.docJson,
      JSON.stringify({ offsetW: [p50.cardsOffsetW, p100.cardsOffsetW, p200.cardsOffsetW], offsetH: [p50.cardsOffsetH, p100.cardsOffsetH, p200.cardsOffsetH],
        cardOffsets: p100.cardOffsets, bytes: [p50.docBytes.length, p100.docBytes.length, p200.docBytes.length] }));

    // ③ 同一套不变量 × 三个档位
    const tiers = [['zoom:invariants-50', 0.5, p50], ['zoom:invariants-100', 1, p100], ['zoom:invariants-200', 2, p200]];
    for (const [id, z, p] of tiers) {
      const bound = LABEL_MAX_PX * z + 1; // 标签度量按 z 放大 ⇒ 上界也按 z 放大（+1 采样余量）
      const offPath = (p.ownPath ?? []).filter((entry) => entry.distance === null || entry.distance > bound);
      const cardRatio = p.cardW / p100.cardW;
      check(id, `${Math.round(z * 100)}% 档下**同一套不变量同样成立**：标签都贴在**自己那条线**上（上界 ${Math.round(bound * 100) / 100}px）、`
        + '任意两标签**不相交**、连线仍压在屏卡**之上**（层序）、屏卡实测宽按同一比例放大',
        offPath.length === 0 && p.worstOverlap === 0 && p.pairs === 10
        && Number(p.zArrows) > Number(p.zCards) && p.linesBeforeLabels && p.covered === 0 && p.onCard - p.offscreen >= 1
        && Math.abs(cardRatio - z) < 0.02,
        JSON.stringify({ z, scale: p.scale, bound, offPath, onOwn: p.ownPath, worstOverlap: p.worstOverlap, pairs: p.pairs,
          onCard: p.onCard, testable: p.onCard - p.offscreen, offscreen: p.offscreen, covered: p.covered, offenders: p.offenders,
          zCards: p.zCards, zArrows: p.zArrows, cardW: p.cardW, cardRatio: Math.round(cardRatio * 1000) / 1000 }));
    }

    // ④ 缩放态（200%，最后 setZoomViaWheel 停在 2）下**命中测试**跟着走
    const hitPoint = await evalIn(`(() => {
      const svg = document.querySelector('#dz-arrows');
      const base = svg.getBoundingClientRect();
      for (const path of document.querySelectorAll('#dz-arrows .dz-arrow-path')) {
        const total = path.getTotalLength();
        for (const t of [0.5, 0.44, 0.56, 0.38, 0.62, 0.3, 0.7, 0.25, 0.75]) {
          const p = path.getPointAtLength(total * t);
          const x = base.left + p.x; const y = base.top + p.y;
          if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) continue;
          const owner = document.elementFromPoint(x, y)?.closest?.('[data-arrow]') ?? null;
          if (owner) return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, id: owner.getAttribute('data-arrow'), scale: Number(document.querySelector('#dz-flow-zoom-level').dataset.zoom) };
        }
      }
      return null;
    })()`);
    check('zoom:hit-arrow', '200% 档下箭头上找得到一个**视口内**的真点（`getPointAtLength` ＋ `elementFromPoint` 命中的就是那根箭头；坐标就是屏幕坐标 —— 缩放没改变这条口径）',
      hitPoint !== null && Math.abs(hitPoint.scale - 2) < 1e-3, JSON.stringify({ hitPoint }));
    if (hitPoint) {
      await clickPoint({ x: hitPoint.x, y: hitPoint.y });
      await frames(3);
      const opened = await evalIn(`(() => ({ hidden: document.querySelector('#dz-tform').hidden, mode: document.querySelector('#dz-tform').dataset.mode ?? null, title: document.querySelector('#dz-tform-title').textContent }))()`);
      check('zoom:hit-test-arrow', '**缩放态（200%）下命中测试跟着走**：按箭头路径上的一个真点（真鼠标）点下去 ⇒ 打开的是**那一条**转移的表单（不是 100% 时那个位置）',
        opened.hidden === false && opened.mode === 'edit' && opened.title.includes(hitPoint.id),
        JSON.stringify({ hitPoint, opened }));
      await clickSelector('#dz-tform-cancel');
      await frames(2);
    }

    // ④b 缩放态下点屏卡头仍然切屏（选一张**不是当前屏**、且在视口内的卡）
    const headTarget = await evalIn(`(() => {
      const pane = document.querySelector('#dz-flow').getBoundingClientRect();
      const current = window.__dz.screenId();
      for (const head of document.querySelectorAll('#dz-flow .dz-card-head')) {
        const screen = head.closest('.dz-card').dataset.screen;
        if (screen === current) continue;
        const r = head.getBoundingClientRect();
        const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
        if (cx > pane.left + 2 && cx < pane.right - 2 && cy > pane.top + 2 && cy < pane.bottom - 2 && cx > 1 && cy > 1 && cx < window.innerWidth - 1 && cy < window.innerHeight - 1) {
          return { x: Math.round(cx * 100) / 100, y: Math.round(cy * 100) / 100, screen, scale: Number(document.querySelector('#dz-flow-zoom-level').dataset.zoom) };
        }
      }
      return null;
    })()`);
    check('zoom:hit-card', '200% 档下找得到一张**视口内、且不是当前屏**的屏卡头（缩放后卡片更大、更容易滚出视口，这里如实挑一张看得见的）',
      headTarget !== null && Math.abs(headTarget.scale - 2) < 1e-3, JSON.stringify({ headTarget }));
    if (headTarget) {
      await clickPoint({ x: headTarget.x, y: headTarget.y });
      await frames(3);
      const afterScreen = await evalIn('window.__dz.screenId()');
      check('zoom:hit-test-card', '**缩放态（200%）下点屏卡头仍然切屏**：点在视口内那张卡的头上 ⇒ 当前屏切到它（缩放没把点击目标弄丢、也没被连线层抢走）',
        afterScreen === headTarget.screen, JSON.stringify({ headTarget, afterScreen }));
    }

    // ⑤ 夹在 [25%, 400%]；「重置」回到**正好** 100%
    const pane = await box('#dz-flow');
    for (let i = 0; i < 40; i += 1) await mouse('mouseWheel', pane.cx, pane.cy, { deltaX: 0, deltaY: -200, button: 'none', buttons: 0 });
    await frames(4);
    const clampedHigh = await flowZoomProbe();
    for (let i = 0; i < 80; i += 1) await mouse('mouseWheel', pane.cx, pane.cy, { deltaX: 0, deltaY: 200, button: 'none', buttons: 0 });
    await frames(4);
    const clampedLow = await flowZoomProbe();
    check('zoom:clamp', `缩放被夹在 [${ZOOM_MIN * 100}%, ${ZOOM_MAX * 100}%]：连滚 40 次放大不超过上限、再连滚 80 次缩小不低于下限`,
      Math.abs(clampedHigh.scale - ZOOM_MAX) < 1e-6 && Math.abs(clampedLow.scale - ZOOM_MIN) < 1e-6,
      JSON.stringify({ high: clampedHigh.scale, low: clampedLow.scale }));

    await clickSelector('#dz-flow-zoom-reset');
    await frames(3);
    const reset = await flowZoomProbe();
    check('zoom:reset-100', '「重置」回到**正好** 100%：读数 == 1、屏卡实测宽回到基线（缩放是视图，不是把卡片改小了）、文档字节也回到基线',
      reset.scale === 1 && Math.abs(reset.cardW - p100.cardW) < 0.5 && reset.docBytes === p100.docBytes,
      JSON.stringify({ scale: reset.scale, cardW: reset.cardW, baseline: p100.cardW, bytes: reset.docBytes.length }));

    // 静态：视图变换（**缩放与平移**）只有**一个**施加点 ＋ `scrollbar-gutter: stable`（纯视图缩放的前提）
    // 2026-09-27 按新事实**收紧**：`translate(...)` 与 `scale(...)` 必须写在**同一行**施加点上（不是两处各算一套），
    // 且两者都从唯一来源 `viewTransform` 取；三条接缝（`view-zoom` / `view-pan` / `zoom-labels`）都在。
    const zoomSource = await readFile(path.join(root, 'web', 'designer.js'), 'utf8');
    const transformWrites = [...zoomSource.matchAll(/node\.flowCards\.style\.transform = `([^`]*)`/g)].map((match) => match[1]);
    const singleWrite = transformWrites[0] ?? '';
    const panSeamCount = (zoomSource.match(/\[SEAM:view-pan\]/g) ?? []).length;
    check('zoom:single-source', '缩放与平移共用**同一个施加点**：源码里 `node.flowCards.style.transform = ` 的模板串只出现**一次**，'
      + '且那一行同时带上 `translate(${viewTransform.x}px, ${viewTransform.y}px)` 与 `scale(${viewTransform.scale})`（两者都从唯一来源 `viewTransform` 取）；'
      + '三条接缝都在（`[SEAM:view-zoom]` / `[SEAM:view-pan]` / `[SEAM:zoom-labels]`）',
      transformWrites.length === 1 && singleWrite.includes('translate(${viewTransform.x}px, ${viewTransform.y}px)')
      && singleWrite.includes('scale(${viewTransform.scale})') && panSeamCount >= 2
      && zoomSource.includes('[SEAM:view-zoom]') && zoomSource.includes('[SEAM:zoom-labels]'),
      JSON.stringify({ transformWrites, panSeamCount }));
    const zoomCss = await readFile(path.join(root, 'web', 'designer.css'), 'utf8');
    check('zoom:stable-gutter', '`.dz-flow` 有 `scrollbar-gutter: stable`（滚动条出现/消失不改内容宽 ⇒ 缩放是纯视图变换、不是「换行跟着滚轮变」）',
      /\.dz-flow\s*\{[^}]*scrollbar-gutter:\s*stable/.test(zoomCss), JSON.stringify({ stable: /scrollbar-gutter:\s*stable/.test(zoomCss) }));

    // 收摊：回到 100%、回到编辑视图（不让后面那条「零异常」被缩放态影响）
    await clickSelector('#dz-flow-zoom-reset');
    await clickSelector('#dz-view-edit');
    await frames(2);
  });

  // ═══ 17c. 流程画布：**点击拖动平移**（与缩放共用同一条纯视图变换）═════════════════════════════
  //
  // 业主 2026-09-27 逐字：「现在有缩放了，但是没有对应的**点击滑动**，请补上」。
  //
  // 这一组全部走**真鼠标事件**（`Input.dispatchMouseEvent` 的 mousePressed / mouseMoved / mouseReleased
  // ＋ mouseWheel），并且用的是 `window.__dzFlowZoomProbe()`（与 `flow-zoom` 组**同一套几何读数**）：
  //   ① 在**空白画布**上按住左键拖动 ⇒ 画布真的按拖动像素平移（卡片实测矩形位移 == 拖动位移），
  //      而**布局与文档一个字节不动**（与 `zoom:pure-view` 同口径）；
  //   ② 平移之后**同一套几何不变量**仍成立（标签贴自己那条线 / 两两不相交 / 连线压在卡上）；
  //   ③ **命中测试跟着平移走**：平移前看到的那根箭头 / 那张卡头，在**新位置**按真点 ⇒
  //      打开的是**那一条**转移 / 切到**那一个**屏；
  //   ④ **平移＋缩放叠加不串味**：「先平移再缩放」与「先缩放再平移」拿到**同一张图**，
  //      且都等于解析式 `B + (x,y) + s·(p−O)`（O = SVG 原点）—— 50% / 200% 两档；
  //   ⑤ 拖到很偏的地方再拖回来 ⇒ 矩阵 / 定点 / 档位 / 文档字节**逐字回到基线**（不许漂）；
  //   ⑥ 起点落在卡片头 / 箭头上时**不抢**它们原有的交互（拖动不改视图、不开表单、不切屏）。
  // 反证臂：`pan-ignored`（把唯一那行施加点的 `translate(...)` 那一半摘掉 ⇒ ①②③④必红、②的
  //   `pan:pure-view` 留绿）。
  await groupCheck('flow-pan', async () => {
    const r2 = (n) => Math.round(n * 100) / 100;
    // 视图读数：变换矩阵（`getComputedStyle` 的实算值）＋ 定点 ＋ 首卡实测矩形 ＋ 档位 ＋ 平移来源。
    const viewProbe = () => evalIn(`(() => {
      const cards = document.querySelector('#dz-flow-cards');
      const first = document.querySelector('#dz-flow .dz-card');
      const fr = first.getBoundingClientRect();
      const sr = document.querySelector('#dz-arrows').getBoundingClientRect();
      const level = document.querySelector('#dz-flow-zoom-level');
      const r = (n) => Math.round(n * 100) / 100;
      return { matrix: getComputedStyle(cards).transform, origin: cards.style.transformOrigin, inline: cards.style.transform,
        card: { x: r(fr.left), y: r(fr.top), w: r(fr.width) }, svg: { x: r(sr.left), y: r(sr.top) },
        scale: Number(level.dataset.zoom), zoomText: level.textContent, pan: window.__dz.viewPan() };
    })()`);
    // 空白画布上的一个真点（`elementFromPoint` 确认那里不是卡片 / 箭头 / 标签 / 流程栏）；
    // `(dx,dy)` 是接下来要拖的位移 ⇒ 落点也必须留在窗口里（否则位移被夹，往返就不对称了）。
    const emptyPoint = (dx = 0, dy = 0) => evalIn(`(() => {
      const flow = document.querySelector('#dz-flow');
      const r = flow.getBoundingClientRect();
      const W = window.innerWidth; const H = window.innerHeight;
      const blocked = (el) => !!el.closest('.dz-card, .dz-arrow-hit, .dz-arrow-label, .dz-flow-bar');
      for (let y = Math.round(r.top + 30); y < r.bottom - 16; y += 20) {
        for (let x = Math.round(r.left + 16); x < r.right - 16; x += 20) {
          if (x < 2 || y < 2 || x > W - 2 || y > H - 2) continue;
          if (x + ${dx} < 2 || y + ${dy} < 2 || x + ${dx} > W - 2 || y + ${dy} > H - 2) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit && hit.closest('#dz-flow') && !blocked(hit)) return { x, y, hit: hit.id || hit.className };
        }
      }
      return null;
    })()`);
    // 从**空白处**按住左键拖 (dx,dy)（真三段鼠标事件）—— 落点由上面扫出的起点保证在窗口里。
    const dragPan = async (dx, dy) => {
      const from = await emptyPoint(dx, dy);
      if (!from) throw new Error(`空白画布上找不到起点（dx=${dx} dy=${dy}）`);
      const to = { x: from.x + dx, y: from.y + dy };
      await dragPoints({ x: from.x, y: from.y }, to, { steps: 8 });
      await frames(3);
      return { from, to, dx, dy };
    };
    // 真滚轮事件换档（`deltaY = -ln(target)/灵敏度`，一步正好到目标；不调内部函数）。
    const wheelTo = async (target) => {
      const pane = await box('#dz-flow');
      await mouse('mouseWheel', pane.cx, pane.cy, { deltaX: 0, deltaY: -Math.log(target) / 0.002, button: 'none', buttons: 0 });
      await frames(3);
    };
    // 箭头上一个**真点**（`getPointAtLength` ＋ `elementFromPoint` 命中的就是那根箭头）。
    const findArrowPoint = () => evalIn(`(() => {
      const base = document.querySelector('#dz-arrows').getBoundingClientRect();
      for (const path of document.querySelectorAll('#dz-arrows .dz-arrow-path')) {
        const total = path.getTotalLength();
        for (const t of [0.5, 0.44, 0.56, 0.38, 0.62, 0.3, 0.7, 0.25, 0.75]) {
          const p = path.getPointAtLength(total * t);
          const x = base.left + p.x; const y = base.top + p.y;
          if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) continue;
          const owner = document.elementFromPoint(x, y)?.closest?.('[data-arrow]') ?? null;
          if (owner) return { x: Math.round(x), y: Math.round(y), id: owner.getAttribute('data-arrow') };
        }
      }
      return null;
    })()`);

    await clickSelector('#dz-view-flow');
    await clickSelector('#dz-flow-zoom-reset');
    await frames(4);
    const base = await viewProbe();
    const baseProbe = await flowZoomProbe();
    check('pan:baseline', '基线：100%、未平移时变换矩阵是**恒等**（`matrix(1, 0, 0, 1, 0, 0)`），且 `flow-zoom` 组那份拥挤样张（4 张卡 / 5 根线 / 5 个标签）还在',
      base.matrix === 'matrix(1, 0, 0, 1, 0, 0)' && base.scale === 1 && base.zoomText === '100%'
      && baseProbe.cards === 4 && baseProbe.paths === 5 && baseProbe.labels === 5,
      JSON.stringify({ matrix: base.matrix, scale: base.scale, cards: baseProbe.cards, paths: baseProbe.paths, labels: baseProbe.labels }));

    // ① 空白画布上按住左键拖动 ⇒ 画布真的按拖动像素平移
    const drag1 = await dragPan(120, 80);
    const moved = await viewProbe();
    const movedProbe = await flowZoomProbe();
    check('pan:drag-moves-canvas', '在**空白画布**上按住左键拖动（真 `mousePressed`/`mouseMoved`/`mouseReleased`，起点经 `elementFromPoint` 确认是空白）⇒ 画布真的平移：'
      + '首卡实测矩形位移 **== 拖动位移**（±0.6px）、档位读数仍是 100%、变换矩阵就是那次位移',
      Math.abs(moved.card.x - base.card.x - drag1.dx) < 0.6 && Math.abs(moved.card.y - base.card.y - drag1.dy) < 0.6
      && moved.pan.x === drag1.dx && moved.pan.y === drag1.dy && moved.scale === 1
      && moved.matrix === `matrix(1, 0, 0, 1, ${drag1.dx}, ${drag1.dy})`,
      JSON.stringify({ startHit: drag1.from.hit, drag: { dx: drag1.dx, dy: drag1.dy }, baseCard: base.card, movedCard: moved.card, pan: moved.pan, matrix: moved.matrix }));

    // ①b 纯视图：平移**不碰布局、不碰文档**（与 `zoom:pure-view` 同口径）
    check('pan:pure-view', '平移**不碰布局、不碰文档**：`.dz-flow-cards` 的 `offsetWidth/offsetHeight`、每张卡的 `offsetLeft,offsetTop`、`exportDoc()` 字节与 `getDoc()` JSON，'
      + '在「未平移」与「平移后」两态下**逐字相同**（变的只有实测矩形 = 视觉）',
      movedProbe.cardsOffsetW === baseProbe.cardsOffsetW && movedProbe.cardsOffsetH === baseProbe.cardsOffsetH
      && movedProbe.cardOffsets === baseProbe.cardOffsets
      && movedProbe.docBytes === baseProbe.docBytes && movedProbe.docJson === baseProbe.docJson,
      JSON.stringify({ offsetW: [baseProbe.cardsOffsetW, movedProbe.cardsOffsetW], offsetH: [baseProbe.cardsOffsetH, movedProbe.cardsOffsetH],
        cardOffsets: movedProbe.cardOffsets, bytes: [baseProbe.docBytes.length, movedProbe.docBytes.length] }));

    // ② 平移态下同一套几何不变量仍成立（100% 档：标签贴自己那条线、两两不相交、连线压在卡上）
    {
      const bound = LABEL_MAX_PX * 1 + 1;
      const offPath = (movedProbe.ownPath ?? []).filter((entry) => entry.distance === null || entry.distance > bound);
      check('pan:invariants', `平移后**同一套几何不变量**仍成立：标签都贴在**自己那条线**上（上界 ${bound}px）、任意两标签**不相交**（10 对）、`
        + '连线仍压在屏卡**之上**（层序）、屏卡实测宽不变',
        offPath.length === 0 && movedProbe.worstOverlap === 0 && movedProbe.pairs === 10
        && Number(movedProbe.zArrows) > Number(movedProbe.zCards) && movedProbe.linesBeforeLabels
        && movedProbe.covered === 0 && movedProbe.onCard - movedProbe.offscreen >= 1
        && Math.abs(movedProbe.cardW - baseProbe.cardW) < 0.02,
        JSON.stringify({ offPath, onOwn: movedProbe.ownPath, worstOverlap: movedProbe.worstOverlap, pairs: movedProbe.pairs, covered: movedProbe.covered,
          onCard: movedProbe.onCard, offscreen: movedProbe.offscreen, cardW: movedProbe.cardW, baseCardW: baseProbe.cardW }));
    }

    // ③a 命中测试跟着平移走（箭头）：平移**前**那个真点，平移到新位置后按下去还是同一根
    await clickSelector('#dz-flow-zoom-reset');
    await frames(3);
    const arrowHit = await findArrowPoint();
    // 平移方向按这个点相对画布四边的余量选（保证平移后的点仍在画布 / 视口里）
    const arrowPan = await evalIn(`(() => {
      const pane = document.querySelector('#dz-flow').getBoundingClientRect();
      const x = ${arrowHit?.x ?? 0}; const y = ${arrowHit?.y ?? 0};
      const dx = pane.right - x - 10 >= 120 ? 120 : (x - pane.left - 10 >= 120 ? -120 : 0);
      const dy = pane.bottom - y - 10 >= 80 ? 80 : (y - pane.top - 10 >= 80 ? -80 : 0);
      return { dx, dy };
    })()`);
    const drag2 = await dragPan(arrowPan.dx, arrowPan.dy);
    const arrowNow = await evalIn(`(() => {
      const at = (x, y) => document.elementFromPoint(x, y)?.closest?.('[data-arrow]')?.getAttribute('data-arrow') ?? null;
      return { after: at(${arrowHit?.x ?? 0} + ${drag2.dx}, ${arrowHit?.y ?? 0} + ${drag2.dy}), before: at(${arrowHit?.x ?? 0}, ${arrowHit?.y ?? 0}) };
    })()`);
    check('pan:hit-arrow', '**命中测试跟着平移走**：平移前箭头上那个真点（`elementFromPoint` 命中的就是那根箭头），平移后在**新位置**命中的还是**同一根**（平移没把点击目标弄丢、也没被别的东西抢走）',
      arrowHit !== null && arrowNow.after === arrowHit.id,
      JSON.stringify({ arrowHit, pan: { dx: drag2.dx, dy: drag2.dy }, arrowNow }));
    if (arrowHit && arrowNow.after === arrowHit.id) {
      await clickPoint({ x: arrowHit.x + drag2.dx, y: arrowHit.y + drag2.dy });
      await frames(3);
      const opened = await evalIn(`(() => ({ hidden: document.querySelector('#dz-tform').hidden, mode: document.querySelector('#dz-tform').dataset.mode ?? null, title: document.querySelector('#dz-tform-title').textContent }))()`);
      check('pan:hit-test-arrow', '**平移态下**按箭头（真鼠标，落在平移后的新位置）⇒ 打开的是**那一条**转移的表单（平移后命中测试仍然对得上）',
        opened.hidden === false && opened.mode === 'edit' && opened.title.includes(arrowHit.id),
        JSON.stringify({ arrowHit, pan: { dx: drag2.dx, dy: drag2.dy }, opened }));
      await clickSelector('#dz-tform-cancel');
      await frames(2);
    } else {
      check('pan:hit-test-arrow', '**平移态下**按箭头打开那一条转移的表单', false, JSON.stringify({ arrowHit, reason: '上一条没命中，按不下去' }));
    }

    // ③b 命中测试跟着平移走（屏卡头）：平移后在卡头的**新位置**按下 ⇒ 切到那一屏
    await clickSelector('#dz-flow-zoom-reset');
    await frames(3);
    // 挑一张**不是当前屏**且看得见的卡头，并给本次平移算出在画布内的方向（平移后仍在画布 / 视口里）
    const headBefore = await evalIn(`(() => {
      const pane = document.querySelector('#dz-flow').getBoundingClientRect();
      const current = window.__dz.screenId();
      for (const head of document.querySelectorAll('#dz-flow .dz-card-head')) {
        const screen = head.closest('.dz-card').dataset.screen;
        if (screen === current) continue;
        const r = head.getBoundingClientRect();
        const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
        if (cx < pane.left + 10 || cx > pane.right - 10 || cy < pane.top + 10 || cy > pane.bottom - 10) continue;
        const dx = pane.right - cx - 10 >= 120 ? 120 : (cx - pane.left - 10 >= 120 ? -120 : 0);
        const dy = pane.bottom - cy - 10 >= 80 ? 80 : (cy - pane.top - 10 >= 80 ? -80 : 0);
        if (dx !== 0 && dy !== 0) return { x: Math.round(cx), y: Math.round(cy), screen, dx, dy };
      }
      return null;
    })()`);
    const drag3 = await dragPan(headBefore?.dx ?? 120, headBefore?.dy ?? 80);
    const headNow = await evalIn(`(() => {
      const hit = document.elementFromPoint(${headBefore?.x ?? 0} + ${drag3.dx}, ${headBefore?.y ?? 0} + ${drag3.dy});
      const head = hit?.closest?.('.dz-card-head') ?? null;
      return { screen: head ? head.closest('.dz-card').dataset.screen : null, tag: hit ? hit.tagName : null };
    })()`);
    check('pan:hit-card', '**平移后卡头还在它挪到的位置上**：平移 120/80 后，在卡头的**新位置**按下命中 `.dz-card-head`（就是那一屏）—— 命中目标没跟着平移弄丢',
      headBefore !== null && headNow.screen === headBefore.screen,
      JSON.stringify({ headBefore, pan: { dx: drag3.dx, dy: drag3.dy }, headNow }));
    await clickPoint({ x: (headBefore?.x ?? 0) + drag3.dx, y: (headBefore?.y ?? 0) + drag3.dy });
    await frames(3);
    const afterScreen = await evalIn('window.__dz.screenId()');
    const afterCard = await viewProbe();
    check('pan:hit-test-card', '**平移态下点屏卡头仍然切屏**：点在卡头的**新位置** ⇒ 当前屏切到它（卡头的交互没被平移抢走）；并且切屏重渲染之后**平移仍在**（视图变换不是一次性渲染态）',
      headBefore !== null && afterScreen === headBefore.screen
      && Math.abs(afterCard.card.x - base.card.x - drag3.dx) < 0.6 && Math.abs(afterCard.card.y - base.card.y - drag3.dy) < 0.6,
      JSON.stringify({ headBefore, pan: { dx: drag3.dx, dy: drag3.dy }, afterScreen, afterCard: afterCard.card, baseCard: base.card }));

    // ④ 平移＋缩放叠加：两序同一张图，且都等于解析式 `B + (x,y) + s·(p−O)`
    for (const [id, tier] of [['pan:compose-50', 0.5], ['pan:compose-200', 2]]) {
      await clickSelector('#dz-flow-zoom-reset');
      await frames(3);
      const rest = await viewProbe();
      const a = await (async () => { const drag = await dragPan(120, 80); await wheelTo(tier); return { drag, got: await viewProbe() }; })();
      await clickSelector('#dz-flow-zoom-reset');
      await frames(3);
      await wheelTo(tier);
      const b = await (async () => { const drag = await dragPan(120, 80); return { drag, got: await viewProbe() }; })();
      const pred = {
        x: r2(rest.svg.x + a.drag.dx + tier * (rest.card.x - rest.svg.x)),
        y: r2(rest.svg.y + a.drag.dy + tier * (rest.card.y - rest.svg.y)),
        w: r2(tier * rest.card.w),
      };
      check(id, `**平移＋缩放叠加不串味**（${Math.round(tier * 100)}%）：先平移再缩放与先缩放再平移 ⇒ 首卡实测矩形是**同一张图**（±0.6px），`
        + '且都等于解析式 `B + (x,y) + s·(p−O)`（O = SVG 原点）；档位读数正好是那一档、两序的平移量都是那次拖动',
        Math.abs(a.got.card.x - b.got.card.x) < 0.6 && Math.abs(a.got.card.y - b.got.card.y) < 0.6
        && Math.abs(a.got.card.x - pred.x) < 0.6 && Math.abs(a.got.card.y - pred.y) < 0.6
        && Math.abs(b.got.card.x - pred.x) < 0.6 && Math.abs(b.got.card.y - pred.y) < 0.6
        && Math.abs(a.got.card.w - pred.w) < 0.6 && Math.abs(b.got.card.w - pred.w) < 0.6
        && Math.abs(a.got.scale - tier) < 1e-3 && Math.abs(b.got.scale - tier) < 1e-3
        && a.got.zoomText === `${Math.round(tier * 100)}%` && b.got.zoomText === a.got.zoomText
        && a.got.pan.x === a.drag.dx && b.got.pan.x === b.drag.dx && a.got.pan.y === a.drag.dy,
        JSON.stringify({ tier, restCard: rest.card, restSvg: rest.svg, dragA: { dx: a.drag.dx, dy: a.drag.dy }, dragB: { dx: b.drag.dx, dy: b.drag.dy },
          A: a.got.card, B: b.got.card, pred, scales: [a.got.scale, b.got.scale], zoomText: [a.got.zoomText, b.got.zoomText] }));
    }

    // ⑤ 拖到很偏的地方再拖回来 ⇒ 矩阵 / 定点 / 档位 / 文档字节逐字回到基线（不许漂）
    await clickSelector('#dz-flow-zoom-reset');
    await frames(3);
    const driftBase = await viewProbe();
    const driftBytes = await evalIn('window.sophoDesigner.exportDoc()');
    let far = driftBase.card;
    for (let i = 0; i < 3; i += 1) { await dragPan(160, 100); far = (await viewProbe()).card; }
    const farMoved = Math.abs(far.x - driftBase.card.x) + Math.abs(far.y - driftBase.card.y);
    for (let i = 0; i < 3; i += 1) await dragPan(-160, -100);
    const back = await viewProbe();
    const backBytes = await evalIn('window.sophoDesigner.exportDoc()');
    check('pan:no-drift', '**拖到很偏的地方再拖回来**：连拖三次（≈480/300px；中途实测确实走远 >400px）再反向拖三次 ⇒ 变换矩阵 / `transform-origin` / 首卡实测矩形 / 档位读数 / `exportDoc()` 字节**逐字回到基线**（不许漂）',
      farMoved > 400 && back.matrix === driftBase.matrix && back.origin === driftBase.origin
      && Math.abs(back.card.x - driftBase.card.x) < 0.01 && Math.abs(back.card.y - driftBase.card.y) < 0.01
      && back.scale === 1 && backBytes === driftBytes,
      JSON.stringify({ farMoved, baseMatrix: driftBase.matrix, backMatrix: back.matrix, baseOrigin: driftBase.origin, backOrigin: back.origin,
        baseCard: driftBase.card, backCard: back.card, bytes: [driftBytes.length, backBytes.length] }));

    // ⑥ 起点落在卡片头 / 箭头上时**不抢**它们原有的交互（拖动不改视图）
    await clickSelector('#dz-flow-zoom-reset');
    await frames(3);
    const blockBase = await viewProbe();
    const blockScreen = await evalIn('window.__dz.screenId()');
    const blockBytes = await evalIn('window.sophoDesigner.exportDoc()');
    const blockHead = await evalIn(`(() => {
      const head = document.querySelector('#dz-flow .dz-card-head');
      const r = head.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const blockArrow = await findArrowPoint();
    if (!blockArrow) throw new Error('pan:blocked-start：画布上找不到箭头的真点（前提不成立）');
    const dragHead = await dragPoints(blockHead, { x: blockHead.x + 70, y: blockHead.y + 50 }, { steps: 6 }).then(() => viewProbe());
    const dragArrow = await dragPoints({ x: blockArrow.x, y: blockArrow.y }, { x: blockArrow.x + 70, y: blockArrow.y + 50 }, { steps: 6 }).then(() => viewProbe());
    const blockAfter = await evalIn(`(() => ({ screen: window.__dz.screenId(), formHidden: document.querySelector('#dz-tform').hidden, bytes: window.sophoDesigner.exportDoc() }))()`);
    check('pan:blocked-start', '起点落在**卡片头 / 箭头**上时**不抢**它们原有的交互：从卡头拖动 ⇒ 视图不动（矩阵还是恒等）、屏也没切；从箭头拖动 ⇒ 视图不动、转移表单没被打开、文档字节不变',
      blockBase.matrix === 'matrix(1, 0, 0, 1, 0, 0)' && dragHead.matrix === blockBase.matrix && dragArrow.matrix === blockBase.matrix
      && blockAfter.screen === blockScreen && blockAfter.formHidden === true && blockAfter.bytes === blockBytes,
      JSON.stringify({ headFrom: blockHead, arrowFrom: blockArrow, afterHead: dragHead.matrix, afterArrow: dragArrow.matrix, base: blockBase.matrix, screen: [blockScreen, blockAfter.screen], formHidden: blockAfter.formHidden, bytesSame: blockAfter.bytes === blockBytes }));

    // ⑦ 「重置」= 回到**正好** 100% **且**回到原位
    await dragPan(140, 90);
    await wheelTo(2);
    await clickSelector('#dz-flow-zoom-reset');
    await frames(3);
    const reset = await viewProbe();
    const resetBytes = await evalIn('window.sophoDesigner.exportDoc()');
    check('pan:reset', '「重置」= 回到**正好** 100% **且**回到原位：拖过也缩过之后点「重置」⇒ 变换矩阵 / 定点 / 首卡实测矩形 / 档位都逐字回到基线（平移与缩放一起归零）',
      reset.matrix === base.matrix && reset.origin === base.origin && reset.scale === 1 && reset.zoomText === '100%'
      && Math.abs(reset.card.x - base.card.x) < 0.01 && Math.abs(reset.card.y - base.card.y) < 0.01
      && resetBytes === baseProbe.docBytes,
      JSON.stringify({ matrix: reset.matrix, origin: reset.origin, card: reset.card, baseCard: base.card, scale: reset.scale, bytes: [resetBytes.length, baseProbe.docBytes.length] }));

    // 收摊：回到 100% ＋ 原位 ＋ 编辑视图（不让后面那条「零异常」被视图态影响）
    await clickSelector('#dz-flow-zoom-reset');
    await clickSelector('#dz-view-edit');
    await frames(2);
  });

  // ═══ 17d. 流程画布：转移起点锚（`from.anchor.selector` ⇒ 起点落在**控件盒子的边**上）══════════════
  //
  // 业主 2026-09-27 的裁定（**丙**）：「要的是**那张画真屏的流程视图**」—— A 半（导出器 `designer/toSvg.mjs`）
  // 早在 `9ab6abf` 就落地了；这一组量的是**页面画布**那半边（`web/designer.js` 的 `[SEAM:anchor]`）。
  //
  // 口径（与 A 半的 `designer/toSvg.mjs` ／ `docs/design/designer-exporters.md` §10 **同一条**）：
  //   · 选择器**只认 `#<元素 id>`**（别的写法不猜）；起点 = 从锚点盒子中心朝目标引射线、取它**穿出盒子**
  //     的那个点（「朝向目标那一侧的那条边」上的落点，与导出器的 `edgePointToward()` 同式）；
  //   · 指不到（元素不在这一屏的内容里）／写法不认／那个控件在**画出来的屏内容**里没有可见位置
  //     ⇒ **退回卡片上那个默认起点**（不是「画到别处」，也不静默：退回了就没有 `data-anchor` 这个读数）；
  //   · **没带** `from.anchor` 的转移**逐像素不变**：`anchor:plain-unchanged` 拿门自己按**改动前那一式**
  //     拼出来的整条 `d` 与画布上那条 path **逐字节**比（含两个控制点）。
  //
  // ⚠️ 一处口径必须写明（免得两半的用词串味）：导出器那边的默认起点是**节点中心**（那边的节点是个紧凑盒子、
  // 不画屏内容）；画布这边卡片里画的是**真屏内容**，默认起点一直是「卡片朝向目标那一侧边的中点」
  // （`docs/design/designer-ui.md` §4）。**退回**退到的是**它** —— 因为「无锚点的转移逐像素不变」是硬判据，
  // 退到卡片中心会把每一根老箭头的起点都挪进卡片里（那是另一件事，得先问业主）。
  //
  // 这一组**全部**走真鼠标事件（`Input.dispatchMouseEvent`）＋ **DOM 实测**；期望值由**门自己**按规则
  // 重算一遍（门里那份 `edgePointToward` / 默认起点式是独立写的，**不调产品里的任何函数**）。
  // 反证臂：`anchor-as-default`（[SEAM:anchor] 换回「一律用默认起点」＝「从容器出来、不是从控件出来」）／
  //   `anchor-self-as-default`（自环那一支）／`anchor-fallback-off-by-body`（退回落点改成屏内容可见区）／
  //   `anchor-ignores-visibility`（不看可见性）／`anchor-falls-back-to-root`（找不到就退回整屏）／
  //   `anchor-any-selector`（写法不认时改用任意选择器）／`anchor-container-falls-back`（容器锚点一律退回）／
  //   `anchor-stale-box`（盒子只量一次、缩放/平移后不重量）／`anchor-dropped-in-canonical`（规范序列化把 anchor 静默丢了）。
  //   另外两条**既有**臂也盯这一组：`painted-arrows`（箭头换成写死的一份 ⇒ 样张根数不对）／
  //   `arrows-under-cards`（层序反了 ⇒ 起点那一段被卡压住、点不到）／`zoom-labels-ignore`（标签度量不跟缩放 ⇒ 50% 档那条必红）。
  const ANCHOR_FIXTURE = {
    $schema: 'https://sopho-pi.invalid/schema/uidesign-0.1.0.json',
    version: '0.1.0',
    tokens: {},
    screens: [
      {
        id: 'screen-a',
        name: '屏 A',
        states: [{ id: 'state-a1', name: '默认' }, { id: 'state-a2', name: '加载中' }],
        root: {
          id: 'el-root-a',
          type: 'container',
          size: { w: { mode: 'fixed', value: 640 }, h: { mode: 'fixed', value: 440 } },
          layout: { mode: 'free' },
          children: [
            { id: 'el-title', type: 'text', box: { x: 20, y: 16, w: 200, h: 24 }, size: { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 24 } }, text: '设置' },
            { id: 'el-input-name', type: 'input', box: { x: 40, y: 120, w: 200, h: 32 }, size: { w: { mode: 'fixed', value: 200 }, h: { mode: 'fixed', value: 32 } } },
            {
              id: 'el-panel', type: 'container', box: { x: 300, y: 200, w: 220, h: 120 },
              size: { w: { mode: 'fixed', value: 220 }, h: { mode: 'fixed', value: 120 } }, layout: { mode: 'free' },
              children: [{ id: 'el-panel-ok', type: 'button', box: { x: 10, y: 70, w: 80, h: 32 }, size: { w: { mode: 'fixed', value: 80 }, h: { mode: 'fixed', value: 32 } }, text: '好' }],
            },
            { id: 'el-foot-settings', type: 'button', box: { x: 420, y: 380, w: 120, h: 36 }, size: { w: { mode: 'fixed', value: 120 }, h: { mode: 'fixed', value: 36 } }, text: '设置' },
            // **屏里看不见**的那个：自由布局允许子元素溢出屏，而卡片体（`.dz-card-body`）`overflow: hidden`
            // ⇒ 它在**画出来的屏内容**里没有可见位置（实测矩形与可见区求交为空）。
            { id: 'el-offscreen', type: 'rect', box: { x: 1100, y: 40, w: 80, h: 40 }, size: { w: { mode: 'fixed', value: 80 }, h: { mode: 'fixed', value: 40 } } },
          ],
        },
      },
      { id: 'screen-b', name: '屏 B', states: [{ id: 'state-b1', name: '默认' }], root: { id: 'el-root-b', type: 'container', size: { w: { mode: 'fixed', value: 640 }, h: { mode: 'fixed', value: 440 } }, layout: { mode: 'free' }, children: [] } },
      { id: 'screen-c', name: '屏 C', states: [{ id: 'state-c1', name: '默认' }], root: { id: 'el-root-c', type: 'container', size: { w: { mode: 'fixed', value: 640 }, h: { mode: 'fixed', value: 440 } }, layout: { mode: 'free' }, children: [] } },
      { id: 'screen-d', name: '屏 D', states: [{ id: 'state-d1', name: '默认' }], root: { id: 'el-root-d', type: 'container', size: { w: { mode: 'fixed', value: 640 }, h: { mode: 'fixed', value: 440 } }, layout: { mode: 'free' }, children: [] } },
    ],
    transitions: [
      { id: 'tr-anchor-button', from: { screen: 'screen-a', state: 'state-a1', anchor: { selector: '#el-foot-settings' } }, to: { screen: 'screen-b', state: 'state-b1' }, trigger: '点设置' },
      { id: 'tr-anchor-input', from: { screen: 'screen-a', state: 'state-a1', anchor: { selector: '#el-input-name' } }, to: { screen: 'screen-c', state: 'state-c1' }, trigger: '改名字' },
      { id: 'tr-plain', from: { screen: 'screen-a', state: 'state-a1' }, to: { screen: 'screen-d', state: 'state-d1' }, trigger: '直接下一步' },
      { id: 'tr-anchor-container', from: { screen: 'screen-a', state: 'state-a1', anchor: { selector: '#el-panel' } }, to: { screen: 'screen-d', state: 'state-d1' }, trigger: '面板' },
      { id: 'tr-nested', from: { screen: 'screen-b', state: 'state-b1', anchor: { selector: '#el-root-b' } }, to: { screen: 'screen-a', state: 'state-a1' }, trigger: '回到 A' },
      { id: 'tr-anchor-self', from: { screen: 'screen-a', state: 'state-a1', anchor: { selector: '#el-foot-settings' } }, to: { screen: 'screen-a', state: 'state-a2' }, trigger: '自己转一圈' },
      { id: 'tr-anchor-missing', from: { screen: 'screen-a', state: 'state-a1', anchor: { selector: '#el-nope' } }, to: { screen: 'screen-c', state: 'state-c1' }, trigger: '指不到' },
      // 锚点指到**别的屏**的元素：`#el-root-b` 是屏 B 的根 —— 文档里**有**这个 id（所以不是 missing），
      // 但它不在 from 那一屏（屏 A）的树里 ⇒ 退回，原因该记成 `not-in-screen-tree`。
      { id: 'tr-anchor-othertree', from: { screen: 'screen-a', state: 'state-a1', anchor: { selector: '#el-root-b' } }, to: { screen: 'screen-c', state: 'state-c1' }, trigger: '锚点在别的屏' },
      { id: 'tr-anchor-hidden', from: { screen: 'screen-a', state: 'state-a1', anchor: { selector: '#el-offscreen' } }, to: { screen: 'screen-b', state: 'state-b1' }, trigger: '屏里看不见' },
      { id: 'tr-anchor-badsel', from: { screen: 'screen-a', state: 'state-a1', anchor: { selector: '[data-id="el-input-name"]' } }, to: { screen: 'screen-b', state: 'state-b1' }, trigger: '写法不认' },
    ],
  };
  await groupCheck('flow-anchor', async () => {
    const r2 = (n) => Math.round(n * 100) / 100;
    const r3 = (n) => Math.round(n * 1000) / 1000;
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

    // ── 探针：**全是 DOM 实测**（不调产品里的任何函数），并按规则把期望值重算一遍 ──────────────────
    // 关键：卡片矩形 / SVG 原点都取**原生字段**（`left`/`right`/`top`/`bottom`/`width`/`height`），
    // 门这一侧于是能拼出与实现**同一串字节**的默认路径 `d`（不是「近似相等」，是逐字节）。
    await evalIn(`window.__dzAnchorProbe = () => {
      const svg = document.querySelector('#dz-arrows');
      const svgRect = svg.getBoundingClientRect();
      const doc = window.sophoDesigner.getDoc();
      const cardOf = (id) => document.querySelector('#dz-flow .dz-card[data-screen="' + id + '"]');
      const cardRect = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
      // 门这一侧的「锚点盒子」= 控件实测矩形 ∩ 屏内容可见区（卡片体 .dz-card-body 有 overflow: hidden）
      const anchorFacts = (card, id) => {
        const body = card.querySelector('.dz-card-body');
        if (!body) return { exists: false, visible: false, box: null };
        const dom = [...body.querySelectorAll('[data-id]')].find((el) => el.getAttribute('data-id') === id) ?? null;
        if (!dom) return { exists: false, visible: false, box: null };
        const rect = dom.getBoundingClientRect();
        const view = body.getBoundingClientRect();
        const left = Math.max(rect.left, view.left);
        const top = Math.max(rect.top, view.top);
        const right = Math.min(rect.right, view.right);
        const bottom = Math.min(rect.bottom, view.bottom);
        const box = { x: left - svgRect.left, y: top - svgRect.top, w: right - left, h: bottom - top };
        return { exists: true, visible: box.w > 0 && box.h > 0, box, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, view: { left: view.left, top: view.top, right: view.right, bottom: view.bottom } };
      };
      // 规则（门自己的一份）：从盒子中心朝 aim 引射线，取穿出盒子的那个点
      const edgePointToward = (box, aim) => {
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const dx = aim.x - cx;
        const dy = aim.y - cy;
        if (dx === 0 && dy === 0) return { x: cx, y: cy };
        const tx = dx > 0 ? (box.x + box.w - cx) / dx : dx < 0 ? (box.x - cx) / dx : Infinity;
        const ty = dy > 0 ? (box.y + box.h - cy) / dy : dy < 0 ? (box.y - cy) / dy : Infinity;
        const t = Math.min(tx, ty);
        return { x: cx + dx * t, y: cy + dy * t };
      };
      const onBoundary = (p, box) => {
        const eps = 0.75;
        const inX = p.x >= box.x - eps && p.x <= box.x + box.w + eps;
        const inY = p.y >= box.y - eps && p.y <= box.y + box.h + eps;
        const onEdge = Math.abs(p.x - box.x) <= eps || Math.abs(p.x - (box.x + box.w)) <= eps || Math.abs(p.y - box.y) <= eps || Math.abs(p.y - (box.y + box.h)) <= eps;
        return inX && inY && onEdge;
      };
      const strictId = (selector) => { const m = typeof selector === 'string' ? /^\\s*#([^\\s#.\\[\\]:>+~,*]+)\\s*$/.exec(selector) : null; return m === null ? null : m[1]; };
      const rows = [];
      for (const path of document.querySelectorAll('#dz-arrows .dz-arrow-path')) {
        const transition = doc.transitions.find((t) => t.id === path.dataset.arrow) ?? null;
        const fromCard = transition ? cardOf(transition.from.screen) : null;
        const toCard = transition ? cardOf(transition.to.screen) : null;
        const total = path.getTotalLength();
        const start = path.getPointAtLength(0);
        const end = path.getPointAtLength(total);
        const a = fromCard ? cardRect(fromCard) : null;
        const b = toCard ? cardRect(toCard) : null;
        const self = !!transition && transition.from.screen === transition.to.screen;
        // 「默认起点」= **改动前那一式**（卡片上朝向目标那一侧边的中点；自环是卡片上边那两个点里靠左的那个）
        let defaultStart = null;
        if (a && b) {
          if (self) defaultStart = { x: a.left - svgRect.left + a.width / 2 - Math.min(a.width / 2, 60) * 0.6, y: a.top - svgRect.top };
          else {
            const forward = b.left + b.width / 2 >= a.left + a.width / 2;
            defaultStart = { x: (forward ? a.right : a.left) - svgRect.left, y: a.top - svgRect.top + a.height / 2 };
          }
        }
        const selector = transition?.from?.anchor?.selector ?? null;
        const anchorId = strictId(selector);
        const facts = fromCard && anchorId !== null ? anchorFacts(fromCard, anchorId) : { exists: false, visible: false, box: null };
        rows.push({
          id: path.dataset.arrow ?? null, self,
          fromScreen: transition?.from?.screen ?? null, toScreen: transition?.to?.screen ?? null,
          marker: path.dataset.anchor ?? null, fallback: path.dataset.anchorFallback ?? null, d: path.getAttribute('d'),
          start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y },
          selector, anchorId, facts,
          expectAnchorStart: facts.visible && !self ? edgePointToward(facts.box, { x: end.x, y: end.y }) : null,
          onBoundary: facts.visible ? onBoundary({ x: start.x, y: start.y }, facts.box) : null,
          defaultStart, toDefault: defaultStart === null ? null : Math.hypot(start.x - defaultStart.x, start.y - defaultStart.y),
        });
      }
      const cards = [...document.querySelectorAll('#dz-flow .dz-card')].map((card) => ({ screen: card.dataset.screen, card: cardRect(card), body: cardRect(card.querySelector('.dz-card-body')) }));
      const labels = [...document.querySelectorAll('#dz-arrows .dz-arrow-label')];
      const boxOf = (el) => { const x = el.getBoundingClientRect(); return { x: x.left, y: x.top, w: x.width, h: x.height }; };
      const area = (p, q) => Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));
      let worstOverlap = 0; let pairs = 0;
      for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) { pairs += 1; worstOverlap = Math.max(worstOverlap, area(boxOf(labels[i]), boxOf(labels[j]))); }
      const distanceToOwn = labels.map((label) => {
        const own = document.querySelector('#dz-arrows .dz-arrow-path[data-arrow="' + label.dataset.arrow + '"]');
        if (!own) return { id: label.dataset.arrow ?? null, distance: null };
        const c = boxOf(label);
        const cx = c.x + c.w / 2; const cy = c.y + c.h / 2;
        const t = own.getTotalLength();
        let best = Infinity;
        for (let i = 0; i <= 200; i += 1) { const p = own.getPointAtLength((t * i) / 200); best = Math.min(best, Math.hypot(svgRect.left + p.x - cx, svgRect.top + p.y - cy)); }
        return { id: label.dataset.arrow ?? null, distance: best };
      });
      return {
        svg: { left: svgRect.left, top: svgRect.top },
        warn: (() => { const w = document.querySelector('#dz-flow-warn'); return { hidden: w.hidden, text: w.textContent.trim(), height: w.getBoundingClientRect().height }; })(),
        scale: Number(document.querySelector('#dz-flow-zoom-level').dataset.zoom),
        zoomText: document.querySelector('#dz-flow-zoom-level').textContent,
        pan: window.__dz.viewPan(), rows, cards, labels: labels.length, pairs, worstOverlap, distanceToOwn,
        docBytes: window.sophoDesigner.exportDoc(), docJson: JSON.stringify(window.sophoDesigner.getDoc()),
      };
    }`);

    const loaded = await evalIn(`(() => {
      const receipt = window.sophoDesigner.setDoc(${JSON.stringify(ANCHOR_FIXTURE)});
      window.sophoDesigner.setView('flow');
      const doc = window.sophoDesigner.getDoc();
      return {
        receipt: { screens: receipt.screens, transitions: receipt.transitions },
        transitions: doc.transitions.map((t) => ({ id: t.id, from: t.from.screen, to: t.to.screen, selector: t.from.anchor?.selector ?? null })),
        anchorsInDoc: doc.transitions.filter((t) => t.from.anchor !== undefined).length,
        bytes: window.sophoDesigner.exportDoc(),
      };
    })()`);
    await frames(8);
    const probeOf = () => evalIn('window.__dzAnchorProbe()');
    const p0 = await probeOf();

    // ── 门自己按**改动前那一式**拼出那条默认路径（整条 `d`：含起点/终点/两个控制点）────────────────
    // 取的是探针里那份**原生** DOMRect 字段 ⇒ 与实现里的算术同一串字节（不是「近似相等」）。
    const defaultD = (probe, row) => {
      const a = (probe.cards ?? []).find((item) => item.screen === row.fromScreen);
      const b = (probe.cards ?? []).find((item) => item.screen === row.toScreen);
      if (!a || !b) return null;
      const sx = probe.svg.left; const sy = probe.svg.top;
      if (row.self) {
        const cx = a.card.left - sx + a.card.width / 2;
        const top = a.card.top - sy;
        const out = Math.min(a.card.width / 2, 60);
        return `M ${cx - out * 0.6} ${top} C ${cx - out} ${top - 46}, ${cx + out} ${top - 46}, ${cx + out * 0.6} ${top}`;
      }
      const forward = b.card.left + b.card.width / 2 >= a.card.left + a.card.width / 2;
      const start = { x: (forward ? a.card.right : a.card.left) - sx, y: a.card.top - sy + a.card.height / 2 };
      const end = { x: (forward ? b.card.left : b.card.right) - sx, y: b.card.top - sy + b.card.height / 2 };
      const bend = Math.max(28, Math.abs(end.x - start.x) * 0.45);
      const c1 = { x: start.x + (forward ? bend : -bend), y: start.y };
      const c2 = { x: end.x - (forward ? bend : -bend), y: end.y };
      return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
    };
    const rowOf = (probe, id) => (probe.rows ?? []).find((item) => item.id === id) ?? null;
    const CONTROLS = ['tr-anchor-button', 'tr-anchor-input'];
    const CONTAINERS = ['tr-anchor-container', 'tr-nested'];
    const SELF_ANCHORED = 'tr-anchor-self';
    const FALLBACKS = ['tr-plain', 'tr-anchor-missing', 'tr-anchor-othertree', 'tr-anchor-hidden', 'tr-anchor-badsel'];
    /** 带锚点的那几条的**几何**读数（起点在盒子边上 / == 规则算出的点 / ≠ 默认起点 / 带 `data-anchor`）。 */
    const anchoredIssues = (probe, ids) => {
      const out = { offBox: [], offRule: [], tooClose: [], noMarker: [], noPath: [], noVisibleBox: [] };
      for (const id of ids) {
        const row = rowOf(probe, id);
        if (!row) { out.noPath.push(id); continue; }
        if (row.anchorId === null || row.marker !== row.anchorId) out.noMarker.push({ id, marker: row.marker, anchorId: row.anchorId });
        if (row.facts?.visible !== true) { out.noVisibleBox.push({ id, facts: { exists: row.facts?.exists ?? null, box: row.facts?.box ?? null } }); continue; }
        if (row.onBoundary !== true) out.offBox.push({ id, start: row.start, box: row.facts.box });
        if (!(row.toDefault > 3)) out.tooClose.push({ id, toDefault: row.toDefault, start: row.start, defaultStart: row.defaultStart });
        if (row.self === false && (row.expectAnchorStart === null || dist(row.start, row.expectAnchorStart) > 0.75)) {
          out.offRule.push({ id, start: row.start, expect: row.expectAnchorStart });
        }
      }
      return out;
    };
    /** 退回那几条：**没有** `data-anchor`、起点**正好**是默认起点、而且整条 `d` 与改动前那一式**逐字节**相同。 */
    const fallbackIssues = (probe, ids) => {
      const out = [];
      for (const id of ids) {
        const row = rowOf(probe, id);
        if (!row) { out.push({ id, why: '没画出来' }); continue; }
        if (row.marker !== null) out.push({ id, why: '退回了却还带着 data-anchor', marker: row.marker });
        if (row.toDefault !== 0) out.push({ id, why: '起点不是那个默认起点', toDefault: row.toDefault, start: row.start, defaultStart: row.defaultStart });
        const expected = defaultD(probe, row);
        if (row.d !== expected) out.push({ id, why: '整条 d 与改动前那一式不一致', d: row.d, expected });
      }
      return out;
    };
    const labelIssues = (probe, tier) => {
      const bound = LABEL_MAX_PX * tier + 1;
      return {
        bound,
        offPath: (probe.distanceToOwn ?? []).filter((entry) => entry.distance === null || entry.distance > bound),
        worstOverlap: probe.worstOverlap, pairs: probe.pairs,
      };
    };
    const geometryDetail = (probe, ids) => JSON.stringify(ids.map((id) => {
      const row = rowOf(probe, id);
      return row === null ? { id, missing: true } : {
        id, marker: row.marker, start: { x: r2(row.start.x), y: r2(row.start.y) },
        box: row.facts?.box ? { x: r2(row.facts.box.x), y: r2(row.facts.box.y), w: r2(row.facts.box.w), h: r2(row.facts.box.h) } : null,
        expect: row.expectAnchorStart ? { x: r2(row.expectAnchorStart.x), y: r2(row.expectAnchorStart.y) } : null,
        defaultStart: row.defaultStart ? { x: r2(row.defaultStart.x), y: r2(row.defaultStart.y) } : null, toDefault: row.toDefault === null ? null : r3(row.toDefault),
      };
    }));

    // ── 样张：4 屏 / 10 条转移（2 个控件锚点 ＋ 1 个容器锚点 ＋ 1 个屏根锚点 ＋ 1 个自环锚点 ＋ 4 条带锚点却退回的 ＋ 1 条不带锚点）──
    check('anchor:sample', '样张（走 `setDoc()` ＝ 与「导入 JSON」同一份校验）：4 屏 / 10 条转移，其中 **9 条带 `from.anchor`**、1 条不带；'
      + '画布上画出 **10 根**箭头，`data-arrow` 与文档里的转移 id 逐个对得上',
      loaded.receipt.screens === 4 && loaded.receipt.transitions === 10 && loaded.anchorsInDoc === 9
      && (p0.rows ?? []).length === 10
      && JSON.stringify([...(p0.rows ?? [])].map((row) => row.id).sort()) === JSON.stringify(loaded.transitions.map((t) => t.id).sort()),
      JSON.stringify({ receipt: loaded.receipt, anchorsInDoc: loaded.anchorsInDoc, paths: (p0.rows ?? []).length,
        ids: (p0.rows ?? []).map((row) => row.id), selectors: loaded.transitions.map((t) => `${t.id}:${t.selector ?? '（无锚点）'}`) }));

    // ── ① 起点落在**控件盒子的边**上（两个真控件：按钮 / 输入框）──────────────────────────────
    const c0 = anchoredIssues(p0, CONTROLS);
    check('anchor:start-on-box-edge', '带锚点的转移（`#el-foot-settings` 按钮 / `#el-input-name` 输入框）：起点落在**那个控件盒子的边**上'
      + '（盒子 = 控件实测矩形 ∩ 屏内容可见区，`±0.75px`）、**不是**卡片上那个默认起点（离它 > 3px），'
      + '而且那根 path 带着 `data-anchor=<控件 id>`（视图标记 —— 退回了就没有它）',
      c0.noPath.length === 0 && c0.noMarker.length === 0 && c0.noVisibleBox.length === 0
      && c0.offBox.length === 0 && c0.tooClose.length === 0,
      JSON.stringify({ issues: c0, rows: JSON.parse(geometryDetail(p0, CONTROLS)) }));

    // ── ② 边上的**哪一个点**：从盒子中心朝目标引射线穿出盒子的那个点（与导出器同式）──────────────
    check('anchor:start-edge-point-toward-target', '起点不是「盒子上随便哪条边」，而是**从盒子中心朝箭头终点引射线、穿出盒子**的那个点'
      + '（与导出器的 `edgePointToward()` 同式）—— 门自己按实测盒子和实测终点重算一遍，两侧相差 ≤ 0.75px'
      + '（那两条线得先在：没画出来 / 量不到可见盒子也算这条红 —— 不让它在空集上假绿）',
      c0.noPath.length === 0 && c0.noVisibleBox.length === 0 && c0.offRule.length === 0,
      JSON.stringify({ issues: { noPath: c0.noPath, noVisibleBox: c0.noVisibleBox, offRule: c0.offRule }, rows: JSON.parse(geometryDetail(p0, CONTROLS)) }));

    // ── ③ 容器 / 屏根也能当锚点（与导出器的 `anchorBoxOf()` 同一条：它不做类型限制）──────────────
    const c1 = anchoredIssues(p0, CONTAINERS);
    check('anchor:container-and-root-honored', '锚点指到**容器**（`#el-panel`）或**屏的根**（`#el-root-b`）时同样按盒子算起点（导出器那边也不做类型限制）——'
      + '起点在那条盒子的边上、≠ 默认起点、带 `data-anchor`（容器盒比控件盒大 ⇒ 「从哪儿出来」这件事照样是量得出来的）',
      c1.noPath.length === 0 && c1.noMarker.length === 0 && c1.noVisibleBox.length === 0
      && c1.offBox.length === 0 && c1.tooClose.length === 0 && c1.offRule.length === 0,
      JSON.stringify({ issues: c1, rows: JSON.parse(geometryDetail(p0, CONTAINERS)) }));

    // ── ④ 自环 ＋ 锚点：起点/终点都落在**锚点盒子的上边**（与导出器同一条）─────────────────────
    const selfRow = rowOf(p0, SELF_ANCHORED);
    const selfOk = !!selfRow && selfRow.self === true && selfRow.anchorId !== null && selfRow.marker === selfRow.anchorId
      && selfRow.facts?.visible === true
      && Math.abs(selfRow.start.y - selfRow.facts.box.y) <= 0.75
      && selfRow.start.x >= selfRow.facts.box.x - 0.75 && selfRow.start.x <= selfRow.facts.box.x + selfRow.facts.box.w + 0.75
      && selfRow.start.x < selfRow.facts.box.x + selfRow.facts.box.w / 2
      && selfRow.toDefault > 3;
    check('anchor:self-start-on-box-edge', '自环（同屏换状态）带锚点时：起点落在**锚点盒子的上边**、且在中点左侧（环从那个控件上方出去再回来）——'
      + '与导出器的自环锚点同一条；而**没带锚点**的自环仍是卡片上边那两个点（下面 `anchor:plain-unchanged` 那条量的是普通转移）',
      selfOk, selfRow === null ? JSON.stringify({ missing: SELF_ANCHORED }) : JSON.stringify({
        marker: selfRow.marker, start: { x: r2(selfRow.start.x), y: r2(selfRow.start.y) },
        box: selfRow.facts?.box ? { x: r2(selfRow.facts.box.x), y: r2(selfRow.facts.box.y), w: r2(selfRow.facts.box.w), h: r2(selfRow.facts.box.h) } : null,
        toDefault: selfRow.toDefault === null ? null : r3(selfRow.toDefault), d: selfRow.d,
      }));

    // ── ⑤ 没带锚点的转移：整条路径**逐字节**还是改动前那一式（向后兼容）──────────────────────────
    const plainRow = rowOf(p0, 'tr-plain');
    const plainExpected = plainRow ? defaultD(p0, plainRow) : null;
    check('anchor:plain-unchanged', '**没带** `from.anchor` 的转移**逐像素不变**：画布上那条 path 的 `d` 与门自己按**改动前那一式**'
      + '（卡片上朝向目标那一侧边的中点 ＋ 两个控制点）拼出来的串**逐字节相同**，且没有 `data-anchor` 属性',
      !!plainRow && plainRow.marker === null && plainRow.toDefault === 0 && plainRow.d === plainExpected,
      plainRow === null ? JSON.stringify({ missing: 'tr-plain' })
        : JSON.stringify({ same: plainRow.d === plainExpected, d: plainRow.d, expected: plainExpected, marker: plainRow.marker, toDefault: plainRow.toDefault }));

    // ── ⑥⑦⑧ 三条「该退回」的形状：元素不在 / 屏里不可见 / 写法不认 ⇒ 起点**正好**是默认起点 ──────────
    const missingRow = rowOf(p0, 'tr-anchor-missing');
    const missingFacts = await evalIn(`(() => {
      const body = document.querySelector('#dz-flow .dz-card[data-screen="screen-a"] .dz-card-body');
      return { present: !!body.querySelector('[data-id="el-nope"]'), ids: [...body.querySelectorAll('[data-id]')].length };
    })()`);
    check('anchor:missing-falls-back', '锚点**指不到**（`#el-nope` 不在这一屏的内容里）⇒ 退回卡片上那个默认起点：'
      + 'path 上**没有** `data-anchor`、起点离默认起点 **0px**、整条 `d` 与改动前那一式逐字节相同',
      !!missingRow && missingFacts.present === false && missingRow.marker === null && missingRow.toDefault === 0
      && missingRow.d === defaultD(p0, missingRow),
      JSON.stringify({ missingFacts, marker: missingRow?.marker ?? null, toDefault: missingRow?.toDefault ?? null,
        d: missingRow?.d ?? null, expected: missingRow ? defaultD(p0, missingRow) : null }));

    const hiddenRow = rowOf(p0, 'tr-anchor-hidden');
    check('anchor:hidden-falls-back', '锚点**在画出来的屏内容里没有可见位置**（`#el-offscreen` 自由布局溢出到屏外：实测矩形与卡片可见区求交为**空**）'
      + '⇒ 同样退回默认起点（门这一侧把那个「求交为空」的实测数字也打出来，证明它真的不可见、不是空口）',
      !!hiddenRow && hiddenRow.facts?.exists === true && hiddenRow.facts?.visible === false
      && hiddenRow.marker === null && hiddenRow.toDefault === 0 && hiddenRow.d === defaultD(p0, hiddenRow),
      JSON.stringify({ exists: hiddenRow?.facts?.exists ?? null, visible: hiddenRow?.facts?.visible ?? null,
        rawRect: hiddenRow?.facts?.rect ?? null, visibleArea: hiddenRow?.facts?.view ?? null, box: hiddenRow?.facts?.box ?? null,
        marker: hiddenRow?.marker ?? null, toDefault: hiddenRow?.toDefault ?? null, d: hiddenRow?.d ?? null,
        expected: hiddenRow ? defaultD(p0, hiddenRow) : null }));

    const badselRow = rowOf(p0, 'tr-anchor-badsel');
    const looseFound = await evalIn(`(() => {
      const card = document.querySelector('#dz-flow .dz-card[data-screen="screen-a"]');
      return { loose: !!card.querySelector('[data-id="el-input-name"]') };
    })()`);
    check('anchor:badselector-falls-back', '锚点**写法不认**（`[data-id="el-input-name"]` 不是 `#<元素 id>`）⇒ 退回默认起点，**不猜**；'
      + '而门同时证明「它本来查得到」：同一个选择器走 `querySelector` 是**能**命中的（⇒ 拦下它的是「只认 `#id`」这条规则，不是元素不存在）',
      !!badselRow && looseFound.loose === true && badselRow.anchorId === null
      && badselRow.marker === null && badselRow.toDefault === 0 && badselRow.d === defaultD(p0, badselRow),
      JSON.stringify({ looseFound, anchorId: badselRow?.anchorId ?? null, marker: badselRow?.marker ?? null,
        toDefault: badselRow?.toDefault ?? null, d: badselRow?.d ?? null, expected: badselRow ? defaultD(p0, badselRow) : null }));

    // ── ⑧b 「锚点没生效」不许静默：四类原因的**机械标记** ＋ 页面上那一句**看得见**的提示 ─────────────
    // 交接单自报的第 ④ 条缺口：锚点指到别的屏 / 写法不认 / 屏里看不见时，页面从前**什么都不说**（
    // `data-anchor` 不在、控制台干净、DOM 里与「压根没带锚点」一模一样）—— 站在页面前面的人看不出自己写的锚点没生效。
    // 现在：`data-anchor-fallback="<封闭原因>"`（机械可读）＋ 流程视图那条既有警告线上点名（人眼可读）。
    const reasonById = {
      'tr-anchor-missing': 'missing',
      'tr-anchor-othertree': 'not-in-screen-tree',
      'tr-anchor-hidden': 'not-visible',
      'tr-anchor-badsel': 'bad-selector',
    };
    const REASONS = ['missing', 'not-in-screen-tree', 'not-visible', 'bad-selector'];
    const fallbackOf = (probe, id) => rowOf(probe, id)?.fallback ?? null;
    const carriedBy = (probe, reason) => (probe.rows ?? []).filter((row) => row.fallback === reason).map((row) => row.id).sort();
    const withFallback = (p0.rows ?? []).filter((row) => row.fallback !== null).map((row) => row.id).sort();
    const ANCHOR_OK_IDS = ['tr-anchor-button', 'tr-anchor-input', 'tr-anchor-container', 'tr-nested', 'tr-anchor-self'];
    const warnFacts = p0.warn ?? null;
    const reasonRows = [
      ['missing', 'tr-anchor-missing', '`#el-nope` 在文档里**任何一棵树**都没有'],
      ['not-in-screen-tree', 'tr-anchor-othertree', '`#el-root-b` 在文档里（它是**屏 B** 的根），但不在 from 那一屏（屏 A）画出来的树里'],
      ['not-visible', 'tr-anchor-hidden', '`#el-offscreen` **在**屏 A 的树里、`findCardElement()` 查得到，但它与屏内容可见区求交没有正面积'],
      ['bad-selector', 'tr-anchor-badsel', '`[data-id="el-input-name"]` 不是 `#<元素 id>`（写法不认，不猜）'],
    ];
    for (const [reason, id, why] of reasonRows) {
      const row = rowOf(p0, id);
      const carried = carriedBy(p0, reason);
      check(`anchor:fallback-reason-${reason}`, `「锚点没生效」的原因**机械可读**：带锚点却退回的 \`${id}\` 那条 path 上写着 `
        + `\`data-anchor-fallback="${reason}"\`（${why}）—— 而这个原因**只**落在它这一条上：10 条 path 里带 \`${reason}\` 的恰好是 \`${id}\` 一条；`
        + '它同时**没有** `data-anchor`（起点真的没落在控件盒子上）、整条 `d` 仍与改动前那一式**逐字节相同**（退回本身的行为一字未改）',
        !!row && row.fallback === reason && JSON.stringify(carried) === JSON.stringify([id])
        && row.marker === null && row.d === defaultD(p0, row),
        JSON.stringify({ id, fallback: row?.fallback ?? null, carried, all: withFallback,
          marker: row?.marker ?? null, sameD: row ? row.d === defaultD(p0, row) : null, warn: warnFacts }));
    }
    const expectedFallback = Object.keys(reasonById).sort();
    check('anchor:fallback-markers-exact', '四种原因**一个不多一个不少**、与转移 id 一一对应：10 条 path 里**只有 4 条**带 `data-anchor-fallback`，'
      + '正好是 {missing: tr-anchor-missing, not-in-screen-tree: tr-anchor-othertree, not-visible: tr-anchor-hidden, bad-selector: tr-anchor-badsel}；'
      + '没带锚点的 `tr-plain` 与 5 条锚点生效的转移**一个属性都不多**（⇒「没带锚点的转移逐字节还是改动前那一式」那条口径没被这个标记破掉）',
      JSON.stringify(withFallback) === JSON.stringify(expectedFallback)
      && REASONS.every((reason) => {
        const id = Object.keys(reasonById).find((key) => reasonById[key] === reason);
        return JSON.stringify(carriedBy(p0, reason)) === JSON.stringify([id]);
      })
      && ['tr-plain', ...ANCHOR_OK_IDS].every((id) => fallbackOf(p0, id) === null),
      JSON.stringify({ withFallback, expectedFallback, byReason: REASONS.map((reason) => [reason, carriedBy(p0, reason)]), warn: warnFacts }));
    check('anchor:fallback-hint-visible', '页面上**看得见**（一处小提示，不新开面板）：流程视图那条既有的警告线 `#dz-flow-warn` 没被藏起来、'
      + '量得到高度，而且逐个点名这 4 条转移与各自的原因（`<id>（<原因>：…）`）—— 站在页面前面的人不必去猜「我写的锚点为什么没生效」；'
      + '而锚点生效的那 5 条与 `tr-plain` **不许**出现在这句提示里',
      warnFacts !== null && warnFacts.hidden === false && warnFacts.height > 0
      && warnFacts.text.includes('4 条转移的起点锚没生效')
      && Object.entries(reasonById).every(([id, reason]) => warnFacts.text.includes(`${id}（${reason}：`))
      && ['tr-plain', ...ANCHOR_OK_IDS].every((id) => !warnFacts.text.includes(id)),
      JSON.stringify(warnFacts));

    // ── ⑨ 缩放 50% / 200% ＋ 平移之后：上面每一条关系**仍然成立**（叠加后的坐标量出来）────────────
    const panBy = async (dx, dy) => {
      const from = await evalIn(`(() => {
        const flow = document.querySelector('#dz-flow');
        const r = flow.getBoundingClientRect();
        const blocked = (el) => !!el.closest('.dz-card, .dz-arrow-hit, .dz-arrow-label, .dz-flow-bar');
        for (let y = Math.round(r.top + 30); y < r.bottom - 16; y += 20) {
          for (let x = Math.round(r.left + 16); x < r.right - 16; x += 20) {
            if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) continue;
            if (x + ${dx} < 2 || y + ${dy} < 2 || x + ${dx} > window.innerWidth - 2 || y + ${dy} > window.innerHeight - 2) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit && hit.closest('#dz-flow') && !blocked(hit)) return { x, y };
          }
        }
        return null;
      })()`);
      if (!from) return null;
      await dragPoints(from, { x: from.x + dx, y: from.y + dy }, { steps: 8 });
      await frames(3);
      return { dx, dy };
    };
    const wheelTo = async (tier) => {
      const pane = await box('#dz-flow');
      await mouse('mouseWheel', pane.cx, pane.cy, { deltaX: 0, deltaY: -Math.log(tier) / 0.002, button: 'none', buttons: 0 });
      await frames(3);
    };
    const PAN = { dx: 120, dy: 80 };
    for (const [id, tier] of [['anchor:tiers-50', 0.5], ['anchor:tiers-200', 2]]) {
      await clickSelector('#dz-flow-zoom-reset');
      await frames(3);
      const pan = await panBy(PAN.dx, PAN.dy);
      await wheelTo(tier);
      const probe = await probeOf();
      const controls = anchoredIssues(probe, CONTROLS);
      const containers = anchoredIssues(probe, CONTAINERS);
      const fallback = fallbackIssues(probe, FALLBACKS);
      const label = labelIssues(probe, tier);
      const zoomedOk = pan !== null && Math.abs(probe.scale - tier) < 1e-3 && probe.pan.x === PAN.dx && probe.pan.y === PAN.dy;
      const anchoredOk = [controls, containers].every((entry) => entry.noPath.length === 0 && entry.noMarker.length === 0
        && entry.noVisibleBox.length === 0 && entry.offBox.length === 0 && entry.tooClose.length === 0 && entry.offRule.length === 0);
      check(id, `${Math.round(tier * 100)}% ＋ 平移 ${PAN.dx}/${PAN.dy} 之后**同一套关系仍成立**：带锚点的起点仍在**控件/容器盒子的边**上、`
        + '仍等于「从盒子中心朝终点引射线穿出盒子」那个点、仍 ≠ 默认起点、仍带 `data-anchor`；该退回的三条起点**仍是**那个默认点；'
        + `标签仍贴在自己那条线上（上界 ${Math.round(label.bound * 100) / 100}px）、两两不相交；文档字节一字不动（纯视图）`,
        zoomedOk && anchoredOk && fallback.length === 0 && label.offPath.length === 0 && label.worstOverlap === 0
        && label.pairs >= 20 && probe.docBytes === loaded.bytes && probe.docJson === p0.docJson,
        JSON.stringify({ tier, scale: probe.scale, pan: probe.pan, zoomedOk,
          controls, containers, fallback, label, records: [controls, containers].some((entry) => entry.offBox.length || entry.offRule.length || entry.tooClose.length)
            ? JSON.parse(geometryDetail(probe, [...CONTROLS, ...CONTAINERS])) : null,
          bytes: [probe.docBytes.length, loaded.bytes.length], pairs: probe.pairs }));
    }

    // ── ⑩ 起点那一段照样点得到（箭头在新起点上仍压在卡片之上 ⇒ 点它打开的是**那一条**转移）────────
    await clickSelector('#dz-flow-zoom-reset');
    await frames(3);
    const hitStart = await evalIn(`(() => {
      const svg = document.querySelector('#dz-arrows');
      const base = svg.getBoundingClientRect();
      const cards = [...document.querySelectorAll('#dz-flow .dz-card')].map((card) => card.getBoundingClientRect());
      const overCard = (x, y) => cards.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      const found = [];
      for (const path of document.querySelectorAll('#dz-arrows .dz-arrow-path[data-anchor]')) {
        const total = path.getTotalLength();
        const samples = [];
        for (const t of [0, 0.005, 0.01, 0.02, 0.04, 0.08, 0.15]) {
          const p = path.getPointAtLength(total * t);
          const x = base.left + p.x; const y = base.top + p.y;
          const inViewport = x > 2 && y > 2 && x < window.innerWidth - 2 && y < window.innerHeight - 2;
          const owner = inViewport ? document.elementFromPoint(x, y) : null;
          samples.push({
            t, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, inViewport, overCard: overCard(x, y),
            arrow: owner?.closest?.('[data-arrow]')?.getAttribute('data-arrow') ?? null, tag: owner ? owner.tagName : null,
          });
        }
        found.push({ id: path.dataset.arrow ?? null, anchor: path.dataset.anchor ?? null, samples });
      }
      return found;
    })()`);
    // 每条带锚点线的「起点那一段」：**几何上压在卡片上**的采样点里，`elementFromPoint` 命中的是不是**连线**
    // （不是卡）。「归谁」是另一件事：16px 粗的点击热区本来就互相重叠 ⇒ 如实把 `own` 也记下来（不当判据）。
    const startRuns = hitStart.map((row) => ({
      id: row.id, anchor: row.anchor,
      overCard: row.samples.filter((sample) => sample.inViewport && sample.overCard).length,
      overCardStolenByCard: row.samples.filter((sample) => sample.inViewport && sample.overCard && sample.arrow === null).length,
      own: row.samples.filter((sample) => sample.inViewport && sample.arrow === row.id).length,
      mine: row.samples.find((sample) => sample.inViewport && sample.arrow === row.id) ?? null,
    }));
    const target = startRuns.find((entry) => entry.mine !== null) ?? null;
    if (target) {
      await clickPoint({ x: target.mine.x, y: target.mine.y });
      await frames(3);
    }
    const openedStart = await evalIn(`(() => ({ hidden: document.querySelector('#dz-tform').hidden, mode: document.querySelector('#dz-tform').dataset.mode ?? null, title: document.querySelector('#dz-tform-title').textContent }))()`);
    check('anchor:hit-start', '起点那一段（现在落在卡片**里面**）照样**点得到**：每条带锚点箭头的路径前 15% 上，'
      + '**几何上压在卡片上**的采样点里 `elementFromPoint` 命中的都是**连线**（不是卡 —— 起点挪进卡片之后连线层仍压在屏卡之上）；'
      + '而真鼠标点一个「归它自己」的点 ⇒ 打开的是**那一条**转移的表单',
      startRuns.length === 5 && startRuns.every((entry) => entry.overCard >= 1 && entry.overCardStolenByCard === 0)
      && target !== null && openedStart.hidden === false && openedStart.mode === 'edit' && openedStart.title.includes(target.id),
      JSON.stringify({ startRuns, target: target === null ? null : { id: target.id, point: target.mine }, opened: openedStart }));
    await safeClickSelector('#dz-tform-cancel');
    await frames(2);

    // ── ⑪ 锚点在**文档**里活着：导出 ⇒ 导入 ⇒ 再导出**逐字节相同**，8 个锚点一个不少 ─────────────
    const roundtrip = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const before = api.exportDoc();
      const receipt = api.setDoc(before);
      const after = api.exportDoc();
      return {
        same: before === after, bytes: before.length, receiptOk: receipt.ok === true,
        anchors: api.getDoc().transitions.filter((t) => t.from.anchor !== undefined).length,
        selectors: api.getDoc().transitions.map((t) => t.from.anchor?.selector ?? null),
      };
    })()`);
    await frames(6);
    const afterRoundtrip = await evalIn(`(() => ({
      paths: document.querySelectorAll('#dz-arrows .dz-arrow-path').length,
      marked: [...document.querySelectorAll('#dz-arrows .dz-arrow-path[data-anchor]')].map((path) => path.dataset.anchor),
      fallen: [...document.querySelectorAll('#dz-arrows .dz-arrow-path[data-anchor-fallback]')].map((path) => [path.dataset.arrow, path.dataset.anchorFallback]).sort(),
    }))()`);
    check('anchor:doc-roundtrip', '锚点在**文档**里活着：`exportDoc()` ⇒ `setDoc()` ⇒ `exportDoc()` **逐字节相同**（规范序列化不把 '
      + '`anchor` 当未知键静默丢掉 —— 9 个锚点往返之后一个不少），而且重新画出来的 10 根箭头里仍有 **5 根**带 `data-anchor`、'
      + '该退回的那 4 条仍然退回（而且带的是**同一个** `data-anchor-fallback` 原因：视图标记是当场重算的，不是上一次的残留）',
      roundtrip.same === true && roundtrip.receiptOk === true && roundtrip.anchors === 9
      && afterRoundtrip.paths === 10 && afterRoundtrip.marked.length === 5
      && JSON.stringify([...afterRoundtrip.marked].sort()) === JSON.stringify(['el-foot-settings', 'el-foot-settings', 'el-input-name', 'el-panel', 'el-root-b'])
      && JSON.stringify(afterRoundtrip.fallen) === JSON.stringify([
        ['tr-anchor-badsel', 'bad-selector'], ['tr-anchor-hidden', 'not-visible'],
        ['tr-anchor-missing', 'missing'], ['tr-anchor-othertree', 'not-in-screen-tree'],
      ]),
      JSON.stringify({ roundtrip, afterRoundtrip }));

    // 收摊：回到 100% ＋ 原位 ＋ 编辑视图（不让后面那条「零异常」被视图态影响）
    await clickSelector('#dz-flow-zoom-reset');
    await clickSelector('#dz-view-edit');
    await frames(2);
  });

  // ═══ 17.95 图层面板：缩进**留白（与会话树同形）** ＋ 可折叠的子项（业主 2026-09-27 更正）════════════
  //
  // 业主 2026-09-27 更正（逐字）：「你的缩进是有了但是**缩进之后，左侧应该是空白的，和我们的会话树一样**，
  // 而不是**还存在槽位**」—— 缩进区（行内容左侧那一段）空白、**不要每层都留槽位**、形状对齐会话树。
  //
  // 这一组量四件事（从头到尾**真鼠标 ＋ 真 DOM**，不调编辑器内部函数）：
  //   ① **缩进 = 留白**：缩进区里**一个槽/引导元素都没有**（源码里也不按层生成），`::before`/`::after` 的
  //      `content` 是 `none`、行不画背景图；并在缩进那一格上用 `elementsFromPoint()` 量：落在最上面的
  //      元素是图层容器本身，**没有任何行/槽盖住缩进区**。
  //   ② **与会话树同形**：每层标签的 `main-left` 逐层步进量 == **本仓会话树在同一台真 Chromium 里的实测步进**
  //      （本组自己另起一页真量会话树；期望值**不写死成常数**）。行左缘同样逐层步进同值；`padding-left` 各行相同。
  //   ③ **行自身那条槽**：恰好 `--design-slot-width`（3px）宽、`solid`、色只取自 `--slot-*`（不是硬编码；
  //      源码里也是 `var(--slot)`，规则体里一个十六进制色都没有）。
  //   ④ **折叠 = 纯视图**：点折叠控件 ⇒ 那一支的行**真的从 DOM 里消失**（不是 CSS 把它藏起来）＋ `aria-expanded` 如实；
  //      折叠 / 展开前后 `exportDoc()` **逐字节相同**、撤销栈一个指针不动（折叠不进历史）。
  //
  // 会话树的实测口径（本组在真 Chromium 里跨 5 层量的原始读数）：缩进是**行自己的** `margin-inline-start =
  // min(depth,6) × .65rem`（`.65rem = 10.4px`），`padding-inline-start` 恒为 0，缩进段里没有元素、
  // 没有伪元素；每一行**只有一条** 3px 槽（它自己那条 `border-inline-start`，`--slot-*` 上色）。
  //
  // 四条反证臂各改一处（都在**副本**上）：`indent-per-level-slot`（缩进改回「每层一段槽」⇒ ①②红）、
  // `slot-hardcoded`（行自身那条槽的颜色写死 ⇒ ③红）、`fold-cosmetics-only`（折叠只用 CSS 藏、子行还在
  // DOM 里 ⇒ ④红，而 `layers:fold-aria` 该留绿）、`fold-aria-lying`（`aria-expanded` 写死 `true` ⇒
  // `layers:fold-aria` 红，而 ④ 该留绿）。
  await evalIn(`window.__layerRowOf = (id) => {
    const measure = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
    const node = document.querySelector('#dz-layers .dz-layer[data-layer="' + id + '"]');
    if (!node) return { id, inDom: false };
    const cs = getComputedStyle(node);
    const fold = node.querySelector(':scope > .dz-fold');
    const main = node.querySelector('.dz-row-main');
    const before = getComputedStyle(node, '::before');
    const after = getComputedStyle(node, '::after');
    const box = measure(node);
    const container = document.querySelector('#dz-layers');
    const containerStyle = getComputedStyle(container);
    const containerLeft = container.getBoundingClientRect().left + parseFloat(containerStyle.borderLeftWidth) + parseFloat(containerStyle.paddingLeft);
    // 缩进区（该层行左缘往左那一段）里，落在 #dz-layers 里的最上面那个元素是谁：应当是容器本身。
    const gutterX = Math.max(containerLeft + 0.5, box.left - 1);
    const hit = document.elementsFromPoint(gutterX, box.cy).find((el) => el.closest && el.closest('#dz-layers')) || null;
    return {
      id, inDom: true,
      depth: Number(node.dataset.depth),
      tag: node.tagName,
      role: node.getAttribute('role'),
      ariaSelected: node.getAttribute('aria-selected'),
      tabIndex: node.tabIndex,
      foldedFlag: node.dataset.folded ?? null,
      marginInlineStart: cs.marginInlineStart,
      paddingLeft: cs.paddingLeft,
      backgroundImage: cs.backgroundImage,
      ownSlot: { width: cs.borderInlineStartWidth, style: cs.borderInlineStartStyle, color: cs.borderInlineStartColor },
      box,
      // 缩进区里**不许**有槽/引导元素（按层生成的都不行）。
      indentEls: [...node.querySelectorAll('.dz-indent, .dz-indent-slot, [class*="indent"], [class*="guide"]')].length,
      directChildClasses: [...node.children].map((child) => child.className),
      pseudo: {
        before: { content: before.content, backgroundImage: before.backgroundImage, display: before.display },
        after: { content: after.content, backgroundImage: after.backgroundImage, display: after.display },
      },
      gutterTop: hit === null ? null : { id: hit.id || null, cls: hit.className || null, isContainer: hit === container },
      fold: fold === null ? null : {
        tag: fold.tagName,
        className: fold.className,
        layer: fold.dataset.foldLayer ?? null,
        expanded: fold.getAttribute('aria-expanded'),
        label: fold.getAttribute('aria-label'),
        text: fold.textContent,
        borderInlineStartWidth: getComputedStyle(fold).borderInlineStartWidth,
        box: measure(fold),
      },
      mainLeft: measure(main).left,
      mainText: main.textContent,
    };
  }`);
  const layerRowOf = (id) => evalIn(`window.__layerRowOf(${JSON.stringify(id)})`);
  const layerPanelCount = () => evalIn(`document.querySelectorAll('#dz-layers .dz-layer').length`);

  let layerIds = null;
  await groupCheck('layer-panel', async () => {
    // ── 期望值来自**真会话树**：另起一页（真 Chromium）量 4 层嵌套的行缩进 ────────────────────────
    // 业主 2026-09-27 更正：缩进要「和我们的会话树一样」。所以这里不写死一个常数，而是当场量会话树。
    const treeIndent = await (async () => {
      const ids = {
        root: 'a1a1a1a1-1111-4111-8111-111111111111',
        d1: 'b2b2b2b2-2222-4222-8222-222222222222',
        d2: 'c3c3c3c3-3333-4333-8333-333333333333',
        d3: 'd4d4d4d4-4444-4444-8444-444444444444',
        d4: 'e5e5e5e5-5555-4555-8555-555555555555',
        sib: 'f6f6f6f6-6666-4666-8666-666666666666',
      };
      const quiet = () => ({ notifies: [], waitingFor: [] });
      const sessions = [
        { id: ids.root, name: '根', status: 'idle', statusLabel: '闲置', archived: false, parentId: null, modifiedAt: '2026-09-25T10:00:00.000Z', notify: quiet() },
        { id: ids.d1, name: '深 1', status: 'idle', statusLabel: '闲置', archived: false, parentId: ids.root, modifiedAt: '2026-09-25T09:00:00.000Z', notify: quiet() },
        { id: ids.d2, name: '深 2', status: 'idle', statusLabel: '闲置', archived: false, parentId: ids.d1, modifiedAt: '2026-09-25T08:00:00.000Z', notify: quiet() },
        { id: ids.d3, name: '深 3', status: 'idle', statusLabel: '闲置', archived: false, parentId: ids.d2, modifiedAt: '2026-09-25T07:30:00.000Z', notify: quiet() },
        { id: ids.d4, name: '深 4', status: 'idle', statusLabel: '闲置', archived: false, parentId: ids.d3, modifiedAt: '2026-09-25T07:00:00.000Z', notify: quiet() },
        { id: ids.sib, name: '另一条顶层', status: 'working', statusLabel: '工作中', archived: false, parentId: null, modifiedAt: '2026-09-25T06:00:00.000Z', notify: quiet() },
      ];
      const settingsHome = await mkdtemp(path.join(os.tmpdir(), 'sopho-designer-ui-tree-home-'));
      const settingsStore = createUiSettingsStore({
        file: path.join(settingsHome, UI_SETTINGS_FILE_NAME),
        writeJson: async (target, value) => { await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); },
      });
      const routes = async (request, response, url) => {
        const p = url.pathname;
        if (p === '/api/host') return sendJson(response, 200, { ok: true }), true;
        if (p === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] }), true;
        if (p === '/api/settings') return sendJson(response, 200, await settingsStore.read()), true;
        if (p === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null } }), true;
        if (p === '/api/tree/events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
          return true;
        }
        const m = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|annotations))?$/.exec(p);
        if (m) {
          const action = m[2] ?? null;
          if (action === null) { sendJson(response, 200, { name: '根', cwd: root, archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }); return true; }
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
      const treePage = await boot({ width: VIEWPORT.width, height: VIEWPORT.height, webRoot, routes });
      const treeProblems = [];
      try {
        await treePage.waitFor(() => treePage.evaluate(`document.querySelector('[data-active-tree-list="true"]') && document.querySelectorAll('[data-active-tree-list="true"] > .tree-session').length === 6`), '会话树没渲染出 6 条行（本组的期望值取不到）');
        await treePage.frames(3);
        return await treePage.evaluate(`(() => {
          const list = document.querySelector('[data-active-tree-list="true"]');
          const listStyle = getComputedStyle(list);
          const listRect = list.getBoundingClientRect();
          const contentLeft = listRect.left + parseFloat(listStyle.borderLeftWidth) + parseFloat(listStyle.paddingLeft);
          return {
            contentLeft,
            rows: [...list.querySelectorAll(':scope > .tree-session')].map((row) => {
              const rect = row.getBoundingClientRect();
              const cs = getComputedStyle(row);
              const select = row.querySelector('.tree-select');
              return {
                id: row.dataset.sessionId,
                depth: Number(row.dataset.depth),
                left: rect.left, right: rect.right, height: rect.height,
                marginInlineStart: cs.marginInlineStart, paddingInlineStart: cs.paddingInlineStart,
                slotWidth: cs.borderInlineStartWidth, slotStyle: cs.borderInlineStartStyle, slotColor: cs.borderInlineStartColor,
                indentEls: row.querySelectorAll('.dz-indent, .dz-indent-slot, [class*="indent"], [class*="guide"]').length,
                beforeContent: getComputedStyle(row, '::before').content,
                afterContent: getComputedStyle(row, '::after').content,
                childCount: row.children.length,
                children: [...row.children].map((child) => child.tagName + '.' + (child.className || '')),
                labelLeft: select.getBoundingClientRect().left,
              };
            }),
          };
        })()`);
      } finally {
        await treePage.close(treeProblems);
        for (const problem of treeProblems) problems.push(`图层期望值（会话树实测页）收尾：${problem}`);
        await rm(settingsHome, { recursive: true, force: true }).catch(() => {});
      }
    })();
    const treeByDepth = (depth) => treeIndent.rows.filter((row) => row.depth === depth);
    const treeStep = treeByDepth(1)[0].left - treeByDepth(0)[0].left;
    const treeLabelStep = treeByDepth(1)[0].labelLeft - treeByDepth(0)[0].labelLeft;
    check('layers:tree-shape-measured', '期望值先量出来（本组另起一页真 Chromium 量**本仓会话树**）：4 层嵌套下缩进是**行自己的 margin**'
      + '（`min(depth,6) × .65rem`）、缩进段里**没有元素**（也没有伪元素）、每行只有**它自己**一条 3px 槽 —— 这就是图层行要对齐的形状',
      treeIndent.rows.length === 6 && treeByDepth(0).length === 2 && treeByDepth(1).length === 1 && treeByDepth(2).length === 1
      && treeByDepth(3).length === 1 && treeByDepth(4).length === 1
      && treeIndent.rows.every((row) => row.paddingInlineStart === '0px' && row.indentEls === 0
        && row.beforeContent === 'none' && row.afterContent === 'none'
        && row.slotWidth === '3px' && row.slotStyle === 'solid')
      && Math.abs(treeStep - treeLabelStep) <= 1 / 64 && Math.abs(treeStep - 10.4) <= 1 / 64,
      JSON.stringify({ 每级步进: Number(treeStep.toFixed(4)), 标签步进: Number(treeLabelStep.toFixed(4)),
        行左缘: treeIndent.rows.map((row) => Number(row.left.toFixed(4))),
        paddingInlineStart: treeIndent.rows.map((row) => row.paddingInlineStart),
        侧缩进段内元素数: treeIndent.rows.reduce((sum, row) => sum + row.indentEls, 0),
        伪元素content: treeIndent.rows.map((row) => [row.beforeContent, row.afterContent]),
        槽: treeIndent.rows.map((row) => `${row.slotWidth}/${row.slotStyle}/${row.slotColor}`),
        子元素: treeIndent.rows.map((row) => row.children) }));

    // ── 夹具：4 层嵌套（屏根 → A → B → C → D）＋ A 下面再挂一个叶子 E ──────────────────────────
    layerIds = await evalIn(`(() => {
      const api = window.sophoDesigner;
      const a = api.addNode(null, { type: 'container', name: 'L-A' });
      const b = api.addNode(a.id, { type: 'container', name: 'L-B' });
      const c = api.addNode(b.id, { type: 'container', name: 'L-C' });
      const d = api.addNode(c.id, { type: 'rect', name: 'L-D' });
      const e = api.addNode(a.id, { type: 'text', name: 'L-E' });
      api.select(null);
      return { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id };
    })()`);
    await frames(2);
    const tokens = await evalIn(`(() => {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden';
      document.body.appendChild(el);
      const read = (name) => { el.style.background = getComputedStyle(document.documentElement).getPropertyValue(name); return getComputedStyle(el).backgroundColor; };
      const out = {};
      for (const name of ['--slot-idle', '--slot-dark', '--slot-user']) out[name] = read(name);
      el.remove();
      return out;
    })()`);
    const rowsBefore = await layerPanelCount();
    const bytesBefore = await evalIn(`window.sophoDesigner.exportDoc()`);
    const historyBefore = await evalIn(`window.__dz.historyIndex()`);
    const chain = [await layerRowOf(layerIds.a), await layerRowOf(layerIds.b), await layerRowOf(layerIds.c), await layerRowOf(layerIds.d)];
    const leafE = await layerRowOf(layerIds.e);
    const rowsForIndent = [chain[0], chain[1], chain[2], chain[3], leafE];

    // ── ① 缩进 = 留白（与会话树同一条画法）─────────────────────────────────────────────
    const blankRows = rowsForIndent.every((row) => row.inDom === true && row.indentEls === 0
      && row.pseudo.before.content === 'none' && row.pseudo.after.content === 'none'
      && row.pseudo.before.backgroundImage === 'none' && row.pseudo.after.backgroundImage === 'none'
      && row.backgroundImage === 'none');
    // depth=0 的缩进区宽度为 0，探针只对有缩进的那几行有意义。
    const gutterBlank = chain.every((row) => row.gutterTop !== null && row.gutterTop.isContainer === true);
    check('layers:indent-blank', '缩进区是**空白**（与会话树的画法逐条同形）：每行的行内**没有**任何按层生成的槽/引导元素'
      + '（`indentEls === 0`：没有 `.dz-indent`/`.dz-indent-slot`，也没有别的 `*indent*`/`*guide*` 元素）、'
      + '`::before`/`::after` 的 `content` 是 `none`、行不画背景图；并在缩进那一格上用 `elementsFromPoint()` 量：'
      + '落在最上面的元素是图层容器本身（**没有任何行/槽盖住缩进区**）',
      blankRows && gutterBlank,
      JSON.stringify({ blankRows, gutterBlank, rows: rowsForIndent.map((row) => ({
        depth: row.depth, indentEls: row.indentEls, directChildren: row.directChildClasses,
        before: row.pseudo.before, after: row.pseudo.after, bg: row.backgroundImage, gutter: row.gutterTop,
      })) }));

    // ── ② 与会话树同形：逐层步进量 == 上面真量出来的 treeStep ────────────────────────────────
    const stepTol = 1 / 64;
    const mainSteps = [chain[1].mainLeft - chain[0].mainLeft, chain[2].mainLeft - chain[1].mainLeft, chain[3].mainLeft - chain[2].mainLeft];
    const leftSteps = [chain[1].box.left - chain[0].box.left, chain[2].box.left - chain[1].box.left, chain[3].box.left - chain[2].box.left];
    const stepOk = mainSteps.every((step) => Math.abs(step - treeStep) <= stepTol)
      && leftSteps.every((step) => Math.abs(step - treeStep) <= stepTol)
      && rowsForIndent.every((row) => row.paddingLeft === chain[0].paddingLeft)
      && Math.abs(leafE.mainLeft - chain[1].mainLeft) <= 0.5;
    check('layers:indent-step', '缩进的**逐层步进量与会话树同值**（期望值是上面那条真量出来的 `treeStep`，不是写死的常数）：'
      + '图层 depth1→2→3→4 的**标签左缘**与**行左缘**逐级步进都 == 会话树的步进；各行 `padding-left` 相同；'
      + '**同一层的叶子行与有子项的行标签左缘相同**（折叠格是占位，不把叶子往左挤）',
      stepOk,
      JSON.stringify({ treeStep: Number(treeStep.toFixed(4)), mainSteps: mainSteps.map((v) => Number(v.toFixed(4))),
        leftSteps: leftSteps.map((v) => Number(v.toFixed(4))), paddingLefts: rowsForIndent.map((r) => r.paddingLeft),
        mainLefts: rowsForIndent.map((r) => Number(r.mainLeft.toFixed(4))), leafVsFolder: Number((leafE.mainLeft - chain[1].mainLeft).toFixed(4)) }));

    // ── ③ 行自身那条槽：宽恰好 --design-slot-width（3px）、色只取自 --slot-* ────────────────
    const slotWidthOk = rowsForIndent.every((row) => row.ownSlot.width === '3px' && row.ownSlot.style === 'solid');
    check('layers:slot-width', '每行**只有它自己那一条** 3px 槽（与会话树同形）：实测 `border-inline-start-width` 恰好 `3px`、'
      + '`solid`（`--design-slot-width` 在本页的降级值就是 3px）；缩进不再往行里塞额外槽/引导元素（上一条已量 `indentEls === 0`）',
      slotWidthOk,
      JSON.stringify({ ownSlot: rowsForIndent.map((row) => ({ depth: row.depth, ...row.ownSlot })), indentEls: rowsForIndent.map((r) => r.indentEls) }));

    const tokenColors = Object.values(tokens);
    const ownSlotColorOk = rowsForIndent.every((row) => row.ownSlot.color === tokens['--slot-idle'] && tokenColors.includes(row.ownSlot.color));
    check('layers:slot-color', '行自身那条槽的颜色**来自 `--slot-*`**：实测 `border-inline-start-color` == 运行时从 `:root` 读到的 '
      + '`--slot-idle` 的解析值（不是测试里写死的常数，也不是内联色 —— 行是 `div`，色由 `designer.css` 落到 `--slot-idle`）',
      ownSlotColorOk,
      JSON.stringify({ ownSlotColorOk, tokenIdle: tokens['--slot-idle'], ownSlotColors: rowsForIndent.map((r) => r.ownSlot.color) }));

    // 源码侧：**服务端真的送出去的那一份**（本门沙箱里的 `web/` 副本）—— 反证臂改的就是副本，读真树的话这条对臂是瞎的。
    const servedCss = await readFile(path.join(webRoot, 'designer.css'), 'utf8');
    const cssRuleOf = (text, selector) => {
      const found = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(text);
      return found ? found[1] : '';
    };
    const layerRule = cssRuleOf(servedCss, '.dz-layers .dz-layer');
    const slotSourceOk = /border-inline-start:\s*var\(--design-slot-width,\s*3px\)\s*solid\s*var\(--slot\)/.test(layerRule)
      && !/#[0-9a-fA-F]{3,8}/.test(layerRule);
    check('layers:slot-source', '行自身那条槽在**源码**里就是 `var(--slot)`（不是色值）：`designer.css` 的 `.dz-layers .dz-layer` 规则里 '
      + '`border-inline-start: var(--design-slot-width, 3px) solid var(--slot)`，且规则体里**一个十六进制色都没有**',
      slotSourceOk, JSON.stringify({ layerRule }));

    const servedJs = await readFile(path.join(webRoot, 'designer.js'), 'utf8');
    const indentSourceOk = servedJs.includes('[SEAM:layer-indent]')
      && /row\.style\.marginInlineStart = `\$\{Math\.min\(depth, 6\) \* \.65\}rem`;/.test(servedJs)
      && !servedCss.includes('.dz-indent');
    check('layers:indent-source', '缩进在**源码**里也与会话树同一条几何：`designer.js` 的那行是 '
      + '`row.style.marginInlineStart = `${Math.min(depth, 6) * .65}rem``（与 `web/render.js` 写会话行的那行逐字同形）；'
      + '`designer.css` 里**没有** `.dz-indent` 这类按层槽的规则',
      indentSourceOk, JSON.stringify({ hasSeam: servedJs.includes('[SEAM:layer-indent]'), cssHasDzIndent: servedCss.includes('.dz-indent') }));

    // ── ①′ 屏/状态列表行（`.dz-row`，是 `<button>`）那条槽也**只有一个来源**：全站共享原语 ────────
    // 改前 `designer.css` 的 `.dz-row` 里还有一句 `border-left: 3px solid var(--dz-slots)` ——
    // 它被 `slot.css` 那条 `!important` 压着、**从来没画出来过**（真 Chromium 实测，改动前量过），
    // 而且它给槽色开了个不在 `--slot-*` 里的 token。所以这条断言有两条腿：
    //   · 源码腿：`designer.css` 里不再出现 `--dz-slots`（先剥掉注释再找 —— 注释里会提到它）；
    //   · 测量腿：实测行槽仍是 `3px solid` ＋ `--slot-idle` 的解析色（与会话树/图层行同色）。
    // ⚠️ 反证臂 `dz-row-dead-slot-token` **只能红源码那一条腿** —— 那句本来就是死的，测量腿
    //   不会动。这是**如实**的：这个缺陷在像素上不可观测，能守的就是「源码不许再开第二个 token」。
    const listRowProbe = await evalIn(`(() => {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'dz-row';
      const main = document.createElement('span'); main.className = 'dz-row-main'; main.textContent = '屏';
      row.appendChild(main);
      document.body.appendChild(row);
      const cs = getComputedStyle(row);
      const out = { width: cs.borderInlineStartWidth, style: cs.borderInlineStartStyle, color: cs.borderInlineStartColor };
      row.remove();
      return out;
    })()`);
    const servedCssNoComments = servedCss.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const listRowSourceOk = !servedCssNoComments.includes('--dz-slots');
    const listRowColorOk = listRowProbe.width === '3px' && listRowProbe.style === 'solid' && listRowProbe.color === tokens['--slot-idle'];
    check('layers:list-row-slot-source', '屏/状态列表行（`.dz-row`，是 `<button>`）那条槽也**只有一个来源**：全站共享原语 '
      + '（`web/slot.css`），颜色只取 `--slot-*` —— `designer.css` 里不再有 `--dz-slots` 这个**第二个槽色 token**'
      + '（改前那句 `border-left: 3px solid var(--dz-slots)` 被原语压着、从来没画出来过），且实测行槽的色'
      + '就是 `--slot-idle` 的解析值（与列表里的图层行同色）',
      listRowSourceOk && listRowColorOk,
      JSON.stringify({ listRowSourceOk, listRowColorOk, listRowProbe, tokenIdle: tokens['--slot-idle'] }));

    // ── ②′ 逐元素撤销开关 `data-slot="off"` 在**按钮**上真的关得掉槽 ────────────────────────────
    // 它由全站共享原语自己的 `@layer slot-off` 保证（与特异性无关）。改前它是裸规则 (0,1,0)，
    // 被大名单里 `button:not(…)×7` 的 (0,7,1) `!important` 压着 ⇒ `web/index.html` 上真写着
    // `data-slot="off"` 的 `#session-notice-close` / `#suggestions-close` 实测仍是 3px（形同虚设）。
    const offSwitch = await evalIn(`(() => {
      const mk = (off) => {
        const b = document.createElement('button'); b.type = 'button'; if (off) b.dataset.slot = 'off';
        document.body.appendChild(b);
        const cs = getComputedStyle(b);
        const out = { width: cs.borderInlineStartWidth, color: cs.borderInlineStartColor };
        b.remove();
        return out;
      };
      const off = mk(true);
      const on = mk(false);
      const input = document.createElement('input'); input.dataset.slot = 'off';
      document.body.appendChild(input);
      const inputOff = getComputedStyle(input).borderInlineStartWidth;
      input.remove();
      return { off, on, inputOff };
    })()`);
    check('slot:off-switch', '逐元素撤销开关 `data-slot="off"` 在**按钮**上真的关得掉那条槽（共享原语的 `@layer slot-off` '
      + '与特异性无关）：`<button data-slot="off">` 实测 `border-inline-start-width` 是 `0px`，同一页**不带 off** 的按钮'
      + '仍是 `3px`（不是把整页槽关掉），`input[data-slot="off"]` 也是 `0px`（本来就 0，换层后不回退）；'
      + '`web/index.html` 上那两个 `data-slot="off"` 的×按钮（`#session-notice-close` / `#suggestions-close`）由此才真的不吃槽',
      offSwitch.off.width === '0px' && offSwitch.on.width === '3px' && offSwitch.inputOff === '0px',
      JSON.stringify(offSwitch));

    // ── 折叠控件本身：有子项 = **真 `<button>`**；没子项 = 占位；控件自己不吃一条槽 ────────────
    const folders = chain.slice(0, 3);   // A / B / C：有子项的 container
    const leaves = [chain[3], leafE];    // D（depth 4）/ E（depth 2）：叶子 —— 两个都量，才盖住「同层的叶子与有子项的行对齐」（B 与 E 都在 depth 2）
    const foldShape = folders.every((row) => row.fold !== null && row.fold.tag === 'BUTTON' && row.fold.layer === row.id
      && row.fold.expanded === 'true' && typeof row.fold.label === 'string' && row.fold.label.length > 0
      && row.fold.text === '▾' && row.fold.borderInlineStartWidth === '0px')
      && leaves.every((row) => row.fold !== null && row.fold.tag === 'SPAN'
        && row.fold.className.includes('dz-fold-empty') && row.fold.expanded === null)
      && Math.abs(chain[1].fold.box.width - leafE.fold.box.width) <= 0.5;   // 同层（depth 2）的 B 与 E：占位格同宽
    check('layers:fold-control-shape', '折叠控件是**真的 `<button>`**（有子项的行才有）：带 `aria-expanded="true"`、`aria-label`、`data-fold-layer`、`▾`；'
      + '叶子行是 `.dz-fold-empty` 占位（同宽 ⇒ 同层标签对齐）。折叠控件**自己不吃一条槽**（实测 `border-inline-start-width` 是 `0px`）：'
      + '否则每行都会多出一段**假的**层级。压住这条共享槽的有两条（都留）：`designer.css` 的 id 作用域规则'
      + '（`#dz-layers .dz-layer > .dz-fold`，1,2,0）与它自带的 `data-slot="off"` —— 后者 2026-09-27 前是裸规则、'
      + '压不过（0,1,0 vs 0,7,1），现已换到 `@layer slot-off`（见 `slot:off-switch`）',
      foldShape,
      JSON.stringify({ foldShape, folders: folders.map((row) => ({ id: row.id, tag: row.fold?.tag, layer: row.fold?.layer,
        expanded: row.fold?.expanded, text: row.fold?.text, border: row.fold?.borderInlineStartWidth })),
        leaves: leaves.map((row) => ({ id: row.id, tag: row.fold?.tag, className: row.fold?.className, expanded: row.fold?.expanded,
          width: Math.round((row.fold?.box.width ?? 0) * 100) / 100 })) }));

    // ── ② 折叠（真鼠标点控件）：子树**真的从 DOM 里消失** ＋ aria 如实 ＋ 纯视图 ────────────────
    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.c}"]`);
    const foldedC = await layerRowOf(layerIds.c);
    const foldedD = await layerRowOf(layerIds.d);
    const stillE = await layerRowOf(layerIds.e);
    const rowsFolded = await layerPanelCount();
    check('layers:fold-hides', '点 C 的折叠控件 ⇒ **C 的子行 D 真的不在 DOM 里了**（不是 `display:none`：`querySelector` 找不到它，'
      + '而图层行总数恰好少 1）；C 自己的行还在（带着 `▸`），**同一层的 E 照旧在**',
      foldedD.inDom === false && foldedC.inDom === true && stillE.inDom === true && rowsFolded === rowsBefore - 1,
      JSON.stringify({ rowsBefore, rowsFolded, d: foldedD, c: { inDom: foldedC.inDom, text: foldedC.fold?.text, expanded: foldedC.fold?.expanded, foldedFlag: foldedC.foldedFlag }, e: stillE.inDom }));

    check('layers:fold-aria', '折叠控件**如实说**自己折了：折叠后 `aria-expanded="false"`、字形 `▸`、行上 `data-folded="true"`'
      + '（三者一致 —— 折叠态不是「藏起来还说自己开着」）',
      foldedC.fold?.expanded === 'false' && foldedC.fold?.text === '▸' && foldedC.foldedFlag === 'true',
      JSON.stringify({ expanded: foldedC.fold?.expanded, text: foldedC.fold?.text, foldedFlag: foldedC.foldedFlag, label: foldedC.fold?.label }));

    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.c}"]`);
    const unfoldedC = await layerRowOf(layerIds.c);
    const unfoldedD = await layerRowOf(layerIds.d);
    const rowsBack = await layerPanelCount();
    check('layers:fold-unfold', '再点一次 ⇒ 子行**回来了**：D 回到 DOM 里、行数恢复、`aria-expanded="true"`、字形 `▾`、`data-folded="false"`；'
      + '且 D 的**位置（缩进）与折叠前逐层相同**（折叠/展开不动缩进）',
      unfoldedD.inDom === true && rowsBack === rowsBefore && unfoldedC.fold?.expanded === 'true'
      && unfoldedC.fold?.text === '▾' && unfoldedC.foldedFlag === 'false'
      && Math.abs(unfoldedD.mainLeft - chain[3].mainLeft) <= 0.5 && Math.abs(unfoldedD.box.left - chain[3].box.left) <= 0.5,
      JSON.stringify({ rowsBack, rowsBefore, d: unfoldedD.inDom, expanded: unfoldedC.fold?.expanded, foldedFlag: unfoldedC.foldedFlag,
        dMainLeft: Number(unfoldedD.mainLeft.toFixed(4)), expectedMainLeft: Number(chain[3].mainLeft.toFixed(4)), dIndentEls: unfoldedD.indentEls }));

    const bytesAfter = await evalIn(`window.sophoDesigner.exportDoc()`);
    const historyAfter = await evalIn(`window.__dz.historyIndex()`);
    check('layers:fold-pure-view', '折叠是**纯视图**（与 `[SEAM:view-zoom]`／`[SEAM:view-pan]` 同一条纪律）：折叠 ⇒ 展开一趟之后 '
      + '`exportDoc()` **逐字节相同**、撤销栈指针一动没动（折叠不进历史、也不上屏一个「可撤销」的改动）',
      bytesAfter === bytesBefore && historyAfter === historyBefore,
      JSON.stringify({ bytes: [bytesBefore.length, bytesAfter.length], same: bytesAfter === bytesBefore, history: [historyBefore, historyAfter] }));

    // ── 点折叠 ≠ 点这一行（选中归选中，折叠归折叠）─────────────────────────────────────────
    await evalIn(`window.sophoDesigner.select(${JSON.stringify(layerIds.b)})`);
    await frames(2);
    await clickSelector(`#dz-layers .dz-layer[data-layer="${layerIds.c}"]`);
    const cAfterRowClick = await layerRowOf(layerIds.c);
    const selectionAfterRowClick = await evalIn(`window.__dz.selection()`);
    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.c}"]`);
    const selectionAfterFoldClick = await evalIn(`window.__dz.selection()`);
    const cAfterFoldClick = await layerRowOf(layerIds.c);
    check('layers:fold-click-not-select', '两条路互不挤：点**这一行的别处** ⇒ 选中这一行（真鼠标，与点画布同一个 `selectElement()`）'
      + '而且**不会顺手把它折了**（`aria-expanded` 仍是 `true`）；点**折叠控件** ⇒ 折叠生效（`false`）但**选中不变**（刚才选的行还是那一行）',
      cAfterRowClick.ariaSelected === 'true' && cAfterRowClick.role === 'option' && cAfterRowClick.fold?.expanded === 'true'
      && JSON.stringify(selectionAfterRowClick) === JSON.stringify([layerIds.c])
      && cAfterFoldClick.fold?.expanded === 'false'
      && JSON.stringify(selectionAfterFoldClick) === JSON.stringify([layerIds.c]),
      JSON.stringify({ selectionAfterRowClick, selectionAfterFoldClick,
        c: { role: cAfterRowClick.role, ariaSelected: cAfterRowClick.ariaSelected, expandedAfterRowClick: cAfterRowClick.fold?.expanded, expandedAfterFoldClick: cAfterFoldClick.fold?.expanded } }));
    // 收摊：把 C 折回来，下面那条「4 层」从干净状态起
    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.c}"]`);

    // ── ③ 4 层嵌套：折最外面那一支 ⇒ 4 个后代行全不在 DOM 里；展开后缩进逐层照旧 ────────────────
    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.a}"]`);
    const deepFolded = await evalIn(`(() => ({
      rows: [...document.querySelectorAll('#dz-layers .dz-layer')].map((row) => row.dataset.layer),
      a: document.querySelector('#dz-layers .dz-layer[data-layer="${layerIds.a}"]') !== null,
      aFold: document.querySelector('.dz-fold[data-fold-layer="${layerIds.a}"]')?.getAttribute('aria-expanded') ?? null,
      aGlyph: document.querySelector('.dz-fold[data-fold-layer="${layerIds.a}"]')?.textContent ?? null,
    }))()`);
    const goneDeep = await evalIn(`(() => ({
      b: document.querySelector('#dz-layers .dz-layer[data-layer="${layerIds.b}"]') !== null,
      c: document.querySelector('#dz-layers .dz-layer[data-layer="${layerIds.c}"]') !== null,
      d: document.querySelector('#dz-layers .dz-layer[data-layer="${layerIds.d}"]') !== null,
      e: document.querySelector('#dz-layers .dz-layer[data-layer="${layerIds.e}"]') !== null,
    }))()`);
    check('layers:fold-deep', '4 层嵌套（屏根 → A → B → C → D）下折叠最外面那一支 A（depth=1）⇒ **它下面 4 个后代行（含深到第 4 层的 D）全不在 DOM 里**，'
      + '只剩 A 自己那一行（带 `▸`、`aria-expanded="false"`）',
      deepFolded.a === true && deepFolded.aFold === 'false' && deepFolded.aGlyph === '▸'
      && goneDeep.b === false && goneDeep.c === false && goneDeep.d === false && goneDeep.e === false
      && deepFolded.rows.length === rowsBefore - 4 && deepFolded.rows.includes(layerIds.a),
      JSON.stringify({ deepFolded, goneDeep, rowsBefore }));
    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.a}"]`);
    const backChain = [await layerRowOf(layerIds.a), await layerRowOf(layerIds.b), await layerRowOf(layerIds.c), await layerRowOf(layerIds.d)];
    check('layers:fold-deep-unfold', '展开回来 ⇒ 4 层全在，且**每层的行位置（缩进）与折叠前逐层相同**（折叠/展开不动缩进）',
      await layerPanelCount() === rowsBefore
      && backChain.every((row, index) => row.inDom === true && row.depth === index + 1
        && Math.abs(row.box.left - chain[index].box.left) <= 0.5 && Math.abs(row.mainLeft - chain[index].mainLeft) <= 0.5),
      JSON.stringify({ rows: await layerPanelCount(), lefts: backChain.map((row) => Number(row.box.left.toFixed(4))),
        expected: chain.map((row) => Number(row.box.left.toFixed(4))), depths: backChain.map((row) => row.depth) }));

    // ── 折叠态在一次会话里记得住：切视图（renderAll 重画）后还在 ────────────────────────────
    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.a}"]`);
    const beforeSwitch = await layerPanelCount();
    await clickSelector('#dz-view-flow');
    await clickSelector('#dz-view-edit');
    const afterSwitch = await layerRowOf(layerIds.a);
    check('layers:fold-kept-in-session', '折叠态是**会话内的视图状态**：切到「流程 · 箭头」再切回「编辑屏」（两次全量重画）之后，A 那一支**还是折着的**'
      + '（`aria-expanded="false"`、`▸`、行数仍是折后的那个数）',
      afterSwitch.inDom === true && afterSwitch.fold?.expanded === 'false' && afterSwitch.fold?.text === '▸'
      && await layerPanelCount() === beforeSwitch,
      JSON.stringify({ beforeSwitch, afterSwitch: { expanded: afterSwitch.fold?.expanded, text: afterSwitch.fold?.text }, rows: await layerPanelCount() }));
    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.a}"]`);

    // ── 折叠把**当前选中项**的行藏起来时，控件如实说出来 ────────────────────────────────
    await evalIn(`window.sophoDesigner.select(${JSON.stringify(layerIds.d)})`);
    await frames(2);
    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.b}"]`);
    const noteRow = await layerRowOf(layerIds.b);
    const hiddenSelected = await layerRowOf(layerIds.d);
    const canvasStillHasSelected = await evalIn(`document.querySelector('#dz-frame .dz-el[data-id="${layerIds.d}"]') !== null`);
    check('layers:fold-selection-note', '折叠把**当前选中的元素**的行藏起来时，折叠控件**如实说出来**'
      + '（`aria-label` 里写明「当前选中的元素就在这一支里 · 展开才看得到它那一行」）—— 折叠只影响图层面板的呈现：'
      + '画布上那个元素照旧在（属性面板也照旧跟着它）',
      hiddenSelected.inDom === false && canvasStillHasSelected === true
      && typeof noteRow.fold?.label === 'string' && noteRow.fold.label.includes('当前选中的元素')
      && noteRow.fold.expanded === 'false' && noteRow.fold.label.includes('2 个子项'),
      JSON.stringify({ hiddenSelected: hiddenSelected.inDom, canvasStillHasSelected, label: noteRow.fold?.label }));
    await clickSelector(`.dz-fold[data-fold-layer="${layerIds.b}"]`);
    await evalIn(`window.sophoDesigner.select(null)`);
    await frames(2);

    // ── 静态：接缝在源码里（四条反证臂各改一处）─────────────────────────────────────────
    // ⚠️ 读**服务端真的送出去的那一份**（沙箱副本）—— 反证臂改的就是副本，读真树的话这条对臂是瞎的。
    const layerSeams = ['[SEAM:layer-fold]', '[SEAM:layer-indent]', '[SEAM:layer-slot]'];
    const missingLayerSeams = layerSeams.filter((seam) => !(servedJs.includes(seam) || servedCss.includes(seam)));
    check('layers:seams', '本单的接缝在源码里（`[SEAM:layer-fold]`：折叠唯一的读取点「折叠掉的支不再往下走」；'
      + '`[SEAM:layer-indent]`：缩进唯一的来源「与会话树同一条 margin 几何」；`[SEAM:layer-slot]`：行自身那条槽的颜色来源）'
      + '—— 四条反证臂各改一处',
      missingLayerSeams.length === 0, missingLayerSeams.length ? `缺：${JSON.stringify(missingLayerSeams)}` : layerSeams.join(' / '));
  });

  // ═══ 18. 全程零未捕获异常 / 零 console.error ══════════════════════════════════════════════
  check('page:clean', '全程零未捕获异常、零 console.error', page.pageProblems.length === 0, JSON.stringify(page.pageProblems));
} catch (error) {
  check('page:arm', '设计器那一臂跑完（没在断言之前抛异常）', false, error?.stack ?? String(error));
} finally {
  if (page) await page.close(problems);
}

// ── 真仓文件的读数 ──────────────────────────────────────────────────────────────────────────
// ⚠️ 判据**按归属**（2026-09-25 修）：
//   · **本门名下**（硬判据，是**观察**而不是本地常量）：`page.staticRoot` = `boot()` 真正解析出来的
//     服务根（`test/ui-harness.mjs` 的返回值里带它），必须在本门自己的 mkdtemp 沙箱里
//     ⇒ 真仓没进任何服务/写路径（将来谁把交给 `boot()` 的服务根改回 `WEB_ROOT`，它当场红）。
//   · 真仓那几份的 sha256 前后比较改成**只记录**：本门对真仓**没有写路径**（写都由沙箱拼出），
//     而真仓是**共享工作区**（人的终端、别的 landing 的脚本随时会改 web/** 与 spec/**）
//     ⇒ 拿它做前后对比就是把**别人的写**算在本门头上（同一个坑 `test/pre-push.mjs` 第 4 节踩过）。
{
  const servedRoot = page?.staticRoot ?? null;
  check('sandbox:served-root-is-sandboxed', '设计器服务的是**本门沙箱里**的 web/ 副本（真仓没进任何服务/写路径）',
    typeof servedRoot === 'string' && !path.relative(sandbox, servedRoot).startsWith('..') && path.resolve(servedRoot) !== path.resolve(WEB_ROOT),
    JSON.stringify({ servedRoot, sandbox, WEB_ROOT, handedWebRoot: webRoot }));
  const changed = [];
  for (const file of REAL_PRODUCT_FILES) {
    const before = hashesBefore.get(file);
    const after = await sha256(path.join(root, file)).catch(() => '(读不到)');
    if (before !== after) changed.push(`${file}（${String(before).slice(0, 8)} → ${String(after).slice(0, 8)}）`);
  }
  const observation = changed.length === 0
    ? `${REAL_PRODUCT_FILES.length} 份真产品文件在本门这一轮里 sha256 没变（写的是临时目录里的副本）`
    : { 变了: changed, 归属: '真仓是共享工作区（本门对真仓没有写路径）—— 别人的写不是本门的副作用' };
  process.stdout.write(`sandbox:real-files-observation（**只记录、不断言**）: ${typeof observation === 'string' ? observation : JSON.stringify(observation)}\n`);
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
  // 有的臂是「**失败那一侧必须绿**」：导出器被拿掉时，「如实报错」那两条恰恰是**该留着的**
  // （否则这条臂就红不出「静默失败」这个形状了）。
  const mustStayGreen = (arm.expectGreen ?? []).filter((id) => !checkIds.includes(id) || redIds.includes(id));
  if (notRed.length === 0 && mustStayGreen.length === 0) {
    process.stdout.write(`✓ 反证臂 ${ARM} 红到位（预期的每一条都红了${arm.expectGreen ? `；且 ${JSON.stringify(arm.expectGreen)} 仍然是绿的` : ''}）—— 这是**期望**的结果，不是缺陷\n`);
  } else {
    process.stdout.write(`✗ 反证臂 ${ARM} **没红到位**：没红的是 ${JSON.stringify(notRed)}${
      mustStayGreen.length ? `；本该留绿却红了/没跑到：${JSON.stringify(mustStayGreen)}` : ''} ⇒ 这道门是个假门\n`);
    process.exitCode = 1;
  }
} else {
  process.stdout.write(`\n──── test/designer-ui.mjs：${checks} 条断言 —— ${checks - failures.length} 绿 / ${failures.length} 红 ────\n`);
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
if (screenshots.length > 0) process.stdout.write(`截图（${screenshots.length} 张）：${screenshots.join(' / ')}\n`);

await removeSandbox(sandbox, problems, 'designer-ui sandbox');
finishCleanup(null, problems);
