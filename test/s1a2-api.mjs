import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeDocument, FakeElement } from './fake-dom.mjs';
import { finishCleanup, listenerPid, processCommandLine, removeSandbox, stopOwnedListener } from './harness.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-api-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 's1a2-base.log');
const appLogPath = path.join(sandbox, 's1a2-app.log');
const baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
const appEntry = path.join(sourceRoot, 'server', 'app.mjs');
let providerServer;
let baseChild;
let appChild;
let baseLog;
let appLog;
let providerPort;
let basePort;
let appPort;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('could not reserve a high port');
}

async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${appPort}/api${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: text, value };
}

async function waitForHttp() {
  let lastError;
  for (let attempt = 0; attempt < (process.platform === 'win32' ? 600 : 160); attempt += 1) {
    try {
      const response = await api('/host');
      if (response.statusCode === 200) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw lastError ?? new Error('A+B did not become ready');
}

async function poll(label, operation, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function openSse(pathname) {
  const events = [];
  const waiters = new Set();
  let response;
  let buffer = '';
  let currentEvent = 'message';
  let currentData = [];
  const request = http.request({
    host: '127.0.0.1',
    port: appPort,
    path: `/api${pathname}`,
    headers: { accept: 'text/event-stream' },
  });
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

  async function waitFor(predicate, timeoutMs = 8000) {
    const found = events.find(predicate);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`SSE wait timed out: ${JSON.stringify(events)}`));
      }, timeoutMs);
      const check = () => {
        const value = events.find(predicate);
        if (!value) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(value);
      };
      waiters.add(check);
    });
  }

  return {
    connected,
    events,
    waitFor,
    close() {
      response?.destroy();
      request.destroy();
    },
  };
}

function usage() {
  return {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
  };
}

function chunk(content, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-s1a2',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(includeUsage ? { usage: usage() } : {}),
  };
}

