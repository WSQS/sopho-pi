// web/designer.js —— 通用设计器 · **B 半：画布与编辑 UI**。
//
// 这一页只做「把那份中立文档画出来、并在上面动手」这一件事。几条口径逐字落地：
//
//  ① **渲染引擎 = 真浏览器**（元素就是 DOM）：`row`/`column` 真的走 flex、`grid` 真的走 grid，
//     `fill` 真的靠 flex-grow / align-self:stretch 撑满 —— 所以「撑满了没有」是**量**出来的，不是算出来的。
//  ② **箭头由数据生成，不直接绘制**：画布上每一根箭头都是 `transitions` 里一条数据的视图
//     （`arrowSpecs()` 是唯一来源；画不出「数据里没有」的箭头）。改/删那条数据 ⇒ 箭头跟着变/消失。
//  ③ **起点空白**、**不存服务端**：导出 / 导入 JSON 就够 —— 因此本页**一个新路由都不需要**，
//     也不同宿主 reload 发生关系（`/designer.html` 由 `server/app.mjs` 的静态服务直接给）。
//  ④ **静态 + 预览**：预览用**同一份文档**渲染一份静态、**零外部请求**的视图（占位图是内联 data URI，
//     一个 `<link>`/外链 `<img>` 都不加）。
//  ⑤ **schema 只增不改、元素 id 永不变**：id 在创建时分配，此后改名/改位置/换父节点都不改，
//     删掉的 id 不复用（`nextId()` 按全文档去重）。
//  ⑥ **流程画布可自由缩放（滚轮）＋点击拖动平移**：两者是同一条**纯视图变换**
//     （`viewTransform = {scale,x,y}` 单一来源 ＋ `applyFlowZoom()` 唯一施加点）——
//     只改 CSS `transform` 与标签度量，**文档一个字节都不动**；`transform-origin` 定在 SVG 原点 ⇒
//     缩放是绕它等比放大、平移是屏幕像素位移（两者叠加不串味）——「层序」「标签不叠、贴在自己那条线上」
//     这些屏幕坐标规则在任何档位 / 任何位移下同样成立。
//
// ── 接口（冻结 v0，与 A 半同一份；要改先问业主，不许各写各的）──────────────────────────────
//
//   文档 = { "$schema", "version": "0.1.0", "tokens": { "--name": "值" },
//            "screens": [ { "id", "name", "states": [ { "id", "name" } ], "root": <element> } ],
//            "transitions": [ { "id", "from": {"screen","state"}, "to": {"screen","state"}, "trigger": "文字" } ] }
//
//   element = { "id", "type": "container|rect|text|image|input|button|divider", "name"?,
//               "box"?: {"x","y","w","h"},
//               "size"?: {"w": {"mode":"fixed|fill|content","value"?}, "h": {...}},
//               "layout"?: {"mode":"free|row|column|grid","gap"?,"padding"?,"columns"?,"align"?},
//               "style"?: {"color","background","borderRadius","borderWidth","fontSize","fontWeight","fontFamily","textAlign"},
//               "text"?: "…", "children"?: [<element>],
//               "orientation"?: "horizontal|vertical", "thickness"?: 1, "color"?: "#…" }
//
//   ⚠️ **只增不改**（本单的加法都在这里，既有字段的语义一个都没动）：
//     · `element.type` 多一个 `divider`（分割符）；它的三个字段 `orientation`/`thickness`/`color`
//       都是**新的可选键**，只有 `type === "divider"` 的元素会带（别的元素序列化出来一个字节都不变）。
//       分割符的 `size` 由渲染器**从 `orientation` + `thickness` 推出来**（长轴跟着容器伸展、
//       短轴 = thickness），所以它自己不带 `size`。
//     · 页面上多一个「导出 HTML」按钮（`exportHtml()`）：把**当前屏当前状态**导出成一份静态 HTML
//       （零外部请求；分割符导出成真元素 `<hr>` —— 不是绝对定位的一条线）。
//       ⚠️ A 半那条「导出管线」在 `designer/` 里，本页这个只是「把画布上这份文档原样写出来」，
//          给门一条能验「真元素」的路径；两边要合，就让 A 半照抄 `dividerHtmlSpec()` 那份映射。
//     · 「复制 JSON」改成**三级降级**（安全上下文 → 兼容路径 → 手动框，见下面「复制到剪贴板」那一段）：
//       `navigator.clipboard` **只在安全上下文存在**（HTTPS 或 localhost / 127.0.0.1），从**局域网 IP ＋
//       明文 HTTP** 打开时它是 `undefined` —— 旧实现直接调 `.writeText` 当场抛（业主实测报回来的原话
//       逐字抄在那段注释里）。这条路上**没有**「失败了就完了」这一格：逐级往下退，退到底就弹一个
//       只读、已全选的手动复制框。
//
//  ⚠️ **一处如实写出来的空档**（已作为问题 q-14198460 记给业主，见 `docs/design/designer-ui.md` §6）：
//     冻结线的 `states` 只列了 `{id,name}` —— 那样一个屏只有一棵树，「多个状态可分别编辑」在数据上
//     没有落点。本页按**方案 A**做：`states[i>0].root` 是**可选**的（第 0 个状态就是 `screens[].root`，
//     不重复写）。读法向后兼容（只读 `screens[].root` 的消费者拿到的仍是默认状态那棵树）。
//     业主如果拍 B 或 C，改的是这一处（`getTree` / `canonicalState`），不是整个骨架。
//
// ── 测试接缝（`test/designer-ui.mjs` 的三条反证臂各改一处；别顺手重命名、别合并）────────────────
//   [SEAM:fill]   `axisCss()` 里 `fill` 那一行 —— 改成按 fixed 处理 ⇒「fill 撑满父容器」必红；
//   [SEAM:arrows] `arrowSpecs()` 的 return —— 改成一份写死的箭头 ⇒「删了 transition 箭头还在」必红；
//   [SEAM:undo]   `undo()` 的第一行 —— 改成 `location.reload()` ⇒「撤销回到完全相同的几何」必红；
//   [SEAM:divider] `dividerSizeShim()` 里长轴那一行 —— 改成固定 1px ⇒「分割符跟着容器伸展」必红；
//   [SEAM:tform]   `submitTransitionForm()` 里写 `transitions` 那一行 —— 改成不写 ⇒「确定⇒箭头出现」必红。
//   [SEAM:view-zoom] `applyFlowZoom()` 里把缩放施加到画布那一行 —— 改成往文档里写一个键 ⇒
//     「缩放是纯视图（文档字节一字不动）」与「画布真的放大」必红；
//   [SEAM:zoom-labels] `labelZoom()` 的 return —— 改成常数 1 ⇒ 50% 档下标签叠在一起必红。
//   [SEAM:anchor] `paintArrows()` 里算起点那一行 —— 换成「一律用卡片上那个默认起点」⇒「带锚点的转移从**控件盒子的边**
//     出发」「缩放/平移后那个关系仍成立」必红；接缝邻居（`anchorBoxOnCanvas()` 的可见性判定 / `anchorTargetId()`
//     的选择器口径）各有一条臂。
//   [SEAM:anchor-box] `anchorBoxOnCanvas()` 的量法与可见性判定（`getBoundingClientRect()` ＋ 与屏内容可见区求交）
//     —— 缓存住第一次量到的盒子 ⇒ 缩放/平移之后起点留在旧位置必红。
//   [SEAM:anchor-fallback] `paintArrows()` 里写 `path.dataset.anchorFallback` 那一行 —— 把标记拿掉
//     （退回本身照旧）⇒「四类原因机械可读」与「一个不多一个不少」必红；
//   [SEAM:anchor-fallback-reason] `anchorFallbackReason()` / `docHasElementId()` 的封闭原因判定
//     —— 每一类原因各有一条臂把它错报成另一类 ⇒ 那一类判据必红；
//   [SEAM:anchor-fallback-hint] `renderFlowWarn()` 里锚点那半句 —— 拿掉 ⇒「页面上看得见（一处小提示）」必红。
//   [SEAM:view-pan] `applyFlowZoom()` 那一行里的 `translate(...)` 那一半（缩放与平移共用这一个施加点）
//     —— 把它摘掉（或改成写模型）⇒「拖动真的平移画布」「平移后命中测试跟着走」「平移＋缩放不串味」必红。
//   [SEAM:copy-fallback] —— ⚠️ 这条**不在这份文件里**：三级降级 2026-09-25 抽进了共用实现
//     `web/copy-text.js`（主产品页的「复制」也调它）；接缝在那份文件里 ②③ 那一段（换成 `throw`
//     ⇒「非安全上下文也拿得到导出串」必红），反证臂 `clipboard-no-fallback` 改的也是那一份。
//   [SEAM:export-build] `buildExport()` 里那一行 —— 换成「把第一次的缓存再发一次」⇒「改了文档导出物跟着变」必红；
//   [SEAM:export-guard] `runExport()` 的 catch —— 换成「只写一句完成」⇒「导出失败如实报」必红。
//   [SEAM:api-commit] `apiMutate()` 里那一行 —— 换成「直接改、不进撤销栈」⇒「一次 API 改动 = 一条历史」
//     /「API 与鼠标在同一个撤销栈里」必红；
//   [SEAM:api-guard] `apiGuard()` 里那一行 —— 换成「什么都不做」⇒「非法输入抛带原因的错 + 文档逐字节未变」必红。
//   [SEAM:layer-fold] `renderLayers()` 里「折叠掉的那一支不再往下走」那一行（`return isLayerFolded(...) ? false : undefined;`）
//     ＋ `layerFoldCell()` 里那条 `aria-expanded` —— 两条折叠反证臂各改一处：
//       `fold-cosmetics-only` 把折叠做成「只用 CSS 把子行藏起来」（子行还在 DOM 里）⇒「折叠 ⇒ 子行**真的**不在 DOM 里」必红、
//       `fold-aria-lying` 把 `aria-expanded` 写成常量 `true` ⇒「折叠控件如实说」必红。
//   [SEAM:layer-indent] `layerRow()` 里 `row.style.marginInlineStart = …` 那一行（**缩进的唯一来源**）——
//     反证臂 `indent-per-level-slot` 把它换成「每层生成一段 `.dz-indent-slot`」（＝退回 2026-09-27 那版
//     「每层一段槽」的画法）⇒「缩进区元素数 = 0」与「main-left 逐层步进 == 会话树实测值」必红。
//   [SEAM:layer-slot] `designer.css` 里 `.dz-layers .dz-layer` 那条 `border-inline-start: … solid var(--slot)`
//     （**行自身**那条 3px 槽的颜色来源）—— 反证臂 `slot-hardcoded` 把 `var(--slot)` 换成硬编码色 ⇒
//     「槽色来自 `--slot-*`」必红（槽宽仍是 `--design-slot-width`，几何那几条留绿）。
//
// ── 可编程控制面：`window.sophoDesigner`（给 agent 用）──────────────────────────────────────
// 与鼠标**同一条**编辑路径（写操作都走 `changeModel()`：一条历史 + 重渲染），**如实回执**（成功 `{ok:true,…}`、
// 非法输入抛带原因的 `Error` 且不留下半成品）。签名 / 回执 / 失败行为逐个写在 `docs/design/designer-agent.md`；
// 运行时可以用 `window.sophoDesigner.help()` 把这份清单拿出来。
//
// 沙箱纪律：本页不 fetch 任何东西（除了自己的 static 资源），不起进程，不碰真 profile。

const SCHEMA_URL = 'https://sopho-pi.invalid/schema/uidesign-0.1.0.json';
const VERSION = '0.1.0';

/** 画布视口（屏的默认尺寸）。冻结模型里没有「屏尺寸」这一格 ⇒ 它由根元素的 `size.fixed` 决定，
 *  拿不到就用这个常量（与 `server/app.mjs` 无关，纯前端常数）。 */
const VIEWPORT = { w: 640, h: 440 };
/** 流程视图里每张屏卡的缩放（箭头端点按**实测矩形**算，所以缩放不影响正确性）。 */
const FLOW_SCALE = 0.55;
// ── 流程画布的**视图变换**（滚轮缩放 ＋ 左键拖动平移）────────────────────────────────────────
//
// 业主 2026-09-26 逐字：「设计器页面 流程/箭头页面 中间的部分我希望改成可以**自由缩放**的画布，
// 可以不用拖动元素，但是可以通过**滚轮直接放大缩小**」；
// 业主 2026-09-27 逐字：「现在有缩放了，但是没有对应的**点击滑动**，请补上」。
//
// 口径：缩放与平移是**同一条纯视图变换** —— **一个字节都不写进文档**（`state.doc` 的坐标 / JSON 全不动），
// 只改 `.dz-flow-cards` 的 CSS `transform`（外加标签度量按同一倍数放大，见 `labelZoom()`）。
// 箭头的端点仍按卡片的**实测矩形**（`getBoundingClientRect()`）算 ⇒ 缩放 / 平移后自动跟着走，
// 不另算一套几何（单一来源 = `viewTransform`，唯一施加点 = `applyFlowZoom()`）。**不做拖动元素**：
// 起点落在卡片 / 箭头 / 标签 / 流程栏上时**不抢**它们原有的交互（见下面那段 `mousedown`）。
const FLOW_ZOOM_MIN = 0.25;
const FLOW_ZOOM_MAX = 4;
/** 滚轮灵敏度：`scale *= exp(-deltaY * 系数)` —— 一格滚轮（±100px）约 ×1.22。 */
const FLOW_ZOOM_SENSITIVITY = 0.002;
/**
 * [SEAM:view-zoom] —— 流程画布视图变换（**缩放 ＋ 平移**）的**唯一来源**（渲染 / 命中测试 / 读数都从它取）。
 * `x`/`y` 是**屏幕像素**位移：`translate` 写在 `scale` **前面** ⇒ 位移不被缩放放大，
 * 「先缩放再平移」与「先平移再缩放」拿到的是同一张图。它**不是**模型的一部分（`state.doc` 一字不写）。
 */
const viewTransform = { scale: 1, x: 0, y: 0 };
/** 吸附阈值（px）。 */
const SNAP = 6;
/** 元素类型（冻结线的封闭集合）。 */
const TYPES = ['container', 'rect', 'text', 'image', 'input', 'button', 'divider'];
const TYPE_LABEL = {
  container: '容器', rect: '矩形', text: '文本', image: '图片', input: '输入', button: '按钮', divider: '分割符',
};
/** 分割符：**语义化的分隔**（不是画上去的一条线）——长轴跟着容器伸展，短轴 = `thickness`（靠 border 给厚度）。 */
const DIVIDER_ORIENTATIONS = ['horizontal', 'vertical'];
const DIVIDER_DEFAULT_COLOR = '#4a4d56';
const DIVIDER_DEFAULT_THICKNESS = 1;
const LAYOUT_MODES = ['free', 'row', 'column', 'grid'];
const SIZE_MODES = ['fixed', 'fill', 'content'];
const ALIGN_MODES = ['start', 'center', 'end', 'stretch'];
const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'];
const FONT_WEIGHTS = ['', '300', '400', '500', '600', '700'];
const ALIGN_CSS = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
const GRID_ALIGN_CSS = { start: 'start', center: 'center', end: 'end', stretch: 'stretch' };
const DEFAULT_SIZE = {
  container: { w: 200, h: 120 }, rect: { w: 120, h: 80 }, text: { w: 120, h: 24 },
  image: { w: 120, h: 90 }, input: { w: 160, h: 32 }, button: { w: 96, h: 32 },
  // 只用于「拖出来时的落点换算」；分割符的长/短边由 orientation+thickness 决定
  divider: { w: 240, h: 1 },
};
const TAG = { container: 'div', rect: 'div', text: 'div', image: 'img', input: 'input', button: 'button', divider: 'hr' };
/** 图片占位：**内联 data URI** ⇒ 预览「零外部请求」这条不是靠自觉，是靠它本来就是内联的。 */
const IMAGE_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,'
  + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180">'
    + '<rect width="240" height="180" fill="#1b1d22" stroke="#3a3d45"/>'
    + '<circle cx="60" cy="52" r="18" fill="#3a3d45"/>'
    + '<path d="M0 180 L80 80 L140 140 L190 90 L240 150 L240 180 Z" fill="#2a2d34"/></svg>');

// ── 规范化序列化（往返必需：导出 ⇒ 导入 ⇒ 再导出 = **逐字节相同**）────────────────────────────
// 键序固定、缩进 2 格、末尾一个换行；`undefined/null` 丢掉、空的 size/box/layout/style 丢掉、
// `mode !== 'fixed'` 时丢掉 `value`、`children: []` 丢掉。未知键**不静默丢**（schema 只增不改），
// 原样挂在已知键之后（顺序 = 原插入顺序）。tokens 的键排序（那是一张映射，顺序无语义）。
const DOC_KEYS = ['$schema', 'version', 'tokens', 'screens', 'transitions'];
const SCREEN_KEYS = ['id', 'name', 'states', 'root'];
const STATE_KEYS = ['id', 'name', 'root'];
// `orientation`/`thickness`/`color` 是**只增**的新键，追加在最后 ⇒ 既有的元素序列化出来一个字节都不变。
const ELEMENT_KEYS = ['id', 'type', 'name', 'box', 'size', 'layout', 'style', 'text', 'children', 'orientation', 'thickness', 'color'];
const BOX_KEYS = ['x', 'y', 'w', 'h'];
const LAYOUT_KEYS = ['mode', 'gap', 'padding', 'columns', 'align'];
const STYLE_KEYS = ['color', 'background', 'borderRadius', 'borderWidth', 'fontSize', 'fontWeight', 'fontFamily', 'textAlign', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];
/** 单边边框（**只增**的四个新 `style` 键，追加在 `STYLE_KEYS` 末尾 ⇒ 旧文档序列化一个字节不变）。
 *  它是「3px 的槽可以被**编辑出来**」那条判据的落点：单边边框 ＋ `color`。 */
const BORDER_SIDES = ['Top', 'Right', 'Bottom', 'Left'];
const TRANSITION_KEYS = ['id', 'from', 'to', 'trigger'];
/** 转移的**两端**（顺序就是校验与报错里的顺序）。 */
const TRANSITION_ENDS = ['from', 'to'];
const END_KEYS = ['screen', 'state'];

