#!/usr/bin/env node
// `GET /debug/instances` 的验收门（真沙箱：真起 A + 真 worker，高位随机端口）。
//
// 这条端点给 **UI** 供数（不是给 agent 用的工具），所以**形状对不够**——本单的关键判据是**只读性**：
//   调用前后「池状态」与「会话文件的 size/mtime」必须一字不变。
//   （反证臂：把端点改成会 evict，本门那一条必红——见交付报告。）
//
// 断言分七组：
//   ① 只读性（先跑它）：池 summary / hot 集合 / 按会话表（除时间量 idleForMs 外）＋ 每个会话文件
//      的 size/mtimeMs 前后一字不变；idleForMs 只许**变大**（变大才说明没有 acquire 重置 lastAccessAt）。
//   ② 形状：200 ＋ worker 块（pid/uptime/rss/heapUsed/external）＋ 池的按会话表（含复用
//      reclaim/dryRun 那套判据的 evictionEligible / blockers / pinReasons / idleForMs）。
//   ③ 是「worker 的」事实：worker.pid ≠ 宿主 pid，且与 host.worker.rssBytes 同源。
//   ④ 策略阈值 ＋ host 块 ＋ `unavailable` 非空（取不到的字段如实点名）。
//   ⑤ 工具清单块：逐条形状（含业主 2026-09-26 那条「分组」：每个工具非空 group ＋ 合法 groupSource，
//      分组视图与逐工具字段一致，声明表覆盖全部工具）＋ 每条热会话各有一份 `active`（**会话级**，
//      不是 worker 级常数）＋ `observedOn` 点名它是从哪条会话读的 ＋ 没有热 runtime 时如实写「取不到」。
//   ⑥ 回合**在飞**时读同一张表：那一行必须是 running / in_flight_turn / 不可回收（“谁挡着、为什么挡”）。
//   ⑦ 只读边角：POST /debug/instances 如实 405，不是静默接受。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, runGateOnMutatedCopy, stopSpawnedListener } from './harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 反证臂用它指向「改过一处的副本」；正常跑就是真树。
const sourceRoot = process.env.SOPHO_DEBUG_GATE_ROOT ? path.resolve(process.env.SOPHO_DEBUG_GATE_ROOT) : repoRoot;
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
// 沙箱在 `runGate()` 里建（反证臂模式不打自己的沙箱，免得留一个没人删的目录）。
let sandbox;
let home;
let cwd;
let sessionsRoot;
let baseLogPath;
let baseEntry;
// 假 provider 用：一个提示词让回合被拖住，好在「真在跑」的 runtime 上读一次池表与工具面。
const SLOW_PROMPT = 'SLOW_TURN_FOR_DEBUG_INSTANCES';
let providerServer;
let baseChild;
let baseLog;
let providerPort;
let basePort;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value, raw: text };
}

async function poll(label, operation, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    // 刚开始的 ECONNREFUSED 是**预期**的（A 还没 listen 完）：这不是失败，是「还没好」。
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(40);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

async function waitIdle(id) {
  return poll(`session ${id} idle`, () => api(`/sessions/${id}`), (reply) => reply.statusCode === 200 && reply.value.runtime?.isStreaming !== true, 20_000);
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((part) => part?.text || '').join('');
}

function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messageText(messages[index]);
  }
  return '';
}

