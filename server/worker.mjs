// S1b: the pi runtime pool now lives in a replaceable generation worker
// (docs/design-runtime-isolation.md §3). This is that worker. It owns the
// RuntimePool, the real pi adapter and the session/tree HTTP surface, and it is
// the only writer for the session files it has opened (single-writer rule), so
// every write-capable route arrives here through the stable host.
//
// The host is the only client: the server listens on 127.0.0.1 with an
// OS-assigned port and requires the token the host passed at spawn time. The
// host learns the port through the `ready` IPC message.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogic } from './base-logic.mjs';

const token = process.env.SOPHO_WORKER_TOKEN || randomUUID();
const generationId = process.env.SOPHO_WORKER_GENERATION || `g-${process.pid}`;
const logicVersion = process.env.SOPHO_WORKER_LOGIC_VERSION || generationId;
const codeRevision = process.env.SOPHO_WORKER_CODE_REVISION || null;

const openSockets = new Set();
const logic = createLogic({
  logicVersion,
  generationId,
  codeRevision,
  onRoute: (event) => process.send?.({ generationId, ...event }),
});

const server = http.createServer(handleRequest);
server.on('connection', (socket) => {
  openSockets.add(socket);
  socket.once('close', () => openSockets.delete(socket));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  // Port 0: the OS assigns a free loopback port, so sandboxes never collide.
  server.listen(0, '127.0.0.1', () => resolve(undefined));
});

process.send?.({
  type: 'ready',
  pid: process.pid,
  port: server.address().port,
  generationId,
  logicVersion,
  codeRevision,
});
console.log(JSON.stringify({ event: 'worker_ready', pid: process.pid, generationId, logicVersion, port: server.address().port }));

process.on('message', (message) => {
  void handleHostMessage(message).catch((error) => {
    process.send?.({ type: 'error', generationId, requestId: message?.requestId, message: error instanceof Error ? error.message : String(error), statusCode: error?.statusCode, code: error?.code, details: error?.details });
  });
});

async function handleHostMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'drain') {
    await logic.drainToGeneration(message.currentGenerationId ?? null);
    process.send?.({
      type: 'drain-ack',
      generationId,
      // Every request->answer ack must carry the requestId the host sent: the host's
      // callWorker only resolves on a reply whose requestId matches, so a drain-ack
      // without it made every drain look like a 30s timeout (host log:
      // "drain failed: worker ... did not answer drain in 30000ms").
      requestId: message.requestId,
      currentGenerationId: message.currentGenerationId ?? null,
      hot: logic.hotSessions().length,
    });
    scheduleDrainExit();
    return;
  }
  if (message.type === 'query') {
    const sessions = logic.hotSessions().map((session) => session.sessionId);
    const route = message.sessionId === undefined ? null : await logic.probeRoute(message.sessionId);
    process.send?.({ type: 'query-result', generationId, requestId: message.requestId, sessions, route });
    return;
  }
  if (message.type === 'live-facts') {
    const facts = await logic.liveSessionFacts();
    // `liveSessionFacts()` 现在回 `{facts, unavailable}`：`unavailable` 是「到点没答上来的 handle」
    // 的诚实名单（per-handle 死线，见 base-logic）。两条调用方各自按契约处理，不在这里吞掉。
    process.send?.({
      type: 'live-facts-result',
      generationId,
      requestId: message.requestId,
      facts: Array.isArray(facts) ? facts : facts.facts,
      unavailable: Array.isArray(facts?.unavailable) ? facts.unavailable : [],
    });
    return;
  }
  if (message.type === 'delegation-create') {
    const value = await logic.createDelegatedSession(message.input);
    process.send?.({ type: 'delegation-create-result', generationId, requestId: message.requestId, value });
    return;
  }
  if (message.type === 'delegation-message') {
    const value = await logic.deliverDelegationMessage(message.sessionId, message.input);
    process.send?.({ type: 'delegation-message-result', generationId, requestId: message.requestId, value });
    return;
  }
  if (message.type === 'delegation-read') {
    const value = await logic.delegationSessionRead(message.sessionId, message.lines);
    process.send?.({ type: 'delegation-read-result', generationId, requestId: message.requestId, value });
    return;
  }
  if (message.type === 'parent-fact') {
    const value = await logic.parentSessionFact(message.sessionId);
    process.send?.({ type: 'parent-fact-result', generationId, requestId: message.requestId, value });
    return;
  }
  if (message.type === 'reclaim') {
    const value = await logic.reclaimIdle(message.input);
    process.send?.({ type: 'reclaim-result', generationId, requestId: message.requestId, value });
    return;
  }
  if (message.type === 'shutdown') {
    await shutdown();
  }
}

