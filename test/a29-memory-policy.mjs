import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RuntimePool, poolConfigFromEnv } from '../server/pool.mjs';
import { createMemoryWatermarkLatch } from '../server/base-logic.mjs';
import { finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'a29-policy-'));
const filesRoot = path.join(sandbox, 'pool-files');
await mkdir(filesRoot, { recursive: true });

function print(label, value) {
  process.stdout.write(`${label}: ${JSON.stringify(value)}\n`);
}

async function sessionFile(id, directory = filesRoot, padding = '', cwd = directory) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd, padding })}\n`);
  return file;
}

function poolHarness({ admitRuntime = async () => {}, maxHot = 8 } = {}) {
  return rawPoolHarness({ admitRuntime, maxHot });
}

function rawPoolHarness({ admitRuntime = null, maxHot = 8 } = {}) {
  const files = new Map();
  let opens = 0;
  const pool = new RuntimePool({
    maxHot,
    idleTTL: 900000,
    sweepInterval: 0,
    currentGenerationId: 'g-a29',
    locateSession: async (id) => ({ sessionFile: files.get(id) }),
    admitRuntime,
    prepareRuntime: async () => ({ generationId: 'g-a29', cacheCleared: true }),
    openRuntime: async ({ sessionId, sessionFile: file }) => {
      opens += 1;
      return { generationId: 'g-a29', sessionFile: file, getCurrentLeafId: () => null, async dispose() {} };
    },
  });
  return { pool, files, get opens() { return opens; } };
}

async function released(pool, id) {
  const handle = await pool.acquire(id);
  await handle.release();
  return handle;
}

function testCountCapIsOptIn() {
  assert.deepEqual(poolConfigFromEnv({}), { maxHot: null, idleTTL: 15 * 60 * 1000 });
  assert.equal(poolConfigFromEnv({ SOPHO_MAX_HOT: 'off' }).maxHot, null);
  assert.equal(poolConfigFromEnv({ SOPHO_MAX_HOT: '12' }).maxHot, 12);
  assert.throws(() => poolConfigFromEnv({ SOPHO_MAX_HOT: '0' }), /invalid SOPHO_MAX_HOT/);
  print('A29-0 maxHot is opt-in', { unset: null, off: null, explicit: 12, zeroRejected: true });
}

async function testEvictThenSucceed() {
  let pressure = false;
  const harness = poolHarness({
    admitRuntime: async ({ reclaimMemory }) => {
      if (pressure) assert.equal(await reclaimMemory(), 1);
    },
  });
  const first = randomUUID();
  const second = randomUUID();
  harness.files.set(first, await sessionFile(first));
  harness.files.set(second, await sessionFile(second));
  await released(harness.pool, first);
  pressure = true;
  await released(harness.pool, second);
  assert.equal(harness.pool.counters.evict.memory, 1);
  assert.equal(harness.pool.getSession(first).runtimeState, 'cold');
  assert.equal(harness.pool.getSession(second).runtimeState, 'hotIdle');
  print('A29-1 idle durable victim reclaimed before success', { workerPid: process.pid, generation: 'g-a29', memoryEvictions: 1, opened: harness.opens });
  await harness.pool.close();
}

async function testProtectedRuntimesReject() {
  const error = Object.assign(new Error('worker cannot safely admit'), { statusCode: 503, code: 'worker_memory_pressure' });
  let enforce = false;
  const harness = poolHarness({
    admitRuntime: async ({ reclaimMemory }) => {
      if (!enforce) return;
      assert.equal(await reclaimMemory(), 0);
      throw error;
    },
  });
  const active = randomUUID();
  const pinned = randomUUID();
  const incoming = randomUUID();
  for (const id of [active, pinned, incoming]) harness.files.set(id, await sessionFile(id));
  const activeHandle = await harness.pool.acquire(active);
  const pinnedHandle = await released(harness.pool, pinned);
  pinnedHandle.pin('contract');
  enforce = true;
  await assert.rejects(harness.pool.acquire(incoming), (failure) => failure.code === 'worker_memory_pressure' && failure.statusCode === 503);
  assert.equal(harness.pool.getSession(active).acquiredLeases, 1);
  assert.deepEqual(harness.pool.getSession(pinned).pinReasons, ['contract']);
  assert.equal(harness.pool.counters.evict.memory, 0);
  assert.equal(harness.opens, 2);
  // A refused cold acquire must not leave a half-open record behind.
  assert.equal(harness.pool.getSession(incoming), null);
  print('A29-2 active and pinned are not killed', { statusCode: 503, error: error.code, activeLeases: 1, pinned: true, memoryEvictions: 0 });
  await activeHandle.release();
  pinnedHandle.unpin('contract');
  await harness.pool.close();
}

async function testSoftCapNeverRefuses() {
  // v2.1 semantics restored: maxHot is a soft target. With an admission policy wired
  // (as server/base-logic.mjs always does), a full pool must NOT refuse the request --
  // it may exceed maxHot and let memory admission decide.
  const harness = rawPoolHarness({ maxHot: 1, admitRuntime: async () => {} });
  const held = [];
  for (let index = 0; index < 3; index += 1) {
    const id = randomUUID();
    harness.files.set(id, await sessionFile(id));
    held.push(await harness.pool.acquire(id));
  }
  const summary = harness.pool.summary();
  assert.equal(summary.hot, 3);
  assert.equal(summary.maxHot, 1);
  assert.equal(summary.counters.evict.capacity, 0);
  const fourth = randomUUID();
  harness.files.set(fourth, await sessionFile(fourth));
  const late = await harness.pool.acquire(fourth);
  assert.equal(harness.pool.summary().hot, 4);
  print('A29-7 soft maxHot: all-busy pool exceeds the target instead of refusing', {
    maxHot: 1, hotAfterAllBusyAcquires: harness.pool.summary().hot,
    poolSaturatedReturned: false, capacityEvictions: harness.pool.summary().counters.evict.capacity,
    errorCodeForLateAcquire: null,
  });
  for (const handle of [...held, late]) await handle.release();
  const target = randomUUID();
  harness.files.set(target, await sessionFile(target));
  await released(harness.pool, target);
  const afterRelease = harness.pool.summary();
  assert.ok(afterRelease.counters.evict.capacity >= 1, 'released idle runtimes must still be reclaimed down to the target');
  print('A29-7b reclaim still happens when a victim exists', {
    maxHot: 1, capacityEvictions: afterRelease.counters.evict.capacity, hot: afterRelease.hot,
  });
  await harness.pool.close();
}

async function testNoAdmissionPolicyFallsBackToHardCap() {
  // A pool with no admission policy has no other bound, so maxHot stays hard there.
  const harness = rawPoolHarness({ maxHot: 1 });
  const id = randomUUID();
  harness.files.set(id, await sessionFile(id));
  const held = await harness.pool.acquire(id);
  const second = randomUUID();
  harness.files.set(second, await sessionFile(second));
  await assert.rejects(harness.pool.acquire(second), (failure) => failure.code === 'pool_saturated' && failure.statusCode === 409);
  print('A29-8 pool without admission policy keeps the hard bound', { maxHot: 1, error: 'pool_saturated', statusCode: 409, note: 'fallback only; base-logic always wires admitRuntime' });
  await held.release();
  await harness.pool.close();
}

async function testHotAdmissionKeepsAcquireOrder() {
  // The invariant the burst gate depends on: a same-tick batch of acquires for one session
  // must *resolve* in submission order, even when admission does slow I/O. If admission ran
  // in the caller's own await (after acquire returned), a later delivery could reach the
  // runtime first and the burst would stop being 'first message, rest steer'.
  const calls = [];
  const harness = poolHarness({
    admitRuntime: async ({ hot }) => {
      calls.push(hot);
      // Earlier submissions are deliberately slower: only a serialized acquire keeps order.
      const delayMs = Math.max(0, 60 - calls.length * 20);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    },
  });
  const id = randomUUID();
  harness.files.set(id, await sessionFile(id));
  const warm = await harness.pool.acquire(id);
  await warm.release();
  const resolved = [];
  const handles = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
    const handle = await harness.pool.acquire(id);
    resolved.push(index);
    return handle;
  }));
  assert.deepEqual(resolved, [0, 1, 2]);
  assert.deepEqual(calls, [false, true, true, true]);
  await Promise.all(handles.map((handle) => handle.release()));
  print('A29-9 hot-path admission keeps acquire order', {
    admissionCalls: calls.map((hot) => (hot ? 'hot' : 'cold')),
    resolvedInSubmissionOrder: resolved,
    slowestFirstUnderConcurrentAdmission: true,
  });
  await harness.pool.close();
}

async function testRejectBeforeOpen() {
  const harness = poolHarness({ admitRuntime: async () => { throw Object.assign(new Error('predicted peak exceeds budget'), { statusCode: 503, code: 'worker_memory_pressure' }); } });
  const id = randomUUID();
  harness.files.set(id, await sessionFile(id, filesRoot, 'x'.repeat(4096)));
  await assert.rejects(harness.pool.acquire(id), (failure) => failure.code === 'worker_memory_pressure');
  assert.equal(harness.opens, 0);
  print('A29-3 oversized file rejected before openRuntime', { openRuntimeCalls: harness.opens, error: 'worker_memory_pressure' });
  await harness.pool.close();
}

function testHysteresis() {
  const latch = createMemoryWatermarkLatch({ heapHighBytes: 100, heapLowBytes: 60, rssHighBytes: 200, rssLowBytes: 120 });
  const samples = [
    latch.sample({ heapUsed: 90, rss: 150 }),
    latch.sample({ heapUsed: 101, rss: 150 }),
    latch.sample({ heapUsed: 99, rss: 150 }),
    latch.sample({ heapUsed: 61, rss: 121 }),
    latch.sample({ heapUsed: 60, rss: 120 }),
    latch.sample({ heapUsed: 101, rss: 150 }),
  ];
  assert.deepEqual(samples.map((sample) => [sample.pressure, sample.episode]), [[false, 0], [true, 1], [true, 1], [true, 1], [false, 1], [true, 2]]);
  print('A29-4 high-low watermark hysteresis', { states: samples.map((sample) => ({ pressure: sample.pressure, episode: sample.episode })) });
}

async function reservePort() {
  for (let port = 44000 + Math.floor(Math.random() * 15000); port < 65000; port += 1) {
    if (port === 7321 || port === 7331) continue;
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('no high port available');
}

function request(port, pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { connection: 'close', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ statusCode: response.statusCode, value: JSON.parse(raw) }); } catch { reject(new Error(`invalid JSON: ${raw}`)); }
      });
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitHost(port, logPath = null) {
  const deadline = Date.now() + 60000;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, '/host');
      if (response.statusCode === 200 && response.value.currentWorkerPid) return response.value;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // A bare ECONNREFUSED is useless for diagnosis; the child's own log says why it died.
  const tail = logPath ? `\n--- base.log tail ---\n${(await readFile(logPath, 'utf8').catch(() => '(unreadable)')).split(/\r?\n/).slice(-20).join('\n')}` : '';
  throw new Error(`host did not start on port ${port}: ${last?.message}${tail}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 15000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function writeTreeSession(directory, bytes) {
  const id = randomUUID();
  const file = path.join(directory, `${id}.jsonl`);
  const now = new Date().toISOString();
  const header = JSON.stringify({ type: 'session', version: 3, id, timestamp: now, cwd: directory });
  const message = JSON.stringify({
    type: 'message', id: randomUUID(), parentId: null, timestamp: now,
    message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(bytes) }], stopReason: 'stop', timestamp: Date.now() },
  });
  await writeFile(file, `${header}\n${message}\n`);
  return { id, file, bytes: Buffer.byteLength(header) + Buffer.byteLength(message) + 2 };
}