function completionChunk(delta, finishReason = null) {
  return { id: 'chatcmpl-debug', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-debug-instances', choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

// 会话文件的「size/mtime 一字不变」就是拿这个量：只读 stat，不读内容。
async function sessionFileStats() {
  const names = (await readdir(sessionsRoot)).sort();
  const rows = {};
  for (const name of names) {
    const info = await stat(path.join(sessionsRoot, name));
    rows[name] = { size: info.size, mtimeMs: info.mtimeMs };
  }
  return rows;
}

// 池的「事实快照」：/host 的口径（summary + 每个 worker 持有的会话 id 集合）。
function poolFacts(host) {
  return {
    pool: host.pool,
    workerSessions: (host.workers ?? []).map((worker) => ({ generationId: worker.generationId, state: worker.state, sessions: worker.sessions })),
  };
}

// 判据表（复用 reclaim 的那套）去掉时间量后的样子：用它比较「表本身」有没有被动过。
function sessionRowsWithoutIdle(body) {
  return (body.pool?.sessions ?? []).map(({ idleForMs, ...rest }) => rest);
}

function sessionFileFor(id, cwdPath) {
  const now = new Date().toISOString();
  return `${[
    { type: 'session', version: 3, id, timestamp: now, cwd: cwdPath },
    { type: 'message', id: `${id}-user`, parentId: null, timestamp: now, message: { role: 'user', content: 'debug instances probe', timestamp: Date.now() } },
  ].map(JSON.stringify).join('\n')}\n`;
}

async function startFakeProvider() {
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const prompt = latestUserText(body.messages).trim();
    // 故意拖住这一轮：让池表与工具面能在一个**真在跑**的 runtime 上被读到。
    if (prompt === SLOW_PROMPT) await sleep(2500);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify(completionChunk({ role: 'assistant', content: 'noop' }))}\n\n`);
    response.write(`data: ${JSON.stringify(completionChunk({}, 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server };
}

async function runGate() {
  let primaryError;
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'debug-instances-'));
  home = path.join(sandbox, 'home');
  cwd = path.join(sandbox, 'workspace');
  sessionsRoot = path.join(home, 'sessions');
  baseLogPath = path.join(sandbox, 'base.log');
  baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
  try {
  for (const directory of [home, cwd, sessionsRoot]) await mkdir(directory, { recursive: true });
  const used = new Set();
  providerPort = await reserveHighPort(used); used.add(providerPort);
  basePort = await reserveHighPort(used); used.add(basePort);

  const sessionIds = [randomUUID(), randomUUID()];
  for (const id of sessionIds) await writeFile(path.join(sessionsRoot, `seed_${id}.jsonl`), sessionFileFor(id, cwd));

  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    api: 'openai-completions',
    apiKey: 'sandbox',
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{ id: 'fake-debug-instances', name: 'Debug Instances Fake', contextWindow: 4096, maxTokens: 512 }],
  } } }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake', defaultModel: 'fake-debug-instances', defaultThinkingLevel: 'off',
    compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  providerServer = await startFakeProvider();
  baseLog = await open(baseLogPath, 'w');
  baseChild = spawn(process.execPath, [baseEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: cwd,
      SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => api('/host'), (reply) => reply.statusCode === 200, 30_000);
  assert.equal(Number(await listenerPid(basePort)), baseChild.pid);
  print('sandbox', { home, providerPort, basePort, basePid: baseChild.pid, sessionIds, forbiddenPortsUsed: false });

  // 两条会话都真的开成 runtime（热的）：没有热 runtime 的池表是空表，也读不到工具面。
  // `GET /sessions/{id}` 只读元数据、**不** acquire —— 必须真跑一个回合才会把 runtime 热起来。
  for (const id of sessionIds) {
    const sent = await api(`/sessions/${id}/message`, { method: 'POST', body: { text: 'warm up this runtime' } });
    assert.equal(sent.statusCode, 202, sent.raw);
    await waitIdle(id);
  }
  const hostBefore = (await api('/host')).value;
  assert.equal(hostBefore.pool.hot, 2, `expected 2 hot runtimes, got ${JSON.stringify(hostBefore.pool)}`);
  // 落定之后再取样：回合结束那次持久化写完了才比较，否则「文件变了」这一条会跟聊天的写混在一起。
  await sleep(300);

  const before = {
    pool: poolFacts(hostBefore),
    files: await sessionFileStats(),
    debug: (await api('/debug/instances')).value,
  };
  print('poolBefore', hostBefore.pool);
  print('sessionFilesBefore', before.files);

  // ——— 被测调用：一次 GET /debug/instances ———
  const reply = await api('/debug/instances');
  assert.equal(reply.statusCode, 200, reply.raw);
  const body = reply.value;
  print('GET /debug/instances raw', reply.raw);
  assert.equal(body.readOnly, true);
  assert.equal(body.endpoint, 'GET /debug/instances');

  const after = {
    pool: poolFacts((await api('/host')).value),
    files: await sessionFileStats(),
    debug: (await api('/debug/instances')).value,
  };

  // ① 只读性（本单的关键判据，先跑它）——池状态与会话文件的 size/mtime 一字不变
  assert.deepEqual(after.pool, before.pool, 'the pool state changed across GET /debug/instances');
  assert.deepEqual(after.files, before.files, 'a session file size/mtime changed across GET /debug/instances');
  assert.deepEqual(sessionRowsWithoutIdle(after.debug), sessionRowsWithoutIdle(before.debug), 'the per-session table changed (only the time-derived idleForMs may move)');
  const idleBefore = new Map(before.debug.pool.sessions.map((row) => [row.sessionId, row.idleForMs]));
  for (const row of after.debug.pool.sessions) {
    assert.ok(row.idleForMs >= idleBefore.get(row.sessionId), `idleForMs must not be reset by the read (session ${row.sessionId})`);
  }
  // 反面：runtime 还活着、还答得上来（不是被偷偷收掉了才「没变化」）
  assert.equal(after.pool.pool.hot, 2);
  assert.equal(after.debug.pool.sessions.length, 2);
  print('readOnlyProof', {
    poolBefore: JSON.stringify(before.pool.pool),
    poolAfter: JSON.stringify(after.pool.pool),
    filesBefore: JSON.stringify(before.files),
    filesAfter: JSON.stringify(after.files),
    idleForMsBefore: [...idleBefore.entries()],
    idleForMsAfter: after.debug.pool.sessions.map((row) => [row.sessionId, row.idleForMs]),
    hotAfter: after.pool.pool.hot,
  });

  // ② 形状：worker 自身
  assert.equal(Number.isInteger(body.worker.pid), true);
  assert.equal(body.worker.pid, hostBefore.currentWorkerPid, 'worker.pid must be the serving worker, not the host');
  assert.notEqual(body.worker.pid, hostBefore.pid, 'the endpoint must run inside the worker, not the host');
  assert.equal(body.worker.generationId, hostBefore.currentGenerationId);
  assert.equal(typeof body.worker.uptimeSeconds, 'number');
  assert.ok(body.worker.uptimeSeconds > 0);
  for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
    assert.equal(typeof body.worker.memory[key], 'number', `worker.memory.${key} must be a number`);
    assert.ok(body.worker.memory[key] > 0, `worker.memory.${key} must be > 0`);
  }
  assert.equal(typeof body.worker.logicVersion, 'string');
  assert.equal(typeof body.worker.codeRevision, 'string');

  // ③ 与 host 的 worker 视图同源（不是编出来的第二个进程）
  assert.equal(body.worker.memory.rss, body.host.worker.rssBytes);
  assert.equal(body.host.generationId, body.worker.generationId);
  assert.equal(body.host.pool.hot, 2);

  // ④ 池的按会话表：复用 reclaim/dryRun 那套判据
  assert.equal(Array.isArray(body.pool.sessions), true);
  assert.equal(body.pool.sessions.length, 2, JSON.stringify(body.pool));
  const rowsById = new Map(body.pool.sessions.map((row) => [row.sessionId, row]));
  for (const id of sessionIds) {
    const row = rowsById.get(id);
    assert.ok(row, `pool.sessions must include ${id}`);
    for (const field of ['runtimeState', 'acquiredLeases', 'pinReasons', 'idleForMs', 'evictionEligible', 'blockers', 'durable', 'generationId']) {
      assert.ok(Object.hasOwn(row, field), `pool.sessions[] must carry ${field}`);
    }
    assert.equal(row.runtimeState, 'hotIdle', `loaded session ${id} should be a hot idle runtime: ${JSON.stringify(row)}`);
    assert.equal(row.durable, true);
    assert.deepEqual(row.pinReasons, [], 'no SSE subscriber was opened here, so nothing may be pinned');
    assert.deepEqual(row.blockers, []);
    assert.equal(row.evictionEligible, true, 'an idle durable session with no pins must be reclaimable');
  }
  assert.equal(body.pool.summary.hot, 2);

  // ⑤ 策略阈值（内存准入/压力那几个，与 admitSession / memoryPressureError 同源）
  assert.ok(body.policy.watermarks.heapHighBytes > 0);
  assert.ok(body.policy.watermarks.rssHighBytes > 0);
  assert.equal(typeof body.policy.admission.formula, 'string');
  assert.equal(body.policy.admission.singleFileBudgetBytes, Math.min(body.policy.watermarks.heapHighBytes, body.policy.watermarks.rssHighBytes));
  assert.ok(body.policy.heapLimitBytes > 0);
  print('policy', { watermarks: body.policy.watermarks, heapLimitBytes: body.policy.heapLimitBytes, singleFileBudgetBytes: body.policy.admission.singleFileBudgetBytes });

  // ⑥ 工具清单块（给 UI 的数据）：逐条形状 ＋ **会话级** active ＋ 点名它是从哪条会话读的
  const tools = body.tools;
  assert.equal(typeof tools.source, 'string');
  assert.equal(typeof tools.scope, 'string');
  assert.equal(tools.liveSessionCount, 2);
  assert.ok(sessionIds.includes(tools.observedOn), `tools.observedOn must name a live session: ${tools.observedOn}`);
  assert.equal(tools.registeredUnavailableReason, null);
  assert.equal(tools.identicalRegisteredAcrossLiveSessions, true);
  assert.equal(Array.isArray(tools.registered), true);
  assert.ok(tools.registered.length > 0);
  assert.equal(tools.registeredCount, tools.registered.length);
  const names = tools.registered.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'the registered list must not repeat a tool');
  for (const tool of tools.registered) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.hasParameters, 'boolean');
    assert.equal(typeof tool.descriptionHead, 'string');
    assert.equal(typeof tool.path, 'string');
    assert.ok(tool.source !== undefined && tool.source !== null, `${tool.name} must carry sourceInfo.source`);
    assert.ok(Array.isArray(tool.parameterNames), `${tool.name} must carry its top-level parameter names`);
    // 业主 2026-09-25 那条要求（名称/描述/参数/参数说明）在数据面上的逐键判据：
    assert.equal(typeof tool.description, 'string', `${tool.name} must carry its FULL description`);
    assert.ok(tool.description.length > 0, `${tool.name} must carry its FULL description`);
    assert.ok(tool.parameters !== null && typeof tool.parameters === 'object', `${tool.name} must carry its JSON Schema verbatim`);
    assert.ok(Array.isArray(tool.parameterDetails), `${tool.name} must carry one record per parameter`);
    assert.equal(tool.parameterDetails.length, tool.parameterNames.length, `${tool.name}: parameterDetails must cover every top-level parameter`);
    assert.deepEqual(tool.parameterDetails.map((detail) => detail.name), tool.parameterNames, `${tool.name}: parameterDetails must follow the schema's property order`);
    for (const detail of tool.parameterDetails) {
      assert.equal(typeof detail.name, 'string');
      assert.ok(detail.type === null || typeof detail.type === 'string');
      assert.equal(typeof detail.required, 'boolean');
      assert.ok(detail.description === null || typeof detail.description === 'string', `${tool.name}.${detail.name}: description must be the real string or null`);
    }
  }
  // 钉住一个**真工具**：内建 `read` 的 path/offset/limit 说明**非空且逐字对得上**（不是「字段存在即可」）。
  const readTool = tools.registered.find((tool) => tool.name === 'read');
  assert.ok(readTool, 'the builtin read tool must be in the registered list');
  assert.deepEqual(readTool.parameterDetails, [
    { name: 'path', type: 'string', required: true, description: 'Path to the file to read (relative or absolute)' },
    { name: 'offset', type: 'number', required: false, description: 'Line number to start reading from (1-indexed)' },
    { name: 'limit', type: 'number', required: false, description: 'Maximum number of lines to read' },
  ], "read's parameter descriptions must match pi's tool definition byte for byte");
  assert.equal(readTool.description, 'Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.', 'read.description must be the FULL pi description, byte for byte');
  print('readParameterDetails', readTool.parameterDetails);
  // 业主 2026-09-26 那条要求：**工具要有分组**（`docs/human/v2.2-lessons.md` §调试工具）。这条门
  // 在真沙箱里跑两条真会话，所以这里量的是**真注册清单**上的分组：每个工具非空 group ＋ 合法
  // groupSource，分组视图与逐工具字段一致，且声明表**覆盖全部**工具（两个差集都空）。
  const toolNames = tools.registered.map((tool) => tool.name);
  // 先判「声明表覆盖全部工具」（新工具没进表 ⇒ 红的那条尖刀），再判逐工具字段与分组视图一致。
  assert.deepEqual(tools.groupTable.registeredButNotDeclared, [], 'every registered tool must be declared in the group table');
  assert.deepEqual(tools.groupTable.declaredButNotRegistered, [], 'the group table must not name tools that are no longer registered');
  assert.deepEqual(tools.groupTable.duplicateToolNames, [], 'a tool must be declared in exactly one group');
  assert.ok(typeof tools.groupTable.declaredIn === 'string' && tools.groupTable.declaredIn.includes('TOOL_GROUP_TABLE'));
  for (const tool of tools.registered) {
    assert.ok(typeof tool.group === 'string' && tool.group.trim() !== '', `${tool.name} must carry a non-empty group`);
    assert.ok(tool.groupSource === 'declared' || tool.groupSource === 'builtin-table', `${tool.name}: groupSource must say how its group was decided: ${tool.groupSource}`);
  }
  assert.equal(tools.groupsUnavailableReason, null);
  assert.ok(Array.isArray(tools.groups) && tools.groups.length > 0, `tools.groups must be the group view: ${JSON.stringify(tools.groups)}`);
  const groupedNames = tools.groups.flatMap((group) => group.tools);
  assert.deepEqual([...groupedNames].sort(), [...toolNames].sort(), 'the group view must cover exactly the registered tools (no repeat, no omission)');
  const toolByName = new Map(tools.registered.map((tool) => [tool.name, tool]));
  for (const group of tools.groups) {
    assert.ok(typeof group.name === 'string' && group.name.trim() !== '');
    assert.equal(group.toolCount, group.tools.length);
    for (const name of group.tools) assert.equal(toolByName.get(name).group, group.name, `${name}: the per-tool group and the group view must agree`);
  }
  print('toolGroups', tools.groups.map((group) => ({ name: group.name, groupSource: group.groupSource, toolCount: group.toolCount, tools: group.tools })));
  // 每条热会话各有一份自己的 active（会话级，不是 worker 级常数）
  assert.equal(tools.activeBySession.length, 2, JSON.stringify(tools.activeBySession));
  const activeById = new Map(tools.activeBySession.map((row) => [row.sessionId, row]));
  for (const id of sessionIds) {
    const row = activeById.get(id);
    assert.ok(row, `tools.activeBySession must include ${id}`);
    assert.ok(Array.isArray(row.active) && row.active.length > 0);
    assert.equal(row.activeCount, row.active.length);
    for (const builtin of ['read', 'bash', 'edit', 'write']) {
      assert.ok(row.active.includes(builtin), `${id}: the default tool surface should include ${builtin}`);
    }
  }
  assert.deepEqual(tools.unreadableLiveSessions, []);
  assert.ok(Array.isArray(tools.unavailable) && tools.unavailable.length >= 2);
  print('toolSurfaceBlock', {
    source: tools.source,
    scope: tools.scope,
    observedOn: tools.observedOn,
    liveSessionCount: tools.liveSessionCount,
    registeredCount: tools.registeredCount,
    identicalRegisteredAcrossLiveSessions: tools.identicalRegisteredAcrossLiveSessions,
    groups: tools.groups,
    registered: tools.registered,
    activeBySession: tools.activeBySession,
    unavailable: tools.unavailable,
  });

  // ⑦ 取不到的字段如实登记（不是 null 顶替）
  assert.equal(Array.isArray(body.unavailable), true);
  assert.ok(body.unavailable.length >= 3);
  for (const entry of body.unavailable) {
    assert.equal(typeof entry.field, 'string');
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length > 20, `unavailable[].reason must say why: ${JSON.stringify(entry)}`);
  }
  for (const field of ['hostProcess', 'appProcess', 'otherGenerations']) {
    assert.ok(body.unavailable.some((entry) => entry.field === field), `unavailable must name ${field}`);
  }
  print('unavailable', body.unavailable.map((entry) => entry.field));

  // ⑧ 回合**在飞**时读同一张表：那一行必须是 running / in_flight_turn / 不可回收
  const slow = await api(`/sessions/${sessionIds[0]}/message`, { method: 'POST', body: { text: SLOW_PROMPT } });
  assert.equal(slow.statusCode, 202, slow.raw);
  const busyReply = await poll('a running runtime in the pool table', () => api('/debug/instances'),
    (reply2) => reply2.statusCode === 200 && (reply2.value.pool?.sessions ?? []).some((row) => row.running === true), 15_000);
  const busyRow = busyReply.value.pool.sessions.find((row) => row.running === true);
  assert.equal(busyRow.sessionId, sessionIds[0]);
  assert.equal(busyRow.runningNow, true);
  assert.equal(busyRow.evictionEligible, false, 'a runtime with a turn in flight must not be reclaimable');
  assert.ok(busyRow.blockers.includes('in_flight_turn'), `expected in_flight_turn in blockers: ${JSON.stringify(busyRow.blockers)}`);
  assert.equal(busyReply.value.tools.activeBySession.length, 2, 'the tool surface must still be readable while a turn is in flight');
  print('inFlightRow', busyRow);
  await waitIdle(sessionIds[0]);

  // ⑨ 只读边角：写方法如实 405（不静默接受）
  const posted = await api('/debug/instances', { method: 'POST', body: {} });
  assert.equal(posted.statusCode, 405, posted.raw);
  assert.match(posted.value.message ?? '', /read-only/);
  print('POST /debug/instances', { statusCode: posted.statusCode, value: posted.value });

  print('RESULT', 'debug-instances PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  if (basePort) {
    try { await stopSpawnedListener(baseChild, basePort, baseEntry); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (providerServer?.server) {
    providerServer.server.closeAllConnections();
    await new Promise((resolve) => providerServer.server.close(resolve));
  }
  if (baseLog) await cleanupStep(cleanupProblems, 'close baseLog', () => baseLog.close());
  if (baseChild && baseChild.exitCode === null) await new Promise((resolve) => baseChild.once('exit', resolve));
  const baseOutput = await readFile(baseLogPath, 'utf8').catch(() => '');
  if (baseOutput.trim()) print('base log', baseOutput.trim());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
  }
}

