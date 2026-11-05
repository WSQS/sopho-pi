#!/usr/bin/env node
// 门：agent 面向的归档工具 `session_archive`（**薄封装一致性**）。
//
// 业主 2026-09-22 拍板：工具的权限/行为**与 `POST /sessions/{id}/archive` 那条路由一样，不引入额外限制**
// ——「凡路由接受的，工具不许拒；凡路由怎么报的，工具就怎么报」。所以本门钉的不是“工具自己那套规则”，
// 而是**工具的结果 ≡ 直接打那条路由的结果**（同一条判据下逐条对齐）。
//
// 真 A（`server/base.mjs` + generation worker）+ 假 provider，无 Chromium。覆盖：
//   ① 任意会话 id（P 归档一条与自己**无父子关系**的会话）⇒ 路由 200、工具也 200（**不许**拒）；
//      并逐字核对审计条目（by/at/archived）；
//   ② 在跑目标；③ 已归档目标（幂等）；④ archived:false 撤销；⑤ 不存在的完整 uuid；⑥ 片段 uuid
//      —— 每一格都是「路由回什么 / 工具回什么」的逐条对齐（statusCode + reason + archived + changed + by）；
//   ⑦ 归档态非法值（archived 非布尔）⇒ 路由 400 invalid_archived（工具的参数是 boolean，表达不出该值，
//      这不是“额外限制”：工具不会拒掉路由会接受的 id）。
//
// 反证臂（`--reverse-arm-extra-limit`）：把副本树里的**工具**改成“拒掉某个路由会接受的 id”⇒ **必红**
// （钉住「不许加额外限制」）。（上一版那条“权限守卫放行任意 id ⇒ 必红”的方向反了，已删。）
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { cp, mkdir, mkdtemp, open, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox, runArms, stopSpawnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'sopho-archivetool-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const CWD = path.join(TMP, 'cwd');
const UDIR = path.join(TMP, 'unrelated');
const BASE_LOG_PATH = path.join(TMP, 'base.log');
const ARCHIVE_ENTRY = 'sopho.archive';
const REVERSE_EXTRA_LIMIT = process.argv.includes('--reverse-arm-extra-limit');
let BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');
let BASE_CWD = ROOT;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let baseChild;
let baseLog;
let provider;
let basePort;
let providerPort;
let parentId;

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

async function poll(label, operation, predicate, timeoutMs = 40_000) {
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

function sseChunk(delta, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-archivetool',
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

function lastToolResultText(messages = []) {
  const last = messages.at(-1);
  if (!last || last.role !== 'tool') return '';
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

function toolCall(name, args) {
  return sseChunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${name}-${Math.random().toString(16).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
}

// 假 provider：第一跳按最后一条 user 文本决定“调哪个工具、打哪个 id、archived 是什么”，第二跳把工具
// **回执原文**回显回来（门从 `/messages` 里逐字读回并 JSON.parse）。`ARCH_TOOL <id> [undo]` 是唯一的工具口令。
async function startProvider() {
  const requests = [];
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const part of incoming) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    const prompt = lastUserText(body.messages);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
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
    if (!secondTurn) {
      const tool = /ARCH_TOOL (\S+)(?:\s+(undo))?/.exec(prompt);
      if (tool) return emitTool('session_archive', { id: tool[1], ...(tool[2] === 'undo' ? { archived: false } : { archived: true }) });
      const busy = /BUSY (\d+)/.exec(prompt);
      if (busy) return emitTool('bash', { command: `sleep ${busy[1]}` });
      return emitText('FAKE_OK');
    }
    return emitText(`ARCH_ECHO ${lastToolResultText(body.messages)}`);
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
  if (!hit) return null;
  return path.join(SESSIONS, hit);
}

async function archiveEntries(sessionId) {
  const file = await sessionFileOf(sessionId);
  if (!file) return [];
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'custom' && entry.customType === ARCHIVE_ENTRY)
    .map((entry) => entry.data);
}

async function messagesOf(sessionId) {
  const reply = await request(`/sessions/${sessionId}/messages`);
  assert.equal(reply.status, 200, reply.raw);
  return reply.value.messages;
}

async function waitIdle(sessionId, timeoutMs = 60_000) {
  return poll(`session ${sessionId} settles`, () => request(`/sessions/${sessionId}`), (reply) => reply.value?.runtime?.isStreaming === false
    && reply.value?.runtime?.isCompacting === false
    && (reply.value?.pendingMessages ?? 0) === 0, timeoutMs);
}

async function detailOf(sessionId) {
  const reply = await request(`/sessions/${sessionId}`);
  assert.equal(reply.status, 200, reply.raw);
  return reply.value;
}

// 工具回执读法：假 provider 第二跳回显 `ARCH_ECHO <…>`；里层是插件 `toolResult()` 的 JSON。
function parseEcho(text) {
  const raw = text.slice('ARCH_ECHO '.length);
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    const inner = parsed.map((part) => part.text ?? '').join('');
    return JSON.parse(inner);
  }
  if (parsed && typeof parsed === 'object') return parsed;
  return JSON.parse(String(parsed));
}

async function runToolCall(sessionId, promptText) {
  const before = (await messagesOf(sessionId)).length;
  const posted = await request(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: promptText } });
  assert.equal(posted.status, 202, posted.raw);
  const echoed = await poll(`tool echo for "${promptText}"`, async () => {
    const messages = await messagesOf(sessionId);
    return messages.slice(before).find((message) => message.role === 'assistant'
      && typeof message.text === 'string' && message.text.startsWith('ARCH_ECHO ')) ?? null;
  }, (found) => Boolean(found), 60_000);
  const receipt = parseEcho(echoed.text);
  print(`tool receipt ${promptText.split(' ').slice(0, 3).join(' ')}`, receipt);
  return receipt;
}

