#!/usr/bin/env node
// 冲突判定路的死线契约（F2 的门 + 反证臂 + 「旋钮真的在管这条死线」的控制臂）。
//
// 契约：`allLiveSessionFacts()` 是**正确性**用途（`/move`·`/handoff`·`session_new`·子会话创建），
// 不是装饰。它答不上来时**必须诚实可重试**：503 + `error:'live_facts_unavailable'` +
// `details:{retryable:true, retryAfterMs}` + HTTP 头 `Retry-After: 1`（与 JSON 的 1000ms 对齐，C4）；
// 响应在有限时间内结束；宿主一直活着。不许 500，不许静默 fail-open。
//
// 怎么让「答不上来」确定性地发生：`/move` 的守卫（`guardMove`）在调 `allLiveSessionFacts()`
// 之前**不做任何 IPC**，所以可以按**精确 pid** 把当前 worker `SIGSTOP` 住 ⇒ 它的 live-facts
// 必然到点。为什么不能只靠 `SOPHO_LIVE_FACTS_TIMEOUT_MS=0`：IPC 往返在空载沙箱里往往 < 1ms
// （Node 把 `setTimeout(0)` 夹到 1ms），实测 12/12 发都让 worker 抢先答上（见报告）⇒ 只靠 0
// 会是一道**时快时慢**的门。SIGSTOP 让「到点」这件事变成确定的。
//
// 三条臂（都在同一份真树 `server/base.mjs` 上，除反证臂的**副本**外）：
//   A 正向（真树，knob=0）：3 发 `/move` × 暂停的 worker ⇒ 503 + retryable + retryAfterMs，2s 内结束；
//   B 控制（真树，knob=5000）：1 发 ⇒ 也必须 503，但**要等 ~5s** ⇒ 证明死线真的由这个旋钮驱动
//     （若代码忽略旋钮，A 与 B 的耗时不会差出量级）；
//   C 反证（副本，knob=0）：把那条路改回旧行为（普通 Error，无 statusCode/code/details）
//     ⇒ 同一发**必须**不再带可重试语义（500 / 没有 retryable）。若突变后仍 503+retryable，
//     这条臂就是**没判到东西** ⇒ 本门判红。
//
// 沙箱：副本 home + 端口 net 自留；进程一律**按精确 pid** 杀（绝不 pkill；SIGSTOP/SIGCONT 也是精确 pid）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLIENT_DEADLINE_MS = 2000;
const CONTROL_CLIENT_DEADLINE_MS = 9000;
const CONTROL_MIN_MS = 4500;
const ROUNDS = 3;
// ⚠️ F7：JSON 的 retryAfterMs 与 HTTP 头 `Retry-After: 1`（秒）取一致 = 1000ms。
const EXPECTED_RETRY_AFTER_MS = 1000;

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => { const { port } = listener.address(); listener.close(() => resolve(port)); });
  });
}

function request(port, pathname, { method = 'GET', body = null, timeoutMs = CLIENT_DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const startedAt = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { accept: 'application/json', connection: 'close', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value = null;
        try { value = JSON.parse(text); } catch {}
        resolve({ statusCode: response.statusCode, headers: response.headers, value, body: text, elapsedMs: Date.now() - startedAt, timedOut: false });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    req.once('error', (error) => {
      if (String(error.message).startsWith('timeout after')) {
        resolve({ statusCode: null, headers: null, value: null, body: null, elapsedMs: Date.now() - startedAt, timedOut: true, error: error.message });
        return;
      }
      reject(error);
    });
    req.end(payload ?? undefined);
  });
}

