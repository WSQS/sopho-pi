#!/usr/bin/env node
// retry-visible-frontend.mjs —— M-36「上游自动重试在网页里看得见」的**前端门**（真 Chromium）。
//
// 背景（`docs/tui-parity.md` M-36）：服务端早把 pi 的 `auto_retry_start/end` 如实投影成
// `session.retry_start/retry_end`（`server/base-logic.mjs:1683-1700`，带 attempt/maxAttempts/delayMs/
// errorMessage），也有门 `npm run test:sseretry` 守着。但修前 **网页侧一条都没接**
//（`grep -rn "retry_start\|session.retry" web/` → 0 命中）⇒ 用户看到的只是「卡住了」。
//
// 这条门用**仓库既有那套假 provider**（`test/sse-retry-visibility.mjs` 里那套：第一次请求把上游
// socket 掐断 ⇒ pi 记成可重试类，之后正常回正文）驱动**真服务器**（A `server/base.mjs` + B
// `server/app.mjs` + 假上游）⇒ **真 Chromium** 真开页面，逐帧采样 I-12 那一行。断言：
//   ① 重试窗口里那一行**确实出现「正在重试」**，且属于**状态层**（`data-layer=hint`，不是 5s 就退场的
//      info 回执）—— 计数是 pi 给的真值 1/2、2/2；
//   ② **第一帧正文 delta 到达后交还状态层**（重试文案消失）—— 用页面**自己收到的 SSE**做时间轴
//      （页面里包一层 `EventSource.prototype.addEventListener`，事件 t 与逐帧采样同一个 `performance.now()`）；
//   ③ 全程**逐帧布局位移 Δpx = 0**（notice / composer / 正文区 / header 的 top、height）；
//   ④ 重试**最终失败**时**错误优先**：行上留的是 `上游错误：…`（error 覆盖层），不被状态层盖掉；
//   ⑤ 零新增元素：`#notice` 的 `childElementCount` 恒为 0，且重试文案单行、不横向溢出。
//
// 反面对照（red→green 的另一半）：`SOPHO_HINT_WEB=<修前的 web/>`（照 `test/hint-line.mjs` 的同一套办法）
// —— 同一把尺子量修前的 `web/`，①②④ 必红。
//
// 纪律：只起**自己 spawn** 的 A/B/假上游/Chromium，高位随机端口（**不碰 7331/7321**）；
// 临时 ASSIST_HOME + 临时 Chromium profile；**真 profile 只读**；**不 pkill**（只杀自己 spawn 的进程）。
//
// 跑法：CHROME_BIN=/usr/bin/chromium node test/retry-visible-frontend.mjs
//       SOPHO_HINT_WEB=/tmp/m36-web-before CHROME_BIN=/usr/bin/chromium node test/retry-visible-frontend.mjs

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 修前对照：把 B 伺服出去的 `web/` 换成另一份（同一把尺子量两个版本）。
const webRoot = process.env.SOPHO_HINT_WEB ? path.resolve(process.env.SOPHO_HINT_WEB) : path.join(root, 'web');
const artifactRoot = process.env.SOPHO_RETRY_ARTIFACT || path.join(os.tmpdir(), 'sopho-retry-visible');

// 这两条文案是**另一份抄写**（`web/app.js` 里抄错了，门就该红）。
const RETRY_PREFIX = '上游错误，正在重试';
const retryText = (attempt, maxAttempts) => `${RETRY_PREFIX} ${attempt}/${maxAttempts}…`;
// 观测窗口：baseDelayMs 放大到 1500ms（第一次重试等 1500、第二次 3000），让逐帧采样抓得稳；
// 计数仍是 pi 的真值（maxAttempts=2）。服务端门 `test:sseretry` 已钉死 baseDelayMs=500 的真值。
const BASE_DELAY_MS = 1500;

let serverChildren = [];
let provider;
let chromium;
let browser;
let basePort;
let appPort;
let sandbox;
let baseLog;
let appLog;

