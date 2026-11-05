#!/usr/bin/env node
// 门：**受守卫的 worktree 回收路径**（插件工具 `reclaim_worktree`）＋候选报告（`bin/wt-report.mjs`）。
//
// 为什么有这道门（2026-09-24 的真实事故，维护者干的）：用两条手搓判据筛「可删的 worktree」——
//   ①分支已是 `origin/master` 的祖先 ②`/tree` 的 `cwd` 字段不在活会话里 ⇒ 删掉了一个正干活、**尚未提交**
//   的子会话的 cwd（未提交改动不可恢复）。两条判据都不可靠，本门把两条**都**做成反证臂。
//
// 场景全部在**临时目录里的假仓库 ＋ 临时 ASSIST_HOME** 里造（真 `.sopho-wt/` 与真 profile 一个字节都不碰）：
//   · 真宿主 A（`server/base.mjs`，从**临时副本树**里起）＋ 假 provider（不联网、不调真模型）＋ 真 git 仓库
//     （`git init` + 裸远端 origin ⇒ `origin/master` 真的存在）；
//   · 真会话（`POST /sessions`）、真归档（`POST /sessions/{id}/archive`）、**真工具调用**
//     （往调用方会话发一条消息，假 provider 回一个 `reclaim_worktree` 工具调用，回执原样回显）。
//
// 臂：
//   ① 事故现场重建（A 已归档、B 也住同一棵树且有未提交改动）⇒ **拒绝**且 B 的目录逐字节未动；
//   ② 已归档 ＋ 无别的会话 ＋ 内容零差异 ⇒ **成功**（目录真没了、回执如实）；再调一次 ⇒ **幂等**；
//   ③ 有未并入差异 ⇒ 默认**拒绝**；`force:true` ⇒ 动，且回执写明丢弃了什么、分支**不**删；
//   ④ 工作区有未提交改动（分支是祖先）⇒ 默认**拒绝**（这一臂正是反证臂②的靶子）；
//   ⑤ 快照/护栏：未归档 ⇒ 拒绝；主检出 ⇒ 拒绝；片段 uuid ⇒ 拒绝；不存在的 uuid ⇒ 拒绝；
//   ⑥ `bin/wt-report.mjs` 只读：跑前跑后仓库与目录一字不差，且它自己的建议可复核。
//
// ③ 有未并入差异 ⇒ 默认**拒绝**；`force:true` ⇒ 动，且回执写明丢弃了什么、分支**不**删。
//    ⚠ 本臂的夹具是**基点落后**的：分支自己只改 1 个文件，而基准（`origin/master`）往前推了 `MASTER_EXTRA` 个提交
//    ⇒ 「它自己的改动」（三点 `origin/master...branch` ＋ 两点 `rev-list`）与「并进基准的整体变化」（两点
//    `origin/master..branch`）**必然给出不同的数字**。老夹具里基点就是分支的父提交 ⇒ 两条式子结果相同，
//    下面 U9/U11 那两条断言在旧代码上也会绿（**抓不到 bug**）；基点落后了才有牙（U9/U10/U11/U12）。
//
// ⑦ 落位账（`placement.json`）补 cwd：宿主报了活会话、盘上没有会话文件那一类（旧的一票否决就是它）；
//    附带**三条**反证：①落位 cwd 在树里 ⇒ 仍拒；②落位账查不到 ⇒ 仍拒；③落位账**读不出来**
//    （`placement.ok === false`）⇒ 仍拒 —— 第三条原来只有代码路径、没有红臂，本笔补上现场（P12/P13/P14）。
//
// ⑥ `bin/wt-report.mjs` 与守卫**同一口径**：那批「宿主报了、盘上还没有会话文件」的活会话按落位账的
//    cwd 分三类（落在树里 ⇒ 照旧挡路；不住这棵树里 ⇒ 不再打 needs-human；连落位账也判不出 ⇒ 仍 needs-human），
//    并把「用的是哪份来源」写进报告（R8-R11）。报告本身仍**只读**（它从不调 `reclaimWorktree`、不删任何东西）；
//    R12 是这一臂**另外**用一次真工具调用，证「报告说可回收的那棵树，守卫真收得掉」。
//
// 反证臂（各自**必红**；各自在**副本树**上改插件源码，绝不动本仓文件）：
//   `--mutant=tree-projection`   ⇒ 「活会话」判据换成读 `/tree` 投影（**必红**：复现那次事故）；
//   `--mutant=ancestor-only`     ⇒ 「内容安全」判据换成只看「分支是祖先」＋不再让 git 自己兜底（**必红**：未提交改动真被删）；
//   `--mutant=placement-ignored` ⇒ 拿掉「用落位账补 cwd」那一步、回到旧行为（**必红**：放行那条）；
//   `--mutant=placement-unreadable-blind` ⇒ 落位账**读不出来**时把全体「活而无文件」的会话放行（**必红**：P13/P14）。
//   `--mutant=two-dot-own-changes` ⇒ 「它自己的改动」那步的**三点**退回**两点**（**必红**：U9/U11/U12 —— 就是本单修掉的那个 bug）。
//   子进程模式：`node test/wt-reclaim.mjs --arm=<臂> --code=<副本树>`，父进程断言它**红**且红在**预期的那一条**上；
//   也可以单独跑一条：`node test/wt-reclaim.mjs --mutant=<名字>`（在副本树上改，期望它**红**；红到位才算过）。

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox, runArms, stopSpawnedListener } from './harness.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

const argValue = (name) => {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
};
const ONLY_ARM = argValue('arm');
const ONLY_MUTANT = argValue('mutant');
const CODE_ROOT_ARG = argValue('code');

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 断言簿（一次把红条目列全；与 test/design-spec.mjs 同形）────────────────────────────────────
let checks = 0;
const failures = [];
function check(id, name, ok, detail) {
  checks += 1;
  const text = detail === undefined ? "" : (typeof detail === "string" ? detail : JSON.stringify(detail));
  if (ok) {
    process.stdout.write(`✓ [${id}] ${name}${text === "" ? "" : ` —— ${text}`}\n`);
    return true;
  }
  failures.push({ id, name });
  process.stdout.write(`✗ [${id}] ${name}${text === "" ? "" : ` —— ${text}`}\n`);
  return false;
}

// ── 沙箱：临时副本代码树（server/ + pi-extensions/ + node_modules 联接）──────────────────────────
async function sharedNodeModules() {
  const own = path.join(ROOT, 'node_modules');
  if (existsSync(own)) return { dir: own, source: 'the repository itself' };
  // worktree 通常没有自己的 node_modules（`spawn worktree:"new"` 只切出一棵新树，不装依赖）⇒
  // 顺着 git 的**公共目录**推主检出（与 `test/s0b.mjs` / `test/sandbox-hygiene.mjs` 同一口径）。
  let mainRepo = null;
  try {
    const common = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT });
    const commonDir = path.resolve(common.stdout.trim());
    mainRepo = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : ROOT;
  } catch {
    mainRepo = null;
  }
  const main = mainRepo ? path.join(mainRepo, 'node_modules') : null;
  if (!main || !existsSync(main)) throw new Error(`no node_modules at ${own} and none to link at ${main ?? '(unknown main checkout)'}; run npm ci first`);
  return { dir: main, source: `the main checkout ${main}` };
}

/** 造一棵可启动的副本代码树（**绝不在**真树里起宿主）。 */
async function copyCodeTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const part of ['server', 'pi-extensions']) await cp(path.join(source, part), path.join(target, part), { recursive: true });
  await cp(path.join(source, 'package.json'), path.join(target, 'package.json'));
  const modules = await sharedNodeModules();
  await symlink(modules.dir, path.join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return { target, modules: modules.source };
}

/** 从本仓造一棵（反证臂的副本也从**这棵沙箱树**再拷一份，而不是拷真树）。 */
async function prepareCodeTree(tmp, label) {
  return await copyCodeTree(ROOT, path.join(tmp, `code-${label}`));
}

