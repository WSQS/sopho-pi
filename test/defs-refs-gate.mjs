#!/usr/bin/env node
// defs-refs-gate —— 定义/引用差集自查门的**门**（业主 2026-09-21 批准的两条「门纪律」之二）。
//
// 检查器本身是 `bin/check-defs-refs.mjs`（只读）。这道门证明两件事：
//   ① **检查器有牙**：拿今天两次真事故的**原始文件字节**（`git show <red rev>:<path>`）
//      在临时 git 仓库里重放「定义被删、引用还在」与「被调用、从未声明」⇒ 检查器必须判红；
//      再拿一个合法小文件（只有 import 与外部/全局调用）⇒ 不许误报。
//   ② **当前工作树是绿的**：真仓上跑一遍，必须 0 违规。
//
// 为什么要「自证有牙」：一道从不判红的门等于没有门。这里的红样本不是编的 ——
//   · `NOTIFY_QUIET_MS`：`0162fca` 把它放回来；`0162fca^` 就是定义没了、4 处引用还在的那个状态
//     （线上表现：走通知/委派那条路的请求 500）；
//   · `finishFailedProxy`：`a87eb6b` 补的声明；`a87eb6b^` 就是「有调用点、全仓无声明」的状态
//     （兜底 proxy 一撞必 ReferenceError）。
//   ⚠️ 任务书里把第二处写成 `448ca57`：那笔是**发现它的那条测试**（在 `a87eb6b` **之后**），
//     在 `448ca57` 上检查器本来就该是绿的（修复已在它的历史里）。红态取真正的修复前一个提交。
//
// 跑法：npm run test:defsrefs（也已接进 test:prepush 与 test:harness 的命令链）
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, defaultRoot } from '../bin/check-defs-refs.mjs';
import { finishCleanup, removeSandbox, runArms } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const realRoot = path.resolve(here, '..');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitQuiet = (cwd, args) => {
  try { return git(cwd, args).trim(); } catch { return null; }
};

/** 在临时目录里造一个真 git 仓库：先提交 `baseFiles`，再把工作树改成 `workFiles`。 */
async function makeRepo(sandbox, name, { baseFiles, workFiles }) {
  const dir = path.join(sandbox, name);
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'defsrefs-gate@test.invalid']);
  git(dir, ['config', 'user.name', 'defsrefs gate']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [relative, text] of Object.entries(baseFiles)) {
    const full = path.join(dir, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text, 'utf8');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base state']);
  for (const [relative, text] of Object.entries(workFiles)) {
    const full = path.join(dir, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text, 'utf8');
  }
  return dir;
}

/** 从**真仓**里取出某一 rev 的真实文件字节（只读 `git show`，不动真树、不建 worktree）。 */
const realFile = (rev, relative) => git(realRoot, ['show', `${rev}:${relative}`]);

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'defsrefs-gate-'));
const cleanupProblems = [];
let primaryError = null;
let outcome = null;

