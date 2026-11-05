// S1b: the stable host. This process keeps its pid for the lifetime of the
// deployment; the logic layer (pi runtime pool, session/tree HTTP surface) lives
// in replaceable generation workers (docs/design-runtime-isolation.md §3).
//
// `POST /reload-code` starts a new worker, waits until it is ready, then switches
// the current generation atomically. The previous worker keeps serving only the
// sessions it already owns, is told to stop handing out new ones, and exits once
// its pool has settled and drained. At most two generations exist at any time.
import { execFile, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const host = process.env.SOPHO_HOST || '127.0.0.1';
const rawPort = process.env.SOPHO_PORT || '7331';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`invalid SOPHO_PORT: ${rawPort}`);
}

const MAX_GENERATIONS = 2;
const RELOAD_DRAIN_GRACE_MS = Number.isFinite(Number(process.env.SOPHO_RELOAD_DRAIN_GRACE_MS))
  ? Math.max(0, Number(process.env.SOPHO_RELOAD_DRAIN_GRACE_MS))
  : 3000;
// How long a draining generation may take to finish its in-flight turns before the host
// is allowed to tear it down. Default null = wait for the worker's own lifecycle: a worker
// that still has a turn in flight is *supposed* to keep serving it (the design says
// "active 会话留旧 worker 跑完"), and killing it destroys that turn's reply. The worker
// exits on its own the moment it has no busy session (idle SSE subscribers do not count),
// so normally a reload is fast; only a real in-flight turn keeps it alive, and we let it
// finish. A genuinely stuck generation is surfaced by the worker's own
// `worker_drain_stuck` log and by `/host` draining facts, not by silently killing it.
// Set SOPHO_RELOAD_DRAIN_KILL_MS to opt into a bounded teardown (e.g. for an automated
// reload loop that would rather drop a stuck turn than stay blocked).
const RELOAD_DRAIN_KILL_MS = Number.isFinite(Number(process.env.SOPHO_RELOAD_DRAIN_KILL_MS))
  ? Math.max(1000, Number(process.env.SOPHO_RELOAD_DRAIN_KILL_MS))
  : null;
// During host shutdown we must fit inside `bin/stop.sh`'s own bounded wait, so a stuck
// generation cannot hold the process open: host shutdown is bounded even though reload
// is not (a host restart takes the whole process tree down anyway).
const SHUTDOWN_DRAIN_KILL_MS = Number.isFinite(Number(process.env.SOPHO_SHUTDOWN_DRAIN_KILL_MS))
  ? Math.max(1000, Number(process.env.SOPHO_SHUTDOWN_DRAIN_KILL_MS))
  : 10_000;
const startedAt = new Date();
const startupSequence = Date.now();
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || process.env.ASSIST_HOME || process.env.SOPHO_AGENT_DIR || path.join(process.env.HOME || process.cwd(), '.pi', 'agent'));
const workerEntry = path.join(rootDir, 'server', 'worker.mjs');
const seenFile = path.join(agentDir, 'seen.json');
const settledFile = path.join(agentDir, 'settled.json');
const draftsFile = path.join(agentDir, 'drafts.json');
const DRAFT_MAX_BYTES = 64 * 1024;
const codeRevision = await repositoryRevision(rootDir);
const rawWorkerOldSpaceMiB = process.env.SOPHO_WORKER_OLD_SPACE_MIB;
const workerOldSpaceMiB = rawWorkerOldSpaceMiB === undefined ? null : Number(rawWorkerOldSpaceMiB);
if (workerOldSpaceMiB !== null && (!Number.isInteger(workerOldSpaceMiB) || workerOldSpaceMiB < 64)) {
  throw new Error(`invalid SOPHO_WORKER_OLD_SPACE_MIB: ${rawWorkerOldSpaceMiB}`);
}

/** @type {Map<string, {generationId: string, pid: number, port: number, token: string, logicVersion: string, codeRevision: string|null, state: 'current'|'draining'|'exited', startedAt: string, drainingAt: string|null, exitedAt: string|null, child: import('node:child_process').ChildProcess|null, exitReason: string|null}>} */
const workers = new Map();
// Session -> owning generation. The host writes this table from worker route
// reports; it is the only place that decides which process owns a session's file.
const sessionOwners = new Map();
// child/target -> registrations waiting to wake a watcher after the target has
// remained settled for a full quiet window. Parentage itself is never stored
// here: push derives it from the child's session header.
const notifyRegistrations = new Map();
let currentGenerationId = null;
let generationSequence = 0;
let reloadQueue = Promise.resolve();
let delegationQueue = Promise.resolve();
let lastReload = { at: startedAt.toISOString(), durationMs: null, ok: null, previousLogicVersion: null, logicVersion: null, error: null };
let unreadWriteQueue = Promise.resolve();
let unreadStoreError = null;
let draftWriteQueue = Promise.resolve();
let draftStoreError = null;

// 会话状态的三个口径（与 logic 层 `STATUS_LABELS` 同形）：`/tree` 的行只用这三种。
const STATUS_LABELS = { working: '工作中', unread: '未读', idle: '闲置' };

function validTimestamp(value) {
  return Number.isFinite(value) && value > 1e12;
}