const digestOf = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`;

// 副本：只突变副本（真树一个字不改）。反证臂把「诚实 503」换成旧行为（普通 Error，无 details）。
async function materialize(treeDir, { plainError }) {
  await mkdir(treeDir, { recursive: true });
  await cp(path.join(root, 'server'), path.join(treeDir, 'server'), { recursive: true });
  await cp(path.join(root, 'web'), path.join(treeDir, 'web'), { recursive: true });
  await cp(path.join(root, 'pi-extensions'), path.join(treeDir, 'pi-extensions'), { recursive: true });
  await writeFile(path.join(treeDir, 'package.json'), await readFile(path.join(root, 'package.json')));
  await symlink(path.join(root, 'node_modules'), path.join(treeDir, 'node_modules'), 'dir');
  if (!plainError) return { dir: treeDir, mutated: null };
  const file = path.join(treeDir, 'server', 'base.mjs');
  let text = await readFile(file, 'utf8');
  const anchor = '// 正确性路（冲突判定）⇒ 诚实且**可重试**';
  const anchorAt = text.indexOf(anchor);
  assert.ok(anchorAt > 0, 'mutation anchor not found (allLiveSessionFacts catch)');
  const throwAt = text.indexOf('throw Object.assign(', anchorAt);
  assert.ok(throwAt > 0, 'mutation: the honest 503 throw is not after the anchor');
  const endAt = text.indexOf(';', throwAt);
  assert.ok(endAt > 0, 'mutation: cannot find the end of the honest throw');
  text = `${text.slice(0, throwAt)}throw error;   // (mutation: 旧行为 —— 普通 Error，无 statusCode/code/details)${text.slice(endAt + 1)}`;
  await writeFile(file, text);
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => execFile(process.execPath, ['--check', file], (error, stdout, stderr) => {
    if (error) reject(new Error(`mutated base.mjs does not even parse: ${stderr || error.message}`));
    else resolve();
  }));
  return { dir: treeDir, mutated: 'allLiveSessionFacts: honest 503 replaced by a plain Error (no details)' };
}

