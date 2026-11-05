#!/usr/bin/env node
// test/stream-tree-events.mjs —— 「一次流式回复期间不产生 delta 类 tree.session 事件」的机械门。
//
// 为什么要有它：`server/base-logic.mjs` 的 runtime adapter 原来对**所有**会话事件都调
// `emitTree(..., name)`，于是每个 delta 都推一条 `tree.session`；前端收到就全量 `GET /api/tree`
// （305 会话时实测 215 KB / 0.5–1.3 s）并整体重建左栏。服务端的事件率实测到 171 条/秒，
// 与 `session.delta` **1:1**。这跟 v2.1 的语义不一致（v2.1 没有任何 per-delta 树事件）。
//
// 这条门做的事：真起一个沙箱 A（假上游按 chunk 流），在 `/tree/events` 上数事件 ——
//   ① 上游真的流了（`session.delta` ≥ 门槛，否则这条门什么都没验到）；
//   ② 流式窗口内 `tree.session` 的 reason **没有** `session.delta`；
//   ③ 状态转换的树事件还在（`session.start` / `session.end`），不是把功能删掉换数字好看；
//   ④ **客户端后果**：真 Chromium 开真 B 代理，数流式窗口里页面实际打了多少次 `GET /api/tree`
//      （`performance.getEntriesByType('resource')`）—— 事件率是机制，这是用户付的账。
//
// 铁律：自己 spawn 的沙箱 A（只按自己的 pid 停）、高位随机端口、临时 home、**不 pkill**、
// **不碰真 profile**、**不用 7331/7321**；假上游只在 127.0.0.1 上监听随机口。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { hostStatus, poll, reserveHighPort, startSandboxBase } from './perf-verify-lib.mjs';
import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DELTA_TARGET = Number(process.env.SOPHO_TREE_EVENTS_DELTAS ?? 300);
const DELTA_TEXT = '流';
const PROVIDER_CHUNK_DELAY_MS = Number(process.env.SOPHO_TREE_EVENTS_DELAY_MS ?? 2);

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

// `SOPHO_TREE_EVENTS_REPORT=1`：只打印、不抛（拿「修前」的原始数字用；默认缺省的严格模式才抛）。
const REPORT_ONLY = process.env.SOPHO_TREE_EVENTS_REPORT === '1';

function check(name, ok, detail) {
  if (!ok && REPORT_ONLY) {
    process.stdout.write(`✗(报告模式) ${name} —— ${detail}\n`);
    return;
  }
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

function providerChunk(content, finishReason = null) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'tree-events-fake',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
  };
}

