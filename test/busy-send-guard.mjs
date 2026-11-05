#!/usr/bin/env node
// 机械门：跑着的时候发消息（409 忙冲突）不许丢输入、不许重复、必须有正确语义或可读提示。
//
// 造三个窗口，全部注入在**前端发送路径**上（真 Chromium 跑 web/app.js，假 API/SSE）：
//   B 半轮：服务端先给 session.start，再给 session.end（= 一条 assistant 消息结束），
//           run 还没停（还没 session.settled）⇒ 客户端必须知道「还在跑」，回车走 steer，
//           **不许**去打 message 路由拿 409；abort 也必须仍然可用。
//   A 静默忙：服务端忙但**不广播**（客户端以为空闲）⇒ message 路由 409，
//           前端必须按用户意图自动改走 steer 重发：输入清零、文本**只落地一次**。
//   C 死忙：message 与 steer 都 409 ⇒ 不许丢输入（文字仍留在输入框）、提示必须是可读中文，
//           不许把 pi 的英文原句端给用户。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'busy-send-guard-'));
const sessionId = '33333333-3333-4333-8333-333333333333';
const STREAMING_CONFLICT = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
const NOT_STREAMING_CONFLICT = 'Agent is not currently processing; steer/followUp require an active response.';

const requests = [];
const delivered = [];
const drafts = new Map();
const sessionClients = new Set();
let busy = false;           // 服务端 run 级忙（权威）
let messageRefused = false; // message 路由 409 忙冲突
let steerRefused = false;   // steer 路由也 409 忙冲突（hard-busy）
let steerIdleRefused = false; // steer 撞「已经闲了」（409 session_not_streaming）—— 反方向窗口
let holdSteer = false;        // 把 steer 请求挂住：测试可在「请求已到、409 还没回」的空档里改输入框
let heldSteers = [];          // 挂住的 steer 响应（release 时统一回 409）
let raceArm = false;          // 用户路径复现：这一轮正好在 message(409) → 兜底 steer 的两跳之间结束
let browser;
let chromium;
let server;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
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

