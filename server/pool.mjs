import { readFile, realpath, stat } from 'node:fs/promises';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVICTION_REASONS = ['ttl', 'capacity', 'memory', 'stale_generation', 'manual'];
const BUSY_FLAGS = new Set(['compaction', 'retry', 'queued', 'handoff']);

function iso(now) {
  return new Date(now).toISOString();
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !FULL_UUID.test(sessionId)) {
    throw new TypeError(`sessionId must be a full UUID: ${sessionId}`);
  }
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function withTimeout(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function inspectSessionFile(sessionId, sessionFile, currentLeafId = null) {
  const canonicalPath = await realpath(sessionFile);
  const info = await stat(canonicalPath);
  if (!info.isFile()) throw new Error(`session path is not a file: ${canonicalPath}`);

  const text = await readFile(canonicalPath, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error(`session file is empty: ${canonicalPath}`);

  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`invalid session header JSON: ${canonicalPath}`, { cause: error });
  }
  if (header?.id !== sessionId) {
    throw new Error(`session header id mismatch: requested ${sessionId}, found ${header?.id ?? 'missing'}`);
  }

  let leafCovered = currentLeafId === null;
  if (currentLeafId !== null) {
    for (let index = 1; index < lines.length; index += 1) {
      let entry;
      try {
        entry = JSON.parse(lines[index]);
      } catch (error) {
        throw new Error(`invalid session entry JSON at line ${index + 1}: ${canonicalPath}`, { cause: error });
      }
      if (entry?.id === currentLeafId) leafCovered = true;
    }
  }

  return {
    sessionFile: canonicalPath,
    size: info.size,
    internalKey: canonicalPath,
    header,
    durable: leafCovered,
  };
}

export class GenerationDrainingError extends Error {
  constructor(sessionId) {
    super(`generation is draining and no longer owns session: ${sessionId}`);
    this.name = 'GenerationDrainingError';
    this.code = 'session_not_owned_by_generation';
    this.statusCode = 409;
  }

  toJSON() {
    return { error: this.code, message: this.message };
  }
}

// Retained for the one case where maxHot is still a hard bound: a pool with no
// admission policy wired has no other bound available, so it refuses instead of
// growing without limit. Every real deployment wires one (server/base-logic.mjs),
// and there the user-visible bound is the memory admission error instead.
export class PoolSaturatedError extends Error {
  constructor(summary) {
    super('runtime pool is saturated and has no eligible eviction victim');
    this.name = 'PoolSaturatedError';
    this.code = 'pool_saturated';
    this.statusCode = 409;
    this.pool = summary;
  }

  toJSON() {
    return { error: this.code, message: this.message, pool: this.pool };
  }
}

export class RuntimeHandle {
  #adapter;
  #hooks;
  #operationQueue = Promise.resolve();
  #queuedOperations = 0;
  #disposePromise = null;
  #disposing = false;
  #disposed = false;
  #currentLeafId = null;

  constructor({ sessionId, generationId, workerPid = process.pid, runtimeId = randomUUID(), token = randomUUID(), adapter, hooks = {} }) {
    validateSessionId(sessionId);
    if (!adapter || typeof adapter.dispose !== 'function') {
      throw new TypeError('RuntimeHandle adapter must provide dispose()');
    }
    this.sessionId = sessionId;
    this.generationId = String(generationId);
    this.workerPid = workerPid;
    this.runtimeId = String(runtimeId);
    this.token = String(token);
    this.#adapter = adapter;
    this.#hooks = hooks;
  }

  get owner() {
    return {
      generationId: this.generationId,
      workerPid: this.workerPid,
      runtimeId: this.runtimeId,
      token: this.token,
    };
  }

  get disposed() {
    return this.#disposed;
  }

  // 「正在收它」（`dispose()` 已开始、`#adapter.dispose` 还没跑完）：与 `disposed` 是两件事 ——
  // `disposed` 是「收完了」，这个是「已经在收了」。调用方（归档的热路）拿它判「这一笔撞上的是
  // 别人正在收它」，从而把「refresh 的那条 `#assertOpen`」如实降级成「跳过」而不是 500。
  get disposing() {
    return this.#disposing;
  }

  get cwd() {
    return this.#adapter.cwd ?? null;
  }

  get sessionFile() {
    return this.#adapter.sessionFile ?? null;
  }

