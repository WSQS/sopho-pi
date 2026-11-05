#!/usr/bin/env node
// 门：agent 面向的改模型工具 `session_set_model`（业主 2026-10-14 拍的选项②：默认改自己、显式参数可改子会话）。
//
// 出处：调研单 `docs/plans/recon-2026-10-13-session-model-api.md`（服务端全链已在：GET /sessions/{id}/models
// ＋ POST /sessions/{id}/model 走 owner 路由，adapter.setModel 忙 ⇒ 409）——缺的只是 agent 工具，本单补上。
// 本门钉五格 ＋ 两条反证臂，全部起**真宿主＋真 worker＋假 provider**（临时 ASSIST_HOME ＋ 高位随机端口，无 Chromium）：
//   ① 闲 ⇒ 改自己：直接驱动插件工具的 execute（桩 ctx），目标自己空闲 ⇒ 200；回执含 from/to，
//      且 POST 路径真被走到（宿主侧 GET /models 的 current 真变了 ＋ 会话文件里真多了一条 model_change）；
//   ② 忙 ⇒ 409 如实拒绝：模型驱动的工具调用发生在 P 自己的回合里 ⇒ P 就是忙目标（pi 的
//      _isAgentRunActive 整个回合为真）⇒ 路由 409 session_streaming；回执必须如实说「正忙、没有改」，
//      并断言**模型真的没被改**（GET /models 的 current 不变 ＋ model_change 条数不变）——
//      没有这条，「拒绝」就可能是假的；
//   ③ 显式 sessionId：自己的空闲子会话 ⇒ 允许（模型驱动，C1 真换了）；自己的忙子会话 ⇒ 409（C2 挂一条
//      sleep 长回合）；不是自己的子会话（无关根会话）⇒ 如实拒绝 target_not_own_child 且一个字节没写；
//      自己的父会话 ⇒ 同样拒绝（父不是子）；
//   ④ 未知 model ⇒ 拒绝并**列出可用值**（不猜、不改）；
//   ⑤ 每次调用后断言目标会话 `forks == 0`（按 parentId 建孩子表；这是「没有重开 model_change 双写口」
//      的直接形状证据 —— 历史分叉就是同父两支 model_change ＋ 随行 thinking_level_change）。
//
// 反证臂（本门的关键牙）：
//   · `--reverse-arm=bypass-route`：把副本树里的工具改成**绕过 owner 路由**、直接调 pi 的
//     `ctx.setModel`（进程内直写，对在跑的回合零守卫）⇒ ②「忙 ⇒ 409 且模型没改」**必须红**
//     （证明门真的在盯「必须走路由」，不是摆设）；
//   · `--reverse-arm=fakereceipt`：把副本树里的工具改成回执照旧谎称 200 成功而实际什么都没调
//     ⇒ ② 的「409」断言**必须红**。
// 用法：`node test/set-model-tool.mjs [--reverse-arm=bypass-route|fakereceipt]`。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { cp, mkdir, mkdtemp, open, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox, runArms, stopSpawnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'sopho-setmodeltool-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const CWD = path.join(TMP, 'cwd');
const UDIR = path.join(TMP, 'unrelated');
const BASE_LOG_PATH = path.join(TMP, 'base.log');
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const ARM_NAMES = new Set(['bypass-route', 'fakereceipt']);
if (ARM !== null && !ARM_NAMES.has(ARM)) {
  console.error(`unknown reverse arm: ${ARM} (known: ${[...ARM_NAMES].join(' | ')})`);
  process.exit(2);
}
let BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');
let BASE_CWD = ROOT;
// 反证臂在副本树里改插件 ⇒ 门进程里直接 import 的插件也必须指向同一份（①③④ 用桩 ctx 直驱）。
let PLUGIN_ENTRY = path.join(ROOT, 'pi-extensions', 'assistant', 'index.ts');

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let baseChild;
let baseLog;
let provider;
let basePort;
let providerPort;
let parentId;
let childIdleId;   // C1：自己的空闲子会话（模型驱动臂）
let childBusyId;   // C2：自己的忙子会话（挂一条 sleep 长回合）
let unrelatedId;   // U：与自己无父子关系的根会话

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
    model: 'fake-setmodeltool',
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

