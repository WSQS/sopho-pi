// designer/expand.mjs —— 把**实例**摊平成具体元素树（Figma 的 instance resolution）。
//
// 为什么要有它：中立文档允许 `type: "instance"` 的结点**引用** `components[]` 里的一个组件
// （`ref`）＋一个变体（`variant`）＋一层逐实例覆盖（`overrides`）。**渲染器（HTML / SVG）都只认具体元素树** ⇒
// 引用必须先摊平。两份实现共用**这一个**摊平器，免得它们各写一份、日后漂移。
//
// 口径（写死在这里；门按这几条钉）：
//   ① 覆盖合并：对象逐键**深合并**（`style.border.left.color` 只改那一格），数组与标量整体替换；
//   ② 一层覆盖的来源顺序：**变体在前、实例在后**（同一元素同一字段，实例赢）；
//   ③ id 重发：实例根拿**实例自己的 id**（锚点/量盒子仍然找得到它），子元素拿 `${实例 id}/${组件里的 id}`
//      —— 确定性、全文档唯一，且两个实例互不撞；
//   ④ 实例结点自己的 `name` / `box` / `size` / `layout` / `style` / `text` 再盖在组件根的对应字段上
//      （身份字段 `ref` / `variant` / `overrides` **不落进树**：树里没有「引用」这种东西）。
//
// 不做的事（诚实）：**组件里不许再嵌实例**（校验器拒收）⇒ 这里只摊平一层、不递归解析组件。

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** 实例结点自己的字段里，哪些会盖到「组件根」上（身份字段除外）。 */
const INSTANCE_ROOT_KEYS = ['name', 'box', 'size', 'layout', 'style', 'text'];

/** 深合并：对象逐键递归，数组与标量（含 `text`）整体替换。返回**新对象**（不改入参）。 */
export function deepMerge(base, patch) {
  if (!isObject(base) || !isObject(patch)) return structuredClone(patch);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : structuredClone(value);
  }
  return out;
}

/** 文档里某个组件（找不到返回 null；「指不到」由校验器负责判红）。 */
export function componentById(doc, id) {
  return (Array.isArray(doc?.components) ? doc.components : []).find((item) => isObject(item) && item.id === id) ?? null;
}

/** 把若干张覆盖表并成一张：同一元素同一字段，**后面的赢**（递归合并）。 */
export function mergeOverrideMaps(...maps) {
  const out = {};
  for (const map of maps) {
    if (!isObject(map)) continue;
    for (const [id, patch] of Object.entries(map)) {
      out[id] = out[id] === undefined ? structuredClone(patch) : deepMerge(out[id], patch);
    }
  }
  return out;
}

/** 把一张覆盖表盖到一棵**组件树**上（按元素 id 匹配、递归），返回新树。 */
export function applyOverrides(tree, overrides) {
  if (!isObject(overrides) || Object.keys(overrides).length === 0) return structuredClone(tree);
  const walk = (node) => {
    let out = structuredClone(node);
    const patch = overrides[node.id];
    if (patch !== undefined) out = deepMerge(out, patch);
    // ⚠️ 不能因为本结点有覆盖就 `return`：`overrides` 是**整棵树**的映射，子结点也要继续走
    //   （第一版就是在这里提前返回，于是「根上有 border 覆盖 + 某个子元素有 text 覆盖」时子元素那份静默丢了）。
    if (Array.isArray(node.children)) out.children = node.children.map(walk);
    return out;
  };
  return walk(tree);
}

/** 摊平一个元素（整棵树）：`type: instance` 换成组件树的展开结果，其余递归下去。 */
export function expandElement(element, doc) {
  if (!isObject(element)) return element;
  if (element.type !== 'instance') {
    const out = structuredClone(element);
    if (Array.isArray(element.children)) out.children = element.children.map((child) => expandElement(child, doc));
    return out;
  }
  const component = componentById(doc, element.ref);
  if (component === null) throw new Error(`实例 ${JSON.stringify(element.id)} 的 ref ${JSON.stringify(element.ref)} 指不到任何组件（文档不合法就不该走到这里）`);
  const variants = Array.isArray(component.variants) ? component.variants : [];
  const variant = variants.find((item) => isObject(item) && item.id === element.variant);
  const overrides = mergeOverrideMaps(variant?.overrides, element.overrides);
  const base = applyOverrides(component.root, overrides);
  const rootId = element.id;
  const out = { ...base, id: rootId };
  for (const key of INSTANCE_ROOT_KEYS) {
    if (element[key] === undefined) continue;
    out[key] = isObject(element[key]) && isObject(base[key]) ? deepMerge(base[key], element[key]) : structuredClone(element[key]);
  }
  if (Array.isArray(base.children)) {
    const rekey = (node) => {
      const copy = { ...node, id: `${rootId}/${node.id}` };
      if (Array.isArray(node.children)) copy.children = node.children.map(rekey);
      return copy;
    };
    out.children = base.children.map(rekey);
  }
  return out;
}

/** 摊平一棵树（渲染器的入口）。 */
export function expandTree(tree, doc) {
  return expandElement(tree, doc);
}
