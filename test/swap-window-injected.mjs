#!/usr/bin/env node
// test/swap-window-injected.mjs —— 用**故障注入**把「换代窗口里那一发失败」摆成确定性夹具（与平台无关）。
//
// 为什么要有这道门（2026-09-21，范围扩展单）：那条口径原来只有三条证据，而它们**全都要 POSIX 信号**：
//   · `test/fallback-proxy-retry.mjs`（`reached === false` 那条收尾 + 写请求 503 带 `Retry-After`）
//     —— 摆法要「按精确 pid SIGSTOP 住当前代 ⇒ 发请求 ⇒ SIGKILL」；
//   · `test/live-facts-deadline.mjs`（守卫路 503 的 `Retry-After: 1`）—— 要 SIGSTOP 当前 worker；
//   · `test/host-session-path-probe.mjs --phase read-retry`（owner 路由的读路径重试）—— 要 SIGSTOP g1。
// Windows 没有 SIGSTOP（`process.kill(pid,'SIGSTOP')` 直接抛 `ERR_UNKNOWN_SIGNAL`）⇒ 那条口径在 Windows
// 上**一条门都没有**。本门换摆法：**不用信号、不靠时序竞态**，用两个只测不产的注入旋钮（与仓里既有的
// `SOPHO_FAULT_ATOMIC_RENAME` 同口径，不设时零影响）：
//
//   ① `SOPHO_FAULT_NO_WORKER_REPLY=<COUNT>[:<METHOD>[:<PATH-PREFIX>]]`（逻辑层，见 `server/base-logic.mjs`）
//      —— 让这一发**没有上游回话**（在写出任何字节之前把连接掐掉）。宿主侧看到的就是 `reached === false`
//      （`proxyToWorker` 的 `upstreamRequest` 报错）⇒ **必然**走 `finishFailedProxy` 那条收尾：
//        幂等 GET/HEAD ⇒ 换当前代**重试一次**；写请求 ⇒ **一次都不重试**，回 `503 generation_swapped`
//        + `retryable:true` + `retryAfterMs:1000` + HTTP 头 `Retry-After: 1`。
//   ② `SOPHO_FAULT_LIVE_FACTS_DOWN=<COUNT>`（逻辑层同一处）—— 让前 COUNT 次 `liveSessionFacts()` 抛。
//      宿主侧 `callWorker({type:'live-facts'})` 收到 `{type:'error'}` ⇒ `allLiveSessionFacts()` 统一包成
//      `503 live_facts_unavailable` + `details.retryable` ⇒ 守卫路（`/move`…）确定地回「答不上来 + 可重试
//      + `Retry-After: 1`」。它证明的是**真**语义（worker 确实答不上），不是伪造一个响应。
//
// 两个夹具（`--fixture retry-after` / `--fixture read-retry`；默认两个都跑，各自独立报告）：
//
//   A · `Retry-After: 1`（正例 / 负例 / 反证）
//     A1 正例：换代窗口那一发（写请求 + 注入①）⇒ **带** `Retry-After: 1`，且与 body 的
//        `retryAfterMs:1000` 一致；A2 正例：守卫路那条（注入②）⇒ 同样**带**。
//     A3/A4/A5 负例：**非**可重试的 404 / 409（两条）/ 500 ⇒ **一律不带**这个头（不许「任何错都加」）。
//     A6/A7 反证：把两处加头的代码在**沙箱副本**里去掉 ⇒ A1/A2 的断言必红（并贴红）。
//
//   B · 读路径重试支（幂等 GET/HEAD 换当前代重试一次 / 写请求一次都不重试 / 不带旗标时行为不变）
//     B1 owner 路由：注入①一次 ⇒ GET 该会话**重试一次并成功**（200），宿主日志里恰好 1 行
//        `generation swap (owner route): retrying GET …`；B2 上界：注入①**两次** ⇒ 只重试一次就停（仍
//        恰 1 行 ⇒ 总共 2 发），那发是诚实可重试的 503（不是裸 502）。
//     B3 写请求：注入①一次 ⇒ `POST …/archive` 得 503 + 可重试语义 + `Retry-After: 1`，**0 行
//        `retrying POST`**，且那次 archive **没有落库**（= 只有一次尝试，没有双写）。
//     B4/B5 兜底 proxy 那条入口（与 owner 路由共用 `finishFailedProxy`）：读 ⇒ 重试一次并被 worker 答
//        （404「not found」是 worker 说的，不是宿主编的）；写 ⇒ 503 + 0 行 `retrying POST`。
//     B6 零影响：**不设旋钮**的宿主上，同样那几发全部按今天的路走（200/200、archive 落库、0 行重试）。
//     B7/B8 反证（沙箱副本）：把 `finishFailedProxy` 的幂等判定改成 `if (false)` ⇒ B1 必红；改成
//        `if (true)`（写也重试）⇒ B3 必红（archive 落库 / 出现 `retrying POST`）。
//
// 沙箱纪律：一律经 `test/sandbox-guard.mjs`（同生共死 + 寿命上限）；副本 home + 高位随机端口；
// 进程只按**精确 pid** 停（绝不 pkill）；真树 `server/` 一字不动（突变只落在副本里 + `node --check`）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { finishCleanup, listenerPid, removeSandbox } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_ENTRY = path.join(ROOT, 'test', 'sandbox-guard.mjs');
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SESSION_ID = '01a0a100-0000-4000-8000-000000000001';
const UNKNOWN_SESSION_ID = '01a0a100-0000-4000-8000-0000000000ff';
const FALLBACK_PATH = '/definitely-not-a-route';
const SANDBOX_LIFETIME_MS = 4 * 60 * 1000;

