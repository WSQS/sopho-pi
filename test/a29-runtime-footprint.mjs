#!/usr/bin/env node
// A-29 follow-up: how much does one hot runtime actually cost?
//
// Answers "can we raise the number of simultaneously open sessions?" with measured
// numbers instead of a guess. It opens synthetic sessions one at a time and samples the
// worker's RSS / heapUsed after each open, so the per-session slope is real resident cost
// (not a transient parse peak).
//
// Safety: everything runs in a mkdtemp home on a random high port; the real profile is
// never read; only the host pid this script recorded is signalled.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, stat, writeFile } from 'node:fs/promises';
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

const SHAPES = {
  small: { label: 'small', sessionMiB: 0.2, messages: 20, sessions: 16 },
  mid: { label: 'mid (stress-harness shape 5 MiB / 400 msgs)', sessionMiB: 5, messages: 400, sessions: 12 },
  large: { label: 'large (real known shape 13 MiB / 1521 msgs)', sessionMiB: 13, messages: 1521, sessions: 12 },
};

function usage() {
  return `Usage: node test/a29-runtime-footprint.mjs [options]\n\n` +
    `  --shape small|large|both  session shape to measure (default both)\n` +
    `  --sessions N              sessions to open per shape (default per shape)\n` +
    `  --worker-old-space-mib N  explicit worker heap via SOPHO_WORKER_OLD_SPACE_MIB (0 = Node default)\n` +
    `  --routes commands|commands+messages  which request to make per session (default commands)\n` +
    `  --settle-ms N             wait between the 3 samples of each state (default 300)\n` +
    `  --samples N               samples per state; the minimum is the post-GC floor (default 3)\n` +
    `  --keep                    keep the temporary sandbox\n`;
}

function numberArg(name, value, { integer = true, min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { shape: 'both', sessions: null, workerOldSpaceMiB: 0, settleMs: 300, samples: 3, routes: 'commands', keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--shape') options.shape = next();
    else if (arg === '--sessions') options.sessions = numberArg(arg, next(), { min: 2 });
    else if (arg === '--worker-old-space-mib') options.workerOldSpaceMiB = numberArg(arg, next());
    else if (arg === '--settle-ms') options.settleMs = numberArg(arg, next(), { min: 0 });
    else if (arg === '--samples') options.samples = numberArg(arg, next(), { min: 1 });
    else if (arg === '--routes') options.routes = next();
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!['small', 'mid', 'large', 'both'].includes(options.shape)) throw new Error(`--shape must be small, mid, large or both: ${options.shape}`);
  if (!['commands', 'commands+messages'].includes(options.routes)) throw new Error(`--routes must be commands or commands+messages: ${options.routes}`);
  return options;
}

function emit(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

async function reserveHighPort() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 42000 + Math.floor(Math.random() * 22000);
    if (port === 7321 || port === 7331) continue;
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
  const file = path.join(sessionsRoot, `fp-${String(index + 1).padStart(4, '0')}_${id}.jsonl`);
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
    const marker = ` footprint session=${index + 1} message=${messageIndex + 1} `;
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

function request(port, method, pathname, { collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { accept: 'application/json', connection: 'close' } });
    req.once('error', reject);
    req.once('response', (response) => {
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => { bytes += chunk.length; if (collect) chunks.push(chunk); });
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        bytes,
        raw: collect ? Buffer.concat(chunks).toString('utf8') : '',
        elapsedMs: Date.now() - started,
      }));
    });
    req.end();
  });
}

function linearSlope(points) {
  // Least-squares slope of value against the (uniform) open index.
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

// Robust slope: the median of all pairwise slopes. V8's occasional collection drops the
// floor by tens of MiB, which badly skews a least-squares fit; the median pair ignores it.
function theilSenSlope(points) {
  const slopes = [];
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const dx = points[right].x - points[left].x;
      if (dx !== 0) slopes.push((points[right].y - points[left].y) / dx);
    }
  }
  return median(slopes) ?? 0;
}

function medianPositiveDelta(values) {
  const positive = values.filter((value) => value > 0);
  return positive.length === 0 ? null : median(positive);
}

