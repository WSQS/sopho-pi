#!/usr/bin/env node
// test/tool-duration-server.mjs —— 工具卡耗时的**服务端那一半**：`/messages` 里每个工具调用要带
// `startedAt` / `endedAt`，跑完的就是那两个 entry 的 timestamp **逐字**，没跑完的 `endedAt` 必须是 `null`。
//
// 为什么要这一道门：TUI 的 shell 渲染器在工具卡里写一行 muted 的 `Elapsed`/`Took ${(ms/1000).toFixed(1)}s`
// （`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/bash.js:23`、`:93-95`），
// 而我们网页没有 pi 那种「渲染时开始计时」的时刻（页面可以在工具跑着的时候才打开）⇒ 时间基准只能由
// 服务端给。这一层「给不出来就 null」的口径**改了不会让别的门变红**，所以必须有人逐字断言。
//
// 判据（三条 + 两条诚实性）：
//   ① 完成：`startedAt` = 带该 toolCall 的 assistant entry 的 timestamp、`endedAt` = 配对 toolResult
//      entry 的 timestamp —— **逐字对账**（不信任实现算出来的毫秒差，直接比字符串）；
//   ② 未完成（只有调用、没有结果条目）⇒ `endedAt === null`，`startedAt` 照给；
//   ③ 取不到（entry 缺 timestamp / 不是字符串 / 解析不出时间）⇒ **两个字段都 `null`**（不许兜出别的值）；
//   ④ 一条 assistant 消息里两个 toolCall ⇒ 共用同一个 `startedAt`（这是**近似**：含排队时间）、
//      各自的 `endedAt` 用各自结果的 timestamp；
//   ⑤ 结果条目缺 timestamp ⇒ `endedAt === null`（`startedAt` 仍然给，不许连坐）。
//
// 夹具是**手写会话文件**（固定 uuid / 固定 ISO 时间戳），不起 pi runtime 的推理 —— 只打 `GET
// /sessions/{id}/messages`。原始证据：把 wire 里那几条工具 part 原样打印出来。
//
// **反证臂**：把投影那两行去掉（在**一份 server/ 的临时副本**里改，主树文件一字不动）⇒ ① 必红。
// 判据只有一条：那一版给出的 `startedAt` 不是夹具里那个 timestamp（是个 undefined）。
//
// 铁律：只起**自己 spawn** 的 A（高位随机端口 + 临时 home/日志）；不碰真 profile；不用 7331/7321；
// 不 pkill（只按自己 spawn 的 child 停）；`node_modules` / `pi-extensions` 用 junction/symlink 挂过去。
//
// 用法：
//   node test/tool-duration-server.mjs          # 修后绿 + 反证臂（反证臂必须红）
//   node test/tool-duration-server.mjs --keep   # 保留夹具目录（打印路径）

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { hostStatus, poll, request, reserveHighPort, writeMinimalHome } from './perf-verify-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

/** 固定 uuid：夹具的「已知内容」从这一条起就是确定的。 */
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const T0 = '2026-09-01T00:00:00.000Z';
const iso = (seconds) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

// 夹具的真值（断言逐字用它们，不另算一份）：[秒] = 相对 T0 的秒数。
const TRUTH = {
  done: { startedAt: iso(10), endedAt: iso(13.4) },          // 3400 ms ⇒ 前端那半要画 `3.4s`
  open: { startedAt: iso(20), endedAt: null },              // 没有结果条目
  legacyResult: { startedAt: iso(30), endedAt: null },      // 结果条目**没有** timestamp
  noStart: { startedAt: null, endedAt: iso(52) },           // entry 没有 timestamp（老文件）
  badStart: { startedAt: null, endedAt: iso(54) },          // timestamp 不是合法时间
  numberStart: { startedAt: null, endedAt: iso(56) },       // timestamp 是数字（不是 ISO 字符串）
  pairA: { startedAt: iso(40), endedAt: iso(41) },          // 同一条消息两个调用：共用 startedAt
  pairB: { startedAt: iso(40), endedAt: iso(42.5) },
};

