#!/usr/bin/env node
// command-tag-honesty.mjs —— M-05 事故的机械防线（`docs/tui-parity.md` 的 G2）。
//
// 事故形状：命令面板里那条「我们承认缺口」的台账，写着 `export: { tag: '点「快照」' }`，
// 而 `web/**` 里**根本没有**那个按钮（只有 `web/app.js` 的一句注释提到「快照」）。
// 台账自己撒谎，且没有任何东西会因此变红。
//
// 这道门把「谁替代了这条命令」变成**可机械核实**的断言，四件事：
//   A. tag 不许是自由文本：只能取 `TAG_KINDS` 里登记过的稳定话术；
//      claimsUi=true 的话术必须给 uiEntry，claimsUi=false 的**必须不给**（不许自相矛盾）。
//   B. 声称指 UI 的，uiEntry 必须在 `UI_ENTRIES` 里登记，且那条登记的「文件 + 原文片段」
//      在提交树里**真的找得到**（这是「不许再撒一次谎」的那一步）。
//   C. 不指 UI 的条目，文案里也不许出现「点「X」」这种 UI 指认（自由文本同样是撒谎面）。
//   D. 反向漂移：提交树里**已经**出现了导出/快照入口的引用，台账却还写「无网页入口」⇒ 红
//      （把 export 的 tag/uiEntry/UI_ENTRIES 一起翻正才算对账；失败信息里给了照抄的配方）。
//
// 另附 G1（同一份台账的另一面）：pi 的 `BUILTIN_SLASH_COMMANDS` 里**每一个**命令名
// 都必须在 `WEB_BUILTINS ∪ BUILTIN_ELSEWHERE` 里被**显式**分类；两边任一侧多出名字都红
// （pi 升版新增内置命令 ⇒ 门红，这正是设计目的）。
//
// ── 判据钉的是**提交树**（`git show HEAD:<file>`），不是工作区 ─────────────────────────
// 为什么：本仓的 landing 常常并行改 `web/**`（同一个 repo 的多个 worktree），**未提交**的
// 前端改动不该让这道门红；但它一旦提交进 HEAD，台账就必须翻正。工作区里的漂移仍然会**打印**
// 出来（note，不是失败），免得本地看不见。拿不到 git（不是仓库/没有 git）时退回读工作区，
// 并把模式打印出来 —— 结论里必须能看出这次判的是哪一份。
//
// 误报风险（报告里也要写清）：
//   · `UI_ENTRIES` 钉的是**原文片段**（`id="tree"`）。前端改 id / 只改写法 ⇒ 门红。
//     这是故意的：那是「入口还在不在」的判据，红了就该有人来看一眼并更新登记。
//   · pi 换了 `dist/core/slash-commands.js` 的路径/导出形状 ⇒ 门红（读不到权威表）。
//     这种情况**也应该红**：那时命令面板同样在骗人。
//   · 反向漂移（D）在前端 landing **提交**导出链接时会红 —— 那是要人对账，不是误报
//     （照失败信息里的配方改三行即可）。
//
// 跑法：npm run test:commandtags（静态断言，不起任何进程、不碰真 profile）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUILTIN_ELSEWHERE,
  DEFAULT_UNAVAILABLE_BUILTIN,
  TAG_KINDS,
  UI_ENTRIES,
  WEB_BUILTINS,
} from '../server/base-logic.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

/** 自由文本里的 UI 指认（「点「X」」「看「Y」」「用＋「Z」」）—— tag 是话术，reason 是自由文本。 */
const UI_CLAIM_IN_TEXT = /(?:点|按|看|用)[\s＋+]*[「『]/;

/** 导出口在网页里的痕迹：`<a href="/api/sessions/<id>/export">` 或 JS 里 setAttribute 的那种。 */
const EXPORT_REFERENCE = /(?:href|src)\s*=\s*[`"'][^`"']*\/export\b|\/sessions\/\$\{[^}]*\}\/export/;

/** 每条条目的统一形状：`{ name, tag, reason, uiEntry }`。 */
function ledgerEntries() {
  const named = Object.entries(BUILTIN_ELSEWHERE).map(([name, entry]) => ({ name, ...entry }));
  return [...named, { name: '(默认：未分类内置命令)', ...DEFAULT_UNAVAILABLE_BUILTIN }];
}

// ── 提交树读取（判据；见文件头「判据钉的是提交树」） ─────────────────────────────────
const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

/** 返回 `{ mode, files: Map<相对路径, 文件内容> }`。 */
async function webSources() {
  const listed = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'web']);
  const names = listed.status === 0 && typeof listed.stdout === 'string'
    ? listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  if (names.length > 0) {
    const files = new Map();
    for (const name of names) {
      const shown = git(['show', `HEAD:${name}`]);
      if (shown.status !== 0) continue;
      files.set(name, shown.stdout);
    }
    if (files.size > 0) return { mode: 'HEAD', files };
  }
  // 退回工作区（不是 git 仓库 / git 不可用 / HEAD 里没有 web/）。
  const files = new Map();
  const visit = async (dir) => {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, dirent.name);
      if (dirent.isDirectory()) await visit(target);
      else if (/\.(?:html|js|mjs|css)$/.test(dirent.name)) {
        files.set(path.relative(root, target).split(path.sep).join('/'), await readFile(target, 'utf8'));
      }
    }
  };
  await visit(path.join(root, 'web')).catch(() => {});
  return { mode: 'working-tree (git unavailable or HEAD has no web/)', files };
}