// 假 provider：第一跳按最后一条 user 文本决定调哪个工具；第二跳把工具回执原文回显回来。
// `MODEL_TOOL <ref>` ＝ 改自己；`MODEL_TOOL_CHILD <ref> <sessionId>` ＝ 显式子会话；`BUSY <n>` ＝ 挂一条长回合。
async function startProvider() {
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const part of incoming) raw += part;
    const body = JSON.parse(raw);
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
      const child = /MODEL_TOOL_CHILD (\S+) (\S+)/.exec(prompt);
      if (child) return emitTool('session_set_model', { model: child[1], sessionId: child[2] });
      const self = /MODEL_TOOL (\S+)/.exec(prompt);
      if (self) return emitTool('session_set_model', { model: self[1] });
      const busy = /BUSY (\d+)/.exec(prompt);
      if (busy) return emitTool('bash', { command: `sleep ${busy[1]}` });
      return emitText('FAKE_OK');
    }
    return emitText(`MODEL_ECHO ${lastToolResultText(body.messages)}`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server };
}

async function sessionFileOf(sessionId) {
  const files = await readdir(SESSIONS, { recursive: true });
  const hit = files.find((entry) => typeof entry === 'string' && entry.endsWith(`${sessionId}.jsonl`));
  if (!hit) return null;
  return path.join(SESSIONS, hit);
}

// 形状检查（复用 2026-10-13 调研单 §5.1 那套口径）：按 parentId 建孩子表，凡同父 ≥2 子即一处分叉；
// 另数 model_change 条数（「模型没被改」的文件侧证据）。历史双写分叉的形状就是同父两支 model_change。
async function shapeOf(sessionId) {
  const file = await sessionFileOf(sessionId);
  if (!file) return null;
  const text = await readFile(file, 'utf8');
  const entries = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const childCounts = new Map();
  for (const entry of entries) {
    if (!entry.parentId) continue;
    childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
  }
  let forks = 0;
  for (const count of childCounts.values()) if (count > 1) forks += 1;
  return { forks, entries: entries.length, modelChanges: entries.filter((entry) => entry.type === 'model_change').length };
}

async function modelsCurrentOf(sessionId) {
  const reply = await request(`/sessions/${sessionId}/models`);
  assert.equal(reply.status, 200, reply.raw);
  return reply.value.current ?? null;
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

function parseEcho(text) {
  const parsed = JSON.parse(text.slice('MODEL_ECHO '.length));
  if (Array.isArray(parsed)) return JSON.parse(parsed.map((part) => part.text ?? '').join(''));
  if (parsed && typeof parsed === 'object') return parsed;
  return JSON.parse(String(parsed));
}

async function runToolCall(sessionId, promptText, label) {
  const before = (await messagesOf(sessionId)).length;
  const posted = await request(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: promptText } });
  assert.equal(posted.status, 202, posted.raw);
  const echoed = await poll(`tool echo for ${label}`, async () => {
    const messages = await messagesOf(sessionId);
    return messages.slice(before).find((message) => message.role === 'assistant'
      && typeof message.text === 'string' && message.text.startsWith('MODEL_ECHO ')) ?? null;
  }, (found) => Boolean(found), 60_000);
  const receipt = parseEcho(echoed.text);
  print(`tool receipt ${label}`, receipt);
  return receipt;
}