// V8 collects in bursts, so a floor series is piecewise: it climbs, drops when a
// collection runs, climbs again. Fitting the whole series mixes the two regimes. The
// segment after the last drop is the cleanest "retained per runtime" reading; the
// climbing stretches before a drop are retained + not-yet-collected garbage.
function tailSegmentAfterLastDrop(points, key) {
  let lastDrop = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index][key] < points[index - 1][key]) lastDrop = index;
  }
  const tail = points.slice(lastDrop);
  return {
    fromOpened: tail[0]?.x ?? 0,
    toOpened: tail.at(-1)?.x ?? 0,
    slopeMiB: Number((linearSlope(tail.map((point) => ({ x: point.x, y: point[key] }))) / MIB).toFixed(2)),
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function poll(label, operation, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await operation(); } catch (error) { last = { error: error.message }; }
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

async function hostSample(port) {
  const response = await request(port, 'GET', '/host', { collect: true });
  if (response.statusCode !== 200) throw new Error(`GET /host -> ${response.statusCode} ${response.raw.slice(0, 300)}`);
  return JSON.parse(response.raw);
}

async function stopOwnedHost(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
  ]);
  if (exited) return;
  emit('cleanup_escalation', { hostPid: child.pid, signal: 'SIGKILL' });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function measureShape(shape, options) {
  const sessions = options.sessions ?? shape.sessions;
  const sandbox = await mkdtemp(path.join(os.tmpdir(), `sopho-a29-footprint-${shape.label.split(' ')[0]}-`));
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'workspace');
  const logPath = path.join(sandbox, 'base.log');
  const port = await reserveHighPort();
  let child;
  let logHandle;
  let primaryError;
  try {
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
    await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');

    const corpus = [];
    for (let index = 0; index < sessions; index += 1) {
      corpus.push(await writeSyntheticSession({
        sessionsRoot,
        workspace,
        index,
        targetBytes: Math.floor(shape.sessionMiB * MIB),
        messageCount: shape.messages,
      }));
    }
    const totalBytes = corpus.reduce((sum, session) => sum + session.bytes, 0);
    emit('corpus', {
      shape: shape.label,
      sessions,
      messagesPerSession: shape.messages,
      sessionBytes: corpus[0].bytes,
      corpusMiB: Number((totalBytes / MIB).toFixed(2)),
      port,
      sandbox,
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
        // No capacity eviction and no TTL eviction: every opened runtime must stay hot so
        // the cumulative curve is per-runtime cost, not a mix of open and close.
        SOPHO_MAX_HOT: String(sessions),
        SOPHO_IDLE_TTL_MS: String(60 * 60 * 1000),
        ...(options.workerOldSpaceMiB > 0 ? { SOPHO_WORKER_OLD_SPACE_MIB: String(options.workerOldSpaceMiB) } : {}),
      },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });

    const first = await poll('host ready', () => hostSample(port), (host) => host?.currentWorkerPid > 0);
    const workerPid = first.currentWorkerPid;
    const generationId = first.currentGenerationId;
    const sampleBaseline = [];
    for (let attempt = 0; attempt < options.samples; attempt += 1) {
      if (attempt > 0 && options.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, options.settleMs));
      sampleBaseline.push(attempt === 0 ? first : await hostSample(port));
    }
    const baselineFloor = sampleBaseline.reduce((lowest, host) => (host.workerHeapUsedBytes < lowest.workerHeapUsedBytes ? host : lowest));
    const baseline = { x: 0, rss: baselineFloor.workerRssBytes, heap: baselineFloor.workerHeapUsedBytes };
    emit('baseline', {
      shape: shape.label,
      workerPid,
      generationId,
      heapLimitBytes: first.memoryPolicy?.heapLimitBytes ?? null,
      workerOldSpaceMiB: first.workerOldSpaceMiB ?? null,
      maxHot: first.pool?.maxHot ?? null,
      rssMiB: Number((baseline.rss / MIB).toFixed(2)),
      heapUsedMiB: Number((baseline.heap / MIB).toFixed(2)),
    });

    // A single sample right after the request measures mostly the request's own garbage,
    // not what the runtime retains. V8 collects that later (idle GC), so each state is
    // sampled a few times and the minimum stands in for the post-GC floor. Both the floor
    // and the last sample are reported; the floor is the number a capacity plan can use.
    const points = [baseline];
    for (let index = 0; index < corpus.length; index += 1) {
      const session = corpus[index];
      // 用 `/commands` 把会话开热：`GET /sessions/{id}`（看详情）现在**不建 runtime**，
      // 它量不出「N 个热 runtime 的占用」—— 这个脚本量的正是后者。
      const detail = await request(port, 'GET', `/sessions/${session.id}/commands`);
      assert.equal(detail.statusCode, 200, `warm for session ${index + 1} -> ${detail.statusCode}`);
      let messages = null;
      if (options.routes === 'commands+messages') {
        messages = await request(port, 'GET', `/sessions/${session.id}/messages`);
        assert.equal(messages.statusCode, 200, `messages for session ${index + 1} -> ${messages.statusCode}`);
      }
      const samples = [];
      for (let attempt = 0; attempt < options.samples; attempt += 1) {
        if (attempt > 0 && options.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, options.settleMs));
        const host = await hostSample(port);
        assert.equal(host.currentWorkerPid, workerPid, `worker was replaced during measurement at session ${index + 1}`);
        assert.equal(host.currentGenerationId, generationId, `generation changed during measurement at session ${index + 1}`);
        assert.equal(host.pool?.counters?.evict?.memory ?? 0, 0, `memory eviction fired during measurement at session ${index + 1}`);
        samples.push(host);
      }
      const floor = samples.reduce((lowest, host) => (host.workerHeapUsedBytes < lowest.workerHeapUsedBytes ? host : lowest));
      const last = samples.at(-1);
      assert.ok(Number(last.pool?.hot ?? 0) >= index + 1, `expected ${index + 1} hot runtimes, saw ${last.pool?.hot}`);
      // samples[0] is taken right after the request, so it is the closest thing to the
      // request's transient peak; later samples show how much of it V8 gives back.
      const postRequest = samples[0];
      const highest = samples.reduce((top, host) => (host.workerHeapUsedBytes > top.workerHeapUsedBytes ? host : top));
      points.push({
        x: index + 1,
        rss: floor.workerRssBytes,
        heap: floor.workerHeapUsedBytes,
        lastRss: last.workerRssBytes,
        lastHeap: last.workerHeapUsedBytes,
        postRequestHeap: postRequest.workerHeapUsedBytes,
        maxHeap: highest.workerHeapUsedBytes,
        detailBytes: detail.bytes,
        messagesBytes: messages?.bytes ?? null,
        requestMs: detail.elapsedMs + (messages?.elapsedMs ?? 0),
      });
      const previous = points[points.length - 2];
      emit('open', {
        shape: shape.label,
        opened: index + 1,
        hot: last.pool?.hot ?? null,
        floorRssMiB: Number((floor.workerRssBytes / MIB).toFixed(2)),
        floorHeapMiB: Number((floor.workerHeapUsedBytes / MIB).toFixed(2)),
        lastRssMiB: Number((last.workerRssBytes / MIB).toFixed(2)),
        lastHeapMiB: Number((last.workerHeapUsedBytes / MIB).toFixed(2)),
        deltaFloorRssMiB: Number(((floor.workerRssBytes - previous.rss) / MIB).toFixed(2)),
        deltaFloorHeapMiB: Number(((floor.workerHeapUsedBytes - previous.heap) / MIB).toFixed(2)),
        postRequestHeapMiB: Number((postRequest.workerHeapUsedBytes / MIB).toFixed(2)),
        peakOverPreviousFloorMiB: Number(((postRequest.workerHeapUsedBytes - previous.heap) / MIB).toFixed(2)),
        samplesPerState: samples.length,
        messagesBytes: messages?.bytes ?? null,
        requestMs: detail.elapsedMs + (messages?.elapsedMs ?? 0),
      });
    }

    const rssPoints = points.map((point) => ({ x: point.x, y: point.rss }));
    const heapPoints = points.map((point) => ({ x: point.x, y: point.heap }));
    const rssSlopeMiB = theilSenSlope(rssPoints) / MIB;
    const heapSlopeMiB = theilSenSlope(heapPoints) / MIB;
    const rssDeltas = points.slice(1).map((point, index) => (point.rss - points[index].rss) / MIB);
    const heapDeltas = points.slice(1).map((point, index) => (point.heap - points[index].heap) / MIB);
    const firstOpenRss = (points[1].rss - points[0].rss) / MIB;
    const firstOpenHeap = (points[1].heap - points[0].heap) / MIB;
    const summary = {
      shape: shape.label,
      sessions,
      sessionMiB: shape.sessionMiB,
      messagesPerSession: shape.messages,
      workerPid,
      generationId,
      heapLimitMiB: Number(((first.memoryPolicy?.heapLimitBytes ?? 0) / MIB).toFixed(1)),
      rssPerSessionMiB: Number(rssSlopeMiB.toFixed(2)),
      heapPerSessionMiB: Number(heapSlopeMiB.toFixed(2)),
      rssPerSessionLeastSquaresMiB: Number((linearSlope(rssPoints) / MIB).toFixed(2)),
      heapPerSessionLeastSquaresMiB: Number((linearSlope(heapPoints) / MIB).toFixed(2)),
      floorRssSeriesMiB: points.map((point) => Number((point.rss / MIB).toFixed(2))),
      floorHeapSeriesMiB: points.map((point) => Number((point.heap / MIB).toFixed(2))),
      postRequestHeapSeriesMiB: points.map((point) => Number((point.postRequestHeap / MIB).toFixed(2))),
      // Transient peak of one request above the floor that preceded it: the number an
      // admission predictor has to cover, because the runtime that is already hot keeps
      // its retained memory while this request's wire is built.
      transientPeakOverFloorMiB: Number((Math.max(...points.slice(1).map((point, index) => (point.postRequestHeap - points[index].heap) / MIB))).toFixed(2)),
      transientPeakOverFloorMedianMiB: Number((median(points.slice(1).map((point, index) => (point.postRequestHeap - points[index].heap) / MIB)) ?? 0).toFixed(2)),
      firstOpenRssMiB: Number(firstOpenRss.toFixed(2)),
      firstOpenHeapMiB: Number(firstOpenHeap.toFixed(2)),
      restRssDeltaMedianMiB: Number((median(rssDeltas.slice(1)) ?? 0).toFixed(2)),
      restRssDeltaMinMiB: Number(Math.min(...rssDeltas.slice(1)).toFixed(2)),
      restRssDeltaMaxMiB: Number(Math.max(...rssDeltas.slice(1)).toFixed(2)),
      restHeapDeltaMedianMiB: Number((median(heapDeltas.slice(1)) ?? 0).toFixed(2)),
      restHeapDeltaMinMiB: Number(Math.min(...heapDeltas.slice(1)).toFixed(2)),
      restHeapDeltaMaxMiB: Number(Math.max(...heapDeltas.slice(1)).toFixed(2)),
      positiveRssDeltaMedianMiB: Number((medianPositiveDelta(rssDeltas) ?? 0).toFixed(2)),
      positiveHeapDeltaMedianMiB: Number((medianPositiveDelta(heapDeltas) ?? 0).toFixed(2)),
      tailSegmentRss: tailSegmentAfterLastDrop(points, 'rss'),
      tailSegmentHeap: tailSegmentAfterLastDrop(points, 'heap'),
      totalRssMiB: Number((points.at(-1).rss / MIB).toFixed(2)),
      totalHeapMiB: Number((points.at(-1).heap / MIB).toFixed(2)),
      // Envelope: the worst floor seen, divided by the number of hot runtimes. This is the
      // conservative number a capacity plan should use, because RSS only returns pages
      // sometimes and the heap floor only drops when a collection happens to run.
      envelopeRssPerSessionMiB: Number(((Math.max(...points.map((point) => point.rss)) - baseline.rss) / MIB / sessions).toFixed(2)),
      envelopeHeapPerSessionMiB: Number(((Math.max(...points.map((point) => point.heap)) - baseline.heap) / MIB / sessions).toFixed(2)),
      routes: options.routes,
      samplesPerState: options.samples,
      memoryEvictions: 0,
      hostStillRunning: child.exitCode === null && child.signalCode === null,
    };
    emit('shape_result', summary);
    return summary;
  } catch (error) { primaryError = error; } finally {
    const cleanupProblems = [];
    await stopOwnedHost(child).catch((error) => emit('cleanup_error', { message: error.message }));
    await logHandle?.close().catch(() => {});
    if (options.keep) emit('kept', { sandbox, logPath });
    else await removeSandbox(sandbox, cleanupProblems);
    finishCleanup(primaryError, cleanupProblems);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const wanted = options.shape === 'both' ? ['small', 'mid', 'large'] : [options.shape];
  const results = [];
  for (const name of wanted) results.push(await measureShape(SHAPES[name], options));
  emit('summary', { results });
  // Do not assert that every fitted slope is positive: V8 may run a major collection
  // after the baseline sample and make a short floor series go down even while all
  // runtimes remain hot. The raw floor/envelope/tail series is the evidence; the harness
  // already asserts no eviction, stable worker/generation and the expected hot count.
  process.stdout.write('RESULT: a29 runtime footprint measured\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