  get currentLeafId() {
    if (typeof this.#adapter.getCurrentLeafId === 'function') return this.#adapter.getCurrentLeafId();
    return this.#currentLeafId;
  }

  setCurrentLeafId(entryId) {
    this.#assertOpen();
    this.#currentLeafId = entryId ?? null;
  }

  touch() {
    this.#assertOpen();
    this.#hooks.touch?.();
  }

  setActive(active) {
    this.#assertOpen();
    this.#hooks.setActive?.(Boolean(active));
  }

  settled() {
    this.#assertOpen();
    this.#hooks.settled?.();
  }

  async release() {
    this.#assertOpen();
    await this.#hooks.release?.();
  }

  setPendingMessages(count) {
    this.#assertOpen();
    if (!Number.isInteger(count) || count < 0) throw new TypeError('pending message count must be a non-negative integer');
    this.#hooks.setPendingMessages?.(count);
  }

  setBusy(flag, busy) {
    this.#assertOpen();
    if (!BUSY_FLAGS.has(flag)) throw new TypeError(`unknown runtime busy flag: ${flag}`);
    this.#hooks.setBusy?.(flag, Boolean(busy));
  }

  pin(reason) {
    this.#assertOpen();
    if (!reason) throw new TypeError('pin reason is required');
    this.#hooks.pin?.(String(reason));
  }

  unpin(reason) {
    this.#assertOpen();
    this.#hooks.unpin?.(String(reason));
  }

  async refreshPersistence() {
    this.#assertOpen();
    return this.#hooks.refreshPersistence?.();
  }

  // 运行级事实：这个 runtime 此刻是不是真的在干活。谁想回收它、或者想宣称它「闲置」，
  // 只能问它自己（adapter.isWorking()：模型请求在飞 / 压紧 / 重试 / 准入守卫），
  // 不能拿「池里有这条 hot 记录」这种名单当判据。
  // 没有 isWorking 的脚本 adapter 如实返回 null（没有事实可问），调用方退回缓存标签。
  runningNow() {
    const adapter = this.#adapter;
    if (typeof adapter?.isWorking !== 'function') return null;
    try {
      return adapter.isWorking() === true;
    } catch {
      return null;
    }
  }

  // 只读事实：这个 runtime 的 pi 会话现在**向模型暴露**的工具面 —— 全部注册工具（`getAllTools()`）
  // 与此刻 active 的名字（`getActiveToolNames()`）。
  //
  // 口径与 `runningNow()` 完全一样：**同步**问它、**不进操作队列**。为什么强调这一条：
  //   · 它是纯读 —— 两个方法都是同步取值，JS 单线程里读不到「半个状态」；
  //   · 而走 `runExclusive` 会把这条记录的 `queuedOperations` 临时顶到 1，而那是**回收判据之一**
  //     （`#reclaimBlockers` 里的 `queued_operations`）⇒ 一条调试读不该让并发的一次 reclaim 少收一条。
  // 没有可读会话（脚本 adapter / 已 disposed）⇒ 如实回 `{ok:false, reason}`，不猜、不返回空数组顶替。
  toolSurface() {
    const session = this.#adapter?.session;
    if (!session) return { ok: false, reason: 'this runtime adapter holds no pi session object' };
    if (typeof session.getAllTools !== 'function' || typeof session.getActiveToolNames !== 'function') {
      return { ok: false, reason: 'this pi session exposes neither getAllTools() nor getActiveToolNames()' };
    }
    try {
      const registered = session.getAllTools();
      const active = session.getActiveToolNames();
      if (!Array.isArray(registered) || !Array.isArray(active)) {
        return { ok: false, reason: 'getAllTools()/getActiveToolNames() did not return arrays' };
      }
      return { ok: true, registered, active };
    } catch (error) {
      return { ok: false, reason: normalizeError(error).message };
    }
  }

  runExclusive(operation, { active = true } = {}) {
    this.#assertOpen();
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    this.#queuedOperations += 1;
    this.#hooks.setQueuedOperations?.(this.#queuedOperations);
    const run = async () => {
      this.#assertOpen();
      this.#queuedOperations -= 1;
      this.#hooks.setQueuedOperations?.(this.#queuedOperations);
      if (active) this.#hooks.setActive?.(true);
      try {
        return await operation(this.#adapter, this);
      } finally {
        if (active) {
          this.#hooks.setActive?.(false);
          this.#hooks.settled?.();
        }
      }
    };
    const result = this.#operationQueue.then(run, run);
    this.#operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async dispose(reason = 'manual') {
    if (this.#disposed) return;
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposing = true;
    this.#disposePromise = (async () => {
      try {
        await this.#operationQueue;
        await this.#adapter.dispose(reason);
        this.#disposed = true;
      } catch (error) {
        this.#disposing = false;
        this.#disposePromise = null;
        throw error;
      }
    })();
    return this.#disposePromise;
  }

  #assertOpen() {
    if (this.#disposed || this.#disposing) throw new Error(`runtime handle is disposing or disposed: ${this.sessionId}`);
  }
}

export class RuntimePool {
  #records = new Map();
  #internalOwners = new Map();
  #openQueue = Promise.resolve();
  #events = [];
  #eventSequence = 0;
  #sweeper;
  #closed = false;
  #draining = false;

  // ── 「本代 runtime 的插件缓存」这条契约的两半（2026-10-04 口径修正，两边一起改）────────────
  //   · `preparedGenerationId === currentGenerationId` 时 `cacheCleared` **必须为 true**（下面那条硬条件）：
  //     这是「**本代**开出来的 runtime 一定要拿到当前插件文件」的那道契约 —— 提供者（`base-logic` 的
  //     `prepareRuntime`）**真的**清过 pi 的进程级插件模块缓存之后才许报 true（2026-10-04 之前它是自报，
  //     提供者只 reload 一次、按 pi 语义并**不**清缓存 ⇒ 两边一起改）。
  //   · 跨代（`preparedGenerationId !== currentGenerationId`）时允许 false：那本就不是缺陷，而是**陈旧**，
  //     由 `pluginStale` 如实登记（这样一条会话才可能落在「拿旧面」这个已知状态上，而不是被拒开）。
  constructor({
    maxHot = null,
    idleTTL = 15 * 60 * 1000,
    sweepInterval = 30 * 1000,
    currentGenerationId,
    locateSession = async () => null,
    prepareRuntime = async ({ currentGenerationId: generationId }) => ({ generationId, cacheCleared: false }),
    admitRuntime = null,
    openRuntime,
    clock = Date.now,
    workerPid = process.pid,
    logicVersion = null,
    codeRevision = null,
    loadedAt = new Date().toISOString(),
    onEvent = null,
  }) {
    if (maxHot !== null && (!Number.isInteger(maxHot) || maxHot < 1)) throw new TypeError('maxHot must be null or a positive integer');
    if (!Number.isFinite(idleTTL) || idleTTL < 0) throw new TypeError('idleTTL must be a non-negative number');
    if (!Number.isFinite(sweepInterval) || sweepInterval < 0) throw new TypeError('sweepInterval must be a non-negative number');
    if (!currentGenerationId) throw new TypeError('currentGenerationId is required');
    if (typeof openRuntime !== 'function') throw new TypeError('openRuntime is required');
    if (admitRuntime !== null && typeof admitRuntime !== 'function') throw new TypeError('admitRuntime must be a function or null');

    this.maxHot = maxHot;
    this.idleTTL = idleTTL;
    this.currentGenerationId = String(currentGenerationId);
    this.locateSession = locateSession;
    this.prepareRuntime = prepareRuntime;
    this.admitRuntime = admitRuntime;
    this.openRuntime = openRuntime;
    this.clock = clock;
    this.workerPid = workerPid;
    this.logicVersion = logicVersion;
    this.codeRevision = codeRevision;
    this.loadedAt = loadedAt;
    this.onEvent = onEvent;
    this.counters = {
      acquire: 0,
      restore: 0,
      evict: Object.fromEntries(EVICTION_REASONS.map((reason) => [reason, 0])),
      disposeFailures: 0,
      lastDisposeError: null,
    };

    if (sweepInterval > 0) {
      this.#sweeper = setInterval(() => {
        this.sweep().catch((error) => this.#emit('sweep_error', { error: normalizeError(error).message }));
      }, sweepInterval);
      this.#sweeper.unref?.();
    }
  }

