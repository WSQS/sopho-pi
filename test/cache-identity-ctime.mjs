#!/usr/bin/env node
// cache-identity-ctime —— 「文件身份」必须带 **ctime**：同 size 同 mtimeMs 的**原地重写**不许让读侧缓存交陈旧值。
//
// 出处（业主 2026-09-22 派单）：`docs/design-session-seal.md` §8 把 `persistedManagerCache` 记成
// 「不看 ctime ⇒ 同 size 同 mtimeMs 的原地重写理论上能拿到陈旧 manager —— **列为待查项**」。
// 读码普查（基准提交 `c9e1af4`，行号是那份的行号）——**按「文件身份/新鲜度」判缓存的地方一共这些**：
//   · `legacyArchiveCache`（`legacyArchiveIds`，:3664，签名 `${mtimeMs}:${size}`）      —— `/tree`、`/sessions/{id}`
//   · `persistedManagerCache`（`openPersistedManager`，:4256 比较 / :4266 记账，size+mtimeMs）—— `/questions`、详情那一半
//   · `messageBodyCache` 的冷读 `versionKey`（`fileMessageBody`，:4524，`file|…|size|mtimeMs|ro`）—— `/messages`
//     （`(versionKey, encoding)` 的压缩分槽 :712 同键，改一处两路都盖住）
//   · `treeIndex`（:4881 / :4896）**本来就看 ctime**，不在本件的改动里（只把两处 :3460/:4866 的
//     旧注释改成 (size, mtimeMs, ctimeMs)，它们已经比代码旧了）
//   · 另看过两处、**有意不动**：`sessionFileCache`（:4274）只判「文件还在不在」，不判内容新鲜度；
//     `currentSnapshot`（:4367）比的是**两个不同文件**的 mtime（会话 vs 导出快照），不是一份缓存签名，
//     拿一个文件的 ctime 去和另一个文件的 mtime 比是错的。
// 前三处都补上 ctimeMs。
//
// 为什么 ctime 能挡住：`(size, mtimeMs)` 可以被一次**原地重写 + 回拨 mtime**（或同一毫秒内的重写）
// 保持不变，而 ctime 在「内容写入 / 元数据改动 / inode 被替换」时**必变** —— 本件先**实测**这个前提
// （打印 `(size, mtimeMs, ctimeMs)` 三元组），再拿它当判据；前提不成立就整臂失败（不硬改）。
//
// 两条臂、**同一份探针**：
//   arm real    仓里的真代码（新签名）    ⇒ 重写后三条读路都必须给出**新值**（绿）
//   arm mutant  沙箱副本 + 把三处签名里的 ctimeMs 撤掉（= 旧签名，别的一字不动）
//                                        ⇒ 同一份探针必须给出**陈旧值**（红）—— 证明这条门真的能判红
//
// 探针（对每一条读路各一发 GET，重写前后各量一次）：
//   · `/tree`            读 `legacyArchiveCache`：archive.json 从「标记别的 id」改成「标记本会话 id」
//   · `/sessions/{id}/questions`  读 `persistedManagerCache`：冷会话（无 runtime）问题题面 ALPHA→OMEGA
//   · `/sessions/{id}/messages`   读 `messageBodyCache`：同一份正文里的 ALPHA→OMEGA
// 重写走 `open('r+')` 原地写回 + `utimes` 回拨 mtime：字节数不变、mtimeMs 逐位相同、只有 ctime 变。
//
// 沙箱纪律（与 `test/perf-verify-lib.mjs` / `test/migrate-legacy-archive.mjs` 同口径）：
//   · 只起**自己 spawn** 的 `server/base.mjs`，只按**精确 pid**（`stopOwnedListener` 先核监听 pid
//     就是 spawn 的 pid、cmdline 就是那份 entry）停，**绝不 pkill**；
//   · 高位随机端口 + 127.0.0.1，**绝不**用 7331/7321/7411/7412；
//   · 日志写沙箱自己的目录，**绝不**写 `/tmp/sopho-base.log` / `sopho-app.log`；
//   · 副本 home，真 profile 只读、不碰；跑完自清（`.probe-sandbox/` 在 .gitignore 里）。
//
// 用法：node test/cache-identity-ctime.mjs   /   npm run test:cachectime

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, stopOwnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 沙箱放**仓内**：副本的 `server/base-logic.mjs` 要 import `@earendil-works/pi-coding-agent`，
// 得顺着目录向上找到仓里的 `node_modules`（与 `test/s4-handoff-cwd.mjs` / `test/host-session-path-probe.mjs` 同一条理由）。
const SANDBOX_ROOT = path.join(ROOT, '.probe-sandbox');
await mkdir(SANDBOX_ROOT, { recursive: true });
const CODE_ENTRIES = ['server', 'pi-extensions', 'web'];
const FORBIDDEN_PORTS = new Set([7321, 7331, 7322, 7411, 7412]);
const QUESTION_ENTRY = 'sopho.question';
// 题面/正文里的标记词：ALPHA → OMEGA 逐字节等长（5 B），所以重写前后 size 完全相同。
const MARK_BEFORE = 'ALPHA';
const MARK_AFTER = 'OMEGA';
const FILE_MTIME = new Date(1_790_085_818_112);   // 固定到整毫秒，两次 utimes 逐位相同
const ARCHIVE_MTIME = new Date(1_790_085_819_200);

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let checks = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    checks += 1;
    process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
    return true;
  }
  failures.push(name);
  process.stdout.write(`✗ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  return false;
}

// ───────────────────────── 小工具 ─────────────────────────
async function reservePort(excluded = new Set()) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const candidate = 42000 + Math.floor(Math.random() * 22000);
    if (FORBIDDEN_PORTS.has(candidate) || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

async function get(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { accept: 'application/json', connection: 'close' } });
  const raw = await response.text();
  let value = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = raw.slice(0, 300); }
  return { status: response.status, raw, value };
}

async function poll(label, operation, predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(100);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)?.slice(0, 400)}`);
}