/** 假上游：把一条回复拆成 DELTA_TARGET 个 chunk 流出去（pi 会把每个 chunk 变成一个 text_delta）。 */
async function startFakeProvider(port, requests) {
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const part of request) raw += part;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify(providerChunk(''))}\n\n`);
    for (let index = 0; index < DELTA_TARGET; index += 1) {
      if (response.destroyed) return;
      response.write(`data: ${JSON.stringify(providerChunk(DELTA_TEXT))}\n\n`);
      if (PROVIDER_CHUNK_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, PROVIDER_CHUNK_DELAY_MS));
    }
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify(providerChunk(null, 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

/** 逐块读 SSE，把 event/data 累积成列表；`waitFor` 等一条满足谓词的事件。 */
function openSse(port, pathname, events) {
  const controller = new AbortController();
  const waiters = [];
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSE ${pathname} did not connect`)), 10_000);
    (async () => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`SSE ${pathname} -> HTTP ${response.status}`);
      clearTimeout(timer);
      resolve(response);
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = {};
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event.event = line.slice(6).trim();
              else if (line.startsWith('data:')) event.data = JSON.parse(line.slice(5).trim());
            }
            if (event.event) {
              events.push(event);
              for (const waiter of [...waiters]) {
                if (waiter.predicate(event)) {
                  waiters.splice(waiters.indexOf(waiter), 1);
                  waiter.resolve(event);
                }
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (error.name !== 'AbortError') for (const waiter of waiters.splice(0)) waiter.reject(error);
      }
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });
  return {
    connected,
    events,
    waitFor(predicate, timeoutMs = 60_000, from = 0) {
      const existing = events.slice(from).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${pathname}: SSE wait timed out after ${timeoutMs}ms`)), timeoutMs);
        waiters.push({
          predicate,
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
      });
    },
    async close() {
      controller.abort();
      await connected.catch(() => {});
    },
  };
}

async function postJson(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch { value = text.slice(0, 400); }
  return { statusCode: response.status, value };
}

async function getJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { accept: 'application/json' } });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch { value = text.slice(0, 400); }
  return { statusCode: response.status, value };
}

async function waitForPage(operation, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

/** 最小 CDP 客户端（只用于本地 chromium）；pageProblems 收集未捕获异常与 console.error。 */
function cdp(wsUrl, pageProblems) {
  const socket = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') pageProblems.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageProblems.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  const client = {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    send(method, params = {}) {
      const id = ++sequence;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    once(method) {
      return new Promise((resolve) => {
        const listener = (params) => {
          listeners.get(method).delete(listener);
          resolve(params);
        };
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(listener);
      });
    },
    close() { socket.close(); },
  };
  client.evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
    return result.result.value;
  };
  return client;
}

const sandboxDir = await mkdtemp(path.join(os.tmpdir(), 'sopho-tree-events-'));
const home = path.join(sandboxDir, 'home');
const workspace = path.join(sandboxDir, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const logPath = path.join(sandboxDir, 'base.log');
const sessionId = randomUUID();

let providerServer = null;
let base = null;
let treeStream = null;
let app = null;
let appLog = null;
let chromium = null;
let browser = null;
const requests = [];

let primaryError;
try {
  await mkdir(workspace, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  const providerPort = await reservePort();
  providerServer = await startFakeProvider(providerPort, requests);

  const now = new Date().toISOString();
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: now, cwd: workspace },
    { type: 'model_change', id: 'b0000001', parentId: null, timestamp: now, provider: 'fake', modelId: 'tree-events-fake' },
    { type: 'thinking_level_change', id: 'b0000002', parentId: 'b0000001', timestamp: now, thinkingLevel: 'off' },
    { type: 'message', id: 'b0000003', parentId: 'b0000002', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'please stream' }], timestamp: Date.now() } },
  ];
  await writeFile(path.join(sessionsRoot, `tree-events_${sessionId}.jsonl`), `${lines.map(JSON.stringify).join('\n')}\n`);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'tree-events-fake', name: 'Tree Events Fake', contextWindow: 8192, maxTokens: 2048 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'tree-events-fake',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  base = await startSandboxBase({ home, sessionsRoot, workspace, logPath });
  await poll('sandbox ready', () => hostStatus(base.port), (status) => (status?.currentWorkerPid ?? 0) > 0, 60_000);
  print('sandbox', { port: base.port, pid: base.child.pid, home, sessionId, forbiddenPortsUsed: false });

  const treeEvents = [];
  treeStream = openSse(base.port, '/tree/events', treeEvents);
  await treeStream.connected;
  await treeStream.waitFor((event) => event.event === 'tree.snapshot');

  // 打开会话事件流（走 A 的 /sessions/{id}/events），这样才能确定「delta 都发出去了」。
  const sessionEvents = [];
  const sessionStream = openSse(base.port, `/sessions/${sessionId}/events`, sessionEvents);
  await sessionStream.connected;
  await sessionStream.waitFor((event) => event.event === 'session.snapshot');

  const treeCountBefore = treeEvents.length;
  const sessionIndexBefore = sessionEvents.length;
  const accepted = await postJson(base.port, `/sessions/${sessionId}/message`, { text: 'please stream' });
  check('会话开始跑（POST /message 202）', accepted.statusCode === 202, `HTTP ${accepted.statusCode} body=${JSON.stringify(accepted.value)}`);
  await sessionStream.waitFor((event) => event.event === 'session.start', 30_000);
  await sessionStream.waitFor((event) => event.event === 'session.end', 60_000);
  await new Promise((resolve) => setTimeout(resolve, 400)); // 让最后一拍 SSE 落地

  const window = sessionEvents.slice(sessionIndexBefore);
  const treeWindow = treeEvents.slice(treeCountBefore);
  const deltas = window.filter((event) => event.event === 'session.delta');
  const treeSessions = treeWindow.filter((event) => event.event === 'tree.session');
  const reasons = {};
  for (const event of treeSessions) reasons[event.data?.reason ?? '(none)'] = (reasons[event.data?.reason ?? '(none)'] ?? 0) + 1;
  const deltaReasons = treeSessions.filter((event) => String(event.data?.reason ?? '').startsWith('session.delta'));

  print('流式窗口实测', {
    providerRequests: requests.length,
    deltas: deltas.length,
    treeSessionTotal: treeSessions.length,
    treeSessionReasons: reasons,
    treeSnapshot: treeWindow.filter((event) => event.event === 'tree.snapshot').length,
  });

  check('假上游这一轮真的按 chunk 流了（否则这条门什么都没验到）', deltas.length >= Math.floor(DELTA_TARGET * 0.9), `session.delta=${deltas.length} 期望 ≥${Math.floor(DELTA_TARGET * 0.9)}`);
  check('一次流式回复期间没有 delta 类 tree.session', deltaReasons.length === 0, `reason=session.delta 的 tree.session=${deltaReasons.length}（全部 tree.session=${treeSessions.length}）`);
  check('状态转换的树事件还在：session.start', reasons['session.start'] >= 1, JSON.stringify(reasons));
  check('状态转换的树事件还在：session.end', reasons['session.end'] >= 1, JSON.stringify(reasons));
  check('这一轮回复的正文都是"流"字（上游与 pi 的口径对得上）', deltas.every((event) => event.data?.channel === 'text' && event.data?.delta === DELTA_TEXT), JSON.stringify(deltas.slice(0, 3)));

  const tree = await getJson(base.port, '/tree');
  const row = tree.value?.sessions?.find((session) => session.id === sessionId);
  check('会话在树里（这条门连的是真 /tree）', tree.statusCode === 200 && !!row, `HTTP ${tree.statusCode} row=${JSON.stringify(row)}`);

  // ④ 客户端后果：真 Chromium 开真 B 代理，数流式窗口里页面实际打了多少次 `GET /api/tree`。
  const appPort = await reserveHighPort();
  // ⚠️ 这里**不能**写 `const appLog = ...`：外层已有一个 `let appLog = null`（收尾用它关日志），
  // 遮蔽它的话下面 `cleanupStep('close app log', () => appLog?.close?.())` 关的是 null，
  // 这个 FileHandle 就丢给 GC —— Node 25 把这个（以前只是 deprecation）升成硬错：
  // `ERR_INVALID_STATE: A FileHandle object was closed during garbage collection`，
  // 进程在**所有断言都过了之后**以非 0 退出（实测：同一份代码 3 次里红 1 次，纯 GC 时机）。
  appLog = await open(path.join(sandboxDir, 'app.log'), 'w');
  app = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'app.mjs')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      SOPHO_APP_HOST: '127.0.0.1',
      SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1',
      SOPHO_UPSTREAM_PORT: String(base.port),
      SOPHO_WEB_ROOT: path.join(REPO_ROOT, 'web'),
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  await poll('app ready', () => fetch(`http://127.0.0.1:${appPort}/api/host`).then((response) => response.ok, () => false), (ok) => ok === true, 30_000);

  const debugPort = await reservePort();
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandboxDir, 'chromium')}`, 'about:blank',
  ], { env: browserSandboxEnv(sandboxDir), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitForPage(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const pageProblems = [];
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await loaded;
  const treeFetches = () => browser.evaluate(`performance.getEntriesByType('resource').filter((entry) => entry.name.endsWith('/api/tree')).length`);
  await waitForPage(() => browser.evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'session row did not render in the real client');
  await browser.evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitForPage(() => browser.evaluate(`document.querySelector('#session-title').textContent.includes('please stream') && document.querySelector('#session-connection').textContent.includes('已连接')`), 'session page did not connect in the real client');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const clientTreeBefore = await treeFetches();
  const clientSessionIndex = sessionEvents.length;
  const secondAccepted = await postJson(base.port, `/sessions/${sessionId}/message`, { text: 'stream for the real client' });
  check('真客户端的这一轮也开始跑', secondAccepted.statusCode === 202, `HTTP ${secondAccepted.statusCode}`);
  await sessionStream.waitFor((event) => event.event === 'session.start', 30_000, clientSessionIndex);
  await sessionStream.waitFor((event) => event.event === 'session.end', 60_000, clientSessionIndex);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const clientTreeDuring = (await treeFetches()) - clientTreeBefore;
  const clientDeltas = sessionEvents.slice(clientSessionIndex).filter((event) => event.event === 'session.delta').length;
  print('真客户端实测', { chromium: version.Browser, deltasThisTurn: clientDeltas, treeFetchesDuringTurn: clientTreeDuring, pageProblems });
  check('真客户端把 300 个 delta 全收了（否则这个数字没意义）', clientDeltas >= Math.floor(DELTA_TARGET * 0.9), `session.delta=${clientDeltas}`);
  check('真客户端在一轮流式回复里打的 GET /api/tree 次数 ≤ 4（状态转换）', clientTreeDuring <= 4, `实测 ${clientTreeDuring} 次（每 delta 一次时会是几百次）`);
  check('真客户端页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));

  await sessionStream.close();
  print('RESULT', `stream tree events ${REPORT_ONLY ? '(报告模式，不判成败)' : 'PASS'}（${deltas.length} 个 delta，delta 类 tree.session = ${deltaReasons.length}，状态转换树事件 = ${JSON.stringify(reasons)}；真客户端一轮 ${clientDeltas} delta 打了 ${clientTreeDuring} 次 GET /api/tree）`);
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  browser?.close();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await new Promise((resolve) => chromium.once('exit', resolve));
  }
  if (app && app.exitCode === null) app.kill('SIGTERM');
  await cleanupStep(cleanupProblems, 'close app log', () => appLog?.close?.());
  await cleanupStep(cleanupProblems, 'close tree stream', () => treeStream?.close?.());
  await cleanupStep(cleanupProblems, 'stop base', () => base?.stop?.());
  if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
  await removeSandbox(sandboxDir, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
