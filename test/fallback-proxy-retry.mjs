#!/usr/bin/env node
// C2 的门：**通用兜底 proxy** 那条入口（匹配不上 DELEGATION_PATH / SESSION_PATH 的路径）
// 在「一代没接上」（`proxied.reached === false`）时必须走 `finishFailedProxy`：
//   ① **绝不** `ReferenceError` / 500；② 幂等 GET 换当前代**重试一次**（或没有当前代时回诚实可重试）；
//   ③ 写请求（POST）**不重试**、回 503 + `retryable:true`；④ 宿主一直活着。
//
// 怎么把「没接上」做成确定的（不能靠 SIGSTOP —— 被暂停的进程**监听套接字仍在内核里**，
// `http.request` 的连接照样握手成功，于是宿主一直等响应、`reached` 永远是 false 的那条路根本走不到）：
//   把当前代 SIGSTOP 住 ⇒ 发请求（宿主会连上这个暂停的 worker 并在等它回话）
//   ⇒ 等 ~250ms（确保宿主已经连上）⇒ SIGKILL 那个 worker
//   ⇒ 已建立的上游连接被对端关掉 ⇒ 宿主的 `upstreamRequest` 报错 ⇒ `reached === false` ⇒ `finishFailedProxy`。
// 反证臂（`--reverse-arm`，副本上做）：把那个函数的**声明**改名（调用点照旧）⇒ 必红（500 ReferenceError）。
//
// 沙箱：副本 home + net 自留端口；进程一律**按精确 pid** 杀（绝不 pkill）；SIGSTOP 过的 worker 在 finally 里 SIGKILL。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
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
const REVERSE_ARM = process.argv.includes('--reverse-arm');
const CLIENT_DEADLINE_MS = 8000;
const ROUNDS = 3;
const FALLBACK_PATH = '/definitely-not-a-route';
const NO_GENERATION_MESSAGE = 'no live generation worker; POST /reload-code to start one';

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