async function testTreeAggregateAdmission() {
  const home = path.join(sandbox, 'tree-home');
  const sessions = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'tree-workspace');
  await mkdir(sessions, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');

  // 10 MiB is a 1:40 scale model of the 388 MiB production profile. With the calibrated
  // multiplier (8), the old ∑files×8 model predicts ~80 MiB on top of the worker's live heap
  // and trips the 110 MiB test watermark; each 1 MiB file individually predicts only ~9 MiB.
  const records = [];
  for (let index = 0; index < 10; index += 1) records.push(await writeTreeSession(sessions, 1024 * 1024));
  const aggregateBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  const port = await reservePort();
  const logPath = path.join(sandbox, 'tree-base.log');
  const log = await open(logPath, 'w');
  const child = spawn(process.execPath, [path.join(root, 'server', 'base.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: workspace,
      SOPHO_NO_TOOLS: '1',
      SOPHO_MEMORY_HEAP_HIGH_BYTES: String(110 * 1024 * 1024),
      SOPHO_MEMORY_HEAP_LOW_BYTES: String(90 * 1024 * 1024),
      SOPHO_MEMORY_RSS_HIGH_BYTES: String(2 * 1024 * 1024 * 1024),
      SOPHO_MEMORY_RSS_LOW_BYTES: String(1536 * 1024 * 1024),
      SOPHO_MEMORY_RESERVE_BYTES: String(1024 * 1024),
      SOPHO_MEMORY_SESSION_MULTIPLIER: '8',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  try {
    await waitHost(port, logPath);
    const tree = await request(port, '/tree');
    assert.equal(tree.statusCode, 200, `scaled aggregate tree must fit sequentially: ${JSON.stringify(tree.value)}`);
    assert.equal(tree.value.sessions.length, records.length);

    const oversized = await writeTreeSession(sessions, 15 * 1024 * 1024);
    const rejected = await request(port, `/sessions/${oversized.id}`);
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.value.error, 'worker_memory_pressure');
    assert.equal(rejected.value.details.retryable, true);
    assert.equal(rejected.value.details.sessionId, oversized.id);
    assert.equal(rejected.value.details.reason, 'single_session_prediction_exceeds_budget');
    print('A29-10 sequential tree admission + oversized counterexample', {
      scale: '10 MiB aggregate = 1:40 of the 388 MiB production profile',
      aggregateBytes,
      oldAggregatePredictionBytes: aggregateBytes * 8 + 1024 * 1024,
      perFilePredictionBytes: Math.max(...records.map((record) => record.bytes)) * 8 + 1024 * 1024,
      treeStatus: tree.statusCode,
      sessions: tree.value.sessions.length,
      oversized: { fileBytes: oversized.bytes, statusCode: rejected.statusCode, error: rejected.value.error, details: rejected.value.details },
    });
  } finally {
    await stop(child);
    await log.close();
  }
}

async function testCacheBoundsAndHostFields() {
  const home = path.join(sandbox, 'home');
  const sessions = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'workspace');
  await mkdir(sessions, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const ids = [];
  // cwd 故意不存在 ⇒ 走 `/messages` 的 cwd-missing 只读分支（那条路才用这两个缓存）
  const missingCwd = path.join(sandbox, 'gone-workspace');
  for (let index = 0; index < 5; index += 1) {
    const id = randomUUID();
    ids.push(id);
    await sessionFile(id, sessions, 'x'.repeat(256), missingCwd);
  }
  const port = await reservePort();
  const logPath = path.join(sandbox, 'base.log');
  const log = await open(logPath, 'w');
  const child = spawn(process.execPath, [path.join(root, 'server', 'base.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: workspace,
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '1',
      SOPHO_PERSISTED_MANAGER_CACHE: '2',
      SOPHO_PERSISTED_MANAGER_CACHE_BYTES: '8000',
      SOPHO_READONLY_MESSAGE_CACHE: '2',
      SOPHO_READONLY_MESSAGE_CACHE_BYTES: '8000',
      SOPHO_MEMORY_HEAP_HIGH_BYTES: '1000000000000',
      SOPHO_MEMORY_HEAP_LOW_BYTES: '900000000000',
      SOPHO_MEMORY_RSS_HIGH_BYTES: '1000000000000',
      SOPHO_MEMORY_RSS_LOW_BYTES: '900000000000',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  try {
    const before = await waitHost(port, logPath);
    // 两个缓存各自的**触发点**：
    //  · readonlyMessages（现在缓存的是 /messages 的响应体）← GET /messages 的 cwd-missing 只读分支；
    //  · persistedManager ← 写路径的 cwd 准入（assertSessionCwdAvailable）：PATCH 一个 cwd 已不存在的
    //    会话，它在回 409 之前就把那个 manager 从缓存里取/建出来了。
    // 为什么不拿「看详情」触发：详情现在走 /tree 那份字节投影 + 侧车（不建 runtime、也不开
    // SessionManager），两个缓存它都不碰 —— 那是「详情不建 runtime」这个目标的**副作用**，不是回归。
    for (const id of ids) assert.equal((await request(port, `/sessions/${id}/messages`)).statusCode, 200);
    for (const id of ids) assert.equal((await request(port, `/sessions/${id}`, { method: 'PATCH', body: { name: 'cache probe' } })).statusCode, 409);
    const after = (await request(port, '/host')).value;
    const caches = after.memoryPolicy.caches;
    assert.ok(caches.persistedManager.items >= 1 && caches.persistedManager.items <= 2);
    assert.ok(caches.persistedManager.bytes <= 8000);
    assert.ok(caches.readonlyMessages.items >= 1 && caches.readonlyMessages.items <= 2);
    assert.ok(caches.readonlyMessages.bytes <= 8000);
    // Accounted cache bytes are the calibrated in-memory estimate (file x sessionMultiplier),
    // not the file size: a manager holds parsed entries, which is several times the JSONL.
    assert.ok(caches.persistedManager.bytes >= caches.persistedManager.items * 400, 'accounted bytes must reflect the memory multiplier');
    assert.equal(after.currentWorkerPid, before.currentWorkerPid);
    assert.equal(after.currentGenerationId, before.currentGenerationId);
    assert.equal(typeof after.memoryPolicy.watermarks.heapHighBytes, 'number');
    assert.equal(typeof after.pool.counters.evict.memory, 'number');
    print('A29-5 pool-external caches and /host fields', {
      workerPid: after.currentWorkerPid,
      generationId: after.currentGenerationId,
      watermarks: after.memoryPolicy.watermarks,
      caches,
      evictMemory: after.pool.counters.evict.memory,
      lastReclaim: after.memoryPolicy.lastReclaim,
      lastRejection: after.memoryPolicy.lastRejection,
    });
  } finally {
    await stop(child);
    await log.close();
  }
}

let primaryError;
try {
  testCountCapIsOptIn();
  await testEvictThenSucceed();
  await testProtectedRuntimesReject();
  await testSoftCapNeverRefuses();
  await testNoAdmissionPolicyFallsBackToHardCap();
  await testRejectBeforeOpen();
  await testHotAdmissionKeepsAcquireOrder();
  testHysteresis();
  await testCacheBoundsAndHostFields();
  await testTreeAggregateAdmission();
  print('A29-6 existing eligibility contract', { assertion: 'active/pinned leases survived memory reclaim; test/s1a-pool.mjs remains the full pending/queued/non-durable contract' });
  print('RESULT', 'A29 memory policy PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
