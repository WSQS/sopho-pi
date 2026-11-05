#!/usr/bin/env node
// S4-2 acceptance: handoff moves a session's context (a lossy summary) to a new *sibling*
// session, leaves a line in handoffs.jsonl, and never touches the source on failure.
//
// Sandbox only: copy home, random high ports, local fake provider, exact-pid cleanup.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, stopSpawnedListener } from './harness.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 's4-handoff-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const SOURCE_CWD = path.join(TMP, 'source');
const PARENT_CWD = path.join(TMP, 'parent');
const TARGET_CWD = path.join(TMP, 'target');
const TARGET_FAIL_CWD = path.join(TMP, 'target-fail');
// 一个**空目录**（没有任何活会话）：`to.cwd` + `to.sameCwd` 的矛盾要靠 worker 回 400，
// 而宿主的工作区守卫会先拦下已经有活会话的目录（那条是 409）⇒ 用一个干净目录才能问到 worker。
const EMPTY_CWD = path.join(TMP, 'empty-no-live-session');
const PROPER_NOUN = 'QUOKKA-7731';
const PARENT_ID = randomUUID();
const SOURCE_ID = randomUUID();
const PARENT_FILE = path.join(SESSIONS, `seed_${PARENT_ID}.jsonl`);
const SOURCE_FILE = path.join(SESSIONS, `seed_${SOURCE_ID}.jsonl`);
const BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');
const BASE_LOG_PATH = path.join(TMP, 'base.log');
const HANDOFFS = path.join(HOME, 'handoffs.jsonl');

let baseChild;
let baseLog;
let provider;
let basePort;
let providerPort;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort(excluded = new Set()) {
  for (let candidate = 20000 + Math.floor(Math.random() * 30000); candidate < 62000; candidate += 1) {
    if (candidate === 7331 || candidate === 7321 || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
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

async function poll(label, operation, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(50);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function usage() {
  return { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
}

function sse(response, delta, finishReason = null, includeUsage = false) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-s4h',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: usage() } : {}),
  })}\n\n`);
}

function messageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text || '').join('');
  return '';
}

function userText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    return messageText(message);
  }
  return '';
}

function systemText(messages = []) {
  const system = messages.find((message) => message.role === 'system');
  return messageText(system);
}

// The plugin calls ctx.modelRegistry.complete() with HANDOFF_SYSTEM_PROMPT. We recognise
// that nested call by its system prompt, so we never need a real model.
function isSummaryRequest(body) {
  return systemText(body.messages).includes('context transfer assistant');
}

function startProvider() {
  const requests = [];
  const state = { refuseSummary: false, sourceToolCalls: 0 };
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ summaryRequest: isSummaryRequest(body), trigger: userText(body.messages).trim().slice(0, 40), tools: body.tools?.length ?? 0 });

    if (isSummaryRequest(body)) {
      if (state.refuseSummary) {
        // "the fake provider refuses": the summarisation step must fail, not silently pass.
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fake provider refuses to summarise (sandbox refusal)' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      // Echo the conversation the plugin serialised, so the proper noun in the new
      // session really came from the source conversation and not from a stub.
      const echoed = userText(body.messages);
      sse(response, { role: 'assistant', content: `## Context\n${echoed}\n\n## Task\ncontinue from the goal above` });
      sse(response, {}, 'stop', true);
      response.end('data: [DONE]\n\n');
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    // The trigger must be the *whole* last user message, never a substring of the prompt:
    // a handoff summary echoes the source conversation, so substring matching would make
    // the new sibling hand off again (infinite chain).
    const prompt = userText(body.messages).trim();
    // Only "am I resuming this same turn after a tool call" matters; earlier tool results
    // in the history must not suppress a new trigger.
    const hasToolResult = body.messages[body.messages.length - 1]?.role === 'tool';
    if (!hasToolResult && prompt === 'HANDOFF_NOW') {
      state.sourceToolCalls += 1;
      const args = { goal: '继续把 QUOKKA-7731 收尾', to: { cwd: TARGET_CWD } };
      sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-handoff-ok', type: 'function', function: { name: 'handoff', arguments: JSON.stringify(args) } }] });
      sse(response, {}, 'tool_calls', true);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (!hasToolResult && prompt === 'HANDOFF_FAIL') {
      state.sourceToolCalls += 1;
      state.refuseSummary = true;
      const args = { goal: '这次摘要会失败', to: { cwd: TARGET_FAIL_CWD } };
      sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-handoff-fail', type: 'function', function: { name: 'handoff', arguments: JSON.stringify(args) } }] });
      sse(response, {}, 'tool_calls', true);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (!hasToolResult && prompt === 'HANDOFF_SESSION') {
      state.sourceToolCalls += 1;
      const args = { goal: 'compress session instead', compress: 'session' };
      sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-handoff-session', type: 'function', function: { name: 'handoff', arguments: JSON.stringify(args) } }] });
      sse(response, {}, 'tool_calls', true);
      response.end('data: [DONE]\n\n');
      return;
    }
    sse(response, { role: 'assistant', content: 'FAKE_OK' });
    sse(response, {}, 'stop', true);
    response.end('data: [DONE]\n\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', () => resolve({ server, requests, state }));
  });
}

async function jsonlFiles() {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(target);
    }
  }
  await visit(SESSIONS);
  return found.sort();
}

