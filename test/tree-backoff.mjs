#!/usr/bin/env node
// test/tree-backoff.mjs —— /tree 失败时的前端重试纪律门（防「实例级放大回路」）。
//
// 现场：v2.2 的 GET /tree 在真机上 >5s ⇒ 被宿主 5 秒硬超时掐掉 ⇒ 500；
// worker 那边**继续算**；前端拿到 500 就立刻重试 ⇒ 实测约 6.4 次/秒、几分钟 736 个 TIME_WAIT，
// 每个重试又叠一层计算 ⇒ worker 被拖死。
//
// 本门用假 API 造一个**受控一直 500 的 /api/tree** + 持续推 tree.session 的 SSE，
// 在真 Chromium 里钉住四件事：
//   ① N 秒内的 /tree 请求次数有上界（旧实现上就是把 SSE 事件数一个个变成请求）；
//   ② 退避期间没有并发重入（同一 URL 同时在飞的请求数 ≤ 1）；
//   ③ 后端恢复后能重新拿到树，且退避被重置（成功一次后新的 tree.session 立刻触发请求）；
//   ④ 连续失败时有诚实的 notice（不静默空着）。
//
// 只用一个高位随机端口 + 临时 user-data-dir；不碰真实 profile、7331/7321。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-treebackoff-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-treebackoff');
const screenshotFile = path.join(artifactRoot, 'tree-backoff-1200x760.png');

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessions = [
  { id: SESSION_ID, name: '退避门 · 主会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  { id: OTHER_ID, name: '退避门 · 另一条', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
];

// 门的阈值（依据见本轮报告）：稳态 = 退避 1s→2s→4s（抖动 50–100%）。
//   风暴窗口 4s 里，有退避时请求数 ≈ 2–4；没有退避时 = 事件数（每 50ms 一个 ⇒ ≈80）。
const STORM_MS = Number(process.env.SOPHO_TREEBACKOFF_STORM_MS ?? 4000);
const EVENT_INTERVAL_MS = Number(process.env.SOPHO_TREEBACKOFF_EVENT_MS ?? 50);
// 平均每 50ms 一个事件 ⇒ 4s ≈ 80 个请求（旧实现）；阈值 10 给退避留足抖动余量。
const STORM_REQUEST_LIMIT = Number(process.env.SOPHO_TREEBACKOFF_LIMIT ?? 10);
const TREE_HANDLER_DELAY_MS = Number(process.env.SOPHO_TREEBACKOFF_DELAY_MS ?? 40);

let server;
let chromium;
let browser;
let treeStream = null;
let storming = false;
let stormTimer = null;
let treeMode = 'fail';
const treeRequests = [];
let treeConcurrent = 0;
let treeMaxConcurrent = 0;
let checks = 0;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
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

async function waitFor(operation, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
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

async function evaluate(expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
  return result.result.value;
}

function pushTreeEvent() {
  if (treeStream && !treeStream.destroyed) treeStream.write(`event: tree.session\ndata: ${JSON.stringify({ seq: treeRequests.length + 1, at: Date.now(), type: 'test', sessionId: SESSION_ID, reason: 'storm' })}\n\n`);
}

function startStorm() {
  storming = true;
  if (stormTimer !== null) return;
  stormTimer = setInterval(() => { if (storming) pushTreeEvent(); }, EVENT_INTERVAL_MS);
}

function stopStorm() {
  storming = false;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(artifactRoot, { recursive: true });
const port = await reservePort();
let primaryError;
try {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/tree') {
      treeConcurrent += 1;
      treeMaxConcurrent = Math.max(treeMaxConcurrent, treeConcurrent);
      treeRequests.push({ at: Date.now(), mode: treeMode, concurrent: treeConcurrent });
      let settled = false;
      const finish = () => { if (settled) return; settled = true; treeConcurrent -= 1; };
      response.once('finish', finish);
      response.once('close', finish);
      return setTimeout(() => {
        if (treeMode === 'fail') sendJson(response, 500, { message: 'tree 门：受控一直 500' });
        else if (treeMode === 'partial') sendJson(response, 200, { sessions: sessions.slice(0, 1), partial: true, indexScan: { complete: false, files: sessions.length, indexed: 1, pending: sessions.length - 1, rows: 1, hidden: 0, truncated: false }, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
        else sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
      }, TREE_HANDLER_DELAY_MS);
    }
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      treeStream = response;
      response.once('close', () => { if (treeStream === response) treeStream = null; });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const content = await readFile(path.join(webRoot, 'index.html'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(content);
    }
    const file = path.resolve(webRoot, `.${url.pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
    ? 'C:/Users/user/AppData/Local/Chromium/Application/chrome.exe'
    : '/usr/bin/chromium');
  const debugPort = await reservePort();
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
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
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;

  // 首个 /tree 必然 500。
  await waitFor(() => treeRequests.length >= 1, 'first /tree request did not arrive');

  // ── 风暴：SSE 每 50ms 推一个 tree.session，持续 STORM_MS ─────────────
  const stormStart = Date.now();
  startStorm();
  await delay(STORM_MS);
  stopStorm();
  const stormEnd = Date.now();
  const inWindow = treeRequests.filter((request) => request.at >= stormStart && request.at <= stormEnd);
  const gaps = inWindow.slice(1).map((request, index) => request.at - inWindow[index].at);
  check('① 风暴窗口内 /tree 请求次数有上界', inWindow.length <= STORM_REQUEST_LIMIT, `窗口 ${STORM_MS}ms 事件间隔 ${EVENT_INTERVAL_MS}ms：${JSON.stringify({ requests: inWindow.length, limit: STORM_REQUEST_LIMIT, gapsMs: gaps })}`);

  // 停在还没恢复时统计并发：同一 URL 同时在飞的请求数必须 ≤1。
  check('② 退避期间没有并发重入（同 URL 在飞 ≤1）', treeMaxConcurrent === 1, `treeMaxConcurrent=${treeMaxConcurrent}（全部请求：${JSON.stringify(treeRequests.map((r) => [r.mode, r.concurrent]))}）`);

  // 连续失败时应出现诚实 notice（不是静默空着 / 反复闪）。
  const failureNotice = await waitFor(async () => {
    const text = await evaluate(`document.querySelector('#notice').textContent`);
    return text.includes('会话树暂时拿不到') ? text : null;
  }, 'tree failure notice did not appear', 8000);
  check('④ 连续失败时有诚实 notice', failureNotice.includes('会话树暂时拿不到'), JSON.stringify(failureNotice));

  const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(screenshotFile, Buffer.from(shot.data, 'base64'));

  // ── 恢复：后端改回 200，等退避到点后自动重试成功 ────────────────────
  treeMode = 'ok';
  const failuresAtRecoveryStart = inWindow.length;
  const recovered = await waitFor(async () => {
    const rows = await evaluate(`document.querySelectorAll('[data-session-id]').length`);
    const oks = treeRequests.filter((request) => request.mode === 'ok').length;
    return rows > 0 && oks > 0 ? { rows, oks } : null;
  }, 'tree did not recover after backoff', 40000);
  check('③ 后端恢复后退避到点自动重试成功并画出树', recovered.rows === sessions.length, `渲染 ${recovered.rows} 行；恢复期 200 响应 ${recovered.oks} 次（风暴窗口内失败 ${failuresAtRecoveryStart} 次）`);

  // ── 退避重置：成功一次后，新的 tree.session 应立刻触发请求 ──────────
  const beforeReset = treeRequests.length;
  startStorm();
  const afterReset = await waitFor(() => treeRequests.length > beforeReset ? treeRequests.length : null, 'tree.session after recovery did not trigger a prompt request', 3000);
  stopStorm();
  check('③ 成功一次后退避被重置（新事件立刻触发请求）', afterReset > beforeReset, `恢复后新 tree.session 在 3s 内触发请求：${beforeReset} → ${afterReset}`);
  check('② 恢复期也没有并发重入', treeMaxConcurrent === 1, `treeMaxConcurrent=${treeMaxConcurrent}`);

  // ── ⑤ worker 的索引还在建时的**部分视图**（`partial: true`）不许落地 ────────────────────
  // 那份响应行都是对的，但可能**不全**；拿它顶掉手上这份完整的树，会话就会在左栏「消失」一下 ——
  // 那比等一下更坏。所以：不落地，只很快补问一次（worker 那边索引在接着建）。
  {
    // 先等在飞的那次请求落地：同一资源单飞（前一条臂刚推过一个事件），不等就可能被合并掉。
    await waitFor(() => treeConcurrent === 0, 'the in-flight /tree request did not drain', 5000);
    const oksBefore = treeRequests.filter((request) => request.mode === 'ok').length;
    const rowsBefore = await evaluate(`document.querySelectorAll('[data-session-id]').length`);
    treeMode = 'partial';
    pushTreeEvent();
    await waitFor(() => treeRequests.some((request) => request.mode === 'partial'), 'a partial /tree response did not arrive', 20000);
    await delay(300);
    const rowsAfter = await evaluate(`document.querySelectorAll('[data-session-id]').length`);
    check('⑤ 部分视图不落地：界面上的树一行都不许少', rowsAfter === rowsBefore && rowsAfter === sessions.length, `partial 响应前后行数 ${rowsBefore} → ${rowsAfter}（夹具 ${sessions.length} 条）`);
    treeMode = 'ok';
    await waitFor(() => treeConcurrent === 0, 'the in-flight partial response did not drain', 5000);
    const retried = await waitFor(async () => {
      const oks = treeRequests.filter((request) => request.mode === 'ok').length;
      return oks > oksBefore ? oks : null;
    }, 'the partial view did not trigger a follow-up refresh', 20000);
    const rowsFinal = await evaluate(`document.querySelectorAll('[data-session-id]').length`);
    check('⑤ 部分视图之后很快补问一次，拿到完整树就落地', retried > oksBefore && rowsFinal === sessions.length, `补问后 200 次数 ${oksBefore} → ${retried}，行数 ${rowsFinal}/${sessions.length}`);
    print('partial view', { rowsBefore, rowsAfterPartial: rowsAfter, rowsFinal, okRequestsBefore: oksBefore, okRequestsAfter: retried });
  }
  check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));

  print('storm', { windowMs: STORM_MS, eventIntervalMs: EVENT_INTERVAL_MS, eventsPushed: Math.floor(STORM_MS / EVENT_INTERVAL_MS), treeRequestsInWindow: inWindow.length, gapsMs: gaps, maxConcurrent: treeMaxConcurrent });
  print('allTreeRequests', treeRequests.map((request) => ({ mode: request.mode, tMs: request.at - stormStart, concurrent: request.concurrent })));
  print('screenshot', screenshotFile);
  print('chromium', { product: version.Browser, executable: chrome, viewport: '1200x760' });
  print('checks', checks);
  print('RESULT', 'tree backoff PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  stopStorm();
  if (stormTimer !== null) clearInterval(stormTimer);
  browser?.close();
  treeStream?.destroy();
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM');
    await new Promise((resolve) => chromium.once('exit', resolve));
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