function buildEntries({ cwd }) {
  const entries = [];
  let parentId = null;
  const push = (entry) => { entries.push(entry); parentId = entry.id; };
  const assistant = (id, timestamp, calls) => ({
    type: 'message', id, parentId, ...(timestamp === undefined ? {} : { timestamp }),
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: `PARITY-${id}` },
        ...calls.map(([callId, name]) => ({ type: 'toolCall', id: callId, name, arguments: { command: 'echo hi' } })),
      ],
      api: 'fixture', provider: 'fixture', model: 'fixture-model', stopReason: 'toolUse',
    },
  });
  const result = (id, timestamp, callId) => ({
    type: 'message', id, parentId, ...(timestamp === undefined ? {} : { timestamp }),
    message: { role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text: `OUT-${callId}` }], isError: false },
  });

  entries.push({ type: 'session', version: 3, id: SESSION_ID, timestamp: T0, cwd });
  entries.push({ type: 'session_info', id: 'i0000001', parentId: null, timestamp: iso(1), name: 'tool duration fixture' });

  // ① 完成：startedAt/endedAt 逐字 = 这两条 entry 的 timestamp（差 3.4s）。
  push(assistant('m0000001', TRUTH.done.startedAt, [['call_done', 'bash']]));
  push(result('r0000001', TRUTH.done.endedAt, 'call_done'));

  // ② 未完成：只有调用、没有结果条目。
  push(assistant('m0000002', TRUTH.open.startedAt, [['call_open', 'bash']]));

  // ③ 结果条目在文件里**没有** timestamp ⇒ endedAt 必须是 null（startedAt 照给）。
  push(assistant('m0000003', TRUTH.legacyResult.startedAt, [['call_legacy_result', 'bash']]));
  push(result('r0000003', undefined, 'call_legacy_result'));

  // ④ 一条 assistant 消息里两个 toolCall：共用一个 startedAt，各自 endedAt。
  push(assistant('m0000004', TRUTH.pairA.startedAt, [['call_pair_a', 'bash'], ['call_pair_b', 'read']]));
  push(result('r0000004a', TRUTH.pairA.endedAt, 'call_pair_a'));
  push(result('r0000004b', TRUTH.pairB.endedAt, 'call_pair_b'));

  // ⑤ 老文件的三种「取不到 startedAt」：缺字段 / 不是合法时间 / 是数字（不是 ISO 字符串）。
  push(assistant('m0000005', undefined, [['call_no_start', 'bash']]));
  push(result('r0000005', TRUTH.noStart.endedAt, 'call_no_start'));
  push(assistant('m0000006', 'not-a-date', [['call_bad_start', 'bash']]));
  push(result('r0000006', TRUTH.badStart.endedAt, 'call_bad_start'));
  push(assistant('m0000007', Date.parse(iso(55)), [['call_number_start', 'bash']]));
  push(result('r0000007', TRUTH.numberStart.endedAt, 'call_number_start'));

  return entries;
}

/** 造夹具 home（只写临时目录），返回 `{home,sessionsRoot,workspace,file,cleanup}`。 */
async function createFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sopho-tooldur-'));
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(home, 'workspace');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeMinimalHome(home, workspace);
  const entries = buildEntries({ cwd: workspace });
  const file = path.join(sessionsRoot, `fixture_${SESSION_ID}.jsonl`);
  const stream = createWriteStream(file, { encoding: 'utf8' });
  for (const entry of entries) stream.write(`${JSON.stringify(entry)}\n`);
  await new Promise((resolve, reject) => stream.end(resolve).once('error', reject));
  return { home, sessionsRoot, workspace, file, entries, cleanup: async () => { await rm(home, { recursive: true, force: true }); } };
}

/**
 * 一份 **server/ 的临时副本**（`node_modules` / `pi-extensions` 用 junction/symlink 挂回本仓）：
 * 反证臂就在这份副本里把投影去掉 —— 主树 `server/base-logic.mjs` 一个字节都不动。
 * 为什么必须换一棵树：`server/base.mjs` 用 `import.meta.url` 定位 `server/worker.mjs`，
 * 而 worker 又相对自己 import `./base-logic.mjs`，所以「换一版逻辑」只能连目录一起换。
 */