function orderedKeys(source, keys) {
  const out = {};
  for (const key of keys) {
    if (!source || !Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  for (const key of Object.keys(source ?? {})) {
    if (keys.includes(key)) continue;
    if (source[key] === undefined) continue;
    out[key] = source[key];
  }
  return out;
}
function trimObject(value) {
  return value && Object.keys(value).length > 0 ? value : undefined;
}
function canonicalSizeAxis(spec) {
  if (!spec || typeof spec !== 'object') return undefined;
  const mode = SIZE_MODES.includes(spec.mode) ? spec.mode : 'content';
  const out = { mode };
  if (mode === 'fixed') out.value = Number.isFinite(Number(spec.value)) ? Number(spec.value) : 0;
  return out;
}
function canonicalSize(size) {
  if (!size || typeof size !== 'object') return undefined;
  const out = {};
  for (const axis of ['w', 'h']) if (size[axis]) out[axis] = canonicalSizeAxis(size[axis]);
  return trimObject(out);
}
function canonicalBox(box) {
  if (!box || typeof box !== 'object') return undefined;
  const out = {};
  for (const key of BOX_KEYS) if (Number.isFinite(Number(box[key]))) out[key] = Number(box[key]);
  return trimObject(out);
}
function canonicalLayout(layout) {
  if (!layout || typeof layout !== 'object') return undefined;
  const out = orderedKeys(layout, LAYOUT_KEYS);
  if (!out.mode) out.mode = 'free';
  if (out.mode !== 'grid') delete out.columns;
  return out;
}
function canonicalStyle(style) {
  if (!style || typeof style !== 'object') return undefined;
  return trimObject(orderedKeys(style, STYLE_KEYS));
}
function canonicalElement(element) {
  if (!element || typeof element !== 'object') return element;
  const src = {
    ...element,
    box: canonicalBox(element.box),
    size: canonicalSize(element.size),
    layout: canonicalLayout(element.layout),
    style: canonicalStyle(element.style),
  };
  for (const key of ['box', 'size', 'layout', 'style']) if (!src[key]) delete src[key];
  if (Array.isArray(src.children)) {
    const children = src.children.map(canonicalElement);
    if (children.length > 0) src.children = children; else delete src.children;
  } else {
    delete src.children;
  }
  return orderedKeys(src, ELEMENT_KEYS);
}
function canonicalState(st, index) {
  const src = { id: st.id, name: st.name };
  if (index > 0 && st.root && typeof st.root === 'object') src.root = canonicalElement(st.root);
  return orderedKeys(src, STATE_KEYS);
}
function canonicalScreen(screen) {
  return orderedKeys({
    id: screen.id,
    name: screen.name,
    states: (Array.isArray(screen.states) ? screen.states : []).map((st, index) => canonicalState(st, index)),
    root: canonicalElement(screen.root),
  }, SCREEN_KEYS);
}
function canonicalTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return {};
  const out = {};
  for (const key of Object.keys(tokens).sort()) {
    if (tokens[key] === undefined) continue;
    out[key] = tokens[key];
  }
  return out;
}
function serializeDocument(doc) {
  const out = orderedKeys({
    $schema: doc.$schema ?? SCHEMA_URL,
    version: doc.version ?? VERSION,
    tokens: canonicalTokens(doc.tokens ?? {}),
    screens: (Array.isArray(doc.screens) ? doc.screens : []).map(canonicalScreen),
    transitions: (Array.isArray(doc.transitions) ? doc.transitions : []).map((transition) => orderedKeys({
      id: transition.id,
      from: orderedKeys(transition.from ?? {}, END_KEYS),
      to: orderedKeys(transition.to ?? {}, END_KEYS),
      trigger: transition.trigger ?? '',
    }, TRANSITION_KEYS)),
  }, DOC_KEYS);
  return `${JSON.stringify(out, null, 2)}\n`;
}
/**
 * 分割符的校验（**不许静默兜底**：坏值一律抛出**可读的**错，界面如实报出来）。
 * 别的元素类型不管 —— schema 只增不改，本页不替别人的扩展发言。
 */
function validateDivider(element, where) {
  if (!DIVIDER_ORIENTATIONS.includes(element.orientation)) {
    throw new Error(`分割符 ${element.id ?? '(无 id)'}（在 ${where}）的 orientation 只能是 ${DIVIDER_ORIENTATIONS.join(' / ')}，收到 ${JSON.stringify(element.orientation)}`);
  }
  const thickness = Number(element.thickness);
  if (!Number.isFinite(thickness) || thickness <= 0) {
    throw new Error(`分割符 ${element.id ?? '(无 id)'}（在 ${where}）的 thickness 必须是正数，收到 ${JSON.stringify(element.thickness)}`);
  }
}
/**
 * 转移两端的**唯一口径**（「导入 JSON」／`setDoc()`／`addTransition()` 共用**这一份** —— 不许一处拦、一处放）：
 * 两端都必须**显式**写成 `{screen, state}`（`state` 不许省）。
 * 为什么：`flowSvg()` 拿 `${from.screen}/${from.state}` 找 (屏 · 状态) 节点，省了 `state` 就取不到 ⇒
 * 那根箭头**画不出来**，而旧校验一声不响地收下（2026-09-25 实测：`design/samples/two-pane/main-screen.json`
 * 的 4 条转移全只写了 `screen` ⇒ 转移图 0 根箭头，页面上没有任何提示）。
 * 返回一句「人话 ＋ 可粘回的路径」；两端都合法时返回 `null`。
 *
 * [SEAM:tends] —— 反证臂 `no-transition-end-check` 把 `state` 那一行的条件换成 `false`（不再查 `state`）
 * ⇒ 缺 `state` 的文档会被静默收下 ⇒ `tends:*` 那几条必红。
 */
function transitionEndIssue(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${where}: 要写成 {screen, state}，收到 ${JSON.stringify(value ?? null)}`;
  }
  if (typeof value.screen !== 'string' || value.screen.length === 0) {
    return `${where}: 缺少 "screen" —— 两端都要写成 {screen, state}（现在只有 ${JSON.stringify(value)}）`;
  }
  if (typeof value.state !== 'string' || value.state.length === 0) {
    return `${where}: 缺少 "state" —— 两端都要写成 {screen, state}（现在只有 ${JSON.stringify(value)}）`;
  }
  return null;
}
/** 全文档校验（导入时跑；屏幕上/状态里的每一棵树都走一遍）。
 *  ⚠️ 这是页面**唯一**的那套校验器（`parseDocument()` 与 `setDoc()` 都从这里进来）：
 *  「转移两端必须写全」这一条也在这儿，不在别处另写一份。 */
function validateDocument(doc) {
  for (const screen of doc.screens ?? []) {
    const trees = [[screen.root, `屏 ${screen.id}`]];
    for (const [index, st] of (screen.states ?? []).entries()) {
      trees.push([index === 0 ? screen.root : st.root, `屏 ${screen.id} · 状态 ${st.id}`]);
    }
    for (const [tree, where] of trees) {
      walkTree(tree, (element) => {
        if (element?.type === 'divider') validateDivider(element, where);
      });
    }
  }
  // 转移两端（`transitionEndIssue()` 是唯一那份口径）—— 缺 `state` 的文档在转移图里一根箭头都画不出来。
  const endIssues = [];
  (Array.isArray(doc.transitions) ? doc.transitions : []).forEach((transition, index) => {
    if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
      endIssues.push(`transitions[${index}]: 一条转移要写成对象 {id, from:{screen,state}, to:{screen,state}, trigger}，收到 ${JSON.stringify(transition ?? null)}`);
      return;
    }
    for (const end of TRANSITION_ENDS) {
      const issue = transitionEndIssue(transition[end], `transitions[${index}].${end}`);
      if (issue) endIssues.push(issue);
    }
  });
  if (endIssues.length > 0) throw new Error(endIssues.join('\n'));
  return doc;
}
/** **最低限度的形状校验**（坏 JSON / 缺 screens 一律抛，界面如实报错，不装成功）。
 *  ⚠️ 「导入 JSON」与可编程控制面的 `setDoc()` **共用这一份**（不是两套校验器）：前者喂 JSON 文本、
 *  后者喂一份对象（或文本），两者都从这里进来，再一起过 `validateDocument()`。 */
function checkDocumentShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是一份文档对象（顶层要是 JSON 对象）');
  if (!Array.isArray(parsed.screens)) throw new Error('缺 screens（文档顶层要有 screens 数组）');
  if (parsed.screens.length === 0) throw new Error('screens 是空的（至少要有一屏）');
  for (const screen of parsed.screens) {
    if (!screen || typeof screen.id !== 'string') throw new Error('某个 screen 缺 id（字符串）');
    if (!screen.root || typeof screen.root !== 'object') throw new Error(`屏 ${screen.id} 缺 root`);
  }
  return parsed;
}
/** 导入：解析 + 形状校验 + 分割符校验。 */
function parseDocument(text) {
  return validateDocument(checkDocumentShape(JSON.parse(text)));
}

// ── 文档构造 ────────────────────────────────────────────────────────────────────────────
function blankRoot() {
  return {
    id: 'el-1', type: 'container', name: '屏幕',
    size: { w: { mode: 'fixed', value: VIEWPORT.w }, h: { mode: 'fixed', value: VIEWPORT.h } },
    layout: { mode: 'free' },
    children: [],
  };
}
function blankDocument() {
  return {
    $schema: SCHEMA_URL,
    version: VERSION,
    tokens: {},
    screens: [{ id: 'screen-1', name: '屏 1', states: [{ id: 'state-1', name: '默认' }], root: blankRoot() }],
    transitions: [],
  };
}

// ── 状态 ────────────────────────────────────────────────────────────────────────────────
const state = {
  doc: blankDocument(),
  screenId: 'screen-1',
  stateId: 'state-1',
  selection: [],
  view: 'edit',
  history: [],
  historyIndex: -1,
  drag: null,
  toolDrag: null,
  /** 图层行里被折叠掉的那几支（**视图状态**：不进文档、不进撤销栈；见 `[SEAM:layer-fold]`）。 */
  folded: new Set(),
};

const node = {
  tools: document.querySelector('#dz-tools'),
  newDoc: document.querySelector('#dz-new'),
  exportBtn: document.querySelector('#dz-export'),
  copyBtn: document.querySelector('#dz-copy'),
  copyPanel: document.querySelector('#dz-copy-panel'),
  copyLead: document.querySelector('#dz-copy-lead'),
  copyWhy: document.querySelector('#dz-copy-why'),
  copyText: document.querySelector('#dz-copy-text'),
  copyClose: document.querySelector('#dz-copy-close'),
  importInput: document.querySelector('#dz-import'),
  undoBtn: document.querySelector('#dz-undo'),
  redoBtn: document.querySelector('#dz-redo'),
  viewEdit: document.querySelector('#dz-view-edit'),
  viewFlow: document.querySelector('#dz-view-flow'),
  previewOpen: document.querySelector('#dz-preview-open'),
  status: document.querySelector('#dz-status'),
  screens: document.querySelector('#dz-screens'),
  screenCount: document.querySelector('#dz-screen-count'),
  addScreen: document.querySelector('#dz-add-screen'),
  delScreen: document.querySelector('#dz-del-screen'),
  states: document.querySelector('#dz-states'),
  stateCount: document.querySelector('#dz-state-count'),
  addState: document.querySelector('#dz-add-state'),
  delState: document.querySelector('#dz-del-state'),
  layers: document.querySelector('#dz-layers'),
  frame: document.querySelector('#dz-frame'),
  canvas: document.querySelector('#dz-canvas'),
  flow: document.querySelector('#dz-flow'),
  arrows: document.querySelector('#dz-arrows'),
  flowCards: document.querySelector('#dz-flow-cards'),
  flowEmpty: document.querySelector('#dz-flow-empty'),
  flowWarn: document.querySelector('#dz-flow-warn'),
  flowAddTransition: document.querySelector('#dz-flow-add-transition'),
  flowZoomIn: document.querySelector('#dz-flow-zoom-in'),
  flowZoomOut: document.querySelector('#dz-flow-zoom-out'),
  flowZoomLevel: document.querySelector('#dz-flow-zoom-level'),
  flowZoomReset: document.querySelector('#dz-flow-zoom-reset'),
  panel: document.querySelector('#dz-panel'),
  panelNote: document.querySelector('#dz-panel-note'),
  selectionCount: document.querySelector('#dz-selection-count'),
  transitions: document.querySelector('#dz-transitions'),
  transitionCount: document.querySelector('#dz-transition-count'),
  addTransition: document.querySelector('#dz-add-transition'),
  exportMenu: document.querySelector('#dz-export-menu'),
  exportToggle: document.querySelector('#dz-export-toggle'),
  exportItems: document.querySelector('#dz-export-items'),
  tform: document.querySelector('#dz-tform'),
  tformTitle: document.querySelector('#dz-tform-title'),
  tformFromScreen: document.querySelector('#dz-tform-from-screen'),
  tformFromState: document.querySelector('#dz-tform-from-state'),
  tformToScreen: document.querySelector('#dz-tform-to-screen'),
  tformToState: document.querySelector('#dz-tform-to-state'),
  tformTrigger: document.querySelector('#dz-tform-trigger'),
  tformError: document.querySelector('#dz-tform-error'),
  tformOk: document.querySelector('#dz-tform-ok'),
  tformCancel: document.querySelector('#dz-tform-cancel'),
  tformDelete: document.querySelector('#dz-tform-delete'),
  preview: document.querySelector('#dz-preview'),
  previewStage: document.querySelector('#dz-preview-stage'),
  previewClose: document.querySelector('#dz-preview-close'),
  previewSummary: document.querySelector('#dz-preview-summary'),
};

/** 每次 renderCanvas 重建：id → DOM（量测、选中框、拖拽都读它）。 */
let elementNodes = new Map();
/** 画布覆盖层（选中框 / 手柄 / 参考线）。 */
let overlay = null;
/** 提交计数（`commit()` 被调了几次）—— 门用它钉「一次交互 = 一条历史条目」。 */
let commits = 0;

// ── 小工具 ──────────────────────────────────────────────────────────────────────────────
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const clone = (value) => structuredClone(value);
function withPx(value) {
  const text = String(value).trim();
  return /^-?\d+(\.\d+)?$/.test(text) ? `${text}px` : text;
}
function currentScreen() {
  return state.doc.screens.find((screen) => screen.id === state.screenId) ?? state.doc.screens[0];
}
function currentStateIndex() {
  const index = (currentScreen().states ?? []).findIndex((st) => st.id === state.stateId);
  return index < 0 ? 0 : index;
}
function currentState() {
  const screen = currentScreen();
  return (screen.states ?? [])[currentStateIndex()] ?? { id: state.stateId, name: state.stateId };
}
/** 当前状态的树：第 0 个状态就是 `screens[].root`；后面的状态若自带 root 就用它。 */
function getTree(screen, index) {
  if (index === 0) return screen.root;
  const st = screen.states?.[index];
  return st?.root ?? screen.root;
}
/** 可写的树：编辑非默认状态时，第一次写才把默认树**拷一份**给它（此前的历史快照仍是「没拷」的那份）。 */
function editTree() {
  const screen = currentScreen();
  const index = currentStateIndex();
  if (index === 0) return screen.root;
  const st = screen.states[index];
  if (!st.root) st.root = clone(screen.root);
  return st.root;
}
const currentTree = () => getTree(currentScreen(), currentStateIndex());

function frameSize(tree) {
  const w = tree?.size?.w;
  const h = tree?.size?.h;
  return {
    w: w?.mode === 'fixed' && num(w.value) > 0 ? num(w.value) : VIEWPORT.w,
    h: h?.mode === 'fixed' && num(h.value) > 0 ? num(h.value) : VIEWPORT.h,
  };
}
/**
 * 深度优先走一棵树。访问者返回**字面上的 `false`** ⇒ 不再往下走（图层行的折叠就靠这一条：
 * 折叠掉的那一支**真的不渲染子行**，不是拿 CSS 把它藏起来）。返回别的任何值（含 `undefined`）照常往下。
 */
function walkTree(tree, visit, depth = 0, parent = null) {
  if (!tree) return;
  if (visit(tree, depth, parent) === false) return;
  for (const child of tree.children ?? []) walkTree(child, visit, depth + 1, tree);
}
function findElement(tree, id) {
  let found = null;
  walkTree(tree, (element) => { if (element.id === id) found = element; });
  return found;
}
function findParentOf(tree, id) {
  let found = null;
  walkTree(tree, (element, _depth, parent) => { if (element.id === id) found = parent; });
  return found;
}
function elementLabel(element) {
  if (!element) return '(没了)';
  if (element.name) return element.name;
  if (element.type === 'container' && element.id === currentTree().id) return '屏幕';
  if (element.type === 'divider') return element.orientation === 'vertical' ? '竖分割符' : '横分割符';
  return TYPE_LABEL[element.type] ?? element.type;
}
function nextId(prefix) {
  const used = new Set();
  for (const screen of state.doc.screens ?? []) {
    used.add(screen.id);
    walkTree(screen.root, (element) => used.add(element.id));
    for (const st of screen.states ?? []) {
      used.add(st.id);
      if (st.root) walkTree(st.root, (element) => used.add(element.id));
    }
  }
  for (const transition of state.doc.transitions ?? []) used.add(transition.id);
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

// ── 渲染：元素 ──────────────────────────────────────────────────────────────────────────
function applyStyle(dom, element) {
  const style = element.style ?? {};
  if (style.color) dom.style.color = style.color;
  if (style.background) dom.style.background = style.background;
  if (style.borderRadius) dom.style.borderRadius = withPx(style.borderRadius);
  const borderColor = style.color || '#3a3d45';
  // 四边（`borderWidth`：老字段，语义一个字没动）
  if (style.borderWidth) {
    dom.style.borderWidth = withPx(style.borderWidth);
    dom.style.borderStyle = 'solid';
    dom.style.borderColor = borderColor;
  }
  // 单边边框（只增的四个键）：**只**给那一侧画。
  // ⚠️ 不能把全局 `border-style` 设成 solid —— 那样其它三边的宽度会变成初始值 `medium`（3px）的实线，
  //    凭空长出三条边框来。所以这里一律按「一侧一个长手属性」写。
  let leftBorder = null;
  for (const side of BORDER_SIDES) {
    const raw = style[`border${side}Width`];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = withPx(raw);
    if (side === 'Left') { leftBorder = value; continue; }
    dom.style[`border${side}Style`] = 'solid';
    dom.style[`border${side}Color`] = borderColor;
    dom.style[`border${side}Width`] = value;
  }
  if (style.borderWidth && !style.borderLeftWidth) leftBorder = withPx(style.borderWidth);
  // 左边（inline-start）正是**产品那条 3px 槽**占着的一侧（`slot.css` 用 `!important` 画它）。
  // 元素**自己**写的边框必须能盖过它，所以这一侧用**行内 `!important`**（行内 important 在级联里高于
  // 样式表 important）—— 否则 `button`/`input` 上的「3px 槽」永远做不出来。
  if (leftBorder) {
    dom.style.setProperty('border-left-width', leftBorder, 'important');
    dom.style.setProperty('border-left-style', 'solid', 'important');
    dom.style.setProperty('border-left-color', borderColor, 'important');
  }
  if (style.fontSize) dom.style.fontSize = withPx(style.fontSize);
  if (style.fontWeight) dom.style.fontWeight = String(style.fontWeight);
  if (style.fontFamily) dom.style.fontFamily = style.fontFamily;
  if (style.textAlign) dom.style.textAlign = style.textAlign;
}
/**
 * `fill` 这一档的实现（[SEAM:fill] —— 反证臂把它改成按 fixed 处理）。
 * 主轴上 `flex: 1 1 0`（真的去抢剩余空间）；交叉轴上 `align-self: stretch`；自由布局里 `100%`；网格里 `100%`。
 */
function applyFill(dom, axis, css, { parentMode, main, free }) {
  if (free || parentMode === 'grid') { dom.style[css] = '100%'; return; }
  if (main) {
    dom.style.flexGrow = '1';
    dom.style.flexShrink = '1';
    dom.style.flexBasis = '0';
    dom.style[axis === 'w' ? 'minWidth' : 'minHeight'] = '0';
    return;
  }
  dom.style.alignSelf = 'stretch';
}
function axisCss(dom, axis, spec, ctx) {
  const css = axis === 'w' ? 'width' : 'height';
  const mode = SIZE_MODES.includes(spec?.mode) ? spec.mode : 'content';
  const value = num(spec?.value);
  if (mode === 'fixed') {
    dom.style[css] = `${value}px`;
    if (ctx.main) { dom.style.flexGrow = '0'; dom.style.flexShrink = '0'; dom.style.flexBasis = 'auto'; }
    return;
  }
  // [SEAM:fill] —— 下一行是 `fill` 的**唯一**实现处（反证臂 fill-as-fixed 改的就是它）
  if (mode === 'fill') { applyFill(dom, axis, css, ctx); return; }
  dom.style[css] = 'auto';
  if (ctx.main) { dom.style.flexGrow = '0'; dom.style.flexShrink = '0'; dom.style.flexBasis = 'auto'; }
  if (ctx.parentMode === 'grid') dom.style.justifySelf = 'start';
}
/**
 * 分割符（`type === "divider"`）的**尺寸语义**：它不是「一个固定大小的盒子」，
 * 而是一条**可拉伸的分隔** —— 长轴**总是**跟着容器走，短轴才是它自己的厚度。
 *
 * [SEAM:divider] —— 下面长轴那一行就是「跟着容器伸展」的**唯一**实现处：
 *   `fill` ⇒ row/column 里抢剩余空间或沿交叉轴 stretch、grid/free 里 100%；
 *   反证臂 `divider-as-line` 把它换成 `{ mode: 'fixed', value: 1 }`（固定一像素的细矩形）⇒ 必红。
 */
function dividerSizeShim(element) {
  const vertical = element.orientation === 'vertical';
  const long = { mode: 'fill' };
  const short = { mode: 'fixed', value: 0 }; // 内容 0：厚度由下面那条 border 给
  return vertical ? { w: short, h: long } : { w: long, h: short };
}
/**
 * 分割符的外观：短轴零内容 + **一条 border**（`orientation` 决定哪条边）—— 所以导出成 HTML 时
 * 它也是一个真元素（横的 `<hr>`），而不是「一个画上去的细矩形」。颜色取自元素自己的 `color`。
 */
function applyDividerStyle(dom, element) {
  const vertical = element.orientation === 'vertical';
  const thickness = Math.max(1, num(element.thickness) || DIVIDER_DEFAULT_THICKNESS);
  const color = element.color || DIVIDER_DEFAULT_COLOR;
  dom.dataset.orientation = vertical ? 'vertical' : 'horizontal';
  dom.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
  dom.style.boxSizing = 'content-box';
  dom.style.margin = '0';
  dom.style.padding = '0';
  dom.style.borderStyle = 'solid';
  dom.style.borderColor = color;
  dom.style.borderWidth = '0';
  dom.style[vertical ? 'borderLeftWidth' : 'borderTopWidth'] = `${thickness}px`;
}
/** 分割符在**导出**里的那份映射（A 半要合就照抄这里）。 */
function dividerHtmlSpec(element) {
  return {
    tag: 'hr',
    orientation: element.orientation === 'vertical' ? 'vertical' : 'horizontal',
    thickness: Math.max(1, num(element.thickness) || DIVIDER_DEFAULT_THICKNESS),
    color: element.color || DIVIDER_DEFAULT_COLOR,
    role: 'separator',
  };
}
/**
 * 分割符在**非自由**布局里的定位：**留在流里**（`relative`）。它靠 `dividerSizeShim()` 的短轴（`fixed 0` ＋
 * `content-box` 的那条 border）在**主轴上占住 thickness**，长轴再 `fill`/`stretch` ⇒ 两个 `fill` 兄弟拿到的
 * 是「`父内容宽 - thickness`」再平分，加起来 ＋ 分割符宽 == 父宽。
 * [SEAM:divider-flow] —— 反证臂 `divider-no-place` 把下面 `return 'relative'` 改成 `return 'absolute'`
 *   （把它从流里拿掉 ⇒ 它不再占主轴）⇒ 两个 `fill` 兄弟各占一半（忽略分割符）⇒ 总宽溢出，
 *   `cols:sum-eq-parent` / `cols:follows-parent` / `cols:follows-thickness` 必红。
 */
function dividerPosition() {
  return 'relative';
}
function applySizing(dom, element, parentMode) {
  const box = element.box ?? {};
  // 分割符的尺寸**不来自** `size` 字段：长轴跟着容器伸展、短轴 = thickness（见 `dividerSizeShim()`）
  const size = element.type === 'divider' ? dividerSizeShim(element) : (element.size ?? {});
  if (parentMode === 'root') {
    dom.style.position = 'relative';
    dom.style.width = '100%';
    dom.style.height = '100%';
    dom.style.minWidth = '0';
    dom.style.minHeight = '0';
    return;
  }
  if (parentMode === 'free') {
    dom.style.position = 'absolute';
    dom.style.left = `${num(box.x)}px`;
    dom.style.top = `${num(box.y)}px`;
    axisCss(dom, 'w', size.w, { parentMode, main: false, free: true });
    axisCss(dom, 'h', size.h, { parentMode, main: false, free: true });
    return;
  }
  // 分割符**留在流里**占主轴（thickness 那条 border 就是它的占位）—— 见 `dividerPosition()` 的 [SEAM:divider-flow]。
  dom.style.position = element.type === 'divider' ? dividerPosition() : 'relative';
  const main = parentMode === 'row' ? 'w' : parentMode === 'column' ? 'h' : null;
  axisCss(dom, 'w', size.w, { parentMode, main: main === 'w', free: false });
  axisCss(dom, 'h', size.h, { parentMode, main: main === 'h', free: false });
}
function applyLayout(dom, element, childCount) {
  const layout = element.layout ?? {};
  const mode = LAYOUT_MODES.includes(layout.mode) ? layout.mode : 'free';
  dom.dataset.layoutMode = mode;
  if (mode === 'free') {
    dom.style.display = 'block';
    if (childCount === 0) dom.dataset.empty = 'true';
    return;
  }
  if (mode === 'grid') {
    dom.style.display = 'grid';
    dom.style.gridTemplateColumns = `repeat(${Math.max(1, Math.floor(num(layout.columns) || 2))}, minmax(0, 1fr))`;
    dom.style.gap = `${num(layout.gap)}px`;
    dom.style.padding = `${num(layout.padding)}px`;
    dom.style.alignItems = GRID_ALIGN_CSS[layout.align] ?? 'stretch';
    if (childCount === 0) dom.dataset.empty = 'true';
    return;
  }
  dom.style.display = 'flex';
  dom.style.flexDirection = mode === 'row' ? 'row' : 'column';
  dom.style.gap = `${num(layout.gap)}px`;
  dom.style.padding = `${num(layout.padding)}px`;
  dom.style.alignItems = ALIGN_CSS[layout.align] ?? 'flex-start';
  if (childCount === 0) dom.dataset.empty = 'true';
}
function fillContent(dom, element, opts) {
  const text = element.text ?? '';
  if (element.type === 'text') dom.textContent = text;
  else if (element.type === 'button') { dom.type = 'button'; dom.textContent = text || '按钮'; }
  else if (element.type === 'image') { dom.src = IMAGE_PLACEHOLDER; dom.alt = text || '图片'; dom.draggable = false; }
  else if (element.type === 'input') { dom.readOnly = true; dom.tabIndex = -1; dom.value = text; dom.placeholder = '输入'; }
  if (opts.static) dom.dataset.static = 'true';
}
function elementNode(element, parentMode, opts = {}) {
  const dom = document.createElement(TAG[element.type] ?? 'div');
  dom.className = `dz-el dz-el-${element.type}`;
  dom.dataset.id = element.id;
  dom.dataset.type = element.type;
  applyStyle(dom, element);
  applySizing(dom, element, parentMode);
  if (element.type === 'divider') applyDividerStyle(dom, element);
  const children = Array.isArray(element.children) ? element.children : [];
  if (element.type === 'container' || children.length > 0) applyLayout(dom, element, children.length);
  fillContent(dom, element, opts);
  for (const child of children) dom.appendChild(elementNode(child, element.layout?.mode ?? 'free', opts));
  opts.nodes?.set(element.id, dom);
  return dom;
}

// ── 渲染：画布 ──────────────────────────────────────────────────────────────────────────
function renderCanvas() {
  elementNodes = new Map();
  const tree = currentTree();
  const size = frameSize(tree);
  node.frame.innerHTML = '';
  node.frame.style.width = `${size.w}px`;
  node.frame.style.height = `${size.h}px`;
  node.frame.dataset.screen = currentScreen().id;
  node.frame.dataset.state = currentState().id;
  node.frame.appendChild(elementNode(tree, 'root', { nodes: elementNodes }));
  overlay = document.createElement('div');
  overlay.className = 'dz-overlay';
  node.frame.appendChild(overlay);
  paintSelection();
  paintMeasures();
}
function paintSelection() {
  if (!overlay) return;
  for (const [id, dom] of elementNodes) {
    dom.classList.toggle('dz-selected', state.selection.length === 1 && state.selection[0] === id);
    dom.classList.toggle('dz-multi', state.selection.length > 1 && state.selection.includes(id));
  }
  overlay.innerHTML = '';
  if (state.selection.length === 0) return;
  const primary = state.selection[state.selection.length - 1];
  const dom = elementNodes.get(primary);
  if (!dom) return;
  const handle = document.createElement('div');
  handle.className = 'dz-handle';
  handle.dataset.role = 'resize-se';
  handle.dataset.id = primary;
  handle.title = '拖这个角改尺寸（写进 size.fixed）';
  overlay.appendChild(handle);
  placeHandle(handle, dom);
}
function placeHandle(handle, dom) {
  const frameRect = node.frame.getBoundingClientRect();
  const rect = dom.getBoundingClientRect();
  handle.style.left = `${rect.right - frameRect.left}px`;
  handle.style.top = `${rect.bottom - frameRect.top}px`;
}
/** 面板里那几个「实测」读数**全部来自 DOM**（于是「画布变没变」是量出来的，不是模型自己说的）。 */
function paintMeasures() {
  const id = state.selection[state.selection.length - 1];
  const dom = id ? elementNodes.get(id) : null;
  for (const axis of ['w', 'h']) {
    const readout = node.panel.querySelector(`[data-measure="${axis}"]`);
    if (!readout) continue;
    if (!dom) { readout.textContent = '—'; continue; }
    const rect = dom.getBoundingClientRect();
    readout.textContent = `实测 ${Math.round(axis === 'w' ? rect.width : rect.height)}px`;
  }
}
function clearGuides() {
  if (!overlay) return;
  for (const guide of overlay.querySelectorAll('.dz-guide')) guide.remove();
}
function drawGuides(guides) {
  clearGuides();
  if (!overlay) return;
  const frameRect = node.frame.getBoundingClientRect();
  for (const guide of guides) {
    const dom = document.createElement('div');
    dom.className = 'dz-guide';
    dom.dataset.axis = guide.axis;
    if (guide.axis === 'x') dom.style.left = `${guide.at - frameRect.left}px`;
    else dom.style.top = `${guide.at - frameRect.top}px`;
    overlay.appendChild(dom);
  }
}

// ── 渲染：屏 / 状态 / 图层 ───────────────────────────────────────────────────────────────
function listRow({ selected, main, tag, onClick, dataset }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'dz-row';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', selected ? 'true' : 'false');
  Object.assign(row.dataset, dataset ?? {});
  const mainSpan = document.createElement('span');
  mainSpan.className = 'dz-row-main';
  mainSpan.textContent = main;
  row.appendChild(mainSpan);
  if (tag) {
    const tagSpan = document.createElement('span');
    tagSpan.className = 'dz-row-tag';
    tagSpan.textContent = tag;
    row.appendChild(tagSpan);
  }
  row.addEventListener('click', onClick);
  return row;
}
function renderScreens() {
  node.screens.innerHTML = '';
  node.screenCount.textContent = `${state.doc.screens.length}`;
  for (const screen of state.doc.screens) {
    node.screens.appendChild(listRow({
      selected: screen.id === currentScreen().id,
      main: screen.name || screen.id,
      tag: `${(screen.states ?? []).length} 状态`,
      dataset: { screen: screen.id },
      onClick: () => switchScreen(screen.id),
    }));
  }
  node.delScreen.disabled = state.doc.screens.length <= 1;
}
function renderStates() {
  node.states.innerHTML = '';
  const states = currentScreen().states ?? [];
  node.stateCount.textContent = `${states.length}`;
  for (const st of states) {
    node.states.appendChild(listRow({
      selected: st.id === currentState().id,
      main: st.name || st.id,
      tag: st.root ? '独立树' : '共用默认树',
      dataset: { state: st.id },
      onClick: () => switchState(st.id),
    }));
  }
  node.delState.disabled = states.length <= 1;
}
// ── 渲染：图层行的缩进（**留白，与会话树同形**）＋ 折叠子项（**纯视图**）────────────────────────
//
// 业主 2026-09-27 更正（逐字）：「你的缩进是有了但是**缩进之后，左侧应该是空白的，和我们的会话树一样**，
// 而不是**还存在槽位**」—— 也就是：缩进区（行内容左侧那一段）**空白**，**不要每层都留槽位**，
// 形状对齐主产品页的会话树。
//
// 会话树的实测口径（`test/tree-row-flush.mjs` 那条门 ＋ 本单在真 Chromium 里跨 4 层量的读数）：
//   · 缩进由**行自己的 `margin-inline-start = min(depth,6) × .65rem`** 表达（`.65rem = 10.4px`），
//     行的 `padding-inline-start` 恒为 0；缩进那一段**没有任何元素、没有伪元素**（`::before`/`::after` 的
//     `content` 是 `none`）—— 就是留白。
//   · 每一行**只有一条** 3px 槽，就是它**自己**那条 `border-inline-start`（`var(--slot-*)` 上色），
//     随行一起被缩进挪到该层的左缘。
// 现在的画法与本仓会话树**逐条同形**（同一份 `.65rem`、同一条「行自身槽」几何；token 仍只取
// `--slot-*` / `--design-slot-width`，不新开调色板、不硬编码色）。
//
// 折叠仍与 `[SEAM:view-zoom]` / `[SEAM:view-pan]` 同一条纪律：`state.folded` 是**视图状态**，
// `state.doc` 一个字节不动、不进撤销栈、`exportDoc()` 逐字节不变。
// [SEAM:layer-fold] 就在 `renderLayers()` 里那一行：折叠掉的那一支**真的不渲染子行**（不是 CSS 藏）。
function renderLayers() {
  node.layers.innerHTML = '';
  walkTree(currentTree(), (element, depth) => {
    node.layers.appendChild(layerRow(element, depth));
    // [SEAM:layer-fold] —— 折叠掉的那一支不再往下走（子行**根本不进 DOM**）。
    return isLayerFolded(element.id) ? false : undefined;
  });
}
/** 折叠态（视图状态，不是文档的一部分）。 */
function isLayerFolded(id) {
  return state.folded.has(id);
}
/** 这一行往下有几层/几个元素 —— 折叠按钮的读数（折叠会藏掉几个）。 */
function layerSubtreeCount(element) {
  let count = 0;
  walkTree(element, (child) => { if (child !== element) count += 1; });
  return count;
}
/** 当前选中的元素有没有落在这一支里面（折叠着的时候要说清，不让选中项在图层里凭空消失）。 */
function layerHoldsSelection(element) {
  return state.selection.some((id) => {
    let hit = false;
    walkTree(element, (child) => { if (child !== element && child.id === id) hit = true; });
    return hit;
  });
}
/** 折叠 / 展开这一支。**纯视图**：`state.doc` 一个字节不动，也不进撤销栈（只重画图层那一栏）。 */
function toggleLayerFold(id) {
  if (state.folded.has(id)) state.folded.delete(id); else state.folded.add(id);
  renderLayers();
}
/** 折叠那一格：有子项 ⇒ 真按钮（`aria-expanded` 如实）；没子项 ⇒ 占位（同一层的行标签因此对齐）。 */
function layerFoldCell(element) {
  if ((element.children ?? []).length === 0) {
    const blank = document.createElement('span');
    blank.className = 'dz-fold dz-fold-empty';
    blank.setAttribute('aria-hidden', 'true');
    return blank;
  }
  const folded = isLayerFolded(element.id);
  // 「藏着几个」只在折叠时算：展开时它是 O(子树) 的一次遍历，而这函数在拖拽的每一帧都会被叫到。
  const what = folded
    ? `展开「${elementLabel(element)}」这一支（折叠着 ${layerSubtreeCount(element)} 个子项）`
    : `折叠「${elementLabel(element)}」这一支`;
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'dz-fold';
  fold.dataset.foldLayer = element.id;
  // 折叠控件自己不吃一条槽：行左边那条槽**只**表达这一行自己的边界（缩进是留白，不画槽）。
  // `data-slot="off"` 是 `web/slot.css` 的逐元素撤销开关；2026-09-27 之前它在 `button` 上**压不过**
  //   那条 7 个 `:not()` 的通用槽（0,1,0 vs 0,7,1）—— 那时真正生效的是 `designer.css` 里那条
  //   `#dz-layers .dz-layer > .dz-fold`（1,2,0）。现在那条开关已换到 `@layer slot-off`（分层 `!important`
  //   压过未分层的，与特异性无关）⇒ 声明本身就管用了；本页那条 id 规则照旧留着（双保险，见 designer.css）。
  //   两条路的实测读数在 `test/designer-ui.mjs` 的 `layers:fold-control-shape` 与 `slot:off-switch`。
  fold.dataset.slot = 'off';
  fold.setAttribute('aria-expanded', String(!folded));
  fold.textContent = folded ? '▸' : '▾';
  // 折叠着且选中项就在这一支里时**如实说出来**（画布与属性面板照旧能看见它，只有图层这一栏看不见）。
  const label = folded && layerHoldsSelection(element)
    ? `${what} —— 当前选中的元素就在这一支里，展开才看得到它那一行（画布与属性面板不受影响）`
    : what;
  fold.setAttribute('aria-label', label);
  fold.title = label;
  fold.addEventListener('click', (event) => {
    event.stopPropagation(); // 点折叠 ≠ 点这一行：选中不许被顺手改掉
    toggleLayerFold(element.id);
  });
  return fold;
}
/**
 * 一行图层。**不是** `<button>`：这一行里要放一个**真的**折叠按钮，而 `button` 里不许再套 `button`
 * （HTML 内容模型禁止交互内容后代 —— 套了浏览器会把里面那个吞掉，`aria-expanded` 也就没人读得到）。
 * 键盘可达性与改前那个 `<button>` 一样：`tabindex="0"` ＋ Enter/Space 自己接；
 * `event.target !== row` 时不接（折叠按钮自己的 Enter/Space 归它，不能一次按键又折又选）。
 */
function layerRow(element, depth) {
  const row = document.createElement('div');
  row.className = 'dz-row dz-layer';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', state.selection.includes(element.id) ? 'true' : 'false');
  row.tabIndex = 0;
  Object.assign(row.dataset, { layer: element.id, depth: String(depth) });
  if ((element.children ?? []).length > 0) row.dataset.folded = String(isLayerFolded(element.id));
  // [SEAM:layer-indent] —— 缩进的**唯一**来源：与会话树逐字同一条几何（`web/render.js` 的
  // `marginInlineStart = Math.min(depth,6) * .65rem`）⇒ 缩进区是**留白**（没有任何按层生成的槽/引导元素），
  // 行自身那条 3px 槽随行一起挪到该层左缘（与会话树同形）。
  row.style.marginInlineStart = `${Math.min(depth, 6) * .65}rem`;
  row.appendChild(layerFoldCell(element));
  const main = document.createElement('span');
  main.className = 'dz-row-main';
  main.textContent = elementLabel(element);
  row.appendChild(main);
  const tag = document.createElement('span');
  tag.className = 'dz-row-tag';
  tag.textContent = element.type;
  row.appendChild(tag);
  const select = (event) => selectElement(element.id, { additive: event.shiftKey || event.metaKey || event.ctrlKey });
  row.addEventListener('click', select);
  row.addEventListener('keydown', (event) => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    select(event);
  });
  return row;
}

