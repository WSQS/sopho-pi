import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RuntimePool, PoolSaturatedError } from '../server/pool.mjs';
import { finishCleanup, listenerRows, processCommandLine, removeSandbox } from './harness.mjs';

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a-pool-'));
const sandboxHome = path.join(sandbox, 'home');
const sessionsRoot = path.join(sandboxHome, 'sessions');
const HOST_READY_TIMEOUT_MS = 15_000;
const HOST_READY_POLL_MS = 30;
let hostPid = null;
let hostChild = null;
let hostExitPromise = null;
let hostLogHandle = null;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function createClock() {
  let now = 1_800_000_000_000;
  return {
    now: () => now,
    tick: (amount = 10) => { now += amount; return now; },
  };
}

async function reserveHighPort() {
  for (let candidate = 43000 + Math.floor(Math.random() * 15000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, value: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`invalid JSON from ${pathname}: ${body}`, { cause: error }));
        }
      });
    });
    request.once('error', reject);
  });
}

async function waitForHost(port) {
  // Windows startup on the test machine has measured as high as 7.4s. Give it
  // roughly 2x headroom, while keeping a finite budget for genuine failures.
  const deadline = Date.now() + HOST_READY_TIMEOUT_MS;
  let lastError;
  do {
    try {
      const response = await getJson(port, '/host');
      if (response.statusCode === 200) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, HOST_READY_POLL_MS));
  } while (Date.now() < deadline);
  throw new Error(`host did not become ready within ${HOST_READY_TIMEOUT_MS}ms`, { cause: lastError });
}

// 「这个端口的主人是谁」：绑定地址那一列不是本门要的，但「监听行」本身要贴进报告
// （`portOwner.raw`）—— 一律问 `test/harness.mjs` 的 `listenerRows`，本文件里不出现 `ss`
// 字面量（纪律见 `test/harness-contract.mjs`）。没有监听者就如实报错，不假装拿到 pid。
async function portOwner(port) {
  const owner = (await listenerRows(port)).find((row) => Number.isInteger(row.pid) && row.pid > 0);
  if (!owner) throw new Error(`no listener pid for ${port}`);
  return { pid: owner.pid, raw: owner.raw };
}

function processExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function createHarness(root, clock, { maxHot = 4, idleTTL = 15 * 60 * 1000, generation = 'g1', failDisposeFor = new Set() } = {}) {
  const files = new Map();
  let openCount = 0;

  function sessionPath(sessionId) {
    return path.join(root, `${sessionId}.jsonl`);
  }

  async function readEntries(sessionId) {
    const text = await readFile(sessionPath(sessionId), 'utf8');
    return text.trim().split('\n').map((line) => JSON.parse(line));
  }

  const pool = new RuntimePool({
    maxHot,
    idleTTL,
    sweepInterval: 0,
    currentGenerationId: generation,
    clock: clock.now,
    locateSession: async (sessionId) => files.has(sessionId) ? { sessionFile: files.get(sessionId) } : null,
    prepareRuntime: async ({ currentGenerationId }) => ({ generationId: currentGenerationId, cacheCleared: true }),
    openRuntime: async ({ sessionId, generationId }) => {
      openCount += 1;
      const target = sessionPath(sessionId);
      let leafId = null;
      let cwd = `/workspace/${sessionId}`;
      if (files.has(sessionId)) {
        const entries = await readEntries(sessionId);
        cwd = entries[0].cwd;
        leafId = entries.at(-1)?.id ?? null;
      }
      return {
        generationId,
        cwd,
        get sessionFile() { return target; },
        getCurrentLeafId() { return leafId; },
        async appendMessage(text) {
          if (!files.has(sessionId)) {
            await writeFile(target, `${JSON.stringify({ type: 'session', id: sessionId, cwd })}\n`);
            files.set(sessionId, target);
          }
          const entry = { type: 'message', id: randomUUID(), parentId: leafId, text };
          await appendFile(target, `${JSON.stringify(entry)}\n`);
          leafId = entry.id;
          return entry;
        },
        async dispose() {
          if (failDisposeFor.has(sessionId)) throw new Error(`scripted dispose failure for ${sessionId}`);
        },
      };
    },
  });

  return { pool, files, readEntries, get openCount() { return openCount; } };
}