const checkpoints = { pass: [], fail: [] };
function check(label, ok, detail) {
  (ok ? checkpoints.pass : checkpoints.fail).push(`${label}：${detail}`);
  process.stdout.write(`${ok ? '✓' : '✗'} ${label} —— ${detail}\n`);
}
function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const listener = net.createServer();
      listener.once('error', () => resolve(false));
      listener.listen(candidate, '127.0.0.1', () => listener.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

async function waitFor(operation, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(25);
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)}`);
}

// ── 假 provider（同 `test/sse-retry-visibility.mjs`）：按最后一条 user 文案决定行为 ────────────────
// `RETRY_THEN_OK`：第一次掐断、第二次正常回正文；`FAIL_ALWAYS`：每次都掐断 ⇒ 两次重试后最终失败。
function providerChunk(delta, finishReason = null) {
  return {
    id: `chatcmpl-${finishReason ?? 'delta'}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-retry',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part?.text ?? '').join(' ');
  }
  return '';
}
async function startProvider() {
  const seen = new Set();
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const part of request) raw += part;
    requests += 1;
    const marker = lastUserText(JSON.parse(raw));
    const breakNow = marker.includes('FAIL_ALWAYS') || (marker.includes('RETRY_THEN_OK') && !seen.has(marker));
    if (marker.includes('RETRY_THEN_OK')) seen.add(marker);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    if (breakNow) {
      // 上游中途断流：pi 记成 `stopReason:'error'` + `errorMessage` 命中可重试类
      //（`dist/utils/retry.js` 的 RETRYABLE_PROVIDER_ERROR_PATTERN）。不发任何正文
      // ⇒ 「第一帧正文 delta」与「retry_start」在时间轴上分得开。
      setTimeout(() => response.socket?.destroy(new Error('scripted upstream break')), 20).unref();
      return;
    }
    response.write(`data: ${JSON.stringify(providerChunk({ role: 'assistant', content: 'retry-succeeded' }))}\n\n`);
    response.write(`data: ${JSON.stringify(providerChunk(null, 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(providerPort, '127.0.0.1', resolve); });
  return { server, get requests() { return requests; } };
}

// ── Chromium / CDP ────────────────────────────────────────────────────────────────────────────
function cdp(wsUrl, pageProblems) {
  const socket = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
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
        const onMessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.method !== method) return;
          socket.removeEventListener('message', onMessage);
          resolve(message.params);
        };
        socket.addEventListener('message', onMessage);
      });
    },
    close() { socket.close(); },
  };
}
async function evaluate(expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
  return result.result.value;
}
async function frames(count = 3) {
  await evaluate(`new Promise((resolve)=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
}
async function shot(name) {
  const image = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const file = path.join(artifactRoot, `${name}.png`);
  await writeFile(file, Buffer.from(image.data, 'base64'));
  return file;
}

const INSTRUMENT = `(() => {
  const H = window.__m36 = { frames: [], marks: [], sse: [], sampling: false };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);
  const box = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { top: num(r.top), height: num(r.height), left: num(r.left), width: num(r.width) }; };
  // 页面**真的收到**的 SSE：包一层 EventSource，对每个连接预挂一组捕获监听（与 app 自己有没有订阅无关 ——
  // 修前 app 根本没订阅 retry_* ，但事件本来就到了浏览器；这条门要能同时看到两件事）。
  try {
    const Native = window.EventSource;
    const RECORDED = ['session.snapshot', 'session.start', 'session.delta', 'session.end', 'session.settled', 'session.retry_start', 'session.retry_end', 'session.error'];
    class RecordingEventSource extends Native {
      constructor(url, config) {
        super(url, config);
        for (const type of RECORDED) {
          Native.prototype.addEventListener.call(this, type, (event) => {
            try { H.sse.push({ t: num(performance.now()), name: type, data: typeof event.data === 'string' ? event.data : null }); } catch {}
          });
        }
      }
    }
    window.EventSource = RecordingEventSource;
  } catch {}
  const sample = () => {
    const notice = document.querySelector('#notice');
    const composer = document.querySelector('#composer');
    const pane = document.querySelector('.messages-pane');
    const header = document.querySelector('main > header');
    if (!notice || !composer) return null;
    return {
      t: num(performance.now()),
      text: notice.textContent,
      layer: notice.dataset.layer ?? null,
      level: notice.dataset.level ?? null,
      notice: box(notice), composer: box(composer), pane: box(pane), header: box(header),
    };
  };
  H.now = () => num(performance.now());
  H.start = () => { H.frames = []; H.marks = []; H.sampling = true; const step = () => { if (!H.sampling) return; const value = sample(); if (value) H.frames.push(value); requestAnimationFrame(step); }; requestAnimationFrame(step); };
  H.mark = (label) => { H.marks.push({ label, t: num(performance.now()), index: H.frames.length }); return true; };
  H.collect = () => { H.sampling = false; return H.frames; };
})();`;

/** 行上事实的行内探针（复用 `test/hint-line.mjs` 的同一条判据：单行 / 不溢出 / 零新增元素）。 */
const PROBE = `(() => {
  const node = document.querySelector('#notice');
  const style = getComputedStyle(node);
  const box = node.getBoundingClientRect();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts = []; let cursor;
  while ((cursor = walker.nextNode())) if (cursor.data.trim()) texts.push(cursor);
  let lines = 0;
  if (texts.length) {
    const range = document.createRange();
    range.setStart(texts[0], 0);
    range.setEnd(texts[texts.length - 1], texts[texts.length - 1].data.length);
    lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.y))).size;
  }
  return {
    text: node.textContent,
    layer: node.dataset.layer ?? null,
    level: node.dataset.level ?? null,
    color: node.style.color,
    whiteSpace: style.whiteSpace,
    height: Math.round(box.height * 100) / 100,
    lines,
    childElementCount: node.childElementCount,
    overflowX: Math.round((document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth) * 100) / 100,
  };
})()`;
const probe = () => evaluate(PROBE);

let providerPort;

let primaryError;
try {
  await mkdir(artifactRoot, { recursive: true });
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-retry-visible-'));
  const home = path.join(sandbox, 'home');
  const cwd = path.join(sandbox, 'cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  providerPort = await reserveHighPort();
  basePort = await reserveHighPort(new Set([providerPort]));
  appPort = await reserveHighPort(new Set([providerPort, basePort]));

  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions', apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-retry', name: 'Fake Retry', contextWindow: 4096, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake', defaultModel: 'fake-retry', defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    // 受控重试：maxRetries=2（attempt 1/2、2/2）、backoff 放大到 1500ms 便于逐帧观测；
    // provider 层不许自己重试（否则「第一帧正文 delta」的时刻会失真）。
    retry: { enabled: true, maxRetries: 2, baseDelayMs: BASE_DELAY_MS, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  provider = await startProvider();
  baseLog = await open(path.join(sandbox, 'base.log'), 'w');
  appLog = await open(path.join(sandbox, 'app.log'), 'w');
  const base = spawn(process.execPath, [path.join(root, 'server', 'base.mjs')], {
    cwd: root,
    env: {
      ...process.env, HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'),
      PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: cwd, SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  const app = spawn(process.execPath, [path.join(root, 'server', 'app.mjs')], {
    cwd: root,
    env: {
      ...process.env, HOME: home, ASSIST_HOME: home,
      SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(basePort), SOPHO_WEB_ROOT: webRoot,
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  serverChildren = [app, base];

  const api = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value; try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { statusCode: response.status, value };
  };

  await waitFor(async () => (await api('/host')).statusCode === 200, 'sandbox A+B did not become ready', 30_000);
  const createdA = await api('/sessions', { method: 'POST', body: { cwd, name: 'M-36 重试后成功' } });
  const createdB = await api('/sessions', { method: 'POST', body: { cwd, name: 'M-36 重试后失败' } });
  if (createdA.statusCode !== 201 || createdB.statusCode !== 201) throw new Error(`create failed: A=${createdA.statusCode} B=${createdB.statusCode}`);
  const sessionA = createdA.value.id;
  const sessionB = createdB.value.id;
  print('sandbox', { home, cwd, providerPort, basePort, appPort, webRoot, baseDelayMs: BASE_DELAY_MS, forbiddenPortsUsed: false });

  // ── 真 Chromium ────────────────────────────────────────────────────────
  const debugPort = await reserveHighPort(new Set([providerPort, basePort, appPort]));
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank',
  ], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'Chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const pageProblems = [];
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await loaded;
  await waitFor(() => evaluate(`!!document.querySelector('#notice') && !!window.__m36`), 'page did not load');
  await frames(4);

  const openSession = async (id) => {
    await waitFor(() => evaluate(`!!document.querySelector('[data-session-id="${id}"] .tree-select')`), `tree row ${id} not rendered`);
    await evaluate(`document.querySelector('[data-session-id="${id}"] .tree-select').click()`);
    await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false && document.querySelector('#messages').dataset.renderComplete === 'true'`), `session ${id} did not open`);
    await frames(4);
  };
  const sseTimes = (name) => evaluate(`window.__m36.sse.filter((e) => e.name === ${JSON.stringify(name)}).map((e) => e.t)`);
  const sseAfter = async (name, after) => (await waitFor(async () => {
    const list = await sseTimes(name);
    const hit = list.find((t) => t > after);
    return hit ?? null;
  }, `no ${name} after ${after}`, 30_000));
  const sseEvent = (name) => evaluate(`window.__m36.sse.filter((e) => e.name === ${JSON.stringify(name)}).map((e) => ({ t: e.t, data: e.data }))`);

  /** 一边等终局、一边把「状态层出现重试文案」的那一刻连同整行探针记下来（去重）；
   *  每个新出现的重试文案都拍一张图当原始证据。 */
  async function observeUntil(predicate, label, timeoutMs = 30_000, shotPrefix = 'retry-window') {
    const captured = new Map();
    const shots = [];
    const deadline = Date.now() + timeoutMs;
    let done = false;
    while (Date.now() < deadline) {
      const p = await probe().catch(() => null);
      if (p && p.layer === 'hint' && p.text.includes(RETRY_PREFIX) && !captured.has(p.text)) {
        captured.set(p.text, p);
        shots.push(await shot(`${shotPrefix}-${captured.size}-${p.text.replace(/[^0-9]/g, '') || 'x'}`).catch(() => null));
      }
      if (await predicate().catch(() => false)) { done = true; break; }
      await sleep(30);
    }
    if (!done) check(label, false, `观察窗内未等到终局（${label}）`);
    return { captured, shots };
  }

  await evaluate(`window.__m36.start()`);
  await evaluate(`window.__m36.mark('boot')`);

  // ── 场景 A：一次重试后成功 ────────────────────────────────────────────────
  await openSession(sessionA);
  await evaluate(`window.__m36.mark('A-open')`);
  const sendA = await evaluate(`window.__m36.now()`);
  const postedA = await api(`/sessions/${sessionA}/message`, { method: 'POST', body: { text: 'RETRY_THEN_OK 触发一次脚本化的上游断流' } });
  print('scenario A POST /message', { statusCode: postedA.statusCode });
  // 观察从 **POST 之后立刻** 开始（重试窗口只有 1500ms，晚一步就错过）。
  const capturedAResult = await observeUntil(async () => {
    const list = await sseTimes('session.settled');
    return list.some((t) => t > sendA);
  }, 'A：观察窗内未等到 session.settled', 30_000, 'm36-A');
  const capturedA = capturedAResult.captured;
  await frames(5); // 让 delta 之后也有几帧可量（验证「交还」）。
  await evaluate(`window.__m36.mark('A-done')`);
  const shotA = await shot('m36-1-retry-then-ok-1200x760');

  // ── 场景 B：两次重试后最终失败 ────────────────────────────────────────────
  await openSession(sessionB);
  await evaluate(`window.__m36.mark('B-open')`);
  const sendB = await evaluate(`window.__m36.now()`);
  const postedB = await api(`/sessions/${sessionB}/message`, { method: 'POST', body: { text: 'FAIL_ALWAYS 让上游一直断' } });
  print('scenario B POST /message', { statusCode: postedB.statusCode });
  const capturedBResult = await observeUntil(async () => {
    const list = await sseTimes('session.settled');
    return list.some((t) => t > sendB);
  }, 'B：观察窗内未等到 session.settled', 40_000, 'm36-B');
  const capturedB = capturedBResult.captured;
  await frames(6);
  await evaluate(`window.__m36.mark('B-done')`);
  const finalProbe = await probe();
  const shotB = await shot('m36-2-retry-exhausted-1200x760');

  const allFrames = await evaluate(`window.__m36.collect()`);
  const marks = await evaluate(`window.__m36.marks`);
  const sseLog = await evaluate(`window.__m36.sse.map((e) => ({ t: e.t, name: e.name }))`);
  print('页面收到的 SSE 事件（名字 + t）', sseLog);
  print('SSE 原始载荷（session.retry_start 全部）', await sseEvent('session.retry_start'));
  print('SSE 原始载荷（session.retry_end 全部）', await sseEvent('session.retry_end'));
  print('A 窗口捕获到的状态层探针', Object.fromEntries([...capturedA.entries()]));
  print('B 窗口捕获到的状态层探针', Object.fromEntries([...capturedB.entries()]));
  print('重试窗口截图', { a: capturedAResult.shots, b: capturedBResult.shots, settled: [shotA, shotB] });

  // 用**页面自己收到的 SSE** 做时间轴（与逐帧采样同一个 `performance.now()`）。
  const retryStartsA = (await sseTimes('session.retry_start')).filter((t) => t > sendA);
  const retryEndsA = (await sseTimes('session.retry_end')).filter((t) => t > sendA);
  const retryA = retryStartsA[0] ?? null;
  const retryEndA = retryA === null ? null : (retryEndsA.find((t) => t > retryA) ?? null);
  const retryB = (await sseTimes('session.retry_start')).filter((t) => t > sendB).sort((a, b) => a - b);
  const retryEndB = (await sseTimes('session.retry_end')).filter((t) => t > sendB).sort((a, b) => a - b);
  print('时间轴（页面时钟）', { sendA, retryA, retryEndA, sendB, retryB, retryEndB });

  // ── ① 重试窗口里那一行确实出现「正在重试」（状态层） ──────────────────────
  const probeA = capturedA.get(retryText(1, 2));
  check('① A：重试窗口里出现「上游错误，正在重试 1/2…」（状态层）',
    Boolean(probeA) && probeA.layer === 'hint' && probeA.level === 'info',
    probeA ? `text=${JSON.stringify(probeA.text)} layer=${probeA.layer} level=${probeA.level}` : `未捕获；捕获到=[${[...capturedA.keys()].join(' | ')}]`);
  check('⑤ A：重试文案单行、不横向溢出、零新增元素',
    Boolean(probeA) && probeA.lines === 1 && probeA.overflowX <= 0 && probeA.childElementCount === 0 && probeA.height <= 20,
    probeA ? `lines=${probeA.lines} overflowX=${probeA.overflowX} childElementCount=${probeA.childElementCount} height=${probeA.height} color=${JSON.stringify(probeA.color)}` : '未捕获');

  // ── ② 第一帧正文 delta 到达后交还（用页面自己收到的 SSE 做时间轴） ──────────
  const deltaTimes = await evaluate(`window.__m36.sse.filter((e) => e.name === 'session.delta' && e.data && e.data.includes('"channel":"text"')).map((e) => e.t)`);
  const firstDeltaA = retryA === null ? null : (deltaTimes.find((t) => t > retryA) ?? null);
  const afterDelta = firstDeltaA === null ? [] : allFrames.filter((frame) => frame.t > firstDeltaA && frame.t < (marks.find((m) => m.label === 'A-done')?.t ?? Infinity));
  check('② A：第一帧正文 delta 之后，行上不再有「正在重试」（交还状态层）',
    Boolean(firstDeltaA) && afterDelta.length > 0 && afterDelta.every((frame) => !frame.text.includes(RETRY_PREFIX)),
    `firstDelta t=${firstDeltaA} 之后 ${afterDelta.length} 帧，含重试文案的帧 = ${afterDelta.filter((f) => f.text.includes(RETRY_PREFIX)).length}`);
  check('② A：重试期间「正在重试」确实常驻到 retry_end / 首帧 delta（不是一闪而过）',
    retryA !== null && retryEndA !== null && (retryEndA - retryA) >= BASE_DELAY_MS * 0.5,
    `retry_start→retry_end = ${retryA !== null && retryEndA !== null ? Math.round(retryEndA - retryA) : 'n/a'}ms（baseDelayMs=${BASE_DELAY_MS}）`);

  // ── ④ B：两次重试的计数 + 最终失败时错误优先 ──────────────────────────────
  const probeB1 = capturedB.get(retryText(1, 2));
  const probeB2 = capturedB.get(retryText(2, 2));
  check('④ B：两次重试的计数都对（1/2 → 2/2），且都在状态层',
    Boolean(probeB1) && Boolean(probeB2) && probeB1.layer === 'hint' && probeB2.layer === 'hint',
    `1/2=${probeB1 ? JSON.stringify(probeB1.text) : '未捕获'} 2/2=${probeB2 ? JSON.stringify(probeB2.text) : '未捕获'}`);
  check('④ B：重试最终失败时错误优先（行上留的是上游错误，不是状态层）',
    finalProbe?.layer === 'notice' && finalProbe?.level === 'error' && finalProbe.text.includes('上游错误') && !finalProbe.text.includes(RETRY_PREFIX),
    `text=${JSON.stringify(finalProbe?.text)} layer=${finalProbe?.layer} level=${finalProbe?.level}`);
  check('④ B：页面确实收到两次重试窗口（attempt 1/2 与 2/2）',
    retryB.length === 2 && retryEndB.length === 1,
    `retry_start×${retryB.length} @${JSON.stringify(retryB)}；retry_end×${retryEndB.length} @${JSON.stringify(retryEndB)}`);

  // ── ③ 逐帧布局位移 = 0（按 mark 分段：会话内换状态不得动布局） ───────────────
  const segments = [];
  for (let index = 0; index < marks.length - 1; index += 1) {
    segments.push({ label: `${marks[index].label}→${marks[index + 1].label}`, from: marks[index].index, to: marks[index + 1].index });
  }
  const boxKeys = ['notice', 'composer', 'pane', 'header'];
  const fieldKeys = ['top', 'height'];
  const drift = {};
  for (const segment of segments) {
    const slice = allFrames.slice(segment.from, segment.to);
    const per = {};
    for (const node of boxKeys) {
      for (const field of fieldKeys) {
        let max = 0; let detail = 'none';
        for (let index = 1; index < slice.length; index += 1) {
          const before = slice[index - 1][node]?.[field];
          const after = slice[index][node]?.[field];
          if (typeof before !== 'number' || typeof after !== 'number') continue;
          const delta = Math.round((after - before) * 100) / 100;
          if (Math.abs(delta) > max) { max = Math.abs(delta); detail = `${node}.${field} Δ=${delta}px @frame${index}（${JSON.stringify(slice[index - 1].text)} → ${JSON.stringify(slice[index].text)}）`; }
        }
        per[`${node}.${field}`] = { maxPx: max, detail };
      }
    }
    drift[segment.label] = { frames: slice.length, per };
  }
  const retryTextsInFrames = [...new Set(allFrames.map((frame) => frame.text))].filter((text) => text.includes(RETRY_PREFIX));
  const allZero = Object.values(drift).every((entry) => Object.values(entry.per).every((value) => value.maxPx === 0));
  check('③ 逐帧布局位移 Δpx = 0（notice / composer / 正文区 / header）',
    allFrames.length > 120 && allZero,
    `${allFrames.length} 帧；分段=${Object.entries(drift).map(([label, entry]) => `${label}(${entry.frames}帧)`).join(' ')}；最大位移=${JSON.stringify(Object.fromEntries(Object.entries(drift).map(([label, entry]) => [label, Object.fromEntries(Object.entries(entry.per).map(([key, value]) => [key, value.maxPx]))])))}`);
  print('逐帧位移明细', drift);
  print('逐帧出现过的重试文案（去重）', retryTextsInFrames);

  check('⑥ 页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));
  print('screenshots', { a: shotA, b: shotB, artifactRoot });
  print('chromium', { product: version.Browser, executable: chrome, forbiddenPortsUsed: false });
  print('checks', checkpoints.pass.length + checkpoints.fail.length);
  if (checkpoints.fail.length) throw new Error(`retry visible frontend gate failed:\n${checkpoints.fail.join('\n')}`);
  print('RESULT', `M-36 frontend retry visibility PASS（重试窗口可见「正在重试 1/2…」状态层 + 首帧 delta 交还 + 逐帧位移 0px + 最终失败错误优先）`);
  primaryError = null;
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'close browser', async () => { browser?.close(); });
  if (chromium && chromium.exitCode === null) {
    await cleanupStep(cleanupProblems, 'stop chromium', () => {
      chromium.kill('SIGTERM');
      return new Promise((resolve) => chromium.once('exit', resolve));
    });
  }
  for (const child of serverChildren) {
    if (child && child.exitCode === null) {
      await cleanupStep(cleanupProblems, `stop child ${child.pid}`, () => {
        child.kill('SIGTERM');
        return new Promise((resolve) => child.once('exit', resolve));
      });
    }
  }
  await cleanupStep(cleanupProblems, 'close provider', async () => {
    if (provider?.server) { provider.server.closeAllConnections(); await new Promise((resolve) => provider.server.close(resolve)); }
  });
  await cleanupStep(cleanupProblems, 'close logs', async () => { await baseLog?.close(); await appLog?.close(); });
  if (sandbox) await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
