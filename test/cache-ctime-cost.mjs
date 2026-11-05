#!/usr/bin/env node
// cache-ctime-cost.mjs —— 「把 ctime 放进读侧缓存签名」的**代价**量测（只量不改）。
//
// 派单背景：读侧缓存（legacyArchiveCache / persistedManagerCache / messageBodyCache）的签名
// 在 `2bcc96d` 补了 `ctimeMs`，动机是**正确性**（挡住「同 size 同 mtimeMs 的原地重写」误命中）。
// 本件只回答一个问题：**ctime 会不会带来额外冷取（内容没变、只因 ctime 变就失效重算），值多少 ms。**
//
// 做法（真沙箱、真 A、只读真 profile）：
//   夹具 = 一条冷会话（无 runtime）：一份 ~1.7 MiB 的 JSONL（正文里含标记 ALPHA）＋ 一条未答
//   `sopho.question` ＋ 一份 v2.1 旧账 `archive.json`。三条读路各发一发 GET：
//     · `/tree`                  → `legacyArchiveCache`（archive.json）＋ `treeIndex`（会话文件）
//     · `/sessions/{id}/questions` → `persistedManagerCache`（冷会话 manager）
//     · `/sessions/{id}/messages`  → `messageBodyCache`（冷读响应体）
//   同一个脚本跑**两条臂**：
//     · real    = 仓里真代码
//     · noctime = 沙箱副本，只把三处签名里的 `ctimeMs` 撤掉（别的**一字不动**），用来量 ctime
//                 的**边际**冷取：同一份探针在 no-ctime 臂上是不是同一处**命中**。
//   每组 ≥3 次独立沙箱（每边 ≥3）。
//
// 四个相位：
//   A  基线   —— 同一份内容连读 3 次（应当全命中）
//   B  同内容重写（temp+rename）—— 逐字节相同的内容换一个 inode（mtime/ctime 大概率都变）
//   B' 同内容原地重写 + 回拨 mtime —— **size 与 mtimeMs 逐位不变、只有 ctime 变**（ctime 的边际场景）
//   C  纯追加（真增量）—— 追加一条合法条目（size 变；两边都该冷取）
//
// 分类口径：`/messages` 的冷/命中由 worker 诊断日志（`SOPHO_READONLY_CACHE_DIAGNOSTICS=1`，
// `[readonly-cache] parse|hit <file>`）**如实判定**；`/questions` 与 `/tree` 没有诊断日志，
// 只报 ms（并在相位内「读一次、再读一次」给出冷/热的 ms 对照，供人判断）。
//
// 沙箱纪律（与 `test/cache-identity-ctime.mjs` / `test/perf-verify-lib.mjs` 同口径）：
//   · 只起**自己 spawn** 的 `server/base.mjs`，只按**精确 pid**停（`stopOwnedListener` 先核监听 pid
//     就是 spawn 的 pid、cmdline 就是那份 entry），**绝不 pkill**；
//   · 高位随机端口 + 127.0.0.1，**绝不**用 7321/7331/7322/7411/7412；
//   · 日志写沙箱自己的目录，**绝不**写 `/tmp/sopho-base.log` / `sopho-app.log`；
//   · 副本 home，真 profile 只读、不碰；跑完自清（沙箱在仓内 `.probe-sandbox/`，已在 .gitignore）。
//
// 用法：node test/cache-ctime-cost.mjs [--repeats N] [--json <file>]

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, stopOwnedListener } from './harness.mjs';
import { hostStatus, poll, request, reserveHighPort, sleep } from './perf-verify-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_ROOT = path.join(ROOT, '.probe-sandbox');
const CODE_ENTRIES = ['server', 'pi-extensions', 'web'];

