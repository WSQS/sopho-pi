#!/usr/bin/env node
// designer/diff.mjs —— 两份中立文档的**语义 diff**（纯 Node、零依赖）。
//
// 为什么按「语义」而不是按文本：**id 是稳定的**（业主口径：schema 只增不改、id 永不变），所以
// 「同一个元素」跨两份文档是可判的。于是 diff 能说出**是哪个元素、哪个字段**变了，而不是
// 「第 47 行不一样」。这也是两件事共用的同一件工具：
//   ① 人看「这一版改了什么」；
//   ② **导出物是不是旧的** —— 导出物里嵌着它对应文档的 `sha256`（`designer/canonical.mjs`），
//      拿它和「当前文档的 sha256」比即可（`--check-export`）。这条正是「多一层上游就多一个漂源」那把闸。
//
// 语义口径（写下来，免得后人以为是漏了）：
//   · 元素 / 屏 / 状态 / 转移都**按 id 对齐**：同名同 id ⇒ 同一个东西（改名字、改位置都还是它）；
//   · `children` 的**数组顺序有语义**（绘制顺序）⇒ 顺序变了报 `reordered`；
//   · `tokens` 的键**没有顺序**（schema 里它是自由对象）⇒ 键按字典序比；
//   · `$schema` / `version` / `name` 是文档层字段，变化也会报；
//   · 不认识的字段（schema 里没有的）照样比（`designer/diff.mjs` 不该悄悄放过一件事）。
//
// 用法：
//   node designer/diff.mjs <a.json> <b.json>                       # 0 = 语义相同；1 = 有差异
//   node designer/diff.mjs --check-export=<file> --doc=<doc.json>   # 导出物是不是按这份文档生成的
//   node designer/diff.mjs --json ...                               # 机读结果

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { canonicalize, docDigest } from './canonical.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value) => JSON.stringify(value === undefined ? null : value);

/** 导出物里嵌的文档摘要（HTML 的 `<meta name="designer-doc-digest">` / SVG 的 `data-doc-digest`）。 */
export function embeddedDigest(text) {
  const meta = /name="designer-doc-digest"\s+content="sha256:([0-9a-f]{64})"/.exec(text);
  if (meta) return meta[1];
  const attr = /data-doc-digest="sha256:([0-9a-f]{64})"/.exec(text);
  return attr ? attr[1] : null;
}

const short = (digest) => `sha256:${digest.slice(0, 10)}…${digest.slice(-4)}`;

/** 导出物是不是按**这一份**文档生成的（旧的 ⇒ `ok:false`，把两侧的摘要都报出来）。 */
export function checkExportFreshness(doc, text, source = '(导出物)') {
  const embedded = embeddedDigest(text);
  const expected = docDigest(doc);
  if (embedded === null) {
    return { ok: false, code: 'digest-missing', source, embedded, expected, message: `${source}: 里面没有文档摘要（这份导出物不是本导出器产的，或者被手改过）` };
  }
  if (embedded !== expected) {
    return {
      ok: false, code: 'export-stale', source, embedded, expected,
      message: `${source}: 导出物是旧的 —— 它对应 ${short(embedded)}，当前文档是 ${short(expected)}（重跑一次导出器）`,
    };
  }
  return { ok: true, code: 'fresh', source, embedded, expected, message: `${source}: 新鲜（${short(embedded)} 与当前文档一致）` };
}

// ── 语义 diff 本体 ────────────────────────────────────────────────────────────────────────────
function push(changes, kind, path, before, after) {
  changes.push({ kind, path, before: before === undefined ? null : before, after: after === undefined ? null : after });
}

function diffScalar(changes, path, before, after) {
  if (stable(before) === stable(after)) return;
  push(changes, before === undefined ? 'added' : after === undefined ? 'removed' : 'changed', path, before, after);
}