// A draining worker exits on its own once it has no *busy* runtime left. An idle
// session that is only held open by an SSE subscriber is not busy: the subscriber
// reconnects to the new generation, so it must not keep this process alive (that is
// what forced the host to SIGTERM a generation mid-turn and lose the reply).
//
// The watcher must never give up. The host waits for this process's own lifecycle
// (`RELOAD_DRAIN_KILL_MS` is null by default: "a worker that still has a turn in flight
// is supposed to keep serving it"), so a watcher that stopped watching after its first
// deadline would leave the generation alive forever: the host would keep 409-ing every
// later `reload-code` even after every session on this generation had gone idle (that
// is the 2026-09-20 incident, see docs/handoff.md §generation worker). While it is still
// busy it re-reports the honest blocker list every SOPHO_DRAIN_STUCK_LOG_MS, so a stuck
// generation is visible instead of silent.
const drainStuckLogMs = (() => {
  const raw = process.env.SOPHO_DRAIN_STUCK_LOG_MS;
  if (raw === undefined || raw === '') return 10 * 60 * 1000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 100) throw new Error(`invalid SOPHO_DRAIN_STUCK_LOG_MS: ${raw}`);
  return value;
})();

async function scheduleDrainExit() {
  const watchingSince = Date.now();
  let nextReportAt = watchingSince + drainStuckLogMs;
  for (;;) {
    const busy = logic.drainBusy();
    if (busy.length === 0) break;
    if (Date.now() >= nextReportAt) {
      console.error(JSON.stringify({
        event: 'worker_drain_stuck',
        generationId,
        watchingSince: new Date(watchingSince).toISOString(),
        waitedMs: Date.now() - watchingSince,
        nextReportMs: drainStuckLogMs,
        live: logic.liveRuntimes(),
        busy: busy.map((record) => record.sessionId),
        blockers: logic.drainBlockers(),
      }));
      nextReportAt = Date.now() + drainStuckLogMs;
    }
    await delay(250);
  }
  process.send?.({ type: 'exiting', generationId, reason: 'drained', waitedMs: Date.now() - watchingSince });
  await shutdown();
}

async function handleRequest(request, response) {
  if (request.headers['x-sopho-worker-token'] !== token) {
    request.resume();
    sendJson(response, 403, { error: 'worker_token_required' });
    return;
  }
  const url = new URL(request.url || '/', 'http://worker.local');
  try {
    if (request.method === 'GET' && url.pathname === '/host') {
      request.resume();
      sendJson(response, 200, workerStatus());
      return;
    }
    const handled = await logic.handle(request, response);
    if (!handled && !response.headersSent) sendJson(response, 404, { error: 'not found' });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error(JSON.stringify({ event: 'worker_request_failed', generationId, path: url.pathname, error: failure.message }));
    if (!response.headersSent) sendJson(response, 500, { error: failure.message });
    else response.destroy(failure);
  }
}

function workerStatus() {
  const logicHost = typeof logic.getHostStatus === 'function' ? logic.getHostStatus() : {};
  return {
    pid: process.pid,
    generationId,
    logicVersion,
    codeRevision,
    memory: process.memoryUsage(),
    hotSessions: logic.hotSessions(),
    ...logicHost,
  };
}

async function shutdown() {
  const forced = setTimeout(() => process.exit(0), 5000);
  forced.unref?.();
  const closed = new Promise((resolve) => server.close(resolve));
  // End long-lived SSE responses first. `server.close` only resolves once every
  // connection is gone, so an open SSE subscriber otherwise hangs it until the forced
  // exit above and the client sees an abrupt disconnect. `logic.dispose` ends those
  // responses with a retryable `server.reload` and closes the pool.
  await logic.dispose?.();
  for (const socket of openSockets) socket.destroy();
  await closed;
  process.send?.({ type: 'exiting', generationId });
  process.exit(0);
}

function sendJson(response, statusCode, value) {
  if (response.destroyed || response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}
