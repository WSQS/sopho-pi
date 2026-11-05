#!/usr/bin/env node
// test/designer-model.mjs —— 中立文档模型的门：**校验（好文档过 / 每类坏文档都给可读错）＋ 导出的确定性**。
// 不用浏览器（一两秒）：这一层是「文档本身对不对」「同一份文档导出两次是不是同一串字节」。
//
// 断言组：
//   ① 好文档过（`demo.json` 与 `minimal.json`，逐条报出错误数/警告数）；
//   ② 每类坏文档都红，而且**报错可读**：有 `code`、有可粘贴回去的 `path`、`message` 里点名了字段与
//      闯祸的那个值 —— 任务书点名的那五类（未知 type / 缺 id / id 重复 / 坐标非数 / 版本不认识）各有一条断言；
//      另有一类：转移的一端**缺 `state`**（`transition-state-missing`，2026-09-25 收严）；
//   ②b 转移两端**必须显式 `{screen, state}`**（同一次收严的判据面）：fixtures 与 generated 的 demo
//      每一端都写全（4 个断言）；缺 `state` 的文档被拒收（模型层 ＋ CLI，报错带可粘回的路径）；
//      两份「故意坏」的夹具保持坏、并多一条名正言顺的原因（断言它们不是回归）；
//      反证臂 `schema-state-optional`（把 schema 改回「可选」）与 `fixture-state-dropped`
//      （把 fixtures 里某条 `state` 删掉）各必红；
//   ③ **确定性**：同一份文档渲染两次 ⇒ 逐字节相同（HTML / 每张屏 SVG / 转移图 / 规范 JSON），
//      并且**跨进程**再跑一次导出器，产物的 sha256 逐个相同；
//   ④ 坏文档 ⇒ **如实拒绝、什么都不产出**（库函数抛 `DesignerInvalidDocumentError`；CLI 非 0 且不写盘）；
//   ⑤ schema 是**结构与封闭集合的唯一来源**：`type:"arrow"` 这类必须被拒（报错里那个集合就是 schema 的枚举），
//      并且 schema 里每个 `$ref` 都能解析（悬空引用是静默的坏）；
//      反证臂 `schema-not-source` 把 schema 副本的 `type` 枚举里加一个 `"arrow"` ⇒ ⑤必红
//      （证明校验真的在读那份 schema，而不是把规则写死在代码里）。
//   ⑥ 组件 / 变体 / 实例 / 逐实例覆盖 ＋ 单边边框（2026-10-05 加，Figma 的 component·variant·instance·override）：
//      `fixtures/components.json` 是好文档（进 ① 那一组）；摊平（`designer/expand.mjs`）的变体生效、
//      实例覆盖赢变体、id 重发、纯函数；`style.border` 在 HTML（逐边 width/color）与 SVG（逐边 rect）都落地；
//      而**没有新字段的老文档一个字节没变**（`border:legacy-untouched`）。
//      8 类「指不到/用错」的坏文档各有一条断言（参 BAD_CASES）；7 条新反证臂各拿掉一条牙 ⇒ 对应断言必红。
//
// 用法：
//   node test/designer-model.mjs
//   node test/designer-model.mjs --reverse-arm=schema-not-source
//   node test/designer-model.mjs --reverse-arm=schema-state-optional
//   node test/designer-model.mjs --reverse-arm=fixture-state-dropped

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { removeSandbox } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const THIS_FILE = path.join(here, 'designer-model.mjs');
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const DESIGNER_ROOT = path.resolve(process.env.SOPHO_DESIGNER_ROOT || path.join(root, 'designer'));

