#!/usr/bin/env node
// A-29 worker-memory pressure harness.
//
// It never opens the real profile: every run creates a synthetic session corpus in
// a temporary PI home, starts its own A on a random high port, and only terminates
// the exact host pid it spawned. The deliberately small optional V8 heap makes an
// OOM reproducible without consuming the machine's normal ~4 GiB Node heap.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

const MIB = 1024 * 1024;
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const forbiddenPorts = new Set([7321, 7331]);
const limits = {
  sessions: 500,
  sessionMiB: 32,
  totalMiB: 2048,
  concurrency: 4,
  maxHot: 500,
  workerOldSpaceMiB: 4096,
  timeoutSeconds: 30 * 60,
};

function usage() {
  return `Usage: node test/a29-memory-stress.mjs [options]\n\n` +
    `  --sessions N             synthetic sessions to open (default 16)\n` +
    `  --session-mib N          approximate JSONL bytes per session (default 5)\n` +
    `  --messages N             messages per session (default 400)\n` +
    `  --concurrency N          concurrent session opens, capped at 4 (default 1)\n` +
    `  --max-hot N              SOPHO_MAX_HOT (default equals --sessions)\n` +
    `  --rotate-every N         POST /reload-code after each N opens; 0 disables\n` +
    `  --worker-old-space-mib N set sandbox NODE_OPTIONS heap (default 192; 0=Node default)\n` +
    `  --sample-every N         emit /host memory sample every N opens (default 1)\n` +
    `  --expect safe|survive    safe accepts completion or worker_memory_pressure; survive requires completion (default safe)\n` +
    `  --timeout-seconds N      whole-run deadline (default 1800)\n` +
    `  --keep                   retain the exact temporary directory printed at start\n` +
    `  --help                   show this help\n\n` +
    `Safety caps: ${limits.sessions} sessions, ${limits.sessionMiB} MiB/session, ` +
    `${limits.totalMiB} MiB corpus, concurrency ${limits.concurrency}.`;
}

