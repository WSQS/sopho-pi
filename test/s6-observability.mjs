import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, runArms, stopSpawnedListener } from './harness.mjs';
// 「推荐回复」那次**旁路模型调用**不是「这一轮的请求」——本门按响应的**次序**发 plan
//（round-one / round-two / round-without-usage），旁路那次不能占掉一个 plan、也不进这本账。
import { isSuggestionBypassRequest } from './fixtures/suggestions-bypass.mjs';
import { FakeElement } from './fake-dom.mjs';

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's6-observability-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 's6-base.log');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
let providerServer;
let baseChild;
let baseLog;
let providerPort;
let basePort;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}


async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value };
}

async function poll(label, operation, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function completionChunk(content, finishReason = null, usage = undefined) {
  return {
    id: 'chatcmpl-s6',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-s6',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

async function startFakeProvider() {
  const plans = [
    { text: 'round-one', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
    { text: 'round-two', usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } },
    { text: 'round-without-usage', usage: undefined },
  ];
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    // 「推荐回复」那次旁路调用（回合落定后另起的一次模型调用）：**不占 plan**、也不进这本账，
    // 回一个空空当当的正常完成响应就行（它不是对话里的任何一轮）。
    if (isSuggestionBypassRequest(body)) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify(completionChunk('', 'stop'))}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    requests.push(body);
    const plan = plans.shift();
    assert.ok(plan, 'unexpected provider request');
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(completionChunk(plan.text))}\n\n`);
    response.write(`data: ${JSON.stringify(completionChunk(null, 'stop', plan.usage))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, requests };
}

async function waitForHttp() {
  await poll('base ready', () => api('/host').catch(() => null), (response) => response?.statusCode === 200);
}

async function runTurn(sessionId, text, assistantCount) {
  const accepted = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text } });
  assert.equal(accepted.statusCode, 202);
  return poll(`turn ${assistantCount} persisted`, () => api(`/sessions/${sessionId}/messages`), (response) => response.statusCode === 200
    && response.value.messages.filter((message) => message.role === 'assistant').length === assistantCount);
}

