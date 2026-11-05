#!/usr/bin/env node
// S1b acceptance: the runtime pool lives in replaceable generation workers
// (docs/design-runtime-isolation.md §3) and the host pid never changes.
//
// Cases (docs §5):
//   reload-bound  V1: 200 idle reloads; RSS(200) - RSS(20) < 64 MiB; never more
//                 than two generations; exactly one worker after each settles.
//   generation-stale
//                 V5: a controlled long turn in g1; reload to g2; a new session
//                 reports g2, the old session reports pluginStale/logicStale and
//                 finishes; the old runtime is reclaimed once settled; reopening
//                 lands in g2 with the same history, entry by entry; a reload while
//                 g1 is still draining returns 409 reload_blocked_by_draining_generation.
//   sse-open-inflight
//                 The blind spot generation-stale left: an SSE subscription stays OPEN
//                 across a reload while a slow turn is in flight. The turn must finish,
//                 the reply must be persisted to the session JSONL, no server.error may
//                 interrupt it, the still-open subscriber must not pin the draining
//                 generation until the host force-kills it, and the session must keep
//                 working afterwards. Red before the fix (the host SIGTERMed the
//                 generation mid-turn after ~95 s and the reply was lost).
//   idle-pinned  An idle durable session held open by an SSE subscriber must not pin the
//                draining generation either: the generation exits on its own, the
//                subscriber reconnects, and the session keeps working in the new one.
//   drain-idle-reclaim
//                2026-09-20 gap: a session parked on a draining generation used to be able
//                to block the swap *forever*. The worker's drain watcher stopped watching
//                after its first 10-minute deadline (one `worker_drain_stuck` line, then
//                nothing), so even after every session on that generation went idle the
//                process never exited -> the host's two-generation limit stayed full ->
//                every later /reload-code answered 409. This case pins the honest contract:
//                an idle runtime on the draining generation is reclaimed, a *running* one is
//                never reclaimed, `POST /reclaim` reports/reclaims only idle runtimes
//                (dry-run included), and the generation still exits once its work is done.
//   reclaim      The explicit, non-destructive reclaim entry on a healthy (non-draining)
//                generation: dry-run reports without touching, an idle runtime is reclaimed
//                and its history survives, a running turn is refused with 409 and finishes
//                normally, and a not-yet-durable session is refused honestly.
//   worker-reclaim
//                 V7: record the exact worker pid, terminate that pid, confirm it is
//                 gone from the process table, reopen (history intact) and see the
//                 total worker RSS come back.
//   crash       A current worker is SIGKILLed mid-turn: the host pid survives, the
//               client sees a terminal event (not silence), persisted entries stay,
//               and a reopen cold-starts in the replacement generation.
//
// Sandbox only: a copy home, a high random port, a local fake OpenAI-compatible
// provider. No real model, no litellm, never 7331/7321, and processes are killed by
// the exact pid we recorded (never by name).
//
// The host does not start `server/base.mjs` directly: it goes through
// `test/sandbox-guard.mjs`, which owns the sandbox's process group, dies when this
// harness's stdio disappears, and caps the sandbox lifetime. Without it a SIGKILLed
// harness (or any failing case) left a host and its generation workers running forever
// -- that is the 2026-09-18 incident, see docs/handoff.md §沙箱卫生.
//
// Usage:
//   node test/runtime-isolation.mjs --case all
//   node test/runtime-isolation.mjs --case reload-bound --reloads 200
//   node test/runtime-isolation.mjs --case generation-stale
//   node test/runtime-isolation.mjs --case sse-open-inflight
//   node test/runtime-isolation.mjs --case idle-pinned
//   node test/runtime-isolation.mjs --case drain-idle-reclaim
//   node test/runtime-isolation.mjs --case reclaim
//   node test/runtime-isolation.mjs --case worker-reclaim
//   node test/runtime-isolation.mjs --case crash
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finishCleanup, listenerPid, removeSandbox } from './harness.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1b-isolation-'));
const home = path.join(sandbox, 'home');
const workspace = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 's1b-base.log');

const MIB = 1024 * 1024;
const MAX_GENERATIONS = 2;
const RSS_GROWTH_LIMIT = 64 * MIB;
const guardEntry = path.join(sourceRoot, 'test', 'sandbox-guard.mjs');
// The sandbox guard's lifetime cap must never fire on a healthy run, and it must not be a
// guess. Measured on this machine (2026-09-18): one `/reload-code` costs at most 5085 ms
// (`lastReload.durationMs` in a full 200-reload run), so budget 8000 ms per reload plus a
// minute for start/stop, and cap at 2x that estimate -- the same "2x the observed worst case"
// convention the repo already uses for the 125 s Windows start-up limit. For the default
// 200 reloads that is 2 x (60 s + 1600 s) = 55.3 min; the whole `--case all` run measured
// 1101 s, so the cap sits at ~3x the real run.
const RELOAD_BUDGET_MS = 8000;
function sandboxLifetimeFor(reloads) {
  const fromEnv = Number(process.env.SOPHO_SANDBOX_LIFETIME_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const estimatedMs = 60_000 + Math.max(1, reloads) * RELOAD_BUDGET_MS;
  return Math.max(20 * 60 * 1000, estimatedMs * 2);
}

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function parseArgs(argv) {
  const options = { case: 'all', reloads: 200 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--case') options.case = argv[index + 1];
    else if (argv[index] === '--reloads') options.reloads = Number(argv[index + 1]);
    else if (argv[index].startsWith('--case=')) options.case = argv[index].slice('--case='.length);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

async function reserveHighPort() {
  for (let candidate = 44000 + Math.floor(Math.random() * 15000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321) continue;
    const available = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function exitOf(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function killPid(pid, signal) {
  // Exact pid only. Never a name or a glob.
  try { process.kill(pid, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

async function waitGone(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

async function json(port, method, pathname, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let value;
        try { value = text ? JSON.parse(text) : null; } catch { value = text; }
        resolve({ statusCode: response.statusCode, value, text, headers: response.headers });
      });
    });
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

// A connection refused while the host boots is normal, not a test failure.
async function tryJson(port, method, pathname, body) {
  try {
    return await json(port, method, pathname, body);
  } catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) return null;
    throw error;
  }
}

async function poll(label, operation, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function openSse(port, pathname) {
  const events = [];
  const waiters = new Set();
  let response;
  let buffer = '';
  let currentEvent = 'message';
  let currentData = [];
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: pathname,
    headers: { accept: 'text/event-stream' },
  });
  const connected = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (incoming) => {
      response = incoming;
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        buffer += chunk;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line === '') {
            if (currentData.length > 0) {
              const raw = currentData.join('\n');
              let data;
              try { data = JSON.parse(raw); } catch { data = raw; }
              events.push({ event: currentEvent, data });
              for (const waiter of [...waiters]) waiter();
            }
            currentEvent = 'message';
            currentData = [];
          } else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) currentData.push(line.slice(5).trimStart());
        }
      });
      incoming.on('error', () => {});
      resolve();
    });
    request.end();
  });

  function waitFor(predicate, timeoutMs = 20_000) {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`SSE wait timed out; events=${JSON.stringify(events.slice(-12))}`));
      }, timeoutMs);
      const check = () => {
        const value = events.find(predicate);
        if (!value) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(value);
      };
      waiters.add(check);
    });
  }

  return {
    connected,
    events,
    waitFor,
    close() {
      response?.destroy();
      request.destroy();
    },
  };
}

function usage() {
  return { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 };
}

function chunk(content, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-s1b',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(includeUsage ? { usage: usage() } : {}),
  };
}

function lastUserText(body) {
  for (let index = body.messages?.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part.text || '').join('');
  }
  return '';
}

