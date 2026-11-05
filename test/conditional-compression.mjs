#!/usr/bin/env node
// test/conditional-compression.mjs —— 「条件压缩」的契约门（真 A + 真 B + 假 provider）。
//
// 要钉住的三臂（一条都不能少）：
//   ① 回环请求（浏览器打 127.0.0.1:7321）⇒ **无 `content-encoding`**，正文与「现在的字节」逐字节相同；
//   ② 非回环请求（打本机 LAN / ZeroTier 地址）⇒ **有 `content-encoding`**，解码后与回环正文逐字节相同；
//   ③ SSE 端点 ⇒ **无 `content-encoding`**，且**流式仍逐帧 flush**（假 provider 挂住上游时，
//      `session.delta` 必须已经到达客户端 —— 若被压缩/缓冲就不会到）。
//
// 为什么「非回环」必须经 B：worker（逻辑层）的 TCP 对端永远是宿主 A（回环），它看不到浏览器；
// 唯一看得到浏览器的是 B（`server/app.mjs`），B 把对端写进 `x-forwarded-for` 再反代。所以这条门
// 必须连 **B 的 LAN 地址**，不能连 A —— 连 A 是回环，永远不压，那样测不到 ②。
//
// 红线：只起自己 spawn 的 A/B/假 provider，只按 pid 停（`test/harness.mjs`）；高位随机端口
// （绝不用 7331/7321）；日志写本次沙箱；**不 pkill**；不碰真实 profile。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-compression-'));
const home = path.join(sandbox, 'home');
const workspace = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 'compression-base.log');
const appLogPath = path.join(sandbox, 'compression-app.log');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const appEntry = path.join(sourceRoot, 'server', 'app.mjs');

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
let checks = 0;
function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}
const big = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;

let providerServer;
let baseChild;
let appChild;
let baseLog;
let appLog;
let providerPort;
let basePort;
let appPort;

function reserveHighPort(excluded = new Set(), host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const next = () => {
      if (attempt >= 200) return reject(new Error('could not reserve a high port'));
      attempt += 1;
      const candidate = 44000 + Math.floor(Math.random() * 15000);
      if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) return next();
      const server = net.createServer();
      server.once('error', () => next());
      server.listen(candidate, host, () => {
        server.close(() => resolve(candidate));
      });
    };
    next();
  });
}

function nonLoopbackAddress() {
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue;
      if (entry.family !== 'IPv4') continue;
      if (/^169\.254\./.test(entry.address)) continue; // link-local
      return { name, address: entry.address };
    }
  }
  return null;
}

/** 一次原始 HTTP 请求：收全 Buffer（不截断），带头与耗时。 */
function rawRequest(host, port, pathname, { method = 'GET', headers = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({ host, port, method, path: pathname, headers: { connection: 'close', ...headers } });
    const timer = setTimeout(() => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, elapsedMs: Date.now() - started });
    };
    req.once('error', (error) => finish({ error: error.message, statusCode: 0, headers: {}, buffer: Buffer.alloc(0) }));
    req.once('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', (error) => finish({ error: error.message, statusCode: response.statusCode ?? 0, headers: response.headers, buffer: Buffer.concat(chunks) }));
      response.once('end', () => finish({ statusCode: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks) }));
    });
    req.end();
  });
}

function postJson(host, port, pathname, value, { timeoutMs = 20_000 } = {}) {
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, method: 'POST', path: pathname, headers: { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => request.destroy(new Error(`POST ${pathname} timed out after ${timeoutMs}ms`)), timeoutMs);
    request.once('error', (error) => { clearTimeout(timer); reject(error); });
    request.once('close', () => clearTimeout(timer));
    request.end(body);
  });
}

function decode(body, encoding) {
  if (encoding === 'br') return brotliDecompressSync(body);
  if (encoding === 'gzip') return gunzipSync(body);
  return body;
}

function chunk(content) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-compression',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: null }],
  };
}

