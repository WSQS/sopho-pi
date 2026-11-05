#!/usr/bin/env node
// test/thinking-stream.mjs —— 「流式中没有思考输出」这条用户报告的两半证据（真沙箱 A+B + 真 Chromium）。
//
// 为什么要有它：v2.2 的 `web/app.js` 在 `session.delta` 处理器里写死了
//   `if (data.channel !== 'text') return;`
// ⇒ 服务端照发的 `channel:"thinking"` 帧被前端整段丢弃：流式过程中看不到思考，
//   只在 `session.end` 重拉 `/messages` 时，那一坨思考才「啪」地出现（用户看到的高度跳变）。
// 用户已拍板走「甲」：流式中就**直接展开**显示完整思考（边流边长），不做折叠/淡色那种。
//
// 这条门把要求钉成机械可复现的数字：
//   ① 服务端**确实在线上**发了 thinking delta —— 真沙箱（A `server/base.mjs` + B `server/app.mjs` +
//      假上游）里打印**原始 SSE 帧**，断言 thinking 帧存在、且排在 text 帧之前；
//   ② 前端**真的边流边显**思考 —— 真 Chromium + 假 API：流式中读数直播块里的
//      `.thinking-body` 文本逐字等于思考内容（修前恒为 0）；
//   ③ **同构 + 到达顺序交错** —— 夹具故意送 thinking→text→thinking→text 四段，断言直播块的
//      DOM 顺序与结束后的历史顺序都是「按到达交错」，而不是「思考统一攒到正文前面/后面」；
//   ④ **对齐的收益可量化** —— 记录 `#messages.scrollHeight` 在 `session.end` 前后 + 流式各段的高度；
//      修前跳变 = 整块思考的高度，修后应只剩 markdown 重排；
//   ⑤ **甲的副作用** —— 思考直接展开 ⇒ 流式期间消息区变长更快；顺带断言全程贴底（dist≈0）；
//   ⑥ **工具卡独立一条** —— 直播期间就出现工具卡（`session.tool_start/end`），与结束后的正式卡同构；
//      量「结束那一刻」的高度变化，作为独立结论（本门不设工具阈值）。
//   ⑦ 正文口径不许变：直播正文与历史正文各自逐字相同、且只出现一次。
//
// 沙箱一律高位随机端口 + 临时 ASSIST_HOME/日志；不使用 7331/7321；不碰真实 profile；
// 不 pkill（只杀自己 spawn 的进程/浏览器）。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/thinking-stream.mjs
//   SOPHO_THINKING_LIMIT_JSON='{"endJumpPx":40}' node test/thinking-stream.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-thinking-'));
const history = '一段用来把滚动区域撑到真实会话量级的历史正文。'.repeat(30);

// ── 夹具 A（思考直播）：故意**交错**送四段，证明「按到达顺序」，不是「思考攒到前面」。──
const THINK_A = '先想清楚第一段：思考必须边流边显，不能等结束才蹦出来。'.repeat(4);
const TEXT_A = '第一段正文：紧跟在第一段思考之后到达。'.repeat(3);
const THINK_B = '第二段思考：交错到达也不许被拍平或挪到正文前面。'.repeat(4);
const TEXT_B = '第二段正文：排在第二段思考之后到达。'.repeat(3);
const THINKING = THINK_A + THINK_B;
const REPLY = TEXT_A + TEXT_B;
// 到达顺序（每段再切成分片）。
const SEGMENTS = [
  { channel: 'thinking', text: THINK_A },
  { channel: 'text', text: TEXT_A },
  { channel: 'thinking', text: THINK_B },
  { channel: 'text', text: TEXT_B },
];
const SEGMENT_ORDER = ['thinking', 'text', 'thinking', 'text'];
// 历史（正式消息）文本的比较口径：**按 wire 文本**、不再比「DOM 文本」逐字相等。
// 正式思考/正文现在走 marked（web/markdown.mjs）：marked 每个块 token 后补一个 `\n`，
// `breaks:true` 还把软换行变 `<br>` ⇒ `.textContent.length` 会比 wire 文本多出块分隔符。
// 这里两侧空白规范化（折叠连续空白、去首尾）后再比：断言仍是「正文内容等于上游那份」，
// 没有放宽成空断言、没有删断言。注意**直播块**（liveText / liveThinkingChars）不走 markdown ——
// 那条是纯文本 + appendData 的流式路径，下面仍保留**逐字相等**，不许跟着一起规范化。
const wireText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
// 结束后的历史 parts —— 与到达顺序同构（思考/正文交错，不是两段思考并一起）。
const THINK_PARTS = [
  { type: 'thinking', text: THINK_A },
  { type: 'text', text: TEXT_A },
  { type: 'thinking', text: THINK_B },
  { type: 'text', text: TEXT_B },
];