  setCurrentGeneration(generationId) {
    if (!generationId) throw new TypeError('generationId is required');
    this.currentGenerationId = String(generationId);
    this.#emit('generation_changed', { generationId: this.currentGenerationId });
  }

  async drainToGeneration(generationId) {
    return this.#serializeOpen(async () => {
      this.#draining = true;
      if (generationId) this.currentGenerationId = String(generationId);
      this.#emit('generation_draining', { currentGenerationId: this.currentGenerationId });
      await this.#evictExpired();
      // A session that never became durable (no session file covers its leaf yet)
      // can never be evicted by the rules above. Left alone it would keep this
      // generation alive forever, which is exactly the unbounded accumulation the
      // two-generation limit exists to prevent. During drain those are reclaimed,
      // loudly and only when nobody is holding them.
      await this.#forceDisposeNonDurable();
      return this.summary();
    });
  }

  async #forceDisposeNonDurable() {
    const now = this.clock();
    const candidates = [...this.#records.values()].filter((record) => record.handle !== null
      && !record.durable
      && record.leaseCount === 0
      && record.pendingMessages === 0
      && record.queuedOperations === 0
      && record.busyFlags.size === 0
      && this.#idleForReclaim(record));
    for (const record of candidates) {
      const handle = record.handle;
      record.runtimeState = 'evicting';
      try {
        await handle.dispose('drain_non_durable');
      } catch (error) {
        const failure = normalizeError(error);
        this.counters.disposeFailures += 1;
        this.counters.lastDisposeError = { at: iso(now), sessionId: record.sessionId, message: failure.message };
        record.runtimeState = 'hotIdle';
        record.pinReasons.add('dispose_failed');
        this.#emit('dispose_failed', { sessionId: record.sessionId, reason: 'drain_non_durable', error: failure.message });
        continue;
      }
      if (record.internalKey) this.#internalOwners.delete(record.internalKey);
      record.handle = null;
      record.owner = null;
      record.runtimeState = 'cold';
      record.runtimeId = null;
      record.generationId = null;
      record.workerPid = null;
      record.leaseCount = 0;
      this.#emit('drain_non_durable_disposed', { sessionId: record.sessionId });
    }
    return candidates.length;
  }

  isGenerationDraining() {
    return this.#draining;
  }

  // Live runtimes are still owned by this generation; a draining worker uses this
  // to decide when it can exit.
  liveRuntimes() {
    return [...this.#records.values()].filter((record) => record.handle !== null).length;
  }

  // During drain the worker must keep running while any session still has real work
  // left: a turn in flight, queued messages, an acquired lease, a compaction/retry.
  // A durable idle session that is only held open by an SSE subscriber is *not* work;
  // that subscriber reconnects to the new generation in milliseconds, so it must not
  // pin the old generation forever (which is exactly how a still-open browser tab used
  // to keep a generation alive until the host force-killed it, taking an in-flight turn
  // with it). This is the honest difference between "busy" and "merely subscribed".
  drainBusy() {
    return [...this.#records.values()]
      .filter((record) => record.handle !== null && !this.#reclaimableModuloPins(record))
      .map((record) => ({
        sessionId: record.sessionId,
        runtimeState: record.runtimeState,
        durable: record.durable,
        pendingMessages: record.pendingMessages,
        queuedOperations: record.queuedOperations,
        acquiredLeases: record.leaseCount,
        busyFlags: [...record.busyFlags].sort(),
        pinReasons: [...record.pinReasons].sort(),
      }));
  }

  // Honest diagnosis for a drain that cannot finish (does not silently keep an
  // unreclaimable generation alive).
  drainBlockers() {
    const now = this.clock();
    return [...this.#records.values()]
      .filter((record) => record.handle !== null)
      .map((record) => ({
        ...this.#recordsFacts(record, now),
        evictionEligible: this.#eligible(record, now),
        idleForMs: this.#idleFor(record, now),
        blockers: this.#reclaimBlockers(record),
      }));
  }

  // 显式、非破坏的回收入口（不换代也能用）：只收**闲置** runtime，在跑的一律拒绝并说清楚为什么。
  // 与自动路（TTL/换代）共用同一套判据：`#reclaimBlockers` 只列事实，不猜。
  // - `dryRun`：只报不收（运维看得见它准备收谁、谁挡着、为什么挡）。
  // - `includePinned`：默认不动有 SSE 订阅者的 runtime（那是活客户端在用它的直播流）；
  //   显式打开才收，且调用方负责把那一路 SSE 用可重连事件收尾（见 base-logic 的 evict 钩子）。
  async reclaimIdle({ dryRun = false, sessionId = null, includePinned = false } = {}) {
    if (sessionId !== null) validateSessionId(sessionId);
    return this.#serializeOpen(async () => {
      const now = this.clock();
      const reclaimed = [];
      const wouldReclaim = [];
      const refused = [];
      const skipped = [];
      for (const record of [...this.#records.values()]) {
        if (sessionId !== null && record.sessionId !== sessionId) continue;
        if (record.handle === null) continue;
        const facts = this.#recordsFacts(record, now);
        const reasons = this.#reclaimBlockers(record);
        const hard = reasons.filter((reason) => reason !== 'subscriber_pinned');
        if (hard.length > 0) {
          refused.push({ ...facts, reason: hard[0], reasons });
          continue;
        }
        if (reasons.includes('subscriber_pinned') && !includePinned) {
          skipped.push({ ...facts, reason: 'subscriber_pinned', reasons, hint: 'pass includePinned:true to reclaim it anyway (ends that session\'s SSE stream with a retryable event)' });
          continue;
        }
        if (dryRun) {
          wouldReclaim.push({ ...facts, reason: 'idle', reasons });
          continue;
        }
        const ok = await this.#evict(record, 'manual', { ignorePins: includePinned });
        if (ok) {
          reclaimed.push({ ...facts, reason: 'manual', reasons, pinReasonsBefore: facts.pinReasons });
        } else {
          refused.push({ ...facts, reason: 'not_reclaimable_now', reasons, disposeError: this.counters.lastDisposeError });
        }
      }
      return {
        at: iso(now),
        dryRun: dryRun === true,
        includePinned: includePinned === true,
        sessionId,
        // 注意：排空中的池把 currentGenerationId 指向**下一代**（新 open 都去那里）。
        // worker 自己的代别由调用方（base-logic）用 generationId 填，这里只报池的事实。
        poolCurrentGenerationId: this.currentGenerationId,
        draining: this.#draining,
        liveRuntimes: this.liveRuntimes(),
        reclaimed,
        wouldReclaim,
        refused,
        skipped,
      };
    });
  }

  acquire(sessionId, options = {}) {
    validateSessionId(sessionId);
    this.counters.acquire += 1;
    return this.#serializeOpen(() => this.#acquire(sessionId, options));
  }

  getHandle(sessionId) {
    validateSessionId(sessionId);
    return this.#records.get(sessionId)?.handle ?? null;
  }

  getSession(sessionId) {
    validateSessionId(sessionId);
    const record = this.#records.get(sessionId);
    return record ? this.#snapshot(record) : null;
  }

  listSessions() {
    return [...this.#records.values()].map((record) => this.#snapshot(record));
  }

  getEvents() {
    return this.#events.map((event) => structuredClone(event));
  }

  summary() {
    const values = [...this.#records.values()];
    const hot = values.filter((record) => record.handle !== null).length;
    return {
      hot,
      cold: values.filter((record) => record.runtimeState === 'cold').length,
      active: values.filter((record) => record.runtimeState === 'hotActive').length,
      pinned: values.filter((record) => record.pinReasons.size > 0).length,
      loading: values.filter((record) => record.runtimeState === 'loading').length,
      draining: this.#draining,
      maxHot: this.maxHot,
      idleTTL: this.idleTTL,
      counters: structuredClone(this.counters),
    };
  }

  async sweep({ memoryPressure = false } = {}) {
    return this.#serializeOpen(async () => {
      const before = this.counters.evict.ttl + this.counters.evict.stale_generation + this.counters.evict.memory;
      await this.#evictExpired();
      if (memoryPressure) await this.#evictMemory();
      return this.counters.evict.ttl + this.counters.evict.stale_generation + this.counters.evict.memory - before;
    });
  }

  async evict(sessionId, reason = 'manual') {
    validateSessionId(sessionId);
    if (!EVICTION_REASONS.includes(reason)) throw new TypeError(`unknown eviction reason: ${reason}`);
    return this.#serializeOpen(async () => {
      const record = this.#records.get(sessionId);
      if (!record || !this.#eligible(record, this.clock())) return false;
      return this.#evict(record, reason);
    });
  }

  async close({ disposeTimeout = 5000 } = {}) {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweeper) clearInterval(this.#sweeper);
    await this.#serializeOpen(async () => {
      const records = [...this.#records.values()];
      for (const record of records) {
        if (!record.handle) continue;
        if (this.#eligible(record, this.clock())) {
          await this.#evict(record, 'manual');
          continue;
        }
        const handle = record.handle;
        record.runtimeState = 'evicting';
        this.#emit('close_disposing', { sessionId: record.sessionId, acquiredLeases: record.leaseCount });
        try {
          await withTimeout(handle.dispose('pool_close'), disposeTimeout, () => {
            throw new Error(`dispose timed out after ${disposeTimeout}ms: ${record.sessionId}`);
          });
          if (record.internalKey) this.#internalOwners.delete(record.internalKey);
          record.handle = null;
          record.owner = null;
          record.runtimeState = 'cold';
          record.runtimeId = null;
          record.generationId = null;
          record.workerPid = null;
          record.leaseCount = 0;
        } catch (error) {
          const failure = normalizeError(error);
          this.counters.disposeFailures += 1;
          this.counters.lastDisposeError = { at: iso(this.clock()), sessionId: record.sessionId, message: failure.message };
          this.#emit('dispose_failed', { sessionId: record.sessionId, reason: 'pool_close', error: failure.message });
        }
      }
    });
  }

  async #acquire(sessionId, options) {
    if (this.#closed) throw new Error('runtime pool is closed');
    const existing = this.#records.get(sessionId);
    if (existing?.handle && !existing.handle.disposed) {
      existing.leaseCount += 1;
      this.#touch(existing);
      try {
        await this.#evictExpired(sessionId);
        // Admission also covers an already-hot runtime, and it must happen *here*:
        // this is the serialized section, so callers keep the acquire order the pool
        // resolved them in. Running it in a caller's own `await` after acquire (as an
        // earlier revision did) lets filesystem latency decide which delivery reaches
        // the runtime first, which reorders same-tick deliveries for one session.
        if (this.admitRuntime) {
          await this.admitRuntime({
            sessionId,
            currentGenerationId: this.currentGenerationId,
            sessionFile: existing.handle.sessionFile ?? null,
            sessionFileBytes: existing.sessionFileBytes,
            hot: true,
            options,
            reclaimMemory: () => this.#evictMemory(),
          });
        }
      } catch (error) {
        existing.leaseCount -= 1;
        throw error;
      }
      return existing.handle;
    }
    if (this.#draining) throw new GenerationDrainingError(sessionId);

    await this.#evictExpired(sessionId);
    await this.#ensureCapacity();
    const now = this.clock();
    const record = existing ?? this.#newRecord(sessionId, now);
    record.runtimeState = 'loading';
    record.lastAccessAt = now;
    if (!existing) this.#records.set(sessionId, record);
    this.#emit('loading', { sessionId });

    try {
      const located = await this.locateSession(sessionId, options);
      const locatedSessionFile = located?.sessionFile ?? null;
      let verified = null;
      if (locatedSessionFile) {
        try {
          verified = await inspectSessionFile(sessionId, locatedSessionFile);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }

      if (this.admitRuntime) {
        await this.admitRuntime({
          sessionId,
          currentGenerationId: this.currentGenerationId,
          sessionFile: verified?.sessionFile ?? locatedSessionFile,
          sessionFileBytes: verified?.size ?? null,
          hot: false,
          options,
          reclaimMemory: () => this.#evictMemory(),
        });
      }

      const prepared = await this.prepareRuntime({
        sessionId,
        currentGenerationId: this.currentGenerationId,
        sessionFile: verified?.sessionFile ?? locatedSessionFile,
        options,
      });
      if (!prepared?.generationId) {
        throw new Error('prepareRuntime must report the generation that will actually be loaded');
      }
      const preparedGenerationId = String(prepared.generationId);
      if (preparedGenerationId === this.currentGenerationId && prepared.cacheCleared !== true) {
        throw new Error('current-generation runtime requires confirmed plugin cache clearing (prepareRuntime must clear pi\'s process-level extension cache, not merely report that it asked for it)');
      }

      const opened = await this.openRuntime({
        sessionId,
        sessionFile: verified?.sessionFile ?? locatedSessionFile,
        generationId: preparedGenerationId,
        cacheCleared: prepared.cacheCleared === true,
        prepared,
        options,
      });
      if (!opened || typeof opened.dispose !== 'function') {
        throw new TypeError('openRuntime must return a runtime adapter with dispose()');
      }
      const actualGenerationId = String(opened.generationId ?? preparedGenerationId);
      if (actualGenerationId !== preparedGenerationId) {
        await opened.dispose('generation_mismatch');
        throw new Error(`runtime generation mismatch: prepared ${preparedGenerationId}, opened ${actualGenerationId}`);
      }
      const handle = new RuntimeHandle({
        sessionId,
        generationId: actualGenerationId,
        workerPid: opened.workerPid ?? this.workerPid,
        runtimeId: opened.runtimeId,
        token: opened.token,
        adapter: opened,
        hooks: this.#handleHooks(record),
      });

      record.handle = handle;
      record.leaseCount = 1;
      record.owner = handle.owner;
      record.runtimeState = 'hotIdle';
      record.generationId = handle.generationId;
      record.runtimeId = handle.runtimeId;
      record.workerPid = handle.workerPid;
      record.logicVersion = opened?.logicVersion ?? this.logicVersion;
      record.codeRevision = opened?.codeRevision ?? this.codeRevision;
      record.loadedAt = opened?.loadedAt ?? this.loadedAt;
      record.settledAt = now;
      record.busyFlags.clear();
      opened.attachHandle?.(handle);
      await this.#refreshPersistence(record, verified);
      if (existing) {
        record.restoreCount += 1;
        this.counters.restore += 1;
        this.#emit('restore', { sessionId, owner: record.owner });
      } else {
        this.#emit('open', { sessionId, owner: record.owner });
      }
      return handle;
    } catch (error) {
      const failedHandle = record.handle;
      if (failedHandle) {
        try {
          await failedHandle.dispose('open_failed');
        } catch (disposeError) {
          const failure = normalizeError(disposeError);
          this.counters.disposeFailures += 1;
          this.counters.lastDisposeError = { at: iso(this.clock()), sessionId, message: failure.message };
          this.#emit('dispose_failed', { sessionId, reason: 'open_failed', error: failure.message });
        }
      }
      if (record.internalKey) this.#internalOwners.delete(record.internalKey);
      record.handle = null;
      record.owner = null;
      record.runtimeState = 'cold';
      if (!existing) this.#records.delete(sessionId);
      this.#emit('open_failed', { sessionId, error: normalizeError(error).message });
      throw error;
    }
  }

  // 「封存」的安全点：**在没有 runtime 持有的窗口里做文件替换**（`docs/design-session-seal.md` §2.2）。
  //
  // 为什么必须是池子提供的一个独占段（而不是调用方自己 evict 完就去写文件）：
  //   · `evict` 之后到 `rename` 之间的那个窗口里，任何一次 `acquire` 都会**重新打开**这个会话的
  //     runtime —— 它拿到的是**替换前**的全量文件，于是替换对它不可见；它下一次 append 把 `parentId`
  //     写成已经不存在的叶 ⇒ 冷读时链在两条处断掉（实测：热读 917 条、冷读 2 条、prompt 630 669 B→2 111 B）。
  //   · `acquire` 与本方法都走同一条 `#serializeOpen` 串行队列 ⇒ 拿在这里 = **先 evict、替换、再放新 acquire 进来**，
  //     窗口里不可能插进一个持有者。
  //
  // 代价/边界：段内调用方拿到的 `operation` 只许做文件/侧车读写 —— 任何再进 `#serializeOpen` 的池方法
  // （acquire / evict / sweep / reclaimIdle / close）都会**自锁**。
  // 返回：`{ ok:false, blockers, facts }` = 收不掉（在跑/有租约/有队列/不 durable）；
  //       `{ ok:true, evicted, value }` = 现在没有持有者，`value` 是 `operation()` 的结果。
  async holdSession(sessionId, operation) {
    validateSessionId(sessionId);
    if (typeof operation !== 'function') throw new TypeError('holdSession needs an operation function');
    return this.#serializeOpen(async () => {
      const record = this.#records.get(sessionId);
      let evicted = false;
      if (record?.handle) {
        const facts = this.#recordsFacts(record, this.clock());
        if (!this.#reclaimableModuloPins(record)) {
          return { ok: false, evicted: false, blockers: this.#reclaimBlockers(record), facts };
        }
        // 有订阅者的 runtime（SSE）也收：替换热文件必须真的让它们断线重连（`onEvent` 的 evict 钩子
        // 会把那一路 SSE 用可重连事件收尾）—— 这是「无 runtime 持有」这条硬门的落地。
        evicted = await this.#evict(record, 'manual', { ignorePins: true });
        if (!evicted) return { ok: false, evicted: false, blockers: this.#reclaimBlockers(record), facts };
      }
      const value = await operation();
      // `evicted:false` 也是一条事实：这一代本来就没有 runtime 持有它（没有东西可收），
      // 与「收掉了」是两件事 —— 收据里不许把它们说成同一件。
      return { ok: true, evicted, value };
    });
  }

  // 这条 hot runtime 现在收不掉的原因：只列事实（运行级 + 池自己的账），不猜。
  #reclaimBlockers(record) {
    const blockers = [];
    if (this.#running(record)) blockers.push('in_flight_turn');
    if (!record.durable) blockers.push('not_durable');
    if (record.pendingMessages > 0) blockers.push('pending_messages');
    if (record.queuedOperations > 0) blockers.push('queued_operations');
    if (record.leaseCount > 0) blockers.push('acquired_leases');
    if (record.busyFlags.size > 0) blockers.push(`busy:${[...record.busyFlags].sort().join('+')}`);
    if (record.pinReasons.size > 0) blockers.push('subscriber_pinned');
    return blockers;
  }

  #recordsFacts(record, now) {
    return {
      sessionId: record.sessionId,
      runtimeState: record.runtimeState,
      durable: record.durable,
      running: this.#running(record),
      runningNow: record.handle?.runningNow?.() ?? null,
      acquiredLeases: record.leaseCount,
      pendingMessages: record.pendingMessages,
      queuedOperations: record.queuedOperations,
      busyFlags: [...record.busyFlags].sort(),
      pinReasons: [...record.pinReasons].sort(),
      idleForMs: this.#idleFor(record, now),
      generationId: record.generationId,
      sessionFileBytes: record.sessionFileBytes,
    };
  }

  async #evictMemory() {
    const now = this.clock();
    const candidates = [...this.#records.values()]
      .filter((record) => this.#eligible(record, now))
      .sort((left, right) => this.#lruTime(left) - this.#lruTime(right));
    let evicted = 0;
    for (const record of candidates) if (await this.#evict(record, 'memory')) evicted += 1;
    return evicted;
  }

  async #evictExpired(exceptSessionId = null) {
    const now = this.clock();
    // While draining, an idle durable session is reclaimable immediately: the
    // worker has already been told it will never serve a new acquire again.
    const expired = [...this.#records.values()]
      .filter((record) => record.sessionId !== exceptSessionId
        && this.#eligible(record, now)
        && (record.generationId !== this.currentGenerationId || this.#draining || this.#idleFor(record, now) >= this.idleTTL))
      .sort((left, right) => this.#lruTime(left) - this.#lruTime(right));
    for (const record of expired) {
      const reason = record.generationId !== this.currentGenerationId ? 'stale_generation' : 'ttl';
      await this.#evict(record, reason);
    }
  }

  // maxHot is a soft target, matching v2.1: reclaim eligible idle runtimes while the
  // pool is at or over it, but never refuse a request because of the count alone. The
  // count is not the bound that matters — memory is. With an admission policy wired
  // (server/base-logic.mjs) the pool may therefore exceed maxHot and the request still
  // has to pass memory admission; only a pool with no admission policy at all falls
  // back to refusing, because then nothing else would bound it.
  async #ensureCapacity() {
    // Production default: no count-based eviction at all. The real bound is memory
    // admission. A numeric maxHot is an explicit opt-in used by deterministic pool tests
    // and deployments that deliberately want an idle-runtime cache target.
    if (this.maxHot === null) return;
    while (this.#hotCount() >= this.maxHot) {
      const now = this.clock();
      const victim = [...this.#records.values()]
        .filter((record) => this.#eligible(record, now))
        .sort((left, right) => this.#lruTime(left) - this.#lruTime(right))[0];
      if (!victim) {
        if (this.admitRuntime) return;
        throw new PoolSaturatedError(this.summary());
      }
      await this.#evict(victim, 'capacity');
    }
  }

  async #evict(record, reason, { ignorePins = false } = {}) {
    // 能不能收，判据是运行级事实（`#idleForReclaim`），不是「池里有这条 hot 记录」。
    if (!record.handle || !this.#idleForReclaim(record)) return false;
    await this.#refreshPersistence(record);
    // `ignorePins` 只有显式回收入口（reclaimIdle({includePinned:true})）会用：订阅者不是「工作」，
    // 但它是活客户端，默认谁也不许替它做决定；自动路（TTL/换代）照旧把 pin 当硬条件。
    const eligible = ignorePins ? this.#reclaimableModuloPins(record) : this.#eligible(record, this.clock());
    if (!eligible) return false;
    const before = this.#snapshot(record);
    const handle = record.handle;
    record.runtimeState = 'evicting';
    this.#emit('evicting', { sessionId: record.sessionId, reason, before });
    try {
      await handle.dispose(reason);
    } catch (error) {
      const failure = normalizeError(error);
      this.counters.disposeFailures += 1;
      this.counters.lastDisposeError = { at: iso(this.clock()), sessionId: record.sessionId, message: failure.message };
      record.runtimeState = 'hotIdle';
      record.pinReasons.add('dispose_failed');
      this.#emit('dispose_failed', { sessionId: record.sessionId, reason, error: failure.message });
      return false;
    }

    if (record.internalKey) this.#internalOwners.delete(record.internalKey);
    record.handle = null;
    record.owner = null;
    record.runtimeState = 'cold';
    record.runtimeId = null;
    record.generationId = null;
    record.workerPid = null;
    record.loadedAt = null;
    record.leaseCount = 0;
    record.pinReasons.clear();
    record.lastEvictedAt = this.clock();
    record.lastEvictionReason = reason;
    this.counters.evict[reason] += 1;
    this.#emit('evict', { sessionId: record.sessionId, reason, before, after: this.#snapshot(record) });
    return true;
  }

  async #refreshPersistence(record, alreadyVerified = null) {
    if (!record.handle) return this.#snapshot(record);
    const sessionFile = record.handle.sessionFile ?? alreadyVerified?.sessionFile ?? null;
    if (!sessionFile) {
      this.#claimInternalKey(record, `pending:${record.sessionId}`);
      record.durable = false;
      return this.#snapshot(record);
    }

    try {
      const verified = await inspectSessionFile(record.sessionId, sessionFile, record.handle.currentLeafId);
      this.#claimInternalKey(record, verified.internalKey);
      record.durable = verified.durable;
      record.sessionFileBytes = verified.size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#claimInternalKey(record, `pending:${record.sessionId}`);
      record.durable = false;
    }
    return this.#snapshot(record);
  }

  #claimInternalKey(record, internalKey) {
    const owner = this.#internalOwners.get(internalKey);
    if (owner && owner !== record.sessionId) {
      throw new Error(`session file already owned by ${owner}: ${internalKey}`);
    }
    if (record.internalKey && record.internalKey !== internalKey) this.#internalOwners.delete(record.internalKey);
    this.#internalOwners.set(internalKey, record.sessionId);
    record.internalKey = internalKey;
  }

  #handleHooks(record) {
    return {
      touch: () => this.#touch(record),
      setActive: (active) => {
        record.runtimeState = active ? 'hotActive' : 'hotIdle';
        this.#touch(record);
      },
      settled: () => {
        record.settledAt = this.clock();
        if (record.runtimeState === 'hotActive') record.runtimeState = 'hotIdle';
        this.#emit('settled', { sessionId: record.sessionId });
        this.#requestSweep(record);
      },
      release: async () => {
        if (record.leaseCount < 1) throw new Error(`runtime handle has no acquired lease: ${record.sessionId}`);
        record.leaseCount -= 1;
        record.settledAt = this.clock();
        this.#touch(record);
        this.#emit('release', { sessionId: record.sessionId, leases: record.leaseCount });
        await this.#serializeOpen(async () => {
          if (record.handle) await this.#refreshPersistence(record);
          await this.#evictExpired();
          if (this.#draining) await this.#forceDisposeNonDurable();
        });
      },
      setPendingMessages: (count) => {
        record.pendingMessages = count;
      },
      setQueuedOperations: (count) => {
        record.queuedOperations = count;
      },
      setBusy: (flag, busy) => {
        if (busy) record.busyFlags.add(flag);
        else record.busyFlags.delete(flag);
      },
      pin: (reason) => record.pinReasons.add(reason),
      unpin: (reason) => {
        record.pinReasons.delete(reason);
        this.#requestSweep(record);
      },
      refreshPersistence: () => this.#refreshPersistence(record),
    };
  }

  #newRecord(sessionId, now) {
    return {
      sessionId,
      internalKey: null,
      runtimeState: 'cold',
      durable: false,
      handle: null,
      owner: null,
      runtimeId: null,
      generationId: null,
      workerPid: null,
      logicVersion: this.logicVersion,
      codeRevision: this.codeRevision,
      loadedAt: null,
      sessionFileBytes: null,
      lastAccessAt: now,
      settledAt: null,
      pinReasons: new Set(),
      busyFlags: new Set(),
      pendingMessages: 0,
      queuedOperations: 0,
      leaseCount: 0,
      restoreCount: 0,
      lastEvictedAt: null,
      lastEvictionReason: null,
    };
  }

  #snapshot(record) {
    const now = this.clock();
    const hot = record.handle !== null;
    const stale = hot && record.generationId !== this.currentGenerationId;
    return {
      sessionId: record.sessionId,
      runtimeState: record.runtimeState,
      durable: record.durable,
      runtimeId: record.runtimeId,
      generationId: record.generationId,
      workerPid: record.workerPid,
      logicVersion: record.logicVersion,
      codeRevision: record.codeRevision,
      loadedAt: record.loadedAt,
      pluginStale: stale,
      logicStale: stale,
      staleReason: stale ? `generation ${record.generationId} is not current ${this.currentGenerationId}` : null,
      lastAccessAt: iso(record.lastAccessAt),
      settledAt: record.settledAt === null ? null : iso(record.settledAt),
      idleForMs: this.#running(record) ? 0 : this.#idleFor(record, now),
      evictionEligible: this.#eligible(record, now),
      pinReasons: [...record.pinReasons].sort(),
      pendingMessages: record.pendingMessages,
      queuedOperations: record.queuedOperations,
      acquiredLeases: record.leaseCount,
      restoreCount: record.restoreCount,
      lastEvictedAt: record.lastEvictedAt === null ? null : iso(record.lastEvictedAt),
      lastEvictionReason: record.lastEvictionReason,
      owner: record.owner ? { ...record.owner } : null,
      internalKey: record.internalKey,
    };
  }

  #eligible(record) {
    return this.#reclaimableModuloPins(record) && record.pinReasons.size === 0;
  }

  // 「这个 runtime 现在算在跑」的判据 = 运行级事实。优先问 runtime 自己（isWorking()：模型
  // 请求在飞 / 压紧 / 重试 / 准入守卫）；它答 false 就是真的没在跑（那些条件它全看得见）。
  // 只有拿不到运行级事实时（脚本 adapter 没有 isWorking）才退回缓存标签——标签由
  // agent_start/agent_settled 维护，正常就等于 isStreaming。宁可少收一条，也不掐在飞回合。
  #running(record) {
    const live = record.handle?.runningNow?.() ?? null;
    if (live !== null) return live;
    return record.runtimeState === 'hotActive';
  }

  // 回收只谈稳定态：loading/evicting 这种过渡态一律不算闲置（也就不算「这一代可以退」）。
  #idleForReclaim(record) {
    if (record.handle === null) return false;
    if (record.runtimeState === 'loading' || record.runtimeState === 'evicting') return false;
    return !this.#running(record);
  }

  // Same as #eligible but ignoring pins: a session that would be reclaimable if nobody
  // were subscribed. Used during drain to separate "busy" from "merely pinned".
  #reclaimableModuloPins(record) {
    return this.#idleForReclaim(record)
      && record.handle !== null
      && record.durable
      && record.pendingMessages === 0
      && record.queuedOperations === 0
      && record.leaseCount === 0
      && record.busyFlags.size === 0;
  }

  #touch(record) {
    record.lastAccessAt = this.clock();
  }

  #idleFor(record, now) {
    const since = Math.max(record.lastAccessAt, record.settledAt ?? 0);
    return Math.max(0, now - since);
  }

  #lruTime(record) {
    return Math.max(record.lastAccessAt, record.settledAt ?? 0);
  }

  #hotCount() {
    return [...this.#records.values()].filter((record) => record.handle !== null).length;
  }

  #serializeOpen(operation) {
    const result = this.#openQueue.then(operation, operation);
    this.#openQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  #requestSweep(record) {
    queueMicrotask(() => {
      this.#serializeOpen(async () => {
        if (record.handle && record.runtimeState === 'hotIdle') await this.#refreshPersistence(record);
        await this.#evictExpired();
        if (this.#draining) await this.#forceDisposeNonDurable();
      }).catch((error) => this.#emit('sweep_error', { sessionId: record.sessionId, error: normalizeError(error).message }));
    });
  }

  #emit(event, details) {
    const value = { seq: ++this.#eventSequence, at: iso(this.clock()), event, ...details };
    this.#events.push(value);
    if (this.#events.length > 5000) this.#events.shift();
    this.onEvent?.(structuredClone(value));
  }
}

export function poolConfigFromEnv(env = process.env) {
  const rawMaxHot = env.SOPHO_MAX_HOT;
  const disabled = rawMaxHot === undefined || rawMaxHot === '' || /^(?:off|none|null|unlimited)$/i.test(rawMaxHot);
  const maxHot = disabled ? null : Number(rawMaxHot);
  const idleTTL = Number(env.SOPHO_IDLE_TTL_MS ?? 15 * 60 * 1000);
  if (maxHot !== null && (!Number.isInteger(maxHot) || maxHot < 1)) throw new Error(`invalid SOPHO_MAX_HOT: ${rawMaxHot}`);
  if (!Number.isFinite(idleTTL) || idleTTL < 0) throw new Error(`invalid SOPHO_IDLE_TTL_MS: ${env.SOPHO_IDLE_TTL_MS}`);
  return { maxHot, idleTTL };
}