async function persist(handle, text) {
  const entry = await handle.runExclusive((runtime) => runtime.appendMessage(text));
  await handle.refreshPersistence();
  return entry;
}

// Mirror how an HTTP request uses a handle: acquire for the request, write,
// then release the lease so the runtime becomes evictable again. A handle that
// is never released stays pinned and must block capacity eviction (409).
async function withSession(pool, sessionId, fn) {
  const handle = await pool.acquire(sessionId);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

// These harnesses wire no admission policy on purpose: with nothing else available to
// bound the pool, maxHot stays a hard bound and the pool refuses. In the real worker
// (server/base-logic.mjs) an admission policy is always wired, so maxHot is only a soft
// target and a full pool grows past it instead of returning 409 — that contract lives in
// test/a29-memory-policy.mjs (A29-7/A29-8).
async function expectSaturated(promise) {
  try {
    await promise;
    assert.fail('expected pool saturation');
  } catch (error) {
    assert.ok(error instanceof PoolSaturatedError);
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'pool_saturated');
    return error.toJSON();
  }
}

async function testKeyAndPluginCacheContract() {
  const root = path.join(sessionsRoot, 'key-contract');
  await mkdir(root, { recursive: true });
  const fullId = randomUUID();
  const wrongId = randomUUID();
  const mismatchPath = path.join(root, `${fullId}.jsonl`);
  await writeFile(mismatchPath, `${JSON.stringify({ type: 'session', id: wrongId, cwd: root })}\n`);
  let mismatchOpened = 0;
  const mismatchPool = new RuntimePool({
    maxHot: 1,
    idleTTL: 900000,
    sweepInterval: 0,
    currentGenerationId: 'g1',
    locateSession: async () => ({ sessionFile: mismatchPath }),
    prepareRuntime: async () => ({ generationId: 'g1', cacheCleared: true }),
    openRuntime: async () => { mismatchOpened += 1; return { async dispose() {} }; },
  });
  await assert.rejects(mismatchPool.acquire(fullId), /session header id mismatch/);
  assert.equal(mismatchOpened, 0);
  assert.throws(() => mismatchPool.acquire(fullId.slice(0, 8)), /full UUID/);

  let unsafeOpened = 0;
  const unsafePool = new RuntimePool({
    maxHot: 1,
    idleTTL: 900000,
    sweepInterval: 0,
    currentGenerationId: 'g2',
    prepareRuntime: async () => ({ generationId: 'g2', cacheCleared: false }),
    openRuntime: async () => { unsafeOpened += 1; return { async dispose() {} }; },
  });
  await assert.rejects(unsafePool.acquire(randomUUID()), /confirmed plugin cache clearing/);
  assert.equal(unsafeOpened, 0);

  const staleId = randomUUID();
  const stalePool = new RuntimePool({
    maxHot: 1,
    idleTTL: 900000,
    sweepInterval: 0,
    currentGenerationId: 'g2',
    prepareRuntime: async () => ({ generationId: 'g1', cacheCleared: false }),
    openRuntime: async () => ({ generationId: 'g1', async dispose() {} }),
  });
  await stalePool.acquire(staleId);
  const stale = stalePool.getSession(staleId);
  assert.equal(stale.pluginStale, true);
  assert.match(stale.staleReason, /g1.*g2/);
  print('V0 key/cache contract', {
    prefixRejected: true,
    headerMismatchRejectedBeforeOpen: mismatchOpened === 0,
    currentGenerationWithoutCacheClearRejectedBeforeOpen: unsafeOpened === 0,
    unclearedCacheActualGeneration: stale.generationId,
    currentGeneration: 'g2',
    pluginStale: stale.pluginStale,
    mtimeUsed: false,
  });
  await mismatchPool.close();
  await unsafePool.close();
  await stalePool.close();
}

