#!/usr/bin/env node
// `GET /debug/instances` 的**工具清单**那一块（`tools`）的验收门：真沙箱（真起 A + 真 worker），
// 用假 provider 让**真会话**跑一个回合，再把**三份互相独立的事实**对起来：
//
//   ① 插件源码里 `pi.registerTool({ name: "…" })` 的静态扫描集 S；
//   ② 门里钉死的清单 EXPECTED_TOOLS（「登记处」：新加一个工具而不改这里 ⇒ 必红）；
//   ③ 端点 `tools.registered` 里属于本插件的那一批 R（它是**就地读活 runtime 的 pi 会话对象**来的）。
// 再加一条模型面的交叉证据：假 provider 收到的 `body.tools[].function.name` 就是**真正发给模型**的工具面
// ⇒ 它必须等于 `tools.activeBySession[<这条会话>].active`。工具面是**会话级**的，这条断言就是钉它。
//
// ⚠️ 为什么要有 EXPECTED_TOOLS 这一份：只比「源码扫描 vs 端点吐出的」的话，两边同时变（加了个工具）
// 就永远相等，清单会**静默过期**。钉死一份、并让源码扫描也等于它，加工具/漏登记两条路都必然红。
//
// 另有一臂量「**没有活 runtime** ⇒ 如实说取不到」（不是吐一份空清单假装没有工具）。
// 常驻反证臂：`npm run test:debugtools:reverse-shrink`（端点少吐一条 ⇒ 必红）、`:reverse-unregistered`
//（源码加了工具而清单没登记 ⇒ 必红）、`:reverse-unparsable`（新注册点写成扫描器认不出的形状 ⇒ 必红）、
// `:reverse-paramdesc`（把插件某个参数的 `description` 抹掉 ⇒ 端点照实吐 null、门里钉死的那条必红）、
// `:reverse-groupdrop`（把某个工具从**分组声明表**里摘掉 ⇒ 声明表不再覆盖全部工具 ⇒ 必红）、
// `:reverse-groupblank`（把某一组的**组名**抹成空串 ⇒ 「每个工具都有非空分组」那条必红）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, runGateOnMutatedCopy, stopSpawnedListener } from './harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 反证臂用它指向「改过一处的副本」；正常跑就是真树。
const sourceRoot = process.env.SOPHO_DEBUG_GATE_ROOT ? path.resolve(process.env.SOPHO_DEBUG_GATE_ROOT) : repoRoot;
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
// 沙箱在 `runGate()` 里建（反证臂模式不打自己的沙箱，免得留一个没人删的目录）。
let sandbox;
let home;
let cwd;
let sessionsRoot;
let baseLogPath;
let baseEntry;
const PLUGIN_SOURCE = path.join(sourceRoot, 'pi-extensions', 'assistant', 'index.ts');
const PLUGIN_SUFFIX = 'pi-extensions/assistant/index.ts';
const SESSION_ID = randomUUID();
const MODEL = 'fake-debug-tools';

// 本插件注册表的「登记处」。它必须与插件源码里的注册点、以及端点 `tools.registered` 里属于本插件的那批
// 三方一致。**加一个工具就要改这里** —— 这正是「忘了登记 ⇒ 必红」的那道闸。
const EXPECTED_TOOLS = [
  'cwd', 'device_list', 'device_probe', 'device_run',
  'handoff', 'image_generate', 'question_ask', 'question_close', 'question_list', 'reclaim_worktree',
  'session_archive', 'session_new', 'session_push', 'session_read', 'session_send', 'session_set_model', 'session_set_title',
];

let providerServer;
let baseChild;
let baseLog;
let providerPort;
let basePort;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

async function reserveHighPort(excluded = new Set()) {
  for (let candidate = 23000 + Math.floor(Math.random() * 30000); candidate < 63000; candidate += 1) {
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

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${basePort}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value, raw: text };
}