// A fake provider with per-response plans: 'hold' streams a first chunk and waits
// until the test releases it (a controllable long turn); 'break' destroys the socket.
async function startFakeProvider(port) {
  const plans = [];
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    const plan = plans.shift() ?? { mode: 'normal', text: `reply:${lastUserText(body).slice(0, 60)}` };
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(plan.text))}\n\n`);
    plan.markStarted?.({ request: body, text: plan.text });
    request.socket.once('close', () => plan.markClosed?.());
    if (plan.mode === 'hold') await plan.released;
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify(chunk(null, 'stop', true))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    requests,
    plan(mode, text) {
      let releaseResolve;
      let startedResolve;
      let closedResolve;
      const plan = {
        mode,
        text,
        started: new Promise((resolve) => { startedResolve = resolve; }),
        released: new Promise((resolve) => { releaseResolve = resolve; }),
        closed: new Promise((resolve) => { closedResolve = resolve; }),
        markStarted: startedResolve,
        markClosed: closedResolve,
      };
      plan.release = () => releaseResolve?.();
      plans.push(plan);
      return plan;
    },
  };
}

async function startHost(basePort, extraEnv = {}) {
  const logHandle = await open(baseLogPath, 'a');
  const guard = spawn(process.execPath, [
    guardEntry,
    '--entry', path.join(sourceRoot, 'server', 'base.mjs'),
    '--label', `s1b-host-${basePort}`,
    '--lifetime-ms', String(sandboxLifetimeFor(options.reloads)),
    '--watch-stdin',
  ], {
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
      SOPHO_DEFAULT_CWD: workspace,
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '8',
      ...extraEnv,
    },
    // detached: the guard must outlive us so it can honour "same-life" when this harness
    // is SIGKILLed. stdin stays a pipe (`--watch-stdin`) and the IPC entry is the second
    // parent-death channel.
    stdio: ['pipe', logHandle.fd, logHandle.fd, 'ipc'],
    detached: true,
  });
  const exited = exitOf(guard);
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sandbox guard never reported sandbox-start')), 20_000);
    guard.on('message', (message) => {
      if (message?.type !== 'sandbox-start') return;
      clearTimeout(timer);
      resolve(message);
    });
    guard.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`sandbox guard exited before the host started (code=${code} signal=${signal})`));
    });
  });
  const host = await poll('host ready', () => tryJson(basePort, 'GET', '/host'), (response) => response?.statusCode === 200, 30_000);
  const runtime = { guard, hostPid: started.pid, exited, logHandle, host: host.value, port: basePort };
  // Say out loud what the guard was told: the lifetime cap is derived (see
  // sandboxLifetimeFor), and a number nobody can see is a number nobody can check.
  print('sandbox guard', { label: `s1b-host-${basePort}`, pid: started.pid, pgid: started.pgid, lifetimeMs: sandboxLifetimeFor(options.reloads), reloads: options.reloads, detached: true });
  // Registered so that a case which throws before its own stopHost() cannot leak the tree.
  hostRuntime = runtime;
  return runtime;
}

async function stopHost(runtime, basePort) {
  if (!runtime) return;
  const { guard, hostPid, exited, logHandle } = runtime;
  if (hostRuntime === runtime) hostRuntime = null;
  // Stop the host itself first, by exact pid, so it shuts its workers down gracefully.
  // The guard then sees its child exit and reaps anything the host left behind.
  if (processAlive(hostPid)) {
    await killPid(hostPid, 'SIGTERM');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && processAlive(hostPid)) await new Promise((resolve) => setTimeout(resolve, 50));
    if (processAlive(hostPid)) await killPid(hostPid, 'SIGKILL');
  }
  const guardExited = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 15_000))]);
  if (!guardExited && guard?.pid) {
    await killPid(guard.pid, 'SIGKILL');
    await exited;
  }
  await logHandle.close();
  const pid = await listenerPid(basePort);
  if (pid) throw new Error(`port ${basePort} still owned by pid ${pid} after shutdown`);
}

async function waitForSettledWorker(port, timeoutMs = 30_000) {
  return poll('settled worker', () => tryJson(port, 'GET', '/host'), (response) => response?.statusCode === 200
    && response.value.workerCount === 1
    && response.value.drainingGenerations.length === 0, timeoutMs);
}

function entryLines(text) {
  return text.split('\n').filter((line) => line.trim() !== '');
}

function entriesOf(text) {
  return entryLines(text).map((line) => JSON.parse(line));
}

async function findSessionFile(sessionId) {
  const { readdir } = await import('node:fs/promises');
  const found = await poll('session file', async () => {
    for (const name of await readdir(sessionsRoot)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(sessionsRoot, name);
      const first = entryLines(await readFile(file, 'utf8'))[0];
      if (!first) continue;
      try {
        if (JSON.parse(first).id === sessionId) return file;
      } catch {
        // A partially written file is skipped; it will be found on a later poll.
      }
    }
    return null;
  }, (value) => value !== null, 15_000);
  return found;
}

async function caseReloadBound(basePort) {
  const reloads = options.reloads;
  // The RSS baseline is sample 20, or the last sample when fewer were asked for: "--reloads 1"
  // used to crash on `samples[20].totalRss` (undefined), which made the cheap smoke form of
  // this case impossible.
  const baselineIndex = Math.min(20, reloads);
  const runtime = await startHost(basePort);
  const hostPid = runtime.host.pid;
  assert.equal(await listenerPid(basePort), hostPid);
  const samples = {};
  let peakWorkers = runtime.host.workerCount;
  let peakGenerations = 1;

  for (let index = 1; index <= reloads; index += 1) {
    const reload = await json(basePort, 'POST', '/reload-code');
    assert.equal(reload.statusCode, 200, `reload ${index} must succeed`);
    assert.equal(reload.value.pid, hostPid, 'host pid must not change');
    // Sample the switch window itself: the draining worker exists only between the
    // new worker becoming current and the old one exiting.
    const sampling = (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const sample = await tryJson(basePort, 'GET', '/host');
        if (sample?.statusCode === 200) {
          peakWorkers = Math.max(peakWorkers, sample.value.workerCount);
          peakGenerations = Math.max(peakGenerations, 1 + sample.value.drainingGenerations.length);
          if (sample.value.workerCount === 1 && sample.value.drainingGenerations.length === 0
            && sample.value.currentGenerationId === reload.value.generationId) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    })();
    await sampling;
    if (index === baselineIndex || index === reloads) {
      const settled = await waitForSettledWorker(basePort, 60_000);
      const value = settled.value;
      peakWorkers = Math.max(peakWorkers, value.workerCount);
      peakGenerations = Math.max(peakGenerations, 1 + value.drainingGenerations.length);
      samples[index] = {
        hostRss: value.hostMemory.rss,
        workerRss: value.workerRssBytes,
        totalRss: value.hostMemory.rss + value.workerRssBytes,
        workerCount: value.workerCount,
        generations: 1 + value.drainingGenerations.length,
      };
      print(`reload-bound sample ${index}`, samples[index]);
    } else if (index % 25 === 0) {
      print(`reload ${index}/${reloads}`, { logicVersion: reload.value.logicVersion });
    }
  }

  const growth = samples[reloads].totalRss - samples[baselineIndex].totalRss;
  const finalHost = await json(basePort, 'GET', '/host');
  print('reload-bound result', {
    reloads,
    baselineIndex,
    sample20: samples[baselineIndex],
    sampleLast: samples[reloads],
    growthBytes: growth,
    growthMiB: Number((growth / MIB).toFixed(2)),
    peakWorkers,
    peakGenerations,
    generationLimit: finalHost.value.generationLimit,
    hostPidUnchanged: finalHost.value.pid === hostPid,
    lastReload: finalHost.value.lastReload,
    workerCountAfterSettle: finalHost.value.workerCount,
  });
  assert.equal(finalHost.value.pid, hostPid, 'host pid unchanged after every reload');
  assert.equal(finalHost.value.workerCount, 1, 'exactly one worker after settle');
  assert.equal(finalHost.value.drainingGenerations.length, 0, 'no draining generation after settle');
  assert.equal(finalHost.value.generationLimit, MAX_GENERATIONS, 'generation limit is fixed at 2');
  assert.ok(peakGenerations <= MAX_GENERATIONS, `never more than ${MAX_GENERATIONS} generations (peak ${peakGenerations})`);
  assert.ok(growth < RSS_GROWTH_LIMIT, `RSS growth from sample ${baselineIndex} ${(growth / MIB).toFixed(2)} MiB must stay under 64 MiB`);
  assert.ok(finalHost.value.workerRssBytes > 0, 'workerRssBytes is a real measurement');
  await stopHost(runtime, basePort);
  return { growth, samples, peakGenerations };
}

async function createSession(basePort, name) {
  const created = await json(basePort, 'POST', '/sessions', { name });
  assert.equal(created.statusCode, 201);
  return created.value.id;
}

async function caseGenerationStale(basePort) {
  const runtime = await startHost(basePort);
  const hostPid = runtime.host.pid;
  const g1 = runtime.host.currentGenerationId;
  const workerPid1 = runtime.host.currentWorkerPid;
  const g1Session = await createSession(basePort, 'long turn in g1');
  print('generation-stale start', { hostPid, g1, workerPid1, g1Session });

  // 先跑一个普通回合让这个会话**落盘**：`/tree` 的底是磁盘投影（会话文件里的事实），
  // 一个还没跑完第一回合的会话根本没有树行 —— 而下面那条「旧代里的在跑事实必须进树」
  // 断言需要一个真实存在的树行作为前提。
  const warmPlan = provider.plan('normal', 'g1-durable-warm');
  assert.equal((await json(basePort, 'POST', `/sessions/${g1Session}/message`, { text: 'warm up in g1' })).statusCode, 202);
  await warmPlan.started;
  await poll('g1 session durable', () => json(basePort, 'GET', `/sessions/${g1Session}`), (response) => response.value.durable === true && response.value.runtime?.isStreaming === false, 20_000);

  const plan = provider.plan('hold', 'long-turn-alpha');
  // Subscribe before sending: a turn that starts before the subscription streams its
  // early deltas where nobody is listening (correct, but not what this case proves).
  const stream = openSse(basePort, `/sessions/${g1Session}/events`);
  await stream.connected;
  const accepted = await json(basePort, 'POST', `/sessions/${g1Session}/message`, { text: 'start the long turn' });
  assert.equal(accepted.statusCode, 202);
  await plan.started;
  await poll('g1 turn streaming', () => json(basePort, 'GET', `/sessions/${g1Session}`), (response) => response.value.runtime?.isStreaming === true, 15_000);
  await stream.waitFor((event) => event.event === 'session.start', 15_000);
  const delta = await stream.waitFor((event) => event.event === 'session.delta' && event.data.delta === 'long-turn-alpha', 15_000);
  print('g1 streaming delta', delta);

  const reload = await json(basePort, 'POST', '/reload-code');
  assert.equal(reload.statusCode, 200);
  assert.equal(reload.value.pid, hostPid);
  const g2 = reload.value.generationId;
  assert.notEqual(g2, g1);
  print('reloaded while g1 is active', { previous: reload.value.previousLogicVersion, current: reload.value.logicVersion });

  const draining = await json(basePort, 'GET', '/host');
  print('draining snapshot while g1 turn runs', {
    currentGenerationId: draining.value.currentGenerationId,
    workerCount: draining.value.workerCount,
    draining: draining.value.drainingGenerations,
  });
  assert.equal(draining.value.drainingGenerations.length, 1, 'g1 must be draining, not gone');
  assert.equal(draining.value.drainingGenerations[0].generationId, g1);

  // V5: while g1 is undrained, another reload must be refused as-is.
  const blocked = await json(basePort, 'POST', '/reload-code');
  print('second reload while draining raw response', { statusCode: blocked.statusCode, body: blocked.value });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.value.error, 'reload_blocked_by_draining_generation');
  const afterBlocked = await json(basePort, 'GET', '/host');
  assert.equal(afterBlocked.value.currentGenerationId, g2, 'blocked reload must not create a third generation');
  assert.equal(afterBlocked.value.workerCount, 2, 'exactly current + draining after a blocked reload');

  // A brand new session must land in g2 even while g1 drains.
  const freshSession = await createSession(basePort, 'fresh in g2');
  const freshDetail = await json(basePort, 'GET', `/sessions/${freshSession}`);
  assert.equal(freshDetail.value.generationId, g2);
  assert.equal(freshDetail.value.pluginStale, false, 'a new session in g2 is not stale');

  // The old session must keep serving and report honest stale flags.
  const staleDetail = await json(basePort, 'GET', `/sessions/${g1Session}`);
  print('g1 session honest fields', {
    generationId: staleDetail.value.generationId,
    currentGenerationId: staleDetail.value.currentGenerationId,
    pluginStale: staleDetail.value.pluginStale,
    logicStale: staleDetail.value.logicStale,
    staleReason: staleDetail.value.staleReason,
    workerPid: staleDetail.value.workerPid,
    owner: staleDetail.value.owner,
  });
  assert.equal(staleDetail.value.generationId, g1);
  assert.equal(staleDetail.value.pluginStale, true);
  assert.equal(staleDetail.value.logicStale, true);
  assert.match(String(staleDetail.value.staleReason), /g-/);

  // `/tree` 是**投影**：旧代里还在跑的长回合必须在树里报「在跑」。这条曾经是假的 ——
  // 当前代的 `/tree` 只覆盖自己池子里的 runtime（treeRecords 走 pool.listSessions()），
  // 停在旧代上的会话落到盘上的默认值 ⇒ 明明 isStreaming=true，树里却显示「闲置」。
  // 状态聚合归宿主（server/base.mjs 的 overlayWorkingStatus + drainingRunningSessionIds）。
  const drainTree = await json(basePort, 'GET', '/tree');
  const drainRow = drainTree.value.sessions.find((session) => session.id === g1Session);
  print('tree row while g1 drains', { id: g1Session, status: drainRow?.status, statusLabel: drainRow?.statusLabel, unread: drainRow?.unread, isStreaming: staleDetail.value.runtime?.isStreaming });
  assert.ok(drainRow, 'the draining session must still be a row of /tree');
  assert.equal(drainRow.status, 'working', `a session running on the draining generation must report working, got ${drainRow.status}`);
  assert.equal(drainRow.statusLabel, '工作中');
  // 反向：谁没在跑就不能被标成在跑（树里此刻只有这条长回合）。
  assert.deepEqual(drainTree.value.sessions.filter((session) => session.status === 'working').map((session) => session.id), [g1Session]);

  // Let the long turn finish and watch it stream to the end over the same SSE.
  plan.release();
  const end = await stream.waitFor((event) => event.event === 'session.end' && event.data.text === 'long-turn-alpha', 30_000);
  assert.equal(end.data.stopReason, 'stop');
  print('g1 long turn finished on the draining worker', end.data);
  const g1Messages = await json(basePort, 'GET', `/sessions/${g1Session}/messages`);
  const g1Texts = g1Messages.value.messages.map((message) => message.text);
  assert.ok(g1Texts.includes('long-turn-alpha'), 'the finished turn is in g1 history');
  stream.close();

  // Settled: the stale runtime is reclaimed and g1's worker exits.
  const settled = await waitForSettledWorker(basePort, 60_000);
  print('after settle', { workerCount: settled.value.workerCount, draining: settled.value.drainingGenerations, currentWorkerPid: settled.value.currentWorkerPid, workerRssBytes: settled.value.workerRssBytes });
  assert.equal(settled.value.workerCount, 1, 'g1 worker must exit after its sessions settled and were reclaimed');
  assert.ok(await waitGone(workerPid1, 15_000), `old worker pid ${workerPid1} must be gone`);

  // Reopen: the session lands in g2 with the same history, entry by entry.
  // ⚠️ 用一条**会 acquire** 的路来重新打开（`/commands`）：`GET /sessions/{id}`（看详情）**不再建 runtime**，
  // 所以它自身不会把会话放进 g2 —— 它报的 generationId 是「真正拥有它那一代」的事实。
  const reopen = await json(basePort, 'GET', `/sessions/${g1Session}/commands`);
  assert.equal(reopen.statusCode, 200, reopen.raw);
  const reopened = await poll('reopen in g2', () => json(basePort, 'GET', `/sessions/${g1Session}`), (response) => response.value.generationId === g2, 15_000);
  print('reopened in g2', { generationId: reopened.value.generationId, pluginStale: reopened.value.pluginStale, restoreCount: reopened.value.restoreCount, workerPid: reopened.value.workerPid });
  assert.equal(reopened.value.pluginStale, false);
  assert.notEqual(reopened.value.workerPid, workerPid1);
  assert.equal(reopen.statusCode, 200, reopen.raw);

  const beforeFile = await readFile(await findSessionFile(g1Session), 'utf8');
  const afterMessages = await json(basePort, 'GET', `/sessions/${g1Session}/messages`);
  const beforeEntries = entriesOf(beforeFile).filter((entry) => entry.type === 'message');
  const afterEntries = afterMessages.value.messages;
  print('history comparison', { fileMessages: beforeEntries.length, apiMessages: afterEntries.length, firstId: afterEntries[0]?.entryId, lastId: afterEntries.at(-1)?.entryId });
  assert.equal(afterEntries.length, beforeEntries.length, 'history entry count is stable across generations');
  assert.deepEqual(afterEntries.map((message) => message.entryId), beforeEntries.map((entry) => entry.id));
  assert.deepEqual(afterEntries.map((message) => message.text), beforeEntries.map((entry) => entry.message?.content?.[0]?.text ?? ''));

  await stopHost(runtime, basePort);
  return { g1, g2, staleFlags: { pluginStale: staleDetail.value.pluginStale, logicStale: staleDetail.value.logicStale } };
}

// The blind spot `generation-stale` left open: that case closes its SSE stream right
// after the turn, so it only ever proved "the pin is released -> the worker drains".
// Here the subscription stays OPEN across the reload and the whole (long) turn, which is
// what a browser tab does. The old code then pinned g1 forever and the host force-killed
// it after ~95 s, destroying the in-flight reply. The hold is deliberately longer than
// that old teardown cascade, so this case is red on the unfixed code and green once the
// reply survives.
const SSE_OPEN_SLOW_TURN_MS = Number.isFinite(Number(process.env.SOPHO_TEST_SLOW_TURN_MS))
  ? Math.max(1000, Number(process.env.SOPHO_TEST_SLOW_TURN_MS))
  : 110_000;

async function caseSseOpenInflight(basePort) {
  const runtime = await startHost(basePort);
  const hostPid = runtime.host.pid;
  const g1 = runtime.host.currentGenerationId;
  const workerPid1 = runtime.host.currentWorkerPid;
  const sessionId = await createSession(basePort, 'sse-open slow turn');
  print('sse-open start', { hostPid, g1, workerPid1, sessionId, holdMs: SSE_OPEN_SLOW_TURN_MS });

  // Warm up first so the session is durable (has a file) before the slow turn; a session
  // with no completed turn yet can lose the whole file, which is a different failure.
  const warm = provider.plan('normal', 'warm-sse-open');
  assert.equal((await json(basePort, 'POST', `/sessions/${sessionId}/message`, { text: 'warm up' })).statusCode, 202);
  await warm.started;
  await poll('warm turn durable', () => json(basePort, 'GET', `/sessions/${sessionId}`), (response) => response.value.durable === true && response.value.runtime?.isStreaming === false, 20_000);

  // Open the subscriber and DO NOT close it until the very end.
  const stream = openSse(basePort, `/sessions/${sessionId}/events`);
  await stream.connected;

  const marker = `sse-open-${randomUUID().slice(0, 6)}`;
  const plan = provider.plan('hold', marker);
  assert.equal((await json(basePort, 'POST', `/sessions/${sessionId}/message`, { text: `start ${marker}` })).statusCode, 202);
  await plan.started;
  await poll('slow turn streaming', () => json(basePort, 'GET', `/sessions/${sessionId}`), (response) => response.value.runtime?.isStreaming === true, 15_000);
  await stream.waitFor((event) => event.event === 'session.start', 15_000);
  await stream.waitFor((event) => event.event === 'session.delta' && event.data.delta === marker, 15_000);

  const reloadAt = Date.now();
  const reload = await json(basePort, 'POST', '/reload-code');
  assert.equal(reload.statusCode, 200, reload.raw);
  assert.equal(reload.value.pid, hostPid, 'reload must not change the host pid');
  const g2 = reload.value.generationId;
  assert.notEqual(g2, g1);
  print('sse-open reload while the slow turn runs', { g1, g2, reloadMs: Date.now() - reloadAt, previous: reload.value.previousLogicVersion, current: reload.value.logicVersion });

  // The draining generation still owns the running session and must keep serving it.
  const during = await json(basePort, 'GET', `/sessions/${sessionId}`);
  print('sse-open session during drain', { generationId: during.value.generationId, workerPid: during.value.workerPid, isStreaming: during.value.runtime?.isStreaming, pinReasons: during.value.pinReasons });
  assert.equal(during.value.generationId, g1, 'the in-flight session stays on the draining generation');
  assert.equal(during.value.runtime?.isStreaming, true, 'the turn is still streaming on the draining generation');

  // Hold past the old ~95 s teardown cascade, then let the turn finish.
  await new Promise((resolve) => setTimeout(resolve, SSE_OPEN_SLOW_TURN_MS));
  print('sse-open releasing the slow turn', { atMs: Date.now() - reloadAt, oldWorkerAlive: processAlive(workerPid1) });
  plan.release();

  // The turn must end normally: a real session.end, never a server.error cutting it off.
  const terminal = await stream.waitFor((event) => event.event === 'session.end' || event.event === 'server.error', 60_000);
  const errors = stream.events.filter((event) => event.event === 'server.error');
  const endIndex = stream.events.findIndex((event) => event.event === 'session.end' && event.data?.text === marker);
  const erroredBeforeEnd = stream.events.some((event, index) => event.event === 'server.error' && (endIndex === -1 || index < endIndex));

  // ② the reply must be persisted in the session JSONL (not just streamed).
  const sessionFile = await findSessionFile(sessionId);
  const rawFile = await readFile(sessionFile, 'utf8');
  const assistantReply = entriesOf(rawFile)
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .map((entry) => Array.isArray(entry.message?.content) ? entry.message.content.map((part) => part.text ?? '').join('') : '');
  print('sse-open terminal event', { terminal, serverErrors: errors, persistedAssistantReplies: assistantReply });

  assert.equal(erroredBeforeEnd, false, 'no server.error may interrupt the in-flight turn');
  assert.equal(terminal.event, 'session.end', `the long turn must end normally, got ${terminal.event}: ${JSON.stringify(terminal.data)}`);
  assert.equal(terminal.data.text, marker, 'the finished turn carries the full reply');
  assert.equal(terminal.data.stopReason, 'stop');
  print('sse-open persisted assistant replies', { sessionFile: path.basename(sessionFile), assistantReply });
  assert.ok(assistantReply.includes(marker), 'the assistant reply is persisted to the session JSONL');

  // The still-open subscriber must no longer pin the draining generation: it exits on its own.
  const settled = await waitForSettledWorker(basePort, 60_000);
  print('sse-open after settle', { workerCount: settled.value.workerCount, draining: settled.value.drainingGenerations, currentWorkerPid: settled.value.currentWorkerPid });
  assert.equal(settled.value.workerCount, 1, 'the draining generation must exit on its own while the SSE subscriber is still open');
  assert.equal(settled.value.drainingGenerations.length, 0);
  assert.ok(await waitGone(workerPid1, 15_000), `old worker pid ${workerPid1} must be gone`);
  assert.equal(errors.length, 0, `no server.error at all, got ${JSON.stringify(errors)}`);

  // ④ the session keeps working after the generation switch.
  stream.close();
  const after = provider.plan('normal', `alive-${marker}`);
  const again = await json(basePort, 'POST', `/sessions/${sessionId}/message`, { text: `are you alive ${marker}` });
  assert.equal(again.statusCode, 202, again.raw);
  await after.started;
  const continued = await poll('session continues', () => json(basePort, 'GET', `/sessions/${sessionId}/messages`), (response) => response.value.messages?.some((message) => message.text === `alive-${marker}`), 30_000);
  const texts = continued.value.messages.map((message) => message.text);
  print('sse-open session continues', { generationId: (await json(basePort, 'GET', `/sessions/${sessionId}`)).value.generationId, texts: texts.slice(-3) });
  assert.ok(texts.includes(marker), 'the earlier reply is still in history');

  await stopHost(runtime, basePort);
  return { g1, g2, holdMs: SSE_OPEN_SLOW_TURN_MS, terminalEvent: terminal.event, oldWorkerPid: workerPid1 };
}

async function caseIdlePinned(basePort) {
  const runtime = await startHost(basePort);
  const hostPid = runtime.host.pid;
  const g1 = runtime.host.currentGenerationId;
  const workerPid1 = runtime.host.currentWorkerPid;
  const sessionId = await createSession(basePort, 'idle pinned');

  const warm = provider.plan('normal', 'warm-idle-pinned');
  assert.equal((await json(basePort, 'POST', `/sessions/${sessionId}/message`, { text: 'warm up' })).statusCode, 202);
  await warm.started;
  await poll('idle durable', () => json(basePort, 'GET', `/sessions/${sessionId}`), (response) => response.value.durable === true && response.value.runtime?.isStreaming === false, 20_000);

  // The browser tab is open on a session that is idle at reload time. It must not pin g1.
  const stream = openSse(basePort, `/sessions/${sessionId}/events`);
  await stream.connected;
  await stream.waitFor((event) => event.event === 'session.snapshot', 15_000);

  const reloadAt = Date.now();
  const reload = await json(basePort, 'POST', '/reload-code');
  assert.equal(reload.statusCode, 200, reload.raw);
  assert.equal(reload.value.pid, hostPid);
  const g2 = reload.value.generationId;
  assert.notEqual(g2, g1);

  const settled = await waitForSettledWorker(basePort, 60_000);
  print('idle-pinned settled', { elapsedMs: Date.now() - reloadAt, workerCount: settled.value.workerCount, draining: settled.value.drainingGenerations, currentWorkerPid: settled.value.currentWorkerPid, sseEvents: stream.events.map((event) => event.event) });
  assert.equal(settled.value.workerCount, 1, 'an idle session held open by an SSE subscriber must not pin the draining generation');
  assert.equal(settled.value.drainingGenerations.length, 0);
  assert.ok(await waitGone(workerPid1, 15_000), `old worker pid ${workerPid1} must be gone`);
  const errors = stream.events.filter((event) => event.event === 'server.error');
  assert.equal(errors.length, 0, `no server.error on the subscriber, got ${JSON.stringify(errors)}`);
  stream.close();

  // It keeps working in the new generation.
  const after = provider.plan('normal', 'alive-idle-pinned');
  assert.equal((await json(basePort, 'POST', `/sessions/${sessionId}/message`, { text: 'still there?' })).statusCode, 202);
  await after.started;
  const messages = await poll('idle-pinned continues', () => json(basePort, 'GET', `/sessions/${sessionId}/messages`), (response) => response.value.messages?.some((message) => message.text === 'alive-idle-pinned'), 30_000);
  print('idle-pinned session continues', { generationId: (await json(basePort, 'GET', `/sessions/${sessionId}`)).value.generationId, texts: messages.value.messages.slice(-2).map((message) => message.text) });

  await stopHost(runtime, basePort);
  return { g1, g2, workerPid1 };
}

async function caseWorkerReclaim(basePort) {
  const runtime = await startHost(basePort);
  const hostPid = runtime.host.pid;
  const sessionId = await createSession(basePort, 'durable idle session');
  // Send one turn so the session is durable (a session file exists and covers the leaf).
  const plan = provider.plan('normal', 'durable-one');
  assert.equal((await json(basePort, 'POST', `/sessions/${sessionId}/message`, { text: 'make me durable' })).statusCode, 202);
  await plan.started;
  await poll('turn done', () => json(basePort, 'GET', `/sessions/${sessionId}`), (response) => response.value.runtime?.isStreaming === false && response.value.durable === true, 20_000);

  const before = await json(basePort, 'GET', '/host');
  const workerPid = before.value.currentWorkerPid;
  const beforeRss = before.value.hostMemory.rss + before.value.workerRssBytes;
  print('worker-reclaim before', { hostPid, workerPid, workerCount: before.value.workerCount, totalRss: beforeRss });
  assert.ok(workerPid > 0);
  assert.ok(processAlive(workerPid));

  const sessionFile = await findSessionFile(sessionId);
  const beforeFile = await readFile(sessionFile, 'utf8');
  const beforeCount = entryLines(beforeFile).length;

  await killPid(workerPid, 'SIGKILL');
  assert.ok(await waitGone(workerPid, 10_000), `worker pid ${workerPid} must be gone from the process table`);
  print('worker killed by exact pid', { workerPid, goneFromProcessTable: true });

  const recovered = await poll('replacement worker', () => tryJson(basePort, 'GET', '/host'), (response) => response?.statusCode === 200
    && response.value.workerCount === 1
    && response.value.currentWorkerPid !== null
    && response.value.currentWorkerPid !== workerPid, 30_000);
  assert.equal(recovered.value.pid, hostPid, 'host pid survives a worker kill');
  print('replacement worker', { currentWorkerPid: recovered.value.currentWorkerPid, currentGenerationId: recovered.value.currentGenerationId, workerRssBytes: recovered.value.workerRssBytes });

  const reopened = await json(basePort, 'GET', `/sessions/${sessionId}`);
  assert.equal(reopened.statusCode, 200);
  const messages = await json(basePort, 'GET', `/sessions/${sessionId}/messages`);
  assert.ok(messages.value.messages.some((message) => message.text === 'durable-one'), 'history is not lost');
  const afterFile = await readFile(sessionFile, 'utf8');
  const afterCount = entryLines(afterFile).length;
  const afterRss = recovered.value.hostMemory.rss + recovered.value.workerRssBytes;
  print('worker-reclaim after', {
    workerPid: recovered.value.currentWorkerPid,
    workerGeneration: reopened.value.generationId,
    pluginStale: reopened.value.pluginStale,
    fileLinesBefore: beforeCount,
    fileLinesAfter: afterCount,
    totalRssBefore: beforeRss,
    totalRssAfter: afterRss,
  });
  assert.equal(afterCount, beforeCount, 'reopening must not rewrite history');
  assert.ok(afterRss < MIB * 600, 'total RSS stays in the same order of magnitude after reclaim');

  await stopHost(runtime, basePort);
  return { workerPid, totalRssBefore: beforeRss, totalRssAfter: afterRss };
}

async function caseCrash(basePort) {
  const runtime = await startHost(basePort);
  const hostPid = runtime.host.pid;
  const sessionId = await createSession(basePort, 'crash mid-turn');
  // One completed turn first, so "persisted entries survive" is actually testable.
  const firstPlan = provider.plan('normal', 'persisted-before-crash');
  assert.equal((await json(basePort, 'POST', `/sessions/${sessionId}/message`, { text: 'first turn' })).statusCode, 202);
  await firstPlan.started;
  await poll('first turn durable', () => json(basePort, 'GET', `/sessions/${sessionId}`), (response) => response.value.runtime?.isStreaming === false && response.value.durable === true, 20_000);

  const stream = openSse(basePort, `/sessions/${sessionId}/events`);
  await stream.connected;
  const plan = provider.plan('hold', 'crash-partial');
  assert.equal((await json(basePort, 'POST', `/sessions/${sessionId}/message`, { text: 'crash this turn' })).statusCode, 202);
  await plan.started;
  await stream.waitFor((event) => event.event === 'session.delta' && event.data.delta === 'crash-partial', 15_000);

  const before = await json(basePort, 'GET', '/host');
  const workerPid = before.value.currentWorkerPid;
  const fileBeforeCrash = await readFile(await findSessionFile(sessionId), 'utf8');
  await killPid(workerPid, 'SIGKILL');
  assert.ok(await waitGone(workerPid, 10_000));

  // The client must see a terminal event (honest error), not silence.
  const terminal = await stream.waitFor((event) => event.event === 'session.end' || event.event === 'server.error', 25_000);
  print('crash client view', terminal);
  stream.close();

  const recovered = await poll('replacement after crash', () => tryJson(basePort, 'GET', '/host'), (response) => response?.statusCode === 200
    && response.value.workerCount === 1
    && response.value.currentWorkerPid !== null
    && response.value.currentWorkerPid !== workerPid, 30_000);
  assert.equal(recovered.value.pid, hostPid, 'host pid survives a mid-turn worker crash');
  const file = await findSessionFile(sessionId);
  const lines = entryLines(await readFile(file, 'utf8'));
  let parseFailures = 0;
  for (const line of lines) {
    try { JSON.parse(line); } catch { parseFailures += 1; }
  }
  const messages = await json(basePort, 'GET', `/sessions/${sessionId}/messages`);
  const survived = messages.value.messages.some((message) => message.text === 'persisted-before-crash');
  print('crash recovery', {
    crashedWorkerPid: workerPid,
    replacementWorkerPid: recovered.value.currentWorkerPid,
    replacementGenerationId: recovered.value.currentGenerationId,
    fileLinesBeforeCrash: entryLines(fileBeforeCrash).length,
    persistedLines: lines.length,
    jsonlParseFailures: parseFailures,
    completedTurnSurvived: survived,
    terminalEvent: terminal.event,
    terminals: messages.value.messages.map((message) => message.text),
  });
  assert.equal(parseFailures, 0, 'every persisted line must stay parseable');
  assert.ok(survived, 'entries written before the crash must survive the reopen');
  assert.notEqual(recovered.value.currentGenerationId, before.value.currentGenerationId);
  // The interrupted turn is honestly not claimed as persisted: no fabricated reply.
  assert.ok(!messages.value.messages.some((message) => message.text === 'crash-partial'), 'an in-flight turn is not silently persisted');
  await stopHost(runtime, basePort);
  return { workerPid, terminalEvent: terminal.event, completedTurnSurvived: survived };
}

// ── 2026-09-20：停在 draining 代上的会话曾经能把换代**永久**挡住 ───────────────────────────
//
// 现场（arcsopho 7331，报告里有原始输出）：`g-…-1` 自 14:32:49Z 起 draining，会话不走；worker 日志里
// `worker_drain_stuck` **只打过一次**（10 分钟到点即放弃），可那一代直到 6 小时后还活着 —— 于是
// 「一次只允许一个 drain」的守卫把后续每一次 `reload-code` 都拒成 409。
//
// 因此这里钉的是**两件分开的事实**：
//   ① 闲置的 runtime 照常被收（判据是运行级事实，不是「有 hot 条目」）；
//   ② 在跑的 runtime 一条都不收；且这一代**空载后必须真的退出**、下一次 reload 不再 409。
// 沙箱尺度：把 idleTTL 与「drain 还在忙时多久重报一次」都调小，让这两条能在秒级量到。
const DRAIN_IDLE_TTL_MS = 900;
const DRAIN_STUCK_LOG_MS = 700;

async function logSize() {
  return (await stat(baseLogPath).catch(() => ({ size: 0 }))).size;
}

async function waitForLog(pattern, fromOffset, timeoutMs = 15_000, label = 'log line') {
  const deadline = Date.now() + timeoutMs;
  let tail = '';
  while (Date.now() < deadline) {
    const text = await readFile(baseLogPath, 'utf8').catch(() => '');
    tail = text.slice(fromOffset);
    const line = tail.split('\n').find((entry) => pattern.test(entry));
    if (line) return line;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out; tail=${tail.slice(-1500)}`);
}