// 突变锚（都只落在**沙箱副本**里；每个都在真树里恰好出现 1 次，找不到就是红：门在报「它盯的代码跑了」）。
const IDEMPOTENT_ANCHOR = "  if (method === 'GET' || method === 'HEAD') {";
const WORKER_UNAVAILABLE_HEADER_ANCHOR = "    retryAfterMs: 1000,\n  }, { 'retry-after': '1' });";
const GUARD_HEADER_ANCHOR = "  }, retryable ? { 'retry-after': '1' } : {});";

const failures = [];
let armsRun = 0;
async function arm(label, fn) {
  armsRun += 1;
  try { await fn(); process.stdout.write(`✓ ${label}\n`); }
  catch (error) { failures.push({ label, error }); process.stdout.write(`✗ ${label} —— ${error instanceof Error ? error.message : String(error)}\n`); }
}

const reserveHighPort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => { const { port } = listener.address(); listener.close(() => resolve(port)); });
});

function request(port, pathname, { method = 'GET', body = null, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs,
      headers: { accept: 'application/json', connection: 'close', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let value = null;
        try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
        resolve({ statusCode: response.statusCode, headers: response.headers, value, body: raw.slice(0, 240) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

async function poll(label, fn, ok, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (ok(last)) return last; } catch (error) { last = error; }
    await sleep(50);
  }
  throw new Error(`${label} timed out; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

// ── 沙箱：副本 home + 一条会话文件 + 高位随机端口，宿主经 test/sandbox-guard.mjs 包起 ─────────────
async function startHost({ label, treeDir = ROOT, extraEnv = {} }) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), `swap-injected-${label}-`));
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'workspace');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const at = '2026-09-18T00:00:00.000Z';
  await writeFile(path.join(sessionsRoot, `s_${SESSION_ID}.jsonl`), `${[
    JSON.stringify({ type: 'session', version: 3, id: SESSION_ID, timestamp: at, cwd: workspace }),
    JSON.stringify({ type: 'session_info', id: '01a0a100-0000-4000-8000-000000000002', parentId: null, timestamp: at, name: 'injected-fixture' }),
    JSON.stringify({ type: 'message', id: '01a0a100-0000-4000-8000-000000000003', parentId: null, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'injected-fixture' }] } }),
  ].join('\n')}\n`);

  const port = await reserveHighPort();
  const logPath = path.join(sandbox, 'host.log');
  const logHandle = await open(logPath, 'w');
  const guard = spawn(process.execPath, [
    GUARD_ENTRY,
    '--entry', path.join(treeDir, 'server', 'base.mjs'),
    '--label', `swap-injected-${label}`,
    '--lifetime-ms', String(SANDBOX_LIFETIME_MS),
    '--watch-stdin',
  ], {
    cwd: treeDir,
    env: {
      ...process.env,
      HOME: home, ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: workspace, SOPHO_NO_TOOLS: '1',
      ...extraEnv,
    },
    stdio: ['pipe', logHandle.fd, logHandle.fd, 'ipc'],
    detached: true,
  });
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sandbox ${label}: guard never reported sandbox-start`)), 30_000);
    guard.on('message', (message) => {
      if (message?.type !== 'sandbox-start') return;
      clearTimeout(timer);
      resolve(message);
    });
    guard.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`sandbox ${label}: guard exited before the host started (code=${code} signal=${signal})`));
    });
  });
  const hostReply = await poll(`sandbox ${label}: host ready`, () => request(port, '/host', { timeoutMs: 3000 }), (reply) => reply.statusCode === 200);  // 起完必须核「监听者 = 守卫报的 pid = /host 报的 pid」——这也是「只按精确 pid 停」的前提。
  const listener = await listenerPid(port);
  assert.equal(listener, started.pid, `sandbox ${label}: 端口 ${port} 的监听者必须是守卫报的那个 pid`);
  assert.equal(hostReply.value?.pid, started.pid, `sandbox ${label}: /host 报的 pid 必须与守卫报的一致`);
  return { label, sandbox, home, sessionsRoot, workspace, port, logPath, logHandle, guard, hostPid: started.pid, host: hostReply.value };
}