/** 原地重写：字节数必须不变 ⇒ `open('r+')` 写回同一 inode + `utimes` 把 mtime 回拨到原来的值。 */
async function rewriteInPlace(file, from, to, mtimeDate) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to), `rewrite markers must be the same byte length: ${from} vs ${to}`);
  const bytes = await readFile(file);
  const text = bytes.toString('utf8');
  const occurrences = text.split(from).length - 1;
  assert.ok(occurrences >= 1, `${file}: ${from} must appear at least once`);
  const next = Buffer.from(text.replaceAll(from, to), 'utf8');
  assert.equal(next.length, bytes.length, `${file}: in-place rewrite must keep the byte length`);
  const handle = await open(file, 'r+');
  try {
    await handle.write(next, 0, next.length, 0);
  } finally {
    await handle.close();
  }
  await utimes(file, mtimeDate, mtimeDate);
  assert.equal((await readFile(file)).length, bytes.length, `${file}: byte length after rewrite`);
  return { size: next.length };
}

/** 三元组（诚实打印用；`ctimeMs` 带亚毫秒小数）。 */
function triple(info) {
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

// ───────────────────────── 突变副本（红臂）─────────────────────────
// 每一刀都只撤掉签名里的 ctimeMs，别的**一字不动**；锚点必须恰好命中 1 次、`node --check` 兜底。
const MUTATIONS = [
  { from: 'const signature = `${fileStat.mtimeMs}:${fileStat.size}:${fileStat.ctimeMs}`;', to: 'const signature = `${fileStat.mtimeMs}:${fileStat.size}`;', what: 'legacyArchiveCache 签名去掉 ctimeMs' },
  { from: 'hit.mtimeMs === info.mtimeMs && hit.ctimeMs === info.ctimeMs) {', to: 'hit.mtimeMs === info.mtimeMs) {', what: 'persistedManagerCache 命中判据去掉 ctimeMs' },
  { from: 'mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, bytes:', to: 'mtimeMs: info.mtimeMs, bytes:', what: 'persistedManagerCache 记的身份去掉 ctimeMs' },
  { from: "|${info.mtimeMs}|${info.ctimeMs}|${flags.readOnly ? 'ro' : 'rw'}", to: "|${info.mtimeMs}|${flags.readOnly ? 'ro' : 'rw'}", what: 'messageBodyCache 的冷读 versionKey 去掉 ctimeMs' },
];

async function assertParses(file) {
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', file], (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message)));
      else resolve();
    });
  });
}