async function logLinesMatching(pattern, fromOffset) {
  const text = await readFile(baseLogPath, 'utf8').catch(() => '');
  return text.slice(fromOffset).split('\n').filter((entry) => pattern.test(entry));
}

function generationReport(response, generationId) {
  return response.value?.generations?.find((entry) => entry.generationId === generationId) ?? null;
}

async function warmTurn(basePort, sessionId, text) {
  const plan = provider.plan('normal', text);
  const response = await json(basePort, 'POST', `/sessions/${sessionId}/message`, { text });
  assert.equal(response.statusCode, 202, `warm turn must be accepted: ${response.text}`);
  await plan.started;
  return poll('warm session durable and idle', () => json(basePort, 'GET', `/sessions/${sessionId}`),
    (detail) => detail.value.durable === true && detail.value.runtime?.isStreaming === false, 20_000);
}

async function caseDrainIdleReclaim(basePort) {
  const runtime = await startHost(basePort, {
    SOPHO_IDLE_TTL_MS: String(DRAIN_IDLE_TTL_MS),
    SOPHO_DRAIN_STUCK_LOG_MS: String(DRAIN_STUCK_LOG_MS),
  });
  const hostPid = runtime.host.pid;
  const g1 = runtime.host.currentGenerationId;
  const workerPid1 = runtime.host.currentWorkerPid;
  print('drain-idle-reclaim start', { hostPid, g1, workerPid1, idleTTLms: DRAIN_IDLE_TTL_MS, drainStuckLogMs: DRAIN_STUCK_LOG_MS });

  // 三形状摆在一代上：(A) 搁着不管的闲置会话、(B) 挂着网页订阅者的闲置会话、
  // (C) 真在跑的一条长回合（反向臂：它一条都不许被收）。
  const idleSession = await createSession(basePort, 'idle parked on g1');
  await warmTurn(basePort, idleSession, 'warm-idle-parked');
  const watchedSession = await createSession(basePort, 'idle watched on g1');
  await warmTurn(basePort, watchedSession, 'warm-idle-watched');
  const stream = openSse(basePort, `/sessions/${watchedSession}/events`);
  await stream.connected;
  await stream.waitFor((event) => event.event === 'session.snapshot', 15_000);
  const runningSession = await createSession(basePort, 'running on g1');
  await warmTurn(basePort, runningSession, 'warm-running');
  const hold = provider.plan('hold', 'still-running-on-g1');
  assert.equal((await json(basePort, 'POST', `/sessions/${runningSession}/message`, { text: 'start the long turn' })).statusCode, 202);
  await hold.started;
  await poll('running turn streaming', () => json(basePort, 'GET', `/sessions/${runningSession}`), (detail) => detail.value.runtime?.isStreaming === true, 15_000);
  const before = await json(basePort, 'GET', `/sessions/${idleSession}`);
  const watchedBefore = await json(basePort, 'GET', `/sessions/${watchedSession}`);
  print('drain-idle-reclaim before reload', {
    idle: { runtimeState: before.value.runtimeState, generationId: before.value.generationId, evictionEligible: before.value.evictionEligible },
    watched: { runtimeState: watchedBefore.value.runtimeState, pinReasons: watchedBefore.value.pinReasons, evictionEligible: watchedBefore.value.evictionEligible },
  });
  assert.equal(before.value.generationId, g1);
  assert.equal(watchedBefore.value.runtimeState, 'hotIdle');
  assert.ok(watchedBefore.value.pinReasons.length > 0, 'the SSE subscriber must really pin the runtime');

  const logFrom = await logSize();
  const reload = await json(basePort, 'POST', '/reload-code');
  assert.equal(reload.statusCode, 200, reload.text);
  assert.equal(reload.value.pid, hostPid);
  const g2 = reload.value.generationId;
  assert.notEqual(g2, g1);

  // ① 闲置那条照常被收：判据是运行级事实（这条没有回合在跑），不是「它还在 hot 名单里」。
  const cold = await poll('idle runtime reclaimed on the draining generation', () => json(basePort, 'GET', `/sessions/${idleSession}`),
    (detail) => detail.value.runtimeState === 'cold' && detail.value.generationId === null && detail.value.runtime?.isStreaming === false, 20_000);
  print('idle runtime reclaimed while g1 drains', {
    sessionId: idleSession, runtimeState: cold.value.runtimeState, generationId: cold.value.generationId,
    lastEvictionReason: cold.value.lastEvictionReason, lastEvictedAt: cold.value.lastEvictedAt, evictionEligible: cold.value.evictionEligible,
  });
  assert.ok(['ttl', 'stale_generation'].includes(cold.value.lastEvictionReason), `idle reclamation must be an idle rule, got ${cold.value.lastEvictionReason}`);

  // ③ 反向臂：长回合还在跑，就一条也不许收（运行级事实 isStreaming=true，而不是名单上有它）。
  const stillRunning = await json(basePort, 'GET', `/sessions/${runningSession}`);
  print('running session after the swap', {
    sessionId: runningSession, generationId: stillRunning.value.generationId, runtimeState: stillRunning.value.runtimeState,
    isStreaming: stillRunning.value.runtime?.isStreaming, evictionEligible: stillRunning.value.evictionEligible, workerPid: stillRunning.value.workerPid,
  });
  assert.equal(stillRunning.value.generationId, g1, 'an in-flight turn stays on the draining generation');
  assert.equal(stillRunning.value.runtimeState, 'hotActive');
  assert.equal(stillRunning.value.runtime?.isStreaming, true);
  assert.equal(stillRunning.value.evictionEligible, false);
  assert.equal(stillRunning.value.workerPid, workerPid1);

  // ② 挂着订阅者的那条：自动路不动它（pin 是硬条件），但它也不挡这一代退出。
  const watched = await json(basePort, 'GET', `/sessions/${watchedSession}`);
  print('pinned idle session after the swap', { sessionId: watchedSession, runtimeState: watched.value.runtimeState, pinReasons: watched.value.pinReasons, evictionEligible: watched.value.evictionEligible });
  assert.equal(watched.value.runtimeState, 'hotIdle');
  assert.equal(watched.value.evictionEligible, false, 'an automatic eviction must not yank a live subscriber\'s runtime');

  // 手动路 · dry-run：只报不收，且如实说出「谁收不了、为什么」。
  const dry = await json(basePort, 'POST', '/reclaim', { dryRun: true });
  assert.equal(dry.statusCode, 200, dry.text);
  const dryG1 = generationReport(dry, g1);
  print('reclaim dry-run', { totals: dry.value.totals, g1: { wouldReclaim: dryG1?.wouldReclaim, refused: dryG1?.refused, skipped: dryG1?.skipped } });
  assert.ok(dry.value.dryRun === true);
  assert.deepEqual(dryG1.skipped.map((entry) => entry.sessionId), [watchedSession], 'dry-run reports the idle-but-pinned runtime it is skipping');
  assert.ok(dryG1.skipped[0].reason === 'subscriber_pinned' && /includePinned/.test(dryG1.skipped[0].hint), 'and it says how to reclaim it anyway');
  assert.deepEqual(dryG1.refused.map((entry) => entry.sessionId), [runningSession], 'dry-run refuses the in-flight turn');
  assert.ok(dryG1.refused[0].reasons.includes('in_flight_turn'), `the refusal must name the runtime-level reason, got ${JSON.stringify(dryG1.refused[0].reasons)}`);
  assert.equal((await json(basePort, 'GET', `/sessions/${watchedSession}`)).value.runtimeState, 'hotIdle', 'dry-run must not touch anything');
  // 同一把尺子带上 includePinned：准备收谁就如实换到 wouldReclaim 里（还是没收）。
  const dryPinned = await json(basePort, 'POST', '/reclaim', { dryRun: true, includePinned: true });
  const dryPinnedG1 = generationReport(dryPinned, g1);
  print('reclaim dry-run includePinned', { dryRun: dryPinned.value.dryRun, includePinned: dryPinned.value.includePinned, wouldReclaim: dryPinnedG1?.wouldReclaim?.map((entry) => entry.sessionId), refused: dryPinnedG1?.refused?.map((entry) => entry.sessionId), skipped: dryPinnedG1?.skipped });
  assert.deepEqual(dryPinnedG1.wouldReclaim.map((entry) => entry.sessionId), [watchedSession]);
  assert.deepEqual(dryPinnedG1.skipped, []);
  assert.equal((await json(basePort, 'GET', `/sessions/${watchedSession}`)).value.runtimeState, 'hotIdle', 'includePinned dry-run must not touch anything either');

  // 手动路 · 点名在跑的会话 ⇒ 409 并说明（不是静默跳过）。
  const busyRefusal = await json(basePort, 'POST', '/reclaim', { sessionId: runningSession });
  print('reclaim refused a running session', { statusCode: busyRefusal.statusCode, body: busyRefusal.value });
  assert.equal(busyRefusal.statusCode, 409);
  assert.equal(busyRefusal.value.error, 'session_busy_reclaim');
  assert.ok(busyRefusal.value.details.reasons.includes('in_flight_turn'));
  // 手动路 · 点名挂着订阅者的会话（没开 includePinned）⇒ 也如实拒，并给出出路。
  const pinnedRefusal = await json(basePort, 'POST', '/reclaim', { sessionId: watchedSession });
  assert.equal(pinnedRefusal.statusCode, 409);
  assert.equal(pinnedRefusal.value.error, 'session_not_reclaimable');
  assert.ok(pinnedRefusal.value.details.reasons.includes('subscriber_pinned'));

  // 手动路 · 显式 includePinned：收掉它，并把那一路 SSE 用**可重连**事件收尾（不留死流）。
  const reclaimed = await json(basePort, 'POST', '/reclaim', { sessionId: watchedSession, includePinned: true });
  assert.equal(reclaimed.statusCode, 200, reclaimed.text);
  const reclaimedG1 = generationReport(reclaimed, g1);
  print('reclaim includePinned', { totals: reclaimed.value.totals, reclaimed: reclaimedG1?.reclaimed?.map((entry) => ({ sessionId: entry.sessionId, reason: entry.reason, pinReasonsBefore: entry.pinReasonsBefore })), sseStreamsEnded: reclaimedG1?.sessionSseStreamsEnded });
  assert.deepEqual(reclaimedG1.reclaimed.map((entry) => entry.sessionId), [watchedSession]);
  assert.ok(reclaimedG1.sessionSseStreamsEnded >= 1, `the reclaimed runtime's SSE stream must be closed honestly, got ${reclaimedG1.sessionSseStreamsEnded}`);
  const watchedCold = await json(basePort, 'GET', `/sessions/${watchedSession}`);
  assert.equal(watchedCold.value.runtimeState, 'cold');
  assert.equal(watchedCold.value.generationId, null);
  const retryable = await stream.waitFor((event) => event.event === 'server.reload' && event.data.retry === true, 10_000);
  print('subscriber got a retryable end instead of a dead stream', retryable.data);

  // 这一代现在只剩那条真在跑的回合：它必须（a）不被收、(b）一直在看着并**周而复始**地如实报
  // ——旧实现在这里只报一次就 return，之后再也不看（这就是「永久挡住」的全部机制）。
  const stuckLine = await waitForLog(/worker_drain_stuck/, logFrom, 20_000, 'periodic worker_drain_stuck report');
  const stuckReports = await poll('drain watcher keeps re-reporting while a turn runs',
    () => logLinesMatching(/worker_drain_stuck/, logFrom),
    (lines) => lines.length >= 3, 20_000);
  const stuck = JSON.parse(stuckReports.at(-1).slice(stuckReports.at(-1).indexOf('{"event"')));
  print('drain watcher keeps reporting while a turn really runs', { reports: stuckReports.length, waitedMs: stuck.waitedMs, busy: stuck.busy, blockers: stuck.blockers });
  assert.ok(stuckReports.length >= 3, `a watcher that still watches must re-report (got ${stuckReports.length})`);
  assert.deepEqual(stuck.busy, [runningSession], 'the only blocker must be the in-flight turn');
  assert.ok(stuck.blockers[0].blockers.includes('in_flight_turn'), `blocker facts must be runtime-level, got ${JSON.stringify(stuck.blockers[0].blockers)}`);
  assert.ok(stuck.waitedMs >= DRAIN_STUCK_LOG_MS, 'the report must come from a watcher that is still watching');

  // 旧口径的守卫依然在（一次只允许一个 drain），但**现在它自己说清楚谁挡着、为什么挡**。
  const blocked = await json(basePort, 'POST', '/reload-code');
  print('reload while a real turn runs', { statusCode: blocked.statusCode, error: blocked.value.error, details: blocked.value.details });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.value.error, 'reload_blocked_by_draining_generation');
  assert.equal(blocked.value.details.currentGenerationId, g2);
  const blockedG1 = blocked.value.details.drainingGenerations.find((entry) => entry.generationId === g1);
  assert.ok(blockedG1, 'the 409 must name the blocking generation');
  assert.ok(Array.isArray(blockedG1.blockers), 'the 409 must carry the worker\'s own blocker facts');
  assert.ok(blockedG1.blockers.some((entry) => entry.sessionId === runningSession && entry.blockers.includes('in_flight_turn')));
  assert.ok(await processAlive(workerPid1), 'a refused reload must not kill the draining worker mid-turn');

  // 长回合跑完 ⇒ 这一代空载 ⇒ 自己退出（旧实现在这里永不退出）⇒ 下一次 reload 不再 409。
  hold.release();
  const end = await poll('long turn finishes on the draining worker', () => json(basePort, 'GET', `/sessions/${runningSession}/messages`),
    (messages) => messages.value.messages?.some((message) => message.text === 'still-running-on-g1'), 30_000);
  print('in-flight reply survived the whole episode', { texts: end.value.messages.slice(-2).map((message) => message.text) });
  const settled = await waitForSettledWorker(basePort, 60_000);
  print('draining generation exited by itself', { workerCount: settled.value.workerCount, currentWorkerPid: settled.value.currentWorkerPid });
  assert.equal(settled.value.workerCount, 1, 'the generation must exit once it has no busy runtime left');
  assert.equal(settled.value.drainingGenerations.length, 0);
  assert.ok(await waitGone(workerPid1, 15_000), `drainded worker pid ${workerPid1} must be gone`);
  const second = await json(basePort, 'POST', '/reload-code');
  print('reload after the drained generation exited', { statusCode: second.statusCode, generationId: second.value.generationId, error: second.value.error });
  assert.equal(second.statusCode, 200, 'a generation that exited must not block the next reload');
  await waitForSettledWorker(basePort, 30_000);

  stream.close();
  await stopHost(runtime, basePort);
  return { g1, g2, idleSession, watchedSession, runningSession };
}