function createPlan(text) {
  let startedResolve;
  let releaseResolve;
  const plan = {
    text,
    mode: 'normal',
    releasedNow: false,
    started: new Promise((resolve) => { startedResolve = resolve; }),
    release: () => { plan.releasedNow = true; releaseResolve?.(); },
    released: new Promise((resolve) => { releaseResolve = resolve; }),
    markStarted: startedResolve,
  };
  return plan;
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

async function startFakeProvider() {
  const plans = [];
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    const plan = plans.shift() ?? createPlan(`reply:${lastUserText(body).slice(0, 40)}`);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(plan.text))}\n\n`);
    plan.markStarted();
    if (plan.mode === 'hold') await plan.released;
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify(chunk(null))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, plan(mode, text) { const value = createPlan(text); value.mode = mode; plans.push(value); return value; } };
}

/** SSE 客户端：真实解析 event/data，记录事件到达时刻（用来证「上游还挂着时 delta 就到了」）。 */
function openSse(host, port, pathname, headers) {
  const events = [];
  const waiters = new Set();
  let response;
  let buffer = '';
  let currentEvent = 'message';
  let currentData = [];
  const request = http.request({ host, port, path: pathname, headers: { accept: 'text/event-stream', ...headers } });
  const connected = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (incoming) => {
      response = incoming;
      incoming.setEncoding('utf8');
      incoming.on('data', (text) => {
        buffer += text;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line === '') {
            if (currentData.length > 0) {
              const raw = currentData.join('\n');
              let data;
              try { data = JSON.parse(raw); } catch { data = raw; }
              events.push({ event: currentEvent, data, at: Date.now(), ended: false });
              for (const waiter of [...waiters]) waiter();
            }
            currentEvent = 'message';
            currentData = [];
          } else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) currentData.push(line.slice(5).trimStart());
        }
      });
      incoming.once('end', () => {
        events.push({ event: '__end__', data: null, at: Date.now(), ended: true });
        for (const waiter of [...waiters]) waiter();
      });
      incoming.on('error', () => {});
      resolve(incoming);
    });
    request.end();
  });
  const waitFor = (predicate, timeoutMs = 10_000) => {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSE wait timed out: ${JSON.stringify(events.map((event) => event.event))}`)), timeoutMs);
      const check = () => {
        const value = events.find(predicate);
        if (!value) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(value);
      };
      waiters.add(check);
    });
  };
  return { connected, events, waitFor, headers: () => response?.headers ?? {}, close() { response?.destroy(); request.destroy(); } };
}