async function poll(label, operation, predicate, timeoutMs = 10_000) {
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

// 源码里的注册点（`pi.registerTool({ name: "…" })`）。**不是**从运行时拿的——两条独立事实。
async function registeredToolNamesInSource() {
  const source = await readFile(PLUGIN_SOURCE, 'utf8');
  const pattern = /pi\.registerTool\(\{\s*\n?\s*name:\s*"([^"]+)"/g;
  const names = [];
  let match;
  while ((match = pattern.exec(source)) !== null) names.push(match[1]);
  const occurrences = (source.match(/pi\.registerTool\(/g) ?? []).length;
  assert.equal(occurrences, names.length, `every pi.registerTool({ name: "…" }) occurrence must be parsed by this gate; parsed=${JSON.stringify(names.sort())}`);
  return names.sort();
}

function sse(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((part) => part?.text || '').join('');
}

function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messageText(messages[index]);
  }
  return '';
}

async function startProvider() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const prompt = latestUserText(body.messages).trim();
    const tools = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
    requests.push({ prompt, tools, lastRole: body.messages?.at(-1)?.role ?? null });
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    sse(response, { role: 'assistant', content: `DONE:${prompt}` });
    sse(response, {}, 'stop');
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, requests };
}

function sessionFile(id) {
  const now = new Date().toISOString();
  return `${[
    { type: 'session', version: 3, id, timestamp: now, cwd },
    { type: 'model_change', id: `${id}-model`, parentId: null, timestamp: now, provider: 'fake', modelId: MODEL },
  ].map(JSON.stringify).join('\n')}\n`;
}

