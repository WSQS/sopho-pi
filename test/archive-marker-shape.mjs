#!/usr/bin/env node
// 门：**归档那一笔到底写没写**、写成什么形状（`sopho.archive` typed 条目）。
//
// 为什么要有这道门（2026-09-25 总台当场撞到的一件）：总台对同一条会话发了两次
// `POST /sessions/{id}/archive`，两次都回 200 `{archived:true, changed:true}`，但
// **会话文件里只多了一条**；并且他把一条**旧的行内文本命中**（`grep -ao 'sopho\.archive[^}]…'`
// 打在一条 bash 工具输出里的**源码注释**上，注释里写着 `sopho.archive{archived:true}`）误读成
// 「legacy 形状的标记」，于是推测「带不带 `fromSessionId` ⇒ 落不同形状」。
//
// 本门钉两件**机械事实**（都可红）：
//   ① **`fromSessionId` 不是变量**：路由只读 `body.archived` / `body.by`（`server/base-logic.mjs` 的
//      `/archive` 处理段），宿主 `SESSION_PATH` 只按**路径**匹配 ⇒ 带与不带 `fromSessionId` 的两次
//      POST，落盘形状与条数必须**逐字相同**（本门逐条比 `data` 与行数）；
//   ② **回执说真话**：`changed:true` ⇒ 会话文件里**必须真的多出恰好一条** typed
//      `{"type":"custom","customType":"sopho.archive","data":{…}}`，且**恰好**落在文件尾；
//      `changed:false` ⇒ 文件一个字节都不动。这条判据把「回执说改了、文件里没有」挡在门外
//      （2026-09-25 那两次 POST 里有一次正是这个形状 —— 本门的目标就是让它必红）。
//
// 三种目标状态各来一遍（同一套判据）：**冷**（建好、落盘、没人持有）、**热**（刚跑完一轮、
// runtime 还在池子里）、**换代码后**（draining 代仍持有）。三格都必须写成功。
//
// 反证臂（`--reverse-arm-receipt-lies`）：把逻辑层副本里 `setArchived` 的那次
// `manager.appendCustomEntry` 摘掉（**只**摘这一行，其余一字不改）⇒ 回执照样 `changed:true`，
// 而文件里没有条目 ⇒ ② 必红。它证明这道门量的是**文件**而不是回执。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { cp, mkdir, mkdtemp, open, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox, runArms, stopSpawnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'sopho-archmarker-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const CWD = path.join(TMP, 'cwd');
const BASE_LOG_PATH = path.join(TMP, 'base.log');
const ARCHIVE_ENTRY = 'sopho.archive';
const REVERSE_RECEIPT_LIES = process.argv.includes('--reverse-arm-receipt-lies');
let BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');
let BASE_CWD = ROOT;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let baseChild;
let baseLog;
let provider;
let basePort;
let providerPort;
let parentId;

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

async function request(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let value;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = raw; }
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
    await sleep(50);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function sseChunk(delta, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-archmarker',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } : {}),
  };
}

// 假 provider：只回一段文字（本门不测插件工具，只需要会话**跑完一轮** ⇒ 落盘且 runtime 变热）。
async function startProvider() {
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    for await (const _ of incoming) { /* drain */ }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify(sseChunk({ role: 'assistant', content: 'FAKE_OK' }))}\n\n`);
    response.write(`data: ${JSON.stringify(sseChunk({}, 'stop', true))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return server;
}

async function sessionFileOf(sessionId) {
  const files = await readdir(SESSIONS, { recursive: true });
  const hit = files.find((entry) => typeof entry === 'string' && entry.endsWith(`${sessionId}.jsonl`));
  if (!hit) return null;
  return path.join(SESSIONS, hit);
}