async function makeMutantCodeRoot(destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of CODE_ENTRIES) await cp(path.join(ROOT, entry), path.join(destination, entry), { recursive: true });
  const logicFile = path.join(destination, 'server', 'base-logic.mjs');
  let text = await readFile(logicFile, 'utf8');
  const applied = [];
  for (const mutation of MUTATIONS) {
    const hits = text.split(mutation.from).length - 1;
    assert.equal(hits, 1, `${logicFile}: mutation anchor must hit exactly once (${mutation.what}), got ${hits}`);
    text = text.replace(mutation.from, mutation.to);
    applied.push(mutation.what);
  }
  await writeFile(logicFile, text, 'utf8');
  assert.equal(await readFile(logicFile, 'utf8'), text, 'mutant write-back must be byte-identical to the intended text');
  await assertParses(logicFile);
  return applied;
}

// ───────────────────────── 一条臂 ─────────────────────────
// 夹具：一条冷会话（无 runtime）：正文一条 user 消息 + 一条未答的 sopho.question。
// 另外一份 v2.1 旧账 archive.json（只被 `legacyArchiveIds` 读）。
function fixtureLines({ id, cwd, name }) {
  const now = '2026-09-01T00:00:00.000Z';
  return [
    { type: 'session', version: 3, id, timestamp: now, cwd },
    { type: 'session_info', id: 'si-0001', parentId: null, timestamp: now, name },
    { type: 'message', id: 'm-0001', parentId: 'si-0001', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: `MESSAGE-${MARK_BEFORE}-PROBE` }], timestamp: Date.parse(now) } },
    { type: 'custom', id: 'q-0001', parentId: 'm-0001', timestamp: now, customType: QUESTION_ENTRY, data: { id: 'q-00000001', op: 'ask', text: `QUESTION-${MARK_BEFORE}-PROBE`, options: null, priority: 'normal', dedupeKey: 'aaaaaaaaaaaa', at: Date.parse(now) - 1000, by: 'agent', context: '本件夹具：只为证明读侧缓存的文件身份必须带 ctime，不含任何模型回合。' } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

async function runArm({ name, mutate }) {
  const sandbox = await mkdtemp(path.join(SANDBOX_ROOT, `cache-ctime-${name}-`));
  const problems = [];
  let child = null;
  let port = null;
  let codeRoot = ROOT;
  let entry = path.join(ROOT, 'server', 'base.mjs');
  try {
    const home = path.join(sandbox, 'home');
    const sessions = path.join(home, 'sessions');
    const workspace = path.join(sandbox, 'workspace');
    for (const dir of [home, sessions, workspace]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: {} }, null, 2)}\n`);
    await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultThinkingLevel: 'off', compaction: { enabled: false } }, null, 2)}\n`);

    if (mutate) {
      codeRoot = path.join(sandbox, 'code');
      const applied = await makeMutantCodeRoot(codeRoot);
      print(`[${name}] mutant patches`, applied);
      entry = path.join(codeRoot, 'server', 'base.mjs');
    }

    // 夹具：会话文件 + 旧账 archive.json（本会话不在里面）。
    const sessionId = randomUUID();
    const foreignId = randomUUID();
    assert.equal(sessionId.length, foreignId.length, 'both ids are full uuids (the archive.json payloads must be the same length)');
    const sessionFile = path.join(sessions, `seed_${sessionId}.jsonl`);
    const archiveFile = path.join(home, 'archive.json');
    await writeFile(sessionFile, fixtureLines({ id: sessionId, cwd: workspace, name: 'ctime probe' }));
    await utimes(sessionFile, FILE_MTIME, FILE_MTIME);
    await writeFile(archiveFile, `{"${foreignId}":true}\n`);
    await utimes(archiveFile, ARCHIVE_MTIME, ARCHIVE_MTIME);
    const sessionBefore = triple(await stat(sessionFile));
    const archiveBefore = triple(await stat(archiveFile));

    // 起沙箱宿主（真 arm 用仓里那份；mutant arm 用副本）。
    port = await reservePort();
    const logHandle = await open(path.join(sandbox, 'base.log'), 'w');
    child = spawn(process.execPath, [entry], {
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
        SOPHO_PORT: String(port),
        SOPHO_DEFAULT_CWD: workspace,
        SOPHO_NO_TOOLS: '1',
      },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
    await poll(`[${name}] base ready`, () => get(port, '/host'), (reply) => reply.status === 200);
    assert.equal(await listenerPid(port), child.pid, `[${name}] the port listener must be the pid I spawned`);

    // —— 第一次读：把三条缓存都装满 ——
    const tree1 = await get(port, '/tree');
    assert.equal(tree1.status, 200, `[${name}] GET /tree -> ${tree1.status} ${tree1.raw.slice(0, 200)}`);
    const row1 = (tree1.value.sessions ?? []).find((session) => session.id === sessionId);
    assert.ok(row1, `[${name}] the fixture session must be in /tree`);
    const questions1 = await get(port, `/sessions/${sessionId}/questions`);
    assert.equal(questions1.status, 200, `[${name}] GET /questions -> ${questions1.status} ${questions1.raw.slice(0, 200)}`);
    assert.equal(questions1.value?.source, 'file', `[${name}] /questions must read the cold file (source=file), got ${questions1.value?.source}`);
    const messages1 = await get(port, `/sessions/${sessionId}/messages`);
    assert.equal(messages1.status, 200, `[${name}] GET /messages -> ${messages1.status} ${messages1.raw.slice(0, 200)}`);
    const before = {
      archived: row1.archived,
      questionsSource: questions1.value?.source ?? null,
      question: questions1.value?.questions?.[0]?.text ?? null,
      messagesHasBefore: messages1.raw.includes(MARK_BEFORE),
      messagesHasAfter: messages1.raw.includes(MARK_AFTER),
    };

    // —— 原地重写（同 size 同 mtimeMs）：会话文件 ALPHA→OMEGA，archive.json 换成标记本会话 ——
    await rewriteInPlace(sessionFile, MARK_BEFORE, MARK_AFTER, FILE_MTIME);
    await rewriteInPlace(archiveFile, foreignId, sessionId, ARCHIVE_MTIME);
    const sessionAfter = triple(await stat(sessionFile));
    const archiveAfter = triple(await stat(archiveFile));
    print(`[${name}] session file (size, mtimeMs, ctimeMs)`, { before: sessionBefore, after: sessionAfter });
    print(`[${name}] archive.json (size, mtimeMs, ctimeMs)`, { before: archiveBefore, after: archiveAfter });

    // —— 第二次读：新签名必须给出新值；旧签名会给出陈旧值 ——
    const tree2 = await get(port, '/tree');
    assert.equal(tree2.status, 200, `[${name}] GET /tree (after) -> ${tree2.status} ${tree2.raw.slice(0, 200)}`);
    const row2 = (tree2.value.sessions ?? []).find((session) => session.id === sessionId);
    assert.ok(row2, `[${name}] the fixture session must still be in /tree`);
    const questions2 = await get(port, `/sessions/${sessionId}/questions`);
    assert.equal(questions2.status, 200, `[${name}] GET /questions (after) -> ${questions2.status} ${questions2.raw.slice(0, 200)}`);
    const messages2 = await get(port, `/sessions/${sessionId}/messages`);
    assert.equal(messages2.status, 200, `[${name}] GET /messages (after) -> ${messages2.status} ${messages2.raw.slice(0, 200)}`);
    const after = {
      archived: row2.archived,
      question: questions2.value?.questions?.[0]?.text ?? null,
      messagesHasBefore: messages2.raw.includes(MARK_BEFORE),
      messagesHasAfter: messages2.raw.includes(MARK_AFTER),
    };

    return { name, sessionId, before, after, sessionIdentity: { before: sessionBefore, after: sessionAfter }, archiveIdentity: { before: archiveBefore, after: archiveAfter } };
  } finally {
    if (child && port !== null) {
      await cleanupStep(problems, `[${name}] stop own listener`, () => stopOwnedListener(port, entry, child.pid));
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
      }
    }
    await removeSandbox(sandbox, problems, `[${name}] remove sandbox`);
    if (problems.length > 0) throw new Error(`[${name}] cleanup problems: ${problems.join('; ')}`);
  }
}