// ── 反证臂：只在**副本树**上改插件源码 ────────────────────────────────────────────────────────
const MUTANTS = {
  'tree-projection': {
    arm: 'incident',
    expect: 'A9',
    expectAll: ['A9', 'A10'],
    description: '「活会话」判据换成读 /tree 投影字段（2026-09-24 事故的第一条判据）',
    apply: (source) => {
      const from = '  // 5) (c) 占用判据：会话文件 header（一手来源）+ 宿主活会话 id 的交叉核对。';
      const upto = '  // ── (c) end ──';
      const start = source.indexOf(from);
      const end = source.indexOf(upto);
      assert.ok(start >= 0 && end > start, '反证臂 tree-projection：插件里找得到那一整段占用判据');
      const mutant = [
        '  // ── (c) 占用判据（MUTANT tree-projection）：整段换成 2026-09-24 那次用的**投影**判据 ──',
        '  const treeReply = baseUrl ? await fetch(`${baseUrl}/tree`, { headers: { accept: "application/json" } }) : null;',
        '  const treeValue = treeReply && treeReply.ok ? await treeReply.json() : {};',
        '  const treeRows = Array.isArray(treeValue.sessions) ? treeValue.sessions : [];',
        '  const occupants = [];',
        '  for (const row of treeRows) {',
        '    if (row?.status !== "working") continue;',
        '    if (typeof row.cwd !== "string" || row.cwd.trim() === "") continue;',
        '    if (!pathInsideOrEqual(normalizeFsPath(row.cwd), normalizeFsPath(worktreePath))) continue;',
        '    occupants.push({ id: String(row.id).toLowerCase(), cwd: row.cwd, status: row.status, source: "tree-projection" });',
        '  }',
        '  receipt.steps.c_occupancy = { sources: ["host /tree projection — MUTANT (the 2026-09-24 criterion)"], worktreePath, occupants, occupantCount: occupants.length, treeRows: treeRows.length, treeProjectionUsed: true };',
        '  if (occupants.length > 0) return refusal(receipt, "live_session_in_worktree", `MUTANT: ${occupants.length} 条「树上正在跑」的会话落在这棵树里`, { occupants });',
      ].join('\n');
      return `${source.slice(0, start)}${mutant}\n${source.slice(end)}`;
    },
  },
  'placement-ignored': {
    arm: 'placement',
    expect: 'P3',
    expectAll: ['P3', 'P4', 'P5', 'P6'],
    description: '把「用 placement.json 的 cwd 补上」那一步拿掉（回到「盘上没有会话文件就一律当 cwd 不明」的旧行为）',
    apply: (source) => {
      const from = '  // ── (c-2) 第二份一手来源';
      const upto = '  // ── (c-2) placement cwd end ──';
      const start = source.indexOf(from);
      const end = source.indexOf(upto);
      assert.ok(start >= 0 && end > start, '反证臂 placement-ignored：插件里找得到「用落位账补 cwd」那一整段');
      const mutant = [
        '  // ── (c-2) MUTANT placement-ignored：不用落位账（回到「盘上没有 header 就一律不知道」的旧行为）──',
        '  const unknownCwdResolvedFrom = null;',
        '  const placementResolvedLive = [];',
        '  const stillUnknownCwdLive = liveWithoutHeader.map((id) => ({ id, cwd: null, source: "unresolved", placementKind: null, why: "MUTANT: placement.json is not consulted" }));',
      ].join('\n');
      return `${source.slice(0, start)}${mutant}\n${source.slice(end)}`;
    },
  },
  'ancestor-only': {
    arm: 'dirty',
    expect: 'D1',
    description: '「内容安全」判据换成只看「分支是 origin/master 的祖先」＋ 不再让 git 自己兜成底（2026-09-24 的第二条判据，连同那条路径的直接删）',
    apply: (source) => {
      const from = '  const contentSafe = content.contentSafe && dirty.ok === true && dirty.count === 0 && ignoredCount === 0;';
      assert.ok(source.includes(from), '反证臂 ancestor-only：插件里找得到那条内容安全判据');
      const removalFrom = '  const removal = await runGit(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], mainRepo);';
      assert.ok(source.includes(removalFrom), '反证臂 ancestor-only：插件里找得到那条 worktree remove 调用');
      return source
        .replace(from, '  // MUTANT ancestor-only：只看祖先，不看差异、也不看工作区（2026-09-24 的判据）。\n  const contentSafe = content.ancestor;')
        .replace(removalFrom, '  // MUTANT ancestor-only：既然「只看了祖先就认定安全」，那条历史路径就不会再让 git 自己兜底了。\n  const removal = await runGit(["worktree", "remove", "--force", worktreePath], mainRepo);');
    },
  },
  'placement-unreadable-blind': {
    arm: 'placement',
    expect: 'P13',
    expectAll: ['P13', 'P14'],
    description: '落位账**读不出来**（`placement.ok === false`）时把「活而无文件」的会话全体放行 —— 等于把「不许猜」放宽成「看不见就当它不在这棵树里」',
    apply: (source) => {
      const from = '  if (stillUnknownCwdLive.length > 0) {';
      assert.ok(source.includes(from), '反证臂 placement-unreadable-blind：插件里找得到那条「仍然看不出 cwd ⇒ 拒」的判据');
      return source.replace(from, '  // MUTANT placement-unreadable-blind：只在落位账**读得出来**时才拒（读不出来 ⇒ 全体放行）。\n  if (placement.ok === true && stillUnknownCwdLive.length > 0) {');
    },
  },
  'two-dot-own-changes': {
    arm: 'unmerged',
    expect: 'U9',
    expectAll: ['U9', 'U11', 'U12'],
    description: '把「它自己的改动」那步的**三点**（`origin/master...<branch>` = merge-base → 分支 tip）退回**两点**（`origin/master..<branch>` = 两条 tip 的差异）—— 就是本单修掉的那个 bug（文件数与提交数描述的不是同一件事）',
    apply: (source) => {
      const from = '  const ownRun = await runGit(["diff", "--numstat", `${baseRef}...${branchRef}`], repo);';
      const to = '  const ownRun = await runGit(["diff", "--numstat", `${baseRef}..${branchRef}`], repo); // reverse arm: 三点退回两点（两条 tip 的差异）';
      assert.ok(source.includes(from), '反证臂 two-dot-own-changes：插件里找得到那条三点 diff（它自己的改动）');
      return source.replace(from, to);
    },
  },
};

async function applyMutant(codeRoot, name) {
  const spec = MUTANTS[name];
  assert.ok(spec, `unknown mutant ${name}`);
  const file = path.join(codeRoot, 'pi-extensions', 'assistant', 'reclaim-worktree.mjs');
  const before = await readFile(file, 'utf8');
  const after = spec.apply(before);
  assert.notEqual(after, before, `mutant ${name} must actually change the source`);
  await writeFile(file, after);
  await execFileAsync(process.execPath, ['--check', file]); // 变体必须还是合法 JS
  print('reverse-arm mutation', { mutant: name, arm: spec.arm, expect: spec.expect, expectedRed: spec.description, file: 'pi-extensions/assistant/reclaim-worktree.mjs (copy only)' });
}

// ── 假 provider：不联网、不调真模型；`RECLAIM <uuid> [force]` = 唯一的口令（其余一律回 FAKE_OK）──
const MODEL = 'fake-wtreclaim';
function sseChunk(delta, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } : {}),
  };
}
function lastUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part.text || '').join('');
  }
  return '';
}
function lastToolResultText(messages = []) {
  const last = messages.at(-1);
  if (!last || last.role !== 'tool') return '';
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}
function toolCall(name, args) {
  return sseChunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${name}-${Math.random().toString(16).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
}

async function startProvider(port) {
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const part of incoming) raw += part;
    const body = JSON.parse(raw);
    const prompt = lastUserText(body.messages);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const emitText = (text) => {
      response.write(`data: ${JSON.stringify(sseChunk({ role: 'assistant', content: text }))}\n\n`);
      response.write(`data: ${JSON.stringify(sseChunk({}, 'stop', true))}\n\n`);
      response.end('data: [DONE]\n\n');
    };
    const emitTool = (name, args) => {
      response.write(`data: ${JSON.stringify(toolCall(name, args))}\n\n`);
      response.write(`data: ${JSON.stringify(sseChunk({}, 'tool_calls', true))}\n\n`);
      response.end('data: [DONE]\n\n');
    };
    if (body.messages.at(-1)?.role === 'tool') {
      // 第二跳：把工具**回执原文**回显回来（门从 `/messages` 里逐字读回并 JSON.parse）。
      return emitText(/^RECLAIM /.test(prompt) ? `WT_ECHO ${lastToolResultText(body.messages)}` : 'FAKE_OK');
    }
    const reclaim = /^RECLAIM (\S+)(?:\s+(force))?/.exec(prompt);
    if (reclaim) return emitTool('reclaim_worktree', { id: reclaim[1], ...(reclaim[2] ? { force: true } : {}) });
    return emitText('FAKE_OK');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server };
}