/** 会话文件的**原始读数**：行数、尾条、以及所有 `sopho.archive` 条目的 `data`（逐条 JSON.parse）。 */
async function markerShape(sessionId) {
  const file = await sessionFileOf(sessionId);
  if (!file) return { file: null, lines: null, entries: null, tailType: null };
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const parsed = lines.map((line) => JSON.parse(line));
  const tail = parsed.at(-1);
  return {
    file,
    lines: lines.length,
    // typed 条目 = **JSON 解析之后**才成立的事实（不是字节 grep）
    entries: parsed.filter((entry) => entry.type === 'custom' && entry.customType === ARCHIVE_ENTRY)
      .map((entry) => entry.data),
    // 字面量出现次数：把「行内文本命中」与「真条目」分开数（那次误读正是把前者当成了后者）
    literalHits: (text.match(/"customType":"sopho\.archive"/g) ?? []).length,
    tailType: tail?.type ?? null,
    tailCustomType: tail?.customType ?? null,
    tailId: tail?.id ?? null,
    tailParentId: tail?.parentId ?? null,
    ids: new Set(parsed.map((entry) => entry.id).filter(Boolean)),
  };
}

/** 归档一次：先把请求原文打出来（证据面），再把**文件前后**两种读数都打出来。 */
async function archiveOnce(label, sessionId, body) {
  const before = await markerShape(sessionId);
  const reply = await request(`/sessions/${encodeURIComponent(sessionId)}/archive`, { method: 'POST', body });
  const after = await markerShape(sessionId);
  const record = {
    label,
    requestBody: body,
    statusCode: reply.status,
    response: reply.value,
    linesBefore: before.lines,
    linesAfter: after.lines,
    entriesBefore: before.entries,
    entriesAfter: after.entries,
    literalHitsBefore: before.literalHits,
    literalHitsAfter: after.literalHits,
    tailBefore: before.tailId,
    tailAfter: after.tailId,
  };
  print(`archive raw [${label}] POST /sessions/${sessionId}/archive ${JSON.stringify(body)}`, record);
  return { reply, before, after, record };
}

/** ② 回执说真话：`changed:true` ⇒ 恰好 +1 条 typed 条目、且落在文件尾；`changed:false` ⇒ 一个字节都不动。 */
function assertReceiptTellsTheTruth(label, { reply, before, after }, expectedArchived = true) {
  assert.equal(reply.status, 200, `${label}: 期望 200，实际 ${reply.status} ${reply.raw}`);
  assert.equal(reply.value?.archived, expectedArchived, `${label}: 回执 archived 必须是 ${expectedArchived}`);
  if (reply.value?.changed === true) {
    assert.equal(after.entries.length, before.entries.length + 1,
      `${label}: 回执说 changed:true ⇒ 文件里必须**真的**多出恰好一条 typed ${ARCHIVE_ENTRY}（前 ${JSON.stringify(before.entries)} / 后 ${JSON.stringify(after.entries)}）`);
    assert.equal(after.lines, before.lines + 1, `${label}: changed:true ⇒ 行数必须 +1（前 ${before.lines} / 后 ${after.lines}）`);
    assert.equal(after.tailCustomType, ARCHIVE_ENTRY, `${label}: 那一刻写下的条目必须落在文件尾（尾条 customType=${after.tailCustomType}）`);
    assert.equal(after.tailParentId, before.tailId, `${label}: 新条目的 parentId 必须是写之前的叶（${JSON.stringify(after.tailParentId)} ≠ ${JSON.stringify(before.tailId)}）`);
  } else {
    assert.equal(after.lines, before.lines, `${label}: changed:false ⇒ 行数不许变（前 ${before.lines} / 后 ${after.lines}）`);
    assert.equal(after.entries.length, before.entries.length, `${label}: changed:false ⇒ 条目数不许变`);
  }
  // 幂等口径：最新一条就是请求的状态。
  assert.equal(after.entries.at(-1)?.archived, expectedArchived, `${label}: 最新一条 ${ARCHIVE_ENTRY} 必须说 archived:${expectedArchived}`);
}

const createSession = async (cwd, name) => {
  const created = await request('/sessions', { method: 'POST', body: { cwd, name } });
  assert.equal(created.status, 201, created.raw);
  // 热身：pi 在第一条 assistant 消息落盘前不写文件 ⇒ 会话必须落盘才能走真实的 openPersisted 路。
  assert.equal((await request(`/sessions/${created.value.id}/message`, { method: 'POST', body: { text: `${name}_WARM` } })).status, 202);
  await poll(`session ${name} settles`, () => request(`/sessions/${created.value.id}`),
    (reply) => reply.value?.runtime?.isStreaming === false && (reply.value?.pendingMessages ?? 0) === 0, 60_000);
  assert.ok(await sessionFileOf(created.value.id), `${name} 热身之后应当落盘`);
  return created.value.id;
};

