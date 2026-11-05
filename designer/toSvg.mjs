// designer/toSvg.mjs —— 中立文档 ⇒ **确定 SVG**（纯 Node、零依赖、零外部请求）。
//
// 两样东西，各自一份产物：
//   ① `renderScreenSvg(doc, screenId)` —— 一屏的**静态** SVG。SVG 里没有 flex/grid，所以这里有一个
//      很小的布局引擎（自由布局 = 用 box 的绝对坐标；row/column/grid = 按语义算格位），
//      它**只**为「把同一份语义落到 SVG 坐标系」而存在。它与 `toHtml.mjs` 是两条独立实现，
//      门用**同一组期望数字**量两者的结果 ⇒ 两条路必须对同一份文档说同一件事。
//   ② `renderFlowSvg(doc)` —— 「屏 / 状态到哪去」的图：节点是 (屏, 状态)，**箭头全部由 `transitions` 生成**。
//      每根箭头都带 `data-transition="<转移 id>"`；**没有数据就没有箭头** —— 反证臂 `hardcoded-arrow`
//      就是往这里塞一根凭空的箭头（`test/designer-export.mjs` 会红）。
//      **标签**（`trigger` 那句话）落在**它自己那条连线**上、互不重叠、带不透明底，层在连线之上
//      （“屏卡 < 连线 < 标签”；规则与判据见 `docs/design/designer-exporters.md` §8.2）。
//      **起点**默认取 (屏,状态) 节点的中心；转移的 `from` 端带了可选的 `anchor.selector` 时，起点改取
//      **那个控件的盒子边**（朝向目标那一侧）—— 控件只存在于屏坐标系里，它的盒子按**逐轴比例**映进节点框
//      （节点是个紧凑盒子、不画屏内容；见 `anchorBoxOf()` 的注释）。没带 anchor 的转移一个字节不变。
//
// 不确定的地方（诚实）：`content`（由内容决定）在 SVG 里没有字体度量可用，本文件用**字符宽度估计**
// （CJK 算 1 个字号宽、其它算 0.55）—— 这是**近似**，门只对 `fixed` / `fill` / 位置断言（见
// docs/designer-exporters.md 的「没验到什么」）。HTML 那条路用的是浏览器的真度量。
//
// PNG：本文件**不**产 PNG（纯 Node 没有光栅化）。PNG 用真浏览器打开导出的 HTML 截
// （`test/designer-export.mjs` 有这条臂：`Page.captureScreenshot`）。

import { assertValidDocument, anchorElementId, containerModeOf, findElementById, stateTreeOf } from './validate.mjs';
import { docDigest } from './canonical.mjs';
import { expandTree } from './expand.mjs';
// 「一屏画多大」的判据只有一处（`toHtml.screenStageSize`）：SVG 与 HTML 必须对同一屏给出同一个尺寸，
// 所以这里从 toHtml 借它，而不是再抄一遍。
import { stageSizeOf, DEFAULT_VIEWPORT } from './toHtml.mjs';

const num = (value) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000));
const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `var(--token)` 追到具体值（token 表里的别名链；查不到就回落 null ⇒ 画 none）。 */
export function resolveColor(value, tokens = {}) {
  let current = value;
  for (let hop = 0; hop < 32; hop += 1) {
    if (typeof current !== 'string') return null;
    const match = /^\s*var\(\s*(--[a-zA-Z0-9_-]+)\s*\)\s*$/.exec(current);
    if (!match) return current;
    if (!(match[1] in tokens)) return null;
    current = tokens[match[1]];
  }
  return null;
}

function paddingOf(layout) {
  const value = layout?.padding;
  if (value === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof value === 'number') return { top: value, right: value, bottom: value, left: value };
  const [a, b = a, c = a, d = b] = value;
  return { top: a, right: b, bottom: c, left: d };
}

/** 字符宽度**估计**（只在 SVG 需要「由内容决定」的尺寸时用；见文件头）。 */
export function estimateTextExtent(text, fontSize = 14) {
  let width = 0;
  for (const char of String(text ?? '')) width += (char.codePointAt(0) > 0x2e7f ? 1 : 0.55) * fontSize;
  return { w: Math.round(width * 100) / 100, h: Math.round(fontSize * 1.4 * 100) / 100 };
}

