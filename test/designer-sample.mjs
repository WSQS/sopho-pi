#!/usr/bin/env node
// test/designer-sample.mjs —— **「一份设计只能有一个 json 真源」**那道门（样例：`design/samples/two-pane/`）。
//
// 为什么要有它（业主 2026-09-26 的决定，逐字）：
//   「整理一下现在生成的页面，现在是拆分成了 3 个 json 但是我们的软件应该由**一个统一的 json** 来管理」。
//   拆开之后**那张转移图就不完整了**：3 屏之间的 4 条转移只活在其中一个文件里，另两份各自 `transitions: []`
//   —— 于是「哪一屏去得了哪一屏」这件事**按屏拆开就没了**。
//
// 它钉住的事实（每条都能复跑；红了能直接指到文件与数）：
//   ① `main-screen.json` 是**唯一那份设计文档**，且合法；
//   ② live 集合（样例根下**除 `attempts/` 之外**的一切）里，**每一份**带元素树的 `.json` 都与它**逐字节同源**
//      —— 这正好把「按屏拆出来的文档」和「忘了删的旧导出」都判红（它们的屏集/转移集与真源不同）；
//      `screens/` 这个目录不许存在（per-screen json 的落点已经删掉）；
//   ③ 转移**端到端成立**：每一端都写全 `{screen, state}`、都能指到存在的屏与状态；多屏设计里
//      **每一屏都至少是一条转移的一端**（「全部屏都能从 `screens[0]` 走到」）—— 转移被丢掉时这条必红；
//   ④ 箭头**只由数据来**：真源渲染出的转移图里 `designer-arrow` 的根数 == `transitions` 条数，
//      且**盘上那份 `generated/main-screen.flow.svg` 与刚渲染的逐字节相同**（不许陈旧）；
//   ⑤ **真源能由它的构建模块原样复现**：`merge.mjs` 的 `composeDocument()` 的规范字节 == 盘上那份，
//      而且它自己合法。⚠️ 这条是**真的抓到过东西的**：2026-09-28 之前 `merge.mjs` 的 `TRANSITIONS`
//      少了 `state`（`5b92eb0` 只手工补了产物、没补构建器）⇒ 跑一次 `node merge.mjs` 会**覆盖真源**成一份
//      **不合法**的文档（8 条 `field-required`）。以前没有任何门看这一格。
//   ⑥ 导出物与视图都是**新鲜**的：`generated/main-screen.{json,html,flow.svg,screen.*.svg}` 逐个逐字节
//      等于刚渲染的；每屏一份的 HTML 视图（`views.mjs` 派生）同理；
//   ⑦ **没有「拿 json 当输入」的陈旧线**：live 的 `.mjs` 里不许再出现 `screens/**.json` 或
//      `attempts/main-screen.buttons-only.json`（那是旧流水线的中间件；它现在是历史存档，**没有读者**）。
//
// 用法：
//   node test/designer-sample.mjs                                  # 查真样例
//   node test/designer-sample.mjs --sample-root=<目录>              # 换一棵样例树（反证臂用）
//   node test/designer-sample.mjs --reverse-arm=split              # 反证臂：把真源按屏拆成三份 ⇒ 必红
//   node test/designer-sample.mjs --reverse-arm=stale-generator    # 反证臂：构建器少写 `state` ⇒ 必红
//
// 出口：0 = 全绿（选了臂则臂也红到位）；1 = 有红 / 臂没红到位；2 = 参数不认识。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { removeSandboxConverged } from './harness.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const here = path.dirname(THIS_FILE);
const root = path.resolve(here, '..');
const DESIGNER_ROOT = path.join(root, 'designer');
const argOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const ARM = argOf('reverse-arm');
const SAMPLE_ROOT = path.resolve(argOf('sample-root') || process.env.SOPHO_DESIGNER_SAMPLE_ROOT || path.join(root, 'design', 'samples', 'two-pane'));
const VIEWPORT = { w: 1440, h: 900 };

const failures = [];
const problems = [];
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
function check(id, name, ok, detail) {
  process.stdout.write(`${ok ? '✓' : '✗'} [${id}] ${name} —— ${detail}\n`);
  if (!ok) failures.push(id);
  return ok;
}

