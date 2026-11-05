#!/usr/bin/env node
// test/live-tools.mjs —— 「流式过程里看不见工具卡（I-16）」+「真空时没有『思考中…』（I-22）」两半证据。
//
// 为什么要有它：v2.2 的 `server/base-logic.mjs` 的 `eventPayload()` 对 pi 的
//   `tool_execution_start/end` **没有任何映射**（落到 `return null`）⇒ 工具事件不上线；
// 前端也只订阅 snapshot/start/delta/queue/compaction/end/error（grep 不到 tool）。
// 于是「跑工具」那几秒没有**直播**工具卡：只有 `session.end {stopReason:"toolUse"}` 触发的
// 一次整块 `/messages` 重拉，才把服务端标着 running 的卡搬上屏（而且卡的状态要等**下一段**
// 助手消息结束才翻）。
//
// 这条门把要求钉成机械可复现的数字：
//   ① 服务端**确实在线上**发了工具帧 —— 真沙箱（A `server/base.mjs` + B `server/app.mjs` +
//      假上游真跑一次 bash）里打印**原始 SSE 帧**，断言 `session.tool_start/end` 存在、
//      id/name/args/result 对得上、且排在 `stopReason:"toolUse"` 的 end 之后、下一段 start 之前；
//   ② 前端**流式中就画出工具卡** —— 真 Chromium + 假 API：`tool_start` 到达后直播块里**有**
//      `.tool-card[data-state="running"]`（修前恒为 0）；
//   ③ **就地更新** —— `tool_end` 到达后同一张卡（卡片总数不增）翻成 done-success/done-error，
//      且直播块**没有被整块重建**（正文文本节点对象不变，用打标验证）；
//   ④ **同构** —— 直播卡与结束后的正式卡走 `web/render.js` 的同一个 `toolCard()`；结束交接后
//      同一工具只有**一张**卡（不重复）；
//   ⑤ **顺序** —— 连续多个工具、工具与正文交错，都按到达顺序（与历史同构）；
//   ⑥ **出错** —— `isError:true` ⇒ done-error + `.tool-bad`；
//   ⑦ **「思考中…」** —— 只在直播块真的什么都没得画（没有思考/正文/工具）时出现，一有内容就消失；
//   ⑧ **卡数 == SSE 工具帧数**；
//   ⑨ **结束跳变** —— 量 `session.end` 前后 `#messages.scrollHeight` 的差值，作为「工具卡那一跳」的数字。
//   ⑩ **工具耗时的时间基准**（TUI 平价，2026-09-20 加）—— `session.tool_start` / `session.tool_end`
//      带服务端观测到的 `startedAt` / `endedAt`（可解析、有序、差值 0…60s），且落盘那张工具卡的
//      `startedAt`/`endedAt`（= entry 的 timestamp）也在。两条尺子各自的耗时原样打印出来对照。
//
// 沙箱一律高位随机端口 + 临时 ASSIST_HOME/日志；不使用 7331/7321；不碰真实 profile；
// 不 pkill（只杀自己 spawn 的进程/浏览器）。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/live-tools.mjs

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
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-livetools-'));
const history = '一段用来把滚动区域撑到真实会话量级的历史正文。'.repeat(30);

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

// ───────────────────────────── ① 真沙箱：原始 SSE 帧（工具真的跑了） ─────────────────────────────