/**
 * 一屏的布局：返回**平铺**的绘制清单（按文档顺序），每项是绝对坐标（相对屏的左上角）。
 * 自由布局只看 `box`；row/column/grid 按语义算格位（与 CSS 的 flex/grid 同一套规则：
 * 主轴先给 fixed、剩下的平分给 fill；交叉轴 fill = 铺满内容区）。
 */
export function layoutScreen(tree, viewport = DEFAULT_VIEWPORT) {
  const root = tree?.root ?? tree;
  const canvas = stageSizeOf(root, viewport);
  const drawList = [];

  const intrinsic = (element) => {
    const fontSize = element.style?.fontSize ?? 14;
    const estimate = estimateTextExtent(element.text ?? element.name ?? '', fontSize);
    const axis = (key, fallback) => {
      const constraint = element.size?.[key];
      if (constraint === undefined) return fallback;
      if (constraint.mode === 'fixed') return typeof constraint.value === 'number' ? constraint.value : fallback;
      if (constraint.mode === 'content') return key === 'w' ? estimate.w : estimate.h;
      return null; // fill：由父容器分配
    };
    return { axis, estimate, fontSize };
  };

  // 自由布局：位置与大小**只看 box**（与 CSS 绝对定位一一对应）
  const placeFree = (element) => {
    const box = { x: element.box.x, y: element.box.y, w: element.box.w, h: element.box.h };
    drawList.push({ element, box });
    const children = Array.isArray(element.children) ? element.children : [];
    if (children.length === 0) return;
    const layout = isObject(element.layout) ? element.layout : { mode: 'free' };
    if (layout.mode === 'free') for (const child of children) placeFree(child);
    else autoLayout(element, box, children, layout);
  };

  // 自动布局：把 children 排进一个已经定好的盒子 box 里（flex / grid 的语义）
  const autoLayout = (element, box, children, layout) => {
    const pad = paddingOf(layout);
    const gap = layout.gap ?? 0;
    const content = { w: Math.max(0, box.w - pad.left - pad.right), h: Math.max(0, box.h - pad.top - pad.bottom) };
    const emit = (child, slot) => {
      const childBox = { x: box.x + pad.left + slot.x, y: box.y + pad.top + slot.y, w: slot.w, h: slot.h };
      drawList.push({ element: child, box: childBox });
      const grand = Array.isArray(child.children) ? child.children : [];
      if (grand.length === 0) return;
      const childLayout = isObject(child.layout) ? child.layout : { mode: 'free' };
      if (childLayout.mode === 'free') for (const item of grand) placeFree(item);
      else autoLayout(child, childBox, grand, childLayout);
    };
    if (layout.mode === 'row' || layout.mode === 'column') {
      const isRow = layout.mode === 'row';
      const mainKey = isRow ? 'w' : 'h';
      const crossKey = isRow ? 'h' : 'w';
      const extents = children.map((child) => {
        const info = intrinsic(child);
        return { child, main: info.axis(mainKey, 'content'), cross: info.axis(crossKey, 'fill') };
      });
      const fillCount = extents.filter((item) => item.main === null).length;
      const fixedSum = extents.reduce((sum, item) => sum + (item.main ?? 0), 0);
      const available = (isRow ? content.w : content.h) - gap * (children.length - 1);
      const share = fillCount > 0 ? Math.max(0, available - fixedSum) / fillCount : 0;
      let cursor = 0;
      for (const item of extents) {
        const main = item.main === null ? share : item.main;
        const cross = item.cross === null ? (isRow ? content.h : content.w) : item.cross;
        emit(item.child, { x: isRow ? cursor : 0, y: isRow ? 0 : cursor, w: isRow ? main : cross, h: isRow ? cross : main });
        cursor += main + gap;
      }
      return;
    }
    const columns = Math.max(1, layout.columns ?? 1);
    const cellW = Math.max(0, (content.w - gap * (columns - 1)) / columns);
    const rows = [];
    children.forEach((child, index) => {
      const row = Math.floor(index / columns);
      rows[row] = rows[row] ?? { h: 0 };
      const height = intrinsic(child).axis('h', 'fill');
      if (height !== null) rows[row].h = Math.max(rows[row].h, height);
    });
    children.forEach((child, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const info = intrinsic(child);
      const w = info.axis('w', 'fill') ?? cellW;
      const h = info.axis('h', 'fill') ?? rows[row].h;
      const rowY = rows.slice(0, row).reduce((sum, item) => sum + item.h + gap, 0);
      emit(child, { x: column * (cellW + gap), y: rowY, w, h });
    });
  };

  const rootBox = { x: 0, y: 0, w: canvas.w, h: canvas.h };
  drawList.push({ element: root, box: rootBox });
  const children = Array.isArray(root.children) ? root.children : [];
  const mode = containerModeOf(root) ?? 'free';
  if (children.length > 0) {
    if (mode === 'free') for (const child of children) placeFree(child);
    else autoLayout(root, rootBox, children, isObject(root.layout) ? root.layout : { mode });
  }
  return { canvas, drawList };
}