async function runGate() {
  let primaryError;
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'debug-tools-'));
  home = path.join(sandbox, 'home');
  cwd = path.join(sandbox, 'workspace');
  sessionsRoot = path.join(home, 'sessions');
  baseLogPath = path.join(sandbox, 'base.log');
  baseEntry = path.join(sourceRoot, 'server', 'base.mjs');
  try {
  for (const directory of [home, cwd, sessionsRoot]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(sessionsRoot, `seed_${SESSION_ID}.jsonl`), sessionFile(SESSION_ID));

  const used = new Set();
  providerPort = await reserveHighPort(used); used.add(providerPort);
  basePort = await reserveHighPort(used); used.add(basePort);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    api: 'openai-completions',
    apiKey: 'sandbox',
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{ id: MODEL, name: 'Debug Tools Fake', contextWindow: 8192, maxTokens: 1024 }],
  } } }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake', defaultModel: MODEL, defaultThinkingLevel: 'off',
    compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);

  const provider = await startProvider();
  providerServer = provider;
  baseLog = await open(baseLogPath, 'w');
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
      SOPHO_MAX_HOT: '4',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  await poll('base ready', () => api('/host'), (reply) => reply.statusCode === 200, 30_000);
  assert.equal(Number(await listenerPid(basePort)), baseChild.pid);
  print('sandbox', { home, providerPort, basePort, basePid: baseChild.pid, sessionId: SESSION_ID, forbiddenPortsUsed: false });

  // ——— 臂 A：一条热 runtime 都没有 ⇒ 如实说「取不到」，不是吐一份空清单假装没有工具 ———
  const cold = (await api('/debug/instances')).value;
  assert.equal(cold.tools.liveSessionCount, 0, JSON.stringify(cold.tools));
  assert.equal(cold.tools.registered, null);
  assert.equal(cold.tools.registeredCount, null);
  assert.equal(cold.tools.observedOn, null);
  assert.equal(typeof cold.tools.registeredUnavailableReason, 'string');
  assert.ok(cold.tools.registeredUnavailableReason.length > 20);
  assert.equal(cold.tools.groups, null);
  assert.equal(typeof cold.tools.groupsUnavailableReason, 'string');
  assert.ok(cold.tools.groupsUnavailableReason.length > 20);
  assert.equal(cold.tools.groupTable.registeredButNotDeclared, null, 'read nothing ≠ everything is stale: the diff sets must be null, not an empty array');
  assert.equal(cold.tools.groupTable.declaredButNotRegistered, null);
  assert.ok(Array.isArray(cold.tools.groupTable.groups) && cold.tools.groupTable.groups.length > 0, 'the declaration table is a static fact ⇒ it is readable even with no live runtime');
  assert.deepEqual(cold.tools.activeBySession, []);
  print('toolsWithoutLiveRuntime', {
    liveSessionCount: cold.tools.liveSessionCount,
    registered: cold.tools.registered,
    registeredUnavailableReason: cold.tools.registeredUnavailableReason,
    groups: cold.tools.groups,
    activeBySession: cold.tools.activeBySession,
  });

  // ——— 臂 B：真跑一个回合（于是有了一条热 runtime），再拿三方事实对账 ———
  const sent = await api(`/sessions/${SESSION_ID}/message`, { method: 'POST', body: { text: 'read my tool surface' } });
  assert.equal(sent.statusCode, 202, sent.raw);
  await poll('turn persisted', () => api(`/sessions/${SESSION_ID}/messages`),
    (reply) => reply.statusCode === 200 && reply.value.messages.some((message) => message.role === 'assistant'));
  const live = (await api('/debug/instances')).value;
  print('toolsRaw', JSON.stringify(live.tools));

  // ① 源码注册点（静态事实）
  const sourceNames = await registeredToolNamesInSource();
  print('sourceRegisterToolNames', sourceNames);
  assert.deepEqual(sourceNames, EXPECTED_TOOLS, 'the plugin source registered a different tool set than this gate has on record');

  // ② 端点吐出的、属于本插件的那一批（`sourceInfo.path` 是唯一能认出插件的那一项；
  //    实测 `sourceInfo.source` 是 "cli"，不是路径）
  assert.equal(live.tools.liveSessionCount, 1);
  assert.equal(live.tools.observedOn, SESSION_ID);
  assert.equal(live.tools.registeredUnavailableReason, null);
  assert.equal(live.tools.identicalRegisteredAcrossLiveSessions, true);
  const registered = live.tools.registered ?? [];
  const pluginTools = registered.filter((tool) => typeof tool.path === 'string' && tool.path.replace(/\\/g, '/').endsWith(PLUGIN_SUFFIX));
  const reportedNames = pluginTools.map((tool) => tool.name).sort();
  print('endpointReportedPluginTools', reportedNames);
  assert.deepEqual(reportedNames, EXPECTED_TOOLS, 'the endpoint reported a different tool set than the plugin registered');
  assert.equal(pluginTools.length, EXPECTED_TOOLS.length);
  assert.equal(live.tools.registeredCount, registered.length);
  for (const tool of registered) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.hasParameters, 'boolean');
    assert.equal(tool.hasParameters, true, `${tool.name} must carry a parameter schema`);
    assert.ok(Array.isArray(tool.parameterNames), `${tool.name} must expose its schema's top-level property names (an empty array is a real answer: e.g. a no-argument tool)`);
    assert.equal(typeof tool.descriptionHead, 'string');
    assert.ok(typeof tool.path === 'string' && tool.path.length > 0);
    // 业主 2026-09-25 那条要求：**名称/描述/参数/参数说明**四样都要。
    //   · `description` 是**全文**（`descriptionHead` 只是前 160 字，两个都要有）；
    //   · `parameters` 是那份 JSON Schema **原样**；
    //   · `parameterDetails` 每个参数一条 `{ name, type, required, description }`。
    assert.equal(typeof tool.description, 'string', `${tool.name} must carry its FULL description`);
    assert.ok(tool.description.length > 0, `${tool.name} must carry its FULL description`);
    assert.ok(tool.description.length >= tool.descriptionHead.length, `${tool.name}: the full description must not be shorter than its head`);
    assert.ok(tool.parameters !== null && typeof tool.parameters === 'object', `${tool.name} must carry its JSON Schema verbatim`);
    assert.ok(Array.isArray(tool.parameterDetails), `${tool.name} must carry one record per parameter`);
    assert.equal(tool.parameterDetails.length, tool.parameterNames.length, `${tool.name}: parameterDetails must cover every top-level parameter`);
    assert.deepEqual(tool.parameterDetails.map((detail) => detail.name), tool.parameterNames, `${tool.name}: parameterDetails must follow the schema's property order`);
    const requiredNames = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
    for (const detail of tool.parameterDetails) {
      assert.equal(typeof detail.name, 'string');
      assert.ok(detail.type === null || typeof detail.type === 'string', `${tool.name}.${detail.name}: type is the JSON Schema type or null, never a guess`);
      assert.equal(typeof detail.required, 'boolean');
      assert.ok(detail.description === null || (typeof detail.description === 'string' && detail.description.length > 0), `${tool.name}.${detail.name}: description must be the real string or null (never an empty-string stand-in)`);
      // 逐键对账：那一条必须**就是** schema 里那个 property 的原文，不是另编一份。
      const schemaProperty = tool.parameters.properties?.[detail.name];
      assert.ok(schemaProperty && typeof schemaProperty === 'object', `${tool.name}.${detail.name} must exist in the JSON Schema's properties`);
      assert.equal(detail.type, typeof schemaProperty.type === 'string' ? schemaProperty.type : null, `${tool.name}.${detail.name}: type must equal the schema's type`);
      assert.equal(detail.description, typeof schemaProperty.description === 'string' && schemaProperty.description.trim() !== '' ? schemaProperty.description : null, `${tool.name}.${detail.name}: description must equal the schema's description (null when pi's definition has none)`);
      assert.equal(detail.required, requiredNames.includes(detail.name), `${tool.name}.${detail.name}: required must equal the schema's required[]`);
    }
  }

  // 钉住**真工具**：内建 `read` 的三个参数逐字对得上 pi 的定义（不是「字段存在即可」）。
  const registeredByName = new Map(registered.map((tool) => [tool.name, tool]));
  const readTool = registeredByName.get('read');
  assert.ok(readTool, 'the builtin read tool must be in the registered list');
  assert.equal(readTool.description, 'Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.', 'read.description must be the FULL pi description, byte for byte');
  assert.ok(readTool.descriptionHead.endsWith('…') && readTool.description.startsWith(readTool.descriptionHead.slice(0, -1)), 'read.descriptionHead must be the truncated head of the full description');
  assert.deepEqual(readTool.parameterDetails, [
    { name: 'path', type: 'string', required: true, description: 'Path to the file to read (relative or absolute)' },
    { name: 'offset', type: 'number', required: false, description: 'Line number to start reading from (1-indexed)' },
    { name: 'limit', type: 'number', required: false, description: 'Maximum number of lines to read' },
  ], "read's parameter descriptions must match pi's tool definition byte for byte");
  // 也钉一个**本插件**的工具（证明插件那一路的说明同样照实带出来）。
  const sessionNewTool = registeredByName.get('session_new');
  assert.ok(sessionNewTool, 'the plugin session_new tool must be in the registered list');
  assert.equal(sessionNewTool.parameterDetails.find((detail) => detail.name === 'task')?.description, "Task to send as the child's first user message", "session_new.task must carry pi's parameter description byte for byte");
  assert.equal(sessionNewTool.parameterDetails.find((detail) => detail.name === 'task')?.required, false, 'session_new.task is optional (omit to create without a turn) ⇒ required must be false');
  assert.equal(sessionNewTool.parameterDetails.find((detail) => detail.name === 'name')?.required, false, 'session_new.name is optional in the schema ⇒ required must be false');
  // 照实报：pi 的定义里**就是有两个**参数没写说明（`StringEnum(...)` 不带 description）——
  // 端点到那里必须给 `null`（UI 逐字写「这一项取不到」），**不许**拿空串或编一句顶替。
  // 哪天真给它们补上说明，这两条会红 ⇒ 改这里（这正是「照实登记」的机械意思）。
  const undocumented = [];
  for (const tool of registered) {
    for (const detail of tool.parameterDetails) if (detail.description === null) undocumented.push(`${tool.name}.${detail.name}`);
  }
  print('parametersWithoutDescription', undocumented);
  assert.deepEqual(undocumented.sort(), [], 'the gate records exactly which parameters pi leaves without a description (null, stated honestly); after the reading tools retired, none are left');
  const noArgumentTools = registered.filter((tool) => tool.parameterDetails.length === 0).map((tool) => tool.name).sort();
  print('toolsWithoutParameters', noArgumentTools);
  assert.deepEqual(noArgumentTools, ['cwd', 'device_list'], 'a no-argument tool must be an empty parameterDetails list, not a missing field');
  print('readParameterDetails', readTool.parameterDetails);
  print('sessionNewParameterDetails', sessionNewTool.parameterDetails);

  // 业主 2026-09-26 那条要求：**工具要对应的分组**（`docs/human/v2.2-lessons.md` §调试工具）。
  // 四层判据，全在真沙箱的真会话上：
  //   ① 每个已注册工具都有**非空** `group`，且 `groupSource` 是「怎么定下来的」那两个合法值之一
  //      （`unclassified` 就是登记缺口，本门不许它出现）；
  //   ② 分组视图（`tools.groups`）与逐工具字段**互相一致**（不重不漏，组内计数对得上）；
  //   ③ 声明表要**覆盖全部**工具：`registeredButNotDeclared` / `declaredButNotRegistered` 两个差集
  //      都必须为空（新工具没进表 ⇒ 红；表里留着已经不在的工具 ⇒ 也红）；
  //   ④ 表自身要干净：组名不重复、一个工具只归一组、插件一律 `declared`、内建一律 `builtin-table`。
  // 判据顺序：① **先**判「声明表覆盖全部工具」（那是「新工具没进表 ⇒ 红」的尖刀）⇒ ② 再判逐工具字段
  // 与分组视图（同一份事实的两种视图，不重不漏）⇒ ③ 最后判两边的来源语义。
  const allRegisteredNames = registered.map((tool) => tool.name);
  const groupTable = live.tools.groupTable;
  assert.ok(groupTable && typeof groupTable === 'object', 'tools.groupTable must carry the declaration table itself');
  assert.deepEqual(groupTable.registeredButNotDeclared, [], 'every registered tool must be declared in the group table; a new tool with no group is a registration gap');
  assert.deepEqual(groupTable.declaredButNotRegistered, [], 'the group table must not name tools that are no longer registered');
  assert.deepEqual(groupTable.duplicateToolNames, [], 'a tool must be declared in exactly one group');
  assert.equal(new Set(groupTable.groups.map((group) => group.name)).size, groupTable.groups.length, 'group names must be unique');
  assert.ok(groupTable.groups.every((group) => group.tools.length > 0 && typeof group.name === 'string' && group.name.trim() !== ''), 'the declared table must not carry an empty or unnamed group');
  const declaredNames = groupTable.groups.flatMap((group) => group.tools);
  assert.deepEqual([...declaredNames].sort(), [...allRegisteredNames].sort(), 'the declared table must cover exactly the registered tools');
  assert.ok(typeof groupTable.declaredIn === 'string' && groupTable.declaredIn.includes('POST /reload-code'), `the table must say where it lives and when it takes effect: ${groupTable.declaredIn}`);
  for (const tool of registered) {
    assert.ok(typeof tool.group === 'string' && tool.group.trim().length > 0, `${tool.name} must carry a non-empty group`);
    assert.ok(tool.groupSource === 'declared' || tool.groupSource === 'builtin-table', `${tool.name}: groupSource must say how its group was decided (declared / builtin-table); 'unclassified' is the registration gap this gate fails on: ${tool.groupSource}`);
  }
  assert.equal(live.tools.groupsUnavailableReason, null);
  const groups = live.tools.groups;
  assert.ok(Array.isArray(groups) && groups.length > 0, `tools.groups must be the group view: ${JSON.stringify(groups)}`);
  const groupedNames = groups.flatMap((group) => group.tools);
  assert.equal(groupedNames.length, allRegisteredNames.length, 'a tool must appear in exactly one group of the view');
  assert.deepEqual([...groupedNames].sort(), [...allRegisteredNames].sort(), 'the group view must cover exactly the registered tools (no repeat, no omission)');
  for (const group of groups) {
    assert.ok(typeof group.name === 'string' && group.name.trim() !== '', `every group must be named: ${JSON.stringify(group)}`);
    assert.equal(group.toolCount, group.tools.length, `${group.name}: toolCount must equal the tools listed`);
    assert.ok(group.toolCount > 0, 'the group view must not carry an empty group');
    for (const name of group.tools) assert.equal(registeredByName.get(name).group, group.name, `${name}: the per-tool group and the group view must agree`);
  }
  // 最后：两边的来源语义钉住：插件那批一律 `declared`，pi 内建那批一律 `builtin-table`。
  assert.deepEqual([...new Set(pluginTools.map((tool) => tool.groupSource))], ['declared'], 'every plugin tool must be declared in the table (groupSource=declared)');
  const builtinTools = registered.filter((tool) => !pluginTools.includes(tool));
  assert.equal(builtinTools.length, 8, `pi's own file/shell tools must all be classified: ${JSON.stringify(builtinTools.map((tool) => tool.name))}`);
  assert.deepEqual([...new Set(builtinTools.map((tool) => tool.groupSource))], ['builtin-table'], 'pi built-ins must come from the built-in table, matched by name');
  print('toolGroups', groups.map((group) => ({ name: group.name, groupSource: group.groupSource, toolCount: group.toolCount })));
  print('groupTable', { declaredIn: groupTable.declaredIn, groups: groupTable.groups.length, duplicateToolNames: groupTable.duplicateToolNames });

  // ③ 模型面交叉证据：真正发给模型的工具名 == 端点给这条会话报的 active（工具面是**会话级**的）
  const providerRequest = provider.requests.find((entry) => entry.prompt === 'read my tool surface');
  assert.ok(providerRequest, 'the provider never saw the warm-up request');
  const modelFacing = [...providerRequest.tools].sort();
  const activeRow = (live.tools.activeBySession ?? []).find((row) => row.sessionId === SESSION_ID);
  assert.ok(activeRow, 'tools.activeBySession must carry a row for the live session');
  assert.equal(activeRow.activeCount, activeRow.active.length);
  print('modelFacingTools', modelFacing);
  print('endpointActiveForSession', [...activeRow.active].sort());
  assert.deepEqual([...activeRow.active].sort(), modelFacing, 'the endpoint\'s per-session active list must equal the tool names actually sent to the model for that session');
  assert.ok(activeRow.active.includes('read') && activeRow.active.includes('bash'));

  print('RESULT', 'debug-tools PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  if (basePort) {
    try { await stopSpawnedListener(baseChild, basePort, baseEntry); } catch (error) { process.stderr.write(`base cleanup failed: ${error.message}\n`); }
  }
  if (providerServer?.server) {
    providerServer.server.closeAllConnections();
    await new Promise((resolve) => providerServer.server.close(resolve));
  }
  if (baseLog) await cleanupStep(cleanupProblems, 'close baseLog', () => baseLog.close());
  if (baseChild && baseChild.exitCode === null) await new Promise((resolve) => baseChild.once('exit', resolve));
  const baseOutput = await readFile(baseLogPath, 'utf8').catch(() => '');
  if (baseOutput.trim()) print('base log', baseOutput.trim());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
  }
}