// ── 常驻反证臂（本仓惯例：把交付物**副本**改一处，再拿**真门**去打那份副本，断言必红）────────────
// 机械在 `test/harness.mjs` 的 `runGateOnMutatedCopy()`：副本建在仓库根里的 `.sopho-debugarm-sandbox-*/`
// （必须在仓内：`node_modules` 靠向上查找解析），跑完收敛式删除。为什么必须打副本：拿真树去改就污染
// 正在交付的东西 —— 本仓实测踩过「用 `git checkout --` 还原手臂时把**未提交**的交付改动一起还原掉」。
const ARM_MUTANTS = {
  evict: {
    what: '把只读端点改成会 evict（路由里加 `await pool.reclaimIdle({ dryRun: false })`）',
    file: 'server/base-logic.mjs',
    from: '          sendJson(response, 200, debugInstancesReport());',
    to: '          await pool.reclaimIdle({ dryRun: false }); // reverse-arm:evict\n          sendJson(response, 200, debugInstancesReport());',
    expect: 'the pool state changed across GET /debug/instances',
  },
  groupdrop: {
    what: '把分组声明表里的一个工具**摘掉**（`session_push`）⇒ 声明表不再覆盖全部工具（业主 2026-09-26 那条）',
    file: 'server/base-logic.mjs',
    from: "{ name: '树形会话组', source: 'declared', tools: ['cwd', 'handoff', 'session_new', 'session_push', 'session_read', 'session_send', 'session_set_title'] },",
    to: "{ name: '树形会话组', source: 'declared', tools: ['cwd', 'handoff', 'session_new', 'session_read', 'session_send', 'session_set_title'] },",
    expect: 'every registered tool must be declared in the group table',
  },
};