async function reservePort(excluded = new Set()) {
  for (let candidate = 20000 + Math.floor(Math.random() * 30000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('no high port available');
}

// ── 沙箱启动：真宿主 ＋ 真 git 仓库（含裸远端 origin）＋ 临时 home ─────────────────────────────────
async function bootSandbox({ codeRoot, tmp, label }) {
  const home = path.join(tmp, 'home');
  const sessions = path.join(home, 'sessions');
  await mkdir(sessions, { recursive: true });
  const repo = path.join(tmp, 'main');
  const outside = path.join(tmp, 'outside');
  await mkdir(outside, { recursive: true });
  const inside = (args) => ['-c', 'user.email=sandbox@example.invalid', '-c', 'user.name=sandbox', ...args];
  await mkdir(repo, { recursive: true });
  await execFileAsync('git', ['init', '-b', 'master'], { cwd: repo });
  await writeFile(path.join(repo, 'README.md'), '# sandbox main tree\n');
  await writeFile(path.join(repo, '.gitignore'), 'node_modules\n');
  await execFileAsync('git', inside(['add', '-A']), { cwd: repo });
  await execFileAsync('git', inside(['commit', '-m', 'sandbox init']), { cwd: repo });
  const origin = path.join(tmp, 'origin.git');
  await execFileAsync('git', ['init', '--bare', '-b', 'master', origin], { cwd: tmp });
  await execFileAsync('git', ['remote', 'add', 'origin', origin], { cwd: repo });
  await execFileAsync('git', ['push', '-u', 'origin', 'master'], { cwd: repo });

  const used = new Set();
  const providerPort = await reservePort(used); used.add(providerPort);
  const basePort = await reservePort(used); used.add(basePort);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: MODEL, name: 'Fake worktree reclaim', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: MODEL, defaultThinkingLevel: 'off', compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 1 } }, null, 2)}\n`);

  const provider = await startProvider(providerPort);
  const logPath = path.join(tmp, `base-${label}.log`);
  const log = await open(logPath, 'w');
  const child = spawn(process.execPath, [path.join(codeRoot, 'server', 'base.mjs')], {
    cwd: codeRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: repo,
      SOPHO_MAX_HOT: '8',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  const sandbox = { tmp, label, codeRoot, home, sessions, repo, outside, origin, basePort, providerPort, provider, child, log, logPath };
  await poll(`${label}: base /host`, () => api(sandbox, '/host'), (reply) => reply.status === 200, 60_000);
  return sandbox;
}

async function shutdownSandbox(sandbox, problems) {
  if (!sandbox) return;
  await cleanupStep(problems, `${sandbox.label}: stop base listener`, async () => {
    await stopSpawnedListener(sandbox.child, sandbox.basePort, path.join(sandbox.codeRoot, 'server', 'base.mjs'));
  });
  await cleanupStep(problems, `${sandbox.label}: stop fake provider`, async () => {
    await new Promise((resolve) => sandbox.provider?.server?.close(() => resolve()));
  });
  await cleanupStep(problems, `${sandbox.label}: close base log`, async () => { await sandbox.log?.close(); });
}

// ── HTTP / 轮询小工具 ─────────────────────────────────────────────────────────────────────────
async function api(sandbox, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${sandbox.basePort}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let value;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = raw; }
  return { status: response.status, raw, value };
}

async function poll(label, operation, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(50);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

const gitOut = async (args, cwd) => (await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const gitCode = async (args, cwd) => {
  try {
    await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return 0;
  } catch (error) {
    return typeof error.code === 'number' ? error.code : 1;
  }
};

async function sessionFileOf(sandbox, sessionId) {
  const rows = await readdir(sandbox.sessions, { recursive: true });
  const hit = rows.find((entry) => typeof entry === 'string' && entry.endsWith(`${sessionId}.jsonl`));
  return hit ? path.join(sandbox.sessions, hit) : null;
}

async function messagesOf(sandbox, sessionId) {
  const reply = await api(sandbox, `/sessions/${sessionId}/messages`);
  assert.equal(reply.status, 200, reply.raw);
  return reply.value.messages;
}

async function detailOf(sandbox, sessionId) {
  const reply = await api(sandbox, `/sessions/${sessionId}`);
  assert.equal(reply.status, 200, reply.raw);
  return reply.value;
}

async function waitIdle(sandbox, sessionId) {
  return poll(`session ${sessionId} settles`, () => api(sandbox, `/sessions/${sessionId}`), (reply) => reply.value?.runtime?.isStreaming === false
    && reply.value?.runtime?.isCompacting === false
    && (reply.value?.pendingMessages ?? 0) === 0, 90_000);
}

async function createSession(sandbox, cwd, name) {
  const created = await api(sandbox, '/sessions', { method: 'POST', body: { cwd, name } });
  assert.equal(created.status, 201, created.raw);
  const id = created.value.id;
  assert.equal((await api(sandbox, `/sessions/${id}/message`, { method: 'POST', body: { text: 'WARM' } })).status, 202);
  await waitIdle(sandbox, id);
  assert.ok(await sessionFileOf(sandbox, id), `${name} 热身之后必须落盘（占用判据读的就是这个 header）`);
  return id;
}

async function archiveSession(sandbox, id, by = null) {
  // `by` 只作审计且**必须**是完整 uuid（路由自己的校验）⇒ 传调用方会话 id 或干脆不传。
  const reply = await api(sandbox, `/sessions/${id}/archive`, { method: 'POST', body: { archived: true, ...(by ? { by } : {}) } });
  assert.equal(reply.status, 200, reply.raw);
  assert.equal(reply.value.archived, true, reply.raw);
  return reply.value;
}

/** 宿主 `/host` 报的活会话 id（与本仓守卫 `probeLiveSessions` 读的是同一份 workers/drainingGenerations 形状）。 */
async function hostLiveIds(sandbox) {
  const reply = await api(sandbox, '/host');
  const rows = [...(reply.value?.workers ?? []), ...(reply.value?.drainingGenerations ?? [])];
  const ids = new Set();
  for (const row of rows) for (const id of (row?.sessions ?? [])) if (typeof id === 'string') ids.add(id.toLowerCase());
  return [...ids];
}

/**
 * 造一条「宿主知道它活着、盘上还没有它的会话文件」的会话 —— 这正是拦住整个回收路径的那种形状。
 * 本仓实测（2026-10-05，沙箱）：`POST /sessions` 就会让宿主把它记进 sessionOwners（⇒ `/host` 报它），
 * 而 pi 的会话文件要等**第一条消息**才落盘 ⇒ 不热身就能稳定造出「活但无文件」。
 * 落位账（placement.json）在创建时就已经写下它的 cwd。
 */
async function createPendingSession(sandbox, body, name) {
  const created = await api(sandbox, '/sessions', { method: 'POST', body: { ...body, name } });
  assert.equal(created.status, 201, created.raw);
  const id = created.value.id;
  await poll(`/host reports the pending session ${id}`, () => hostLiveIds(sandbox), (ids) => ids.includes(id), 30_000);
  return { id, placement: created.value.placement ?? null };
}

/**
 * 直接调那条**导出路径**（不经宿主工具调用）—— 反证臂③必须有它，原因在**宿主自己**：
 * 宿主的 `readPlacementConfig()` 碰上非法 JSON 会抛 500 `placement-config-invalid`，而 `assertNotMoved()`
 * （每条会话路由上都要过，包括门自己发的那条 message POST）与 `/sessions` 的 placementView 都会读**同一份**文件
 * ⇒ 把沙箱里那份 placement.json 弄坏，连宿主都跑不下去（那一跑还没到守卫就先 500 了）。
 * 所以现场用**副本 home**（里面只有一份非法 placement.json，**绝不动真 profile**）＋ 同一份会话目录，
 * 直接调守卫那个导出函数 —— `env` 就是它给这种「换一个 home 量」留的参数。
 * 从 **CODE_ROOT** 动态 import：反证臂给的是那棵被改过的副本树，这样变异才作用得到本臂。
 */
async function callGuardInProcess(sandbox, sessionId, ledgerHome) {
  const module = await import(pathToFileURL(path.join(CODE_ROOT, 'pi-extensions', 'assistant', 'reclaim-worktree.mjs')).href);
  return await module.reclaimWorktree({
    sessionId,
    callerCwd: sandbox.repo,
    baseUrl: `http://127.0.0.1:${sandbox.basePort}`,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: ledgerHome,
      ASSIST_HOME: ledgerHome,
      SOPHO_AGENT_DIR: ledgerHome,
      PI_CODING_AGENT_SESSION_DIR: sandbox.sessions,
      SOPHO_SESSION_DIR: sandbox.sessions,
    },
  });
}

async function callTool(sandbox, callerId, promptText) {
  const before = (await messagesOf(sandbox, callerId)).length;
  const posted = await api(sandbox, `/sessions/${callerId}/message`, { method: 'POST', body: { text: promptText } });
  assert.equal(posted.status, 202, posted.raw);
  const echoed = await poll(`tool echo for "${promptText}"`, async () => {
    const rows = await messagesOf(sandbox, callerId);
    return rows.slice(before).find((message) => message.role === 'assistant' && typeof message.text === 'string' && message.text.startsWith('WT_ECHO ')) ?? null;
  }, (found) => Boolean(found), 90_000);
  const receipt = parseEcho(echoed.text);
  print(`tool receipt ${promptText}`, receipt);
  return receipt;
}

/** 回显里层是插件 `toolResult()` 的 JSON（可能是 `[{type:'text',text}]` 也可能是对象本身）。 */
function parseEcho(text) {
  const parsed = JSON.parse(text.slice('WT_ECHO '.length));
  if (Array.isArray(parsed)) return JSON.parse(parsed.map((part) => part.text ?? '').join(''));
  if (parsed && typeof parsed === 'object') return parsed;
  return JSON.parse(String(parsed));
}

/** 目录快照（文件清单 + 每个文件的 sha256）——「一字未动」的判据。目录不在就回 null（那是**红**，不是崩）。 */
async function snapshotDirectory(root) {
  if (!(await stat(root).then((info) => info.isDirectory()).catch(() => false))) return null;
  const rows = {};
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) rows[path.relative(root, full).split(path.sep).join('/')] = createHash('sha256').update(await readFile(full)).digest('hex');
    }
  };
  await walk(root);
  return rows;
}

const worktreeList = async (sandbox) => gitOut(['worktree', 'list', '--porcelain'], sandbox.repo);
const normalizePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const worktreePaths = async (sandbox) => (await worktreeList(sandbox)).split(/\r?\n/)
  .filter((line) => line.startsWith('worktree '))
  .map((line) => normalizePath(line.slice('worktree '.length).trim()));

/** 所有已注册 worktree 的目录快照（“报告没动任何目录”的判据）。 */
async function snapshotWorktrees(sandbox) {
  const snapshot = {};
  for (const entry of (await worktreeList(sandbox)).split(/\r?\n/).filter((line) => line.startsWith('worktree '))) {
    const dir = path.resolve(entry.slice('worktree '.length).trim());
    if (existsSync(dir)) snapshot[normalizePath(dir)] = await snapshotDirectory(dir);
  }
  return snapshot;
}

// ── 场景搭建 ────────────────────────────────────────────────────────────────────────────────
async function addWorktree(sandbox, slug) {
  const wt = path.join(path.dirname(sandbox.repo), '.sopho-wt', slug);
  await mkdir(path.dirname(wt), { recursive: true });
  await execFileAsync('git', ['worktree', 'add', '-b', `wt/${slug}`, wt, 'HEAD'], { cwd: sandbox.repo });
  return wt;
}

const commitIn = async (cwd, message) => {
  await execFileAsync('git', ['-c', 'user.email=sandbox@example.invalid', '-c', 'user.name=sandbox', 'add', '-A'], { cwd });
  await execFileAsync('git', ['-c', 'user.email=sandbox@example.invalid', '-c', 'user.name=sandbox', 'commit', '-m', message], { cwd });
};