// ── 常驻反证臂（本仓惯例：把交付物**副本**改一处，再拿**真门**去打那份副本，断言必红）────────────
// 机械在 `test/harness.mjs` 的 `runGateOnMutatedCopy()`：副本建在仓库根里的 `.sopho-debugarm-sandbox-*/`
// （必须在仓内：`node_modules` 靠向上查找解析），跑完收敛式删除。为什么必须打副本：拿真树去改就污染
// 正在交付的东西 —— 本仓实测踩过「用 `git checkout --` 还原手臂时把**未提交**的交付改动一起还原掉」。
// 两条插件臂共用同一个接缝（`pi.registerCommand("handoff"` 之前插一个 `pi.registerTool`）。
const PLUGIN_SEAM = '\tpi.registerCommand("handoff", {';
const EXTRA_TOOL = (comment) => `\tpi.registerTool({\n${comment}\t\tname: "debug_extra_probe",\n\t\tlabel: "Extra probe",\n\t\tdescription: "A reverse-arm tool that exists only to prove the tool-list gate goes red.",\n\t\tparameters: Type.Object({}),\n\t\tasync execute() {\n\t\t\treturn toolResult({ ok: true });\n\t\t},\n\t});\n\n`;

const ARM_MUTANTS = {
  shrink: {
    what: '把端点吐出的工具集合**少一条**（`registered` 里滤掉 `session_push`）',
    file: 'server/base-logic.mjs',
    from: '      const registered = surface.registered.map(toolRecord).sort((left, right) => String(left.name).localeCompare(String(right.name)));',
    to: "      const registered = surface.registered.map(toolRecord).filter((tool) => tool.name !== 'session_push').sort((left, right) => String(left.name).localeCompare(String(right.name)));",
    expect: 'the endpoint reported a different tool set than the plugin registered',
  },
  paramdesc: {
    what: '把插件某个参数的说明**抹掉**（`session_new.task` 去掉 `description`）⇒ 端点照实吐 null、门里钉死的那条必红',
    file: 'pi-extensions/assistant/index.ts',
    from: 'task: Type.Optional(Type.String({ description: "Task to send as the child\'s first user message" })),',
    to: 'task: Type.Optional(Type.String({})),',
    expect: "session_new.task must carry pi's parameter description byte for byte",
  },
  unregistered: {
    what: '源码里加一个 `pi.registerTool`，而门里的 EXPECTED_TOOLS 没登记它',
    file: 'pi-extensions/assistant/index.ts',
    from: PLUGIN_SEAM,
    to: `${EXTRA_TOOL('')}${PLUGIN_SEAM}`,
    expect: 'the plugin source registered a different tool set than this gate has on record',
  },
  unparsable: {
    what: '源码里加一个**扫描器解析不出来**的 `pi.registerTool`（`{` 与 `name:` 之间插一行注释）',
    file: 'pi-extensions/assistant/index.ts',
    from: PLUGIN_SEAM,
    to: `${EXTRA_TOOL('\t\t// reverse-arm:unparsable\n')}${PLUGIN_SEAM}`,
    expect: 'must be parsed by this gate',
  },
  groupdrop: {
    what: '把分组声明表里的一个工具**摘掉**（`session_push`）⇒ 它掉进显式组「未分组」、声明表不再覆盖全部工具',
    file: 'server/base-logic.mjs',
    from: "{ name: '树形会话组', source: 'declared', tools: ['cwd', 'handoff', 'session_new', 'session_push', 'session_read', 'session_send', 'session_set_title'] },",
    to: "{ name: '树形会话组', source: 'declared', tools: ['cwd', 'handoff', 'session_new', 'session_read', 'session_send', 'session_set_title'] },",
    expect: 'every registered tool must be declared in the group table',
  },
  groupblank: {
    what: '把某一组的**组名抹成空串**（`提问组`）⇒ 那一组工具的 `group` 就是空串（声明表不允许无名/空名组）',
    file: 'server/base-logic.mjs',
    from: "{ name: '提问组', source: 'declared',",
    to: "{ name: '', source: 'declared',",
    expect: 'must not carry an empty or unnamed group',
  },
};