// ── 反证臂 ────────────────────────────────────────────────────────────────────────────────────
// 臂改的是**副本**：整棵样例树拷到 `design/samples/.sopho-sample-arm-<随机>/`（**必须是这个深度** ——
// 构建模块里的相对导入是 `../../../designer/...`，仓外或别的深度都解析不到）。真样例一个字节不动。
const ARM_SPECS = {
  split: {
    why: '把真源按屏拆成三份（`screens/settings.json`、`screens/questions.json` ＋ 只留 main 的 `main-screen.json`），'
      + '并把两份 per-screen 文档导出到 `generated/` —— 就是业主点名的那个「三个各自完整的 json」的样子',
    expectRed: ['live:one-document', 'live:no-per-screen-json', 'fresh:source-reproducible', 'fresh:export-set', 'docs:transitions-connect-every-screen'],
    async mutate(dest) {
      const sourceFile = path.join(dest, 'main-screen.json');
      const source = JSON.parse(await readFile(sourceFile, 'utf8'));
      const screensDir = path.join(dest, 'screens');
      await mkdir(screensDir, { recursive: true });
      const keep = source.screens[0];
      for (const screen of source.screens.slice(1)) {
        const doc = {
          $schema: source.$schema, version: source.version,
          name: `${screen.name}（按屏拆出来的那份文档）`,
          tokens: source.tokens, screens: [screen], transitions: [],
        };
        const text = `${JSON.stringify(doc, null, 2)}\n`;
        await writeFile(path.join(screensDir, `${screen.id}.json`), text, 'utf8');
        await writeFile(path.join(dest, 'generated', `${screen.id}.json`), text, 'utf8');
      }
      const mainOnly = {
        $schema: source.$schema, version: source.version,
        name: `${keep.name}（按屏拆出来的那份文档）`,
        tokens: source.tokens, screens: [keep], transitions: [],
      };
      const mainText = `${JSON.stringify(mainOnly, null, 2)}\n`;
      await writeFile(sourceFile, mainText, 'utf8');
      await writeFile(path.join(dest, 'generated', 'main-screen.json'), mainText, 'utf8');
    },
  },
  'stale-generator': {
    why: '把构建器 `merge.mjs` 的 TRANSITIONS 里每一端的 `state` 删掉（= 2026-09-28 之前真仓库里那个状态：'
      + '产物被手工补过、构建器没有）⇒ 由它「复现」出来的真源与盘上那份不同、而且本身不合法',
    expectRed: ['fresh:source-reproducible', 'fresh:composed-valid'],
    async mutate(dest) {
      const file = path.join(dest, 'merge.mjs');
      const text = await readFile(file, 'utf8');
      // ⚠️ 2026-09-27：`TRANSITIONS` 那两行的 `from` 形状变过一次（起点锚那一单先内联、后又收回表里
      // ⇒ 字面量**回到原样**：`from: { screen: 'main', state: 'default' }`）⇒ 删 `state` 的锚点用**正则**
      // （只认 `from: { screen: 'main', state: 'default' }` 这个形状，不吃字面量里的其它改动），
      // 不写死整行原文 —— 否则字面量形状一变这条臂就自己变成「找不到原文的抛错」，那是假红。
      const mutated = text.replace(/from: \{ screen: 'main', state: 'default' \}/g, "from: { screen: 'main' }");
      if (mutated === text) throw new Error('反证臂 stale-generator：在 merge.mjs 里没找到可替换的 TRANSITIONS 原文');
      await writeFile(file, mutated, 'utf8');
    },
  },
};