const TOOL_OUT = 'LIVE_TOOLS_SERVER_ARM_OUTPUT';
const TEXT_BEFORE = '动手之前先说一句。';
const TEXT_AFTER = '工具跑完了，收个尾。';

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
        api: 'openai-completions', apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-tools', name: 'Fake Tools', contextWindow: 8192, maxTokens: 2048 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake', defaultModel: 'fake-tools',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  const providerChunk = (delta, finishReason = null) => ({
    id: `chatcmpl-${finishReason ?? 'delta'}`, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: 'fake-tools',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const provider = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (!hasToolResult) {
      response.write(`data: ${JSON.stringify(providerChunk({ role: 'assistant', content: TEXT_BEFORE }))}\n\n`);
      response.write(`data: ${JSON.stringify(providerChunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-server-arm', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `echo ${TOOL_OUT}` }) } }] }))}\n\n`);
      response.write(`data: ${JSON.stringify(providerChunk({}, 'tool_calls'))}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify(providerChunk({ role: 'assistant', content: TEXT_AFTER }))}\n\n`);
      response.write(`data: ${JSON.stringify(providerChunk({}, 'stop'))}\n\n`);
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
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    return { statusCode: response.status, value };
  };

  let request;
  try {
    await waitFor(async () => (await api('/host')).statusCode === 200, 'sandbox A+B did not become ready', 20_000);
    const created = await api('/sessions', { method: 'POST', body: { cwd, name: 'live tools' } });
    assert.equal(created.statusCode, 201, `create failed: ${created.statusCode} ${JSON.stringify(created.value)}`);
    const sessionId = created.value.id;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);

    request = http.request({ host: '127.0.0.1', port: appPort, path: `/api/sessions/${sessionId}/events`, headers: { accept: 'text/event-stream' } });
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

    const accepted = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '跑一个真工具' } });
    assert.equal(accepted.statusCode, 202);
    await waitFor(() => frames.filter((frame) => frame.event === 'session.end').length >= 2, 'no two session.end frames', 30_000);
    request.destroy();

    const toolStarts = frames.filter((frame) => frame.event === 'session.tool_start');
    const toolEnds = frames.filter((frame) => frame.event === 'session.tool_end');
    const toolUseEndIndex = frames.findIndex((frame) => frame.event === 'session.end' && frame.data.stopReason === 'toolUse');
    const startIndex = frames.findIndex((frame) => frame.event === 'session.tool_start');
    const endIndex = frames.findIndex((frame) => frame.event === 'session.tool_end');
    const nextStartIndex = frames.findIndex((frame, index) => index > endIndex && frame.event === 'session.start');

    print('SSE 原始帧（会话事件流，逐帧原样）', frames.map((frame) => `${frame.event} ${JSON.stringify(frame.data)}`));
    print('SSE 工具帧统计', { toolStarts: toolStarts.length, toolEnds: toolEnds.length, toolUseEndIndex, startIndex, endIndex, nextStartIndex });

    assert.equal(toolStarts.length, 1, '服务端必须转发一次 session.tool_start');
    assert.equal(toolEnds.length, 1, '服务端必须转发一次 session.tool_end');
    assert.equal(toolStarts[0].data.toolCallId, 'call-server-arm');
    assert.equal(toolStarts[0].data.name, 'bash');
    assert.equal(toolStarts[0].data.args.command, `echo ${TOOL_OUT}`);
    assert.equal(toolEnds[0].data.toolCallId, 'call-server-arm');
    assert.equal(toolEnds[0].data.isError, false);
    assert.match(toolEnds[0].data.result, new RegExp(TOOL_OUT));
    // 工具耗时（TUI 平价，2026-09-20 加）：这两个事件带**服务端观测到**的起止时间。
    // ⚠️ pi 的 `tool_execution_start/end` 本身没有时间戳（`dist/core/agent-session.js:528-556`），
    // 所以这里是 `eventPayload()` 收到事件那一刻的 `new Date().toISOString()` —— 只断言「有、能解析、有序」，
    // 不假装它是 pi 给的字段。
    const frameStarted = Date.parse(toolStarts[0].data.startedAt);
    const frameEnded = Date.parse(toolEnds[0].data.endedAt);
    assert.ok(Number.isFinite(frameStarted), `session.tool_start 必须带可解析的 startedAt（实测 ${JSON.stringify(toolStarts[0].data.startedAt)}）`);
    assert.ok(Number.isFinite(frameEnded), `session.tool_end 必须带可解析的 endedAt（实测 ${JSON.stringify(toolEnds[0].data.endedAt)}）`);
    assert.ok(frameEnded >= frameStarted && frameEnded - frameStarted < 60_000, `观测到的工具耗时应当是 0…60s（实测 ${frameEnded - frameStarted}ms）`);
    assert.ok(toolUseEndIndex >= 0 && startIndex === toolUseEndIndex + 1, `tool_start 必须紧跟 stopReason:"toolUse" 的 end（toolUseEndIndex=${toolUseEndIndex} startIndex=${startIndex}）`);
    assert.ok(endIndex > startIndex && nextStartIndex > endIndex, `顺序必须是 start < end < 下一段 start（${startIndex} < ${endIndex} < ${nextStartIndex}）`);

    const messages = await api(`/sessions/${sessionId}/messages`);
    const assistant = (messages.value.messages || []).find((message) => message.role === 'assistant');
    const toolPart = (assistant?.parts || []).find((part) => part.type === 'tool');
    assert.ok(toolPart, '落盘历史里必须有这条工具卡');
    assert.equal(toolPart.status, 'done-success');
    assert.match(toolPart.result, new RegExp(TOOL_OUT));
    // 同一次调用在**两条不同的尺子**上都得有时间（它们量的是同一件事，但观察者不同）：
    //   · SSE 那两个 = 服务端收到 pi 事件那一刻；
    //   · 落盘 part 这两个 = 会话文件里 entry 的 timestamp（`startedAt` 取自带 toolCall 的 assistant entry）。
    assert.ok(Number.isFinite(Date.parse(toolPart.startedAt)) && Number.isFinite(Date.parse(toolPart.endedAt)),
      `落盘工具卡必须带 startedAt/endedAt（实测 ${JSON.stringify({ startedAt: toolPart.startedAt, endedAt: toolPart.endedAt })}）`);
    const partStarted = Date.parse(toolPart.startedAt);
    const partEnded = Date.parse(toolPart.endedAt);
    assert.ok(partEnded >= partStarted, `落盘工具卡的 endedAt 不得早于 startedAt（实测 ${partEnded - partStarted}ms）`);
    print('工具耗时（同一次调用，两条尺子）', { SSE观测ms: frameEnded - frameStarted, 落盘entry时间戳ms: partEnded - partStarted });
    print('落盘工具 parts', { toolCallId: toolPart.toolCallId, status: toolPart.status, resultChars: (toolPart.result || '').length, startedAt: toolPart.startedAt, endedAt: toolPart.endedAt });
    return { sessionId, toolStarts: toolStarts.length, toolEnds: toolEnds.length };
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