// ───────────────────────── 跑两条臂 ─────────────────────────
let primaryError = null;
const results = {};
try {
  results.real = await runArm({ name: 'real', mutate: false });
  results.mutant = await runArm({ name: 'mutant', mutate: true });
} catch (error) {
  primaryError = error;
}

if (results.real && results.mutant) {
  for (const arm of ['real', 'mutant']) {
    const result = results[arm];
    // 前提（两条臂都要成立）：重写后 size 与 mtimeMs 逐位相同，只有 ctime 变 —— 这就是本件的判据本身。
    check(`[${arm}] 前提：会话文件重写后 (size, mtimeMs) 不变、ctimeMs 变了`,
      result.sessionIdentity.before.size === result.sessionIdentity.after.size
      && result.sessionIdentity.before.mtimeMs === result.sessionIdentity.after.mtimeMs
      && result.sessionIdentity.before.ctimeMs !== result.sessionIdentity.after.ctimeMs,
      { before: result.sessionIdentity.before, after: result.sessionIdentity.after });
    check(`[${arm}] 前提：archive.json 重写后 (size, mtimeMs) 不变、ctimeMs 变了`,
      result.archiveIdentity.before.size === result.archiveIdentity.after.size
      && result.archiveIdentity.before.mtimeMs === result.archiveIdentity.after.mtimeMs
      && result.archiveIdentity.before.ctimeMs !== result.archiveIdentity.after.ctimeMs,
      { before: result.archiveIdentity.before, after: result.archiveIdentity.after });
  }

  // 绿半（真代码）：三条读路都必须给出新值。
  check('[real] /tree 读到新的旧账集合（archive.json 改标本会话 ⇒ archived:true）', results.real.after.archived === true,
    { before: results.real.before.archived, after: results.real.after.archived });
  check('[real] /questions 给出重写后的题面（OMEGA）', typeof results.real.after.question === 'string' && results.real.after.question.includes(MARK_AFTER) && !results.real.after.question.includes(MARK_BEFORE),
    { before: results.real.before.question, after: results.real.after.question });
  check('[real] /messages 给出重写后的正文（OMEGA，且不含 ALPHA）', results.real.after.messagesHasAfter === true && results.real.after.messagesHasBefore === false,
    { before: results.real.before, after: results.real.after });

  // 红半（旧签名副本）：同一份探针必须交出**陈旧值** —— 否则这条门判不了红。
  check('[mutant] /tree 给出陈旧值（archived 仍是 false）', results.mutant.after.archived === false,
    { before: results.mutant.before.archived, after: results.mutant.after.archived });
  check('[mutant] /questions 给出陈旧值（题面仍是 ALPHA）', typeof results.mutant.after.question === 'string' && results.mutant.after.question.includes(MARK_BEFORE),
    { before: results.mutant.before.question, after: results.mutant.after.question });
  check('[mutant] /messages 给出陈旧值（正文仍是 ALPHA，不含 OMEGA）', results.mutant.after.messagesHasBefore === true && results.mutant.after.messagesHasAfter === false,
    { before: results.mutant.before, after: results.mutant.after });

  process.stdout.write(`\n──── cache-identity-ctime: ${checks} green / ${failures.length} red ────\n`);
}

if (primaryError) failures.push(`run threw: ${primaryError.message}`);
finishCleanup(primaryError, []);
if (failures.length > 0) {
  process.stderr.write(`cache-identity-ctime: ${failures.length} failure(s): ${JSON.stringify(failures)}\n`);
  process.exitCode = 1;
} else if (results.real && results.mutant) {
  process.stdout.write('cache-identity-ctime: PASS（真代码三条读路都给出新值；旧签名副本三条都给出陈旧值）\n');
}