// ── 渲染：属性面板 ───────────────────────────────────────────────────────────────────────
function field(labelText, control, { wide = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = wide ? 'dz-field dz-field-wide' : 'dz-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(control);
  return wrap;
}
function group(title, { vocab } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'dz-group';
  // `data-vocab` 标出这一组属于哪套语汇（free / auto / root / container / divider）—— 门按它断言「该有的在、不该有的不在」。
  if (vocab) wrap.dataset.vocab = vocab;
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.appendChild(h);
  return wrap;
}
/** 一行说明（「为什么这一格不在这里」）。 */
function note(text) {
  const p = document.createElement('p');
  p.className = 'dz-note';
  p.textContent = text;
  return p;
}
function textInput(value, onInput, onChange, extra = {}) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  Object.assign(input.dataset, extra.dataset ?? {});
  if (extra.step) input.step = String(extra.step);
  input.addEventListener('input', () => onInput(input.value));
  if (onChange) input.addEventListener('change', () => onChange(input.value));
  return input;
}
function numberInput(value, onInput, onChange, extra = {}) {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value ?? 0);
  Object.assign(input.dataset, extra.dataset ?? {});
  input.addEventListener('input', () => { const v = Number(input.value); if (Number.isFinite(v)) onInput(v); });
  if (onChange) input.addEventListener('change', () => { const v = Number(input.value); if (Number.isFinite(v)) onChange(v); });
  return input;
}
function selectInput(value, options, onChange, extra = {}) {
  const select = document.createElement('select');
  Object.assign(select.dataset, extra.dataset ?? {});
  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}
function axisEditor(element, axis, { free, role } = {}) {
  const spec = element.size?.[axis] ?? { mode: 'content' };
  const row = document.createElement('div');
  row.className = 'dz-axis';
  const tag = document.createElement('span');
  // 轴的角色（主轴 / 交叉轴 / 网格 / 宽 / 高）写在标签上：让人一眼知道这一格在 auto 语义里管哪一头。
  tag.textContent = role ? `${axis.toUpperCase()} · ${role}` : axis.toUpperCase();
  tag.dataset.axis = axis;
  if (role) tag.dataset.role = role;
  row.appendChild(tag);
  const modeSelect = selectInput(spec.mode ?? 'content', SIZE_MODES.map((mode) => ({ value: mode, label: mode })), (next) => {
    changeModel(() => {
      const target = element.size ?? (element.size = {});
      const measured = Math.round(measuredSize(element)[axis === 'w' ? 'w' : 'h']);
      const value = next === 'fixed' ? (num(spec.value) || measured || DEFAULT_SIZE[element.type]?.[axis] || 100) : undefined;
      target[axis] = value === undefined ? { mode: next } : { mode: next, value };
    });
  }, { dataset: { field: `size-${axis}-mode` } });
  row.appendChild(modeSelect);
  const valueInput = numberInput(num(spec.value), (next) => {
    changeModel(() => { element.size = { ...(element.size ?? {}), [axis]: { mode: 'fixed', value: next } }; }, { live: true });
  }, (next) => {
    changeModel(() => { element.size = { ...(element.size ?? {}), [axis]: { mode: 'fixed', value: next } }; });
  }, { dataset: { field: `size-${axis}-value` } });
  valueInput.disabled = (spec.mode ?? 'content') !== 'fixed';
  row.appendChild(valueInput);
  const measure = document.createElement('span');
  measure.className = 'dz-measure';
  measure.dataset.measure = axis;
  measure.textContent = '—';
  row.appendChild(measure);
  return row;
}
function measuredSize(element) {
  const dom = elementNodes.get(element.id);
  const rect = dom?.getBoundingClientRect();
  return { w: rect?.width ?? 0, h: rect?.height ?? 0 };
}
/** 分区标题：属性面板按**语汇**分组，标题自己说明这一组属于哪一套。 */
const VOCAB_TITLE = {
  free: '自由定位（父容器是自由容器）',
  auto: '自动排布（父容器是 row / column / grid）',
  root: '屏根（这一屏的画布尺寸）',
};
/**
 * 属性面板**跟着父容器换语汇**（作业单①：这正是「改了没反应」的来源 —— 结构上它是被忽略的）。
 *   · 父容器 `free`  ⇒ 自由定位（X/Y 来自 `box`，W/H 来自 `size`）；
 *   · 父容器 row/column/grid ⇒ 自动排布（只有 `size` 三档，**没有** `box`）；
 *   · 屏根 ⇒ 画布尺寸。
 * 另一套**整组不出现**（不是禁用假装的）—— 见 `renderPanel()` 里按这个值分支。
 * [SEAM:panel-context] —— 反证臂 `panel-ignores-parent` 把下面 `return` 那一行改成 `return 'free';`
 *   （不看父容器）⇒ auto 父容器下也照旧显示并允许改 `box` ⇒ `panel:auto-vocab` / `panel:hidden-not-usable` 必红。
 */
function placementVocab(parentMode) {
  if (parentMode === 'free') return 'free';
  if (parentMode === 'root') return 'root';
  return 'auto';
}
function renderPanel() {
  const panel = node.panel;
  panel.innerHTML = '';
  const selection = state.selection;
  node.selectionCount.textContent = selection.length > 0 ? `选中 ${selection.length}` : '';
  const tree = currentTree();
  const screen = currentScreen();
  const st = currentState();

  const screenGroup = group('屏 / 状态');
  screenGroup.appendChild(field('屏名', textInput(screen.name, (value) => {
    changeModel(() => { screen.name = value; }, { live: true });
  }, (value) => { changeModel(() => { screen.name = value; }); }, { dataset: { field: 'screen-name' } })));
  screenGroup.appendChild(field('状态名', textInput(st.name, (value) => {
    changeModel(() => { st.name = value; }, { live: true });
  }, (value) => { changeModel(() => { st.name = value; }); }, { dataset: { field: 'state-name' } })));
  panel.appendChild(screenGroup);

  if (selection.length === 1) {
    const element = findElement(tree, selection[0]);
    if (!element) { state.selection = []; return renderPanel(); }
    const parent = findParentOf(tree, element.id);
    const parentMode = parent ? (parent.layout?.mode ?? 'free') : 'root';
    node.panelNote.textContent = `${elementLabel(element)}　·　${element.type}　·　id=${element.id}　·　父容器布局 = ${parent ? (parent.layout?.mode ?? 'free') : '屏根'}`;

    const elementGroup = group('元素');
    elementGroup.appendChild(field('名字', textInput(element.name ?? '', (value) => {
      changeModel(() => { element.name = value; }, { live: true });
    }, (value) => { changeModel(() => { element.name = value; }); }, { dataset: { field: 'element-name' } })));
    const order = document.createElement('div');
    order.className = 'dz-inline';
    order.appendChild(button('上移', () => moveElement(element, -1)));
    order.appendChild(button('下移', () => moveElement(element, 1)));
    order.appendChild(button('复制', () => duplicateElement(element)));
    order.appendChild(button('删掉', () => removeElement(element)));
    elementGroup.appendChild(order);
    panel.appendChild(elementGroup);

    // ── 位置 / 尺寸这一组**由父容器决定显示哪套语汇**（分割符在非 free 父容器里没有自己的尺寸）──
    const vocab = element.type === 'divider' && parentMode !== 'free' ? null : placementVocab(parentMode);
    if (vocab === 'free') {
      const freeGroup = group(VOCAB_TITLE.free, { vocab: 'free' });
      freeGroup.appendChild(field('X', numberInput(num(element.box?.x), (value) => {
        changeModel(() => { element.box = { ...(element.box ?? {}), x: value }; }, { live: true });
      }, (value) => { changeModel(() => { element.box = { ...(element.box ?? {}), x: value }; }); }, { dataset: { field: 'box-x' } })));
      freeGroup.appendChild(field('Y', numberInput(num(element.box?.y), (value) => {
        changeModel(() => { element.box = { ...(element.box ?? {}), y: value }; }, { live: true });
      }, (value) => { changeModel(() => { element.box = { ...(element.box ?? {}), y: value }; }); }, { dataset: { field: 'box-y' } })));
      if (element.type === 'divider') {
        freeGroup.appendChild(note('分割符没有自己的 W/H：长边跟着容器伸展（`fill`），短边 = 粗细（`thickness` 那条 border）。'));
      } else {
        freeGroup.appendChild(axisEditor(element, 'w', { free: true, role: '宽' }));
        freeGroup.appendChild(axisEditor(element, 'h', { free: true, role: '高' }));
      }
      panel.appendChild(freeGroup);
    } else if (vocab === 'auto') {
      const mainAxis = parentMode === 'row' ? 'w' : parentMode === 'column' ? 'h' : null;
      const roleOf = (axis) => (parentMode === 'grid' ? '网格' : (axis === mainAxis ? '主轴' : '交叉轴'));
      const autoGroup = group(VOCAB_TITLE.auto, { vocab: 'auto' });
      autoGroup.appendChild(axisEditor(element, 'w', { role: roleOf('w') }));
      autoGroup.appendChild(axisEditor(element, 'h', { role: roleOf('h') }));
      autoGroup.appendChild(note(`父容器是 ${parentMode}：位置由布局语义决定，所以这里**没有** X/Y（自由定位那一套整组不出现、改了也不生效）。`));
      panel.appendChild(autoGroup);
    } else if (vocab === 'root') {
      const rootGroup = group(VOCAB_TITLE.root, { vocab: 'root' });
      rootGroup.appendChild(axisEditor(element, 'w', { role: '画布宽' }));
      rootGroup.appendChild(axisEditor(element, 'h', { role: '画布高' }));
      rootGroup.appendChild(note('这是屏根容器：它的 W/H（`fixed` 时）就是这一屏画布的大小。'));
      panel.appendChild(rootGroup);
    }

    if (element.type === 'divider') {
      // 分割符没有「尺寸三档」：它的长短边由方向 + 粗细推出来（渲染器保证），所以这里只给那三格。
      const dividerGroup = group('分割符（可拉伸的分隔）', { vocab: 'divider' });
      dividerGroup.appendChild(field('方向', selectInput(element.orientation ?? 'horizontal', DIVIDER_ORIENTATIONS.map((value) => ({
        value, label: value === 'horizontal' ? '横（分隔上下）' : '竖（分隔左右）',
      })), (next) => {
        changeModel(() => { element.orientation = next; });
      }, { dataset: { field: 'divider-orientation' } })));
      const thicknessInput = numberInput(num(element.thickness) || DIVIDER_DEFAULT_THICKNESS, (value) => {
        if (!Number.isFinite(value) || value <= 0) {
          // 坏值 ⇒ **可读报错**、**不写进文档**（也不偷偷改成 1）；框里就留着你填的那个值，看得见错在哪
          setStatus(`分割符的「粗细」必须是正数（收到「${thicknessInput.value}」）—— 没有写进文档`, 'error');
          thicknessInput.setAttribute('aria-invalid', 'true');
          return;
        }
        thicknessInput.removeAttribute('aria-invalid');
        changeModel(() => { element.thickness = value; }, { live: true });
      }, (value) => {
        if (!Number.isFinite(value) || value <= 0) {
          setStatus(`分割符的「粗细」必须是正数（收到「${value}」）—— 没有写进文档`, 'error');
          thicknessInput.setAttribute('aria-invalid', 'true');
          return;
        }
        thicknessInput.removeAttribute('aria-invalid');
        changeModel(() => { element.thickness = value; });
      }, { dataset: { field: 'divider-thickness' } });
      dividerGroup.appendChild(field('粗细', thicknessInput));
      dividerGroup.appendChild(field('颜色', textInput(element.color ?? DIVIDER_DEFAULT_COLOR, (value) => {
        changeModel(() => { element.color = value; }, { live: true });
      }, (value) => { changeModel(() => { element.color = value; }); }, { dataset: { field: 'divider-color' } })));
      dividerGroup.appendChild(note('长边跟着容器伸展（row / column / grid / free 都是），短边 = 粗细（一条真 border）⇒ 它不是「画上去的一条线」，也没有自己的 X/Y/W/H 三档。'));
      panel.appendChild(dividerGroup);
    }

    if (element.type === 'container') {
      const layout = element.layout ?? (element.layout = { mode: 'free' });
      const layoutGroup = group('容器布局（这个容器自己怎么排布它的子元素）', { vocab: 'container' });
      layoutGroup.appendChild(field('模式', selectInput(layout.mode ?? 'free', LAYOUT_MODES.map((mode) => ({ value: mode, label: mode })), (next) => {
        changeModel(() => { element.layout = { ...(element.layout ?? {}), mode: next }; });
      }, { dataset: { field: 'layout-mode' } })));
      layoutGroup.appendChild(field('间距', numberInput(num(layout.gap), (value) => {
        changeModel(() => { element.layout = { ...(element.layout ?? {}), gap: value }; }, { live: true });
      }, (value) => { changeModel(() => { element.layout = { ...(element.layout ?? {}), gap: value }; }); }, { dataset: { field: 'layout-gap' } })));
      layoutGroup.appendChild(field('内边距', numberInput(num(layout.padding), (value) => {
        changeModel(() => { element.layout = { ...(element.layout ?? {}), padding: value }; }, { live: true });
      }, (value) => { changeModel(() => { element.layout = { ...(element.layout ?? {}), padding: value }; }); }, { dataset: { field: 'layout-padding' } })));
      layoutGroup.appendChild(field('列数（grid）', numberInput(num(layout.columns) || 2, (value) => {
        changeModel(() => { element.layout = { ...(element.layout ?? {}), columns: Math.max(1, Math.round(value)) }; }, { live: true });
      }, (value) => { changeModel(() => { element.layout = { ...(element.layout ?? {}), columns: Math.max(1, Math.round(value)) }; }); }, { dataset: { field: 'layout-columns' } })));
      layoutGroup.appendChild(field('对齐', selectInput(layout.align ?? 'start', [{ value: 'start', label: 'start' }, { value: 'center', label: 'center' }, { value: 'end', label: 'end' }, { value: 'stretch', label: 'stretch' }], (next) => {
        changeModel(() => { element.layout = { ...(element.layout ?? {}), align: next }; });
      }, { dataset: { field: 'layout-align' } })));
      panel.appendChild(layoutGroup);
    }

    if (element.type === 'divider') return; // 分割符的外观在「分割符」那一组里（color），不走 style 八项
    const style = element.style ?? {};
    const styleGroup = group('样式');
    for (const [key, label] of [['color', '文字色'], ['background', '背景'], ['borderRadius', '圆角'], ['borderWidth', '边框宽'], ['fontSize', '字号'], ['fontFamily', '字体']]) {
      styleGroup.appendChild(field(label, textInput(style[key] ?? '', (value) => {
        changeModel(() => { element.style = { ...(element.style ?? {}), [key]: value }; }, { live: true });
      }, (value) => { changeModel(() => { element.style = { ...(element.style ?? {}), [key]: value }; }); }, { dataset: { field: `style-${key}` } })));
    }
    styleGroup.appendChild(field('字重', selectInput(String(style.fontWeight ?? ''), FONT_WEIGHTS.map((weight) => ({ value: weight, label: weight || '(默认)' })), (next) => {
      changeModel(() => {
        const target = { ...(element.style ?? {}) };
        if (next) target.fontWeight = next; else delete target.fontWeight;
        element.style = target;
      });
    }, { dataset: { field: 'style-fontWeight' } })));
    styleGroup.appendChild(field('文本对齐', selectInput(style.textAlign ?? 'left', TEXT_ALIGNS.map((value) => ({ value, label: value })), (next) => {
      changeModel(() => { element.style = { ...(element.style ?? {}), textAlign: next }; });
    }, { dataset: { field: 'style-textAlign' } })));
    panel.appendChild(styleGroup);

    // 单边边框：**只增**的四格。它是「那条 3px 槽能在编辑器里做出来」的落点：左 = 3 ＋ 文字色。
    const sidesGroup = group('边框（单边 —— 背景 / 边框 / 槽都是这样做出来的）');
    for (const [key, label] of [['borderTopWidth', '上'], ['borderRightWidth', '右'], ['borderBottomWidth', '下'], ['borderLeftWidth', '左（槽）']]) {
      sidesGroup.appendChild(field(label, textInput(style[key] ?? '', (value) => {
        changeModel(() => { element.style = { ...(element.style ?? {}), [key]: value }; }, { live: true });
      }, (value) => { changeModel(() => { element.style = { ...(element.style ?? {}), [key]: value }; }); }, { dataset: { field: `style-${key}` } })));
    }
    panel.appendChild(sidesGroup);

    if (element.type !== 'container' && element.type !== 'rect') {
      const contentGroup = group('内容');
      contentGroup.appendChild(field('文本', textInput(element.text ?? '', (value) => {
        changeModel(() => { element.text = value; }, { live: true });
      }, (value) => { changeModel(() => { element.text = value; }); }, { dataset: { field: 'element-text' } })));
      panel.appendChild(contentGroup);
    }

    if (selection.length >= 2) panel.appendChild(alignGroup());
  } else if (selection.length > 1) {
    node.panelNote.textContent = `选中 ${selection.length} 个元素（多选：在画布上按住 shift 点，或在图层里 shift 点）。`;
    panel.appendChild(alignGroup());
  } else {
    node.panelNote.textContent = '未选中元素。在画布上点一个元素、或在左栏图层里点。';
  }
}
function button(label, onClick) {
  const dom = document.createElement('button');
  dom.type = 'button';
  dom.className = 'dz-btn dz-btn-sm';
  dom.textContent = label;
  dom.addEventListener('click', onClick);
  return dom;
}
function alignGroup() {
  const wrap = group('对齐（自由布局的同级之间）');
  const grid = document.createElement('div');
  grid.className = 'dz-align';
  for (const [mode, label] of [['left', '左'], ['hcenter', '中'], ['right', '右'], ['top', '上'], ['vcenter', '中'], ['bottom', '下']]) {
    const dom = button(label, () => alignSelection(mode));
    dom.dataset.align = mode;
    dom.title = `对齐：${label}`;
    grid.appendChild(dom);
  }
  wrap.appendChild(grid);
  return wrap;
}

// ── 渲染：转移（箭头的数据）────────────────────────────────────────────────────────────
function renderTransitions() {
  node.transitions.innerHTML = '';
  const transitions = state.doc.transitions ?? [];
  node.transitionCount.textContent = `${transitions.length}`;
  if (transitions.length === 0) {
    const note = document.createElement('p');
    note.className = 'dz-note';
    note.textContent = '还没有转移 —— 流程画布上就一根箭头都没有。';
    node.transitions.appendChild(note);
    return;
  }
  const screenOptions = state.doc.screens.map((screen) => ({ value: screen.id, label: screen.name || screen.id }));
  for (const transition of transitions) {
    const row = document.createElement('div');
    row.className = 'dz-transition';
    row.dataset.transition = transition.id;
    const grid = document.createElement('div');
    grid.className = 'dz-transition-grid';
    const fromScreen = transition.from?.screen ?? state.doc.screens[0].id;
    const toScreen = transition.to?.screen ?? state.doc.screens[0].id;
    const statesOf = (screenId) => (state.doc.screens.find((s) => s.id === screenId)?.states ?? []).map((s) => ({ value: s.id, label: s.name || s.id }));
    grid.appendChild(selectInput(fromScreen, screenOptions, (next) => {
      changeModel(() => { transition.from = { screen: next, state: statesOf(next)[0]?.value }; });
    }, { dataset: { field: 'from-screen' } }));
    grid.appendChild(selectInput(transition.from?.state ?? statesOf(fromScreen)[0]?.value ?? '', statesOf(fromScreen), (next) => {
      changeModel(() => { transition.from = { ...(transition.from ?? {}), state: next }; });
    }, { dataset: { field: 'from-state' } }));
    grid.appendChild(selectInput(toScreen, screenOptions, (next) => {
      changeModel(() => { transition.to = { screen: next, state: statesOf(next)[0]?.value }; });
    }, { dataset: { field: 'to-screen' } }));
    grid.appendChild(selectInput(transition.to?.state ?? statesOf(toScreen)[0]?.value ?? '', statesOf(toScreen), (next) => {
      changeModel(() => { transition.to = { ...(transition.to ?? {}), state: next }; });
    }, { dataset: { field: 'to-state' } }));
    row.appendChild(grid);
    const foot = document.createElement('div');
    foot.className = 'dz-transition-foot';
    const trigger = textInput(transition.trigger ?? '', (value) => {
      changeModel(() => { transition.trigger = value; }, { live: true });
    }, (value) => { changeModel(() => { transition.trigger = value; }); }, { dataset: { field: 'trigger' } });
    trigger.placeholder = '触发（这一句会写在箭头上）';
    foot.appendChild(trigger);
    foot.appendChild(button('删掉', () => {
      changeModel(() => { state.doc.transitions = (state.doc.transitions ?? []).filter((t) => t.id !== transition.id); });
    }));
    row.appendChild(foot);
    node.transitions.appendChild(row);
  }
}

