#!/usr/bin/env node
// 409「Agent is already processing」的真实复现门（真实 A + 假 provider，无 Chromium）。
//
// 要证明的那条窗口：pi 的 assistant 消息**已经 message_end**（服务端据此发 session.end，
// 前端据此把 streaming 置回 false），但这一轮 agent run 还没停（pi 的 _isAgentRunActive 仍为 true，
// 工具还在跑 / 归还没结束）。此刻对 `/sessions/{id}/message` 发一条普通消息 → 409，
// 而 `/sessions/{id}/steer` 是通的。
//
// 证据全部是原始 HTTP 回执，不做任何"应该没问题"的推断。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox, stopSpawnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'sopho-busy409-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const CWD = path.join(TMP, 'cwd');
const BASE_LOG_PATH = path.join(TMP, 'base.log');
const BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let baseChild;
let baseLog;
let provider;
let basePort;
let providerPort;

async function reservePort(excluded = new Set()) {
  for (let candidate = 20000 + Math.floor(Math.random() * 30000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('no high port available');
}

async function request(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let value;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = raw; }
  return { status: response.status, raw, value };
}

async function poll(label, operation, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(40);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function sseChunk(delta, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-busy409',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } : {}),
  };
}

function lastUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => part.text || '').join('');
  }
  return '';
}

// 假 provider：第一条（还没看到 tool 结果）回一个 bash 工具调用（sleep 3s），
// 工具跑完那一次再回一句收尾文字。sleep 就是被测窗口 —— 窗口长度可控。
async function startProvider() {
  const requests = [];
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const part of incoming) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const prompt = lastUserText(body.messages);
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    if (prompt.includes('BUSY_WINDOW') && !hasToolResult) {
      response.write(`data: ${JSON.stringify(sseChunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-busy-sleep', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 3' }) } }] }))}\n\n`);
      response.write(`data: ${JSON.stringify(sseChunk({}, 'tool_calls', true))}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    const text = prompt.includes('BUSY_WINDOW') ? 'BUSY_WINDOW_DONE' : 'FAKE_OK';
    response.write(`data: ${JSON.stringify(sseChunk({ role: 'assistant', content: text }))}\n\n`);
    response.write(`data: ${JSON.stringify(sseChunk({}, 'stop', true))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, requests };
}

// 读会话 SSE，等某个 event 名到。返回一个 { waitFor }，并记录所有收到的事件名。
async function openSessionStream(sessionId) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${basePort}/sessions/${sessionId}/events`, { signal: controller.signal });
  const seen = [];
  let buffer = '';
  const waiters = new Set();
  const notify = () => {
    for (const waiter of [...waiters]) {
      if (waiter.check()) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  };
  (async () => {
    try {
      for await (const part of response.body) {
        buffer += Buffer.from(part).toString('utf8');
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const name = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
          const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
          if (!name) continue;
          seen.push({ name, data: dataLine ? JSON.parse(dataLine.slice(5).trim()) : {} });
        }
        notify();
      }
    } catch { /* stream closed */ }
  })();
  return {
    seen,
    // after = 已经看过的同名事件数（0 = 等第一个）。用来在一条流里区分「上一轮的 end」与「这一轮的 end」。
    async waitFor(name, { after = 0, timeoutMs = 20_000 } = {}) {
      const count = () => seen.filter((entry) => entry.name === name).length;
      if (count() > after) return seen.filter((entry) => entry.name === name)[after];
      await new Promise((resolve, reject) => {
        const waiter = {
          check: () => count() > after,
          resolve,
          timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`SSE event ${name} #${after + 1} not seen; saw ${seen.map((entry) => entry.name).join(',')}`)); }, timeoutMs),
        };
        waiters.add(waiter);
      });
      return seen.filter((entry) => entry.name === name)[after];
    },
    close() { controller.abort(); },
  };
}