// 桩 ctx 直驱：import（真/副本树里的）插件，用假 pi 把 registerTool 的注册表抓出来，
// 拿 session_set_model 的 execute 直接调 —— 走的还是同一份代码、同一条 HTTP 路由，
// 只是「发起调用的进程」不在被测会话的回合里 ⇒ 目标可以真的是闲的。
let pluginTools = null;
async function pluginTool(name) {
  if (pluginTools === null) {
    const mod = await import(pathToFileURL(PLUGIN_ENTRY).href);
    const tools = new Map();
    mod.default({
      registerTool: (spec) => tools.set(spec.name, spec),
      on: () => {},
      registerCommand: () => {},
    });
    pluginTools = tools;
  }
  const spec = pluginTools.get(name);
  assert.ok(spec, `plugin must register ${name}`);
  return spec;
}

async function callToolDirectly(callerId, callerFile, params) {
  const spec = await pluginTool('session_set_model');
  const ctx = {
    sessionManager: { getSessionId: () => callerId, getSessionFile: () => callerFile },
    cwd: CWD,
  };
  const result = await spec.execute('gate', params, undefined, undefined, ctx);
  print(`tool receipt (direct, caller=${callerId.slice(0, 8)})`, result.details);
  return result.details;
}

let primaryError = null;
try {
  for (const directory of [HOME, SESSIONS, CWD, UDIR]) await mkdir(directory, { recursive: true });
  if (ARM !== null) {
    // 反证臂：副本树（server + pi-extensions + package.json；node_modules 用 junction —— Windows 免特权）。
    const tree = path.join(TMP, 'reverse-tree');
    await mkdir(tree, { recursive: true });
    for (const part of ['server', 'pi-extensions']) await cp(path.join(ROOT, part), path.join(tree, part), { recursive: true });
    await cp(path.join(ROOT, 'package.json'), path.join(tree, 'package.json'));
    await symlink(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'), 'junction');
    const pluginPath = path.join(tree, 'pi-extensions', 'assistant', 'index.ts');
    let source = await readFile(pluginPath, 'utf8');
    // 锚点一：默认导出的入口 —— 把 pi（ExtensionAPI：它才有进程内 setModel，agent-session.js 的 runtime API；
    // 工具的 ctx 上没有）拑到全局，给下面那个 POST 块的替换体用。
    const exportAnchor = 'export default function (pi: ExtensionAPI) {';
    assert.ok(source.includes(exportAnchor), '反证臂：默认导出入口在插件里找得到');
    source = source.replace(exportAnchor, `${exportAnchor}\n\t(globalThis as any).__sophoReversePi = pi; // REVERSE ARM: stash the ExtensionAPI for the routeless mutation`);
    // 锚点二：setSessionModel 里「④ 真正的写」那个 POST 块（tabs 与插件文件逐字一致）。
    const anchor = '\tconst reply = await requestRaw(`/sessions/${encodeURIComponent(target)}/model`, {\n\t\tmethod: "POST",\n\t\tbody: { model: refOf(selected) },\n\t});\n';
    assert.ok(source.includes(anchor), '反证臂：要插桩的 POST 块在插件里找得到');
    let injected;
    if (ARM === 'bypass-route') {
      // 反证方向一：**绕过 owner 路由**，直接调 pi 的进程内 setModel（agent-session.js 的 runtime API）——
      // 它对在跑的回合零守卫（recon §2.1）。
      injected = '\t// REVERSE ARM: bypass the owner route entirely — in-process setModel (no busy guard).\n'
        + '\tconst routeless = await (globalThis as any).__sophoReversePi.setModel({ provider: selected.provider, id: selected.id });\n'
        + '\tconst reply = { statusCode: routeless === false ? 409 : 200, value: { ok: routeless !== false, sessionId: target, model: refOf(selected), previous: modelsValue.current ?? null, source: modelsValue.source ?? null, matchedBy } };\n';
    } else {
      // 反证方向二：回执照旧谎称 200 成功，实际什么都没调、什么都没改。
      injected = '\t// REVERSE ARM: the receipt lies — 200 ok without doing anything.\n'
        + '\tconst reply = { statusCode: 200, value: { ok: true, sessionId: target, model: refOf(selected), previous: modelsValue.current ?? null, source: modelsValue.source ?? null, matchedBy } };\n';
    }
    await writeFile(pluginPath, source.replace(anchor, injected));
    BASE_ENTRY = path.join(tree, 'server', 'base.mjs');
    BASE_CWD = tree;
    PLUGIN_ENTRY = pluginPath;
    print('reverse-arm mutation', { arm: ARM, tree });
  }

  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used); used.add(basePort);
  // 两个模型（同 provider）：默认 fake-a，可换 fake-b —— 「改模型」得真有第二个可换。
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-a', name: 'Fake A', contextWindow: 8192, maxTokens: 1024 }, { id: 'fake-b', name: 'Fake B', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-a', defaultThinkingLevel: 'off', compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 1 } }, null, 2)}\n`);
  // 门进程里桩 ctx 直驱也要打到同一个宿主（插件的 baseUrl() 在调用时读 SOPHO_PORT）。
  process.env.SOPHO_PORT = String(basePort);

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
    // 热身：pi 在第一条 assistant 消息落盘前不写文件，而路由要走真实 runtime/openPersist ⇒ 会话必须落盘。
    assert.equal((await request(`/sessions/${created.value.id}/message`, { method: 'POST', body: { text: `${name}_WARM` } })).status, 202);
    await waitIdle(created.value.id);
    assert.ok(await sessionFileOf(created.value.id), `${name} 热身之后应当落盘`);
    return created.value.id;
  };
  // 自己的子会话：走宿主的委派路 /spawn（parentSession = 调用者的会话文件）。
  // share:true：沙箱里两条子会话与父同 cwd（本门的被测面是「父子关系」，不是工作区守卫 —— 那是 spawn 自己的門）。
  const spawnChildOf = async (name) => {
    const spawned = await request(`/sessions/${parentId}/spawn`, { method: 'POST', body: { name, share: true } });
    assert.ok(spawned.status >= 200 && spawned.status < 300, spawned.raw);
    const childId = spawned.value.childSessionId ?? spawned.value.sessionId ?? spawned.value.id;
    assert.ok(typeof childId === 'string' && childId.length > 0, spawned.raw);
    assert.equal((await request(`/sessions/${childId}/message`, { method: 'POST', body: { text: `${name}_WARM` } })).status, 202);
    await waitIdle(childId);
    assert.ok(await sessionFileOf(childId), `${name} 热身之后应当落盘`);
    return childId;
  };

  parentId = await createSession(CWD, 'model-parent');
  unrelatedId = await createSession(UDIR, 'unrelated-root');

  if (ARM === null) {
    childIdleId = await spawnChildOf('idle-child');
    childBusyId = await spawnChildOf('busy-child');

    print('sandbox', { tmp: TMP, providerPort, basePort, basePid: baseChild.pid, parentId, childIdleId, childBusyId, unrelatedId, reverse: null });

    const parentFile = await sessionFileOf(parentId);
    const childIdleFile = await sessionFileOf(childIdleId);
    const childBusyFile = await sessionFileOf(childBusyId);
    const unrelatedFile = await sessionFileOf(unrelatedId);

    const { failed } = await runArms([
      ['① 闲 ⇒ 改自己：200、回执含 from/to，且 POST 路径真被走到（current 真变了 ＋ model_change 真多了）', async () => {
        const before = await shapeOf(parentId);
        const currentBefore = await modelsCurrentOf(parentId);
        assert.equal(currentBefore, 'fake/fake-a', `基线：默认模型应当是 fake/fake-a（实为 ${currentBefore}）`);
        const receipt = await callToolDirectly(parentId, parentFile, { model: 'fake/fake-b' });
        assert.equal(receipt.ok, true, JSON.stringify(receipt));
        assert.equal(receipt.statusCode, 200, JSON.stringify(receipt));
        assert.equal(receipt.from, 'fake/fake-a', JSON.stringify(receipt));
        assert.equal(receipt.to, 'fake/fake-b', JSON.stringify(receipt));
        assert.equal(receipt.targetRelation, 'self', JSON.stringify(receipt));
        assert.equal(receipt.persist, false, 'persist 固定 false（回执必须自述）');
        assert.ok(typeof receipt.effective === 'string' && receipt.effective.includes('立即生效'), JSON.stringify(receipt));
        assert.equal('thinkingLevelBefore' in receipt && 'thinkingLevel' in receipt && 'thinkingLevelChanged' in receipt, true, '回执必须自述思考档位是否随行变了');
        // POST 路径真被走到（宿主侧证据）：current 真变了。
        assert.equal(await modelsCurrentOf(parentId), 'fake/fake-b', 'POST /model 必须真的把 current 换到 fake/fake-b');
        // 文件侧证据：真多了一条 model_change。
        const after = await shapeOf(parentId);
        assert.equal(after.modelChanges, before.modelChanges + 1, `应当恰好多一条 model_change：${JSON.stringify({ before, after })}`);
        assert.equal(after.forks, 0, `改完不许有分叉：${JSON.stringify(after)}`);
        // 换回去，给后面的臂留一个已知基线。
        const back = await callToolDirectly(parentId, parentFile, { model: 'fake/fake-a' });
        assert.equal(back.ok, true, JSON.stringify(back));
        assert.equal(await modelsCurrentOf(parentId), 'fake/fake-a');
        const settled = await shapeOf(parentId);
        assert.equal(settled.forks, 0, JSON.stringify(settled));
        return { receipt, before, after };
      }],

      ['② 忙 ⇒ 409 如实拒绝：改自己发生在自己的回合里 ⇒ 409 session_streaming，且模型真的没被改', async () => {
        const before = await shapeOf(parentId);
        const currentBefore = await modelsCurrentOf(parentId);
        const receipt = await runToolCall(parentId, 'MODEL_TOOL fake/fake-b', 'busy-self');
        assert.equal(receipt.ok, false, JSON.stringify(receipt));
        assert.equal(receipt.statusCode, 409, JSON.stringify(receipt));
        assert.equal(receipt.reason, 'session_streaming', JSON.stringify(receipt));
        assert.equal(receipt.changed, false, JSON.stringify(receipt));
        assert.ok(/没有改/.test(receipt.note ?? ''), `回执必须如实说「正忙、没有改」：${receipt.note}`);
        await waitIdle(parentId, 60_000);
        // 「拒绝」必须是真的：模型一个字节没动（宿主侧 ＋ 文件侧双证）。
        assert.equal(await modelsCurrentOf(parentId), currentBefore, '忙时被拒 ⇒ 模型必须没被改（宿主侧 current）');
        const after = await shapeOf(parentId);
        assert.equal(after.modelChanges, before.modelChanges, `忙时被拒 ⇒ 不得新增 model_change：${JSON.stringify({ before, after })}`);
        assert.equal(after.forks, 0, JSON.stringify(after));
        return { receipt, currentBefore };
      }],

      ['③a 显式 sessionId＝自己的空闲子会话 ⇒ 允许：子会话真换了、回执自述 own-child', async () => {
        const before = await shapeOf(childIdleId);
        const receipt = await runToolCall(parentId, `MODEL_TOOL_CHILD fake/fake-b ${childIdleId}`, 'child-idle');
        assert.equal(receipt.ok, true, JSON.stringify(receipt));
        assert.equal(receipt.statusCode, 200, JSON.stringify(receipt));
        assert.equal(receipt.sessionId, childIdleId, JSON.stringify(receipt));
        assert.equal(receipt.targetRelation, 'own-child', JSON.stringify(receipt));
        assert.equal(receipt.from, 'fake/fake-a', JSON.stringify(receipt));
        assert.equal(receipt.to, 'fake/fake-b', JSON.stringify(receipt));
        assert.equal(await modelsCurrentOf(childIdleId), 'fake/fake-b', '子会话必须真的换了（POST 路径被走到）');
        const after = await shapeOf(childIdleId);
        assert.equal(after.modelChanges, before.modelChanges + 1, JSON.stringify({ before, after }));
        assert.equal(after.forks, 0, JSON.stringify(after));
        return { receipt };
      }],

      ['③b 显式 sessionId＝自己的忙子会话 ⇒ 409，且子会话的模型没被改', async () => {
        // 挂一条长回合（bash sleep）⇒ C2 isStreaming。
        assert.equal((await request(`/sessions/${childBusyId}/message`, { method: 'POST', body: { text: 'BUSY 8' } })).status, 202);
        await poll('busy-child streaming', () => request(`/sessions/${childBusyId}`), (reply) => reply.value?.runtime?.isStreaming === true, 30_000);
        const before = await shapeOf(childBusyId);
        const currentBefore = await modelsCurrentOf(childBusyId);
        const receipt = await callToolDirectly(parentId, parentFile, { model: 'fake/fake-b', sessionId: childBusyId });
        assert.equal(receipt.ok, false, JSON.stringify(receipt));
        assert.equal(receipt.statusCode, 409, JSON.stringify(receipt));
        assert.equal(receipt.reason, 'session_streaming', JSON.stringify(receipt));
        assert.equal(receipt.changed, false, JSON.stringify(receipt));
        assert.ok(/没有改/.test(receipt.note ?? ''), `必须如实说「正忙、没有改」：${receipt.note}`);
        assert.equal(await modelsCurrentOf(childBusyId), currentBefore, '忙时被拒 ⇒ 子会话模型必须没被改');
        const after = await shapeOf(childBusyId);
        assert.equal(after.modelChanges, before.modelChanges, JSON.stringify({ before, after }));
        assert.equal(after.forks, 0, JSON.stringify(after));
        await waitIdle(childBusyId, 60_000);
        return { receipt };
      }],

      ['③c 显式 sessionId＝无关根会话 ⇒ 如实拒绝 target_not_own_child，且一个字节没写', async () => {
        const before = await shapeOf(unrelatedId);
        const currentBefore = await modelsCurrentOf(unrelatedId);
        const receipt = await callToolDirectly(parentId, parentFile, { model: 'fake/fake-b', sessionId: unrelatedId });
        assert.equal(receipt.ok, false, JSON.stringify(receipt));
        assert.equal(receipt.reason, 'target_not_own_child', JSON.stringify(receipt));
        assert.equal(receipt.statusCode, null, '本地拒绝，没打路由（无真实 statusCode）');
        assert.ok(/不是你的子会话/.test(receipt.note ?? ''), `必须说明拒绝理由：${receipt.note}`);
        assert.equal(receipt.parentId ?? null, null, '无关根会话没有父');
        assert.equal(await modelsCurrentOf(unrelatedId), currentBefore, '被拒 ⇒ 模型没被改');
        const after = await shapeOf(unrelatedId);
        assert.equal(after.modelChanges, before.modelChanges, JSON.stringify({ before, after }));
        assert.equal(after.forks, 0, JSON.stringify(after));
        return { receipt };
      }],

      ['③d 显式 sessionId＝自己的父会话 ⇒ 同样拒绝（父不是子）', async () => {
        const receipt = await callToolDirectly(childIdleId, childIdleFile, { model: 'fake/fake-b', sessionId: parentId });
        assert.equal(receipt.ok, false, JSON.stringify(receipt));
        assert.equal(receipt.reason, 'target_not_own_child', JSON.stringify(receipt));
        assert.equal(receipt.parentId ?? null, null, '父会话是根 ⇒ 没有父');
        assert.equal(await modelsCurrentOf(parentId), 'fake/fake-a', '被拒 ⇒ 父会话模型没被改');
        return { receipt };
      }],

      ['④ 未知 model ⇒ 拒绝并列出可用值（不猜、不改）', async () => {
        const before = await shapeOf(parentId);
        const currentBefore = await modelsCurrentOf(parentId);
        const receipt = await callToolDirectly(parentId, parentFile, { model: 'fake/does-not-exist' });
        assert.equal(receipt.ok, false, JSON.stringify(receipt));
        assert.equal(receipt.reason, 'model_not_found', JSON.stringify(receipt));
        assert.deepEqual(receipt.availableModels, ['fake/fake-a', 'fake/fake-b'], `必须列出可用值：${JSON.stringify(receipt)}`);
        assert.equal(await modelsCurrentOf(parentId), currentBefore, '被拒 ⇒ 模型没被改');
        const after = await shapeOf(parentId);
        assert.equal(after.modelChanges, before.modelChanges, JSON.stringify({ before, after }));
        assert.equal(after.forks, 0, JSON.stringify(after));
        return { receipt };
      }],

      ['⑤ 全部目标会话 forks == 0（没有重开 model_change 双写口的形状证据）', async () => {
        for (const [label, id] of [['P', parentId], ['C1', childIdleId], ['C2', childBusyId], ['U', unrelatedId]]) {
          const shape = await shapeOf(id);
          assert.ok(shape, `${label} 会话文件应当存在`);
          assert.equal(shape.forks, 0, `${label} 不得有分叉：${JSON.stringify(shape)}`);
        }
        return { checked: [parentId, childIdleId, childBusyId, unrelatedId] };
      }],
    ], { title: 'set-model-tool' });

    if (failed.length === 0) {
      print('RESULT', 'session_set_model gate PASS (idle-self 200 + busy 409 honest refusal with model untouched + own-child allowed / non-child refused + unknown model listed + forks==0 everywhere)');
    } else {
      print('RESULT', `session_set_model gate RED (${failed.length} arm(s)) — ${failed.map((item) => item.name).join(' | ')}`);
    }
  } else {
    // 反证臂：只跑 ②（忙 ⇒ 409 且模型没改）—— 两个变异方向都必须让这条红。
    print('sandbox', { tmp: TMP, providerPort, basePort, basePid: baseChild.pid, parentId, reverse: ARM });
    const before = await shapeOf(parentId);
    const currentBefore = await modelsCurrentOf(parentId);
    const { failed } = await runArms([
      ['② 忙 ⇒ 409 如实拒绝（反证：变异后必须红）', async () => {
        const receipt = await runToolCall(parentId, 'MODEL_TOOL fake/fake-b', `busy-self-reverse-${ARM}`);
        assert.equal(receipt.ok, false, JSON.stringify(receipt));
        assert.equal(receipt.statusCode, 409, JSON.stringify(receipt));
        assert.equal(receipt.reason, 'session_streaming', JSON.stringify(receipt));
        assert.equal(receipt.changed, false, JSON.stringify(receipt));
        await waitIdle(parentId, 60_000);
        assert.equal(await modelsCurrentOf(parentId), currentBefore, '忙时被拒 ⇒ 模型必须没被改');
        const after = await shapeOf(parentId);
        assert.equal(after.modelChanges, before.modelChanges, JSON.stringify({ before, after }));
        return { receipt };
      }],
    ], { title: `set-model-tool (reverse: ${ARM})` });
    if (failed.length > 0) print('RESULT', `session_set_model gate RED as expected (${failed.length} arm(s)) — ${failed.map((item) => item.name).join(' | ')}`);
    else print('RESULT', `session_set_model gate UNEXPECTEDLY GREEN under reverse arm ${ARM} — the gate is not watching what it must watch`);
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
