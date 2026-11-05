#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, runArms, stopSpawnedListener } from './harness.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 's4-cwd-move-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const SOURCE_CWD = path.join(TMP, 'source');
const CHILD_CWD = path.join(TMP, 'child');
const CONFLICT_CWD = path.join(TMP, 'conflict');
const OCCUPIED_CWD = path.join(TMP, 'occupied');
const TARGET_CWD = path.join(TMP, 'target');
const MISSING_CWD = path.join(TMP, 'missing');
const TARGET_MARKER = 'S4_TARGET_ONLY_52e1';
const SOURCE_ID = randomUUID();
const SOURCE_FILE = path.join(SESSIONS, `seed_${SOURCE_ID}.jsonl`);
const BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');
const BASE_LOG_PATH = path.join(TMP, 'base.log');

let baseChild;
let baseLog;
let provider;
let basePort;
let providerPort;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lines = (bytes) => bytes.toString('utf8').trimEnd().split('\n');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort(excluded = new Set()) {
  for (let candidate = 20000 + Math.floor(Math.random() * 30000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
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

async function poll(label, operation, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
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

function usage() {
  return { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
}

function sse(response, delta, finishReason = null, includeUsage = false) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-s4',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: usage() } : {}),
  })}\n\n`);
}

function userText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part.text || '').join('');
  }
  return '';
}

async function startProvider() {
  const holds = [];
  const requests = [];
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const prompt = userText(body.messages);
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    if (prompt.includes('CWD_PROBE_REQUEST') && !hasToolResult) {
      const command = "pwd; printf '\\nMARKER_CONTENT='; cat ./target-only.txt";
      sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-s4-cwd', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] });
      sse(response, {}, 'tool_calls', true);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (prompt.includes('CWD_PROBE_REQUEST') && hasToolResult) {
      sse(response, { role: 'assistant', content: 'CWD_PROBE_DONE' });
      sse(response, {}, 'stop', true);
      response.end('data: [DONE]\n\n');
      return;
    }
    const hold = holds.shift();
    sse(response, { role: 'assistant', content: hold?.text ?? 'FAKE_OK' });
    if (hold) {
      hold.started();
      await hold.released;
    }
    if (!response.destroyed) {
      sse(response, {}, 'stop', true);
      response.end('data: [DONE]\n\n');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return {
    server,
    requests,
    hold(text) {
      let startedResolve;
      let releaseResolve;
      const value = {
        text,
        startedPromise: new Promise((resolve) => { startedResolve = resolve; }),
        released: new Promise((resolve) => { releaseResolve = resolve; }),
        started: startedResolve,
        release: releaseResolve,
      };
      holds.push(value);
      return value;
    },
  };
}

async function jsonlFiles() {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(target);
    }
  }
  await visit(SESSIONS);
  return found.sort();
}

async function cleanup(problems) {
  if (baseChild && basePort) await cleanupStep(problems, 'stop base', () => stopSpawnedListener(baseChild, basePort, BASE_ENTRY));
  if (provider?.server) {
    await cleanupStep(problems, 'close provider', () => new Promise((resolve) => {
      provider.server.closeAllConnections();
      provider.server.close(resolve);
    }));
  }
  await cleanupStep(problems, 'close base log', () => baseLog?.close());
  await removeSandbox(TMP, problems);
}

let primaryError;
try {
  for (const directory of [HOME, SESSIONS, SOURCE_CWD, CHILD_CWD, CONFLICT_CWD, OCCUPIED_CWD, TARGET_CWD]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(TARGET_CWD, 'target-only.txt'), `${TARGET_MARKER}\n`);
  const now = new Date().toISOString();
  const sourceEntries = [
    { type: 'session', version: 3, id: SOURCE_ID, timestamp: now, cwd: SOURCE_CWD },
    { type: 'message', id: 's4-user', parentId: null, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'history alpha' }], timestamp: Date.now() } },
    { type: 'message', id: 's4-assistant', parentId: 's4-user', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'history beta 中文 <>&' }], api: 'openai-completions', provider: 'fake', model: 'fake-s4', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } },
  ];
  await writeFile(SOURCE_FILE, `${sourceEntries.map(JSON.stringify).join('\n')}\n`);
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-s4', name: 'Fake S4', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-s4', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);

  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used);
  // models.json needs the final provider port.
  const models = JSON.parse(await readFile(path.join(HOME, 'models.json'), 'utf8'));
  models.providers.fake.baseUrl = `http://127.0.0.1:${providerPort}/v1`;
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify(models, null, 2)}\n`);
  provider = await startProvider();
  baseLog = await open(BASE_LOG_PATH, 'w');
  baseChild = spawn(process.execPath, [BASE_ENTRY], {
    cwd: ROOT,
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
      SOPHO_DEFAULT_CWD: SOURCE_CWD,
      SOPHO_MAX_HOT: '12',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => request('/host'), (reply) => reply.status === 200, 30_000);
  assert.equal(await listenerPid(basePort), baseChild.pid);
  print('sandbox', { tmp: TMP, home: HOME, providerPort, basePort, basePid: baseChild.pid, forbiddenPortsUsed: false });

  // 各臂独立报告：一臂红也要把其余臂跑完（从前的形状里，一条早失败会遮住后面所有覆盖）。
  // 跨臂状态（`moved` = 那一次成功的 move 回执）提到外层。
  let moved = null;
  const { failed } = await runArms([
    ['① 插件 cwd 面（session_new + /cwd /scratch /move）', async () => {
      const loaded = await discoverAndLoadExtensions([path.join(ROOT, 'pi-extensions', 'assistant', 'index.ts')], ROOT, HOME);
      assert.deepEqual(loaded.errors, []);
      const extension = loaded.extensions[0];
      assert.ok(extension.tools.has('session_new'));
      for (const command of ['cwd', 'scratch', 'move']) assert.ok(extension.commands.has(command), `missing /${command}`);
      assert.match(extension.tools.get('session_new').definition.description, /does not move/);
      await request(`/sessions/${SOURCE_ID}`);
      print('plugin cwd surface', { tools: ['session_new'], commands: ['cwd', 'scratch', 'move'] });
      return [...extension.commands.keys()].filter((name) => ['cwd', 'scratch', 'move'].includes(name));
    }],

    ['② scratch 与 cwd-recents（+ placement.json 记账）', async () => {
      const recentsBefore = await request('/cwd-recents');
      assert.equal(recentsBefore.status, 200);
      const scratch = await request('/sessions', { method: 'POST', body: { scratch: true } });
      assert.equal(scratch.status, 201, scratch.raw);
      assert.equal(scratch.value.cwd, path.join(HOME, 'scratch', scratch.value.id));
      assert.equal((await stat(scratch.value.cwd)).isDirectory(), true);
      const recentsAfter = await request('/cwd-recents');
      assert.equal(recentsAfter.status, 200);
      assert.deepEqual(recentsAfter.value.recents, recentsBefore.value.recents);
      const placementAfterScratch = await request('/placement');
      assert.equal(placementAfterScratch.status, 200, placementAfterScratch.raw);
      assert.equal(placementAfterScratch.value.exists, true);
      assert.equal(placementAfterScratch.value.error, null);
      assert.equal(placementAfterScratch.value[scratch.value.id].kind, 'scratch');
      assert.equal(placementAfterScratch.value[scratch.value.id].scratchRoot, path.join(HOME, 'scratch'));
      assert.equal(placementAfterScratch.value[scratch.value.id].source, 'placement.json');
      print('scratch and cwd-recents', { response: scratch.value, before: recentsBefore.value, after: recentsAfter.value, placement: placementAfterScratch.value[scratch.value.id] });
      return { scratchCwd: scratch.value.cwd };
    }],

    ['③ session_new 成功 + 工作树冲突被拒', async () => {
      const child = await request(`/sessions/${SOURCE_ID}/session-new`, { method: 'POST', body: { cwd: CHILD_CWD, name: 'cwd child' } });
      assert.equal(child.status, 201, child.raw);
      const childTree = await request('/tree');
      assert.equal(childTree.value.sessions.find((entry) => entry.id === child.value.childSessionId)?.parentId, SOURCE_ID);
      const blocker = await request('/sessions', { method: 'POST', body: { cwd: CONFLICT_CWD, name: 'blocker' } });
      assert.equal(blocker.status, 201, blocker.raw);
      const nodesBeforeConflict = (await request('/tree')).value.sessions.length;
      const conflict = await request(`/sessions/${SOURCE_ID}/session-new`, { method: 'POST', body: { cwd: CONFLICT_CWD } });
      const nodesAfterConflict = (await request('/tree')).value.sessions.length;
      assert.equal(conflict.status, 409, conflict.raw);
      assert.equal(conflict.value.error, 'workspace_conflict');
      assert.equal(nodesAfterConflict, nodesBeforeConflict);
      print('session_new success', child.value);
      print('session_new conflict raw response and node count', { response: conflict, nodesBeforeConflict, nodesAfterConflict });
      return { childSessionId: child.value.childSessionId, conflictError: conflict.value.error };
    }],

    ['④ move 到不存在的 cwd ⇒ 409 target_cwd_missing（文件一个都不动）', async () => {
      const filesBeforeMissing = await jsonlFiles();
      const missing = await request(`/sessions/${SOURCE_ID}/move`, { method: 'POST', body: { cwd: MISSING_CWD } });
      assert.equal(missing.status, 409, missing.raw);
      assert.equal(missing.value.error, 'target_cwd_missing');
      assert.deepEqual(await jsonlFiles(), filesBeforeMissing);
      print('missing target refusal raw response', missing);
      return { status: missing.status, error: missing.value.error };
    }],

    ['⑤ move 到已被占用的 cwd ⇒ 409 workspace_conflict', async () => {
      const occupied = await request('/sessions', { method: 'POST', body: { cwd: OCCUPIED_CWD, name: 'occupier' } });
      assert.equal(occupied.status, 201, occupied.raw);
      const filesBeforeOccupiedMove = await jsonlFiles();
      const nodesBeforeOccupiedMove = (await request('/tree')).value.sessions.length;
      const occupiedMove = await request(`/sessions/${SOURCE_ID}/move`, { method: 'POST', body: { cwd: OCCUPIED_CWD } });
      assert.equal(occupiedMove.status, 409, occupiedMove.raw);
      assert.equal(occupiedMove.value.error, 'workspace_conflict');
      assert.deepEqual(await jsonlFiles(), filesBeforeOccupiedMove);
      assert.equal((await request('/tree')).value.sessions.length, nodesBeforeOccupiedMove);
      print('move into an occupied cwd is refused', { response: occupiedMove, nodesBeforeOccupiedMove });
      return { status: occupiedMove.status, error: occupiedMove.value.error };
    }],

    ['⑥ 源会话在跑（流开着）时 move ⇒ 409 session_busy_move', async () => {
      const hold = provider.hold('STREAM_SOURCE_DONE');
      try {
        const streamAccepted = await request(`/sessions/${SOURCE_ID}/message`, { method: 'POST', body: { text: 'hold source open' } });
        assert.equal(streamAccepted.status, 202, streamAccepted.raw);
        await hold.startedPromise;
        await poll('source streaming', () => request(`/sessions/${SOURCE_ID}`), (reply) => reply.value?.runtime?.isStreaming === true);
        const filesBeforeBusy = await jsonlFiles();
        const busy = await request(`/sessions/${SOURCE_ID}/move`, { method: 'POST', body: { cwd: TARGET_CWD } });
        assert.equal(busy.status, 409, busy.raw);
        assert.equal(busy.value.error, 'session_busy_move');
        assert.deepEqual(await jsonlFiles(), filesBeforeBusy);
        print('busy source refusal raw response', busy);
        return { status: busy.status, error: busy.value.error };
      } finally {
        // 无论这一臂红绿都必须把流放掉，否则后面的 move 臂会看到「源还在跑」。
        hold.release();
        await poll('source settled', () => request(`/sessions/${SOURCE_ID}`), (reply) => reply.value?.runtime?.isStreaming === false).catch(() => {});
      }
    }],

    ['⑦ move 建出 fork：源文件逐字节不动 + 只换头部', async () => {
      const sourceBefore = await readFile(SOURCE_FILE);
      const hashBefore = sha256(sourceBefore);
      const linesBefore = lines(sourceBefore);
      moved = await request(`/sessions/${SOURCE_ID}/move`, { method: 'POST', body: { cwd: TARGET_CWD } });
      assert.equal(moved.status, 201, moved.raw);
      const sourceAfter = await readFile(SOURCE_FILE);
      assert.equal(sha256(sourceAfter), hashBefore);
      assert.deepEqual(sourceAfter, sourceBefore);
      const targetFile = moved.value.targetFile;
      const targetBytes = await readFile(targetFile);
      const targetLines = lines(targetBytes);
      const targetHeader = JSON.parse(targetLines[0]);
      assert.equal(targetHeader.cwd, TARGET_CWD);
      assert.equal(targetHeader.parentSession, SOURCE_FILE);
      assert.deepEqual(targetLines.slice(1), linesBefore.slice(1));
      print('fork source hash and line counts', { beforeSha256: hashBefore, afterSha256: sha256(sourceAfter), sourceLinesBefore: linesBefore.length, sourceLinesAfter: lines(sourceAfter).length, forkLines: targetLines.length });
      print('move response', moved.value);
      return { toSessionId: moved.value.toSessionId, forkLines: targetLines.length };
    }],

    ['⑧ 旧会话被打上 moved 标记并归档，发消息被拒', async () => {
      const movedTree = await request('/tree');
      const oldNode = movedTree.value.sessions.find((entry) => entry.id === SOURCE_ID);
      const newNode = movedTree.value.sessions.find((entry) => entry.id === moved.value.toSessionId);
      assert.equal(oldNode.archived, true);
      assert.match(oldNode.name, new RegExp(`moved-to:${moved.value.toSessionId}`));
      assert.equal(oldNode.movedTo, moved.value.toSessionId);
      assert.equal(newNode.cwd, TARGET_CWD);
      assert.equal(newNode.parentId, SOURCE_ID);
      const movedMessages = await request(`/sessions/${moved.value.toSessionId}/messages`);
      assert.equal(movedMessages.status, 200);
      const oldRejected = await request(`/sessions/${SOURCE_ID}/message`, { method: 'POST', body: { text: 'must not continue here' } });
      assert.equal(oldRejected.status, 409);
      assert.equal(oldRejected.value.error, 'session_moved');
      print('old session moved marker archive and refusal', { oldNode, refusal: oldRejected });
      return { movedTo: oldNode.movedTo, refusal: oldRejected.value.error };
    }],

    ['⑨ 旧会话不能再 move，且不再占着旧 cwd', async () => {
      const filesBeforeSecondMove = await jsonlFiles();
      const secondMove = await request(`/sessions/${SOURCE_ID}/move`, { method: 'POST', body: { cwd: TARGET_CWD } });
      assert.equal(secondMove.status, 409, secondMove.raw);
      assert.equal(secondMove.value.error, 'session_moved');
      assert.deepEqual(await jsonlFiles(), filesBeforeSecondMove);
      const reuseOldCwd = await request(`/sessions/${SOURCE_ID}/session-new`, { method: 'POST', body: { cwd: SOURCE_CWD, name: 'back in the old tree' } });
      assert.equal(reuseOldCwd.status, 201, reuseOldCwd.raw);
      print('moved source cannot move again and stops blocking its old cwd', { secondMove, reuseOldCwd: reuseOldCwd.value });
      return { secondMoveError: secondMove.value.error, reuseStatus: reuseOldCwd.status };
    }],

    ['⑩ 真在 fork 那棵树上跑 bash（cwd 证据）', async () => {
      const probe = await request(`/sessions/${moved.value.toSessionId}/message`, { method: 'POST', body: { text: 'CWD_PROBE_REQUEST: call bash exactly as instructed by the provider' } });
      assert.equal(probe.status, 202, probe.raw);
      const targetFile = moved.value.targetFile;
      await poll('target bash evidence', () => readFile(targetFile, 'utf8'), (text) => text.includes(TARGET_MARKER)
        && (process.platform === 'win32' ? text.includes('/target\\n') : text.includes(TARGET_CWD))
        && text.includes('CWD_PROBE_DONE'), 30_000);
      const targetText = await readFile(targetFile, 'utf8');
      assert.match(targetText, new RegExp(TARGET_MARKER));
      if (process.platform === 'win32') assert.ok(targetText.includes('/target\\n'));
      else assert.match(targetText, new RegExp(TARGET_CWD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      print('fake-provider bash cwd evidence', { targetCwd: TARGET_CWD, marker: TARGET_MARKER, providerRequests: provider.requests.length });
      return { providerRequests: provider.requests.length };
    }],

    ['⑪ placement.json 坏文件/缺键/缺文件三种读法', async () => {
      const placementPath = path.join(HOME, 'placement.json');
      const placementGood = await readFile(placementPath, 'utf8');
      await writeFile(placementPath, '{\n');
      const placementBad = await request('/placement');
      assert.equal(placementBad.status, 500, placementBad.raw);
      assert.equal(placementBad.value.error, 'placement-config-invalid');
      assert.equal(await readFile(placementPath, 'utf8'), '{\n');
      await writeFile(placementPath, placementGood);
      const config = JSON.parse(placementGood);
      delete config[moved.value.toSessionId];
      await writeFile(placementPath, `${JSON.stringify(config, null, 2)}\n`);
      const placementDerived = await request('/placement');
      assert.equal(placementDerived.status, 200, placementDerived.raw);
      assert.equal(placementDerived.value[moved.value.toSessionId].derived, true);
      assert.equal(placementDerived.value[moved.value.toSessionId].source, 'pi-header');
      assert.equal(placementDerived.value[moved.value.toSessionId].cwd, TARGET_CWD);
      await rm(placementPath);
      const placementMissing = await request('/placement');
      assert.equal(placementMissing.status, 200, placementMissing.raw);
      assert.equal(placementMissing.value.exists, false);
      assert.equal(placementMissing.value.error, null);
      assert.ok(placementMissing.value[moved.value.toSessionId]);
      await writeFile(placementPath, placementGood);
      print('placement bad-file / missing-key / missing-file responses', { bad: placementBad, derived: placementDerived.value[moved.value.toSessionId], missing: { exists: placementMissing.value.exists, error: placementMissing.value.error } });
      return { badStatus: placementBad.status, derived: placementDerived.value[moved.value.toSessionId].derived };
    }],
  ], { title: 's4-cwd-move' });
  print('RESULT', failed.length === 0 ? 'S4 cwd/move PASS' : `S4 cwd/move FAIL（${failed.length} 臂红）`);
} catch (error) {
  primaryError = error;
  let logTail = '';
  try { logTail = (await readFile(BASE_LOG_PATH, 'utf8')).slice(-12_000); } catch {}
  if (logTail) process.stderr.write(`\nbase log tail:\n${logTail}\n`);
} finally {
  const cleanupProblems = [];
  await cleanup(cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