// —— 一致性判据：工具的结果 ≡ 直接打那条路由的结果 ——
// 2xx 比 `{statusCode, archived, changed, by}`；非 2xx 比 `{statusCode, reason, message}`（路由的错误体就带这些）。
// `at`/`id` 两侧各自如实即可（时间/目标本来就不一样）；`by` 在错误体里不是路由字段，故错误格不比它。
const routeReport = (reply) => (reply.status >= 200 && reply.status < 300
  ? { statusCode: reply.status, archived: reply.value?.archived ?? null, changed: reply.value?.changed ?? null, by: reply.value?.by ?? null }
  : { statusCode: reply.status, reason: reply.value?.error ?? null, message: reply.value?.message ?? null });
const toolReport = (receipt) => (receipt.statusCode >= 200 && receipt.statusCode < 300
  ? { statusCode: receipt.statusCode, archived: receipt.archived ?? null, changed: receipt.changed ?? null, by: receipt.by ?? null }
  : { statusCode: receipt.statusCode, reason: receipt.reason ?? null, message: receipt.message ?? null });

async function assertParity(label, { target = null, routeTarget = target, toolTarget = routeTarget, archived = true }) {
  const route = await request(`/sessions/${routeTarget}/archive`, { method: 'POST', body: { archived, by: parentId } });
  // 直接把**路由本身的原始回执**打出来（业主拍的证据面：先实测路由对这类目标是什么行为）。
  print(`route raw  [${label}] direct POST /sessions/${routeTarget}/archive {archived:${archived}, by:P}`, { statusCode: route.status, body: route.value });
  const routeValue = routeReport(route);
  const receipt = await runToolCall(parentId, `ARCH_TOOL ${toolTarget}${archived ? '' : ' undo'}`);
  const toolValue = toolReport(receipt);
  assert.deepEqual(toolValue, routeValue, `${label}：工具结果必须 ≡ 直接打路由的结果\nroute=${JSON.stringify(routeValue)}\ntool =${JSON.stringify(toolValue)}`);
  await waitIdle(parentId);
  return { label, route: routeValue, tool: toolValue, routeRaw: route.value, receipt };
}