if (ARM && !ARM_SPECS[ARM]) {
  process.stderr.write(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_SPECS).join(', ')}）\n`);
  process.exit(2);
}

// ── 工具 ──────────────────────────────────────────────────────────────────────────────────────
const exists = async (target) => (await stat(target).catch(() => null)) !== null;

/** live 集合里的所有 `.json`（**排除 `attempts/`** —— 那是历史/探针归档，不是这份设计的真源）。 */
async function liveJsonFiles(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'attempts') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await liveJsonFiles(full, base, out);
    else if (entry.name.endsWith('.json')) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** live 的 `.mjs`（样例根一层）。 */
const liveScripts = async () => (await readdir(SAMPLE_ROOT)).filter((name) => name.endsWith('.mjs'));

const isDocument = (value) => value !== null && typeof value === 'object' && Array.isArray(value.screens) && typeof value.version === 'string';
/** 「带着一棵元素树」：文档，或一份裸的屏（`{id, root}`）—— 按屏拆出来的中间件两种形态都算。 */
const hasElementTree = (value) => isDocument(value) || (value !== null && typeof value === 'object' && value.root !== null && typeof value.root === 'object' && typeof value.id === 'string');

/** 屏的可达性（把转移当无向边）：从 `screens[0]` 出发能走到几屏。 */
function reachableScreens(doc) {
  const ids = doc.screens.map((screen) => screen.id);
  const seen = new Set([ids[0]]);
  const queue = [ids[0]];
  while (queue.length) {
    const current = queue.shift();
    for (const transition of doc.transitions ?? []) {
      for (const [a, b] of [[transition.from?.screen, transition.to?.screen], [transition.to?.screen, transition.from?.screen]]) {
        if (a === current && ids.includes(b) && !seen.has(b)) { seen.add(b); queue.push(b); }
      }
    }
  }
  return { seen, ids };
}

async function runChecks() {
  const canonical = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'canonical.mjs')).href);
  const { validateDocument } = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'validate.mjs')).href);
  const toHtml = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toHtml.mjs')).href);
  const toSvg = await import(pathToFileURL(path.join(DESIGNER_ROOT, 'toSvg.mjs')).href);

  const sourceFile = path.join(SAMPLE_ROOT, 'main-screen.json');
  const sourceText = await readFile(sourceFile, 'utf8').catch(() => null);
  if (sourceText === null) {
    check('source:exists', `真源 ${path.relative(root, sourceFile)} 存在`, false, '读不到');
    return;
  }
  const source = JSON.parse(sourceText);
  const sourceCanonical = canonical.canonicalJson(source);
  check('source:exists', `真源 ${path.relative(root, sourceFile)} 存在且是规范字节`,
    sourceText === sourceCanonical,
    `${Buffer.byteLength(sourceText)} B｜sha256 ${sha(sourceText).slice(0, 16)}…${sourceText === sourceCanonical ? '（== 规范字节）' : '（⚠️ 不是规范字节）'}`);

  // ① 合法
  const report = validateDocument(source, { source: path.relative(root, sourceFile).split(path.sep).join('/') });
  check('source:valid', '真源通过校验（0 个错）', report.ok,
    `${report.errors.length} 错 / ${report.warnings.length} 警告${report.errors.length ? `：${report.errors.map((error) => `${error.code}@${error.path}`).join(', ')}` : ''}`);

  // ② live 集合里每一份「带元素树」的 json 都与真源同源
  const jsonFiles = await liveJsonFiles(SAMPLE_ROOT);
  const foreign = [];
  const treeCarriers = [];
  for (const relative of jsonFiles) {
    const text = await readFile(path.join(SAMPLE_ROOT, relative), 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { continue; }
    if (!hasElementTree(parsed)) continue;
    treeCarriers.push(relative);
    if (text !== sourceCanonical) {
      foreign.push(`${relative}（屏 ${JSON.stringify((parsed.screens ?? [parsed]).map((item) => item?.id ?? '?'))}、转移 ${(parsed.transitions ?? []).length} 条）`);
    }
  }
  check('live:one-document', 'live 集合（除 attempts/）里**每一份带元素树的 `.json`** 都与真源逐字节同源 —— 一份设计只有一个 json 内容',
    foreign.length === 0,
    foreign.length === 0
      ? `${treeCarriers.length} 份带树的 json，全部 == 真源：${treeCarriers.join('、')}`
      : `有 ${foreign.length} 份与真源不同（**按屏拆开就会是这样：屏集与转移集都被切开**）：${foreign.join('；')}`);

  const screensDirExists = await exists(path.join(SAMPLE_ROOT, 'screens'));
  const perScreen = jsonFiles.filter((relative) => relative.startsWith('screens/'));
  check('live:no-per-screen-json', '`screens/` 目录不存在、也没有任何 `screens/**.json`（per-screen json 的落点已删掉）',
    !screensDirExists && perScreen.length === 0,
    `screens/ 目录：${screensDirExists ? '在' : '不在'}｜screens/**.json：${JSON.stringify(perScreen)}`);

  check('live:single-json-per-design', 'live 集合里的 `.json` 恰好是「真源 ＋ 它的规范导出」两份',
    JSON.stringify(jsonFiles) === JSON.stringify(['generated/main-screen.json', 'main-screen.json']),
    `实际：${JSON.stringify(jsonFiles)}`);

  // ③ 转移端到端成立；多屏设计里每屏都连着
  const ends = (source.transitions ?? []).flatMap((transition, index) => ['from', 'to'].map((end) => ({ index, end, value: transition?.[end] })));
  const badEnds = ends.filter(({ value }) => value === null || typeof value !== 'object' || typeof value.screen !== 'string' || typeof value.state !== 'string');
  const stateIds = new Map((source.screens ?? []).map((screen) => [screen.id, (screen.states ?? []).map((state) => state.id)]));
  const dangling = ends.filter(({ value }) => value && typeof value === 'object' && (!stateIds.has(value.screen) || !stateIds.get(value.screen).includes(value.state)));
  check('docs:transitions-ends', `每一条转移的**两端**都写全 {screen, state} 且指到存在的屏与状态（${(source.transitions ?? []).length} 条 / ${ends.length} 端）`,
    ends.length > 0 && badEnds.length === 0 && dangling.length === 0,
    `缺 screen/state 的端：${JSON.stringify(badEnds.map(({ index, end }) => `transitions[${index}].${end}`))}｜`
    + `指不到东西的端：${JSON.stringify(dangling.map(({ index, end, value }) => `transitions[${index}].${end} → ${value.screen}/${value.state}`))}｜`
    + `屏与状态：${JSON.stringify([...stateIds].map(([id, states]) => `${id}:[${states.join(',')}]`))}`);

  const { seen, ids } = reachableScreens(source);
  const isolated = ids.filter((id) => !seen.has(id));
  check('docs:transitions-connect-every-screen', `多屏设计里**每一屏都至少是一条转移的一端**（从 ${ids[0]} 顺着转移能走到全部 ${ids.length} 屏）`,
    ids.length >= 2 && isolated.length === 0,
    `屏 ${JSON.stringify(ids)}｜从 ${ids[0]} 走得到：${JSON.stringify([...seen])}｜走不到的：${JSON.stringify(isolated)}`);

  // ④ 箭头只由数据来；盘上那份不许陈旧
  const freshFlow = toSvg.renderFlowSvg(source, { source: 'main-screen.json' });
  const arrowCount = [...freshFlow.matchAll(/class="designer-arrow"/g)].length;
  check('arrows:only-from-data', `转移图里 \`designer-arrow\` 的根数 == transitions 条数（${(source.transitions ?? []).length} ⇔ ${arrowCount}）`,
    arrowCount === (source.transitions ?? []).length,
    `箭头 ${arrowCount} 根 / 转移 ${(source.transitions ?? []).length} 条`);

  // ⑤ 真源能由构建模块原样复现（而且它自己合法）
  const merge = await import(pathToFileURL(path.join(SAMPLE_ROOT, 'merge.mjs')).href);
  let composed = null;
  let composedError = null;
  try {
    composed = await merge.composeDocument();
  } catch (error) {
    composedError = error;
  }
  const composedCanonical = composed === null ? null : canonical.canonicalJson(composed);
  const composedReport = composed === null
    ? { ok: false, errors: [{ code: 'compose-threw', path: '(composeDocument())', message: composedError?.message ?? '' }] }
    : validateDocument(composed, { source: '(composeDocument() 的结果)' });
  check('fresh:composed-valid', '构建模块组装出来的那份文档自己合法（0 个错）', composedReport.ok,
    composed === null
      ? `组装直接抛了：${composedError?.message}`
      : `${composedReport.errors.length} 错${composedReport.errors.length ? `：${composedReport.errors.map((error) => `${error.code}@${error.path}`).join(', ')}` : ''}`);
  check('fresh:source-reproducible', '盘上那份真源 == 构建模块刚组装出来的（**逐字节**）—— 生成器与真源不许各说各话',
    composedCanonical === sourceText,
    composedCanonical === sourceText
      ? `两边都是 ${Buffer.byteLength(sourceText)} B、sha256 ${sha(sourceText).slice(0, 16)}…`
      : `盘上 ${Buffer.byteLength(sourceText)} B sha256 ${sha(sourceText).slice(0, 16)}… / 刚组装 ${composedCanonical === null ? '(抛了)' : `${Buffer.byteLength(composedCanonical)} B sha256 ${sha(composedCanonical).slice(0, 16)}…`}`);

  // ⑥ 导出物与视图新鲜
  const expected = new Map([
    ['main-screen.json', toHtml.renderDocumentJson(source, { source: 'main-screen.json' })],
    ['main-screen.html', toHtml.renderDocumentHtml(source, { viewport: VIEWPORT, source: 'main-screen.json' })],
    ['main-screen.flow.svg', freshFlow],
  ]);
  for (const screen of source.screens) {
    expected.set(`main-screen.screen.${screen.id}.svg`, toSvg.renderScreenSvg(source, screen.id, { viewport: VIEWPORT, source: 'main-screen.json' }));
    for (const state of (screen.states ?? []).slice(1)) {
      if (state.root === undefined) continue;
      expected.set(`main-screen.screen.${screen.id}.${state.id}.svg`, toSvg.renderScreenSvg(source, screen.id, { viewport: VIEWPORT, state: state.id, source: 'main-screen.json' }));
    }
  }
  const generatedDir = path.join(SAMPLE_ROOT, 'generated');
  // ⚠️ 只比**导出器该产的那几种**（`.json`/`.html`/`.svg`）。PNG 不在导出器里（纯 Node 不光栅化；
  //    `main-screen.png` 由真 Chromium 在 `shoot.mjs` 里截）⇒ 其余 `main-screen.*` 不参与集合比较。
  const onDiskExports = (await readdir(generatedDir))
    .filter((name) => name.startsWith('main-screen.') && /\.(json|html|svg)$/.test(name))
    .sort();
  const staleExports = [];
  for (const [name, text] of expected) {
    const onDisk = await readFile(path.join(generatedDir, name), 'utf8').catch(() => null);
    if (onDisk !== text) staleExports.push(`${name}（${onDisk === null ? '盘上没有' : `${Buffer.byteLength(onDisk)} B vs ${Buffer.byteLength(text)} B`}）`);
  }
  const setOk = JSON.stringify(onDiskExports) === JSON.stringify([...expected.keys()].sort());
  check('fresh:export-set', '`generated/main-screen.*` 的文件集合与字节**逐个**等于刚渲染的（不多、不少、不旧）',
    setOk && staleExports.length === 0,
    `盘上 ${JSON.stringify(onDiskExports)} / 期望 ${JSON.stringify([...expected.keys()].sort())}${staleExports.length ? `｜陈旧：${staleExports.join('、')}` : ''}`);

  const views = await import(pathToFileURL(path.join(SAMPLE_ROOT, 'views.mjs')).href);
  let viewFiles = new Map();
  let viewError = null;
  try {
    viewFiles = views.renderViewFiles(source);
  } catch (error) {
    viewError = error;
  }
  const staleViews = [];
  for (const [name, text] of viewFiles) {
    const onDisk = await readFile(path.join(generatedDir, name), 'utf8').catch(() => null);
    if (onDisk !== text) staleViews.push(`${name}（${onDisk === null ? '盘上没有' : '字节不同'}）`);
  }
  check('fresh:views', `每屏一份的**派生视图**（${[...viewFiles.keys()].join('、') || '（派生不出来）'}）== 从真源刚派生出来的（只出 .html，不出 .json）`,
    viewError === null && viewFiles.size > 0 && staleViews.length === 0,
    viewError !== null
      ? `从这份真源派生视图直接抛了：${viewError.message}（真源里得有 ${views.VIEW_SCREEN_IDS.join('、')} 这几屏）`
      : staleViews.length === 0 ? `${viewFiles.size} 份全新鲜` : `陈旧：${staleViews.join('、')}`);

  // ⑦ 没有「拿 json 当输入」的陈旧线
  const staleInputs = [];
  for (const name of await liveScripts()) {
    const text = await readFile(path.join(SAMPLE_ROOT, name), 'utf8');
    for (const needle of ['screens/', 'main-screen.buttons-only.json']) {
      if (text.includes(needle) && text.split('\n').some((line) => !/^\s*(\/\/|\*)/.test(line) && line.includes(needle))) {
        staleInputs.push(`${name} 里的代码行引用了 ${needle}`);
      }
    }
  }
  check('live:no-stale-input', 'live 的 `.mjs` 代码里不再引用 `screens/` 或 `attempts/main-screen.buttons-only.json`（旧流水线的中间件）',
    staleInputs.length === 0, staleInputs.length === 0 ? '一处都没有' : staleInputs.join('；'));
}

// ── 跑 ────────────────────────────────────────────────────────────────────────────────────────
if (!ARM) {
  await runChecks();
  process.stdout.write(`\n──── test/designer-sample.mjs：${failures.length === 0 ? '全部绿' : `${failures.length} 条红`} ────\n`);
  if (failures.length > 0) process.stdout.write(`红的：${JSON.stringify(failures)}\n`);
  for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
  process.exitCode = failures.length === 0 && problems.length === 0 ? 0 : 1;
} else {
  const spec = ARM_SPECS[ARM];
  // ⚠️ 副本必须落在 `design/samples/<名字>/` 这个深度：构建模块里的相对导入是 `../../../designer/...`。
  const dest = await mkdtemp(path.join(root, 'design', 'samples', '.sopho-sample-arm-'));
  process.stdout.write(`反证臂 ${ARM}：${spec.why}\n  副本（真样例一个字节不动）：${path.relative(root, dest)}\n`);
  let child = null;
  try {
    await cp(SAMPLE_ROOT, dest, { recursive: true });
    await spec.mutate(dest);
    child = spawnSync(process.execPath, [THIS_FILE, `--sample-root=${dest}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, SOPHO_DESIGNER_SAMPLE_ROOT: dest },
    });
    const redIds = [...(child.stdout ?? '').matchAll(/^✗ \[([^\]]+)\]/gm)].map((match) => match[1]);
    const missing = spec.expectRed.filter((id) => !redIds.includes(id));
    const redLines = (child.stdout ?? '').split('\n').filter((line) => line.startsWith('✗'));
    process.stdout.write(`\n──── 反证臂 ${ARM}：预期红 ${JSON.stringify(spec.expectRed)} / 实际红 ${JSON.stringify(redIds)}（子进程 exit=${child.status}）────\n`);
    for (const id of spec.expectRed) process.stdout.write(`  ${redIds.includes(id) ? '红' : '没红'}：[${id}]\n`);
    process.stdout.write(`\n子进程里那些红**逐字**长这样（报告要原文）：\n${redLines.map((line) => `  ${line}`).join('\n')}\n`);
    const ok = child.status !== 0 && missing.length === 0;
    process.stdout.write(ok
      ? `✓ 反证臂 ${ARM} 红到位（真样例一个字节没动）\n`
      : `✗ 反证臂 ${ARM} **没红到位**：缺 ${JSON.stringify(missing)}（子进程 exit=${child.status}）⇒ 这道门是个假门\n`);
    if (!ok) process.stdout.write(`${(child.stdout ?? '').split('\n').filter((line) => line.startsWith('✗')).join('\n')}\n`);
    process.stderr.write(child.stderr ?? '');
    process.exitCode = ok ? 0 : 1;
  } finally {
    const result = await removeSandboxConverged(dest, { label: `designer-sample 反证臂 ${ARM} 副本` });
    for (const problem of result.problems) problems.push(problem);
    if (result.remaining) problems.push(`反证臂副本 ${dest} 删了 ${result.passes} 遍仍在盘上`);
    if (problems.length > 0) process.stdout.write(`cleanup problems (secondary): ${problems.join('; ')}\n`);
    if (process.exitCode === 0 && problems.length > 0) process.exitCode = 1;
  }
}