async function stopHost(runtime) {
  if (!runtime) return;
  const { guard, hostPid, port, logHandle } = runtime;
  try { guard?.stdin?.end(); } catch { /* 守卫已经没了 */ }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && guard?.pid && alive(guard.pid)) await sleep(50);
  // 按精确 pid 收尾；pid 已经不在（ESRCH）不算错 —— 那一发本来就只可能是“它已经自己退了”。
  const killIfAlive = (pid) => { if (!pid || !alive(pid)) return; try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; } };
  killIfAlive(guard?.pid);
  killIfAlive(hostPid);
  for (let attempt = 0; attempt < 100 && await listenerPid(port); attempt += 1) await sleep(50);
  await logHandle.close().catch(() => {});
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const logText = (runtime) => readFile(runtime.logPath, 'utf8').catch(() => '');
/** 宿主日志里的重试行（`finishFailedProxy` 的机械证据）。 */
async function retryLines(runtime, { entry = null, method = null } = {}) {
  const text = await logText(runtime);
  return text.split('\n').filter((line) => line.includes('generation swap (')
    && (entry === null || line.includes(`generation swap (${entry})`))
    && (method === null || line.includes(`: retrying ${method} `)));
}

/** 在沙箱副本里做一处突变（真树 `server/` 一个字不动）。 */
async function materialize(dir, edits) {
  await mkdir(dir, { recursive: true });
  await cp(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true });
  await cp(path.join(ROOT, 'web'), path.join(dir, 'web'), { recursive: true });
  await cp(path.join(ROOT, 'pi-extensions'), path.join(dir, 'pi-extensions'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), await readFile(path.join(ROOT, 'package.json')));
  await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const file = path.join(dir, 'server', 'base.mjs');
  let text = await readFile(file, 'utf8');
  for (const edit of edits) {
    const occurrences = text.split(edit.from).length - 1;
    assert.equal(occurrences, 1, `mutation anchor must appear exactly once in server/base.mjs (${edit.what}); found ${occurrences}`);
    text = text.replace(edit.from, edit.to);
  }
  await writeFile(file, text);
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => execFile(process.execPath, ['--check', file], (error, stdout, stderr) => error ? reject(new Error(`mutated base.mjs does not parse: ${stderr || error.message}`)) : resolve()));
  print('mutation', { dir, edits: edits.map((edit) => edit.what) });
  return dir;
}

