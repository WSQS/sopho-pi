#!/usr/bin/env node
// 门：delegate（`session_send` / `session_push` / notify 唤醒）的**投递语义**。
//
// 业主 **2026-10-13 改判**（问题 q-88e0fad8，诊断单 `docs/plans/diagnosis-2026-10-12-delegate-delivery.md`）：
// **把 delegate 也统一成 steer** —— 与「回答问题」（`deliverAnswer`）同形：
//   忙（有活跃回合）⇒ **steer**（插进当前这一轮，不再等整个 run 跑完）；闲 ⇒ 真起一轮；
//   忙但没有活跃回合（压缩中）⇒ 如实退成 `followUp`；`triggerTurn:false`（handoff 指路）**保持排队**。
// 旧语义（忙 ⇒ followUp 排队）在长 run 里的实测代价：一条 delegate **发出 → 落盘 +68 min 46 s**
// （其间过了 116 个回合边界都没插进去）。
//
// 手法照 `test/manager-questions.mjs` 的 ⑦：真 A（宿主）＋ 真 worker ＋ 假 provider，无 Chromium。
// **判据不看回执字串**（回执可以是假回执）—— 用**假 provider 收到的 messages** 断言那条 delegate
// **真的进了当前这一轮**：它出现在一次 provider 请求里，且那次请求的上下文里**还没有** `BUSY_WINDOW_DONE`
// （= 这一轮还没收尾）；旧语义下它只会出现在 `BUSY_WINDOW_DONE` **之后**的请求里（run 收尾才送达）。
//
// 断言 id 一览：
//   D1 忙 ⇒ 回执 mode:'steer'/queued:false
//   D2 忙 ⇒ 在 run 结束前就被这一回合看到（provider 原始证据）
//   D3 忙 ⇒ 紧跟在还在跑的 tool 调用之后被插进来（不是等这一轮跑完）
//   D4 忙 ⇒ 只送达 1 次
//   D5 闲 ⇒ 回执 mode:'message'/queued:false
//   D6 闲 ⇒ 真的起了一轮（provider 收到）
//   D7 notify 忙 ⇒ 回执（诊断块）mode:'steer'
//   D8 notify 忙 ⇒ 在 run 结束前被看到（与 D2 同一条判据）
//   D9 `triggerTurn:false`（handoff 指路）⇒ **保持排队**：流式时不在 run 收尾前被看到，收尾后才落盘
//   D10 既有语义没弄丢：delegate 回执也带 `mode`，且 `queued` 与 mode 一致
//
// 反证臂（副本树里改 `server/base-logic.mjs` 的 `deliverDelegation`，沙箱跑）：
//   `--reverse-arm`              = 把忙 ⇒ steer 整段搬回旧语义（mode/deliverAs 都回 followUp）⇒ 必红；
//   `--reverse-arm-fakereceipt`  = **只**把 `deliverAs` 改回 'followUp'、回执照旧谎称 mode:'steer'
//                                  （最危险的退化）⇒ 回执那几条不报，D2/D3 必红。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { cp, mkdir, mkdtemp, open, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox, stopSpawnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'sopho-delegsteer-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const CWD = path.join(TMP, 'cwd');
// handoff 的落点单独一个**空**目录（workspace 冲突护栏：同一 cwd 上已有别的 live 会话时 handoff 会被 409 拒）。
const HANDOFF_CWD = path.join(TMP, 'cwd-handoff');
const BASE_LOG_PATH = path.join(TMP, 'base.log');

const REVERSE_ARM = process.argv.includes('--reverse-arm');
const REVERSE_FAKE_RECEIPT = process.argv.includes('--reverse-arm-fakereceipt');
let BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');
let BASE_CWD = ROOT;

const DELEGATE_BUSY = 'DELEG_STEER_BUSY：这是忙时派来的一条 delegate（必须插进当前这一轮）。';
const DELEGATE_IDLE = 'DELEG_STEER_IDLE：这是闲时派来的一条 delegate（必须起一轮）。';
const POINTER_SUMMARY = 'BUSY_WINDOW: 6 handoff 摘要（这条让子会话第一轮跑得够久）。';

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

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
    } catch (error) { last = { error: error instanceof Error ? error.message : String(error) }; }
    await sleep(50);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

const textOfMessage = (message) => (typeof message.content === 'string'
  ? message.content
  : (message.content ?? []).map((part) => part?.text ?? '').join(''));

function lastUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user') continue;
    return textOfMessage(messages[index]);
  }
  return '';
}

function sseChunk(delta, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-delegsteer',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } : {}),
  };
}

function toolCall(name, args) {
  return sseChunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${name}-${Math.random().toString(16).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
}

// 假 provider：`BUSY_WINDOW:<秒>` ⇒ 回一条 `bash {command: sleep N}`（真跑、真占住一个活跃回合）。
async function startProvider() {
  const requests = [];
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const part of incoming) raw += part;
    const body = JSON.parse(raw);
    requests.push({ at: Date.now(), body });
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const prompt = lastUserText(body.messages);
    const secondTurn = body.messages.at(-1)?.role === 'tool';
    const emitText = (text) => {
      response.write(`data: ${JSON.stringify(sseChunk({ role: 'assistant', content: text }))}\n\n`);
      response.write(`data: ${JSON.stringify(sseChunk({}, 'stop', true))}\n\n`);
      response.end('data: [DONE]\n\n');
    };
    const emitTool = (name, args) => {
      response.write(`data: ${JSON.stringify(toolCall(name, args))}\n\n`);
      response.write(`data: ${JSON.stringify(sseChunk({}, 'tool_calls', true))}\n\n`);
      response.end('data: [DONE]\n\n');
    };
    if (!secondTurn && prompt.includes('BUSY_WINDOW')) {
      const seconds = Number(/BUSY_WINDOW(?::\s*(\d+))?/u.exec(prompt)?.[1] ?? 3);
      return emitTool('bash', { command: `sleep ${seconds}` });
    }
    if (!secondTurn) return emitText('FAKE_OK');
    return emitText('BUSY_WINDOW_DONE');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, requests };
}

async function sessionFileOf(sessionId) {
  const files = await readdir(SESSIONS, { recursive: true });
  const hit = files.find((entry) => typeof entry === 'string' && entry.endsWith(`${sessionId}.jsonl`));
  return hit ? path.join(SESSIONS, hit) : null;
}

async function messagesOf(sessionId) {
  const reply = await request(`/sessions/${sessionId}/messages`);
  assert.equal(reply.status, 200, reply.raw);
  return reply.value;
}

async function waitIdle(sessionId, timeoutMs = 60_000) {
  return poll(`session ${sessionId} settles`, () => request(`/sessions/${sessionId}`), (reply) => reply.value?.runtime?.isStreaming === false
    && reply.value?.runtime?.isCompacting === false
    && (reply.value?.pendingMessages ?? 0) === 0, timeoutMs);
}

// 「那条 delegate 在 run 收尾前被这一回合看到了吗」——唯一判据（不看回执字串）：
// 存在一次 provider 请求，它的上下文里**有**那条 mark，且**没有**任何 assistant 说过 `BUSY_WINDOW_DONE`。
function sawBeforeRunEnd(requests, mark) {
  return requests.some((entry) => JSON.stringify(entry.body.messages).includes(mark)
    && !entry.body.messages.some((message) => message.role === 'assistant' && textOfMessage(message).includes('BUSY_WINDOW_DONE')));
}
function requestWithMarkBeforeRunEnd(requests, mark) {
  return requests.find((entry) => JSON.stringify(entry.body.messages).includes(mark)
    && !entry.body.messages.some((message) => message.role === 'assistant' && textOfMessage(message).includes('BUSY_WINDOW_DONE'))) ?? null;
}

// ── 反向臂：副本树 + 只改 deliverDelegation 里那一段 ────────────────────────────────
const FROM_REVERSE = [
  "      const mode = !triggerTurn",
  "        ? (streaming ? 'followUp' : 'message')",
  "        : streaming ? 'steer' : busy ? 'followUp' : 'message';",
  "      const deliverAs = triggerTurn && (streaming || busy)",
  "        ? (mode === 'steer' ? 'steer' : 'followUp')",
  "        : undefined;",
].join('\n');
const TO_REVERSE = [
  "      const mode = !triggerTurn",
  "        ? (streaming ? 'followUp' : 'message')",
  "        : busy ? 'followUp' : 'message';",
  "      const deliverAs = triggerTurn && (streaming || busy) ? 'followUp' : undefined;",
].join('\n');
const FROM_FAKE = [
  "      const deliverAs = triggerTurn && (streaming || busy)",
  "        ? (mode === 'steer' ? 'steer' : 'followUp')",
  "        : undefined;",
].join('\n');
const TO_FAKE = "      const deliverAs = triggerTurn && (streaming || busy) ? 'followUp' : undefined;";