// ── 渲染：流程画布（箭头由 transitions 生成）─────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';
/** 标签排版的常量（门里的 N 就按 `LABEL_OFFSET` 定，见 `docs/design/designer-ui.md` §4.1）。
 *  · `LABEL_PAD`：不透明底在文字外面留出来的边（px）；
 *  · `LABEL_OFFSET`：挤在一起时沿**路径法线**最多挪多远（px）—— 它同时是「标签中心到它自己那条线」的上界。 */
const LABEL_PAD = 3;
const LABEL_OFFSET = 16;
/** 标签字号（px）—— 与 `.dz-arrow-label` 的 CSS 声明同值；缩放时乘 `labelZoom()` 后**内联**上去。 */
const LABEL_FONT = 10;
/** 沿路径**前后挪**的候选位置：先中点，再两边对称扩散（越靠前的越优先）。 */
const LABEL_FRACTIONS = [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8];
/** 以 `center` 为中心、`size` 那么大的矩形（标签盒子的统一形状）。 */
const boxAround = (center, size) => ({ x: center.x - size.w / 2, y: center.y - size.h / 2, w: size.w, h: size.h });
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * [SEAM:arrow-labels] —— 「一个标签落在**它自己那条线上的哪一点**」的**唯一出处**。
 * 反证臂 `labels-one-point` 把 `labelCandidatesOnPath()` 换成「只返回同一个点」
 * ⇒ `labels:on-own-path`（跑到线外去了）与 `labels:no-overlap`（全叠在一处）必红。
 *
 * 策略（就是文档里写着的那条规则，两条实现——流程画布与导出的 `*.flow.svg`——共用它）：
 *   ① 先在**中点**试（0.5）；② 挤了就把候选点沿路径**前后挪**（±0.06、±0.12、…）；
 *   ③ 还挤就让标签沿**路径法线**上下错开一点（±`LABEL_OFFSET` —— 最外圈的那些候选点）；
 *   ④ 全都挤（几十条线挤在一处）⇒ 取**重叠面积最小**的那个，宁可叠一点，**绝不把标签搬到离线更远的地方**
 *      （那样它会变成一条对不上自己那条线的标签）。⇒「标签中心到它自己那条线 ≤ `LABEL_OFFSET` + 一点点」
 *      这条在**任何**文档上都成立（门量的是 ≤ 18px）。
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
/**
 * [SEAM:arrows] —— 画布上**每一根**箭头的唯一来源。
 * 反证臂 `painted-arrows` 把下一行换成一份写死的箭头 ⇒「删掉 transition 箭头却还在」必红。
 */
function arrowSpecs() {
  return state.doc.transitions.map((transition) => transitionArrow(transition)).filter(Boolean);
}
function transitionArrow(transition) {
  const from = state.doc.screens.findIndex((screen) => screen.id === transition.from?.screen);
  const to = state.doc.screens.findIndex((screen) => screen.id === transition.to?.screen);
  if (from < 0 || to < 0) return null;
  return {
    id: transition.id,
    from, to,
    self: from === to,
    label: String(transition.trigger ?? ''),
    fromState: transition.from?.state ?? null,
    toState: transition.to?.state ?? null,
    // 起点锚（可选）：`from.anchor.selector` **原样**带过来 —— 解不解析得动是画的时候的事（见 `anchorBoxOnCanvas()`）。
    anchor: transition.from?.anchor ?? null,
  };
}
/**
 * [SEAM:zoom-labels] —— 缩放态下标签度量的**放大倍数**（字号 / 边距 / 避让距离一并乘它）。
 * 标签是**屏幕空间**的东西（路径坐标本来就是屏幕坐标）：让它的度量跟着 `viewTransform.scale` 走，
 * 缩放后标签与箭头/卡片的比例才不变 —— 「不叠、贴在自己那条线上」两条在任何档位下同样成立。
 * 反证臂 `zoom-labels-ignore` 把它换成常数 1 ⇒ 50% 档下标签挤成一团必红。
 */
function labelZoom() {
  return viewTransform.scale;
}

/**
 * [SEAM:view-zoom] —— 视图变换（**缩放 ＋ 平移**）的**唯一应用点**：只写 CSS（`.dz-flow-cards` 的 `transform`）。
 * 定点选在 **SVG 层的原点**（`#dz-arrows` 左上角）：先把 transform 摘掉、量两张**未变换**的实测矩形，
 * 两者之差就是卡片层到 SVG 原点的固定偏移（与**滚动位置**、与**平移量**都无关）⇒ 整块画布绕它等比缩放，
 * 缩放就是 z=1 那张图的等比放大（标签的相对排布一字不变）；平移是屏幕像素位移（与缩放量无关）。
 * ⚠️ 这里**给 `state.doc` 一个字节都不写** —— 反证臂 `zoom-mutates-model` 把施加变换那一行
 * 换成往文档里写一个键 ⇒「纯视图（文档字节不变）」与「画布真的放大」两条必红。
 */
function applyFlowZoom() {
  node.flowCards.style.transform = 'none';
  const cardsRect = node.flowCards.getBoundingClientRect();
  const svgRect = node.arrows.getBoundingClientRect();
  node.flowCards.style.transformOrigin = `${svgRect.left - cardsRect.left}px ${svgRect.top - cardsRect.top}px`;
  // [SEAM:view-zoom] [SEAM:view-pan] —— 把**缩放与平移**施加到画布的唯一一行（两条反证臂各摘一半）
  node.flowCards.style.transform = `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`;
  if (node.flowZoomLevel) {
    node.flowZoomLevel.textContent = `${Math.round(viewTransform.scale * 100)}%`;
    node.flowZoomLevel.dataset.zoom = String(viewTransform.scale);
  }
}
let arrowPaintHandle = null;
/** 视图一变，连线的端点就得按**新的**实测矩形重算（同一帧里合并成一次，拖动时不排一长串 rAF）。 */
function scheduleArrowPaint() {
  if (state.view !== 'flow') return;
  if (arrowPaintHandle !== null) cancelAnimationFrame(arrowPaintHandle);
  arrowPaintHandle = requestAnimationFrame(() => { arrowPaintHandle = null; paintArrows(); });
}
function setFlowZoom(next) {
  const wanted = Number(next);
  if (!Number.isFinite(wanted)) return viewTransform.scale;
  viewTransform.scale = Math.min(FLOW_ZOOM_MAX, Math.max(FLOW_ZOOM_MIN, wanted));
  applyFlowZoom();
  scheduleArrowPaint();
  return viewTransform.scale;
}
/**
 * [SEAM:view-pan] —— 平移（**屏幕像素**）：与缩放共用 `viewTransform` 与**同一个**施加点。
 * 非有限数直接忽略（不留半成品）；回执是**落地后**的实际位移。
 */
function setFlowPan(nextX, nextY) {
  const x = Number(nextX);
  const y = Number(nextY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: viewTransform.x, y: viewTransform.y };
  viewTransform.x = x;
  viewTransform.y = y;
  applyFlowZoom();
  scheduleArrowPaint();
  return { x: viewTransform.x, y: viewTransform.y };
}
const zoomFlowBy = (factor) => setFlowZoom(viewTransform.scale * factor);
/** 「重置」= 回到**正好** 100% **且**回到原位（把画布拖丢之后的退路：缩放与平移一起归零）。 */
const resetFlowZoom = () => { viewTransform.x = 0; viewTransform.y = 0; return setFlowZoom(1); };
/** 滚轮一格：`deltaMode` 归一成像素（行/页模式换算一下），再按指数步进。 */
function wheelZoomDelta(event) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
  return Number(event.deltaY || 0) * unit;
}

function renderFlow() {
  if (state.view !== 'flow') return;
  // 视图可见之后才量得到真矩形 ⇒ 每次渲染都重算一次定点（窗口改宽/改高后栏会换行，定点也跟着变）
  applyFlowZoom();
  // 空态要说人话（不是「一片空白让人猜」）：一条转移都没有时，把「去哪儿加」直接写出来
  node.flowEmpty.hidden = (state.doc.transitions ?? []).length > 0;
  // 那条警告线的**唯一**写入处（现在还没量锚点 ⇒ 先只写节点那一半；`paintArrows()` 里补上锚点那一半）
  renderFlowWarn();
  node.flowCards.innerHTML = '';
  const cards = [];
  state.doc.screens.forEach((screen, index) => {
    const card = document.createElement('div');
    card.className = 'dz-card';
    card.dataset.screen = screen.id;
    card.dataset.index = String(index);
    if (screen.id === currentScreen().id) card.dataset.current = 'true';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'dz-card-head';
    const name = document.createElement('span');
    name.className = 'dz-row-main';
    name.textContent = screen.name || screen.id;
    head.appendChild(name);
    const count = document.createElement('span');
    count.className = 'dz-count';
    count.textContent = `${(screen.states ?? []).length} 状态`;
    head.appendChild(count);
    head.addEventListener('click', () => switchScreen(screen.id));
    card.appendChild(head);
    const body = document.createElement('div');
    body.className = 'dz-card-body';
    const size = frameSize(screen.root);
    body.style.width = `${Math.round(size.w * FLOW_SCALE)}px`;
    body.style.height = `${Math.round(size.h * FLOW_SCALE)}px`;
    const scale = document.createElement('div');
    scale.className = 'dz-card-scale';
    scale.style.width = `${size.w}px`;
    scale.style.height = `${size.h}px`;
    scale.style.transform = `scale(${FLOW_SCALE})`;
    scale.appendChild(elementNode(screen.root, 'root', { static: true }));
    body.appendChild(scale);
    card.appendChild(body);
    node.flowCards.appendChild(card);
    cards.push(card);
  });
  requestAnimationFrame(() => paintArrows(cards));
}
// ── 转移起点锚（`from.anchor.selector`）：起点从「那个控件盒子的边」出发，不是从卡片边 ─────────────
//
// 口径与 A 半的导出器（`designer/toSvg.mjs` 的 `anchorBoxOf()` / `edgePointToward()`）**是同一条**：
//   · 选择器**只认 `#<元素 id>`**（与 `designer/validate.mjs` 的 `anchorElementId()` 同一个正则）——
//     别的写法（`.class` / `[id=…]` / 复合选择器）**不猜**（猜错会画出「看着对、其实指错控件」的箭头）；
//   · 起点 = 从**锚点盒子中心朝目标**引一条射线、取它**穿出盒子**的那个点
//     （就是「朝向目标那一侧的那条边」上的落点；与导出器的 `edgePointToward()` 同一式）；
//   · 指不到（元素不在这一屏的内容里）／写法不认／那个控件在**画出来的屏内容**里没有可见位置
//     ⇒ **退回卡片上那个默认起点**（朝向目标那一侧边的中点），并把「退回」写成判据
//     （`test/designer-ui.mjs` 的 `flow-anchor` 组）—— 不许静默乱画。
//   · 退回**本身**（落点、路径字节）一个字节不改（没带锚点的转移逐字节还是改动前那一式）；
//     但「带锚点却退回」这件事**要说出来**：path 上留 `data-anchor-fallback=<封闭原因>`
//     （见 `[SEAM:anchor-fallback]` 与 `anchorFallbackReason()`），流程视图那条既有的警告线上再点一次名。
//     ⇒ 站在页面前面的人不再「看不出自己写的锚点没生效」（交接单自报的第 ④ 条缺口）。
//
// 与导出器的**唯一**差别在「盒子怎么来」：那边节点是个紧凑盒子、不画屏内容 ⇒ 锚点盒子是**算**的
// （屏坐标系里的控件盒子按逐轴比例映进节点框）；这边屏内容就是**真 DOM**（`elementNode()` 画的）⇒ 直接
// 量控件的**实测矩形**。两种取法都天然带上各自那一套缩放：这边量到的是「屏内 `FLOW_SCALE` 缩放 ＋
// 画布 `viewTransform` 缩放/平移」之后的屏幕坐标，再减去 SVG 原点就是画布坐标。
// ⇒ 这里**不另算一套几何**（`anchorBoxOnCanvas()` 里既不出现 `viewTransform`、也不出现 `FLOW_SCALE`）。
/**
 * [SEAM:anchor-name] —— 锚点选择器的**唯一**解析处：只认 `#<元素 id>`，别的一律 `null`（不猜）。
 * 反证臂 `anchor-any-selector` 把它与下面「按 id 查元素」那两行一起换成「写法不认就 `fromCard.querySelector(selector)`」
 * ⇒「写法不认 ⇒ 退回默认起点」必红（`[data-id="el-input-name"]` 那种写法会被当锚点用）。
 */
function anchorTargetId(selector) {
  if (typeof selector !== 'string') return null;
  const match = /^\s*#([^\s#.\[\]:>+~,*]+)\s*$/.exec(selector);
  return match === null ? null : match[1];
}
/** 在**这张卡片**里按 `data-id` 找那个元素的真 DOM（元素 id 全文档唯一 ⇒ 命中至多一个）。
 *  不走 `querySelector('#id')`：元素 id 是文档里的字符串，直接拼进选择器要另做转义（`CSS.escape`），
 *  而这里比对的是属性值本身 —— 少一个可能出错的地方。 */
function findCardElement(card, id) {
  for (const dom of card.querySelectorAll('[data-id]')) {
    if (dom.getAttribute('data-id') === id) return dom;
  }
  return null;
}
/** 「起点锚没生效」的**封闭原因集** —— `data-anchor-fallback` 的属性值、以及页面上那句提示的文字都取这里。
 *  为什么要有这个：锚点指不到时会**照旧**退回卡片上那个默认起点（那条口径不变），但从前**一声不响** ——
 *  站在页面前面的人看不出「我写的锚点没生效」。这四类原因就是「为什么没生效」的机械读数。 */
const ANCHOR_FALLBACK_TEXT = {
  'bad-selector': '选择器写法不认（起点锚只认 #<元素 id>）',
  missing: '这个 id 在 from 那一屏的树里找不到（文档里任何一棵树都没有）',
  'not-in-screen-tree': '这个 id 在文档里，但不在 from 那一屏画出来的树里',
  'not-visible': '这个元素在画出来的屏内容里没有可见位置（溢出屏外或被裁掉）',
};
/** 这个 id 在**文档的任何一棵树**里有没有（`screens[].root` ＋ 有自己树的状态 `states[].root`）——
 *  与校验器 `designer/validate.mjs` 遍历的「每一棵树」同一个范围；只用来把退回分成两类：
 *  `missing`（文档里根本没有）与 `not-in-screen-tree`（在文档里，但不在 from 那一屏的树里）。 */
function docHasElementId(id) {
  const stack = [];
  for (const screen of state.doc.screens ?? []) {
    if (screen?.root) stack.push(screen.root);
    for (const st of screen?.states ?? []) if (st?.root) stack.push(st.root);
  }
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === null || typeof element !== 'object') continue;
    if (element.id === id) return true;
    for (const child of element.children ?? []) stack.push(child);
  }
  return false;
}
/**
 * [SEAM:anchor-fallback-reason] —— 「这条带锚点的转移**为什么**退回」的**唯一**判定处
 * （`null` = 这条转移压根没带锚点 ⇒ 它不是「退回」，不该留任何标记）。
 * 只在 `anchorBoxOnCanvas()` 已经说「没有可用的锚」之后调用（所以这里不必再量一遍几何）。
 *
 * 四类原因是**封闭集**（`ANCHOR_FALLBACK_TEXT` 的键），彼此咬合：
 *   · `bad-selector`：`#<元素 id>` 之外的写法（`.class` / `[id=…]` / 复合选择器）—— 与上面「只认 `#id`」同一条；
 *   · `not-visible`：元素**在** from 卡片画出来的那棵树里（`findCardElement()` 查得到），但它与屏内容
 *     可见区求交没有正面积（自由布局允许子元素溢出屏外 ⇒ 画布上根本看不见）；
 *   · `not-in-screen-tree`：卡片里查不到这个 id，但**文档别处**（任何一棵树）有它（`docHasElementId()`）
 *     —— 典型是「锚点指到别的屏的元素」；
 *   · `missing`：卡片里查不到、文档里任何一棵树也没有。
 */
function anchorFallbackReason(fromCard, spec) {
  const anchor = spec?.anchor;
  if (anchor === null || anchor === undefined) return null;
  if (typeof anchor !== 'object' || Array.isArray(anchor) || typeof anchor.selector !== 'string') return 'bad-selector';
  const id = anchorTargetId(anchor.selector);
  if (id === null) return 'bad-selector';
  const body = fromCard.querySelector('.dz-card-body');
  const fallbackDom = body ? findCardElement(body, id) : null;
  if (fallbackDom === null) return docHasElementId(id) ? 'not-in-screen-tree' : 'missing';
  return 'not-visible';
}
/** 流程视图上那句**可见**的锚点提示（没有退回的锚点 ⇒ `null`）：点名哪几条转移、各是哪种原因。 */
function anchorFallbackWarningText(entries) {
  if (entries.length === 0) return null;
  const named = entries.map((entry) => `${entry.id}（${entry.reason}：${ANCHOR_FALLBACK_TEXT[entry.reason]}）`).join('；');
  return `⚠ ${entries.length} 条转移的起点锚没生效（退回卡片上那个默认起点）：${named}`;
}
/**
 * [SEAM:anchor-box] —— 锚点控件在**画布坐标**（SVG 层局部坐标）里的盒子；`null` = 这条转移没有可用的锚
 * （没带 anchor / 选择器写法不认 / 元素不在这一屏的内容里 / 在画出来的屏内容里没有可见位置）。
 *
 * 「可见位置」= 控件的实测矩形与屏内容的**可见区**（`.dz-card-body`，`overflow: hidden`）求交之后
 * 还剩正面积 —— 自由布局允许子元素溢出屏，溢出的那部分在画布上根本看不见 ⇒ 如实算作「没有可见位置」。
 * 这个判定与**视图缩放/平移无关**（两边都在同一次 `getBoundingClientRect()` 的坐标系里）。
 * 反证臂 `anchor-ignores-visibility` 把那个求交/正面积判定拿掉 ⇒「屏里看不见的控件 ⇒ 退回默认起点」必红。
 */
function anchorBoxOnCanvas(fromCard, spec, svgRect) {
  const anchor = spec?.anchor;
  if (anchor === null || anchor === undefined) return null;
  if (typeof anchor !== 'object' || Array.isArray(anchor) || typeof anchor.selector !== 'string') return null;
  const id = anchorTargetId(anchor.selector);
  if (id === null) return null;
  const body = fromCard.querySelector('.dz-card-body');
  const dom = body ? findCardElement(body, id) : null;
  if (!body || !dom) return null;
  const rect = dom.getBoundingClientRect();
  const view = body.getBoundingClientRect();
  const left = Math.max(rect.left, view.left);
  const top = Math.max(rect.top, view.top);
  const right = Math.min(rect.right, view.right);
  const bottom = Math.min(rect.bottom, view.bottom);
  if (!(right - left > 0) || !(bottom - top > 0)) return null;
  return { x: left - svgRect.left, y: top - svgRect.top, w: right - left, h: bottom - top, id };
}
/** 从盒子中心朝 `aim` 引一条射线，取它**穿出盒子边界**的那个点（盒子宽/高为 0 时退化成中心点；
 *  方向为 0 时也返回中心点）—— 与导出器的 `edgePointToward()` 同一式（同一条规则，两处实现）。 */
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