async function waitForReady() {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await rawRequest('127.0.0.1', appPort, '/api/host');
    if (response.statusCode === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 不要把「起不来」伪装成「没就绪」：把两份日志的尾巴一起抛出来，下一次才知道为什么。
  const tail = (text) => text.split('\n').filter(Boolean).slice(-8).join('\n');
  const baseTail = await readFile(baseLogPath, 'utf8').catch(() => '(no base log)');
  const appTail = await readFile(appLogPath, 'utf8').catch(() => '(no app log)');
  throw new Error(`A+B did not become ready on base=${basePort} app=${appPort}\n-- base --\n${tail(baseTail)}\n-- app --\n${tail(appTail)}`);
}

function banner() {}

let primaryError;
try {
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  providerPort = await reserveHighPort();
  const used = new Set([providerPort]);
  basePort = await reserveHighPort(used); used.add(basePort);
  // B 绑 0.0.0.0：探测也用 0.0.0.0，避开「127.0.0.1 空闲但别的接口上被占」的碰撞。
  appPort = await reserveHighPort(used, '0.0.0.0'); used.add(appPort);

  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-compression', name: 'Compression Fake', contextWindow: 4096, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-compression',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  // 大夹具：自己写一条 ~18 MiB 的会话文件（确定性，任何人跑都一样）；小夹具验体积阈值。
  const words = [];
  for (let index = 0; index < 2048; index += 1) words.push(randomUUID().replaceAll('-', '').slice(0, 10));
  const text = (length) => {
    let value = '';
    while (value.length < length) value += `${words[Math.floor(Math.random() * words.length)]} `;
    return value.slice(0, length);
  };
  async function seedSession(size) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const lines = [{ type: 'session', version: 3, id, timestamp: now, cwd: workspace }];
    for (let index = 0; index < size.messages; index += 1) {
      const role = index % 2 ? 'assistant' : 'user';
      const message = role === 'assistant'
        ? { role, content: [{ type: 'text', text: text(size.chars) }], stopReason: 'stop', timestamp: Date.now() }
        : { role, content: text(size.chars), timestamp: Date.now() };
      lines.push({ type: 'message', id: `${index}`.padStart(8, '0'), parentId: index === 0 ? null : `${index - 1}`.padStart(8, '0'), timestamp: now, message });
    }
    await writeFile(path.join(sessionsRoot, `compression_${id}.jsonl`), `${lines.map(JSON.stringify).join('\n')}\n`);
    return id;
  }
  const bigId = await seedSession({ messages: 900, chars: 20_000 });
  const smallId = await seedSession({ messages: 8, chars: 400 });

  providerServer = await startFakeProvider();
  baseLog = await open(baseLogPath, 'w');
  appLog = await open(appLogPath, 'w');
  baseChild = spawn(process.execPath, [baseEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: workspace,
      SOPHO_NO_TOOLS: '1',
      SOPHO_COMPRESS_DIAGNOSTICS: '1',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  appChild = spawn(process.execPath, [appEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_APP_HOST: '0.0.0.0',
      SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1',
      SOPHO_UPSTREAM_PORT: String(basePort),
      SOPHO_WEB_ROOT: path.join(sourceRoot, 'web'),
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  await waitForReady();
  print('sandbox', { home, workspace, providerPort, basePort, appPort });

  const lan = nonLoopbackAddress();
  const bigPath = `/api/sessions/${bigId}/messages`;
  const smallPath = `/api/sessions/${smallId}/messages`;

  // 业主链路是**明文 HTTP**：真实浏览器只提 `gzip, deflate`（实测 `/messages` 请求头）。
  // 所以主断言走这条；br 另开一条「客户端真提 br 时才用」的附加检查（当前链路用不到）。
  const browserAccept = 'gzip, deflate';
  const acceptBoth = 'br, gzip, deflate';

  // ── 臂 ① 回环：不压、逐字节与「现在」相同（这里用 A 直连与 identity 两条独立参照）──────────────
  const loopback = await rawRequest('127.0.0.1', appPort, bigPath, { headers: { 'accept-encoding': browserAccept } });
  const directA = await rawRequest('127.0.0.1', basePort, `/sessions/${bigId}/messages`, { headers: { 'accept-encoding': browserAccept } });
  const loopbackIdentity = await rawRequest('127.0.0.1', appPort, bigPath, { headers: { 'accept-encoding': 'identity' } });
  check('① 回环经 B：无 content-encoding', loopback.statusCode === 200 && loopback.headers['content-encoding'] === undefined, JSON.stringify({ status: loopback.statusCode, contentEncoding: loopback.headers['content-encoding'] ?? null }));
  check('① 回环经 B 与 A 直连逐字节相同', Buffer.compare(loopback.buffer, directA.buffer) === 0 && loopback.statusCode === 200 && directA.statusCode === 200, JSON.stringify({ loopbackBytes: loopback.buffer.length, directBytes: directA.buffer.length }));
  check('① 回环 identity 也是同一份字节', Buffer.compare(loopback.buffer, loopbackIdentity.buffer) === 0, JSON.stringify({ identityBytes: loopbackIdentity.buffer.length }));
  check('① 回环 content-length 与正文一致', Number(loopback.headers['content-length']) === loopback.buffer.length, JSON.stringify({ contentLength: loopback.headers['content-length'], bytes: loopback.buffer.length }));
  const loopback304 = await rawRequest('127.0.0.1', appPort, bigPath, { headers: { 'accept-encoding': browserAccept, 'if-none-match': String(loopback.headers.etag) } });
  check('① 回环 If-None-Match 命中 ⇒ 304 零传输（回环也享有零重传）', loopback304.statusCode === 304 && loopback304.buffer.length === 0, JSON.stringify({ status: loopback304.statusCode, bytes: loopback304.buffer.length }));

  if (!lan) {
    print('SKIP arms ②/③(non-loopback)', '本机没有非回环 IPv4 地址；条件压缩的非回环臂需要它（不能拿 127.x 冒充）');
    print('summary', { checks, skippedNonLoopback: true, bigBytes: loopback.buffer.length });
    banner();
  } else {
    print('non-loopback peer', lan);
    // ── 臂 ② 非回环：压、解码后逐字节相同 ────────────────────────────────────────────────────
    const remote = await rawRequest(lan.address, appPort, bigPath, { headers: { 'accept-encoding': browserAccept } });
    check('② 非回环（浏览器真实能力 gzip, deflate）：有 content-encoding: gzip', remote.statusCode === 200 && remote.headers['content-encoding'] === 'gzip', JSON.stringify({ status: remote.statusCode, contentEncoding: remote.headers['content-encoding'] ?? null }));
    check('② 非回环：vary 声明 accept-encoding', /accept-encoding/i.test(String(remote.headers.vary ?? '')), JSON.stringify(remote.headers.vary ?? null));
    check('② 非回环：content-length 与压缩后正文一致', Number(remote.headers['content-length']) === remote.buffer.length, JSON.stringify({ contentLength: remote.headers['content-length'], bytes: remote.buffer.length }));
    const decodedGzip = decode(remote.buffer, remote.headers['content-encoding']);
    check('② 非回环解码后与回环逐字节相同', Buffer.compare(decodedGzip, loopback.buffer) === 0, JSON.stringify({ encodedBytes: remote.buffer.length, decodedBytes: decodedGzip.length, plainBytes: loopback.buffer.length }));
    check('② 非回环确实变小', remote.buffer.length < loopback.buffer.length, JSON.stringify({ encoded: remote.buffer.length, plain: loopback.buffer.length, ratio: `${(remote.buffer.length / loopback.buffer.length * 100).toFixed(1)}%` }));

    // ── 硬要求：压缩变体与不压变体**不能互相顶掉**（键 = (versionKey, encoding)）─────────────
    // 顺序 gzip → 回环(不压) → gzip：三者「解码后正文」都必须逐字节等于参照。若两者共用同一个
    // 缓存槽，中间的回到环会拿到 gzip 字节（或反过来），这条立刻红。
    const interleave = [
      await rawRequest(lan.address, appPort, bigPath, { headers: { 'accept-encoding': browserAccept } }),
      await rawRequest('127.0.0.1', appPort, bigPath, { headers: { 'accept-encoding': browserAccept } }),
      await rawRequest(lan.address, appPort, bigPath, { headers: { 'accept-encoding': browserAccept } }),
    ];
    const interleaveDecoded = [decode(interleave[0].buffer, 'gzip'), interleave[1].buffer, decode(interleave[2].buffer, 'gzip')];
    check('② 压缩/不压变体不互相顶掉：gzip → 回环 → gzip（三段解码后都逐字节相同）',
      interleave[0].headers['content-encoding'] === 'gzip'
      && interleave[1].headers['content-encoding'] === undefined
      && interleave[2].headers['content-encoding'] === 'gzip'
      && interleaveDecoded.every((buffer) => Buffer.compare(buffer, loopback.buffer) === 0),
      JSON.stringify(interleave.map((result) => ({ ce: result.headers['content-encoding'] ?? null, bytes: result.buffer.length }))));

    const brOffered = await rawRequest(lan.address, appPort, bigPath, { headers: { 'accept-encoding': acceptBoth } });
    check('② 客户端真提 br 时才用 br（当前明文链路用不到）⇒ content-encoding: br 且解码相同', brOffered.headers['content-encoding'] === 'br' && Buffer.compare(decode(brOffered.buffer, 'br'), loopback.buffer) === 0, JSON.stringify({ contentEncoding: brOffered.headers['content-encoding'] ?? null, bytes: brOffered.buffer.length }));

    const noAccept = await rawRequest(lan.address, appPort, bigPath, { headers: { 'accept-encoding': 'identity' } });
    check('② 只接受 identity ⇒ 不压', noAccept.headers['content-encoding'] === undefined && Buffer.compare(noAccept.buffer, loopback.buffer) === 0, JSON.stringify({ contentEncoding: noAccept.headers['content-encoding'] ?? null, bytes: noAccept.buffer.length }));

    const small = await rawRequest(lan.address, appPort, smallPath, { headers: { 'accept-encoding': browserAccept } });
    check('② 非回环但小于体积阈值 ⇒ 不压', small.statusCode === 200 && small.headers['content-encoding'] === undefined, JSON.stringify({ status: small.statusCode, bytes: small.buffer.length, contentEncoding: small.headers['content-encoding'] ?? null }));

    // ── 正交：压缩结果缓存（同一版只压一次）+ ETag / If-None-Match（idle 会话重开 ⇒ 304 零传输）──
    check('② 响应带弱 ETag', typeof loopback.headers.etag === 'string' && loopback.headers.etag.startsWith('W/"'), JSON.stringify(loopback.headers.etag ?? null));
    const remoteAgain = await rawRequest(lan.address, appPort, bigPath, { headers: { 'accept-encoding': browserAccept } });
    check('② 压缩结果被缓存：第二次字节与第一次完全相同', Buffer.compare(remoteAgain.buffer, remote.buffer) === 0, JSON.stringify({ first: remote.buffer.length, second: remoteAgain.buffer.length }));
    const cacheLog = await readFile(baseLogPath, 'utf8');
    check('② 缓存命中可观测（worker 日志 [compress-cache] hit）', /\[compress-cache\] hit .* gzip/.test(cacheLog), JSON.stringify(cacheLog.split('\n').filter((line) => line.includes('compress-cache')).slice(-3)));
    const notModified = await rawRequest(lan.address, appPort, bigPath, { headers: { 'accept-encoding': browserAccept, 'if-none-match': String(loopback.headers.etag) } });
    check('② If-None-Match 命中 ⇒ 304 零传输', notModified.statusCode === 304 && notModified.buffer.length === 0, JSON.stringify({ status: notModified.statusCode, bytes: notModified.buffer.length, etag: notModified.headers.etag ?? null }));
    const stale = await rawRequest(lan.address, appPort, bigPath, { headers: { 'accept-encoding': browserAccept, 'if-none-match': 'W/"v1-deadbeefdeadbeefdeadbeef"' } });
    check('② 陈旧 ETag ⇒ 200 且仍压缩', stale.statusCode === 200 && stale.headers['content-encoding'] === 'gzip', JSON.stringify({ status: stale.statusCode, contentEncoding: stale.headers['content-encoding'] ?? null }));

    // ── 臂 ③ SSE：不压 + 逐帧 flush（上游还挂着时 delta 必须已经到）────────────────────────────
    const createdSession = await postJson('127.0.0.1', appPort, '/api/sessions', { cwd: workspace, name: 'Compression Stream' });
    assert.equal(createdSession.statusCode, 201, `POST /sessions -> ${createdSession.statusCode} ${createdSession.buffer.toString('utf8').slice(0, 300)}`);
    const streamId = JSON.parse(createdSession.buffer.toString('utf8')).id;

    const stream = openSse(lan.address, appPort, `/api/sessions/${streamId}/events`, { 'accept-encoding': browserAccept });
    await stream.connected;
    const sseHeaders = stream.headers();
    check('③ SSE：无 content-encoding', sseHeaders['content-encoding'] === undefined, JSON.stringify(sseHeaders['content-encoding'] ?? null));
    check('③ SSE：content-type 仍是 text/event-stream', /^text\/event-stream/.test(String(sseHeaders['content-type'])), JSON.stringify(sseHeaders['content-type'] ?? null));
    await stream.waitFor((event) => event.event === 'session.snapshot');
    print('③ sse snapshot', { events: stream.events.map((event) => event.event) });

    // 假 provider 写一条 delta 后**挂住**；客户端必须在它释放之前就收到 delta —— 这就是「逐帧 flush」。
    const plan = providerServer.plan('hold', 'compression-stream-alpha');
    const messagePosted = await postJson('127.0.0.1', appPort, `/api/sessions/${streamId}/message`, { text: 'trigger compression stream' });
    print('③ message posted', { status: messagePosted.statusCode, body: messagePosted.buffer.toString('utf8').slice(0, 200) });
    await plan.started;
    const delta = await stream.waitFor((event) => event.event === 'session.delta' && event.data.delta === 'compression-stream-alpha', 8000);
    check('③ SSE：上游还挂着时 delta 已到达（逐帧 flush，没被攒）', plan.releasedNow !== true, JSON.stringify({ deltaAt: delta.at }));
    check('③ SSE：delta 到达时响应还没结束', stream.events.every((event) => event.event !== '__end__'), JSON.stringify(stream.events.map((event) => event.event)));
    plan.release();
    await stream.waitFor((event) => event.event === 'session.end');
    stream.close();

    print('summary', {
      loopbackBytes: loopback.buffer.length,
      gzipBytes: remote.buffer.length,
      gzipRatio: `${(remote.buffer.length / loopback.buffer.length * 100).toFixed(1)}%`,
      brotliBytes: brOffered.buffer.length,
      cachedGzipBytes: remoteAgain.buffer.length,
      notModifiedBytes: notModified.buffer.length,
      loopbackMs: loopback.elapsedMs,
      gzipMs: remote.elapsedMs,
      sseContentEncoding: sseHeaders['content-encoding'] ?? null,
    });
    banner();
  }

  print('RESULT', `conditional-compression PASS (${checks} checks)`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  if (baseChild) await cleanupStep(cleanupProblems, 'stop A', () => new Promise((resolve) => {
    if (baseChild.exitCode !== null || baseChild.signalCode !== null) return resolve();
    baseChild.once('exit', resolve);
    baseChild.kill('SIGTERM');
    setTimeout(() => { if (baseChild.exitCode === null) baseChild.kill('SIGKILL'); resolve(); }, 8000).unref();
  }));
  if (appChild) await cleanupStep(cleanupProblems, 'stop B', () => new Promise((resolve) => {
    if (appChild.exitCode !== null || appChild.signalCode !== null) return resolve();
    appChild.once('exit', resolve);
    appChild.kill('SIGTERM');
    setTimeout(() => { if (appChild.exitCode === null) appChild.kill('SIGKILL'); resolve(); }, 8000).unref();
  }));
  if (providerServer) await cleanupStep(cleanupProblems, 'stop provider', () => new Promise((resolve) => { providerServer.server.closeAllConnections?.(); providerServer.server.close(resolve); }));
  if (baseLog) await cleanupStep(cleanupProblems, 'close base log', () => baseLog.close());
  if (appLog) await cleanupStep(cleanupProblems, 'close app log', () => appLog.close());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
