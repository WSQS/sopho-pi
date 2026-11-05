#!/usr/bin/env node
// test/tool-state-sync.mjs —— 「工具卡还显示运行中，助手的下一个思考块已经在下面了」这条用户报告的逐帧证据。
//
// 为什么要单独一条门：v2.2 的工具卡状态**只在 refreshMessages() 里画**（`web/render.js:98-99`
// 从 part.status 取），而 refreshMessages 只有 4 个调用点（session.snapshot / compaction_end /
// session.end / 切会话，见 `web/app.js`）。**工具开始/结束都不重画**；服务端 `eventPayload()`
// 也**根本没有**把 pi 的 `tool_execution_*` 事件映射成任何 SSE 帧（`server/base-logic.mjs:1296-1321`，
// 末尾 `return null`）。⇒ 一张卡可能在整整「下一段思考」里都停在「运行中」。
//
// 这条门用**真 A+B + 假上游 + 真工具 + 真 Chromium** 造出那条窗口，抓四个时刻：
//   ① 工具卡首次显示为「运行中」（DOM data-state=running）
//   ② 工具**真的结束**（判据一：`GET /messages` 里该 part 的 status 翻成 done-success；判据二：假上游收到第 2 个请求）
//   ③ 下一个思考节点首次插进 DOM（`.live-message .thinking-body` 出现）
//   ④ 工具卡变「完成」（DOM data-state=done-success）
// 并用原始 SSE 帧列出「②→④ 之间线上到底发了什么」。
//
// 用法：CHROME_BIN=/usr/bin/chromium node test/tool-state-sync.mjs
// 可选：SOPHO_TOOL_SLEEP_S=4（工具时长）  SOPHO_TOOLSYNC_LIMIT_JSON='{"maxLagMs":1500}'

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-toolsync-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-toolsync');
const TOOL_SLEEP_S = Number(process.env.SOPHO_TOOL_SLEEP_S || 4);
// 工具**真的跑过**的机械证据：命令自己 echo 一个标记，它必须原样出现在被转发的
// `session.tool_end.result` 里（不是夹具自己编的字符串）。
const TOOL_MARK = `PI_REAL_TOOL_MARK_${TOOL_SLEEP_S}`;
const TOOL_CMD = `echo ${TOOL_MARK}; sleep ${TOOL_SLEEP_S}`;
const TOOL_CALL_ID = 'call_sleep_1';
const THINK_2 = '工具已经跑完了，现在开始第二段思考：这一段思考是在工具结果之后到达的。'.repeat(6);
const TEXT_2 = '第二段正文：排在第二段思考之后。'.repeat(2);
const TEXT_1 = '第一段正文：马上要调一个慢工具。';

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

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
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function chunk(text, count) {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
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

// ───────────────────────── 假上游（OpenAI completions）：慢工具 → 思考 ─────────────────────────

function providerChunk(delta, finishReason = null) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-tool',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function toolCallChunk(command = TOOL_CMD, id = TOOL_CALL_ID) {
  return providerChunk({
    tool_calls: [{
      index: 0,
      id,
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command }) },
    }],
  });
}

