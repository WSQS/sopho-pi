#!/usr/bin/env node
// test/bash-timeout-note-ui.mjs —— 工具卡上「未指定 timeout ⇒ 本机缺省 N s」那一行的**机械门**。
//
// 这条显示要守住的不变量（一句话）：**没有显式 timeout 的 bash 调用 ⇒ 卡上有那一行，且那个数只有一个来处
// （生成物）；显式给了 timeout 的调用 / 别的工具 ⇒ 一个字都不加。** 前端不许把那个数写死。
//
// 事实与由来（一手）：插件 `pi-extensions/assistant/index.ts` 的 `pi.on("tool_call")` 会给**没给** timeout
// 的 bash 调用补一个缺省（`DEFAULT_BASH_TIMEOUT_S`）；注入的值**不落盘** ⇒ 会话记录里没有 `timeout` 字段
// ⇒ 工具卡今天完全看不见它。这一行就是把那层安全网摆到明面上（只做显示：不动插件判据、不改 pi 内置描述）。
//
// 形状（**fakedom 那一路**：不起浏览器、不起服务，一两秒、结果确定 —— 同 `test/fake-dom-contract.mjs`）：
//   直接拿**真** `web/render.js` 的 `toolCard()` ＋ `test/fake-dom.mjs` 的假 document 造四张卡。
//   值那一侧：`web/generated/plugin-values.js`（`bin/gen-plugin-values.mjs` 从插件源码读出来的）——
//   本门 import 它来算**期望的那句原文**，并断言 render.js 里没有那个数的字面量。
//
// 红绿对照（报告里给的复跑命令）：`--reverse-arm=no-note` 在**副本树**里把「append 那一行」拿掉 ⇒
//   ① 卡上有那一行 与 ② 值来自生成物 **必红**（真仓库一个字节不动）。
//
// 用法：
//   node test/bash-timeout-note-ui.mjs
//   node test/bash-timeout-note-ui.mjs --reverse-arm=no-note     # ⇒ ①/② 必红
//
// 出口：0 = 全绿（且若选了臂，臂也红到位）；1 = 有红 / 臂没红到位。

import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { FakeDocument } from './fake-dom.mjs';
import { removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;

/** 反证臂 `no-note`：把「append 那一行」整段拿掉（**副本树**里改；`from:`/`to:` 成对声明，
 *  `bin/check-arm-seams.mjs` 会扫到它）。 */
const NOTE_RENDER_SEAM = {
  file: 'render.js',
  from: "  if (bashTimeoutNoteApplies(part)) {\n    const timeoutNote = document.createElement('div');\n    timeoutNote.className = 'tool-timeout-note';\n    timeoutNote.dataset.timeoutNote = 'true';\n    timeoutNote.textContent = bashTimeoutNoteText();\n    output.append(timeoutNote);\n  }",
  to: '  // 反证臂 no-note：那一行的渲染被拿掉（副本树里改）。',
};
const ARM_MUTANTS = {
  'no-note': { what: '把工具卡上那行注记的**渲染**整段拿掉（副本树里改 web/render.js）⇒ ①「有那一行」与 ②「值来自生成物」必红', seam: NOTE_RENDER_SEAM, expect: ['note:shown-without-timeout', 'note:value-from-generated'] },
};
if (ARM && !ARM_MUTANTS[ARM]) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);