/** `/tree` 那一眼里这棵树长什么样（**只用来当证据**：事故判据②读的就是它）。 */
async function treeRowsFor(sandbox, worktree) {
  const reply = await api(sandbox, '/tree');
  const rows = (reply.value?.sessions ?? []).filter((row) => typeof row.cwd === 'string' && row.cwd.trim() !== ''
    && path.resolve(row.cwd).toLowerCase() === path.resolve(worktree).toLowerCase());
  return { status: reply.status, rows };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────────────────
let SANDBOX = null;
let CODE_ROOT = null;
const problems = [];
// 沙箱目录前缀**只复用已有那两个字面量**（`wtreclaim-arm-` / `wtreclaim-gate-`）：
// `test/sandbox-hygiene.mjs` 的 sweep-dir-prefixes 臂是按**源码里的字面量**推导「门会建哪些前缀」的，
// 多写一个新前缀就得连推导集一起改；而「单独跑一条反证臂」只是同一个「臂」入口，不需要新形状。
const ARM_LABEL = ONLY_ARM ?? ONLY_MUTANT;

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), ARM_LABEL ? `wtreclaim-arm-${ARM_LABEL}-` : 'wtreclaim-gate-'));
  let primaryError = null;
  try {
    if (ONLY_MUTANT) {
      // 单独跑一条反证臂：在**副本树**上施加变异，信**那棵副本**起宿主与工具（真树一个字节不动）。
      const spec = MUTANTS[ONLY_MUTANT];
      assert.ok(spec, `unknown mutant ${ONLY_MUTANT}（可选：${Object.keys(MUTANTS).join(' / ')}）`);
      const mutantRoot = path.join(tmp, `code-mutant-${ONLY_MUTANT}`);
      await copyCodeTree(ROOT, mutantRoot);
      await applyMutant(mutantRoot, ONLY_MUTANT);
      CODE_ROOT = mutantRoot;
      print('standalone reverse arm', { mutant: ONLY_MUTANT, arm: spec.arm, expectRed: spec.expectAll ?? [spec.expect], codeRoot: mutantRoot, readOnly: 'real .sopho-wt/ and the real profile are never touched' });
    } else {
      const prepared = CODE_ROOT_ARG ? { target: CODE_ROOT_ARG, modules: '(given by --code)' } : await prepareCodeTree(tmp, 'clean');
      CODE_ROOT = prepared.target;
      print('sandbox', { tmp, codeRoot: CODE_ROOT, nodeModules: prepared.modules, onlyArm: ONLY_ARM, readOnly: 'real .sopho-wt/ and the real profile are never touched' });
    }
    SANDBOX = await bootSandbox({ codeRoot: CODE_ROOT, tmp, label: ARM_LABEL ?? 'gate' });
    print('sandbox base', { basePort: SANDBOX.basePort, providerPort: SANDBOX.providerPort, home: SANDBOX.home, repo: SANDBOX.repo, pid: SANDBOX.child.pid });

    if (ONLY_MUTANT) {
      await runStandaloneMutant(ONLY_MUTANT);
    } else if (ONLY_ARM) {
      await runOneArm(ONLY_ARM);
    } else {
      await runAllArms(tmp);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    await shutdownSandbox(SANDBOX, problems);
    await removeSandbox(tmp, problems, 'remove sandbox');
    const expectedRedNote = ONLY_MUTANT ? `（单独反证臂 ${ONLY_MUTANT}：这些红是**期望**的结果，不是缺陷）` : '';
    process.stdout.write(`\n──── wt-reclaim gate: ${checks} check(s) — ${checks - failures.length} green / ${failures.length} red${expectedRedNote} ────\n`);
    for (const failure of failures) process.stdout.write(`FAIL  [${failure.id}] ${failure.name}\n`);
    // 单独跑一条反证臂时，「红」正是要的结果 ⇒ 退出码由 `runStandaloneMutant` 自己判（它就在上面跑）。
    if (failures.length > 0 && !ONLY_MUTANT) process.exitCode = 1;
    finishCleanup(primaryError, problems);
  }
}

/**
 * 单独跑一条反证臂（`--mutant=<名字>`）：跑完在**这一份进程里**判定「它红了、且红在预期的那几条上」。
 * 红到位 ⇒ 退出码 0（这是**期望**的结果）；没红到位 ⇒ 非 0（那才是「这条臂是假臂」的证据）。
 */
async function runStandaloneMutant(name) {
  const spec = MUTANTS[name];
  const before = failures.length;
  await ARMS[spec.arm](SANDBOX);
  const captured = failures.slice(before);
  const red = captured.map((failure) => failure.id);
  const required = spec.expectAll ?? [spec.expect];
  const missing = required.filter((id) => !red.includes(id));
  print('standalone reverse arm result', {
    mutant: name,
    arm: spec.arm,
    what: spec.description,
    expectRed: required,
    actuallyRed: red,
    redEvidence: captured.map((failure) => `✗ [${failure.id}] ${failure.name}`),
    verdict: missing.length === 0 ? '红到位（这是**期望**的结果，不是缺陷）' : '**没红到位** ⇒ 这条臂是假臂',
  });
  if (missing.length !== 0) {
    print('RESULT', `单独反证臂 ${name} **没红到位**：该红却没红的是 ${JSON.stringify(missing)}（实际红了 ${JSON.stringify(red)}）`);
    process.exitCode = 1;
  } else {
    print('RESULT', `单独反证臂 ${name} 红到位（这是**期望**的结果）：${required.join(' + ')} 都红了（一共 ${red.length} 条红）`);
  }
}

/** 单臂模式（反证臂的靶子）：臂内任一 `check` 红 ⇒ 退出码非 0，且红条目**带 id**。 */
async function runOneArm(arm) {
  const runner = ARMS[arm];
  assert.ok(runner, `unknown arm ${arm}`);
  const before = failures.length;
  await runner(SANDBOX);
  if (failures.length > before) {
    throw new Error(`arm ${arm}: ${failures.length - before} check(s) failed in this arm: ${failures.slice(before).map((failure) => `[${failure.id}] ${failure.name}`).join('; ')}`);
  }
  process.stdout.write(`arm ${arm}: all checks green\n`);
}

// ── 各臂 ────────────────────────────────────────────────────────────────────────────────────
const CALLER = { id: null };

async function ensureCaller(sandbox) {
  if (CALLER.id) return CALLER.id;
  CALLER.id = await createSession(sandbox, sandbox.repo, 'maintainer (caller)');
  return CALLER.id;
}