async function createRuntimeCopy({ revert }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sopho-tooldur-rt-'));
  await cp(path.join(root, 'server'), path.join(dir, 'server'), { recursive: true });
  await symlink(path.join(root, 'pi-extensions'), path.join(dir, 'pi-extensions'), 'junction');
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  if (revert) {
    const file = path.join(dir, 'server', 'base-logic.mjs');
    const source = await readFile(file, 'utf8');
    const marker = '    call.part.startedAt = entryTimestamp(call.message.timestamp);\n'
      + '    call.part.endedAt = result ? entryTimestamp(result.timestamp) : null;\n';
    assert.ok(source.includes(marker), '反证臂的补丁锚点不在了 —— 这条臂不是「去掉投影」，它什么都没改（必须红）');
    await writeFile(file, source.replace(marker, ''));
  }
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

async function startRuntime({ runtimeDir, fixture }) {
  const port = await reserveHighPort();
  const logPath = path.join(fixture.home, `base-${path.basename(runtimeDir)}.log`);
  const logHandle = await open(logPath, 'w');
  const child = spawn(process.execPath, [path.join(runtimeDir, 'server', 'base.mjs')], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      HOME: fixture.home,
      ASSIST_HOME: fixture.home,
      SOPHO_AGENT_DIR: fixture.home,
      PI_CODING_AGENT_DIR: fixture.home,
      PI_CODING_AGENT_SESSION_DIR: fixture.sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: fixture.workspace,
      SOPHO_NO_TOOLS: '1',
    },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 15_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await logHandle.close().catch(() => {});
  };
  await poll(`sandbox A ready (${path.basename(runtimeDir)})`, () => hostStatus(port), (host) => host?.currentWorkerPid > 0, 90_000);
  return { port, child, stop, logPath };
}

/** wire 里全部工具 part：`{toolCallId, startedAt, endedAt, status, name}`。 */
function toolParts(payload) {
  const out = [];
  for (const message of payload.messages ?? []) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts ?? []) {
      if (part.type !== 'tool') continue;
      out.push({ toolCallId: part.toolCallId, name: part.name, status: part.status, startedAt: part.startedAt, endedAt: part.endedAt, entryId: message.entryId });
    }
  }
  return out;
}

const byId = (parts, id) => parts.find((part) => part.toolCallId === id) ?? null;

async function armFor({ revert, fixture }) {
  const copied = await createRuntimeCopy({ revert });
  let runtime = null;
  try {
    runtime = await startRuntime({ runtimeDir: copied.dir, fixture });
    const response = await request(runtime.port, `/sessions/${SESSION_ID}/messages`, { timeoutMs: 120_000 });
    assert.equal(response.statusCode, 200, `GET /messages -> ${response.statusCode} ${response.raw?.slice(0, 400)}`);
    return { payload: response.value, parts: toolParts(response.value), port: runtime.port, logPath: runtime.logPath };
  } finally {
    // 无论断言怎么炸，只按自己 spawn 的那个 pid 停（不 pkill、不扫端口）。
    await runtime?.stop?.();
    await copied.cleanup();
  }
}

const problems = [];
const record = (ok, name, detail) => {
  if (ok) print(`✓ ${name}`, detail);
  else problems.push(`${name} —— ${detail}`);
};