function paintArrows(cards = [...node.flowCards.querySelectorAll('.dz-card')]) {
  const svg = node.arrows;
  for (const child of [...svg.querySelectorAll('.dz-arrow')]) child.remove();
  // 先按内容尺寸铺满（绝对定位的 svg 在滚动容器里 100% 只等于**可视**高度 ⇒ 不铺满会截断箭头）
  svg.style.width = `${Math.max(node.flow.scrollWidth, node.flow.clientWidth)}px`;
  svg.style.height = `${Math.max(node.flow.scrollHeight, node.flow.clientHeight)}px`;
  const svgRect = svg.getBoundingClientRect();
  const specs = arrowSpecs();
  // [SEAM:anchor-fallback-hint] —— 「退回的锚点」那半句警告必须**在这一帧量卡片之前**写下去（顺序是有意义的）：
  // 警告线在流里、就在卡片层上面 ⇒ 它一出现就把卡片往下推；写晚了这一帧量到的矩形就与它出现之后的画布对不上
  // （实测：箭头差出警告线那 62.7px）。而它又只能从「锚点盒量不量得到」推出来 ⇒ 先量一遍。
  // 为什么先量一遍不会把结论量错：`anchorFallbackReason()` 的判定（可见/在不在这一屏的树里）与「整块上下平移」无关 ——
  // 控件与屏内容可见区一起平移，求交结果不变。
  if (state.view === 'flow') {
    const fallbacks = [];
    for (const spec of specs) {
      const fromCard = cards[spec.from];
      if (!fromCard || !cards[spec.to]) continue;
      if (anchorBoxOnCanvas(fromCard, spec, svgRect) !== null) continue;
      const reason = anchorFallbackReason(fromCard, spec);
      if (reason !== null) fallbacks.push({ id: spec.id, reason });
    }
    renderFlowWarn(fallbacks);
  }
  // [SEAM:arrow-layers] —— 层序的 DOM 半边。这张 SVG 整层压在屏卡**之上**（`--dz-layer-arrows` > `--dz-layer-cards`，
  // 见 designer.css）；SVG 元素不吃 `z-index`，所以 SVG 内部再用**两组 ＋ 挂载顺序**分一次层：
  // 连线（含箭头 marker 与点击热区）在前、标签在后 ⇒ 标签永远压在所有连线上面。
  const lines = document.createElementNS(SVG_NS, 'g');
  lines.setAttribute('class', 'dz-arrow dz-arrow-lines');
  const labels = document.createElementNS(SVG_NS, 'g');
  labels.setAttribute('class', 'dz-arrow dz-arrow-labels');
  svg.appendChild(lines);
  svg.appendChild(labels);
  const labelled = [];
  const placed = [];
  for (const spec of specs) {
    const fromCard = cards[spec.from];
    const toCard = cards[spec.to];
    if (!fromCard || !toCard) continue;
    const a = fromCard.getBoundingClientRect();
    const b = toCard.getBoundingClientRect();
    // 这条转移的起点锚：`null` = 没有可用的锚 ⇒ 一律退回卡片上那个**默认起点**（下面每一支各写一次）
    const anchorBox = anchorBoxOnCanvas(fromCard, spec, svgRect);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'dz-arrow-path');
    path.dataset.arrow = spec.id;
    // 视图标记：这根箭头的起点**真的**落在哪个控件的盒子上（没锚 / 退回时**没有**这个属性 —— 这是「退回」的机械读数）
    if (anchorBox !== null) path.dataset.anchor = anchorBox.id;
    // [SEAM:anchor-fallback] —— 「带锚点却退回了」的显式标记（封闭原因；`null` = 没带锚点）。
    // ⚠ 没带锚点的转移**不加任何属性**（它的 path 逐字节还是改动前那一式 —— 那条口径不许破）。
    const fallbackReason = anchorBox === null ? anchorFallbackReason(fromCard, spec) : null;
    if (fallbackReason !== null) path.dataset.anchorFallback = fallbackReason;
    path.setAttribute('marker-end', 'url(#dz-arrowhead)');
    let d;
    if (spec.self) {
      if (anchorBox === null) {
        const cx = a.left - svgRect.left + a.width / 2;
        const top = a.top - svgRect.top;
        const out = Math.min(a.width / 2, 60);
        d = `M ${cx - out * 0.6} ${top} C ${cx - out} ${top - 46}, ${cx + out} ${top - 46}, ${cx + out * 0.6} ${top}`;
      } else {
        // 自环 ＋ 锚点：起点/终点都落在**锚点盒子的上边**（环从那个控件上方出去、再回来）—— 与导出器同一条
        const ax = anchorBox.x + anchorBox.w / 2;
        const out = Math.max(4, Math.min(anchorBox.w / 2, 24));
        d = `M ${ax - out} ${anchorBox.y} C ${ax - (out * 5) / 3} ${anchorBox.y - 44}, ${ax + (out * 5) / 3} ${anchorBox.y - 44}, ${ax + out} ${anchorBox.y}`;
      }
    } else {
      const forward = b.left + b.width / 2 >= a.left + a.width / 2;
      const cardStart = {
        x: (forward ? a.right : a.left) - svgRect.left,
        y: a.top - svgRect.top + a.height / 2,
      };
      const end = {
        x: (forward ? b.left : b.right) - svgRect.left,
        y: b.top - svgRect.top + b.height / 2,
      };
      // [SEAM:anchor] —— 起点：锚点盒子（指得到且屏里可见）⇒ 从它朝目标那一侧的边出发；
      // 否则（没锚 / 指不到 / 屏里看不见）退回卡片上那个**默认起点**。
      // 反证臂 `anchor-as-default` 把这一行换成 `const start = cardStart;` ⇒「起点落在控件盒子的边上」必红。
      const start = anchorBox === null ? cardStart : edgePointToward(anchorBox, end);
      const bend = Math.max(28, Math.abs(end.x - start.x) * 0.45);
      const c1 = { x: start.x + (forward ? bend : -bend), y: start.y };
      const c2 = { x: end.x - (forward ? bend : -bend), y: end.y };
      d = `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
    }
    path.setAttribute('d', d);
    lines.appendChild(path);
    // 点箭头 ⇒ 打开同一个转移表单：细线不好点，所以再叠一条**透明但很粗**的同路径归中点
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('class', 'dz-arrow-hit');
    hit.setAttribute('d', d);
    hit.dataset.arrow = spec.id;
    lines.appendChild(hit);
    if (spec.label) labelled.push({ path, spec });
  }
  // 标签**贴在自己那条线上**、且互相不叠（`pickLabelSpot` 是唯一出处）
  for (const { path, spec } of labelled) placeArrowLabel(labels, path, spec, placed);
}

/** 沿**真路径**取候选点（`getPointAtLength` ⇒ 曲线也算准）；每个位置上再给两个沿法线的错开点。
 *  `zoom`（= `labelZoom()`）把「沿法线错开多远」也按缩放放大 ⇒ 缩放态下标签的候选集与 z=1 等比。 */
function labelCandidatesOnPath(path, zoom) {
  const total = path.getTotalLength();
  const points = [];
  const reach = LABEL_OFFSET * zoom;
  for (const fraction of LABEL_FRACTIONS) {
    const at = total * fraction;
    const here = path.getPointAtLength(at);
    const next = path.getPointAtLength(Math.min(total, at + 1));
    const dx = next.x - here.x;
    const dy = next.y - here.y;
    const length = Math.hypot(dx, dy) || 1;
    points.push({ x: here.x, y: here.y });
    for (const offset of [reach, -reach]) {
      points.push({ x: here.x + (-dy / length) * offset, y: here.y + (dx / length) * offset });
    }
  }
  return points;
}

/**
 * 画一个标签：**一个组**（不透明底 `<rect>` ＋ 文字），组的中心正好落在 `pickLabelSpot()` 选中的那个点上。
 * 量的是**真文字**的包围盒（`getBBox()`）⇒ 背景框恒好把文字包住（「看不清」那半边由此收掉）。
 */
function placeArrowLabel(layer, path, spec, placed) {
  const zoom = labelZoom();
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'dz-arrow-label');
  group.dataset.arrow = spec.id;
  // 字号也跟着缩放（内联，覆盖 CSS 里那个基准字号）⇒ 标签整体与画布同一比例。
  group.style.fontSize = `${LABEL_FONT * zoom}px`;
  const box = document.createElementNS(SVG_NS, 'rect');
  box.setAttribute('class', 'dz-arrow-label-bg');
  box.setAttribute('rx', '2');
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('class', 'dz-arrow-label-text');
  text.setAttribute('text-anchor', 'middle');
  text.textContent = spec.label;
  group.appendChild(box);
  group.appendChild(text);
  layer.appendChild(group);
  // 先在**本地坐标**量一次文字（这时组还没有 transform）⇒ 背景框把文字包住、并让框的中心落在选中的点上。
  const textBox = text.getBBox();
  const size = { w: textBox.width + LABEL_PAD * zoom * 2, h: textBox.height + 2 * zoom };
  box.setAttribute('x', String(textBox.x - LABEL_PAD * zoom));
  box.setAttribute('y', String(textBox.y - 1 * zoom));
  box.setAttribute('width', String(size.w));
  box.setAttribute('height', String(size.h));
  const spot = pickLabelSpot(labelCandidatesOnPath(path, zoom), size, placed);
  const center = { x: textBox.x + textBox.width / 2, y: textBox.y + textBox.height / 2 };
  group.setAttribute('transform', `translate(${svgNum(spot.point.x - center.x)} ${svgNum(spot.point.y - center.y)})`);
  placed.push(boxAround(spot.point, size));
}

// ── 转移表单（流程视图的显眼入口：「＋ 添加转移」或点画布上的箭头）──────────────────────────
//
// 一张表单就对应 `transitions` 里的**一条**数据（没有第二份真相）：
//   · 新建：填「从（屏+状态）→ 到（屏+状态）」＋ 触发（一句话）⇒ 确定 ⇒ 往 `transitions` 里加一条
//     ⇒ 画布上**立刻**出现那根箭头（箭头是这条数据的视图，不是画上去的）；
//   · 改/删：点画布上的箭头 ⇒ 同一个表单带回原值 ⇒ 确定 ⇒ 改那条数据（箭头跟着变）／「删掉这条」。
// 非法输入（缺屏 / 从=到 完全同一条）**如实拒绝并说明**，不静默创建一条废转移。
const tform = { editing: null, draft: null, error: '' };

const screenOptions = () => (state.doc.screens ?? []).map((screen) => ({ value: screen.id, label: screen.name || screen.id }));
const stateOptions = (screenId) => (state.doc.screens.find((screen) => screen.id === screenId)?.states ?? [])
  .map((st) => ({ value: st.id, label: st.name || st.id }));
function fillSelect(select, options, value) {
  select.innerHTML = '';
  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    select.appendChild(opt);
  }
  select.value = value ?? '';
  if (select.value !== (value ?? '')) select.value = ''; // 那个屏/状态已经没了 ⇒ 如实留空，不装
}
/** 新开一张表单时的默认值：能猜到别的屏就指向它；只有一个屏且只有一个状态 ⇒ 空着（缺屏是**要人改**的，不猜）。 */
function defaultTransitionDraft() {
  const from = currentScreen();
  const other = state.doc.screens.find((screen) => screen.id !== from.id);
  const fromState = (from.states ?? [{}])[0]?.id ?? '';
  if (other) return { from: { screen: from.id, state: fromState }, to: { screen: other.id, state: (other.states ?? [{}])[0]?.id ?? '' }, trigger: '' };
  const otherState = (from.states ?? []).find((st) => st.id !== fromState);
  if (otherState) return { from: { screen: from.id, state: fromState }, to: { screen: from.id, state: otherState.id }, trigger: '' };
  return { from: { screen: from.id, state: fromState }, to: { screen: '', state: '' }, trigger: '' };
}
function renderTransitionForm() {
  const draft = tform.draft;
  fillSelect(node.tformFromScreen, screenOptions(), draft.from.screen);
  fillSelect(node.tformFromState, stateOptions(draft.from.screen), draft.from.state);
  fillSelect(node.tformToScreen, screenOptions(), draft.to.screen);
  fillSelect(node.tformToState, stateOptions(draft.to.screen), draft.to.state);
  node.tformTrigger.value = draft.trigger ?? '';
  node.tformTitle.textContent = tform.editing ? `改转移 ${tform.editing}` : '添加转移';
  node.tformDelete.hidden = !tform.editing;
  node.tformError.textContent = tform.error ?? '';
  node.tform.dataset.mode = tform.editing ? 'edit' : 'new';
}
function openTransitionForm(transitionId = null) {
  const existing = transitionId ? (state.doc.transitions ?? []).find((transition) => transition.id === transitionId) : null;
  tform.editing = existing ? existing.id : null;
  tform.error = '';
  tform.draft = existing
    ? { from: { ...(existing.from ?? {}) }, to: { ...(existing.to ?? {}) }, trigger: existing.trigger ?? '' }
    : defaultTransitionDraft();
  renderTransitionForm();
  node.tform.hidden = false;
  if (state.view !== 'flow') switchView('flow');
  setStatus(existing
    ? `在改转移 ${existing.id}：改完点确定（箭头跟着变），或点「删掉这条」`
    : '填「从 / 到 / 触发」，确定 ⇒ transitions 里加一条，画布上立刻出现那根箭头', 'ok');
}
function closeTransitionForm() {
  node.tform.hidden = true;
  tform.editing = null;
  tform.draft = null;
  tform.error = '';
}
function showTransitionFormError(message) {
  tform.error = message;
  node.tformError.textContent = message;
}
function submitTransitionForm() {
  if (!tform.draft) return false;
  const draft = tform.draft;
  const screens = state.doc.screens ?? [];
  const fromScreen = screens.find((screen) => screen.id === draft.from.screen);
  const toScreen = screens.find((screen) => screen.id === draft.to.screen);
  if (!fromScreen) {
    showTransitionFormError('要先选「从」的屏（文档里至少要有一屏）');
    return false;
  }
  if (!toScreen) {
    showTransitionFormError('要选「到」的屏 —— 缺屏的转移是一条废转移（画不出箭头）');
    return false;
  }
  const fromState = draft.from.state || (fromScreen.states ?? [{}])[0]?.id;
  const toState = draft.to.state || (toScreen.states ?? [{}])[0]?.id;
  if (fromScreen.id === toScreen.id && fromState === toState) {
    showTransitionFormError('「从」和「到」不能是同一条（同屏同状态）：那样箭头原地不动。换一个屏，或换一个状态');
    return false;
  }
  const trigger = String(draft.trigger ?? '').trim();
  if (tform.editing) {
    const editing = tform.editing;
    changeModel(() => {
      const target = (state.doc.transitions ?? []).find((transition) => transition.id === editing);
      if (!target) return;
      target.from = { screen: fromScreen.id, state: fromState };
      target.to = { screen: toScreen.id, state: toState };
      target.trigger = trigger;
    });
    setStatus(`已改转移 ${editing}（箭头跟着变了）`, 'ok');
  } else {
    const id = nextId('tr');
    // [SEAM:tform] —— 下面这一行是「确定」**唯一的**写入点
    // （反证臂 `tform-no-write` 把整行换成不写 ⇒「确定 ⇒ 箭头出现」必红）
    changeModel(() => {
      state.doc.transitions = [...(state.doc.transitions ?? []), { id, from: { screen: fromScreen.id, state: fromState }, to: { screen: toScreen.id, state: toState }, trigger }];
    });
    setStatus(`已加一条转移 ${id}：${fromScreen.name || fromScreen.id} → ${toScreen.name || toScreen.id}（画布上立刻多一根箭头）`, 'ok');
  }
  closeTransitionForm();
  return true;
}
function deleteTransitionFromForm() {
  const id = tform.editing;
  if (!id) return;
  changeModel(() => { state.doc.transitions = (state.doc.transitions ?? []).filter((transition) => transition.id !== id); });
  setStatus(`已删掉转移 ${id}（它那根箭头跟着消失了）`, 'ok');
  closeTransitionForm();
}

// ── 导出 HTML（把当前屏当前状态原样写成一份静态 HTML）───────────────────────────────────────
// ⚠️ 这不走任何网络：DOM 里每个元素的**内联样式**就是导出内容（图片是内联 data URI）。
// 分割符导出成**真元素** `<hr>`（带 aria-orientation）—— 不是绝对定位的一条线。
const EXPORT_CSS = [
  '* { box-sizing: border-box; }',
  // 导出的这份也走**中立基线**（14px ＋ 系统字体栈）：与画布上看到的一致，且没有我们产品的皮肤
  'body { margin: 0; background: #15171b; color: #e6e8ec; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }',
  '.dz-frame { margin: 0 auto; }',
  'button, input { font: inherit; }',
  'img { display: block; }',
  'hr.dz-el-divider { margin: 0; padding: 0; border-style: solid; }',
].join('\n');
function escapeHtml(text) {
  return String(text).replace(/[&<>\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function exportHtml() {
  const tree = currentTree();
  const size = frameSize(tree);
  const host = document.createElement('div');
  host.className = 'dz-frame';
  host.setAttribute('style', `position:relative;width:${size.w}px;height:${size.h}px;background:#15171b;`
    + 'box-shadow:0 0 0 1px #292b31;');
  host.appendChild(elementNode(tree, 'root'));
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(currentScreen().name || currentScreen().id)}</title>`,
    `<style>\n${EXPORT_CSS}\n</style>`,
    '</head>',
    '<body>',
    host.outerHTML,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
// ── 顶栏「导出 ▾」：一次导出当场重跑，失败如实报 ────────────────────────────────────────
//
// 选路（实测，见 `docs/design/designer-ui.md` §7）：**页面内生成**。为什么不让本页直接调 A 半
// `designer/` 里那套导出器：
//   ① 它们**依赖 Node**（`designer/validate.mjs` 顶层 `readFileSync` 读 `schema.json`、
//      `designer/canonical.mjs` 用 `node:crypto` 的 `createHash`）⇒ 浏览器里加载就断；
//   ② 更硬的一条：本页的站点根就是 `web/`（`server/app.mjs`），**浏览器根本够不到 `designer/`**
//      （实测 `GET /designer/toHtml.mjs` ⇒ 404）；要让浏览器加载它，得改 `server/**` 或
//      另生成一份可服务的副本 —— 那份副本不在本单允许动的文件里。
//   ⇒ 本页这条导出的几何**不另算一遍**：它是把当前屏的树用画布上**同一套** `elementNode()` 渲到
//      屏幕外再 `getBoundingClientRect()` **量出来**的（于是「撑满了没有」仍然是量出来的，而不是
//      第二份布局引擎说了算）。HTML 那份更是画布上那份 DOM 的**串行化**。
//
// 范围（写在明处）：HTML / SVG / PNG 都是**当前屏 + 当前状态**（所见即所得）；规范 JSON 与转移图
// 是**整份文档**。不做「整份文档一张图」（见 docs/design/designer-ui.md §10 的没验/未做）。
const EXPORT_LABELS = { html: 'HTML', svg: 'SVG', png: 'PNG', json: '规范 JSON', flow: '转移图' };
const EXPORT_SCOPE = {
  html: '当前屏当前状态 · 静态、零外部请求',
  svg: '当前屏当前状态 · 矢量、几何实测',
  png: '当前屏当前状态 · 由那份 SVG 光栅化',
  json: '整份文档 · 规范字节',
  flow: '整份文档 · 节点与箭头都来自数据',
};
const EXPORT_STAGE_ID = 'dz-export-stage';
const EXPORT_BG = '#15171b';

/** 每次导出的结果（给门与 UI 用；**不上 UI 吹**）。 */
let lastExport = { kind: null, ok: null, name: null, bytes: 0, reason: null };

// ── 名字：带屏名/状态名/时间戳，便于区分（同一份文档连导两次也认得出来）────────────────────
function exportStamp(date = new Date()) {
  const two = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}
function safeName(text, fallback) {
  const cleaned = String(text ?? '').trim().replace(/[\s/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}
function exportFileName(extension) {
  const screen = currentScreen();
  const st = currentState();
  const head = `design-${safeName(screen?.name, screen?.id ?? 'screen')}-${safeName(st?.name, st?.id ?? 'state')}`;
  const base = extension === 'flow.svg' ? `design-flow-${exportStamp()}` : `${head}-${exportStamp()}`;
  return `${base}.${extension}`;
}
const byteLength = (text) => new TextEncoder().encode(text).length;

// ── 下载 ─────────────────────────────────────────────────────────────────────────────────
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 留够读回的时间（门就是靠 blob URL 读回来断字节的）——反正这份内存随页面走。
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── 量测舞台：同一套渲染、同一个中立基线，只是挪到屏幕外 ──────────────────────────────────
/**
 * 把一棵树用**画布上同一套** `elementNode()` 渲到屏幕外的 `div.dz-frame` 里，交给 `run(host)`。
 * 为什么挪到屏幕外：导出可能在流程视图 / 预览里点，那时的 `#dz-frame` 不一定有布局。
 * 为什么 `class="dz-frame"`：与画布同一份中立基线（14px ＋ 系统字体栈 ＋ 中性墨色）。
 * 为什么 `id="dz-export-stage"`：产品那条 3px 槽的压制是 **id 作用域**的（特异性 0,7,1 只有 id 压得住），
 * 见 `designer.css` 里 `#dz-export-stage button.dz-el` 那条。
 */
function withMeasuredHost(tree, size, run) {
  const stage = document.createElement('div');
  stage.id = EXPORT_STAGE_ID;
  stage.setAttribute('aria-hidden', 'true');
  const host = document.createElement('div');
  host.className = 'dz-frame';
  host.dataset.exportStage = 'true';
  host.setAttribute('style', `position:relative;margin:0;width:${size.w}px;height:${size.h}px;`
    + `background:${EXPORT_BG};box-shadow:none;`);
  host.appendChild(elementNode(tree, 'root'));
  stage.appendChild(host);
  document.body.appendChild(stage);
  try {
    return run(host);
  } finally {
    stage.remove();
  }
}

// ── SVG：几何全部来自实测（不是第二份布局引擎）────────────────────────────────────────────
const SVG_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const svgEscape = (value) => String(value).replace(/[&<>"']/g, (ch) => SVG_ESCAPES[ch]);
const svgNum = (value) => String(Math.round(value * 100) / 100);
const transparentColor = (color) => !color || color === 'transparent' || /^rgba\(0,\s*0,\s*0,\s*0\)$/.test(color);
/** 一个元素节点自己的文字（输入框取 `value`／占位；图片没有文字；有元素子节点的容器不算）。 */
function textOfNode(dom) {
  if (dom.tagName === 'IMG') return '';
  if (dom.children.length > 0) return '';
  if (dom.tagName === 'INPUT') return dom.value || dom.placeholder || '';
  return dom.textContent ?? '';
}
/**
 * 当前屏/状态 ⇒ 一份**纯形状** SVG（`<rect>` / `<text>` / `<image>`，没有 `foreignObject`）。
 * 几何：每个节点 `getBoundingClientRect()` 减掉舞台的矩形；样式：`getComputedStyle()` 的背景、四边边框、
 * 圆角、字体、颜色、对齐。⇒ **画布上是什么几何，SVG 里就是什么几何**（同一套渲染、同一套 CSS）。
 * 诚实边界：文字是**按实测基线画的单行/换行 `<text>`**（按 `\n` 切成 `tspan`），没有浏览器那套换行断点算法。
 */
function svgForTree(tree, size, title) {
  return withMeasuredHost(tree, size, (host) => {
    const hostRect = host.getBoundingClientRect();
    const body = [];
    for (const dom of host.querySelectorAll('.dz-el')) {
      const rect = dom.getBoundingClientRect();
      const cs = getComputedStyle(dom);
      const id = dom.dataset.id ?? '';
      const x = rect.left - hostRect.left;
      const y = rect.top - hostRect.top;
      const w = rect.width;
      const h = rect.height;
      const radius = Number.parseFloat(cs.borderTopLeftRadius) || 0;
      const fill = cs.backgroundColor;
      // **每个元素都出一条带 `data-id` 的 `<rect>`**：透明（中立的）元素画成 `fill="none"`
      // —— 像素上与画布一致（本来就是看不见的），但导出物里**每一个元素都找得到**（可追溯）。
      if (w > 0 && h > 0) {
        body.push(`<rect data-id="${svgEscape(id)}" data-type="${svgEscape(dom.dataset.type ?? '')}" x="${svgNum(x)}" y="${svgNum(y)}"`
          + ` width="${svgNum(w)}" height="${svgNum(h)}"${radius > 0 ? ` rx="${svgNum(radius)}"` : ''}`
          + ` fill="${transparentColor(fill) ? 'none' : svgEscape(fill)}"/>`);
      }
      // 四边边框各画一条（单边边框也画得出来）—— 取的就是画布上那四条 computed 值
      for (const side of BORDER_SIDES) {
        const width = Number.parseFloat(cs[`border${side}Width`]) || 0;
        const color = cs[`border${side}Color`];
        if (width <= 0 || transparentColor(color)) continue;
        const band = side === 'Top' ? [x, y, w, width]
          : side === 'Bottom' ? [x, y + h - width, w, width]
            : side === 'Left' ? [x, y, width, h]
              : [x + w - width, y, width, h];
        body.push(`<rect data-id="${svgEscape(id)}" data-border="${side.toLowerCase()}" x="${svgNum(band[0])}" y="${svgNum(band[1])}"`
          + ` width="${svgNum(band[2])}" height="${svgNum(band[3])}" fill="${svgEscape(color)}"/>`);
      }
      if (dom.tagName === 'IMG') {
        const src = dom.getAttribute('src');
        if (src) {
          body.push(`<image data-id="${svgEscape(id)}" x="${svgNum(x)}" y="${svgNum(y)}" width="${svgNum(w)}" height="${svgNum(h)}"`
            + ` preserveAspectRatio="xMidYMid slice" href="${svgEscape(src)}"/>`);
        }
        continue;
      }
      const text = textOfNode(dom);
      if (!text) continue;
      const fontSize = Number.parseFloat(cs.fontSize) || 14;
      const lineHeight = Number.parseFloat(cs.lineHeight) || fontSize * 1.2;
      const anchor = cs.textAlign === 'center' ? 'middle' : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'end' : 'start';
      const padLeft = Number.parseFloat(cs.paddingLeft) || 0;
      const padRight = Number.parseFloat(cs.paddingRight) || 0;
      const tx = anchor === 'middle' ? x + w / 2 : anchor === 'end' ? x + w - padRight : x + padLeft;
      const centered = cs.display === 'inline-flex' || dom.tagName === 'INPUT';
      const baseline = centered ? y + h / 2 + fontSize * 0.35 : y + (lineHeight - fontSize) / 2 + fontSize * 0.8;
      const tspans = text.split('\n')
        .map((line, index) => `<tspan x="${svgNum(tx)}"${index === 0 ? '' : ` dy="${svgNum(lineHeight)}"`}>${svgEscape(line)}</tspan>`)
        .join('');
      body.push(`<text data-id="${svgEscape(id)}" y="${svgNum(baseline)}" text-anchor="${anchor}"`
        + ` font-family="${svgEscape(cs.fontFamily)}" font-size="${svgNum(fontSize)}" font-weight="${svgEscape(cs.fontWeight)}"`
        + ` fill="${svgEscape(cs.color)}">${tspans}</text>`);
    }
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}"`
        + ` data-designer-screen="${svgEscape(title)}" data-designer-elements="${host.querySelectorAll('.dz-el').length}">`,
      `<rect x="0" y="0" width="${size.w}" height="${size.h}" fill="${EXPORT_BG}"/>`,
      ...body,
      '</svg>',
      '',
    ].join('\n');
  });
}

// ── PNG：由那份 SVG **光栅化**（浏览器里没有第二个把矢量转成位图的入口）────────────────────
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('SVG 没被当成图片加载起来（光栅化第一步就断了）'));
    image.src = url;
  });
}
async function rasterizeSvg(svg, size) {
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size.w));
  canvas.height = Math.max(1, Math.round(size.h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 上下文（这个浏览器不让把 SVG 画进位图）');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  // ⚠️ 导出件里没有一条外部资源（占位图是内联 data URI）⇒ 画布不会被污染；真被污染了 `toBlob` 会抛，
  //    这里如实把它抛出去（绝不静默给一张空白 PNG）。
  return await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('canvas.toBlob 返回了空（PNG 编码没成功）'));
      }, 'image/png');
    } catch (error) {
      reject(error);
    }
  });
}

// ── 转移图（SVG）：节点 = (屏,状态)，箭头 = `transitions` 的一条数据 ────────────────────────────
const FLOW_NODE = { w: 190, h: 44, gapX: 70, gapY: 54, pad: 24 };
/** 导出件里的标签（纯数据、没有字体度量 —— 宽度用 `estimateLabelWidth` **估**）。 */
const FLOW_LABEL = { fontSize: 11, height: 14, pad: 3 };
/** 字符宽度**估计**（只在「标签互相不叠」这条判断里用；CJK 算 1 个字号宽、其它算 0.55）。 */
function estimateLabelWidth(text, fontSize = FLOW_LABEL.fontSize) {
  let width = 0;
  for (const char of String(text)) width += (char.codePointAt(0) > 0x2e7f ? 1 : 0.55) * fontSize;
  return width;
}
/** 三次贝塞尔在 `t` 处的点（导出件的坐标不靠 DOM ⇒ 只能自己算）。 */
function cubicAt(curve, t) {
  const k = 1 - t;
  const at = (key) => (k * k * k * curve[0][key]) + (3 * k * k * t * curve[1][key]) + (3 * k * t * t * curve[2][key]) + (t * t * t * curve[3][key]);
  return { x: at('x'), y: at('y') };
}
/** 沿这条曲线取候选点（与画布那条用**同一组分数 ＋ 同一个法线错开量** ⇒ 规则只有一条）。 */
function labelCandidatesOnCurve(curve) {
  const points = [];
  for (const fraction of LABEL_FRACTIONS) {
    const here = cubicAt(curve, fraction);
    const ahead = cubicAt(curve, Math.min(1, fraction + 0.02));
    const dx = ahead.x - here.x;
    const dy = ahead.y - here.y;
    const length = Math.hypot(dx, dy) || 1;
    points.push(here);
    for (const offset of [LABEL_OFFSET, -LABEL_OFFSET]) {
      points.push({ x: here.x + (-dy / length) * offset, y: here.y + (dx / length) * offset });
    }
  }
  return points;
}
function flowNodes() {
  const nodes = [];
  const byKey = new Map();
  (state.doc.screens ?? []).forEach((screen, row) => {
    const states = screen.states?.length ? screen.states : [{ id: `${screen.id}-state`, name: '默认' }];
    states.forEach((st, col) => {
      const key = `${screen.id}/${st.id}`;
      const nodeSpec = {
        key,
        row,
        col,
        label: `${screen.name || screen.id} · ${st.name || st.id}`,
        x: FLOW_NODE.pad + col * (FLOW_NODE.w + FLOW_NODE.gapX),
        y: FLOW_NODE.pad + row * (FLOW_NODE.h + FLOW_NODE.gapY),
      };
      nodes.push(nodeSpec);
      byKey.set(key, nodeSpec);
    });
  });
  return { nodes, byKey };
}
/** 「这条转移在**转移图**（节点 = 屏 · 状态）里指得到两端吗」——**唯一**一处判定：`flowSvg()` 与流程视图共用。
 *  返回 `null`（指得到）或 `{id, from, to}`（指不到 —— 那根箭头画不出来）。 */
function transitionNodeGap(transition, byKey) {
  const from = byKey.get(`${transition?.from?.screen}/${transition?.from?.state}`);
  const to = byKey.get(`${transition?.to?.screen}/${transition?.to?.state}`);
  if (from && to) return null;
  return { id: transition?.id ?? '(无 id)', from: transition?.from ?? null, to: transition?.to ?? null };
}
/** 流程视图上那句**可见**的警告：指不到节点的转移不许静默（校验已经拒收缺 `state` 的文档 ⇒
 *  这里是「万一」（例如 `state` 写了个不存在的 id —— 形状合法、节点不存在）的兜底）。 */