try {
  const removedReal = realFile('0162fca', 'server/base.mjs');
  const notifyRed = realFile('0162fca^', 'server/base.mjs');
  const proxyFixed = realFile('a87eb6b', 'server/base.mjs');
  const proxyRed = realFile('a87eb6b^', 'server/base.mjs');

  const { results, failed } = await runArms([
    ['真仓工作树（base=HEAD）必须绿', async () => {
      const result = await check({ root: realRoot, base: 'HEAD' });
      assert.deepEqual(result.violations, [], `当前工作树不该有定义/引用违规：\n${result.violations.map((item) => JSON.stringify(item)).join('\n')}`);
      return `files=${result.stats.files} removed-def=${result.stats.removedDefs} undeclared-call=${result.stats.undeclaredCalls}`;
    }],

    ['真仓非空差集（base=HEAD~80）也必须绿 —— 证半 1 不是空转', async () => {
      const base = gitQuiet(realRoot, ['rev-parse', '--verify', '--quiet', 'HEAD~80']);
      if (!base) return 'SKIP（本仓历史不足 80 个提交）';
      const changed = git(realRoot, ['diff', '--name-only', base, '--']).split('\n').filter(Boolean).length;
      assert.ok(changed > 20, `base=HEAD~80 必须真的比出很多文件，否则这条臂是空的：changed=${changed}`);
      const result = await check({ root: realRoot, base });
      assert.deepEqual(result.violations, [], `HEAD~80..工作树这 80 个提交里出现了「定义没了、引用还在」：\n${result.violations.map((item) => JSON.stringify(item)).join('\n')}`);
      return `changed=${changed} files=${result.stats.files}`;
    }],

    ['靶子 1 · NOTIFY_QUIET_MS（0162fca^ 的红态）必须判红，且点名文件:行+标识符', async () => {
      const repo = await makeRepo(sandbox, 'notify', { baseFiles: { 'server/base.mjs': removedReal }, workFiles: { 'server/base.mjs': notifyRed } });
      const result = await check({ root: repo });
      const hit = result.violations.find((item) => item.kind === 'removed_definition' && item.name === 'NOTIFY_QUIET_MS');
      assert.ok(hit, `必须报「NOTIFY_QUIET_MS 定义没了但引用还在」：${JSON.stringify(result.violations)}`);
      assert.equal(hit.file, 'server/base.mjs');
      assert.ok(hit.referenceCount >= 4, `引用数必须 ≥4（真事故是 4 处）：${hit.referenceCount}`);
      assert.ok(Number.isInteger(hit.line) && hit.line > 0, `必须给出行号：${JSON.stringify(hit)}`);
      return `${hit.file}:${hit.line} ${hit.name} refs=${hit.referenceCount}`;
    }],

    ['靶子 2 · finishFailedProxy（a87eb6b^ 的红态）两半都要判红', async () => {
      const repo = await makeRepo(sandbox, 'proxy', { baseFiles: { 'server/base.mjs': proxyFixed }, workFiles: { 'server/base.mjs': proxyRed } });
      const result = await check({ root: repo });
      const removed = result.violations.find((item) => item.kind === 'removed_definition' && item.name === 'finishFailedProxy');
      const undeclared = result.violations.find((item) => item.kind === 'undeclared_call' && item.name === 'finishFailedProxy');
      assert.ok(removed, `半 1 必须报 finishFailedProxy 定义没了但调用点还在：${JSON.stringify(result.violations)}`);
      assert.ok(undeclared, `半 2 必须报 finishFailedProxy 被调用但全仓无声明：${JSON.stringify(result.violations)}`);
      return `removed-def ${removed.file}:${removed.line}; undeclared-call ${undeclared.file}:${undeclared.line}`;
    }],

    ['半 1 跨文件：模块 A 删掉被 B import 的函数 ⇒ 红', async () => {
      const repo = await makeRepo(sandbox, 'crossfile', {
        baseFiles: {
          'server/a.mjs': 'export function sharedHelper(x) {\n  return x + 1;\n}\n',
          'server/b.mjs': "import { sharedHelper } from './a.mjs';\nexport const value = sharedHelper(1);\n",
        },
        workFiles: {
          'server/a.mjs': 'export const unrelated = 1;\n',
        },
      });
      const result = await check({ root: repo });
      const hit = result.violations.find((item) => item.kind === 'removed_definition' && item.name === 'sharedHelper');
      assert.ok(hit, `import 方仍在引用 ⇒ 必须判红：${JSON.stringify(result.violations)}`);
      assert.ok(hit.references.some((reference) => reference.startsWith('server/b.mjs:')), `引用必须落在 import 方：${JSON.stringify(hit.references)}`);
      return `server/a.mjs:${hit.line} sharedHelper ← ${hit.references.join(', ')}`;
    }],

    ['半 2 独立反例：调用一个全仓没声明的标识符 ⇒ 红', async () => {
      const repo = await makeRepo(sandbox, 'undeclared', {
        baseFiles: { 'server/keep.mjs': 'export const keep = 1;\n' },
        workFiles: { 'server/broken.mjs': 'export async function go() {\n  return mysteryHelper(1);\n}\n' },
      });
      const result = await check({ root: repo });
      const hit = result.violations.find((item) => item.kind === 'undeclared_call' && item.name === 'mysteryHelper');
      assert.ok(hit, `必须报 mysteryHelper 被调用但无声明：${JSON.stringify(result.violations)}`);
      assert.equal(hit.file, 'server/broken.mjs');
      assert.equal(hit.line, 2);
      return `${hit.file}:${hit.line} ${hit.name}`;
    }],

    ['合法小文件（只有 import 与外部/全局调用）不许误报', async () => {
      const repo = await makeRepo(sandbox, 'legit', {
        baseFiles: {
          'server/lib.mjs': 'export function compute(x) {\n  return x * 2;\n}\n',
        },
        workFiles: {
          'server/uses.mjs': [
            "import { readFile, writeFile } from 'node:fs/promises';",
            "import { join } from 'node:path';",
            "import { compute } from './lib.mjs';",
            '',
            'export async function run(items) {',
            '  const results = items.map((item) => compute(item));',
            "  const text = JSON.stringify(results, null, 2);",
            "  await writeFile(join('/tmp', 'x.json'), text);",
            "  const back = await readFile(join('/tmp', 'x.json'), 'utf8');",
            '  setTimeout(() => {}, 0);',
            '  return parseInt(back, 10) + Number(results.length) + Math.max(0, 1);',
            '}',
            '',
          ].join('\n'),
        },
      });
      const result = await check({ root: repo });
      assert.deepEqual(result.violations, [], `合法文件不许被误报：\n${result.violations.map((item) => JSON.stringify(item)).join('\n')}`);
      return `files=${result.stats.files} violations=0`;
    }],
  ], { title: 'defs-refs gate' });

  outcome = { results, failed };
} catch (error) {
  primaryError = error;
} finally {
  await removeSandbox(sandbox, cleanupProblems, 'remove defsrefs gate sandbox');
  if (!primaryError && outcome && outcome.failed.length === 0) process.stdout.write('RESULT: defs-refs gate PASS\n');
  finishCleanup(primaryError, cleanupProblems);
}