// ───────────────────────────── ② 真前端：直播工具卡 + 就地更新 + 空态「思考中…」 ─────────────────────────────

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
    close() { socket.close(); },
  };
}

const SESSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEXT_1 = '先给一句正文，让直播块里不只有工具。';
const TEXT_2 = '工具之后又说了两句。';
const LONG_RESULT = Array.from({ length: 16 }, (_, index) => `line-${index + 1}: ${'x'.repeat(50)}`).join('\n');
// T2 结束夹具那**一轮**的 entryId（真形状：工具 part 恒在消息末尾 ⇒ 工具跑完后的续写正文属于
// **下一条** assistant 消息，不再和工具挤在同一条里；只读普查 398 个真会话：「工具 part 不是最后
// 一块」= 0 条）。两条都列进来，量「这一轮」的顺序时才不会漏掉续写那一半。
const TURN_ENTRIES = ['a-turn', 'a-turn-2'];

async function runFrontendArm({ port, baseMessages }) {
  const rows = [{ id: SESSION_ID, name: '直播工具卡', parentId: null, archived: false, status: 'working', statusLabel: '工作中', unread: false, modifiedAt: '2026-09-21T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } }];
  const session = { messages: baseMessages, streaming: false, stream: null };
  const toolFrameCount = { start: 0 };

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
        if (!row) return sendJson(response, 404, { message: 'not found' });
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
        const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!session.stream || session.stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
        if (name === 'session.start') session.streaming = true;
        // `stopReason:"toolUse"` 的 end 之后这一轮**还没完**（工具要跑）；只有 terminal 的 end 才落幕。
        if (name === 'session.end' && data?.stopReason !== 'toolUse') session.streaming = false;
        if (name === 'session.tool_start') toolFrameCount.start += 1;
        session.stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === '/api/test/stream' && request.method === 'POST') {
        const chunks = [];
        for await (const part of request) chunks.push(part);
        const { frames, paceMs } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!session.stream || session.stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
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
      const live = root.querySelector('.live-message');
      // 平铺（业主 2026-09-22）：流式期间也是**顶层块**（assistant 段 + 顶层工具卡）—— 工具卡不再
      // 嵌在 .message-body 里。所以顺序/正文都按 .live-message 的块逐个读（同一把尺子量流式与结束）。
      const bodies = live ? Array.from(live.querySelectorAll('.message-body')) : [];
      const order = (scope) => scope ? Array.from(scope.childNodes).map((node) => node?.classList?.contains('message-thinking') ? 'thinking' : node?.classList?.contains('tool-card') ? 'tool' : node?.classList?.contains('markdown') ? 'text' : (node?.nodeType === 3 && node.data) ? 'text' : null).filter(Boolean) : [];
      const liveOrder = () => {
        if (!live) return [];
        const out = [];
        for (const child of live.children) {
          if (child.classList.contains('tool-card')) { out.push('tool'); continue; }
          if (child.classList.contains('message-assistant')) out.push(...order(child.querySelector('.message-body')));
        }
        return out;
      };
      const liveBodyText = () => bodies.map((body) => Array.from(body.childNodes).filter((node) => node.nodeType === 3).map((node) => node.data).join('')).join('');
      // 平铺（业主 2026-09-22）：工具卡是 #messages 的**顶层块**，不再是 assistant 块的子孙。
      // 所以「这一轮」按**所属 assistant 消息的 entryId** 把文章与工具块收拢（工具块带 data-part-of）。
      // 真形状下工具 part 恒在消息末尾 ⇒ 工具之后的续写正文属于**下一条** assistant 消息，
      // 所以按 TURN_ENTRIES（本轮那几条）收拢，而不是只认「最后一条 assistant」（会漏掉续写）。
      const TURN = ${JSON.stringify(TURN_ENTRIES)};
      const inTurn = (id) => TURN.includes(id);
      const turnOrder = () => {
        const out = [];
        for (const node of root.children) {
          if (node.classList.contains('tool-card') && inTurn(node.dataset.partOf)) { out.push('tool'); continue; }
          if (node.classList.contains('message-assistant') && inTurn(node.dataset.entryId)) out.push(...order(node.querySelector('.message-body')));
        }
        return out;
      };
      const historyTools = Array.from(root.querySelectorAll('.tool-card')).filter((node) => inTurn(node.dataset.partOf));
      return {
        live: root.querySelectorAll('.live-message').length,
        liveCards: live ? live.querySelectorAll('.tool-card').length : 0,
        liveThink: live ? live.querySelectorAll('.think').length : 0,
        liveThinkText: live?.querySelector('.think')?.textContent || '',
        liveText: liveBodyText(),
        liveOrder: liveOrder(),
        liveStates: live ? Array.from(live.querySelectorAll('.tool-card')).map((node) => node.dataset.state) : [],
        liveBad: live ? live.querySelectorAll('.tool-card.tool-bad').length : 0,
        liveResult: live ? Array.from(live.querySelectorAll('.tool-result')).map((node) => node.textContent).join(' || ') : '',
        liveCollapsed: live?.querySelector('.tool-card')?.dataset.collapsed || null,
        cards: root.querySelectorAll('.tool-card').length,
        cardStates: Array.from(root.querySelectorAll('.tool-card')).map((node) => node.dataset.state),
        historyEntry: TURN.join(','),
        historyCards: historyTools.length,
        historyOrder: turnOrder(),
        historyResult: historyTools.map((node) => node.querySelector('.tool-result')?.textContent ?? '').join(' || '),
        historyCollapsed: historyTools[0]?.dataset.collapsed || null,
        height: root.scrollHeight,
        dist: Math.round(root.scrollHeight - root.scrollTop - root.clientHeight),
      };
    })()`);
    const frames = async (count = 3) => evaluate(`new Promise((resolve)=>{let left=${count};const step=()=>{left-=1;if(left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);
    const emit = async (name, data = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/test/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, data }) });
      if (!response.ok) throw new Error(`emit ${name} failed ${response.status}`);
    };
    const stream = async (frameList, paceMs = 4) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/test/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frames: frameList, paceMs }) });
      if (!response.ok) throw new Error(`stream failed ${response.status}`);
    };
    const chunk = (text, count = 4) => {
      const size = Math.max(1, Math.ceil(text.length / count));
      const out = [];
      for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
      return out;
    };
    const streamText = async (text) => {
      for (const delta of chunk(text)) { await stream([{ channel: 'text', delta }], 4); await frames(1); }
    };

    await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor(() => evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${SESSION_ID}"]')`), 'page did not load');
    await evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"] .tree-select').click()`);
    await waitFor(() => session.stream !== null, 'session events stream did not connect');
    await waitFor(() => evaluate(`document.querySelector('#prompt')?.disabled === false && document.querySelectorAll('#messages .message').length >= ${baseMessages.length}`), 'messages did not render');

    const checks = [];
    const check = (name, ok, detail) => {
      if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
      checks.push(name);
      print(`✓ ${name}`, detail);
    };

    // ── T1：空态「思考中…」只在真的没东西可画时出现 ─────────────────────────────
    await emit('session.start', { role: 'assistant' });
    await frames();
    const atStart = await metrics();
    check('开播即空：直播块出现「✻ 思考中…」占位', atStart.live === 1 && atStart.liveThink === 1 && atStart.liveThinkText.includes('思考中'), JSON.stringify({ live: atStart.live, think: atStart.liveThinkText }));
    await streamText(TEXT_1);
    await waitFor(async () => (await metrics()).liveText === TEXT_1, 'first text did not render');
    const afterText = await metrics();
    check('一有正文，「思考中…」立刻消失', afterText.liveThink === 0 && afterText.liveText === TEXT_1, JSON.stringify({ think: afterText.liveThink, text: afterText.liveText.length }));

    // ── T2：单个工具（running → 就地翻 done → 结束交接不重复 / 量结束跳变）────────
    // `stopReason:"toolUse"` 的 end：这一轮还没完 —— 直播块必须留着，不能当收尾。
    await emit('session.end', { stopReason: 'toolUse', errorMessage: null, text: TEXT_1 });
    await frames();
    const afterToolUse = await metrics();
    check('stopReason:"toolUse" 的 end 不收尾：直播块留着、正文还在、不补「思考中…」', afterToolUse.live === 1 && afterToolUse.liveText === TEXT_1 && afterToolUse.liveThink === 0, JSON.stringify({ live: afterToolUse.live, text: afterToolUse.liveText.length, think: afterToolUse.liveThink }));

    // 给直播块里那个正文文本节点打标：tool_end 之后它必须还是同一个对象（证明没有整块重建）。
    await evaluate(`(() => { const body=document.querySelector('.live-message .message-body'); const textNode=Array.from(body.childNodes).find((n)=>n.nodeType===3); textNode.__probe='keep'; return textNode.__probe; })()`);

    await emit('session.tool_start', { toolCallId: 'call-live', name: 'bash', args: { command: 'echo hi' } });
    await waitFor(async () => (await metrics()).liveCards === 1, 'live tool card did not appear', 8000);
    const toolRunning = await metrics();
    check('tool_start 后：直播块里出现一张运行中的工具卡', toolRunning.liveCards === 1 && toolRunning.liveStates[0] === 'running' && toolRunning.liveOrder.includes('tool'), JSON.stringify({ cards: toolRunning.liveCards, states: toolRunning.liveStates, order: toolRunning.liveOrder }));
    check('直播卡里的工具名与参数与事件一致', (await evaluate(`document.querySelector('.live-message .tool-name')?.textContent`)) === 'bash' && (await evaluate(`document.querySelector('.live-message .tool-args')?.textContent`)) === 'echo hi', await evaluate(`JSON.stringify([document.querySelector('.live-message .tool-name')?.textContent, document.querySelector('.live-message .tool-args')?.textContent])`));

    await emit('session.tool_end', { toolCallId: 'call-live', name: 'bash', isError: false, result: 'hi\n' });
    await waitFor(async () => (await metrics()).liveStates[0] === 'done-success', 'live tool card did not flip to done-success', 8000);
    const toolDone = await metrics();
    check('tool_end 后：**同一张卡**就地翻成 done-success（卡片总数不增）', toolDone.liveCards === 1 && toolDone.cards === 1 && toolDone.liveResult.includes('hi'), JSON.stringify({ liveCards: toolDone.liveCards, cards: toolDone.cards, result: toolDone.liveResult }));
    const probeKept = await evaluate(`document.querySelector('.live-message .message-body')?.childNodes?.[0]?.__probe === 'keep'`);
    check('就地更新：正文文本节点对象没被换掉（直播块没整块重建）', probeKept === true, `probe=${probeKept}`);

    // 下一段助手消息：直播块继续用同一块（不 reset）。
    await emit('session.start', { role: 'assistant' });
    await streamText(TEXT_2);
    await waitFor(async () => (await metrics()).liveText.includes(TEXT_2), 'continuation text did not render');
    const interleaved = await metrics();
    check('工具与正文交错：直播块 DOM 顺序 = 到达顺序(正文→工具→正文)', JSON.stringify(interleaved.liveOrder) === JSON.stringify(['text', 'tool', 'text']) && interleaved.liveCards === 1, JSON.stringify({ order: interleaved.liveOrder, cards: interleaved.liveCards }));

    // 结束交接：历史与直播同构，同一工具只能有一张卡。
    // 结束夹具按**真形状**摆：工具 part 在消息末尾，工具跑完后的续写正文是**下一条** assistant 消息
    // （旧夹具 `[text, tool, text]` 把工具夹在中间，真数据里 0 条 ⇒ 已改）。
    const beforeEnd = await metrics();
    session.messages = [
      ...baseMessages,
      { entryId: 'a-turn', role: 'assistant', parts: [{ type: 'text', text: TEXT_1 }, { type: 'tool', toolCallId: 'call-live', name: 'bash', args: { command: 'echo hi' }, status: 'done-success', result: 'hi\n' }] },
      { entryId: 'a-turn-2', role: 'assistant', parts: [{ type: 'text', text: TEXT_2 }] },
    ];
    await emit('session.end', { stopReason: 'stop', errorMessage: null, text: TEXT_2 });
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && document.querySelectorAll('#messages .tool-card').length === 1`), 'end did not converge to a single history card', 10_000);
    await frames();
    const afterEnd = await metrics();
    const toolEndJumpPx = afterEnd.height - beforeEnd.height;
    check('结束交接：同一工具只剩一张卡（不重复）', afterEnd.live === 0 && afterEnd.cards === 1 && afterEnd.historyCards === 1 && afterEnd.cardStates[0] === 'done-success', JSON.stringify({ live: afterEnd.live, cards: afterEnd.cards, history: afterEnd.historyCards, states: afterEnd.cardStates }));
    check('结束交接后历史 DOM 顺序与直播同构', JSON.stringify(afterEnd.historyOrder) === JSON.stringify(['text', 'tool', 'text']), JSON.stringify(afterEnd.historyOrder));

    // ── T3：连续多个工具 + 出错（isError）───────────────────────────────────────
    const framesBeforeT3 = toolFrameCount.start;
    await emit('session.start', { role: 'assistant' });
    await frames();
    await emit('session.tool_start', { toolCallId: 'call-a', name: 'read', args: { path: '/tmp/a.txt' } });
    await emit('session.tool_end', { toolCallId: 'call-a', name: 'read', isError: false, result: 'A_OK\n' });
    await emit('session.tool_start', { toolCallId: 'call-b', name: 'bash', args: { command: 'exit 3' } });
    await emit('session.tool_end', { toolCallId: 'call-b', name: 'bash', isError: true, result: 'command failed\n' });
    await waitFor(async () => (await metrics()).liveCards === 2, 'two live tool cards did not appear', 8000);
    const twoTools = await metrics();
    check('连续多个工具：两张直播卡、状态各自对（成功 + 出错）', JSON.stringify(twoTools.liveStates) === JSON.stringify(['done-success', 'done-error']) && twoTools.liveCards === 2, JSON.stringify({ states: twoTools.liveStates }));
    check('出错的卡带 .tool-bad 且结果正文在卡里', twoTools.liveBad === 1 && twoTools.liveResult.includes('command failed'), JSON.stringify({ bad: twoTools.liveBad, result: twoTools.liveResult }));
    check('卡数 == SSE 工具帧数（本场景新增 2 个 start）', toolFrameCount.start - framesBeforeT3 === 2 && twoTools.liveCards === 2, `frames=${toolFrameCount.start - framesBeforeT3} cards=${twoTools.liveCards}`);

    session.messages = [...baseMessages, { entryId: 'a-turn', role: 'assistant', parts: [{ type: 'tool', toolCallId: 'call-a', name: 'read', args: { path: '/tmp/a.txt' }, status: 'done-success', result: 'A_OK\n' }, { type: 'tool', toolCallId: 'call-b', name: 'bash', args: { command: 'exit 3' }, status: 'done-error', isError: true, result: 'command failed\n' }] }];
    await emit('session.end', { stopReason: 'stop', errorMessage: null, text: '' });
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && document.querySelectorAll('#messages .tool-card').length === 2`), 'two-tool end did not converge', 10_000);
    await frames();
    const twoToolsAfterEnd = await metrics();
    check('两个工具结束交接后仍是两张卡（各一张，不重复）', twoToolsAfterEnd.cards === 2 && JSON.stringify(twoToolsAfterEnd.cardStates) === JSON.stringify(['done-success', 'done-error']), JSON.stringify({ cards: twoToolsAfterEnd.cards, states: twoToolsAfterEnd.cardStates }));

    // ── T4：长输出卡（默认折叠）在直播与历史里同构 ─────────────────────────────
    await emit('session.start', { role: 'assistant' });
    await frames();
    await emit('session.tool_start', { toolCallId: 'call-long', name: 'bash', args: { command: 'cat big.txt' } });
    await emit('session.tool_end', { toolCallId: 'call-long', name: 'bash', isError: false, result: LONG_RESULT });
    await waitFor(async () => (await metrics()).liveCollapsed !== null, 'long tool card did not settle', 8000);
    const longLive = await metrics();
    session.messages = [...baseMessages, { entryId: 'a-turn', role: 'assistant', parts: [{ type: 'tool', toolCallId: 'call-long', name: 'bash', args: { command: 'cat big.txt' }, status: 'done-success', result: LONG_RESULT }] }];
    await emit('session.end', { stopReason: 'stop', errorMessage: null, text: '' });
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && document.querySelectorAll('#messages .tool-card').length === 1`), 'long-tool end did not converge', 10_000);
    await frames();
    const longHistory = await metrics();
    check('长输出卡：直播与历史的默认折叠状态一致（同一套 toolCard）', longLive.liveCollapsed === 'true' && longHistory.historyCollapsed === 'true' && longLive.liveResult === longHistory.historyResult, JSON.stringify({ live: longLive.liveCollapsed, history: longHistory.historyCollapsed, sameLen: longLive.liveResult.length === longHistory.historyResult.length }));

    // ── T5：对照 —— 不发工具帧（= 修前行为），工具卡只能在 session.end 那一刻长出来 ──
    // 这是「工具卡那一跳」的**修前基线**：同一段流、同一个工具，只是服务端不转发工具事件。
    const CONTROL_RESULT = 'control line 1\ncontrol line 2\ncontrol line 3';
    session.messages = baseMessages;
    // 先把正文重拉回 baseMessages（抹掉上一场景留在历史里的卡），量到的基线才是「零张图」的。
    await emit('session.start', { role: 'assistant' });
    await emit('session.end', { stopReason: 'stop', errorMessage: null, text: '' });
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && document.querySelectorAll('#messages .tool-card').length === 0`), 'control baseline did not clear the history card', 10_000);
    await emit('session.start', { role: 'assistant' });
    await streamText(TEXT_1);
    await waitFor(async () => (await metrics()).liveText === TEXT_1, 'control live text did not render');
    await frames();
    const controlBefore = await metrics();
    session.messages = [...baseMessages, { entryId: 'a-turn', role: 'assistant', parts: [{ type: 'text', text: TEXT_1 }, { type: 'tool', toolCallId: 'call-control', name: 'bash', args: { command: 'echo hi' }, status: 'done-success', result: CONTROL_RESULT }] }];
    await emit('session.end', { stopReason: 'stop', errorMessage: null, text: TEXT_1 });
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && document.querySelectorAll('#messages .tool-card').length === 1`), 'control end did not converge', 10_000);
    await frames();
    const controlAfter = await metrics();
    const controlJumpPx = controlAfter.height - controlBefore.height;
    check('对照（不发工具帧）：直播块里没有工具卡，卡片只在 end 一次性长出来', controlBefore.liveCards === 0 && controlAfter.cards === 1, JSON.stringify({ liveCards: controlBefore.liveCards, cards: controlAfter.cards }));
    check('直播工具卡把「工具卡那一跳」消掉（对照跳变 > 直播跳变）', controlJumpPx > toolEndJumpPx && controlJumpPx > 20, JSON.stringify({ 对照跳变px: controlJumpPx, 直播跳变px: toolEndJumpPx }));

    // ── T6：中断（aborted）—— 工具卡翻 done-error，terminal end 收尾 ──────────────
    session.messages = baseMessages;
    await emit('session.start', { role: 'assistant' });
    await emit('session.tool_start', { toolCallId: 'call-abort', name: 'bash', args: { command: 'sleep 30' } });
    await waitFor(async () => (await metrics()).liveCards === 1, 'abort-case live card did not appear', 8000);
    // 真沙箱实测：中断一个在跑的工具 ⇒ `session.tool_end {isError:true,result:"Command aborted"}`，
    // 随后下一段 `session.start` + `stopReason:"aborted"` 的 terminal end（原始帧在报告里）。
    await emit('session.tool_end', { toolCallId: 'call-abort', name: 'bash', isError: true, result: 'Command aborted' });
    await waitFor(async () => (await metrics()).liveStates[0] === 'done-error', 'abort-case card did not flip to done-error', 8000);
    session.messages = [...baseMessages, { entryId: 'a-turn', role: 'assistant', parts: [{ type: 'tool', toolCallId: 'call-abort', name: 'bash', args: { command: 'sleep 30' }, status: 'done-error', isError: true, result: 'Command aborted' }] }];
    await emit('session.end', { stopReason: 'aborted', errorMessage: null, text: '' });
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0 && document.querySelectorAll('#messages .tool-card').length === 1`), 'abort terminal end did not clear the live block', 10_000);
    await frames();
    const afterAbort = await metrics();
    check('中断：工具卡翻成 done-error，terminal end 把直播块收掉（不残留）', afterAbort.live === 0 && afterAbort.cards === 1 && afterAbort.cardStates[0] === 'done-error', JSON.stringify({ live: afterAbort.live, cards: afterAbort.cards, states: afterAbort.cardStates }));

    // ── T7：terminal end 丢了 —— `session.settled` 兜底收尾 ───────────────────────
    session.messages = baseMessages;
    await emit('session.start', { role: 'assistant' });
    await emit('session.tool_start', { toolCallId: 'call-stuck', name: 'bash', args: { command: 'sleep 30' } });
    await waitFor(async () => (await metrics()).liveCards === 1, 'stuck-case live card did not appear', 8000);
    session.messages = [...baseMessages, { entryId: 'a-turn', role: 'assistant', parts: [{ type: 'tool', toolCallId: 'call-stuck', name: 'bash', args: { command: 'sleep 30' }, status: 'unfinished' }] }];
    await emit('session.settled', {}); // 故意不发 session.end
    await waitFor(() => evaluate(`document.querySelectorAll('#messages .live-message').length === 0`), 'settled fallback did not clear the live block', 10_000);
    await frames();
    const afterSettled = await metrics();
    check('end 丢了：session.settled 兜底把直播块收掉（不永久残留）', afterSettled.live === 0 && afterSettled.cards === 1, JSON.stringify({ live: afterSettled.live, cards: afterSettled.cards }));

    check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));

    return { checks, toolEndJumpPx, controlJumpPx, beforeEndHeight: beforeEnd.height, afterEndHeight: afterEnd.height, chromium: version.Browser, toolFrames: toolFrameCount.start };
  } finally {
    browser?.close();
    session.stream?.destroy();
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
  assert.ok(serverArm.toolStarts > 0 && serverArm.toolEnds > 0);
  const frontendArm = await runFrontendArm({ port: frontPort, baseMessages: historyMessages });
  print('前端臂结论', {
    checks: frontendArm.checks.length,
    chromium: frontendArm.chromium,
    直播工具卡结束跳变px: frontendArm.toolEndJumpPx,
    对照无工具帧结束跳变px: frontendArm.controlJumpPx,
    结束前高度: frontendArm.beforeEndHeight,
    结束后高度: frontendArm.afterEndHeight,
    SSE工具帧数: frontendArm.toolFrames,
  });
  print('沙箱', { home: sandbox, ports: { providerPort, basePort, appPort, frontPort }, forbiddenPortsUsed: false });
  print('RESULT', `live tools PASS（SSE tool_start/end 各 ${serverArm.toolStarts} 帧；前端 ${frontendArm.checks.length} 项检查；工具卡结束跳变 直播 ${frontendArm.toolEndJumpPx}px vs 对照 ${frontendArm.controlJumpPx}px）`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}