// ── 夹具 B（工具卡，独立一条）：`.session.tool_start/end` 现在真的上线了 ⇒ 流式中就画出工具卡；
//    这里量「修后」的结束跳变（修前的数字 417px 留在报告里）。──
// 夹具按**真形状**摆（只读普查 398 个真会话 / 58463 行）：带工具块的 assistant 消息里工具 part
// **一律在末尾** —— `thinking+tool` 13380 / `tool` 4470 / `thinking+text+tool` 2954 /
// `thinking+tool+tool` 2642 / `text+tool` 244 …；「工具 part 不是最后一块」= **0** 条。
// 旧夹具 `[tool×5, text]`（正文排在工具**之后**）在真数据里不存在 ⇒ 已改成 `[text, tool×5]`：
// 这也正是流式的到达顺序（正文先来、工具后来），结束交接因此不应重排。
const TOOL_REPLY = '这一轮正文很少，大部分时间在跑工具。'.repeat(3);
// 这一轮 assistant 消息的 entryId：有了它，顶层工具卡才会带 `data-part-of`，
// 「这些卡属于**这条** assistant 消息」才能被直接断言（而不是靠全页 `.tool-card` 数数）。
const TOOL_TURN_ID = 'a-tools';
const TOOL_PARTS = [
  { type: 'text', text: TOOL_REPLY },
  ...Array.from({ length: 5 }, (_, index) => ({
    type: 'tool',
    toolCallId: `call-tool-${index}`,
    name: 'read',
    args: { path: `/tmp/tool-${index}.txt` },
    result: `工具 ${index} 的结果正文。`.repeat(8),
    status: 'done-success',
  })),
];

const SESSION_THINKING = '88888888-8888-4888-8888-888888888888';
const SESSION_TOOLS = '99999999-9999-4999-8999-999999999999';

function chunk(text, count) {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
}

/** 把 [段] 展平成 SSE 帧（每段拆成 perSegment 个 delta），保留到达顺序。 */
function framesOf(segments, perSegment = 6) {
  const frames = [];
  for (const segment of segments) for (const delta of chunk(segment.text, perSegment)) frames.push({ channel: segment.channel, delta });
  return frames;
}

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

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

