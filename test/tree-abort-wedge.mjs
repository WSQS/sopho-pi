#!/usr/bin/env node
// 2026-10-04 那次 `/tree` 持续 500 的**受控复现 ＋ 会判红的门**。
//
// 定性（`docs/plans/incident-2026-10-04-tree-live-facts.md`）：一条工具永不返回 ⇒
//   `POST /sessions/{id}/abort` 里的 `session.abort()`（= pi 的 `agent.abort()` + `await waitForIdle()`，
//   **无死线**）永不 resolve ⇒ 它跑在的按会话串行队列（`pool.runExclusive`）被**永久占住**
//   ⇒ `/tree` 的热 runtime 覆写与 `liveSessionFacts()` 全部排在它后面 ⇒ worker 一个字不回
//   ⇒ 宿主 5000ms 硬超时 ⇒ 500 / 53 字节。
//
// 这个门做三件事（每一件都有**原始读数**进报告）：
//   A 受控复现（真树）：副本 home ＋ 副本树 ＋ 高位随机端口 ＋ 本地假 provider。假 provider 对含 `HANG`
//     的回合发一个 `bash` 工具调用，命令是**逃逸后代持续写继承 stdout**（`setsid bash -c '…echo tick…' &`）
//     ⇒ pi 的 `waitForChildProcess` 永不 finalize ⇒ 工具永不返回 ⇒ 回合永不结束（`in_flight_turn`）。
//   B 修法断言（真树）：`POST /abort` 必须**有限时间内**如实回 `{aborted:false, reason:'abort_timeout'}`
//     （绝不挂住）；同时发起的 `GET /tree` 必须在死线内回 **200 ＋ 扫盘底 ＋ 明确降级标注**
//     （`liveFactsUnavailable:[{sessionId, reason:'handle_timeout'}]`），不是 500、也不撒谎；
//     队列必须**继续服务**（abort 之后同一个 handle 的 `GET /sessions/{id}` 仍能在有限时间内答上来）。
//   C 反证臂（打**副本**）：把三条新牙各自拆掉一处，断言真门**必红**在预期那条上：
//       · `--reverse-arm=no-abort-deadline`：abort 拆掉显式死线 ⇒ 红在「abort 没回话」；
//       · `--reverse-arm=no-tree-deadline`：`/tree` 热覆写拆掉 per-handle 死线 ⇒ 红在缺失
//         `liveFactsUnavailable` 标注（handle 被占住，读到的仍是能答时的旧事实，不是降级）；
//       · `--reverse-arm=lying-annotation`：超时了却**不写进**降级标注 ⇒ 红在同一处（标注撒谎）。
//
// 纪律：不碰 7331/7321；不写活实例日志（日志在沙箱自己的目录）；只按**精确 pid** 收尾（绝不 pkill）；
//       逃逸后代的 pid 由它自己写进沙箱里的一个 pid 文件（精确杀，不靠 ps/pgrep 模式匹配）。
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { removeSandbox, runGateOnMutatedCopy } from './harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 反证臂会把本门当「真门」在**副本**上再跑一次（副本根由这个 env 传进来）。
const ROOT = process.env.SOPHO_DEBUG_GATE_ROOT ? path.resolve(process.env.SOPHO_DEBUG_GATE_ROOT) : repoRoot;
const guardEntry = path.join(repoRoot, 'test', 'sandbox-guard.mjs');
const ARM = (process.argv.find((argument) => argument.startsWith('--reverse-arm=')) || '').split('=')[1] || null;