const ARMS = {
  // ① 事故现场重建
  async incident(sandbox) {
    const caller = await ensureCaller(sandbox);
    const worktree = await addWorktree(sandbox, 'incident');
    const archived = await createSession(sandbox, worktree, 'A (archived, looks reclaimable)');
    const working = await createSession(sandbox, worktree, 'B (working here, nothing committed)');
    await writeFile(path.join(worktree, 'work-in-progress.txt'), 'the uncommitted work the 2026-09-24 incident destroyed\n');
    const archive = await archiveSession(sandbox, archived, caller);

    // 两条历史判据在这一刻的**实测值**（它们都说「安全」——这就是那次事故）。
    const ancestorCode = await gitCode(['merge-base', '--is-ancestor', 'wt/incident', 'origin/master'], sandbox.repo);
    const tree = await treeRowsFor(sandbox, worktree);
    print('incident evidence: criterion ① (branch is an ancestor of origin/master)', { branch: 'wt/incident', mergeBaseIsAncestorExitCode: ancestorCode, saysSafe: ancestorCode === 0 });
    print('incident evidence: criterion ② (the /tree projection, read raw)', { status: tree.status, rowCount: tree.rows.length, rows: tree.rows.map((row) => ({ id: row.id, status: row.status, cwd: row.cwd, archived: row.archived })), workingRows: tree.rows.filter((row) => row.status === 'working').length });

    const before = await snapshotDirectory(worktree);
    const receipt = await callTool(sandbox, caller, `RECLAIM ${archived}`);
    const after = await snapshotDirectory(worktree);

    check('A1', '事故现场：**拒绝**（还有会话的 cwd 落在这棵树里）', receipt.ok === false && receipt.reason === 'live_session_in_worktree', { ok: receipt.ok, reason: receipt.reason, blockedBy: receipt.blockedBy });
    check('A2', '拒绝回执**点名**了那条会话（B 的完整 uuid）', (receipt.occupants ?? []).some((occupant) => occupant.id === working), receipt.occupants ?? []);
    check('A3', '回执如实：目标会话确实已归档，拒绝不是因为它', receipt.steps?.a_archived?.archived === true && archive.archived === true, receipt.steps?.a_archived ?? null);
    check('A4', 'B 的目录**一字未动**（目录还在）', await stat(worktree).then((info) => info.isDirectory()).catch(() => false), worktree);
    check('A5', 'B 的未提交改动**逐字节还在**', JSON.stringify(before) === JSON.stringify(after), { before: Object.keys(before ?? {}), after: after === null ? '(目录已不在)' : Object.keys(after) });
    check('A6', '（复现前提）判据①单独用会说「安全」：分支是 origin/master 的祖先', ancestorCode === 0, { mergeBaseIsAncestorExitCode: ancestorCode });
    check('A7', '（复现前提）判据②单独用也会说「安全」：/tree 里没有「正在跑」的行', tree.rows.filter((row) => row.status === 'working').length === 0, { workingRows: tree.rows.filter((row) => row.status === 'working').length, rows: tree.rows.length });
    check('A8', '占用判据的来源**不是** /tree 投影（回执自己写了来源）', receipt.steps?.c_occupancy?.treeProjectionUsed === false && Array.isArray(receipt.steps?.c_occupancy?.sources) && receipt.steps.c_occupancy.sources.some((source) => source.includes('first-hand')), receipt.steps?.c_occupancy?.sources ?? null);

    // force 也**不放宽** (c)：这一条是「拿未提交的工作去赌」的护栏。
    const forced = await callTool(sandbox, caller, `RECLAIM ${archived} force`);
    const afterForce = await snapshotDirectory(worktree);
    check('A9', 'force:true 也**不放宽**「有会话住在这棵树里」', forced.ok === false && forced.reason === 'live_session_in_worktree' && forced.changed === false, { ok: forced.ok, reason: forced.reason });
    check('A10', 'force 之后目录与文件仍然一字未动', JSON.stringify(before) === JSON.stringify(afterForce), { after: afterForce === null ? '(目录已不在 —— 未提交改动真的被删了)' : Object.keys(afterForce) });
  },

  // ② 干净 ⇒ 成功 ＋ 幂等 ＋ id 护栏
  async success(sandbox) {
    const caller = await ensureCaller(sandbox);
    const worktree = await addWorktree(sandbox, 'safe');
    const session = await createSession(sandbox, worktree, 'D (archived, nothing to lose)');
    await archiveSession(sandbox, session);

    const receipt = await callTool(sandbox, caller, `RECLAIM ${session}`);
    check('S1', '已归档 ＋ 无别的会话 ＋ 零差异 ⇒ **成功**', receipt.ok === true && receipt.reason === 'reclaimed' && receipt.removed === true && receipt.changed === true, { ok: receipt.ok, reason: receipt.reason, note: receipt.note });
    check('S2', '目录**真的**没了', await stat(worktree).then(() => false).catch(() => true), worktree);
    check('S3', '注册项也没了（git worktree list 里查不到）', !(await worktreePaths(sandbox)).includes(normalizePath(worktree)), { listed: (await worktreePaths(sandbox)).length });
    check('S4', '内容安全 ⇒ 分支也删了', receipt.branchDeleted === true && (await gitOut(['branch', '--list', 'wt/safe'], sandbox.repo)) === '', receipt.steps?.e_removal ?? null);
    check('S5', '回执如实带 git 的原始输出与命令', typeof receipt.steps?.e_removal?.code === 'number' && receipt.steps.e_removal.code === 0 && typeof receipt.steps.e_removal.command === 'string' && receipt.steps.e_removal.worktreeGone === true, receipt.steps?.e_removal ?? null);

    const again = await callTool(sandbox, caller, `RECLAIM ${session}`);
    check('S6', '幂等：再调一次 ⇒ ok:true / alreadyReclaimed:true / changed:false', again.ok === true && again.alreadyReclaimed === true && again.changed === false && again.removed === false, { ok: again.ok, reason: again.reason, changed: again.changed, alreadyReclaimed: again.alreadyReclaimed });
    check('S7', '幂等回执照实说「没东西可收」', typeof again.note === 'string' && /幂等|没有东西可收/.test(again.note), again.note);
    check('S8', '幂等回执说清 mainRepo 是怎么推出来的', typeof again.steps?.alreadyGone?.mainRepoFrom === 'string', again.steps?.alreadyGone?.mainRepoFrom ?? null);

    const short = await callTool(sandbox, caller, `RECLAIM ${session.slice(0, 8)}`);
    check('S9', '片段 uuid ⇒ 如实拒绝（full_uuid_required），一个字没动', short.ok === false && short.reason === 'full_uuid_required' && short.changed === false, { ok: short.ok, reason: short.reason });
    const unknown = await callTool(sandbox, caller, `RECLAIM 99999999-9999-4999-8999-999999999999`);
    check('S10', '不存在的完整 uuid ⇒ 如实拒绝（session_not_found）', unknown.ok === false && unknown.reason === 'session_not_found', { ok: unknown.ok, reason: unknown.reason, note: unknown.note });

    // 给「候选报告」臂留一条**干净、可回收**的树（报告臂要能验「可回收」那条建议是真的可执行）。
    const cleanWorktree = await addWorktree(sandbox, 'clean-for-report');
    const cleanSession = await createSession(sandbox, cleanWorktree, 'I (archived, clean, left for the report arm)');
    await archiveSession(sandbox, cleanSession);
    print('success arm leftovers for the report arm', { cleanWorktree, cleanSession });
  },

  // ③ 有未并入差异 ⇒ 默认拒绝；force 才动，且分支不删
  //
  // 夹具的**关键**：分支自己只改 1 个文件，而基准（`origin/master`）在分支切出去之后往前推 `MASTER_EXTRA`
  // 个提交（各一个只在基准侧存在的文件）⇒ 分支的基点就**落后**了：
  //   · 它自己的改动（三点 `origin/master...wt/unmerged`）= 1 个文件；
  //   · 并进基准的整体变化（两点 `origin/master..wt/unmerged`）= 1 + MASTER_EXTRA 个文件。
  // 老夹具里基点＝分支的父提交 ⇒ 两条式子结果相同 ⇒ 「两个数字描述同一件事」那条断言在旧代码上也绿（抓不到 bug）。
  async unmerged(sandbox) {
    const MASTER_EXTRA = 3;
    const caller = await ensureCaller(sandbox);
    const worktree = await addWorktree(sandbox, 'unmerged');
    await writeFile(path.join(worktree, 'committed-but-not-merged.txt'), 'committed on the branch only\n');
    await commitIn(worktree, 'work that never reached origin/master');
    // —— 让这条分支的**基点落后**（先把基准往前推 MASTER_EXTRA 个提交）——
    for (let index = 1; index <= MASTER_EXTRA; index += 1) {
      await writeFile(path.join(sandbox.repo, `unmerged-arm-master-only-${index}.txt`), `master only ${index} (unmerged-arm fixture)\n`);
      await commitIn(sandbox.repo, `unmerged-arm fixture: master-only ${index}`);
    }
    await execFileAsync('git', ['push', 'origin', 'master'], { cwd: sandbox.repo });
    const mergeBaseSha = await gitOut(['merge-base', 'origin/master', 'wt/unmerged'], sandbox.repo);
    const mergeBaseDate = await gitOut(['log', '-1', '--format=%ci', mergeBaseSha], sandbox.repo);
    const ownThreeDot = await gitOut(['diff', '--numstat', 'origin/master...wt/unmerged'], sandbox.repo);
    const twoTipTwoDot = await gitOut(['diff', '--numstat', 'origin/master..wt/unmerged'], sandbox.repo);
    print('unmerged arm fixture (base behind by design)', { MASTER_EXTRA, mergeBaseSha, mergeBaseDate, ownThreeDot: ownThreeDot.replace(/\n/g, ' | '), twoTipTwoDot: twoTipTwoDot.replace(/\n/g, ' | ') });
    check('U0', '夹具自检：基点确实**落后**了（三点与两点必然给出不同读数；否则下面那条断言抓不到 bug）',
      ownThreeDot.split('\n').filter((line) => line.trim() !== '').length === 1
      && twoTipTwoDot.split('\n').filter((line) => line.trim() !== '').length === 1 + MASTER_EXTRA
      && mergeBaseSha !== (await gitOut(['rev-parse', 'origin/master'], sandbox.repo)),
      { ownFiles: ownThreeDot.split('\n').filter((line) => line.trim() !== '').length, twoTipFiles: twoTipTwoDot.split('\n').filter((line) => line.trim() !== '').length, expected: { own: 1, twoTip: 1 + MASTER_EXTRA }, mergeBaseSha, baseTip: await gitOut(['rev-parse', 'origin/master'], sandbox.repo) });
    const session = await createSession(sandbox, worktree, 'E (archived, but has unmerged commits)');
    await archiveSession(sandbox, session);

    const refused = await callTool(sandbox, caller, `RECLAIM ${session}`);
    check('U1', '有未并入差异 ⇒ 默认**拒绝**', refused.ok === false && refused.reason === 'unmerged_changes' && refused.changed === false, { ok: refused.ok, reason: refused.reason, note: refused.note });
    check('U2', '拒绝回执给出差异规模（文件数/增删行）', (refused.unmerged?.files ?? 0) >= 1 && typeof refused.unmerged?.added === 'number', refused.unmerged ?? null);
    check('U3', '拒绝时目录与文件都还在', await stat(path.join(worktree, 'committed-but-not-merged.txt')).then(() => true).catch(() => false), worktree);

    // U9-U11：本单的核心 —— 「未并入」那组数字必须描述**它自己的改动**，并与「并进基准的整体变化」分开说。
    check('U9', '「未并入」那组数字是**它自己的改动**（三点文件数 ＋ 两点提交数 = 同一件事），不是两条 tip 的差异',
      refused.unmerged?.commitsAhead === 1
      && refused.unmerged?.files === 1
      && refused.unmerged?.added === 1
      && refused.unmerged?.deleted === 0
      && refused.unmerged?.vsMasterTwoDot?.files === 1 + MASTER_EXTRA
      && refused.unmerged?.vsMasterTwoDot?.added === 1
      && refused.unmerged?.vsMasterTwoDot?.deleted === MASTER_EXTRA
      && refused.unmerged?.files !== refused.unmerged?.vsMasterTwoDot?.files,
      { unmerged: refused.unmerged ?? null,
        expected: { commitsAhead: 1, files: 1, added: 1, deleted: 0, vsMasterTwoDot: { files: 1 + MASTER_EXTRA, added: 1, deleted: MASTER_EXTRA } },
        fixture: { mergeBaseSha, own: 'origin/master...wt/unmerged (three-dot)', vsMasterTwoDot: 'origin/master..wt/unmerged (two-dot)' },
        why: 'files/added/deleted 必须 = 三点（它自己那一笔）；两条 tip 的差异另存 vsMasterTwoDot，绝不混进这组' });
    check('U10', '「未并入」读数把**分叉点**摊在明面上（mergeBase.sha/date = 夹具自己量的那个）',
      refused.unmerged?.mergeBase?.sha === mergeBaseSha
      && typeof refused.unmerged?.mergeBase?.date === 'string'
      && refused.unmerged?.mergeBase?.date === mergeBaseDate
      && mergeBaseDate.length > 0,
      { mergeBase: refused.unmerged?.mergeBase ?? null, expected: { sha: mergeBaseSha, date: mergeBaseDate } });
    check('U11', '拒绝回执那句话**分得清**「它自己的改动」与「并进 master 的整体变化」（与归档提示逐字同源）',
      String(refused.note ?? '').includes('这 1 个提交自己改了 1 个文件')
      && String(refused.note ?? '').includes('不是它自己的改动')
      && String(refused.note ?? '').includes(`并进 origin/master 会带来 ${1 + MASTER_EXTRA} 个文件的变化`),
      { note: refused.note ?? null, expectedSubstrings: ['这 1 个提交自己改了 1 个文件', '不是它自己的改动', `并进 origin/master 会带来 ${1 + MASTER_EXTRA} 个文件的变化`] });

    const forced = await callTool(sandbox, caller, `RECLAIM ${session} force`);
    check('U4', 'force:true ⇒ 动（目录真没了）', forced.ok === true && forced.removed === true, { ok: forced.ok, reason: forced.reason, note: forced.note });
    check('U5', '强制回收的**回执逐字写明丢了什么**', forced.discarded?.force === true && (forced.discarded?.unmerged?.files ?? 0) >= 1, forced.discarded ?? null);
    check('U6', '内容不安全 ⇒ **分支不删**（未并入的提交还在）', forced.branchDeleted === false && (await gitOut(['branch', '--list', 'wt/unmerged'], sandbox.repo)) !== '', { branchDeleted: forced.branchDeleted, kept: forced.steps?.e_removal?.branchKept ?? null });

    // 再调一次（幂等那一半）：目录与注册项都不在了，但**残留分支未并入** ⇒ 如实说不删分支（force 也不删）。
    const leftover = await callTool(sandbox, caller, `RECLAIM ${session}`);
    check('U7', '目录已不在、残留分支未并入 ⇒ 幂等且**不删分支**，并说清为什么', leftover.ok === false && leftover.reason === 'already_reclaimed_branch_unsafe'
      && leftover.alreadyReclaimed === true && (await gitOut(['branch', '--list', 'wt/unmerged'], sandbox.repo)) !== '', { ok: leftover.ok, reason: leftover.reason, note: leftover.note });
    const leftoverForced = await callTool(sandbox, caller, `RECLAIM ${session} force`);
    check('U8', 'force 也不删「未并入」的残留分支（未并入的提交不悄悄丢）', leftoverForced.ok === false && (await gitOut(['branch', '--list', 'wt/unmerged'], sandbox.repo)) !== '', { ok: leftoverForced.ok, reason: leftoverForced.reason });

    // U12：另外两处报「未并入 / 多少文件」的地方（force 的 `discarded.unmerged` ＋ 幂等那一半的 already-gone note）
    // 用的是**同一套口径**（都走 `unmergedReportOf` / `unmergedPhrase`）—— 一处改了另一处没改，这条就红。
    check('U12', 'force 的 discarded.unmerged 与 already-gone 那句 note 用的是**同一套口径**（自己 = 1 个文件；两条 tip 的差异 = 1+3）',
      forced.discarded?.unmerged?.files === 1
      && forced.discarded?.unmerged?.commitsAhead === 1
      && forced.discarded?.unmerged?.vsMasterTwoDot?.files === 1 + MASTER_EXTRA
      && String(leftover.note ?? '').includes('这 1 个提交自己改了 1 个文件')
      && String(leftover.note ?? '').includes(`并进 origin/master 会带来 ${1 + MASTER_EXTRA} 个文件的变化`),
      { discarded: forced.discarded?.unmerged ?? null, leftoverNote: leftover.note ?? null });
  },

  // ④ 工作区脏（分支是祖先）⇒ 默认拒绝（反证臂②的靶子）
  async dirty(sandbox) {
    const caller = await ensureCaller(sandbox);
    const worktree = await addWorktree(sandbox, 'dirty');
    const session = await createSession(sandbox, worktree, 'F (archived, uncommitted work present)');
    await archiveSession(sandbox, session);
    await writeFile(path.join(worktree, 'uncommitted-work.txt'), 'this is exactly what the incident destroyed\n');
    const before = await snapshotDirectory(worktree);
    const ancestorCode = await gitCode(['merge-base', '--is-ancestor', 'wt/dirty', 'origin/master'], sandbox.repo);

    const receipt = await callTool(sandbox, caller, `RECLAIM ${session}`);
    const after = await snapshotDirectory(worktree);
    check('D1', '工作区有未提交改动 ⇒ 默认**拒绝**（祖先判据看不见它）', receipt.ok === false && receipt.reason === 'worktree_dirty' && receipt.changed === false, { ok: receipt.ok, reason: receipt.reason, note: receipt.note });
    check('D2', '拒绝回执给出脏了几个路径 ＋ 前几条原文', (receipt.dirty?.count ?? 0) >= 1 && Array.isArray(receipt.dirty?.sample) && receipt.dirty.sample.length >= 1, receipt.dirty ?? null);
    check('D3', '未提交改动**逐字节还在**、目录未动', JSON.stringify(before) === JSON.stringify(after) && await stat(worktree).then((info) => info.isDirectory()).catch(() => false), { after: after === null ? '(目录已不在 —— 未提交改动真的被删了)' : Object.keys(after) });
    check('D4', '（复现前提）这一刻分支是 origin/master 的祖先 ⇒ 判据①会说「安全」', ancestorCode === 0, { mergeBaseIsAncestorExitCode: ancestorCode });
  },

  // ⑤ 快照与主树护栏
  async guards(sandbox) {
    const caller = await ensureCaller(sandbox);
    // 另一条调用方：cwd **不在**这个仓库里（用来单独验「主检出」那条护栏；上面那条调用方在仓库里，
    // 会先撞上 `caller_inside_target` —— 两条护栏分开各测一次）。
    const outsideCaller = await createSession(sandbox, sandbox.outside, 'maintainer outside the repo');
    const worktree = await addWorktree(sandbox, 'guards');
    const live = await createSession(sandbox, worktree, 'G (never archived)');
    const notArchived = await callTool(sandbox, caller, `RECLAIM ${live}`);
    check('G1', '目标没归档 ⇒ 拒绝（session_not_archived），目录未动', notArchived.ok === false && notArchived.reason === 'session_not_archived'
      && await stat(worktree).then((info) => info.isDirectory()).catch(() => false), { ok: notArchived.ok, reason: notArchived.reason });

    // 主检出：会话的 cwd 就是**主树**本身（已归档）⇒ 一律拒绝。
    const onMain = await createSession(sandbox, sandbox.repo, 'H (archived, cwd is the main checkout)');
    await archiveSession(sandbox, onMain, outsideCaller);
    const beforeMain = await snapshotDirectory(sandbox.repo);
    const mainReceipt = await callTool(sandbox, outsideCaller, `RECLAIM ${onMain}`);
    const afterMain = await snapshotDirectory(sandbox.repo);
    check('G2', '目标是**主检出** ⇒ 拒绝（target_is_main_tree），主树一字未动', mainReceipt.ok === false && mainReceipt.reason === 'target_is_main_tree'
      && JSON.stringify(beforeMain) === JSON.stringify(afterMain), { ok: mainReceipt.ok, reason: mainReceipt.reason });
    check('G3', '主树仍在注册表里（第一条）', (await worktreePaths(sandbox))[0] === normalizePath(sandbox.repo), (await worktreePaths(sandbox))[0]);

    const insideReceipt = await callTool(sandbox, caller, `RECLAIM ${onMain}`);
    check('G4', '调用方自己的 cwd 就在目标里 ⇒ 拒绝（caller_inside_target）', insideReceipt.ok === false && insideReceipt.reason === 'caller_inside_target', { ok: insideReceipt.ok, reason: insideReceipt.reason });

    const gone = await callTool(sandbox, outsideCaller, `RECLAIM ${live} force`);
    check('G5', 'force 也**不放宽**「目标必须已归档」', gone.ok === false && gone.reason === 'session_not_archived', { ok: gone.ok, reason: gone.reason });

    // (c) 的「含子目录」那一半：会话的 cwd 是这棵树的**子目录** ⇒ 也算占用。
    const nestedWorktree = await addWorktree(sandbox, 'nested');
    const nestedTarget = await createSession(sandbox, nestedWorktree, 'K (archived target of wt/nested)');
    await archiveSession(sandbox, nestedTarget, outsideCaller);
    await mkdir(path.join(nestedWorktree, 'nested'), { recursive: true });
    const nestedOccupant = await createSession(sandbox, path.join(nestedWorktree, 'nested'), 'L (cwd is a subdirectory of the worktree)');
    const nestedReceipt = await callTool(sandbox, caller, `RECLAIM ${nestedTarget}`);
    check('G6', '(c) 的「含子目录」那一半：子目录里的会话也算占用（前缀判据）', nestedReceipt.ok === false && nestedReceipt.reason === 'live_session_in_worktree'
      && (nestedReceipt.occupants ?? []).some((occupant) => occupant.id === nestedOccupant), { ok: nestedReceipt.ok, reason: nestedReceipt.reason, occupants: nestedReceipt.occupants ?? [] });
  },

  // ⑦ 落位账（placement.json）补 cwd：宿主报了活会话、盘上**没有**它的会话文件的那一类
  //
  // 为什么单独一臂：`POST /sessions` 就会让宿主把它记进 sessionOwners（⇒ `/host` 报它是活会话），
  // 而 pi 的会话文件要等**第一条消息**才落盘 ⇒ 旧实现在 `sessions/` 里看不到它、只能当「cwd 不明」
  // 而**一票否决**：一条这样的会话能挡住那台机器上**所有** worktree 回收（2026-09-2x winbox 的 33 棵）。
  // 本臂验三件事：(c-2) 用落位账把「不知道」变成「知道」；① cwd 在树里 ⇒ 仍拒；② 落位账查不到 ⇒ 仍拒。
  // 反证臂 ③（`--mutant=placement-ignored`）把「用落位账」那一步拿掉 ⇒ 本臂的放行那条**必红**。
  async placement(sandbox) {
    const caller = await ensureCaller(sandbox);

    // ── 主场景：活会话（无文件）的 cwd 在**目标树之外**（落位 kind=scratch）⇒ 补上后**放行** ──
    const worktree = await addWorktree(sandbox, 'placement');
    const target = await createSession(sandbox, worktree, 'M (archived target of wt/placement)');
    await archiveSession(sandbox, target, caller);
    const pending = await createPendingSession(sandbox, { scratch: true }, 'N (live, no session file, cwd outside the tree)');
    const pendingFile = await sessionFileOf(sandbox, pending.id);
    const ledger0 = JSON.parse(await readFile(path.join(sandbox.home, 'placement.json'), 'utf8'));
    const pendingLive = (await hostLiveIds(sandbox)).includes(pending.id);
    check('P1', '前提：宿主 /host 报了这条活会话，但盘上**没有**它的会话文件（旧行为就是被这个挡住的）',
      pendingLive && pendingFile === null,
      { live: pendingLive, sessionFile: pendingFile, cwd: pending.placement?.cwd ?? null });
    check('P2', '前提：落位账（placement.json）里记着它的 cwd —— 同一件事的另一份一手来源',
      ledger0[pending.id]?.cwd === pending.placement?.cwd && ledger0[pending.id]?.kind === 'scratch',
      { entry: ledger0[pending.id] ?? null });

    const receipt = await callTool(sandbox, caller, `RECLAIM ${target}`);
    check('P3', '放行：落位账给出 cwd、且 cwd **不在**目标树里 ⇒ 回收成功',
      receipt.ok === true && receipt.reason === 'reclaimed' && receipt.removed === true && receipt.changed === true,
      { ok: receipt.ok, reason: receipt.reason, note: receipt.note });
    const liveProbe = receipt.steps?.c_occupancy?.liveProbe ?? {};
    const resolvedRow = (liveProbe.resolvedFromPlacement ?? []).find((row) => row.id === pending.id) ?? null;
    check('P4', '回执如实写清用的是哪份来源（unknownCwdResolvedFrom=\'placement\'）＋ 逐条 {id,cwd,source}',
      liveProbe.unknownCwdResolvedFrom === 'placement' && resolvedRow !== null
      && normalizePath(resolvedRow.cwd) === normalizePath(await realpath(pending.placement.cwd))
      && resolvedRow.source === 'placement' && resolvedRow.insideTarget === false,
      { unknownCwdResolvedFrom: liveProbe.unknownCwdResolvedFrom ?? null, resolvedFromPlacement: liveProbe.resolvedFromPlacement ?? null });
    check('P5', '回执把「仍然不知道 cwd」那一栏单列出来且为空（没有静默），原始名单仍在 sessionsWithoutHeader 里',
      Array.isArray(liveProbe.stillUnknownCwd) && liveProbe.stillUnknownCwd.length === 0
      && Array.isArray(liveProbe.sessionsWithoutHeader) && liveProbe.sessionsWithoutHeader.includes(pending.id),
      { stillUnknownCwd: liveProbe.stillUnknownCwd ?? null, sessionsWithoutHeader: liveProbe.sessionsWithoutHeader ?? null });

    // ── 反证臂 ①：落位账里的 cwd **就落在目标树里** ⇒ 仍然拒（证明这一半没放松）──
    const insideTree = await addWorktree(sandbox, 'placement-inside');
    const insideTarget = await createSession(sandbox, insideTree, 'O (archived target of wt/placement-inside)');
    await archiveSession(sandbox, insideTarget, caller);
    const insidePending = await createPendingSession(sandbox, { cwd: insideTree }, 'P (live, no session file, cwd INSIDE the tree)');
    const beforeInside = await snapshotDirectory(insideTree);
    const insideReceipt = await callTool(sandbox, caller, `RECLAIM ${insideTarget}`);
    check('P6', '反证臂①：落位账里的 cwd 落在目标树里 ⇒ 仍**拒**（它是占用者，这一半没放松）',
      insideReceipt.ok === false && insideReceipt.reason === 'live_session_in_worktree'
      && (insideReceipt.occupants ?? []).some((occupant) => occupant.id === insidePending.id && occupant.source === 'placement'),
      { ok: insideReceipt.ok, reason: insideReceipt.reason, occupants: insideReceipt.occupants ?? [] });
    check('P7', '反证臂①：拒绝时目标树一字未动',
      JSON.stringify(beforeInside) === JSON.stringify(await snapshotDirectory(insideTree)), { tree: insideTree });
    const insideForced = await callTool(sandbox, caller, `RECLAIM ${insideTarget} force`);
    check('P8', '反证臂①：force:true 也**不放宽**这一条',
      insideForced.ok === false && insideForced.reason === 'live_session_in_worktree' && insideForced.changed === false,
      { ok: insideForced.ok, reason: insideForced.reason });

    // ── 反证臂 ②：落位账里**查不到**这条 id ⇒ 仍然拒（那仍然是「猜」的地方）──
    const missingTree = await addWorktree(sandbox, 'placement-missing');
    const missingTarget = await createSession(sandbox, missingTree, 'Q (archived target of wt/placement-missing)');
    await archiveSession(sandbox, missingTarget, caller);
    const orphan = await createPendingSession(sandbox, { scratch: true }, 'R (live, no session file, its placement entry removed)');
    const ledgerFile = path.join(sandbox.home, 'placement.json');
    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
    const hadEntry = Boolean(ledger[orphan.id]);
    delete ledger[orphan.id];
    await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    const ledgerAfter = JSON.parse(await readFile(ledgerFile, 'utf8'));
    const orphanStillLive = (await hostLiveIds(sandbox)).includes(orphan.id);
    check('P9', '反证臂②前提：落位账里确实查不到这条 id 了（宿主也没把它写回去）、会话文件也仍然没有',
      hadEntry && ledgerAfter[orphan.id] === undefined && (await sessionFileOf(sandbox, orphan.id)) === null,
      { hadEntry, entryNow: ledgerAfter[orphan.id] ?? null, live: orphanStillLive });
    const orphanReceipt = await callTool(sandbox, caller, `RECLAIM ${missingTarget}`);
    check('P10', '反证臂②：落位账查不到这条 ⇒ **仍拒**（live_session_cwd_unknown），且点名了它',
      orphanReceipt.ok === false && orphanReceipt.reason === 'live_session_cwd_unknown'
      && (orphanReceipt.stillUnknownCwd ?? []).some((row) => row.id === orphan.id),
      { ok: orphanReceipt.ok, reason: orphanReceipt.reason, stillUnknownCwd: orphanReceipt.stillUnknownCwd ?? null, note: orphanReceipt.note });
    const orphanForced = await callTool(sandbox, caller, `RECLAIM ${missingTarget} force`);
    check('P11', '反证臂②：force:true 也不放宽这一条（仍然不许猜）',
      orphanForced.ok === false && orphanForced.reason === 'live_session_cwd_unknown',
      { ok: orphanForced.ok, reason: orphanForced.reason });

    // ── 反证臂 ③：落位账**读不出来**（`placement.ok === false`）⇒ 那条「活而无文件」的会话**仍然拒** ──
    // 原单自报：这一支只有代码路径、没有红臂。这里把现场真造出来，并配 mutant
    //（`--mutant=placement-unreadable-blind`）证明这条牙有齿。
    const unreadableTree = await addWorktree(sandbox, 'placement-unreadable');
    const unreadableTarget = await createSession(sandbox, unreadableTree, 'S (archived target of wt/placement-unreadable)');
    await archiveSession(sandbox, unreadableTarget, caller);
    const unreadablePending = await createPendingSession(sandbox, { scratch: true }, 'T (live, no session file, the guard will read a broken ledger)');
    const ledgerHome = path.join(sandbox.tmp, 'guard-ledger-broken');
    await mkdir(ledgerHome, { recursive: true });
    const brokenLedger = path.join(ledgerHome, 'placement.json');
    await writeFile(brokenLedger, '{ "not": "json" at all\n');
    const brokenParses = await readFile(brokenLedger, 'utf8').then((text) => { try { JSON.parse(text); return true; } catch { return false; } });
    const realLedgerParses = await readFile(path.join(sandbox.home, 'placement.json'), 'utf8').then((text) => { try { JSON.parse(text); return true; } catch { return false; } });
    check('P12', '反证臂③前提：守卫要读的那份落位账是**副本 home** 里一份非法 JSON（真账仍是好的、真 profile 一字未碰），而那条会话确实「活而无文件」',
      brokenParses === false && realLedgerParses === true && path.resolve(ledgerHome).startsWith(path.resolve(sandbox.tmp))
      && (await sessionFileOf(sandbox, unreadablePending.id)) === null && (await hostLiveIds(sandbox)).includes(unreadablePending.id),
      { ledgerHome, brokenParses, realLedgerParses, live: (await hostLiveIds(sandbox)).includes(unreadablePending.id), sessionFile: await sessionFileOf(sandbox, unreadablePending.id) });

    const beforeUnreadable = await snapshotDirectory(unreadableTree);
    const unreadableReceipt = await callGuardInProcess(sandbox, unreadableTarget, ledgerHome);
    print(`tool receipt (in-process, broken ledger) RECLAIM ${unreadableTarget}`, unreadableReceipt);
    check('P13', '反证臂③：落位账**读不出来**（placement.ok=false）⇒ 没有会话文件的活会话**仍然拒**（live_session_cwd_unknown）＋ 回执照实写 unknownCwdResolvedFrom=null / stillUnknownCwd 点名它 / placementReadable=false',
      unreadableReceipt.ok === false && unreadableReceipt.reason === 'live_session_cwd_unknown' && unreadableReceipt.changed === false
      && unreadableReceipt.unknownCwdResolvedFrom === null
      && (unreadableReceipt.stillUnknownCwd ?? []).some((row) => row.id === unreadablePending.id)
      && unreadableReceipt.steps?.c_occupancy?.placementReadable === false
      && typeof unreadableReceipt.steps?.c_occupancy?.placementError === 'string',
      { ok: unreadableReceipt.ok, reason: unreadableReceipt.reason, unknownCwdResolvedFrom: unreadableReceipt.unknownCwdResolvedFrom ?? null,
        stillUnknownCwd: unreadableReceipt.stillUnknownCwd ?? null, placementReadable: unreadableReceipt.steps?.c_occupancy?.placementReadable ?? null,
        placementError: unreadableReceipt.steps?.c_occupancy?.placementError ?? null, note: unreadableReceipt.note });
    check('P14', '反证臂③：这一条拒绝也**一个字节都不动**（目录快照逐字节相同）',
      JSON.stringify(beforeUnreadable) === JSON.stringify(await snapshotDirectory(unreadableTree)), { tree: unreadableTree });
  },

  // ⑥ 候选报告：只读、可复核
  async report(sandbox) {
    const before = { listed: await worktreeList(sandbox), trees: await snapshotWorktrees(sandbox) };
    const run = await runReport(sandbox);
    const after = { listed: await worktreeList(sandbox), trees: await snapshotWorktrees(sandbox) };
    const lines = run.out.split('\n');
    print('wt-report raw output', lines.slice(0, 80).join('\n'));
    check('R1', 'bin/wt-report.mjs 退出码 0 且输出可解析', run.code === 0, { code: run.code, stderr: run.err.slice(0, 400) });
    let parsed = null;
    try { parsed = JSON.parse(run.out); } catch { parsed = null; }
    check('R2', '--json 是一份结构化报告（worktrees / counts / limits 都在）', parsed?.report === 'wt-report' && Array.isArray(parsed?.worktrees) && parsed.worktrees.length >= 4 && Array.isArray(parsed.limits), parsed ? { worktrees: parsed.worktrees.length, counts: parsed.counts } : null);
    const reclaimable = (parsed?.worktrees ?? []).filter((row) => row.suggestion === 'reclaimable');
    check('R3', '给出了「可回收」的候选，且带的是**可执行的建议**（点名一条已归档会话）', reclaimable.length >= 1 && reclaimable.every((row) => /reclaim_worktree\(\{ id: "[0-9a-f-]{36}" \}\)/.test(row.action ?? '')), reclaimable.map((row) => ({ path: row.path, action: row.action })));
    check('R4', '至少一条「可回收」的建议与工具**愿意**做的事一致（那条树真能回收）', reclaimable.length >= 1 && reclaimable.some((row) => /clean-for-report/.test(row.path)), reclaimable.map((row) => row.path));
    const needsHuman = (parsed?.worktrees ?? []).filter((row) => row.suggestion === 'needs-human');
    check('R5', '「需人看」的每条都写了为什么', needsHuman.every((row) => Array.isArray(row.reasons) && row.reasons.length >= 1), needsHuman.flatMap((row) => row.reasons).slice(0, 8));
    check('R6', '候选报告**只读**：跑前跑后注册表与每个 worktree 的目录一字不差', JSON.stringify(before) === JSON.stringify(after), { listedSame: before.listed === after.listed, treesCompared: Object.keys(before.trees).length });
    check('R7', '报告自己写明已知边界（pending 会话看不见 / 已搬家豁免的来源 / 只读）', Array.isArray(parsed?.limits) && parsed.limits.length >= 3, parsed?.limits ?? null);

    // ── R8+：与守卫**同一口径**的「活会话、无会话文件」分类（这一跑带宿主探针真去问 `/host`）──
    // 现场：① 一条活而无文件的会话，落位账说它**不住**这棵树里（⇒ 不再打 needs-human）；
    //       ② 另一条活而无文件的会话，落位账说它**就落在这棵树里**（⇒ 照旧挡路，措辞沿用守卫的）。
    const caller = await ensureCaller(sandbox);
    const outsideTree = await addWorktree(sandbox, 'report-outside');
    const outsideTarget = await createSession(sandbox, outsideTree, 'T (archived target of wt/report-outside)');
    await archiveSession(sandbox, outsideTarget, caller);
    const outsidePending = await createPendingSession(sandbox, { cwd: sandbox.outside }, 'U (live, no session file, cwd outside every worktree)');
    const insideTree = await addWorktree(sandbox, 'report-inside');
    const insideTarget = await createSession(sandbox, insideTree, 'V (archived target of wt/report-inside)');
    await archiveSession(sandbox, insideTarget, caller);
    const insidePending = await createPendingSession(sandbox, { cwd: insideTree }, 'W (live, no session file, cwd inside wt/report-inside)');

    const beforeProbe = { listed: await worktreeList(sandbox), trees: await snapshotWorktrees(sandbox) };
    const probed = await runReport(sandbox, { hostProbe: true });
    const afterProbe = { listed: await worktreeList(sandbox), trees: await snapshotWorktrees(sandbox) };
    print('wt-report --json (with host probe) raw head', probed.out.split('\n').slice(0, 6).join('\n'));
    let probedReport = null;
    try { probedReport = JSON.parse(probed.out); } catch { probedReport = null; }
    const probe = probedReport?.hostProbe ?? {};
    const rowOf = (pattern) => (probedReport?.worktrees ?? []).find((row) => pattern.test(row.path)) ?? null;
    check('R8', '带宿主探针那一跑：报告写明「活而无文件」的原始名单与**它用的来源**（unknownCwdResolvedFrom=\'placement\' ＋ 逐条 {id,cwd,source}），没有静默',
      probed.code === 0 && probe.ok === true
      && Array.isArray(probe.sessionsWithoutHeader) && probe.sessionsWithoutHeader.includes(outsidePending.id) && probe.sessionsWithoutHeader.includes(insidePending.id)
      && probe.unknownCwdResolvedFrom === 'placement' && probe.placementReadable === true
      && [outsidePending.id, insidePending.id].every((id) => (probe.resolvedFromPlacement ?? []).some((row) => row.id === id && row.source === 'placement'))
      && (probe.stillUnknownCwd ?? []).length === 0 && probedReport.liveFactsComplete === true,
      { code: probed.code, ok: probe.ok, unknownCwdResolvedFrom: probe.unknownCwdResolvedFrom ?? null, placementReadable: probe.placementReadable ?? null,
        resolvedFromPlacement: (probe.resolvedFromPlacement ?? []).map((row) => ({ id: row.id, source: row.source, placementKind: row.placementKind })),
        stillUnknownCwd: (probe.stillUnknownCwd ?? []).length, liveFactsComplete: probedReport?.liveFactsComplete ?? null });

    const outsideRow = rowOf(/report-outside/);
    check('R9', '与守卫同口径：落位账说那条活会话**不住这棵树里** ⇒ 这一行不再打 needs-human（是可回收的候选），理由里也没拿「cwd 不明」当借口',
      outsideRow !== null && outsideRow.suggestion === 'reclaimable'
      && (outsideRow.liveWithoutHeader?.outside ?? []).some((row) => row.id === outsidePending.id)
      && (outsideRow.liveWithoutHeader?.inTree ?? []).length === 0
      && !(outsideRow.reasons ?? []).some((reason) => /cwd 不明/.test(reason)),
      { suggestion: outsideRow?.suggestion ?? null, reasons: outsideRow?.reasons ?? null,
        liveWithoutHeader: outsideRow?.liveWithoutHeader ?? null });

    const insideRow = rowOf(/report-inside/);
    check('R10', '与守卫同口径：落位账说那条活会话**就落在这棵树里** ⇒ 照旧标成挡路（措辞沿用 live_session_in_worktree）＋ 理由里写明用的哪份来源',
      insideRow !== null && insideRow.suggestion === 'needs-human'
      && (insideRow.liveWithoutHeader?.inTree ?? []).some((row) => row.id === insidePending.id)
      && (insideRow.reasons ?? []).some((reason) => /live_session_in_worktree/.test(reason) && /placement\.json|落位账/.test(reason))
      && !(insideRow.reasons ?? []).some((reason) => /cwd 不明/.test(reason)),
      { suggestion: insideRow?.suggestion ?? null, reasons: insideRow?.reasons ?? null, liveWithoutHeader: insideRow?.liveWithoutHeader ?? null });

    check('R11', '带宿主探针那一跑也**只读**：注册表与每棵树目录快照一字不差', JSON.stringify(beforeProbe) === JSON.stringify(afterProbe),
      { listedSame: beforeProbe.listed === afterProbe.listed, treesCompared: Object.keys(beforeProbe.trees).length });

    // 同一口径的直接证据：报告说「可回收」的那棵树（旁边就有一条活而无文件、落位账说不在这棵树里的会话），
    // 守卫真调用一次就该成功 —— 报告的建议与守卫的动作一致。
    const executed = await callTool(sandbox, caller, `RECLAIM ${outsideTarget}`);
    check('R12', '同一口径的直接证据：报告说「可回收」的那棵树，守卫**真的**回收成功（旁边那条活而无文件的会话没挡路）',
      executed.ok === true && executed.reason === 'reclaimed' && executed.removed === true && executed.changed === true,
      { ok: executed.ok, reason: executed.reason, note: executed.note });
  },
};