let primaryError = null;
try {
  for (const directory of [HOME, SESSIONS, CWD, UDIR]) await mkdir(directory, { recursive: true });
  if (REVERSE_EXTRA_LIMIT) {
    const tree = path.join(TMP, 'reverse-tree');
    await mkdir(tree, { recursive: true });
    for (const part of ['server', 'pi-extensions']) await cp(path.join(ROOT, part), path.join(tree, part), { recursive: true });
    await cp(path.join(ROOT, 'package.json'), path.join(tree, 'package.json'));
    // Windows 上普通 symlink 要特权；'junction' 不用（且 Linux 上等价于 dir）。
    await symlink(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'), 'junction');
    const pluginPath = path.join(tree, 'pi-extensions', 'assistant', 'index.ts');
    const source = await readFile(pluginPath, 'utf8');
    // 反证方向：把**工具**改成“拒掉某个路由会接受的 id”（加了一条路由没有的额外限制）⇒ ① 必红。
    const from = '\t\t\tconst reply = await requestRaw(`/sessions/${encodeURIComponent(params.id)}/archive`, {\n';
    assert.ok(source.includes(from), '反证臂（额外限制）：要插桩的那一行在插件里找得到');
    const injected = '\t\t\tif (params.id !== caller) return toolResult({ ok: false, statusCode: 403, id: params.id, archived: null, changed: null, by: caller, at: null, reason: "reverse_arm_extra_limit", message: "REVERSE ARM: refused an id the route accepts", note: "reverse arm" });\n';
    await writeFile(pluginPath, source.replace(from, `${injected}${from}`));
    BASE_ENTRY = path.join(tree, 'server', 'base.mjs');
    BASE_CWD = tree;
    print('reverse-arm mutation', { arm: 'extra-limit', mutation: '插件工具：params.id !== caller ⇒ 直接 403（拒掉一个路由会接受的 id）', tree });
  }

  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used); used.add(basePort);
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-archivetool', name: 'Fake archive', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-archivetool', defaultThinkingLevel: 'off', compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 1 } }, null, 2)}\n`);

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
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => request('/host'), (reply) => reply.status === 200, 40_000);

  const createSession = async (cwd, name) => {
    const created = await request('/sessions', { method: 'POST', body: { cwd, name } });
    assert.equal(created.status, 201, created.raw);
    // 热身：pi 在第一条 assistant 消息落盘前不写文件，而路由要走真实 runtime/openPersisted ⇒ 会话必须落盘。
    assert.equal((await request(`/sessions/${created.value.id}/message`, { method: 'POST', body: { text: `${name}_WARM` } })).status, 202);
    await waitIdle(created.value.id);
    assert.ok(await sessionFileOf(created.value.id), `${name} 热身之后应当落盘`);
    return created.value.id;
  };

  parentId = await createSession(CWD, 'archiver-parent');
  if (!REVERSE_EXTRA_LIMIT) {
    // 正跑臂：P 归档一条与自己**无父子关系**的会话 —— 路由 200，工具也必须 200（这是「不许加额外限制」的主判据）。
    const anyRouteId = await createSession(UDIR, 'any-route');
    const anyToolId = await createSession(UDIR, 'any-tool');
    // 在跑臂：两条无关会话各跑一条 sleep，路由/工具各打一条。
    const runRouteId = await createSession(UDIR, 'run-route');
    const runToolId = await createSession(UDIR, 'run-tool');
    // 幂等/撤销臂：两条无关会话，先由**路由**归档好（setup），再由两侧各做幂等/撤销。
    const archRouteId = await createSession(UDIR, 'arch-route');
    const archToolId = await createSession(UDIR, 'arch-tool');

    print('sandbox', { tmp: TMP, providerPort, basePort, basePid: baseChild.pid, parentId, anyRouteId, anyToolId, runRouteId, runToolId, archRouteId, archToolId, reverse: REVERSE_EXTRA_LIMIT ? 'extra-limit' : null });

    const { failed } = await runArms([
      ['① 任意会话 id（与自己无父子关系）⇒ 路由 200 且工具 200（不许拒）＋ 审计条目逐字', async () => {
        const parity = await assertParity('任意 id', { routeTarget: anyRouteId, toolTarget: anyToolId, archived: true });
        assert.equal(parity.route.statusCode, 200, JSON.stringify(parity));
        assert.equal((await detailOf(anyRouteId)).archived, true, '路由侧目标必须真的 archived');
        assert.equal((await detailOf(anyToolId)).archived, true, '工具侧目标必须真的 archived');
        assert.equal(typeof parity.receipt.at, 'number', '工具回执必须如实带 at');
        assert.equal(parity.receipt.by, parentId, '工具回执必须如实带 by=调用方');
        const entries = await archiveEntries(anyToolId);
        assert.equal(entries.length, 1, `工具侧应当恰好 1 条 sopho.archive：${JSON.stringify(entries)}`);
        assert.equal(entries[0].by, parentId, '审计条目必须逐字记下 who');
        assert.equal(typeof entries[0].at, 'number', '审计条目必须逐字记下 when');
        assert.equal(entries[0].archived, true);
        return { parity: parity.tool, anyToolEntries: entries };
      }],

      ['② 在跑目标 ⇒ 路由与工具逐条对齐（两边都照路由报 409）', async () => {
        assert.equal((await request(`/sessions/${runRouteId}/message`, { method: 'POST', body: { text: 'BUSY 8' } })).status, 202);
        assert.equal((await request(`/sessions/${runToolId}/message`, { method: 'POST', body: { text: 'BUSY 8' } })).status, 202);
        await poll('run-route streaming', () => request(`/sessions/${runRouteId}`), (reply) => reply.value?.runtime?.isStreaming === true, 30_000);
        await poll('run-tool streaming', () => request(`/sessions/${runToolId}`), (reply) => reply.value?.runtime?.isStreaming === true, 30_000);
        const parity = await assertParity('在跑目标', { routeTarget: runRouteId, toolTarget: runToolId, archived: true });
        assert.equal(parity.route.statusCode, 409, JSON.stringify(parity));
        assert.equal(parity.route.reason, 'session_streaming', JSON.stringify(parity));
        assert.equal((await detailOf(runRouteId)).archived, false, '在跑的目标不许被硬收（路由侧）');
        assert.equal((await detailOf(runToolId)).archived, false, '在跑的目标不许被硬收（工具侧）');
        await waitIdle(runRouteId, 60_000);
        await waitIdle(runToolId, 60_000);
        return parity.tool;
      }],

      ['③ 已归档目标 ⇒ 路由与工具逐条对齐（都幂等 changed:false，且都不追加条目）', async () => {
        // setup 用**路由本身**把两条目标置成已归档（这是场景准备，不是被测行为）。
        for (const id of [archRouteId, archToolId]) {
          const setup = await request(`/sessions/${id}/archive`, { method: 'POST', body: { archived: true, by: parentId } });
          assert.equal(setup.status, 200, setup.raw);
          assert.equal(setup.value.changed, true);
        }
        const parity = await assertParity('已归档目标（幂等）', { routeTarget: archRouteId, toolTarget: archToolId, archived: true });
        assert.equal(parity.route.statusCode, 200, JSON.stringify(parity));
        assert.equal(parity.route.changed, false, JSON.stringify(parity));
        assert.equal((await archiveEntries(archRouteId)).length, 1, '幂等不许追加条目（路由侧）');
        assert.equal((await archiveEntries(archToolId)).length, 1, '幂等不许追加条目（工具侧）');
        assert.equal((await detailOf(archToolId)).archived, true);
        return parity.tool;
      }],

      ['④ archived:false 撤销 ⇒ 路由与工具逐条对齐（都真的回活跃）', async () => {
        const parity = await assertParity('撤销', { routeTarget: archRouteId, toolTarget: archToolId, archived: false });
        assert.equal(parity.route.statusCode, 200, JSON.stringify(parity));
        assert.equal(parity.route.archived, false, JSON.stringify(parity));
        assert.equal(parity.route.changed, true, JSON.stringify(parity));
        assert.equal((await detailOf(archRouteId)).archived, false, '撤销后必须真的回活跃（路由侧）');
        assert.equal((await detailOf(archToolId)).archived, false, '撤销后必须真的回活跃（工具侧）');
        assert.deepEqual((await archiveEntries(archToolId)).map((entry) => entry.archived), [true, false], '撤销应当追加一条 archived:false');
        return parity.tool;
      }],

      ['⑤ 不存在的完整 uuid ⇒ 路由与工具逐条对齐（404 session_not_found）', async () => {
        const parity = await assertParity('不存在的 uuid', { target: randomUUID(), archived: true });
        assert.equal(parity.route.statusCode, 404, JSON.stringify(parity));
        assert.equal(parity.route.reason, 'session_not_found', JSON.stringify(parity));
        return parity.tool;
      }],

      ['⑥ 片段 uuid ⇒ 路由与工具逐条对齐（400 full_uuid_required）', async () => {
        const parity = await assertParity('片段 uuid', { target: anyToolId.slice(0, 8), archived: true });
        assert.equal(parity.route.statusCode, 400, JSON.stringify(parity));
        assert.equal(parity.route.reason, 'full_uuid_required', JSON.stringify(parity));
        return parity.tool;
      }],

      ['⑦ 归档态非法值（archived 非布尔）⇒ 路由 400 invalid_archived（工具参数是 boolean，表达不出该值）', async () => {
        const route = await request(`/sessions/${anyRouteId}/archive`, { method: 'POST', body: { archived: 'yes', by: parentId } });
        assert.equal(route.status, 400, route.raw);
        assert.equal(route.value.error, 'invalid_archived', route.raw);
        // 工具的参数 schema 是 boolean ⇒ 它**不会**发出非法值（这是类型，不是对目标范围的额外限制：
        // 工具不会拒掉路由会接受的任何 id —— 这一点由 ①–⑥ 逐条钉住）。
        return { routeInvalidArchived: routeReport(route) };
      }],
    ], { title: REVERSE_EXTRA_LIMIT ? 'archive-session-tool (reverse: extra-limit)' : 'archive-session-tool' });

    if (failed.length === 0 && !REVERSE_EXTRA_LIMIT) {
      print('RESULT', 'session_archive gate PASS (thin client: tool result == POST /sessions/{id}/archive result for arbitrary id / running / already-archived / undo / missing / fragment)');
    } else if (failed.length > 0) {
      print('RESULT', `session_archive gate RED (${failed.length} arm(s)) — ${failed.map((item) => item.name).join(' | ')}`);
    }
  } else {
    // 反证臂：只跑 ① 的一致性判据（工具被改成拒掉一个路由会接受的 id ⇒ 必红）。
    print('sandbox', { tmp: TMP, providerPort, basePort, basePid: baseChild.pid, parentId, reverse: 'extra-limit' });
    const anyRouteId = await createSession(UDIR, 'any-route');
    const anyToolId = await createSession(UDIR, 'any-tool');
    const { failed } = await runArms([
      ['① 任意会话 id ⇒ 路由 200 且工具 200（不许拒）', async () => {
        const parity = await assertParity('任意 id', { routeTarget: anyRouteId, toolTarget: anyToolId, archived: true });
        assert.equal(parity.route.statusCode, 200, JSON.stringify(parity));
      }],
    ], { title: 'archive-session-tool (reverse: extra-limit)' });
    if (failed.length > 0) print('RESULT', `session_archive gate RED (${failed.length} arm(s)) — ${failed.map((item) => item.name).join(' | ')}`);
  }
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
