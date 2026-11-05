#!/usr/bin/env node
// test/docs-index-complete.mjs —— `docs/` 索引完整性门。
//
// 为什么要有它（总台 2026-09-25 派单的原话）：`docs/README.md` 是**手写的总索引、没有生成器**，
// 而「新文档上了、索引没跟上」这件事**没有任何机械守卫**。当天另一条线新增
// `docs/design/designer-agent.md`，只能**靠人记得**往索引里补一行，新文档才有入口。这道门把
// 「记得」变成一条一两秒就能跑的红/绿，两个方向都查：
//
//   ① 正向（不漏）：`docs/**/*.md`（**除 `history/**`**）里每一份文档，都必须在 `docs/README.md`
//      里被**引用到**（有一条指向它的链接，或索引正文里点到了它的相对路径即可）。
//      —— 抓「文档上了、索引没跟上」。
//   ② 反向（不悬空）：`docs/README.md` 里每条指向 `docs/` 内部的链接，都必须指向**真实存在**的
//      文件/目录。
//      —— 抓「索引指向已删/搬走的文档」（搬走时最容易留下这种悬空链接）。
//
// 例外**只在白名单里**（`INDEX_WHITELIST`，每条写明理由；跑起来会原样打印）。纪律照旧：
// **只减不增** —— 以后新增例外要有人点名，不是随手加一行把门弄绿。`history/**` 的排除同理，
// 显式列在 `INDEX_OUT_OF_SCOPE` 里（按日期归档、只读历史，索引只用一行代表整个目录）。
//
// 判据本身不另写一套「路径≈」的模糊匹配：相对路径直接 `path.resolve` 到绝对路径比相等，
// 索引正文里的字面出现用 `String.includes`（这是「链接/路径即可」的宽口径，见任务书）。
//
// 用法：
//   node test/docs-index-complete.mjs                       # 真仓库（npm run test:docsindex）
//   node test/docs-index-complete.mjs --reverse-arm=missing-doc   # 反证臂①：新增一份文档、不改索引 ⇒ 必红在 index:complete
//   node test/docs-index-complete.mjs --reverse-arm=dead-link     # 反证臂②：索引里一条链接改成不存在的路径 ⇒ 必红在 index:no-dead-links
//
// 反证臂打的是 docs/ 的**副本**（`test/harness.mjs` 的 `runGateOnMutatedCopy`），真树一个字节不动。
//
// 出口：0 = 真树两向全绿（选了臂则臂也红到位）；1 = 有缺行 / 有悬空链接 / 臂没红到位 / 读不到索引。

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runGateOnMutatedCopy } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
// 反证臂用：让门去扫**另一棵树**的 docs/（子进程里由 runGateOnMutatedCopy 指过来）。
const ROOT = path.resolve(process.env.SOPHO_DOCS_INDEX_GATE_ROOT || DEFAULT_ROOT);
const DOCS_DIR = path.join(ROOT, 'docs');
const README_RELATIVE = 'README.md';
const GATE_FILE = fileURLToPath(import.meta.url);
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const ARM_NAMES = new Set(['missing-doc', 'dead-link']);

// ── 例外白名单：**只减不增**，每条写明理由 ──────────────────────────────────────────────────
//
// 一份文档出现在这里 = 「它不需要在索引里被引用」。这是**豁免**，不是「查过了没问题」。
// 以后要新增一条，必须有人点名（照本仓惯例：纪律清单里写清为什么）。
export const INDEX_WHITELIST = Object.freeze([
  {
    path: 'README.md',
    reason: '索引自身：它是入口，自己引用自己在导航上没有意义（也避免「改索引才能过门」这个环）',
  },
]);

// 显式排除的目录（不是白名单：这是「范围之外」，整棵子树都不看）。
export const INDEX_OUT_OF_SCOPE = Object.freeze([
  {
    dir: 'history',
    reason: '按日期归档的只读历史；索引只用一行代表整个 history/ 目录，不要求逐份进索引',
  },
]);

const insideDir = (relative, dir) => relative === dir || relative.startsWith(`${dir}/`);