const MESSAGES = Number(process.env.SOPHO_CCT_COST_MESSAGES ?? 1200);
const MESSAGE_CHARS = Number(process.env.SOPHO_CCT_COST_CHARS ?? 4096);
const MARK_BEFORE = 'ALPHA';
const MARK_AFTER = 'OMEGA';
const QUESTION_ENTRY = 'sopho.question';
const ARCHIVE_ENTRIES = 1800; // 旧账里 1800 条 id（≈ 61 KiB），让「重读+解析 archive.json」这一步可见
// 相位 B / B' 用的**整毫秒** mtime（utimes 只认整毫秒；用固定整数才能让 size+mtimeMs 逐位不变）。
const RENAMED_MTIME = new Date(1_790_086_200_000);

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const REPEATS = Number(argValue('--repeats', process.env.SOPHO_CCT_COST_REPEATS ?? 3));
const JSON_OUT = argValue('--json', null);

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(SANDBOX_ROOT, { recursive: true });

// ───────────────────────── 夹具 ─────────────────────────
function fixtureLines({ id, cwd, name }) {
  const now = '2026-09-01T00:00:00.000Z';
  const lines = [
    { type: 'session', version: 3, id, timestamp: now, cwd },
    { type: 'session_info', id: 'si-0001', parentId: null, timestamp: now, name },
  ];
  let parent = 'si-0001';
  for (let index = 0; index < MESSAGES; index += 1) {
    const text = `MKTEST-${MARK_BEFORE}-${String(index).padStart(5, '0')} `.padEnd(MESSAGE_CHARS, 'x');
    const isUser = index % 2 === 0;
    const message = isUser
      ? { role: 'user', content: text, timestamp: Date.parse(now) }
      : { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.parse(now) };
    const entryId = `m-${String(index).padStart(4, '0')}`;
    lines.push({ type: 'message', id: entryId, parentId: parent, timestamp: now, message });
    parent = entryId;
  }
  lines.push({
    type: 'custom', id: 'q-0001', parentId: parent, timestamp: now, customType: QUESTION_ENTRY,
    data: { id: 'q-00000001', op: 'ask', text: `QUESTION-${MARK_BEFORE}-PROBE`, options: null, priority: 'normal', dedupeKey: 'aaaaaaaaaaaa', at: Date.parse(now) - 1000, by: 'agent', context: '本件夹具：只为量 ctime 落在读侧缓存签名里的代价，不含任何模型回合。' },
  });
  return `${lines.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/** 原地重写 + 回拨 mtime：字节数不变、`size`/`mtimeMs` 逐位不变、只有 ctime 变。 */
async function rewriteInPlace(file, from, to, mtimeMs) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to), `markers must be equal length: ${from} vs ${to}`);
  const bytes = await readFile(file);
  const text = bytes.toString('utf8');
  assert.ok(text.includes(from), `${file}: ${from} must appear`);
  const next = Buffer.from(text.replaceAll(from, to), 'utf8');
  assert.equal(next.length, bytes.length, `${file}: in-place rewrite must keep the byte length`);
  const handle = await open(file, 'r+');
  try {
    await handle.write(next, 0, next.length, 0);
  } finally {
    await handle.close();
  }
  const when = new Date(mtimeMs);
  await utimes(file, when, when);
  return { size: next.length };
}

const triple = (info) => ({ size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });

// ───────────────────────── no-ctime 副本（边际冷取的红臂/对照臂）─────────────────────────
// 每一刀只撤掉签名里的 ctimeMs；锚点必须恰好命中 1 次，`node --check` 兜底。
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
  await assertParses(logicFile);
  return applied;
}

// ───────────────────────── 一次沙箱 run ─────────────────────────
async function readCacheEvents(logPath) {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text.split(/\r?\n/).filter((line) => line.includes('[readonly-cache]')).map((line) => line.slice(line.indexOf('[readonly-cache]')));
}

async function startBase({ entry, codeRoot, home, sessionsRoot, workspace, logPath, port }) {
  const logHandle = await open(logPath, 'w');
  const child = spawn(process.execPath, [entry], {
    cwd: codeRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: workspace,
      SOPHO_NO_TOOLS: '1',
      SOPHO_READONLY_CACHE_DIAGNOSTICS: '1',
    },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  return { child, logHandle };
}

async function runOnce({ arm, repetition }) {
  const sandbox = await mkdtemp(path.join(SANDBOX_ROOT, `cache-cost-${arm}-r${repetition}-`));
  const problems = [];
  let child = null;
  let logHandle = null;
  let port = null;
  let entry = path.join(ROOT, 'server', 'base.mjs');
  const readings = { arm, repetition, phases: {} };
  try {
    const home = path.join(sandbox, 'home');
    const sessions = path.join(home, 'sessions');
    const workspace = path.join(sandbox, 'workspace');
    for (const dir of [home, sessions, workspace]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: {} }, null, 2)}\n`);
    await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultThinkingLevel: 'off', compaction: { enabled: false } }, null, 2)}\n`);

    if (arm === 'noctime') {
      const codeRoot = path.join(sandbox, 'code');
      readings.mutations = await makeMutantCodeRoot(codeRoot);
      entry = path.join(codeRoot, 'server', 'base.mjs');
    }

    const sessionId = randomUUID();
    const foreignId = randomUUID();
    assert.equal(sessionId.length, foreignId.length, 'both ids are full uuids');
    const sessionFile = path.join(sessions, `seed_${sessionId}.jsonl`);
    const archiveFile = path.join(home, 'archive.json');
    await writeFile(sessionFile, fixtureLines({ id: sessionId, cwd: workspace, name: 'ctime cost probe' }));
    const members = {};
    for (let index = 0; index < ARCHIVE_ENTRIES; index += 1) members[randomUUID()] = true;
    await writeFile(archiveFile, `${JSON.stringify(members)}\n`);

    port = await reserveHighPort();
    const logPath = path.join(sandbox, 'base.log');
    ({ child, logHandle } = await startBase({ entry, codeRoot: path.dirname(path.dirname(entry)), home, sessionsRoot: sessions, workspace, logPath, port }));
    await poll(`[${arm}/r${repetition}] base ready`, () => hostStatus(port), (reply) => reply.currentWorkerPid > 0, 120_000).catch(async (error) => {
      const log = await readFile(logPath, 'utf8').catch(() => '(no log)');
      throw new Error(`[${arm}/r${repetition}] base did not become ready: ${error.message}\n--- base.log tail ---\n${log.split('\n').slice(-25).join('\n')}`);
    });
    assert.equal(await listenerPid(port), child.pid, `[${arm}/r${repetition}] the port listener must be the pid I spawned`);

    const url = (kind) => (kind === 'tree' ? '/tree' : `/sessions/${sessionId}/${kind}`);
    async function read(kind, label) {
      const before = await readCacheEvents(logPath);
      const r = await request(port, url(kind), { timeoutMs: 120_000 });
      // worker 的诊断行由宿主异步转发进日志：等它到齐（最多 500 ms），不假设同步落盘。
      let after = before;
      for (let attempt = 0; attempt < 25 && after.length === before.length; attempt += 1) {
        await sleepMs(20);
        after = await readCacheEvents(logPath);
      }
      let cache = null;
      if (kind === 'messages') {
        const fresh = after.slice(before.length);
        cache = fresh.some((line) => line.includes(`parse ${sessionFile}`)) ? 'cold'
          : fresh.some((line) => line.includes(`hit ${sessionFile}`)) ? 'hit' : 'unknown';
      }
      let containsMark = null;
      if (kind === 'messages' || kind === 'questions') {
        const body = JSON.stringify(r.value ?? '');
        containsMark = { hasBefore: body.includes(MARK_BEFORE), hasAfter: body.includes(MARK_AFTER) };
      }
      return { label, kind, status: r.statusCode, ms: r.elapsedMs, bytes: r.bytes, cache, containsMark, events: kind === 'messages' ? after.slice(before.length) : undefined };
    }

    // 预热：把三条缓存都装满（/tree 需先建立 treeIndex + legacyArchiveCache）。
    await read('tree', 'warm-tree');
    await read('questions', 'warm-questions');
    await read('messages', 'warm-messages');

    // —— A 基线：连读 3 次（应当全命中）——
    readings.phases.A = { tree: [], questions: [], messages: [] };
    for (let index = 0; index < 3; index += 1) {
      readings.phases.A.tree.push(await read('tree', `A-tree-${index}`));
      readings.phases.A.questions.push(await read('questions', `A-questions-${index}`));
      readings.phases.A.messages.push(await read('messages', `A-messages-${index}`));
    }
    readings.phases.A.isBaseline = true;

    // —— B 同内容重写（temp+rename，逐字节相同）——
    // 换完 inode 后把 mtime **钉到整毫秒**：utimes 只认整毫秒，B' 要能逐位回拨到同一个值。
    const beforeB = triple(await stat(sessionFile));
    const bytes = await readFile(sessionFile);
    const tmp = `${sessionFile}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, sessionFile);
    await utimes(sessionFile, RENAMED_MTIME, RENAMED_MTIME);
    const afterB = triple(await stat(sessionFile));
    readings.phases.B = { identity: { before: beforeB, after: afterB }, tree: [], questions: [], messages: [] };
    readings.phases.B.tree.push(await read('tree', 'B-tree-1'));
    readings.phases.B.questions.push(await read('questions', 'B-questions-1'));
    readings.phases.B.messages.push(await read('messages', 'B-messages-1'));
    readings.phases.B.tree.push(await read('tree', 'B-tree-2'));
    readings.phases.B.questions.push(await read('questions', 'B-questions-2'));
    readings.phases.B.messages.push(await read('messages', 'B-messages-2'));

    // —— B' 原地重写 + 回拨 mtime 到 B 之后的值（只有 ctime 变）——
    const beforeBp = triple(await stat(sessionFile));
    await rewriteInPlace(sessionFile, MARK_BEFORE, MARK_AFTER, RENAMED_MTIME);
    const afterBp = triple(await stat(sessionFile));
    readings.phases.Bp = { identity: { before: beforeBp, after: afterBp }, tree: [], questions: [], messages: [] };
    readings.phases.Bp.tree.push(await read('tree', 'Bp-tree-1'));
    readings.phases.Bp.questions.push(await read('questions', 'Bp-questions-1'));
    readings.phases.Bp.messages.push(await read('messages', 'Bp-messages-1'));
    readings.phases.Bp.tree.push(await read('tree', 'Bp-tree-2'));
    readings.phases.Bp.questions.push(await read('questions', 'Bp-questions-2'));
    readings.phases.Bp.messages.push(await read('messages', 'Bp-messages-2'));

    // —— C 纯追加（真增量）——
    const beforeC = triple(await stat(sessionFile));
    const now = new Date().toISOString();
    const appendEntry = { type: 'message', id: 'm-append', parentId: 'q-0001', timestamp: now, message: { role: 'user', content: 'APPENDED-ENTRY-PROBE', timestamp: Date.parse(now) } };
    await writeFile(sessionFile, `${JSON.stringify(appendEntry)}\n`, { flag: 'a' });
    const afterC = triple(await stat(sessionFile));
    readings.phases.C = { identity: { before: beforeC, after: afterC }, tree: [], questions: [], messages: [] };
    readings.phases.C.tree.push(await read('tree', 'C-tree-1'));
    readings.phases.C.questions.push(await read('questions', 'C-questions-1'));
    readings.phases.C.messages.push(await read('messages', 'C-messages-1'));
    readings.phases.C.tree.push(await read('tree', 'C-tree-2'));
    readings.phases.C.questions.push(await read('questions', 'C-questions-2'));
    readings.phases.C.messages.push(await read('messages', 'C-messages-2'));

    readings.sessionFileBytes = (await stat(sessionFile)).size;
    readings.archiveFileBytes = (await stat(archiveFile)).size;

    // ── 直测：三条缓存「失效后重算」的**单项成本**（与上面的端到端 ms 互证）──
    const raw = await readFile(sessionFile, 'utf8');
    const t0 = process.hrtime.bigint();
    const parsed = raw.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
    const parseMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    const archiveText = await readFile(archiveFile, 'utf8');
    const archiveIds = Object.keys(JSON.parse(archiveText)).length;
    const archiveMs = Number(process.hrtime.bigint() - t1) / 1e6;
    // persistedManagerCache 失效后的重算 = `SessionManager.open(file)`（真代码那一步），直测它：
    const openMs = [];
    for (let index = 0; index < 5; index += 1) {
      const t2 = process.hrtime.bigint();
      const manager = SessionManager.open(sessionFile);
      openMs.push(Number(process.hrtime.bigint() - t2) / 1e6);
      manager.getEntries();
    }
    openMs.sort((a, b) => a - b);
    readings.micro = { jsonlParseMs: Number(parseMs.toFixed(2)), jsonlLines: parsed.length, archiveReadParseMs: Number(archiveMs.toFixed(2)), archiveIds, sessionManagerOpenMs: { min: Number(openMs[0].toFixed(2)), median: Number(openMs[Math.floor(openMs.length / 2)].toFixed(2)), max: Number(openMs[openMs.length - 1].toFixed(2)) } };
    return readings;
  } finally {
    if (child && port !== null) {
      const entryPath = entry;
      await cleanupStep(problems, `[${arm}/r${repetition}] stop own listener`, () => stopOwnedListener(port, entryPath, child.pid));
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleepMs(5000)]);
      }
    }
    if (logHandle) await cleanupStep(problems, `[${arm}/r${repetition}] close log`, () => logHandle.close());
    await removeSandbox(sandbox, problems, `[${arm}/r${repetition}] remove sandbox`);
    if (problems.length > 0) throw new Error(`[${arm}/r${repetition}] cleanup problems: ${problems.join('; ')}`);
  }
}

