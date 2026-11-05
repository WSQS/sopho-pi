#!/usr/bin/env node
// sse-retry-visibility.mjs —— M-36「自动重试可见」的门（`docs/tui-parity.md` M-36）。
//
// 缺口形状：服务端修前只知道「正在重试」（`server/base-logic.mjs` 把 `auto_retry_*` 记成
// `setBusy('retry')`，前端只用它启用「停止」按钮）—— SSR/观察面里**一个字都没有**，
// 用户看到的是「卡住了」。pi 其实把 attempt / maxAttempts / delayMs / errorMessage 都给了
// （`dist/core/agent-session.js:2299-2303`），这是纯转发。
//
// 做法：**受控重试**。假 provider 第一次请求写半截 SSE 然后把上游 socket 掐断
// （pi 记成 `stopReason:'error'` + `errorMessage:'terminated'`，属于可重试类，
// `dist/utils/retry.js` 的 RETRYABLE_PROVIDER_ERROR_PATTERN 里有 `terminated`），
// 第二次正常回一条文本。`retry.baseDelayMs=500` 让 backoff 窗口足够观测。
//
// 断言（逐字段 + 诚实性）：
//   · `session.retry_start` 的 attempt/maxAttempts/delayMs 等于 pi settings 的真值（1 / 2 / 500），
//     errorMessage 非空字符串；事件带 emit 包装的 seq/at/type/sessionId。
//   · 重试期间 `runtime.isRetrying === true`（后端确实把它当 busy）。
//   · `session.retry_end` 的 success=true、attempt=1、finalError=null。
//   · provider 只被打了 2 次（不是 3 次、也不是 1 次）——证明「一次重试」是事实而非话术。
//
// 跑法：npm run test:sseretry
// 铁律：只起**自己 spawn** 的 A、只按那个 pid 停；高位随机端口；**不碰真 profile**；**不 pkill**。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'v22-sse-retry-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 'base.log');
let provider;
let base;
let baseLog;
let providerPort;
let basePort;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value, body: text };
}

async function poll(label, operation, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) { last = error; }
    await sleep(20);
  }
  throw new Error(`${label} timed out; last=${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)}`);
}

/** 极简 SSE 读取器：只收 event/data，够本门用。 */
function openSse(pathname) {
  const events = [];
  const waiters = new Set();
  let response;
  let buffer = '';
  let currentEvent = 'message';
  let currentData = [];
  const request = http.request({ host: '127.0.0.1', port: basePort, path: pathname, headers: { accept: 'text/event-stream' } });
  const connected = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (incoming) => {
      response = incoming;
      assert.equal(incoming.statusCode, 200);
      assert.match(String(incoming.headers['content-type']), /^text\/event-stream/);
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        buffer += chunk;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line === '') {
            if (currentData.length > 0) {
              const raw = currentData.join('\n');
              let data;
              try { data = JSON.parse(raw); } catch { data = raw; }
              events.push({ event: currentEvent, data });
              for (const waiter of [...waiters]) waiter();
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
    events,
    connected,
    waitFor(predicate, timeoutMs = 20_000) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`SSE wait timed out: ${JSON.stringify(events.map((e) => e.event))}`)); }, timeoutMs);
        const check = () => {
          const value = events.find(predicate);
          if (!value) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(value);
        };
        waiters.add(check);
      });
    },
    close() {
      response?.destroy();
      request.destroy();
    },
  };
}

function chunk(content, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-retry',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 } } : {}),
  };
}