async function runReport(sandbox, { hostProbe = false } = {}) {
  const args = [path.join(ROOT, 'bin', 'wt-report.mjs'), '--repo', sandbox.repo, '--home', sandbox.home, '--json'];
  // 带探针那一跑真去问宿主的 `/host`（不带就 `--no-host-probe`，只看盘上那一份）。
  if (hostProbe) args.push('--base-url', `http://127.0.0.1:${sandbox.basePort}`);
  else args.push('--no-host-probe');
  const child = spawn(process.execPath, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, out, err };
}

/** 父进程：跑绿臂，再逐个跑反证臂并断言**它红了、且红在预期的那一条上**。 */
async function runAllArms(tmp) {
  const greenArms = [
    ['① 事故现场重建（拒绝且目录一字未动）', () => ARMS.incident(SANDBOX)],
    ['② 干净 ⇒ 成功 ⇒ 幂等 ＋ id 护栏', () => ARMS.success(SANDBOX)],
    ['③ 未并入差异：默认拒绝 / force 才动且不删分支', () => ARMS.unmerged(SANDBOX)],
    ['④ 未提交改动（分支是祖先）：默认拒绝', () => ARMS.dirty(SANDBOX)],
    ['⑤ 快照与主树护栏', () => ARMS.guards(SANDBOX)],
    // ⚠ 顺序有意义：报告臂必须在**放置臂摘掉落位账那条条目之前**跑完（摘掉之后会多出一条「判不出 cwd」的
    // 活会话，那一轮里所有行都会被顶成 needs-human，R9/R10/R12 就量不到「同口径」这件事了）。
    ['⑥ 候选报告只读且可复核（含与守卫同口径的那一类）', () => ARMS.report(SANDBOX)],
    ['⑦ 落位账（placement.json）补 cwd：放行 ＋ 三条反证臂', () => ARMS.placement(SANDBOX)],
  ].map(([name, run]) => [name, async () => {
    const before = failures.length;
    const detail = await run();
    if (failures.length > before) throw new Error(`${failures.length - before} check(s) failed: ${failures.slice(before).map((failure) => `[${failure.id}]`).join(' ')}`);
    return detail ?? 'all checks green';
  }]);
  await runArms(greenArms, { title: 'wt-reclaim arms' });

  for (const name of Object.keys(MUTANTS)) {
    const spec = MUTANTS[name];
    const mutantRoot = path.join(tmp, `code-mutant-${name}`);
    await copyCodeTree(CODE_ROOT, mutantRoot);
    await applyMutant(mutantRoot, name);
    const run = await runMutantChild(name, spec, mutantRoot);
    const required = spec.expectAll ?? [spec.expect];
    const missing = required.filter((id) => !run.out.includes(`✗ [${id}]`));
    check(`R-${name}`, `反证臂「${spec.description}」**必红**（红在 ${required.map((id) => `[${id}]`).join(' + ')} 上）`, run.code !== 0 && missing.length === 0, {
      exitCode: run.code,
      expectedRedChecks: required,
      missingRedChecks: missing,
      redChecks: (run.out.match(/✗ \[[^\]]+\]/g) ?? []),
      redLines: run.out.split('\n').filter((line) => line.startsWith('✗ [')).slice(0, 4),
    });
  }
}