function shapeOf(element, box, tokens) {
  const style = isObject(element.style) ? element.style : {};
  const fill = style.background !== undefined ? resolveColor(style.background, tokens) ?? 'none' : 'none';
  const borderWidth = typeof style.borderWidth === 'number' ? style.borderWidth : 0;
  const radius = typeof style.borderRadius === 'number' ? style.borderRadius : 0;
  // rect 的几何盒子**就是文档里那个盒子**（浏览器量 SVG 形状时给的是几何盒子，描边不算在里面 ——
  // 真 Chromium 实测：`getBoundingClientRect()` 忽略 stroke），所以门量出来的数 == 文档的数。
  const attrs = [
    `x="${num(box.x)}"`, `y="${num(box.y)}"`,
    `width="${num(Math.max(0, box.w))}"`, `height="${num(Math.max(0, box.h))}"`,
    `fill="${esc(fill)}"`,
  ];
  if (radius > 0) attrs.push(`rx="${num(radius)}"`);
  // 给了新字段 `style.border` 就走「逐边画」那一支（下面 `borderEdgesOf`）；没有新字段的老文档
  // 还是走这一支的 `stroke` —— 逐字节不变（`test:designerfresh` 是它的锁）。
  if (borderWidth > 0 && !isObject(style.border)) {
    attrs.push(`stroke="${esc(resolveColor(style.color, tokens) ?? '#000000')}"`, `stroke-width="${num(borderWidth)}"`);
  }
  return {
    attrs,
    fontSize: style.fontSize ?? 14,
    textColor: resolveColor(style.color, tokens) ?? '#000000',
    textAlign: style.textAlign ?? 'left',
  };
}

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'];
/** `style.border` ⇒ 逐边的 `{side,width,color}`（width > 0 才返回）。没有新字段就返回 `[]` ⇒ 走旧的 stroke。 */
export function borderEdgesOf(style, tokens = {}) {
  if (!isObject(style) || !isObject(style.border)) return [];
  const border = style.border;
  const baseWidth = typeof border.width === 'number' ? border.width : 0;
  const baseColor = border.color ?? style.color;
  const edges = [];
  for (const side of BORDER_SIDES) {
    const spec = isObject(border[side]) ? border[side] : {};
    const width = typeof spec.width === 'number' ? spec.width : baseWidth;
    if (!(width > 0)) continue;
    edges.push({ side, width, color: resolveColor(spec.color ?? baseColor, tokens) ?? '#000000' });
  }
  return edges;
}

/** 一条边在盒子里的矩形（沿该边的一条，厚度 = 边的宽；厚度夹在盒子尺寸以内）。 */
function borderEdgeBox(box, side, width) {
  const thickness = Math.min(width, Math.min(box.w, box.h));
  if (side === 'top') return { x: box.x, y: box.y, w: box.w, h: thickness };
  if (side === 'bottom') return { x: box.x, y: box.y + box.h - thickness, w: box.w, h: thickness };
  if (side === 'left') return { x: box.x, y: box.y, w: thickness, h: box.h };
  return { x: box.x + box.w - thickness, y: box.y, w: thickness, h: box.h };
}