async function sessionHeaders() {
  const heads = [];
  for (const file of await jsonlFiles()) {
    const first = (await readFile(file, 'utf8')).split('\n').find((line) => line.trim() !== '');
    const header = JSON.parse(first);
    heads.push({ file, ...header });
  }
  return heads;
}

async function readHandoffLines() {
  try {
    return (await readFile(HANDOFFS, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function cleanup(problems) {
  if (baseChild && basePort) await cleanupStep(problems, 'stop base', () => stopSpawnedListener(baseChild, basePort, BASE_ENTRY));
  if (provider?.server) {
    await cleanupStep(problems, 'close provider', () => new Promise((resolve) => {
      provider.server.closeAllConnections();
      provider.server.close(resolve);
    }));
  }
  await cleanupStep(problems, 'close base log', () => baseLog?.close());
  await removeSandbox(TMP, problems);
}

let primaryError;
try {
  for (const directory of [HOME, SESSIONS, SOURCE_CWD, PARENT_CWD, TARGET_CWD, TARGET_FAIL_CWD, EMPTY_CWD]) await mkdir(directory, { recursive: true });
  const now = new Date().toISOString();
  // A root parent session, so the handoff's new session must be a *sibling* of SOURCE
  // (same parentSession), not a child of SOURCE.
  await writeFile(PARENT_FILE, `${JSON.stringify({ type: 'session', version: 3, id: PARENT_ID, timestamp: now, cwd: PARENT_CWD })}\n`);
  await writeFile(SOURCE_FILE, [
    { type: 'session', version: 3, id: SOURCE_ID, timestamp: now, cwd: SOURCE_CWD, parentSession: PARENT_FILE },
    { type: 'model_change', id: '40000001', parentId: null, timestamp: now, provider: 'fake', modelId: 'fake-s4h' },
    { type: 'message', id: 's4h-user', parentId: '40000001', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: `源会话在做 ${PROPER_NOUN} 这件事` }], timestamp: Date.now() } },
    { type: 'message', id: 's4h-assistant', parentId: 's4h-user', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: `知道了，继续 ${PROPER_NOUN}` }], api: 'openai-completions', provider: 'fake', model: 'fake-s4h', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } },
  ].map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-s4h', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);

  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used);
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-s4h', name: 'Fake S4H', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
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
      SOPHO_DEFAULT_CWD: SOURCE_CWD,
      SOPHO_MAX_HOT: '12',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => request('/host'), (reply) => reply.status === 200, 30_000);
  assert.equal(await listenerPid(basePort), baseChild.pid);
  print('sandbox', { tmp: TMP, home: HOME, providerPort, basePort, basePid: baseChild.pid, forbiddenPortsUsed: false });

  const loaded = await discoverAndLoadExtensions([path.join(ROOT, 'pi-extensions', 'assistant', 'index.ts')], ROOT, HOME);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.ok(extension.tools.has('handoff'), 'missing handoff tool');
  assert.ok(extension.commands.has('handoff'), 'missing /handoff command');
  const handoffDescription = extension.tools.get('handoff').definition.description;
  assert.match(handoffDescription, /sibling/);
  assert.match(handoffDescription, /lossy summary/);
  print('plugin handoff surface', { tools: ['handoff'], commands: ['handoff'], description: handoffDescription.slice(0, 120) });

  // Make sure the source session is live (owner worker) before we drive its turn.
  const detail = await request(`/sessions/${SOURCE_ID}`);
  assert.equal(detail.status, 200, detail.raw);

  const filesBefore = await jsonlFiles();
  const sourceBefore = await readFile(SOURCE_FILE);
  assert.equal((await readHandoffLines()).length, 0, 'handoffs.jsonl should start absent/empty');

  // ---- success path: same-turn summary via ctx.modelRegistry.complete(), sibling session
  const started = await request(`/sessions/${SOURCE_ID}/message`, { method: 'POST', body: { text: 'HANDOFF_NOW' } });
  assert.equal(started.status, 202, started.raw);
  const lines = await poll('one handoff line', async () => {
    const all = await readHandoffLines();
    return all.length >= 1 ? all : null;
  }, Boolean);
  const record = JSON.parse(lines[0]);
  assert.equal(record.ok, true, JSON.stringify(record));
  assert.equal(record.from, SOURCE_ID);
  assert.equal(record.compress, 'llm');
  assert.equal(record.target.cwd, TARGET_CWD);
  // 落点必须**自报家门**：来源 + 请求值 + 回读值 + 核对结论，一样不少。
  assert.equal(record.cwdSource, 'explicit');
  assert.equal(record.requestedCwd, TARGET_CWD);
  assert.equal(record.actualCwd, TARGET_CWD);
  assert.equal(record.cwdVerified, true);
  assert.match(record.summarySha, /^[0-9a-f]{64}$/);
  assert.match(record.to, /^[0-9a-f-]{36}$/);
  print('handoffs.jsonl success line', record);

  // Sibling, not child: the new header's parentSession is the source's parent.
  const heads = await sessionHeaders();
  const sibling = heads.find((head) => head.id === record.to);
  assert.ok(sibling, `no session file for ${record.to}`);
  assert.equal(path.resolve(sibling.parentSession), path.resolve(PARENT_FILE));
  assert.notEqual(path.resolve(sibling.parentSession), path.resolve(SOURCE_FILE));
  assert.equal(sibling.cwd, TARGET_CWD);
  const siblingTree = await request('/tree');
  const siblingNode = siblingTree.value.sessions.find((entry) => entry.id === record.to);
  assert.equal(siblingNode.parentId, PARENT_ID);
  print('sibling header + tree parent', { parentSession: sibling.parentSession, parentId: siblingNode.parentId, cwd: sibling.cwd });

  // Self-contained: the new session's first user message carries a source proper noun.
  const siblingFile = await poll('sibling durable file', async () => {
    const found = (await sessionHeaders()).find((head) => head.id === record.to)?.file;
    return found ?? null;
  }, Boolean);
  const firstUser = await poll('sibling first user message', async () => {
    const entries = (await readFile(siblingFile, 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
    const message = entries.find((entry) => entry.type === 'message' && entry.message?.role === 'user');
    return message ? message.message.content.map((part) => part.text || '').join('') : null;
  }, Boolean);
  assert.ok(firstUser.includes(PROPER_NOUN), `first user message is not self-contained: ${firstUser.slice(0, 200)}`);
  print('self-contained first user message (excerpt)', firstUser.slice(0, 200));

  // A pointer message telling the new session where the source is (v1 lesson).
  const pointer = await poll('sibling pointer message', async () => {
    const bytes = await readFile(siblingFile, 'utf8');
    return bytes.includes(SOURCE_ID) && bytes.includes(path.basename(SOURCE_FILE)) && bytes.includes('摘要') ? bytes : null;
  }, Boolean);
  print('pointer message present', { hasSourceId: pointer.includes(SOURCE_ID), hasSourceFile: pointer.includes(path.basename(SOURCE_FILE)) });
  // 指路消息的**第一行**永远是生效的 cwd（回读值）：摘要里若写了别的目录，矛盾就在这里摆着。
  const pointerText = await poll('sibling pointer text', async () => {
    const entries = (await readFile(siblingFile, 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
    const carrier = entries.find((entry) => entry.type === 'custom_message' && typeof entry.content === 'string' && entry.content.includes('[handoff 指路]'));
    return carrier?.content ?? null;
  }, Boolean);
  assert.ok(pointerText.startsWith('[handoff 落点]'), `指路消息必须以落点开头：${pointerText.slice(0, 120)}`);
  assert.ok(pointerText.split('\n')[0].includes(TARGET_CWD), `落点那一行必须逐字带生效 cwd ${TARGET_CWD}：${pointerText.split('\n')[0]}`);
  print('pointer head names the effective cwd', pointerText.split('\n')[0]);

  // The source session must be untouched by the handoff itself: append-only, no moved marker.
  const sourceAfterSuccess = await readFile(SOURCE_FILE);
  assert.ok(sourceAfterSuccess.length >= sourceBefore.length);
  assert.ok(sourceAfterSuccess.subarray(0, sourceBefore.length).equals(sourceBefore), 'handoff rewrote the source session prefix');
  assert.ok(!sourceAfterSuccess.includes('moved-to:'), 'a lossy handoff must not archive the source like /move does');
  print('source prefix preserved by handoff', { beforeBytes: sourceBefore.length, afterBytes: sourceAfterSuccess.length, movedMarker: false });

  // ---- receipt is honest about being lossy
  const receipt = await poll('tool receipt', async () => {
    const messages = await request(`/sessions/${SOURCE_ID}/messages`);
    const wire = messages.value?.messages ?? [];
    const last = [...wire].reverse().find((message) => message.role === 'toolResult' || message.role === 'tool');
    return last?.text ?? null;
  }, (value) => typeof value === 'string' && value.includes('handoff'));
  assert.match(receipt, /摘要/);
  assert.match(receipt, /不是全文/);
  // 回执必须是**可核对的**：带 cwd / 来源 / 回读三处事实（不是只有一个目标就完事）。
  assert.match(receipt, /"cwdVerified": true/);
  assert.match(receipt, /"cwdSource": "explicit"/);
  assert.match(receipt, /"fromHeader":/);
  // 回执是 JSON 文本，路径是转义过的，所以按转义形状比对（不是少比对一处）。
  assert.ok(receipt.includes(JSON.stringify(TARGET_CWD).slice(1, -1)), '回执里必须出现生效的 cwd（JSON 转义形状）');
  print('receipt says summary, not full text', { excerpt: receipt.slice(0, 160) });

  // ---- bad line skipping: one broken line must not hide the rest
  await appendFile(HANDOFFS, '{oops not json\n', 'utf8');
  const readBack = await request('/handoffs');
  assert.equal(readBack.status, 200, readBack.raw);
  assert.equal(readBack.value.exists, true);
  assert.ok(readBack.value.skipped >= 1, 'the broken line must be counted as skipped');
  assert.ok(readBack.value.handoffs.some((entry) => entry.to === record.to), 'good lines must still be readable');
  print('bad line skipped, good lines still readable', { skipped: readBack.value.skipped, readable: readBack.value.handoffs.length });

  // ---- failure path: the summary step fails, so the source is not touched and ok:false is logged
  const sourceBeforeFail = await readFile(SOURCE_FILE);
  const filesBeforeFail = await jsonlFiles();
  const siblingsBeforeFail = (await sessionHeaders()).filter((head) => path.resolve(head.parentSession ?? '') === path.resolve(PARENT_FILE)).length;
  const failStart = await request(`/sessions/${SOURCE_ID}/message`, { method: 'POST', body: { text: 'HANDOFF_FAIL' } });
  assert.equal(failStart.status, 202, failStart.raw);
  const failLine = await poll('ok:false handoff line', async () => {
    const all = (await readHandoffLines()).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return all.find((entry) => entry.ok === false && entry.from === SOURCE_ID) ?? null;
  }, Boolean);
  assert.equal(failLine.to, null);
  assert.equal(failLine.compress, 'llm');
  assert.ok(typeof failLine.error === 'string' && failLine.error.length > 0, 'a failed summary must record why');
  print('handoffs.jsonl failure line', failLine);

  const sourceAfterFail = await readFile(SOURCE_FILE);
  assert.ok(sourceAfterFail.subarray(0, sourceBeforeFail.length).equals(sourceBeforeFail), 'a failed handoff rewrote the source session');
  const filesAfterFail = await jsonlFiles();
  // No new session file: a failed summary must not leave an orphan session.
  assert.deepEqual(filesAfterFail, filesBeforeFail, 'a failed handoff must not create a session file');
  const siblingCountAfterFail = (await sessionHeaders()).filter((head) => path.resolve(head.parentSession ?? '') === path.resolve(PARENT_FILE)).length;
  assert.equal(siblingCountAfterFail, siblingsBeforeFail, 'a failed handoff must not create a sibling session');
  print('failed handoff left the source and the tree alone', { newFiles: filesAfterFail.length - filesBeforeFail.length, siblingCount: siblingCountAfterFail });

  // The failure receipt must say the source was untouched and that it is a summary.
  const failReceipt = await poll('failure receipt', async () => {
    const messages = await request(`/sessions/${SOURCE_ID}/messages`);
    const wire = messages.value?.messages ?? [];
    const last = [...wire].reverse().find((message) => (message.role === 'toolResult' || message.role === 'tool') && message.text.includes('ok'));
    return last?.text ?? null;
  }, (value) => typeof value === 'string' && value.includes('"ok": false'));
  assert.match(failReceipt, /"ok": false/);
  assert.match(failReceipt, /不是全文/);
  print('failure receipt explains the failure', { excerpt: failReceipt.slice(0, 200) });

  // ---- compress:"session" falls back to pi's own compaction: no new file, no cwd change.
  // The tool cannot do this mid-turn (the adapter refuses compaction while streaming), so
  // we drive the same logic-layer path the plugin calls, on an idle session.
  provider.state.refuseSummary = false;
  await poll('source idle', () => request(`/sessions/${SOURCE_ID}`), (reply) => reply.value?.runtime?.isStreaming === false);
  const filesBeforeSession = await jsonlFiles();
  const sessionHandoff = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'compress session instead', compress: 'session' } });
  assert.equal(sessionHandoff.status, 200, sessionHandoff.raw);
  assert.equal(sessionHandoff.value.ok, true);
  assert.equal(sessionHandoff.value.mode, 'compaction');
  assert.equal(sessionHandoff.value.to, null);
  const compactionLine = sessionHandoff.value.handoff;
  assert.equal(compactionLine.compress, 'session');
  assert.equal(compactionLine.to, null);
  await poll('source compaction settles', () => request(`/sessions/${SOURCE_ID}`), (reply) => reply.value?.runtime?.isCompacting === false);
  const filesAfterSession = await jsonlFiles();
  assert.deepEqual(filesAfterSession, filesBeforeSession, 'compress:"session" must not create a session file');
  const sourceHeadAfter = JSON.parse((await readFile(SOURCE_FILE, 'utf8')).split('\n')[0]);
  assert.equal(sourceHeadAfter.cwd, SOURCE_CWD);
  print('compress:"session" produced no new file and did not change cwd', { files: filesAfterSession.length, compactionLine });

  // ---- placement: the sibling is recorded as a real directory session
  const placement = await request('/placement');
  assert.equal(placement.status, 200, placement.raw);
  assert.equal(placement.value[record.to].kind, 'dir');
  assert.equal(placement.value[record.to].cwd, TARGET_CWD);
  print('sibling placement recorded', placement.value[record.to]);

  // ---- edges on the handoff endpoint (no agent turn needed)
  const filesBeforeEdges = await jsonlFiles();
  const missingGoal = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: {} });
  assert.equal(missingGoal.status, 400, missingGoal.raw);
  assert.equal(missingGoal.value.error, 'invalid_goal');
  const badCompress = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'x', compress: 'magic' } });
  assert.equal(badCompress.status, 400, badCompress.raw);
  assert.equal(badCompress.value.error, 'invalid_compress');
  const missingCwd = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'x', summary: 's', to: { cwd: path.join(TMP, 'does-not-exist') } } });
  assert.equal(missingCwd.status, 409, missingCwd.raw);
  assert.equal(missingCwd.value.error, 'target_cwd_missing');
  // A device target is validated against devices.json, then refused honestly: a real remote
  // session is S3-2 and does not exist yet.
  const unknownDevice = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'x', summary: 's', to: { device: 'nope' } } });
  assert.equal(unknownDevice.status, 404, unknownDevice.raw);
  assert.equal(unknownDevice.value.error, 'device_not_found');
  await writeFile(path.join(HOME, 'devices.json'), `${JSON.stringify({ winbox: { host: 'winbox.local', mode: 'tools', addedAt: Date.now() } }, null, 2)}\n`);
  const deviceRefused = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'x', summary: 's', to: { device: 'winbox' } } });
  assert.equal(deviceRefused.status, 409, deviceRefused.raw);
  assert.equal(deviceRefused.value.error, 'handoff_device_unsupported');
  assert.match(deviceRefused.value.message, /not implemented/);
  // 落点不许静默沿用：没给 to.cwd / to.sameCwd 就是拒绝（400），不是“默认同 cwd”。
  const noDestination = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'x', summary: 's' } });
  assert.equal(noDestination.status, 400, noDestination.raw);
  assert.equal(noDestination.value.error, 'handoff_cwd_required');
  assert.match(noDestination.value.message, /to\.cwd is required/);
  assert.equal(noDestination.value.details.sourceCwd, SOURCE_CWD);
  // sameCwd 必须是 boolean；与 to.cwd 同时给就是矛盾。
  const badSameCwd = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'x', summary: 's', to: { sameCwd: 'yes' } } });
  assert.equal(badSameCwd.status, 400, badSameCwd.raw);
  assert.equal(badSameCwd.value.error, 'invalid_same_cwd');
  const cwdConflict = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'x', summary: 's', to: { cwd: EMPTY_CWD, sameCwd: true } } });
  assert.equal(cwdConflict.status, 400, cwdConflict.raw);
  assert.equal(cwdConflict.value.error, 'handoff_cwd_conflict');
  const bogusTo = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'x', summary: 's', to: { cwdx: 'y' } } });
  assert.equal(bogusTo.status, 400, bogusTo.raw);
  assert.equal(bogusTo.value.error, 'invalid_to');
  print('endpoint edges', { missingGoal: missingGoal.value.error, badCompress: badCompress.value.error, missingCwd: missingCwd.value.error, unknownDevice: unknownDevice.value.error, deviceRefused: deviceRefused.value.error, noDestination: noDestination.value.error, badSameCwd: badSameCwd.value.error, cwdConflict: cwdConflict.value.error });
  assert.deepEqual(await jsonlFiles(), filesBeforeEdges, 'refused handoffs must not create session files');

  // ---- workspace guard: landing a sibling next to a live session in one tree is refused
  const conflict = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: 'x', summary: 's', to: { cwd: TARGET_CWD } } });
  assert.equal(conflict.status, 409, conflict.raw);
  assert.equal(conflict.value.error, 'workspace_conflict');
  assert.ok(conflict.value.details.conflicts.some((entry) => entry.id === record.to));
  assert.deepEqual(await jsonlFiles(), filesBeforeEdges, 'a refused handoff must not create a session file');
  print('handoff workspace guard', { error: conflict.value.error, conflicts: conflict.value.details.conflicts.map((entry) => entry.id) });

  // ---- sameCwd:true —— 允许，但必须**明文**沿用，账上写清 cwdSource:"source"（不是静默）
  const sameCwd = await request(`/sessions/${SOURCE_ID}/handoff`, { method: 'POST', body: { goal: '在同一目录再来一条', summary: 'SAME_CWD_SUMMARY', to: { sameCwd: true } } });
  assert.equal(sameCwd.status, 200, sameCwd.raw);
  assert.equal(sameCwd.value.ok, true);
  assert.equal(sameCwd.value.cwdSource, 'source');
  assert.equal(sameCwd.value.cwd, SOURCE_CWD);
  assert.equal(sameCwd.value.requestedCwd, SOURCE_CWD);
  assert.equal(sameCwd.value.cwdVerified, true);
  assert.equal(sameCwd.value.cwdReadBack.fromHeader, SOURCE_CWD);
  assert.match(sameCwd.value.notice, /沿用源 cwd/);
  assert.equal(sameCwd.value.handoff.target.cwd, SOURCE_CWD);
  assert.equal(sameCwd.value.handoff.cwdSource, 'source');
  assert.equal(sameCwd.value.handoff.actualCwd, SOURCE_CWD);
  assert.equal(sameCwd.value.handoff.cwdVerified, true);
  const sameCwdHead = (await sessionHeaders()).find((head) => head.id === sameCwd.value.to);
  assert.ok(sameCwdHead, `no session file for ${sameCwd.value.to}`);
  assert.equal(sameCwdHead.cwd, SOURCE_CWD);
  print('sameCwd:true recorded as an explicit inheritance', { to: sameCwd.value.to, cwd: sameCwdHead.cwd, cwdSource: sameCwd.value.cwdSource });

  // ---- `/handoff` 命令面（用户真正的入口）：**只给目标不给落点就不派请求**。
  // 2026-09-21 事故就是从这条路进来的：用户 `/handoff 在~/Documents/godot下重新创建一个会话吧。`，
  // 而那时的命令路径连 `to` 都不构造 ⇒ 落点静默沿用源 cwd。命令的 handler 直调沙箱 base。
  process.env.SOPHO_PORT = String(basePort);
  const notifications = [];
  const branchEntry = { type: 'message', id: 'cmd-b1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '命令路径的源对话' }], timestamp: Date.now() } };
  const commandContext = {
    cwd: SOURCE_CWD,
    sessionManager: {
      getSessionId: () => SOURCE_ID,
      getBranch: () => [branchEntry],
    },
    model: { provider: 'fake', id: 'fake-s4h' },
    // 摘要那一步在插件里发生（真环境会发一次真请求）；这里只给一个固定回报，
    // 因为本段要验的是**命令到落点的接线**，不是摘要质量。
    modelRegistry: { complete: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'COMMAND_PATH_SUMMARY' }] }) },
    ui: { notify: (message, type) => { notifications.push({ message, type }); } },
  };
  const handoffCommand = extension.commands.get('handoff');
  assert.ok(handoffCommand?.handler, 'missing /handoff command handler');
  const filesBeforeCommand = await jsonlFiles();
  const linesBeforeCommand = (await readHandoffLines()).length;
  await handoffCommand.handler(`在 ${TARGET_CWD} 下继续`, commandContext);
  assert.equal(notifications.length, 1, `不给落点时只应该回一条用法，实际 ${JSON.stringify(notifications)}`);
  assert.equal(notifications[0].type, 'info');
  assert.match(notifications[0].message, /落点必须显式给/);
  assert.match(notifications[0].message, /--cwd/);
  assert.match(notifications[0].message, /--here/);
  // 目标文本里写了个真实存在的目录 ⇒ 只有被列为**候选**，绝不自动选。
  assert.ok(notifications[0].message.includes(TARGET_CWD), `应该把目标的目录列为候选：${notifications[0].message}`);
  assert.match(notifications[0].message, /只是候选，不会自动选/);
  assert.deepEqual(await jsonlFiles(), filesBeforeCommand, '不给落点的 /handoff 不许建会话文件');
  assert.equal((await readHandoffLines()).length, linesBeforeCommand, '不给落点的 /handoff 不许记账');
  print('command without a destination sends nothing', { message: notifications[0].message.slice(0, 240) });

  // 给了落点就真的派：`--cwd <目录>` 与 `--here`；`--cwd`+`--here` 矛盾⇒拒绝且不派。
  notifications.length = 0;
  await handoffCommand.handler(`--cwd ${EMPTY_CWD} 到空目录继续`, commandContext);
  assert.equal(notifications.length, 1, JSON.stringify(notifications));
  assert.equal(notifications[0].type, 'info', JSON.stringify(notifications[0]));
  assert.match(notifications[0].message, /已 handoff 到新会话/);
  assert.ok(notifications[0].message.includes(EMPTY_CWD), `回执必须报出生效的落点：${notifications[0].message}`);
  assert.match(notifications[0].message, /已回读核对/);
  const commandRecord = (await readHandoffLines()).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse().find((entry) => entry.target?.cwd === EMPTY_CWD) ?? null;
  assert.ok(commandRecord, 'command handoff must append a ledger line');
  assert.equal(commandRecord.cwdSource, 'explicit');
  assert.equal(commandRecord.cwdVerified, true);
  assert.ok((await sessionHeaders()).some((head) => head.id === commandRecord.to && head.cwd === EMPTY_CWD), '新会话 header 的 cwd 必须是 --cwd 给的那个目录');
  print('command with --cwd lands verbatim', { to: commandRecord.to, cwd: commandRecord.target.cwd, cwdVerified: commandRecord.cwdVerified });

  notifications.length = 0;
  await handoffCommand.handler('--cwd x --here 矛盾', commandContext);
  assert.equal(notifications.length, 1, JSON.stringify(notifications));
  assert.equal(notifications[0].type, 'error');
  assert.match(notifications[0].message, /互相矛盾/);
  notifications.length = 0;
  await handoffCommand.handler('--cwd', commandContext);
  assert.equal(notifications[0]?.type, 'error', JSON.stringify(notifications));
  assert.match(notifications[0].message, /--cwd 后面要跟/);
  print('command flag errors are refused before any request', { conflict: notifications[0].message.slice(0, 80) });

  print('S4-2 handoff acceptance', 'ALL CHECKS PASSED');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await cleanup(cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