/** pi 的权威内置命令表（与 `server/base-logic.mjs` 的 builtinCommands() 同一条两级 fallback）。 */
async function piBuiltinCommands() {
  try {
    const rootModule = await import(PI_PACKAGE);
    if (Array.isArray(rootModule.BUILTIN_SLASH_COMMANDS)) return { commands: rootModule.BUILTIN_SLASH_COMMANDS, how: 'package-root' };
  } catch {}
  const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE))));
  const file = path.join(packageRoot, 'dist', 'core', 'slash-commands.js');
  const module = await import(pathToFileURL(file).href);
  if (!Array.isArray(module.BUILTIN_SLASH_COMMANDS)) throw new Error(`${file} does not export BUILTIN_SLASH_COMMANDS`);
  return { commands: module.BUILTIN_SLASH_COMMANDS, how: file };
}

const sources = await webSources();
const entries = ledgerEntries();
const relative = (file) => file.split(path.sep).join('/');

// ── A. tag 是登记过的话术，claimsUi 与 uiEntry 必须自洽 ──────────────────────────────
for (const entry of entries) {
  assert.ok(Object.hasOwn(TAG_KINDS, entry.tag), `台账条目 ${entry.name} 的 tag「${entry.tag}」不在 TAG_KINDS 里：tag 必须是登记过的稳定话术，不许新造自由文本`);
  assert.equal(typeof entry.reason, 'string', `台账条目 ${entry.name} 的 reason 必须是字符串`);
  assert.ok(entry.reason.trim() !== '', `台账条目 ${entry.name} 的 reason 不许为空`);
  const kind = TAG_KINDS[entry.tag];
  if (kind.claimsUi) {
    assert.equal(typeof entry.uiEntry, 'string', `tag「${entry.tag}」（${entry.name}）声称网页上有入口，就必须给 uiEntry`);
    assert.ok(entry.uiEntry.trim() !== '', `tag「${entry.tag}」（${entry.name}）的 uiEntry 不许是空串`);
    assert.ok(Object.hasOwn(UI_ENTRIES, entry.uiEntry), `台账条目 ${entry.name} 的 uiEntry「${entry.uiEntry}」没有在 UI_ENTRIES 里登记`);
  } else {
    assert.equal(entry.uiEntry ?? null, null, `tag「${entry.tag}」（${entry.name}）声称的是「没有网页入口」，就不许再给 uiEntry`);
  }
}

// ── C. 不指 UI 的条目，文案里也不许指认 UI ─────────────────────────────────────────
for (const entry of entries) {
  if (entry.uiEntry) continue;
  const text = `${entry.tag}${entry.reason}`;
  assert.ok(!UI_CLAIM_IN_TEXT.test(text), `台账条目 ${entry.name} 的 tag/reason 里出现了 UI 指认（${text}），却没有登记 uiEntry —— 这正是 M-05 的撒谎形状`);
}

