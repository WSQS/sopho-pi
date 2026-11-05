#!/usr/bin/env node
// test/steer-live-split.mjs —— 机械门：流式中 steer 插话之后，新产出的正文只能落在**新**直播块里。
//
// 用户 2026-09-19 报的现象（真实会话 4bc978b2-16a6-456b-a5a2-7b1f36def848 的那几个 steer）：
//   流式中按 Enter 插话 ⇒ 用户的插话消息出现在正文流里了，但**插话之后**新产出的正文还继续
//   追加进「插话之前」那条旧直播气泡 ⇒ 屏幕上新内容排在用户消息**上面**。
//
// 为什么会这样：v2.2 把直播块改成「按 part 的持久节点」（正文走 `appendData` 增量）。它假定
// **一次直播只有一条 assistant 消息**；而 pi 在 turn 边界注入插话/排队消息后，会在**同一轮**里
// 再产出一条 assistant 消息（新的 `session.start`）。客户端只在 `!liveActive` 时才开新块，
// 于是新消息的 delta 被并进旧块。
//
// 这条门要钉住的三件事（都在真 A+B + 假 provider + 真 Chromium 上跑）：
//   ① 插话消息在**正文流里**（历史里它排在旧 assistant 之后、新 assistant 之前）；
//   ② 插话之后新出现的正文只落在**新节点**（旧节点的文本长度不再增长；没有任何节点同时含
//      「插话前」和「插话后」两段文本）；
//   ③ 与最终历史**不丢不重**（两段正文各只出现一次，两块 assistant 各一条）。
//
// 还顺带钉住：原始 SSE 里插话被注入的顺序（`session.queue` 里那条消息**离队**紧接在新的
// `session.start` 之前），以及**工具循环**（没有插话）仍是同一块（不回归 v2.2 已有行为）。
//
// 沙箱一律高位随机端口（绝不用 7331/7321）+ 临时 ASSIST_HOME/日志；只杀自己 spawn 的进程，
// 不用 pkill，不碰真实 profile。清理统一走 test/harness.mjs 的共享助手。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/steer-live-split.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'steer-live-split-'));