async function runReverseArm(name) {
  const arm = ARM_MUTANTS[name];
  if (!arm) throw new Error(`不认识的反证臂：${name}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);
  process.stdout.write(`反证臂 ${name}：${arm.what}\n`);
  const result = await runGateOnMutatedCopy({
    root: repoRoot,
    tag: 'debugarm',
    dirs: ['server', 'pi-extensions', 'web'],
    gateFile: fileURLToPath(import.meta.url),
    expect: arm.expect,
    mutate: async (copyRoot) => {
      const file = path.join(copyRoot, arm.file);
      const text = await readFile(file, 'utf8');
      if (!text.includes(arm.from)) {
        throw new Error(`反证臂 ${name} 的改写**没命中**（接缝形状变了？）：${arm.file}\n  要找：${JSON.stringify(arm.from)}`);
      }
      await writeFile(file, text.replace(arm.from, arm.to), 'utf8');
    },
  });
  print('reverseArm', { name, exitCode: result.exitCode, redLine: result.redLine });
  if (result.problems.length > 0) {
    process.stderr.write(`cleanup problems (secondary): ${result.problems.join('; ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`✓ 反证臂 ${name} 红到位（这是**期望**的结果，不是缺陷）：${result.redLine}\n`);
}

if (ARM) await runReverseArm(ARM);
else await runGate();