let primaryError;
try {
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  const used = new Set();
  providerPort = await reserveHighPort(used); used.add(providerPort);
  basePort = await reserveHighPort(used); used.add(basePort);

  const routerSessionId = randomUUID();
  const routerSessionPath = path.join(sessionsRoot, `router_${routerSessionId}.jsonl`);
  const now = new Date().toISOString();
  await writeFile(routerSessionPath, `${[
    { type: 'session', version: 3, id: routerSessionId, timestamp: now, cwd },
    { type: 'message', id: 'router-user', parentId: null, timestamp: now, message: { role: 'user', content: 'route this', timestamp: Date.now() } },
    { type: 'message', id: 'router-assistant', parentId: 'router-user', timestamp: now, message: {
      role: 'assistant', content: [{ type: 'text', text: 'routed' }], api: 'openai-completions', provider: 'fake', model: 'autorouter', responseModel: 'complex-tier',
      usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55, cost: { input: 0.0001, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00012 } },
      stopReason: 'stop', timestamp: Date.now(),
    } },
    { type: 'compaction', id: 'router-compaction', parentId: 'router-assistant', timestamp: now, summary: 'compact', firstKeptEntryId: 'router-user', tokensBefore: 55,
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0.00002, output: 0.000004, cacheRead: 0, cacheWrite: 0, total: 0.000024 } } },
  ].map(JSON.stringify).join('\n')}\n`);

  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{
          id: 'fake-s6',
          name: 'S6 Fake',
          contextWindow: 4096,
          maxTokens: 1024,
          cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
        }, {
          id: 'autorouter',
          name: 'Approximate Router',
          contextWindow: 4096,
          maxTokens: 1024,
          cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
        }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-s6',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  providerServer = await startFakeProvider();
  baseLog = await open(baseLogPath, 'w');
  baseChild = spawn(process.execPath, [baseEntry], {
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
      SOPHO_DEFAULT_CWD: cwd,
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await waitForHttp();
  assert.equal(Number(await listenerPid(basePort)), baseChild.pid);
  print('sandbox', { home, providerPort, basePort, forbiddenPortsUsed: false });

  // 各臂独立报告：一臂红也要把其余臂跑完（④ 前端 DOM 那一臂最容易被前面遮住）。
  // `sessionId` / `twoRounds` 是跨臂状态，所以提到外层。
  let sessionId = null;
  let twoRounds = null;
  const { failed } = await runArms([
    ['① router 估算标记（按近似模型计价）', async () => {
      // 会话文件在 setup 里就写好了（与基线一致：宿主启动前就在）。
      const routerMessages = await api(`/sessions/${routerSessionId}/messages`);
      assert.equal(routerMessages.statusCode, 200);
      const routed = routerMessages.value.messages.find((message) => message.role === 'assistant');
      assert.equal(routed.model.id, 'complex-tier');
      assert.equal(routed.model.requestedId, 'autorouter');
      assert.equal(routed.model.routed, true);
      assert.equal(routed.costEstimated, true);
      assert.equal(routed.costBasis, 'assumed');
      assert.match(routed.costNote, /Router model pricing is approximate/);
      assert.deepEqual(routerMessages.value.observability.cumulative.auxiliary, { known: 1, unknown: 0 });
      assert.equal(routerMessages.value.observability.cumulative.usage.input, 60);
      assert.equal(routerMessages.value.observability.cumulative.usage.output, 6);
      assert.equal(routerMessages.value.observability.cumulative.costBasis, 'assumed');
      print('router estimate marker', { model: routed.model, costEstimated: routed.costEstimated, costBasis: routed.costBasis, costNote: routed.costNote, cumulative: routerMessages.value.observability.cumulative });
      return { model: routed.model.id, costBasis: routed.costBasis, input: routerMessages.value.observability.cumulative.usage.input };
    }],

    ['② 两轮已知用量（metadata 计价）', async () => {
      const created = await api('/sessions', { method: 'POST', body: { cwd, name: 'S6 Observability' } });
      assert.equal(created.statusCode, 201);
      sessionId = created.value.id;

      await runTurn(sessionId, 'first', 1);
      twoRounds = await runTurn(sessionId, 'second', 2);
      const assistants = twoRounds.value.messages.filter((message) => message.role === 'assistant');
      assert.equal(assistants[0].model.display, 'fake/fake-s6');
      assert.deepEqual(
        assistants.map((message) => ({ input: message.usage.input, output: message.usage.output })),
        [{ input: 100, output: 10 }, { input: 200, output: 20 }],
      );
      assert.ok(assistants.every((message) => message.costEstimated === true));
      assert.ok(assistants.every((message) => message.costBasis === 'metadata'));
      assert.deepEqual(twoRounds.value.observability.cumulative.usage, {
        status: 'known', input: 300, output: 30, cacheRead: 0, cacheWrite: 0, note: null,
      });
      assert.equal(twoRounds.value.observability.cumulative.costEstimated, true);
      assert.equal(twoRounds.value.observability.cumulative.costBasis, 'metadata');
      assert.ok(Math.abs(twoRounds.value.observability.cumulative.cost.total - 0.00072) < 1e-12);
      print('two known rounds', {
        messages: assistants.map((message) => ({ model: message.model, usage: message.usage, cost: message.cost, costEstimated: message.costEstimated, costBasis: message.costBasis })),
        cumulative: twoRounds.value.observability.cumulative,
      });
      return { totalInput: twoRounds.value.observability.cumulative.usage.input };
    }],

    ['③ 缺失用量=unknown（不许当 0）+ 详情', async () => {
      const threeRounds = await runTurn(sessionId, 'third without usage', 3);
      const third = threeRounds.value.messages.filter((message) => message.role === 'assistant').at(-1);
      assert.equal(third.usage.status, 'unknown');
      assert.equal(third.usage.input, null);
      assert.equal(third.usage.output, null);
      assert.equal(third.usage.raw.input, 0);
      assert.equal(third.usage.raw.output, 0);
      assert.match(third.usage.note, /unknown, not zero/);
      assert.equal(third.costEstimated, true);
      assert.equal(third.costBasis, 'metadata');
      assert.equal(threeRounds.value.observability.cumulative.usage.status, 'partial');
      assert.equal(threeRounds.value.observability.cumulative.usage.input, 300);
      assert.equal(threeRounds.value.observability.cumulative.rounds.unknown, 1);
      print('missing usage is unknown', { third: { usage: third.usage, cost: third.cost }, cumulative: threeRounds.value.observability.cumulative });

      const detail = await api(`/sessions/${sessionId}`);
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.value.observability.lastTurn.model.display, 'fake/fake-s6');
      assert.equal(detail.value.observability.lastTurn.usage.status, 'unknown');
      assert.equal(detail.value.observability.cumulative.usage.input, 300);
      return { cumulativeStatus: threeRounds.value.observability.cumulative.usage.status, unknownRounds: threeRounds.value.observability.cumulative.rounds.unknown };
    }],

    ['④ 前端观测行 DOM（用量压回一行）', async () => {
      const { renderSessionObservability } = await import(`${pathToFileURL(path.join(sourceRoot, 'web', 'render.js')).href}?test=${Date.now()}`);
      const line = new FakeElement();
      renderSessionObservability(line, twoRounds.value.observability);
      assert.match(line.textContent, /fake\/fake-s6/);
      assert.match(line.textContent, /累计输入 300/);
      // 2026-09-19 门维护：用量行在 badd34d（用量/观测行压回一行）里已把
      // 「（估算，非账单）」两个词压成「（估算）」—— 那是当时的既定简化，
      // 断言一直没跟着改，于是这道门在底座上就是红的。这里只同步文案，不改判定口径。
      assert.match(line.textContent, /（估算）/);
      const indexHtml = await readFile(path.join(sourceRoot, 'web', 'index.html'), 'utf8');
      assert.match(indexHtml, /id="session-usage"/);
      print('frontend DOM line', line.textContent);
      return line.textContent;
    }],
  ], { title: 's6-observability' });

  print('RESULT', failed.length === 0 ? 'S6 observability PASS' : `S6 observability FAIL（${failed.length} 臂红）`);
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  if (basePort) {
    try { await stopSpawnedListener(baseChild, basePort, baseEntry); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (providerServer?.server) {
    providerServer.server.closeAllConnections();
    await new Promise((resolve) => providerServer.server.close(resolve));
  }
  if (baseLog) await cleanupStep(cleanupProblems, 'close baseLog', () => baseLog.close());
  if (baseChild && baseChild.exitCode === null) await new Promise((resolve) => baseChild.once('exit', resolve));
  const baseOutput = await readFile(baseLogPath, 'utf8').catch(() => '');
  if (baseOutput.trim()) print('base log', baseOutput.trim());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