function flowWarningText() {
  const gaps = (state.doc.transitions ?? []).map((transition) => transitionNodeGap(transition, flowNodes().byKey)).filter(Boolean);
  if (gaps.length === 0) return null;
  return `⚠ ${gaps.length} 条转移指不到节点（from/to 的「屏 · 状态」在文档里找不到）⇒ 转移图里画不出来、未画：${gaps.map((gap) => gap.id).join('、')}`;
}
/**
 * [SEAM:anchor-fallback-hint] —— 流程视图那条警告线的**唯一**写入处：两件都不许静默 ——
 *   ① 转移指不到「屏 · 状态」节点（既有那条兜底）；② **带锚点却退回了**（`anchorFallbackWarningText()`）。
 * 为什么复用这一条（不新开面板）：它就在流程视图里、就是为「不许静默」留的位置；
 * 退回的锚点本来就是**画布上**那根箭头的事，站在它前面的人该在这里看到原因。
 * 反证臂 `anchor-fallback-hint-dropped` 把②那一半拿掉 ⇒ `<id>` 提示那条必红。
 */
function renderFlowWarn(anchorFallbacks = []) {
  const lines = [];
  const gaps = flowWarningText();
  if (gaps !== null) lines.push(gaps);
  const anchors = anchorFallbackWarningText(anchorFallbacks);
  if (anchors !== null) lines.push(anchors);
  node.flowWarn.hidden = lines.length === 0;
  node.flowWarn.textContent = lines.join(' ');
}
/** 一根箭头的**四个控制点**（纯数据算，不靠 DOM）：自环从节点上沿兜一圈，其余从一条边到另一条边。
 *  ⚠️ 与上一版那支「直接拼出 `<path d>`」的 `flowArrow()` 是**同一条几何**（`M start C c1, c2, end` 逐字相同）；
 *  改成先返回控制点，是因为**标签要贴在自己那条线上**（得沿它取候选点）—— 见 `[SEAM:arrow-labels]`。 */
function flowArrowCurve(from, to) {
  if (from.key === to.key) {
    // 自环：从节点上沿兜一圈
    const cx = from.x + FLOW_NODE.w / 2;
    const top = from.y;
    return [{ x: cx - 18, y: top }, { x: cx - 26, y: top - 34 }, { x: cx + 26, y: top - 34 }, { x: cx + 18, y: top }];
  }
  const fromCenter = { x: from.x + FLOW_NODE.w / 2, y: from.y + FLOW_NODE.h / 2 };
  const toCenter = { x: to.x + FLOW_NODE.w / 2, y: to.y + FLOW_NODE.h / 2 };
  const startX = toCenter.x >= fromCenter.x ? from.x + FLOW_NODE.w : from.x;
  const endX = toCenter.x >= fromCenter.x ? to.x : to.x + FLOW_NODE.w;
  const midX = (startX + endX) / 2;
  return [{ x: startX, y: fromCenter.y }, { x: midX, y: fromCenter.y }, { x: midX, y: toCenter.y }, { x: endX, y: toCenter.y }];
}
const flowArrowPath = (curve) => `M ${svgNum(curve[0].x)} ${svgNum(curve[0].y)} C ${svgNum(curve[1].x)} ${svgNum(curve[1].y)}, ${svgNum(curve[2].x)} ${svgNum(curve[2].y)}, ${svgNum(curve[3].x)} ${svgNum(curve[3].y)}`;
/** 一根箭头的 `<path>` 元素（属性集与上一版**逐字相同**；`d` 现在由 `flowArrowCurve()` 算 ——
 *  传进来的 `curve` 是为了让调用方把同一份控制点再拿去放标签，不是第二个真相）。 */
function flowArrow(from, to, transition, curve = flowArrowCurve(from, to)) {
  const attributes = `data-transition="${svgEscape(transition.id ?? '')}" stroke="#8abeb7" fill="none" marker-end="url(#dz-export-arrowhead)"`;
  return `<path ${attributes} d="${flowArrowPath(curve)}"/>`;
}
function flowSvg() {
  const { nodes, byKey } = flowNodes();
  const rows = Math.max(1, (state.doc.screens ?? []).length);
  const cols = Math.max(1, ...nodes.reduce((acc, nodeSpec) => [...acc, nodeSpec.col + 1], [1]));
  const width = FLOW_NODE.pad * 2 + cols * FLOW_NODE.w + (cols - 1) * FLOW_NODE.gapX;
  const height = FLOW_NODE.pad * 2 + rows * FLOW_NODE.h + (rows - 1) * FLOW_NODE.gapY;
  const body = [];
  for (const nodeSpec of nodes) {
    body.push(`<g data-node="${svgEscape(nodeSpec.key)}">`);
    body.push(`  <rect x="${nodeSpec.x}" y="${nodeSpec.y}" width="${FLOW_NODE.w}" height="${FLOW_NODE.h}" rx="3" fill="#1b1d22" stroke="#3a3d45"/>`);
    body.push(`  <text x="${nodeSpec.x + FLOW_NODE.w / 2}" y="${nodeSpec.y + FLOW_NODE.h / 2 + 5}" text-anchor="middle" font-size="13" fill="#c8ccd4" font-family="system-ui, sans-serif">${svgEscape(nodeSpec.label)}</text>`);
    body.push('</g>');
  }
  const arrows = [];
  const labels = [];
  const placed = [];
  const gaps = [];
  const transitions = Array.isArray(state.doc.transitions) ? state.doc.transitions : [];
  for (const transition of transitions) {
    // 指不到节点 ⇒ **不静默**：记下来，末尾在图上明写一句（页面流程视图里也有一条同样的可见警告）
    const gap = transitionNodeGap(transition, byKey);
    if (gap) { gaps.push(gap); continue; }
    // 校验（`transitionEndIssue()`）已经保证两端显式写着 `screen` / `state` ⇒ 这里不再猜默认状态
    const from = byKey.get(`${transition.from.screen}/${transition.from.state}`);
    const to = byKey.get(`${transition.to.screen}/${transition.to.state}`);
    const curve = flowArrowCurve(from, to);
    arrows.push(flowArrow(from, to, transition, curve));
    const label = transition.trigger ?? '';
    if (!label) continue;
    // 标签**贴在自己那条线上**、且互相不叠：与画布上用的是**同一条策略**（`pickLabelSpot`），
    // 只是候选点自己算（导出件里没有 DOM 可量）⇒ 标签之间按**估**出来的宽度避让。
    const size = { w: estimateLabelWidth(label) + FLOW_LABEL.pad * 2, h: FLOW_LABEL.height };
    const spot = pickLabelSpot(labelCandidatesOnCurve(curve), size, placed);
    const box = boxAround(spot.point, size);
    placed.push(box);
    labels.push(`<g class="designer-arrow-label" data-transition="${svgEscape(transition.id ?? '')}">`
      + `<rect x="${svgNum(box.x)}" y="${svgNum(box.y)}" width="${svgNum(box.w)}" height="${svgNum(box.h)}" rx="2" fill="${EXPORT_BG}"/>`
      + `<text x="${svgNum(spot.point.x)}" y="${svgNum(spot.point.y)}" dy="0.35em" text-anchor="middle" font-size="${FLOW_LABEL.fontSize}" fill="#8abeb7" font-family="system-ui, sans-serif">${svgEscape(label)}</text>`
      + '</g>');
  }
  if (gaps.length > 0) {
    body.push(`<text class="dz-flow-warning" data-flow-warning="${gaps.length}" x="${FLOW_NODE.pad}" y="${height - 8}" font-size="12" fill="#e06868" font-family="system-ui, sans-serif">${svgEscape(`⚠ ${gaps.length} 条转移指不到节点，未画：${gaps.map((gap) => gap.id).join('、')}`)}</text>`);
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-designer-flow="true">`,
    '<defs><marker id="dz-export-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8abeb7"/></marker></defs>',
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${EXPORT_BG}"/>`,
    ...body,
    ...arrows,
    // 标签单独一层、挂在整个连线层**之后** ⇒ 导出件里也是「连线 < 标签」（与画布同一条层序规则）
    `<g class="dz-arrow-labels">${labels.join('')}</g>`,
    '</svg>',
    '',
  ].join('\n');
}

// ── 出口：buildExport（重跑） ⇒ renderExport（真渲染） ⇒ runExport（下载 + 如实报）───────────────
/**
 * [SEAM:export-build] —— 反证臂 `export-stale-cache` 把下面这一行换成「把第一次的结果缓存起来再发一次」，
 * 于是「改了文档再导出」拿到的还是旧稿 ⇒ `export:fresh-*` 必红。
 */
async function buildExport(kind) {
  return renderExport(kind);
}
/** 这一层是「哪一格式、怎么渲、叫什么名」的**唯一**出处（`runExport` 只负责发与报）。 */
async function renderExport(kind) {
  switch (kind) {
    case 'html': {
      const text = exportHtml();
      return { text, name: exportFileName('html'), bytes: byteLength(text) };
    }
    case 'svg': {
      const tree = currentTree();
      const svg = svgForTree(tree, frameSize(tree), `${currentScreen().name} · ${currentState().name}`);
      return { text: svg, name: exportFileName('svg'), bytes: byteLength(svg) };
    }
    case 'png': {
      const tree = currentTree();
      const size = frameSize(tree);
      const svg = svgForTree(tree, size, `${currentScreen().name} · ${currentState().name}`);
      const blob = await step('光栅化', () => rasterizeSvg(svg, size));
      return { blob, name: exportFileName('png'), bytes: blob.size };
    }
    case 'json': {
      const text = exportText();
      return { text, name: exportFileName('json'), bytes: byteLength(text) };
    }
    case 'flow': {
      const text = flowSvg();
      return { text, name: exportFileName('flow.svg'), bytes: byteLength(text) };
    }
    default:
      throw new Error(`不认识的导出格式 ${JSON.stringify(kind)}（可选：${Object.keys(EXPORT_LABELS).join(' / ')}）`);
  }
}
/** 给每一步包一句「哪一步」，失败时状态栏里就说得出**缺的是哪一步**（不只是「失败了」）。 */
async function step(name, run) {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${name}这一步失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
const EXPORT_MIME = { html: 'text/html;charset=utf-8', svg: 'image/svg+xml;charset=utf-8', json: 'application/json;charset=utf-8', flow: 'image/svg+xml;charset=utf-8' };
async function runExport(kind) {
  closeExportMenu();
  const label = EXPORT_LABELS[kind] ?? kind;
  const item = node.exportItems.querySelector(`[data-export="${kind}"]`);
  if (item) item.dataset.busy = 'true';
  try {
    const payload = await step('渲染', () => buildExport(kind));
    if (payload.blob) downloadBlob(payload.blob, payload.name);
    else downloadBlob(new Blob([payload.text], { type: EXPORT_MIME[kind] ?? 'text/plain;charset=utf-8' }), payload.name);
    lastExport = { kind, ok: true, name: payload.name, bytes: payload.bytes, reason: null };
    delete node.exportMenu.dataset.error;
    setStatus(`已导出 ${payload.name}（${payload.bytes} 字节；${EXPORT_SCOPE[kind] ?? ''}）`, 'ok');
  } catch (error) {
    // [SEAM:export-guard] —— 反证臂 `export-silent-failure` 把下面这三行换成「只写一句完成」，
    // 于是「导出失败静默」⇒ `export:fail-honest` / `export:fail-no-download` 必红。
    const reason = error instanceof Error ? error.message : String(error);
    lastExport = { kind, ok: false, name: null, bytes: 0, reason };
    setStatus(`导出 ${label} 失败：${reason}`, 'error');
    node.exportMenu.dataset.error = reason;
  } finally {
    if (item) delete item.dataset.busy;
  }
}
function openExportMenu() {
  node.exportItems.hidden = false;
  node.exportToggle.setAttribute('aria-expanded', 'true');
}
function closeExportMenu() {
  node.exportItems.hidden = true;
  node.exportToggle.setAttribute('aria-expanded', 'false');
}

// ── 渲染总入口 ──────────────────────────────────────────────────────────────────────────
function setStatus(text, kind) {
  node.status.textContent = text;
  if (kind) node.status.dataset.kind = kind; else delete node.status.dataset.kind;
}
function renderAll() {
  renderScreens();
  renderStates();
  renderLayers();
  renderCanvas();
  renderPanel();
  renderTransitions();
  renderFlow();
  paintToolbar();
  // ⚠️ 必须在 `renderPanel()` **之后**：那几个「实测」读数就写在面板里（面板刚重建完才有那两格）
  paintMeasures();
  setStatus(statusText());
}
function statusText() {
  const doc = state.doc;
  let elements = 0;
  walkTree(currentTree(), () => { elements += 1; });
  return `${doc.screens.length} 屏 / ${(doc.transitions ?? []).length} 转移 / 本状态 ${elements} 元素（当前：${currentScreen().name} · ${currentState().name}）`;
}
function paintToolbar() {
  node.undoBtn.disabled = state.historyIndex <= 0;
  node.redoBtn.disabled = state.historyIndex >= state.history.length - 1;
  node.viewEdit.setAttribute('aria-pressed', state.view === 'edit' ? 'true' : 'false');
  node.viewFlow.setAttribute('aria-pressed', state.view === 'flow' ? 'true' : 'false');
}
/** 轻量重画：拖拽/打字时用（**不**重建属性面板本身 —— 那会把正在输入的那一格弄丢）。 */
function applyLive() {
  renderCanvas();
  renderFlow();
  renderLayers();
  paintToolbar();
  setStatus(statusText());
}

// ── 历史（撤销 / 重做）──────────────────────────────────────────────────────────────────
function snapshot() {
  return { doc: clone(state.doc), screenId: state.screenId, stateId: state.stateId, selection: [...state.selection] };
}
function applySnapshot(entry) {
  // ⚠️ 必须**拷一份**：`state.doc` 此后会被就地改动（拖拽 / 打字都是就地写），
  //    若直接拿历史里的那个对象，就地写会**改坏历史条目** ⇒ 撤销回不到当时那份文档。
  //    （实测踩过：连撤三次回到的是「撤两次」那个状态；原始输出在交付报告里。）
  state.doc = clone(entry.doc);
  state.screenId = entry.screenId;
  state.stateId = entry.stateId;
  state.selection = [...entry.selection];
  renderAll();
}
function resetHistory() {
  state.history = [snapshot()];
  state.historyIndex = 0;
}
function commit() {
  commits += 1;
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshot());
  state.historyIndex = state.history.length - 1;
  renderAll();
}
function changeModel(mutator, { live = false } = {}) {
  mutator();
  if (live) applyLive(); else commit();
}
function undo() {
  // [SEAM:undo] —— 反证臂 `undo-reload` 把这一行换成 `location.reload();`
  if (state.historyIndex <= 0) return;
  state.historyIndex -= 1;
  applySnapshot(state.history[state.historyIndex]);
}
function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex += 1;
  applySnapshot(state.history[state.historyIndex]);
}

// ── 选择 / 切换 ─────────────────────────────────────────────────────────────────────────
function selectElement(id, { additive = false } = {}) {
  if (additive) {
    state.selection = state.selection.includes(id) ? state.selection.filter((x) => x !== id) : [...state.selection, id];
  } else {
    state.selection = [id];
  }
  renderLayers();
  renderPanel();
  paintSelection();
  paintMeasures();
}
function switchScreen(id) {
  if (id === currentScreen().id) return;
  changeModel(() => {
    state.screenId = id;
    state.stateId = (state.doc.screens.find((s) => s.id === id)?.states ?? [{}])[0].id;
    state.selection = [];
  });
}
function switchState(id) {
  if (id === currentState().id) return;
  changeModel(() => {
    const screen = currentScreen();
    const index = (screen.states ?? []).findIndex((st) => st.id === id);
    const st = screen.states[index];
    // 切到一个「共用默认树」的状态 ⇒ 这一下就给它一棵自己的树（此前的历史快照仍是「没拷」的那份）。
    // 这样「每个状态各自编辑」不需要额外的隐式写入点：切换本身（本来就可撤销）是唯一的那个点。
    if (index > 0 && st && !st.root) st.root = clone(screen.root);
    state.stateId = id;
    state.selection = [];
  });
}
function switchView(view) {
  state.view = view;
  node.canvas.hidden = view !== 'edit';
  node.flow.hidden = view !== 'flow';
  paintToolbar();
  renderFlow();
}

// ── 增删改 ──────────────────────────────────────────────────────────────────────────────
function defaultContainer() {
  const tree = currentTree();
  const selected = state.selection.length > 0 ? findElement(tree, state.selection[state.selection.length - 1]) : null;
  if (selected?.type === 'container') return selected;
  return tree;
}
/**
 * [SEAM:neutral] —— 新建元素的**默认样式**：**中立**（一段空白，什么都不写）。
 * 这是「新建出来的就是一个中立的矩形，不是 sopho-pi 的一行」那条判据的**唯一**决定处：
 * 反证臂 `neutral-slot-default` 把它改成 `return { color: '#8abeb7', borderLeftWidth: 3 };` ⇒ 必红。
 * 那一侧的「槽」不是被删掉了 —— 它现在**能在属性面板里做出来**（单边边框 ＋ 颜色），见 `applyStyle()`。
 */
function newElementStyle() {
  return undefined;
}
function makeElement(type, point) {
  const size = DEFAULT_SIZE[type] ?? { w: 120, h: 80 };
  const element = {
    id: nextId('el'),
    type,
    name: TYPE_LABEL[type] ?? type,
  };
  const style = newElementStyle();
  if (style && Object.keys(style).length > 0) element.style = style;
  if (type === 'divider') {
    // 分割符**不带 `size`**：它的长/短边由 orientation + thickness 决定（见 dividerSizeShim）
    element.orientation = 'horizontal';
    element.thickness = DIVIDER_DEFAULT_THICKNESS;
    element.color = DIVIDER_DEFAULT_COLOR;
  } else {
    element.size = { w: { mode: 'fixed', value: size.w }, h: { mode: 'fixed', value: size.h } };
  }
  if (type === 'container') element.layout = { mode: 'free' };
  if (type === 'text') element.text = '文本';
  if (type === 'button') element.text = '按钮';
  if (type === 'input') element.text = '';
  if (type === 'image') element.text = '图片';
  element.box = point
    ? { x: Math.round(point.x - size.w / 2), y: Math.round(point.y - size.h / 2) }
    : { x: 0, y: 0 };
  return element;
}
function addElement(type, { point, parentId } = {}) {
  const tree = currentTree();
  let parent = parentId ? findElement(tree, parentId) : defaultContainer();
  if (!parent || parent.type !== 'container') parent = tree;
  const element = makeElement(type, point);
  if (!point) {
    const count = (parent.children ?? []).length;
    element.box = { x: 16 + (count % 8) * 14, y: 16 + (count % 8) * 14 };
  }
  changeModel(() => {
    const live = parent === tree ? editTree() : parent;
    live.children = [...(live.children ?? []), element];
    state.selection = [element.id];
  });
  return element;
}
function removeElement(element) {
  const tree = currentTree();
  const parent = findParentOf(tree, element.id);
  if (!parent) { setStatus('屏根不能删掉（它是这一屏的树）', 'error'); return; }
  changeModel(() => {
    parent.children = (parent.children ?? []).filter((child) => child.id !== element.id);
    state.selection = state.selection.filter((id) => id !== element.id);
  });
}
function duplicateElement(element) {
  const tree = currentTree();
  const parent = findParentOf(tree, element.id);
  if (!parent) return;
  const copy = clone(element);
  const remap = (source, target) => {
    target.id = nextId('el');
    (target.children ?? []).forEach((child, index) => remap(source.children?.[index], child));
  };
  remap(element, copy);
  copy.box = { ...(copy.box ?? {}), x: num(copy.box?.x) + 14, y: num(copy.box?.y) + 14 };
  changeModel(() => {
    const index = parent.children.findIndex((child) => child.id === element.id);
    parent.children = [...parent.children.slice(0, index + 1), copy, ...parent.children.slice(index + 1)];
    state.selection = [copy.id];
  });
}
function moveElement(element, delta) {
  const tree = currentTree();
  const parent = findParentOf(tree, element.id);
  if (!parent) return;
  const index = parent.children.findIndex((child) => child.id === element.id);
  const next = index + delta;
  if (next < 0 || next >= parent.children.length) return;
  changeModel(() => {
    const children = [...parent.children];
    [children[index], children[next]] = [children[next], children[index]];
    parent.children = children;
  });
}
function addScreen() {
  const id = nextId('screen');
  const stateId = nextId('state');
  const root = blankRoot();
  root.id = nextId('el');
  changeModel(() => {
    state.doc.screens.push({ id, name: `屏 ${state.doc.screens.length + 1}`, states: [{ id: stateId, name: '默认' }], root });
    state.screenId = id;
    state.stateId = stateId;
    state.selection = [];
  });
}
function removeScreen() {
  if (state.doc.screens.length <= 1) return;
  const id = currentScreen().id;
  changeModel(() => {
    state.doc.screens = state.doc.screens.filter((screen) => screen.id !== id);
    state.doc.transitions = (state.doc.transitions ?? []).filter((t) => t.from?.screen !== id && t.to?.screen !== id);
    state.screenId = state.doc.screens[0].id;
    state.stateId = state.doc.screens[0].states[0].id;
    state.selection = [];
  });
}
function addState() {
  const screen = currentScreen();
  const id = nextId('state');
  changeModel(() => {
    screen.states.push({ id, name: `状态 ${screen.states.length + 1}`, root: clone(getTree(screen, currentStateIndex())) });
    for (const element of [screen.states[screen.states.length - 1].root]) {
      walkTree(element, (el) => { el.id = nextId('el'); });
    }
    state.stateId = id;
    state.selection = [];
  });
}
function removeState() {
  const screen = currentScreen();
  if ((screen.states ?? []).length <= 1) return;
  const index = currentStateIndex();
  changeModel(() => {
    screen.states = screen.states.filter((_st, i) => i !== index);
    state.doc.transitions = (state.doc.transitions ?? []).filter((t) =>
      !(t.from?.screen === screen.id && t.from?.state === state.stateId)
      && !(t.to?.screen === screen.id && t.to?.state === state.stateId));
    state.stateId = screen.states[0].id;
    state.selection = [];
  });
}
function addTransition() {
  const screen = currentScreen();
  const other = state.doc.screens.find((candidate) => candidate.id !== screen.id) ?? screen;
  changeModel(() => {
    state.doc.transitions = [...(state.doc.transitions ?? []), {
      id: nextId('tr'),
      from: { screen: screen.id, state: currentState().id },
      to: { screen: other.id, state: (other.states ?? [{}])[0].id },
      trigger: '点一下',
    }];
  });
  if (state.view === 'flow') renderFlow();
}

// ── 对齐 ────────────────────────────────────────────────────────────────────────────────
function alignSelection(mode) {
  const tree = currentTree();
  const elements = state.selection.map((id) => findElement(tree, id)).filter(Boolean);
  if (elements.length < 2) return;
  const boxes = elements.map((element) => {
    const rect = elementNodes.get(element.id)?.getBoundingClientRect();
    const parentDom = elementNodes.get(element.id)?.parentElement;
    const parentRect = parentDom?.getBoundingClientRect();
    return {
      element,
      x: rect.left - parentRect.left,
      y: rect.top - parentRect.top,
      w: rect.width,
      h: rect.height,
    };
  });
  changeModel(() => {
    if (mode === 'left' || mode === 'hcenter' || mode === 'right') {
      const min = Math.min(...boxes.map((b) => b.x));
      const max = Math.max(...boxes.map((b) => b.x + b.w));
      for (const box of boxes) {
        if (mode === 'left') box.element.box = { ...(box.element.box ?? {}), x: Math.round(min) };
        if (mode === 'right') box.element.box = { ...(box.element.box ?? {}), x: Math.round(max - box.w) };
        if (mode === 'hcenter') box.element.box = { ...(box.element.box ?? {}), x: Math.round((min + max) / 2 - box.w / 2) };
      }
    } else {
      const min = Math.min(...boxes.map((b) => b.y));
      const max = Math.max(...boxes.map((b) => b.y + b.h));
      for (const box of boxes) {
        if (mode === 'top') box.element.box = { ...(box.element.box ?? {}), y: Math.round(min) };
        if (mode === 'bottom') box.element.box = { ...(box.element.box ?? {}), y: Math.round(max - box.h) };
        if (mode === 'vcenter') box.element.box = { ...(box.element.box ?? {}), y: Math.round((min + max) / 2 - box.h / 2) };
      }
    }
  });
}