function broadcast(event, data) {
  for (const response of sessionClients) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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

async function waitFor(fn, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function cdp(wsUrl) {
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || result.result?.description || 'browser evaluation failed');
  return result.result.value;
}

async function pressEnter(text, { alt = false } = {}) {
  await evaluate(`(() => { const input = document.querySelector('#prompt'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: ${alt}, bubbles: true, cancelable: true })); })()`);
}

const view = () => evaluate(`({ input: document.querySelector('#prompt').value, notice: document.querySelector('#notice').textContent, abort: document.querySelector('#abort').disabled, send: document.querySelector('#send').disabled })`);

let primaryError;
try {
  const port = await reservePort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/tree') {
      sendJson(response, 200, { sessions: [{ id: sessionId, name: 'Busy guard', status: 'idle', statusLabel: '闲置', archived: false, parentId: null }] });
      return;
    }
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: [{ id: sessionId, name: 'Busy guard', status: 'idle', statusLabel: '闲置', archived: false, parentId: null }] })}\n\n`);
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}`) {
      sendJson(response, 200, { name: 'Busy guard', context: null, observability: null, runtime: { isStreaming: busy, isCompacting: false, isRetrying: false, model: { provider: 'fake', id: 'fake-busy' } } });
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}/messages`) {
      sendJson(response, 200, { messages: [], extras: [], compaction: { atIndex: null }, observability: null, context: null });
      return;
    }
    if (url.pathname === `/api/sessions/${sessionId}/commands`) {
      sendJson(response, 200, { streaming: busy, compacting: false, canRun: !busy, commands: [] });
      return;
    }
    const draftId = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/)?.[1];
    if (draftId) {
      if (request.method === 'GET') return sendJson(response, 200, drafts.get(draftId) ?? { text: '', at: null });
      const body = await bodyOf(request);
      if (body.text === '') drafts.delete(draftId);
      else drafts.set(draftId, { text: body.text, at: Date.now() });
      return sendJson(response, 200, drafts.get(draftId) ?? { text: '', at: null });
    }
    if (url.pathname === `/api/sessions/${sessionId}/events`) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: busy, isCompacting: false, isRetrying: false, queue: { steering: [], followUp: [] } })}\n\n`);
      sessionClients.add(response);
      response.once('close', () => sessionClients.delete(response));
      return;
    }
    const action = url.pathname.match(new RegExp(`^/api/sessions/${sessionId}/(message|steer|follow-up)$`))?.[1];
    if (action && request.method === 'POST') {
      const body = await bodyOf(request);
      requests.push({ action, text: body.text, at: Date.now() });
      // 用户遇到的那条路径的开关：客户端以为空闲（下面 /control/race 不发 session.start）⇒ 打 message；
      // 这一发 409（streamingBehavior）的**同时**这一轮真的结束（服务端翻空闲）⇒ 前端兜底踩的 steer
      // 就会撞 session_not_streaming —— 两跳之间的那几毫秒就是 state-skew 量到的那个缝。
      if (action === 'message' && raceArm) {
        raceArm = false;
        busy = false; messageRefused = false; steerIdleRefused = true;
        return sendJson(response, 409, { error: 'session_streaming', message: STREAMING_CONFLICT });
      }
      if (action === 'message' && messageRefused) return sendJson(response, 409, { error: 'session_streaming', message: STREAMING_CONFLICT });
      if (action === 'steer' && steerRefused) return sendJson(response, 409, { error: 'session_streaming', message: STREAMING_CONFLICT });
      // 反方向窗口：客户端以为在跑（session.start 已到）、服务端其实已经闲了 ⇒ steer/follow-up
      // 撞 session_not_streaming（= 用户看到「会话这轮已经结束」那句 409 的那一支）。
      if (action !== 'message' && steerIdleRefused) return sendJson(response, 409, { error: 'session_not_streaming', message: NOT_STREAMING_CONFLICT });
      // 挂住这条 steer：让测试在「请求已到、响应未回」的空档里改输入框（验反方向兜底的条件 a/b）。
      if (action === 'steer' && holdSteer) { heldSteers.push(response); return; }
      delivered.push({ action, text: body.text });
      if (action !== 'message') {
        const steering = delivered.filter((entry) => entry.action === 'steer').map((entry) => entry.text);
        const followUp = delivered.filter((entry) => entry.action === 'follow-up').map((entry) => entry.text);
        broadcast('session.queue', { steering, followUp });
      }
      return sendJson(response, 202, { accepted: true });
    }
    if (url.pathname === '/control/half-turn') {
      busy = true; messageRefused = true; steerRefused = false;
      broadcast('session.start', { role: 'assistant' });
      broadcast('session.end', { stopReason: 'stop', errorMessage: null, text: '' });
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/control/settle') {
      busy = false; messageRefused = false; steerRefused = false;
      broadcast('session.settled', {});
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/control/silent-busy') {
      // 服务端忙，但**不广播**：客户端以为空闲（= 漏了 settled / 刚重连的窗口）。
      busy = true; messageRefused = true; steerRefused = false;
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/control/hard-busy') {
      busy = true; messageRefused = true; steerRefused = true;
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/control/reverse-race') {
      // 反方向窗口（窗口 A 的尾段）：客户端**以为在跑**（这一帧 session.start 到位），
      // 服务端其实已经闲（busy=false）⇒ steer 会撞 session_not_streaming。
      busy = false; messageRefused = false; steerRefused = false; steerIdleRefused = true; holdSteer = false; heldSteers = [];
      broadcast('session.start', { role: 'assistant' });
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/control/reverse-race-ok') {
      // 同类窗口，但这一轮**还没结束**：steer 照常 2xx 受理 ⇒ 前端不该再补一发 message。
      busy = true; messageRefused = false; steerRefused = false; steerIdleRefused = false; holdSteer = false; heldSteers = [];
      broadcast('session.start', { role: 'assistant' });
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/control/hold-steer') {
      // 挂住 steer：条件是「响应还没回」，服务端忙闲不影响这一场。
      busy = false; messageRefused = false; steerRefused = false; steerIdleRefused = false; holdSteer = true; heldSteers = [];
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === '/control/release-steer') {
      // 放掉挂住的 steer：一律回 409 session_not_streaming（此刻客户端以为在跑）。
      holdSteer = false;
      const pending = heldSteers;
      heldSteers = [];
      for (const held of pending) sendJson(held, 409, { error: 'session_not_streaming', message: NOT_STREAMING_CONFLICT });
      return sendJson(response, 200, { ok: true, released: pending.length });
    }
    if (url.pathname === '/control/race') {
      // 用户路径的起手：服务端**真的在跑**，但客户端已经对账回「空闲」（settled 到过）⇒ 回车走 message。
      busy = true; messageRefused = true; steerRefused = false; steerIdleRefused = false; holdSteer = false; heldSteers = []; raceArm = true;
      broadcast('session.settled', {});
      return sendJson(response, 200, { ok: true });
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(webRoot, `.${pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reservePort();
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const result = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return result?.ok ? result.json() : null;
  }, 'chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${port}/`, { method: 'PUT' })).json();
  browser = cdp(target.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'tree did not render');
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not open');
  print('chromium', { product: version.Browser, chrome });

  // ── B：半轮（session.end 已到、run 未 settle）⇒ 必须走 steer，且 abort 不能失效 ──
  await fetch(`http://127.0.0.1:${port}/control/half-turn`);
  await waitFor(async () => (await view()).notice.includes('回复完成'), 'half-turn session.end did not reach the client');
  const halfTurn = await view();
  assert.equal(halfTurn.abort, false, '工具循环中途 abort 必须仍然可用（不能因为 session.end 就置灰）');
  const beforeB = requests.length;
  await pressEnter('B-半轮窗口');
  await waitFor(async () => (await view()).input === '' && delivered.some((entry) => entry.text === 'B-半轮窗口'), 'B window message never landed and cleared');
  const afterB = requests.slice(beforeB);
  assert.deepEqual(afterB.map((entry) => entry.action), ['steer'], `B 窗口必须走 steer，实测 ${JSON.stringify(afterB)}`);
  assert.equal(delivered.filter((entry) => entry.text === 'B-半轮窗口').length, 1, 'B 窗口不许重复落地');
  assert.equal((await view()).input, '', 'B 窗口成功后输入框必须清空');
  print('B half-turn window: steer used, abort still live, one delivery', { requests: afterB, delivered: delivered.filter((entry) => entry.text === 'B-半轮窗口') });

  await fetch(`http://127.0.0.1:${port}/control/settle`);
  await waitFor(async () => (await view()).abort === true, 'settle did not re-disable abort');

  // ── A：静默忙（客户端以为空闲）⇒ message 409 ⇒ 自动按 steer 重发，只落地一次 ──
  await fetch(`http://127.0.0.1:${port}/control/silent-busy`);
  const beforeA = requests.length;
  await pressEnter('A-静默忙窗口');
  await waitFor(async () => (await view()).input === '' && delivered.some((entry) => entry.text === 'A-静默忙窗口'), 'A window message never landed and cleared');
  const afterA = requests.slice(beforeA);
  assert.deepEqual(afterA.map((entry) => entry.action), ['message', 'steer'], `A 窗口必须先 message(409) 再 steer，实测 ${JSON.stringify(afterA)}`);
  assert.equal(delivered.filter((entry) => entry.text === 'A-静默忙窗口').length, 1, 'A 窗口必须只落地一次（不许重复消息）');
  const viewA = await view();
  assert.equal(viewA.input, '', 'A 窗口自动重发成功后输入框必须清空');
  assert.equal(/streamingBehavior/.test(viewA.notice), false, 'A 窗口不该把 pi 的英文原句端给用户');
  print('A silent-busy window: message 409 then steer retry, exactly one delivery', { requests: afterA, notice: viewA.notice });

  // ── C：死忙（message 与 steer 都 409）⇒ 不丢输入 + 可读提示 ──
  await fetch(`http://127.0.0.1:${port}/control/hard-busy`);
  const beforeC = requests.length;
  await pressEnter('C-死忙窗口');
  await waitFor(async () => {
    const current = await view();
    return current.notice.includes('409') && requests.length >= beforeC + 2 ? current : null;
  }, 'C window readable notice missing');
  const afterC = requests.slice(beforeC);
  const viewC = await view();
  assert.deepEqual(afterC.map((entry) => entry.action), ['message', 'steer'], `C 窗口必须两次都试过，实测 ${JSON.stringify(afterC)}`);
  assert.equal(delivered.some((entry) => entry.text === 'C-死忙窗口'), false, 'C 窗口不许假装送达');
  assert.equal(viewC.input, 'C-死忙窗口', 'C 窗口失败后输入框里的文字必须还在（绝不丢用户输入）');
  assert.equal(/streamingBehavior/.test(viewC.notice), false, 'C 窗口不许把 pi 的英文原句端给用户');
  assert.match(viewC.notice, /还在跑/, `C 窗口提示要说明「还在跑」，实测：${viewC.notice}`);
  print('C hard-busy window: input kept, readable notice, no false delivery', { requests: afterC, notice: viewC.notice, input: viewC.input });

  // ── D：反方向窗口（以为在跑、其实已经闲）⇒ steer 409 session_not_streaming ⇒ 按新消息重发一次 ──
  // 这正是 C 组没盖的那一支（C 的 steer 回的是 session_streaming，方向相反）。
  await fetch(`http://127.0.0.1:${port}/control/reverse-race`);
  await waitFor(async () => (await view()).abort === false, 'reverse-race session.start did not make the client think it is busy');
  const beforeD = requests.length;
  await pressEnter('D-反方向窗口');
  await waitFor(async () => (await view()).input === '' && delivered.some((entry) => entry.text === 'D-反方向窗口'), 'D window message never landed and cleared');
  const afterD = requests.slice(beforeD);
  const viewD = await view();
  assert.deepEqual(afterD.map((entry) => entry.action), ['steer', 'message'], `D 窗口必须先 steer(409) 再按新消息重发，实测 ${JSON.stringify(afterD)}`);
  assert.equal(delivered.filter((entry) => entry.text === 'D-反方向窗口').length, 1, 'D 窗口必须只落地一次（不许重复投递）');
  assert.equal(viewD.input, '', 'D 窗口重发成功后输入框必须清空（原文作为新消息送出去了）');
  assert.match(viewD.notice, /消息已接收/, `D 窗口重发成功要报「消息已接收」，实测：${viewD.notice}`);
  assert.equal(/not currently processing/.test(viewD.notice), false, 'D 窗口不该把 pi 的英文原句端给用户');
  print('D reverse window: steer 409(session_not_streaming) then resend as plain message, exactly one delivery', { requests: afterD, delivered: delivered.filter((entry) => entry.text === 'D-反方向窗口'), notice: viewD.notice });

  // ── E：steer 已受理（2xx）⇒ 不许再补一发 message（不许重复投递）──
  await fetch(`http://127.0.0.1:${port}/control/reverse-race-ok`);
  await waitFor(async () => (await view()).abort === false, 'reverse-race-ok session.start did not make the client think it is busy');
  const beforeE = requests.length;
  await pressEnter('E-steer-已受理');
  await waitFor(async () => (await view()).input === '' && delivered.some((entry) => entry.text === 'E-steer-已受理'), 'E window steer never landed and cleared');
  const afterE = requests.slice(beforeE);
  assert.deepEqual(afterE.map((entry) => entry.action), ['steer'], `E 窗口 steer 已 2xx 受理就不许再发 message，实测 ${JSON.stringify(afterE)}`);
  assert.equal(delivered.filter((entry) => entry.text === 'E-steer-已受理').length, 1, 'E 窗口必须只落地一次');
  print('E steer accepted (202): no extra message resend', { requests: afterE });

  // ── F：原文被改过 ⇒ 不许重发（条件 a），保持今天那句可读 409、输入不丢 ──
  await fetch(`http://127.0.0.1:${port}/control/hold-steer`);
  const beforeF = requests.length;
  await pressEnter('F-原文未改');
  await waitFor(() => requests.slice(beforeF).some((entry) => entry.action === 'steer'), 'F held steer request never arrived');
  // 在「steer 已到、409 还没回」的空档里改输入框 —— 用户此刻想发的是另一段。
  await evaluate(`(() => { const input = document.querySelector('#prompt'); input.value = 'F-原文改过了'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await fetch(`http://127.0.0.1:${port}/control/release-steer`);
  const viewF = await waitFor(async () => { const value = await view(); return value.notice.includes('409') ? value : null; }, 'F readable 409 missing');
  const afterF = requests.slice(beforeF);
  assert.deepEqual(afterF.map((entry) => entry.action), ['steer'], `F 窗口原文改过后不许重发，实测 ${JSON.stringify(afterF)}`);
  assert.equal(delivered.some((entry) => entry.text === 'F-原文未改' || entry.text === 'F-原文改过了'), false, 'F 窗口不许假装送达');
  assert.equal(viewF.input, 'F-原文改过了', 'F 窗口失败后用户改过的文字必须原样留在输入框里');
  assert.match(viewF.notice, /已经结束/, `F 窗口提示要说明「这轮已经结束」，实测：${viewF.notice}`);
  print('F edited-original window: no resend, input kept, readable 409', { requests: afterF, notice: viewF.notice, input: viewF.input });

  // ── G：两次同文发送同时在飞 ⇒ 最多只许落地一次（条件 b：不许两条发送各自兜底成两份）──
  await fetch(`http://127.0.0.1:${port}/control/hold-steer`);
  const beforeG = requests.length;
  await pressEnter('G-同时两发');
  await waitFor(() => requests.slice(beforeG).filter((entry) => entry.action === 'steer').length >= 1, 'G first held steer never arrived');
  await pressEnter('G-同时两发'); // 同文再按一次：此刻 sendInFlight===2
  await waitFor(() => requests.slice(beforeG).filter((entry) => entry.action === 'steer').length >= 2, 'G second held steer never arrived');
  await fetch(`http://127.0.0.1:${port}/control/release-steer`);
  await waitFor(() => requests.slice(beforeG).some((entry) => entry.action === 'message'), 'G reverse fallback never fired');
  await new Promise((resolve) => setTimeout(resolve, 250)); // 留出「万一有第二次兜底」的窗口
  const afterG = requests.slice(beforeG);
  assert.equal(afterG.filter((entry) => entry.action === 'steer').length, 2, `G 窗口应有两次 steer，实测 ${JSON.stringify(afterG)}`);
  assert.equal(afterG.filter((entry) => entry.action === 'message').length, 1, `G 窗口只许补一次 message，实测 ${JSON.stringify(afterG)}`);
  assert.equal(delivered.filter((entry) => entry.text === 'G-同时两发').length, 1, 'G 窗口同一条原文只许落地一次（不重）');
  print('G two same-text sends in flight: exactly one delivery', { requests: afterG, delivered: delivered.filter((entry) => entry.text === 'G-同时两发') });

  // ── H：用户遇到的那条完整路径（message 409 → 兜底 steer 409 → 反方向兜底 message）+ 竞态时序 ──
  // 客户端以为空闲、服务端在跑 ⇒ message 409；这一轮正好在「message 409 → 兜底 steer」的两跳之间结束 ⇒
  // steer 409 session_not_streaming（用户看到的就是这句）；修后在这里按新消息重发一发，只落地一次。
  await fetch(`http://127.0.0.1:${port}/control/race`);
  await waitFor(async () => (await view()).abort === true, 'H race did not put the client back to idle');
  const beforeH = requests.length;
  await pressEnter('H-用户路径');
  await waitFor(async () => (await view()).input === '' && delivered.some((entry) => entry.text === 'H-用户路径'), 'H user-path message never landed and cleared');
  const afterH = requests.slice(beforeH);
  const viewH = await view();
  assert.deepEqual(afterH.map((entry) => entry.action), ['message', 'steer', 'message'], `H 用户路径必须 message→steer→message，实测 ${JSON.stringify(afterH.map((entry) => entry.action))}`);
  assert.equal(delivered.filter((entry) => entry.text === 'H-用户路径').length, 1, 'H 用户路径必须只落地一次（不许重复）');
  assert.match(viewH.notice, /消息已接收/, `H 用户路径修后要报「消息已接收」，实测：${viewH.notice}`);
  print('H user path: message 409 -> fallback steer 409(session_not_streaming) -> resend once, one delivery', {
    requests: afterH,
    hop1MsgToSteerMs: afterH[1].at - afterH[0].at,
    hop2SteerToRetryMs: afterH[2].at - afterH[1].at,
    notice: viewH.notice,
  });

  print('RESULT', 'busy-send guard PASS (no input loss, no duplicate delivery, steer fallback both directions + readable 409)');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'close browser', async () => { browser?.close(); });
  // 顺序要紧：先收掉 chromium，再关 server（否则 server.close 会等 keep-alive 连接 ⇒ 挂住 ✗）
  await cleanupStep(cleanupProblems, 'stop chromium', async () => {
    if (chromium && chromium.exitCode === null) {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    }
  });
  await cleanupStep(cleanupProblems, 'close server', async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}