async function testDefaultHasNoCountEviction() {
  const root = path.join(sessionsRoot, 'default-no-cap');
  await mkdir(root, { recursive: true });
  const files = new Map();
  const pool = new RuntimePool({
    idleTTL: 900000,
    sweepInterval: 0,
    currentGenerationId: 'g1',
    locateSession: async (sessionId) => files.has(sessionId) ? { sessionFile: files.get(sessionId) } : null,
    prepareRuntime: async () => ({ generationId: 'g1', cacheCleared: true }),
    openRuntime: async ({ sessionId }) => {
      const file = path.join(root, `${sessionId}.jsonl`);
      return {
        generationId: 'g1',
        sessionFile: file,
        async appendMessage() {
          await writeFile(file, `${JSON.stringify({ type: 'session', id: sessionId, cwd: root })}\n${JSON.stringify({ type: 'message', id: randomUUID(), parentId: null, text: 'durable' })}\n`);
          files.set(sessionId, file);
        },
        getCurrentLeafId: () => null,
        async dispose() {},
      };
    },
  });
  for (let index = 0; index < 20; index += 1) {
    const handle = await pool.acquire(randomUUID());
    await handle.runExclusive((runtime) => runtime.appendMessage());
    await handle.refreshPersistence();
    await handle.release();
  }
  const summary = pool.summary();
  assert.equal(summary.maxHot, null);
  assert.equal(summary.hot, 20);
  assert.equal(summary.counters.evict.capacity, 0);
  print('V1a default count eviction disabled', { maxHot: summary.maxHot, hot: summary.hot, capacityEvictions: summary.counters.evict.capacity, sessionsOpened: 20 });
  await pool.close();
}

async function testBoundedPool() {
  const clock = createClock();
  const harness = createHarness(sessionsRoot, clock);
  let peakHot = 0;
  for (let index = 0; index < 200; index += 1) {
    await withSession(harness.pool, randomUUID(), (handle) => persist(handle, `message-${index}`));
    clock.tick();
    peakHot = Math.max(peakHot, harness.pool.summary().hot);
  }
  const evictions = harness.pool.getEvents().filter((event) => event.event === 'evict');
  assert.ok(peakHot <= 4);
  assert.ok(evictions.length >= 196);
  assert.ok(evictions.every((event) => event.before.durable && event.before.runtimeState === 'hotIdle' && event.before.evictionEligible));
  print('V1 bounded', {
    sessions: 200,
    maxHot: 4,
    peakHot,
    evictions: evictions.length,
    cold: harness.pool.summary().cold,
    victimsAllDurableIdle: true,
  });
  await harness.pool.close();
}

async function testLruAndRestore() {
  const root = path.join(sessionsRoot, 'lru');
  await mkdir(root, { recursive: true });
  const clock = createClock();
  const harness = createHarness(root, clock);
  const ids = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((name) => [name, randomUUID()]));
  const before = new Map();

  for (const name of ['A', 'B', 'C', 'D']) {
    await withSession(harness.pool, ids[name], (handle) => persist(handle, `${name}-first`));
    before.set(name, await harness.readEntries(ids[name]));
    clock.tick(100);
  }
  harness.pool.getHandle(ids.A).touch();
  clock.tick(100);
  await withSession(harness.pool, ids.E, (e) => persist(e, 'E-first'));

  const capacityEvents = harness.pool.getEvents().filter((event) => event.event === 'evict' && event.reason === 'capacity');
  assert.equal(capacityEvents.at(-1).sessionId, ids.B);
  const bBefore = before.get('B');
  const reopened = await harness.pool.acquire(ids.B);
  await reopened.release();
  const bAfter = await harness.readEntries(ids.B);
  assert.equal(bAfter.length, bBefore.length);
  assert.equal(bAfter.at(-1).id, bBefore.at(-1).id);
  assert.equal(bAfter[0].cwd, bBefore[0].cwd);
  assert.equal(harness.pool.getSession(ids.B).restoreCount, 1);
  assert.equal(reopened.cwd, bBefore[0].cwd);
  print('V2 LRU raw event', capacityEvents.at(-1));
  print('V2 reopen consistency', {
    session: 'B',
    messages: bAfter.length - 1,
    lastEntryId: bAfter.at(-1).id,
    cwd: bAfter[0].cwd,
    restoreCount: harness.pool.getSession(ids.B).restoreCount,
  });
  await harness.pool.close();
}