function numberArg(name, value, { integer = true, min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    sessions: 16,
    sessionMiB: 5,
    messages: 400,
    concurrency: 1,
    maxHot: null,
    rotateEvery: 0,
    workerOldSpaceMiB: 192,
    sampleEvery: 1,
    expect: 'safe',
    timeoutSeconds: 1800,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--sessions') options.sessions = numberArg(arg, next(), { min: 1 });
    else if (arg === '--session-mib') options.sessionMiB = numberArg(arg, next(), { integer: false, min: 0.1 });
    else if (arg === '--messages') options.messages = numberArg(arg, next(), { min: 1 });
    else if (arg === '--concurrency') options.concurrency = numberArg(arg, next(), { min: 1 });
    else if (arg === '--max-hot') options.maxHot = numberArg(arg, next(), { min: 1 });
    else if (arg === '--rotate-every') options.rotateEvery = numberArg(arg, next());
    else if (arg === '--worker-old-space-mib') options.workerOldSpaceMiB = numberArg(arg, next());
    else if (arg === '--sample-every') options.sampleEvery = numberArg(arg, next(), { min: 1 });
    else if (arg === '--expect') options.expect = next();
    else if (arg === '--timeout-seconds') options.timeoutSeconds = numberArg(arg, next(), { min: 10 });
    else throw new Error(`unknown option: ${arg}`);
  }
  options.maxHot ??= options.sessions;
  if (!['safe', 'survive'].includes(options.expect)) throw new Error(`--expect must be safe or survive: ${options.expect}`);
  if (options.rotateEvery > 0 && options.concurrency !== 1) {
    throw new Error('--rotate-every requires --concurrency 1 so no request crosses a generation rotation');
  }
  for (const [key, cap] of Object.entries({
    sessions: limits.sessions,
    sessionMiB: limits.sessionMiB,
    concurrency: limits.concurrency,
    maxHot: limits.maxHot,
    workerOldSpaceMiB: limits.workerOldSpaceMiB,
    timeoutSeconds: limits.timeoutSeconds,
  })) {
    if (options[key] > cap) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} exceeds safety cap ${cap}`);
  }
  const corpusMiB = options.sessions * options.sessionMiB;
  if (corpusMiB > limits.totalMiB) throw new Error(`synthetic corpus ${corpusMiB} MiB exceeds safety cap ${limits.totalMiB} MiB`);
  return options;
}

function emit(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

async function reserveHighPort() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 42000 + Math.floor(Math.random() * 22000);
    if (forbiddenPorts.has(port)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('could not reserve a random high port');
}

function assistantMessage(text, timestamp) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-a29',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp,
  };
}

async function writeSyntheticSession({ sessionsRoot, workspace, index, targetBytes, messageCount }) {
  const id = randomUUID();
  const file = path.join(sessionsRoot, `a29-${String(index + 1).padStart(4, '0')}_${id}.jsonl`);
  const timestamp = new Date(Date.now() + index).toISOString();
  const header = { type: 'session', version: 3, id, timestamp, cwd: workspace };
  const fixedOverhead = Buffer.byteLength(`${JSON.stringify(header)}\n`) + messageCount * 300;
  const textBytes = Math.max(64, Math.floor((targetBytes - fixedOverhead) / messageCount));
  const stream = createWriteStream(file, { encoding: 'utf8' });
  let streamError = null;
  stream.once('error', (error) => { streamError = error; });
  const write = async (line) => {
    if (!stream.write(`${JSON.stringify(line)}\n`)) await new Promise((resolve) => stream.once('drain', resolve));
    if (streamError) throw streamError;
  };
  await write(header);
  let parentId = null;
  for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
    const entryId = `${index.toString(16).padStart(4, '0')}${messageIndex.toString(16).padStart(8, '0')}`;
    const marker = ` session=${index + 1} message=${messageIndex + 1} `;
    const text = marker + 'x'.repeat(Math.max(1, textBytes - Buffer.byteLength(marker)));
    const user = messageIndex % 2 === 0;
    const message = user
      ? { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() + messageIndex }
      : assistantMessage(text, Date.now() + messageIndex);
    await write({ type: 'message', id: entryId, parentId, timestamp, message });
    parentId = entryId;
  }
  await new Promise((resolve, reject) => stream.end(resolve).once('error', reject));
  const info = await stat(file);
  return { id, file, bytes: info.size };
}

async function request(port, method, pathname, { timeoutMs = 120_000, collect = true } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { accept: 'application/json', connection: 'close' } });
    const timer = setTimeout(() => req.destroy(new Error(`request timeout after ${timeoutMs}ms: ${method} ${pathname}`)), timeoutMs);
    req.once('error', (error) => { clearTimeout(timer); reject(error); });
    req.once('response', (response) => {
      let bytes = 0;
      const chunks = [];
      const collectBody = collect === true || (collect === 'errors' && response.statusCode >= 400);
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (collectBody) chunks.push(chunk);
      });
      response.once('error', (error) => { clearTimeout(timer); reject(error); });
      response.once('end', () => {
        clearTimeout(timer);
        const raw = collectBody ? Buffer.concat(chunks).toString('utf8') : '';
        let value = null;
        if (collectBody && raw) {
          try { value = JSON.parse(raw); } catch { value = raw; }
        }
        resolve({ statusCode: response.statusCode, bytes, raw, value, elapsedMs: Date.now() - started });
      });
    });
    req.end();
  });
}

async function poll(label, operation, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await operation(); } catch (error) { last = { error: error.message }; }
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function currentWorker(host) {
  return host?.workers?.find((worker) => worker.state === 'current') ?? null;
}

async function hostSample(port) {
  const response = await request(port, 'GET', '/host');
  if (response.statusCode !== 200) throw new Error(`GET /host -> ${response.statusCode} ${response.raw.slice(0, 500)}`);
  return response.value;
}

async function waitReady(port) {
  return poll('sandbox A ready', () => hostSample(port), (host) => host?.currentWorkerPid > 0, 60_000);
}

async function waitSingleWorker(port, generationId = null) {
  return poll('single settled generation', () => hostSample(port), (host) => host?.workerCount === 1
    && host.drainingGenerations?.length === 0
    && (generationId === null || host.currentGenerationId === generationId), 90_000);
}

async function stopOwnedHost(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve(null), 20_000)),
  ]);
  if (exited) return;
  emit('cleanup_escalation', { hostPid: pid, signal: 'SIGKILL' });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function mapLimit(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  }));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-a29-memory-'));
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'workspace');
  const logPath = path.join(sandbox, 'base.log');
  const port = await reserveHighPort();
  let child;
  let logHandle;
  let crash = null;
  let completed = 0;
  const rejections = [];
  const startedAt = Date.now();
  const deadline = setTimeout(() => {
    emit('deadline', { timeoutSeconds: options.timeoutSeconds });
    child?.kill('SIGTERM');
  }, options.timeoutSeconds * 1000);
  deadline.unref?.();

  let primaryError;
  try {
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: {} }, null, 2)}\n`);
    await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultThinkingLevel: 'off', compaction: { enabled: false } }, null, 2)}\n`);

    emit('sandbox', {
      sandbox,
      home,
      sessionsRoot,
      port,
      realProfileTouched: false,
      forbiddenPortsUsed: false,
      options,
    });

    const sessions = [];
    for (let index = 0; index < options.sessions; index += 1) {
      sessions.push(await writeSyntheticSession({
        sessionsRoot,
        workspace,
        index,
        targetBytes: Math.floor(options.sessionMiB * MIB),
        messageCount: options.messages,
      }));
      if ((index + 1) % 10 === 0 || index + 1 === options.sessions) {
        emit('corpus_progress', { written: index + 1, sessions: options.sessions });
      }
    }
    const corpusBytes = sessions.reduce((sum, session) => sum + session.bytes, 0);
    emit('corpus_ready', {
      sessions: sessions.length,
      messagesPerSession: options.messages,
      corpusBytes,
      corpusMiB: Number((corpusBytes / MIB).toFixed(2)),
      minSessionBytes: Math.min(...sessions.map((session) => session.bytes)),
      maxSessionBytes: Math.max(...sessions.map((session) => session.bytes)),
    });

    logHandle = await open(logPath, 'w');
    child = spawn(process.execPath, [baseEntry], {
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
        SOPHO_PORT: String(port),
        SOPHO_DEFAULT_CWD: workspace,
        SOPHO_NO_TOOLS: '1',
        SOPHO_MAX_HOT: String(options.maxHot),
        ...(options.workerOldSpaceMiB > 0 ? { SOPHO_WORKER_OLD_SPACE_MIB: String(options.workerOldSpaceMiB) } : {}),
      },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
    const hostExit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const firstHost = await waitReady(port);
    const originalHostPid = firstHost.pid;
    let expectedWorkerPid = firstHost.currentWorkerPid;
    let expectedGeneration = firstHost.currentGenerationId;
    emit('host_ready', {
      hostPid: originalHostPid,
      workerPid: expectedWorkerPid,
      generationId: expectedGeneration,
      maxHot: firstHost.pool?.maxHot,
      workerOldSpaceMiB: options.workerOldSpaceMiB || null,
    });

    const openOne = async (session, index) => {
      let detail;
      let messages;
      try {
        detail = await request(port, 'GET', `/sessions/${session.id}`, { collect: 'errors' });
        if (detail.statusCode === 503 && detail.value?.error === 'worker_memory_pressure') {
          rejections.push({ sessionId: session.id, route: 'detail', statusCode: detail.statusCode, body: detail.value });
          emit('readable_rejection', rejections.at(-1));
          return true;
        }
        if (detail.statusCode !== 200) throw new Error(`detail status ${detail.statusCode}: ${detail.raw}`);
        messages = await request(port, 'GET', `/sessions/${session.id}/messages`, { collect: 'errors' });
        if (messages.statusCode === 503 && messages.value?.error === 'worker_memory_pressure') {
          rejections.push({ sessionId: session.id, route: 'messages', statusCode: messages.statusCode, body: messages.value });
          emit('readable_rejection', rejections.at(-1));
          return true;
        }
        if (messages.statusCode !== 200) throw new Error(`messages status ${messages.statusCode}: ${messages.raw}`);
      } catch (error) {
        let observed = null;
        try {
          observed = await poll(
            'worker replacement after request failure',
            () => hostSample(port),
            (host) => host?.currentWorkerPid > 0
              && (host.currentWorkerPid !== expectedWorkerPid || host.currentGenerationId !== expectedGeneration),
            30_000,
          );
        } catch {}
        if (observed) {
          crash = {
            atSession: index + 1,
            completedBeforeCrash: completed,
            lostWorkerPid: expectedWorkerPid,
            lostGenerationId: expectedGeneration,
            replacementWorkerPid: observed.currentWorkerPid,
            replacementGenerationId: observed.currentGenerationId,
            requestError: error.message,
          };
          emit('worker_replaced', crash);
          return false;
        }
        throw error;
      }

      completed += 1;
      if (completed % options.sampleEvery === 0 || completed === options.sessions) {
        const host = await hostSample(port);
        if (host.currentWorkerPid !== expectedWorkerPid || host.currentGenerationId !== expectedGeneration) {
          crash = {
            atSession: index + 1,
            completedBeforeCrash: completed,
            lostWorkerPid: expectedWorkerPid,
            lostGenerationId: expectedGeneration,
            replacementWorkerPid: host.currentWorkerPid,
            replacementGenerationId: host.currentGenerationId,
            requestError: null,
          };
          emit('worker_replaced', crash);
          return false;
        }
        const worker = currentWorker(host);
        emit('sample', {
          opened: completed,
          elapsedMs: Date.now() - startedAt,
          workerPid: host.currentWorkerPid,
          generationId: host.currentGenerationId,
          rssBytes: worker?.rssBytes ?? host.workerRssBytes,
          rssMiB: Number(((worker?.rssBytes ?? host.workerRssBytes) / MIB).toFixed(2)),
          heapUsedBytes: worker?.heapUsedBytes ?? host.workerHeapUsedBytes,
          heapUsedMiB: Number(((worker?.heapUsedBytes ?? host.workerHeapUsedBytes) / MIB).toFixed(2)),
          hot: worker?.hot ?? host.pool?.hot,
          memoryEvictions: host.pool?.counters?.evict?.memory ?? null,
          memoryPressure: host.memoryPolicy?.state?.pressure ?? null,
          cacheBytes: host.memoryPolicy?.caches ?? null,
          detailBytes: detail.bytes,
          messagesBytes: messages.bytes,
          requestMs: detail.elapsedMs + messages.elapsedMs,
        });
      }

      if (options.rotateEvery > 0 && completed % options.rotateEvery === 0 && completed < options.sessions) {
        const rotated = await request(port, 'POST', '/reload-code');
        if (rotated.statusCode !== 200) throw new Error(`POST /reload-code -> ${rotated.statusCode} ${rotated.raw.slice(0, 500)}`);
        const settled = await waitSingleWorker(port, rotated.value.generationId);
        assert.equal(settled.pid, originalHostPid, 'host pid must survive generation rotation');
        expectedWorkerPid = settled.currentWorkerPid;
        expectedGeneration = settled.currentGenerationId;
        emit('rotated', {
          opened: completed,
          hostPid: settled.pid,
          workerPid: expectedWorkerPid,
          generationId: expectedGeneration,
          workerCount: settled.workerCount,
          hot: settled.pool?.hot,
        });
      }
      return true;
    };

    // Concurrency is intentionally bounded and defaults to one. Stop scheduling new
    // work after the first observed worker replacement.
    await mapLimit(sessions, options.concurrency, async (session, index) => {
      if (crash) return false;
      return openOne(session, index);
    });

    const logText = await readFile(logPath, 'utf8');
    const fatalLines = logText.split(/\r?\n/).filter((line) => /FATAL ERROR|heap out of memory|current worker .* exited|replacing lost generation/.test(line));
    for (const line of fatalLines) process.stdout.write(`RAW_LOG ${line}\n`);
    const oomEvidence = {
      fatal: /FATAL ERROR:.*heap out of memory/i.test(logText),
      sigabrt: /exited: signal SIGABRT/.test(logText),
      workerExit: /current worker .* exited:/.test(logText),
      replacement: /replacing lost generation/.test(logText),
    };
    if (!crash && oomEvidence.workerExit) {
      crash = { atSession: null, completedBeforeCrash: completed, requestError: null };
    }
    const finalHost = await hostSample(port);
    emit('host_memory_policy', {
      workerPid: finalHost.currentWorkerPid,
      generationId: finalHost.currentGenerationId,
      memoryPolicy: finalHost.memoryPolicy,
      evictMemory: finalHost.pool?.counters?.evict?.memory ?? null,
    });
    emit('result', {
      expectation: options.expect,
      observed: crash ? 'crash' : 'survive',
      completed,
      requested: options.sessions,
      crash,
      oomEvidence,
      readableRejections: rejections.length,
      elapsedMs: Date.now() - startedAt,
      logPath,
      hostStillRunning: child.exitCode === null && child.signalCode === null,
    });

    assert.equal(crash, null, `worker was replaced instead of completing or returning worker_memory_pressure: ${JSON.stringify(crash)}`);
    assert.equal(oomEvidence.fatal, false, 'V8 logged heap OOM instead of a readable rejection');
    assert.equal(oomEvidence.replacement, false, 'host replaced the worker during the memory safety run');
    if (options.expect === 'survive') {
      assert.equal(rejections.length, 0, 'survival arm received worker_memory_pressure');
      assert.equal(completed, options.sessions, 'survival arm did not finish the requested load');
    } else {
      assert.equal(completed + rejections.length, options.sessions, 'safe arm neither completed nor rejected every requested session');
    }

    const prematureHostExit = await Promise.race([hostExit, new Promise((resolve) => setTimeout(() => resolve(null), 10))]);
    assert.equal(prematureHostExit, null, `thin host exited unexpectedly: ${JSON.stringify(prematureHostExit)}`);
  } catch (error) { primaryError = error; } finally {
    const cleanupProblems = [];
    clearTimeout(deadline);
    await stopOwnedHost(child).catch((error) => emit('cleanup_error', { message: error.message }));
    await logHandle?.close().catch(() => {});
    if (options.keep) emit('kept', { sandbox, logPath });
    else await removeSandbox(sandbox, cleanupProblems);
    finishCleanup(primaryError, cleanupProblems);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