// ── 两段场景用到的文本（都是短句，方便在 DOM 里逐字认）───────────────────────
const RUN1_PROMPT = '先慢一点开场：甲。';
const RUN1_STEER = '插话：改成先讲结论。';
const TEXT_A = '甲段：工具之前说的一句正文。';
const TEXT_B = '乙段：插话之后才说出来的正文。';
const TEXT_C = '乙段续：插话之后又补一句。';
const RUN2_PROMPT = '不用工具，慢慢说：丙。';
const RUN2_STEER = '插话：换个说法。';
const TEXT_D = '丙段：插话之前的长正文。';
const TEXT_E = '丁段：插话之后的新正文。';
const RUN3_PROMPT = '第三场：慢工具 + 两次插话。';
const STEER3A = '插话三-A：先说结论。';
const STEER3B = '插话三-B：再给一条理由。';
const THINK3 = '先想一下：插话之后要先给结论，再补工具。';
const TEXT_C3 = '戊段：工具之前的正文。';
const TEXT_D3 = '己段：插话之后的新正文。';
const TEXT_E3 = '庚段：第二个工具之后的收尾。';
const RUN4_PROMPT = '第四场：断线重连里的插话。';
const RUN4_STEER = '插话四：断线时插的话。';
const TEXT_F = '辛段：断线之前工具里的正文。';
const TEXT_H = '癸段：断线期间插话之后的新正文。';

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reserveHighPort() {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321) continue;
    const available = await new Promise((resolve) => {
      const listener = net.createServer();
      listener.once('error', () => resolve(false));
      listener.listen(candidate, '127.0.0.1', () => listener.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

async function waitFor(operation, message, timeoutMs = 20_000) {
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

const chunkText = (text, count) => {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
};

// ── ① 真沙箱：A + B + 假 provider。同一个 provider 服务两种场景 ─────────────────
async function startSandbox() {
  const providerPort = await reserveHighPort();
  const basePort = await reserveHighPort();
  const appPort = await reserveHighPort();
  const home = path.join(sandbox, 'home');
  const cwd = path.join(sandbox, 'cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions', apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-steer', name: 'Fake Steer', contextWindow: 8192, maxTokens: 2048, reasoning: true }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake', defaultModel: 'fake-steer',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  const providerChunk = (delta, finishReason = null) => ({
    id: `chatcmpl-${finishReason ?? 'delta'}`, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: 'fake-steer',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const provider = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const users = body.messages.filter((message) => message.role === 'user');
    const last = users[users.length - 1]?.content;
    const lastUser = typeof last === 'string' ? last : JSON.stringify(last ?? '');
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (delta, finish = null) => response.write(`data: ${JSON.stringify(providerChunk(delta, finish))}\n\n`);
    const toolCount = body.messages.filter((message) => message.role === 'tool').length;
    if (lastUser.includes('插话四')) {
      for (const piece of chunkText(TEXT_H, 4)) { send({ role: 'assistant', content: piece }); await wait(400); }
      send({}, 'stop');
    } else if (lastUser.includes('插话三')) {
      if (toolCount >= 2) {
        for (const piece of chunkText(TEXT_E3, 3)) { send({ role: 'assistant', content: piece }); await wait(400); }
        send({}, 'stop');
      } else {
        for (const piece of chunkText(THINK3, 3)) { send({ reasoning_content: piece }); await wait(150); }
        send({ role: 'assistant', content: TEXT_D3 });
        await wait(150);
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-third', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 1; echo STEER_THIRD_TOOL' }) } }] });
        send({}, 'tool_calls');
      }
    } else if (lastUser.includes(RUN2_STEER)) {
      for (const piece of chunkText(TEXT_E, 2)) { send({ role: 'assistant', content: piece }); await wait(200); }
      send({}, 'stop');
    } else if (lastUser.includes(RUN1_STEER)) {
      for (const piece of chunkText(`${TEXT_B}${TEXT_C}`, 3)) { send({ role: 'assistant', content: piece }); await wait(200); }
      send({}, 'stop');
    } else if (lastUser.includes(RUN2_PROMPT)) {
      for (const piece of chunkText(TEXT_D, 4)) { send({ role: 'assistant', content: piece }); await wait(250); }
      send({}, 'stop');
    } else if (lastUser.includes(RUN3_PROMPT)) {
      send({ role: 'assistant', content: TEXT_C3 });
      await wait(150);
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-slow3', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 2; echo STEER_THIRD' }) } }] });
      send({}, 'tool_calls');
    } else if (lastUser.includes(RUN4_PROMPT)) {
      send({ role: 'assistant', content: TEXT_F });
      await wait(150);
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-slow4', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 2; echo STEER_FOURTH' }) } }] });
      send({}, 'tool_calls');
    } else {
      // 第一段场景的第一次请求：先说一句，然后调用一个**慢**工具（留出插话窗口）。
      send({ role: 'assistant', content: TEXT_A });
      await wait(150);
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-slow', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 3; echo STEER_TOOL_DONE' }) } }] });
      send({}, 'tool_calls');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(providerPort, '127.0.0.1', resolve); });

  const baseLog = await open(path.join(sandbox, 'base.log'), 'w');
  const appLog = await open(path.join(sandbox, 'app.log'), 'w');
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
  const api = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let value;
    try { value = raw ? JSON.parse(raw) : null; } catch { value = raw; }
    return { statusCode: response.status, value };
  };
  const stop = async () => {
    for (const child of [app, base]) {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      }
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    baseLog.close();
    appLog.close();
  };
  return { providerPort, basePort, appPort, api, stop };
}

// ── CDP 小工具（与其它门同一套最小实现）─────────────────────────────────────
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
    close() { socket.close(); },
  };
}

const RECORDER = `(() => {
  const root = document.querySelector('#messages');
  const ids = new WeakMap();
  let seq = 0;
  const idOf = (node) => { if (!ids.has(node)) ids.set(node, 'n' + (++seq)); return ids.get(node); };
  const bodyText = (node) => (node.querySelector('.message-body')?.textContent ?? node.textContent ?? '');
  window.__rec = [];
  window.__snap = (label) => {
    window.__rec.push({ label, at: Math.round(performance.now()), kids: Array.from(root.children).map((node) => ({
      id: idOf(node), kind: node.dataset.kind ?? null, role: node.dataset.role ?? null,
      live: node.classList.contains('live-message'), pending: node.dataset.pending ?? null,
      think: node.querySelectorAll('.message-thinking').length,
      tools: node.querySelectorAll('.tool-card').length,
      text: bodyText(node),
    })) });
  };
  const observer = new MutationObserver(() => window.__snap('mut'));
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  window.__snap('init');
  return true;
})()`;