/** 递归往下比到一个**叶子**：`box.w` 变了就报 `…box.w`，不是把整个 box 当成一处变化。 */
function compareValue(changes, path, before, after) {
  if (stable(before) === stable(after)) return;
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) compareValue(changes, `${path}.${key}`, before[key], after[key]);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) compareValue(changes, `${path}[${index}]`, before[index], after[index]);
    return;
  }
  diffScalar(changes, path, before, after);
}

/** 对象逐字段比（含未列在 schema 里的字段；数组交给调用方按语义处理）。 */
function diffFields(changes, path, before, after, { skip = [] } = {}) {
  const keys = [...new Set([...Object.keys(isObject(before) ? before : {}), ...Object.keys(isObject(after) ? after : {})])]
    .filter((key) => !skip.includes(key))
    .sort();
  for (const key of keys) {
    compareValue(changes, `${path}.${key}`, isObject(before) ? before[key] : undefined, isObject(after) ? after[key] : undefined);
  }
}

function elementPaths(screen, screenId) {
  const nodes = new Map();
  const walk = (element, parentId, depth) => {
    if (!isObject(element)) return;
    const path = `screens.${screenId}.${element.id}`;
    nodes.set(element.id, { element, parentId, depth, path });
    for (const child of Array.isArray(element.children) ? element.children : []) walk(child, element.id, depth + 1);
  };
  walk(screen.root, null, 0);
  return nodes;
}

function diffScreens(changes, before, after) {
  const left = new Map((Array.isArray(before) ? before : []).filter(isObject).map((screen) => [screen.id, screen]));
  const right = new Map((Array.isArray(after) ? after : []).filter(isObject).map((screen) => [screen.id, screen]));
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const id of ids) {
    const path = `screens.${id}`;
    const a = left.get(id);
    const b = right.get(id);
    if (!a) { push(changes, 'added', path, undefined, b.name ?? b.id); continue; }
    if (!b) { push(changes, 'removed', path, a.name ?? a.id, undefined); continue; }
    diffScalar(changes, `${path}.name`, a.name, b.name);
    // 状态按 id 对齐
    const statesA = new Map((a.states ?? []).map((state) => [state.id, state]));
    const statesB = new Map((b.states ?? []).map((state) => [state.id, state]));
    for (const stateId of [...new Set([...statesA.keys(), ...statesB.keys()])].sort()) {
      const one = statesA.get(stateId);
      const other = statesB.get(stateId);
      if (!one) push(changes, 'added', `${path}.states.${stateId}`, undefined, other.name ?? other.id);
      else if (!other) push(changes, 'removed', `${path}.states.${stateId}`, one.name ?? one.id, undefined);
      else diffScalar(changes, `${path}.states.${stateId}.name`, one.name, other.name);
    }
    const orderA = (a.states ?? []).map((state) => state.id).join(',');
    const orderB = (b.states ?? []).map((state) => state.id).join(',');
    if (orderA !== orderB) push(changes, 'reordered', `${path}.states`, orderA, orderB);
    // 元素树按 id 对齐
    const nodesA = elementPaths(a, id);
    const nodesB = elementPaths(b, id);
    for (const elementId of [...new Set([...nodesA.keys(), ...nodesB.keys()])].sort()) {
      const one = nodesA.get(elementId);
      const other = nodesB.get(elementId);
      const elementPath = `screens.${id}.${elementId}`;
      if (!one) { push(changes, 'added', elementPath, undefined, { type: other.element.type, parent: other.parentId }); continue; }
      if (!other) { push(changes, 'removed', elementPath, { type: one.element.type, parent: one.parentId }, undefined); continue; }
      if (one.parentId !== other.parentId) push(changes, 'moved', `${elementPath}.parent`, one.parentId, other.parentId);
      diffFields(changes, elementPath, one.element, other.element, { skip: ['id', 'children'] });
      const childrenA = (one.element.children ?? []).map((child) => child.id).join(',');
      const childrenB = (other.element.children ?? []).map((child) => child.id).join(',');
      if (childrenA !== childrenB) push(changes, 'reordered', `${elementPath}.children`, childrenA, childrenB);
    }
  }
}