let primaryError;
try {
  for (const directory of [HOME, SESSIONS, CWD]) await mkdir(directory, { recursive: true });
  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used);
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-busy409', name: 'Fake busy409', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-busy409', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);
  provider = await startProvider();
  baseLog = await open(BASE_LOG_PATH, 'w');
  baseChild = spawn(process.execPath, [BASE_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME,
      ASSIST_HOME: HOME,
      SOPHO_AGENT_DIR: HOME,
      PI_CODING_AGENT_DIR: HOME,
      PI_CODING_AGENT_SESSION_DIR: SESSIONS,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: CWD,
      SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => request('/host'), (reply) => reply.status === 200, 40_000);
  const created = await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'busy409' } });
  assert.equal(created.status, 201, created.raw);
  const sessionId = created.value.id;
  print('sandbox', { tmp: TMP, providerPort, basePort, basePid: baseChild.pid, sessionId });

  const stream = await openSessionStream(sessionId);
  await stream.waitFor('session.snapshot');

  const accepted = await request(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'BUSY_WINDOW: call bash sleep 3' } });
  assert.equal(accepted.status, 202, accepted.raw);

  // 等"assistant 消息结束"这条前端可见信号 —— 也就是服务端的 session.end。
  const endEvent = await stream.waitFor('session.end');
  print('session.end event (client thinks the reply is over)', endEvent.data);

  // —— 窗口：session.end 已到，但这一轮 agent run 还开着 ——
  const detail = await request(`/sessions/${sessionId}`);
  const messagesRaw = await request(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'WINDOW_PLAIN_MESSAGE' } });
  const steerRaw = await request(`/sessions/${sessionId}/steer`, { method: 'POST', body: { text: 'WINDOW_STEER' } });
  print('GET /sessions/{id} during the window', { status: detail.status, runtime: detail.value?.runtime, status_label: detail.value?.status });
  print('POST /sessions/{id}/message during the window (raw)', messagesRaw);
  print('POST /sessions/{id}/steer during the window (raw)', steerRaw);

  assert.equal(detail.value?.runtime?.isStreaming, true, '窗口内服务端必须仍报 agent run 在跑（这就是前端不知道的事实）');
  assert.equal(messagesRaw.status, 409, messagesRaw.raw);
  assert.equal(messagesRaw.value.error, 'session_streaming');
  assert.equal(messagesRaw.value.message, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
  assert.equal(steerRaw.status, 202, steerRaw.raw);
  print('reproduced 409 window', { message: messagesRaw.value.message, steerAccepted: true });

  // 收尾：这一轮跑完（工具 + 收尾文字），agent settled。
  const settled = await stream.waitFor('session.settled');
  print('session.settled event (real idle)', settled.data);
  const endAt = Date.parse(endEvent.data.at);
  const settledAt = Date.parse(settled.data.at);
  print('客户端以为空闲 → pi 真空闲的差值（工具循环）', { endAt: endEvent.data.at, settledAt: settled.data.at, gapMs: settledAt - endAt, stopReason: endEvent.data.stopReason });
  print('窗口内 SSE 事件顺序', stream.seen.map((entry) => entry.name));
  await poll('idle after settle', () => request(`/sessions/${sessionId}`), (reply) => reply.value?.runtime?.isStreaming === false);
  const after = await request(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'AFTER_SETTLE' } });
  assert.equal(after.status, 202, after.raw);
  print('post-settle plain message accepted', after.status);
  // 把 AFTER_SETTLE 这一轮也等完，免得它的 end/settled 串进下一组的计数。
  await stream.waitFor('session.end', { after: 1 });
  await stream.waitFor('session.settled', { after: 1 });
  stream.close();

  // 对照组：**没有工具**的一轮 —— session.end 与 session.settled 之间只隔收尾与落盘。
  const plain = await openSessionStream(sessionId);
  await plain.waitFor('session.snapshot');
  const plainAccepted = await request(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'PLAIN_TURN' } });
  assert.equal(plainAccepted.status, 202, plainAccepted.raw);
  const plainEnd = await plain.waitFor('session.end');
  const plainSettled = await plain.waitFor('session.settled');
  const plainGapMs = Date.parse(plainSettled.data.at) - Date.parse(plainEnd.data.at);
  print('客户端以为空闲 → pi 真空闲的差值（无工具单轮）', { endAt: plainEnd.data.at, settledAt: plainSettled.data.at, gapMs: plainGapMs, stopReason: plainEnd.data.stopReason });
  plain.close();
  print('RESULT', 'busy409 window reproduced: 409 on /message while agent run still active PASS');
} catch (error) {
  primaryError = error;
  let logTail = '';
  try { logTail = (await readFile(BASE_LOG_PATH, 'utf8')).slice(-8000); } catch {}
  if (logTail) process.stderr.write(`\nbase log tail:\n${logTail}\n`);
} finally {
  const problems = [];
  if (baseChild && basePort) await cleanupStep(problems, 'stop base', () => stopSpawnedListener(baseChild, basePort, BASE_ENTRY));
  if (provider?.server) {
    await cleanupStep(problems, 'close provider', () => new Promise((resolve) => {
      provider.server.closeAllConnections();
      provider.server.close(resolve);
    }));
  }
  await cleanupStep(problems, 'close base log', () => baseLog?.close());
  await removeSandbox(TMP, problems);
  finishCleanup(primaryError, problems);
}
