#!/usr/bin/env node
// test/delegation-msg-order.mjs —— 「子会话 push 回来时，那条代理消息块（aside.extra-message）
// 必须**先**出现，再才是模型开始流式」这条顺序的观察台 + 门。
//
// 形状：真沙箱 A + B（副本 home + 高位随机端口 + 本地假 provider）+ 真 Chromium。
// 为什么必须真 A+B：扩展消息**不走 SSE**，它只存在于会话 JSONL 里、由 `/messages` 的 payload
// 现算出来（web/render.js 的 extraBoundaries）。所以「这条块什么时候出现在屏幕上」=「前端什么时候
// 拉了正文」，这条因果只有一个真服务端才看得见。
//
// 逐帧记录三件事（页内 performance.now，零点 = POST /push 那一刻）：
//   ① `aside.extra-message[data-custom-type="sopho.delegation"]` 第一次出现（MutationObserver）；
//   ② 直播块（`.live-message`）第一次出现（= session.start 那一帧）；
//   ③ 直播块里第一段**真内容**（正文/思考，不是「✻ 思考中…」占位）第一次出现。
// 另外从 Node 侧记一条独立的 SSE 流（原样打印每一个 event 名）—— 用来核「SSE 有没有为这条扩展消息
// 发任何事件」，以及服务端落消息与起轮的先后（再看 JSONL 的行序）。
//
// 默认只观察（exit 0）；`--assert` 才断言。断言里 A1-A4/A7 是**顺序本身**，A5/A6 是这次修法的**代价护栏**：
//   A1 JSONL 里 `sopho.delegation` 那条 custom_message **排在**这一轮的 assistant 正文之前（服务端那一半）；
//   A2 那条 aside 真的出现过；
//   A3 `asideAt <= firstDeltaAt`（这就是用户报的那条顺序）；
//   A4 收尾后 DOM 里 aside 仍在那条 assistant 正文**之前**（不是被堆到末尾）；
//   A5 开播那一帧的 aside 是**纯 append**（正文一个节点都没被摘掉/重画）；
//   A6 开播这一帧的正文重拉走的是**尾部增量**（带 `?after=` 游标）；
//   A7 收尾后 `#messages` 里恰好一条这个 customType 的 aside（不重复）。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, quiesceCdpPage, removeSandbox, stopSpawnedListener } from './harness.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-deleg-order-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const artifactRoot = process.env.SOPHO_DELEG_ARTIFACT_DIR || '/tmp/delegation-order-logs';
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const appEntry = path.join(sourceRoot, 'server', 'app.mjs');

const assertMode = process.argv.includes('--assert') || process.env.SOPHO_DELEG_ASSERT === '1';
const firstDeltaMs = Number(process.env.SOPHO_DELEG_FIRST_DELTA_MS ?? 400);
const chunkGapMs = Number(process.env.SOPHO_DELEG_CHUNK_GAP_MS ?? 60);
const CHUNKS = ['第一段流式正文。', '第二段流式正文。', '第三段流式正文。', '第四段流式正文。'];
const DELEGATION_TEXT = 'DELEGATION-ORDER-PROBE：子会话 push 回执（这一条必须排在流式正文之前）。';
// 父会话既有正文的条数（用来量这次「开播拉一次」在大会话上的代价；0 = 原来的 3 条小夹具）。
const HISTORY = Number(process.env.SOPHO_DELEG_HISTORY ?? 0);

const problems = [];
const report = { mode: assertMode ? 'assert' : 'observe', firstDeltaMs, chunkGapMs };
let checks = 0;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(operation, message, timeoutMs = 10_000) {
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

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value, body: text };
}

// ── 假 provider：第一次流式 delta 之前**故意停一会儿** ──────────────────────────
// 为什么需要这个停顿：真模型响应前本来就有排队/首 token 延迟；而我们量的正是「那条 aside 与第一帧
// 正文谁先到」。假 provider 若零延迟吐字，量到的只是「GET /messages 与一帧 SSE 谁更快」，
// 那就把要验的东西换成了另一件事。这个停顿把「模型还没开始说话」这段时间显式做出来。
function chunk(content, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-deleg',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  };
}

