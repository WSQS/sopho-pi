#!/usr/bin/env node
// designer/validate.mjs —— 中立文档的校验器（纯 Node、零依赖）。
//
// 两半，各管一件事：
//   ① **结构**：直接**解释 `designer/schema.json`**（本文件自己不写死任何一个字段名或封闭集合）。
//      ⇒ 「字段名 / type 的封闭集合 / layout.mode / size.mode / align / style 的键」只有**一份**判断，
//      就是那份 schema。改了 schema，校验行为就跟着改（`test/designer-model.mjs` 有一条反证臂钉这件事：
//      往 schema 副本的 type 枚举里塞一个 "arrow" ⇒ 带 `"type":"arrow"` 的文档当场从「不认识」变「认识」）。
//      支持的关键字（就这些，没实现的**不会**被当成通过）：$ref、type、enum、required、properties、
//      additionalProperties、propertyNames、items、minItems、maxItems、minLength、minimum、anyOf。
//   ② **语义**：JSON Schema 表达不了的那几件 —— id 唯一 / token 引用闭合且无环 / 转移两端指得到 /
//      自由容器的子元素必须有 box / 只有 container 能带 layout 与 children / fixed 必须有 value。
//      （转移两端的 `state` **必填**那条归 ① 的 schema `required` 判（一处判定、一处报错），这里不另写一份口径；
//      2026-09-25 收严：以前 `state` 可选，现在缺了当场拒收 —— **破坏性**，旧文档要补上 states[0].id。）
//
// 输出的每一条都带 `code` ＋ `path`（`screens[0].root.children[2].box.x` 这种可粘贴回去的路径）
// ＋ `message`（人读的一句话）。**坏文档给可读报错**，不是「invalid」三个字。
//
// 用法：
//   node designer/validate.mjs <doc.json>        # 0 = 合法（警告不算失败）；1 = 有错
//   node design/validate.mjs --json <doc.json>   # 把结果按 JSON 打到 stdout
//
// 纪律：本文件**不联网**（$schema 那个 URL 只是记录，谁也不去取它）。

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SCHEMA_URL = new URL('./schema.json', import.meta.url);
export const SCHEMA = JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));

/** 文档的格式版本：只认 schema 里 `version.enum` 列出的那些（唯一来源就是那份 schema）。 */
export const SUPPORTED_VERSIONS = [...SCHEMA.properties.version.enum];

/** 封闭集合都从 schema 里读出来（给导出器与门用；不要在别处再抄一份）。 */
export const VOCAB = Object.freeze({
  elementTypes: [...SCHEMA.$defs.element.properties.type.enum],
  layoutModes: [...SCHEMA.$defs.element.properties.layout.properties.mode.enum],
  sizeModes: [...SCHEMA.$defs.constraint.properties.mode.enum],
  aligns: [...SCHEMA.$defs.element.properties.layout.properties.align.enum],
  textAligns: [...SCHEMA.$defs.element.properties.style.properties.textAlign.enum],
  styleKeys: Object.keys(SCHEMA.$defs.element.properties.style.properties),
});

/** 文档不合法时抛这个：带上全部错误（不是第一个），导出器拿它**拒绝产出**（不许有半成品）。 */
export class DesignerInvalidDocumentError extends Error {
  constructor(errors, source = '(内存里的文档)') {
    const head = errors.slice(0, 3).map((error) => error.message).join('；');
    super(`${source} 不是合法的设计器文档（${errors.length} 个错）：${head}${errors.length > 3 ? `；还有 ${errors.length - 3} 个` : ''}`);
    this.name = 'DesignerInvalidDocumentError';
    this.errors = errors;
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────────────────────────
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsType = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);const snippet = (value) => {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
};
const typeNames = (type) => (Array.isArray(type) ? type : [type]);
const describeShape = (node) => {
  if (!isObject(node)) return '任意值';
  if (node.enum) return node.enum.map((item) => JSON.stringify(item)).join(' | ');
  if (node.type === 'array') return `数组（${describeShape(node.items)}）`;
  const names = node.type ? typeNames(node.type).join(' | ') : '值';
  return node.minimum !== undefined ? `${names}（≥ ${node.minimum}）` : names;
};
const titleOf = (node) => (isObject(node) && typeof node.title === 'string' ? node.title : null);
const withTitle = (path, title) => (title ? `${path}（${title}）` : path);

export function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error(`只支持本文件内的 $ref（读到 ${JSON.stringify(ref)}）`);
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node?.[key];
    if (node === undefined) throw new Error(`$ref 指不到：${ref}`);
  }
  return node;
}