function createPlan(mode, text) {
  let startedResolve;
  let releaseResolve;
  let closedResolve;
  return {
    mode,
    text,
    started: new Promise((resolve) => { startedResolve = resolve; }),
    release: () => releaseResolve?.(),
    released: new Promise((resolve) => { releaseResolve = resolve; }),
    closed: new Promise((resolve) => { closedResolve = resolve; }),
    markStarted: startedResolve,
    markClosed: closedResolve,
  };
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
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    const plan = plans.shift() ?? createPlan('normal', `reply:${lastUserText(body).slice(0, 80)}`);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(plan.text))}\n\n`);
    plan.markStarted({ request: body, text: plan.text });
    request.socket.once('close', () => plan.markClosed({ destroyed: response.destroyed }));

    if (plan.mode === 'break') {
      setTimeout(() => response.socket?.destroy(new Error('scripted upstream break')), 20).unref();
      return;
    }
    if (plan.mode === 'hold') await plan.released;
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify(chunk(null, 'stop', true))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return {
    server,
    plans,
    requests,
    plan(mode, text) {
      const value = createPlan(mode, text);
      plans.push(value);
      return value;
    },
  };
}

function assistantMessage(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-s1a2',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function writeLargeExportSession() {
  const id = randomUUID();
  const file = path.join(sessionsRoot, `large-export_${id}.jsonl`);
  const now = new Date().toISOString();
  const payload = 'five-mebibyte-export-fixture\n'.repeat(Math.ceil((5 * 1024 * 1024) / 29)).slice(0, 5 * 1024 * 1024);
  const lines = [
    { type: 'session', version: 3, id, timestamp: now, cwd },
    { type: 'message', id: 'e0000001', parentId: null, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'export fixture' }], timestamp: Date.now() } },
    { type: 'message', id: 'e0000002', parentId: 'e0000001', timestamp: now, message: assistantMessage(payload) },
  ];
  await writeFile(file, `${lines.map(JSON.stringify).join('\n')}\n`);
  return { id, file, bytes: Buffer.byteLength(await readFile(file)) };
}

async function writeSeedSessions() {
  const parentId = randomUUID();
  const childId = randomUUID();
  const parentPath = path.join(sessionsRoot, `seed-parent_${parentId}.jsonl`);
  const childPath = path.join(sessionsRoot, `seed-child_${childId}.jsonl`);
  const now = new Date().toISOString();
  const parentLines = [
    { type: 'session', version: 3, id: parentId, timestamp: now, cwd },
    { type: 'model_change', id: '00000001', parentId: null, timestamp: now, provider: 'fake', modelId: 'fake-s1a2' },
    { type: 'thinking_level_change', id: '00000002', parentId: '00000001', timestamp: now, thinkingLevel: 'off' },
    { type: 'message', id: '00000003', parentId: '00000002', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'seed question' }], timestamp: Date.now() } },
    { type: 'message', id: '00000004', parentId: '00000003', timestamp: now, message: assistantMessage('assistant body only') },
    { type: 'message', id: '00000005', parentId: '00000004', timestamp: now, message: { ...assistantMessage(''), content: [{ type: 'toolCall', id: 'call-ok', name: 'read', arguments: { path: 'ok.txt' } }] } },
    { type: 'message', id: '00000006', parentId: '00000005', timestamp: now, message: { role: 'toolResult', toolCallId: 'call-ok', toolName: 'read', content: [{ type: 'text', text: 'read ok' }], isError: false, timestamp: Date.now() } },
    { type: 'message', id: '00000007', parentId: '00000006', timestamp: now, message: { ...assistantMessage(''), content: [{ type: 'toolCall', id: 'call-bad', name: 'bash', arguments: { command: 'exit 1' } }] } },
    { type: 'message', id: '00000008', parentId: '00000007', timestamp: now, message: { role: 'toolResult', toolCallId: 'call-bad', toolName: 'bash', content: [{ type: 'text', text: 'command failed' }], isError: true, timestamp: Date.now() } },
    { type: 'message', id: '00000009', parentId: '00000008', timestamp: now, message: { ...assistantMessage(''), content: [{ type: 'toolCall', id: 'call-unfinished', name: 'write', arguments: { path: 'unfinished.txt' } }], stopReason: 'aborted' } },
    { type: 'custom_message', id: '0000000a', parentId: '00000009', timestamp: now, customType: 'seed-extension', content: 'extension body only', display: true, details: { color: 'purple' } },
    { type: 'session_info', id: '0000000b', parentId: '0000000a', timestamp: now, name: 'Seed Parent' },
  ];
  const childLines = [
    { type: 'session', version: 3, id: childId, timestamp: now, cwd, parentSession: parentPath },
    { type: 'message', id: '10000001', parentId: null, timestamp: now, message: { role: 'user', content: 'child idle', timestamp: Date.now() } },
  ];
  await writeFile(parentPath, `${parentLines.map(JSON.stringify).join('\n')}\n`);
  await writeFile(childPath, `${childLines.map(JSON.stringify).join('\n')}\n`);
  return { parentId, childId, parentPath, childPath };
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

async function waitForIdle(sessionId) {
  return poll('session idle', () => api(`/sessions/${sessionId}`), (response) => response.statusCode === 200
    && !response.value.runtime.isStreaming
    && !response.value.runtime.isCompacting
    && !response.value.runtime.isRetrying);
}

function assertContext(context, { used = true, enabled = false } = {}) {
  assert.ok(context);
  assert.equal(context.modelId, 'fake-s1a2');
  assert.equal(context.provider, 'fake');
  assert.equal(context.contextWindow, 4096);
  assert.equal(context.reserveTokens, 256);
  assert.equal(context.thresholdTokens, 3840);
  assert.equal(context.keepRecentTokens, 128);
  assert.equal(context.compactionEnabled, enabled);
  if (used) {
    assert.equal(typeof context.usedTokens, 'number');
    assert.equal(context.freeTokens, context.thresholdTokens - context.usedTokens);
  } else {
    assert.equal(context.usedTokens, null);
    assert.equal(context.freeTokens, null);
  }
}

let primaryError;
try {
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  const used = new Set();
  providerPort = await reserveHighPort(used); used.add(providerPort);
  basePort = await reserveHighPort(used); used.add(basePort);
  appPort = await reserveHighPort(used); used.add(appPort);
  const seeded = await writeSeedSessions();
  const unreadBase = Date.now() - 60_000;
  await writeFile(path.join(home, 'settled.json'), `${JSON.stringify({
    [seeded.parentId]: unreadBase,
    [seeded.childId]: unreadBase + 10_000,
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'seen.json'), '{}\n');

  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-s1a2', name: 'S1a2 Fake', contextWindow: 4096, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-s1a2',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

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
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: cwd,
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '8',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  appChild = spawn(process.execPath, [appEntry], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_APP_HOST: '127.0.0.1',
      SOPHO_APP_PORT: String(appPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1',
      SOPHO_UPSTREAM_PORT: String(basePort),
      SOPHO_WEB_ROOT: path.join(sourceRoot, 'web'),
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  await waitForHttp();
  if (process.platform !== 'win32') {
    assert.equal(Number(await listenerPid(basePort)), baseChild.pid);
    assert.equal(Number(await listenerPid(appPort)), appChild.pid);
  }
  print('sandbox', { home, cwd, providerPort, basePort, appPort, forbiddenPortsUsed: false });

  const prefix = await api(`/sessions/${seeded.parentId.slice(0, 8)}`);
  assert.equal(prefix.statusCode, 400);
  assert.equal(prefix.value.error, 'full_uuid_required');
  assert.match(prefix.value.message, /full UUID.*prefixes are not accepted/);

  const poolBeforeColdTree = (await api('/host')).value.pool;
  const tree = await api('/tree');
  const poolAfterColdTree = (await api('/host')).value.pool;
  assert.equal(tree.statusCode, 200);
  assert.equal(poolBeforeColdTree.hot, 0);
  assert.equal(poolAfterColdTree.hot, poolBeforeColdTree.hot);
  assert.equal(poolAfterColdTree.counters.acquire, poolBeforeColdTree.counters.acquire);
  const parent = tree.value.sessions.find((session) => session.id === seeded.parentId);
  const child = tree.value.sessions.find((session) => session.id === seeded.childId);
  assert.ok(parent);
  assert.ok(child);
  assert.equal(parent.context, null);
  assert.equal(child.context, null);
  assert.equal(child.parentId, seeded.parentId);
  assert.equal(parent.status, 'unread');
  assert.equal(parent.unread, true);
  assert.equal(parent.settledAt, unreadBase);
  assert.equal(parent.seenAt, null);
  assert.equal(typeof parent.archived, 'boolean');
  assert.deepEqual(tree.value.unread, {
    count: 2,
    oldestId: seeded.parentId,
    oldestName: 'Seed Parent',
    oldestAt: unreadBase,
  });

  const detail = await api(`/sessions/${seeded.parentId}`);
  assert.equal(detail.statusCode, 200);
  // 看详情**不建 runtime**：这一句就是判据 —— acquire 计数器不许动。
  const poolAfterDetail = (await api('/host')).value.pool;
  assert.equal(poolAfterDetail.counters.acquire, poolAfterColdTree.counters.acquire, 'GET /sessions/{id} must not acquire (build) a runtime');
  assert.equal(poolAfterDetail.hot, 0);
  assert.equal(detail.value.detailSource, 'file', 'a cold detail must say so');
  for (const field of ['runtimeState', 'durable', 'generationId', 'pluginStale', 'logicStale', 'pendingMessages', 'evictionEligible', 'pinReasons']) {
    assert.ok(Object.hasOwn(detail.value, field), `missing honest field ${field}`);
  }
  assert.equal(detail.value.sessionId, seeded.parentId);
  // 冷会话没有 runtime ⇒ 这几项没有主语：如实 null + 明列（v2.1 的 pluginStale 也是这个口径）。
  assert.equal(detail.value.runtimeState, 'cold');
  assert.equal(detail.value.pluginStale, null);
  assert.equal(detail.value.logicStale, null);
  assert.equal(detail.value.durable, null);
  assert.equal(detail.value.context, null);
  assert.equal(detail.value.observability, null);
  assert.equal(detail.value.runtime.isStreaming, false);
  assert.equal(detail.value.runtime.model, null);
  assert.equal(detail.value.runtime.thinkingLevel, null, 'a cold detail must not invent a thinking level');
  for (const field of ['context', 'observability', 'durable', 'pluginStale', 'logicStale', 'runtime.model', 'runtime.thinkingLevel']) {
    assert.ok(detail.value.unavailableFields.includes(field), `${field} must be declared unavailable on a cold detail, not invented`);
  }

  const messages = await api(`/sessions/${seeded.parentId}/messages`);
  assert.equal(messages.statusCode, 200);
  assert.ok(Array.isArray(messages.value.messages));
  assert.ok(Array.isArray(messages.value.extras));
  assert.equal(messages.value.extras[0].customType, 'seed-extension');
  assert.equal(messages.value.extras[0].text, 'extension body only');
  assert.equal(messages.value.compaction.atIndex, null);
  assert.equal(messages.value.compaction.note, '正文列表 ≠ 模型现在看得见的东西');
  const toolParts = messages.value.messages.flatMap((message) => message.parts || []).filter((part) => part.type === 'tool');
  assert.deepEqual(toolParts.map((part) => [part.name, part.status]), [
    ['read', 'done-success'],
    ['bash', 'done-error'],
    ['write', 'unfinished'],
  ]);
  assert.equal(toolParts[0].result, 'read ok');
  assert.equal(toolParts[1].result, 'command failed');
  assert.equal(messages.value.messages.find((message) => message.entryId === '00000009').aborted, true);
  print('tree/session/messages shape', {
    prefixResponse: { statusCode: prefix.statusCode, body: prefix.value },
    coldTreePool: { before: poolBeforeColdTree, after: poolAfterColdTree },
    treeStatuses: tree.value.sessions.map((session) => ({ id: session.id, status: session.status, archived: session.archived, parentId: session.parentId, context: session.context })),
    detailContext: detail.value.context,
    honestFields: Object.fromEntries(['runtimeState', 'durable', 'generationId', 'pluginStale', 'logicStale', 'pendingMessages', 'evictionEligible', 'pinReasons'].map((field) => [field, detail.value[field]])),
    messages: { count: messages.value.messages.length, toolParts, extras: messages.value.extras, compaction: messages.value.compaction },
  });

  const renamed = await api(`/sessions/${seeded.parentId}`, { method: 'PATCH', body: { name: 'Renamed Seed', archived: true } });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual(renamed.value, { name: 'Renamed Seed', archived: true });
  const afterMetadata = await api('/tree');
  const changed = afterMetadata.value.sessions.find((session) => session.id === seeded.parentId);
  assert.equal(changed.name, 'Renamed Seed');
  assert.equal(changed.archived, true);
  assert.equal(changed.unread, false);
  assert.equal(afterMetadata.value.sessions.find((session) => session.id === seeded.childId).hiddenByArchive, true);
  assert.equal(afterMetadata.value.unread.count, 0);
  const unarchived = await api(`/sessions/${seeded.parentId}/archive`, { method: 'POST', body: { archived: false } });
  assert.equal(unarchived.statusCode, 200);
  assert.equal(unarchived.value.archived, false);
  const afterUnarchive = await api('/tree');
  assert.equal(afterUnarchive.value.unread.count, 2);
  assert.equal(afterUnarchive.value.sessions.find((session) => session.id === seeded.childId).hiddenByArchive, false);
  print('title/archive + hidden unread branch', { patch: renamed.value, afterTree: changed, hiddenChild: afterMetadata.value.sessions.find((session) => session.id === seeded.childId), unreadSummary: afterMetadata.value.unread, unarchive: unarchived.value });

  const invalidExport = await api('/sessions/not-a-uuid/export');
  assert.equal(invalidExport.statusCode, 400);
  assert.equal(invalidExport.value.error, 'full_uuid_required');
  const missingExport = await api(`/sessions/${randomUUID()}/export`);
  assert.equal(missingExport.statusCode, 404);
  assert.equal(missingExport.value.error, 'session_not_found');
  const largeExport = await writeLargeExportSession();
  const memoryBeforeExport = (await api('/host')).value.workerRssBytes;
  const headExport = await api(`/sessions/${largeExport.id}/export`, { method: 'HEAD', headers: { accept: 'text/html' } });
  assert.equal(headExport.statusCode, 200);
  assert.equal(headExport.body, '');
  assert.match(headExport.headers['content-type'], /^text\/html; charset=utf-8$/);
  assert.equal(Number(headExport.headers['content-length']) > 5 * 1024 * 1024, true);
  assert.equal(headExport.headers['x-content-type-options'], 'nosniff');
  const getExport = await api(`/sessions/${largeExport.id}/export`, { headers: { accept: 'text/html' } });
  assert.equal(getExport.statusCode, 200);
  assert.equal(Buffer.byteLength(getExport.body), Number(getExport.headers['content-length']));
  assert.match(getExport.body, /<!DOCTYPE html>/i);
  const memoryAfterExport = (await api('/host')).value.workerRssBytes;
  // Honest limit of this ruler: it catches order-of-magnitude retention, not a one-shot
  // ~7 MB whole-body buffer (the snapshot generation itself allocates the same order of
  // memory either way). The streaming guarantee is the createReadStream path in the handler;
  // this bound only proves the response did not blow up the worker.
  assert.ok(memoryAfterExport - memoryBeforeExport < 192 * 1024 * 1024, `5 MiB export retained too much RSS: ${memoryAfterExport - memoryBeforeExport}`);
  print('A-15 export GET/HEAD + 5 MiB streaming fixture', {
    invalid: invalidExport.value,
    missing: missingExport.value,
    fixtureBytes: largeExport.bytes,
    head: { statusCode: headExport.statusCode, headers: headExport.headers, bodyBytes: Buffer.byteLength(headExport.body) },
    get: { statusCode: getExport.statusCode, contentLength: getExport.headers['content-length'], bodyBytes: Buffer.byteLength(getExport.body) },
    workerRssDeltaBytes: memoryAfterExport - memoryBeforeExport,
    rssDeltaVsSnapshotBytes: memoryAfterExport - memoryBeforeExport,
    rssRulerLimit: 'order-of-magnitude only; cannot distinguish a one-shot whole-body buffer',
  });

  const registrations = await api('/registrations');
  assert.equal(registrations.statusCode, 200);
  assert.equal(registrations.value.enabled, true);
  assert.equal(registrations.value.source, 'stable-host /tree notify projection');
  assert.equal(registrations.value.count, 0);
  assert.deepEqual(registrations.value.records, []);
  assert.equal(registrations.value.error, null);
  for (const field of ['sweepMs', 'idleMs', 'timeoutMs', 'startedAt', 'attaches', 'timersCreated', 'stats']) {
    assert.ok(Object.hasOwn(registrations.value, field), `registrations missing v2.1 field ${field}`);
  }
  assert.equal(registrations.value.hotScope, "records[].hot is this generation worker's own pool only");
  for (const field of ['records[].seenHot', 'records[].lastRunningSeenAt', 'records[].settledCount', 'sweepMs', 'timeoutMs', 'stats']) {
    assert.ok(registrations.value.unavailableFields.includes(field), `registrations must declare ${field} as unavailable instead of inventing it`);
  }
  // A live registration must be reported with real values, not placeholders: the stable host
  // owns the registry, the worker only projects it (which is why `hot` is scoped honestly).
  const watched = await api('/sessions', { method: 'POST', body: { cwd, name: 'Watched Child' } });
  assert.equal(watched.statusCode, 201);
  const registered = await api(`/sessions/${seeded.childId}/send`, {
    method: 'POST',
    body: { fromSessionId: watched.value.id, text: 'register a watcher', notify: true },
  });
  assert.equal(registered.statusCode, 202);
  const liveRegistrations = await poll('live notify registration', () => api('/registrations'), (response) => response.value.records.some((record) => record.childId === seeded.childId && record.hot === true));
  const liveRecord = liveRegistrations.value.records.find((record) => record.childId === seeded.childId);
  assert.ok(liveRecord, `expected a live registration for ${seeded.childId}: ${JSON.stringify(liveRegistrations.value)}`);
  assert.equal(liveRecord.hot, true);
  assert.equal(typeof liveRecord.at, 'number');
  assert.equal(typeof liveRecord.ageMs, 'number');
  assert.equal(liveRecord.quietMs, liveRegistrations.value.idleMs);
  assert.equal(typeof liveRecord.state, 'string');
  assert.equal(liveRecord.seenHot, null);
  assert.equal(liveRecord.settledCount, null);
  print('A-18 live registration record', { record: liveRecord, idleMs: liveRegistrations.value.idleMs, unwatchedFieldsStayNull: ['seenHot', 'settledCount', 'lastRunningSeenAt'] });
  const pluginWatch = await api('/plugin-watch');
  assert.equal(pluginWatch.statusCode, 200);
  assert.equal(pluginWatch.value.enabled, false);
  assert.equal(pluginWatch.value.pending, null);
  assert.deepEqual(pluginWatch.value.pendingIds, []);
  assert.equal(pluginWatch.value.error.code, 'plugin_watch_not_applicable');
  for (const field of ['file', 'intervalMs', 'startedAt', 'attaches', 'timersCreated', 'appliedHash', 'triggers', 'lastTriggerAt', 'lastTriggerHash', 'lastReloaded', 'lastReloadedAt', 'totalReloaded', 'skippedDirty', 'preflights', 'failures', 'lastError', 'lastErrorAt', 'uncommittedHash']) {
    assert.ok(Object.hasOwn(pluginWatch.value, field), `plugin-watch missing v2.1 field ${field}`);
  }
  print('A-18 registrations + plugin-watch honest diagnostics', { registrations: registrations.value, pluginWatch: pluginWatch.value });

  const metricsBefore = await api('/metrics');
  assert.equal(metricsBefore.statusCode, 200);
  for (const field of ['now', 'pid', 'startedAt', 'uptimeMs', 'bucketMs', 'bucketsKept', 'bucketsOrder', 'bytesNote', 'selfExcluded', 'totals', 'buckets', 'top3ByBytes', 'routes']) {
    assert.ok(Object.hasOwn(metricsBefore.value, field), `metrics missing v2.1 field ${field}`);
  }
  assert.equal(metricsBefore.value.bucketMs, 5000);
  assert.equal(metricsBefore.value.bucketsKept, 12);
  assert.equal(metricsBefore.value.buckets.length, 12);
  assert.equal(metricsBefore.value.totals.requests > 0, true);
  assert.equal(metricsBefore.value.totals.bytes > 0, true);
  assert.equal(metricsBefore.value.routes.some((route) => route.pattern === '/sessions/:id/export' && route.bytes > 0), true);
  assert.equal(metricsBefore.value.routes.some((route) => route.pattern === '/metrics'), false);
  assert.match(metricsBefore.value.routesNote, /capped at 128 rows/);
  const badMetricsMethod = await api('/metrics', { method: 'POST', body: {} });
  assert.equal(badMetricsMethod.statusCode, 404);
  assert.equal(badMetricsMethod.value.error, 'not found');
  const metricsAfter = await api('/metrics');
  assert.equal(metricsAfter.value.totals.requests, metricsBefore.value.totals.requests);
  assert.equal(metricsAfter.value.routes.find((route) => route.pattern === '/metrics'), undefined);
  assert.equal(metricsAfter.value.routes.find((route) => route.pattern === '/metrics')?.bytes, undefined);
  const flooded = 200;
  for (let index = 0; index < flooded; index += 1) await api(`/probe-route-${index}`);
  const metricsFlooded = await api('/metrics');
  const overflowRoute = metricsFlooded.value.routes.find((route) => route.pattern === '(other routes)');
  assert.ok(metricsFlooded.value.routes.length <= 128, `per-route table grew past the cap: ${metricsFlooded.value.routes.length}`);
  assert.ok(overflowRoute, `expected an overflow row after ${flooded} distinct paths`);
  assert.ok(overflowRoute.evictedRoutes > 0);
  assert.ok(overflowRoute.bytes > 0);
  assert.equal(metricsFlooded.value.routes.some((route) => route.pattern === '/probe-route-0'), false);
  assert.equal(metricsFlooded.value.routes.some((route) => route.pattern === `/probe-route-${flooded - 1}`), true);
  assert.equal(metricsFlooded.value.totals.requests, metricsAfter.value.totals.requests + flooded);
  print('A-19 route table stays bounded', {
    flooded,
    routeRows: metricsFlooded.value.routes.length,
    overflow: overflowRoute,
    oldestProbeStillListed: metricsFlooded.value.routes.some((route) => route.pattern === '/probe-route-0'),
    newestProbeStillListed: metricsFlooded.value.routes.some((route) => route.pattern === `/probe-route-${flooded - 1}`),
    totalsRequests: metricsFlooded.value.totals.requests,
  });

  print('A-19 worker egress bandwidth metrics', {
    shape: Object.keys(metricsBefore.value),
    scope: metricsBefore.value.scope,
    totals: metricsBefore.value.totals,
    top3ByBytes: metricsBefore.value.top3ByBytes,
    exportRoute: metricsBefore.value.routes.find((route) => route.pattern === '/sessions/:id/export'),
    badMethod: { statusCode: badMetricsMethod.statusCode, body: badMetricsMethod.value },
    selfExcludedAfterBadMethod: metricsAfter.value.totals,
  });

  const created = await api('/sessions', { method: 'POST', body: { cwd, name: 'API Session' } });
  assert.equal(created.statusCode, 201);
  const sessionId = created.value.id;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);

  const missingDraft = await api(`/sessions/${sessionId}/draft`);
  assert.deepEqual(missingDraft.value, { text: '', at: null });
  const draftText = '跨刷新仍在的草稿\n第二行';
  const writtenDraft = await api(`/sessions/${sessionId}/draft`, { method: 'PUT', body: { text: draftText } });
  assert.equal(writtenDraft.statusCode, 200);
  assert.equal(writtenDraft.value.text, draftText);
  assert.ok(writtenDraft.value.at > 1e12);
  assert.deepEqual((await api(`/sessions/${sessionId}/draft`)).value, writtenDraft.value);
  const oversizedDraft = await api(`/sessions/${sessionId}/draft`, { method: 'PUT', body: { text: '界'.repeat(22_000) } });
  assert.equal(oversizedDraft.statusCode, 413);
  assert.equal(oversizedDraft.value.error, 'draft_too_large');
  assert.equal(oversizedDraft.value.details.maxBytes, 65_536);
  const concurrentDrafts = ['并发甲', '并发乙', '并发丙'];
  const concurrentResults = await Promise.all(concurrentDrafts.map((text) => api(`/sessions/${sessionId}/draft`, { method: 'PUT', body: { text } })));
  assert.ok(concurrentResults.every((result) => result.statusCode === 200));
  const concurrentStored = JSON.parse(await readFile(path.join(home, 'drafts.json'), 'utf8'))[sessionId];
  assert.ok(concurrentDrafts.includes(concurrentStored.text));
  assert.ok(concurrentStored.at > 1e12);
  const deletedDraft = await api(`/sessions/${sessionId}/draft`, { method: 'PUT', body: { text: '' } });
  assert.deepEqual(deletedDraft.value, { text: '', at: null });
  assert.equal(JSON.parse(await readFile(path.join(home, 'drafts.json'), 'utf8'))[sessionId], undefined);
  await api(`/sessions/${sessionId}/draft`, { method: 'PUT', body: { text: draftText } });
  print('draft sidecar API', { written: writtenDraft.value, oversized: oversizedDraft.value, concurrentStored, deleted: deletedDraft.value });

  const treeStream = openSse('/tree/events');
  let sessionStream = openSse(`/sessions/${sessionId}/events`);
  await Promise.all([treeStream.connected, sessionStream.connected]);
  await sessionStream.waitFor((event) => event.event === 'session.snapshot');
  await treeStream.waitFor((event) => event.event === 'tree.snapshot');

  const streamingPlan = providerServer.plan('hold', 'stream-alpha');
  const accepted = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'first accepted message' } });
  assert.equal(accepted.statusCode, 202);
  await streamingPlan.started;
  await sessionStream.waitFor((event) => event.event === 'session.start');
  await sessionStream.waitFor((event) => event.event === 'session.delta' && event.data.delta === 'stream-alpha');
  const streaming409 = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'must not disappear' } });
  assert.equal(streaming409.statusCode, 409);
  assert.equal(streaming409.value.error, 'session_streaming');
  assert.equal(streaming409.value.message, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
  streamingPlan.release();
  const normalEnd = await sessionStream.waitFor((event) => event.event === 'session.end' && event.data.text === 'stream-alpha');
  assert.equal(normalEnd.data.stopReason, 'stop');
  const hotDetail = await waitForIdle(sessionId);
  assertContext(hotDetail.value.context);
  // M-11（只读显示）：热详情的 `runtime` 追加了 `thinkingLevel` —— **只追加**：既有字段名/类型一个没改，
  // 且它诚实：读不到就是 null（不编一个档位）。
  assert.equal(typeof hotDetail.value.runtime.isStreaming, 'boolean');
  assert.equal(typeof hotDetail.value.runtime.isCompacting, 'boolean');
  assert.equal(typeof hotDetail.value.runtime.isRetrying, 'boolean');
  assert.ok(Object.hasOwn(hotDetail.value.runtime, 'model'), 'runtime.model must stay a declared field');
  assert.ok(Object.hasOwn(hotDetail.value.runtime, 'thinkingLevel'), 'hot detail must carry runtime.thinkingLevel');
  // 夹具的会话文件里落了一条 `thinking_level_change` ⇒ pi 的 `AgentSession.thinkingLevel` 就是 'off'。
  // 钉住这个值才证明我们读的是 runtime 的真事实，而不是一个写死的 null。
  assert.equal(hotDetail.value.runtime.thinkingLevel, 'off', JSON.stringify(hotDetail.value.runtime.thinkingLevel));
  const unreadAfterSettle = await poll('settled session becomes unread', () => api('/tree'), (response) => response.value.sessions.find((session) => session.id === sessionId)?.unread === true);
  const unreadCreated = unreadAfterSettle.value.sessions.find((session) => session.id === sessionId);
  assertContext(unreadCreated.context);
  assert.ok(unreadCreated.settledAt > 1e12);
  assert.equal(unreadCreated.seenAt, null);
  const afterRace = await api(`/sessions/${sessionId}/messages`);
  assert.ok(afterRace.value.messages.some((message) => message.text === 'first accepted message'));
  assert.ok(!afterRace.value.messages.some((message) => message.text.includes('must not disappear')));
  print('streaming window 409 raw response', { statusCode: streaming409.statusCode, body: streaming409.value });
  print('hot context from detail + tree', { detail: hotDetail.value.context, tree: unreadCreated.context, thinkingLevel: hotDetail.value.runtime.thinkingLevel, compactionDisabledSemantics: 'threshold remains the configured contextWindow - reserveTokens boundary; automatic compaction is disabled' });
  print('SSE normal sequence', sessionStream.events.filter((event) => ['session.start', 'session.delta', 'session.end'].includes(event.event)).slice(-3));

  const queuePlan = providerServer.plan('hold', 'queue-base');
  assert.equal((await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'queue turn' } })).statusCode, 202);
  await queuePlan.started;
  const runningUnreadTree = await api('/tree');
  const runningUnread = runningUnreadTree.value.sessions.find((session) => session.id === sessionId);
  assert.equal(runningUnread.status, 'working');
  assert.equal(runningUnread.unread, true);
  sessionStream.close();
  const steer = await api(`/sessions/${sessionId}/steer`, { method: 'POST', body: { text: 'steered instruction' } });
  const followUp = await api(`/sessions/${sessionId}/followUp`, { method: 'POST', body: { text: 'followed instruction' } });
  assert.equal(steer.statusCode, 202);
  assert.equal(followUp.statusCode, 202);
  sessionStream = openSse(`/sessions/${sessionId}/events`);
  await sessionStream.connected;
  const reconnectedSnapshot = await sessionStream.waitFor((event) => event.event === 'session.snapshot');
  assert.deepEqual(reconnectedSnapshot.data.queue, {
    steering: ['steered instruction'],
    followUp: ['followed instruction'],
  });
  queuePlan.release();
  await poll('queued messages persisted', () => api(`/sessions/${sessionId}/messages`), (response) => {
    const text = response.value.messages.map((message) => message.text);
    return text.includes('steered instruction') && text.includes('followed instruction');
  }, 12_000);
  await waitForIdle(sessionId);
  const queueCleared = await sessionStream.waitFor((event) => event.event === 'session.queue'
    && event.data.steering.length === 0 && event.data.followUp.length === 0);
  print('steer/followUp queue lifecycle', {
    runningUnread,
    steer: steer.value,
    followUp: followUp.value,
    reconnectSnapshotQueue: reconnectedSnapshot.data.queue,
    cleared: queueCleared.data,
  });
  const idleSteer = await api(`/sessions/${sessionId}/steer`, { method: 'POST', body: { text: 'must fail while idle' } });
  const idleFollowUp = await api(`/sessions/${sessionId}/follow-up`, { method: 'POST', body: { text: 'must also fail while idle' } });
  assert.equal(idleSteer.statusCode, 409);
  assert.equal(idleFollowUp.statusCode, 409);
  assert.equal(idleSteer.value.error, 'session_not_streaming');
  assert.equal(idleFollowUp.value.error, 'session_not_streaming');
  print('idle steer/follow-up honest failures', { steer: idleSteer.value, followUp: idleFollowUp.value });

  // Same-tick ordering gate, repeated. One round is a coin flip: the regression this pins
  // (admission doing I/O between acquire and the delivery operation) only reorders when the
  // filesystem happens to answer out of order, so a single burst passed 1 time in 3. Repeat
  // it so a reordering regression is red every run instead of occasionally.
  const burstRounds = Number(process.env.SOPHO_BURST_ROUNDS ?? 10);
  assert.ok(Number.isInteger(burstRounds) && burstRounds >= 1, `SOPHO_BURST_ROUNDS must be a positive integer: ${process.env.SOPHO_BURST_ROUNDS}`);
  const burstModes = [];
  let lastBurst;
  for (let round = 0; round < burstRounds; round += 1) {
    const prefix = `same-tick-r${round}`;
    const burstPlan = providerServer.plan('hold', `${prefix}-base`);
    const burst = await api(`/sessions/${sessionId}/dev-burst`, { method: 'POST', body: { text: prefix, n: 3 } });
    assert.equal(burst.statusCode, 200);
    const modes = burst.value.results.map((result) => result.mode);
    assert.deepEqual(modes, ['message', 'steer', 'steer'], `burst round ${round + 1}/${burstRounds} reordered: ${JSON.stringify(burst.value.results)}`);
    burstModes.push(modes);
    await burstPlan.started;
    burstPlan.release();
    const texts = [0, 1, 2].map((index) => `${prefix}-${index}`);
    await poll('same-tick burst persisted once', () => api(`/sessions/${sessionId}/messages`), (response) => {
      const seen = response.value.messages.map((message) => message.text);
      return texts.every((text) => seen.filter((value) => value === text).length === 1);
    }, 12_000);
    await waitForIdle(sessionId);
    lastBurst = { response: burst.value, texts };
  }
  const afterBurst = await api(`/sessions/${sessionId}/messages`);
  print('same-tick delivery no loss/no duplicate', {
    rounds: burstRounds,
    modesPerRound: burstModes,
    allRoundsOrdered: burstModes.every((modes) => modes.join(',') === 'message,steer,steer'),
    response: lastBurst.response,
    counts: Object.fromEntries(lastBurst.texts.map((text) => [text, afterBurst.value.messages.filter((message) => message.text === text).length])),
  });

  const abortPlan = providerServer.plan('hold', 'abort-partial');
  assert.equal((await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'abort this turn' } })).statusCode, 202);
  await abortPlan.started;
  await sessionStream.waitFor((event) => event.event === 'session.delta' && event.data.delta === 'abort-partial');
  const abort = await api(`/sessions/${sessionId}/abort`, { method: 'POST', body: {} });
  assert.equal(abort.statusCode, 200);
  assert.equal(abort.value.aborted, true);
  const abortEnd = await sessionStream.waitFor((event) => event.event === 'session.end' && event.data.stopReason === 'aborted');
  assert.equal(abortEnd.data.stopReason, 'aborted');
  await waitForIdle(sessionId);
  print('abort client view', { response: abort.value, terminalEvent: abortEnd });

  const breakPlan = providerServer.plan('break', 'before-upstream-break');
  assert.equal((await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'break upstream now' } })).statusCode, 202);
  await breakPlan.started;
  await sessionStream.waitFor((event) => event.event === 'session.delta' && event.data.delta === 'before-upstream-break');
  const brokenEnd = await sessionStream.waitFor((event) => event.event === 'session.end' && event.data.stopReason === 'error', 12_000);
  assert.match(brokenEnd.data.errorMessage, /terminated|fetch|socket|stream|break|network/i);
  await waitForIdle(sessionId);
  print('upstream mid-stream break client view', brokenEnd);

  for (let index = 0; index < 3; index += 1) {
    const response = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: `${'context '.repeat(180)}${index}` } });
    assert.equal(response.statusCode, 202);
    await waitForIdle(sessionId);
  }
  const beforeCompactionContext = (await api(`/sessions/${sessionId}`)).value.context;
  assertContext(beforeCompactionContext);
  const compactPlan = providerServer.plan('hold', 'compact summary');
  const compactAccepted = await api(`/sessions/${sessionId}/compact`, { method: 'POST', body: {} });
  assert.equal(compactAccepted.statusCode, 202);
  await compactPlan.started;
  const compaction409 = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'blocked during compaction' } });
  assert.equal(compaction409.statusCode, 409);
  assert.equal(compaction409.value.error, 'session_compacting');
  assert.equal(compaction409.value.message, 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.');
  compactPlan.release();
  const compactedMessages = await poll('compaction persisted', () => api(`/sessions/${sessionId}/messages`), (response) => response.value.compaction.atIndex !== null, 12_000);
  assert.ok(!compactedMessages.value.messages.some((message) => message.text === 'blocked during compaction'));
  const afterCompactionContext = (await api(`/sessions/${sessionId}`)).value.context;
  assertContext(afterCompactionContext, { used: false });
  print('compaction window 409 raw response', { statusCode: compaction409.statusCode, body: compaction409.value });
  print('compaction boundary', compactedMessages.value.compaction);
  print('context across compaction', { before: beforeCompactionContext, after: afterCompactionContext });

  const treeEvent = await treeStream.waitFor((event) => event.event === 'tree.session' && event.data.sessionId === sessionId);
  assert.equal(treeEvent.data.type, 'tree.session');
  print('tree SSE sample', treeEvent);

  const seen = await api(`/sessions/${sessionId}/seen`, { method: 'POST', body: {} });
  assert.equal(seen.statusCode, 200);
  const readTree = await api('/tree');
  const readSession = readTree.value.sessions.find((session) => session.id === sessionId);
  assert.equal(readSession.unread, false);
  assert.ok(readSession.seenAt >= readSession.settledAt);
  assert.equal(readSession.status, 'idle');
  print('seen clears unread', { response: seen.value, session: readSession, unreadSummary: readTree.value.unread });

  const page = await fetch(`http://127.0.0.1:${appPort}/`);
  const pageText = await page.text();
  assert.equal(page.status, 200);
  assert.match(pageText, /id="tree"/);
  assert.match(pageText, /id="messages"/);
  assert.match(pageText, /id="abort"/);
  const appJs = await (await fetch(`http://127.0.0.1:${appPort}/app.js`)).text();
  assert.match(appJs, /new EventSource\('\/api\/tree\/events'\)/);
  assert.match(appJs, /session\.delta/);
  assert.match(appJs, /session\.queue/);
  assert.match(appJs, /follow-up/);

  const { renderMessages, renderQueueStatus, renderTree } = await import(`${pathToFileURL(path.join(sourceRoot, 'web', 'render.js')).href}?test=${Date.now()}`);
  const document = new FakeDocument();
  const container = new FakeElement(document, 'section');
  renderMessages(container, messages.value);
  const allNodes = descendants(container);
  const assistantNode = allNodes.find((node) => node.className.includes('message-assistant'));
  const extraNode = allNodes.find((node) => node.className === 'extra-message');
  assert.ok(assistantNode);
  assert.ok(extraNode);
  assert.equal(extraNode.dataset.kind, 'extra');
  assert.equal(assistantNode.dataset.kind, 'message');
  assert.ok(descendants(assistantNode).some((node) => node.textContent === 'assistant body only'));
  assert.ok(!descendants(assistantNode).some((node) => node.textContent === 'extension body only'));
  assert.ok(descendants(extraNode).some((node) => node.textContent === 'extension body only'));
  const queueContainer = new FakeElement(document, 'section');
  renderQueueStatus(queueContainer, { steering: ['one'], followUp: ['two'] });
  assert.equal(queueContainer.hidden, false);
  assert.ok(descendants(queueContainer).some((node) => node.textContent === '⏳ 排队中 · 2 条'));
  assert.deepEqual(descendants(queueContainer).filter((node) => node.className === 'queue-item').map((node) => node.dataset.queueType), ['steer', 'follow-up']);
  renderQueueStatus(queueContainer, { steering: [], followUp: [] });
  assert.equal(queueContainer.hidden, true);
  const treeContainer = new FakeElement(document, 'section');
  renderTree(treeContainer, tree.value.sessions, () => {});
  const renderedChild = descendants(treeContainer).find((node) => node.dataset.sessionId === seeded.childId);
  assert.equal(renderedChild.dataset.depth, '1');
  print('extras DOM assertion', {
    extraClass: extraNode.className,
    extraKind: extraNode.dataset.kind,
    assistantClass: assistantNode.className,
    assistantContainsExtra: false,
    visiblyDistinct: extraNode.className !== assistantNode.className,
    childTreeDepth: renderedChild.dataset.depth,
  });

  const validDraftBytes = await readFile(path.join(home, 'drafts.json'));
  await writeFile(path.join(home, 'drafts.json'), '{broken while running\n');
  const runtimeBadDraft = await api(`/sessions/${sessionId}/draft`);
  assert.equal(runtimeBadDraft.statusCode, 500);
  assert.match(runtimeBadDraft.value.message, /invalid draft sidecar/i);
  await writeFile(path.join(home, 'drafts.json'), validDraftBytes);
  print('invalid draft sidecar fails loud while running', runtimeBadDraft.value);

  sessionStream.close();
  treeStream.close();

  await stopOwnedListener(basePort, baseEntry, baseChild?.pid);
  if (baseChild.exitCode === null) await new Promise((resolve) => baseChild.once('exit', resolve));
  baseChild = spawn(process.execPath, [baseEntry], {
    cwd: sourceRoot,
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
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '8',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await waitForHttp();
  const poolBeforeRestartedTree = (await api('/host')).value.pool;
  const afterRestartTree = await api('/tree');
  const poolAfterRestartedTree = (await api('/host')).value.pool;
  const afterRestartSession = afterRestartTree.value.sessions.find((session) => session.id === sessionId);
  assert.equal(poolBeforeRestartedTree.hot, 0);
  assert.equal(poolAfterRestartedTree.hot, poolBeforeRestartedTree.hot);
  assert.equal(poolAfterRestartedTree.counters.acquire, poolBeforeRestartedTree.counters.acquire);
  assert.equal(afterRestartSession.context, null);
  assert.equal(afterRestartSession.unread, false);
  assert.equal(afterRestartSession.seenAt, seen.value.seenAt);
  assert.ok(JSON.parse(await readFile(path.join(home, 'settled.json'), 'utf8'))[sessionId] > 1e12);
  assert.equal(JSON.parse(await readFile(path.join(home, 'seen.json'), 'utf8'))[sessionId], seen.value.seenAt);
  const poolBeforeDraftRead = (await api('/host')).value.pool;
  const restartedDraft = await api(`/sessions/${sessionId}/draft`);
  const poolAfterDraftRead = (await api('/host')).value.pool;
  assert.deepEqual(restartedDraft.value, { text: draftText, at: JSON.parse(await readFile(path.join(home, 'drafts.json'), 'utf8'))[sessionId].at });
  assert.equal(poolBeforeDraftRead.hot, 0);
  assert.equal(poolAfterDraftRead.hot, 0);
  print('cold tree + seen + draft survive base restart without runtime', { session: afterRestartSession, treePoolBefore: poolBeforeRestartedTree, treePoolAfter: poolAfterRestartedTree, seenFile: JSON.parse(await readFile(path.join(home, 'seen.json'), 'utf8'))[sessionId], draft: restartedDraft.value, poolBeforeDraftRead, poolAfterDraftRead });

  await stopOwnedListener(basePort, baseEntry, baseChild?.pid);
  if (baseChild.exitCode === null) await new Promise((resolve) => baseChild.once('exit', resolve));
  await writeFile(path.join(home, 'drafts.json'), '{broken json\n');
  baseChild = spawn(process.execPath, [baseEntry], {
    cwd: sourceRoot,
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
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '8',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  const invalidDraftExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('base did not fail on invalid drafts.json')), 10_000);
    baseChild.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.notEqual(invalidDraftExit, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(await readFile(baseLogPath, 'utf8'), /invalid draft sidecar.*drafts\.json/i);
  baseChild = null;
  print('invalid draft sidecar fails loud', { exitCode: invalidDraftExit, file: path.join(home, 'drafts.json') });

  await writeFile(path.join(home, 'drafts.json'), '{}\n');
  await writeFile(path.join(home, 'seen.json'), '{broken json\n');
  baseChild = spawn(process.execPath, [baseEntry], {
    cwd: sourceRoot,
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
      SOPHO_NO_TOOLS: '1',
      SOPHO_MAX_HOT: '8',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  const invalidExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('base did not fail on invalid seen.json')), 10_000);
    baseChild.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.notEqual(invalidExit, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(await readFile(baseLogPath, 'utf8'), /invalid unread sidecar.*seen\.json/i);
  baseChild = null;
  print('invalid seen sidecar fails loud', { exitCode: invalidExit, file: path.join(home, 'seen.json') });
  print('RESULT', 'S1a-2 API/frontend PASS');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  if (appPort) {
    try { await stopOwnedListener(appPort, appEntry, appChild?.pid); } catch (error) { process.stderr.write(`app cleanup failed: ${error.message}\n`); }
  }
  if (basePort) {
    try { await stopOwnedListener(basePort, baseEntry, baseChild?.pid); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (providerServer?.server) {
    providerServer.server.closeAllConnections();
    await new Promise((resolve) => providerServer.server.close(resolve));
  }
  if (baseLog) await baseLog.close();
  if (appLog) await appLog.close();
  if (baseChild && baseChild.exitCode === null) await new Promise((resolve) => baseChild.once('exit', resolve));
  if (appChild && appChild.exitCode === null) await new Promise((resolve) => appChild.once('exit', resolve));
  if (baseLogPath) {
    const baseOutput = await readFile(baseLogPath, 'utf8').catch(() => '');
    if (baseOutput.trim()) print('base log', baseOutput.trim());
  }
  if (appLogPath) {
    const appOutput = await readFile(appLogPath, 'utf8').catch(() => '');
    if (appOutput.trim()) print('app log', appOutput.trim());
  }
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
