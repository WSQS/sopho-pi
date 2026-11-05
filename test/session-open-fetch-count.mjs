#!/usr/bin/env node
// test/session-open-fetch-count.mjs —— 「打开一条会话 ⇒ 正文只拉一次」的观察台 + 门（真 A + 真 B + 真 Chromium）。
//
// 为什么单独一条门：`test/session-connect-flow.mjs` 用的是**假 API**，它把 `session.snapshot`
// 在连上的一瞬间就发出去了 —— 于是「选中会话那次拉取」与「初连快照那次拉取」**必然重叠**，
// coalesce（`web/app.js` 的 messagesRefreshInFlight）必然命中，那条门永远是绿的。
// 真服务端不是这样：`session.snapshot` 要等 `/events` 那边把 runtime 打开（大会话上实测是秒级），
// 而 `/messages` 的冷读有响应体缓存（命中时几十毫秒）⇒ **第一条 GET 先回来**，第二条（快照那次）
// 到的时候 `messagesRefreshInFlight` 已经被清掉了 ⇒ 同一份正文白拉第二遍。这就是本门要钉住的现场。
//
// 做法：
//   ① 沙箱里种两条会话：一条大会话（默认 900 条 × 20 KB ≈ 18 MiB）、一条小会话（12 条）；
//   ② 先用**裸 HTTP** 把大会话的 `/messages` 响应体缓存预热一次（复现「重复打开」那条实况：
//      缓存命中时 TTFB 很小，而 runtime 才刚开始打开 ⇒ 两条拉取不重叠）；
//   ③ 真 Chromium 打开页面 → 点大会话 → 点小会话，**每一次 `/messages` 请求**都记下来
//      （URL 是否带 `?after=`、响应字节、发起者、时刻）；
//   ④ 默认只观察（打印归因表，exit 0）；`--assert` 才断言「每条会话打开时 `/messages` 总数 ≤ 1」。
//
// 红线：只起**自己 spawn** 的 A、B 与 Chromium，只按各自 pid 停（`test/harness.mjs`）；
// 高位随机端口（绝不用 7331/7321）；日志写本次沙箱；**不 pkill**；不碰真实 profile。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, quiesceCdpPage, removeSandbox } from './harness.mjs';
import { hostStatus, poll, reserveHighPort, sleep, startSandboxBase, writeMinimalHome } from './perf-verify-lib.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-openfetch-'));
const home = path.join(sandbox, 'home');
const workspace = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 'openfetch-base.log');
const appLogPath = path.join(sandbox, 'openfetch-app.log');

// 默认 200 条 × 20 KB ≈ 10 MiB：这是「缓存命中后 GET 很快、而 runtime 才刚开始打开」的甜区 ——
// 大会话 GET 的往返（约 0.3 s）**短于** runtime 打开（秒级），所以快照那次拉取必然落在它之后。
const BIG_MESSAGES = Number(process.env.SOPHO_OPENFETCH_BIG ?? 200);
const SMALL_MESSAGES = Number(process.env.SOPHO_OPENFETCH_SMALL ?? 12);
const assert = process.argv.includes('--assert') || process.env.SOPHO_OPENFETCH_ASSERT === '1';

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
let checks = 0;
function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

/** 一条内容确定的会话文件（真 JSONL 形状）。大会话用 20 KB/条把「runtime 打开」拖到秒级。 */
function sessionFile({ id, count, chars }) {
  const now = '2026-09-19T00:00:00.000Z';
  const lines = [{ type: 'session', version: 3, id, timestamp: now, cwd: workspace }];
  for (let index = 0; index < count; index += 1) {
    const text = `OPENFETCH-${index} ${`${index}`.padStart(6, '0')} `.padEnd(chars, 'x');
    const message = index % 2
      ? { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.parse(now) }
      : { role: 'user', content: text, timestamp: Date.parse(now) };
    lines.push({ type: 'message', id: `${index + 1}`.padStart(8, '0'), parentId: index === 0 ? null : `${index}`.padStart(8, '0'), timestamp: now, message });
  }
  return `${lines.map(JSON.stringify).join('\n')}\n`;
}