let primaryError = null;
try {
  for (const directory of [HOME, SESSIONS, CWD]) await mkdir(directory, { recursive: true });
  if (REVERSE_RECEIPT_LIES) {
    // 反证臂：副本树里只把「真的写文件」那一行摘掉（回执照旧说 changed:true）⇒ ② 必红。
    const tree = path.join(TMP, 'reverse-tree');
    await mkdir(tree, { recursive: true });
    for (const part of ['server', 'pi-extensions']) await cp(path.join(ROOT, part), path.join(tree, part), { recursive: true });
    await cp(path.join(ROOT, 'package.json'), path.join(tree, 'package.json'));
    await symlink(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'), 'junction');
    const logicPath = path.join(tree, 'server', 'base-logic.mjs');
    const source = await readFile(logicPath, 'utf8');
    const from = "      manager.appendCustomEntry(ARCHIVE_ENTRY, { ...meta, archived: Boolean(archived) });\n";
    assert.ok(source.includes(from), '反证臂：要摘掉的那一行在逻辑层里找得到');
    await writeFile(logicPath, source.replace(from, '      // REVERSE ARM: 摘掉真正的写（回执照旧 changed:true）\n'));
    BASE_ENTRY = path.join(tree, 'server', 'base.mjs');
    BASE_CWD = tree;
    print('reverse-arm mutation', { arm: 'receipt-lies', mutation: 'setArchived 不再 appendCustomEntry', tree });
  }

  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used); used.add(basePort);
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-archmarker', name: 'Fake archive marker', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-archmarker', defaultThinkingLevel: 'off', compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 1 } }, null, 2)}\n`);

  provider = await startProvider();
  baseLog = await open(BASE_LOG_PATH, 'w');
  baseChild = spawn(process.execPath, [BASE_ENTRY], {
    cwd: BASE_CWD,
    env: {
      ...process.env,
      HOME,
      ASSIST_HOME: HOME,
      SOPHO_AGENT_DIR: HOME,
      PI_CODING_AGENT_DIR: HOME,
      PI_CODING_AGENT_SESSION_DIR: SESSIONS,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: CWD,
      SOPHO_MAX_HOT: '8',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => request('/host'), (reply) => reply.status === 200, 40_000);

  parentId = await createSession(CWD, 'marker-parent');

  const arms = [
    ['① 热目标（刚跑完一轮、runtime 还在池子里）＋ 不带 `fromSessionId`／不带 `by` ⇒ 文件里恰好 +1 条 typed 条目', async () => {
      const target = await createSession(CWD, 'hot-plain');
      const run = await archiveOnce('热·不带 fromSessionId', target, { archived: true });
      assertReceiptTellsTheTruth('热·不带 fromSessionId', run);
      assert.equal(run.after.entries.length, 1, '热目标：恰好一条');
      assert.equal(run.after.entries[0].by, undefined, '不带 `by` ⇒ 条目里不许凭空多出 by（写法逐字不变）');
      return run.record;
    }],

    ['② 同一条路、同一个状态，**带** `fromSessionId` ⇒ 与 ① 逐字同形（`fromSessionId` 不是变量）', async () => {
      const target = await createSession(CWD, 'hot-with-from');
      const withField = await archiveOnce('热·带 fromSessionId', target, { archived: true, fromSessionId: parentId });
      assertReceiptTellsTheTruth('热·带 fromSessionId', withField);
      assert.equal(withField.after.entries.length, 1, '带 `fromSessionId`：同样恰好一条');
      // 逐字同形的机械判据：两次落盘的条目字段集合相同（都不带 by/at —— 因为路由根本不读 fromSessionId）。
      const plain = await archiveOnce('热·同形对照（撤销后再归档回来）', target, { archived: false });
      assertReceiptTellsTheTruth('热·同形对照（archived:false）', plain, false);
      const again = await archiveOnce('热·同形对照（再归档）', target, { archived: true });
      assert.equal(JSON.stringify(again.after.entries.at(-1)), JSON.stringify(withField.after.entries.at(-1)),
        '同一条路两次 POST（带/不带 `fromSessionId`）落下的条目必须逐字相同');
      return { withField: withField.record, control: again.record };
    }],

    ['③ 冷目标（落盘、但没人持有 runtime）⇒ 同样 +1 条 typed 条目', async () => {
      const target = await createSession(CWD, 'cold-plain');
      // 让它真的冷：换一代（旧代的 runtime 进 draining，新代里它是冷的）＋ 等旧代退干净。
      const rotated = await request('/reload-code', { method: 'POST', body: {} });
      assert.equal(rotated.status, 200, `POST /reload-code -> ${rotated.status} ${rotated.raw}`);
      await poll('old generation drains', () => request('/host'), (reply) => (reply.value?.workers ?? []).length === 1, 60_000);
      const run = await archiveOnce('冷·不带 fromSessionId', target, { archived: true });
      assertReceiptTellsTheTruth('冷·不带 fromSessionId', run);
      assert.equal(run.after.entries.length, 1, '冷目标：恰好一条');
      return run.record;
    }],

    ['④ 换代码之后（draining 代仍持有该会话）⇒ 同样 +1 条 typed 条目', async () => {
      const target = await createSession(CWD, 'draining-plain');
      const rotated = await request('/reload-code', { method: 'POST', body: {} });
      assert.equal(rotated.status, 200, `POST /reload-code -> ${rotated.status} ${rotated.raw}`);
      // 不等待旧代退：此刻它就是「draining 代仍持有」的形状（本门要的正是这一格）。
      const host = await request('/host');
      print('draining 现场', { workers: (host.value?.workers ?? []).map((worker) => ({ generationId: worker.generationId, draining: worker.draining, sessions: (worker.sessions ?? []).length })) });
      const run = await archiveOnce('draining·不带 fromSessionId', target, { archived: true });
      assertReceiptTellsTheTruth('draining·不带 fromSessionId', run);
      assert.equal(run.after.entries.length, 1, 'draining 目标：恰好一条');
      return run.record;
    }],

    ['⑤ 幂等：同一状态再归档一次 ⇒ `changed:false` 且文件一个字节都不动', async () => {
      const target = await createSession(CWD, 'idempotent-plain');
      const first = await archiveOnce('幂等·第一次', target, { archived: true });
      assertReceiptTellsTheTruth('幂等·第一次', first);
      const second = await archiveOnce('幂等·第二次（同一状态）', target, { archived: true });
      assert.equal(second.reply.value?.changed, false, `幂等：第二次必须 changed:false（实际 ${JSON.stringify(second.reply.value)}）`);
      assertReceiptTellsTheTruth('幂等·第二次', second);
      return { first: first.record, second: second.record };
    }],
  ];

  const { failed } = await runArms(arms, { title: REVERSE_RECEIPT_LIES ? 'archive-marker-shape (reverse: receipt-lies)' : 'archive-marker-shape' });
  if (failed.length === 0 && !REVERSE_RECEIPT_LIES) {
    print('RESULT', 'archive-marker-shape PASS (每次 changed:true 都真的 +1 条 typed sopho.archive；fromSessionId 不是变量；冷/热/draining 三格同判据)');
  } else if (failed.length > 0) {
    print('RESULT', `archive-marker-shape RED (${failed.length} arm(s)) — ${failed.map((item) => item.name).join(' | ')}`);
  }
} catch (error) {
  primaryError = error;
  let logTail = '';
  try { logTail = (await readFile(BASE_LOG_PATH, 'utf8')).slice(-8000); } catch { /* no log */ }
  if (logTail) process.stderr.write(`\nbase log tail:\n${logTail}\n`);
} finally {
  const problems = [];
  await cleanupStep(problems, 'stop sandbox host', async () => {
    if (provider) await new Promise((resolve) => provider.close(resolve));
    await stopSpawnedListener(baseChild, basePort, path.join('server', 'base.mjs'));
  });
  await cleanupStep(problems, 'remove sandbox', async () => { await removeSandbox(TMP, problems, 'remove archive-marker sandbox'); });
  finishCleanup(primaryError, problems);
}