async function runGate() {
  const used = new Set();
  const providerPort = await reserveHighPort(used); used.add(providerPort);
  const basePort = await reserveHighPort(used); used.add(basePort);
  const appPort = await reserveHighPort(used); used.add(appPort);
  const home = path.join(sandbox, 'home');
  const cwd = path.join(sandbox, 'cwd');
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-tool', name: 'Fake Tool', contextWindow: 32768, maxTokens: 2048, reasoning: true }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-tool',
    defaultThinkingLevel: 'low',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  // 假上游：第 1 个请求 ⇒ 正文 + 一个慢工具调用；第 2 个请求（工具结果已在上下文里）⇒ 思考 + 正文。
  // 第 2 个请求的**到达时刻**就是「工具真的跑完、结果已回到 pi」的独立证据。
  const providerArrivals = [];
  const provider = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const part of request) raw += part;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const hasToolResult = (body.messages || []).at(-1)?.role === 'tool';
    providerArrivals.push({ at: Date.now(), index: providerArrivals.length + 1, hasToolResult });
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (!hasToolResult) {
      for (const delta of chunk(TEXT_1, 2)) {
        response.write(`data: ${JSON.stringify(providerChunk({ content: delta }))}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const callIndex = providerArrivals.filter((arrival) => !arrival.hasToolResult).length;
      response.write(`data: ${JSON.stringify(toolCallChunk(`echo ${TOOL_MARK}; sleep ${callIndex === 1 ? TOOL_SLEEP_S : TOOL_SLEEP_S + 2}`, `call_sleep_${callIndex}`))}\n\n`);
      response.write(`data: ${JSON.stringify(providerChunk({}, 'tool_calls'))}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    for (const delta of chunk(THINK_2, 12)) {
      response.write(`data: ${JSON.stringify(providerChunk({ reasoning_content: delta }))}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    for (const delta of chunk(TEXT_2, 4)) {
      response.write(`data: ${JSON.stringify(providerChunk({ content: delta }))}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
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
      SOPHO_DEFAULT_CWD: cwd, SOPHO_MAX_HOT: '4',
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

  let chromium;
  let browser;
  let sseRequest;
  try {
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

    await waitFor(async () => (await api('/host')).statusCode === 200, 'sandbox A+B did not become ready', 20_000);
    const created = await api('/sessions', { method: 'POST', body: { cwd, name: '工具卡状态' } });
    assert.equal(created.statusCode, 201, `create failed: ${created.statusCode} ${JSON.stringify(created.value)}`);
    const sessionId = created.value.id;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);

    // ① 原始 SSE 帧（照浏览器的接法，独立一条连接），带到达时间戳。
    const frames = [];
    sseRequest = http.request({
      host: '127.0.0.1', port: appPort, path: `/api/sessions/${sessionId}/events`,
      headers: { accept: 'text/event-stream' },
    });
    let buffer = '';
    await new Promise((resolve, reject) => {
      sseRequest.once('error', reject);
      sseRequest.once('response', (incoming) => {
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
            if (eventLine) frames.push({
              at: Date.now(),
              event: eventLine.slice(6).trim(),
              data: dataLine ? JSON.parse(dataLine.slice(5).trim()) : null,
            });
          }
        });
        resolve();
      });
      sseRequest.end();
    });
    await waitFor(() => frames.some((frame) => frame.event === 'session.snapshot'), 'no session.snapshot frame');

    // ② 真 Chromium 打在**真 app** 上。
    const debugPort = await reserveHighPort(new Set([appPort, basePort, providerPort]));
    const chromiumPath = process.env.CHROME_BIN || '/usr/bin/chromium';
    chromium = spawn(chromiumPath, [
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
    const evaluate = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
      return result.result.value;
    };

    await browser.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    await waitFor(() => evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${sessionId}"]')`), 'page did not load', 20_000);
    await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
    await waitFor(() => evaluate(`document.querySelector('#prompt')?.disabled === false`), 'session did not open');

    // 时间线探针：MutationObserver + 50ms 采样。签名去重，只留状态真的变了的那些时刻。
    // 同时区分「直播块里的卡」与「消息列表里的历史卡」——用户报的正是「列表里那张过期的卡」。
    const PROBE_JS = `(() => {
      if (window.__tlTimer) clearInterval(window.__tlTimer);
      const tl = { events: [], last: '' };
      window.__tl = tl;
      const snap = () => {
        const cardEls = Array.from(document.querySelectorAll('#messages .tool-card'));
        const cards = cardEls.map((card) => card.dataset.state);
        const live = document.querySelector('#messages .live-message');
        const liveCards = live ? live.querySelectorAll('.tool-card').length : 0;
        const listCards = cardEls.filter((card) => !live || !live.contains(card)).length;
        const liveThinking = live ? Array.from(live.querySelectorAll('.thinking-body')).map((n) => n.textContent).join('').length : 0;
        const body = live?.querySelector('.message-body');
        const liveText = live ? Array.from(body?.childNodes || []).filter((n) => n.nodeType === 3).map((n) => n.data).join('').length : 0;
        return {
          cards,
          liveCards,
          listCards,
          liveThinking,
          liveText,
          runningCards: cards.filter((s) => s === 'running').length,
          doneCards: cards.filter((s) => s === 'done-success').length,
        };
      };
      const commit = (why) => {
        const s = snap();
        const sig = [s.cards.join('|'), s.liveCards, s.listCards, s.liveThinking > 0 ? 1 : 0, s.liveText > 0 ? 1 : 0].join('#');
        if (sig === tl.last) return;
        tl.last = sig;
        tl.events.push({ t: Date.now(), why, ...s });
      };
      const observer = new MutationObserver(() => commit('mutation'));
      observer.observe(document.querySelector('#messages'), { subtree: true, childList: true, attributes: true, characterData: true });
      window.__tlTimer = setInterval(() => commit('tick'), 50);
      commit('install');
      return true;
    })()`;
    await evaluate(PROBE_JS);

    // ③ 服务端 payload 轮询：工具 part 的 status 真值（独立于 DOM 的判据）。
    const payloadProbes = [];
    const payloadOf = async (why) => {
      const messages = await api(`/sessions/${sessionId}/messages`);
      const list = messages.value?.messages || [];
      const tools = [];
      list.forEach((message, index) => {
        for (const part of message.parts || []) {
          if (part.type === 'tool') tools.push({ messageIndex: index, name: part.name, status: part.status, hasResult: part.result !== undefined });
        }
      });
      const assistantParts = list.filter((m) => m.role === 'assistant').map((m, i) => (m.parts || []).map((p) => `${p.type}:${p.status ?? '-'}`));
      const probe = { at: Date.now(), why, messageCount: list.length, tools, assistantParts };
      payloadProbes.push(probe);
      return probe;
    };
    let pollStop = false;
    const pollPromise = (async () => {
      while (!pollStop) {
        await payloadOf('poll').catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })();

    // ④ 发消息，跑这一轮。
    const sentAt = Date.now();
    const accepted = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '请先调一个慢工具，然后再想一段' } });
    assert.equal(accepted.statusCode, 202, `message failed: ${accepted.statusCode} ${JSON.stringify(accepted.value)}`);

    const geometryAt = async () => evaluate(`(() => {
      const card = document.querySelector('#messages .tool-card');
      const live = document.querySelector('#messages .live-message');
      const thinking = live?.querySelector('.message-thinking');
      const rect = (node) => node ? { top: Math.round(node.getBoundingClientRect().top), bottom: Math.round(node.getBoundingClientRect().bottom), height: Math.round(node.getBoundingClientRect().height) } : null;
      const root = document.querySelector('#messages');
      return {
        工具卡状态: card?.dataset.state ?? null,
        工具卡文案: card?.textContent ?? null,
        工具卡几何: rect(card),
        直播块几何: rect(live),
        思考块几何: rect(thinking),
        工具卡在思考块之上: !!(card && thinking && card.getBoundingClientRect().bottom <= thinking.getBoundingClientRect().top + 1),
        消息区高度: root.scrollHeight,
      };
    })()`);
    await mkdir(artifactRoot, { recursive: true });
    const shoot = async (name) => {
      const shot = await browser.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(artifactRoot, `tool-state-sync-${name}-${Date.now()}.png`);
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      return file;
    };

    // 时刻③：下一个思考节点刚进 DOM 那一瞬 —— 这就是用户看到的「卡还在运行中，思考已经在下面」的画面。
    await waitFor(() => evaluate(`window.__tl.events.some((e) => e.liveThinking > 0)`), 'no live thinking node appeared', 60_000);
    const bugMoment = {
      at: Date.now(),
      ...(await geometryAt()),
      events: await evaluate(`window.__tl.events.slice(-6)`),
      screenshot: null,
    };
    bugMoment.screenshot = await shoot('bug-moment');

    // 窗口中期：思考已经长出一大截，卡还在运行中（用户真正看到的那几秒）。
    await waitFor(() => evaluate(`(() => { const live = document.querySelector('#messages .live-message'); return live ? Array.from(live.querySelectorAll('.thinking-body')).map((n) => n.textContent).join('').length >= 150 : false; })()`), 'thinking did not grow past 150 chars', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const midWindow = {
      at: Date.now(),
      ...(await geometryAt()),
      liveThinkingChars: await evaluate(`(() => { const live = document.querySelector('#messages .live-message'); return live ? Array.from(live.querySelectorAll('.thinking-body')).map((n) => n.textContent).join('').length : 0; })()`),
      screenshot: null,
    };
    midWindow.screenshot = await shoot('mid-window');

    // 时刻④：工具卡终于变完成。
    await waitFor(() => evaluate(`window.__tl.events.some((e) => e.doneCards > 0)`), 'timeline did not reach a done tool card', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    pollStop = true;
    await pollPromise;

    const timeline = await evaluate(`({ events: window.__tl.events, page: window.__tl.page || null })`);
    const events = timeline.events;
    const firstRunning = events.find((e) => e.runningCards > 0) || null;
    const firstThinking = events.find((e) => e.liveThinking > 0) || null;
    const firstDone = events.find((e) => e.doneCards > 0) || null;
    // payload 判据：工具 part 第一次不再是 running。
    let toolDonePayload = null;
    for (const probe of payloadProbes) {
      if (probe.tools.length && probe.tools.every((tool) => tool.status !== 'running')) { toolDonePayload = probe; break; }
    }
    const firstRunningProbe = payloadProbes.find((probe) => probe.tools.some((tool) => tool.status === 'running')) || null;
    const toolArrival = providerArrivals.find((arrival) => arrival.hasToolResult) || null;

    const geometry = await geometryAt();
    const screenshotFile = await shoot('after-done');

    const lagMs = firstDone && toolDonePayload ? firstDone.t - toolDonePayload.at : null;
    const thinkingGapMs = firstDone && firstThinking ? firstDone.t - firstThinking.t : null;

    // ②→④ 之间线上到底发了什么（去掉心跳）：证明「工具结束」根本没有任何帧。
    const deadZoneFrames = toolDonePayload
      ? frames.filter((frame) => frame.at >= toolDonePayload.at && frame.at <= (firstDone?.t ?? Infinity))
        .map((frame) => `${frame.event}@+${frame.at - toolDonePayload.at}ms ${JSON.stringify(frame.data)}`)
      : [];

    print('① 四个时刻（DOM 时间线，毫秒绝对时刻 Date.now()）', {
      工具卡首次运行中: firstRunning?.t ?? null,
      工具真实结束_payload判据: toolDonePayload?.at ?? null,
      工具真实结束_假上游收到结果请求: toolArrival?.at ?? null,
      下一个思考节点首次进DOM: firstThinking?.t ?? null,
      工具卡首次变完成: firstDone?.t ?? null,
      发送消息时刻: sentAt,
    });
    print('① 滞后（ms）', {
      工具真结束到卡变完成_payload判据: lagMs,
      思考先进DOM到卡变完成: thinkingGapMs,
      发送到卡显示运行中: firstRunning ? firstRunning.t - sentAt : null,
    });
    print('② DOM 时间线（状态真的变了的那些帧，取前 40 条）', events.slice(0, 40).map((e) => ({ 'Δms': e.t - sentAt, why: e.why, 运行中: e.runningCards, 完成: e.doneCards, 思考字符: e.liveThinking, 正文字符: e.liveText })));
    print('③ payload 真值（GET /sessions/{id}/messages 轮询）', {
      工具运行中时的一条: firstRunningProbe ? { at: firstRunningProbe.at, tools: firstRunningProbe.tools, assistantParts: firstRunningProbe.assistantParts } : null,
      工具结束后的一条: toolDonePayload ? { at: toolDonePayload.at, tools: toolDonePayload.tools, assistantParts: toolDonePayload.assistantParts } : null,
      轮询样本数: payloadProbes.length,
    });
    print('③ 最终 payload 摘录（messages[].parts 概览）', {
      messages: (await api(`/sessions/${sessionId}/messages`)).value.messages.map((message, index) => ({ index, role: message.role, parts: (message.parts || []).map((part) => ({ type: part.type, status: part.status ?? null, chars: String(part.text ?? part.result ?? '').length })) })),
    });
    print('④ SSE 原始帧（工具结束 → 卡变完成这段窗口）', deadZoneFrames);
    print('④ SSE 原始帧（全部，去掉心跳）', frames.filter((f) => f.event !== 'message').map((f) => `+${f.at - sentAt}ms ${f.event} ${JSON.stringify(f.data)}`));
    print('⑤ 几何（ⓐ 卡变完成后的那一瞬）', geometry);
    print('⑤ 几何（ⓑ 思考刚进 DOM 那一瞬 —— 就是用户报的那一帧）', bugMoment);
    print('⑤ 几何（ⓒ 窗口中期：思考已长出一大截。修前这里卡还写着「运行中…」，修后已是「完成」）', midWindow);
    print('⑥ 假上游请求到达', providerArrivals.map((arrival) => ({ index: arrival.index, 'Δms_from_send': arrival.at - sentAt, hasToolResult: arrival.hasToolResult })));
    print('截图', screenshotFile);

    assert.ok(firstRunning, '工具卡必须一度显示为运行中');
    assert.ok(firstThinking, '必须出现过直播思考块');
    assert.ok(firstDone, '工具卡最终必须变成完成');
    assert.ok(toolDonePayload, 'payload 里工具 part 最终必须不再是 running');

    // 「真工具真的跑了」的机械证据：命令自己 echo 的标记出现在被转发的 tool_end 里。
    const toolEndFrames = frames.filter((frame) => frame.event === 'session.tool_end');
    const toolEndWithMark = toolEndFrames.find((frame) => String(frame.data?.result ?? '').includes(TOOL_MARK)) || null;
    print('⑧ 真工具跑过的证据（命令自己 echo 的标记 → session.tool_end.result）', {
      '工具命令': TOOL_CMD,
      'tool_end 帧数': toolEndFrames.length,
      '带标记的 tool_end': toolEndWithMark ? { at: toolEndWithMark.at, name: toolEndWithMark.data.name, result: toolEndWithMark.data.result } : null,
      '假上游第 2 个请求是否带 tool 结果': providerArrivals.find((a) => a.hasToolResult)?.hasToolResult ?? null,
    });
    // 修前（服务端不转发工具事件）这一断言是空的 —— 那是**没有数据源**，不是“标记没跑”。
    // 所以只在“本轮确实收到过工具事件”时断言标记；修前用 deadZoneFrames 证明“一条都没有”。
    if (toolEndFrames.length > 0) {
      assert.ok(toolEndWithMark, `session.tool_end.result 必须携带真命令的 stdout（含 ${TOOL_MARK}）`);
    } else {
      assert.ok(firstDone, '没有工具事件时，卡只能靠下一段 session.end 收尾（这正是被测的滞后）');
    }

    // ── 场景 B：**第二张历史卡**（甲覆盖不到的那条路）──────────────────────────
    // 场景 A 里跑着的卡在直播块里；但**重载 / 切回正在跑工具的会话**时，卡只能由
    // `/messages` 历史画进消息**列表**。这条就是「列表里那张过期的运行中卡」的真身（乙的范围）：
    // 重载之后工具真的结束时，它会不会被就地更新？还是在下一段思考里一直停在「运行中」？
    // 修前（服务端不转发 tool 事件）这条会彻底卡住 ⇒ 给对比跑留一个显式开关，不把“修前”变成超时。
    const skipB = process.env.SOPHO_TOOLSYNC_SKIP_B === '1';
    let scenarioB = null;
    if (!skipB) {
    await waitFor(() => frames.some((frame) => frame.event === 'session.settled'), 'turn 1 never settled', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const beforeB = frames.length;
    const sentBAt = Date.now();
    const acceptedB = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: '再来一轮慢工具（这次中途刷新页面）' } });
    assert.equal(acceptedB.statusCode, 202, `message B failed: ${acceptedB.statusCode} ${JSON.stringify(acceptedB.value)}`);
    // 等第二张工具卡开始跑，再刷新 —— 刷新时它就是一张「历史里标着 running」的卡。
    await waitFor(() => frames.slice(beforeB).some((frame) => frame.event === 'session.tool_start'), 'turn 2 tool never started', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reloadAt = Date.now();
    await browser.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    await waitFor(() => evaluate(`!!document.querySelector('#messages')`), 'page did not reload', 20_000);
    await evaluate(PROBE_JS);
    await waitFor(() => evaluate(`!!document.querySelector('[data-session-id="${sessionId}"]')`), 'session missing after reload', 20_000);
    await evaluate(`document.querySelector('[data-session-id="${sessionId}"] .tree-select').click()`);
    // 刷新后历史画出的那张卡：状态必须是 running，而且它在**消息列表**里（不在直播块里）。
    await waitFor(() => evaluate(`window.__tl.events.some((e) => e.runningCards > 0 && e.listCards > 0)`), 'reloaded page never showed a running history card', 30_000);
    const reloadRunning = (await evaluate(`window.__tl.events`)).find((e) => e.runningCards > 0 && e.listCards > 0);
    const reloadShot = await shoot('reload-running-list-card');
    // 工具真的结束（假上游收到那一次带 tool result 的请求）→ 卡该翻成完成、且**不能**等到下一段思考。
    const toolEndB = await waitFor(() => {
      const arrival = providerArrivals.filter((item) => item.hasToolResult).at(-1);
      return arrival && arrival.index >= 4 ? arrival : null;
    }, 'turn 2 tool result never reached the provider', 60_000);
    await waitFor(() => evaluate(`window.__tl.events.some((e) => e.doneCards > 0)`), 'reloaded page never flipped the history card to done', 30_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const eventsB = await evaluate(`window.__tl.events`);
    // 「卡翻成完成」必须**只**看第二张卡：刷新那一刻第一张卡就已经是 done-success 了，
    // 所以判据是「工具真结束之后，running 卡数降到 0」。
    const doneB = eventsB.find((e) => e.t >= toolEndB.at - 250 && e.runningCards === 0) || null;
    const thinkingWhileRunningB = eventsB.find((e) => e.liveThinking > 0 && e.runningCards > 0) || null;
    scenarioB = {
      '刷新时刻': reloadAt,
      '刷新后列表里的运行中卡': reloadRunning,
      '工具真结束_假上游收到结果请求': toolEndB.at,
      '卡翻成完成': doneB?.t ?? null,
      '滞后ms': doneB ? doneB.t - toolEndB.at : null,
      '刷新后曾出现「思考已进DOM但卡还运行中」': thinkingWhileRunningB,
      '截图': reloadShot,
    };
    print('⑦ 场景 B（重载 / 切回正在跑工具的会话 ⇒ 历史卡 = 乙的范围）', scenarioB);
    print('⑦ 场景 B DOM 时间线（Δms 相对重载后首次列表卡）', eventsB.map((e) => ({ 'Δms': e.t - (reloadRunning?.t ?? reloadAt), why: e.why, cards: e.cards, 列表卡: e.listCards, 直播卡: e.liveCards, 运行中: e.runningCards, 思考字符: e.liveThinking })));
    } else {
      print('⑦ 场景 B', '未跑（SOPHO_TOOLSYNC_SKIP_B=1：修前那一版没有任何工具事件，这条只会停在超时，不把它当结论）');
    }

    const limits = {
      // 定因阶段这条门**只报数字**；修好后（甲/乙任一）这里应收紧到「工具结束 ≤1.5s 内卡就变完成」。
      maxLagMs: 60_000,
      ...(process.env.SOPHO_TOOLSYNC_LIMIT_JSON ? JSON.parse(process.env.SOPHO_TOOLSYNC_LIMIT_JSON) : {}),
    };
    const failures = [];
    if (pageProblems.length) failures.push(`页面异常：${JSON.stringify(pageProblems)}`);
    if (failures.length) throw new Error(`tool state sync gate failed: ${failures.join(' | ')}`);
    return { chromium: version.Browser, sessionId, lagMs, thinkingGapMs, deadZoneFrames: deadZoneFrames.length, limits, screenshotFile, bugScreenshot: bugMoment.screenshot, midScreenshot: midWindow.screenshot, scenarioB, ports: { providerPort, basePort, appPort } };
  } finally {
    try { sseRequest?.destroy(); } catch {}
    browser?.close();
    for (const child of [chromium, app, base]) {
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

let primaryError;
try {
  const result = await runGate();
  print('RESULT', `tool state sync PASS/measure（工具真结束→卡变完成 滞后 ${result.lagMs}ms；思考先进 DOM→卡变完成 ${result.thinkingGapMs}ms；该窗口 SSE 帧 ${result.deadZoneFrames} 条；场景 B 历史卡滞后 ${result.scenarioB?.滞后ms}ms）`);
  print('沙箱', { home: sandbox, ports: result.ports, forbiddenPortsUsed: false });
} catch (error) {
  primaryError = error;
  process.stdout.write(`✗ tool state sync gate failed: ${error && error.message}\n${error && error.stack}\n`);
} finally {
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