const problems = [];
let failures = 0;
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
function check(id, name, ok, detail) {
  if (ok) { process.stdout.write(`✓ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`); return true; }
  failures += 1;
  process.stdout.write(`✗ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  return false;
}

// ── 预备一个「web 根」：默认是真仓库的 web/；反证臂下先拷一份、把那行渲染拿掉 ────────────────────
const sandboxes = [];
let webRoot = path.join(root, 'web');
if (ARM === 'no-note') {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-bashtimeoutnote-'));
  sandboxes.push(sandbox);
  webRoot = path.join(sandbox, 'web');
  await cp(path.join(root, 'web'), webRoot, { recursive: true });
  const seam = ARM_MUTANTS[ARM].seam;
  const renderPath = path.join(webRoot, seam.file);
  const source = await readFile(renderPath, 'utf8');
  if (!source.includes(seam.from)) throw new Error(`反证臂 ${ARM} 的改写没命中（render.js 形状变了？）：${ARM_MUTANTS[ARM].what}`);
  await writeFile(renderPath, source.replace(seam.from, seam.to), 'utf8');
  const mutated = await readFile(renderPath, 'utf8');
  if (mutated === source || !mutated.includes('反证臂 no-note')) throw new Error(`反证臂 ${ARM} 的变异**没落地**（副本与源相同 / 找不到注入标记）—— 这一臂不算数`);
  print('反证臂 no-note', `web/ 副本 ${webRoot}（那行渲染已拿掉；真仓库一个字节不动）`);
}

const renderSource = await readFile(path.join(webRoot, 'render.js'), 'utf8');
const render = await import(pathToFileURL(path.join(webRoot, 'render.js')).href);
const generated = await import(pathToFileURL(path.join(webRoot, 'generated', 'plugin-values.js')).href);

// 期望的那句原文：**值来自生成物**（本门不写死那个数；写死了这一条就成了同义反复）。
const expectedNote = `未指定 timeout ⇒ 本机缺省 ${generated.BASH_DEFAULT_TIMEOUT_S} s（插件安全网；${generated.BASH_TIMEOUT_ENV} 可覆盖，${generated.BASH_TIMEOUT_OFF_VALUES.join('/')} 关掉）`;
print('生成物里的值', JSON.stringify({ BASH_DEFAULT_TIMEOUT_S: generated.BASH_DEFAULT_TIMEOUT_S, BASH_TIMEOUT_ENV: generated.BASH_TIMEOUT_ENV, BASH_TIMEOUT_OFF_VALUES: generated.BASH_TIMEOUT_OFF_VALUES }));
print('期望的那句原文', expectedNote);

// ── 造卡（真 `toolCard()` ＋ 假 document）──────────────────────────────────────────────────────
const textOf = (node) => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  let out = typeof node.textContent === 'string' ? node.textContent : '';
  for (const child of node.children ?? []) out += textOf(child);
  return out;
};
const cardOf = (part) => render.toolCard(new FakeDocument(), { type: 'tool', status: 'done-success', result: 'ok', ...part }, {});
const rowOf = (card) => card.children.find((child) => child.className === 'tool-call') ?? null;
const outputOf = (card) => card.children.find((child) => child.className === 'tool-output') ?? null;
const noteOf = (card) => outputOf(card)?.children.find((child) => child.className === 'tool-timeout-note') ?? null;
const argsOf = (card) => rowOf(card)?.children.find((child) => child.className === 'tool-args') ?? null;

// ① 没有 timeout 的 bash 调用 ⇒ 卡上有那一行，且在 `.tool-output` 这一块里（不是塞进 `.tool-call` 那一行、
//    也不在 `.tool-args` 里 —— 那两处分别有「恒为一条（≤26px）」与「就是参数本身」的既有硬规矩）。
const noTimeout = cardOf({ name: 'bash', args: { command: 'echo hi' } });
const noTimeoutNote = noteOf(noTimeout);
check('note:shown-without-timeout', '没有显式 `timeout` 的 bash 卡上**有**那一行，且挂在 `.tool-output` 里、排在结果之前',
  noTimeoutNote !== null && noTimeoutNote.dataset.timeoutNote === 'true'
    && outputOf(noTimeout).children[0] === noTimeoutNote
    && !rowOf(noTimeout).children.some((child) => child.className === 'tool-timeout-note')
    && !argsOf(noTimeout).children.some((child) => child.className === 'tool-timeout-note'),
  JSON.stringify({ outputChildren: outputOf(noTimeout).children.map((child) => child.className), rowChildren: rowOf(noTimeout).children.map((child) => child.className), argsChildren: argsOf(noTimeout).children.map((child) => child.className) }));

// ② 那一行的值**逐字**来自生成物（render.js 不写死）。
check('note:value-from-generated', '那一行的原文**逐字**等于按 web/generated/plugin-values.js 里的值拼出来的那句（值只有一个来处）',
  textOf(noTimeoutNote) === expectedNote,
  JSON.stringify({ got: textOf(noTimeoutNote), want: expectedNote }));

// ③ 前端源码里**没有**那个数的字面量（否则就是第二份真理），而且它确实 import 了生成物。
const literal = String(generated.BASH_DEFAULT_TIMEOUT_S);
check('note:no-hardcoded-value', `web/render.js 里没有那个数的字面量（${literal}），而且确实用了生成物的常量名 —— 否则就是第二份真理`,
  renderSource.includes('BASH_DEFAULT_TIMEOUT_S') && !renderSource.includes(literal),
  JSON.stringify({ usesGeneratedConstant: renderSource.includes('BASH_DEFAULT_TIMEOUT_S'), hasLiteral: renderSource.includes(literal), literal }));

// ④ 显式给了 timeout 的 bash 调用 ⇒ **一个元素都不加**（它本来就有值；别去动它）。
const withTimeout = cardOf({ name: 'bash', args: { command: 'echo hi', timeout: 300 } });
check('note:absent-with-timeout', '显式 `timeout: 300` 的 bash 卡上**没有**那一行（参数显示保持原样）',
  noteOf(withTimeout) === null && textOf(argsOf(withTimeout)) === 'echo hi',
  JSON.stringify({ outputChildren: outputOf(withTimeout).children.map((child) => child.className), argsText: textOf(argsOf(withTimeout)) }));

// ⑤ 别的工具 ⇒ 也不加（那层安全网只管内置 bash）。
const otherTool = cardOf({ name: 'read', args: { path: 'a.txt' } });
check('note:absent-other-tool', '非 bash 工具（read）卡上**没有**那一行',
  noteOf(otherTool) === null,
  JSON.stringify({ outputChildren: outputOf(otherTool).children.map((child) => child.className) }));

// ⑥ 回归：`.tool-args` 的正文**就是参数本身**（那一行不进 `.tool-args`，免得既有「args = 命令」被带歪）。
check('note:args-untouched', '没有 timeout 的 bash 卡上，`.tool-args` 的正文仍**逐字**是命令本身（那一行在它外面）',
  textOf(argsOf(noTimeout)) === 'echo hi',
  JSON.stringify({ argsText: textOf(argsOf(noTimeout)) }));

// ── 臂的判据 ───────────────────────────────────────────────────────────────────────────────────
let armOk = null;
if (ARM === 'no-note') {
  const redIds = [];
  if (noTimeoutNote === null) redIds.push('note:shown-without-timeout');
  if (textOf(noTimeoutNote) !== expectedNote) redIds.push('note:value-from-generated');
  const expected = ARM_MUTANTS[ARM].expect;
  armOk = expected.every((id) => redIds.includes(id));
  process.stdout.write(`\n──── 反证臂 no-note：预期红 ${JSON.stringify(expected)} / 实际红 ${JSON.stringify(redIds)} ────\n`);
  process.stdout.write(`  红：[note:shown-without-timeout] 卡上的行＝${noTimeoutNote === null ? 'null（没有）' : JSON.stringify(textOf(noTimeoutNote))}\n`);  process.stdout.write(armOk
    ? '✓ 反证臂 no-note 红到位（拿掉渲染 ⇒ 那两条都红）—— 这是**期望**的结果，不是缺陷\n'
    : `✗ 反证臂 no-note **没红到位**：实际红 ${JSON.stringify(redIds)} ⇒ 这道门是个假门\n`);
}
if (!ARM) {
  process.stdout.write(`\n──── test/bash-timeout-note-ui.mjs：6 条断言 —— ${6 - failures} 绿 / ${failures} 红 ────\n`);
}

for (const sandbox of sandboxes) await removeSandbox(sandbox, problems, 'bash-timeout-note-ui sandbox');
for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
process.exitCode = (ARM ? armOk === true : failures === 0) && problems.length === 0 ? 0 : 1;