async function startProvider() {
  let count = 0;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of request) raw += part;
    requests.push(JSON.parse(raw));
    count += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    if (count === 1) {
      // 脚本化的「上游中途断流」：pi 会记成 stopReason='error' + errorMessage 含 'terminated'
      // ⇒ 命中可重试类（dist/utils/retry.js 的 RETRYABLE_PROVIDER_ERROR_PATTERN）。
      response.write(`data: ${JSON.stringify(chunk('before-retry-break'))}\n\n`);
      setTimeout(() => response.socket?.destroy(new Error('scripted upstream break')), 20).unref();
      return;
    }
    response.write(`data: ${JSON.stringify(chunk('retry-succeeded'))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(null, 'stop', true))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, requests, get count() { return count; } };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(8000).then(() => { throw new Error(`pid ${child.pid} did not exit`); }),
  ]);
}

let primaryError;
try {
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  providerPort = await reservePort();
  basePort = await reservePort();
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-retry', name: 'Fake Retry', contextWindow: 4096, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-retry',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    // 受控重试：一次重试、backoff 500ms（够观测 isRetrying），provider 层不许自己重试（否则计数不准）。
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 500, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  provider = await startProvider();
  baseLog = await open(baseLogPath, 'w');
  base = spawn(process.execPath, [path.join(root, 'server', 'base.mjs')], {
    cwd: root,
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
      SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => api('/host'), (response) => response.statusCode === 200, 30_000);
  print('sandbox', { home, cwd, providerPort, basePort, forbiddenPortsUsed: false });

  const created = await api('/sessions', { method: 'POST', body: { cwd } });
  assert.equal(created.statusCode, 201, created.body);
  const sessionId = created.value.id;

  const sse = openSse(`/sessions/${sessionId}/events`);
  await sse.connected;
  const started = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '触发一次脚本化的上游断流' } });
  assert.equal(started.statusCode, 202, started.body);

  const retryStart = await sse.waitFor((event) => event.event === 'session.retry_start');
  // 形状断言：pi 给什么就报什么（attempt/maxAttempts/delayMs 出自 settings，delayMs=baseDelayMs*2^0）。
  assert.deepEqual(
    { attempt: retryStart.data.attempt, maxAttempts: retryStart.data.maxAttempts, delayMs: retryStart.data.delayMs },
    { attempt: 1, maxAttempts: 2, delayMs: 500 },
  );
  assert.equal(typeof retryStart.data.errorMessage, 'string');
  assert.ok(retryStart.data.errorMessage.length > 0, '重试必须带上「为什么重试」的上游错误');
  // emit 包装的字段也在（seq/at/type/sessionId），前端据此排序与归属。
  assert.equal(retryStart.data.type, 'session.retry_start');
  assert.equal(retryStart.data.sessionId, sessionId);
  assert.ok(Number.isInteger(retryStart.data.seq) && typeof retryStart.data.at === 'string');
  print('session.retry_start', retryStart.data);

  // 重试期间后端确实把它当 busy（修前唯一的用途就是启用「停止」按钮；这里证明它同时是可见窗口）。
  const busy = await poll('retrying', () => api(`/sessions/${sessionId}`), (response) => response.value?.runtime?.isRetrying === true, 2000).catch((error) => ({ error: error.message }));
  assert.ok(!busy.error, `重试期间 isRetrying 没有变成 true：${JSON.stringify(busy).slice(0, 300)}`);
  print('isRetrying during backoff', { isRetrying: busy.value.runtime.isRetrying });

  const retryEnd = await sse.waitFor((event) => event.event === 'session.retry_end');
  assert.deepEqual(
    { success: retryEnd.data.success, attempt: retryEnd.data.attempt, finalError: retryEnd.data.finalError },
    { success: true, attempt: 1, finalError: null },
  );
  print('session.retry_end', retryEnd.data);

  const settled = await sse.waitFor((event) => event.event === 'session.end' && String(event.data?.text ?? '').includes('retry-succeeded'));
  assert.equal(settled.data.stopReason, 'stop');

  // 诚实性：真的是「1 次失败 + 1 次重试」——provider 被打的次数就是这个事实的判据。
  assert.equal(provider.requests.length, 2, `provider 被打的次数不对：${provider.requests.length}（应 1 次失败 + 1 次重试）`);
  assert.equal(provider.count, 2);
  sse.close();

  print('RESULT', 'M-36 automatic retry visibility over SSE PASS');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'stop base', async () => { await stopChild(base).catch((error) => print('base cleanup error', error.message)); });
  await cleanupStep(cleanupProblems, 'close provider server', async () => { if (provider?.server) await new Promise((resolve) => provider.server.close(resolve)); });
  await cleanupStep(cleanupProblems, 'close base log', async () => { await baseLog?.close(); });
  await cleanupStep(cleanupProblems, 'base log tail', async () => {
    const log = await readFile(baseLogPath, 'utf8').catch(() => '');
    if (/error/i.test(log) && process.env.SOPHO_SSE_RETRY_SHOW_LOG === '1') print('base log tail', log.slice(-1500));
  });
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}