// ── 夹具 A：`Retry-After: 1` ───────────────────────────────────────────────────────────────
// 判据写成一函数一断言，正例/负例/反证共用：反证臂要求「同一个判据**必须不成立**」。
const hasRetryAfterHeader = (reply) => reply.headers?.['retry-after'] === '1';
const describe = (reply) => ({ statusCode: reply.statusCode, retryAfter: reply.headers?.['retry-after'] ?? null, error: reply.value?.error ?? null, retryable: reply.value?.retryable ?? reply.value?.details?.retryable ?? null, retryAfterMs: reply.value?.retryAfterMs ?? reply.value?.details?.retryAfterMs ?? null });

/** A1 的判据：换代窗口里的写请求 ⇒ 诚实可重试的 503 **且头一致**。 */
const swapWindowWriteIsHonest = (reply) => reply.statusCode === 503
  && reply.value?.error === 'generation_swapped'
  && reply.value?.retryable === true
  && reply.value?.retryAfterMs === 1000
  && hasRetryAfterHeader(reply);
/** A2 的判据：守卫路答不上 live-facts ⇒ 503 `live_facts_unavailable` **且头一致**。 */
const guardPathIsHonest = (reply) => reply.statusCode === 503
  && reply.value?.error === 'live_facts_unavailable'
  && reply.value?.details?.retryable === true
  && reply.value?.details?.retryAfterMs === 1000
  && hasRetryAfterHeader(reply);

// ── 夹具 B：读路径重试支 ───────────────────────────────────────────────────────────────────
/** B1/B2 的判据：GET 那一发在窗口里恰好重试一次（成不成由 statusCode 另行断言）。 */
const readRetriedExactlyOnce = (measured) => measured.retryLines === 1;

const scenarioOwnerRead = async (host) => {
  const reply = await request(host.port, `/sessions/${SESSION_ID}`);
  return { ...describe(reply), retryLines: (await retryLines(host, { entry: 'owner route', method: 'GET' })).length };
};
const scenarioFallbackRead = async (host) => {
  const reply = await request(host.port, FALLBACK_PATH);
  return { ...describe(reply), retryLines: (await retryLines(host, { entry: 'fallback proxy', method: 'GET' })).length };
};
/** B3/B8 的判据：写请求（archive）一次都不重试，而且**没有落库**。 */
const scenarioOwnerWrite = async (host) => {
  const before = (await retryLines(host, { method: 'POST' })).length;
  const reply = await request(host.port, `/sessions/${SESSION_ID}/archive`, { method: 'POST', body: { archived: true } });
  const detail = await request(host.port, `/sessions/${SESSION_ID}`);
  return {
    ...describe(reply),
    retryLines: (await retryLines(host, { method: 'POST' })).length - before,
    archivedLanded: detail.value?.archived === true,
  };
};
const scenarioFallbackWrite = async (host) => {
  const before = (await retryLines(host, { method: 'POST' })).length;
  const reply = await request(host.port, FALLBACK_PATH, { method: 'POST', body: { hello: 'world' } });
  return { ...describe(reply), retryLines: (await retryLines(host, { method: 'POST' })).length - before };
};

const writeNeverRetried = (measured) => measured.statusCode === 503
  && measured.error === 'generation_swapped'
  && measured.retryable === true
  && measured.retryLines === 0
  && measured.archivedLanded === false;