// ── B. 登记的入口必须在提交树里真的找得到 ──────────────────────────────────────────
const entryEvidence = [];
for (const [id, spec] of Object.entries(UI_ENTRIES)) {
  assert.match(spec.file, /^web\//, `UI_ENTRIES.${id} 的 file 必须在 web/ 下（现在没有这个入口就当没有，不许指 web/ 之外的东西）`);
  assert.equal(typeof spec.needle, 'string', `UI_ENTRIES.${id} 必须给 needle（可机械核对的原文片段）`);
  const text = sources.files.get(relative(spec.file));
  assert.ok(text !== undefined, `UI_ENTRIES.${id} 声称入口在 ${spec.file}，但它不在这一份里（${sources.mode}）`);
  assert.ok(text.includes(spec.needle), `UI_ENTRIES.${id} 声称 ${spec.file} 里有 ${JSON.stringify(spec.needle)}，但没找到（前端把入口删了/换了写法？）`);
  entryEvidence.push({ id, file: relative(spec.file), needle: spec.needle, what: spec.what });
}

// ── D. 反向漂移：提交树里已经有的网页入口，台账必须跟上 ─────────────────────────────
// D1（粗检测）：提交树里出现「导出/快照」引用（id 换了也抓得到）而台账说「没入口」⇒ 红。
const exportReferences = [];
for (const [file, text] of sources.files) {
  text.split('\n').forEach((line, index) => {
    if (EXPORT_REFERENCE.test(line)) exportReferences.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
  });
}
if (exportReferences.length > 0) {
  assert.notEqual(BUILTIN_ELSEWHERE.export.uiEntry ?? null, null,
    `这份提交树里已经出现了导出/快照入口（${exportReferences.join(' | ')}），但台账的 export 还写着「${BUILTIN_ELSEWHERE.export.tag}」。照这个配方翻正：`
    + ` ① TAG_KINDS 里加一条声称 UI 的话术（claimsUi: true）；`
    + ` ② UI_ENTRIES 里登记那个入口的 file + 原文片段（例如 { file: 'web/index.html', needle: 'id="export"' }）；`
    + ` ③ BUILTIN_ELSEWHERE.export 改成 { tag: <新话术>, uiEntry: <新 id>, reason: <指向那个入口> }。`);
}

// D2（精确）：台账里**预计**会被网页入口替代的那几条，钉住入口的原文片段。
// 只在「入口已进提交树」时断言「台账必须指向它」—— 未提交的并行前端改动不该让门红（见文件头）。
// 反向（台账指了它，入口就真的在）由 B 项负责（UI_ENTRIES 的 needle 必须找得到）。
const LEDGER_UI_EXPECTATIONS = {
  export: { command: 'export', file: 'web/index.html', needle: 'id="export"' },
  rename: { command: 'name', file: 'web/index.html', needle: 'id="rename"' },
};
const landedWithoutLedger = [];
for (const [uiEntry, expected] of Object.entries(LEDGER_UI_EXPECTATIONS)) {
  const text = sources.files.get(relative(expected.file));
  if (text === undefined || !text.includes(expected.needle)) continue;
  const ledger = BUILTIN_ELSEWHERE[expected.command];
  if ((ledger?.uiEntry ?? null) !== uiEntry) {
    landedWithoutLedger.push({ uiEntry, command: expected.command, file: relative(expected.file), needle: expected.needle, ledgerTag: ledger?.tag ?? '(缺)', ledgerUiEntry: ledger?.uiEntry ?? null });
  }
}
assert.deepEqual(landedWithoutLedger, [],
  `这份提交树里已经有这些网页入口了，但台账没跟上（或指错了）：${JSON.stringify(landedWithoutLedger)}`
  + ` —— 把对应条目的 tag 换成指着它的话术、uiEntry 换成登记过的 id，并把入口登进 UI_ENTRIES。`);

// 工作区里的漂移只打印（未提交的并行前端改动不该让这道门红 —— 见文件头）。
const workingTreeDrift = [];
if (sources.mode === 'HEAD') {
  const visit = async (dir) => {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, dirent.name);
      if (dirent.isDirectory()) await visit(target);
      else if (/\.(?:html|js|mjs|css)$/.test(dirent.name)) {
        const name = relative(path.relative(root, target));
        if (sources.files.get(name) === await readFile(target, 'utf8')) continue;
        (await readFile(target, 'utf8')).split('\n').forEach((line, index) => {
          if (EXPORT_REFERENCE.test(line)) workingTreeDrift.push(`${name}:${index + 1}（工作区有、HEAD 没有）`);
        });
      }
    }
  };
  await visit(path.join(root, 'web')).catch(() => {});
}

// ── G1. pi 的内置命令必须逐条显式分类（两边都不许多名字） ─────────────────────────
const pi = await piBuiltinCommands();
const classified = new Set([...Object.keys(WEB_BUILTINS), ...Object.keys(BUILTIN_ELSEWHERE)]);
const piNames = pi.commands.map((command) => command.name);
const unclassified = piNames.filter((name) => !classified.has(name));
const deadRows = [...classified].filter((name) => !piNames.includes(name));
assert.deepEqual(unclassified, [], `pi 的内置命令有未分类的：${unclassified.join(', ')} —— 必须显式分类（WEB_BUILTINS 或 BUILTIN_ELSEWHERE），不许掉进默认桶`);
assert.deepEqual(deadRows, [], `台账里的这些名字在 pi 的内置表里不存在了：${deadRows.join(', ')}（pi 改名/删除了？）`);

print('ledger', {
  entries: entries.length,
  tags: [...new Set(entries.map((entry) => entry.tag))],
  uiEntries: entries.filter((entry) => entry.uiEntry).map((entry) => `${entry.name}→${entry.uiEntry}`),
});
print('ui entry evidence', entryEvidence);
print('reverse drift (export references in the judged tree)', exportReferences);
print('reverse drift (landed web entry but the ledger has not caught up)', landedWithoutLedger);
print('reverse drift (working tree only, not a failure)', workingTreeDrift);
print('pi builtin table', { how: pi.how, count: piNames.length });
print('RESULT', `command tag honesty PASS (judged against: ${sources.mode})`);