function assistantMessage(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-deleg',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function startFakeProvider(requests, logStream) {
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of request) raw += part;
    let body;
    try { body = JSON.parse(raw); } catch { body = { raw }; }
    requests.push({ at: Date.now(), body });
    logStream.write(`${JSON.stringify({ at: new Date().toISOString(), model: body.model, messages: (body.messages || []).length })}\n`);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    await sleep(firstDeltaMs);
    if (response.destroyed) return;
    for (const text of CHUNKS) {
      response.write(`data: ${JSON.stringify(chunk(text))}\n\n`);
      await sleep(chunkGapMs);
      if (response.destroyed) return;
    }
    response.write(`data: ${JSON.stringify(chunk(null, 'stop', true))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return server;
}

// ── 夹具：一条父会话（已有一轮问答）+ 一条子会话（header.parentSession 指向父文件）──────
async function writeSeedSessions() {
  const parentId = randomUUID();
  const childId = randomUUID();
  const parentPath = path.join(sessionsRoot, `seed-parent_${parentId}.jsonl`);
  const childPath = path.join(sessionsRoot, `seed-child_${childId}.jsonl`);
  const now = new Date().toISOString();
  const parentLines = [
    { type: 'session', version: 3, id: parentId, timestamp: now, cwd },
    { type: 'model_change', id: '00000001', parentId: null, timestamp: now, provider: 'fake', modelId: 'fake-deleg' },
    { type: 'message', id: '00000002', parentId: '00000001', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: '父会话的既有提问' }], timestamp: Date.now() } },
    { type: 'message', id: '00000003', parentId: '00000002', timestamp: now, message: assistantMessage('父会话的既有回答') },
  ];
  // 可选的大历史：每条 ≈2 KB，用来量「开播这一帧的重拉」在大会话上是整份还是尾部增量。
  const filler = '历史填充句子。'.repeat(150);
  let cursorId = '00000003';
  for (let index = 0; index < HISTORY; index += 1) {
    const id = `0001${String(index).padStart(4, '0')}`;
    const role = index % 2 === 0 ? 'user' : 'assistant';
    const message = role === 'assistant'
      ? assistantMessage(`HIST${index}：${filler}`)
      : { role: 'user', content: [{ type: 'text', text: `HIST${index}：${filler}` }], timestamp: Date.now() };
    parentLines.push({ type: 'message', id, parentId: cursorId, timestamp: now, message });
    cursorId = id;
  }
  const childLines = [
    { type: 'session', version: 3, id: childId, timestamp: now, cwd, parentSession: parentPath },
    { type: 'message', id: '10000001', parentId: null, timestamp: now, message: { role: 'user', content: '子会话待命', timestamp: Date.now() } },
  ];
  await writeFile(parentPath, `${parentLines.map(JSON.stringify).join('\n')}\n`);
  await writeFile(childPath, `${childLines.map(JSON.stringify).join('\n')}\n`);
  return { parentId, childId, parentPath, childPath };
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
}

const PAGE_PROBE = `(() => {
  window.__ord = { t0: null, aside: null, live: null, delta: null, ticks: [], asideCount: 0, inserts: 0, removes: 0, fetches: [] };
  const messages = document.querySelector('#messages');
  const stamp = () => performance.now() - window.__ord.t0;
  function scan() {
    const o = window.__ord;
    if (o.t0 === null) return;
    const now = stamp();
    const aside = messages.querySelector('aside.extra-message[data-custom-type="sopho.delegation"]');
    if (aside && o.aside === null) o.aside = now;
    const live = messages.querySelector('.live-message');
    if (live && o.live === null) o.live = now;
    let text = '';
    let thinking = '';
    if (live) {
      const body = live.querySelector('.message-body');
      if (body) {
        for (const node of body.childNodes) if (node.nodeType === 3) text += node.data;
        const think = body.querySelector('.message-thinking .thinking-body');
        if (think) thinking = think.textContent || '';
      }
    }
    if ((text.length > 0 || thinking.length > 0) && o.delta === null) o.delta = now;
    o.asideCount = messages.querySelectorAll('aside.extra-message').length;
    o.ticks.push({ at: Number(now.toFixed(1)), aside: Boolean(aside), liveText: text.length, thinking: thinking.length, bubbles: messages.querySelectorAll('article.message').length, inserts: o.inserts, removes: o.removes });
  }
  window.__ord.start = () => { window.__ord.t0 = performance.now(); };
  window.__ord.scan = scan;
  window.__ord.mutations = [];
  new MutationObserver((records) => {
    const o = window.__ord;
    const describe = (node) => node.nodeType === 3 ? '#text(' + node.data.length + ')' : node.tagName + '.' + node.className + (node.dataset && node.dataset.kind ? '[' + node.dataset.kind + ']' : '');
    for (const record of records) {
      o.removes += record.removedNodes.length; o.inserts += record.addedNodes.length;
      if (o.t0 !== null && (record.removedNodes.length || record.addedNodes.length)) {
        o.mutations.push({ at: Number((performance.now() - o.t0).toFixed(1)), removed: [...record.removedNodes].map(describe), added: [...record.addedNodes].map(describe) });
      }
    }
    scan();
  }).observe(messages, { subtree: true, childList: true, characterData: true, attributes: true });
  // 这一窗里所有 /messages GET（正文/扩展消息的**唯一**来源）：时刻 + 响应字节 + 是否带 ?after= 增量游标。
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
    const response = await origFetch(...args);
    if (url.includes('/messages')) {
      const o = window.__ord;
      response.clone().text().then((body) => o.fetches.push({
        at: o.t0 === null ? null : Number((performance.now() - o.t0).toFixed(1)),
        url, bytes: body.length, status: response.status,
      })).catch(() => {});
    }
    return response;
  };
  // 收尾形状：aside 在 DOM 里排在哪条正文之前/之后（用 final 探针读）。
  window.__ord.finalOrder = () => {
    const children = [...messages.children];
    const asideIndex = children.findIndex((node) => node.matches('aside.extra-message[data-custom-type="sopho.delegation"]'));
    const bodyIndex = children.findIndex((node) => node.matches('article.message-assistant') && !node.matches('.live-message') && node.textContent.includes('第一段流式正文'));
    return { asideIndex, bodyIndex, total: children.length, kinds: children.map((node) => node.dataset.kind || node.className) };
  };
  return 'probe-installed';
})()`;

// ── Node 侧独立 SSE 观察（用来核「SSE 到底发了什么」）──────────────────────────
function openSse(pathname, events) {
  let response;
  let buffer = '';
  let currentEvent = 'message';
  let currentData = [];
  const started = { at: null };
  const request = http.request({
    host: '127.0.0.1', port: appPort, path: `/api${pathname}`, headers: { accept: 'text/event-stream' },
  });
  const connected = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (incoming) => {
      response = incoming;
      assert.equal(incoming.statusCode, 200);
      incoming.setEncoding('utf8');
      incoming.on('data', (chunkText) => {
        buffer += chunkText;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line === '') {
            if (currentData.length > 0) {
              const raw = currentData.join('\n');
              let data;
              try { data = JSON.parse(raw); } catch { data = raw; }
              events.push({ at: started.at === null ? null : performance.now() - started.at, event: currentEvent, data });
            }
            currentEvent = 'message';
            currentData = [];
          } else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) currentData.push(line.slice(5).trimStart());
        }
      });
      incoming.on('error', () => {});
      resolve();
    });
    request.end();
  });
  return {
    connected,
    markStart() { started.at = performance.now(); },
    close() { response?.destroy(); request.destroy(); },
  };
}

let providerPort;
let basePort;
let appPort;
let providerServer;
let baseChild;
let appChild;
let chromium;
let browser;
let baseLog;
let appLog;
let providerLogStream;
let primaryError;
const providerRequests = [];
const sseEvents = [];
const pageProblems = [];
const screenshots = [];
let sse;

async function screenshot(name) {
  const { data } = await browser.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(artifactRoot, `${name}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  screenshots.push(file);
  return file;
}