// ── 判据本体（导出是为了能直接对副本跑；CLI 与反证臂共用同一份） ──────────────────────────────
export async function auditDocsIndex(docsDir) {
  const readmeFile = path.join(docsDir, README_RELATIVE);
  let readme;
  try {
    readme = await readFile(readmeFile, 'utf8');
  } catch (error) {
    return { docsDir, readmeFile, fatal: `读不到索引文件 ${readmeFile}：${error.message}` };
  }

  // ① 候选文档：docs/ 下全部 *.md（递归，含子目录）。
  const docs = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path.join(dir, entry.name), relative); continue; }
      if (entry.isFile() && entry.name.endsWith('.md')) docs.push(relative);
    }
  }
  await walk(docsDir, '');
  docs.sort();

  const excluded = INDEX_OUT_OF_SCOPE.map(({ dir }) => dir);
  const inScope = docs.filter((relative) => !excluded.some((dir) => insideDir(relative, dir)));
  const exempted = new Set(INDEX_WHITELIST.map(({ path: relative }) => relative));

  // ② 索引里的 markdown 链接。`#锚点` 剥掉；`../x`、`/x`、`scheme:` 不是「docs/ 内链接」，不算本门范围。
  const links = [];
  for (const match of readme.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const raw = match[2].trim();
    links.push({ text: match[1], raw, target: raw.split('#')[0].trim() });
  }
  const isInternal = (target) => target.length > 0
    && !target.startsWith('..')
    && !target.startsWith('/')
    && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
  const internalLinks = links.filter((link) => isInternal(link.target));
  const absoluteOf = (target) => path.resolve(docsDir, target);

  // 「被引用到」＝ 索引正文里出现了它的相对路径（宽口径，链接/路径都算），
  // 或者有一条 docs/ 内链接 resolve 到它。
  const referenced = (relative) => {
    if (readme.includes(relative)) return true;
    const absolute = path.join(docsDir, relative);
    return internalLinks.some((link) => absoluteOf(link.target) === absolute);
  };
  const missing = inScope.filter((relative) => !exempted.has(relative) && !referenced(relative));

  // ③ 反向：每条 docs/ 内链接都要落在真实存在的路径上（文件或目录都行，`.md` 与目录链接都常见）。
  const broken = [];
  for (const link of internalLinks) {
    const absolute = absoluteOf(link.target);
    try {
      await stat(absolute);
    } catch {
      broken.push({ ...link, absolute });
    }
  }

  return { docsDir, readmeFile, readme, docs, inScope, excluded, exempted, links, internalLinks, missing, broken };
}