/** 一屏 ⇒ 确定 SVG（同一份文档 ⇒ 逐字节相同的字符串）。 */
export function renderScreenSvg(doc, screenId, options = {}) {
  const { viewport = DEFAULT_VIEWPORT, state, source } = options;
  assertValidDocument(doc, source);
  const screen = doc.screens.find((item) => item.id === screenId);
  if (!screen) throw new Error(`文档里没有屏 ${JSON.stringify(screenId)}（有：${doc.screens.map((item) => item.id).join(', ')}）`);
  const states = Array.isArray(screen.states) ? screen.states : [];
  const stateId = state ?? states[0]?.id ?? 'default';
  const selected = states.find((item) => isObject(item) && item.id === stateId);
  if (state !== undefined && selected === undefined) {
    throw new Error(`屏 ${screenId} 里没有状态 ${JSON.stringify(state)}（有：${states.map((item) => item.id).join(', ')}）`);
  }
  // 状态带了 `root` 就画它自己那棵树；否则与默认树共用（读法向后兼容：只看 `screens[].root` 的消费者仍拿到默认那棵）。
  // 画之前先把实例摊平成具体元素树（`designer/expand.mjs`）。
  const tree = expandTree(stateTreeOf(screen, stateId), doc);
  const tokens = isObject(doc.tokens) ? doc.tokens : {};
  const { canvas, drawList } = layoutScreen(tree, viewport);
  const parts = [];
  for (const { element, box } of drawList) {
    const shape = shapeOf(element, box, tokens);
    const common = `data-el-id="${esc(element.id)}" data-el-type="${esc(element.type)}"`;
    const edges = borderEdgesOf(element.style, tokens);
    const edgeParts = [];
    for (const edge of edges) {
      const rect = borderEdgeBox(box, edge.side, edge.width);
      edgeParts.push(`<rect class="designer-border" data-el-border-of="${esc(element.id)}" data-el-border-side="${esc(edge.side)}" x="${num(rect.x)}" y="${num(rect.y)}" width="${num(Math.max(0, rect.w))}" height="${num(Math.max(0, rect.h))}" fill="${esc(edge.color)}"/>`);
    }
    if (element.type === 'text' || element.type === 'button' || element.type === 'input') {
      const label = element.text ?? element.name ?? '';
      const anchor = shape.textAlign === 'center' ? 'middle' : shape.textAlign === 'right' ? 'end' : 'start';
      const anchorAttr = shape.textAlign === 'left' ? '' : ` text-anchor="${anchor}"`;
      const x = shape.textAlign === 'center' ? box.x + box.w / 2 : shape.textAlign === 'right' ? box.x + box.w : box.x;
      if (element.type !== 'text') parts.push(`<rect ${common} ${shape.attrs.join(' ')}/>`);
      parts.push(...edgeParts);
      parts.push(`<text ${common} x="${num(x)}" y="${num(box.y + shape.fontSize)}" font-size="${num(shape.fontSize)}" fill="${esc(shape.textColor)}"${anchorAttr}>${esc(label)}</text>`);
      continue;
    }
    parts.push(`<rect ${common} ${shape.attrs.join(' ')}/>`);
    parts.push(...edgeParts);
  }
  const digest = docDigest(doc);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(canvas.w)}" height="${num(canvas.h)}" viewBox="0 0 ${num(canvas.w)} ${num(canvas.h)}" data-doc-digest="sha256:${digest}" data-designer-screen="${esc(screen.id)}" data-designer-state="${esc(stateId)}" role="img" aria-label="${esc(screen.name ?? screen.id)} · ${esc(stateId)}">