// ── ① schema 解释器 ──────────────────────────────────────────────────────────────────────────
//
// 「有牙」的边界（诚实）：只实现上面列的关键字。schema 里出现别的关键字（today 没有）会被**忽略**，
// 所以扩展 schema 时必须同时在这里加实现 —— 这条边界写在 docs/designer-exporters.md 的「没验到什么」里。
function validateNode(node, value, path, errors, root) {
  if (node === true || node === undefined) return;
  if (!isObject(node)) return;
  if (node.$ref) return validateNode(resolveRef(node.$ref, root), value, path, errors, root);

  if (node.enum && !node.enum.some((item) => item === value)) {
    errors.push({
      code: path === 'version' ? 'version-unsupported' : path.endsWith('.type') ? 'type-unknown' : 'value-not-allowed',
      keyword: 'enum',
      path,
      message: `${path}: 只能是 ${node.enum.map((item) => JSON.stringify(item)).join(' | ')} 之一，实际是 ${snippet(value)}`,
    });
    return;
  }

  if (node.type) {
    const names = typeNames(node.type);
    const ok = names.some((name) => (
      name === 'object' ? isObject(value)
        : name === 'array' ? Array.isArray(value)
          : name === 'integer' ? Number.isInteger(value)
            : name === 'number' ? (typeof value === 'number' && Number.isFinite(value))
              : name === 'null' ? value === null
                : typeof value === name
    ));
    if (!ok) {
      const isCoordinate = /\.box\.(x|y|w|h)$/.test(path);
      errors.push({
        code: isCoordinate ? 'coordinate-not-number' : 'field-type',
        keyword: 'type',
        path,
        message: `${withTitle(path, titleOf(node))}: 必须是 ${names.join(' | ')}，实际是 ${snippet(value)}（${jsType(value)}）`,
      });
      return;
    }
  }

  if (node.anyOf) {
    const matched = node.anyOf.some((option) => {
      const probe = [];
      validateNode(option, value, path, probe, root);
      return probe.length === 0;
    });
    if (!matched) {
      errors.push({
        code: 'value-not-allowed',
        keyword: 'anyOf',
        path,
        message: `${withTitle(path, titleOf(node))}: 形状不对 —— ${node.description ?? node.anyOf.map(describeShape).join(' 或 ')}；实际是 ${snippet(value)}`,
      });
      return;
    }
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push({ code: 'field-type', keyword: 'minLength', path, message: `${withTitle(path, titleOf(node))}: 不能是空字符串` });
    }
    if (node.pattern && !new RegExp(node.pattern).test(value)) {
      errors.push({ code: 'token-name-invalid', keyword: 'pattern', path, message: `${withTitle(path, titleOf(node))}: 不符合格式 ${node.pattern}，实际是 ${snippet(value)}` });
    }
  }
  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) {
    errors.push({ code: 'value-not-allowed', keyword: 'minimum', path, message: `${withTitle(path, titleOf(node))}: 不能小于 ${node.minimum}，实际是 ${value}` });
  }

  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push({ code: 'screens-empty', keyword: 'minItems', path, message: `${withTitle(path, titleOf(node))}: 至少要 ${node.minItems} 项，实际 ${value.length} 项` });
      return;
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      errors.push({ code: 'value-not-allowed', keyword: 'maxItems', path, message: `${withTitle(path, titleOf(node))}: 最多 ${node.maxItems} 项，实际 ${value.length} 项` });
      return;
    }
    if (node.items) value.forEach((item, index) => validateNode(node.items, item, `${path}[${index}]`, errors, root));
    return;
  }

  if (isObject(value)) {
    const allowed = node.properties ? Object.keys(node.properties) : null;
    if (node.propertyNames?.pattern) {
      for (const key of Object.keys(value)) {
        if (!new RegExp(node.propertyNames.pattern).test(key)) {
          errors.push({
            code: 'token-name-invalid',
            keyword: 'propertyNames',
            path: `${path}.${key}`,
            message: `${path}: 键 ${JSON.stringify(key)} 不合法（token 名必须以 -- 开头、只含字母数字与 -_）`,
          });
        }
      }
    }
    for (const required of node.required ?? []) {
      if (value[required] === undefined) {
        // 「缺了哪个字段」之外，把这个字段自己的 `description` 也带上 —— 一处的说明只有一份（就在 schema 里），
        // 免得「为什么它必填」只写在文档里、报错里却看不到（`state` 那条就是这么收严的）。
        const child = node.properties?.[required];
        const why = isObject(child) && typeof child.description === 'string' ? ` —— ${child.description}` : '';
        errors.push({
          code: required === 'id' ? 'id-missing' : 'field-required',
          keyword: 'required',
          path,
          message: `${withTitle(path, titleOf(node))}: 缺少必填字段 ${JSON.stringify(required)}${why}`,
        });
      }
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (value[key] !== undefined) validateNode(child, value[key], path ? `${path}.${key}` : key, errors, root);
    }
    for (const key of Object.keys(value)) {
      if (allowed && allowed.includes(key)) continue;
      const extra = node.additionalProperties;
      if (extra === undefined || extra === true) continue;
      if (extra === false) {
        errors.push({
          code: 'field-unknown',
          keyword: 'additionalProperties',
          path: `${path}.${key}`,
          message: `${path}: 不认识的字段 ${JSON.stringify(key)}（允许：${(allowed ?? []).join(', ') || '（空对象）'}）`,
        });
      } else {
        validateNode(extra, value[key], path ? `${path}.${key}` : key, errors, root);
      }
    }
  }
}