/** 裸 HTTP GET（只为预热响应体缓存 + 核一次 200）。 */
function rawGet(port, pathname) {
  return new Promise((resolve) => {
    const started = Date.now();
    const request = http.request({ host: '127.0.0.1', port, path: pathname, headers: { accept: 'application/json', connection: 'close' } });
    request.once('error', (error) => resolve({ error: error.message, statusCode: 0, bytes: 0, ms: Date.now() - started }));
    request.once('response', (response) => {
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => { bytes += chunk.length; chunks.push(chunk); });
      response.once('end', () => resolve({ statusCode: response.statusCode, bytes, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }));
    });
    request.end();
  });
}

function postJson(port, pathname, value) {
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: pathname, headers: { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

/** 假 provider：第一段 delta 写出后**挂住**，由测试释放 —— 用来把会话稳定地保持在「在跑」状态。 */
async function startFakeProvider(port) {
  const plans = [];
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') return response.writeHead(404).end();
    for await (const _ of request) { /* drain */ }
    const plan = plans.shift() ?? { text: 'OPENFETCH-DEFAULT', mode: 'normal', markStarted: () => {}, started: Promise.resolve(), released: Promise.resolve(), release: () => {} };
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunk = (content) => `data: ${JSON.stringify({ id: 'chatcmpl-openfetch', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-openfetch', choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: null }] })}\n\n`;
    response.write(chunk(''));
    response.write(chunk(plan.text));
    plan.markStarted();
    if (plan.mode === 'hold') await plan.released;
    if (response.destroyed) return;
    response.write(chunk(null));
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    server,
    plan(mode, text) {
      let startedResolve;
      let releaseResolve;
      const plan = {
        mode,
        text,
        releasedNow: false,
        started: new Promise((resolve) => { startedResolve = resolve; }),
        released: new Promise((resolve) => { releaseResolve = resolve; }),
        markStarted: () => startedResolve(),
        release: () => { plan.releasedNow = true; releaseResolve(); },
      };
      plans.push(plan);
      return plan;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

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
  return {
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
        const listener = (params) => { listeners.get(method).delete(listener); resolve(params); };
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(listener);
      });
    },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(handler);
      return () => listeners.get(method)?.delete(handler);
    },
    close() { socket.close(); },
  };
}

let base = null;
let appChild = null;
let chromium = null;
let browser = null;
let appLog = null;
let provider = null;
let primaryError = null;
const report = { fixture: { big: BIG_MESSAGES, small: SMALL_MESSAGES }, opens: [], requests: [] };
const pageProblems = [];
const cleanupProblems = [];