const SANDBOX_LIFETIME_MS = Number(process.env.SOPHO_SANDBOX_LIFETIME_MS) || 4 * 60 * 1000;
// abort 自己的死线：真树默认 2000ms；门把它固定成 2000 好让「到点如实回 abort_timeout」有确定的读数。
const ABORT_DEADLINE_MS = 2000;
const CLIENT_DEADLINE_MS = 9000;
const ABORT_CLIENT_DEADLINE_MS = ABORT_DEADLINE_MS + 4000;
const TREE_UNDER_DEADLINE_MS = 1500; // 真树：(per-handle 250ms + 扫盘) ≪ 15 00；被占住时若没死线会 ~2000ms

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
async function killPid(pid, signal) {
  try { process.kill(pid, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

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

function request(port, method, pathname, body, timeoutMs = CLIENT_DEADLINE_MS) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const startedAt = Date.now();
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': payload.length, connection: 'close' }
        : { connection: 'close' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value = text;
        try { value = text ? JSON.parse(text) : null; } catch {}
        resolve({ statusCode: response.statusCode, value, text, bytes: Buffer.byteLength(text), ms: Date.now() - startedAt, timedOut: false });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`client timeout ${timeoutMs}ms`)); });
    req.once('error', (error) => {
      if (String(error.message).startsWith('client timeout')) {
        resolve({ statusCode: null, value: null, text: null, bytes: 0, ms: Date.now() - startedAt, timedOut: true, error: error.message });
        return;
      }
      reject(error);
    });
    req.end(payload ?? undefined);
  });
}
async function tryJson(port, method, pathname, body) {
  try { return await request(port, method, pathname, body); } catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) return null;
    throw error;
  }
}
async function poll(label, operation, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)?.slice(0, 400)}`);
}

const chunk = (delta, finish = null) => ({
  id: `chatcmpl-${randomUUID()}`,
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'fake-wedge',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
function lastUserText(body) {
  for (let index = (body.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part.text || '').join('');
  }
  return '';
}

// 假 provider：含 `HANG` 的用户回合 ⇒ 一个 `bash` 工具调用（逃逸后代持续写继承 stdout ⇒ 工具永不返回）。
async function startFakeProvider(port, hangCommand) {
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const part of req) raw += part;
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const hasToolResult = body.messages?.some((message) => message.role === 'tool');
    const hang = lastUserText(body).includes('HANG') && !hasToolResult;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    if (hang) {
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'run the hanging command' }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-hang', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: hangCommand }) } }] }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'reply' }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

const exitOf = (child) => new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

async function startHost({ home, sessionsRoot, workspace, basePort, logFile }) {
  const log = await open(logFile, 'a');
  const guard = spawn(process.execPath, [
    guardEntry,
    '--entry', path.join(ROOT, 'server', 'base.mjs'),
    '--label', `treewedge-${basePort}`,
    '--lifetime-ms', String(SANDBOX_LIFETIME_MS),
    '--watch-stdin',
  ], {
    cwd: ROOT,
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
      SOPHO_MAX_HOT: '8',
      SOPHO_ABORT_TIMEOUT_MS: String(ABORT_DEADLINE_MS),
      SOPHO_MEMORY_HEAP_HIGH_BYTES: '1000000000000',
      SOPHO_MEMORY_HEAP_LOW_BYTES: '900000000000',
      SOPHO_MEMORY_RSS_HIGH_BYTES: '1000000000000',
      SOPHO_MEMORY_RSS_LOW_BYTES: '900000000000',
    },
    stdio: ['pipe', log.fd, log.fd, 'ipc'],
    detached: true,
  });
  await log.close();
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
  if (!host) throw new Error('host never became ready');
  return { guard, exited, hostPid: host.value.pid, port: basePort, guardPid: started.pid };
}

async function stopHost(runtime) {
  if (!runtime) return;
  const { guard, hostPid, exited } = runtime;
  if (processAlive(hostPid)) {
    await killPid(hostPid, 'SIGTERM');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && processAlive(hostPid)) await sleep(50);
    if (processAlive(hostPid)) await killPid(hostPid, 'SIGKILL');
  }
  const guardExited = await Promise.race([exited, sleep(15_000).then(() => null)]);
  if (!guardExited && guard?.pid && processAlive(guard.pid)) {
    await killPid(guard.pid, 'SIGKILL');
    await exited;
  }
}

const instanceRow = async (port, sessionId) => {
  const response = await request(port, 'GET', '/debug/instances');
  return response.value?.pool?.sessions?.find((row) => row.sessionId === sessionId) ?? null;
};

async function runGate() {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'tree-abort-wedge-'));
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'workspace');
  const escapeePidFile = path.join(sandbox, 'escapee.pid');
  const baseLogPath = path.join(sandbox, 'tree-abort-wedge.log');
  const problems = [];
  let provider = null;
  let hostRuntime = null;
  try {
    for (const dir of [home, sessionsRoot, workspace]) await mkdir(dir, { recursive: true });
    // 逃逸后代：`setsid` 出来的新会话首进程把**自己的 pid** 写进沙箱内的 pid 文件 ⇒ 收尾时按精确 pid 杀。
    // 它持续往继承来的 stdout 管道写 ⇒ pi 的 `waitForChildProcess` 永不 finalize ⇒ 工具永不返回。
    const hangCommand = `setsid bash -c 'echo $$ > ${escapeePidFile}; while :; do echo tick; sleep 0.05; done' &`;
    const providerPort = await reserveHighPort();
    const basePort = await reserveHighPort();
    provider = await startFakeProvider(providerPort, hangCommand);
    await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          api: 'openai-completions',
          apiKey: 'sandbox-key',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: 'fake-wedge', name: 'Wedge Fake', contextWindow: 4096, maxTokens: 1024 }],
        },
      },
    }, null, 2)}\n`);
    await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
      defaultProvider: 'fake',
      defaultModel: 'fake-wedge',
      defaultThinkingLevel: 'off',
      compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    }, null, 2)}\n`);
    print('fixture', { sandbox, root: ROOT, providerPort, basePort, abortDeadlineMs: ABORT_DEADLINE_MS, hangCommand });

    hostRuntime = await startHost({ home, sessionsRoot, workspace, basePort, logFile: baseLogPath });
    print('sandbox host', { port: basePort, guardPid: hostRuntime.guardPid, hostPid: hostRuntime.hostPid });

    const createSession = async (name) => {
      const created = await request(basePort, 'POST', '/sessions', { name });
      assert.equal(created.statusCode, 201, `create session: ${created.statusCode} ${created.text}`);
      return created.value.id;
    };

    // ── 反证基线：一条普通会话跑完一个回合 ⇒ `/tree` 200（几 ms）。
    const normal = await createSession('普通会话（基线）');
    assert.equal((await request(basePort, 'POST', `/sessions/${normal}/message`, { text: 'hello' })).statusCode, 202);
    await poll('normal turn settles', () => request(basePort, 'GET', `/sessions/${normal}`), (response) => response.value?.runtime?.isStreaming === false && response.value?.durable === true, 30_000);
    const baseline = await request(basePort, 'GET', '/tree');
    print('[基线] 无 wedge 时 /tree', { statusCode: baseline.statusCode, bytes: baseline.bytes, ms: baseline.ms });
    assert.equal(baseline.statusCode, 200, `baseline /tree must be 200: ${baseline.text}`);
    assert.equal(baseline.value?.liveFactsUnavailable ?? null, null, 'a healthy /tree must not carry a degradation marker');

    // ── 造 wedge：一条会话跑一个永不返回的 bash 工具。
    const stuck = await createSession('卡死会话');
    assert.equal((await request(basePort, 'POST', `/sessions/${stuck}/message`, { text: 'HANG now' })).statusCode, 202);
    const escapeePid = await poll('the hanging tool actually started (its pid file appears)', async () => {
      try { return Number((await readFile(escapeePidFile, 'utf8')).trim()); } catch { return NaN; }
    }, (value) => Number.isInteger(value) && value > 0, 30_000);
    print('[wedge] 逃逸后代已启动', { escapeePid, pidFile: escapeePidFile });
    await poll('stuck session is streaming', () => request(basePort, 'GET', `/sessions/${stuck}`), (response) => response.value?.runtime?.isStreaming === true, 30_000);
    const wedgeRow = await instanceRow(basePort, stuck);
    print('[wedge] /debug/instances 里的卡死行', wedgeRow);
    assert.ok(wedgeRow?.blockers?.includes('in_flight_turn'), `the wedged session must show in_flight_turn: ${JSON.stringify(wedgeRow)}`);

    // 反证臂 A：**只有工具卡住、还没 abort** 时，`/tree` 仍必须 200（单点卡死不等于整树挂）。
    const beforeAbort = await request(basePort, 'GET', '/tree');
    print('[反证] 只有卡死工具、未 abort 时 /tree', { statusCode: beforeAbort.statusCode, bytes: beforeAbort.bytes, ms: beforeAbort.ms });
    assert.equal(beforeAbort.statusCode, 200, `a stuck tool alone must not break /tree: ${beforeAbort.text}`);

    // ── 关键：abort 会占住该 handle 的串行队列（`waitForIdle()`）⇒ `/tree` 的热覆写必须能到点跳过。
    // 怎么**确定**地知道「abort 正占着队列」：`queuedOperations` 数的是**在排队**的操作（不是正在跑的）
    // —— abort 自己跑起来后它就归 0。所以再发一个同 handle 的读（canary）排在它后面，`queuedOperations >= 1`
    // 就证明 abort **正握着那把锁**（这与现场读数里 `queuedOperations` 一路上涨同源）。
    const abortPromise = request(basePort, 'POST', `/sessions/${stuck}/abort`, {}, ABORT_CLIENT_DEADLINE_MS);
    await sleep(150);
    const abortEarly = await Promise.race([abortPromise, sleep(1200).then(() => null)]);
    print('[关键] abort 在 1.2s 时的状态（未到 2s 死线 ⇒ 应 still pending）', abortEarly === null ? 'still pending' : { statusCode: abortEarly.statusCode, ms: abortEarly.ms, timedOut: abortEarly.timedOut, value: abortEarly.value });
    const canary = request(basePort, 'GET', `/sessions/${stuck}`, undefined, ABORT_CLIENT_DEADLINE_MS);
    const occupied = await poll('abort occupies the per-session queue', () => instanceRow(basePort, stuck), (row) => (row?.queuedOperations ?? 0) >= 1, 10_000);
    print('[关键] abort 已占住队列', { queuedOperations: occupied?.queuedOperations, blockers: occupied?.blockers });
    const treeUnderAbort = await request(basePort, 'GET', '/tree');
    print('[关键] abort 在飞时 /tree', { statusCode: treeUnderAbort.statusCode, bytes: treeUnderAbort.bytes, ms: treeUnderAbort.ms, liveFactsUnavailable: treeUnderAbort.value?.liveFactsUnavailable ?? null });
    assert.equal(treeUnderAbort.statusCode, 200, `/tree must answer 200 while a handle is stuck, not 500: ${treeUnderAbort.text}`);
    assert.ok(treeUnderAbort.value?.sessions?.some((session) => session.id === stuck), 'the scan-derived row for the stuck session must still be present');
    const unavailable = treeUnderAbort.value?.liveFactsUnavailable;
    assert.ok(Array.isArray(unavailable) && unavailable.length > 0, `the degraded /tree must carry liveFactsUnavailable: ${treeUnderAbort.text?.slice(0, 400)}`);
    const stuckMark = unavailable.find((entry) => entry.sessionId === stuck);
    assert.ok(stuckMark, `liveFactsUnavailable must name the stuck session ${stuck}: ${JSON.stringify(unavailable)}`);
    assert.equal(stuckMark.reason, 'handle_timeout', `the marker must say handle_timeout: ${JSON.stringify(stuckMark)}`);
    assert.ok(treeUnderAbort.ms < TREE_UNDER_DEADLINE_MS, `/tree must return inside its per-handle deadline (${TREE_UNDER_DEADLINE_MS}ms), got ${treeUnderAbort.ms}ms`);

    // ── abort 回执：**有限时间内**如实说「没停掉」，绝不挂住。
    const abort = await abortPromise;
    print('[关键] abort 回执', { statusCode: abort.statusCode, ms: abort.ms, timedOut: abort.timedOut, value: abort.value });
    assert.equal(abort.timedOut, false, `POST /abort must answer inside its explicit deadline; it hung (${abort.ms}ms)`);
    assert.equal(abort.statusCode, 200, `abort receipt: ${abort.text}`);
    assert.equal(abort.value?.aborted, false, `a timed-out abort must NOT claim success: ${abort.text}`);
    assert.equal(abort.value?.reason, 'abort_timeout', `the receipt must say abort_timeout: ${abort.text}`);
    assert.equal(abort.value?.retryable, true, `the receipt must be retryable: ${abort.text}`);
    assert.ok(abort.ms < ABORT_DEADLINE_MS + 3000, `abort must return around its ${ABORT_DEADLINE_MS}ms deadline, got ${abort.ms}ms`);

    // ── 队列必须**继续服务**：abort 之后同一个 handle 的普通请求要能答上来（不再被永久挡住）。
    await poll('the per-session queue drains after abort', () => instanceRow(basePort, stuck), (row) => (row?.queuedOperations ?? 0) === 0, 10_000);
    const detail = await request(basePort, 'GET', `/sessions/${stuck}`, undefined, 6000);
    print('[关键] abort 之后同 handle 的 GET /sessions/{id}', { statusCode: detail.statusCode, ms: detail.ms });
    assert.equal(detail.timedOut, false, `the queue must keep serving after abort; GET /sessions/${stuck} hung (${detail.ms}ms)`);
    assert.equal(detail.statusCode, 200, `the queue must keep serving after abort: ${detail.text}`);

    const ping = await request(basePort, 'GET', '/ping');
    print('[关键] /ping（事件循环仍活）', { statusCode: ping.statusCode, ms: ping.ms });
    assert.equal(ping.statusCode, 200, 'the worker event loop must stay alive');

    // canary（排在 abort 后面的那个读）随后也要能结束 —— 同一条队列恢复服务的第二份读数。
    const canaryResponse = await canary;
    print('[关键] canary GET /sessions/{id}（曾排在 abort 后面）', { statusCode: canaryResponse.statusCode, ms: canaryResponse.ms, timedOut: canaryResponse.timedOut });
    assert.equal(canaryResponse.timedOut, false, `the queued canary must eventually run (${canaryResponse.ms}ms)`);

    // 收尾：按精确 pid 杀掉逃逸后代（否则它会一直写管道）。
    await killPid(escapeePid, 'SIGKILL').catch(() => {});
    try { await killPid(-escapeePid, 'SIGKILL'); } catch {}
    print('RESULT', { ok: true, baselineMs: baseline.ms, treeUnderAbortMs: treeUnderAbort.ms, abortMs: abort.ms, stuckMark });
    process.stdout.write('RESULT: tree-abort-wedge PASS\n');
  } finally {
    // 精确路径清理：逃逸后代（若有）＋ 沙箱宿主 ＋ 沙箱目录。
    try {
      const pid = Number((await readFile(path.join(sandbox, 'escapee.pid'), 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) { await killPid(pid, 'SIGKILL').catch(() => {}); try { await killPid(-pid, 'SIGKILL'); } catch {} }
    } catch {}
    await stopHost(hostRuntime);
    try { provider?.close?.(); } catch {}
    await removeSandbox(sandbox, problems, 'remove tree-abort-wedge sandbox');
    print('sandbox cleanup', { sandbox, problems });
  }
}

// ── 常驻反证臂：把交付物**副本**改一处，再拿真门去打那份副本，断言必红（本仓惯例）──────────────
const ARM_MUTANTS = {
  'no-abort-deadline': {
    what: '把 abort 的显式死线拆掉（回到旧行为：`await session.abort()`，永不 resolve）',
    file: 'server/base-logic.mjs',
    from: "      const outcome = await raceDeadline(session.abort(), ABORT_DEADLINE_MS);\n      if (outcome.timedOut) return { aborted: false, reason: 'abort_timeout', retryable: true };\n      if (outcome.error) throw outcome.error;\n      return { aborted: true, reason: 'aborted' };",
    to: "      await session.abort(); // reverse-arm:no-abort-deadline\n      return { aborted: true, reason: 'aborted' };",
    expect: 'must answer inside its explicit deadline',
  },
  'no-tree-deadline': {
    what: '把 `/tree` 热覆写的 per-handle 死线拆掉（直接 await，被占住时读到旧事实、没有降级标注）',
    file: 'server/base-logic.mjs',
    from: "      const perHandle = treeHandleDeadlineMs === null ? left : Math.min(treeHandleDeadlineMs, left);\n      const outcome = await raceDeadline(inspectAdapter(handle, (adapter) => ({\n        id: runtime.sessionId,\n        file: adapter.manager.getSessionFile() ?? null,\n        archiveState: latestArchiveState(adapter.manager.getEntries()),\n        context: adapter.context(),\n        summary: summaryFromManager(adapter.manager, adapter),\n      })), perHandle);",
    to: "      const perHandle = 60000; // reverse-arm:no-tree-deadline\n      const outcome = { timedOut: false, value: await inspectAdapter(handle, (adapter) => ({\n        id: runtime.sessionId,\n        file: adapter.manager.getSessionFile() ?? null,\n        archiveState: latestArchiveState(adapter.manager.getEntries()),\n        context: adapter.context(),\n        summary: summaryFromManager(adapter.manager, adapter),\n      })) };",
    expect: 'the degraded /tree must carry liveFactsUnavailable',
  },
  'lying-annotation': {
    what: '超时了却**不写进**降级标注（`hotUnavailable` 不再记录这个 handle ⇒ 调用方被欺骗）',
    file: 'server/base-logic.mjs',
    from: "        hotUnavailable.push({ sessionId: runtime.sessionId, reason: 'handle_timeout', timeoutMs: perHandle });\n        continue;",
    to: "        continue; // reverse-arm:lying-annotation",
    expect: 'the degraded /tree must carry liveFactsUnavailable',
  },
};

async function runReverseArm(name) {
  const arm = ARM_MUTANTS[name];
  if (!arm) throw new Error(`不认识的反证臂：${name}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
  process.stdout.write(`反证臂 ${name}：${arm.what}\n`);
  const result = await runGateOnMutatedCopy({
    root: repoRoot,
    tag: 'treewedge',
    dirs: ['server', 'pi-extensions', 'web'],
    gateFile: fileURLToPath(import.meta.url),
    expect: arm.expect,
    mutate: async (copyRoot) => {
      const file = path.join(copyRoot, arm.file);
      const text = await readFile(file, 'utf8');
      const hits = text.split(arm.from).length - 1;
      if (hits !== 1) {
        throw new Error(`反证臂 ${name} 的接缝在该文件里出现 ${hits} 次（应为**恰好 1 次**）：${arm.file}\n  要找：${JSON.stringify(arm.from).slice(0, 200)}`);
      }
      await writeFile(file, text.replace(arm.from, arm.to), 'utf8');
      await new Promise((resolve, reject) => execFile(process.execPath, ['--check', file], (error, stderr) => (error ? reject(new Error(`mutated ${arm.file} does not parse: ${stderr || error.message}`)) : resolve())));
    },
  });
  print('reverseArm', { name, exitCode: result.exitCode, redLine: result.redLine });
  if (result.problems.length > 0) {
    process.stderr.write(`cleanup problems (secondary): ${result.problems.join('; ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`✓ 反证臂 ${name} 红到位（这是**期望**的结果，不是缺陷）：${result.redLine}\n`);
}

let primaryError = null;
try {
  if (ARM) await runReverseArm(ARM);
  else await runGate();
} catch (error) {
  primaryError = error;
  process.stderr.write(`\ntree-abort-wedge FAIL: ${error?.stack || error}\n`);
  process.exitCode = 1;
}
