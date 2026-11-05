// designer/toHtml.mjs —— 中立文档 ⇒ **静态 HTML/CSS**（纯 Node、零依赖、零外部请求）。
//
// 一句话：把「语义」翻成 CSS —— 自由容器 = 绝对定位；row/column/grid = flex/grid；
// fixed/fill/content = 固定值 / 跟随父容器 / 由内容决定；style 里的 `var(--token)` 原样透到 `:root`。
// **没有 JS、没有外链**（`<style>` 是内联的，字体只写通用族，绝不产出 `@font-face` / `@import` /
// `<link>` / `<img src>`）—— 这一条由 `test/designer-export.mjs` 用真 Chromium 的**网络层**钉住。
//
// 不变式（门的断言面）：
//   · **同一份文档导出两次 ⇒ 逐字节相同**（纯函数；类名按文档顺序编号，tokens 按键排序）；
//   · 坏的文档 ⇒ **抛错、什么都不产出**（`assertValidDocument` 先跑，绝没有半成品 HTML）；
//   · 导出物里嵌一份 `sha256:<规范字节>`（`designer/canonical.mjs`），所以「盘上这份对应哪一版文档」可判。
//
// 尺寸语义（与 `designer/schema.json` 的 `constraint` 一一对应）：
//   · `fixed`   ⇒ `flex: 0 0 auto` ＋ `width/height: <value>px`（主轴与交叉轴一样：一个确定的数）；
//   · `fill`    ⇒ **主轴**（row 里的 w / column 里的 h）`flex: 1 1 0`；**交叉轴** `align-self: stretch`；
//                 grid 里就是铺满格位（stretch）。⇒ **这一条是「跟随父容器」的唯一落点**，
//                 反证臂 `fill-as-fixed` 就是把这一行改掉（`test/designer-export.mjs`）。
//   · `content` ⇒ `width/height: max-content`（由内容决定；文字的真实度量由浏览器算）。
//   自由布局（free）容器里的子元素**不看 size**，位置与大小由 `box` 决定（CSS 绝对定位）。
//   **容器**在 free 里也一样是 `position:absolute`（**不**再补 `position:relative` —— 那会把容器打回正常流、
//   两层竖着堆；见 `docs/design/designer-exporters.md` §8.1）。
//   `row/column/grid` 里的容器则仍补 `relative`（它是在流里的，得给后代的 `box` 当包含块）。

import { assertValidDocument, containerModeOf, VOCAB } from './validate.mjs';
import { canonicalJson, docDigest } from './canonical.mjs';
import { expandTree } from './expand.mjs';

export const DEFAULT_VIEWPORT = Object.freeze({ w: 1200, h: 760 });

/** 数的文字形式（固定小数位，避免 1/3 这类值在不同运行里写出不同字节）。 */
const num = (value) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000));

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

function paddingCss(padding) {
  if (padding === undefined) return null;
  if (typeof padding === 'number') return `${num(padding)}px`;
  return `${padding.map((value) => `${num(value)}px`).join(' ')}`;
}

