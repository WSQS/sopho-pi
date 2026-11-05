#!/usr/bin/env node
// 会话树状态门：`POST /reload-code` 之后，**停在旧代（draining generation）上的会话**
// 仍必须在 `/tree` 里报出它真实的状态（在跑 = working / 工作中），
// 而**真正空闲**的会话必须仍报 idle（反向：不许过度上报）。
//
// 为什么需要这条门：`/tree` 的底是**扫盘**出来的（会话文件里的事实），而「此刻在不在跑」
// 只有**持有 runtime 的那一代**知道；宿主是唯一知道「还有哪几代活着」的一层。
// 修前 `/tree` 由**当前代** worker 算：它的 `treeRecords` 只覆盖**自己池子**里的 runtime
// （`pool.listSessions()`），停在旧代上的会话于是落到盘上的默认值 idle/unread ——
// 明明在跑，树里却显示「闲置」（现场：acc4f565… 在 g1 上 `isStreaming:true`，`/tree` 报 idle）。
//
// 判据（三条，一条都不能少）：
//   (a) reload 之后，停在旧代的会话仍报「在跑」；
//   (b) 真空闲的会话仍报 idle（反向）；
//   (c) 旧代消失之后，状态仍然正确（没有「在跑」残留，也没有幻影）。
// 另外校验 `/tree` 的**响应形状**没被改动（字段名不增不减：前端还要照它画「在跑」记号）。
//
// 沙箱：副本 home + 高位随机端口 + 本地假 provider。绝不碰 7331/7321，绝不碰真 profile
// （`~/.pi/profiles/assistant` 只读，本门根本不指它），进程一律**按 pid** 杀（绝不用 pkill）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'tree-draining-status-'));
const home = path.join(sandbox, 'home');
const workspace = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 'tree-draining-status-base.log');
const guardEntry = path.join(sourceRoot, 'test', 'sandbox-guard.mjs');
//  ⑦ 的门（opt-in）：`--draining-timeout-arm` 时才跑「draining 代答不上 live-facts ⇒ 如实降级」那一段。
//  为什么 opt-in：它要按**精确 pid** 把 draining 代 `SIGSTOP` 住才能确定性地让死线到点；默认那条
//  跑法（不暂停任何进程）的行为一字不改。这一段里有**两条臂**，两种旋钮取值各自留原始输出：
//    · **冷启动臂**（缓存还空）⇒ 只断言「200 + 带上降级旗标」；**不**断言「在跑」（那一格会**低报**：
//      没有任何「上次已知 overlay」可兜 ⇒ 真在跑的会话可能被读成 idle，调用方以旗标为准）。
//    · **暖缓存臂**（先 poll 到在跑事实进缓存）⇒ 断言「降级 + 保留上次已知 overlay + 仍报在跑」。
//    `--timeout-ms=0`    ⇒ 两臂都绿；`--timeout-ms=5000` ⇒ 暖缓存臂判红（`/tree` 撞上那条死线）
const DRAINING_TIMEOUT_ARM = process.argv.includes('--draining-timeout-arm');
// 把旋钮从 argv 传给**宿主进程**（跨平台，不依赖 shell 的 `VAR=... cmd`）。
const TIMEOUT_MS_ARG = (() => {
  const found = process.argv.find((argument) => argument.startsWith('--timeout-ms='));
  return found === undefined ? null : found.slice('--timeout-ms='.length);
})();
// 一个不受时限的回合最多被门自己 hold 几十秒；寿命上限取「实测需要的好几倍」，不是猜数。
const SANDBOX_LIFETIME_MS = Number(process.env.SOPHO_SANDBOX_LIFETIME_MS) || 4 * 60 * 1000;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function killPid(pid, signal) {
  // 只按 pid，绝不用名字/glob。
  try { process.kill(pid, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

async function waitGone(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(50);
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

async function tryJson(port, method, pathname, body) {
  try {
    return await json(port, method, pathname, body);
  } catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) return null;
    throw error;
  }
}

async function poll(label, operation, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await sleep(50);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function usage() {
  return { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 };
}

function chunk(content, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-tds',
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

// 假 provider：'normal' 立刻答完；'hold' 推第一个 chunk 之后挂住，直到门显式 release
// ——「一个可控的长回合」就是靠它。
async function startFakeProvider(port) {
  const plans = [];
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    const plan = plans.shift() ?? { mode: 'normal', text: `reply:${lastUserText(body).slice(0, 60)}` };
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(plan.text))}\n\n`);
    plan.markStarted?.();
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
    plan(mode, text) {
      let releaseResolve;
      let startedResolve;
      const plan = {
        mode,
        text,
        started: new Promise((resolve) => { startedResolve = resolve; }),
        released: new Promise((resolve) => { releaseResolve = resolve; }),
        markStarted: startedResolve,
      };
      plan.release = () => releaseResolve?.();
      plans.push(plan);
      return plan;
    },
  };
}

function exitOf(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function startHost(basePort, logHandle) {
  const guard = spawn(process.execPath, [
    guardEntry,
    '--entry', path.join(sourceRoot, 'server', 'base.mjs'),
    '--label', `tsd-host-${basePort}`,
    '--lifetime-ms', String(SANDBOX_LIFETIME_MS),
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
      ...(TIMEOUT_MS_ARG === null ? {} : { SOPHO_DRAINING_FACTS_TIMEOUT_MS: TIMEOUT_MS_ARG }),
    },
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
  print('sandbox host', { label: `tsd-host-${basePort}`, port: basePort, guardPid: started.pid, hostPid: host.value.pid, lifetimeMs: SANDBOX_LIFETIME_MS });
  return { guard, exited, hostPid: host.value.pid, port: basePort };
}

async function stopHost(runtime, basePort) {
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

function rowOf(tree, sessionId) {
  return tree.sessions.find((session) => session.id === sessionId) ?? null;
}

// 一个会话行在 `/tree` 里的**规范形状**：前端靠这些字段画行与「在跑」记号。
// 名字一个都不能少（响应形状兼容）；多出来的字段（比如将来的新事实）不算破坏。
const REQUIRED_ROW_FIELDS = ['id', 'name', 'status', 'statusLabel', 'archived', 'parentId', 'unread', 'modifiedAt'];
const REQUIRED_TREE_FIELDS = ['sessions', 'generatedAt', 'unread', 'titles'];

function assertRowShape(row, where) {
  for (const field of REQUIRED_ROW_FIELDS) {
    assert.ok(row[field] !== undefined, `${where}: /tree row ${row.id} is missing field "${field}"`);
  }
  assert.equal(row.statusLabel, { working: '工作中', unread: '未读', idle: '闲置' }[row.status], `${where}: statusLabel must match status for ${row.id}`);
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
        models: [{ id: 'fake-tds', name: 'TSD Fake', contextWindow: 4096, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-tds',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);
  print('sandbox', { home, workspace, sessionsRoot, providerPort, basePort, forbiddenPortsUsed: false });

  const logHandle = await open(baseLogPath, 'a');
  hostRuntime = await startHost(basePort, logHandle);

  const createSession = async (name) => {
    const created = await json(basePort, 'POST', '/sessions', { name });
    assert.equal(created.statusCode, 201, JSON.stringify(created.value));
    return created.value.id;
  };

  const g1 = (await json(basePort, 'GET', '/host')).value.currentGenerationId;
  const workerPid1 = (await json(basePort, 'GET', '/host')).value.currentWorkerPid;

  // ── 两条会话都先落盘（durable）：/tree 的底是磁盘投影，没有文件的会话不在树上。
  // 甲（idleSession）：一个正常跑完的回合 + 标记已读 ⇒ 之后必须一直报 idle。
  const idleSession = await createSession('空闲会话（反向判据）');
  const idlePlan = provider.plan('normal', 'idle-turn-done');
  assert.equal((await json(basePort, 'POST', `/sessions/${idleSession}/message`, { text: '跑一个普通回合' })).statusCode, 202);
  await idlePlan.started;
  await poll('空闲会话落盘', () => json(basePort, 'GET', `/sessions/${idleSession}`), (response) => response.value.durable === true && response.value.runtime?.isStreaming === false, 30_000);
  assert.equal((await json(basePort, 'POST', `/sessions/${idleSession}/seen`)).statusCode, 200);

  // 乙（runningSession）：先落盘，再起一个被 hold 住的长回合 ⇒ 旧代里「正在跑」。
  const runningSession = await createSession('在跑会话');
  const warmPlan = provider.plan('normal', 'warm-turn-done');
  assert.equal((await json(basePort, 'POST', `/sessions/${runningSession}/message`, { text: '先跑一个回合让它落盘' })).statusCode, 202);
  await warmPlan.started;
  await poll('在跑会话落盘', () => json(basePort, 'GET', `/sessions/${runningSession}`), (response) => response.value.durable === true && response.value.runtime?.isStreaming === false, 30_000);
  assert.equal((await json(basePort, 'POST', `/sessions/${runningSession}/seen`)).statusCode, 200);

  // 前置：reload 之前，两条都必须是 idle（否则后面的判据没有意义）。
  const before = await poll('两条会话都报 idle（前置）', () => json(basePort, 'GET', '/tree'), (response) => response.value.sessions.some((session) => session.id === runningSession) && rowOf(response.value, runningSession).status === 'idle' && rowOf(response.value, idleSession).status === 'idle', 30_000);
  const treeFieldsBefore = Object.keys(before.value).sort();
  const rowFieldsBefore = Object.keys(rowOf(before.value, idleSession)).sort();
  for (const field of REQUIRED_TREE_FIELDS) assert.ok(treeFieldsBefore.includes(field), `/tree must keep field "${field}"`);
  print('reload 前的树（/tree）', {
    generatedAt: before.value.generatedAt,
    idle: { id: idleSession, status: rowOf(before.value, idleSession).status, statusLabel: rowOf(before.value, idleSession).statusLabel },
    running: { id: runningSession, status: rowOf(before.value, runningSession).status, statusLabel: rowOf(before.value, runningSession).statusLabel },
    topLevelFields: treeFieldsBefore,
    rowFields: rowFieldsBefore,
  });

  // 起长回合，然后换代：这条回合会留在**旧代**上跑（设计如此：active 会话留旧 worker 跑完）。
  const holdPlan = provider.plan('hold', 'held-turn-running');
  assert.equal((await json(basePort, 'POST', `/sessions/${runningSession}/message`, { text: '起一个长回合' })).statusCode, 202);
  await holdPlan.started;
  await poll('长回合在跑', () => json(basePort, 'GET', `/sessions/${runningSession}`), (response) => response.value.runtime?.isStreaming === true, 20_000);

  const reload = await json(basePort, 'POST', '/reload-code');
  assert.equal(reload.statusCode, 200, JSON.stringify(reload.value));
  const g2 = reload.value.generationId;
  assert.notEqual(g2, g1);

  const draining = await poll('旧代进入 draining', () => json(basePort, 'GET', '/host'), (response) => response.value.drainingGenerations.length === 1, 30_000);
  const drainingFact = draining.value.drainingGenerations[0];
  assert.equal(drainingFact.generationId, g1, 'the old generation must be the draining one');
  assert.ok(drainingFact.sessions.includes(runningSession), `the running session must still be owned by the draining generation: ${JSON.stringify(drainingFact.sessions)}`);
  // 两个字段同名不同义，别混用（现场取证）：
  //   · `pool.draining` = **当前 worker 自己那个池子**的 drain 标志（pool.mjs 的 #draining，
  //     池内不再接手新会话要用它），所以当前代没在 drain 时恒为 false；
  //   · `drainingGenerations` = **宿主**的旧代账（worker.state === 'draining'）。
  print('draining 窗口的 /host', {
    currentGenerationId: draining.value.currentGenerationId,
    poolDraining: draining.value.pool?.draining,
    drainWorkerState: draining.value.workers.find((worker) => worker.generationId === g1)?.state,
    drainingGenerations: draining.value.drainingGenerations.map((worker) => ({ generationId: worker.generationId, pid: worker.pid, state: worker.state, sessions: worker.sessions })),
  });
  assert.equal(draining.value.pool?.draining, false, 'pool.draining is the current worker pool\'s own flag, not the host\'s draining-generation ledger');
  assert.equal(draining.value.workers.find((worker) => worker.generationId === g1)?.state, 'draining');

  // 会话详情直说它还在旧代上跑（这条是判据的立足点，不是结论）。
  const detail = await json(basePort, 'GET', `/sessions/${runningSession}`);
  print('draining 窗口：会话详情（/sessions/{id}）', {
    generationId: detail.value.generationId,
    workerPid: detail.value.workerPid,
    pluginStale: detail.value.pluginStale,
    isStreaming: detail.value.runtime?.isStreaming,
  });
  assert.equal(detail.value.generationId, g1, 'the session must really live on the draining generation');
  assert.equal(detail.value.runtime?.isStreaming, true, 'the turn must really be streaming on the draining generation');

  // ══════ ⑦ 的**冷启动臂**（opt-in）：缓存还是**空**的时候，draining 代答不上 live-facts 会怎样？
  // 这一格是**已知的产品语义空洞**（已写入 plan §11）：还没有任何一次成功问到 facts ⇒ 没有「上次已知 overlay」
  // 可兜 ⇒ 行**会低报**（真在旧代上跑的会话可能被读成 idle）—— 但响应带着 `drainingFacts.status === 'timeout'`
  // 这个旗标，调用方**能知道**这一发不可信。所以本臂**只**断言「200 + 旗标」，**不**拿行状态当断言 ✗。
  // 时机：这是 reload 之后**第一发** `/tree`（缓存必空），开臂前先 SIGSTOP 住 draining 代使到点确定。
  if (DRAINING_TIMEOUT_ARM) {
    const knob = TIMEOUT_MS_ARG ?? process.env.SOPHO_DRAINING_FACTS_TIMEOUT_MS;
    assert.ok(typeof knob === 'string' && /^\d+$/.test(knob), 'this arm must be run with --timeout-ms=<整数> (or SOPHO_DRAINING_FACTS_TIMEOUT_MS set to an integer)');
    const coldWorkerPid = draining.value.drainingGenerations[0].pid;
    await killPid(coldWorkerPid, 'SIGSTOP');
    let cold;
    let coldElapsedMs;
    try {
      const startedAt = Date.now();
      cold = await json(basePort, 'GET', '/tree');
      coldElapsedMs = Date.now() - startedAt;
    } finally {
      await killPid(coldWorkerPid, 'SIGCONT');
    }
    print('⑦ 冷启动臂：缓存空 + 暂停 draining 代时的 /tree', {
      statusCode: cold.statusCode, elapsedMs: coldElapsedMs,
      topLevelFields: Object.keys(cold.value ?? {}).sort(), drainingFacts: cold.value?.drainingFacts ?? null,
      runningRow: rowOf(cold.value ?? { sessions: [] }, runningSession)?.status ?? null,
      note: '缓存空 ⇒ 行可能低报（上面 runningRow 如果是 idle 就是这一格）；调用方以 drainingFacts 旗标为准',
    });
    assert.equal(cold.statusCode, 200, `⑦ 冷启动：降级不得把 /tree 变成错: ${cold.statusCode}`);
    assert.ok(cold.value?.drainingFacts, '⑦ 冷启动：缓存空也必须如实报出降级事实（否则调用方无从得知这一发不可信）');
    assert.equal(cold.value.drainingFacts.status, 'timeout', `⑦ 冷启动：status: ${JSON.stringify(cold.value.drainingFacts)}`);
    assert.equal(cold.value.drainingFacts.timeoutMs, Number(knob), `⑦ 冷启动：timeoutMs must be the knob value: ${JSON.stringify(cold.value.drainingFacts)}`);
    assert.equal(cold.value.drainingFacts.generationId, g1, `⑦ 冷启动：降级事实必须指名那一代: ${JSON.stringify(cold.value.drainingFacts)}`);
    // ⚠️ 有意**不**断言 runningRow：冷启动时行可能（也应该）被读成 idle —— 那是被旗标标记的已知折中，
    //    不是这一条臂能保证的东西（拿它断言「在跑」反而会把一个假承诺钉进门）。
  }

  // ── 判据 (a)：reload 之后，停在旧代的会话在 /tree 里仍报「在跑」。
  // 先等「上次已知 overlay」进缓存（poll 到 running=working）。默认（不死线）下第一发就满足，poll 只多跑一轮；
  // 而 ⑦ 的门用 `SOPHO_DRAINING_FACTS_TIMEOUT_MS=0` 跑时，某一发可能到点降级 —— 缓存已有事实，
  // 「真在跑的仍报在跑」这条判据才有立足点。
  const duringTree = (await poll('draining overlay 建立（在跑事实进缓存）', () => json(basePort, 'GET', '/tree'), (response) => rowOf(response.value, runningSession)?.status === 'working', 20_000)).value;
  const runningRow = rowOf(duringTree, runningSession);
  print('判据 (a) draining 窗口的树行', { id: runningSession, status: runningRow?.status, statusLabel: runningRow?.statusLabel, unread: runningRow?.unread });
  // ⑦ 的门要求的两个打印：`/tree` 的**顶层字段集**与 `drainingFacts`（没降级时是 undefined）。
  print('判据 (a) /tree 顶层字段与 drainingFacts', { topLevelFields: Object.keys(duringTree).sort(), drainingFacts: duringTree.drainingFacts ?? null });
  assert.ok(runningRow, `the running session must still be a row of /tree`);
  assertRowShape(runningRow, 'during drain');
  assert.equal(runningRow.status, 'working', `(a) a session running on the draining generation must report working, got ${runningRow.status}`);
  assert.equal(runningRow.statusLabel, '工作中');

  // ── 判据 (b)：真空闲的会话仍报 idle；树里不能出现第二个「在跑」。
  const idleRow = rowOf(duringTree, idleSession);
  const workingIds = duringTree.sessions.filter((session) => session.status === 'working').map((session) => session.id);
  print('判据 (b) draining 窗口的树行', { id: idleSession, status: idleRow?.status, statusLabel: idleRow?.statusLabel, unread: idleRow?.unread, workingIds, topLevelFields: Object.keys(duringTree).sort(), rowFields: Object.keys(idleRow ?? {}).sort() });
  assert.ok(idleRow, 'the idle session must still be a row of /tree');
  assertRowShape(idleRow, 'during drain');
  assert.equal(idleRow.status, 'idle', `(b) a genuinely idle session must still report idle, got ${idleRow.status}`);
  assert.equal(idleRow.statusLabel, '闲置');
  assert.deepEqual(workingIds, [runningSession], `(b) only the session that is really running may report working, got ${JSON.stringify(workingIds)}`);

  // 响应形状兼容：字段名只增不减（与上面的 REQUIRED_ROW_FIELDS 同一条口径：**多出来的字段不算破坏**）。
  // ⑦ 往 `/tree` 顶层**追加**了 `drainingFacts` ⇒ 这里不能再要求集合**相等**（旧集合 ⊆ 新集合）。
  for (const field of treeFieldsBefore) assert.ok(Object.keys(duringTree).includes(field), `/tree must keep field "${field}" (fields may only be added)`);
  assert.deepEqual(Object.keys(idleRow).sort(), rowFieldsBefore, '/tree row shape must not change across a reload');

  // `/tree` 是前端轮询的热路径：量一下 draining 窗口里的一次往返。这次聚合只在**有 draining 代**
  // 时才多一次 IPC，而且与取树**并发**跑（见 server/base.mjs 的 Promise.all）。
  // ⚠️ 这是 2 个会话的沙箱尺度，不是 380 条会话的生产尺度（见报告「没验到什么」）。
  const treeTimings = [];
  for (let index = 0; index < 3; index += 1) {
    const startedAt = Date.now();
    const polled = (await json(basePort, 'GET', '/tree')).value;
    treeTimings.push(Date.now() - startedAt);
    print(`draining 窗口 /tree round ${index + 1}`, { topLevelFields: Object.keys(polled).sort(), drainingFacts: polled.drainingFacts ?? null });
  }

  // ══════ ⑦ 的**暖缓存臂**（opt-in）：先让「上次已知 overlay」进缓存，再看 draining 代答不上 live-facts 会怎样。
  // 怎么把「答不上来」做成确定的：按**精确 pid** 把 draining 代 `SIGSTOP` 住 ⇒ 它的 live-facts 必然到点
  // （只靠 `SOPHO_DRAINING_FACTS_TIMEOUT_MS=0` 会有 IPC 往返 vs 1ms 定时的赛跑，不够确定）。
  if (DRAINING_TIMEOUT_ARM) {
    const knob = TIMEOUT_MS_ARG ?? process.env.SOPHO_DRAINING_FACTS_TIMEOUT_MS;
    assert.ok(typeof knob === 'string' && /^\d+$/.test(knob), 'this arm must be run with --timeout-ms=<整数> (or SOPHO_DRAINING_FACTS_TIMEOUT_MS set to an integer)');
    const drainedPid = draining.value.drainingGenerations[0].pid;
    // 先把「上次已知 overlay」存进缓存：必须**先成功一次**（否则「不降级成闲置」这条判据没有立足点）。
    const warmed = await poll('draining overlay 先成功一次（把上次已知事实放进缓存）', () => json(basePort, 'GET', '/tree'), (response) => rowOf(response.value, runningSession)?.status === 'working' && response.value.drainingFacts === undefined, 20_000);
    print('⑦ 暖缓存臂：暂停 draining 代之前的 /tree（缓存已建立）', { topLevelFields: Object.keys(warmed.value).sort(), drainingFacts: warmed.value.drainingFacts ?? null, running: rowOf(warmed.value, runningSession)?.status });
    assert.equal(rowOf(warmed.value, idleSession)?.status, 'idle', '…and the genuinely idle session stays idle before the arm');
    await killPid(drainedPid, 'SIGSTOP');
    try {
      const startedAt = Date.now();
      const degraded = await json(basePort, 'GET', '/tree');
      const elapsedMs = Date.now() - startedAt;
      print('⑦ 暖缓存臂：暂停 draining 代之后的 /tree', {
        topLevelFields: Object.keys(degraded.value).sort(), drainingFacts: degraded.value.drainingFacts ?? null,
        elapsedMs, running: rowOf(degraded.value, runningSession)?.status, idle: rowOf(degraded.value, idleSession)?.status,
      });
      assert.equal(degraded.statusCode, 200, `⑦: a draining live-facts timeout must not turn /tree into an error: ${degraded.statusCode}`);
      // 反证臂（knob=5000）在这里判红：死线到点要等 ~5000ms ⇒ 越过这条上限。
      assert.ok(elapsedMs < 4500, `⑦: /tree must come back inside the short deadline (${elapsedMs}ms) —— 旋钮 ${knob} 没在管这条死线`);
      assert.ok(degraded.value.drainingFacts, `⑦: the degraded fact must be reported honestly, got ${JSON.stringify(degraded.value.drainingFacts)}`);
      assert.equal(degraded.value.drainingFacts.status, 'timeout', `⑦: status: ${JSON.stringify(degraded.value.drainingFacts)}`);
      assert.equal(degraded.value.drainingFacts.timeoutMs, Number(knob), `⑦: timeoutMs must be the knob value: ${JSON.stringify(degraded.value.drainingFacts)}`);
      assert.equal(degraded.value.drainingFacts.generationId, g1, `⑦: the degraded fact must name the draining generation: ${JSON.stringify(degraded.value.drainingFacts)}`);
      // 最关键的一条：降级**不许**把「未知」说成「没在跑」。
      assert.equal(rowOf(degraded.value, runningSession)?.status, 'working', '⑦: a session that is really running must NOT be downgraded to idle just because live-facts timed out');
      assert.equal(rowOf(degraded.value, idleSession)?.status, 'idle', '⑦: the genuinely idle session must stay idle');
      print('⑦ 暖缓存臂结论', { verdict: 'degraded + stale overlay kept + still reports working', knob, elapsedMs });
    } finally {
      await killPid(drainedPid, 'SIGCONT');   // 一定要恢复：后面还要放行长回合 / 等旧代自己退出
    }
  } else {
    print('⑦ 臂', { verdict: 'skipped (跑法：node test/tree-draining-status.mjs --draining-timeout-arm --timeout-ms=<n>)' });
  }
  print('draining 窗口 /tree 往返（ms，3 次，沙箱尺度）', treeTimings);

  // 放开长回合：它必须在旧代上跑完；旧代随后自己退出。
  holdPlan.release();
  const settled = await poll('旧代退出', () => json(basePort, 'GET', '/host'), (response) => response.value.workerCount === 1 && response.value.drainingGenerations.length === 0, 60_000);
  print('旧代退出后', { workerCount: settled.value.workerCount, drainingGenerations: settled.value.drainingGenerations, currentWorkerPid: settled.value.currentWorkerPid, oldWorkerPid: workerPid1 });
  assert.ok(await waitGone(workerPid1, 20_000), `old worker pid ${workerPid1} must be gone`);

  // ── 判据 (c)：旧代消失后状态仍然正确 —— 不再有「在跑」，两条行都还在、仍然是规范形状。
  const afterTree = (await json(basePort, 'GET', '/tree')).value;
  const afterRunning = rowOf(afterTree, runningSession);
  const afterIdle = rowOf(afterTree, idleSession);
  const afterWorking = afterTree.sessions.filter((session) => session.status === 'working').map((session) => session.id);
  print('判据 (c) 旧代消失后的树行', {
    running: { id: runningSession, status: afterRunning?.status, statusLabel: afterRunning?.statusLabel },
    idle: { id: idleSession, status: afterIdle?.status, statusLabel: afterIdle?.statusLabel },
    workingIds: afterWorking,
  });
  assert.ok(afterRunning && afterIdle, '(c) both rows must still be in /tree after the old generation is gone');
  assertRowShape(afterRunning, 'after drain');
  assertRowShape(afterIdle, 'after drain');
  assert.notEqual(afterRunning.status, 'working', '(c) no session may stay "working" after its generation is gone');
  assert.ok(['idle', 'unread'].includes(afterRunning.status), `(c) the finished session must fall back to an honest disk status, got ${afterRunning.status}`);
  assert.equal(afterIdle.status, 'idle', '(c) the idle session must still report idle');
  assert.deepEqual(afterWorking, [], '(c) no phantom "working" rows after the draining generation exits');

  print('RESULT', 'tree-draining-status PASS');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  const cleanup = async (label, action) => {
    try { await action(); } catch (error) { cleanupProblems.push(`${label}: ${error.message}`); }
  };
  if (hostRuntime) await cleanup('stop host', () => stopHost(hostRuntime, hostRuntime.port));
  if (provider?.server) {
    provider.server.closeAllConnections();
    await cleanup('stop provider', () => new Promise((resolve) => provider.server.close(resolve)));
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