try {
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  const used = new Set();
  providerPort = await reserveHighPort(used); used.add(providerPort);
  basePort = await reserveHighPort(used); used.add(basePort);
  appPort = await reserveHighPort(used); used.add(appPort);
  const seeded = await writeSeedSessions();
  report.environment = {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    sandbox, home, cwd, providerPort, basePort, appPort,
    chromium: process.env.CHROME_BIN || '/usr/bin/chromium',
    forbiddenPortsUsed: [providerPort, basePort, appPort].some((port) => port === 7331 || port === 7321),
  };

  await writeFile(path.join(home, 'settled.json'), '{}\n');
  await writeFile(path.join(home, 'seen.json'), '{}\n');
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-deleg', name: 'Delegation Fake', contextWindow: 4096, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-deleg',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  providerLogStream = await open(path.join(artifactRoot, 'provider-requests.jsonl'), 'w');
  providerServer = await startFakeProvider(providerRequests, providerLogStream);

  baseLog = await open(path.join(artifactRoot, 'sandbox-base.log'), 'w');
  appLog = await open(path.join(artifactRoot, 'sandbox-app.log'), 'w');
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
      SOPHO_MAX_HOT: '8',
      SOPHO_NOTIFY_QUIET_MS: '1500',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  appChild = spawn(process.execPath, [appEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_APP_HOST: '127.0.0.1',
      SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1',
      SOPHO_UPSTREAM_PORT: String(basePort),
      SOPHO_WEB_ROOT: path.join(sourceRoot, 'web'),
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/host`, { headers: { accept: 'application/json' } }).catch(() => null);
    return response?.ok ? response : null;
  }, 'A+B did not become ready');
  print('sandbox', report.environment);
  // 对照组：同一份历史**不带** `?after=` 的整份字节数（用来说明开播那次增量有多小）。
  const fullMessages = await api(`/sessions/${seeded.parentId}/messages`);
  report.fullMessagesBytes = Buffer.byteLength(fullMessages.body);
  print('fullMessagesBytes', report.fullMessagesBytes);

  // ── 真 Chromium ────────────────────────────────────────────────────────────
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  const debugPort = await reservePort();
  chromium = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank',
  ], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'Chromium remote debugger did not start');
  report.environment.browser = version.Browser;
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.once('Page.loadEventFired');
  // 深链：地址栏带完整 uuid ⇒ 页面一就绪就选中父会话（I-53）。
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/#${seeded.parentId}` });
  await loaded;
  await waitFor(async () => {
    const value = await evaluate(`document.querySelector('#messages .message') !== null`);
    return value === true;
  }, 'parent history did not render');

  async function evaluate(expression) {
    const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
    return result.result.value;
  }

  await evaluate(PAGE_PROBE);
  await screenshot('01-before-push');

  // 独立 SSE（Node 侧）先连上并定零；页内探针也定零。
  sse = openSse(`/sessions/${seeded.parentId}/events`, sseEvents);
  await sse.connected;
  await sleep(150); // 让初连的 session.snapshot + 那次正文重拉跑完，别把初连帧算进本次窗口
  const beforeCount = sseEvents.length;
  const t0 = performance.now();
  sse.markStart();
  await evaluate('window.__ord.start()');
  const pushAt = Date.now();
  const pushed = await api(`/sessions/${seeded.childId}/push`, { method: 'POST', body: { text: DELEGATION_TEXT } });
  report.push = { statusCode: pushed.statusCode, body: pushed.value, at: pushAt };
  print('push', { statusCode: pushed.statusCode, parentSessionId: pushed.value?.parentSessionId });

  // 等这一轮结束（settled + 收尾重拉）。
  await waitFor(async () => {
    const value = await evaluate('window.__ord.delta !== null');
    return value === true;
  }, 'no streaming delta arrived');
  const marksAtDelta = await evaluate('({ aside: window.__ord.aside, live: window.__ord.live, delta: window.__ord.delta, inserts: window.__ord.inserts, removes: window.__ord.removes, bubbles: window.__ord.ticks.at(-1)?.bubbles ?? null })');
  await screenshot('02-first-delta');
  await waitFor(async () => {
    const value = await evaluate('window.__ord.finalOrder().bodyIndex >= 0 && document.querySelectorAll("#messages .live-message").length === 0');
    return value === true;
  }, 'turn did not finish / live block never handed off', 20_000);
  const order = await evaluate('window.__ord.finalOrder()');
  const finalAsideCount = await evaluate('window.__ord.asideCount');
  const ticks = await evaluate('window.__ord.ticks');
  const fetches = await evaluate('window.__ord.fetches');
  await screenshot('03-final');
  const wallMs = performance.now() - t0;
  sse.close();

  const asideFinal = ticks.find((tick) => tick.aside)?.at ?? null;
  const mutations = await evaluate('window.__ord.mutations');
  const marks = { ...marksAtDelta, asideFinal, finalAsideCount, ticks, fetches, mutations, order, wallMs: Number(wallMs.toFixed(1)) };
  print('marks', marks);
  report.marks = marks;

  // ── 服务端事实：JSONL 行序 ─────────────────────────────────────────────────
  const lines = (await readFile(seeded.parentPath, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  const entries = lines.map((line, index) => {
    const entry = JSON.parse(line);
    const role = entry.type === 'message' ? entry.message?.role : null;
    const text = entry.type === 'custom_message' ? entry.content : role ? JSON.stringify(entry.message?.content ?? '').slice(0, 60) : '';
    return { index, id: entry.id ?? null, type: entry.type, customType: entry.customType ?? null, role, text: typeof text === 'string' ? text.slice(0, 80) : String(text).slice(0, 80) };
  });
  report.jsonl = entries;
  await writeFile(path.join(artifactRoot, 'jsonl-order.json'), `${JSON.stringify(entries, null, 2)}\n`);
  await writeFile(path.join(artifactRoot, 'sse-events.json'), `${JSON.stringify(sseEvents.slice(beforeCount), null, 2)}\n`);
  await writeFile(path.join(artifactRoot, 'page-marks.json'), `${JSON.stringify(marks, null, 2)}\n`);
  await writeFile(path.join(artifactRoot, 'timeline.json'), `${JSON.stringify({ pushAt, marks, sse: sseEvents.slice(beforeCount).map((item) => ({ at: item.at === null ? null : Number(item.at.toFixed(1)), event: item.event })), jsonl: entries, screenshots }, null, 2)}\n`);

  const delegationIndex = entries.findIndex((entry) => entry.customType === 'sopho.delegation');
  const replyIndex = entries.findIndex((entry) => entry.role === 'assistant' && entry.text.includes('第一段流式正文'));
  print('jsonl', { delegationIndex, replyIndex, delegationLine: entries[delegationIndex], replyLine: entries[replyIndex] });
  print('sse', sseEvents.slice(beforeCount).map((item) => `${item.event}@${item.at === null ? '?' : item.at.toFixed(0)}ms`).join(' → '));

  if (assertMode) {
    check('A1 JSONL：sopho.delegation 那条 custom_message 排在 assistant 正文之前',
      delegationIndex > 0 && replyIndex > delegationIndex,
      `delegationIndex=${delegationIndex}, replyIndex=${replyIndex}`);
    check('A2 代理消息块出现过（aside.extra-message[data-custom-type=sopho.delegation]）',
      marks.aside !== null && marks.aside !== undefined,
      `aside=${marks.aside}`);
    check('A3 代理消息块出现在第一帧流式正文之前（asideAt ≤ firstDeltaAt）',
      marks.aside !== null && marks.delta !== null && marks.aside <= marks.delta,
      `asideAt(first seen by final)=${marks.asideFinal}ms, liveAt=${marks.live}ms, firstDeltaAt=${marks.delta}ms`);
    // A5/A6 是**代价**护栏（红态下这两条不判别，因为红态压根没拉）：开播这一帧的重拉必须是
    // 尾部增量、不许把正文整块重画 —— 否则就把「先出代理消息」换来每次开轮的整屏重建。
    const preDeltaFetches = marks.fetches.filter((item) => item.at !== null && item.at <= marks.delta);
    const preDelta = marks.mutations.filter((item) => item.at <= marks.delta);
    // 只关心**正文/扩展消息**节点（kind=message / extra）：直播块（kind=live）与「思考中…」占位
    // 在开播那一帧本来就会被重建，那是既有设计，不是这次改动带来的重建。
    const removedHistory = preDelta.flatMap((item) => item.removed).filter((desc) => desc.includes('[message]') || desc.includes('[extra]'));
    const addedBodies = preDelta.flatMap((item) => item.added).filter((desc) => desc.includes('[message]'));
    const addedExtras = preDelta.flatMap((item) => item.added).filter((desc) => desc.includes('[extra]'));
    check('A5 开播那一帧的 aside 是**纯 append**（正文一个节点都没被摘掉、也没重画）',
      removedHistory.length === 0 && addedBodies.length === 0 && addedExtras.length === 1,
      `removed=${JSON.stringify(removedHistory)}, added消息=${JSON.stringify(addedBodies)}, added扩展=${JSON.stringify(addedExtras)}`);
    check('A6 开播这一帧的正文重拉走的是尾部增量（带 ?after= 游标）',
      preDeltaFetches.length >= 1 && preDeltaFetches.every((item) => item.url.includes('after=')),
      `fetches=${JSON.stringify(preDeltaFetches)}`);
    check('A7 收尾后 #messages 里恰好一条 sopho.delegation aside（不重复）',
      marks.finalAsideCount === 1,
      `finalAsideCount=${marks.finalAsideCount}`);
    check('A4 收尾后 DOM 里 aside 仍在那条 assistant 正文之前',
      order.asideIndex >= 0 && order.bodyIndex >= 0 && order.asideIndex < order.bodyIndex,
      `asideIndex=${order.asideIndex}, bodyIndex=${order.bodyIndex}, order=${JSON.stringify(order.kinds)}`);
    assert.equal(pageProblems.length, 0, `page problems: ${pageProblems.join('; ')}`);
  }
  process.stdout.write(`checks=${checks}\n`);
} catch (error) {
  primaryError = error;
  report.error = String(error?.stack || error);
  await writeFile(path.join(artifactRoot, 'error.txt'), `${report.error}\n`).catch(() => {});
} finally {
  await cleanupStep(problems, 'quiesce chromium', () => quiesceCdpPage(browser));
  await cleanupStep(problems, 'close browser cdp', () => browser?.close());
  if (chromium) await cleanupStep(problems, 'stop chromium', () => { chromium.kill('SIGTERM'); });
  await cleanupStep(problems, 'stop app (B)', () => stopSpawnedListener(appChild, appPort, appEntry));
  await cleanupStep(problems, 'stop base (A)', () => stopSpawnedListener(baseChild, basePort, baseEntry));
  // `close()` 只等新连接不再来，不等已有连接结束 —— pi 对 provider 的 keep-alive 还在时它会永远挂着。
  await cleanupStep(problems, 'close provider', () => new Promise((resolve) => {
    if (!providerServer) return resolve();
    providerServer.closeAllConnections?.();
    providerServer.close(() => resolve());
    setTimeout(resolve, 1000).unref?.();
  }));
 
  await cleanupStep(problems, 'close logs', async () => { await baseLog?.close(); await appLog?.close(); await providerLogStream?.close(); });
  await removeSandbox(sandbox, problems);
  try { await writeFile(path.join(artifactRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); } catch (error) { problems.push(`write report: ${error.message}`); }

  finishCleanup(primaryError, problems);
}