// ── 画布交互：选中 / 拖动 / 缩放 / 吸附 / 从工具栏拖出来 ────────────────────────────────────
function canvasPoint(event) {
  const rect = node.frame.getBoundingClientRect();
  return { x: event.clientX - rect.left - node.frame.clientLeft, y: event.clientY - rect.top - node.frame.clientTop };
}
function localRects(parentDom) {
  const parentRect = parentDom.getBoundingClientRect();
  const originX = parentRect.left + parentDom.clientLeft;
  const originY = parentRect.top + parentDom.clientTop;
  return { originX, originY, width: parentDom.clientWidth, height: parentDom.clientHeight };
}
function parentBoxMetrics(parentDom) {
  const computed = getComputedStyle(parentDom);
  return {
    padLeft: parseFloat(computed.paddingLeft) || 0,
    padRight: parseFloat(computed.paddingRight) || 0,
    padTop: parseFloat(computed.paddingTop) || 0,
    padBottom: parseFloat(computed.paddingBottom) || 0,
  };
}
/** 吸附：把「移动盒」的三条边（左/中/右、上/中/下）与父容器内容边缘、同级元素边缘比，取最近的一条。 */
function computeSnap(moving, parentDom, siblingIds) {
  const { originX, originY, width, height } = localRects(parentDom);
  const pads = parentBoxMetrics(parentDom);
  const targetsX = [
    { at: pads.padLeft, kind: 'parent' },
    { at: pads.padLeft + (width - pads.padLeft - pads.padRight) / 2, kind: 'parent' },
    { at: width - pads.padRight, kind: 'parent' },
  ];
  const targetsY = [
    { at: pads.padTop, kind: 'parent' },
    { at: pads.padTop + (height - pads.padTop - pads.padBottom) / 2, kind: 'parent' },
    { at: height - pads.padBottom, kind: 'parent' },
  ];
  for (const id of siblingIds) {
    const dom = elementNodes.get(id);
    if (!dom) continue;
    const rect = dom.getBoundingClientRect();
    const x = rect.left - originX;
    const y = rect.top - originY;
    targetsX.push({ at: x, kind: 'sibling' }, { at: x + rect.width / 2, kind: 'sibling' }, { at: x + rect.width, kind: 'sibling' });
    targetsY.push({ at: y, kind: 'sibling' }, { at: y + rect.height / 2, kind: 'sibling' }, { at: y + rect.height, kind: 'sibling' });
  }
  let bestX = null;
  for (const edge of [moving.x, moving.x + moving.w / 2, moving.x + moving.w]) {
    for (const target of targetsX) {
      const delta = target.at - edge;
      if (Math.abs(delta) <= SNAP && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, at: target.at };
    }
  }
  let bestY = null;
  for (const edge of [moving.y, moving.y + moving.h / 2, moving.y + moving.h]) {
    for (const target of targetsY) {
      const delta = target.at - edge;
      if (Math.abs(delta) <= SNAP && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, at: target.at };
    }
  }
  const guides = [];
  if (bestX) guides.push({ axis: 'x', at: originX + bestX.at });
  if (bestY) guides.push({ axis: 'y', at: originY + bestY.at });
  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides };
}
function paintLiveBoxes(entries) {
  for (const entry of entries) {
    const dom = elementNodes.get(entry.id);
    if (!dom) continue;
    dom.style.left = `${entry.x}px`;
    dom.style.top = `${entry.y}px`;
  }
  paintSelection();
  paintMeasures();
}
function beginElementDrag(event, dom) {
  const id = dom.dataset.id;
  const tree = currentTree();
  if (!state.selection.includes(id)) selectElement(id, { additive: event.shiftKey });
  const parent = dom.parentElement;
  const parentMode = parent?.dataset.layoutMode ?? 'free';
  const movable = parentMode === 'free';
  const start = canvasPoint(event);
  const entries = state.selection.map((selectedId) => {
    const element = findElement(tree, selectedId);
    return { id: selectedId, element, x: num(element?.box?.x), y: num(element?.box?.y), w: num(measuredSize(element).w), h: num(measuredSize(element).h) };
  }).filter((entry) => entry.element);
  state.drag = {
    kind: 'move', movable, id, parent, start, entries, moved: false,
    siblingIds: [...(parent?.children ?? [])]
      .filter((child) => child.classList?.contains('dz-el') && !state.selection.includes(child.dataset.id))
      .map((child) => child.dataset.id),
  };
}
function beginResize(event, dom) {
  const tree = currentTree();
  const element = findElement(tree, dom.dataset.id);
  if (!element) return;
  state.drag = {
    kind: 'resize',
    id: element.id,
    element,
    start: canvasPoint(event),
    startSize: measuredSize(element),
    moved: false,
  };
}
function onCanvasMouseDown(event) {
  if (event.button !== 0) return;
  const target = event.target;
  if (target.closest('.dz-handle')) { beginResize(event, target.closest('.dz-handle')); event.preventDefault(); return; }
  const dom = target.closest('.dz-el');
  if (!dom || !node.frame.contains(dom)) {
    if (!event.shiftKey) {
      state.selection = [];
      renderLayers();
      renderPanel();
      paintSelection();
    }
    return;
  }
  event.preventDefault();
  beginElementDrag(event, dom);
}
function onDocumentMouseMove(event) {
  const drag = state.drag;
  if (!drag) return;
  if (drag.kind === 'resize') {
    const point = canvasPoint(event);
    const width = Math.max(4, Math.round(drag.startSize.w + (point.x - drag.start.x)));
    const height = Math.max(4, Math.round(drag.startSize.h + (point.y - drag.start.y)));
    drag.moved = true;
    drag.element.size = { w: { mode: 'fixed', value: width }, h: { mode: 'fixed', value: height } };
    const dom = elementNodes.get(drag.id);
    if (dom) { dom.style.width = `${width}px`; dom.style.height = `${height}px`; }
    paintSelection();
    paintMeasures();
    return;
  }
  const point = canvasPoint(event);
  let dx = point.x - drag.start.x;
  let dy = point.y - drag.start.y;
  if (!drag.movable) { drawGuides([]); return; }
  const primary = drag.entries.find((entry) => entry.id === drag.id) ?? drag.entries[0];
  if (primary && drag.parent) {
    const snap = computeSnap({ x: primary.x + dx, y: primary.y + dy, w: primary.w, h: primary.h }, drag.parent, drag.siblingIds);
    dx += snap.dx;
    dy += snap.dy;
    drawGuides(snap.guides);
  }
  for (const entry of drag.entries) {
    entry.element.box = { ...(entry.element.box ?? {}), x: Math.round(entry.x + dx), y: Math.round(entry.y + dy) };
  }
  drag.moved = true;
  paintLiveBoxes(drag.entries);
}
function onDocumentMouseUp() {
  const drag = state.drag;
  state.drag = null;
  clearGuides();
  if (drag && drag.moved) commit();
  else if (drag) applyLive();
}
function beginToolDrag(event, type) {
  const button = event.target.closest('[data-tool]');
  const ghost = document.createElement('div');
  ghost.className = 'dz-ghost';
  ghost.textContent = TYPE_LABEL[type] ?? type;
  ghost.style.left = `${event.clientX + 10}px`;
  ghost.style.top = `${event.clientY + 10}px`;
  document.body.appendChild(ghost);
  button.dataset.armed = 'true';
  const finish = (upEvent) => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', finish);
    ghost.remove();
    delete button.dataset.armed;
    const rect = node.frame.getBoundingClientRect();
    const inside = upEvent.clientX >= rect.left && upEvent.clientX <= rect.right
      && upEvent.clientY >= rect.top && upEvent.clientY <= rect.bottom;
    if (inside) {
      const point = canvasPoint(upEvent);
      const hit = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest('.dz-el');
      addElement(type, { point, parentId: hit?.dataset.id });
    } else {
      addElement(type, {});
    }
  };
  const move = (moveEvent) => {
    ghost.style.left = `${moveEvent.clientX + 10}px`;
    ghost.style.top = `${moveEvent.clientY + 10}px`;
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', finish);
}

// ── 导出 / 导入 / 复制 ───────────────────────────────────────────────────────────────────
function exportText() {
  return serializeDocument(state.doc);
}
function downloadJson() {
  const text = exportText();
  downloadBlob(new Blob([text], { type: 'application/json' }), 'design.json');
  setStatus(`已导出 design.json（${text.length} 字节，往返确定：导出 ⇒ 导入 ⇒ 再导出逐字节相同）`, 'ok');
}
// ── 复制到剪贴板：三级降级 —— **共用实现**在 `web/copy-text.js`（这一页与主产品页调的是同一份）
// 业主 2026-09-25 实测报回来的那条错（逐字）：
//   「复制失败：can't access property "writeText", navigator.clipboard is undefined（可以用「导出 JSON」下载）」
// 根因（`navigator.clipboard` 只在安全上下文存在）与三级（① clipboard API → ② execCommand 兼容路径 →
// ③ 只读、已全选的手动框）的细则现在只写在那一份共用文件里（这一页原先就地实现过一份；2026-09-25 抽出去，
// 因为主产品页的「复制」只做了两级、两级都失败就没有出路）。
// 这一页**只管**：把导出串交给它、把「走的是哪一级」标在状态栏的 `data-copy-path` / title ＋ 控制台上，
// 以及按这一页的口径把 ③ 的文案写清（导出串 / 「导出 JSON」下载）。

/** 这一页的手动框 id（`designer.html` 里那四个元素；共用实现的默认口径是主产品页的 `copy-*`）。 */
const COPY_IDS = { panel: 'dz-copy-panel', lead: 'dz-copy-lead', why: 'dz-copy-why', text: 'dz-copy-text', close: 'dz-copy-close' };

/** 本次复制走的是哪条路径（`'clipboard' | 'execCommand' | 'manual'`）—— 测试接缝用，不上 UI。 */
let lastCopy = { path: null, text: '', bytes: 0 };

/** 关手动框（Esc 与「关掉」是同一个出口）—— 交给共用实现（它会把框里的导出串一起清掉，不留副本）。 */
function closeCopyPanel() {
  return window.sophoCopyText?.closeManualCopy?.() === true;
}

/** 三级降级；返回**实际走到的**路径。 */
async function copyJsonText(text) {
  const shared = window.sophoCopyText;
  if (!shared) throw new Error('共用复制实现没加载（/copy-text.js）');
  const outcome = await shared.copyText(text, { label: '导出串', hint: '用顶栏的「导出 JSON」下载 .json 文件', ids: COPY_IDS });
  return outcome.path;
}

/** 走的是哪条路径：**不**在 UI 上吹（状态栏只说人话），标在 `title` / `data-copy-path` / 控制台里。 */
function markCopyPath(path, text) {
  lastCopy = { path, text, bytes: text.length };
  node.status.dataset.copyPath = path;
  node.status.title = `复制 JSON：走的是 ${path} 路径（${text.length} 字节）`;
  console.log(`[designer] 复制 JSON：走 ${path} 路径（${text.length} 字节）`);
}

async function copyJson() {
  const text = exportText();
  try {
    const path = await copyJsonText(text);
    markCopyPath(path, text);
    if (path === 'manual') {
      setStatus('没能自动复制：当前页面拿不到剪贴板 API，兼容路径也被拒绝 ⇒ 已在弹出的框里全选好，请按 Ctrl+C 复制（也可以用「导出 JSON」下载）', 'error');
    } else {
      setStatus(`已复制 JSON（${text.length} 字节）`, 'ok');
    }
  } catch (error) {
    // 兜底的兜底：②③ 自己会收，真不该走到这里。走到了也**如实**说清为什么 + 指一条出路，不装成功。
    setStatus(`复制失败：${error?.message ?? String(error)}（可以用「导出 JSON」下载 .json 文件）`, 'error');
  }
}
function importText(text) {
  const doc = parseDocument(text);
  changeModel(() => {
    state.doc = doc;
    const screen = doc.screens[0];
    state.screenId = screen.id;
    state.stateId = (screen.states ?? [{ id: 'default' }])[0].id;
    state.selection = [];
    // 换掉整份文档 ⇒ 折叠态清空（那些 id 已经不属于这一份文档了；折叠态**不是**文档的一部分）。
    state.folded.clear();
  });
  setStatus(`已导入（${doc.screens.length} 屏 / ${(doc.transitions ?? []).length} 转移）`, 'ok');
}
async function onImportFile(file) {
  try {
    importText(await file.text());
  } catch (error) {
    setStatus(`导入失败：${error?.message ?? error}`, 'error');
  }
}

// ── 预览（同一份文档的静态渲染；零外部请求）───────────────────────────────────────────────
function openPreview() {
  const tree = currentTree();
  const size = frameSize(tree);
  node.previewStage.innerHTML = '';
  const frame = document.createElement('div');
  frame.className = 'dz-frame';
  frame.style.width = `${size.w}px`;
  frame.style.height = `${size.h}px`;
  frame.appendChild(elementNode(tree, 'root', { static: true }));
  node.previewStage.appendChild(frame);
  node.previewSummary.textContent = `${currentScreen().name} · ${currentState().name}（同一份文档渲染；没有编辑器的手柄与选中框）`;
  node.preview.hidden = false;
  setStatus('预览：静态、零外部请求（占位图是内联 data URI）', 'ok');
}
function closePreview() {
  node.preview.hidden = true;
  node.previewStage.innerHTML = '';
}

// ── 事件接线 ────────────────────────────────────────────────────────────────────────────
node.tools.addEventListener('mousedown', (event) => {
  const button = event.target.closest('[data-tool]');
  if (!button) return;
  event.preventDefault();
  beginToolDrag(event, button.dataset.tool);
});
node.frame.addEventListener('mousedown', onCanvasMouseDown);
document.addEventListener('mousemove', onDocumentMouseMove);
document.addEventListener('mouseup', onDocumentMouseUp);

node.newDoc.addEventListener('click', () => {
  changeModel(() => {
    state.doc = blankDocument();
    state.screenId = 'screen-1';
    state.stateId = 'state-1';
    state.selection = [];
    state.folded.clear(); // 同上：换文档 ⇒ 折叠态清空
  });
  setStatus('已新建空白文档', 'ok');
});
node.exportBtn.addEventListener('click', downloadJson);
node.copyBtn.addEventListener('click', () => { void copyJson(); });
node.copyClose.addEventListener('click', closeCopyPanel);
node.importInput.addEventListener('change', () => {
  const file = node.importInput.files?.[0];
  if (file) void onImportFile(file);
  node.importInput.value = '';
});
node.undoBtn.addEventListener('click', undo);
node.redoBtn.addEventListener('click', redo);
node.viewEdit.addEventListener('click', () => switchView('edit'));
node.viewFlow.addEventListener('click', () => switchView('flow'));
node.previewOpen.addEventListener('click', openPreview);
node.previewClose.addEventListener('click', closePreview);
node.addScreen.addEventListener('click', addScreen);
node.delScreen.addEventListener('click', removeScreen);
node.addState.addEventListener('click', addState);
node.delState.addEventListener('click', removeState);
node.addTransition.addEventListener('click', addTransition);
node.flowAddTransition.addEventListener('click', () => openTransitionForm(null));
// 滚轮缩放（业主 2026-09-26）：滚轮**直接**放大 / 缩小；三个按钮是给没有滚轮（键盘 / 触屏）的退路。
// `passive:false` 才能 `preventDefault()`（不让滚轮去滚滚动条）—— 滚动仍可用滚动条拖动。
node.flow.addEventListener('wheel', (event) => {
  if (state.view !== 'flow') return;
  event.preventDefault();
  zoomFlowBy(Math.exp(-wheelZoomDelta(event) * FLOW_ZOOM_SENSITIVITY));
}, { passive: false });
// 点击拖动**平移**（业主 2026-09-27：「现在有缩放了，但是没有对应的**点击滑动**，请补上」）。
// 口径（起点分流，**不抢**既有交互）：只有起点落在**空白画布**上（不是卡片 / 卡头 / 卡片本体 / 箭头 / 标签 /
// 流程栏）才平移 —— 卡片头还是切屏、箭头 / 标签还是打开那条转移、卡片本体那套不动。
// 拖动位移是**屏幕像素**（`translate` 写在 `scale` 前面）⇒ 先缩放再平移 / 先平移再缩放同一张图。
// ⚠️ 这是一条**纯视图**交互：`state.doc` 一个字节都不动（门里 `pan:pure-view` 逐字量）。
function blocksFlowPan(target) {
  return !!(target?.closest?.('.dz-card, .dz-arrow-hit, .dz-arrow-label, .dz-flow-bar'));
}
node.flow.addEventListener('mousedown', (event) => {
  if (state.view !== 'flow' || event.button !== 0 || blocksFlowPan(event.target)) return;
  event.preventDefault(); // 拖动时不要选出文字 / 不要触发默认拖拽
  const from = { x: event.clientX, y: event.clientY, panX: viewTransform.x, panY: viewTransform.y };
  node.flow.dataset.panning = 'true';
  const move = (moved) => setFlowPan(from.panX + (moved.clientX - from.x), from.panY + (moved.clientY - from.y));
  const finish = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', finish);
    delete node.flow.dataset.panning;
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', finish);
});
node.flowZoomIn.addEventListener('click', () => zoomFlowBy(1.25));
node.flowZoomOut.addEventListener('click', () => zoomFlowBy(1 / 1.25));
node.flowZoomReset.addEventListener('click', () => resetFlowZoom());
node.exportToggle.addEventListener('click', () => {
  if (node.exportItems.hidden) openExportMenu(); else closeExportMenu();
});
node.exportItems.addEventListener('click', (event) => {
  const item = event.target?.closest?.('[data-export]');
  if (!item) return;
  void runExport(item.dataset.export);
});
// 点外面收起来（菜单开着时点画布 / 别处不应把它留着）
document.addEventListener('click', (event) => {
  if (!node.exportItems.hidden && !event.target?.closest?.('#dz-export-menu')) closeExportMenu();
});
node.tformOk.addEventListener('click', () => { submitTransitionForm(); });
node.tformCancel.addEventListener('click', closeTransitionForm);
node.tformDelete.addEventListener('click', deleteTransitionFromForm);
node.tformFromScreen.addEventListener('change', () => {
  if (!tform.draft) return;
  tform.draft.from = { screen: node.tformFromScreen.value, state: stateOptions(node.tformFromScreen.value)[0]?.value ?? '' };
  tform.error = '';
  renderTransitionForm();
});
node.tformFromState.addEventListener('change', () => {
  if (!tform.draft) return;
  tform.draft.from = { ...tform.draft.from, state: node.tformFromState.value };
  tform.error = '';
});
node.tformToScreen.addEventListener('change', () => {
  if (!tform.draft) return;
  tform.draft.to = { screen: node.tformToScreen.value, state: stateOptions(node.tformToScreen.value)[0]?.value ?? '' };
  tform.error = '';
  renderTransitionForm();
});
node.tformToState.addEventListener('change', () => {
  if (!tform.draft) return;
  tform.draft.to = { ...tform.draft.to, state: node.tformToState.value };
  tform.error = '';
});
node.tformTrigger.addEventListener('input', () => {
  if (tform.draft) tform.draft.trigger = node.tformTrigger.value;
});
/** 点箭头 ⇒ 打开同一个表单（表单是这条数据的视图；表单里改的就是 `transitions` 那条数据）。 */
node.arrows.addEventListener('click', (event) => {
  const hit = event.target?.closest?.('[data-arrow]');
  if (!hit) return;
  openTransitionForm(hit.getAttribute('data-arrow'));
});

window.addEventListener('keydown', (event) => {
  const tag = event.target?.tagName?.toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  if (event.key === 'Escape') {
    if (!node.exportItems.hidden) { closeExportMenu(); return; }
    if (!node.copyPanel.hidden) { closeCopyPanel(); return; }
    if (!node.preview.hidden) { closePreview(); return; }
    if (!node.tform.hidden) { closeTransitionForm(); return; }
    if (!typing) { state.selection = []; renderLayers(); renderPanel(); paintSelection(); }
    return;
  }
  if (typing) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const element = state.selection.length === 1 ? findElement(currentTree(), state.selection[0]) : null;
    if (element) { event.preventDefault(); removeElement(element); }
  }
});
window.addEventListener('resize', () => {
  if (state.view === 'flow') applyFlowZoom(); // 栏换行会移动卡片层 ⇒ 定点要重算
  paintArrows();
});