/** 一棵树的画布（stage）多大：它的 `size.w/h` 是 `fixed` 就用那个数，否则用导出视口。 */
export function stageSizeOf(tree, viewport = DEFAULT_VIEWPORT) {
  const axis = (key, fallback) => {
    const constraint = tree?.size?.[key];
    return constraint?.mode === 'fixed' && typeof constraint.value === 'number' ? constraint.value : fallback;
  };
  return { w: axis('w', viewport.w), h: axis('h', viewport.h) };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const AXIS_PROP = { w: 'width', h: 'height' };
const AXIS_LABEL = { w: '宽', h: '高' };

/**
 * 一条尺寸约束 ⇒ 若干 CSS 声明。
 * `parentMode` 是父容器的布局模式（free/row/column/grid），`axis` 是 'w' | 'h'。
 */
function constraintDeclarations(constraint, axis, parentMode) {
  if (constraint === undefined) return [];
  const prop = AXIS_PROP[axis];
  if (parentMode === 'row' || parentMode === 'column') {
    const isMain = (parentMode === 'row') === (axis === 'w');
    if (isMain) {
      if (constraint.mode === 'fixed') return [['flex', '0 0 auto'], [prop, `${num(constraint.value)}px`]];
      if (constraint.mode === 'fill') return [['flex', '1 1 0'], [prop, 'auto']];
      return [['flex', '0 0 auto'], [prop, 'max-content']];
    }
    if (constraint.mode === 'fixed') return [[prop, `${num(constraint.value)}px`], ['align-self', 'flex-start']];
    if (constraint.mode === 'fill') return [['align-self', 'stretch']];
    return [[prop, 'max-content'], ['align-self', 'flex-start']];
  }
  if (parentMode === 'grid') {
    if (constraint.mode === 'fixed') return [[prop, `${num(constraint.value)}px`], [axis === 'w' ? 'justify-self' : 'align-self', 'start']];
    if (constraint.mode === 'fill') return [[axis === 'w' ? 'justify-self' : 'align-self', 'stretch']];
    return [[prop, 'max-content'], [axis === 'w' ? 'justify-self' : 'align-self', 'start']];
  }
  return [];
}

/**
 * `fill` 的落点：**这一段就是「fill ＝ 跟随父容器」这条语义的唯一实现**。
 * 反证臂 `fill-as-fixed` 改的就是下面这一个 return（改成「当 fixed 处理」）。
 */
function fillDeclarations(axis, parentMode) {
  // ARM-FILL-ANCHOR：下面这几行就是「fill ＝ 跟随父容器」这条语义的**唯一实现**。
  // 反证臂 `fill-as-fixed` 把这一整段换成「一个确定的数（0px）」—— 那就是「把 fill 当 fixed 处理」。
  if (parentMode === 'row' || parentMode === 'column') {
    const isMain = (parentMode === 'row') === (axis === 'w');
    return isMain ? [['flex', '1 1 0'], [AXIS_PROP[axis], 'auto']] : [['align-self', 'stretch']];
  }
  return [[axis === 'w' ? 'justify-self' : 'align-self', 'stretch']];
}

function layoutDeclarations(layout) {
  if (!isObject(layout)) return [];
  const declarations = [];
  if (layout.mode === 'row' || layout.mode === 'column') {
    declarations.push(['display', 'flex'], ['flex-direction', layout.mode === 'row' ? 'row' : 'column']);
    if (layout.gap !== undefined) declarations.push(['gap', `${num(layout.gap)}px`]);
    declarations.push(['align-items', layout.align ?? 'stretch']);
  } else if (layout.mode === 'grid') {
    // 网格的行高由**内容**决定（不把行拉开）：显式写 `align-content: start`，否则 CSS 的默认
    // `stretch` 会把隐式行拉伸到容器高度（实测：4 个 h=40 的项在 180 高的容器里，第二行被顶到 y=105），
    // 那就不是文档说的语义了。SVG 那一条实现也是按内容算行高，两者因此说同一件事。
    declarations.push(['display', 'grid'], ['grid-template-columns', `repeat(${layout.columns}, 1fr)`], ['align-content', 'start']);
    if (layout.gap !== undefined) declarations.push(['gap', `${num(layout.gap)}px`]);
  }
  if (layout.padding !== undefined) declarations.push(['padding', paddingCss(layout.padding)]);
  return declarations;
}

const TAG_FOR = { container: 'div', rect: 'div', text: 'div', image: 'div', input: 'input', button: 'button' };

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'];
/** 一行 `style.border` ⇒ CSS 声明。四边**都**显式给宽（宽 0 就是 0）—— 不显式给的话
 *  `border-style:solid` 会把没写的那条边按 CSS 初始值 `medium` 画出来（那是「看起来对、其实多了一条边」）。
 *  同一元素的 `borderWidth`（旧字段）与 `border` 同时给时，`border` 优先（见上面那一支）。 */
function borderDeclarations(border) {
  const baseWidth = typeof border.width === 'number' ? border.width : 0;
  const declarations = [['border-style', 'solid']];
  for (const side of BORDER_SIDES) {
    const edge = isObject(border[side]) ? border[side] : {};
    const width = typeof edge.width === 'number' ? edge.width : baseWidth;
    declarations.push([`border-${side}-width`, `${num(width)}px`]);
  }
  for (const side of BORDER_SIDES) {
    const edge = isObject(border[side]) ? border[side] : {};
    const color = edge.color ?? border.color;
    if (color !== undefined) declarations.push([`border-${side}-color`, color]);
  }
  return declarations;
}

function styleDeclarations(style) {
  if (!isObject(style)) return [];
  const declarations = [];
  if (style.color !== undefined) declarations.push(['color', style.color]);
  if (style.background !== undefined) declarations.push(['background-color', style.background]);
  // 旧字段 `borderWidth`（四边同一个数）只在**没有**新字段 `border` 时生效 —— 给了 `border` 就以它为准。
  // 这一条同时保住了「不用新特性的文档逐字节不变」：老文档走的就是下面这一支。
  if (style.borderWidth !== undefined && !isObject(style.border)) declarations.push(['border-style', 'solid'], ['border-width', `${num(style.borderWidth)}px`]);
  if (style.borderRadius !== undefined) declarations.push(['border-radius', `${num(style.borderRadius)}px`]);
  if (isObject(style.border)) declarations.push(...borderDeclarations(style.border));
  if (style.fontSize !== undefined) declarations.push(['font-size', `${num(style.fontSize)}px`]);
  if (style.fontWeight !== undefined) declarations.push(['font-weight', num(style.fontWeight)]);
  if (style.fontFamily !== undefined) declarations.push(['font-family', style.fontFamily]);
  if (style.textAlign !== undefined) declarations.push(['text-align', style.textAlign]);
  return declarations;
}

/**
 * 文档 ⇒ 一页静态 HTML（所有屏按文档顺序竖着排；每屏一个 stage，大小由 root 的 fixed 尺寸或视口决定）。
 */
export function renderDocumentHtml(doc, options = {}) {
  const { viewport = DEFAULT_VIEWPORT, source } = options;
  assertValidDocument(doc, source);
  const rules = [];
  const figures = [];
  let counter = 0;

  const renderElement = (element, parentMode) => {
    const cssClass = `d${counter}`;
    counter += 1;
    const declarations = [];
    if (parentMode === 'free') {
      declarations.push(['position', 'absolute'], ['left', `${num(element.box.x)}px`], ['top', `${num(element.box.y)}px`],
        ['width', `${num(element.box.w)}px`], ['height', `${num(element.box.h)}px`]);
    } else if (element.size !== undefined) {
      for (const axis of ['w', 'h']) {
        const constraint = element.size[axis];
        if (constraint === undefined) continue;
        declarations.push(...(constraint.mode === 'fill' ? fillDeclarations(axis, parentMode) : constraintDeclarations(constraint, axis, parentMode)));
      }
    }
    if (element.type === 'container') {
      // `position` 只在**非 free** 的父容器里补 `relative`：
      //   · 自由布局里的孩子（含**容器**）上面已经被写成了 `position:absolute`；CSS 里绝对定位元素
      //     **本身就是**后代的包含块（自由布局的孙子仍然按本元素的 padding box 定位），所以这里什么都
      //     不用补；
      //   · 而再补一条 `position:relative` 会**赢**（同一属性后写的胜出）⇒ 容器被打回正常流，
      //     只有叶子真被绝对定位 ⇒ 两层容器**竖着堆**（F1：遮罩盖不住页面）。
      //   · row/column/grid 里的孩子是**在流里**的（static）⇒ 必须补 `relative`，否则它自己那棵自由布局
      //     子树里的 `box` 会一路找到 `.designer-screen` 去，落点全错。
      if (parentMode !== 'free') declarations.push(['position', 'relative']);
      declarations.push(...layoutDeclarations(element.layout));
    }
    declarations.push(...styleDeclarations(element.style));
    // 一条规则一行：diff 里「一处语义变化」= 一行变化。
    rules.push(`.${cssClass}{${declarations.map(([prop, value]) => `${prop}:${value}`).join(';')}}`);

    const type = element.type;
    const attrs = [`class="designer-el ${cssClass}"`, `data-el-id="${esc(element.id)}"`, `data-el-type="${esc(type)}"`];
    if (element.name !== undefined) attrs.push(`data-el-name="${esc(element.name)}"`);
    const mode = containerModeOf(element);
    if (mode) attrs.push(`data-layout="${esc(mode)}"`);
    if (element.type === 'image') attrs.push(`role="img"`, `aria-label="${esc(element.name ?? element.text ?? element.id)}"`);
    const children = Array.isArray(element.children) ? element.children : [];
    const inner = children.map((child) => renderElement(child, mode)).join('');
    const text = element.text === undefined ? '' : esc(element.text);
    if (type === 'input') return `<input ${attrs.join(' ')} type="text" value="${text}" readonly>`;
    if (type === 'button') return `<button ${attrs.join(' ')} type="button">${text}</button>`;
    return `<${TAG_FOR[type]} ${attrs.join(' ')}>${text}${inner}</${TAG_FOR[type]}>`;
  };

  // 一节 = 一棵树：默认树（`screens[].root`）＋ 每个「有自己树的状态」（`states[j].root`）。
  // 状态带了 `root` 才多一节 —— 没带的状态与默认树共用（它不是另一棵树）。
  const views = [];
  for (const screen of doc.screens) {
    const states = Array.isArray(screen.states) ? screen.states : [];
    const [first, ...rest] = states;
    views.push({
      screen,
      stateId: first?.id ?? 'default',
      tree: screen.root,
      note: rest.length > 0 ? `（另有 ${rest.length} 个状态：${rest.map((state) => `${state.id}${state.root ? '（有自己那棵树）' : ''}`).join(', ')}）` : '',
    });
    for (const state of rest) {
      if (state.root === undefined) continue;
      views.push({ screen, stateId: state.id, tree: state.root, note: '（这个状态有自己那棵树）' });
    }
  }

  for (const view of views) {
    const { screen } = view;
    // 渲染前先把实例摊平成具体元素树（`designer/expand.mjs`）：HTML 这一条实现只认具体树。
    const tree = expandTree(view.tree, doc);
    const size = stageSizeOf(tree, viewport);
    const label = `${screen.name ?? screen.id} · ${view.stateId}${view.note}`;
    const root = renderElement(tree, null);
    figures.push([
      `<figure class="designer-screen-figure" data-screen-id="${esc(screen.id)}" data-state="${esc(view.stateId)}">`,
      `<figcaption class="designer-chrome">${esc(label)}</figcaption>`,
      `<div class="designer-screen" data-screen-id="${esc(screen.id)}" data-state="${esc(view.stateId)}" data-screen-width="${num(size.w)}" data-screen-height="${num(size.h)}" style="width:${num(size.w)}px;height:${num(size.h)}px">${root}</div>`,
      '</figure>',
    ].join('\n'));
  }

  const tokenKeys = Object.keys(isObject(doc.tokens) ? doc.tokens : {}).sort();
  const tokenBlock = tokenKeys.length === 0 ? '' : `:root{\n${tokenKeys.map((key) => `  ${key}: ${doc.tokens[key]};`).join('\n')}\n}\n`;
  const digest = docDigest(doc);
  const title = doc.name ?? '设计器导出';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} —— 设计器导出（静态）</title>
<meta name="designer-doc-digest" content="sha256:${digest}">
<meta name="designer-doc-version" content="${esc(doc.version)}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#ffffff;color:#111111}
body{font-family:sans-serif;font-size:14px;line-height:1.4}
.designer-doc{padding:16px}
.designer-screen-figure{margin:0 0 24px 0}
.designer-chrome{margin:0 0 4px 0;font-family:monospace;font-size:12px;color:#666666}
.designer-screen{position:relative;overflow:hidden;background:#ffffff}
.designer-el{box-sizing:border-box;min-width:0;min-height:0}
/* 真控件的默认外观先清零：用 :where() 让这条规则的特异性为 0，
   这样下面按元素生成的 .dNN 规则（文档里写的样式）永远**赢过**它 —— 不许出现
   「文档写了 textAlign:center，却被重置规则按回去」这种"看起来对、其实没生效"。 */
:where(.designer-el[data-el-type="input"],.designer-el[data-el-type="button"]){font:inherit;color:inherit;background:transparent;border:0;padding:0;text-align:left;appearance:none}
${tokenBlock}${rules.join('\n')}
</style>
</head>
<body>
<main class="designer-doc" data-designer-doc-digest="sha256:${digest}">
${figures.join('\n')}
</main>
</body>
</html>
`;
}

/** 导出物里那份规范 JSON（「中立 JSON」那一样产物：**逐字节规范**，round-trip 不丢信息）。 */
export function renderDocumentJson(doc, options = {}) {
  assertValidDocument(doc, options.source);
  return canonicalJson(doc);
}

export { VOCAB };