async function waitFor(operation, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(40);
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

try {
  const providerPort = await reserveHighPort();
  provider = await startFakeProvider(providerPort);
  await writeMinimalHome(home, workspace, {
    models: {
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          api: 'openai-completions',
          apiKey: 'sandbox-key',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: 'fake-openfetch', name: 'Openfetch Fake', contextWindow: 4096, maxTokens: 1024 }],
        },
      },
    },
    settings: { defaultProvider: 'fake', defaultModel: 'fake-openfetch', defaultThinkingLevel: 'off', compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } },
  });
  await mkdir(sessionsRoot, { recursive: true });
  const bigId = randomUUID();
  const smallId = randomUUID();
  await writeFile(path.join(sessionsRoot, `openfetch_big_${bigId}.jsonl`), sessionFile({ id: bigId, count: BIG_MESSAGES, chars: 20_000 }));
  await writeFile(path.join(sessionsRoot, `openfetch_small_${smallId}.jsonl`), sessionFile({ id: smallId, count: SMALL_MESSAGES, chars: 400 }));

  base = await startSandboxBase({ home, sessionsRoot, workspace, logPath: baseLogPath });
  await poll('openfetch sandbox ready', () => hostStatus(base.port), (host) => host?.currentWorkerPid > 0, 120_000);

  // ② 预热大会话的响应体缓存（模拟「重复打开」：GET 变成几十毫秒的小请求）。
  const warm = await rawGet(base.port, `/sessions/${bigId}/messages`);
  report.warm = { status: warm.statusCode, bytes: warm.bytes, ms: warm.ms };
  check('沙箱预热：大会话 /messages 冷读一次成功（接下来浏览器那条 GET 会命中响应体缓存）',
    warm.statusCode === 200 && warm.bytes > 1024 * 1024,
    JSON.stringify({ status: warm.statusCode, bytes: warm.bytes, ms: warm.ms }));

  const appPort = await reserveHighPort();
  appLog = await open(appLogPath, 'w');
  appChild = spawn(process.execPath, [path.join(sourceRoot, 'server', 'app.mjs')], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_APP_HOST: '127.0.0.1',
      SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1',
      SOPHO_UPSTREAM_PORT: String(base.port),
      SOPHO_WEB_ROOT: path.join(sourceRoot, 'web'),
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  await poll('B ready', async () => {
    const response = await rawGet(appPort, '/api/host');
    return response.statusCode === 200 ? response : null;
  }, (value) => value !== null, 60_000);

  // ── ③ 真 Chromium：把每一次 /messages 都记下来 ─────────────────────────────
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  const debugPort = await reserveHighPort();
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'Chromium remote debugger did not start', 60_000);
  report.environment = { browser: version.Browser, chrome, node: process.version, platform: `${os.platform()} ${os.release()}` };
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Network.enable');

  const timeOriginBase = Date.now();
  const pendingRequests = new Map();
  const messagesRequests = [];
  browser.on('Network.requestWillBeSent', (params) => {
    const url = params.request.url;
    if (!/\/api\/sessions\/[^/]+\/messages/.test(url)) return;
    const record = {
      id: params.requestId,
      url,
      sessionId: /\/api\/sessions\/([^/]+)\/messages/.exec(url)?.[1] ?? null,
      query: url.includes('?') ? url.slice(url.indexOf('?')) : '',
      after: new URL(url).searchParams.get('after'),
      full: !url.includes('after='),
      initiator: params.initiator?.type ?? null,
      initiatorUrl: (params.initiator?.url ?? params.initiator?.stack?.callFrames?.[0]?.url ?? null),
      initiatorFunction: params.initiator?.stack?.callFrames?.[0]?.functionName ?? null,
      tMs: Date.now() - timeOriginBase,
      wallClock: params.wallTime ?? null,
      type: params.type,
    };
    messagesRequests.push(record);
    pendingRequests.set(params.requestId, record);
  });
  browser.on('Network.responseReceived', (params) => {
    const record = pendingRequests.get(params.requestId);
    if (!record) return;
    record.status = params.response.status;
    record.mimeType = params.response.mimeType;
    record.etag = params.response.headers.etag ?? params.response.headers.ETag ?? null;
    record.responseHeaders = params.response.headers;
    record.ttfbMs = Date.now() - timeOriginBase;
  });
  browser.on('Network.loadingFinished', (params) => {
    const record = pendingRequests.get(params.requestId);
    if (!record) return;
    record.encodedDataLength = params.encodedDataLength;
    record.finishedMs = Date.now() - timeOriginBase;
    pendingRequests.delete(params.requestId);
  });

  // SSE 帧（含 `session.snapshot`）也记下来：/messages 的每一次请求都要能对上是**谁**触发的。
  const sseFrames = [];
  browser.on('Network.eventSourceMessageReceived', (params) => {
    let summary = params.data ?? '';
    try {
      const parsed = JSON.parse(params.data);
      summary = JSON.stringify(parsed).slice(0, 200);
      if (params.eventName === 'session.snapshot') summary = `snapshot ${JSON.stringify({ isStreaming: parsed.isStreaming, keys: Object.keys(parsed).slice(0, 8) })}`;
    } catch {}
    sseFrames.push({ tMs: Date.now() - timeOriginBase, eventName: params.eventName, data: summary });
  });

  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await loaded;
  await waitFor(() => browser.send('Runtime.evaluate', { expression: `document.querySelector('[data-session-id="${bigId}"]') !== null`, returnByValue: true }).then((r) => r.result.value), 'tree did not render', 30_000);

  const click = (id) => browser.send('Runtime.evaluate', { expression: `document.querySelector('[data-session-id="${id}"] .tree-select').click(); true`, returnByValue: true }).then((r) => r.result.value);
  const pageState = () => browser.send('Runtime.evaluate', {
    expression: `(() => { const m = document.querySelector('#messages'); return { bubbles: m?.querySelectorAll('.message').length ?? null, complete: m?.dataset.renderComplete ?? null, total: m?.dataset.messageTotal ?? null, title: document.querySelector('#session-title')?.textContent ?? null }; })()`,
    returnByValue: true,
  }).then((r) => r.result.value);

  /** 点一条会话，等它稳定（渲染完成 + 一段时间没有再发 /messages）。 */
  async function openSession(label, id) {
    const before = messagesRequests.length;
    // 先等这一行真在树里（新建的会话靠 tree SSE 增行）—— 不然 click 会静默落空，
    // 后面的 waitFor 会拿**上一条会话**的 renderComplete 当判据。
    await waitFor(() => browser.send('Runtime.evaluate', { expression: `document.querySelector('[data-session-id="${id}"] .tree-select') !== null`, returnByValue: true }).then((r) => r.result.value), `${label}: 树里没有这一行`, 30_000);
    await click(id);
    await waitFor(async () => {
      const state = await pageState();
      return state.complete === 'true' && state.total !== null ? state : null;
    }, `${label}: 正文没有渲染完成`, 120_000);
    // 静置窗：只认「这之后 1.2 s 内不再有新的 /messages」。
    let seen = messagesRequests.length;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(120);
      if (messagesRequests.length === seen) break;
      seen = messagesRequests.length;
    }
    const state = await pageState();
    const requests = messagesRequests.slice(before);
    report.opens.push({ label, id, state, requests });
    print(`open[${label}] 请求`, requests.map((request) => ({ full: request.full, after: request.after, status: request.status, bytes: request.encodedDataLength ?? null, etag: request.etag, tMs: request.tMs, initiator: request.initiator, fn: request.initiatorFunction })));
    print(`open[${label}] 页面`, state);
    return requests;
  }

  const bigRequests = await openSession(`大会话(${BIG_MESSAGES}条)`, bigId);
  const smallRequests = await openSession(`小会话(${SMALL_MESSAGES}条)`, smallId);
  report.requests = messagesRequests;

  // ── ③ 一条**在跑**的会话：正文还在写时，初连那两条拉取**不许**合并（第二拉是必要的）──
  // 服务端登记 SSE 订阅是在它把 runtime 打开之后（`pool.acquire` → `adapter.subscribe` → 发快照），
  // 所以「正文还在写」的那一段真的可能有落盘内容既没被第一条 GET 拿到、又没赶上订阅；
  // 这是「不做第二次拉取」唯一会丢正文的窗口，门必须钉住它。
  const created = await postJson(appPort, '/api/sessions', { cwd: workspace, name: 'openfetch streaming' });
  check('③ 能在沙箱里建一条会跑的会话（POST /sessions）', created.statusCode === 201, `status=${created.statusCode} body=${created.body.slice(0, 200)}`);
  const streamId = JSON.parse(created.body).id;
  const hold = provider.plan('hold', 'OPENFETCH-STREAM-ALPHA');
  const started = await postJson(appPort, `/api/sessions/${streamId}/message`, { text: 'trigger streaming open' });
  check('③ 消息已受理（这一轮会被假 provider 挂住 ⇒ 会话处于「在跑」）', started.statusCode === 202, `status=${started.statusCode} body=${started.body.slice(0, 200)}`);
  await hold.started;
  const streamingRequests = await openSession('在跑的会话', streamId);
  report.streamingOpen = { requests: streamingRequests };
  // 这一格的时序由产品代码决定（runtime 已经是热的 ⇒ 快照可能落在第一条 GET 还在飞的时候）：
  //   1 条 = 快照与第一条 GET 重叠、被「在飞合并」挡掉（服务端订阅已登记，正文不会丢）；
  //   2 条 = 第一条 GET 先回来，快照那次**必须**重同步（见 `test/session-open-coalesce.mjs` ②）。
  // 两种都是对的；错的只有「合并掉一个还在写的正文」⇒ 下面再用内容收效钉住它。
  check('③ 会话在跑时打开：拉取 1–2 条（1=与在飞那次重叠而被挡住；2=第一条先回来、快照那次必须重同步），但不允许 >2',
    streamingRequests.length >= 1 && streamingRequests.length <= 2,
    `总数=${streamingRequests.length}; 明细=${JSON.stringify(streamingRequests.map((request) => ({ full: request.full, after: request.after, bytes: request.encodedDataLength ?? null, etag: request.etag, tMs: request.tMs })))}`);
  hold.release();
  await waitFor(async () => {
    const text = await browser.send('Runtime.evaluate', { expression: `(() => { const m = document.querySelector('#messages'); return { count: (m.textContent.match(/OPENFETCH-STREAM-ALPHA/g) || []).length, bubbles: m.querySelectorAll('.message').length, live: document.querySelectorAll('#messages .message-live').length }; })()`, returnByValue: true }).then((r) => r.result.value);
    return text.count > 0 && text.live === 0 ? text : null;
  }, '③ 流式那一轮结束后正文没有收敛', 60_000);
  const streamed = await browser.send('Runtime.evaluate', { expression: `(() => { const m = document.querySelector('#messages'); return { count: (m.textContent.match(/OPENFETCH-STREAM-ALPHA/g) || []).length, bubbles: m.querySelectorAll('.message').length }; })()`, returnByValue: true }).then((r) => r.result.value);
  report.streamingTail = streamed;
  check('③ 在跑的会话打开后，流式那一轮的内容最终**只出现一次**（第二拉既没丢也没画重）',
    streamed.count === 1,
    JSON.stringify(streamed));

  report.pageProblems = pageProblems;

  if (assert) {
    for (const [label, requests] of [[`大会话(${BIG_MESSAGES}条)`, bigRequests], [`小会话(${SMALL_MESSAGES}条)`, smallRequests]]) {
      const full = requests.filter((request) => request.full);
      check(`${label}｜打开时 /messages 总数 ≤ 1（不含增量之后的若干次）`, requests.length <= 1,
        `总数=${requests.length}; 明细=${JSON.stringify(requests.map((request) => ({ full: request.full, after: request.after, bytes: request.encodedDataLength ?? null, etag: request.etag, initiator: request.initiator, fn: request.initiatorFunction })))}`);
      check(`${label}｜打开时**全量** /messages ≤ 1`, full.length <= 1, `全量次数=${full.length}; 明细=${JSON.stringify(full.map((request) => ({ bytes: request.encodedDataLength ?? null, tMs: request.tMs, initiatorFunction: request.initiatorFunction })))}`);
    }
    check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));
  }

  print('sse frames', sseFrames);
  print('timeline', [...messagesRequests.map((request) => ({ tMs: request.tMs, what: `GET /messages${request.query} -> ${request.status} ${request.encodedDataLength ?? '?'}B (initiator=${request.initiator}/${request.initiatorFunction})` })), ...sseFrames.map((frame) => ({ tMs: frame.tMs, what: `SSE ${frame.eventName} ${frame.data}` }))].sort((a, b) => a.tMs - b.tMs));
  print('summary', {
    requests: messagesRequests.map((request) => ({ session: request.sessionId === bigId ? 'big' : (request.sessionId === smallId ? 'small' : 'other'), full: request.full, after: request.after, status: request.status, bytes: request.encodedDataLength ?? null, etag: request.etag, ttfbMs: request.ttfbMs, tMs: request.tMs, initiator: request.initiator, initiatorFunction: request.initiatorFunction })),
    pageProblems,
    sseFrames,
  });
  print('RESULT', assert ? `session open fetch count PASS (${checks} checks)` : 'session open fetch count trace written');
} catch (error) {
  primaryError = error;
} finally {
  await cleanupStep(cleanupProblems, 'quiesce page', () => quiesceCdpPage(browser));
  await cleanupStep(cleanupProblems, 'close browser', () => browser?.close());
  if (chromium && chromium.exitCode === null) {
    await cleanupStep(cleanupProblems, 'stop chromium', async () => {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    });
  }
  if (appChild) await cleanupStep(cleanupProblems, 'stop B', async () => {
    if (appChild.exitCode !== null || appChild.signalCode !== null) return;
    appChild.once('exit', () => {});
    appChild.kill('SIGTERM');
    await sleep(200);
  });
  if (base) await cleanupStep(cleanupProblems, 'stop A', () => base.stop());
  if (appLog) await cleanupStep(cleanupProblems, 'close B log', () => appLog.close());
  if (provider) await cleanupStep(cleanupProblems, 'stop fake provider', () => provider.close());
  await cleanupStep(cleanupProblems, 'base log tail', async () => {
    const log = await readFile(baseLogPath, 'utf8').catch(() => '');
    if (primaryError && log) process.stderr.write(`--- base.log tail ---\n${log.split('\n').slice(-12).join('\n')}\n`);
  });
  await cleanupStep(cleanupProblems, 'B log tail', async () => {
    const log = await readFile(appLogPath, 'utf8').catch(() => '');
    if (primaryError && log) process.stderr.write(`--- app.log tail ---\n${log.split('\n').slice(-12).join('\n')}\n`);
  });
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