<desc>designer 导出 · 屏 ${esc(screen.id)} · 状态 ${esc(stateId)} · 文档摘要 sha256:${digest}</desc>
${parts.join('\n')}
</svg>
`;
}

const FLOW = Object.freeze({ nodeW: 180, nodeH: 56, screenGap: 80, stateGap: 20, margin: 32 });
/**
 * 转移图里标签的排版常量（与页面那条实现的 `LABEL_FRACTIONS` / `LABEL_OFFSET` 同一组数字；
 * 规则的**文字**在 `docs/design/designer-exporters.md` §8.2）：
 *   · `pad`：不透明底在文字外面留出来的边（px）；
 *   · `offset`：挤在一起时沿**路径法线**最多挪多远（px）—— 它同时是「标签中心到它自己那条线」的上界；
 *   · `fractions`：沿路径**前后挪**的候选参数（先中点，再两边对称扩散；越靠前的越优先）。
 * 纯数据没有字体度量 ⇒ 宽度用 `estimateTextExtent()` **估**（CJK 算 1 个字号宽、其它 0.55）。
 */
const FLOW_LABEL = Object.freeze({
  fontSize: 11,
  height: 14,
  pad: 3,
  offset: 16,
  fractions: [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8],
});

/** 三次贝塞尔在 `t` 处的点（自环那根 `C` 路径靠它取候选点）。 */
function cubicAt(points, t) {
  const k = 1 - t;
  const at = (key) => (k * k * k * points[0][key]) + (3 * k * k * t * points[1][key]) + (3 * k * t * t * points[2][key]) + (t * t * t * points[3][key]);
  return { x: at('x'), y: at('y') };
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * **锚点控件在转移图坐标系里的盒子**（返回 `null` = 这条转移没带 anchor）。
 *
 * 选择器的写法只认 `#<元素 id>`（`anchorElementId()`，与校验器同一个解析）；能不能指到东西、
 * 写法认不认识，**校验器**（`validate.mjs`）已经判过了（文档不合法就抛、CLI 退 3）—— 这里再抛一次
 * 是防守：宁可什么都不产出，也不把一条「起点退回节点中心」的箭头静默画出来。
 *
 * 语义与几何是怎么接上的（这一段就是「起点取哪个盒子」的**唯一出处**）：
 *   · 转移图的节点是个**紧凑盒子**（`FLOW.nodeW × FLOW.nodeH`），它代表整屏，并不画出屏里的内容；
 *   · 而锚点控件只在**屏坐标系**里有一个盒子（`layoutScreen()` 算出来的自由/自动布局结果）；
 *   · 两者的映射取**逐轴比例**：屏的左上角 ↦ 节点框左上角、屏的右下角 ↦ 节点框右下角 ⇒
 *     「控件在屏里的哪个方位」与「它在节点框里的哪个方位」一致（屏的画布尺寸就是 `stageSizeOf()`）。
 *   · 结果再**夹进节点框**：自由布局允许子元素溢出屏，溢出的那部分映出来会跑到节点框外面去。
 *
 * 找不到 / 写法不认识 ⇒ **如实抛错**（不静默退回节点中心 —— 那正好画出「看起来对、其实从页面中央出来」的箭头）。
 */
function anchorBoxOf(doc, transition, node, viewport) {
  const anchor = transition.from?.anchor;
  if (anchor === undefined) return null;
  if (!isObject(anchor) || typeof anchor.selector !== 'string') {
    throw new Error(`转移 ${JSON.stringify(transition.id)} 的 from.anchor 必须是 { selector: "<css 选择器>" }（读到 ${JSON.stringify(anchor)}）`);
  }
  const id = anchorElementId(anchor.selector);
  if (id === null) {
    throw new Error(`转移 ${JSON.stringify(transition.id)} 的 from.anchor.selector ${JSON.stringify(anchor.selector)} 不是本仓认识的写法：只认 \`#<元素 id>\``);
  }
  const screen = doc.screens.find((item) => item.id === transition.from.screen);
  const tree = expandTree(stateTreeOf(screen, transition.from.state), doc);
  const element = findElementById(tree, id);
  if (element === null) {
    throw new Error(`转移 ${JSON.stringify(transition.id)} 的 from.anchor.selector ${JSON.stringify(anchor.selector)} 指不到东西：屏 ${JSON.stringify(transition.from.screen)}／状态 ${JSON.stringify(transition.from.state)} 的树里没有 id=${JSON.stringify(id)} 的元素`);
  }
  const { canvas, drawList } = layoutScreen(tree, viewport);
  const hit = drawList.find((item) => item.element === element);
  if (hit === undefined || !(canvas.w > 0) || !(canvas.h > 0)) {
    throw new Error(`转移 ${JSON.stringify(transition.id)} 的锚点元素 id=${JSON.stringify(id)} 在布局里量不到盒子（画布 ${canvas.w}×${canvas.h}）`);
  }
  const scaleX = node.w / canvas.w;
  const scaleY = node.h / canvas.h;
  const rawX = node.x + hit.box.x * scaleX;
  const rawY = node.y + hit.box.y * scaleY;
  const x = clamp(rawX, node.x, node.x + node.w);
  const y = clamp(rawY, node.y, node.y + node.h);
  return {
    x,
    y,
    w: Math.max(0, Math.min(rawX + hit.box.w * scaleX, node.x + node.w) - x),
    h: Math.max(0, Math.min(rawY + hit.box.h * scaleY, node.y + node.h) - y),
  };
}