async function runReverseArm(name) {
  const arm = ARM_MUTANTS[name];
  if (!arm) throw new Error(`不认识的反证臂：${name}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
  process.stdout.write(`反证臂 ${name}：${arm.what}\n`);
  const result = await runGateOnMutatedCopy({
    root: repoRoot,
    tag: 'debugarm',
    dirs: ['server', 'pi-extensions', 'web'],
    gateFile: fileURLToPath(import.meta.url),
    expect: arm.expect,
    mutate: async (copyRoot) => {
      const file = path.join(copyRoot, arm.file);
      const text = await readFile(file, 'utf8');
      if (!text.includes(arm.from)) {
        throw new Error(`反证臂 ${name} 的改写**没命中**（接缝形状变了？）：${arm.file}\n  要找：${JSON.stringify(arm.from)}`);
      }
      await writeFile(file, text.replace(arm.from, arm.to), 'utf8');
    },
  });
  print('reverseArm', { name, exitCode: result.exitCode, redLine: result.redLine });
  if (result.problems.length > 0) {
    process.stderr.write(`cleanup problems (secondary): ${result.problems.join('; ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`✓ 反证臂 ${name} 红到位（这是**期望**的结果，不是缺陷）：${result.redLine}\n`);
}

if (ARM) await runReverseArm(ARM);
else await runGate();