async function runMutantChild(name, spec, mutantRoot) {
  print(`reverse arm ${name}: running the "${spec.arm}" arm against a copy whose plugin uses the historical criterion`, { codeRoot: mutantRoot });
  const child = spawn(process.execPath, [SELF, `--arm=${spec.arm}`, `--code=${mutantRoot}`], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.stdout.write(`reverse arm ${name}: timed out, killing pid ${child.pid}\n`);
      child.kill();
    }, 15 * 60 * 1000);
    child.on('close', (value) => { clearTimeout(timer); resolve(value); });
  });
  print(`reverse arm ${name}: raw result`, {
    exitCode: code,
    expected: `a non-zero exit whose output names ${(spec.expectAll ?? [spec.expect]).map((id) => `[${id}]`).join(' + ')} as red`,
    redChecks: (out.match(/✗ \[[^\]]+\]/g) ?? []),
    greenChecks: (out.match(/✓ \[[^\]]+\]/g) ?? []).length,
    firstRedLines: out.split('\n').filter((line) => line.startsWith('✗ [')).slice(0, 3),
    stdoutTail: out.split('\n').slice(-14),
    stderrHead: err.split('\n').slice(0, 8),
    stderrTail: err.split('\n').slice(-6),
  });
  return { code, out, err };
}

await main();