async function testNoActiveOrNonDurableEviction() {
  const activeRoot = path.join(sessionsRoot, 'active');
  await mkdir(activeRoot, { recursive: true });
  const clock = createClock();
  const activeHarness = createHarness(activeRoot, clock);
  const activeIds = Array.from({ length: 5 }, () => randomUUID());
  const blockers = [];
  const blockersResolvers = [];
  for (const id of activeIds.slice(0, 4)) {
    const handle = await activeHarness.pool.acquire(id);
    await persist(handle, 'active');
    await handle.release();
    // Real in-flight turn: runExclusive holds the runtime in hotActive until done.
    blockers.push(handle.runExclusive(() => new Promise((resolve) => blockersResolvers.push(resolve))));
  }
  await nextTurn();
  assert.ok(activeIds.slice(0, 4).every((id) => activeHarness.pool.getSession(id).runtimeState === 'hotActive'));
  const activeBefore = activeIds.slice(0, 4).map((id) => activeHarness.pool.getSession(id));
  const active409 = await expectSaturated(activeHarness.pool.acquire(activeIds[4]));
  assert.deepEqual(activeIds.slice(0, 4).map((id) => activeHarness.pool.getSession(id)), activeBefore);
  assert.equal(activeHarness.pool.getSession(activeIds[4]), null);
  print('V3 active saturation raw response (no admission policy wired: maxHot stays hard)', { statusCode: 409, body: active409, statesUnchanged: true });
  for (const resolve of blockersResolvers) resolve();
  await Promise.all(blockers);
  await activeHarness.pool.close();

  const pendingRoot = path.join(sessionsRoot, 'non-durable');
  await mkdir(pendingRoot, { recursive: true });
  const pendingHarness = createHarness(pendingRoot, createClock());
  const pendingIds = Array.from({ length: 5 }, () => randomUUID());
  for (const id of pendingIds.slice(0, 4)) {
    const handle = await pendingHarness.pool.acquire(id);
    await handle.release();
  }
  const pendingBefore = pendingIds.slice(0, 4).map((id) => pendingHarness.pool.getSession(id));
  const pending409 = await expectSaturated(pendingHarness.pool.acquire(pendingIds[4]));
  assert.deepEqual(pendingIds.slice(0, 4).map((id) => pendingHarness.pool.getSession(id)), pendingBefore);
  assert.ok(pendingBefore.every((session) => !session.durable && session.internalKey === `pending:${session.sessionId}`));
  print('V3 non-durable saturation raw response (no admission policy wired: maxHot stays hard)', { statusCode: 409, body: pending409, statesUnchanged: true });
  await pendingHarness.pool.close();
}

async function testSingleWriter() {
  const root = path.join(sessionsRoot, 'single-writer');
  await mkdir(root, { recursive: true });
  const harness = createHarness(root, createClock(), { maxHot: 4 });
  const sessionId = randomUUID();
  const handles = await Promise.all(Array.from({ length: 100 }, () => harness.pool.acquire(sessionId)));
  assert.equal(new Set(handles).size, 1);
  assert.equal(new Set(handles.map((handle) => handle.owner.token)).size, 1);
  assert.equal(harness.openCount, 1);

  await Promise.all(handles.map((handle, index) => handle.runExclusive((runtime) => runtime.appendMessage(`writer-${index}`))));
  await handles[0].refreshPersistence();
  await Promise.all(handles.map((handle) => handle.release()));
  const lines = (await readFile(path.join(root, `${sessionId}.jsonl`), 'utf8')).trim().split('\n');
  const entries = lines.map((line) => JSON.parse(line));
  const ids = new Set();
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index];
    assert.ok(!ids.has(entry.id));
    if (entry.parentId !== null) assert.ok(ids.has(entry.parentId));
    ids.add(entry.id);
  }
  assert.equal(entries.length, 101);
  print('V4 single writer', {
    concurrentAcquires: 100,
    distinctHandles: new Set(handles).size,
    distinctOwners: new Set(handles.map((handle) => handle.owner.token)).size,
    openCount: harness.openCount,
    jsonLines: entries.length,
    uniqueEntryIds: ids.size,
    parentChainValid: true,
  });
  await harness.pool.close();
}