async function makeReverseTree() {
  const tree = path.join(TMP, 'reverse-tree');
  await mkdir(tree, { recursive: true });
  for (const part of ['server', 'pi-extensions']) await cp(path.join(ROOT, part), path.join(tree, part), { recursive: true });
  await cp(path.join(ROOT, 'package.json'), path.join(tree, 'package.json'));
  await symlink(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'), 'junction');
  const logicPath = path.join(tree, 'server', 'base-logic.mjs');
  const source = await readFile(logicPath, 'utf8');
  if (REVERSE_FAKE_RECEIPT) {
    assert.ok(source.includes(FROM_FAKE), '反证臂（假回执）：要改回去的那一段在 base-logic.mjs 里找得到（找不到说明代码形状变了，本臂要跟着改）');
    await writeFile(logicPath, source.replace(FROM_FAKE, TO_FAKE));
  } else {
    assert.ok(source.includes(FROM_REVERSE), '反证臂：要改回去的那一段在 base-logic.mjs 里找得到（找不到说明代码形状变了，本臂要跟着改）');
    await writeFile(logicPath, source.replace(FROM_REVERSE, TO_REVERSE));
  }
  BASE_ENTRY = path.join(tree, 'server', 'base.mjs');
  BASE_CWD = tree;
  print('reverse-arm mutation', {
    mutation: REVERSE_FAKE_RECEIPT
      ? "deliverDelegation: 只把 deliverAs 改回 'followUp'（回执照旧谎称 mode:'steer'）"
      : "deliverDelegation: 忙 ⇒ steer 整段搬回旧语义（mode/deliverAs 都回 followUp）",
    tree,
  });
}

let primaryError;
try {
  for (const directory of [HOME, SESSIONS, CWD, HANDOFF_CWD]) await mkdir(directory, { recursive: true });
  if (REVERSE_ARM || REVERSE_FAKE_RECEIPT) await makeReverseTree();
  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used);
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-delegsteer', name: 'Fake delegsteer', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-delegsteer', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);

  provider = await startProvider();
  baseLog = await open(BASE_LOG_PATH, 'w');
  baseChild = spawn(process.execPath, [BASE_ENTRY], {
    cwd: BASE_CWD,
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
      SOPHO_MAX_HOT: '8',
      SOPHO_ANNOTATION_NOTIFY_WINDOW_MS: '300',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => request('/host'), (reply) => reply.status === 200, 40_000);
  print('sandbox', { tmp: TMP, providerPort, basePort, basePid: baseChild.pid });

  async function createSession(name) {
    const created = await request('/sessions', { method: 'POST', body: { cwd: CWD, name } });
    assert.equal(created.status, 201, created.raw);
    const id = created.value.id;
    assert.equal((await request(`/sessions/${id}/message`, { method: 'POST', body: { text: 'WARMUP' } })).status, 202);
    await waitIdle(id);
    assert.ok(await sessionFileOf(id), `热身之后会话文件应当存在（${SESSIONS}）`);
    return id;
  }
  const fromWatcher = randomUUID();

  // ── D1–D4 忙（有活跃回合）⇒ steer ────────────────────────────────────────────────
  const busyId = await createSession('busy-delegate');
  const busyStart = provider.requests.length;
  assert.equal((await request(`/sessions/${busyId}/message`, { method: 'POST', body: { text: 'BUSY_WINDOW: 6 先跑一会儿' } })).status, 202);
  await poll('busy window opens', () => request(`/sessions/${busyId}`), (reply) => reply.value?.runtime?.isStreaming === true);
  const busySent = await request(`/sessions/${busyId}/send`, { method: 'POST', body: { fromSessionId: fromWatcher, text: DELEGATE_BUSY, notify: false } });
  assert.equal(busySent.status, 202, busySent.raw);
  check("D1 忙 ⇒ 回执 mode:'steer'/queued:false", busySent.value?.mode === 'steer' && busySent.value?.queued === false,
    `原始回执：${busySent.raw}`);
  const busySeen = await poll('delegate reaches the model at all',
    async () => provider.requests.slice(busyStart),
    (requests) => requests.some((entry) => JSON.stringify(entry.body.messages).includes(DELEGATE_BUSY)) ? requests : null, 30_000);
  const busyHop = requestWithMarkBeforeRunEnd(busySeen, DELEGATE_BUSY);
  check('D2 忙 ⇒ 在 run 结束前就被这一回合看到', Boolean(busyHop),
    `上下文里没有 BUSY_WINDOW_DONE 就带上了那条 delegate=${Boolean(busyHop)}（它到过的请求共 ${busySeen.length} 发；旧语义下只会在 run 收尾后的请求里出现）`);
  const injectedAt = busyHop.body.messages.findIndex((message) => textOfMessage(message) === DELEGATE_BUSY);
  check('D3 忙 ⇒ 紧跟在还在跑的 tool 调用之后被插进来', injectedAt > 0 && busyHop.body.messages[injectedAt - 1]?.role === 'tool',
    `index=${injectedAt}, previousRole=${busyHop.body.messages[injectedAt - 1]?.role}`);
  await waitIdle(busyId);
  const busyMessages = await messagesOf(busyId);
  const busyLanded = (busyMessages.extras ?? []).filter((entry) => entry.customType === 'sopho.delegation' && entry.text === DELEGATE_BUSY);
  check('D4 忙 ⇒ 只送达 1 次', busyLanded.length === 1, `landed=${busyLanded.length} (${JSON.stringify((busyMessages.extras ?? []).map((entry) => entry.text))})`);
  print('GATE-D busy delegate steers into the running turn', {
    receipt: { mode: busySent.value.mode, queued: busySent.value.queued, accepted: busySent.value.accepted },
    providerEvidence: { requestsSinceStart: provider.requests.length - busyStart, messagesInHop: busyHop.body.messages.length, injectedAt, previousRole: busyHop.body.messages[injectedAt - 1]?.role, turnAlreadyEnded: busyHop.body.messages.some((message) => message.role === 'assistant' && textOfMessage(message).includes('BUSY_WINDOW_DONE')) },
  });

  // ── D5–D6 闲 ⇒ 真起一轮 ────────────────────────────────────────────────────────
  const idleId = await createSession('idle-delegate');
  const idleStart = provider.requests.length;
  const idleSent = await request(`/sessions/${idleId}/send`, { method: 'POST', body: { fromSessionId: fromWatcher, text: DELEGATE_IDLE, notify: false } });
  assert.equal(idleSent.status, 202, idleSent.raw);
  check("D5 闲 ⇒ 回执 mode:'message'/queued:false", idleSent.value?.mode === 'message' && idleSent.value?.queued === false,
    `原始回执：${idleSent.raw}`);
  const idleTurn = await poll('idle delegate really starts a turn', async () => provider.requests.slice(idleStart), (requests) => requests.some((entry) => JSON.stringify(entry.body.messages).includes(DELEGATE_IDLE)) || false, 20_000).catch(() => null);
  check('D6 闲 ⇒ 真的起了一轮（provider 收到）', Boolean(idleTurn),
    `provider 收到带那条 delegate 的请求：${Boolean(idleTurn)}`);
  await waitIdle(idleId);
  const idleLanded = (await messagesOf(idleId)).extras?.filter((entry) => entry.customType === 'sopho.delegation' && entry.text === DELEGATE_IDLE) ?? [];
  check('D10 既有语义没弄丢：delegate 回执也带 mode，且 queued 与 mode 一致', idleLanded.length === 1 && idleSent.value.mode === 'message' && idleSent.value.queued === false,
    `landed=${idleLanded.length}, mode=${idleSent.value.mode}, queued=${idleSent.value.queued}`);
  print('GATE-D idle delegate starts a new turn', { receipt: { mode: idleSent.value.mode, queued: idleSent.value.queued }, landed: idleLanded.length });

  // ── D7–D8 notify 唤醒：忙 ⇒ steer（与 delegate 同口径）────────────────────────────────
  const watcherId = await createSession('annotation-watcher');
  const settings = await request('/settings', { method: 'PATCH', body: { 'annotations.notifySession': watcherId } });
  assert.equal(settings.status, 200, settings.raw);
  const notifyStart = provider.requests.length;
  assert.equal((await request(`/sessions/${watcherId}/message`, { method: 'POST', body: { text: 'BUSY_WINDOW: 6 watcher 也很忙' } })).status, 202);
  await poll('watcher busy window opens', () => request(`/sessions/${watcherId}`), (reply) => reply.value?.runtime?.isStreaming === true);
  const posted = await request('/annotations', { method: 'POST', body: { note: 'D7/D8：这条反馈要叫起一个正在跑的维护者会话', kind: 'message', sessionId: randomUUID(), messageId: 'ds-1', blockIndex: 0, role: 'assistant' } });
  assert.equal(posted.status, 201, posted.raw);
  const annotationId = posted.value?.annotation?.id;
  assert.ok(annotationId, `标注必须带 id：${posted.raw}`);
  await poll('notification is delivered to the busy watcher', async () => provider.requests.slice(notifyStart), (requests) => sawBeforeRunEnd(requests, annotationId) || requests.some((entry) => JSON.stringify(entry.body.messages).includes(annotationId)), 30_000);
  const notifyReport = await poll('notify diagnostics report the last delivery', () => request('/annotations'), (reply) => reply.value?.notify?.last?.status === 'delivered', 15_000).catch(() => null);
  const notifyLast = notifyReport?.value?.notify?.last ?? null;
  check("D7 notify 忙 ⇒ 回执（诊断块）mode:'steer'", notifyLast?.mode === 'steer',
    `诊断块 last=${JSON.stringify(notifyLast)}`);
  check('D8 notify 忙 ⇒ 在 run 结束前被看到', sawBeforeRunEnd(provider.requests.slice(notifyStart), annotationId),
    `上下文里没有 BUSY_WINDOW_DONE 就带上了那条唤醒消息（id=${annotationId}）`);
  await waitIdle(watcherId);
  print('GATE-D notify wake into a busy session', { annotationId, last: notifyLast, beforeRunEnd: sawBeforeRunEnd(provider.requests.slice(notifyStart), annotationId) });

  // ── D9 `triggerTurn:false`（handoff 指路）⇒ 保持排队（不 steer）────────────────────────
  const sourceId = await createSession('handoff-source');
  const handoff = await request(`/sessions/${sourceId}/handoff`, { method: 'POST', body: { goal: 'D9：验证 handoff 指路这条 triggerTurn:false 的投递语义', to: { cwd: HANDOFF_CWD }, summary: POINTER_SUMMARY } });
  assert.equal(handoff.status, 200, handoff.raw);
  assert.equal(handoff.value?.ok, true, `handoff 必须成功：${handoff.raw}`);
  const childId = handoff.value.to;
  assert.ok(childId, `handoff 回执必须带子会话 id：${handoff.raw}`);
  await poll('handoff child is running its first turn', () => request(`/sessions/${childId}`), (reply) => reply.value?.runtime?.isStreaming === true, 20_000);
  // 还不该看到指针（它 triggerTurn:false ⇒ 流式时推迟到本回合收尾；steer 才会立刻进当前这一轮）。
  const childDuring = await messagesOf(childId);
  const pointerDuring = (childDuring.extras ?? []).filter((entry) => entry.customType === 'sopho.delegation' && String(entry.text ?? '').includes('[handoff 指路]'));
  check('D9 triggerTurn:false（handoff 指路）⇒ 保持排队：流式时不进当前这一轮', pointerDuring.length === 0
    && !sawBeforeRunEnd(provider.requests, '[handoff 指路]'),
    `运行中 extras 里的指路条数=${pointerDuring.length}，run 收尾前被 model 看到的=${sawBeforeRunEnd(provider.requests, '[handoff 指路]')}`);
  await waitIdle(childId);
  const childAfter = await poll('handoff pointer lands once the turn ends', () => messagesOf(childId), (value) => (value.extras ?? []).some((entry) => entry.customType === 'sopho.delegation' && String(entry.text ?? '').includes('[handoff 指路]')), 20_000);
  const pointerAfter = (childAfter.extras ?? []).filter((entry) => entry.customType === 'sopho.delegation' && String(entry.text ?? '').includes('[handoff 指路]'));
  check('D9b 收尾后指路真的落盘（且只 1 条）', pointerAfter.length === 1,
    `收尾后 extras 里的指路条数=${pointerAfter.length}`);
  print('GATE-D handoff pointer stays queued (triggerTurn:false)', { childId, pointerDuring: pointerDuring.length, pointerAfter: pointerAfter.length, sawBeforeRunEnd: sawBeforeRunEnd(provider.requests, '[handoff 指路]') });

  print('RESULT', 'delegate delivery semantic gate PASS (busy→steer / idle→new turn / notify busy→steer / triggerTurn:false stays queued / receipt mode)');
} catch (error) {
  primaryError = error;
  let logTail = '';
  try { logTail = (await readFile(BASE_LOG_PATH, 'utf8')).slice(-8000); } catch { /* no log */ }
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
process.stdout.write(`checks=${checks}\n`);