/**
 * 从盒子中心朝 `aim` 引一条射线，取它**穿出盒子边界**的那个点 —— 就是「朝向目标那一侧的那条边」上的落点。
 * （盒子宽/高为 0 时退化成中心点；方向为 0 时也返回中心点。）
 */
function edgePointToward(box, aim) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = aim.x - cx;
  const dy = aim.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const tx = dx > 0 ? (box.x + box.w - cx) / dx : dx < 0 ? (box.x - cx) / dx : Infinity;
  const ty = dy > 0 ? (box.y + box.h - cy) / dy : dy < 0 ? (box.y - cy) / dy : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * 一根箭头的几何：**一条线段（两个端点）或一条三次贝塞尔（四个控制点）**。
 * 抽出来是因为「标签落在**自己那条**线上」必须**沿这条路径**取点（不是取两端中点 —— 两条中点相同
 * 的转移会落成同一个点，实测 demo 里 `t-settings-grid` 与 `t-row-home` 都在 `(642, 54)`）；而 `d` 也由
 * 这同一份几何生成 ⇒ 路径与标签用的是同一个形状。
 *
 * `anchorBox`（可省略）：`from` 端带了 anchor 时，那条转移的**起点**改从它出发 ——
 * 取盒子上「朝向目标那一侧」的那条边的出射点（`edgePointToward()`）；终点仍是目标节点中心。
 * 省略 / 传 `null` ⇒ 与以前**逐字一致**（起点 = `from` 节点中心）。
 */
function arrowGeometryOf(from, to, anchorBox = null) {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  if (from === to) {
    if (anchorBox !== null) {
      // 自环：起点/终点都落在**锚点盒子**的上边（环从控件上方出去、再回来）。
      const ax = anchorBox.x + anchorBox.w / 2;
      const out = Math.max(4, Math.min(anchorBox.w / 2, 24));
      return { kind: 'cubic', points: [{ x: ax - out, y: anchorBox.y }, { x: ax - (out * 5) / 3, y: anchorBox.y - 44 }, { x: ax + (out * 5) / 3, y: anchorBox.y - 44 }, { x: ax + out, y: anchorBox.y }] };
    }
    return { kind: 'cubic', points: [{ x: cx - 24, y: from.y }, { x: cx - 40, y: from.y - 44 }, { x: cx + 40, y: from.y - 44 }, { x: cx + 24, y: from.y }] };
  }
  const end = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const start = anchorBox === null ? { x: cx, y: cy } : edgePointToward(anchorBox, end);
  return { kind: 'line', points: [start, end] };
}

function arrowPathD(geometry) {
  const [p0, p1, p2, p3] = geometry.points;
  if (geometry.kind === 'line') return `M ${num(p0.x)} ${num(p0.y)} L ${num(p1.x)} ${num(p1.y)}`;
  return `M ${num(p0.x)} ${num(p0.y)} C ${num(p1.x)} ${num(p1.y)}, ${num(p2.x)} ${num(p2.y)}, ${num(p3.x)} ${num(p3.y)}`;
}