async function testHonestGenerationFields() {
  const root = path.join(sessionsRoot, 'generation');
  await mkdir(root, { recursive: true });
  const clock = createClock();
  const harness = createHarness(root, clock, { generation: 'g1' });
  const sessionId = randomUUID();
  await withSession(harness.pool, sessionId, (handle) => persist(handle, 'g1 message'));
  const g1 = harness.pool.getSession(sessionId);
  assert.equal(g1.pluginStale, false);
  harness.pool.setCurrentGeneration('g2');
  const stale = harness.pool.getSession(sessionId);
  assert.equal(stale.pluginStale, true);
  assert.equal(stale.logicStale, true);
  assert.match(stale.staleReason, /g1.*g2/);
  await harness.pool.evict(sessionId, 'stale_generation');
  await withSession(harness.pool, sessionId, () => nextTurn());
  const g2 = harness.pool.getSession(sessionId);
  assert.equal(g2.generationId, 'g2');
  assert.equal(g2.pluginStale, false);
  assert.equal(g2.restoreCount, 1);
  print('V5 honest generation fields', {
    before: { generationId: g1.generationId, pluginStale: g1.pluginStale },
    afterGenerationChange: { generationId: stale.generationId, currentGenerationId: 'g2', pluginStale: stale.pluginStale, staleReason: stale.staleReason },
    afterReopen: { generationId: g2.generationId, pluginStale: g2.pluginStale, restoreCount: g2.restoreCount },
    mtimeUsed: false,
  });
  await harness.pool.close();
}

async function testTtlAndStaleGenerationReclaim() {
  const ttlRoot = path.join(sessionsRoot, 'ttl');
  await mkdir(ttlRoot, { recursive: true });
  const clock = createClock();
  const ttlHarness = createHarness(ttlRoot, clock, { idleTTL: 1000 });
  const idleId = randomUUID();
  await withSession(ttlHarness.pool, idleId, (handle) => persist(handle, 'idle'));
  clock.tick(2000);
  await withSession(ttlHarness.pool, randomUUID(), (handle) => persist(handle, 'fresher'));
  const ttlEvent = ttlHarness.pool.getEvents().find((event) => event.event === 'evict' && event.reason === 'ttl');
  assert.equal(ttlEvent.sessionId, idleId);
  assert.equal(ttlHarness.pool.getSession(idleId).runtimeState, 'cold');

  const staleRoot = path.join(sessionsRoot, 'stale-generation');
  await mkdir(staleRoot, { recursive: true });
  const staleClock = createClock();
  const staleHarness = createHarness(staleRoot, staleClock, { generation: 'g1' });
  const staleId = randomUUID();
  await withSession(staleHarness.pool, staleId, (handle) => persist(handle, 'g1'));
  assert.equal(staleHarness.pool.getSession(staleId).pluginStale, false);
  staleHarness.pool.setCurrentGeneration('g2');
  assert.equal(staleHarness.pool.getSession(staleId).pluginStale, true);
  await withSession(staleHarness.pool, randomUUID(), (handle) => persist(handle, 'g2'));
  assert.equal(staleHarness.pool.counters.evict.stale_generation, 1);
  assert.equal(staleHarness.pool.getSession(staleId).runtimeState, 'cold');
  print('V7 ttl + stale_generation reclaim', {
    ttlEviction: { sessionId: idleId, reason: ttlEvent.reason, before: ttlEvent.before.runtimeState, idleForMs: ttlEvent.before.idleForMs },
    staleGenerationEvictions: staleHarness.pool.counters.evict.stale_generation,
    mtimeUsed: false,
  });
  await ttlHarness.pool.close();
  await staleHarness.pool.close();
}

async function testDisposeFailureKeepsSessionHot() {
  const root = path.join(sessionsRoot, 'dispose-failure');
  await mkdir(root, { recursive: true });
  const clock = createClock();
  const failingId = randomUUID();
  const harness = createHarness(root, clock, { idleTTL: 1000, failDisposeFor: new Set([failingId]) });
  await withSession(harness.pool, failingId, (handle) => persist(handle, 'stuck'));
  clock.tick(2000);
  const evicted = await harness.pool.sweep();
  assert.equal(evicted, 0);
  assert.equal(harness.pool.counters.disposeFailures, 1);
  const session = harness.pool.getSession(failingId);
  assert.equal(session.runtimeState, 'hotIdle');
  assert.equal(session.evictionEligible, false);
  assert.deepEqual(session.pinReasons, ['dispose_failed']);
  print('V8 dispose failure', {
    disposeFailures: harness.pool.counters.disposeFailures,
    lastDisposeError: harness.pool.counters.lastDisposeError.message,
    runtimeState: session.runtimeState,
    pinReasons: session.pinReasons,
    evictionEligible: session.evictionEligible,
  });
  await harness.pool.close();
}