async function caseReclaim(basePort) {
  const runtime = await startHost(basePort, { SOPHO_IDLE_TTL_MS: String(DRAIN_IDLE_TTL_MS) });
  const hostPid = runtime.host.pid;
  const g1 = runtime.host.currentGenerationId;
  const workerPid1 = runtime.host.currentWorkerPid;
  print('reclaim start', { hostPid, g1, workerPid1, idleTTLms: DRAIN_IDLE_TTL_MS });

  // A. 闲置（跑过一回合、现在闲着）：dry-run 只报不收。
  const idleSession = await createSession(basePort, 'idle reclaimable');
  await warmTurn(basePort, idleSession, 'warm-reclaimable');
  const dry = await json(basePort, 'POST', '/reclaim', { sessionId: idleSession, dryRun: true });
  print('reclaim dry-run on an idle session', { statusCode: dry.statusCode, generation: generationReport(dry, g1) });
  assert.equal(dry.statusCode, 200, dry.text);
  assert.deepEqual(generationReport(dry, g1).wouldReclaim.map((entry) => entry.sessionId), [idleSession]);
  assert.deepEqual(generationReport(dry, g1).reclaimed, []);
  const afterDry = await json(basePort, 'GET', `/sessions/${idleSession}`);
  assert.equal(afterDry.value.runtimeState, 'hotIdle', 'dry-run must leave the runtime hot');
  assert.equal(afterDry.value.generationId, g1);

  // B. 真收：runtime 走掉（会话文件不动），历史与 cwd 一点不丢，同一个代再打开。
  const file = await findSessionFile(idleSession);
  const bytesBefore = (await readFile(file, 'utf8')).length;
  const reclaimed = await json(basePort, 'POST', '/reclaim', { sessionId: idleSession });
  assert.equal(reclaimed.statusCode, 200, reclaimed.text);
  const reclaimedG1 = generationReport(reclaimed, g1);
  print('reclaim on an idle session', { totals: reclaimed.value.totals, reclaimed: reclaimedG1.reclaimed.map((entry) => ({ sessionId: entry.sessionId, reason: entry.reason, idleForMs: entry.idleForMs, durable: entry.durable })) });
  assert.deepEqual(reclaimedG1.reclaimed.map((entry) => entry.sessionId), [idleSession]);
  assert.equal(reclaimedG1.reclaimed[0].reason, 'manual');
  const cold = await poll('runtime reclaimed', () => json(basePort, 'GET', `/sessions/${idleSession}`), (detail) => detail.value.runtimeState === 'cold', 10_000);
  assert.equal(cold.value.generationId, null);
  assert.equal(cold.value.lastEvictionReason, 'manual');
  const bytesAfter = (await readFile(file, 'utf8')).length;
  assert.equal(bytesAfter, bytesBefore, 'reclaiming a runtime must not touch the session file');
  // 会 acquire 的路重新打开它（看详情那条路不建 runtime，不适用于这一步）。
  assert.equal((await json(basePort, 'GET', `/sessions/${idleSession}/commands`)).statusCode, 200);
  const reopened = await poll('reopened in the same generation', () => json(basePort, 'GET', `/sessions/${idleSession}`), (detail) => detail.value.generationId === g1, 15_000);
  const messages = await json(basePort, 'GET', `/sessions/${idleSession}/messages`);
  print('history survived the reclaim', { generationId: reopened.value.generationId, restoreCount: reopened.value.restoreCount, texts: messages.value.messages.map((message) => message.text) });
  assert.ok(messages.value.messages.some((message) => message.text === 'warm-reclaimable'), 'the reclaimed session keeps its history');
  assert.equal(reopened.value.workerPid, workerPid1, 'the same generation serves it again');

  // C. 在跑的：如实拒（409），一个字节都不动；回合自己跑完，回执照样落盘。
  const runningSession = await createSession(basePort, 'running must be refused');
  await warmTurn(basePort, runningSession, 'warm-running-reclaim');
  const hold = provider.plan('hold', 'refused-reclaim-reply');
  assert.equal((await json(basePort, 'POST', `/sessions/${runningSession}/message`, { text: 'start a long turn' })).statusCode, 202);
  await hold.started;
  await poll('turn streaming', () => json(basePort, 'GET', `/sessions/${runningSession}`), (detail) => detail.value.runtime?.isStreaming === true, 15_000);
  const refused = await json(basePort, 'POST', '/reclaim', { sessionId: runningSession });
  print('reclaim refused a running session', { statusCode: refused.statusCode, error: refused.value.error, details: refused.value.details });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.value.error, 'session_busy_reclaim');
  assert.ok(refused.value.details.reasons.includes('in_flight_turn'));
  const during = await json(basePort, 'GET', `/sessions/${runningSession}`);
  assert.equal(during.value.runtimeState, 'hotActive');
  assert.equal(during.value.runtime?.isStreaming, true, 'a refused reclaim must not disturb the in-flight turn');
  assert.equal(during.value.workerPid, workerPid1);
  hold.release();
  const finished = await poll('the refused turn still finishes', () => json(basePort, 'GET', `/sessions/${runningSession}/messages`),
    (value) => value.value.messages?.some((message) => message.text === 'refused-reclaim-reply'), 30_000);
  print('the refused turn finished normally', { texts: finished.value.messages.slice(-2).map((message) => message.text) });
  const afterTurn = await json(basePort, 'GET', `/sessions/${runningSession}`);
  assert.equal(afterTurn.value.runtimeState, 'hotIdle');
  assert.equal(afterTurn.value.workerPid, workerPid1, 'nothing was evicted behind the turn\'s back');

  // D. 还没落盘的会话：如实拒（收掉它 = 丢掉只有内存里那份状态）。
  const pendingSession = await createSession(basePort, 'never persisted');
  const pendingRefusal = await json(basePort, 'POST', '/reclaim', { sessionId: pendingSession });
  print('reclaim refused a non-durable session', { statusCode: pendingRefusal.statusCode, body: pendingRefusal.value });
  assert.equal(pendingRefusal.statusCode, 409);
  assert.equal(pendingRefusal.value.error, 'session_not_reclaimable');
  assert.ok(pendingRefusal.value.details.reasons.includes('not_durable'));
  assert.equal((await json(basePort, 'GET', `/sessions/${pendingSession}`)).value.durable, false);

  // E. 自动路（idleTTL）：闲置 runtime 到期后，下一次 acquire 触发的 sweep 就把它收掉。
  const ttlSession = await createSession(basePort, 'ttl victim');
  await warmTurn(basePort, ttlSession, 'warm-ttl');
  await new Promise((resolve) => setTimeout(resolve, DRAIN_IDLE_TTL_MS + 300));
  const triggerSession = await createSession(basePort, 'sweep trigger');
  await warmTurn(basePort, triggerSession, 'warm-trigger');
  const ttlCold = await poll('idleTTL reclaim', () => json(basePort, 'GET', `/sessions/${ttlSession}`), (detail) => detail.value.runtimeState === 'cold', 15_000);
  print('idleTTL reclaimed by the runtime-level idle fact', { sessionId: ttlSession, lastEvictionReason: ttlCold.value.lastEvictionReason, lastEvictedAt: ttlCold.value.lastEvictedAt });
  assert.equal(ttlCold.value.lastEvictionReason, 'ttl');

  // F. 输入卫生：非布尔/坏 uuid 400，方法不对 405，没有一条会去碰 runtime。
  const badDryRun = await json(basePort, 'POST', '/reclaim', { dryRun: 'yes' });
  assert.equal(badDryRun.statusCode, 400);
  assert.equal(badDryRun.value.error, 'invalid_reclaim');
  const badUuid = await json(basePort, 'POST', '/reclaim', { sessionId: '01a0a385' });
  assert.equal(badUuid.statusCode, 400);
  assert.equal(badUuid.value.error, 'full_uuid_required');
  const badMethod = await json(basePort, 'GET', '/reclaim');
  assert.equal(badMethod.statusCode, 405);
  // 点一条根本不热的会话：不是失败，也没东西可收 —— 如实说清楚。
  const notHot = await json(basePort, 'POST', '/reclaim', { sessionId: randomUUID() });
  assert.equal(notHot.statusCode, 200, notHot.text);
  assert.equal(notHot.value.note, 'no live generation is holding this session (nothing to reclaim)');
  assert.deepEqual(notHot.value.totals, { reclaimed: 0, wouldReclaim: 0, refused: 0, skipped: 0, generations: 1 });
  print('reclaim input hygiene', { badDryRun: badDryRun.value.error, badUuid: badUuid.value.error, badMethod: badMethod.value.error, notHot: notHot.value.note });

  const finalHost = await json(basePort, 'GET', '/host');
  assert.equal(finalHost.value.pid, hostPid, 'reclaim must not restart the host');
  assert.equal(finalHost.value.workerCount, 1, 'reclaim must not create a generation');
  assert.equal(finalHost.value.currentGenerationId, g1);
  assert.equal(finalHost.value.drainingGenerations.length, 0, 'reclaiming in a healthy pool must not start a drain');
  await stopHost(runtime, basePort);
  return { g1, idleSession, runningSession, pendingSession, ttlSession };
}