// ── ② 语义检查（schema 表达不了的那些） ─────────────────────────────────────────────────────

/** 容器的布局模式：没写 `layout` 的 container 按 `free` 算（自由布局是默认；那时子元素必须有 box）。
    `size` / `box` / 布局模式这三件事的默认值只有这一处，导出器与校验器都从这里读。 */
export function containerModeOf(element) {
  if (!isObject(element) || element.type !== 'container') return null;
  return isObject(element.layout) && typeof element.layout.mode === 'string' ? element.layout.mode : 'free';
}

/** `(屏, 状态)` 那一棵树：状态自带 `root` 就用它，否则与默认树共用。
    **这一条读法只有这一处**（`toSvg.renderScreenSvg` 与转移的起点锚都读它）。 */
export function stateTreeOf(screen, stateId) {
  const states = Array.isArray(screen?.states) ? screen.states : [];
  const selected = states.find((item) => isObject(item) && item.id === stateId);
  return selected?.root ?? screen?.root;
}

/** 深度优先找第一个 `id` 命中的元素（元素 id 全文档唯一 ⇒ 命中至多一个）。 */
export function findElementById(tree, id) {
  const stack = [tree];
  while (stack.length > 0) {
    const element = stack.pop();
    if (!isObject(element)) continue;
    if (element.id === id) return element;
    const children = Array.isArray(element.children) ? element.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return null;
}

/** 转移起点锚的选择器认哪几种写法：**只认 `#<元素 id>`**。
 *  为什么：本仓元素的唯一稳定定位方式是 `id`（schema 里必填、且**全文档唯一**）—— 没有 class、没有别的可锚的名字；
 *  所以别的写法（`.class` / `[id=…]` / 组合器 / 通配）**不猜**（猜错会画出「看着对、其实指错控件」的箭头）。
 *  返回 `id`；不认识（或不是字符串）就返回 `null`（调用方如实报错）。 */
export function anchorElementId(selector) {
  if (typeof selector !== 'string') return null;
  const match = /^\s*#([^\s#.\[\]:>+~,*]+)\s*$/.exec(selector);
  return match === null ? null : match[1];
}

/** 文档里的**每一棵树**：默认树（`screens[].root`）＋ 每个「有自己树的状态」（`states[j].root`）
    ＋ 每个组件自己的那棵默认树（`components[].root`）。
    状态树也是元素树 ⇒ 它的元素同样要过 id 唯一、free 要有 box、只有 container 能带 layout/children 那几条。
    组件树同理（它的元素 id 与别的元素一样**全文档唯一**）。 */
function* treeRoots(doc) {
  for (const [screenIndex, screen] of (Array.isArray(doc?.screens) ? doc.screens : []).entries()) {
    if (!isObject(screen)) continue;
    yield [screen.root, `screens[${screenIndex}].root`, false];
    for (const [stateIndex, state] of (Array.isArray(screen.states) ? screen.states : []).entries()) {
      if (isObject(state) && state.root !== undefined) yield [state.root, `screens[${screenIndex}].states[${stateIndex}].root`, false];
    }
  }
  for (const [componentIndex, component] of (Array.isArray(doc?.components) ? doc.components : []).entries()) {
    if (isObject(component) && component.root !== undefined) yield [component.root, `components[${componentIndex}].root`, true];
  }
}

/** 深度优先走遍全部元素（跨屏、跨状态树、跨组件树），带路径。 */
function* walkElements(doc) {
  for (const [root, base, inComponent] of treeRoots(doc)) {
    const stack = [[root, base, null]];
    while (stack.length > 0) {
      const [element, path, parentMode] = stack.pop();
      if (!isObject(element)) continue;
      yield { element, path, parentMode, inComponent };
      const mode = containerModeOf(element);
      const children = Array.isArray(element.children) ? element.children : [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push([children[index], `${path}.children[${index}]`, mode]);
      }
    }
  }
}

/** 一棵（组件）树里全部元素的 id（覆盖只能指到这里的 id）。 */
function collectElementIds(root, out = new Set()) {
  if (!isObject(root)) return out;
  if (typeof root.id === 'string') out.add(root.id);
  for (const child of Array.isArray(root.children) ? root.children : []) collectElementIds(child, out);
  return out;
}

function paddingWarningKey(layout) { return isObject(layout) ? layout.mode : null; }

function semanticErrors(doc) {
  const errors = [];
  const warnings = [];
  if (!isObject(doc)) return { errors, warnings };

  // id 唯一：屏（全文档）／状态（一屏之内）／元素（全文档、不按屏分作用域）／转移（全文档）
  const seen = { screen: new Map(), element: new Map(), transition: new Map(), component: new Map() };
  const claim = (kind, id, path, label) => {
    if (typeof id !== 'string' || id === '') return;
    const map = seen[kind];
    if (map.has(id)) {
      errors.push({
        code: 'id-duplicate',
        path,
        message: `${path}: ${label} id ${JSON.stringify(id)} 重复了（第一次在 ${map.get(id)}）—— id 全文档唯一，不能两处同名`,
      });
      return;
    }
    map.set(id, path);
  };

  const screens = Array.isArray(doc.screens) ? doc.screens : [];
  screens.forEach((screen, index) => {
    if (!isObject(screen)) return;
    claim('screen', screen.id, `screens[${index}].id`, '屏');
    const states = Array.isArray(screen.states) ? screen.states : [];
    const stateIds = new Map();
    states.forEach((state, stateIndex) => {
      if (stateIndex === 0 && isObject(state) && state.root !== undefined) {
        warnings.push({
          code: 'state0-root-ignored',
          path: `screens[${index}].states[0].root`,
          message: `screens[${index}].states[0].root: 默认状态的树**就是** screens[${index}].root（它前面的那一个）；这一份不生效 —— 两份树会是两份真源`,
        });
      }
      if (!isObject(state) || typeof state.id !== 'string' || state.id === '') return;
      if (stateIds.has(state.id)) {
        errors.push({ code: 'id-duplicate', path: `screens[${index}].states[${stateIndex}].id`, message: `screens[${index}].states[${stateIndex}].id: 状态 id ${JSON.stringify(state.id)} 在同一屏里重复了（第一次在 screens[${index}].states[${stateIds.get(state.id)}].id）` });
      } else {
        stateIds.set(state.id, stateIndex);
      }
    });
  });

  const byComponentId = new Map();
  const components = Array.isArray(doc.components) ? doc.components : [];
  components.forEach((component, index) => {
    if (!isObject(component)) return;
    claim('component', component.id, `components[${index}].id`, '组件');
    if (typeof component.id === 'string' && !byComponentId.has(component.id)) byComponentId.set(component.id, component);
  });

  for (const { element, path, parentMode, inComponent } of walkElements(doc)) {
    claim('element', element.id, `${path}.id`, '元素');
    if (parentMode === 'free' && !isObject(element.box)) {
      errors.push({
        code: 'box-missing-in-free',
        path,
        message: `${path}: 自由布局（free）容器里的元素必须有 box（x/y/w/h）—— 没有坐标就没法说它放在哪`,
      });
    }
    if (parentMode && parentMode !== 'free' && isObject(element.box)) {
      warnings.push({ code: 'box-ignored', path: `${path}.box`, message: `${path}.box: 父容器是 ${parentMode} 布局，坐标盒子不起作用（自动布局说了算）；要自由摆放请把父容器改成 free` });
    }
    const type = element.type;
    if (isObject(element.layout) && type !== undefined && type !== 'container') {
      errors.push({ code: 'layout-not-allowed', path: `${path}.layout`, message: `${path}: 只有 container 能带 layout（这里是 ${snippet(type)}）` });
    }
    if (Array.isArray(element.children) && type !== undefined && type !== 'container' && type !== 'instance') {
      errors.push({ code: 'children-not-allowed', path: `${path}.children`, message: `${path}: 只有 container 能有 children（这里是 ${snippet(type)}）` });
    }
    // ── 组件与实例（Figma 的 component / instance）那一组 ──────────────────────────────────────
    // 结构（类型、必填、封闭集合）归 schema 判；这里管 schema 说不清的那几件：**指不指得到**。
    const hasRef = element.ref !== undefined;
    if (hasRef && type !== 'instance') {
      errors.push({ code: 'ref-not-allowed', path: `${path}.ref`, message: `${path}.ref: 只有 type="instance" 能带 ref（这里是 ${snippet(type)}）—— 「引用一个组件」是一种元素，不是普通元素的附加字段` });
    }
    if (type === 'instance' && !hasRef) {
      errors.push({ code: 'instance-ref-missing', path, message: `${path}: type="instance" 就必须有 ref（指到 components[] 里某个组件的 id）—— 没有 ref 就不知道它引用的是谁` });
    }
    if (type === 'instance' && inComponent) {
      errors.push({ code: 'component-nested-instance', path, message: `${path}: 组件树里不许再嵌实例（组件不能引用组件）—— 否则摊平会递归、成环也没人挡` });
    }
    if (Array.isArray(element.children) && type === 'instance') {
      errors.push({ code: 'instance-children-not-allowed', path: `${path}.children`, message: `${path}.children: 实例的子元素来自它引用的组件，不许自己写 children（要改就写 overrides）` });
    }
    if (element.variant !== undefined && !hasRef) {
      errors.push({ code: 'variant-not-allowed', path: `${path}.variant`, message: `${path}.variant: 只有实例（type="instance" 且带 ref）能选变体` });
    }
    if (element.overrides !== undefined && !hasRef) {
      errors.push({ code: 'override-not-allowed', path: `${path}.overrides`, message: `${path}.overrides: 只有实例（type="instance" 且带 ref）能带逐实例覆盖` });
    }
    if (hasRef && type === 'instance' && typeof element.ref === 'string') {
      const component = byComponentId.get(element.ref);
      if (component === undefined) {
        errors.push({ code: 'ref-unknown', path: `${path}.ref`, message: `${path}.ref: 指到了不存在的组件 ${snippet(element.ref)}（文档里的组件：${[...byComponentId.keys()].join(', ') || '（没有）'}）` });
      } else {
        const variants = Array.isArray(component.variants) ? component.variants : [];
        if (typeof element.variant === 'string' && !variants.some((item) => isObject(item) && item.id === element.variant)) {
          errors.push({ code: 'variant-unknown', path: `${path}.variant`, message: `${path}.variant: 组件 ${component.id} 里没有变体 ${snippet(element.variant)}（它有：${variants.map((item) => item?.id).filter((id) => typeof id === 'string').join(', ') || '（没有）'}）` });
        }
        if (isObject(element.overrides)) {
          const known = collectElementIds(component.root);
          for (const key of Object.keys(element.overrides)) {
            if (!known.has(key)) {
              errors.push({ code: 'override-target-unknown', path: `${path}.overrides.${key}`, message: `${path}.overrides: 键 ${JSON.stringify(key)} 不是组件 ${component.id} 树里的元素 id（覆盖只能指到组件里真实存在的那个元素）` });
            }
          }
        }
      }
    }
    for (const axis of ['w', 'h']) {
      const constraint = element.size?.[axis];
      if (!isObject(constraint)) continue;
      if (constraint.mode === 'fixed' && typeof constraint.value !== 'number') {
        errors.push({ code: 'size-value-missing', path: `${path}.size.${axis}`, message: `${path}.size.${axis}: mode 是 fixed 就必须给一个数（value 缺失）` });
      }
      if ((constraint.mode === 'fill' || constraint.mode === 'content') && constraint.value !== undefined) {
        warnings.push({ code: 'size-value-ignored', path: `${path}.size.${axis}.value`, message: `${path}.size.${axis}.value: mode 是 ${constraint.mode}，value 不起作用（只有 fixed 用 value）` });
      }
    }
    const layout = element.layout;
    if (isObject(layout)) {
      if (layout.mode === 'grid' && layout.columns === undefined) {
        errors.push({ code: 'grid-columns-missing', path: `${path}.layout`, message: `${path}.layout: grid 必须给 columns（列数），否则网格没法排` });
      }
      if (layout.mode !== 'grid' && layout.columns !== undefined) {
        warnings.push({ code: 'layout-option-ignored', path: `${path}.layout.columns`, message: `${path}.layout.columns: 只有 grid 用 columns（当前 mode 是 ${layout.mode}）` });
      }
      if (layout.mode === 'free' && (layout.gap !== undefined || layout.padding !== undefined || layout.align !== undefined)) {
        warnings.push({ code: 'layout-option-ignored', path: `${path}.layout`, message: `${path}.layout: free 布局不看 gap/padding/align（自由容器里位置由子元素的 box 说了算）` });
      }
    }
    if (element.text !== undefined && !['text', 'input', 'button'].includes(String(type))) {
      warnings.push({ code: 'text-ignored', path: `${path}.text`, message: `${path}.text: ${snippet(type)} 型元素不渲染 text（只有 text / input / button 用）` });
    }
  }

  // token 引用闭合、无环
  const tokens = isObject(doc.tokens) ? doc.tokens : {};
  const refs = new Map();
  for (const [name, value] of Object.entries(tokens)) {
    if (typeof value !== 'string') continue;
    const match = /^\s*var\(\s*(--[a-zA-Z0-9_-]+)\s*\)\s*$/.exec(value);
    if (match) refs.set(name, match[1]);
  }
  for (const [name, target] of refs) {
    if (!(target in tokens)) {
      errors.push({ code: 'token-ref-unknown', path: `tokens.${name}`, message: `tokens.${name}: 引用了不存在的 token ${target}（token 引用必须能追到具体值）` });
    }
  }
  for (const name of refs.keys()) {
    const chain = [name];
    const seenNames = new Set([name]);
    let cursor = refs.get(name);
    while (cursor !== undefined) {
      if (seenNames.has(cursor)) {
        errors.push({ code: 'token-ref-cycle', path: `tokens.${name}`, message: `tokens.${name}: token 引用成环 —— ${[...chain, cursor].join(' ⇒ ')}（DTCG 的口径：引用不得成环）` });
        break;
      }
      seenNames.add(cursor);
      chain.push(cursor);
      cursor = refs.get(cursor);
    }
  }

  // 转移两端指得到（屏 / 状态）
  const byScreenId = new Map(screens.filter(isObject).map((screen) => [screen.id, screen]));
  const transitions = Array.isArray(doc.transitions) ? doc.transitions : [];
  transitions.forEach((transition, index) => {
    if (!isObject(transition)) return;
    claim('transition', transition.id, `transitions[${index}].id`, '转移');
    for (const end of ['from', 'to']) {
      const value = transition[end];
      if (!isObject(value) || typeof value.screen !== 'string') continue;
      const screen = byScreenId.get(value.screen);
      if (!screen) {
        errors.push({ code: 'transition-screen-unknown', path: `transitions[${index}].${end}.screen`, message: `transitions[${index}].${end}.screen: 指到了不存在的屏 ${snippet(value.screen)}（文档里的屏：${screens.filter(isObject).map((item) => item.id).join(', ') || '（没有）'}）` });
        continue;
      }
      // 缺 `state` 是**结构**错，归 schema 的 `required` 判（一处判定、一处报错）；这一步只管「它在不在那个屏里」。
      if (typeof value.state !== 'string') continue;
      const states = Array.isArray(screen.states) ? screen.states : [];
      if (!states.some((state) => isObject(state) && state.id === value.state)) {
        errors.push({ code: 'transition-state-unknown', path: `transitions[${index}].${end}.state`, message: `transitions[${index}].${end}.state: 屏 ${screen.id} 里没有状态 ${snippet(value.state)}（它有：${states.filter(isObject).map((state) => state.id).join(', ') || '（没有）'}）` });
      }
    }
  });

  // 转移的**起点锚**（可选 `from.anchor.selector`）：必须在 `from` 那个屏/状态树里指到一个元素。
  // 为什么归校验（而不是等导出器自己抛）：这是**文档本身**说不说得通的问题，与「转移两端指得到」同一条口径
  // —— 在这里判 ⇒ 库函数抛 `DesignerInvalidDocumentError`、CLI 退 3 且**一个字节都不写**，报错也带可粘回的路径。
  transitions.forEach((transition, index) => {
    if (!isObject(transition)) return;
    const value = transition.from;
    if (!isObject(value) || value.anchor === undefined) return;
    const path = `transitions[${index}].from.anchor`;
    const anchor = value.anchor;
    // 形状（是不是对象、`selector` 在不在且是字符串）归 schema 的 type/required 判 —— 一处判定、一处报错；
    // 这里只管 schema 说不清的那件：**这个选择器指不指得到元素**。
    if (!isObject(anchor) || typeof anchor.selector !== 'string') return;
    const id = anchorElementId(anchor.selector);
    if (id === null) {
      errors.push({ code: 'anchor-selector-unsupported', path: `${path}.selector`, message: `${path}.selector: ${snippet(anchor.selector)} 不是本仓认识的写法 —— 元素的唯一稳定定位方式是 id，所以只认 \`#<元素 id>\`` });
      return;
    }
    const screen = byScreenId.get(value.screen);
    if (!screen || typeof value.state !== 'string') return; // 屏/状态本身指不到：那几条错上面已经报过了
    if (findElementById(stateTreeOf(screen, value.state), id) === null) {
      errors.push({ code: 'anchor-element-unknown', path: `${path}.selector`, message: `${path}.selector: 屏 ${screen.id}／状态 ${value.state} 的树里没有 id=${JSON.stringify(id)} 的元素（锚点必须指得到那个控件，否则箭头画不出「从控件出来」）` });
    }
  });

  return { errors, warnings };
}

// ── 入口 ─────────────────────────────────────────────────────────────────────────────────────
export function validateDocument(doc, { source = '(内存里的文档)' } = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(doc)) {
    errors.push({
      code: 'doc-not-object',
      keyword: 'type',
      path: '',
      message: `${source}: 文档必须是一个 JSON 对象（读到 ${snippet(doc)}）`,
    });
    return { ok: false, errors, warnings, source };
  }
  validateNode(SCHEMA, doc, '', errors, SCHEMA);
  const semantic = semanticErrors(doc);
  errors.push(...semantic.errors);
  warnings.push(...semantic.warnings);
  return { ok: errors.length === 0, errors, warnings, source };
}

/** 校验并**当场抛**（导出器用：宁可什么都不产出，也不产出半成品）。 */
export function assertValidDocument(doc, source) {
  const result = validateDocument(doc, { source });
  if (!result.ok) throw new DesignerInvalidDocumentError(result.errors, result.source);
  return result;
}

export function formatReport(result) {
  const lines = [];
  for (const error of result.errors) lines.push(`✗ [${error.code}] ${error.message}`);
  for (const warning of result.warnings) lines.push(`! [${warning.code}] ${warning.message}`);
  if (result.ok) {
    lines.push(`✓ ${result.source}: 合法（${result.warnings.length} 条警告）`);
  } else {
    lines.push(`✗ ${result.source}: 不合法（${result.errors.length} 个错、${result.warnings.length} 条警告）`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) {
    process.stderr.write('用法：node designer/validate.mjs [--json] <doc.json>\n');
    process.exit(2);
  }
  const text = readFileSync(file, 'utf8');
  const result = validateDocument(JSON.parse(text), { source: file.split('\\').join('/') });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
    for (const error of result.errors) process.stderr.write(`${error.code} @ ${error.path}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}