const failures = [];
const problems = [];
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
function check(id, name, ok, detail) {
  if (ok) {
    process.stdout.write(`✓ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    process.stdout.write('\n');
    return true;
  }
  failures.push(id);
  process.stdout.write(`✗ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  process.stdout.write('\n');
  return false;
}
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 坏文档语料：`mentions` 是「可读」的机械判据 —— 报错里必须点名字段、并且点名闯祸的那个值。 */
const BAD_CASES = [
  { file: 'unknown-type', code: 'type-unknown', path: 'screens[0].root.children[0].type', mentions: ['tabel', 'container', 'button'], note: '未知 type' },
  { file: 'arrow-type', code: 'type-unknown', path: 'screens[0].root.children[0].type', mentions: ['arrow', 'container'], note: '箭头不是一种元素：它只能由 transitions 生成' },
  { file: 'missing-id', code: 'id-missing', path: 'screens[0].root.children[0]', mentions: ['id'], note: '缺 id' },
  { file: 'duplicate-id', code: 'id-duplicate', path: 'screens[0].root.children[1].id', mentions: ['only-box', 'screens[0].root.children[0].id'], note: 'id 重复' },
  { file: 'coordinate-not-number', code: 'coordinate-not-number', path: 'screens[0].root.children[0].box.x', mentions: ['x', 'number', '"8"'], note: '坐标非数' },
  { file: 'version-unknown', code: 'version-unsupported', path: 'version', mentions: ['9.9.9', '0.1.0'], note: '版本不认识' },
  { file: 'duplicate-screen-id', code: 'id-duplicate', path: 'screens[1].id', mentions: ['only', 'screens[0].id'], note: '屏 id 重复' },
  { file: 'state-root-duplicate-id', code: 'id-duplicate', path: 'screens[0].states[1].root.children[0].id', mentions: ['only-box', 'screens[0].root.children[0].id'], note: '状态自己那棵树里的 id 与别处撞了（id 全文档唯一，不按树分作用域）' },
  { file: 'free-child-without-box', code: 'box-missing-in-free', path: 'screens[0].root.children[0]', mentions: ['box', 'free'], note: '自由布局的子元素没有坐标' },
  { file: 'token-ref-unknown', code: 'token-ref-unknown', path: 'tokens.--alias', mentions: ['--nope'], note: 'token 引用不闭合' },
  { file: 'token-ref-cycle', code: 'token-ref-cycle', path: 'tokens.--a', mentions: ['--a', '--b'], note: 'token 引用成环' },
  { file: 'transition-screen-unknown', code: 'transition-screen-unknown', path: 'transitions[0].to.screen', mentions: ['nope', 'only'], note: '转移指到不存在的屏' },
  { file: 'transition-state-unknown', code: 'transition-state-unknown', path: 'transitions[0].to.state', mentions: ['nope', 'default'], note: '转移指到不存在的状态' },
  { file: 'transition-state-missing', code: 'field-required', path: 'transitions[0].from', mentions: ['state', '缺少', '都要写成'], note: '转移的一端**缺 state**（2026-09-25 收严：这一端以前可选、现在必填，缺了就拒收）' },
  { file: 'size-value-missing', code: 'size-value-missing', path: 'screens[0].root.size.w', mentions: ['fixed', 'value'], note: 'fixed 却没有 value' },
  { file: 'grid-without-columns', code: 'grid-columns-missing', path: 'screens[0].root.layout', mentions: ['columns'], note: '网格没有列数' },
  { file: 'unknown-layout-mode', code: 'value-not-allowed', path: 'screens[0].root.layout.mode', mentions: ['flexbox', 'grid'], note: '布局模式不在封闭集合里' },
  { file: 'unknown-field', code: 'field-unknown', path: 'screens[0].root.children[0].zIndex', mentions: ['zIndex', 'children'], note: '字段名拼错/多余字段' },
  { file: 'unknown-style-key', code: 'field-unknown', path: 'screens[0].root.children[0].style.shadow', mentions: ['shadow', 'color'], note: '样式键不在封闭集合里' },
  { file: 'screens-empty', code: 'screens-empty', path: 'screens', mentions: [], note: '一份文档至少要有一屏' },
  { file: 'not-an-object', code: 'doc-not-object', path: '', mentions: [], note: '顶层不是对象' },
  // ── 组件 / 实例 / 覆盖（Figma 的 component·instance）那一组：每条“指不到”都有自己的 code 与可粘回的 path ──
  { file: 'ref-unknown', code: 'ref-unknown', path: 'screens[0].root.children[0].ref', mentions: ['nope', '不存在的组件'], note: '实例的 ref 指到不存在的组件' },
  { file: 'variant-unknown', code: 'variant-unknown', path: 'screens[0].root.children[0].variant', mentions: ['nope', '没有变体'], note: '实例选的变体不在那个组件里' },
  { file: 'override-target-unknown', code: 'override-target-unknown', path: 'screens[0].root.children[0].overrides.tc-ghost', mentions: ['tc-ghost', '元素 id'], note: '覆盖的键不是组件树里的元素 id' },
  { file: 'instance-ref-missing', code: 'instance-ref-missing', path: 'screens[0].root.children[0]', mentions: ['ref', 'components'], note: 'type=instance 却没有 ref' },
  { file: 'instance-children', code: 'instance-children-not-allowed', path: 'screens[0].root.children[0].children', mentions: ['overrides'], note: '实例自己写了 children（子元素只能来自组件）' },
  { file: 'ref-on-plain-element', code: 'ref-not-allowed', path: 'screens[0].root.children[0].ref', mentions: ['instance'], note: '普通元素带了 ref（引用只能是 instance 那种元素）' },
  { file: 'component-nested-instance', code: 'component-nested-instance', path: 'components[0].root.children[2]', mentions: ['组件', '实例'], note: '组件树里再嵌一个实例（组件不能引用组件）' },
  { file: 'override-field-forbidden', code: 'field-unknown', path: 'screens[0].root.children[0].overrides.tc-meta.id', mentions: ['id'], note: '覆盖里改了不许改的字段（id）' },
];

const ARM_SPECS = {
  'schema-not-source': {
    file: 'schema.json',
    anchor: '"enum": ["container", "rect", "text", "image", "input", "button", "instance"]',
    replace: '"enum": ["container", "rect", "text", "image", "input", "button", "instance", "arrow"]',
    why: '往 schema 的 type 枚举里加一个 "arrow"',
    expectRed: ['schema:closed-set'],
  },
  'schema-state-optional': {
    file: 'schema.json',
    anchor: '"required": ["screen", "state"]',
    replace: '"required": ["screen"]',
    why: '把 schema 里转移那一端的 `state` 改回「可选」（= 2026-09-25 收严之前的口径）',
    expectRed: ['ends:missing-state-rejected', 'bad:transition-state-missing'],
  },
  'fixture-state-dropped': {
    file: 'fixtures/demo.json',
    anchor: '      "from": {\n        "screen": "home",\n        "state": "default"\n      },\n      "to": {\n        "screen": "settings",',
    replace: '      "from": {\n        "screen": "home"\n      },\n      "to": {\n        "screen": "settings",',
    why: '把 fixtures/demo.json 里第一条转移（t-home-settings）的 from.state 删掉',
    expectRed: ['good:demo', 'ends:fixtures-demo'],
  },
  // ── 新能力（组件 / 实例 / 覆盖 / 单边边框）的反证臂：各自把一条牙拿掉，预期那条判据变红 ──
  'ref-unknown-code-drift': {
    file: 'validate.mjs',
    anchor: "        errors.push({ code: 'ref-unknown',",
    replace: "        errors.push({ code: 'ref-unknown-ARM',",
    why: '把「ref 指不到组件」那条报错的 code 改掉（指不到也照样过）',
    expectRed: ['bad:ref-unknown'],
  },
  'variant-unknown-not-checked': {
    file: 'validate.mjs',
    anchor: "        if (typeof element.variant === 'string' && !variants.some((item) => isObject(item) && item.id === element.variant)) {",
    replace: "        if (false) {",
    why: '把「实例选的变体必须存在」那条判据拿掉',
    expectRed: ['bad:variant-unknown'],
  },
  'override-target-not-checked': {
    file: 'validate.mjs',
    anchor: '            if (!known.has(key)) {',
    replace: '            if (false) {',
    why: '把「覆盖只能指到组件里真实存在的元素 id」那条判据拿掉',
    expectRed: ['bad:override-target-unknown'],
  },
  'nested-instance-not-checked': {
    file: 'validate.mjs',
    anchor: "    if (type === 'instance' && inComponent) {",
    replace: '    if (false) {',
    why: '把「组件树里不许再嵌实例」那条判据拿掉',
    expectRed: ['bad:component-nested-instance'],
  },
  'override-merge-dropped': {
    file: 'expand.mjs',
    anchor: '    if (patch !== undefined) out = deepMerge(out, patch);',
    replace: '    if (patch !== undefined) out = structuredClone(node);',
    why: '摊平时把覆盖整层丢掉（变体/逐实例覆盖都不生效）',
    expectRed: ['components:variant-applied', 'components:instance-override-wins'],
  },
  'border-edges-dropped': {
    file: 'toSvg.mjs',
    anchor: '  if (!isObject(style) || !isObject(style.border)) return [];',
    replace: '  return [];',
    why: 'SVG 把单边边框整层丢掉（不再逐边画）',
    expectRed: ['border:svg-edges'],
  },
  'border-html-dropped': {
    file: 'toHtml.mjs',
    anchor: '  if (isObject(style.border)) declarations.push(...borderDeclarations(style.border));',
    replace: '  // ARM: 单边边框整层丢掉',
    why: 'HTML 把单边边框整层丢掉（不再写逐边 border-*-width/color）',
    expectRed: ['border:html-edges'],
  },
};

if (ARM) {
  const spec = ARM_SPECS[ARM];
  if (!spec) {
    process.stderr.write(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_SPECS).join(', ')}）\n`);
    process.exit(2);
  }
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'designer-model-arm-'));
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
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, SOPHO_DESIGNER_ROOT: mutantRoot },
  });
  const redIds = [...(child.stdout ?? '').matchAll(/^✗ \[([^\]]+)\]/gm)].map((match) => match[1]);
  const missing = spec.expectRed.filter((id) => !redIds.includes(id));
  process.stdout.write(`\n──── 反证臂 ${ARM}：预期红 ${JSON.stringify(spec.expectRed)} / 实际红 ${JSON.stringify(redIds)}（子进程 exit=${child.status}）────\n`);
  for (const id of spec.expectRed) process.stdout.write(`  ${redIds.includes(id) ? '红' : '没红'}：[${id}]\n`);
  const ok = child.status !== 0 && missing.length === 0;
  process.stdout.write(ok
    ? `✓ 反证臂 ${ARM} 红到位（${spec.why} ⇒ 校验行为跟着 schema 变；真 designer/ 一个字节没动）\n`
    : `✗ 反证臂 ${ARM} **没红到位**：缺 ${JSON.stringify(missing)}（子进程 exit=${child.status}）⇒ 这道门是个假门\n`);
  if (!ok) process.stdout.write(`${(child.stdout ?? '').split('\n').filter((line) => line.startsWith('✗')).join('\n')}\n`);
  process.stderr.write(child.stderr ?? '');
  await removeSandbox(sandbox, problems, 'designer-model 反证臂沙箱');
  for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
  process.exitCode = ok && problems.length === 0 ? 0 : 1;
} else {
  const validate = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'validate.mjs')).href);
  const canonical = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'canonical.mjs')).href);
  const designer = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toHtml.mjs')).href);
  const svg = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toSvg.mjs')).href);
  const diff = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'diff.mjs')).href);
  const expand = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'expand.mjs')).href);
  const exporterPath = path.join(DESIGNER_ROOT, 'export.mjs');
  if (DESIGNER_ROOT !== path.join(root, 'designer')) print('designer 根', `${DESIGNER_ROOT}（⚠️ 不是仓库里那一份）`);

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'designer-model-'));
  let primaryError = null;
  try {
    // ① 好文档过
    for (const name of ['demo', 'minimal', 'components']) {
      const file = path.join(DESIGNER_ROOT, 'fixtures', `${name}.json`);
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) { check(`good:${name}`, `好文档 ${name}.json 必须存在并合法`, false, '读不到这份 fixture'); continue; }
      const result = validate.validateDocument(JSON.parse(text), { source: `designer/fixtures/${name}.json` });
      check(`good:${name}`, `好文档 ${name}.json 通过校验（0 个错）`, result.ok, `${result.errors.length} 错 / ${result.warnings.length} 警告${result.errors.length ? `：${result.errors.map((error) => `${error.code}@${error.path}`).join(', ')}` : ''}`);
    }

    // ①b 规范序列化 == fixture 的字节（fixture 本身就是规范形式 ⇒ 「导出 JSON」是 round-trip 的）
    const demoText = await readFile(path.join(DESIGNER_ROOT, 'fixtures', 'demo.json'), 'utf8');
    const demo = JSON.parse(demoText);
    check('canonical:roundtrip', 'demo.json 已经是**规范形式**（键序由 schema 定、2 空格）⇒ 导出 JSON 与它逐字节相同（round-trip 不丢信息）',
      canonical.canonicalJson(demo) === demoText, `${Buffer.byteLength(canonical.canonicalJson(demo))} B vs ${Buffer.byteLength(demoText)} B`);

    // ② 每类坏文档：红 + 可读
    const badDir = path.join(DESIGNER_ROOT, 'fixtures', 'bad');
    const present = new Set(await readdir(badDir));
    const reportLines = [];
    for (const badCase of BAD_CASES) {
      const id = `bad:${badCase.file}`;
      if (!present.has(`${badCase.file}.json`)) { check(id, `坏文档语料 ${badCase.file}.json 在场`, false, '文件不在 fixtures/bad/ 里'); continue; }
      const doc = JSON.parse(await readFile(path.join(badDir, `${badCase.file}.json`), 'utf8'));
      const result = validate.validateDocument(doc, { source: `fixtures/bad/${badCase.file}.json` });
      const hit = result.errors.find((error) => error.code === badCase.code && (badCase.path === '' || error.path === badCase.path));
      const readable = hit !== undefined
        && typeof hit.message === 'string' && hit.message.length >= 20
        && (badCase.path === '' || hit.message.includes(badCase.path.split('.').at(-1)) || hit.message.includes(badCase.path))
        && badCase.mentions.every((needle) => hit.message.includes(needle));
      check(id, `坏文档 ${badCase.file}（${badCase.note}）：判红，且报错**可读**（code=${badCase.code}、path=${badCase.path || '(顶层)'}、message 点名了字段与那个值）`,
        result.ok === false && hit !== undefined && readable,
        hit ? `${hit.message}` : `没有 code=${badCase.code} / path=${badCase.path} 的错；实际：${JSON.stringify(result.errors.map((error) => `${error.code}@${error.path}`))}`);
      if (hit) reportLines.push(`BAD-DOC ${badCase.file} → [${hit.code}] ${hit.path || '(顶层)'}\n    ${hit.message}`);
      // 坏文档也可能同时带警告；这里只在「合法」这一步判红，不做别的假设
    }

    // ②b 转移两端**必须显式 `{screen, state}`**（2026-09-25 收严）—— 这一组是那次收严的判据面。
    //    为什么：省掉 `state` 的文档在转移图里**一根箭头都画不出来**（页面那条路径没有「缺省 = 默认状态」实现），
    //    而旧口径静默收下它（`docs/design/designer-format.md` §1~§3 是原始证据）。
    const endsOf = (doc) => (Array.isArray(doc.transitions) ? doc.transitions : [])
      .flatMap((transition, index) => ['from', 'to'].map((end) => ({ index, end, value: transition?.[end] })));
    const incompleteEnds = (doc) => endsOf(doc).filter(({ value }) => value === null || typeof value !== 'object' || Array.isArray(value)
      || typeof value.screen !== 'string' || typeof value.state !== 'string');
    for (const [id, label, file] of [
      ['ends:fixtures-demo', 'fixtures/demo.json', path.join(DESIGNER_ROOT, 'fixtures', 'demo.json')],
      ['ends:generated-demo', 'generated/demo.json', path.join(DESIGNER_ROOT, 'generated', 'demo.json')],
    ]) {
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) { check(id, `${label} 必须在场（读不到就没法量转移两端）`, false, file); continue; }
      const parsed = JSON.parse(text);
      const ends = endsOf(parsed);
      const missing = incompleteEnds(parsed);
      check(id, `${label} 的**每一端**都写全了 {screen, state}（${(parsed.transitions ?? []).length} 条转移 / ${ends.length} 端，一个都不许省）`,
        ends.length > 0 && missing.length === 0,
        missing.length === 0
          ? `${ends.length}/${ends.length} 端齐全：${ends.map(({ value }) => `${value.screen}/${value.state}`).join('、')}`
          : `缺 screen/state 的端：${missing.map(({ index, end }) => `transitions[${index}].${end}`).join('、')}`);
    }

    // 缺 `state` 的一份文档（就地删掉 demo 第一条转移的 `from.state`）⇒ 模型层当场拒收；报错带可粘回的路径 ＋ 人话
    const missingStateDoc = JSON.parse(demoText);
    delete missingStateDoc.transitions[0].from.state;
    const missingStateResult = validate.validateDocument(missingStateDoc, { source: '(demo.json 的副本：删掉 transitions[0].from.state)' });
    const missingStateError = missingStateResult.errors.find((error) => error.code === 'field-required' && error.path === 'transitions[0].from');
    check('ends:missing-state-rejected', '缺 `state` 的转移文档被模型层拒收（`field-required`、path 就是 `transitions[0].from`），且报错里带那条**可粘回的路径**与那句人话（「都要写成 {screen, state}」）',
      missingStateResult.ok === false && missingStateError !== undefined
        && missingStateError.message.includes('transitions[0].from') && missingStateError.message.includes('state') && missingStateError.message.includes('都要写成'),
      missingStateError ? missingStateError.message : `实际：${JSON.stringify(missingStateResult.errors.map((error) => `${error.code}@${error.path}`))}`);
    const missingStateFile = path.join(sandbox, 'missing-state.json');
    await writeFile(missingStateFile, JSON.stringify(missingStateDoc, null, 2), 'utf8');
    const missingStateOut = path.join(sandbox, 'missing-state-out');
    const missingStateRun = spawnSync(process.execPath, [exporterPath, `--doc=${missingStateFile}`, `--out=${missingStateOut}`], { encoding: 'utf8' });
    const missingStateOutFiles = await readdir(missingStateOut).catch(() => []);
    check('ends:missing-state-cli-refused', '同一份缺 `state` 的文档过 CLI：退码 3、`--out` 里一个字节都没写（导出物只有「全部正确」一种状态）',
      missingStateRun.status === 3 && missingStateOutFiles.length === 0,
      `exit=${missingStateRun.status}｜--out 里的文件：${JSON.stringify(missingStateOutFiles)}｜stderr 首行：${(missingStateRun.stderr ?? '').split('\n')[0]}`);

    // 两份「故意坏」的夹具：**保持坏**（各自那条原因还在）**并且**因为新口径多了一条拒绝原因 —— 如实断言，免得被读成回归
    const siblingReasons = [];
    for (const [file, own] of [
      ['transition-screen-unknown', 'transition-screen-unknown@transitions[0].to.screen'],
      ['transition-state-unknown', 'transition-state-unknown@transitions[0].to.state'],
    ]) {
      const doc = JSON.parse(await readFile(path.join(badDir, `${file}.json`), 'utf8'));
      const codes = validate.validateDocument(doc, { source: `fixtures/bad/${file}.json` }).errors.map((error) => `${error.code}@${error.path}`);
      siblingReasons.push({ file, codes, ok: codes.includes(own) && codes.includes('field-required@transitions[0].from') });
    }
    check('ends:sibling-bad-fixtures-get-new-reason', '两份「故意坏」的夹具**保持坏**（各自那条原因还在：指到不存在的屏 / 状态），**并且**多了一条 `field-required@transitions[0].from`（它们两端本来就没写 state）—— 是新规矩抓到了它们，不是回归',
      siblingReasons.every((item) => item.ok),
      siblingReasons.map((item) => `${item.file} → ${item.codes.join('、')}`).join(' ｜ '));
    // ③ 确定性（同进程两次）
    const htmlTimes = [designer.renderDocumentHtml(demo, { viewport: { w: 1200, h: 760 } }), designer.renderDocumentHtml(demo, { viewport: { w: 1200, h: 760 } })];
    const jsonTimes = [canonical.canonicalJson(demo), canonical.canonicalJson(demo)];
    const flowTimes = [svg.renderFlowSvg(demo), svg.renderFlowSvg(demo)];
    const screenTimes = demo.screens.map((screen) => [svg.renderScreenSvg(demo, screen.id), svg.renderScreenSvg(demo, screen.id)]);
    const stateTargets = demo.screens.flatMap((screen) => (screen.states ?? []).slice(1).filter((state) => state.root !== undefined).map((state) => ({ screen, state })));
    const stateTimes = stateTargets.map(({ screen, state }) => [svg.renderScreenSvg(demo, screen.id, { state: state.id }), svg.renderScreenSvg(demo, screen.id, { state: state.id })]);
    check('det:html', 'HTML 渲染两次逐字节相同', htmlTimes[0] === htmlTimes[1], `sha256 ${sha(htmlTimes[0]).slice(0, 12)}…（${Buffer.byteLength(htmlTimes[0])} B）`);
    check('det:json', '规范 JSON 渲染两次逐字节相同', jsonTimes[0] === jsonTimes[1], `sha256 ${sha(jsonTimes[0]).slice(0, 12)}…`);
    check('det:flow', '转移图 SVG 渲染两次逐字节相同', flowTimes[0] === flowTimes[1], `sha256 ${sha(flowTimes[0]).slice(0, 12)}…`);
    check('det:screens', '每张屏 SVG 渲染两次逐字节相同（一屏一条断言）',
      screenTimes.every(([a, b]) => a === b), screenTimes.map(([a], index) => `${demo.screens[index].id}:${sha(a).slice(0, 8)}`).join('｜'));
    check('det:states', `每个「有自己那棵树」的状态的 SVG 渲染两次逐字节相同（共 ${stateTimes.length} 个状态树）`,
      stateTimes.length > 0 && stateTimes.every(([a, b]) => a === b),
      stateTimes.length === 0 ? '这份文档里没有状态树（不合预期：demo.json 带一个）' : stateTargets.map(({ screen, state }, index) => `${screen.id}.${state.id}:${sha(stateTimes[index][0]).slice(0, 8)}`).join('｜'));
    check('states:svg-uses-state-tree', '状态 SVG 画的是**那个状态自己的树**（不是默认那棵）',
      stateTargets.every(({ screen, state }, index) => stateTimes[index][0].includes(`data-el-id="${state.root.children?.[0]?.id ?? state.root.id}"`)
        && !stateTimes[index][0].includes(`data-el-id="${screen.root.children?.[0]?.id ?? screen.root.id}"`)),
      stateTargets.map(({ screen, state }) => `${screen.id}.${state.id} → ${state.root.children?.[0]?.id ?? state.root.id}`).join('｜'));

    // ⑤c `states[0].root`：默认树以 `screens[].root` 为准 —— 给一份**两份树**的文档 ⇒ 应该有一条命名优先级的警告，而不是静默选一个
    const twoTrees = JSON.parse(demoText);
    const homeScreen = twoTrees.screens.find((screen) => screen.id === 'home');
    // 两份树要是**两棵不同的树**（id 也要各自不同，否则报的是 id-duplicate 而不是优先级警告）
    homeScreen.states[0].root = { ...JSON.parse(JSON.stringify(homeScreen.states[1].root)), id: 'home-default-copy', children: JSON.parse(JSON.stringify(homeScreen.states[1].root.children)).map((child) => ({ ...child, id: `${child.id}-copy` })) };
    const twoTreesResult = validate.validateDocument(twoTrees, { source: '(states[0].root 的副本)' });
    const precedenceWarning = twoTreesResult.warnings.find((warning) => warning.code === 'state0-root-ignored');
    check('states:state0-root-warning', '`states[0].root` 给了两份树时：不当场选用一份，而是给一条指名优先级的警告（默认状态的树是 screens[].root）',
      twoTreesResult.ok === true && precedenceWarning !== undefined,
      precedenceWarning ? precedenceWarning.message : `warnings=${JSON.stringify(twoTreesResult.warnings.map((warning) => warning.code))}`);

    // ③b 跨进程：真跑两次导出器，产物逐个 sha256 相同
    const outA = path.join(sandbox, 'a');
    const outB = path.join(sandbox, 'b');
    const runExport = (out) => spawnSync(process.execPath, [exporterPath, `--doc=${path.join(DESIGNER_ROOT, 'fixtures', 'demo.json')}`, `--out=${out}`], { encoding: 'utf8' });
    const runA = runExport(outA);
    const runB = runExport(outB);
    const filesA = runA.status === 0 ? (await readdir(outA)).sort() : [];
    const filesB = runB.status === 0 ? (await readdir(outB)).sort() : [];
    const readAll = async (dir, names) => new Map(await Promise.all(names.map(async (name) => [name, await readFile(path.join(dir, name), 'utf8')])));
    const mapA = await readAll(outA, filesA);
    const mapB = await readAll(outB, filesB);
    const sameAcrossProcesses = runA.status === 0 && runB.status === 0 && filesA.length > 0
      && JSON.stringify(filesA) === JSON.stringify(filesB)
      && filesA.every((name) => mapA.get(name) === mapB.get(name));
    check('det:cross-process', '跨进程再跑一次导出器：产物清单与**每个文件的字节**都相同', sameAcrossProcesses,
      `exit=${runA.status}/${runB.status}｜${filesA.length} 个产物：${filesA.map((name) => `${name}:${sha(mapA.get(name)).slice(0, 8)}`).join('、')}`);

    // ④ 坏文档 ⇒ 如实拒绝（库函数抛；CLI 非 0 且不写盘）
    let threw = 0;
    const badDocs = [];
    for (const badCase of BAD_CASES) {
      const doc = JSON.parse(await readFile(path.join(badDir, `${badCase.file}.json`), 'utf8'));
      badDocs.push([badCase, doc]);
      try {
        designer.renderDocumentHtml(doc, { viewport: { w: 1200, h: 760 } });
      } catch (error) {
        if (error?.name === 'DesignerInvalidDocumentError' && Array.isArray(error.errors) && error.errors.length > 0) threw += 1;
      }
    }
    check('refuse:library', '坏文档调导出器一律抛 `DesignerInvalidDocumentError`（带全部错误）—— 没有半成品字符串',
      threw === BAD_CASES.length, `${threw}/${BAD_CASES.length} 份都抛了`);
    const badOut = path.join(sandbox, 'bad-out');
    const cliRuns = BAD_CASES.map((badCase) => spawnSync(process.execPath, [exporterPath, `--doc=${path.join(badDir, `${badCase.file}.json`)}`, `--out=${badOut}`], { encoding: 'utf8' }));
    const badOutFiles = await readdir(badOut).catch(() => []);
    check('refuse:cli', `坏文档过 CLI：每一份都非 0 退出、且**盘上什么都没写**（${BAD_CASES.length} 份共用同一个 --out 目录，跑完还是空的）`,
      cliRuns.every((run) => run.status === 3) && badOutFiles.length === 0,
      `exit=${JSON.stringify(cliRuns.map((run) => run.status))}｜--out 里的文件：${JSON.stringify(badOutFiles)}`);

    // ⑤ schema 是结构与封闭集合的唯一来源
    const schema = JSON.parse(await readFile(path.join(DESIGNER_ROOT, 'schema.json'), 'utf8'));
    const danglingRefs = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
        try { validate.resolveRef(node.$ref, schema); } catch { danglingRefs.push(node.$ref); }
      }
      for (const value of Object.values(node)) walk(value);
    };
    walk(schema);
    check('schema:refs', 'schema.json 里每个 $ref 都能解析（悬空引用是静默的坏）',
      danglingRefs.length === 0, `dangling=${JSON.stringify(danglingRefs)}｜$schema=${schema.$schema}`);
    check('schema:vocab', '校验器报错里那个「允许的集合」== schema.json 里的枚举（逐字）',
      validate.VOCAB.elementTypes.join(',') === schema.$defs.element.properties.type.enum.join(',')
      && validate.VOCAB.layoutModes.join(',') === schema.$defs.element.properties.layout.properties.mode.enum.join(','),
      `types=${validate.VOCAB.elementTypes.join('|')}`);
    const arrowDoc = JSON.parse(await readFile(path.join(badDir, 'arrow-type.json'), 'utf8'));
    const arrowResult = validate.validateDocument(arrowDoc, { source: 'fixtures/bad/arrow-type.json' });
    const arrowError = arrowResult.errors.find((error) => error.code === 'type-unknown');
    check('schema:closed-set', '一份 `type:"arrow"` 的文档必须被拒（**箭头只能由 transitions 生成**），且报错里那个集合就是 schema 的 type 枚举 —— 把 schema 副本的枚举加一个 arrow，这条就该红',
      arrowResult.ok === false && arrowError !== undefined && validate.VOCAB.elementTypes.every((type) => arrowError.message.includes(type)),
      arrowError ? arrowError.message : JSON.stringify(arrowResult.errors.map((error) => `${error.code}@${error.path}`)));

    // ⑤b diff：语义 diff 说得清「哪个元素、哪个字段」，而且导出物新鲜度可判
    const edited = JSON.parse(demoText);
    edited.screens.find((screen) => screen.id === 'home').root.children.find((child) => child.id === 'home-card').box.w = 161;
    const d = diff.semanticDiff(demo, edited);
    check('diff:semantic', '改一个元素的 box.w ⇒ diff 只报那一处（按 id 对齐，不是按行）',
      d.changes.length === 1 && d.changes[0].path === 'screens.home.home-card.box.w' && d.changes[0].before === 160 && d.changes[0].after === 161,
      JSON.stringify(d.changes));
    const fresh = diff.checkExportFreshness(demo, htmlTimes[0], 'demo.html');
    const stale = diff.checkExportFreshness(edited, htmlTimes[0], 'demo.html');
    check('diff:freshness', '导出物里嵌的摘要：拿当前文档比 ⇒ fresh；拿改过一个数的文档比 ⇒ **stale**（这条就是「导出物是不是旧的」那把闸）',
      fresh.ok === true && stale.ok === false && stale.code === 'export-stale',
      `fresh=${fresh.ok}｜stale=${stale.ok}(${stale.code})：${stale.message}`);

    // ── ⑥ 组件 / 变体 / 实例 / 逐实例覆盖 ＋ 单边边框（Figma 的 component·variant·instance·override）────
    // 这一组的样本是 `fixtures/components.json`（合法）；行为在**摊平器**（`designer/expand.mjs`）
    // 与两个渲染器里，所以这里直接调它们，逐项断言“选哪个变体、谁盖谁、id 怎么重发”。
    const componentsDoc = JSON.parse(await readFile(path.join(DESIGNER_ROOT, 'fixtures', 'components.json'), 'utf8'));
    const expanded = expand.expandTree(componentsDoc.screens[0].root, componentsDoc);
    const instOk = expanded.children.find((child) => child.id === 'inst-ok');
    const instRun = expanded.children.find((child) => child.id === 'inst-run');
    check('components:variant-applied', '实例选哪个变体，摊平后就长那个变体（单边槽色 = 该变体 override 里的 token）',
      instOk?.style?.border?.left?.color === 'var(--slot-success)' && instRun?.style?.border?.left?.color === 'var(--slot-pending)',
      `inst-ok 左边=${JSON.stringify(instOk?.style?.border?.left?.color)} / inst-run 左边=${JSON.stringify(instRun?.style?.border?.left?.color)}`);
    check('components:instance-override-wins', '同一元素同一字段，**逐实例覆盖盖在变体之上**（实例赢）',
      instOk?.children?.[1]?.text === '$ node designer/validate.mjs main-screen.json' && instOk?.children?.[0]?.text === '工具 · 完成',
      JSON.stringify(instOk?.children?.map((child) => child.text)));
    check('components:rekey-unique', '子元素 id = `${实例 id}/${组件里的 id}` —— 确定性、两个实例互不撞',
      JSON.stringify([instOk?.children?.map((child) => child.id), instRun?.children?.map((child) => child.id)])
        === JSON.stringify([['inst-ok/tc-meta', 'inst-ok/tc-line'], ['inst-run/tc-meta', 'inst-run/tc-line']]),
      JSON.stringify([instOk?.children?.map((child) => child.id), instRun?.children?.map((child) => child.id)]));
    const expandedAgain = expand.expandTree(componentsDoc.screens[0].root, componentsDoc);
    check('components:expand-deterministic', '同一份文档摊平两次 ⇒ 逐字节相同（摊平是纯函数）',
      JSON.stringify(expanded) === JSON.stringify(expandedAgain), `sha256 ${sha(JSON.stringify(expanded)).slice(0, 12)}…（${Buffer.byteLength(JSON.stringify(expanded))} B）`);

    const borderHtml = designer.renderDocumentHtml(componentsDoc, { viewport: { w: 300, h: 200 } });
    check('border:html-edges', '单边边框落到 HTML：**四边都显式给宽**（没写的那条不许落到 CSS 初始值 medium 而多出一条边），左边 3px 走变体 token',
      borderHtml.includes('border-left-width:3px') && borderHtml.includes('border-left-color:var(--slot-success)')
      && borderHtml.includes('border-top-width:1px') && borderHtml.includes('border-right-width:1px') && borderHtml.includes('border-bottom-width:1px')
      && /border-(top|right|bottom)-color:var\(--line\)/.test(borderHtml),
      borderHtml.split('\n').find((line) => line.includes('border-left-width')) ?? '(没找到那条规则)');
    const borderSvg = svg.renderScreenSvg(componentsDoc, 'main', { viewport: { w: 300, h: 200 } });
    const leftEdges = [...borderSvg.matchAll(/<rect class="designer-border"[^>]*data-el-border-side="left"[^>]*>/g)].map((match) => match[0]);
    check('border:svg-edges', '单边边框落到 SVG：两个实例各画一条左边（3px、色 = 各自变体的 token），且**不再画旧 stroke**',
      leftEdges.length === 2 && leftEdges.every((line) => /width="3"/.test(line))
      && leftEdges.some((line) => line.includes('fill="#7bc47f"')) && leftEdges.some((line) => line.includes('fill="#7f9baf"'))
      && !/stroke-width="3"/.test(borderSvg),
      leftEdges.join(' ｜ ') || '(一条左边都没画)');
    check('border:legacy-untouched', '**没有**新字段的旧文档一个字节没变：`borderWidth` 仍写 HTML 的 `border-width:Npx`、SVG 仍画 `stroke-width`（不画逐边 rect）',
      htmlTimes[0].includes('border-width:1px') && !htmlTimes[0].includes('border-left-width')
      && svg.renderScreenSvg(demo, 'home', { viewport: { w: 1200, h: 760 } }).includes('stroke-width="1"')
      && !svg.renderScreenSvg(demo, 'home', { viewport: { w: 1200, h: 760 } }).includes('designer-border'),
      `demo.html 含 border-width:1px=${htmlTimes[0].includes('border-width:1px')}、含 border-left-width=${htmlTimes[0].includes('border-left-width')}`);

    process.stdout.write(`\n──── 坏文档的报错逐字（给报告用）────\n${reportLines.join('\n')}\n`);
    process.stdout.write(`\n──── test/designer-model.mjs：${failures.length === 0 ? '全部绿' : `${failures.length} 条红`} ────\n`);
    if (failures.length > 0) process.stdout.write(`红的：${JSON.stringify(failures)}\n`);
  } catch (error) {
    primaryError = error;
    process.stderr.write(`主错误：${error.stack ?? error.message}\n`);
  } finally {
    await removeSandbox(sandbox, problems, 'designer-model 沙箱');
    for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
    // ⚠️ 只有在**没有主错误**的时候才允许打 PASS：早先的写法会在“抛了错”时照样打出 RESULT PASS
    // （failures 数组是空的，但真正失败的是一场异常）—— 那是假绿，本门自己先不允许。
    if (!primaryError && failures.length === 0 && problems.length === 0) process.stdout.write('RESULT: designer model PASS\n');
    process.exitCode = primaryError || failures.length > 0 || problems.length > 0 ? 1 : 0;
  }
}