function diffTransitions(changes, before, after) {
  const left = new Map((Array.isArray(before) ? before : []).filter(isObject).map((transition) => [transition.id, transition]));
  const right = new Map((Array.isArray(after) ? after : []).filter(isObject).map((transition) => [transition.id, transition]));
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const path = `transitions.${id}`;
    const a = left.get(id);
    const b = right.get(id);
    if (!a) { push(changes, 'added', path, undefined, b.trigger ?? b.id); continue; }
    if (!b) { push(changes, 'removed', path, a.trigger ?? a.id, undefined); continue; }
    diffFields(changes, path, a, b, { skip: ['id'] });
  }
}

function diffTokens(changes, before, after) {
  const a = isObject(before) ? before : {};
  const b = isObject(after) ? after : {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    diffScalar(changes, `tokens.${key}`, a[key], b[key]);
  }
}

/**
 * 两份文档的语义 diff：`{ equal, changes: [{ kind, path, before, after }], summary }`。
 * 顺序稳定（按 `path`，再按 `kind`）—— 同一对文档跑两次结果逐字节相同。
 */
export function semanticDiff(before, after) {
  const changes = [];
  const left = isObject(before) ? before : {};
  const right = isObject(after) ? after : {};
  diffScalar(changes, '$schema', left.$schema, right.$schema);
  diffScalar(changes, 'version', left.version, right.version);
  diffScalar(changes, 'name', left.name, right.name);
  diffTokens(changes, left.tokens, right.tokens);
  diffScreens(changes, left.screens, right.screens);
  diffTransitions(changes, left.transitions, right.transitions);
  changes.sort((a, b) => (a.path === b.path ? a.kind.localeCompare(b.kind) : a.path.localeCompare(b.path)));
  const counts = changes.reduce((acc, change) => ({ ...acc, [change.kind]: (acc[change.kind] ?? 0) + 1 }), {});
  return { equal: changes.length === 0, changes, summary: counts, canonicalEqual: JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right)) };
}

/** 文本形式的 diff（人读；一行一处变化）。 */
export function formatDiff(result) {
  if (result.equal) return '两份文档语义相同（没有变化）';
  return result.changes.map((change) => `${change.kind.padEnd(9)} ${change.path}${change.kind === 'changed' ? `：${stable(change.before)} ⇒ ${stable(change.after)}` : change.kind === 'added' ? `（新增 ${stable(change.after)}）` : change.kind === 'removed' ? `（删掉 ${stable(change.before)}）` : `：${stable(change.before)} ⇒ ${stable(change.after)}`}`).join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const files = args.filter((arg) => !arg.startsWith('--'));
  const asJson = args.includes('--json');

  if (argOf('check-export')) {
    const exportFile = argOf('check-export');
    const docFile = argOf('doc');
    if (!docFile) {
      process.stderr.write('用法：node designer/diff.mjs --check-export=<file> --doc=<doc.json>\n');
      process.exit(2);
    }
    const [text, doc] = await Promise.all([readFile(exportFile, 'utf8'), readFile(docFile, 'utf8')]);
    const result = checkExportFreshness(JSON.parse(doc), text, exportFile.split('\\').join('/'));
    process.stdout.write(`${result.ok ? '✓' : '✗'} ${result.message}\n`);
    process.exit(result.ok ? 0 : 1);
  }

  if (files.length !== 2) {
    process.stderr.write('用法：node designer/diff.mjs <a.json> <b.json> ｜ --check-export=<file> --doc=<doc.json>\n');
    process.exit(2);
  }
  const [leftText, rightText] = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  const result = semanticDiff(JSON.parse(leftText), JSON.parse(rightText));
  if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${formatDiff(result)}\n`);
  process.exit(result.equal ? 0 : 1);
}