// A session that was created but never persisted (no turn yet) cannot be evicted by
// the normal rules. Draining it must still let the old generation exit, or an idle
// generation would stay alive forever and the next reload would be blocked.
async function caseDrainNonDurable(basePort) {
  const runtime = await startHost(basePort);
  const hostPid = runtime.host.pid;
  const g1 = runtime.host.currentGenerationId;
  const sessionId = await createSession(basePort, 'never persisted');
  const before = await json(basePort, 'GET', `/sessions/${sessionId}`);
  print('drain-non-durable before reload', { sessionId, durable: before.value.durable, generationId: before.value.generationId, internalKey: before.value.internalKey, workerPid: before.value.workerPid });
  assert.equal(before.value.durable, false, 'a freshly created session without a turn is not durable yet');

  const reload = await json(basePort, 'POST', '/reload-code');
  assert.equal(reload.statusCode, 200);
  assert.equal(reload.value.pid, hostPid);
  const settled = await waitForSettledWorker(basePort, 30_000);
  assert.equal(settled.value.workerCount, 1, 'the drained worker must exit even with a non-durable session');
  assert.equal(settled.value.drainingGenerations.length, 0);

  // The next reload must still succeed: no phantom draining generation is left behind.
  const second = await json(basePort, 'POST', '/reload-code');
  assert.equal(second.statusCode, 200, 'a drained generation must not block the next reload');
  await waitForSettledWorker(basePort, 30_000);
  print('drain-non-durable after', { g1, firstReload: reload.value.generationId, secondReload: second.value.generationId, workerCount: settled.value.workerCount });
  await stopHost(runtime, basePort);
  return { g1, sessionId, firstReload: reload.value.generationId, secondReload: second.value.generationId };
}