async function testOpenFailureDisposesOpenedRuntime() {
  const root = path.join(sessionsRoot, 'open-failure');
  await mkdir(root, { recursive: true });
  const sessionId = randomUUID();
  const sessionFile = path.join(root, `${sessionId}.jsonl`);
  await writeFile(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId, cwd: root })}\n`);
  let disposed = 0;
  const pool = new RuntimePool({
    maxHot: 1,
    idleTTL: 900000,
    sweepInterval: 0,
    currentGenerationId: 'g1',
    locateSession: async () => ({ sessionFile }),
    prepareRuntime: async () => ({ generationId: 'g1', cacheCleared: true }),
    openRuntime: async () => ({
      generationId: 'g1',
      sessionFile,
      getCurrentLeafId() { throw new Error('leaf probe failed'); },
      async dispose() { disposed += 1; },
    }),
  });
  await assert.rejects(pool.acquire(sessionId), /leaf probe failed/);
  assert.equal(disposed, 1);
  assert.equal(pool.getSession(sessionId), null);
  assert.equal(pool.getEvents().some((event) => event.event === 'open_failed'), true);
  print('V9 open failure disposes runtime', { disposedHandles: disposed, recordRemoved: true, openFailedEvent: true });
  await pool.close();
}

async function testNonExistentFileIsPendingCold() {
  const root = path.join(sessionsRoot, 'missing-file');
  await mkdir(root, { recursive: true });
  const sessionId = randomUUID();
  const pool = new RuntimePool({
    maxHot: 2,
    idleTTL: 1000,
    sweepInterval: 0,
    currentGenerationId: 'g1',
    // Locate returns a path that does not exist yet: must open as pending, not crash on realpath.
    locateSession: async () => ({ sessionFile: path.join(root, `${sessionId}.jsonl`) }),
    prepareRuntime: async () => ({ generationId: 'g1', cacheCleared: true }),
    openRuntime: async ({ sessionFile }) => ({ generationId: 'g1', sessionFile, async dispose() {} }),
  });
  const handle = await pool.acquire(sessionId);
  const pending = pool.getSession(sessionId);
  assert.equal(pending.durable, false);
  assert.equal(pending.internalKey, `pending:${sessionId}`);
  assert.equal(pending.evictionEligible, false);
  await handle.release();
  assert.equal(await pool.sweep(), 0);
  print('V10 missing file is pending', {
    durable: pending.durable,
    internalKey: pending.internalKey,
    evictionEligible: pending.evictionEligible,
    crashedOnRealpath: false,
  });
  await pool.close();
}

async function testNestedPoolReloads() {
  // S1b moved the pool into generation workers (server/worker.mjs, spawned by
  // server/base.mjs). The old in-process hack (importing pool.mjs with the logic
  // layer's `?v=` so a pool edit could not hide behind Node's module cache) is gone
  // on purpose: a generation worker is a fresh process, so the whole module graph is
  // new. This probe pins that property: one import per worker process, not per
  // in-process reload.
  const root = path.join(sandbox, 'reload-probe');
  await mkdir(root, { recursive: true });
  await cp(path.join(sourceRoot, 'server'), path.join(root, 'server'), { recursive: true });
  await symlink(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await appendFile(path.join(root, 'server', 'pool.mjs'), '\nglobalThis.__s1aPoolEvals = (globalThis.__s1aPoolEvals || 0) + 1;\n');
  const probePath = path.join(root, 'probe.mjs');
  await writeFile(probePath, [
    "await import('./server/pool.mjs');",
    "await import('./server/pool.mjs');",
    'process.stdout.write(`${JSON.stringify({ inProcessEvals: globalThis.__s1aPoolEvals })}\\n`);',
    '',
  ].join('\n'));
  const { stdout } = await execFileAsync(process.execPath, [probePath], { cwd: root });
  const probe = JSON.parse(stdout.trim());
  // Two imports of the same module in one process = one evaluation; a worker process
  // gets its own copy, which is exactly what the generation switch guarantees.
  assert.equal(probe.inProcessEvals, 1);

  const workerEvals = [];
  for (let index = 0; index < 2; index += 1) {
    const workerProbe = path.join(root, `worker-probe-${index}.mjs`);
    await writeFile(workerProbe, [
      "await import('./server/pool.mjs');",
      'process.stdout.write(`${JSON.stringify({ poolEvals: globalThis.__s1aPoolEvals })}\\n`);',
      '',
    ].join('\n'));
    const result = await execFileAsync(process.execPath, [workerProbe], { cwd: root });
    workerEvals.push(JSON.parse(result.stdout.trim()).poolEvals);
  }
  assert.deepEqual(workerEvals, [1, 1]);
  print('V11 pool module freshness per generation', {
    sameProcessRepeatedImportEvals: probe.inProcessEvals,
    workerProcessEvals: workerEvals,
    note: 'a generation worker is a fresh process, so pool.mjs always runs fresh there',
  });
}

async function testHostObservability() {
  const port = await reserveHighPort();
  const logPath = path.join(sandbox, 's1a-host-test.log');
  hostLogHandle = await open(logPath, 'w');
  hostChild = spawn(process.execPath, [path.join(sourceRoot, 'server', 'base.mjs')], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: sandboxHome,
      ASSIST_HOME: sandboxHome,
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_MAX_HOT: '4',
      SOPHO_IDLE_TTL_MS: '900000',
    },
    stdio: ['ignore', hostLogHandle.fd, hostLogHandle.fd],
  });
  hostPid = hostChild.pid;
  assert.ok(Number.isInteger(hostPid) && hostPid > 0, 'spawned host must have a pid');
  hostExitPromise = processExit(hostChild);
  const response = await waitForHost(port);
  const owner = await portOwner(port);
  assert.equal(owner.pid, hostPid);
  const cmdline = await processCommandLine(hostPid);
  assert.match(cmdline.replaceAll('\\', '/'), /server\/base\.mjs/);
  assert.equal(response.value.pool.maxHot, 4);
  assert.equal(response.value.pool.idleTTL, 900000);
  assert.deepEqual(
    Object.fromEntries(['hot', 'cold', 'active', 'pinned', 'loading'].map((key) => [key, response.value.pool[key]])),
    { hot: 0, cold: 0, active: 0, pinned: 0, loading: 0 },
  );
  assert.equal(response.value.pool.counters.acquire, 0);
  assert.equal(response.value.pool.counters.restore, 0);
  assert.equal(response.value.pool.counters.disposeFailures, 0);
  assert.equal(typeof response.value.hostMemory.rss, 'number');
  print('V6 /host observability', { port, portOwner: owner.raw, response: response.value });

  process.kill(hostPid, 'SIGTERM');
  const exited = await hostExitPromise;
  hostPid = null;
  hostChild = null;
  hostExitPromise = null;
  assert.equal(exited.signal, null);
  // Windows implements process.kill(SIGTERM) via TerminateProcess, so Node reports
  // exit code 1 instead of delivering the POSIX signal to the graceful handler.
  assert.equal(exited.code, process.platform === 'win32' ? 1 : 0);
  await hostLogHandle.close();
  hostLogHandle = null;
}

let primaryError;
try {
  await mkdir(sessionsRoot, { recursive: true });
  print('sandbox', { root: sandbox, home: sandboxHome, forbiddenPortsUsed: false });
  await testKeyAndPluginCacheContract();
  await testDefaultHasNoCountEviction();
  await testBoundedPool();
  await testLruAndRestore();
  await testNoActiveOrNonDurableEviction();
  await testSingleWriter();
  await testHonestGenerationFields();
  await testTtlAndStaleGenerationReclaim();
  await testDisposeFailureKeepsSessionHot();
  await testOpenFailureDisposesOpenedRuntime();
  await testNonExistentFileIsPendingCold();
  await testNestedPoolReloads();
  await testHostObservability();
  print('RESULT', 'S1a pool PASS');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  // `hostPid` is recorded immediately after spawn, before readiness can fail.
  // Always stop that exact child so a timeout cannot leave the test awaiting it forever.
  if (hostChild && hostChild.exitCode === null && hostChild.signalCode === null) {
    try {
      process.kill(hostPid, 'SIGTERM');
    } catch (error) {
      process.stderr.write(`host cleanup failed: ${error.message}\n`);
    }
  }
  if (hostExitPromise) await hostExitPromise;
  if (hostLogHandle) await hostLogHandle.close();
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