// ── 可编程控制面：`window.sophoDesigner`（给 agent 用；与鼠标**同一条**编辑路径）───────────────
//
// 业主 2026-09-28 逐字：「现在 agent 对编辑页面的使用还是需要通过对文件进行 json 编辑才行，后续应该
// 考虑**直接在 webui 当中介入**，这也就意味着需要**让 agent 可以操控编辑器，编辑节点**」。
//
// 这一层**不是第二套编辑器**：每个方法都走这一页自己那条路 ——
//   · 写操作 ⇒ `apiMutate()` ⇒ `changeModel()`（一次调用 = **一条历史条目** + 全量重渲染）—— 与鼠标改一格同一条；
//   · 选中 ⇒ `selectElement()`（与点画布、点图层是同一个函数）；
//   · 导出 ⇒ `exportText()`（与顶栏「导出 JSON」/「导出 ▾ ⇒ 规范 JSON」**同一串字节**）。
//   ⇒ agent 用 API 改完、人接着用鼠标再改一次，两笔改动在**同一个撤销栈**里，撤两次按顺序各回一步
//     （门里 `api:same-undo-stack` 就是这么量的）。
//
// **如实回执**是这一层的硬口径：成功返回 `{ok:true, …}`；非法输入**抛 `Error`**（message 里写清是哪个
// 参数、收到了什么、允许什么），而且在**改动之前**就抛 —— 文档与撤销栈一个字节都不动
// （门里 `api:reject-*` 两条就是这么量的：报错要**说得出理由**、且 `exportDoc()` 逐字节未变）。
// 两个唯一出口：`apiGuard()`（[SEAM:api-guard]，唯一的拒绝点）、`apiMutate()`（[SEAM:api-commit]，唯一的提交点）。
// 长版文档：`docs/design/designer-agent.md`（API 清单 / CDP headless 配方 / 「下一步：服务端·会话级介入」提案）。
const API_VERSION = 'designer-api-1';
/** `help()` 交出去的那份清单（签名 + 一句话；长版在 `docs/design/designer-agent.md`）。 */
const API_HELP = [
  { name: 'getDoc', signature: 'getDoc()', note: '整份文档的**深拷贝**（改它不影响编辑器：写入一律走下面那几个方法）' },
  { name: 'getState', signature: 'getState()', note: '当前在哪一屏 / 哪个状态、视图、选中项、历史指针（含 canUndo / canRedo）' },
  { name: 'getNode', signature: 'getNode(id)', note: '单个元素（深拷贝）+ 它的父 id 与在父容器里的序号；未知 id ⇒ 抛' },
  { name: 'addNode', signature: "addNode(parentId, {type, …})", note: '在 parentId（container；省略 = 屏根）下新建一个元素，返回 {ok,id,type,parentId,index}' },
  { name: 'updateNode', signature: 'updateNode(id, patch)', note: '改 name / box / size / style / text / layout（分割符另加 orientation / thickness / color）；patch 里写 null 就删掉那一格' },
  { name: 'removeNode', signature: 'removeNode(id)', note: '删一个元素连同它的子树（返回删掉几个）；屏根删不掉（抛）' },
  { name: 'moveNode', signature: 'moveNode(id, parentId, index?)', note: '换父容器 / 换位置（index 省略 = 放到末尾）；移进自己或自己的后代、越界都抛' },
  { name: 'select', signature: 'select(id | id[] | null)', note: '选中（与点画布同一个函数；选中不是文档改动，不进撤销栈）' },
  { name: 'openScreen', signature: 'openScreen(screenId, stateId?)', note: '切屏 / 切状态（与点左栏那两行同一条路，每次切换都可撤销）' },
  { name: 'setView', signature: "setView('edit' | 'flow')", note: '切「编辑屏」/「流程 · 箭头」视图（视图不是文档改动，不进撤销栈）' },
  { name: 'addScreen', signature: 'addScreen(name?)', note: '新加一屏（自带一个默认状态与一棵空树）并切过去，返回 {ok,screenId,stateId,rootId}' },
  { name: 'addState', signature: 'addState(screenId, name?)', note: '给指定屏加一个状态（自带一棵拷贝树、元素 id 重新分配）' },
  { name: 'addTransition', signature: "addTransition({from:{screen,state}, to:{screen,state}, trigger})", note: '加一条转移（箭头由它生成，返回 {ok,id,…,arrows}）；同屏同状态会被拒' },
  { name: 'undo', signature: 'undo()', note: '撤销一步（没得撤销时返回 changed:false + 原因，不装成功）' },
  { name: 'redo', signature: 'redo()', note: '重做一步（同上）' },
  { name: 'setDoc', signature: 'setDoc(doc | json)', note: '整份换掉（与「导入 JSON」同一个解析器与校验；坏输入抛，文档一个字节不动）' },
  { name: 'exportDoc', signature: 'exportDoc()', note: '规范字节（与顶栏「导出 JSON」/「导出 ▾ ⇒ 规范 JSON」**同一串**）' },
  { name: 'help', signature: 'help()', note: '这份清单（长版在 docs/design/designer-agent.md）' },
];
/** 每种类型能改的字段（**别的键一律拒**：拒的时候说清收到了什么、能改什么）。 */
const API_KEYS = {
  container: ['name', 'box', 'size', 'layout', 'style'],
  rect: ['name', 'box', 'size', 'style'],
  text: ['name', 'box', 'size', 'style', 'text'],
  image: ['name', 'box', 'size', 'style', 'text'],
  input: ['name', 'box', 'size', 'style', 'text'],
  button: ['name', 'box', 'size', 'style', 'text'],
  divider: ['name', 'box', 'style', 'orientation', 'thickness', 'color'],
};
const apiIsObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
function apiShow(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
/**
 * 唯一的**拒绝点**：不满足就抛（message 里写清是哪个参数、收到了什么、允许什么）—— 绝不静默吞掉、
 * 也绝不把坏值改成「看起来能用」的默认值。
 * [SEAM:api-guard] —— 反证臂 `api-swallow-errors` 把它换成「什么都不做」（`void ok; void reason;`）
 *   ⇒「非法输入 ⇒ 有原因的错」与「文档逐字节未变」那两条必红。
 */
function apiGuard(ok, reason) {
  if (!ok) throw new Error(reason);
}
/**
 * 唯一的**提交点**：所有写操作都从这里进 —— 与鼠标同一个 `changeModel()` ⇒ 一条历史 + 全量重渲染。
 * [SEAM:api-commit] —— 反证臂 `api-bypass-commit` 把它换成「直接改、不进撤销栈」（`mutator(); renderAll();`）
 *   ⇒「一次 API 改动 = 一条历史」与「API 与鼠标在同一个撤销栈里」那两条必红。
 */
function apiMutate(mutator) {
  changeModel(mutator);
}
/** 当前屏当前状态那棵树里的某个元素；找不到就抛（说清「这棵树里没有它」）。 */
function apiElement(where, id) {
  apiGuard(typeof id === 'string' && id.length > 0, `${where}: 元素 id 要是一个非空字符串，收到 ${apiShow(id)}`);
  const element = findElement(currentTree(), id);
  apiGuard(element !== null,
    `${where}: 未知的元素 id ${apiShow(id)} —— 当前屏「${currentScreen().name} · ${currentState().name}」这棵树里没有它`
    + '（用 getDoc() 看全部 id，或先 openScreen() 切到那一屏/那一个状态）');
  return element;
}
/** 父容器：省略 = 当前屏根；给了就必须是存在的 container。 */
function apiParent(where, parentId) {
  if (parentId === undefined || parentId === null) return currentTree();
  const parent = apiElement(where, parentId);
  apiGuard(parent.type === 'container', `${where}: 父元素 ${parent.id} 是 ${parent.type}，装不了子元素（只有 container 能；要往里放东西就先 addNode 一个 container）`);
  return parent;
}
function apiKeyReason(where, element, key, allowed) {
  const hints = {
    id: '元素 id 由文档分配（`nextId()`：全文档唯一）、此后永不变 —— 改不了',
    type: '元素类型建好就定了：要另一种类型，就 removeNode(id) 再 addNode',
    children: '子元素一个一个建：addNode(parentId, …) 把新 id 当父节点用',
    layout: 'layout 只有 container 有（只有容器排布它的子元素）',
    text: 'text 只有 text / image / input / button 有',
    orientation: 'orientation 只有分割符（divider）有',
    thickness: 'thickness 只有分割符（divider）有',
    color: 'color 只有分割符有（别的元素用 style.color）',
  };
  return `${where}: ${element.id}（${element.type}）改不了 ${apiShow(key)} —— 它能改的是 ${allowed.join(' / ')}${hints[key] ? `；${hints[key]}` : ''}`;
}
function apiNum(where, what, value, { min = null, above = null, integer = false } = {}) {
  const n = typeof value === 'number' ? value : NaN;
  apiGuard(Number.isFinite(n), `${where}: ${what} 要是一个数字，收到 ${apiShow(value)}`);
  if (above !== null) apiGuard(n > above, `${where}: ${what} 必须大于 ${above}（正数），收到 ${apiShow(value)}`);
  if (min !== null) apiGuard(n >= min, `${where}: ${what} 不能小于 ${min}，收到 ${apiShow(value)}`);
  if (integer) apiGuard(Number.isInteger(n), `${where}: ${what} 要是一个整数，收到 ${apiShow(value)}`);
  return n;
}
function apiPlanAxis(where, axis, spec) {
  const label = `size.${axis}`;
  apiGuard(apiIsObject(spec), `${where}: ${label} 要是一个对象，例如 {mode:'fixed',value:120} 或 {mode:'fill'}，收到 ${apiShow(spec)}`);
  apiGuard(SIZE_MODES.includes(spec.mode), `${where}: ${label}.mode 只能是 ${SIZE_MODES.join(' / ')} 之一，收到 ${apiShow(spec.mode)}`);
  if (spec.mode !== 'fixed') return { mode: spec.mode };
  return { mode: 'fixed', value: apiNum(where, `${label}.value（mode='fixed' 时必须给）`, spec.value, { min: 0 }) };
}
function apiPlanSize(where, element, size) {
  apiGuard(apiIsObject(size), `${where}: size 要是一个对象，例如 {w:{mode:'fill'}}，收到 ${apiShow(size)}`);
  for (const key of Object.keys(size)) apiGuard(key === 'w' || key === 'h', `${where}: size 里只能有 w / h，收到 ${apiShow(key)}`);
  const next = { ...(element.size ?? {}) };
  for (const axis of ['w', 'h']) {
    const spec = size[axis];
    if (spec === undefined) continue;
    if (spec === null) delete next[axis]; else next[axis] = apiPlanAxis(where, axis, spec);
  }
  return trimObject(next) ?? null; // 归零就整组删掉（别在文档里留一个空壳）
}
function apiPlanBox(where, element, box) {
  apiGuard(apiIsObject(box), `${where}: box 要是一个对象 {x, y}，收到 ${apiShow(box)}`);
  for (const key of Object.keys(box)) {
    apiGuard(key === 'x' || key === 'y', `${where}: box 里只放 x / y（尺寸走 size.w / size.h，别在 box 里再写一份），收到 ${apiShow(key)}`);
  }
  const next = { ...(element.box ?? {}) };
  for (const axis of ['x', 'y']) {
    const value = box[axis];
    if (value === undefined) continue;
    if (value === null) delete next[axis]; else next[axis] = apiNum(where, `box.${axis}`, value);
  }
  return trimObject(next) ?? null;
}
function apiPlanLayout(where, element, layout) {
  apiGuard(element.type === 'container', `${where}: layout 只对 container 有意义（${element.id} 是 ${element.type}），收到 ${apiShow(layout)}`);
  apiGuard(apiIsObject(layout), `${where}: layout 要是一个对象，例如 {mode:'row', gap:0}，收到 ${apiShow(layout)}`);
  const next = { ...(element.layout ?? {}) };
  for (const [key, value] of Object.entries(layout)) {
    apiGuard(LAYOUT_KEYS.includes(key), `${where}: layout 里只认 ${LAYOUT_KEYS.join(' / ')}（就是属性面板「容器布局」那一组），收到 ${apiShow(key)}`);
    if (value === null) { delete next[key]; continue; }
    if (key === 'mode') {
      apiGuard(LAYOUT_MODES.includes(value), `${where}: layout.mode 只能是 ${LAYOUT_MODES.join(' / ')} 之一，收到 ${apiShow(value)}`);
    } else if (key === 'align') {
      apiGuard(ALIGN_MODES.includes(value), `${where}: layout.align 只能是 ${ALIGN_MODES.join(' / ')} 之一，收到 ${apiShow(value)}`);
    } else if (key === 'columns') {
      apiNum(where, 'layout.columns', value, { min: 1, integer: true });
    } else {
      apiNum(where, `layout.${key}`, value, { min: 0 });
    }
    next[key] = value;
  }
  return trimObject(next) ?? null;
}
function apiPlanStyle(where, element, style) {
  apiGuard(apiIsObject(style), `${where}: style 要是一个对象，例如 {background:'#ff0000'}，收到 ${apiShow(style)}`);
  const next = { ...(element.style ?? {}) };
  for (const [key, value] of Object.entries(style)) {
    apiGuard(STYLE_KEYS.includes(key), `${where}: style 里只认 ${STYLE_KEYS.join(' / ')}（就是属性面板「样式」「边框（单边）」那几格），收到 ${apiShow(key)}`);
    if (value === null) { delete next[key]; continue; }
    apiGuard(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
      `${where}: style.${key} 要是一个字符串（数字也收，比如 fontSize: 18），收到 ${apiShow(value)}；要删掉这一格就写 null`);
    next[key] = value;
  }
  return trimObject(next) ?? null;
}
/**
 * 把一个 patch **先全验完、再算出要写哪几格**（返回 `[{key, value}]`，`value === null` 表示删掉这一格）。
 * ⚠️ 这个函数**不碰**文档：调用方拿到 plan 之后才走 `apiMutate()` 去写 ⇒ 非法输入不会留下半成品。
 */
function apiPlan(where, element, patch) {
  apiGuard(apiIsObject(patch), `${where}: 第二个参数要是一个对象 {…}，收到 ${apiShow(patch)}`);
  const allowed = API_KEYS[element.type] ?? ['name', 'box', 'style'];
  for (const key of Object.keys(patch)) apiGuard(allowed.includes(key), apiKeyReason(where, element, key, allowed));
  const plan = [];
  if (patch.name !== undefined) {
    apiGuard(patch.name === null || typeof patch.name === 'string', `${where}: name 要是一个字符串（要清空就写 ''），收到 ${apiShow(patch.name)}`);
    plan.push({ key: 'name', value: patch.name });
  }
  if (patch.text !== undefined) {
    apiGuard(patch.text === null || typeof patch.text === 'string', `${where}: text 要是一个字符串（要清空就写 ''），收到 ${apiShow(patch.text)}`);
    plan.push({ key: 'text', value: patch.text });
  }
  if (patch.box !== undefined) plan.push({ key: 'box', value: apiPlanBox(where, element, patch.box) });
  if (patch.size !== undefined) plan.push({ key: 'size', value: apiPlanSize(where, element, patch.size) });
  if (patch.layout !== undefined) plan.push({ key: 'layout', value: apiPlanLayout(where, element, patch.layout) });
  if (patch.style !== undefined) plan.push({ key: 'style', value: apiPlanStyle(where, element, patch.style) });
  if (patch.orientation !== undefined) {
    apiGuard(DIVIDER_ORIENTATIONS.includes(patch.orientation),
      `${where}: ${element.id} 的 orientation 只能是 ${DIVIDER_ORIENTATIONS.join(' / ')}，收到 ${apiShow(patch.orientation)}`);
    plan.push({ key: 'orientation', value: patch.orientation });
  }
  if (patch.thickness !== undefined) {
    plan.push({ key: 'thickness', value: apiNum(where, `${element.id} 的 thickness`, patch.thickness, { above: 0 }) });
  }
  if (patch.color !== undefined) {
    apiGuard(typeof patch.color === 'string' && patch.color.trim() !== '', `${where}: color 要是一个非空字符串（CSS 颜色），收到 ${apiShow(patch.color)}`);
    plan.push({ key: 'color', value: patch.color });
  }
  return plan;
}
/** 按 plan 写进文档 —— **只在 `apiMutate()` 里面调**（这样才进撤销栈、才重渲染）。 */
function apiApplyPlan(target, plan) {
  for (const { key, value } of plan) {
    if (value === null) delete target[key]; else target[key] = value;
  }
}
function apiHistoryReceipt() {
  return { historyIndex: state.historyIndex, historyLength: state.history.length, canUndo: state.historyIndex > 0, canRedo: state.historyIndex < state.history.length - 1 };
}
function apiGetDoc() {
  return clone(state.doc);
}
function apiGetState() {
  return {
    screenId: currentScreen().id, screenName: currentScreen().name,
    stateId: currentState().id, stateName: currentState().name,
    view: state.view, selection: [...state.selection], commits,
    ...apiHistoryReceipt(),
  };
}
function apiGetNode(id) {
  const where = 'sophoDesigner.getNode';
  const element = apiElement(where, id);
  const parent = findParentOf(currentTree(), id);
  return {
    ok: true, element: clone(element), type: element.type,
    parentId: parent ? parent.id : null,
    index: parent ? (parent.children ?? []).findIndex((child) => child.id === id) : -1,
  };
}
function apiAddNode(parentId, spec) {
  const where = 'sophoDesigner.addNode';
  apiGuard(apiIsObject(spec), `${where}: 第二个参数要是一个对象 {type, …}，例如 addNode('el-1', {type:'rect', box:{x:24,y:24}})，收到 ${apiShow(spec)}`);
  apiGuard(TYPES.includes(spec.type), `${where}: 元素类型只能是 ${TYPES.join(' / ')} 之一，收到 ${apiShow(spec.type)}`);
  const parent = apiParent(where, parentId);
  const element = makeElement(spec.type, undefined); // 出厂值与鼠标新建**同一处**（中立的：没有 style 键）
  const rest = { ...spec };
  delete rest.type;
  apiApplyPlan(element, apiPlan(where, element, rest)); // 验完才落到这个新元素上（它还没进文档）
  if (rest.box === undefined) {
    const count = (parent.children ?? []).length;
    element.box = { x: 16 + (count % 8) * 14, y: 16 + (count % 8) * 14 }; // 与鼠标「只点一下」同一个级联错开
  }
  let index = -1;
  apiMutate(() => {
    const live = parent === currentTree() ? editTree() : parent; // 非默认状态：第一次写才把默认树拷一份（与鼠标同一手）
    live.children = [...(live.children ?? []), element];
    index = live.children.length - 1;
    state.selection = [element.id];
  });
  return { ok: true, id: element.id, type: element.type, parentId: parent.id, index, ...apiHistoryReceipt() };
}
function apiUpdateNode(id, patch) {
  const where = 'sophoDesigner.updateNode';
  const element = apiElement(where, id);
  const plan = apiPlan(where, element, patch); // ← 全部验完才写：非法输入一个字节都不动
  apiMutate(() => {
    const live = findElement(editTree(), id);
    apiApplyPlan(live, plan);
  });
  return { ok: true, id, type: element.type, applied: plan.map((entry) => entry.key), ...apiHistoryReceipt() };
}
function apiRemoveNode(id) {
  const where = 'sophoDesigner.removeNode';
  const element = apiElement(where, id);
  const parent = findParentOf(currentTree(), id);
  apiGuard(parent !== null,
    `${where}: ${id} 是屏根（这一屏的树）—— 删不掉；要清空就先逐个删它的子元素，要删整屏去左栏点「删掉这屏」`);
  let removed = 0;
  walkTree(element, () => { removed += 1; });
  apiMutate(() => {
    const liveParent = findParentOf(editTree(), id);
    liveParent.children = (liveParent.children ?? []).filter((child) => child.id !== id);
    state.selection = state.selection.filter((sel) => sel !== id);
  });
  return { ok: true, id, parentId: parent.id, removedElements: removed, ...apiHistoryReceipt() };
}
function apiMoveNode(id, parentId, index) {
  const where = 'sophoDesigner.moveNode';
  const element = apiElement(where, id);
  const from = findParentOf(currentTree(), id);
  apiGuard(from !== null, `${where}: ${id} 是屏根，移不了`);
  const parent = apiParent(where, parentId);
  apiGuard(parent.id !== id, `${where}: 不能把 ${id} 移进它自己`);
  let cycle = false;
  walkTree(element, (child) => { if (child !== element && child.id === parent.id) cycle = true; });
  apiGuard(!cycle, `${where}: 不能把 ${id} 移进它自己的后代 ${parent.id}（那样这棵子树就从树上掉下来了）`);
  const rest = (parent.children ?? []).filter((child) => child.id !== id);
  const target = index === undefined || index === null ? rest.length : apiNum(where, 'index', index, { min: 0, integer: true });
  apiGuard(target <= rest.length, `${where}: index ${target} 越界 —— 目标父容器 ${parent.id} 在放下 ${id} 之后有 ${rest.length} 个位置（0..${rest.length}）`);
  apiMutate(() => {
    const liveTree = editTree();
    const liveElement = findElement(liveTree, id);
    const liveFrom = findParentOf(liveTree, id);
    liveFrom.children = (liveFrom.children ?? []).filter((child) => child.id !== id);
    const liveTo = parent.id === liveTree.id ? liveTree : findElement(liveTree, parent.id);
    const kids = [...(liveTo.children ?? [])];
    kids.splice(target, 0, liveElement);
    liveTo.children = kids;
    state.selection = [id];
  });
  return { ok: true, id, parentId: parent.id, index: target, ...apiHistoryReceipt() };
}
function apiSelect(id) {
  const where = 'sophoDesigner.select';
  const ids = id === null || id === undefined ? [] : Array.isArray(id) ? id : [id];
  for (const item of ids) apiElement(where, item);
  if (ids.length === 0) {
    state.selection = [];
    renderLayers(); renderPanel(); paintSelection(); paintMeasures();
  } else {
    selectElement(ids[0]); // 与点画布**同一个函数**（选中不进撤销栈：它不是文档改动）
    for (const extra of ids.slice(1)) selectElement(extra, { additive: true });
  }
  return { ok: true, selection: [...state.selection], primary: state.selection[state.selection.length - 1] ?? null };
}
function apiOpenScreen(screenId, stateId) {
  const where = 'sophoDesigner.openScreen';
  apiGuard(typeof screenId === 'string' && screenId.length > 0, `${where}: screenId 要是一个非空字符串，收到 ${apiShow(screenId)}`);
  const screen = state.doc.screens.find((candidate) => candidate.id === screenId);
  apiGuard(!!screen, `${where}: 未知的屏 id ${apiShow(screenId)}（用 getDoc() 看有哪些屏）`);
  const states = screen.states ?? [];
  const wanted = stateId === undefined || stateId === null ? states[0]?.id : stateId;
  apiGuard(states.some((st) => st.id === wanted),
    `${where}: 屏 ${screenId} 上没有状态 ${apiShow(stateId)}（它有：${states.map((st) => st.id).join(' / ') || '（一个都没有）'}）`);
  if (screenId !== currentScreen().id) switchScreen(screenId); // 与点左栏那两行同一条路（各自可撤销）
  if (wanted !== currentState().id) switchState(wanted);
  return { ok: true, screenId: currentScreen().id, stateId: currentState().id, screenName: currentScreen().name, ...apiHistoryReceipt() };
}
function apiSetView(view) {
  const where = 'sophoDesigner.setView';
  apiGuard(view === 'edit' || view === 'flow', `${where}: view 只能是 'edit'（编辑屏）或 'flow'（流程 / 箭头），收到 ${apiShow(view)}`);
  switchView(view); // 与点顶栏那两个按钮同一个函数（视图不是文档改动）
  return { ok: true, view: state.view };
}
function apiAddScreen(name) {
  const where = 'sophoDesigner.addScreen';
  apiGuard(name === undefined || name === null || (typeof name === 'string' && name.trim() !== ''),
    `${where}: 屏名要么不传、要么是一个非空字符串，收到 ${apiShow(name)}`);
  const id = nextId('screen');
  const stateId = nextId('state');
  const root = blankRoot();
  root.id = nextId('el');
  const label = name ?? `屏 ${state.doc.screens.length + 1}`;
  apiMutate(() => {
    state.doc.screens.push({ id, name: label, states: [{ id: stateId, name: '默认' }], root });
    state.screenId = id;
    state.stateId = stateId;
    state.selection = [];
  });
  return { ok: true, screenId: id, stateId, rootId: root.id, name: label, screens: state.doc.screens.length, ...apiHistoryReceipt() };
}
function apiAddState(screenId, name) {
  const where = 'sophoDesigner.addState';
  apiGuard(typeof screenId === 'string' && screenId.length > 0, `${where}: screenId 要是一个非空字符串（用 getDoc() 看有哪些屏），收到 ${apiShow(screenId)}`);
  apiGuard(name === undefined || name === null || (typeof name === 'string' && name.trim() !== ''),
    `${where}: 状态名要么不传、要么是一个非空字符串，收到 ${apiShow(name)}`);
  const screen = state.doc.screens.find((candidate) => candidate.id === screenId);
  apiGuard(!!screen, `${where}: 未知的屏 id ${apiShow(screenId)}（用 getDoc() 看有哪些屏）`);
  const isCurrent = screen.id === currentScreen().id;
  const source = isCurrent ? currentTree() : getTree(screen, 0);
  apiGuard(!!source, `${where}: 屏 ${screenId} 上没有可拷贝的树（root 是空的）`);
  const id = nextId('state');
  const label = name ?? `状态 ${(screen.states ?? []).length + 1}`;
  const fresh = { id, name: label, root: clone(source) };
  apiMutate(() => {
    screen.states.push(fresh);
    // 元素 id 全文档唯一 ⇒ **先 push 进文档、再逐节点重分配**（`nextId()` 才看得见刚分掉的那些 id）—— 与鼠标「＋状态」同一手
    walkTree(fresh.root, (element) => { element.id = nextId('el'); });
    if (isCurrent) { state.stateId = id; state.selection = []; }
  });
  return { ok: true, stateId: id, screenId: screen.id, name: label, rootId: fresh.root.id, current: isCurrent, ...apiHistoryReceipt() };
}
function apiAddTransition(spec) {
  const where = 'sophoDesigner.addTransition';
  apiGuard(apiIsObject(spec), `${where}: 参数是一个对象 {from:{screen,state}, to:{screen,state}, trigger}，收到 ${apiShow(spec)}`);
  const endpoint = (label) => {
    const value = spec[label];
    // 形状口径与「导入 JSON」/`setDoc()` **同一份**实现（`transitionEndIssue()`），不另写一套
    const shape = transitionEndIssue(value, label);
    apiGuard(shape === null, `${where}: ${shape}`);
    const screen = state.doc.screens.find((candidate) => candidate.id === value.screen);
    apiGuard(!!screen, `${where}: ${label}.screen 是未知的屏 id ${apiShow(value.screen)}（用 getDoc() 看有哪些屏）`);
    const states = screen.states ?? [];
    apiGuard(states.some((st) => st.id === value.state),
      `${where}: ${label}.state ${apiShow(value.state)} 不在屏 ${screen.id} 上（它有：${states.map((st) => st.id).join(' / ') || '（一个都没有）'}）`);
    return { screen: screen.id, state: value.state };
  };
  const from = endpoint('from');
  const to = endpoint('to');
  apiGuard(!(from.screen === to.screen && from.state === to.state),
    `${where}: from 和 to 是同一条（${from.screen} · ${from.state}）—— 那样箭头原地不动、画不出来（换一个屏或换一个状态）`);
  const trigger = spec.trigger === undefined || spec.trigger === null ? '' : spec.trigger;
  apiGuard(typeof trigger === 'string', `${where}: trigger 要是一个字符串（比如 '点提交'），收到 ${apiShow(spec.trigger)}`);
  const id = nextId('tr');
  apiMutate(() => {
    state.doc.transitions = [...(state.doc.transitions ?? []), { id, from, to, trigger }];
  });
  return { ok: true, id, from, to, trigger, transitions: (state.doc.transitions ?? []).length, arrows: arrowSpecs().length, ...apiHistoryReceipt() };
}
function apiUndo() {
  const before = state.historyIndex;
  undo();
  if (state.historyIndex === before) {
    return { ok: true, changed: false, reason: '已经在最旧的那一步：没有可撤销的改动了', ...apiHistoryReceipt() };
  }
  return { ok: true, changed: true, ...apiHistoryReceipt() };
}
function apiRedo() {
  const before = state.historyIndex;
  redo();
  if (state.historyIndex === before) {
    return { ok: true, changed: false, reason: '已经在新的一步：没有可重做的改动了', ...apiHistoryReceipt() };
  }
  return { ok: true, changed: true, ...apiHistoryReceipt() };
}
/** 一份文档（对象或文本）→ 校验过的文档：**同一个** `checkDocumentShape()` + `validateDocument()`（不是两套校验器），
 *  只是把底层那句原因原样带上、并在前面标出**是哪一次调用**（回执要能指出是谁拒的）。 */
function apiValidateDoc(where, parsed) {
  try {
    return validateDocument(checkDocumentShape(parsed));
  } catch (error) {
    throw new Error(`${where}: 这份文档不能用 —— ${error?.message ?? String(error)}`);
  }
}
function apiSetDoc(input) {
  const where = 'sophoDesigner.setDoc';
  apiGuard(typeof input === 'string' || apiIsObject(input),
    `${where}: 参数要么是一份文档对象、要么是它的 JSON 字符串，收到 ${apiShow(input)}`);
  let parsed = null;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new Error(`${where}: 不是合法的 JSON（${error?.message ?? String(error)}）`);
    }
  } else {
    parsed = clone(input);
  }
  const doc = apiValidateDoc(where, parsed); // 与「导入 JSON」同一套形状校验 + 分割符校验
  apiMutate(() => {
    state.doc = doc;
    const screen = doc.screens[0];
    state.screenId = screen.id;
    state.stateId = (screen.states ?? [])[0]?.id ?? 'state-1';
    state.selection = [];
    state.folded.clear(); // 同上：换文档 ⇒ 折叠态清空
  });
  const screen = doc.screens[0];
  setStatus(`sophoDesigner.setDoc：已换掉文档（${doc.screens.length} 屏 / ${(doc.transitions ?? []).length} 转移，可撤销）`, 'ok');
  return { ok: true, screens: doc.screens.length, transitions: (doc.transitions ?? []).length, screenId: screen.id, stateId: state.stateId, bytes: exportText().length, ...apiHistoryReceipt() };
}
function apiExportDoc() {
  return exportText(); // 与顶栏「导出 JSON」/「导出 ▾ ⇒ 规范 JSON」同一串字节（`serializeDocument` 是唯一来源）
}
function apiHelp() {
  return API_HELP.map((entry) => ({ ...entry }));
}
const SOPHO_API = {
  version: API_VERSION,
  help: apiHelp,
  getDoc: apiGetDoc,
  getState: apiGetState,
  getNode: apiGetNode,
  addNode: apiAddNode,
  updateNode: apiUpdateNode,
  removeNode: apiRemoveNode,
  moveNode: apiMoveNode,
  select: apiSelect,
  openScreen: apiOpenScreen,
  setView: apiSetView,
  addScreen: apiAddScreen,
  addState: apiAddState,
  addTransition: apiAddTransition,
  undo: apiUndo,
  redo: apiRedo,
  setDoc: apiSetDoc,
  exportDoc: apiExportDoc,
};
// 每个方法外面包一层**只为了看得见**：被拒时除了抛出（回执一个字不改），还把原因写进页面状态栏 ——
// 站在这一页前面的人得看得见「刚才那次调用被拒了、为什么」，而不是只在 agent 的聊天里看得见。
// ⚠️ 它不是校验层：真正的拒绝点只有 `apiGuard()`；这里只负责把同一个 `Error` 原样再抛出去。
for (const [name, fn] of Object.entries(SOPHO_API)) {
  if (typeof fn !== 'function' || name === 'help') continue;
  SOPHO_API[name] = (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      setStatus(`sophoDesigner.${name} 拒了这次调用：${error?.message ?? String(error)}`, 'error');
      throw error;
    }
  };
}
window.sophoDesigner = SOPHO_API;

// ── 启动 ────────────────────────────────────────────────────────────────────────────────
resetHistory();
renderAll();

/** 测试接缝（`test/designer-ui.mjs` 读它们做「往返确定性」「箭头来源」「历史指针」这类判据）。 */
window.__dz = {
  version: 'designer-ui-1',
  doc: () => state.doc,
  serialize: (doc) => serializeDocument(doc ?? state.doc),
  parse: (text) => parseDocument(text),
  arrowSpecs: () => arrowSpecs().map((spec) => ({ id: spec.id, from: spec.from, to: spec.to, label: spec.label })),
  screenId: () => currentScreen().id,
  stateId: () => currentState().id,
  viewScale: () => viewTransform.scale,
  /** 视图平移（屏幕像素）—— 与 `viewScale()` 同一条来源；**不是**模型的一部分。 */
  viewPan: () => ({ x: viewTransform.x, y: viewTransform.y }),
  exportHtml: () => exportHtml(),
  exportKinds: () => Object.keys(EXPORT_LABELS),
  exportLabel: (kind) => EXPORT_LABELS[kind] ?? null,
  lastExport: () => ({ ...lastExport }),
  exportMenuOpen: () => document.querySelector('#dz-export-items').hidden === false,
  copyPath: () => lastCopy.path,
  copyTrace: () => ({ ...lastCopy }),
  htmlSpecOf: (id) => {
    const element = findElement(currentTree(), id);
    return element?.type === 'divider' ? dividerHtmlSpec(element) : null;
  },
  transitions: () => (state.doc.transitions ?? []).map((transition) => ({ ...transition, from: { ...(transition.from ?? {}) }, to: { ...(transition.to ?? {}) } })),
  dividerSizeShim: (element) => dividerSizeShim(element),
  validate: (doc) => { validateDocument(doc); return true; },
  selection: () => [...state.selection],
  historyIndex: () => state.historyIndex,
  historyLength: () => state.history.length,
  commits: () => commits,
  elementCount: () => elementNodes.size,
};
window.__dzReady = true;