async function waitFor(operation, message, timeoutMs = 10_000) {
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

// ───────────────────────────── ① 真沙箱：原始 SSE 帧 ─────────────────────────────

function providerChunk(delta, finishReason = null) {
  return {
    id: `chatcmpl-${finishReason ?? 'delta'}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-thinking',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function runServerArm({ providerPort, basePort, appPort }) {
  const home = path.join(sandbox, 'server-home');
  const cwd = path.join(sandbox, 'server-cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-thinking', name: 'Fake Thinking', contextWindow: 8192, maxTokens: 2048, reasoning: true }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-thinking',
    defaultThinkingLevel: 'low',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  const provider = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    for await (const _ of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // 先 reasoning_content（pi 的 openai-completions 把它变成 `thinking_delta`）……
    for (const delta of chunk(THINKING, 6)) {
      response.write(`data: ${JSON.stringify(providerChunk({ reasoning_content: delta }))}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // ……再 content（`text_delta`）。
    for (const delta of chunk(REPLY, 6)) {
      response.write(`data: ${JSON.stringify(providerChunk({ content: delta }))}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    response.write(`data: ${JSON.stringify(providerChunk({}, 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(providerPort, '127.0.0.1', resolve); });

  const baseLog = await open(path.join(sandbox, 'base.log'), 'w');
  const appLog = await open(path.join(sandbox, 'app.log'), 'w');
  const base = spawn(process.execPath, [path.join(root, 'server', 'base.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'),
      PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: cwd, SOPHO_NO_TOOLS: '1', SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  const app = spawn(process.execPath, [path.join(root, 'server', 'app.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home, ASSIST_HOME: home,
      SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(basePort),
      SOPHO_WEB_ROOT: webRoot,
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });

  const api = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { statusCode: response.status, value };
  };

  let request;
  try {
    await waitFor(async () => (await api('/host')).statusCode === 200, 'sandbox A+B did not become ready', 20_000);
    const created = await api('/sessions', { method: 'POST', body: { cwd, name: 'thinking stream' } });
    assert.equal(created.statusCode, 201, `create failed: ${created.statusCode} ${JSON.stringify(created.value)}`);
    const sessionId = created.value.id;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);

    // 原始 SSE：接上事件的用户（照浏览器的接法）。
    request = http.request({
      host: '127.0.0.1', port: appPort, path: `/api/sessions/${sessionId}/events`,
      headers: { accept: 'text/event-stream' },
    });
    const frames = [];
    let buffer = '';
    await new Promise((resolve, reject) => {
      request.once('error', reject);
      request.once('response', (incoming) => {
        assert.equal(incoming.statusCode, 200, `SSE status ${incoming.statusCode}`);
        incoming.setEncoding('utf8');
        incoming.on('data', (text) => {
          buffer += text;
          let separator;
          while ((separator = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const eventLine = block.split('\n').find((line) => line.startsWith('event:'));
            const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
            if (eventLine && dataLine) frames.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
          }
        });
        resolve();
      });
      request.end();
    });
    await waitFor(() => frames.some((frame) => frame.event === 'session.snapshot'), 'no session.snapshot frame');

    const accepted = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '请先把想法说出来' } });
    assert.equal(accepted.statusCode, 202);
    await waitFor(() => frames.some((frame) => frame.event === 'session.end'), 'no session.end frame', 20_000);
    request.destroy();

    const deltas = frames.filter((frame) => frame.event === 'session.delta');
    const thinking = deltas.filter((frame) => frame.data.channel === 'thinking');
    const text = deltas.filter((frame) => frame.data.channel === 'text');
    const firstText = deltas.findIndex((frame) => frame.data.channel === 'text');
    const lastThinking = deltas.reduce((last, frame, index) => (frame.data.channel === 'thinking' ? index : last), -1);

    print('SSE 原始帧（会话事件流，逐帧原样）', frames.map((frame) => `${frame.event} ${JSON.stringify(frame.data)}`));
    print('SSE 通道统计', { total: deltas.length, thinking: thinking.length, text: text.length, firstTextIndex: firstText, lastThinkingIndex: lastThinking });

    assert.ok(thinking.length > 0, '服务端必须发出 channel:"thinking" 的 session.delta 帧');
    assert.ok(text.length > 0, '服务端必须发出 channel:"text" 的 session.delta 帧');
    assert.equal(thinking.map((frame) => frame.data.delta).join(''), THINKING, 'thinking 帧逐字拼起来必须等于上游思考');
    assert.equal(text.map((frame) => frame.data.delta).join(''), REPLY, 'text 帧逐字拼起来必须等于上游正文');
    assert.ok(lastThinking < firstText, `thinking 帧必须全部排在 text 帧之前，实测 lastThinking=${lastThinking} firstText=${firstText}`);

    const messages = await api(`/sessions/${sessionId}/messages`);
    const assistant = (messages.value.messages || []).find((message) => message.role === 'assistant');
    const parts = assistant?.parts || [];
    assert.equal(parts[0]?.type, 'thinking');
    assert.equal(parts[0]?.text, THINKING);
    print('落盘 parts', parts.map((part) => ({ type: part.type, chars: (part.text || '').length })));
    return { sessionId, deltas: deltas.length, thinkingFrames: thinking.length, textFrames: text.length };
  } finally {
    try { request?.destroy(); } catch {}
    for (const child of [app, base]) {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    baseLog.close();
    appLog.close();
  }
}

// ───────────────────────────── ② 真前端：边流边显 + 同构 + 顺序 + 跳变 ─────────────────────────────

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
    close() { socket.close(); },
  };
}

async function runFrontendArm({ port, baseMessages }) {
  const rows = [
    { id: SESSION_THINKING, name: '思考直播', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
    { id: SESSION_TOOLS, name: '工具卡', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-20T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  ];
  const state = new Map(rows.map((row) => [row.id, { messages: baseMessages, streaming: false, stream: null }]));

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
      if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
      if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions: rows, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
      if (url.pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: rows })}\n\n`);
        return;
      }
      const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events))?$/.exec(url.pathname);
      if (match) {
        const row = rows.find((item) => item.id === match[1]);
        const session = state.get(match[1]);
        if (!row || !session) return sendJson(response, 404, { message: 'not found' });
        const action = match[2] ?? null;
        if (action === null) return sendJson(response, 200, { name: row.name, runtime: { isStreaming: session.streaming, isCompacting: false, isRetrying: false }, observability: null });
        if (action === 'messages') return sendJson(response, 200, { messages: session.messages, extras: [], compaction: { atIndex: null }, observability: null });
        if (action === 'commands') return sendJson(response, 200, { streaming: session.streaming, commands: [] });
        if (action === 'seen') return sendJson(response, 200, { ok: true });
        if (action === 'draft') return sendJson(response, 200, { text: '' });
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: session.streaming, isCompacting: false, isRetrying: false, pendingMessages: 0 })}\n\n`);
          session.stream = response;
          response.once('close', () => { if (session.stream === response) session.stream = null; });
          return;
        }
      }
      if (url.pathname === '/api/test/event' && request.method === 'POST') {
        const chunks = [];
        for await (const part of request) chunks.push(part);
        const { sessionId, name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const session = state.get(sessionId);
        if (!session?.stream || session.stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
        if (name === 'session.start') session.streaming = true;
        if (name === 'session.end') session.streaming = false;
        session.stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === '/api/test/stream' && request.method === 'POST') {
        const chunks = [];
        for await (const part of request) chunks.push(part);
        const { sessionId, frames, paceMs } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const session = state.get(sessionId);
        if (!session?.stream || session.stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
        sendJson(response, 200, { ok: true, count: frames.length });
        for (const frame of frames) {
          if (session.stream.destroyed) return;
          session.stream.write(`event: session.delta\ndata: ${JSON.stringify({ channel: frame.channel, delta: frame.delta })}\n\n`);
          if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
        }
        return;
      }
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.resolve(webRoot, `.${pathname}`);
      if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
      try {
        const content = await readFile(file);
        response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
        response.end(content);
      } catch { response.writeHead(404).end(); }
    } catch (error) {
      try { response.writeHead(500).end(String(error && error.message)); } catch {}
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reserveHighPort(new Set([port]));
  const chromiumPath = process.env.CHROME_BIN || '/usr/bin/chromium';
  const chromium = spawn(chromiumPath, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank',
  ], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  let browser;
  try {
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
    const evaluate = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
      return result.result.value;
    };
    const metrics = async () => evaluate(`(() => {
      const root = document.querySelector('#messages');
      const live = document.querySelector('#messages .live-message');
      const order = (scope) => scope ? Array.from(scope.childNodes).map((node) => node.classList?.contains('message-thinking') ? 'thinking' : node.classList?.contains('tool-card') ? 'tool' : node.classList?.contains('markdown') ? 'text' : node.nodeType === 3 && node.data ? 'text' : null).filter(Boolean) : [];
      const body = live?.querySelector('.message-body');
      return {
        liveNodes: document.querySelectorAll('#messages .live-message').length,
        liveThinkingChars: live ? Array.from(live.querySelectorAll('.thinking-body')).map((node) => node.textContent).join('').length : 0,
        liveThinkingPresent: !!(live && live.querySelector('.thinking-body')),
        liveText: live ? Array.from((body?.childNodes || [])).filter((node) => node.nodeType === 3).map((node) => node.data).join('') : '',
        liveToolCards: live ? live.querySelectorAll('.tool-card').length : 0,
        toolCardsTotal: document.querySelectorAll('#messages .tool-card').length,
        // 收紧（业主 2026-09-22 平铺之后）：不再只数全页 .tool-card，而是按**所属 assistant 消息**
        // 收拢 —— 顶层工具卡带 data-part-of（= 那条消息的 entryId），只能算属于**这一轮**的；
        // 同时「页面上一张没有归属指针的历史工具卡」必须为 0（否则归属证明就没了）。
        toolCardsOfTurn: document.querySelectorAll('#messages .tool-card[data-part-of="${TOOL_TURN_ID}"]').length,
        toolCardsWithoutPartOf: document.querySelectorAll('#messages .tool-card:not([data-part-of])').length,
        // 这一轮的顶层块序列（按存储 parts 顺序逐字）：assistant 文章 + 每张工具卡。
        historyTurnBlocks: Array.from(document.querySelectorAll('#messages > *'))
          .filter((node) => (node.dataset.partOf || node.dataset.entryId) === "${TOOL_TURN_ID}")
          .map((node) => node.classList.contains('tool-card') ? 'tool' : node.classList.contains('message-assistant') ? 'text' : 'other'),
        liveOrder: order(body),
        historyOrderLast: order(document.querySelector('#messages .message-assistant:last-of-type .message-body')),
        historyThinkingParts: (() => { const last = document.querySelector('#messages .message-assistant:last-of-type'); return last ? Array.from(last.querySelectorAll('.thinking-body')).map((node) => (node.querySelector('.markdown') || node).textContent) : []; })(),
        historyTextParts: (() => { const last = document.querySelector('#messages .message-assistant:last-of-type'); return last ? Array.from(last.querySelectorAll('.message-body > .markdown')).map((node) => node.textContent) : []; })(),
        height: root.scrollHeight,
        top: root.scrollTop,
        dist: Math.round(root.scrollHeight - root.scrollTop - root.clientHeight),
      };
    })()`);
    const frames = async () => evaluate(`new Promise((resolve)=>{let left=3;const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
    const emit = async (sessionId, name, data = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, name, data }) });
      if (!response.ok) throw new Error(`emit ${name} failed ${response.status}`);
    };
    const stream = async (sessionId, frameList, paceMs) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/test/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, frames: frameList, paceMs }) });
      if (!response.ok) throw new Error(`stream failed ${response.status}`);
    };
    const selectSession = async (sessionId) => {
      await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
      // 两层都要等：① 服务端确实收到该会话的 SSE 连接（否则 emit 会 409）；② 正文已画。
      await waitFor(() => state.get(sessionId).stream !== null, `session ${sessionId} events stream did not connect`);
      await waitFor(() => evaluate(`document.querySelector('#prompt')?.disabled === false && document.querySelectorAll('#messages .message').length >= ${baseMessages.length}`), `session ${sessionId} messages did not render`);
    };

    await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor(() => evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${SESSION_THINKING}"]')`), 'page did not load');
    await selectSession(SESSION_THINKING);

    // ── 场景 A：思考 → 正文 → 思考 → 正文（交错到达）──────────────────────────
    await emit(SESSION_THINKING, 'session.start', { role: 'assistant' });
    const atStart = await metrics();

    const growth = [];
    const reads = {};
    let index = 0;
    for (const segment of SEGMENTS) {
      await stream(SESSION_THINKING, framesOf([segment]), 6);
      await frames();
      index += 1;
      const snapshot = await metrics();
      reads[index] = snapshot;
      growth.push({ segment: segment.channel, chars: segment.text.length, height: snapshot.height, dist: snapshot.dist });
    }
    // 直播块必须已经四段俱全、且 DOM 顺序 = 到达顺序。
    await waitFor(async () => (await metrics()).liveText === REPLY, 'live text did not reach the whole reply', 15_000);
    const duringThinking = reads[1];
    const beforeEnd = await metrics();

    // ── 结束：历史接管（parts 与到达顺序同构）──────────────────────────────
    state.get(SESSION_THINKING).messages = [...baseMessages, { role: 'assistant', parts: THINK_PARTS }];
    await emit(SESSION_THINKING, 'session.end', { stopReason: 'stop', errorMessage: null, text: REPLY });
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && !!document.querySelector('#messages .message-assistant:last-of-type .message-thinking')`), 'end did not converge to history', 15_000);
    await frames();
    const afterEnd = await metrics();
    const endJumpPx = afterEnd.height - beforeEnd.height;

    print('前端-思考直播（流式中读数）', {
      第一段思考后思考可见字符: duringThinking.liveThinkingChars,
      思考节点存在: duringThinking.liveThinkingPresent,
      期望思考字符: THINKING.length,
      直播正文可见字符: beforeEnd.liveText.length,
      期望正文字符: REPLY.length,
      直播块DOM顺序: beforeEnd.liveOrder,
      结束后历史DOM顺序: afterEnd.historyOrderLast,
    });
    print('前端-思考直播（流式各段高度，甲的副作用：思考也占高度）', {
      开播前: atStart.height,
      ...Object.fromEntries(growth.map((entry) => [`第${growth.indexOf(entry) + 1}段(${entry.segment})`, entry.height])),
      每段距底px: growth.map((entry) => entry.dist),
    });
    print('前端-思考直播（结束跳变：session.end 前后 #messages.scrollHeight）', {
      结束前高度: beforeEnd.height,
      结束后高度: afterEnd.height,
      跳变px: endJumpPx,
    });

    assert.equal(duringThinking.liveThinkingPresent, true, '流式过程中直播块必须已经有思考节点（修前不存在）');
    assert.equal(duringThinking.liveThinkingChars, THINK_A.length, '第一段思考到达后，直播块必须逐字显示它（修前恒为 0）');
    assert.equal(beforeEnd.liveThinkingChars, THINKING.length, '流式结束时直播块必须显示全部思考');
    assert.equal(beforeEnd.liveText, REPLY, '直播正文必须逐字等于回复');
    assert.deepEqual(beforeEnd.liveOrder, SEGMENT_ORDER, `直播块 DOM 顺序必须是按到达交错：${JSON.stringify(beforeEnd.liveOrder)}`);
    assert.deepEqual(afterEnd.historyOrderLast, SEGMENT_ORDER, `结束后历史 DOM 顺序必须同构：${JSON.stringify(afterEnd.historyOrderLast)}`);
    assert.deepEqual(afterEnd.historyThinkingParts.map(wireText), [wireText(THINK_A), wireText(THINK_B)], '结束后历史必须逐块逐字显示全部思考（按 wire 文本规范化空白比较）');
    assert.deepEqual(afterEnd.historyTextParts.map(wireText), [wireText(TEXT_A), wireText(TEXT_B)], '结束后历史 markdown 正文必须逐块逐字等于上游正文（按 wire 文本规范化空白比较）');
    // 甲的副作用：思考直接展开，全程应贴底（dist≈0），不能把用户甩在后面。
    for (const entry of growth) assert.ok(entry.dist <= 2, `流式段 ${entry.segment} 后应贴底跟随，实测距底 ${entry.dist}px`);

    // ── 场景 B（独立一条）：工具卡现在流式中就画（I-16）；量结束那一刻的跳变 ─────
    await selectSession(SESSION_TOOLS);
    await emit(SESSION_TOOLS, 'session.start', { role: 'assistant' });
    await stream(SESSION_TOOLS, framesOf([{ channel: 'text', text: TOOL_REPLY }]), 6);
    await waitFor(async () => (await metrics()).liveText === TOOL_REPLY, 'tool scenario live text did not arrive', 15_000);
    // 真实的 pi 先在带 toolCall 的那条助手消息结束时发 `stopReason:"toolUse"` 的 end，
    // 再逐个 `tool_start` → `tool_end`（原始帧见 test/live-tools.mjs 的服务端臂）。这里照真实序列发。
    await emit(SESSION_TOOLS, 'session.end', { stopReason: 'toolUse', errorMessage: null, text: TOOL_REPLY });
    for (const part of TOOL_PARTS.filter((item) => item.type === 'tool')) {
      await emit(SESSION_TOOLS, 'session.tool_start', { toolCallId: part.toolCallId, name: part.name, args: part.args });
      await emit(SESSION_TOOLS, 'session.tool_end', { toolCallId: part.toolCallId, name: part.name, isError: false, result: part.result });
    }
    await waitFor(async () => (await metrics()).liveToolCards === TOOL_PARTS.length - 1, 'live tool cards did not appear', 15_000);
    await frames();
    const toolsBeforeEnd = await metrics();
    state.get(SESSION_TOOLS).messages = [...baseMessages, { entryId: TOOL_TURN_ID, role: 'assistant', parts: TOOL_PARTS }];
    await emit(SESSION_TOOLS, 'session.end', { stopReason: 'stop', errorMessage: null, text: TOOL_REPLY });
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && document.querySelectorAll('#messages .tool-card[data-part-of="${TOOL_TURN_ID}"]').length === ${TOOL_PARTS.length - 1}`), 'tool scenario end did not converge', 15_000);
    await frames();
    const toolsAfterEnd = await metrics();
    const toolEndJumpPx = toolsAfterEnd.height - toolsBeforeEnd.height;

    print('前端-工具卡（直播中就出现；结束交接后同一工具只有一张卡）', {
      直播中工具卡数: toolsBeforeEnd.liveToolCards,
      结束后本轮工具卡数: toolsAfterEnd.toolCardsOfTurn,
      结束后无归属卡数: toolsAfterEnd.toolCardsWithoutPartOf,
      结束后全页卡数: toolsAfterEnd.toolCardsTotal,
      结束前高度: toolsBeforeEnd.height,
      结束后高度: toolsAfterEnd.height,
      工具卡结束跳变px: toolEndJumpPx,
      结束后本轮顶层块序: toolsAfterEnd.historyTurnBlocks,
      结束后历史DOM顺序: toolsAfterEnd.historyOrderLast,
    });
    assert.equal(toolsBeforeEnd.liveToolCards, TOOL_PARTS.length - 1, '直播期间每个工具一张卡（修前恒为 0）');
    // 收紧后：按「属于这条 assistant 消息」收拢（`data-part-of` = TOOL_TURN_ID），不再靠全页数数。
    assert.equal(toolsAfterEnd.toolCardsOfTurn, TOOL_PARTS.length - 1, '结束交接后属于这条 assistant 消息的工具卡恰好每个工具一张（不重复、不漏）');
    assert.equal(toolsAfterEnd.toolCardsWithoutPartOf, 0, '每张历史工具卡都必须带 data-part-of（说清它属于哪条 assistant 消息）');
    assert.equal(toolsAfterEnd.toolCardsTotal, TOOL_PARTS.length - 1, '结束交接后同一工具只有一张卡（不重复）');
    // 真形状：正文在前、工具在末尾 ⇒ 顶层块序 = 存储 parts 顺序逐字。
    assert.deepEqual(toolsAfterEnd.historyTurnBlocks, ['text', ...Array.from({ length: TOOL_PARTS.length - 1 }, () => 'tool')], `结束后这一轮的顶层块序必须 = 存储 parts 顺序：${JSON.stringify(toolsAfterEnd.historyTurnBlocks)}`);

    const limits = {
      // 思考已边流边显 ⇒ 结束时只剩 markdown 重排（段落边距/折叠头等），量级是「十几 px」，
      // 而不是「整块思考的高度」。修前/修后都在同一夹具上量过，见报告。
      endJumpPx: 50,
      ...(process.env.SOPHO_THINKING_LIMIT_JSON ? JSON.parse(process.env.SOPHO_THINKING_LIMIT_JSON) : {}),
    };
    const failures = [];
    if (Math.abs(endJumpPx) > limits.endJumpPx) failures.push(`思考直播结束跳变 ${endJumpPx}px > ${limits.endJumpPx}px（思考没边流边显时这里会是整块思考的高度）`);
    if (pageProblems.length) failures.push(`页面异常：${JSON.stringify(pageProblems)}`);
    if (failures.length) throw new Error(`thinking stream gate failed: ${failures.join(' | ')}`);
    return { chromium: version.Browser, endJumpPx, toolEndJumpPx, limits, growth };
  } finally {
    browser?.close();
    for (const session of state.values()) session.stream?.destroy();
    if (chromium && chromium.exitCode === null) {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const used = new Set();
const providerPort = await reserveHighPort(used); used.add(providerPort);
const basePort = await reserveHighPort(used); used.add(basePort);
const appPort = await reserveHighPort(used); used.add(appPort);
const frontPort = await reserveHighPort(used); used.add(frontPort);

const historyMessages = Array.from({ length: 60 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `历史消息 ${index + 1}：${history}` }],
}));

let primaryError;
try {
  await mkdir(sandbox, { recursive: true });
  const serverArm = await runServerArm({ providerPort, basePort, appPort });
  print('服务端臂结论', serverArm);
  assert.ok(serverArm.thinkingFrames > 0 && serverArm.textFrames > 0);
  const frontendArm = await runFrontendArm({ port: frontPort, baseMessages: historyMessages });
  print('前端臂结论', { chromium: frontendArm.chromium, endJumpPx: frontendArm.endJumpPx, toolEndJumpPx: frontendArm.toolEndJumpPx, limits: frontendArm.limits });
  print('沙箱', { home: sandbox, ports: { providerPort, basePort, appPort, frontPort }, forbiddenPortsUsed: false });
  print('RESULT', `thinking stream PASS（thinking 帧 ${serverArm.thinkingFrames} 个；流式中思考可见 ${THINKING.length} 字、顺序 ${JSON.stringify(SEGMENT_ORDER)}；思考结束跳变 ${frontendArm.endJumpPx}px；工具卡结束跳变 ${frontendArm.toolEndJumpPx}px）`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}