const SETTLE_HINT = `(() => {
  const root = document.querySelector('#messages');
  return {
    live: root.querySelectorAll('.live-message').length,
    text: root.textContent ?? '',
    children: Array.from(root.children).map((node) => ({ kind: node.dataset.kind ?? null, role: node.dataset.role ?? null, text: node.querySelector('.message-body')?.textContent ?? node.textContent ?? '' })),
  };
})()`;

let browser;
let chromium;
let sandboxHandle;
let primaryError;

try {
  sandboxHandle = await startSandbox();
  const { appPort, api } = sandboxHandle;
  await waitFor(async () => (await api('/host')).statusCode === 200, 'sandbox A+B did not become ready');

  const created = await api('/sessions', { method: 'POST', body: { cwd: path.join(sandbox, 'cwd'), name: 'steer live split' } });
  assert.equal(created.statusCode, 201, `create failed: ${created.statusCode} ${JSON.stringify(created.value)}`);
  const sessionId = created.value.id;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  // 第三个场景另开一条会话（上下文干净，provider 只按**最后一条 user 消息**分支）。
  const created3 = await api('/sessions', { method: 'POST', body: { cwd: path.join(sandbox, 'cwd'), name: 'steer live split 3' } });
  assert.equal(created3.statusCode, 201, `create 3 failed: ${created3.statusCode} ${JSON.stringify(created3.value)}`);
  const sessionId3 = created3.value.id;
  const created4 = await api('/sessions', { method: 'POST', body: { cwd: path.join(sandbox, 'cwd'), name: 'steer live split 4' } });
  assert.equal(created4.statusCode, 201, `create 4 failed: ${created4.statusCode} ${JSON.stringify(created4.value)}`);
  const sessionId4 = created4.value.id;

  // 另开一条用户的 SSE（与浏览器页面并行）—— 拿原始帧，证「服务端记录/顺序是对的」。
  const openFrameStream = async (id) => {
    const state = { frames: [] };
    const request = http.request({ host: '127.0.0.1', port: appPort, path: `/api/sessions/${id}/events`, headers: { accept: 'text/event-stream' } });
    let buffer = '';
    await new Promise((resolve, reject) => {
      request.once('error', reject);
      request.once('response', (incoming) => {
        incoming.setEncoding('utf8');
        incoming.on('data', (raw) => {
          buffer += raw;
          let separator;
          while ((separator = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const eventLine = block.split('\n').find((line) => line.startsWith('event:'));
            const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
            if (eventLine && dataLine) state.frames.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
          }
        });
        resolve();
      });
      request.end();
    });
    await waitFor(() => state.frames.some((frame) => frame.event === 'session.snapshot'), 'no session.snapshot frame');
    return { ...state, request };
  };
  const { frames, request: sseRequest } = await openFrameStream(sessionId);

  const debugPort = await reserveHighPort();
  const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const pageProblems = [];
  browser = cdp(target.webSocketDebuggerUrl, pageProblems);
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Network.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
    return result.result.value;
  };
  const loaded = browser.once('Page.loadEventFired');
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await loaded;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId}"]') !== null`), 'session row did not render');
  await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt')?.disabled === false`), 'session did not open');
  await evaluate(RECORDER);
  const resetRecorder = () => evaluate(`window.__rec = []; window.__snap('reset'); true`);
  const snapshot = () => evaluate(SETTLE_HINT);

  const typeAndEnter = async (text) => {
    await evaluate(`(() => { const input = document.querySelector('#prompt'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  };

  // 记录一帧里「有没有一个节点同时含 A 与 B」以及各节点文本长度是这条门的核心判据。
  const analyze = (rec, before, after) => {
    const everBoth = new Set();
    const beforeNodes = new Map();
    const afterNodes = new Map();
    let firstAfter = null;
    let beforeAliveWhenAfterAppeared = false;
    for (const frame of rec) {
      for (const kid of frame.kids) {
        const hasBefore = kid.text.includes(before);
        const hasAfter = kid.text.includes(after);
        if (hasBefore && hasAfter) everBoth.add(kid.id);
        if (hasBefore) {
          const previous = beforeNodes.get(kid.id);
          if (!previous || previous.len < kid.text.length) beforeNodes.set(kid.id, { len: kid.text.length, at: frame.at });
        }
        if (hasAfter) {
          const previous = afterNodes.get(kid.id);
          if (!previous || previous.firstAt > frame.at) afterNodes.set(kid.id, { firstAt: frame.at, len: kid.text.length });
          if (firstAfter === null) {
            firstAfter = frame.at;
            beforeAliveWhenAfterAppeared = frame.kids.some((node) => node.text.includes(before));
          }
        }
      }
    }
    // 「旧节点不再增长」：以 after 首次出现的那一帧为界，旧节点在那之后的长度 == 之前最后量到的长度。
    const beforeAtAfter = new Map();
    for (const frame of rec) {
      if (firstAfter !== null && frame.at < firstAfter) continue;
      for (const kid of frame.kids) {
        if (!kid.text.includes(before)) continue;
        const previous = beforeAtAfter.get(kid.id) ?? 0;
        beforeAtAfter.set(kid.id, Math.max(previous, kid.text.length));
      }
    }
    const growthAfter = [...beforeAtAfter.entries()].filter(([id, len]) => {
      const beforeLen = beforeNodes.get(id)?.len ?? 0;
      return len > beforeLen;
    });
    return {
      everBoth: [...everBoth],
      beforeIds: [...beforeNodes.keys()],
      afterIds: [...afterNodes.keys()],
      firstAfter,
      beforeAliveWhenAfterAppeared,
      beforeAtAfter: [...beforeAtAfter.entries()],
      beforeLen: [...beforeNodes.entries()].map(([id, value]) => [id, value.len]),
      growthAfter,
      frames: rec.length,
    };
  };

  const checks = [];
  const check = (name, ok, detail) => {
    if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
    checks.push(name);
    print(`✓ ${name}`, detail);
  };

  // ── 场景①：工具循环中插话（真实会话 4bc978b2 的那个形态）──────────────────────
  await resetRecorder();
  await typeAndEnter(RUN1_PROMPT);
  // 等慢工具真的开跑（工具卡进直播块）；这时 agentBusy 为真，Enter 会走 steer。
  await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message .tool-card[data-state="running"]').length === 1`), 'slow tool card did not appear', 20_000);
  await typeAndEnter(RUN1_STEER);
  await waitFor(() => frames.some((frame) => frame.event === 'session.queue' && Array.isArray(frame.data.steering) && frame.data.steering.includes(RUN1_STEER)), 'steer was never queued server-side', 20_000);
  await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && (document.querySelector('#messages')?.textContent || '').includes(${JSON.stringify(TEXT_C)})`), 'run1 did not settle into history', 30_000);
  const run1Rec = await evaluate('window.__rec');
  const run1Snap = await snapshot();

  const run1 = analyze(run1Rec, TEXT_A, TEXT_B);
  print('运行①逐帧分析', run1);
  check('①-a 没有任何节点同时含「插话前」和「插话后」的正文（新内容不灌进旧气泡）', run1.everBoth.length === 0, JSON.stringify(run1.everBoth));
  check('①-b 插话前后的正文分别落在**不同**节点上', run1.beforeIds.length >= 1 && run1.afterIds.length >= 1 && !run1.beforeIds.some((id) => run1.afterIds.includes(id)), JSON.stringify({ beforeIds: run1.beforeIds, afterIds: run1.afterIds }));
  check('①-c 插话后的内容出现时，旧块的内容还在屏幕上（不丢段）', run1.beforeAliveWhenAfterAppeared === true, JSON.stringify({ firstAfter: run1.firstAfter }));
  check('①-d 插话之后旧节点的文本**不再增长**', run1.growthAfter.length === 0, JSON.stringify({ growthAfter: run1.growthAfter, beforeLen: run1.beforeLen }));

  const run1Order = run1Snap.children.map((child) => ({ role: child.role, kind: child.kind, text: child.text.slice(0, 24) }));
  print('运行①收尾时 #messages 子节点序列', run1Order);
  const indexOfText = (needle) => run1Snap.children.findIndex((child) => child.text.includes(needle));
  const aIndex = indexOfText(TEXT_A);
  const steerIndex = indexOfText(RUN1_STEER);
  const bIndex = indexOfText(TEXT_B);
  check('①-e 插话消息在正文流里，且夹在旧 assistant 与新 assistant 之间', aIndex >= 0 && steerIndex >= 0 && bIndex >= 0 && aIndex < steerIndex && steerIndex < bIndex, JSON.stringify({ aIndex, steerIndex, bIndex }));
  const joined = run1Snap.text;
  const countOf = (needle) => joined.split(needle).length - 1;
  check('①-f 与最终历史不丢不重（A/B/C/插话各只出现一次）', countOf(TEXT_A) === 1 && countOf(TEXT_B) === 1 && countOf(TEXT_C) === 1 && countOf(RUN1_STEER) === 1, JSON.stringify({ A: countOf(TEXT_A), B: countOf(TEXT_B), C: countOf(TEXT_C), steer: countOf(RUN1_STEER) }));
  check('①-g 收尾时直播块已全部收掉（不留 frozen 残块）', run1Snap.live === 0, JSON.stringify({ live: run1Snap.live }));

  const indexOfQueueAdd = (text, list = frames) => list.findIndex((frame) => frame.event === 'session.queue' && Array.isArray(frame.data.steering) && frame.data.steering.includes(text));
  const indexAfter = (from, predicate, list = frames) => { for (let index = from + 1; index < list.length; index += 1) if (predicate(list[index])) return index; return -1; };
  const lastBefore = (at, predicate, list = frames) => { let found = -1; for (let index = 0; index < at; index += 1) if (predicate(list[index])) found = index; return found; };
  const drainAfterAdd = (addIndex, list = frames) => indexAfter(addIndex, (frame) => frame.event === 'session.queue' && Array.isArray(frame.data.steering) && frame.data.steering.length === 0, list);

  const add1 = indexOfQueueAdd(RUN1_STEER);
  const drain1 = drainAfterAdd(add1);
  const endToolUse1 = lastBefore(drain1, (frame) => frame.event === 'session.end' && frame.data.stopReason === 'toolUse');
  const toolEnd1 = lastBefore(drain1, (frame) => frame.event === 'session.tool_end');
  const start1 = indexAfter(drain1, (frame) => frame.event === 'session.start');
  print('运行①插话前后的原始 SSE 帧', frames.slice(Math.max(0, endToolUse1), start1 + 1).map((frame) => `${frame.event} ${JSON.stringify(frame.data).slice(0, 120)}`));
  check('①-h 服务端顺序：end{toolUse} → tool_end → queue 离队（注入）→ 新的 session.start', endToolUse1 >= 0 && toolEnd1 >= 0 && drain1 === toolEnd1 + 1 && start1 === drain1 + 1, JSON.stringify({ add1, endToolUse1, toolEnd1, drain1, start1 }));
  const record1 = await api(`/sessions/${sessionId}/messages`);
  const roles1 = (record1.value.messages || []).map((message) => `${message.role}${message.stopReason ? `:${message.stopReason}` : ''}`);
  print('运行①服务端落盘顺序', roles1);
  assert.ok(roles1.join('|').includes('assistant:toolUse|toolResult|user|assistant:stop'), `落盘顺序必须把插话夹在两条 assistant 之间，实测 ${roles1.join('|')}`);

  // ── 场景②：没有工具的纯正文插话（session.end{stop} 收尾与插话注入挨在一起）──────
  await waitFor(() => evaluate(`document.querySelector('#abort').disabled === true`), 'session did not go idle before run2', 20_000);
  await resetRecorder();
  await typeAndEnter(RUN2_PROMPT);
  await waitFor(() => evaluate(`document.querySelector('#prompt').value === ''`), 'run2 prompt was not accepted', 10_000);
  await waitFor(() => evaluate(`(document.querySelector('.live-message .message-body')?.textContent || '').includes(${JSON.stringify(TEXT_D.slice(0, 6))})`), 'run2 live text did not start', 20_000);
  await typeAndEnter(RUN2_STEER);
  await waitFor(() => frames.some((frame) => frame.event === 'session.queue' && Array.isArray(frame.data.steering) && frame.data.steering.includes(RUN2_STEER)), 'run2 steer was never queued', 20_000);
  await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && (document.querySelector('#messages')?.textContent || '').includes(${JSON.stringify(TEXT_E)})`), 'run2 did not settle into history', 30_000);
  const run2Rec = await evaluate('window.__rec');
  const run2Snap = await snapshot();

  const run2 = analyze(run2Rec, TEXT_D, TEXT_E);
  print('运行②逐帧分析', run2);
  check('②-a 没有任何节点同时含插话前后的正文', run2.everBoth.length === 0, JSON.stringify(run2.everBoth));
  check('②-b 插话后的正文落在新节点上（旧节点不再增长）', run2.afterIds.length >= 1 && run2.growthAfter.length === 0, JSON.stringify({ afterIds: run2.afterIds, growthAfter: run2.growthAfter }));
  const indexOfText2 = (needle) => run2Snap.children.findIndex((child) => child.text.includes(needle));
  const dIndex = indexOfText2(TEXT_D);
  const steer2Index = indexOfText2(RUN2_STEER);
  const eIndex = indexOfText2(TEXT_E);
  check('②-c 插话消息夹在旧 assistant 与新 assistant 之间', dIndex >= 0 && steer2Index >= 0 && eIndex >= 0 && dIndex < steer2Index && steer2Index < eIndex, JSON.stringify({ dIndex, steer2Index, eIndex }));
  const joined2 = run2Snap.text;
  const count2 = (needle) => joined2.split(needle).length - 1;
  check('②-d 不丢不重（D/E/插话各一次）', count2(TEXT_D) === 1 && count2(TEXT_E) === 1 && count2(RUN2_STEER) === 1, JSON.stringify({ D: count2(TEXT_D), E: count2(TEXT_E), steer: count2(RUN2_STEER) }));
  const add2 = indexOfQueueAdd(RUN2_STEER);
  const drain2 = drainAfterAdd(add2);
  const endStop2 = lastBefore(drain2, (frame) => frame.event === 'session.end' && frame.data.stopReason === 'stop');
  const start2 = indexAfter(drain2, (frame) => frame.event === 'session.start');
  print('运行②插话前后的原始 SSE 帧', frames.slice(Math.max(0, endStop2), start2 + 1).map((frame) => `${frame.event} ${JSON.stringify(frame.data).slice(0, 120)}`));
  check('②-e 服务端顺序：end{stop} → queue 离队（注入）→ 新的 session.start', endStop2 >= 0 && drain2 === endStop2 + 1 && start2 === drain2 + 1, JSON.stringify({ add2, endStop2, drain2, start2 }));

  // ── 场景③：连续两次插话 + 插话后继续流式（新块的思考与工具卡）─────────────────
  const stream3 = await openFrameStream(sessionId3);
  const frames3 = stream3.frames;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId3}"] .tree-select') !== null`), 'session3 row missing', 15_000);
  await evaluate(`document.querySelector('[data-session-id="${sessionId3}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt')?.disabled === false`), 'session3 did not open');
  await resetRecorder();
  await typeAndEnter(RUN3_PROMPT);
  await waitFor(() => evaluate(`document.querySelector('#prompt').value === ''`), 'run3 prompt was not accepted', 10_000);
  await waitFor(() => evaluate(`(document.querySelector('.live-message .message-body')?.textContent || '').includes(${JSON.stringify(TEXT_C3.slice(0, 5))})`), 'run3 live text did not start', 20_000);
  await typeAndEnter(STEER3A);
  await typeAndEnter(STEER3B);
  await waitFor(() => frames3.some((frame) => frame.event === 'session.queue' && Array.isArray(frame.data.steering) && frame.data.steering.includes(STEER3A) && frame.data.steering.includes(STEER3B)), 'two steers were never queued', 20_000);
  // ④ 边界：插话后的新块里，思考与工具卡也在（都要进**新**块，不能掉回旧块）。
  // pi 的 steeringMode 是 one-at-a-time：两条插话会在**两个** turn 边界分别注入 ⇒ 两次 split、三块。
  await waitFor(() => evaluate(`(() => { const live = document.querySelector('.live-message'); return !!live && (live.querySelector('.message-body')?.textContent || '').includes(${JSON.stringify(TEXT_D3)}) && live.querySelectorAll('.message-thinking').length >= 1 && live.querySelectorAll('.tool-card').length >= 1; })()`), 'run3 new block did not carry thinking + tool card', 40_000);
  const run3Live = await evaluate(`(() => { const live = document.querySelector('.live-message'); return { think: live.querySelectorAll('.message-thinking').length, tools: live.querySelectorAll('.tool-card').length, text: live.querySelector('.message-body')?.textContent || '' }; })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && (document.querySelector('#messages')?.textContent || '').includes(${JSON.stringify(TEXT_E3)})`), 'run3 did not settle into history', 30_000);
  const run3Rec = await evaluate('window.__rec');
  const run3Snap = await snapshot();
  const run3 = analyze(run3Rec, TEXT_C3, TEXT_D3);
  const run3Tail = analyze(run3Rec, TEXT_D3, TEXT_E3);
  print('运行③逐帧分析（工具前→插话后）', run3);
  print('运行③逐帧分析（插话后→第二条插话后）', run3Tail);
  check('③-a 两次连续插话后，新正文也没灌进旧气泡（无节点同时含插话前后文本）', run3.everBoth.length === 0 && run3Tail.everBoth.length === 0, JSON.stringify({ first: run3.everBoth, second: run3Tail.everBoth }));
  const newBlockFrame = run3Rec.find((frame) => frame.kids.some((kid) => kid.text.includes(TEXT_D3) && kid.live && kid.think >= 1 && kid.tools >= 1));
  check('③-b 插话后继续流式：思考与工具卡都落在**新**直播块里', !!newBlockFrame && run3Live.think >= 1 && run3Live.tools >= 1, JSON.stringify({ newBlockFrame: !!newBlockFrame, live: { think: run3Live.think, tools: run3Live.tools } }));
  const order3 = run3Snap.children.map((child) => ({ role: child.role, text: child.text.slice(0, 20) }));
  print('运行③收尾时 #messages 子节点序列', order3);
  const find3 = (needle) => run3Snap.children.findIndex((child) => child.text.includes(needle));
  const cIndex = find3(TEXT_C3);
  const a3 = find3(STEER3A);
  const d3 = find3(TEXT_D3);
  const b3 = find3(STEER3B);
  const e3 = find3(TEXT_E3);
  check('③-c 两条插话各夹在「它打断的那条 assistant」与「它之后的 assistant」之间', cIndex >= 0 && a3 >= 0 && d3 >= 0 && b3 >= 0 && e3 >= 0 && cIndex < a3 && a3 < d3 && d3 < b3 && b3 < e3, JSON.stringify({ cIndex, a3, d3, b3, e3 }));
  const joined3 = run3Snap.text;
  const count3 = (needle) => joined3.split(needle).length - 1;
  check('③-d 不丢不重（C3/D3/E3/两条插话各一次）', count3(TEXT_C3) === 1 && count3(TEXT_D3) === 1 && count3(TEXT_E3) === 1 && count3(STEER3A) === 1 && count3(STEER3B) === 1, JSON.stringify({ C3: count3(TEXT_C3), D3: count3(TEXT_D3), E3: count3(TEXT_E3), A: count3(STEER3A), B: count3(STEER3B) }));
  check('③-e 连续两次插话 ⇒ 两次 split（插话后那条既不与旧块也不与下一条共节点）', run3.beforeIds.length >= 1 && run3.afterIds.length >= 1 && !run3.beforeIds.some((id) => run3.afterIds.includes(id)) && run3Tail.beforeIds.length >= 1 && run3Tail.afterIds.length >= 1 && !run3Tail.beforeIds.some((id) => run3Tail.afterIds.includes(id)), JSON.stringify({ first: { before: run3.beforeIds, after: run3.afterIds }, second: { before: run3Tail.beforeIds, after: run3Tail.afterIds } }));
  print('运行③原始 SSE 帧', frames3.map((frame) => `${frame.event} ${JSON.stringify(frame.data).slice(0, 90)}`));
  stream3.request.destroy();

  // ── 场景④：断线重连后再插话（错过 drain/session.start 的那种）─────────────────────
  // 页面离线时，插话被注入、新 assistant 消息的 `session.start` 与正文都发在了断线窗口里。
  // 重连后 `session.snapshot` 会把落盘的正文补回来（含插话那条 user 消息）。钉住：最终顺序
  // 仍然「旧 assistant → 插话 → 新 assistant」，且新旧正文不共节点、不丢不重。
  const stream4 = await openFrameStream(sessionId4);
  const frames4 = stream4.frames;
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId4}"] .tree-select') !== null`), 'session4 row missing', 15_000);
  await evaluate(`document.querySelector('[data-session-id="${sessionId4}"] .tree-select').click()`);
  await waitFor(() => evaluate(`document.querySelector('#prompt')?.disabled === false`), 'session4 did not open');
  await resetRecorder();
  await typeAndEnter(RUN4_PROMPT);
  await waitFor(() => evaluate(`document.querySelector('#prompt').value === ''`), 'run4 prompt was not accepted', 10_000);
  await waitFor(() => evaluate(`(document.querySelector('.live-message .message-body')?.textContent || '').includes(${JSON.stringify(TEXT_F.slice(0, 5))})`), 'run4 live text did not start', 20_000);
  await typeAndEnter(RUN4_STEER);
  await waitFor(() => frames4.some((frame) => frame.event === 'session.queue' && Array.isArray(frame.data.steering) && frame.data.steering.includes(RUN4_STEER)), 'run4 steer was never queued', 20_000);
  await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await waitFor(() => {
    const added = indexOfQueueAdd(RUN4_STEER, frames4);
    const drained = drainAfterAdd(added, frames4);
    const nextStart = indexAfter(drained, (frame) => frame.event === 'session.start', frames4);
    return drained >= 0 && nextStart === drained + 1;
  }, 'run4 did not reach the injected session.start while offline', 25_000);
  await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && (document.querySelector('#messages')?.textContent || '').includes(${JSON.stringify(TEXT_H)})`), 'run4 did not converge after reconnect', 45_000);
  const run4Rec = await evaluate('window.__rec');
  const run4Snap = await snapshot();
  const run4 = analyze(run4Rec, TEXT_F, TEXT_H);
  print('运行④逐帧分析（断线前→断线期间的插话正文）', run4);
  check('④-a 断线重连后新正文也没灌进旧气泡（无节点同时含断线前后文本）', run4.everBoth.length === 0, JSON.stringify(run4.everBoth));
  const find4 = (needle) => run4Snap.children.findIndex((child) => child.text.includes(needle));
  const f4 = find4(TEXT_F);
  const s4 = find4(RUN4_STEER);
  const h4 = find4(TEXT_H);
  check('④-b 重连后插话消息仍在正文流里，夹在旧 assistant 与新 assistant 之间', f4 >= 0 && s4 >= 0 && h4 >= 0 && f4 < s4 && s4 < h4, JSON.stringify({ f4, s4, h4 }));
  const joined4 = run4Snap.text;
  const count4 = (needle) => joined4.split(needle).length - 1;
  check('④-c 不丢不重（F/H/插话各一次）', count4(TEXT_F) === 1 && count4(TEXT_H) === 1 && count4(RUN4_STEER) === 1, JSON.stringify({ F: count4(TEXT_F), H: count4(TEXT_H), steer: count4(RUN4_STEER) }));
  print('运行④原始 SSE 帧', frames4.map((frame) => `${frame.event} ${JSON.stringify(frame.data).slice(0, 90)}`));
  stream4.request.destroy();

  // （没有插话的工具循环仍是同一块：`live-tools.mjs` 的 T2/T3 逐帧钉住了，这条门不再重跑一遍。）

  check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));
  print('chromium', { product: version.Browser, chrome });
  print('RESULT', `steer live split PASS (${checks.length} checks)`);
  sseRequest.destroy();
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'close browser', async () => { browser?.close(); });
  await cleanupStep(cleanupProblems, 'stop chromium', async () => {
    if (chromium && chromium.exitCode === null) {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    }
  });
  await cleanupStep(cleanupProblems, 'stop sandbox', async () => { await sandboxHandle?.stop(); });
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