let provider;
let hostRuntime;
let primaryError;
try {
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  const providerPort = await reserveHighPort();
  const basePort = await reserveHighPort();
  provider = await startFakeProvider(providerPort);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-s1b', name: 'S1b Fake', contextWindow: 4096, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-s1b',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);
  print('sandbox', { home, workspace, sessionsRoot, providerPort, basePort, forbiddenPortsUsed: false, case: options.case });

  const results = {};
  if (options.case === 'all' || options.case === 'reload-bound') results.reloadBound = await caseReloadBound(basePort);
  if (options.case === 'all' || options.case === 'generation-stale') results.generationStale = await caseGenerationStale(basePort);
  if (options.case === 'all' || options.case === 'sse-open-inflight') results.sseOpenInflight = await caseSseOpenInflight(basePort);
  if (options.case === 'all' || options.case === 'idle-pinned') results.idlePinned = await caseIdlePinned(basePort);
  if (options.case === 'all' || options.case === 'drain-idle-reclaim') results.drainIdleReclaim = await caseDrainIdleReclaim(basePort);
  if (options.case === 'all' || options.case === 'reclaim') results.reclaim = await caseReclaim(basePort);
  if (options.case === 'all' || options.case === 'drain-non-durable') results.drainNonDurable = await caseDrainNonDurable(basePort);
  if (options.case === 'all' || options.case === 'worker-reclaim') results.workerReclaim = await caseWorkerReclaim(basePort);
  if (options.case === 'all' || options.case === 'crash') results.crash = await caseCrash(basePort);
  print('summary', results);
  print('RESULT', 'runtime-isolation PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  if (hostRuntime) {
    try { await stopHost(hostRuntime, hostRuntime.port); } catch (error) { process.stderr.write(`host cleanup: ${error.message}\n`); }
  }
  if (provider?.server) {
    provider.server.closeAllConnections();
    await new Promise((resolve) => provider.server.close(resolve));
  }
  const baseOutput = await readFile(baseLogPath, 'utf8').catch(() => '');
  if (baseOutput.trim()) print('base log tail', baseOutput.trim().split('\n').slice(-15));
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