function pointOnGeometry(geometry, t) {
  if (geometry.kind === 'line') {
    const [a, b] = geometry.points;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return cubicAt(geometry.points, t);
}

const boxAround = (center, size) => ({ x: center.x - size.w / 2, y: center.y - size.h / 2, w: size.w, h: size.h });
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** 沿**这条箭头自己的**路径取候选点；每个位置上再给两个沿法线的错开点。 */
function labelCandidatesAlong(geometry) {
  const points = [];
  for (const fraction of FLOW_LABEL.fractions) {
    const here = pointOnGeometry(geometry, fraction);
    const ahead = pointOnGeometry(geometry, Math.min(1, fraction + 0.02));
    const dx = ahead.x - here.x;
    const dy = ahead.y - here.y;
    const length = Math.hypot(dx, dy) || 1;
    points.push(here);
    for (const offset of [FLOW_LABEL.offset, -FLOW_LABEL.offset]) {
      points.push({ x: here.x + (-dy / length) * offset, y: here.y + (dx / length) * offset });
    }
  }
  return points;
}

/**
 * 「一个标签落在**它自己那条线上**的哪一点」——**唯一一处策略**（与页面那条实现同一条规则；
 * 规则的文字在 `docs/design/designer-exporters.md` §8.2）：先中点、挤了沿路径前后挪、再沿法线错开；全都挤就取
 * **重叠面积最小**的那个 —— **绝不把标签搬到离线更远的地方**（那样它就变成一条对不上自己那条线的标签）。
 */
function pickLabelSpot(candidates, size, placed) {
  let best = null;
  for (const point of candidates) {
    const overlap = placed.reduce((sum, box) => sum + overlapArea(boxAround(point, size), box), 0);
    if (best === null || overlap < best.overlap) best = { point, overlap };
    if (overlap === 0) break;
  }
  return best ?? { point: candidates[0], overlap: 0 };
}

/** (屏, 状态) 的节点键：一律 `屏@@状态`。
 *  ⚠️ 这里**没有**「状态缺省 = `'default'`」那条兜底（2026-09-25 收严）：`assertValidDocument()` 已经判过
 *  两端都是 `{screen, state}`，所以 `stateId` 必定是字符串；万一传进来一个 `undefined`，键会变成 `屏@@undefined`
 *  ⇒ 找不到节点 ⇒ 上面如实留一条空箭头（`d=""`），**不会**静默地指到任何一个真实状态上。 */
export function flowNodeKey(screenId, stateId) {
  return `${screenId}@@${stateId}`;
}

function defaultStateOf(screen) {
  return Array.isArray(screen.states) && screen.states.length > 0 ? screen.states[0].id : 'default';
}

/**
 * 「屏 / 状态到哪去」的图：**箭头只由 `transitions` 生成**。
 * 每一根箭头都带 `data-transition="<转移 id>"`（门按这条断言「图上有、数据里没有」不可能发生）。
 */
export function renderFlowSvg(doc, options = {}) {
  const { source, viewport = DEFAULT_VIEWPORT } = options;
  assertValidDocument(doc, source);
  const nodes = new Map();
  const columns = [];
  doc.screens.forEach((screen, screenIndex) => {
    const states = Array.isArray(screen.states) && screen.states.length > 0 ? screen.states : [{ id: 'default', name: '默认' }];
    const x = FLOW.margin + screenIndex * (FLOW.nodeW + FLOW.screenGap);
    columns.push(x);
    states.forEach((state, stateIndex) => {
      const y = FLOW.margin + stateIndex * (FLOW.nodeH + FLOW.stateGap);
      nodes.set(flowNodeKey(screen.id, state.id), { screen, state, x, y, w: FLOW.nodeW, h: FLOW.nodeH });
    });
  });
  const height = FLOW.margin * 2 + Math.max(...[...nodes.values()].map((node) => node.y + node.h));
  const width = FLOW.margin * 2 + (columns.at(-1) ?? 0) + FLOW.nodeW;

  const nodeParts = [];
  for (const [key, node] of nodes) {
    const isDefault = node.state.id === defaultStateOf(node.screen);
    nodeParts.push(`<g class="designer-flow-node" data-node-key="${esc(key)}" data-screen="${esc(node.screen.id)}" data-state="${esc(node.state.id)}" data-default="${isDefault ? 'yes' : 'no'}">`);
    nodeParts.push(`<rect x="${num(node.x)}" y="${num(node.y)}" width="${num(node.w)}" height="${num(node.h)}" rx="6" fill="${isDefault ? '#f2f4f8' : '#ffffff'}" stroke="#333333" stroke-width="1"/>`);
    nodeParts.push(`<text x="${num(node.x + 10)}" y="${num(node.y + 22)}" font-size="14" fill="#111111">${esc(node.screen.name ?? node.screen.id)}</text>`);
    nodeParts.push(`<text x="${num(node.x + 10)}" y="${num(node.y + 42)}" font-size="12" fill="#555555">${esc(node.state.name ?? node.state.id)}${isDefault ? '（默认）' : ''}</text>`);
    nodeParts.push('</g>');
  }

  const arrowParts = [];
  const labelParts = [];
  const placed = [];
  const transitions = Array.isArray(doc.transitions) ? doc.transitions : [];
  for (const transition of transitions) {
    // 两端都**必须**带 `state`（schema 判必填、`assertValidDocument()` 已经拒了缺的）⇒
    // 这里不再有「缺省 = 该屏的 states[0]」那条兼容分支：留着它，同一份文档在页面那条路径（0 根箭头）
    // 与本目录这条路径（4 根箭头）就会读数不同 —— 那正是 2026-09-25 收严要关掉的口子。
    const fromState = transition.from.state;
    const toState = transition.to.state;
    const from = nodes.get(flowNodeKey(transition.from.screen, fromState));
    const to = nodes.get(flowNodeKey(transition.to.screen, toState));
    const attrs = [
      'class="designer-arrow"',
      `data-transition="${esc(transition.id)}"`,
      `data-from="${esc(flowNodeKey(transition.from.screen, fromState))}"`,
      `data-to="${esc(flowNodeKey(transition.to.screen, toState))}"`,
    ];
    if (!from || !to) {
      // 转移两端（屏/状态）在文档里找不到时，校验器已经红过了；这里**不猜一个位置**，如实留一条空箭头。
      arrowParts.push(`<path ${attrs.join(' ')} d="" fill="none" stroke="#b00020" stroke-width="1.5"/>`);
      continue;
    }
    const geometry = arrowGeometryOf(from, to, anchorBoxOf(doc, transition, from, viewport));
    arrowParts.push(`<path ${attrs.join(' ')} d="${arrowPathD(geometry)}" fill="none" stroke="#1f6feb" stroke-width="1.5" marker-end="url(#designer-arrowhead)"/>`);
    // 标签**贴在自己那条线上**、且互相不叠（`pickLabelSpot` 是唯一出处）。
    const label = transition.trigger ?? '';
    if (label === '') continue;
    const size = { w: estimateTextExtent(label, FLOW_LABEL.fontSize).w + FLOW_LABEL.pad * 2, h: FLOW_LABEL.height };
    const spot = pickLabelSpot(labelCandidatesAlong(geometry), size, placed);
    const box = boxAround(spot.point, size);
    placed.push(box);
    labelParts.push(`<g class="designer-arrow-label" data-transition="${esc(transition.id)}">`);
    labelParts.push(`<rect class="designer-arrow-label-bg" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="2" fill="#ffffff"/>`);
    labelParts.push(`<text class="designer-arrow-label-text" x="${num(spot.point.x)}" y="${num(spot.point.y)}" dy="0.35em" font-size="${num(FLOW_LABEL.fontSize)}" fill="#1f6feb" text-anchor="middle">${esc(label)}</text>`);
    labelParts.push('</g>');
  }
  const digest = docDigest(doc);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}" data-doc-digest="sha256:${digest}" data-designer-flow="yes" role="img" aria-label="屏与状态的转移图">
<desc>designer 导出 · 转移图 · 箭头由 transitions 生成 · 文档摘要 sha256:${digest}</desc>
<defs><marker id="designer-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#1f6feb"/></marker></defs>
${nodeParts.join('\n')}
${arrowParts.join('\n')}
${labelParts.length > 0 ? `<g class="designer-flow-labels">\n${labelParts.join('\n')}\n</g>` : ''}
</svg>
`;
}