async function startHost({ treeDir, home, sessionsRoot, workspace, logFile, liveFactsTimeoutMs }) {
  const port = await reservePort();
  const log = await open(logFile, 'w');
  const child = spawn(process.execPath, [path.join(treeDir, 'server', 'base.mjs')], {
    cwd: treeDir,
    env: {
      ...process.env, HOME: home, ASSIST_HOME: home, PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot, PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port), SOPHO_DEFAULT_CWD: workspace, SOPHO_NO_TOOLS: '1',
      SOPHO_MEMORY_HEAP_HIGH_BYTES: '1000000000000', SOPHO_MEMORY_HEAP_LOW_BYTES: '900000000000',
      SOPHO_MEMORY_RSS_HIGH_BYTES: '1000000000000', SOPHO_MEMORY_RSS_LOW_BYTES: '900000000000',
      SOPHO_GENERATION_WAIT_MS: '500',
      SOPHO_LIVE_FACTS_TIMEOUT_MS: String(liveFactsTimeoutMs),
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await request(port, '/host', { timeoutMs: 3000 });
      if (response.statusCode === 200 && response.value?.currentWorkerPid) return { child, port, logFile, hostStatus: response.value };
    } catch {}
    await sleep(100);
  }
  const tail = await readFile(logFile, 'utf8').catch(() => '(log unreadable)');
  throw new Error(`sandbox host did not become ready on ${port}\n--- log tail ---\n${tail.split('\n').slice(-14).join('\n')}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([new Promise((resolve) => child.once('exit', resolve)).then(() => true), sleep(15000).then(() => false)]);
  if (!exited && child.exitCode === null) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
}

const signalPid = (pid, signal) => { try { process.kill(pid, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; } };

// 一发「worker 被暂停、必然到点」的**守卫路**请求（`path` 决定走哪个 guard：`/move` 或 `/handoff`；
// 两条都在调 `allLiveSessionFacts()` 之前**不做任何 IPC** ⇒ SIGSTOP 能让死线确定到点）。
async function pausedWorkerGuardRequest({ host, sessionId, path, body, timeoutMs }) {
  const workerPid = host.hostStatus.currentWorkerPid;
  signalPid(workerPid, 'SIGSTOP');
  try {
    return await request(host.port, `/sessions/${sessionId}${path}`, { method: 'POST', body, timeoutMs });
  } finally {
    signalPid(workerPid, 'SIGCONT');   // 一定要恢复：不然收尾时 worker 仍停着（SIGTERM 也救不了它）
  }
}

async function assertHostAlive(host, round) {
  const alive = await request(host.port, '/host', { timeoutMs: 3000 });
  assert.equal(alive.statusCode, 200, `round ${round}: the host process must stay alive`);
  assert.equal(alive.value.pid, host.hostStatus.pid, `round ${round}: host pid must not change`);
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'live-facts-deadline-'));
const problems = [];
let primaryError = null;
const hosts = [];
try {
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const parentCwd = path.join(sandbox, 'parent-cwd');
  const targetCwd = path.join(sandbox, 'target-cwd');
  for (const dir of [sessionsRoot, parentCwd, targetCwd]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const sessionId = randomUUID();
  const at = '2026-09-18T00:00:00.000Z';
  await writeFile(path.join(sessionsRoot, `s_${sessionId}.jsonl`), `${[
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: at, cwd: parentCwd }),
    JSON.stringify({ type: 'session_info', id: randomUUID(), parentId: null, timestamp: at, name: '被 move 的会话' }),
    JSON.stringify({ type: 'message', id: randomUUID(), parentId: null, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }),
  ].join('\n')}\n`);
  print('fixture', { sandbox, sessionId, parentCwd, targetCwd, rounds: ROUNDS, expectedRetryAfterMs: EXPECTED_RETRY_AFTER_MS, clientDeadlineMs: CLIENT_DEADLINE_MS });

  // ── 臂 A：真树 + knob=0 + 暂停的 worker ⇒ 必须诚实可重试的 503（3 发）。
  const hostA = await startHost({ treeDir: root, home, sessionsRoot, workspace: parentCwd, logFile: path.join(sandbox, 'knob0.log'), liveFactsTimeoutMs: 0 });
  hosts.push(hostA.child);
  const forward = [];
  const handoffForward = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const response = await pausedWorkerGuardRequest({ host: hostA, sessionId, path: '/move', body: { cwd: targetCwd, share: true }, timeoutMs: CLIENT_DEADLINE_MS });
    forward.push(response);
    print(`A forward round ${round + 1} (knob=0)`, {
      schema: response.timedOut ? 'CLIENT TIMEOUT' : 'completed',
      statusCode: response.statusCode, elapsedMs: response.elapsedMs,
      error: response.value?.error ?? null, details: response.value?.details ?? null,
      retryAfterHeader: response.headers?.['retry-after'] ?? null,
    });
    assert.equal(response.timedOut, false, `forward round ${round + 1}: the response must finish inside ${CLIENT_DEADLINE_MS}ms even with the worker suspended`);
    assert.equal(response.statusCode, 503, `forward round ${round + 1}: a live-facts timeout must be an honest retryable 503, not ${response.statusCode}: ${response.body}`);
    assert.equal(response.value?.error, 'live_facts_unavailable', `forward round ${round + 1}: error code: ${response.body}`);
    assert.equal(response.value?.details?.retryable, true, `forward round ${round + 1}: details.retryable must be true: ${response.body}`);
    assert.equal(response.value?.details?.retryAfterMs, EXPECTED_RETRY_AFTER_MS, `forward round ${round + 1}: details.retryAfterMs must match Retry-After: 1: ${response.body}`);
    // C4（F7 收尾）：守卫路的 503 也必须有与 JSON 对齐的 HTTP 头。
    assert.equal(response.headers?.['retry-after'], '1', `forward round ${round + 1}: the guard-path 503 must carry the matching Retry-After header: ${JSON.stringify(response.headers)}`);
    await assertHostAlive(hostA, round + 1);
    // C4：`/handoff` 那条守卫路是**另一个** catch（`guardHandoff`）——同一条死线、同一个 helper，
    // 也要有对齐的头。它在调 `allLiveSessionFacts()` 之前同样不做 IPC ⇒ 同一种暂停摆法可判。
    const handoff = await pausedWorkerGuardRequest({ host: hostA, sessionId, path: '/handoff', body: { to: { cwd: targetCwd } }, timeoutMs: CLIENT_DEADLINE_MS });
    handoffForward.push(handoff);
    print(`A forward round ${round + 1} handoff (knob=0)`, {
      statusCode: handoff.statusCode, elapsedMs: handoff.elapsedMs,
      error: handoff.value?.error ?? null, retryable: handoff.value?.details?.retryable ?? null,
      retryAfterMs: handoff.value?.details?.retryAfterMs ?? null, retryAfterHeader: handoff.headers?.['retry-after'] ?? null,
    });
    assert.equal(handoff.statusCode, 503, `handoff round ${round + 1}: ${handoff.statusCode} ${handoff.body}`);
    assert.equal(handoff.value?.error, 'live_facts_unavailable', `handoff round ${round + 1}: ${handoff.body}`);
    assert.equal(handoff.value?.details?.retryable, true, `handoff round ${round + 1}: ${handoff.body}`);
    assert.equal(handoff.headers?.['retry-after'], '1', `handoff round ${round + 1}: the guard path must carry the matching Retry-After header: ${JSON.stringify(handoff.headers)}`);
  }
  print('A forward arm', { verdict: `${forward.length}/${forward.length} rounds = 503 + retryable + retryAfterMs (+ same for /handoff)`, statusCodes: forward.map((r) => r.statusCode), handoffStatusCodes: handoffForward.map((r) => r.statusCode), elapsedMs: forward.map((r) => r.elapsedMs) });
  await stop(hostA.child);

  // ── 臂 B（控制）：同一份真树，knob=5000 ⇒ 仍必须 503，但**要等 ~5s** ⇒ 证明死线真的由这个旋钮驱动。
  const hostB = await startHost({ treeDir: root, home, sessionsRoot, workspace: parentCwd, logFile: path.join(sandbox, 'knob5000.log'), liveFactsTimeoutMs: 5000 });
  hosts.push(hostB.child);
  const control = await pausedWorkerGuardRequest({ host: hostB, sessionId, path: '/move', body: { cwd: targetCwd, share: true }, timeoutMs: CONTROL_CLIENT_DEADLINE_MS });
  print('B control (knob=5000)', {
    schema: control.timedOut ? 'CLIENT TIMEOUT' : 'completed',
    statusCode: control.statusCode, elapsedMs: control.elapsedMs,
    error: control.value?.error ?? null, details: control.value?.details ?? null,
  });
  assert.equal(control.timedOut, false, `control: the response must finish inside ${CONTROL_CLIENT_DEADLINE_MS}ms`);
  assert.equal(control.statusCode, 503, `control: knob=5000 must still be the honest 503: ${control.statusCode} ${control.body}`);
  assert.ok(control.elapsedMs >= CONTROL_MIN_MS, `control: with knob=5000 the deadline must actually be ~5s, got ${control.elapsedMs}ms —— 旋钮没有在管这条死线`);
  await assertHostAlive(hostB, 'B');
  await stop(hostB.child);

  // ── 臂 C（反证）：副本上把那条路改回「普通 Error（无 details）」 ⇒ 同一发**必须**丢掉可重试语义。
  const mutated = await materialize(path.join(sandbox, 'mutated'), { plainError: true });
  print('C mutation', mutated.mutated);
  const mutatedBase = await readFile(path.join(mutated.dir, 'server', 'base.mjs'));
  const realBase = await readFile(path.join(root, 'server', 'base.mjs'));
  print('C mutation digest', { mutated: digestOf(mutatedBase), realTree: digestOf(realBase), differs: digestOf(mutatedBase) !== digestOf(realBase) });
  assert.notEqual(digestOf(mutatedBase), digestOf(realBase), 'the mutated copy must differ from the real tree (otherwise the arm tests nothing)');
  const mutatedHome = path.join(sandbox, 'home-mutated');
  await mkdir(mutatedHome, { recursive: true });
  await writeFile(path.join(mutatedHome, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(mutatedHome, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const hostC = await startHost({ treeDir: mutated.dir, home: mutatedHome, sessionsRoot, workspace: parentCwd, logFile: path.join(sandbox, 'mutated.log'), liveFactsTimeoutMs: 0 });
  hosts.push(hostC.child);
  const reverse = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const response = await pausedWorkerGuardRequest({ host: hostC, sessionId, path: '/move', body: { cwd: targetCwd, share: true }, timeoutMs: CLIENT_DEADLINE_MS });
    reverse.push(response);
    print(`C reverse round ${round + 1} (mutation, knob=0)`, {
      schema: response.timedOut ? 'CLIENT TIMEOUT' : 'completed',
      statusCode: response.statusCode, elapsedMs: response.elapsedMs,
      error: response.value?.error ?? null, details: response.value?.details ?? null,
    });
    assert.equal(response.timedOut, false, `reverse round ${round + 1}: even the mutated path must finish (no hang): ${response.elapsedMs}ms`);
    const honest = response.statusCode === 503 && response.value?.details?.retryable === true;
    assert.equal(honest, false, `reverse round ${round + 1}: with the honest 503 removed the receipt must NOT still be 503+retryable (that would mean the arm judges nothing): ${response.statusCode} ${response.body}`);
    await assertHostAlive(hostC, round + 1);
  }
  print('C reverse arm', { verdict: 'WITHOUT the honest 503 the receipt loses retryable semantics', statusCodes: reverse.map((r) => r.statusCode), errors: reverse.map((r) => r.value?.error ?? null) });
  print('RESULT', { ok: true, forward: forward.map((r) => r.statusCode), control: control.statusCode, controlElapsedMs: control.elapsedMs, reverse: reverse.map((r) => r.statusCode) });
  process.stdout.write('RESULT: live-facts-deadline PASS\n');
} catch (error) {
  primaryError = error;
} finally {
  for (const child of hosts) await stop(child);
  await removeSandbox(sandbox, problems);
  finishCleanup(primaryError, problems);
}