const signalPid = (pid, signal) => { try { process.kill(pid, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

async function materialize(treeDir) {
  await mkdir(treeDir, { recursive: true });
  await cp(path.join(root, 'server'), path.join(treeDir, 'server'), { recursive: true });
  await cp(path.join(root, 'web'), path.join(treeDir, 'web'), { recursive: true });
  await cp(path.join(root, 'pi-extensions'), path.join(treeDir, 'pi-extensions'), { recursive: true });
  await writeFile(path.join(treeDir, 'package.json'), await readFile(path.join(root, 'package.json')));
  await symlink(path.join(root, 'node_modules'), path.join(treeDir, 'node_modules'), 'dir');
  if (!REVERSE_ARM) return { dir: treeDir, mutated: null };
  const file = path.join(treeDir, 'server', 'base.mjs');
  let text = await readFile(file, 'utf8');
  const anchor = 'async function finishFailedProxy(request, response, body, first, label, sessionId = null) {';
  assert.ok(text.includes(anchor), 'mutation anchor not found (the finishFailedProxy declaration)');
  text = text.replace(anchor, 'async function finishFailedProxy_DISABLED(request, response, body, first, label, sessionId = null) {   // (mutation: 声明被改名 ⇒ 调用点指向未定义的名字)');
  await writeFile(file, text);
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => execFile(process.execPath, ['--check', file], (error, stdout, stderr) => {
    if (error) reject(new Error(`mutated base.mjs does not even parse: ${stderr || error.message}`));
    else resolve();
  }));
  return { dir: treeDir, mutated: 'finishFailedProxy declaration renamed; call sites left dangling' };
}

async function startHost({ treeDir, home, sessionsRoot, workspace, logFile }) {
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
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await request(port, '/host', { timeoutMs: 3000 });
      if (response.statusCode === 200 && response.value?.currentWorkerPid) return { child, port, logFile, pid: response.value.pid };
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

async function waitForWorker(host, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(host.port, '/host', { timeoutMs: 3000 }).catch(() => null);
    if (response?.statusCode === 200 && Number.isInteger(response.value?.currentWorkerPid) && response.value.currentWorkerPid > 0) {
      if (alive(response.value.currentWorkerPid)) return response.value.currentWorkerPid;
    }
    await sleep(100);
  }
  throw new Error('no live current worker came up (recovery timed out)');
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'fallback-proxy-'));
const problems = [];
let primaryError = null;
const hosts = [];
const pendingStops = new Set();   // 被 SIGSTOP 过、还没死的 worker（finally 兜底 SIGKILL，免得不释放端口）
try {
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'workspace');
  for (const dir of [sessionsRoot, workspace]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  print('fixture', { sandbox, mode: REVERSE_ARM ? 'reverse-arm' : 'positive', fallbackPath: FALLBACK_PATH, rounds: ROUNDS, clientDeadlineMs: CLIENT_DEADLINE_MS });

  const treeDir = REVERSE_ARM ? (await materialize(path.join(sandbox, 'mutated'))).dir : root;
  if (REVERSE_ARM) print('mutation', 'finishFailedProxy declaration renamed ⇒ the call sites point at an undefined name');
  const host = await startHost({ treeDir, home, sessionsRoot, workspace, logFile: path.join(sandbox, `${REVERSE_ARM ? 'mutated' : 'fixed'}.log`) });
  hosts.push(host.child);

  const rounds = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const workerPid = await waitForWorker(host);
    signalPid(workerPid, 'SIGSTOP');
    pendingStops.add(workerPid);
    // 两条请求同时压在兜底入口上（GET 幂等、POST 写）——都发在 worker 还「活着但被暂停」时，
    // 所以宿主**一定**会走进兜底 proxy（`currentWorker()` 非空、child 也活着）。
    const getPromise = request(host.port, FALLBACK_PATH, { method: 'GET' });
    const postPromise = request(host.port, FALLBACK_PATH, { method: 'POST', body: { hello: 'world' } });
    await sleep(250);   // 让宿主的 upstreamRequest 连接建立（连上一个暂停的进程会成功握手）
    signalPid(workerPid, 'SIGKILL');
    pendingStops.delete(workerPid);
    const [get, post] = await Promise.all([getPromise, postPromise]);
    rounds.push({ round: round + 1, workerPid, get, post });
    print(`round ${round + 1} GET  ${FALLBACK_PATH}`, { schema: get.timedOut ? 'CLIENT TIMEOUT' : 'completed', statusCode: get.statusCode, elapsedMs: get.elapsedMs, error: get.value?.error ?? null, retryable: get.value?.retryable ?? null, message: get.value?.message ?? null });
    print(`round ${round + 1} POST ${FALLBACK_PATH}`, { schema: post.timedOut ? 'CLIENT TIMEOUT' : 'completed', statusCode: post.statusCode, elapsedMs: post.elapsedMs, error: post.value?.error ?? null, retryable: post.value?.retryable ?? null, retryAfterMs: post.value?.retryAfterMs ?? null, retryAfterHeader: post.headers?.['retry-after'] ?? null, message: post.value?.message ?? null });

    if (REVERSE_ARM) {
      // 反证臂的**期望**：声明没了 ⇒ 调用点抛 ReferenceError ⇒ 服务器把 routeRequest 的异常变成 500。
      const broken = [get, post].filter((response) => response.statusCode === 500 || (response.value?.message ?? '').includes('is not defined'));
      assert.ok(broken.length > 0, `REVERSE ARM: renaming the declaration must break the fallback entry (500 ReferenceError), but round ${round + 1} answered ${get.statusCode}/${post.statusCode} —— 这条臂**没判到东西**`);
    } else {
      // ① 绝不 ReferenceError / 500（含「声明漏了」那种）。
      for (const [label, response] of [['GET', get], ['POST', post]]) {
        assert.equal(response.timedOut, false, `round ${round + 1} ${label}: the fallback entry must answer inside ${CLIENT_DEADLINE_MS}ms`);
        assert.notEqual(response.statusCode, 500, `round ${round + 1} ${label}: 500 means the fallback entry threw: ${response.body}`);
        assert.ok(!(response.value?.message ?? '').includes('is not defined'), `round ${round + 1} ${label}: ReferenceError leaked: ${response.body}`);
        // 这一发**不是**「宿主动手之前就没有当前代」那条（那是 sendNoGeneration）⇒ 证明真走了 finishFailedProxy 的收尾。
        assert.notEqual(response.value?.message, NO_GENERATION_MESSAGE, `round ${round + 1} ${label}: this was sendNoGeneration, not the fallback proxy path: ${response.body}`);
        if (response.statusCode === 503) {
          assert.equal(response.value?.retryable, true, `round ${round + 1} ${label}: 503 must be honestly retryable: ${response.body}`);
          assert.equal(response.value?.retryAfterMs, 1000, `round ${round + 1} ${label}: retryAfterMs must match Retry-After: ${response.body}`);
          assert.equal(response.headers?.['retry-after'], '1', `round ${round + 1} ${label}: Retry-After header must accompany it: ${JSON.stringify(response.headers)}`);
        } else {
          // GET 有可能已经在新代上重试成功（404 由 worker 说）；写请求不允许这种情况。
          assert.equal(label, 'GET', `round ${round + 1} POST must not be retried (${response.statusCode}): ${response.body}`);
          assert.ok([200, 404].includes(response.statusCode), `round ${round + 1} GET: retried on the current generation ⇒ expected a worker answer, got ${response.statusCode}: ${response.body}`);
        }
      }
      // ③ 写请求：不重试 ⇒ 必然是 503 + retryable。
      assert.equal(post.statusCode, 503, `round ${round + 1}: a POST through the fallback entry must get the honest retryable 503, not ${post.statusCode}: ${post.body}`);
    }
    // ④ 宿主活着。
    const hostAlive = await request(host.port, '/host', { timeoutMs: 4000 });
    assert.equal(hostAlive.statusCode, 200, `round ${round + 1}: the host must stay alive`);
    assert.equal(hostAlive.value.pid, host.pid, `round ${round + 1}: host pid must not change`);
  }

  const log = await readFile(host.logFile, 'utf8');
  const retryLines = log.split('\n').filter((line) => line.includes('generation swap'));
  const failedLines = log.split('\n').filter((line) => line.includes('[base] request failed'));
  const referenceErrors = log.split('\n').filter((line) => line.includes('ReferenceError'));
  print('host log', { generationSwapLines: retryLines.length, baseRequestFailedLines: failedLines.length, referenceErrors: referenceErrors.length, sample: [...retryLines.slice(0, 2), ...failedLines.slice(0, 2)] });
  if (REVERSE_ARM) {
    assert.ok(referenceErrors.length > 0 || failedLines.length > 0, 'REVERSE ARM: the log must show the ReferenceError/500 (otherwise the arm judged nothing)');
    print('RESULT', { ok: true, mode: 'reverse-arm', verdict: 'the renamed declaration breaks the fallback entry (500 ReferenceError) as expected' });
    process.stdout.write('RESULT: fallback-proxy-retry REVERSE ARM PASS\n');
  } else {
    assert.equal(referenceErrors.length, 0, `the honest code must not log any ReferenceError: ${referenceErrors.join(' | ')}`);
    assert.equal(failedLines.length, 0, `no request may fail with an internal error: ${failedLines.join(' | ')}`);
    print('RESULT', { ok: true, mode: 'positive', rounds: rounds.length, statuses: rounds.map((r) => ({ get: r.get.statusCode, post: r.post.statusCode })), retryEvidence: retryLines.length });
    process.stdout.write('RESULT: fallback-proxy-retry PASS\n');
  }
} catch (error) {
  primaryError = error;
} finally {
  for (const pid of pendingStops) signalPid(pid, 'SIGKILL');
  for (const child of hosts) await stop(child);
  await removeSandbox(sandbox, problems);
  finishCleanup(primaryError, problems);
}
