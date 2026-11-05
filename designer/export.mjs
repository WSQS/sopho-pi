#!/usr/bin/env node
// designer/export.mjs —— 中立文档 ⇒ **三样产物**（纯 Node、零依赖）：
//   ① `<名字>.json`        「中立 JSON」：**规范序列化**（键序由 schema 定、2 空格；round-trip 不丢信息）
//   ② `<名字>.html`        静态 HTML/CSS（零外部请求、零 JS）—— 一屏一节，几何由文档里的数决定
//   ③ `<名字>.flow.svg`    「屏/状态到哪去」的图（箭头**只**由 transitions 生成）
//   ＋ `<名字>.screen.<屏 id>.svg`  每屏一张静态 SVG（同一份语义的另一条实现）
//   ＋ `<名字>.screen.<屏 id>.<状态 id>.svg`  **有自己那棵树**的状态（`states[j].root`）各一张
//
// 一句话口径：**这个脚本不发明任何东西** —— 它只把文档翻成别的形状；文档不合法就**一个字节都不写**。
//
// 用法：
//   node designer/export.mjs --doc=designer/fixtures/demo.json --out=designer/generated
//   node designer/export.mjs --doc=<doc.json> --out=<dir> --check     # 只比：盘上那几份 == 刚渲染的（逐字节）
//   node designer/export.mjs --doc=<doc.json> --stdout=html           # 打到 stdout（html|json|flow|screen:<id>）
//   node designer/export.mjs --doc=<doc.json> --viewport=1200x760     # 换导出视口（默认 1200x760）
//
// 出口：0 = 成功（或 --check 全新鲜）；1 = --check 发现有旧/缺（不写盘）；3 = 文档不合法（不写盘）。
// PNG 不在本脚本里：纯 Node 没有光栅化，PNG 用真浏览器打开导出的 HTML 截（`test/designer-export.mjs`）。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { formatReport, validateDocument } from './validate.mjs';
import { renderDocumentHtml, renderDocumentJson, DEFAULT_VIEWPORT } from './toHtml.mjs';
import { renderFlowSvg, renderScreenSvg } from './toSvg.mjs';

const argOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const hasFlag = (name) => process.argv.includes(`--${name}`);

const docPath = argOf('doc');
if (!docPath) {
  process.stderr.write('用法：node designer/export.mjs --doc=<doc.json> --out=<dir> [--check] [--stdout=html|json|flow|screen:<id>]\n');
  process.exit(2);
}
const rawViewport = argOf('viewport');
const viewport = rawViewport
  ? (() => {
    const [w, h] = rawViewport.split(/[x×]/).map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      process.stderr.write(`--viewport 要写成 1200x760 这种：读到 ${JSON.stringify(rawViewport)}\n`);
      process.exit(2);
    }
    return { w, h };
  })()
  : DEFAULT_VIEWPORT;

let doc;
try {
  doc = JSON.parse(await readFile(docPath, 'utf8'));
} catch (error) {
  process.stderr.write(`读不到/读不懂 ${docPath}：${error.message}\n`);
  process.exit(3);
}

const sourceLabel = docPath.split(path.sep).join('/');
const report = validateDocument(doc, { source: sourceLabel });
if (!report.ok) {
  process.stderr.write(`${formatReport(report)}\n`);
  process.stderr.write('⇒ 文档不合法：**一个字节都不产出**（导出物只有一种状态：全部正确）。\n');
  process.exit(3);
}
for (const warning of report.warnings) process.stderr.write(`! [${warning.code}] ${warning.message}\n`);

const base = path.basename(docPath).replace(/\.json$/i, '');
const outDir = argOf('out') ? path.resolve(argOf('out')) : null;

// 先全部渲染进内存，再落盘 —— 「不写半份」不是靠 add，是靠这个顺序。
const outputs = new Map();
outputs.set(`${base}.json`, renderDocumentJson(doc, { source: sourceLabel }));
outputs.set(`${base}.html`, renderDocumentHtml(doc, { viewport, source: sourceLabel }));
outputs.set(`${base}.flow.svg`, renderFlowSvg(doc, { viewport, source: sourceLabel }));
for (const screen of doc.screens) {
  outputs.set(`${base}.screen.${screen.id}.svg`, renderScreenSvg(doc, screen.id, { viewport, source: sourceLabel }));
  const states = Array.isArray(screen.states) ? screen.states : [];
  for (const state of states.slice(1)) {
    if (state.root === undefined) continue; // 没有自己那棵树的状态与默认树共用 ⇒ 不多出一张图
    outputs.set(`${base}.screen.${screen.id}.${state.id}.svg`, renderScreenSvg(doc, screen.id, { viewport, state: state.id, source: sourceLabel }));
  }
}

const stdoutKind = argOf('stdout');
if (stdoutKind) {
  const key = stdoutKind === 'flow'
    ? `${base}.flow.svg`
    : stdoutKind.startsWith('screen:')
      ? `${base}.screen.${stdoutKind.slice('screen:'.length)}.svg`
      : `${base}.${stdoutKind}`;
  if (!outputs.has(key)) {
    process.stderr.write(`--stdout=${stdoutKind} 不认识（已有：${[...outputs.keys()].join(', ')}）\n`);
    process.exit(2);
  }
  process.stdout.write(outputs.get(key));
  process.exit(0);
}

if (!outDir) {
  process.stderr.write('要写盘就必须给 --out=<dir>（或只用 --stdout=<kind> 看一眼）\n');
  process.exit(2);
}

if (hasFlag('check')) {
  let stale = 0;
  for (const [name, text] of outputs) {
    const file = path.join(outDir, name);
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === null) {
      stale += 1;
      process.stdout.write(`✗ ${name}: 盘上没有（跑一次 npm run gen:designer）\n`);
      continue;
    }
    if (current !== text) {
      stale += 1;
      const left = current.split('\n');
      const right = text.split('\n');
      let at = 0;
      while (at < Math.max(left.length, right.length) && left[at] === right[at]) at += 1;
      process.stdout.write(`✗ ${name}: 与当前文档生成的**不一致**（${Buffer.byteLength(current)} B vs ${Buffer.byteLength(text)} B；第一处不同在第 ${at + 1} 行：盘上 ${JSON.stringify(left[at] ?? '(没有这一行)')} / 刚渲染 ${JSON.stringify(right[at] ?? '(没有这一行)')}）\n`);
      continue;
    }
    process.stdout.write(`✓ ${name}: 新鲜（${Buffer.byteLength(text)} B）\n`);
  }
  process.exit(stale === 0 ? 0 : 1);
}

await mkdir(outDir, { recursive: true });
for (const [name, text] of outputs) await writeFile(path.join(outDir, name), text, 'utf8');
process.stdout.write(`✓ 导出 ${outputs.size} 份 ← ${sourceLabel}：${[...outputs.keys()].join('、')}\n`);