// ── 两个夹具 ───────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const fixtureArg = (() => {
  const inline = args.find((arg) => arg.startsWith('--fixture='));
  if (inline) return inline.slice('--fixture='.length);
  const index = args.indexOf('--fixture');
  return index >= 0 ? args[index + 1] : 'all';
})();
const WANT = { 'retry-after': fixtureArg === 'all' || fixtureArg === 'retry-after', 'read-retry': fixtureArg === 'all' || fixtureArg === 'read-retry' };
assert.ok(WANT['retry-after'] || WANT['read-retry'], `unknown --fixture: ${fixtureArg}（要 all / retry-after / read-retry）`);

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'swap-injected-'));
const problems = [];
const hosts = [];
let primaryError = null;
try {
  print('fixture', { sandbox, fixtures: Object.keys(WANT).filter((key) => WANT[key]), platform: process.platform });

  if (WANT['read-retry']) {
    // B6 先跑：**不设旋钮**时这几发必须与今天完全一样（旋钮的“不设时零影响”）。
    const clean = await startHost({ label: 'clean' });
    hosts.push(clean);
    await arm('B6 零影响 · **不设**注入旋钮：读还是 200、写还是落库、0 行重试（与今天一字不差）', async () => {
      const read = await scenarioOwnerRead(clean);
      const write = await scenarioOwnerWrite(clean);
      print('  B6 measured', { read, write });
      assert.equal(read.statusCode, 200, `不设旋钮时 GET 就是普通 200：${JSON.stringify(read)}`);
      assert.equal(read.retryLines, 0, `不设旋钮时不该有重试：${JSON.stringify(read)}`);
      assert.equal(write.statusCode, 200, `不设旋钮时 POST /archive 就是普通 200：${JSON.stringify(write)}`);
      assert.equal(write.archivedLanded, true, `不设旋钮时 archive 必须落库：${JSON.stringify(write)}`);
      assert.equal(write.retryLines, 0, `不设旋钮时不该有重试：${JSON.stringify(write)}`);
    });

    // B1 owner 路由 · 读路径：注入一次 ⇒ 重试一次并**成功**。
    const ownerReadHost = await startHost({ label: 'owner-read', extraEnv: { SOPHO_FAULT_NO_WORKER_REPLY: `1:GET:/sessions/${SESSION_ID}` } });
    hosts.push(ownerReadHost);
    await arm('B1 读路径重试支 · owner 路由：注入「这一发没回话」⇒ GET **重试一次并成功**（200，恰 1 行重试）', async () => {
      const measured = await scenarioOwnerRead(ownerReadHost);
      print('  B1 measured', measured);
      assert.equal(measured.retryLines, 1, `必须恰好重试一次：${JSON.stringify(measured)}`);
      assert.equal(measured.statusCode, 200, `重试那一发必须成功：${JSON.stringify(measured)}`);
      assert.equal(measured.retryable, null, `成功那一发不该是可重试回执：${JSON.stringify(measured)}`);
    });

    // B2 上界：注入两次 ⇒ 只重试一次就停（总共 2 发），那发是诚实可重试的 503。
    const twiceHost = await startHost({ label: 'owner-read-twice', extraEnv: { SOPHO_FAULT_NO_WORKER_REPLY: `2:GET:/sessions/${SESSION_ID}` } });
    hosts.push(twiceHost);
    await arm('B2 上界 · 注入**两次** ⇒ 只重试一次就停（仍恰 1 行重试）+ 那发是诚实可重试的 503（不是裸 502）', async () => {
      const measured = await scenarioOwnerRead(twiceHost);
      print('  B2 measured', measured);
      assert.ok(readRetriedExactlyOnce(measured), `重试次数上界=1：${JSON.stringify(measured)}`);
      assert.equal(measured.statusCode, 503, `两次都没回话 ⇒ 诚实可重试的 503：${JSON.stringify(measured)}`);
      assert.equal(measured.error, 'generation_swapped', `…error=generation_swapped：${JSON.stringify(measured)}`);
      assert.equal(measured.retryable, true, `…retryable:true：${JSON.stringify(measured)}`);
      assert.notEqual(measured.statusCode, 502, '不许是裸 502');
    });

    // B3 写请求：注入一次 ⇒ 绝不重试、不落库、回可重试语义。
    const writeHost = await startHost({ label: 'owner-write', extraEnv: { SOPHO_FAULT_NO_WORKER_REPLY: `1:POST:/sessions/${SESSION_ID}/archive` } });
    hosts.push(writeHost);
    await arm('B3 写请求 · owner 路由：注入一次 ⇒ **一次都不重试**（0 行 `retrying POST`）+ 那次写没有落库', async () => {
      const measured = await scenarioOwnerWrite(writeHost);
      print('  B3 measured', measured);
      assert.ok(writeNeverRetried(measured),
        `写请求不许重试、被拒的那次不许落库：${JSON.stringify(measured)}`);
    });

    // B4/B5 兜底 proxy 那条入口（与 owner 路由共用 finishFailedProxy）。
    const fallbackReadHost = await startHost({ label: 'fallback-read', extraEnv: { SOPHO_FAULT_NO_WORKER_REPLY: `1:GET:${FALLBACK_PATH}` } });
    hosts.push(fallbackReadHost);
    await arm('B4 读路径重试支 · 兜底 proxy 入口：注入一次 ⇒ 重试一次，并且那一发是 **worker 答的** 404（不是宿主编的）', async () => {
      const measured = await scenarioFallbackRead(fallbackReadHost);
      print('  B4 measured', measured);
      assert.ok(readRetriedExactlyOnce(measured), `必须恰好重试一次：${JSON.stringify(measured)}`);
      assert.equal(measured.statusCode, 404, `重试那一发落到 worker 上 ⇒ worker 说「not found」：${JSON.stringify(measured)}`);
      assert.equal(measured.error, 'not found', `那 404 必须是 worker 自己那句 not found（不是宿主编的）：${JSON.stringify(measured)}`);
    });
    const fallbackWriteHost = await startHost({ label: 'fallback-write', extraEnv: { SOPHO_FAULT_NO_WORKER_REPLY: `1:POST:${FALLBACK_PATH}` } });
    hosts.push(fallbackWriteHost);
    await arm('B5 写请求 · 兜底 proxy 入口：注入一次 ⇒ 503 + 可重试语义 + `Retry-After: 1`，0 行 `retrying POST`', async () => {
      const measured = await scenarioFallbackWrite(fallbackWriteHost);
      print('  B5 measured', measured);
      assert.equal(measured.retryLines, 0, `写请求不许重试：${JSON.stringify(measured)}`);
      assert.equal(measured.statusCode, 503, `写请求撞上「没接上」⇒ 诚实可重试的 503：${JSON.stringify(measured)}`);
      assert.equal(measured.error, 'generation_swapped', `…error=generation_swapped：${JSON.stringify(measured)}`);
      assert.equal(measured.retryable, true, `…retryable:true：${JSON.stringify(measured)}`);
      assert.equal(measured.retryAfterMs, 1000, `…retryAfterMs:1000：${JSON.stringify(measured)}`);
    });
  }

  if (WANT['retry-after']) {
    // A1 正例（换代窗口里那一发）+ A3/A4/A5 负例：同一台宿主就能都跑（负例与注入无关）。
    const receiptHost = await startHost({ label: 'retry-after', extraEnv: { SOPHO_FAULT_NO_WORKER_REPLY: `1:POST:/sessions/${SESSION_ID}/archive` } });
    hosts.push(receiptHost);
    await arm('A1 正例 · 换代窗口里的可重试回执**带** `Retry-After: 1`，且与 body 的 `retryAfterMs: 1000` 一致', async () => {
      const reply = await request(receiptHost.port, `/sessions/${SESSION_ID}/archive`, { method: 'POST', body: { archived: true } });
      print('  A1 measured', describe(reply));
      assert.ok(swapWindowWriteIsHonest(reply), `窗口里的写回执必须诚实可重试**且带一致的头**：${JSON.stringify(describe(reply))}`);
    });
    await arm('A3 负例 · **非**可重试的 worker 404（会话不存在）⇒ 不带 `Retry-After`', async () => {
      const reply = await request(receiptHost.port, `/sessions/${UNKNOWN_SESSION_ID}`);
      print('  A3 measured', describe(reply));
      assert.equal(reply.statusCode, 404, `前置：这一发就是 404：${JSON.stringify(describe(reply))}`);
      assert.equal(reply.headers?.['retry-after'], undefined, `非可重试的 404 不许带这个头：${JSON.stringify(reply.headers)}`);
    });
    await arm('A4 负例 · **非**可重试的 worker 409（目标 cwd 不存在）⇒ 不带 `Retry-After`', async () => {
      const reply = await request(receiptHost.port, `/sessions/${SESSION_ID}/move`, { method: 'POST', body: { cwd: path.join(receiptHost.sandbox, 'nope') } });
      print('  A4 measured', describe(reply));
      assert.equal(reply.statusCode, 409, `前置：这一发就是 409：${JSON.stringify(describe(reply))}`);
      assert.equal(reply.value?.error, 'target_cwd_missing', `前置：就是那条 409：${JSON.stringify(describe(reply))}`);
      assert.equal(reply.headers?.['retry-after'], undefined, `非可重试的 409 不许带这个头：${JSON.stringify(reply.headers)}`);
    });
    await arm('A5 负例 · **非**可重试的 worker 500（没配模型时发消息）⇒ 不带 `Retry-After`', async () => {
      const reply = await request(receiptHost.port, `/sessions/${SESSION_ID}/message`, { method: 'POST', body: { text: 'hi' } });
      print('  A5 measured', describe(reply));
      assert.equal(reply.statusCode, 500, `前置：这一发就是 500：${JSON.stringify(describe(reply))}`);
      assert.equal(reply.headers?.['retry-after'], undefined, `非可重试的 500 不许带这个头：${JSON.stringify(reply.headers)}`);
    });

    // A2 正例：守卫路（`sendErrorReceipt`）那条头 —— 注入②让它确定地「答不上 live-facts」。
    const guardHost = await startHost({ label: 'guard-live-facts', extraEnv: { SOPHO_FAULT_LIVE_FACTS_DOWN: '1' } });
    hosts.push(guardHost);
    await arm('A2 正例 · 守卫路（`/move` 答不上 live-facts）**带** `Retry-After: 1`，且 `details` 与它一致', async () => {
      const reply = await request(guardHost.port, `/sessions/${SESSION_ID}/move`, { method: 'POST', body: { cwd: guardHost.workspace } });
      print('  A2 measured', describe(reply));
      assert.ok(guardPathIsHonest(reply), `守卫路那条可重试 503 必须带头：${JSON.stringify(describe(reply))}`);
    });
  }

  // ── 反证臂（突变只落在沙箱副本里）──────────────────────────────────────────────────────────
  if (WANT['read-retry']) {
    const noRetryDir = await materialize(path.join(sandbox, 'mut-no-read-retry'), [{
      from: IDEMPOTENT_ANCHOR,
      to: "  if (false) {   // (mutation B7: 幂等读路径的重试被关掉)",
      what: 'B7 把 finishFailedProxy 的幂等判定改成 if (false)',
    }]);
    const noRetryHost = await startHost({ label: 'mut-no-read-retry', treeDir: noRetryDir, extraEnv: { SOPHO_FAULT_NO_WORKER_REPLY: `1:GET:/sessions/${SESSION_ID}` } });
    hosts.push(noRetryHost);
    await arm('B7 反证（突变：幂等重试关掉）⇒ B1 的判据**必红**（那发不再是 200，也没有重试行）', async () => {
      const measured = await scenarioOwnerRead(noRetryHost);
      print('  B7 mutated evidence（这一行就是「红」）', measured);
      assert.ok(!readRetriedExactlyOnce(measured), `关掉重试之后不许再出现重试行：${JSON.stringify(measured)}`);
      assert.notEqual(measured.statusCode, 200, `关掉重试之后那一发不许再是 200：${JSON.stringify(measured)}`);
      assert.equal(measured.statusCode, 503, `…而应当是那条诚实可重试的 503：${JSON.stringify(measured)}`);
      assert.equal(measured.error, 'generation_swapped', `…error=generation_swapped：${JSON.stringify(measured)}`);
    });

    const retryWritesDir = await materialize(path.join(sandbox, 'mut-retry-writes'), [{
      from: IDEMPOTENT_ANCHOR,
      to: "  if (true) {    // (mutation B8: 写请求也被重试（这正是双写风险）)",
      what: 'B8 让写请求也被重试',
    }]);
    const retryWritesHost = await startHost({ label: 'mut-retry-writes', treeDir: retryWritesDir, extraEnv: { SOPHO_FAULT_NO_WORKER_REPLY: `1:POST:/sessions/${SESSION_ID}/archive` } });
    hosts.push(retryWritesHost);
    await arm('B8 反证（突变：写请求也重试）⇒ B3 的判据**必红**（被拒的写被逮到重放/落库）', async () => {
      const measured = await scenarioOwnerWrite(retryWritesHost);
      print('  B8 mutated evidence（这一行就是「红」）', measured);
      assert.ok(!writeNeverRetried(measured), `写请求被重试之后，那条「一次都不重试」的判据必须不成立：${JSON.stringify(measured)}`);
      assert.ok(measured.retryLines > 0 || measured.archivedLanded === true,
        `必须能看见双写证据（出现 retrying POST 或那次写落库）：${JSON.stringify(measured)}`);
    });
  }

  if (WANT['retry-after']) {
    const noHeaderDir = await materialize(path.join(sandbox, 'mut-no-retry-after'), [
      { from: WORKER_UNAVAILABLE_HEADER_ANCHOR, to: "    retryAfterMs: 1000,\n  });", what: 'A6 去掉 sendWorkerUnavailable 的 Retry-After 头' },
      { from: GUARD_HEADER_ANCHOR, to: "  }, {});", what: 'A7 去掉 sendErrorReceipt 的 Retry-After 头' },
    ]);
    const noHeaderHost = await startHost({
      label: 'mut-no-retry-after',
      treeDir: noHeaderDir,
      extraEnv: { SOPHO_FAULT_NO_WORKER_REPLY: `1:POST:/sessions/${SESSION_ID}/archive`, SOPHO_FAULT_LIVE_FACTS_DOWN: '1' },
    });
    hosts.push(noHeaderHost);
    await arm('A6 反证（突变：`sendWorkerUnavailable` 的头去掉）⇒ A1 的判据**必红**', async () => {
      const reply = await request(noHeaderHost.port, `/sessions/${SESSION_ID}/archive`, { method: 'POST', body: { archived: true } });
      print('  A6 mutated evidence（这一行就是「红」）', describe(reply));
      assert.ok(!swapWindowWriteIsHonest(reply), `头没了之后 A1 的判据必须不成立：${JSON.stringify(describe(reply))}`);
      assert.equal(reply.headers?.['retry-after'], undefined, `…实测就是没有这个头：${JSON.stringify(reply.headers)}`);
      assert.equal(reply.value?.retryable, true, `…而 body 里的可重试语义照旧（变的是头）：${JSON.stringify(describe(reply))}`);
    });
    await arm('A7 反证（突变：`sendErrorReceipt` 的头去掉）⇒ A2 的判据**必红**', async () => {
      const reply = await request(noHeaderHost.port, `/sessions/${SESSION_ID}/move`, { method: 'POST', body: { cwd: noHeaderHost.workspace } });
      print('  A7 mutated evidence（这一行就是「红」）', describe(reply));
      assert.ok(!guardPathIsHonest(reply), `守卫路那条头没了之后 A2 的判据必须不成立：${JSON.stringify(describe(reply))}`);
      assert.equal(reply.headers?.['retry-after'], undefined, `…实测就是没有这个头：${JSON.stringify(reply.headers)}`);
      assert.equal(reply.value?.details?.retryable, true, `…而 details 里的可重试语义照旧（变的是头）：${JSON.stringify(describe(reply))}`);
    });
  }

  print('arms', { run: armsRun, failed: failures.length });
  if (failures.length > 0) {
    print('failed arms', failures.map((entry) => ({ label: entry.label, error: entry.error instanceof Error ? entry.error.message : String(entry.error) })));
    assert.deepEqual(failures.map((entry) => entry.label), [], `${failures.length} arm(s) failed`);
  }
  process.stdout.write(`RESULT: swap-window-injected PASS (arms:${armsRun}, platform:${process.platform})\n`);
} catch (error) {
  primaryError = error;
} finally {
  for (const host of hosts) await stopHost(host);
  await removeSandbox(sandbox, problems);
  finishCleanup(primaryError, problems);
}