// ── 报告与出口 ────────────────────────────────────────────────────────────────────────────
let failures = 0;
function check(id, name, ok, detail) {
  process.stdout.write(`${ok ? '✓' : '✗'} [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  if (!ok) failures += 1;
  return ok;
}

function reportHeader(audit) {
  const lineCount = audit.readme.split(/\r?\n/).length;
  process.stdout.write(`索引文件：docs/${README_RELATIVE}（${lineCount} 行）\n`);
  process.stdout.write(`候选文档：${audit.docs.length} 份 .md（docs/**/*.md，递归）\n`);
  process.stdout.write(`  其中在范围内：${audit.inScope.length} 份`
    + `（排除目录：${audit.excluded.map((dir) => `${dir}/**`).join('、') || '无'}）\n`);
  process.stdout.write(`  白名单（豁免「必须在索引里」）：${audit.exempted.size === 0 ? '无' : [...audit.exempted].join('、')}\n`);
  for (const entry of INDEX_WHITELIST) process.stdout.write(`    · ${entry.path} —— ${entry.reason}\n`);
  for (const entry of INDEX_OUT_OF_SCOPE) process.stdout.write(`    · 排除 ${entry.dir}/** —— ${entry.reason}\n`);
  process.stdout.write(`索引里的链接：${audit.links.length} 条（其中指向 docs/ 内部：${audit.internalLinks.length} 条）\n`);
}

/** 正向：每份在范围内的文档都在索引里被引用到（白名单除外）。 */
function forwardCheck(audit) {
  const total = audit.inScope.length;
  return check(
    'index:complete',
    'docs/**/*.md（除 history/**）每一份都在 docs/README.md 里被引用到',
    audit.missing.length === 0,
    audit.missing.length === 0
      ? `${total - audit.exempted.size}/${total - audit.exempted.size} 份被引用到（白名单豁免 ${audit.exempted.size} 份）`
      : `${audit.missing.length} 份没有进索引（在范围内 ${total} 份，白名单豁免 ${audit.exempted.size} 份）：\n`
        + audit.missing.map((relative) => `        · ${relative}`).join('\n')
        + '\n      （怎么修：把缺的行加进 docs/README.md，摘要照抄该文档头部的状态行）',
  );
}

/** 反向：索引里每条 docs/ 内链接都指向真实存在的路径。 */
function backwardCheck(audit) {
  const total = audit.internalLinks.length;
  return check(
    'index:no-dead-links',
    'docs/README.md 里每条 docs/ 内链接都指向真实存在的文件/目录（无悬空链接）',
    audit.broken.length === 0,
    audit.broken.length === 0
      ? `${total}/${total} 条落点存在`
      : `${audit.broken.length} 条指向不存在的路径（共 ${total} 条 docs/ 内链接）：\n`
        + audit.broken.map((link) => `        · [${link.text}](${link.raw}) ⇒ ${path.relative(ROOT, link.absolute)}`).join('\n')
        + '\n      （怎么修：把链接指回真实路径，或从索引里删掉这条）',
  );
}

// ── 反证臂：拿**真门**去打 docs/ 的副本，证明它真的会红在预期那条上 ─────────────────────────────
if (ARM !== null) {
  if (!ARM_NAMES.has(ARM)) throw new Error(`不认识的反证臂：${ARM}（可选：${[...ARM_NAMES].join('、')}）`);
  const expect = ARM === 'missing-doc' ? 'index:complete' : 'index:no-dead-links';
  // 两条臂各自只动一处、只应打掉一条断言（隔离：证明两条断言各自有牙）：
  //   · missing-doc：往副本 docs/design/ 添一份**不改索引**的新文档 ⇒ 只红正向；
  //   · dead-link：把「先读」表里那条 `ops/handoff.md` 的**链接目标**改成不存在的路径，
  //     但链接**文字**仍然写着 `ops/handoff.md` ⇒ 正向照样绿，只有反向红。
  const mutate = async (copyRoot) => {
    if (ARM === 'missing-doc') {
      const probe = path.join(copyRoot, 'docs', 'design', '__index-probe.md');
      await writeFile(probe, '# 反证探针（不进仓）\n\n这份文档**故意**不在索引里：门必须因此判红。\n', 'utf8');
      return;
    }
    const readmeFile = path.join(copyRoot, 'docs', README_RELATIVE);
    const source = await readFile(readmeFile, 'utf8');
    const before = '](ops/handoff.md)';
    if (!source.includes(before)) {
      throw new Error(`反证臂 dead-link 的改写没命中：副本 docs/${README_RELATIVE} 里找不到 ${JSON.stringify(before)}`);
    }
    await writeFile(readmeFile, source.replace(before, '](ops/__index-probe-gone__.md)'), 'utf8');
  };

  let arm = null;
  let armError = null;
  try {
    arm = await runGateOnMutatedCopy({
      root: DEFAULT_ROOT,
      tag: `docsindex-${ARM}`,
      dirs: ['docs'],
      mutate,
      gateFile: GATE_FILE,
      expect,
      envKey: 'SOPHO_DOCS_INDEX_GATE_ROOT',
    });
  } catch (error) {
    armError = error;
  }
  process.stdout.write(`\n──── 反证臂 ${ARM}：预期红在 ${expect} ────\n`);
  if (armError !== null) {
    process.stdout.write(`✗ 反证臂 ${ARM} 没红到位：${armError instanceof Error ? armError.message : String(armError)}\n`);
  } else {
    process.stdout.write(`✓ 反证臂 ${ARM} 红到位（真门退出码 ${arm.exitCode}）—— 这是**期望**的结果，不是缺陷\n`);
    process.stdout.write(`  红的那一行：${arm.redLine}\n`);
    process.stdout.write(`  门输出（末 1600 字）：\n${arm.output.slice(-1600)}\n`);
  }
  for (const problem of arm?.problems ?? []) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
  const cleanupClean = (arm?.problems ?? []).length === 0;
  process.exitCode = armError === null && arm?.ok === true && cleanupClean ? 0 : 1;
} else {
  const audit = await auditDocsIndex(DOCS_DIR);
  if (audit.fatal) {
    process.stdout.write(`✗ ${audit.fatal}\n`);
    process.exitCode = 1;
  } else {
    reportHeader(audit);
    forwardCheck(audit);
    backwardCheck(audit);
    process.stdout.write(`\n──── test/docs-index-complete.mjs：2 条断言 —— ${2 - failures} 绿 / ${failures} 红 ────\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  }
}