/** 修后的判据（反证臂跑同一段：它**应该**在这里红，红的内容会被原样记下来）。 */
function judge(parts) {
  const failures = [];
  const check = (name, ok, detail) => { if (!ok) failures.push(`${name} —— ${detail}`); else print(`✓ ${name}`, detail); };

  const done = byId(parts, 'call_done');
  check('① 完成的调用：startedAt/endedAt 逐字等于夹具里的两个 timestamp',
    done !== null && done.startedAt === TRUTH.done.startedAt && done.endedAt === TRUTH.done.endedAt,
    `实测 ${JSON.stringify(done && { startedAt: done.startedAt, endedAt: done.endedAt })}，真值 ${JSON.stringify(TRUTH.done)}`);

  const open = byId(parts, 'call_open');
  check('② 未完成（只有调用、没有结果条目）：startedAt 照给、endedAt === null',
    open !== null && open.startedAt === TRUTH.open.startedAt && open.endedAt === null,
    `实测 ${JSON.stringify(open && { startedAt: open.startedAt, endedAt: open.endedAt })}，真值 ${JSON.stringify(TRUTH.open)}`);

  const legacy = byId(parts, 'call_legacy_result');
  check('③ 结果条目缺 timestamp ⇒ endedAt === null（startedAt 不连坐）',
    legacy !== null && legacy.startedAt === TRUTH.legacyResult.startedAt && legacy.endedAt === null,
    `实测 ${JSON.stringify(legacy && { startedAt: legacy.startedAt, endedAt: legacy.endedAt })}，真值 ${JSON.stringify(TRUTH.legacyResult)}`);

  for (const [id, truth, why] of [
    ['call_no_start', TRUTH.noStart, 'entry 缺 timestamp'],
    ['call_bad_start', TRUTH.badStart, 'timestamp 不是合法时间'],
    ['call_number_start', TRUTH.numberStart, 'timestamp 是数字（不是 ISO 字符串）'],
  ]) {
    const part = byId(parts, id);
    check(`③ ${why} ⇒ startedAt === null 且 endedAt 照给`,
      part !== null && part.startedAt === null && part.endedAt === truth.endedAt,
      `实测 ${JSON.stringify(part && { startedAt: part.startedAt, endedAt: part.endedAt })}，真值 ${JSON.stringify(truth)}`);
  }

  const pairA = byId(parts, 'call_pair_a');
  const pairB = byId(parts, 'call_pair_b');
  check('④ 一条消息里两个调用：共用同一个 startedAt，各自 endedAt（近似含排队时间）',
    pairA !== null && pairB !== null
      && pairA.startedAt === TRUTH.pairA.startedAt && pairB.startedAt === TRUTH.pairA.startedAt
      && pairA.endedAt === TRUTH.pairA.endedAt && pairB.endedAt === TRUTH.pairB.endedAt,
    `实测 A=${JSON.stringify(pairA && { startedAt: pairA.startedAt, endedAt: pairA.endedAt })} B=${JSON.stringify(pairB && { startedAt: pairB.startedAt, endedAt: pairB.endedAt })}`);

  // 反面：这一版**多给**了别的工具字段之外的东西不算错，但「没时间戳却给了一个数」一定是错。
  check('③ 反面：没有一条 part 凭空拿到数字型（ms）时间戳',
    parts.every((part) => part.startedAt === null || typeof part.startedAt === 'string'),
    JSON.stringify(parts.map((part) => part.startedAt)));

  return failures;
}

const keep = process.argv.includes('--keep');
const fixture = await createFixture();
print('夹具', { home: fixture.home, file: fixture.file, sessionId: SESSION_ID, entries: fixture.entries.length });
print('夹具真值（秒偏移，逐字用）', TRUTH);

let primaryError = null;
try {
  // ── 修后臂：本仓现在这版逻辑 ────────────────────────────────────────────────
  const afterRevision = await armFor({ revert: false, fixture });
  print('修后臂 · 沙箱 A 口', afterRevision.port);
  print('修后臂 · 工具 part 原样（wire）', afterRevision.parts);
  const afterFailures = judge(afterRevision.parts);
  assert.deepEqual(afterFailures, [], `修后臂应当全绿，却红了：\n  ${afterFailures.join('\n  ')}`);
  print('修后臂结论', { parts: afterRevision.parts.length, failures: afterFailures.length });

  // ── 反证臂：把投影那两行去掉（在临时副本里）⇒ 判据必须红 ─────────────────────
  const beforeRevision = await armFor({ revert: true, fixture });
  print('反证臂 · 沙箱 A 口', beforeRevision.port);
  print('反证臂 · 工具 part 原样（wire）', beforeRevision.parts);
  const revertedFailures = judge(beforeRevision.parts);
  assert.ok(revertedFailures.length > 0, '反证臂（去掉投影）竟然还是绿的 —— 这条臂没有证明任何东西（必须红）');
  print('反证臂 · 修复前红（原始结论，逐条）', revertedFailures);
  print('反证臂结论', { parts: beforeRevision.parts.length, failures: revertedFailures.length });

  print('RESULT', `tool duration server PASS（修后 ${afterRevision.parts.length} 个工具 part 全绿；反证臂 ${revertedFailures.length} 条红）`);
} catch (error) {
  primaryError = error;
} finally {
  if (!keep) await fixture.cleanup().catch((error) => problems.push(`cleanup fixture: ${error.message}`));
  else print('保留夹具', fixture.home);
  if (problems.length) process.stderr.write(`cleanup problems (secondary): ${problems.join(' | ')}\n`);
  if (primaryError) {
    process.stderr.write(`${primaryError.stack ?? primaryError.message}\n`);
    process.exitCode = 1;
  }
}