// ───────────────────────── 汇总 ─────────────────────────
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return { n: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1], mean: Number((sum / sorted.length).toFixed(2)) };
};

function collect(armResults) {
  const out = {};
  for (const phase of ['A', 'B', 'Bp', 'C']) {
    const baseline = phase === 'A';
    out[phase] = {};
    for (const kind of ['tree', 'questions', 'messages']) {
      const perRun = armResults.map((r) => r.phases[phase][kind]);
      if (baseline) {
        const all = perRun.flat();
        out[phase][kind] = {
          afterMutationMs: summarize(all.map((x) => x.ms)),
          cache: all.map((x) => x.cache),
          mark: all.map((x) => x.containsMark),
        };
      } else {
        out[phase][kind] = {
          afterMutationMs: summarize(perRun.map((items) => items[0].ms)),
          thenHitMs: summarize(perRun.map((items) => items[1].ms)),
          cacheAfterMutation: perRun.map((items) => items[0].cache),
          markAfterMutation: perRun.map((items) => items[0].containsMark),
        };
      }
    }
    out[phase].identity = armResults.map((r) => r.phases[phase].identity).filter(Boolean);
  }
  return out;
}

let primaryError = null;
const results = {};
try {
  for (const arm of ['real', 'noctime']) {
    results[arm] = [];
    for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
      const reading = await runOnce({ arm, repetition });
      results[arm].push(reading);
      const a = reading.phases.A.messages.map((x) => x.ms).join('/');
      const b = reading.phases.B.messages[0].ms;
      const bp = reading.phases.Bp.messages[0].ms;
      process.stdout.write(`[${arm} r${repetition}] A /messages ms=${a} cache=${reading.phases.A.messages.map((x) => x.cache).join('/')} | B ms=${b} cache=${reading.phases.B.messages[0].cache} | B' ms=${bp} cache=${reading.phases.Bp.messages[0].cache} mark=${JSON.stringify(reading.phases.Bp.messages[0].containsMark)} | C ms=${reading.phases.C.messages[0].ms} cache=${reading.phases.C.messages[0].cache}\n`);
    }
  }
} catch (error) {
  primaryError = error;
}

const report = { fixture: { messages: MESSAGES, chars: MESSAGE_CHARS, archiveEntries: ARCHIVE_ENTRIES, repeats: REPEATS }, results, summary: null };
if (Object.keys(results).length === 2) {
  report.summary = { real: collect(results.real), noctime: collect(results.noctime) };
  print('summary', report.summary);
}

if (JSON_OUT) await writeFile(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

finishCleanup(primaryError, []);