async function readTimestampMap(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw new Error(`cannot read unread sidecar ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let value;
  try {
    value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch (error) {
    throw new Error(`invalid unread sidecar ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid unread sidecar ${file}: expected an object`);
  const result = new Map();
  for (const [id, at] of Object.entries(value)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !validTimestamp(at)) {
      throw new Error(`invalid unread sidecar ${file}: ${JSON.stringify(id)} must map to a millisecond timestamp`);
    }
    result.set(id.toLowerCase(), at);
  }
  return result;
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

function draftStoreFailure(message, cause) {
  return new Error(`${message} ${draftsFile}: ${cause instanceof Error ? cause.message : String(cause)}`);
}

async function readDraftMap() {
  let text;
  try {
    text = await readFile(draftsFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw draftStoreFailure('cannot read draft sidecar', error);
  }
  let value;
  try {
    value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch (error) {
    throw draftStoreFailure('invalid draft sidecar', error);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw draftStoreFailure('invalid draft sidecar', new Error('expected an object'));
  const result = new Map();
  for (const [id, draft] of Object.entries(value)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      || !draft || typeof draft !== 'object' || Array.isArray(draft)
      || typeof draft.text !== 'string' || !validTimestamp(draft.at)
      || Buffer.byteLength(draft.text, 'utf8') > DRAFT_MAX_BYTES) {
      throw draftStoreFailure('invalid draft sidecar', new Error(`${JSON.stringify(id)} must map to { text, at } with text at most ${DRAFT_MAX_BYTES} UTF-8 bytes`));
    }
    result.set(id.toLowerCase(), { text: draft.text, at: draft.at });
  }
  return result;
}

const seenAtBySession = await readTimestampMap(seenFile);
const settledAtBySession = await readTimestampMap(settledFile);
await readDraftMap();

function timestampObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function queueUnreadWrite(file, map) {
  const operation = unreadWriteQueue.then(() => atomicWriteJson(file, timestampObject(map)));
  unreadWriteQueue = operation.catch((error) => {
    unreadStoreError = error instanceof Error ? error : new Error(String(error));
    console.error(`[base] unread sidecar write failed: ${unreadStoreError.message}`);
  });
  return operation;
}

function assertUnreadStoreHealthy() {
  if (unreadStoreError) throw Object.assign(new Error(`unread state is unavailable: ${unreadStoreError.message}`), { statusCode: 500, code: 'unread_store_failed' });
}

function assertDraftStoreHealthy() {
  if (draftStoreError) throw Object.assign(new Error(`draft state is unavailable: ${draftStoreError.message}`), { statusCode: 500, code: 'draft_store_failed' });
}

function draftObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function queueDraftOperation(operation) {
  const next = draftWriteQueue.then(async () => {
    assertDraftStoreHealthy();
    try {
      return await operation();
    } catch (error) {
      draftStoreError = error instanceof Error ? error : new Error(String(error));
      console.error(`[base] draft sidecar failed: ${draftStoreError.message}`);
      throw draftStoreError;
    }
  });
  draftWriteQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function readDraft(sessionId) {
  return queueDraftOperation(async () => (await readDraftMap()).get(sessionId) ?? { text: '', at: null });
}

async function writeDraft(sessionId, text) {
  const actualBytes = Buffer.byteLength(text, 'utf8');
  if (actualBytes > DRAFT_MAX_BYTES) {
    throw Object.assign(new Error(`draft exceeds the ${DRAFT_MAX_BYTES} byte UTF-8 limit (${actualBytes} bytes)`), {
      statusCode: 413,
      code: 'draft_too_large',
      details: { maxBytes: DRAFT_MAX_BYTES, actualBytes },
    });
  }
  return queueDraftOperation(async () => {
    const drafts = await readDraftMap();
    if (text === '') drafts.delete(sessionId);
    else drafts.set(sessionId, { text, at: Date.now() });
    await atomicWriteJson(draftsFile, draftObject(drafts));
    return drafts.get(sessionId) ?? { text: '', at: null };
  });
}

function recordSettled(sessionId) {
  const settledAt = Date.now();
  settledAtBySession.set(sessionId, settledAt);
  void queueUnreadWrite(settledFile, settledAtBySession).catch(() => {});
  return settledAt;
}

async function recordSeen(sessionId) {
  assertUnreadStoreHealthy();
  const seenAt = Date.now();
  seenAtBySession.set(sessionId, seenAt);
  await queueUnreadWrite(seenFile, seenAtBySession);
  assertUnreadStoreHealthy();
  return seenAt;
}

function decorateUnreadTree(tree) {
  assertUnreadStoreHealthy();
  const sessions = Array.isArray(tree.sessions) ? tree.sessions : [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const hiddenByArchive = (session) => {
    const visited = new Set([session.id]);
    let parent = session.parentId ? byId.get(session.parentId) : null;
    while (parent && !visited.has(parent.id)) {
      if (parent.archived) return true;
      visited.add(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : null;
    }
    return false;
  };
  const decorated = sessions.map((session) => {
    const settledAt = settledAtBySession.get(session.id) ?? null;
    const seenAt = seenAtBySession.get(session.id) ?? null;
    const unread = session.archived !== true && (settledAt ?? 0) > (seenAt ?? 0);
    const working = session.status === 'working';
    return {
      ...session,
      seenAt,
      settledAt,
      unread,
      hiddenByArchive: hiddenByArchive(session),
      status: working ? 'working' : unread ? 'unread' : 'idle',
      statusLabel: working ? STATUS_LABELS.working : unread ? STATUS_LABELS.unread : STATUS_LABELS.idle,
    };
  });
  const visibleUnread = decorated
    .filter((session) => session.unread && !session.hiddenByArchive)
    .sort((left, right) => (left.settledAt ?? 0) - (right.settledAt ?? 0) || left.id.localeCompare(right.id));
  const oldest = visibleUnread[0] ?? null;
  return {
    ...tree,
    sessions: decorated,
    unread: {
      count: visibleUnread.length,
      oldestId: oldest?.id ?? null,
      oldestName: oldest?.name ?? null,
      oldestAt: oldest?.settledAt ?? null,
    },
  };
}

// `/tree` 的「在跑」事实住在**持有它 runtime 的那一代**里。切代际的窗口里那不是当前代：
// 当前代 worker 的 `/tree` 是**扫盘**出来的底（会话文件里的事实），它的 "working" 只覆盖
// **自己池子**里的 runtime（base-logic 的 treeRecords 走 `pool.listSessions()`）——
// 停在旧代（draining generation）上的会话于是落到盘上的默认值 idle/unread，
// 明明在跑，树里却显示「闲置」。宿主是唯一知道「还有哪几代活着」的一层，
// 所以由宿主把这些会话的真实状态补回投影。
//
// 只问 **draining** 代：当前代的在跑事实它自己的 `/tree` 已经带出来了（不重复问，
// `/tree` 是前端轮询的热路径）。代际上限是 2，所以这里最多一次 IPC，而且与取树并发跑。
// 某一代答不上来（超时/已退出）时**如实**记日志并跳过：`/tree` 不该因此变成 500，
// 但也绝不假装知道它在不在跑（不确定就不抬，不猜）。
// ⚠️ 这条路的**自己的**短死线：问 draining 代要 live-facts 是**装饰**（把「真的在跑」的行抬成 working），
// 而 draining 代可能正忙（在跑的回合收不掉：`POST /reclaim` 按设计不收 in_flight_turn）⇒ 用 5s 的通用
// 死线就会让 `/tree` 每次贴到宿主那条 5000ms 死线上（赢一点点 200 / 输一点点 500，且「到点回部分视图」
// 在这条路径上根本来不及生效）。所以给它一条**短的**（旋钮，默认 400ms）：到点就**如实降级**，
// 不许把「未知」伪造成「没有在跑的会话」。
const DRAINING_FACTS_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.SOPHO_DRAINING_FACTS_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 400;
})();

// 上一次**成功**问到的在跑集合，按代记（该代退出时在 `child.once('exit')` 里 `delete`）。到点降级时
// **保留**上一次已知的 overlay 并标 stale —— 理由与后果都写在报告里：两害相权，宁可「刚结束的回合短暂
// 显示成在跑」（working 只可能由事实抬起、从不反向降级，与既有语义一致），也**绝不**把「未知」显示成
// 「没有在跑」。
const drainingRunningCache = new Map();

// 返回 `{ running, degraded }` **一起交回**，不放进模块级单值：两个并发 `/tree` 各自读自己那一份
// 「这一代答没答上」，不会互相把降级事实抹掉（F8）。
// ⚠️ 只有 `/tree` 用它（不是 `/host`）；没有降级时 `degraded === null`。
async function drainingRunningSessionIds() {
  const running = new Set();
  let degraded = null;
  for (const worker of drainingWorkers()) {
    // 通道已经断了的（正在退出 / 已经退出但 'exit' 事件还没到）就不必再发了：
    // 发了也是 EPIPE（下面 callWorker 的 callback 会把它当诚实失败报出来，但何必多一次）。
    if (!worker.child?.connected) continue;
    try {
      const reply = await callWorker(worker, { type: 'live-facts' }, { timeoutMs: DRAINING_FACTS_TIMEOUT_MS });
      for (const fact of reply.facts ?? []) if (fact.running === true) running.add(fact.id);
      const unavailable = Array.isArray(reply.unavailable) ? reply.unavailable : [];
      if (unavailable.length > 0) {
        // 这一代**答上来了**，但某几个 handle 的当下事实到点没取到（worker 侧的 per-handle 死线）：
        // 一样如实降级，并把「上一次已知」里这几条兜回来（宁可疑在跑，也绝不报成没在跑）。
        degraded = { status: 'handle_timeout', generationId: worker.generationId, unavailable: unavailable.map((entry) => entry.sessionId) };
        const previous = drainingRunningCache.get(worker.generationId) ?? new Set();
        for (const entry of unavailable) if (previous.has(entry.sessionId)) running.add(entry.sessionId);
      }
      drainingRunningCache.set(worker.generationId, new Set(running));
    } catch (error) {
      // 到点（或这一代答不上来）⇒ **如实降级**并标注；用上一次已知的 overlay 兜住（stale），
      // 而不是假装「这一代上没有在跑的会话」。
      degraded = { status: 'timeout', timeoutMs: DRAINING_FACTS_TIMEOUT_MS, generationId: worker.generationId };
      for (const id of drainingRunningCache.get(worker.generationId) ?? []) running.add(id);
      console.error(`[host] worker ${worker.generationId} live-facts did not answer in ${DRAINING_FACTS_TIMEOUT_MS}ms while decorating /tree: ${error instanceof Error ? error.message : String(error)}; marking the working overlay as degraded (stale) instead of pretending nothing is running`);
    }
  }
  return { running, degraded };
}

// 只做一件事：把**真的在跑**（由持有它 runtime 的那一代报出，`adapter.isWorking()`）而树里
// 还是 idle/unread 的行抬成 working。绝不反向降级（working 只可能来自事实）、不猜、
// 不新增/删除行 —— `/tree` 的响应形状（字段名与行集合）保持不变，前端照旧按
// status/statusLabel 画「在跑」记号。运行事实是异步取的，会有极短窗口（回合刚好这一刻开始），
// 那种情况下报的仍是盘上的诚实值，不是编的。
function overlayWorkingStatus(sessions, runningIds) {
  if (runningIds.size === 0) return sessions;
  return sessions.map((session) => (session.status === 'working' || !runningIds.has(session.id)
    ? session
    : { ...session, status: 'working', statusLabel: STATUS_LABELS.working }));
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  if (response.destroyed || response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

async function repositoryRevision(directory) {
  const candidates = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (/\.(mjs|js|ts|json|html|css)$/.test(entry.name)) candidates.push(target);
    }
  }
  for (const name of ['server', 'pi-extensions', 'web']) await visit(path.join(directory, name));
  const hash = createHash('sha256');
  let covered = 0;
  for (const file of candidates.sort()) {
    try {
      hash.update(path.relative(directory, file));
      hash.update(await readFile(file));
      covered += 1;
    } catch {
      // A file that disappeared between listing and reading is reported by its absence.
    }
  }
  return { revision: `sha256:${hash.digest('hex')}`, covered, files: candidates.length };
}

function currentWorker() {
  return currentGenerationId === null ? null : workers.get(currentGenerationId) ?? null;
}

function drainingWorkers() {
  return [...workers.values()].filter((worker) => worker.state === 'draining');
}

function generationLimitReached() {
  return workers.size >= MAX_GENERATIONS;
}

async function startWorker(reason) {
  generationSequence += 1;
  const generationId = `g-${startupSequence}-${generationSequence}`;
  const token = createHash('sha256').update(`${process.pid}:${generationId}:${reason}`).digest('hex');
  const child = fork(workerEntry, [], {
    cwd: rootDir,
    ...(workerOldSpaceMiB === null ? {} : { execArgv: [...process.execArgv.filter((arg) => !arg.startsWith('--max-old-space-size=')), `--max-old-space-size=${workerOldSpaceMiB}`] }),
    env: {
      ...process.env,
      SOPHO_WORKER_TOKEN: token,
      SOPHO_WORKER_GENERATION: generationId,
      SOPHO_WORKER_LOGIC_VERSION: generationId,
      SOPHO_WORKER_CODE_REVISION: codeRevision.revision,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const record = {
    generationId,
    pid: child.pid,
    port: null,
    token,
    logicVersion: generationId,
    codeRevision: codeRevision.revision,
    state: 'starting',
    startedAt: new Date().toISOString(),
    drainingAt: null,
    exitedAt: null,
    exitReason: null,
    selfGenerationId: null,
    child,
  };
  workers.set(generationId, record);

  child.stdout?.on('data', (chunk) => process.stdout.write(`[worker ${generationId}] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[worker ${generationId}] ${chunk}`));

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker ${generationId} did not become ready in 30000ms`)), 30_000);
    timer.unref?.();
    const onMessage = (message) => {
      if (!message || message.type !== 'ready' || message.generationId !== generationId) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      record.port = message.port;
      record.logicVersion = message.logicVersion;
      record.codeRevision = message.codeRevision ?? record.codeRevision;
      resolve(record);
    };
    child.on('message', onMessage);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`worker ${generationId} exited before ready (code=${code} signal=${signal})`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.generationId !== undefined && message.generationId !== generationId) return;
    if (message.type === 'owner') {
      if (message.phase === 'hot') sessionOwners.set(message.sessionId, generationId);
      else if (sessionOwners.get(message.sessionId) === generationId) sessionOwners.delete(message.sessionId);
      return;
    }
    if (message.type === 'lifecycle') {
      noteNotifyLifecycle(message.sessionId, message.phase);
      return;
    }
    if (message.type === 'error') console.error(`[host] worker ${generationId} reported: ${message.message}`);
  });

  // ⚠️ **常驻**的 'error' 监听（不是 `once`）。为什么必须有它：worker 退出时它的 IPC 通道会被关掉，
  // 而那一刻 `child.send()` 会**异步**以 EPIPE 收场（同步那份被 try/catch 挡住了，异步这份不会）。
  // Node 对**没有监听者的 'error' 事件**的处理是**终止进程** —— 宿主一死，整个实例（所有会话）就没了。
  // 这条路径真实可达：`/tree` 每次都会给 draining 代发一条 live-facts（`drainingRunningSessionIds`），
  // 而「子进程的通道已经关了、'exit' 事件还没到」那个窗口正好夹在中间；并发多个 `/tree` 时有多个 send
  // 同时落在窗口里 ⇒ 第 2 个 'error' 就没人接了（原来只有 startWorker 里那个 `once('error')`）。
  // 现在：**任何时刻**的 send/spawn 失败都只是记一条日志，绝不会变成宿主退出。
  // （`callWorker` 那个 send 另有 callback 把失败交回调用方 —— 那一条更精确，这一条是兜底。）
  child.on('error', (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[host] worker ${generationId} process error (IPC/spawn, ignored): ${detail}`);
  });

  child.once('exit', (code, signal) => {
    record.state = 'exited';
    record.exitedAt = new Date().toISOString();
    record.exitReason = signal ? `signal ${signal}` : `code ${code}`;
    record.child = null;
    for (const [sessionId, owner] of sessionOwners) {
      if (owner === generationId) sessionOwners.delete(sessionId);
    }
    // 这一代没了 ⇒ 它那条 stale overlay 也不该留着（留着就是死条目；注释里承诺的「代退出时清」
    // 就是这里 —— F3：原来只承诺没做）。
    drainingRunningCache.delete(generationId);
    if (currentGenerationId === generationId) {
      // The current worker is gone. Its pid is the fact; do not pretend sessions still run.
      console.error(`[host] current worker ${generationId} (pid ${record.pid}) exited: ${record.exitReason}`);
      currentGenerationId = null;
      workers.delete(generationId);
      scheduleRecovery(record);
      return;
    }
    workers.delete(generationId);
  });

  try {
    await ready;
  } catch (error) {
    // A worker that never became usable must not hold a generation slot.
    record.child = null;
    workers.delete(generationId);
    throw error;
  }
  return record;
}

let recovery = null;

function scheduleRecovery(lost) {
  if (shuttingDown) return;
  // One replacement at a time: a burst of exits must not spawn several generations.
  recovery ??= recoverFromWorkerLoss(lost)
    .catch((error) => console.error(`[host] worker recovery failed: ${error.message}`))
    .finally(() => { recovery = null; });
}

async function recoverFromWorkerLoss(lost) {
  // Best effort: bring up a replacement generation so the host keeps serving. A
  // session that was only in the lost process is cold again by fact, not silently
  // kept hot somewhere else.
  if (shuttingDown) return;
  console.error(`[host] replacing lost generation ${lost.generationId}`);
  const replacement = await startWorker(`recovery-after-${lost.generationId}`);
  replacement.state = 'current';
  currentGenerationId = replacement.generationId;
}

async function callWorker(worker, message, { timeoutMs = 15_000 } = {}) {
  if (!worker?.child) throw new Error(`worker ${worker?.generationId ?? 'unknown'} is not running`);
  const requestId = `${process.pid}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    let timer;
    let child;
    const done = (settle, value) => {
      clearTimeout(timer);
      child?.off('message', onMessage);
      child?.off('exit', onExit);
      settle(value);
    };
    const onExit = () => done(reject, new Error(`worker ${worker.generationId} exited before answering ${message.type}`));
    const onMessage = (reply) => {
      if (!reply || reply.requestId !== requestId) return;
      if (reply.type === 'error') {
        const error = new Error(reply.message || `worker ${worker.generationId} request failed`);
        error.statusCode = reply.statusCode;
        error.code = reply.code;
        error.details = reply.details;
        done(reject, error);
        return;
      }
      done(resolve, reply);
    };
    timer = setTimeout(() => done(reject, new Error(`worker ${worker.generationId} did not answer ${message.type} in ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    child = worker.child;
    child.on('message', onMessage);
    child.once('exit', onExit);
    try {
      // ⚠️ **带 callback**：通道已经关掉时，`send()` 的失败（EPIPE）会走 callback —— 既不会变成
      // 没有监听者的 'error' 事件（那会让**宿主进程退出**），又能把失败**当这次调用的诚实失败**报给
      // 调用方（下面那些调用方 —— /tree 的 draining 探测、sessionRoute、drain —— 本来都处理 rejection）。
      child.send({ ...message, requestId }, (error) => {
        if (error) done(reject, error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      done(reject, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function waitForExit(worker, timeoutMs) {
  if (!worker.child) return true;
  const child = worker.child;
  // null = no timer: wait for the worker to decide for itself (its own graceful drain
  // lifecycle). A draining worker that still has an in-flight turn must not be killed on
  // a stopwatch, because that is exactly how the reply was lost. The exit listener is
  // removed when the timer wins: a blocked reload polls this path, and a leaked `once`
  // listener per poll is how a reader process ends up with 11 exit listeners and a
  // MaxListenersExceededWarning in the middle of an honest log.
  return new Promise((resolve) => {
    let timer = null;
    const onExit = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
    if (timeoutMs === null) return;
    timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
  });
}

async function drainWorker(worker, nextGenerationId = null, { terminateAfterMs = RELOAD_DRAIN_KILL_MS } = {}) {
  worker.state = 'draining';
  worker.drainingAt = new Date().toISOString();
  try {
    // The worker stops opening new sessions and evicts the hot sessions that belong
    // to the previous generation; it keeps serving sessions it still owns. A worker
    // with no live runtimes may exit before the ack is processed, which is success.
    await callWorker(worker, { type: 'drain', currentGenerationId: nextGenerationId }, { timeoutMs: 30_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/exited before answering/.test(message)) console.error(`[host] worker ${worker.generationId} drain failed: ${message}`);
  }
  // Wait for the worker to exit on its own. It does so as soon as no session is busy
  // (an idle session held open by an SSE subscriber does not count), so a normal reload
  // is fast; only a real in-flight turn keeps it alive, and we let that finish. The long
  // bound is a last resort for a genuinely stuck generation.
  await waitForExit(worker, terminateAfterMs);
  if (worker.child) {
    console.error(`[host] worker ${worker.generationId} still running after drain; asking it to shut down`);
    try { worker.child.send({ type: 'shutdown' }); } catch {}
    if (!await waitForExit(worker, 10_000)) {
      console.error(`[host] terminating worker ${worker.generationId} (pid ${worker.pid}) after drain timeout`);
      worker.child.kill('SIGTERM');
      await waitForExit(worker, 5000);
    }
  }
  return worker.state === 'exited';
}

// Wait for every draining worker to exit, up to timeoutMs. Returns true when none
// are left. This is the bounded grace period before a reload is refused.
async function waitForDrainingToExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (drainingWorkers().length > 0) {
    if (Date.now() >= deadline) return false;
    const pending = drainingWorkers().map((worker) => waitForExit(worker, Math.max(50, deadline - Date.now())));
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 100))]);
  }
  return true;
}

async function reloadCode() {
  const started = Date.now();
  let previous = currentWorker();
  const previousLogicVersion = previous?.logicVersion ?? null;

  if (generationLimitReached()) {
    // The previous generation may still be draining because it is reclaiming its
    // sessions. Give it a bounded grace period to finish before refusing: a burst of
    // reloads must not silently grow the process count, and a refused reload must not
    // manufacture a third generation either.
    const idle = await waitForDrainingToExit(RELOAD_DRAIN_GRACE_MS);
    if (idle) previous = currentWorker();
  }

  if (generationLimitReached()) {
    const blocking = drainingWorkers();
    // 409 必须自己说清楚「挡着的到底是谁、为什么」：逐代问一次 worker 自己的排空事实
    // （有 3 s 上限；问不到就如实记 null，不编）。旧口径只给会话名单，运维只能猜。
    const blockingFacts = await Promise.all(blocking.map(async (worker) => {
      const status = await workerStatus(worker);
      return {
        blockers: status?.drain?.blockers ?? null,
        drainFactsError: typeof status?.error === 'string' ? status.error : null,
      };
    }));
    const failure = new Error('reload blocked by draining generation');
    failure.statusCode = 409;
    failure.code = 'reload_blocked_by_draining_generation';
    failure.details = {
      currentGenerationId,
      drainGraceMs: RELOAD_DRAIN_GRACE_MS,
      drainingGenerations: blocking.map((worker, index) => ({
        generationId: worker.generationId,
        pid: worker.pid,
        startedAt: worker.startedAt,
        drainingAt: worker.drainingAt,
        hotSessions: [...sessionOwners.entries()].filter(([, owner]) => owner === worker.generationId).map(([sessionId]) => sessionId),
        blockers: blockingFacts[index].blockers,
        drainFactsError: blockingFacts[index].drainFactsError,
      })),
      hint: 'POST /reclaim {"dryRun":true} 看每个代收不了谁、为什么；闲置 runtime 会被 POST /reclaim 收掉，在跑的回合不收（等它跑完，或在会话里停掉它）。',
    };
    lastReload = { at: new Date().toISOString(), durationMs: Date.now() - started, ok: false, previousLogicVersion, logicVersion: previousLogicVersion, error: failure.code };
    throw failure;
  }

  // Start and verify the replacement before switching anything: a broken new
  // generation must leave the current one exactly as it was.
  const next = await startWorker('reload');
  if (previous) {
    // Mark the old worker draining and (in the background) tell it to stop taking
    // new sessions. Waiting for its sessions to settle here is exactly what would
    // make the switch unbounded; the drain runs concurrently instead.
    previous.state = 'draining';
    previous.drainingAt = new Date().toISOString();
    void drainWorker(previous, next.generationId);
  }
  next.state = 'current';
  currentGenerationId = next.generationId;

  lastReload = {
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    ok: true,
    previousLogicVersion,
    logicVersion: next.logicVersion,
    error: null,
  };
  return { previousLogicVersion, logicVersion: next.logicVersion, generationId: next.generationId, pid: next.pid };
}

// Reloads are serialized: two concurrent POSTs must not race the generation limit.
function queueReload(operation) {
  const next = reloadQueue.then(operation, operation);
  reloadQueue = next.then(() => undefined, () => undefined);
  return next;
}

function queueDelegation(operation) {
  const next = delegationQueue.then(operation, operation);
  delegationQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function workerStatus(worker) {
  if (!worker || !worker.child) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${worker.port}/host`, {
      headers: { 'x-sopho-worker-token': worker.token },
      signal: AbortSignal.timeout(3000),
    });
    const value = await response.json();
    if (typeof value?.currentGenerationId === 'string') worker.selfGenerationId = value.currentGenerationId;
    return value;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function registerNotify(targetSessionId, watcherSessionId) {
  let watchers = notifyRegistrations.get(targetSessionId);
  if (!watchers) {
    watchers = new Map();
    notifyRegistrations.set(targetSessionId, watchers);
  }
  const previous = watchers.get(watcherSessionId);
  if (previous?.timer) clearTimeout(previous.timer);
  if (previous?.staleTimer) clearTimeout(previous.staleTimer);
  const registeredAt = new Date().toISOString();
  const record = {
    targetSessionId,
    watcherSessionId,
    quietMs: NOTIFY_QUIET_MS,
    staleMs: NOTIFY_STALE_MS,
    registeredAt,
    settledAt: null,
    dueAt: null,
    staleAt: null,
    // 「上次观察到进展」的基线（见 `armStaleWatchdog`）。**不是** `registeredAt` 的别名 ——
    // 会话的 start/settled、以及轮询时看到会话文件有新内容，都会把它推到此刻。看门狗按它计时。
    progressAt: registeredAt,
    // 上一次看到的会话文件形状 `{mtimeMs, size}`；`null` = 还没观测过（第一次观测只立基线）。
    progressMark: null,
    // 当前这段「没有新动静」里已经喊过几次（有新内容/新回合时归零）。`staleAt` 则是登记期间
    // 累计的「最近一次喊过」——落定时用它如实追加一句「先前报过」。
    staleWakes: 0,
    // 轮询间隔：比阈值细一档，这样「满一个 staleMs」的提醒不会整整晚一个阈值才到。
    pollMs: NOTIFY_STALE_MS === null ? null : Math.max(50, Math.floor(NOTIFY_STALE_MS / 10)),
    state: 'waiting_for_settle',
    timer: null,
    staleTimer: null,
    error: null,
  };
  watchers.set(watcherSessionId, record);
  armStaleWatchdog(record);
}

// 静默看门狗（`SOPHO_NOTIFY_STALE_MS`，默认 10 分钟）：登记之后目标**一直没落定**时，按「**多久没有进展**」
// 反复给 watcher 发**如实**的唤醒消息，并把这条登记在 `/tree` 上标成 `state:"stale"`（带 `staleForMs`）
// —— 这样「它静默多久了」不再只存在于人的记忆里，不必点开会话、不必靠人追问。
//
// 为什么要有它（一手）：2026-10-09 一条登记 19:15:21 起等落定、20:36 才落定 —— 中间 81 分钟树上没有任何
// 信号，业主只好亲自问「卡住了吗？」（`docs/plans/diagnosis-2026-10-09-subagent-management.md` §3③）。
//
// ⚠️ 2026-10-30 重做（一手：子会话 798f25d9 单回合跑 13.5 分钟，02:15:15 喊了一次，02:18:51 落定后
// **没有任何落定通知**）。旧版两条硬缺陷：①落定时若已经喊过 stale 就直接抹掉登记、**吞掉落定唤醒**；
// ②计时从 `registeredAt` 起算、且只喊一次 —— 「一次工具调用占用很久」与「从登记起过了很久」是两件事，
// 而卡在 20 分钟时也不再有第二次提醒。现在的语义：
//
//   · 计时基准 = **上次观察到进展**（`progressAt`），不是登记时刻；
//   · 只在目标**确实有在飞的回合**（`live-facts` 的 `running`）时才算数 —— 纯闲置等用户不是「卡住」；
//   · 进展 = 会话生命周期 start/settled 重置基线，或轮询时看到会话文件有新内容（mtime/size 变了）。
//     **一次长时间的工具调用本来就不写盘 ⇒ 正确地计为「没有进展」**；
//   · 每满一个 `staleMs` 且期间无进展就喊一次（第 1、2、3…次），喊完继续武装 ⇒ 卡 10 分钟喊一次、
//     20 分钟再喊一次；
//   · 落定**永远**会走 20 s 静默窗并投递一次唤醒（哪怕先前已经喊过 stale —— 那时文本如实追加一句
//     「（先前报过仍未落定）」后接「已落定」）；落定**不**撤销看门狗（见 `noteNotifyLifecycle` 那段
//     的注释：喊不喊由 `running` 这个事实判，而登记被清掉时定时器一定被 `clearTimeout`）。
//
// 语义边界（不许越界）：它**不改**既有 20 s 静默窗的语义、不判「失败」、不伪造 settled；文案只陈述
// 「自上次有进展起已静默 N、回合仍在跑、这是第 k 次提醒」。
function armStaleWatchdog(record) {
  if (record.staleMs === null) return;   // 显式关掉（`SOPHO_NOTIFY_STALE_MS=off` 等）
  if (record.staleTimer) clearTimeout(record.staleTimer);
  record.staleTimer = setTimeout(() => {
    record.staleTimer = null;
    void runStaleWatchdog(record);
  }, record.pollMs ?? record.staleMs);
  record.staleTimer.unref?.();
}

// 这条登记还挂在那儿吗？（一次轮询里有 await，期间它可能已经落定并被清掉 ⇒ 不许再武装一个孤儿定时器。）
function notifyRegistrationLive(record) {
  return notifyRegistrations.get(record.targetSessionId)?.get(record.watcherSessionId) === record;
}

// 会话文件的形状：**已有的**盘上事实，不新造 IPC 字段。mtime 就是「上次写盘」的时刻。
async function notifyProgressMark(sessionFile) {
  if (typeof sessionFile !== 'string' || sessionFile === '') return null;
  try {
    const info = await stat(sessionFile);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;   // 读不到就不算进展（也不抛：看门狗不该因为一次 stat 失败把宿主打挂）
  }
}

// 问**事实**「它现在到底在不在跑」，不新增 IPC 字段：走既有的 `live-facts`（`/tree` 的装饰路也用它）。
// 交回 `{running, sessionFile}`；交回 `null` = 问不上来（这一代没答 / 这个 handle 到点没交事实）⇒
// 调用方**不猜**，这一轮不计数也不动基线。
async function notifyTargetFacts(targetSessionId) {
  let worker;
  try {
    worker = await sessionRoute(targetSessionId);
  } catch (error) {
    console.error(`[host] stale watchdog: cannot route ${targetSessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!worker?.child) return null;
  let reply;
  try {
    reply = await callWorker(worker, { type: 'live-facts' }, { timeoutMs: NOTIFY_WATCHDOG_FACTS_TIMEOUT_MS });
  } catch (error) {
    console.error(`[host] stale watchdog: worker ${worker.generationId} did not answer live-facts in ${NOTIFY_WATCHDOG_FACTS_TIMEOUT_MS}ms for ${targetSessionId} (${error instanceof Error ? error.message : String(error)}); not guessing whether it is running`);
    return null;
  }
  const unavailable = Array.isArray(reply?.unavailable) ? reply.unavailable : [];
  if (unavailable.some((entry) => entry.sessionId === targetSessionId)) return null;
  const facts = Array.isArray(reply?.facts) ? reply.facts : [];
  const fact = facts.find((entry) => entry.id === targetSessionId);
  // 事实里没有它 ⇒ 没有任何 runtime 持有它 ⇒ **明确**没在跑（`live-facts` 列的就是池子里的全部会话，
  // 所以这不是猜）。
  return fact ? { running: fact.running === true, sessionFile: fact.sessionFile ?? null } : { running: false, sessionFile: null };
}

// 看门狗的一轮：问事实 ⇒ 判在不在跑 ⇒ 判这期间有没有新内容 ⇒ 到了无进展的整数倍就喊一次。
async function runStaleWatchdog(record) {
  if (record.staleMs === null) return;
  if (!notifyRegistrationLive(record)) return;
  const facts = await notifyTargetFacts(record.targetSessionId);
  if (!notifyRegistrationLive(record)) return;
  if (facts === null) {
    // 「在不在跑」问不上来 ⇒ **绝不**把未知说成「卡住」：这一轮不计数、不动基线，下一轮再问。
    armStaleWatchdog(record);
    return;
  }
  if (facts.running !== true) {
    // 没有在飞的回合 ⇒ 闲着等用户不是「卡住」。基线推到此刻、计数归零，**不唤醒**。
    record.progressAt = new Date().toISOString();
    record.progressMark = null;
    record.staleWakes = 0;
    if (record.state === 'stale') record.state = 'waiting_for_settle';
    armStaleWatchdog(record);
    return;
  }
  if (record.state === 'waiting_for_settle') record.state = 'running';
  const mark = await notifyProgressMark(facts.sessionFile);
  if (!notifyRegistrationLive(record)) return;
  const baselineMs = Date.parse(record.progressAt);
  let progressed = false;
  if (mark !== null) {
    const mtimeMs = Math.min(mark.mtimeMs, Date.now());
    if (record.progressMark === null) {
      // 第一次观测：只立基线观测值，**不算**进展（这一次写盘可能就是登记/启动那一下）。
      record.progressMark = mark;
    } else if (mtimeMs > baselineMs || mark.size !== record.progressMark.size) {
      record.progressMark = mark;
      // 基线推到**文件自己写的时刻**（mtime），不是「我这次看见的时刻」。
      record.progressAt = new Date(Math.max(baselineMs, mtimeMs)).toISOString();
      progressed = true;
    } else {
      record.progressMark = mark;
    }
  }
  if (progressed) {
    // 有新内容 ⇒ 这是一段新的「等它停」：计数归零，从这一刻重新计时。
    record.staleWakes = 0;
    record.state = 'running';
    record.error = null;
    armStaleWatchdog(record);
    return;
  }
  const silentMs = Date.now() - baselineMs;
  // 第 (k+1) 次提醒的到期点 = 基线 + (k+1) × staleMs ⇒ 10、20、30…分钟各一次（都从上次进展算）。
  const dueMs = record.staleMs * (record.staleWakes + 1);
  if (silentMs < dueMs) {
    armStaleWatchdog(record);
    return;
  }
  await deliverStaleNotify(record, silentMs);
  if (notifyRegistrationLive(record)) armStaleWatchdog(record);
}

function clearNotifyRegistration(targetSessionId, watcherSessionId) {
  const watchers = notifyRegistrations.get(targetSessionId);
  const record = watchers?.get(watcherSessionId);
  if (record?.timer) clearTimeout(record.timer);
  if (record?.staleTimer) clearTimeout(record.staleTimer);
  watchers?.delete(watcherSessionId);
  if (watchers?.size === 0) notifyRegistrations.delete(targetSessionId);
}

function noteNotifyLifecycle(targetSessionId, phase) {
  if (phase === 'settled') recordSettled(targetSessionId);
  const watchers = notifyRegistrations.get(targetSessionId);
  if (!watchers) return;
  if (phase === 'start') {
    for (const record of watchers.values()) {
      if (record.timer) clearTimeout(record.timer);
      record.timer = null;
      record.settledAt = null;
      record.dueAt = null;
      // 新回合 = 基线重置到此刻（计时从这里重新开始）。
      record.progressAt = new Date().toISOString();
      record.progressMark = null;
      record.staleWakes = 0;
      record.state = 'running';
      record.error = null;
    }
    return;
  }
  if (phase !== 'settled') return;
  const settledAt = Date.now();
  for (const record of watchers.values()) {
    // ⚠️ 落定**不**撤销看门狗（旧版这里是 `clearTimeout(record.staleTimer)`）。为什么：
    //   · 看门狗到底喊不喊，由**事实**判 —— 目标有没有在飞的回合（`live-facts` 的 `running`）。
    //     刚落定的目标现在是闲的 ⇒ 跑一轮也不会喊（「纯闲置等用户不是卡住」）；
    //   · 这样「落定生命周期迟到/丢掉」也不会把看门狗一起弄没一个本该继续着的登记；
    //   · 定时器仍然不会漏：登记被清掉时（落定唤醒投递成功/推送/清除）`clearNotifyRegistration`
    //     一定把它 `clearTimeout`，而且每个定时器都 `unref`。
    // ⚠️ 下面这里**曾经**是 `if (record.staleAt !== null) { clearNotifyRegistration(...); continue; }`：
    // 已经把「一直没落定」喊过一次，落定就只当结局、**不再兑现落定唤醒** —— 实测后果是子会话
    // 02:18:51 落定时父会话什么都没收到（2026-10-30）。现在落定**永远**走静默窗并投递一次，
    // 先前喊过 stale 的只在文本里如实追加一句（见 `deliverNotify`）。
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    record.settledAt = new Date(settledAt).toISOString();
    record.dueAt = new Date(settledAt + record.quietMs).toISOString();
    record.progressAt = new Date(settledAt).toISOString();   // 落定也是基线重置
    record.progressMark = null;
    record.staleWakes = 0;
    record.state = 'quiet_window';
    record.error = null;
    record.timer = setTimeout(() => {
      record.timer = null;
      void deliverNotify(record);
    }, record.quietMs);
    record.timer.unref?.();
  }
}

async function deliverNotify(record) {
  record.state = 'delivering';
  // 正文前缀（「已落定，并持续静默 <quietMs>ms。」）保持不变：既有断言按它认这条唤醒。
  const priorStale = record.staleAt === null ? '' : '（先前报过仍未落定）';
  try {
    await deliverDelegation(record.watcherSessionId, {
      kind: 'notify',
      fromSessionId: record.targetSessionId,
      text: `会话 ${record.targetSessionId} 已落定，并持续静默 ${record.quietMs}ms。${priorStale}请查看它的回报或状态。`,
    });
    clearNotifyRegistration(record.targetSessionId, record.watcherSessionId);
  } catch (error) {
    record.state = 'delivery_failed';
    record.error = error instanceof Error ? error.message : String(error);
    console.error(`[host] notify ${record.targetSessionId} -> ${record.watcherSessionId} failed: ${record.error}`);
  }
}

// 看门狗的一次兑现：**如实**说「自上次有进展起已静默 N、回合仍在跑、这是第 k 次提醒」，绝不写成
// 「它完成了/它失败了」。与 `deliverNotify` 走**同一条**交付路径（`deliverDelegation`），不另造通道。
// 兑现之后**保留**这条登记（`state:"stale"`）并继续武装（可重复），`/tree` 上仍看得见「它静默多久了」。
async function deliverStaleNotify(record, silentMs) {
  const attempt = record.staleWakes + 1;
  record.staleWakes = attempt;          // 先记这一次（投递失败也算「已经提醒过第 k 次」，cadence 不倒退）
  record.staleAt = new Date().toISOString();
  record.state = 'stale';
  record.error = null;
  try {
    await deliverDelegation(record.watcherSessionId, {
      kind: 'notify',
      fromSessionId: record.targetSessionId,
      text: `会话 ${record.targetSessionId} 自上次有进展起已静默 ${silentMs}ms（约 ${Math.round(silentMs / 60_000)} 分钟）：这期间它没有任何新内容写出来，回合仍在跑。这是第 ${attempt} 次提醒，不代表它失败，也不代表它已经完成——请查看它的状态或回报。`,
    });
    record.error = null;
  } catch (error) {
    record.state = 'stale_delivery_failed';
    record.error = error instanceof Error ? error.message : String(error);
    console.error(`[host] stale notify ${record.targetSessionId} -> ${record.watcherSessionId} failed: ${record.error}`);
  }
}

function notifySnapshotFor(sessionId) {
  const now = Date.now();
  const watchers = notifyRegistrations.get(sessionId);
  return watchers ? [...watchers.values()].map((record) => ({
    watcherSessionId: record.watcherSessionId,
    quietMs: record.quietMs,
    staleMs: record.staleMs,
    registeredAt: record.registeredAt,
    settledAt: record.settledAt,
    dueAt: record.dueAt,
    staleAt: record.staleAt,
    // 「它多久没有新动静了」与看门狗同一把尺子：从**上次观察到进展**算，不是从登记算。
    staleForMs: record.progressAt === null ? null : Math.max(0, now - Date.parse(record.progressAt)),
    staleWakes: record.staleWakes,
    state: record.state,
    error: record.error,
  })) : [];
}

function notifyUiFor(sessionId) {
  const notifies = notifySnapshotFor(sessionId);
  const now = Date.now();
  const waitingFor = [];
  for (const [targetSessionId, watchers] of notifyRegistrations) {
    const record = watchers.get(sessionId);
    if (record) waitingFor.push({
      targetSessionId,
      state: record.state,
      dueAt: record.dueAt,
      quietMs: record.quietMs,
      staleAt: record.staleAt,
      staleForMs: record.progressAt === null ? null : Math.max(0, now - Date.parse(record.progressAt)),
      staleWakes: record.staleWakes,
    });
  }
  return { notifies, waitingFor };
}


/** 换代窗口里「没有可用的当前代」时的**诚实、可重试**回执（不许裸 502/503）。 */
function sendNoGeneration(response, message = 'no live generation worker; POST /reload-code to start one') {
  sendJson(response, 503, { error: 'generation_swapped', message, retryable: true, retryAfterMs: 1000 }, { 'retry-after': '1' });
}
function sendWorkerUnavailable(response, error) {
  // ⚠️ 换代窗口里这一发没被任何一代服务 ⇒ 回**可重试语义**，不再回 `502 worker unavailable`
  // （那句话把「换代中、等一下就成」说成「worker 挂了」，误导航调用方）。
  sendJson(response, 503, {
    error: 'generation_swapped',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    retryAfterMs: 1000,
  }, { 'retry-after': '1' });
}

/**
 * 把一个「抛上来的错误」变成回执：body 形状与原来那几处 catch 一字不差（`{error, message, details?}`），
 * 但**多一件**：当它带可重试语义（`details.retryable === true`）时，一并给 HTTP 头 `Retry-After: 1`（秒）。
 * 为什么：JSON 里的 `retryAfterMs: 1000` 与头必须**处处一致**（F7 的收尾）—— 只看头（不看 body）的客户端
 * 在 `/move`·`/handoff`·`session_new`·子会话创建这几条守卫路上原本拿不到任何等待建议。
 */
function sendErrorReceipt(response, error, fallbackCode) {
  const retryable = error?.details?.retryable === true;
  sendJson(response, error?.statusCode ?? 500, {
    error: error?.code ?? fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details === undefined ? {} : { details: error.details }),
  }, retryable ? { 'retry-after': '1' } : {});
}

async function sessionRoute(sessionId) {
  const known = sessionOwners.get(sessionId);
  if (known) {
    const worker = workers.get(known);
    if (worker && worker.child && worker.child.connected !== false) return worker;
    sessionOwners.delete(sessionId);
  }
  // Unknown sessions can only be opened by the current generation. Ask it whether
  // the session is already hot there (the worker decides, the host does not guess),
  // and never ask a draining generation for a cold session.
  // 定案：**不做跨代挂起** —— 当前代不可用就回诚实可重试语义，不等待。
  const worker = currentWorker();
  if (!worker?.child) return null;
  try {
    const reply = await callWorker(worker, { type: 'query', sessionId }, { timeoutMs: 5000 });
    if (reply.route?.phase === 'hot') sessionOwners.set(sessionId, worker.generationId);
    return worker;
  } catch (error) {
    console.error(`[host] worker ${worker.generationId} route query failed: ${error.message}`);
    return worker;
  }
}

async function deliverDelegation(sessionId, input) {
  const worker = await sessionRoute(sessionId);
  if (!worker) throw Object.assign(new Error('no live generation worker'), { statusCode: 503, code: 'no_current_generation', details: { retryable: true, retryAfterMs: 1000 } });
  const reply = await callWorker(worker, { type: 'delegation-message', sessionId, input });
  return reply.value;
}

async function allLiveSessionFacts() {
  const byId = new Map();
  for (const worker of workers.values()) {
    if (!worker.child) continue;
    let reply;
    try {
      reply = await callWorker(worker, { type: 'live-facts' }, { timeoutMs: LIVE_FACTS_TIMEOUT_MS });
    } catch (error) {
      // 正确性路（冲突判定）⇒ 诚实且**可重试**：503 `live_facts_unavailable` + `details.retryable`
      //（调用方的通用处理按 `statusCode`/`details` 回执 ⇒ 不会退化成 500 ✓）。**绝不**静默 fail-open ✗。
      throw Object.assign(new Error(`worker ${worker.generationId} did not answer live-facts in ${LIVE_FACTS_TIMEOUT_MS}ms: ${error instanceof Error ? error.message : String(error)}`), {
        statusCode: 503,
        code: 'live_facts_unavailable',
        details: { retryable: true, retryAfterMs: 1000 },
      });
    }
    // worker 侧的 per-handle 死线到点（某个会话的串行队列被占住）⇒ 这一代的当下事实**不全**
    // 答上来了。正确性路**不许 fail-open**：宁回可重试 503，也绝不在少了一个会话的事实上判冲突。
    const unavailable = Array.isArray(reply.unavailable) ? reply.unavailable : [];
    if (unavailable.length > 0) {
      const ids = unavailable.map((entry) => entry.sessionId).join(', ');
      throw Object.assign(new Error(`worker ${worker.generationId} could not read live facts for ${unavailable.length} hot session(s) before the per-handle deadline: ${ids}`), {
        statusCode: 503,
        code: 'live_facts_unavailable',
        details: { retryable: true, retryAfterMs: 1000, unavailable },
      });
    }
    for (const fact of reply.facts ?? []) byId.set(fact.id, fact);
  }
  return [...byId.values()];
}

async function existingCwd(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw Object.assign(new Error('cwd must be a non-empty existing directory'), { statusCode: 400, code: 'invalid_cwd' });
  }
  const target = path.resolve(value);
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) {
    throw Object.assign(new Error(`target cwd does not exist or is not a directory: ${target}`), { statusCode: 409, code: 'target_cwd_missing', details: { cwd: target } });
  }
  return realpath(target);
}

// `/tree` 那份**落盘投影**：只看文件能看出来的事实（cwd / name / status / 归档 / 父）。
// 为什么要它（2026-09-21 现场）：占用判据原来只看**活 runtime 快照** ⇒ 一条「上一次（失败的）
// 创建弄出来、还没被打开过」的会话不在快照里 ⇒ 调用方拿到 500 之后重试**反而被自己的会话挡住**
// （409 workspace_conflict），而且从回执里**看不出哪条是自己的** ⇒ 没有恢复路径。
async function persistedSessionFacts(targetCwd) {
  const worker = currentWorker();
  if (!worker?.child) return [];
  const tree = await workerJson(worker, '/tree').catch((error) => {
    // ⚠️ 不静默（F9）：这条路失败 ⇒ 落盘占用**少报**（方向是安全的：宁可少报也不假报），
    // 但日志里必须留痕，否则调用方只能看到「冲突变少了」这一件事。
    console.warn(`[host] persistedSessionFacts: /tree unavailable, the on-disk occupancy check is skipped (fewer conflicts may be reported): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (!Array.isArray(tree?.sessions)) return [];
  const rows = [];
  for (const session of tree.sessions) {
    if (session.archived === true) continue;              // 归档的不算占用（与活快照同口径）
    let cwd;
    try { cwd = await realpath(session.cwd); } catch { continue; }
    if (cwd !== targetCwd) continue;
    rows.push({
      id: session.id,
      name: session.name ?? null,
      running: session.status === 'working',
      parentSessionId: session.parentId ?? null,
      source: 'disk',
    });
  }
  return rows;
}

async function workspaceConflicts(liveFacts, excludedSessionId, targetCwd) {
  const conflicts = [];
  const git = await gitFacts(targetCwd);
  for (const fact of liveFacts) {
    if (fact.id === excludedSessionId) continue;
    // A moved session refuses every prompt (409 session_moved) and is archived, so it
    // can no longer edit that tree. Counting it would leave its old cwd permanently
    // unusable after /move.
    if (fact.moved === true) continue;
    let factCwd;
    try { factCwd = await realpath(fact.cwd); } catch { continue; }
    if (factCwd !== targetCwd) continue;
    conflicts.push({
      // ⭐ 契约字段（`docs/manager-toolkit-plan.md` §11「会话创建」②）：调用方靠这几个认出
      // 「哪条是我自己刚建出来的」⇒ 自己认领；`sessionFile`/`parentSessionId` 可能为 null。
      id: fact.id,
      name: fact.name ?? null,
      running: fact.running === true,
      sessionFile: fact.sessionFile ?? null,
      parentSessionId: fact.parentSessionId ?? null,
      source: 'live',
      // 既有字段（**不删**：老消费者照旧拿得到 git 上下文；它们与 cwd 同值、逐元素重复）
      cwd: factCwd,
      isGit: git.isGit,
      gitRoot: git.root,
      dirty: git.dirty,
      branch: git.branch,
    });
  }
  return conflicts;
}

async function gitFacts(cwd) {
  let rootOutput;
  try {
    ({ stdout: rootOutput } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel']));
  } catch {
    return { isGit: false, root: null, mainRepo: null, branch: null, head: null, dirty: null };
  }
  const root = path.resolve(rootOutput.trim());
  try {
    const [{ stdout: status }, { stdout: branch }, { stdout: common }, { stdout: head }] = await Promise.all([
      execFileAsync('git', ['-C', root, 'status', '--porcelain']),
      execFileAsync('git', ['-C', root, 'branch', '--show-current']),
      execFileAsync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
      execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']),
    ]);
    const commonDir = path.resolve(root, common.trim());
    return {
      isGit: true,
      root,
      mainRepo: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : root,
      branch: branch.trim() || null,
      head: head.trim(),
      dirty: status.trim().length > 0,
    };
  } catch (error) {
    throw new Error(`cannot inspect git workspace ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function slugFor(value) {
  const normalized = String(value || 'child').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'child';
  return `${normalized}-${randomUUID().slice(0, 8)}`;
}

async function createWorktree(parentCwd, label) {
  const git = await gitFacts(parentCwd);
  if (!git.isGit) {
    const error = new Error(`worktree:"new" requires a git repository; ${parentCwd} is not inside one (refusing to silently share the directory)`);
    error.statusCode = 409;
    error.code = 'worktree_requires_git';
    throw error;
  }
  const slug = slugFor(label);
  const root = path.join(path.dirname(git.mainRepo), '.sopho-wt');
  const target = path.join(root, slug);
  const branch = `wt/${slug}`;
  await mkdir(root, { recursive: true });
  await execFileAsync('git', ['-C', git.mainRepo, 'worktree', 'add', '-b', branch, target, git.head]);
  return { cwd: await realpath(target), branch, path: target, mainRepo: git.mainRepo };
}

async function removeCreatedWorktree(worktree) {
  if (!worktree) return;
  try {
    await execFileAsync('git', ['-C', worktree.mainRepo, 'worktree', 'remove', '--force', worktree.path]);
  } catch (error) {
    console.error(`[host] failed to remove incomplete worktree ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await execFileAsync('git', ['-C', worktree.mainRepo, 'branch', '-D', worktree.branch]);
  } catch (error) {
    console.error(`[host] failed to remove incomplete branch ${worktree.branch}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// /move keeps the same hard workspace rule as spawn and session_new: landing a live
// session next to another live session in one tree is the hazard the rule exists for.
// The target directory's existence is still checked in the worker (single source of
// truth for target_cwd_missing), so an unusable path is passed through untouched.
async function guardMove(sessionId, bodyBuffer) {
  let body;
  try {
    body = bodyBuffer.length === 0 ? {} : JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400, code: 'invalid_json' });
  }
  if (body.share !== undefined && typeof body.share !== 'boolean') {
    throw Object.assign(new Error('share must be a boolean'), { statusCode: 400, code: 'invalid_share' });
  }
  if (typeof body.cwd !== 'string' || body.cwd.trim() === '' || body.cwd.includes('\0')) return;
  const requested = path.resolve(body.cwd);
  const info = await stat(requested).catch(() => null);
  if (!info?.isDirectory()) return;
  const targetCwd = await realpath(requested);
  const liveFacts = await allLiveSessionFacts();
  // An already-moved session is refused by the worker with the precise session_moved;
  // do not preempt that with a confusing "the target is occupied" (by its own successor).
  if (liveFacts.find((fact) => fact.id === sessionId)?.moved === true) return;
  const conflicts = await workspaceConflicts(liveFacts, sessionId, targetCwd);
  if (conflicts.length > 0 && body.share !== true) {
    const error = new Error('move refused: other live sessions already use the target cwd; two agents editing the same tree can overwrite each other. Use share:true only when you explicitly accept that risk.');
    error.statusCode = 409;
    error.code = 'workspace_conflict';
    error.details = { cwd: targetCwd, conflicts };
    throw error;
  }
}

// handoff lands a *sibling* session in a target cwd, so it obeys the same hard workspace
// rule as spawn/session_new/move. The target cwd's existence is still validated in the
// worker (single source of truth for target_cwd_missing); an unusable path passes through.
async function guardHandoff(sessionId, bodyBuffer) {
  let body;
  try {
    body = bodyBuffer.length === 0 ? {} : JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400, code: 'invalid_json' });
  }
  if (body.share !== undefined && typeof body.share !== 'boolean') {
    throw Object.assign(new Error('share must be a boolean'), { statusCode: 400, code: 'invalid_share' });
  }
  // A device target is refused by the worker with the precise handoff_device_unsupported.
  if (body.to !== undefined && body.to !== null && typeof body.to === 'object' && body.to.device !== undefined && body.to.device !== null) return;
  const requestedCwd = body.to && typeof body.to === 'object' ? body.to.cwd : undefined;
  if (typeof requestedCwd !== 'string' || requestedCwd.trim() === '' || requestedCwd.includes('\0')) return;
  const requested = path.resolve(requestedCwd);
  const info = await stat(requested).catch(() => null);
  if (!info?.isDirectory()) return;
  const targetCwd = await realpath(requested);
  const liveFacts = await allLiveSessionFacts();
  if (liveFacts.find((fact) => fact.id === sessionId)?.moved === true) return;
  const conflicts = await workspaceConflicts(liveFacts, sessionId, targetCwd);
  if (conflicts.length > 0 && body.share !== true) {
    const error = new Error('handoff refused: other live sessions already use the target cwd; two agents editing the same tree can overwrite each other. Use share:true only when you explicitly accept that risk.');
    error.statusCode = 409;
    error.code = 'workspace_conflict';
    error.details = { cwd: targetCwd, conflicts };
    throw error;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('request body exceeds 1048576 bytes'), { statusCode: 413, code: 'body_too_large' });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400, code: 'invalid_json' });
  }
}

function requireFullUuid(value, field = 'sessionId') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '')) {
    const error = new Error(`${field} must be a full UUID; prefixes are not accepted: ${value || '(empty)'}`);
    error.statusCode = 400;
    error.code = 'full_uuid_required';
    throw error;
  }
  return value.toLowerCase();
}

// ⚠️ 「这是不是 SSE」的**事实来源是上游响应的 `content-type`**，不是客户端的 `Accept` 头（2026-09-26）。
// 业主报的那条 aiohttp `TransferEncodingError`（`Response payload is not completed`）的根就在这里：
// **`Accept: */*` 是 aiohttp 的默认**，用 `Accept` 判就把一条 SSE 判成「不是 SSE」⇒ 上游（worker）死掉时
// `terminateDownstream` 走 `response.destroy()` ⇒ 掐断一条 chunked 流（客户端看到的正是 TransferEncodingError）。
// `/…/events` 这条路在 worker 侧由 `beginSse` **无条件**发 `text/event-stream` ⇒ 上游响应头比客户端请求头更接近事实。
// 门：`test/sse-truncation.mjs --assert`（④⑤⑨）钉的就是这一段。
function isEventStreamContentType(value) {
  const raw = Array.isArray(value) ? value.join(',') : value || '';
  return /text\/event-stream/i.test(raw);
}

// **只在还没有上游响应时**才用它：那时没有比「客户端要什么」更硬的事实（见 `upstreamRequest.once('error')`
// 与 `server/app.mjs` 的同名函数 —— 两份拷贝必须同口径）。
function wantsEventStream(request) {
  return isEventStreamContentType(request.headers.accept);
}

function sendSseSoftFailure(response, error) {
  if (response.destroyed || response.headersSent) {
    if (!response.destroyed && !response.writableEnded) response.end();
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
  });
  response.end(`retry: 1000\n: worker unavailable (${detail.replaceAll('\n', ' ')})\n\n`);
}

function terminateDownstream(response, sse, message) {
  if (response.destroyed || response.writableEnded) return;
  try {
    if (sse && response.headersSent) {
      response.write(`event: server.error\ndata: ${JSON.stringify({ type: 'server.error', message, retry: true })}\n\n`);
      response.end();
      return;
    }
    if (!response.headersSent) sendWorkerUnavailable(response, new Error(message));   // 不许裸 502：换诚实可重试语义
    else response.destroy(new Error(message));
  } catch {
    response.destroy();
  }
}

// ⚠️ 这一块原本与「跨代挂起」的旋钮写在一起，2026-09-21 那一笔「去掉跨代挂起」把它**一起删掉了** ✗ ——
// 结果 `NOTIFY_QUIET_MS` 的定义没了、用它的地方还在 ⇒ `ReferenceError: NOTIFY_QUIET_MS is not defined`
// ⇒ 走通知/委派那条路的请求变成 **500**（`test/s1a2-api.mjs:607` 的 `500 !== 202` 就是它：那一发是
// `POST /sessions/{id}/send {notify:true}`）。这里把它**单独**放回来（与挂起无关，纯粹是通知静默窗口）。
const NOTIFY_QUIET_MS = Number.isFinite(Number(process.env.SOPHO_NOTIFY_QUIET_MS))
  ? Math.max(10, Number(process.env.SOPHO_NOTIFY_QUIET_MS))
  : 20_000;

// 静默看门狗的阈值（见 `armStaleWatchdog` 那段注释）：**自上次有进展起**静默满一个阈值就喊一次，
// 之后每多满一个阈值再喊一次（10、20、30…分钟），直到它落定或登记被清掉。
// 取值规则（显式、不抛）：默认 10 分钟；`0` / `off` / `none` / `false` / `no` = **显式关掉**（null）；
// 其它非正数、非数字、空串一律回到默认值 —— 坏值绝不抛（一个写错的旋钮不应该让宿主起不来）。
const NOTIFY_STALE_MS = (() => {
  const raw = process.env.SOPHO_NOTIFY_STALE_MS;
  if (raw === undefined) return 10 * 60_000;
  const text = String(raw).trim().toLowerCase();
  if (['0', 'off', 'none', 'false', 'no'].includes(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return 10 * 60_000;
  return Math.max(10, Math.floor(value));
})();

// 看门狗每次轮询要问一次「它现在在不在跑」（既有的 `live-facts`）。这是**装饰/判断**用途、不是冲突判定，
// 所以给它的是一条**短**死线：到点就如实当作「问不上来」，这一轮不计数、不猜（见 `notifyTargetFacts`）。
const NOTIFY_WATCHDOG_FACTS_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.SOPHO_NOTIFY_WATCHDOG_FACTS_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
})();

// ⚠️ 换代窗口的**有界近因**（集成/验收方 2026-09-21 裁定「甲：追加式」）：
// 客户端按 **`retryable`** 这个旗标分支；`error` code（`session_not_owned_by_generation` / `generation_swapped`）
// **只用于诊断与日志**。宿主保证：**换代窗口内所有非 2xx 都带 `retryable: true`**。
// 「是不是窗口」这里用**有界近因**判：**当前代不可用**（`currentGenerationId === null` / 没有可用的 current worker）
// **或** 存在 draining 代且它开始 draining 距今 ≤ `SWAP_WINDOW_MS`。**这不是**「我们确知此刻正在换代」✗ ——
// 只是「近 windows 内发生过换代」的近似；所以窗口外的真 ownership 冲突**不会**被贴上 `retryable`。
// ⚠️ 与上面那条**装饰**路（`drainingRunningSessionIds`，默认 400ms）不同 ✗：`allLiveSessionFacts()` 是
// **冲突判定**用的（4 个调用点：`/move` · `/handoff` · `session_new` · 子会话创建）⇒ 答不上来**不许**静默
// fail-open ✗（冲突判定不许悄悄变弱）、也**不许**变成 500 ✗ ⇒ 给它自己的**长**死线（默认 5000ms；允许 0 =
// 立即超时，便于门造确定性夹具）＋ 超时抛 503 `live_facts_unavailable` + `details.retryable`。
const LIVE_FACTS_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.SOPHO_LIVE_FACTS_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
})();

const SWAP_WINDOW_MS = (() => {
  const raw = Number.parseInt(process.env.SOPHO_SWAP_WINDOW_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
})();

function inSwapWindow() {
  if (!currentWorker()) return true;   // 当前代不可用（正在路上 / 还没起来）
  const now = Date.now();
  return drainingWorkers().some((worker) => {
    const at = worker.drainingAt ? Date.parse(worker.drainingAt) : Number.NaN;
    return Number.isFinite(at) && now - at <= SWAP_WINDOW_MS;
  });
}

// ⚠️ **死旋钮**（保留只为运维显式开关与文档一致）：`SOPHO_GENERATION_WAIT_MS` 默认 **0 = 不做跨代挂起**
//（2026-09-21 定案）。跨代等待机制（`waitForCurrentWorker`）已删除 ⇒ 这个旋钮**现在不起任何作用**，
// 后人别以为它有用；要恢复挂起必须先按裁定标准交三条测量。
const GENERATION_WAIT_MS = Number.isFinite(Number(process.env.SOPHO_GENERATION_WAIT_MS)) && Number(process.env.SOPHO_GENERATION_WAIT_MS) >= 0
  ? Number(process.env.SOPHO_GENERATION_WAIT_MS)
  : 0;

async function proxyToWorker(request, response, worker, body) {
  // 上游还**没回话**时用（连接直接失败）—— 那时只能退回客户端想要的。
  // 一旦拿到上游响应，改看它的 content-type（`sseUpstream`）。
  const sse = wantsEventStream(request);
  let settled = false;
  let upstreamResponse;
  let resolveOutcome;
  const outcome = new Promise((resolve) => { resolveOutcome = resolve; });   // { reached, error }
  const headers = {
    ...request.headers,
    host: 'worker.local',
    'x-sopho-worker-token': worker.token,
    'content-length': body.length,
  };
  if (currentGenerationId) headers['x-sopho-current-generation'] = currentGenerationId;
  if (worker.selfGenerationId) headers['x-sopho-owner-generation'] = worker.selfGenerationId;
  const upstreamRequest = http.request({
    host: '127.0.0.1',
    port: worker.port,
    method: request.method,
    path: request.url,
    headers,
  }, async (incoming) => {
    settled = true;
    resolveOutcome({ reached: true, error: null });
    upstreamResponse = incoming;
    // ⚠️ **拿到上游响应之后，判「是不是 SSE」以上游响应的 `content-type` 为准**（2026-09-26）：
    // 客户端的 `Accept: */*`（aiohttp 默认）不能当成「不是 SSE」，否则下面两条收尾路会 destroy 掉
    // 一条 chunked 流。`|| sse` 只兜「上游没给 content-type」这一种情形（那种情形下退回 `Accept`）。
    const sseUpstream = isEventStreamContentType(incoming.headers['content-type']) || sse;
    try {
      if (response.destroyed || response.headersSent) {
        incoming.destroy();
        return;
      }
      // ⚠️ 换代窗口的**第三种形状**：请求**已经到达某个 worker**，而它说「我不再持有这条会话」
      //（409 `session_not_owned_by_generation` —— draining 代自己说的）。它不是「没接通」（所以不走
      // `finishFailedProxy`），但**也不该原样透传**（那等于把「换代中、等一下就成」说成「你的请求不合法」）。
      // 口径（集成/验收方定案）：GET/HEAD ⇒ 忘掉旧 owner、换当前代**重试一次**；写请求 ⇒ **不重试**，
      // 只把可重试语义**追加**到同一个 409 上（**状态码与既有字段一字不改** —— 契约面不动）。
      if (incoming.statusCode === 409 && /^\/sessions\//.test(String(request.url ?? ''))) {
        const chunks = [];
        let size = 0;
        let tooBig = false;
        await new Promise((resolve) => {
          incoming.on('data', (chunk) => { if (tooBig) return; chunks.push(chunk); size += chunk.length; if (size > 8192) tooBig = true; });
          incoming.once('end', resolve);
          incoming.once('error', resolve);
        });
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* 不是 JSON：按原样放行 */ }
        if (!tooBig && parsed?.error === 'session_not_owned_by_generation') {
          const match = /^\/sessions\/([^/?]+)/.exec(String(request.url ?? ''));
          if (match) sessionOwners.delete(match[1].toLowerCase());
          const method = String(request.method || 'GET').toUpperCase();
          const retryWorker = (method === 'GET' || method === 'HEAD') ? currentWorker() : null;
          if (retryWorker?.child && retryWorker.child.connected !== false && retryWorker.child.exitCode === null) {
            console.error(`[host] generation swap (session_not_owned_by_generation): retrying ${method} ${request.url} once on generation ${retryWorker.generationId}; the disowning generation had already released the session`);
            const retried = await proxyToWorker(request, response, retryWorker, body);
            if (!retried.reached && !response.headersSent) sendWorkerUnavailable(response, retried.error);
            return;
          }
          // 写请求（或没有可用的当前代）：**绝不重试** ✗（无法证明 worker 没处理过 ⇒ 双写风险）。
          // 裁定（甲：追加式）：**保留** 409 的 status/code 与既有字段**一个都不改** ✓，只**追加**
          // `retryable: true` + `retryAfterMs`（并补 `Retry-After`）—— **且只在换代窗口里**追加：
          // 非窗口的真 ownership 冲突必须**不带** `retryable`（客户端不该去重试一次真正的所有权冲突）。
          if (inSwapWindow()) {
            sendJson(response, 409, { ...parsed, retryable: true, retryAfterMs: 1000 }, { 'retry-after': '1' });
            return;
          }
          // 非窗口 ⇒ 原样透传这个 409（不改 status、不改 code、不加旗标）。
          response.writeHead(incoming.statusCode || 502, incoming.headers);
          if (raw.length > 0) response.write(raw);
          incoming.pipe(response);
          return;
        }
        // 不是那条 409（session_moved / session_cwd_missing / workspace_conflict …）：按原样放行。
        response.writeHead(incoming.statusCode || 502, incoming.headers);
        if (raw.length > 0) response.write(raw);
        incoming.pipe(response);
        return;
      }
      response.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(response);
      incoming.once('error', () => terminateDownstream(response, sseUpstream, 'generation worker connection lost'));
      // A worker that is SIGKILLed mid-stream closes the upstream socket without an
      // 'end'. The client must see a terminal event, never silence.
      incoming.once('close', () => {
        if (!response.writableEnded && !response.writableFinished) {
          terminateDownstream(response, sseUpstream, 'generation worker terminated mid-stream');
        }
      });
    } catch (error) {
      incoming.destroy();
      if (!response.headersSent) response.destroy(error);
    }
  });

  const destroyUpstream = () => {
    if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
    if (!upstreamRequest.destroyed) upstreamRequest.destroy();
  };
  request.once('aborted', destroyUpstream);
  response.once('close', () => {
    if (!response.writableEnded) destroyUpstream();
  });

  upstreamRequest.once('error', (error) => {
    // ⚠️ 换代窗口：owner 已经不会回话（socket 死了 / 它正在 shutdown），而**还没写出任何字节**。
    // 这里**什么都不写**，把「没接通」如实交回调用方 —— owner 路由与兜底 proxy 两处入口会走
    // `finishFailedProxy`（幂等 GET/HEAD 重试一次；写请求直接回可重试语义）。原来这里直接发裸 502，调用方的
    // `if (reached || response.headersSent) return;` 必然 return ⇒ fallback 那段**永远是死代码**。
    // SSE 例外：那条路没有重试语义、客户端不能静默 ⇒ 仍然给软失败。
    resolveOutcome({ reached: false, error });
    if (settled || response.destroyed || response.headersSent) return;
    if (sse) sendSseSoftFailure(response, error);
  });

  if (body.length > 0) upstreamRequest.write(body);
  upstreamRequest.end();
  return outcome;
}

// 一代**没接上**（`proxied.reached === false`，且**还没写出任何字节**）时的统一收尾。
// 语义（集成/验收方定案）：**幂等方法**（GET/HEAD）⇒ 忘掉旧 owner、换当前代**重试一次**；
// **写方法**（POST/PUT/PATCH/DELETE …）⇒ **绝不重试** —— 「宿主没写出字节」≠「worker 没收到」，
// 无法证明它没处理过 ⇒ 自动重试有**双写**风险（本仓底线），直接回诚实、可重试的回执。
// ⚠️ **两处入口共用同一个函数**：owner 路由（`/sessions/*`）与通用兜底 proxy。
// （`dbd5b20` 把兜底入口改成调这个函数时**漏了声明** ⇒ 那条路一撞就 `ReferenceError`；
//  本棒把它实现出来，并让 owner 路由也改走它，不再是两份内联副本。）
async function finishFailedProxy(request, response, body, first, label, sessionId = null) {
  if (first.reached || response.headersSent) return;
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    if (sessionId !== null) sessionOwners.delete(sessionId);
    const fallback = currentWorker();
    if (fallback?.child && fallback.child.connected !== false && fallback.child.exitCode === null) {
      console.error(`[host] generation swap (${label}): retrying ${method} ${request.url} once on generation ${fallback.generationId}; the failed attempt had written no bytes`);
      const retry = await proxyToWorker(request, response, fallback, body);
      if (retry.reached || response.headersSent) return;
      sendWorkerUnavailable(response, retry.error);
      return;
    }
  }
  // 写请求（或没有可用的当前代）：不重试，直接回那条**诚实、可重试**的回执。
  sendWorkerUnavailable(response, first.error);
}

const DELEGATION_PATH = /^\/sessions\/([^/]+)\/(spawn|session-new|send|session-read|push|notify)$/;
const SESSION_PATH = /^\/sessions\/([^/]+)(?:\/(messages|events|commands|models|model|message|steer|follow-up|followUp|dev-burst|abort|compact|title|archive|move|seal|handoff|seen|draft|questions))?$/;

// 宿主等 worker 的那条硬超时。它只服务三个路由：`/tree`、`/draft`、`/seen`（三个都要先问 worker 一棵树）。
// ⚠️ 这条死线必须**大于** worker 自己的索引预算（`SOPHO_TREE_INDEX_BUDGET_MS`，默认 3500 ms）
// —— worker 在那条预算内一定会回（到点先回部分视图），宿主就不会被自己的超时坑成 500。
// 慢机器（真机实测：Windows 笔记本 + 实时防护）上可以放宽；缩短主要用于沙箱里
// 把「宿主侧 timeout ⇒ 500」这条路径钉住（见 test/tree-index-selflock.mjs）。
const WORKER_JSON_TIMEOUT_MS = Number.isFinite(Number(process.env.SOPHO_WORKER_JSON_TIMEOUT_MS)) && Number(process.env.SOPHO_WORKER_JSON_TIMEOUT_MS) > 0
  ? Number(process.env.SOPHO_WORKER_JSON_TIMEOUT_MS)
  : 5000;

async function workerJson(worker, pathname) {
  const response = await fetch(`http://127.0.0.1:${worker.port}${pathname}`, {
    headers: { accept: 'application/json', 'x-sopho-worker-token': worker.token },
    signal: AbortSignal.timeout(WORKER_JSON_TIMEOUT_MS),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = { message: text }; }
  if (!response.ok) {
    const error = new Error(value.message || `worker returned ${response.status}`);
    error.statusCode = response.status;
    error.code = value.error;
    error.details = value.details;
    throw error;
  }
  return value;
}

async function routeDelegation(request, response, sessionId, action, url) {
  try {
    if (request.method === 'GET' && action === 'notify') {
      request.resume();
      sendJson(response, 200, { sessionId, registrations: notifySnapshotFor(sessionId), quietMs: NOTIFY_QUIET_MS, staleMs: NOTIFY_STALE_MS });
      return;
    }
    if (request.method === 'GET' && action === 'session-read') {
      request.resume();
      const lines = Number(url.searchParams.get('lines') ?? 4);
      const worker = await sessionRoute(sessionId);
      if (!worker) throw Object.assign(new Error('no live generation worker'), { statusCode: 503, code: 'no_current_generation', details: { retryable: true, retryAfterMs: 1000 } });
      const reply = await callWorker(worker, { type: 'delegation-read', sessionId, lines: Number.isInteger(lines) ? lines : 4 });
      sendJson(response, 200, { ...reply.value, notify: notifySnapshotFor(sessionId) });
      return;
    }
    if (request.method !== 'POST') {
      throw Object.assign(new Error(`method ${request.method} is not allowed for ${url.pathname}`), { statusCode: 405, code: 'method_not_allowed' });
    }
    const body = await readBody(request);
    if (action === 'send') {
      const fromSessionId = requireFullUuid(body.fromSessionId, 'fromSessionId');
      if (body.notify !== false) registerNotify(sessionId, fromSessionId);
      try {
        const value = await deliverDelegation(sessionId, { kind: body.kind || 'send', fromSessionId, text: body.text });
        sendJson(response, 202, { accepted: true, sessionId, fromSessionId, notify: body.notify !== false, quietMs: NOTIFY_QUIET_MS, ...value });
      } catch (error) {
        if (body.notify !== false) clearNotifyRegistration(sessionId, fromSessionId);
        throw error;
      }
      return;
    }
    if (action === 'push') {
      const childWorker = await sessionRoute(sessionId);
      if (!childWorker) throw Object.assign(new Error('no live generation worker'), { statusCode: 503, code: 'no_current_generation', details: { retryable: true, retryAfterMs: 1000 } });
      const parentReply = await callWorker(childWorker, { type: 'parent-fact', sessionId });
      const parent = parentReply.value;
      if (!parent.parentSessionId) {
        throw Object.assign(new Error(`session ${sessionId} has no parentSession in its file header`), { statusCode: 409, code: 'session_has_no_parent' });
      }
      const value = await deliverDelegation(parent.parentSessionId, {
        kind: 'push',
        fromSessionId: sessionId,
        text: body.text,
      });
      clearNotifyRegistration(sessionId, parent.parentSessionId);
      sendJson(response, 202, { accepted: true, childSessionId: sessionId, parentSessionId: parent.parentSessionId, parentSessionPath: parent.parentSessionPath, ...value });
      return;
    }
    if (action === 'session-new') {
      const value = await queueDelegation(async () => {
        if (body.share !== undefined && typeof body.share !== 'boolean') {
          throw Object.assign(new Error('share must be a boolean'), { statusCode: 400, code: 'invalid_share' });
        }
        if (body.name !== undefined && typeof body.name !== 'string') {
          throw Object.assign(new Error('name must be a string'), { statusCode: 400, code: 'invalid_name' });
        }
        if (body.firstMessage !== undefined && (typeof body.firstMessage !== 'string' || body.firstMessage.trim() === '')) {
          throw Object.assign(new Error('firstMessage must be a non-empty string when provided'), { statusCode: 400, code: 'invalid_first_message' });
        }
        const parentWorker = await sessionRoute(sessionId);
        if (!parentWorker) throw Object.assign(new Error('no live generation worker'), { statusCode: 503, code: 'no_current_generation', details: { retryable: true, retryAfterMs: 1000 } });
        await callWorker(parentWorker, { type: 'delegation-read', sessionId, lines: 1 });
        const liveBefore = await allLiveSessionFacts();
        const parent = liveBefore.find((fact) => fact.id === sessionId);
        if (!parent?.sessionFile) throw Object.assign(new Error(`parent session is not live or durable: ${sessionId}`), { statusCode: 409, code: 'parent_session_not_live' });
        const targetCwd = await existingCwd(body.cwd);
        const conflicts = await workspaceConflicts(liveBefore, null, targetCwd);
        // ⚠️ ①：**创建之前**再查一遍**落盘投影** —— 刚建出来、还没热过的会话只看活快照是看不到的
        // （「上一次建成了、这一次却被拒」那个现场）。两条来源合并，逐元素带 `source` 说明命中来源。
        for (const fact of await persistedSessionFacts(targetCwd)) {
          if (!conflicts.some((item) => item.id === fact.id)) {
            conflicts.push({ ...fact, isGit: false, gitRoot: null, dirty: null, branch: null });
          }
        }
        if (conflicts.length > 0 && body.share !== true) {
          const error = new Error('session_new refused: other sessions already use the target cwd; two agents editing the same tree can overwrite each other. Use share:true only when you explicitly accept that risk.');
          error.statusCode = 409;
          error.code = 'workspace_conflict';
          // 回执形状（②）：`{ cwd, conflicts: [{id, name, running, sessionFile?, parentSessionId?, source}] }`
          // —— 调用方能据此**自己认领**「刚建出来那一条」，而不是只能改 cwd 或加 share。
          error.details = { cwd: targetCwd, conflicts };
          throw error;
        }
        const childSessionId = randomUUID();
        const current = currentWorker();
        if (!current?.child) throw Object.assign(new Error('no live current generation'), { statusCode: 503, code: 'no_current_generation', details: { retryable: true, retryAfterMs: 1000 } });
        const reply = await callWorker(current, {
          type: 'delegation-create',
          input: {
            sessionId: childSessionId,
            cwd: targetCwd,
            name: body.name,
            parentSessionPath: parent.sessionFile,
            ...(body.firstMessage === undefined ? {} : { task: body.firstMessage }),
          },
        }, { timeoutMs: 30_000 });
        return {
          parentSessionId: sessionId,
          childSessionId,
          child: reply.value,
          cwd: targetCwd,
          shared: body.share === true,
          firstMessageAccepted: body.firstMessage !== undefined,
        };
      });
      sendJson(response, 201, value);
      return;
    }
    if (action === 'spawn') {
      const value = await queueDelegation(async () => {
        if (body.worktree !== undefined && body.worktree !== 'new') {
          throw Object.assign(new Error('worktree must be "new" when provided'), { statusCode: 400, code: 'invalid_worktree' });
        }
        if (body.worktree === 'new' && body.share === true) {
          throw Object.assign(new Error('worktree:"new" and share:true are mutually exclusive'), { statusCode: 400, code: 'invalid_spawn_mode' });
        }
        // task 现在是**可选**的：省了 ⇒ 只建会话、不起回合（= 原 session_new 的 firstMessage 省略语义）。
        // ⚠️ 空串/非字符串必须在**创建之前**就拒 —— 否则会话先落盘、再因为空 task 报错，留下一条半成品。
        if (body.task !== undefined && (typeof body.task !== 'string' || body.task.trim() === '')) {
          throw Object.assign(new Error('task must be a non-empty string when provided'), { statusCode: 400, code: 'invalid_task' });
        }
        const hasTask = typeof body.task === 'string';
        const parentWorker = await sessionRoute(sessionId);
        if (!parentWorker) throw Object.assign(new Error('no live generation worker'), { statusCode: 503, code: 'no_current_generation', details: { retryable: true, retryAfterMs: 1000 } });
        await callWorker(parentWorker, { type: 'delegation-read', sessionId, lines: 1 });
        const liveBefore = await allLiveSessionFacts();
        const parent = liveBefore.find((fact) => fact.id === sessionId);
        if (!parent?.sessionFile) throw Object.assign(new Error(`parent session is not live or durable: ${sessionId}`), { statusCode: 409, code: 'parent_session_not_live' });
        let targetCwd = await realpath(parent.cwd);
        let createdWorktree = null;
        if (body.worktree === 'new') {
          createdWorktree = await createWorktree(targetCwd, body.name || body.task);
          targetCwd = createdWorktree.cwd;
        } else {
          const conflicts = await workspaceConflicts(liveBefore, sessionId, targetCwd);
          if (conflicts.length > 0 && body.share !== true) {
            const error = new Error('spawn refused: other live sessions already use the target cwd; two agents editing the same tree can overwrite each other. Use worktree:"new" or share:true only when you explicitly accept that risk.');
            error.statusCode = 409;
            error.code = 'workspace_conflict';
            error.details = { cwd: targetCwd, conflicts };
            throw error;
          }
        }
        const childSessionId = randomUUID();
        // 没有 task ⇒ 没有回合可等 ⇒ 不登记 notify（登记了也永远不会在「停下并静默」上兑现）。
        const watcher = body.notify === false || !hasTask ? null : sessionId;
        if (watcher) registerNotify(childSessionId, watcher);
        const ownershipNotice = createdWorktree
          ? `[工作区告知] 你拥有这棵独立工作树 ${targetCwd}（分支 ${createdWorktree.branch}）；别碰主树 ${createdWorktree.mainRepo}。你的读写都只在这棵树里做。\n\n`
          : '';
        try {
          const current = currentWorker();
          if (!current?.child) throw Object.assign(new Error('no live current generation'), { statusCode: 503, code: 'no_current_generation', details: { retryable: true, retryAfterMs: 1000 } });
          const reply = await callWorker(current, {
            type: 'delegation-create',
            input: {
              sessionId: childSessionId,
              cwd: targetCwd,
              name: body.name,
              parentSessionPath: parent.sessionFile,
              ...(hasTask ? { task: `${ownershipNotice}${body.task}` } : {}),
            },
          }, { timeoutMs: 30_000 });
          return {
            parentSessionId: sessionId,
            childSessionId,
            child: reply.value,
            cwd: targetCwd,
            worktree: createdWorktree ? { path: targetCwd, branch: createdWorktree.branch, mainRepo: createdWorktree.mainRepo } : null,
            shared: body.share === true,
            notify: watcher !== null,
            quietMs: NOTIFY_QUIET_MS,
            staleMs: NOTIFY_STALE_MS,
          };
        } catch (error) {
          if (watcher) clearNotifyRegistration(childSessionId, watcher);
          await removeCreatedWorktree(createdWorktree);
          throw error;
        }
      });
      sendJson(response, 201, value);
      return;
    }
    throw Object.assign(new Error(`unsupported delegation action: ${action}`), { statusCode: 404, code: 'not_found' });
  } catch (error) {
    sendErrorReceipt(response, error, 'delegation_failed');
  }
}

async function routeRequest(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/tree') {
    request.resume();
    const worker = currentWorker();
    if (!worker?.child) {
      sendNoGeneration(response);
      return;
    }
    // 取树与探 draining 代里的在跑会话互不依赖：并发跑，正常路径（没有 draining 代时
    // 立刻返回空集）不多等一次串行往返。
    const [workerTree, draining] = await Promise.all([
      workerJson(worker, '/tree'),
      drainingRunningSessionIds(),
    ]);
    const tree = decorateUnreadTree(workerTree);
    tree.sessions = overlayWorkingStatus(tree.sessions, draining.running)
      .map((session) => ({ ...session, notify: notifyUiFor(session.id) }));
    // 如实标注：问 draining 代要 live-facts 到点没答上来 ⇒ 在跑的叠加是**上一次已知的**（stale）。
    // （`degraded` 是这一次调用自己带回来的，不是模块级单值 ⇒ 并发不会互抹。）
    if (draining.degraded) tree.drainingFacts = draining.degraded;
    sendJson(response, 200, tree);
    return;
  }
  const delegationMatch = DELEGATION_PATH.exec(url.pathname);
  if (delegationMatch) {
    let sessionId;
    try { sessionId = requireFullUuid(decodeURIComponent(delegationMatch[1])); } catch (error) {
      sendJson(response, error?.statusCode ?? 400, { error: error?.code ?? 'invalid_session_id', message: error.message });
      return;
    }
    await routeDelegation(request, response, sessionId, delegationMatch[2], url);
    return;
  }
  const match = SESSION_PATH.exec(url.pathname);
  if (match) {
    let sessionId;
    try { sessionId = requireFullUuid(decodeURIComponent(match[1])); } catch (error) {
      sendJson(response, error?.statusCode ?? 400, { error: error?.code ?? 'invalid_session_id', message: error.message });
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (match[2] === 'draft') {
      try {
        if (request.method !== 'GET' && request.method !== 'PUT') {
          throw Object.assign(new Error(`method ${request.method} is not allowed for ${url.pathname}`), { statusCode: 405, code: 'method_not_allowed' });
        }
        // Resolve through the session owner even though the stable host owns this global
        // sidecar. The worker's /tree is disk-derived and does not acquire a runtime.
        const worker = await sessionRoute(sessionId);
        if (!worker) throw Object.assign(new Error('no live generation worker'), { statusCode: 503, code: 'no_current_generation', details: { retryable: true, retryAfterMs: 1000 } });
        const tree = await workerJson(worker, '/tree');
        // worker 的索引可能只建了一半（它到点先回部分视图）：那时候「树里没有这条」**不等于**
        // 「这条不存在」—— 宁可放过去（draft 只是存一段草稿），也不给一个假的 404。
        if (tree.partial !== true && !tree.sessions?.some((session) => session.id === sessionId)) {
          throw Object.assign(new Error(`session not found: ${sessionId}`), { statusCode: 404, code: 'session_not_found' });
        }
        if (request.method === 'GET') {
          sendJson(response, 200, await readDraft(sessionId));
          return;
        }
        let value;
        try { value = JSON.parse(body.toString('utf8') || '{}'); } catch (error) {
          throw Object.assign(new Error(`invalid JSON body: ${error.message}`), { statusCode: 400, code: 'invalid_json' });
        }
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.text !== 'string') {
          throw Object.assign(new Error('draft body must be an object with a string text field'), { statusCode: 400, code: 'invalid_draft' });
        }
        sendJson(response, 200, await writeDraft(sessionId, value.text));
      } catch (error) {
        sendErrorReceipt(response, error, 'draft_failed');
      }
      return;
    }
    if (match[2] === 'seen') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method_not_allowed', message: `method ${request.method} is not allowed for ${url.pathname}` });
        return;
      }
      try {
        const worker = currentWorker();
        if (!worker?.child) throw Object.assign(new Error('no live generation worker'), { statusCode: 503, code: 'no_current_generation', details: { retryable: true, retryAfterMs: 1000 } });
        const tree = await workerJson(worker, '/tree');
        // 同 draft：索引半成时「树里没有这条」不是「这条不存在」（见上面那段）。
        if (tree.partial !== true && !tree.sessions?.some((session) => session.id === sessionId)) {
          throw Object.assign(new Error(`session not found: ${sessionId}`), { statusCode: 404, code: 'session_not_found' });
        }
        const seenAt = await recordSeen(sessionId);
        sendJson(response, 200, { ok: true, id: sessionId, seenAt, unread: false });
      } catch (error) {
        // 同类收尾：这条路的 503 本来就带 `details.retryable`，原来这个 catch 把它**整个丢掉了**
        // （客户端于是看不到「可重试」）⇒ 一并走 `sendErrorReceipt`（保留 details + 补 `Retry-After`）。
        sendErrorReceipt(response, error, 'seen_failed');
      }
      return;
    }
    if (request.method === 'POST' && match[2] === 'move') {
      try {
        await guardMove(sessionId, body);
      } catch (error) {
        sendErrorReceipt(response, error, 'move_guard_failed');
        return;
      }
    }
    if (request.method === 'POST' && match[2] === 'handoff') {
      try {
        await guardHandoff(sessionId, body);
      } catch (error) {
        sendErrorReceipt(response, error, 'handoff_guard_failed');
        return;
      }
    }
    const worker = await sessionRoute(sessionId);
    if (!worker) {
      sendNoGeneration(response);
      return;
    }
    const first = await proxyToWorker(request, response, worker, body);
    // owner 走了（socket RST/EPIPE，或它的 IPC 通道已关）：忘掉它。**只对幂等方法**（GET/HEAD）重试一次
    // —— 换当前代重开只需要读；写请求（POST…）绝不自动重试。具体口径见 `finishFailedProxy` 的注释
    //（兜底 proxy 那条入口与这里**共用同一个函数**）。
    await finishFailedProxy(request, response, body, first, 'owner route', sessionId);
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const worker = currentWorker();
  if (!worker?.child) {
    sendNoGeneration(response);
    return;
  }
  const proxied = await proxyToWorker(request, response, worker, body);
  // ⚠️ 通用兜底 proxy 那条入口（匹配不上 DELEGATION_PATH / SESSION_PATH 的路径）
  // 与 owner 路由**同一套口径**（同一个函数）：幂等方法（GET/HEAD）换当前代重试一次；
  // 写方法绝不自动重试、直接回可重试语义（集成/验收方 ④）。
  await finishFailedProxy(request, response, body, proxied, 'fallback proxy');
}

async function hostStatus() {
  const current = currentWorker();
  const currentStatus = await workerStatus(current);
  const draining = [];
  const workerDetails = [];
  let workerRssBytes = 0;
  let workerCount = 0;
  let workerHeapUsedBytes = 0;
  const sums = { hot: 0, cold: 0, active: 0, pinned: 0, loading: 0 };
  for (const worker of workers.values()) {
    if (!worker.child) continue;
    workerCount += 1;
    const status = worker.state === 'current' ? currentStatus : await workerStatus(worker);
    if (typeof status?.memory?.rss === 'number') workerRssBytes += status.memory.rss;
    if (typeof status?.memory?.heapUsed === 'number') workerHeapUsedBytes += status.memory.heapUsed;
    for (const key of Object.keys(sums)) {
      if (typeof status?.pool?.[key] === 'number') sums[key] += status.pool[key];
    }
    const ownedSessions = [...sessionOwners.entries()]
      .filter(([, owner]) => owner === worker.generationId)
      .map(([sessionId]) => sessionId);
    workerDetails.push({
      generationId: worker.generationId,
      pid: worker.pid,
      state: worker.state,
      startedAt: worker.startedAt,
      drainingAt: worker.drainingAt,
      exitedAt: worker.exitedAt,
      exitReason: worker.exitReason,
      logicVersion: worker.logicVersion,
      codeRevision: worker.codeRevision,
      rssBytes: status?.memory?.rss ?? null,
      heapUsedBytes: status?.memory?.heapUsed ?? null,
      hot: status?.pool?.hot ?? null,
      active: status?.pool?.active ?? null,
      sessions: ownedSessions,
      memoryPolicy: status?.memoryPolicy ?? null,
      statusError: status?.error ?? null,
    });
    if (worker.state === 'draining') {
      draining.push({
        generationId: worker.generationId,
        pid: worker.pid,
        state: worker.state,
        startedAt: worker.startedAt,
        drainingAt: worker.drainingAt,
        hot: status?.pool?.hot ?? null,
        active: status?.pool?.active ?? null,
        rssBytes: status?.memory?.rss ?? null,
        sessions: ownedSessions,
        // 「谁挡着这一代、为什么挡」——worker 自己报的运行级事实，宿主只原样透传（问不到就是 null）。
        busy: status?.drain?.busy ?? null,
        blockers: status?.drain?.blockers ?? null,
      });
    }
  }
  return {
    pid: process.pid,
    logicVersion: current?.logicVersion ?? null,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: process.uptime(),
    codeRevision: codeRevision.revision,
    codeRevisionCoverage: { covered: codeRevision.covered, files: codeRevision.files },
    generationLimit: MAX_GENERATIONS,
    currentGenerationId,
    currentWorkerPid: current?.pid ?? null,
    drainingGenerations: draining,
    workerCount,
    workerRssBytes,
    workerHeapUsedBytes,
    workerOldSpaceMiB,
    workerTotals: sums,
    lastReload,
    hostMemory: process.memoryUsage(),
    sessionsRoot: currentStatus?.sessionsRoot ?? null,
    memoryPolicy: currentStatus?.memoryPolicy ?? null,
    pool: currentStatus?.pool ?? null,
    workers: workerDetails,
  };
}

// 显式、非破坏的回收入口（辅助路）。为什么必须由宿主做：真正挡着换代的往往不是当前代，
// 而是那个已经在 draining 的代——只有宿主能对所有活着的代说话。
//   POST /reclaim {"dryRun":true}                 只报不收：每个代准备收谁、谁挡着、为什么
//   POST /reclaim {}                              收掉各代闲置 runtime
//   POST /reclaim {"sessionId":"<完整 uuid>"}      只谈这一条：闲置则收；在跑/收不了则 409
//   POST /reclaim {"includePinned":true}          连带收掉只有 SSE 订阅者那种「闲置」
// 收一条 runtime 不动会话文件（durable 是硬条件）：它下次被打开时从 JSONL 重建，历史不丢。
async function reclaimIdle(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const key of ['dryRun', 'includePinned']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      throw Object.assign(new Error(`${key} must be a boolean`), { statusCode: 400, code: 'invalid_reclaim' });
    }
  }
  let sessionId = null;
  if (body.sessionId !== undefined) {
    try {
      sessionId = requireFullUuid(String(body.sessionId));
    } catch (error) {
      throw Object.assign(new Error(error.message), { statusCode: 400, code: error.code ?? 'invalid_session_id' });
    }
  }
  const payload = { dryRun: body.dryRun === true, includePinned: body.includePinned === true, ...(sessionId === null ? {} : { sessionId }) };
  const targets = [...workers.values()].filter((worker) => worker.child !== null);
  if (targets.length === 0) {
    throw Object.assign(new Error('no live generation worker; POST /reload-code to start one'), { statusCode: 503, code: 'no_current_generation' });
  }
  const generations = await Promise.all(targets.map(async (worker) => {
    try {
      const reply = await callWorker(worker, { type: 'reclaim', input: payload }, { timeoutMs: 15_000 });
      // 宿主知道 worker 自己的代别（排空中的池把 currentGenerationId 指向下一代），所以身份字段由宿主定。
      return { ...reply.value, generationId: worker.generationId, pid: worker.pid, state: worker.state };
    } catch (error) {
      return {
        generationId: worker.generationId,
        pid: worker.pid,
        state: worker.state,
        error: error instanceof Error ? error.message : String(error),
        reclaimed: [],
        wouldReclaim: [],
        refused: [],
        skipped: [],
      };
    }
  }));
  const totals = { reclaimed: 0, wouldReclaim: 0, refused: 0, skipped: 0, generations: generations.length };
  for (const generation of generations) {
    totals.reclaimed += generation.reclaimed?.length ?? 0;
    totals.wouldReclaim += generation.wouldReclaim?.length ?? 0;
    totals.refused += generation.refused?.length ?? 0;
    totals.skipped += generation.skipped?.length ?? 0;
  }
  // 点名一条却在跑：如实拒（不是静默跳过）——运维追问「凭什么不收这条」时，答案就在 details 里。
  if (sessionId !== null && totals.reclaimed === 0 && totals.wouldReclaim === 0) {
    const [generation] = generations.filter((entry) => (entry.refused?.length ?? 0) > 0 || (entry.skipped?.length ?? 0) > 0);
    if (generation) {
      const entry = generation.refused?.[0] ?? generation.skipped?.[0];
      const reasons = entry.reasons ?? [entry.reason];
      const busy = reasons.some((reason) => ['in_flight_turn', 'pending_messages', 'queued_operations', 'acquired_leases'].includes(reason) || reason.startsWith('busy:'));
      throw Object.assign(
        new Error(busy
          ? `会话正在跑（${reasons.join(', ')}）；回收入口只收闲置 runtime，不碰在跑的回合`
          : `这条会话现在收不了：${reasons.join(', ')}`),
        {
          statusCode: 409,
          code: busy ? 'session_busy_reclaim' : 'session_not_reclaimable',
          details: { sessionId, generationId: generation.generationId, pid: generation.pid, state: generation.state, reasons, entry, generations },
        },
      );
    }
  }
  // 点名了一条、但它没住在任何活着的代里：这不是失败，是「没东西可收」—— 如实说出来，
  // 不假装收过。
  const note = sessionId !== null && totals.reclaimed === 0 && totals.wouldReclaim === 0 && totals.refused === 0 && totals.skipped === 0
    ? 'no live generation is holding this session (nothing to reclaim)'
    : null;
  return { ok: true, dryRun: payload.dryRun, includePinned: payload.includePinned, sessionId, note, totals, generations };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://host.local');
    if (request.method === 'GET' && url.pathname === '/host') {
      sendJson(response, 200, await hostStatus());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/reload-code') {
      request.resume();
      try {
        const result = await queueReload(() => reloadCode());
        sendJson(response, 200, { ...result, pid: process.pid });
      } catch (error) {
        const statusCode = error?.statusCode ?? 500;
        sendJson(response, statusCode, {
          pid: process.pid,
          error: error?.code ?? 'reload_failed',
          message: error instanceof Error ? error.message : String(error),
          ...(error?.details === undefined ? {} : { details: error.details }),
        });
      }
      return;
    }
    if (url.pathname === '/reclaim' && request.method !== 'POST') {
      request.resume();
      sendJson(response, 405, { error: 'method_not_allowed', message: `method ${request.method} is not allowed for /reclaim` });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/reclaim') {
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, { error: error?.code ?? 'invalid_body', message: error instanceof Error ? error.message : String(error) });
        return;
      }
      try {
        sendJson(response, 200, await reclaimIdle(body));
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, {
          pid: process.pid,
          error: error?.code ?? 'reclaim_failed',
          message: error instanceof Error ? error.message : String(error),
          ...(error?.details === undefined ? {} : { details: error.details }),
        });
      }
      return;
    }
    await routeRequest(request, response, url);
  } catch (error) {
    console.error('[base] request failed', error);
    if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    else response.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});

server.on('clientError', (error, socket) => {
  console.error('[base] client error', error);
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.on('error', (error) => {
  console.error(`[base] server error on ${host}:${port}`, error);
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[base] ${signal} received; stopping ${workers.size} generation worker(s)`);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    timer.unref?.();
    server.close(resolve);
  });
  server.closeIdleConnections();
  server.closeAllConnections();
  for (const worker of workers.values()) {
    // Mark first: the exit handler must not mistake a deliberate shutdown for a crash.
    worker.state = 'draining';
    worker.drainingAt = worker.drainingAt ?? new Date().toISOString();
  }
  await Promise.all([...workers.values()].map((worker) => drainWorker(worker, null, { terminateAfterMs: SHUTDOWN_DRAIN_KILL_MS })));
  await Promise.all([unreadWriteQueue, draftWriteQueue]);
  process.exit(unreadStoreError || draftStoreError ? 1 : 0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await startWorker('boot').then((worker) => {
  worker.state = 'current';
  currentGenerationId = worker.generationId;
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    event: 'listening',
    host,
    port,
    pid: process.pid,
    logicVersion: currentWorker()?.logicVersion ?? null,
    generationId: currentGenerationId,
    workerPid: currentWorker()?.pid ?? null,
  }));
});
