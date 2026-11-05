#!/usr/bin/env node
// S4 源会话 durability 门 —— 「源会话还没落盘」这一条臂（业主 2026-09-21 拍板的三条诚实性缺陷里
// 的 (a)/(b) 与 (d)）＋ `/move` 的正面真机验证（(e)）＋ 用户面 `/move`·`/handoff` 命令那条真路（(f)）。
//
// 为什么有这个文件（每条缺陷都在真代码上核到行号与复现）：
//   (a)(b) 源会话没落盘：pi 的 SessionManager 在**第一条 assistant 消息出现之前根本不写文件**
//   （`@earendil-works/pi-coding-agent/dist/core/session-manager.js` 的 `_persist`：
//    `hasAssistant === false` 时直接 return）。所以一条建出来、还没跑过任何回合的会话
//   （`POST /sessions`、`session_new`）是**热的**，池记 `internalKey:"pending:<id>"` / `durable:false`，
//   而 `adapter.manager.getSessionFile()` 已经给出一个**盘上还不存在**的路径。
//     · (a) 同一事实两种说法：`/move` 答 `409 session_not_durable`，handoff 答 `404 session_not_found`
//       （"会话不存在"）—— 把调用方引向错方向；
//     · (b) `/move` 拿那个不存在的路径直接 `readFile` ⇒ `500 internal_error ENOENT`（崩，不是拒绝）。
//   修法：两条路都走 `sourceNotDurable()`（`server/base-logic.mjs`），同码同文案
//   （`409 session_not_durable` + "先发一条消息让它 durable，或换一条已落盘的会话"）。
//
//   (f) 用户面 `/move` **必然 409**（比上面两条更重）：pi 的 `prompt()` 对 `/cmd` 先派给扩展 handler、
//   handler 回来之后才 `preflightResult(true)`（`agent-session.js` 的 `_tryExecuteExtensionCommand`），
//   而本部署 `startPrompt()` 在调 `session.prompt()` **之前**就把 `admissionPending` 置真、
//   `isWorking()` 含这个标志 ⇒ handler 回头打 `POST /sessions/{自己}/move` 时 `moveSession` 必判忙。
//   现场：`/move <目录>` 当消息发进去 ⇒ `202 {"accepted":true}` 之后什么都没发生（不跑模型、不建 fork、
//   不归档），只有一条**瞬时** `session.notice`（无订阅者即丢）：
//   `409 move refused: …`，而它的 `details.runtime` 三个流状态**全 false**。
//   修法：`adapter.isAdmittingOwnCommand()`（准入的是**这条 prompt 正在派发扩展命令**，没有任何模型回合在飞）
//   ⇒ `moveSession` 放行这一种，其余忙因（流/压紧/重试/真 prompt 准入）照旧 409。
//
// 门（**同一份门代码**跑三臂）：
//   G_pending_handoff / G_pending_move：未落盘的源 ⇒ 诚实码（**不是 404、不是 500**）
//                                        ＋ 不建新会话 ＋ 源会话状态没被改；
//   G_durable_positive                ：已落盘的源 ⇒ 正常成功（handoff 200 / move 201）；
//   G_move_positive（(e)）            ：临时会话先落盘 ⇒ move 到另一个已存在目录，逐项核
//                                        cwd 逐字 / 无损 / 源被归档 / movedTo 字段，并**用证据**回答
//                                        "主人说'搬到 X'之后，他还能在新会话里接着原来的上下文说吗"；
//   G_move_command / G_handoff_command：把 `/move …` / `/handoff --cwd …` 当**一条消息**发进去
//                                        （真走 prompt→扩展命令派发）：必须真搬成 / 真建出兄弟会话，
//                                        来源会话只收到一条 info notice、**没有** error notice；
//   G_census_pending / G_archive_all   ：pending 上的路由普查（只列事实）与收尾归档。
//
// 三条臂：
//   arm real            真代码（未打补丁的副本）     ⇒ 全部门**全绿**；
//   arm mutant          把 (a)/(b) 的修法去掉        ⇒ G_pending_* **必红**，且必须重现旧形状
//                       （handoff 404 session_not_found / move 500 internal_error）；
//   arm command-mutant  把 (f) 的修法去掉            ⇒ G_move_command **必红**，且必须重现那条原始
//                       `session.notice` 原文（含 `details.runtime` 三false）＋ 不建 fork ＋ 不归档。
//
// 铁律（与 test/s4-handoff-cwd.mjs 同口径）：
//   · 只起**自己 spawn** 的沙箱（副本 home + 高位随机端口），只按**精确 pid** 停，**绝不 pkill**；
//   · 端口绝不 7331/7321；日志写沙箱自己的目录，**绝不**写 /tmp/sopho-base*.log；
//   · 会话 id 一律完整 uuid；**真 profile（`~/.pi/profiles/assistant`）只读都不需要** —— 一个字节都不碰；
//   · 打补丁必须可判定（`patchLineOnce`：锚点恰好 1 行、该行里 `from` 恰好 1 处、只改那一行、`node --check`）。
//
// 跑法：node test/s4-durable-source.mjs
//       npm run test:s4durable
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, stopOwnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 沙箱放**仓内**：副本里的 `server/base-logic.mjs` 要 import `@earendil-works/pi-coding-agent`，
// 得顺着目录向上找到仓里的 `node_modules`（与 test/s4-handoff-cwd.mjs 同一条理由）。
const SANDBOX_ROOT = path.join(ROOT, '.probe-sandbox');
await mkdir(SANDBOX_ROOT, { recursive: true });
const TMP = await mkdtemp(path.join(SANDBOX_ROOT, 'durable-source-'));
const BASE_ENTRY = 'server/base.mjs';
const CODE_ENTRIES = ['server', 'web', 'pi-extensions', 'package.json'];
const GUARD_ENTRY = path.join(ROOT, 'test', 'sandbox-guard.mjs');
const SANDBOX_LIFETIME_MS = Number(process.env.SOPHO_SANDBOX_LIFETIME_MS) || 6 * 60 * 1000;
// 这条门会建不少会话（pending 普查每路由一条）⇒ 池的热上限要开大，否则 admit 会因为 maxHot 拒绝，
// 普查就变成了"在量沙箱的池上限"，不是"在量路由"。
const SANDBOX_MAX_HOT = '64';

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 打补丁的硬判据（与 test/s4-handoff-cwd.mjs 同一份契约）
// ---------------------------------------------------------------------------

async function readTextWithEol(file) {
  const text = await readFile(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  assert.equal(lines.join(eol), text, `${file}: 按认出的换行风格拼回去必须逐字相同（混合行尾？）`);
  return { eol, lines };
}

async function patchLineOnce({ file, anchor, from, to, what }) {
  const { eol, lines } = await readTextWithEol(file);
  const matches = (line) => (typeof anchor === 'string' ? line.includes(anchor) : anchor.test(line));
  const hits = lines.map((line, index) => (matches(line) ? index : -1)).filter((index) => index >= 0);
  assert.equal(hits.length, 1, `${file}: 锚点 ${String(anchor)} 必须恰好命中 1 行，实际 ${hits.length} 行（${what}）`);
  const index = hits[0];
  const before = lines[index];
  const occurrences = before.split(from).length - 1;
  assert.equal(occurrences, 1, `${file}: 第 ${index + 1} 行里 ${JSON.stringify(from)} 必须恰好 1 处，实际 ${occurrences} 处（${what}）\n该行逐字：${before}`);
  const after = before.replace(from, to);
  const nextLines = [...lines];
  nextLines[index] = after;
  const changed = nextLines.map((line, i) => (line === lines[i] ? null : i + 1)).filter((value) => value !== null);
  assert.deepEqual(changed, [index + 1], `${file}: 打补丁只许改第 ${index + 1} 行，实际改了 ${JSON.stringify(changed)} 行（${what}）`);
  const next = nextLines.join(eol);
  await writeFile(file, next, 'utf8');
  assert.equal(await readFile(file, 'utf8'), next, `${file}: 写回的字节必须与打算写的一致（${what}）`);
  return { line: index + 1, before: before.trim(), after: after.trim() };
}

async function assertParses(file) {
  try {
    await new Promise((resolve, reject) => {
      execFile(process.execPath, ['--check', file], (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message)));
        else resolve();
      });
    });
  } catch (error) {
    throw new Error(`${file} 打补丁后解析失败（node --check）：\n${error.message}`);
  }
}

// 突变锚点：只改**一行里的一个表达式**，把 (a)/(b) 的修法去掉 ⇒ 旧形状（404 / 500）应当回来。
const MOVE_DURABLE_ANCHOR = '!(await durableFileExists(sourceFile))';
const MOVE_DURABLE_FROM = '!(await durableFileExists(sourceFile))';
const MOVE_DURABLE_TO = 'false   /* (mutation: 不看盘上有没有文件) */';
const HANDOFF_PENDING_ANCHOR = 'if (!pool.getSession(sessionId))';
const HANDOFF_PENDING_FROM = 'if (!pool.getSession(sessionId))';
const HANDOFF_PENDING_TO = '/* (mutation: pending 会话也当成"不存在") */';
// (f) 的修法：`moveSession` 的忙判要放过"命令自己在搬自己"（adapter.isAdmittingOwnCommand()）。
// ⚠️ 锚点必须**只**命中 `/move` 那一行：2026-09-22 「压缩即封存」的忙判用的是**同一条判据**
//（同条件同码，见 `docs/design-session-seal.md` §2.1）⇒ 光靠 `!adapter.isAdmittingOwnCommand()`
// 会命中两行。带上 `if (adapter.isWorking() && ` 就只落在 `/move` 的忙判上（判据本身没动）。
const COMMAND_BUSY_ANCHOR = 'if (adapter.isWorking() && !adapter.isAdmittingOwnCommand())';
const COMMAND_BUSY_FROM = '!adapter.isAdmittingOwnCommand()';
const COMMAND_BUSY_TO = 'true   /* (mutation: 命令自己的位移也当成忙) */';

async function makeCodeRoot(name, patches) {
  const root = path.join(TMP, name);
  await mkdir(root, { recursive: true });
  for (const entry of CODE_ENTRIES) await cp(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
  const logicFile = path.join(root, 'server', 'base-logic.mjs');
  const applied = [];
  if (patches.includes('pending-blind-move')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: MOVE_DURABLE_ANCHOR, from: MOVE_DURABLE_FROM, to: MOVE_DURABLE_TO, what: '/move 不再看盘上有没有文件（退回 `readFile` ENOENT）' }));
  }
  if (patches.includes('pending-blind-handoff')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: HANDOFF_PENDING_ANCHOR, from: HANDOFF_PENDING_FROM, to: HANDOFF_PENDING_TO, what: 'handoff 把 pending 会话也叫"不存在"' }));
  }
  if (patches.includes('command-blind-move')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: COMMAND_BUSY_ANCHOR, from: COMMAND_BUSY_FROM, to: COMMAND_BUSY_TO, what: '用户面 /move 又变回"必然 409 session_busy_move"' }));
  }
  await assertParses(logicFile);
  return { root, applied };
}

// ---------------------------------------------------------------------------
// 沙箱：副本 home + 一个只回一句话的假 provider（同时记下每次请求的 messages）
// ---------------------------------------------------------------------------

async function reservePort(excluded) {
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

function sse(response, delta, finishReason = null, includeUsage = false, model = 'fake-s4ds') {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } : {}),
  })}\n\n`);
}

function flattenMessageContent(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
  return '';
}

async function startProvider(port, state) {
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    state.requests.push(body);
    const messages = body.messages ?? [];
    const lastUser = [...messages].reverse().find((message) => message.role === 'user') ?? null;
    const userText = flattenMessageContent(lastUser);
    const hasToolResult = messages.some((message) => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    // 「handoff 的新会话会立刻按摘要跑一轮（包括当场动手写文件）」要有**机械证据**，不是只数请求：
    // 摘要里带 HANDOFF_ACTS_MARKER 时，回一个 bash 工具调用，让它往**自己 cwd** 写一个文件。
    if (userText.includes('HANDOFF_ACTS_MARKER') && !hasToolResult) {
      const command = `node -e "require('fs').writeFileSync('handoff-acted.txt','HANDOFF_ACTED')"`;
      sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'call-s4ds-act', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] });
      sse(response, {}, 'tool_calls', true, true);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (userText.includes('HANDOFF_ACTS_MARKER') && hasToolResult) {
      sse(response, { role: 'assistant', content: 'HANDOFF_ACTED_DONE' });
      sse(response, {}, 'stop', true, true);
      response.end('data: [DONE]\n\n');
      return;
    }
    sse(response, { role: 'assistant', content: 'FAKE_S4DS_OK' });
    sse(response, {}, 'stop', true, true);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

async function request(port, pathname, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let value;
    try { value = raw ? JSON.parse(raw) : null; } catch { value = raw; }
    return { status: response.status, raw, value };
  } catch (error) {
    return { status: null, raw: String(error?.message ?? error), value: null, aborted: true };
  } finally {
    clearTimeout(timer);
  }
}

async function poll(label, operation, predicate, timeoutMs = 25_000) {
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
  throw new Error(`${label} 超时；最后一次：${JSON.stringify(last)}`);
}

async function jsonlFiles(dir) {
  const found = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(target);
    }
  };
  await visit(dir);
  return found.sort();
}

async function readJsonl(file) {
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

async function sessionHeaders(sessionsDir) {
  const heads = [];
  for (const file of await jsonlFiles(sessionsDir)) {
    const first = (await readFile(file, 'utf8')).split('\n').find((line) => line.trim() !== '');
    heads.push({ file, ...JSON.parse(first) });
  }
  return heads;
}

async function readHandoffRecords(home) {
  try {
    return (await readFile(path.join(home, 'handoffs.jsonl'), 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => { try { return JSON.parse(line); } catch { return { bad: line }; } });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** 建一条**未落盘**的会话（`POST /sessions` 建完就直接是热的、盘上没文件）。 */
async function createPending(arm, name) {
  const reply = await request(arm.basePort, '/sessions', { method: 'POST', body: { scratch: true, name } });
  assert.equal(reply.status, 201, `${arm.name}: 建 pending 会话必须 201，实际 ${reply.status}: ${reply.raw.slice(0, 200)}`);
  const id = reply.value?.id;
  assert.ok(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), `${arm.name}: pending 会话 id 形状不对：${JSON.stringify(id)}`);
  return id;
}

/** 建一条会话 + 发一条消息让它**落盘**（第一条 assistant 消息出现后 pi 才写文件）。 */
async function createDurable(arm, { cwd, name, marker }) {
  const created = await request(arm.basePort, '/sessions', { method: 'POST', body: { cwd, name } });
  assert.equal(created.status, 201, `${arm.name}: 建会话必须 201，实际 ${created.status}: ${created.raw.slice(0, 200)}`);
  const id = created.value?.id;
  const sent = await request(arm.basePort, `/sessions/${id}/message`, { method: 'POST', body: { text: marker } });
  assert.equal(sent.status, 202, `${arm.name}: 发消息必须 202，实际 ${sent.status}: ${sent.raw.slice(0, 200)}`);
  await poll(`${arm.name}: ${id} 落盘`, async () => (await sessionHeaders(arm.sessionsDir)).find((head) => head.id === id) ?? null, Boolean);
  await poll(`${arm.name}: ${id} 停下`, () => request(arm.basePort, `/sessions/${id}`), (reply) => reply.value?.runtime?.isStreaming === false && reply.value?.runtime?.isCompacting === false);
  return id;
}

async function fileForSession(sessionsDir, id) {
  return (await sessionHeaders(sessionsDir)).find((head) => head.id === id)?.file ?? null;
}

/** 等"一条会话被搬走"或者"命令报了错"，哪个先来就返回哪个（两边都要快）。 */
async function waitForMoveOrError(arm, sourceId, stream, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const sessions = (await request(arm.basePort, '/tree')).value?.sessions ?? [];
    const node = sessions.find((entry) => entry.id === sourceId) ?? null;
    last = { archived: node?.archived ?? null, movedTo: node?.movedTo ?? null, notices: noticesOf(stream) };
    if (node?.archived === true && typeof node?.movedTo === 'string') return { landed: node, sawError: false, last };
    const error = noticesOf(stream).find((notice) => notice.level === 'error');
    if (error) return { landed: null, sawError: true, last };
    await sleep(100);
  }
  return { landed: null, sawError: false, last };
}

function errorCodeOf(reply) {
  return reply?.value?.error ?? null;
}

// ---------------------------------------------------------------------------
// 沙箱起停
// ---------------------------------------------------------------------------

async function startArm({ name, codeRoot }) {
  const home = path.join(TMP, `home-${name}`);
  const sessionsDir = path.join(home, 'sessions');
  const durableCwdA = path.join(TMP, `pendingA-${name}`);
  const durableCwdB = path.join(TMP, `pendingB-${name}`);
  const durableCwdC = path.join(TMP, `pendingC-${name}`);
  // 普查专用的落点：与 G_move_positive 搬进去的 `durableCwdB` 分开 —— 否则宿主的工作区守卫会
  // 先以 `workspace_conflict` 把普查的 move 挡下来，那一行量的就不是"pending 源"了。
  const censusCwd = path.join(TMP, `census-${name}`);
  // `/move`·`/handoff` **命令面**各自的落点（它们和前面的臂用不同的目录，免得撞上工作区守卫）。
  const commandMoveCwd = path.join(TMP, `command-move-${name}`);
  const commandHandoffCwd = path.join(TMP, `command-handoff-${name}`);
  const missingCwd = path.join(TMP, `missing-${name}`);
  for (const dir of [home, sessionsDir, durableCwdA, durableCwdB, durableCwdC, censusCwd, commandMoveCwd, commandHandoffCwd]) await mkdir(dir, { recursive: true });
  const used = new Set();
  const providerPort = await reservePort(used); used.add(providerPort);
  const basePort = await reservePort(used);
  const providerState = { requests: [] };
  const provider = await startProvider(providerPort, providerState);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-s4ds', name: 'Fake S4DS', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-s4ds', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);

  const logPath = path.join(TMP, `base-${name}.log`);
  const log = await open(logPath, 'w');
  const guard = spawn(process.execPath, [
    GUARD_ENTRY,
    '--entry', path.join(codeRoot, BASE_ENTRY),
    '--label', `s4ds-${name}-${basePort}`,
    '--lifetime-ms', String(SANDBOX_LIFETIME_MS),
    '--watch-stdin',
  ], {
    cwd: codeRoot,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(basePort),
      SOPHO_DEFAULT_CWD: durableCwdA,
      SOPHO_MAX_HOT: SANDBOX_MAX_HOT,
    },
    stdio: ['pipe', log.fd, log.fd, 'ipc'],
    detached: true,
  });
  const exited = new Promise((resolve) => guard.once('exit', (code, signal) => resolve({ code, signal })));
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: 守卫没有报出 sandbox-start`)), 30_000);
    guard.on('message', (message) => {
      if (message?.type !== 'sandbox-start') return;
      clearTimeout(timer);
      resolve(message);
    });
    guard.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${name}: 宿主起来之前守卫就退了（code=${code} signal=${signal}）`));
    });
  });
  const hostPid = started.pid;
  await poll(`${name}: base 就绪`, () => request(basePort, '/host'), (reply) => reply.status === 200, 40_000);
  assert.equal(await listenerPid(basePort), hostPid, `${name}: 监听端口的必须是我 spawn 的沙箱根 pid`);
  print('sandbox host（经 test/sandbox-guard.mjs 包起）', { arm: name, port: basePort, guardPid: guard.pid, hostPid, listenerPid: await listenerPid(basePort), lifetimeMs: SANDBOX_LIFETIME_MS, maxHot: SANDBOX_MAX_HOT });
  return { name, home, sessionsDir, durableCwdA, durableCwdB, durableCwdC, censusCwd, commandMoveCwd, commandHandoffCwd, missingCwd, basePort, providerPort, provider, providerState, guard, exited, log, logPath, codeRoot, hostPid };
}

async function stopArm(arm, problems) {
  await cleanupStep(problems, `${arm.name}: 关 provider`, () => new Promise((resolve) => { arm.provider.closeAllConnections(); arm.provider.close(resolve); }));
  await cleanupStep(problems, `${arm.name}: 停沙箱根（精确 pid + 入口核对）`, () => stopOwnedListener(arm.basePort, path.join(arm.codeRoot, BASE_ENTRY), arm.hostPid));
  await cleanupStep(problems, `${arm.name}: 收守树`, async () => {
    const settled = await Promise.race([arm.exited, sleep(15_000).then(() => null)]);
    if (settled === null && arm.guard?.pid) {
      try { process.kill(arm.guard.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
      await arm.exited;
    }
  });
  await cleanupStep(problems, `${arm.name}: 关日志`, () => arm.log?.close());
}

// ---------------------------------------------------------------------------
// SSE：`session.notice` 是**瞬时**事件（没有订阅者就丢）⇒ 要抓"用户面 `/move` 那条命令到底发生了什么"
// 就必须先挂上订阅。这里只收事件、不做断言；关的时候 abort。
// ---------------------------------------------------------------------------
async function openEventStream(port, sessionId) {
  const controller = new AbortController();
  const events = [];
  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '' || payload === '[DONE]') continue;
            try { events.push(JSON.parse(payload)); } catch { /* 非 JSON 的 keep-alive 行忽略 */ }
          }
        }
      }
    } catch { /* abort 时正常抛 */ }
  })();
  return { events, status: response.status, close: async () => { controller.abort(); await Promise.race([pump, sleep(1500)]); } };
}

/** 在 SSE 事件里找 `session.notice`。 */
function noticesOf(stream) {
  return stream.events.filter((event) => event?.type === 'session.notice').map((event) => ({ level: event.level ?? null, text: event.text ?? null, source: event.source ?? null }));
}

// ---------------------------------------------------------------------------
// 门
// ---------------------------------------------------------------------------

const DURABLE_CODE = 'session_not_durable';
const DURABLE_RECOVERY_HINT = 'Send that session one message to make it durable';
const DURABLE_BUG_SHAPE = 'has no durable file on disk yet';

/** 未落盘的源 + handoff ⇒ 诚实 409（不是 404）＋ 不建会话 ＋ 源状态没被改。 */
async function gatePendingHandoff(arm) {
  const failures = [];
  const pendingId = await createPending(arm, 'pending-handoff-source');
  const filesBefore = (await jsonlFiles(arm.sessionsDir)).length;
  const recordsBefore = (await readHandoffRecords(arm.home)).length;
  const placementBefore = (await request(arm.basePort, '/placement')).value?.[pendingId] ?? null;
  const detailBefore = (await request(arm.basePort, `/sessions/${pendingId}`)).value ?? {};

  const reply = await request(arm.basePort, `/sessions/${pendingId}/handoff`, {
    method: 'POST',
    body: { goal: '到 B 继续', summary: 'GATE_PENDING_SUMMARY', to: { cwd: arm.durableCwdB } },
  });
  const value = reply.value ?? {};

  if (reply.status !== 409) failures.push(`未落盘的源 + handoff 必须是 409（拒绝），实际 ${reply.status}: ${reply.raw.slice(0, 240)}`);
  if (value.error !== DURABLE_CODE) failures.push(`错误码必须是 ${DURABLE_CODE}（与 /move 同码），实际 ${JSON.stringify(value.error)}`);
  if (reply.status === 404) failures.push(`不许是 404 session_not_found —— 那条把"先发一条消息"这条恢复路径藏起来（这正是缺陷 (a) 的旧形状）`);
  if (typeof value.message !== 'string' || !value.message.includes(DURABLE_BUG_SHAPE)) failures.push(`文案必须说清"源会话还没落盘"，实际 ${JSON.stringify(value.message)}`);
  if (typeof value.message !== 'string' || !value.message.includes(DURABLE_RECOVERY_HINT)) failures.push(`文案必须给出恢复路径（"先发一条消息让它 durable"），实际 ${JSON.stringify(value.message)}`);
  if (value.details?.sessionId !== pendingId) failures.push(`details.sessionId 必须逐字是源会话 id，实际 ${JSON.stringify(value.details)}`);

  const filesAfter = (await jsonlFiles(arm.sessionsDir)).length;
  if (filesAfter !== filesBefore) failures.push(`被拒的 handoff 不许建会话文件：${filesBefore} → ${filesAfter}`);
  const recordsAfter = (await readHandoffRecords(arm.home)).length;
  if (recordsAfter !== recordsBefore) failures.push(`校验级拒绝不许往 handoffs.jsonl 记账（工具描述现在也这么写）：${recordsBefore} → ${recordsAfter}`);
  if (await fileForSession(arm.sessionsDir, pendingId) !== null) failures.push(`源会话在拒绝后还是 pending 才对（盘上不该出现文件）`);
  const placementAfter = (await request(arm.basePort, '/placement')).value?.[pendingId] ?? null;
  if (placementAfter?.claimedBy !== null) failures.push(`源会话不许被标 moved（placement.claimedBy 必须还是 null），实际 ${JSON.stringify(placementAfter)}`);
  if (placementBefore?.cwd !== placementAfter?.cwd) failures.push(`源会话的 cwd 记账不许被改：${placementBefore?.cwd} → ${placementAfter?.cwd}`);
  const detailAfter = (await request(arm.basePort, `/sessions/${pendingId}`)).value ?? {};
  if (detailAfter.cwd !== detailBefore.cwd || detailAfter.archived === true) failures.push(`源会话状态不许被改（cwd/archived），前 ${JSON.stringify({ cwd: detailBefore.cwd, archived: detailBefore.archived })} 后 ${JSON.stringify({ cwd: detailAfter.cwd, archived: detailAfter.archived })}`);

  return {
    ok: failures.length === 0,
    failures,
    evidence: { status: reply.status, error: value.error ?? null, message: value.message ?? null, details: value.details ?? null, newSessionFiles: filesAfter - filesBefore, newLedgerLines: recordsAfter - recordsBefore, pendingId },
  };
}

/** 未落盘的源 + move ⇒ 诚实 409（绝不是 500）＋ 不建会话 ＋ 源状态没被改。 */
async function gatePendingMove(arm) {
  const failures = [];
  const pendingId = await createPending(arm, 'pending-move-source');
  const filesBefore = (await jsonlFiles(arm.sessionsDir)).length;
  const detailBefore = (await request(arm.basePort, `/sessions/${pendingId}`)).value ?? {};

  const reply = await request(arm.basePort, `/sessions/${pendingId}/move`, { method: 'POST', body: { cwd: arm.durableCwdB } });
  const value = reply.value ?? {};

  if (reply.status !== 409) failures.push(`未落盘的源 + move 必须是 409（拒绝），实际 ${reply.status}: ${reply.raw.slice(0, 240)}`);
  if (reply.status === 500) failures.push(`绝不许以 500 internal_error 收场（那是缺陷 (b) 的旧形状：getSessionFile() 给了名字、readFile 撞 ENOENT）`);
  if (value.error !== DURABLE_CODE) failures.push(`错误码必须是 ${DURABLE_CODE}，实际 ${JSON.stringify(value.error)}`);
  if (typeof value.message !== 'string' || !value.message.includes(DURABLE_BUG_SHAPE)) failures.push(`文案必须说清"源会话还没落盘"，实际 ${JSON.stringify(value.message)}`);
  if (typeof value.message !== 'string' || !value.message.includes(DURABLE_RECOVERY_HINT)) failures.push(`文案必须给出恢复路径，实际 ${JSON.stringify(value.message)}`);

  const filesAfter = (await jsonlFiles(arm.sessionsDir)).length;
  if (filesAfter !== filesBefore) failures.push(`被拒的 move 不许建会话文件：${filesBefore} → ${filesAfter}`);
  if (await fileForSession(arm.sessionsDir, pendingId) !== null) failures.push(`源会话在拒绝后还是 pending 才对（盘上不该出现文件）`);
  const placementAfter = (await request(arm.basePort, '/placement')).value?.[pendingId] ?? null;
  if (placementAfter?.claimedBy !== null) failures.push(`源会话不许被标 moved，实际 ${JSON.stringify(placementAfter)}`);
  const detailAfter = (await request(arm.basePort, `/sessions/${pendingId}`)).value ?? {};
  if (detailAfter.cwd !== detailBefore.cwd || detailAfter.archived === true) failures.push(`源会话状态不许被改（cwd/archived）`);

  return {
    ok: failures.length === 0,
    failures,
    evidence: { status: reply.status, error: value.error ?? null, message: value.message ?? null, newSessionFiles: filesAfter - filesBefore, pendingId },
  };
}

/** 已落盘的源 + handoff ⇒ 正常 200（正例），而且**成功**要落一行账。 */
async function gateDurableHandoff(arm) {
  const failures = [];
  const sourceId = await createDurable(arm, { cwd: arm.durableCwdA, name: 'durable handoff source', marker: 'DURABLE_HANDOFF_FIRST_TURN' });
  const recordsBefore = (await readHandoffRecords(arm.home)).length;
  const providerRequestsBefore = arm.providerState.requests.length;
  const reply = await request(arm.basePort, `/sessions/${sourceId}/handoff`, {
    method: 'POST',
    // 摘要里埋一个唯有本门会认的标记 ⇒ 假 provider 回一个 bash 工具调用（见 startProvider）。
    body: { goal: '到 C 继续', summary: 'HANDOFF_ACTS_MARKER 立刻按摘要干活', to: { cwd: arm.durableCwdC } },
  });
  const value = reply.value ?? {};
  if (reply.status !== 200 || value.ok !== true) failures.push(`已落盘的源 + handoff 必须 200 ok:true，实际 ${reply.status} ok=${JSON.stringify(value.ok)}: ${reply.raw.slice(0, 240)}`);
  if (value.cwdVerified !== true || value.cwd !== arm.durableCwdC) failures.push(`落点必须回读核对为 ${arm.durableCwdC}，实际 cwd=${JSON.stringify(value.cwd)} cwdVerified=${JSON.stringify(value.cwdVerified)}`);
  const childId = typeof value.to === 'string' ? value.to : null;
  if (childId === null) failures.push(`回执里没有新会话 id：${JSON.stringify(value).slice(0, 200)}`);
  const childHead = childId === null ? null : (await sessionHeaders(arm.sessionsDir)).find((head) => head.id === childId) ?? null;
  if (childHead?.cwd !== arm.durableCwdC) failures.push(`新会话 header.cwd 必须逐字是 ${arm.durableCwdC}，实际 ${JSON.stringify(childHead?.cwd)}`);
  const recordsAfter = (await readHandoffRecords(arm.home)).length;
  if (recordsAfter !== recordsBefore + 1) failures.push(`**成功**的 handoff 必须恰好落一行账：${recordsBefore} → ${recordsAfter}`);
  const sourcePlacement = (await request(arm.basePort, '/placement')).value?.[sourceId] ?? null;
  if (sourcePlacement?.claimedBy !== null && sourcePlacement?.claimedBy !== undefined) failures.push(`有损 handoff 不许把源会话标 moved，实际 ${JSON.stringify(sourcePlacement)}`);
  // 「新会话**立刻**按摘要跑一轮」不是推断：摘要作为第一条 user 消息投进去 ⇒ 马上有一次模型调用。
  // 而且不只看“请求数”：假 provider 回一个 bash 工具调用，断言它**当场往自己 cwd 写了文件**（否则只是嘴上说说）。
  await poll('handoff 新会话立刻跑一轮', () => Promise.resolve(arm.providerState.requests.length), (count) => count > providerRequestsBefore, 30_000).catch(() => {});
  const actedPath = path.join(arm.durableCwdC, 'handoff-acted.txt');
  await poll('handoff 新会话当场动手', async () => { try { return await readFile(actedPath, 'utf8'); } catch { return null; } }, (text) => text !== null, 40_000).catch(() => {});
  const actedFile = await readFile(actedPath, 'utf8').catch(() => null);
  const turnsAfterHandoff = arm.providerState.requests.length - providerRequestsBefore;
  if (turnsAfterHandoff < 1) failures.push(`handoff 的新会话必须**立刻**按摘要跑一轮（至少一次模型调用），实际 providerRequests +${turnsAfterHandoff}`);
  if (actedFile === null) failures.push(`handoff 的新会话必须**当场动手**（本门摆的是"回一个 bash 工具调用、往自己 cwd 写文件"），盘上没看到 ${actedPath}`);
  else if (!actedFile.includes('HANDOFF_ACTED')) failures.push(`新会话写的那个文件内容不对：${JSON.stringify(actedFile)}`);
  return { ok: failures.length === 0, failures, evidence: { status: reply.status, ok: value.ok ?? null, to: childId, cwd: value.cwd ?? null, newLedgerLines: recordsAfter - recordsBefore, providerRequestsAfterHandoff: turnsAfterHandoff, childActedWroteFile: actedFile !== null, childWroteFilePath: actedFile !== null ? actedPath : null, childFileContent: actedFile } };
}

/** (e) `/move` 的正面真机验证：先落盘、再搬，逐项核对，并**用证据**回答上下文问题。 */
async function gateMovePositive(arm) {
  const failures = [];
  const sourceId = await createDurable(arm, { cwd: arm.durableCwdA, name: 'move positive source', marker: 'MOVE_FIRST_TURN_MARKER' });
  const sourceFile = await fileForSession(arm.sessionsDir, sourceId);
  if (sourceFile === null) failures.push(`源会话发过消息后应当已落盘`);

  // 反面先行：目标目录不存在 ⇒ 如实拒绝，且**源会话不许被归档**、不许有 fork。
  const filesBeforeMissing = (await jsonlFiles(arm.sessionsDir)).length;
  const missing = await request(arm.basePort, `/sessions/${sourceId}/move`, { method: 'POST', body: { cwd: arm.missingCwd } });
  if (missing.status !== 409 || missing.value?.error !== 'target_cwd_missing') failures.push(`move 到不存在的目录必须 409 target_cwd_missing，实际 ${missing.status} ${JSON.stringify(missing.value?.error)}`);
  if ((await jsonlFiles(arm.sessionsDir)).length !== filesBeforeMissing) failures.push(`被拒的 move 不许建 fork`);
  const treeAfterMissing = (await request(arm.basePort, '/tree')).value?.sessions ?? [];
  const sourceNodeAfterMissing = treeAfterMissing.find((node) => node.id === sourceId) ?? null;
  if (sourceNodeAfterMissing?.archived === true || sourceNodeAfterMissing?.movedTo) failures.push(`被拒的 move 后源会话不许被归档/标 moved，实际 ${JSON.stringify(sourceNodeAfterMissing)}`);

  // 无损基线：搬之前的 /messages 条目 id。
  const before = await request(arm.basePort, `/sessions/${sourceId}/messages`);
  const beforeEntryIds = (before.value?.messages ?? []).map((message) => message.entryId);
  if (beforeEntryIds.length === 0) failures.push(`搬之前源会话应当有历史条目，实际 ${JSON.stringify(before.value).slice(0, 200)}`);

  // 正面：搬到一个**已存在且与源不同**的目录。
  const moved = await request(arm.basePort, `/sessions/${sourceId}/move`, { method: 'POST', body: { cwd: arm.durableCwdB } });
  const value = moved.value ?? {};
  const childId = typeof value.toSessionId === 'string' ? value.toSessionId : null;
  if (moved.status !== 201) failures.push(`move 成功必须 201，实际 ${moved.status}: ${moved.raw.slice(0, 240)}`);
  if (childId === null) failures.push(`回执里没有 toSessionId：${JSON.stringify(value).slice(0, 200)}`);

  // ① 新会话的 cwd 逐字等于目标（回执 + header + placement + /sessions/{id} 四处）。
  if (value.cwd !== arm.durableCwdB) failures.push(`回执 cwd 必须逐字是 ${arm.durableCwdB}，实际 ${JSON.stringify(value.cwd)}`);
  const childHead = childId === null ? null : (await sessionHeaders(arm.sessionsDir)).find((head) => head.id === childId) ?? null;
  if (childHead?.cwd !== arm.durableCwdB) failures.push(`新会话 header.cwd 必须逐字是 ${arm.durableCwdB}，实际 ${JSON.stringify(childHead?.cwd)}`);
  const childPlacement = childId === null ? null : (await request(arm.basePort, '/placement')).value?.[childId] ?? null;
  if (childPlacement?.cwd !== arm.durableCwdB) failures.push(`新会话 placement.cwd 必须逐字是 ${arm.durableCwdB}，实际 ${JSON.stringify(childPlacement?.cwd)}`);
  if (childHead?.parentSession !== sourceFile) failures.push(`新会话的 parentSession 必须逐字是源文件 ${sourceFile}，实际 ${JSON.stringify(childHead?.parentSession)}`);

  // ② 无损：同分支 / 同历史（条目 id 逐条在，条数不少于源）。
  const after = childId === null ? null : await request(arm.basePort, `/sessions/${childId}/messages`);
  const afterEntryIds = (after?.value?.messages ?? []).map((message) => message.entryId);
  const missingEntryIds = beforeEntryIds.filter((entryId) => !afterEntryIds.includes(entryId));
  if (missingEntryIds.length > 0) failures.push(`无损断言失败：新会话丢了源会话的条目 ${JSON.stringify(missingEntryIds)}`);
  if (afterEntryIds.length < beforeEntryIds.length) failures.push(`新会话条目数（${afterEntryIds.length}）不得少于源（${beforeEntryIds.length}）`);
  const sourceLinesAfterMove = sourceFile === null ? [] : await readJsonl(sourceFile);
  const childLines = childHead?.file ? await readJsonl(childHead.file) : [];
  const nonHeaderSame = JSON.stringify(sourceLinesAfterMove.slice(1)) === JSON.stringify(childLines.slice(1));
  if (!nonHeaderSame) failures.push(`非 header 行必须逐字复制（无损）：源 ${sourceLinesAfterMove.length - 1} 行 vs 新 ${childLines.length - 1} 行`);

  // ③ 源会话被归档 + 树上有"搬到 …"的痕迹。
  const tree = (await request(arm.basePort, '/tree')).value?.sessions ?? [];
  const sourceNode = tree.find((node) => node.id === sourceId) ?? null;
  // 投影层/宿主侧事实：`/move` 的新会话 `parentSession` = **源会话**（子树）⇒ 宿主 `decorateUnreadTree`
  // 把"祖先已归档的后代"标成 `hiddenByArchive:true`，左栏就被折进归档组（体验上像"搬丢了"）。
  // 这是**宿主侧**规则（`server/base.mjs`）⇒ 本次只把现实量下来写进提案，不在门里假绿、也不改宿主。
  const childNode = childId === null ? null : tree.find((node) => node.id === childId) ?? null;
  if (sourceNode?.archived !== true) failures.push(`源会话必须 archived:true，实际 ${JSON.stringify(sourceNode)}`);
  if (sourceNode?.movedTo !== childId) failures.push(`树的 movedTo 必须逐字是 ${childId}，实际 ${JSON.stringify(sourceNode?.movedTo)}`);
  if (typeof sourceNode?.name !== 'string' || !sourceNode.name.includes(`moved-to:${childId}`)) failures.push(`树上必须能看到"搬到 …"的痕迹（moved-to:<新 id>），实际 ${JSON.stringify(sourceNode?.name)}`);

  // ④ 回执里的 movedTo 一类字段逐字。
  if (value.movedMarker !== `moved-to:${childId}`) failures.push(`回执 movedMarker 必须逐字是 moved-to:${childId}，实际 ${JSON.stringify(value.movedMarker)}`);
  if (value.fromSessionId !== sourceId) failures.push(`回执 fromSessionId 必须逐字是源 id，实际 ${JSON.stringify(value.fromSessionId)}`);
  if (value.archived !== true || value.sourceUnchangedByFork !== true) failures.push(`回执必须说清源被归档且 fork 没改源，实际 ${JSON.stringify({ archived: value.archived, sourceUnchangedByFork: value.sourceUnchangedByFork })}`);
  if (value.placementPersisted !== true) failures.push(`记账必须成功落盘（placementPersisted:true），实际 ${JSON.stringify(value.placementPersisted)}`);
  const sourceBytes = sourceFile === null ? null : await readFile(sourceFile);
  if (sourceBytes !== null && sourceBytes.length !== value.sourceBytesAfterMove) failures.push(`源文件字节数必须前后一致：实际 ${sourceBytes.length} vs 回执 ${value.sourceBytesAfterMove}`);

  // ⑤ 那句回答的证据：在新会话里接着说一句，模型这一轮收到的 messages 必须含源会话那句原文。
  const requestsBefore = arm.providerState.requests.length;
  const continued = await request(arm.basePort, `/sessions/${childId}/message`, { method: 'POST', body: { text: 'MOVE_SECOND_TURN_MARKER 接着原来的说' } });
  if (continued.status !== 202) failures.push(`在新会话里接着发消息必须 202，实际 ${continued.status}: ${continued.raw.slice(0, 200)}`);
  await poll('move 后新会话那一轮', () => Promise.resolve(arm.providerState.requests.length), (count) => count > requestsBefore, 30_000);
  const lastRequest = arm.providerState.requests.at(-1) ?? {};
  const promptText = (lastRequest.messages ?? []).map(flattenMessageContent).join('\n---\n');
  const sawSourceHistory = promptText.includes('MOVE_FIRST_TURN_MARKER');
  const sawSecondTurn = promptText.includes('MOVE_SECOND_TURN_MARKER');
  if (!sawSourceHistory) failures.push(`新会话那一轮发给模型的 messages 里必须含源会话的原话（否则"接着原来的上下文说"就没有证据）`);
  if (!sawSecondTurn) failures.push(`新会话那一轮必须含本次新消息`);

  return {
    ok: failures.length === 0,
    failures,
    evidence: {
      sourceId,
      toSessionId: childId,
      moveStatus: moved.status,
      cwd: value.cwd ?? null,
      childHeaderCwd: childHead?.cwd ?? null,
      movedMarker: value.movedMarker ?? null,
      archived: value.archived ?? null,
      sourceArchivedInTree: sourceNode?.archived ?? null,
      treeMovedTo: sourceNode?.movedTo ?? null,
      childParentId: childNode?.parentId ?? null,
      childHiddenByArchive: childNode?.hiddenByArchive ?? null,
      sourceBytesAfterMove: value.sourceBytesAfterMove ?? null,
      entryIdsBefore: beforeEntryIds,
      entryIdsAfter: afterEntryIds,
      missingEntryIds,
      nonHeaderLinesIdentical: nonHeaderSame,
      missingTargetRefusal: { status: missing.status, error: missing.value?.error ?? null, sourceStillArchived: sourceNodeAfterMissing?.archived ?? null },
      contextContinuity: { sawSourceHistory, sawSecondTurn, providerMessagesInLastTurn: (lastRequest.messages ?? []).length },
    },
  };
}

/** 用户面 `/move`（把 `/move <目录>` 当**一条消息**发进去 ⇒ 走 pi 的 prompt→扩展命令派发那条真路）：必须真能搬成。
 *  这条臂量的就是之前那条产品级缺陷：命令 handler 回头打 HTTP 时 admissionPending 为真，旧代码必然 409。 */
async function gateMoveCommand(arm) {
  const failures = [];
  const sourceId = await createDurable(arm, { cwd: arm.durableCwdA, name: 'command move source', marker: 'MOVE_COMMAND_FIRST_TURN' });
  const sourceFile = await fileForSession(arm.sessionsDir, sourceId);
  const sourceBytesBefore = sourceFile === null ? null : await readFile(sourceFile);
  const stream = await openEventStream(arm.basePort, sourceId);
  const accepted = await request(arm.basePort, `/sessions/${sourceId}/message`, { method: 'POST', body: { text: `/move ${arm.commandMoveCwd}` } });
  const outcome = await waitForMoveOrError(arm, sourceId, stream);
  const notices = noticesOf(stream);
  await stream.close();

  if (accepted.status !== 202) failures.push(`把 /move 当消息发进去应当 202 accepted，实际 ${accepted.status}: ${accepted.raw.slice(0, 200)}`);
  if (outcome.landed === null) {
    const error = notices.find((notice) => notice.level === 'error');
    failures.push(`用户面 /move 没有搬成（sawError=${outcome.sawError}）—— 旧形状：命令 handler 回头打 HTTP 时 admissionPending 为真 ⇒ 409 session_busy_move，且只有一条瞬时 session.notice。现场：${JSON.stringify(error ?? outcome.last)}`);
  }
  const errorNotices = notices.filter((notice) => notice.level === 'error');
  if (errorNotices.length > 0) failures.push(`用户面 /move 不应报错，实际收到 ${JSON.stringify(errorNotices)}`);
  const infoNotices = notices.filter((notice) => notice.level === 'info' && typeof notice.text === 'string' && notice.text.includes('已无损搬到'));
  if (infoNotices.length === 0) failures.push(`命令成功后必须给出"已无损搬到 …"的回执（session.notice info），实际 ${JSON.stringify(notices)}`);

  const childId = outcome.landed?.movedTo ?? null;
  const childHead = childId === null ? null : (await sessionHeaders(arm.sessionsDir)).find((head) => head.id === childId) ?? null;
  if (childId !== null && childHead?.cwd !== arm.commandMoveCwd) failures.push(`新会话 header.cwd 必须逐字是 ${arm.commandMoveCwd}，实际 ${JSON.stringify(childHead?.cwd)}`);
  if (childId !== null && childHead?.parentSession !== sourceFile) failures.push(`新会话 parentSession 必须逐字是源文件 ${sourceFile}，实际 ${JSON.stringify(childHead?.parentSession)}`);
  if (outcome.landed?.archived !== true) failures.push(`搬完源必须被归档，实际 ${JSON.stringify(outcome.landed)}`);
  const sourceBytesAfter = sourceFile === null ? null : await readFile(sourceFile);
  if (sourceBytesBefore !== null && sourceBytesAfter !== null && !sourceBytesBefore.equals(sourceBytesAfter)) failures.push(`命令面 /move 不许改动源文件（无损）`);
  if (outcome.landed === null && errorNotices.some((notice) => /no durable file/.test(notice.text ?? ''))) failures.push(`这臂的源已经落盘，不该撞 session_not_durable`);

  return {
    ok: failures.length === 0,
    failures,
    evidence: {
      sourceId,
      messageStatus: accepted.status,
      toSessionId: childId,
      childCwd: childHead?.cwd ?? null,
      sourceArchived: outcome.landed?.archived ?? null,
      sourceFileBytesUnchanged: sourceBytesBefore !== null && sourceBytesAfter !== null ? sourceBytesBefore.equals(sourceBytesAfter) : null,
      notices,
    },
  };
}

/** 用户面 `/handoff`（不是工具）走同一条 prompt→扩展命令派发那条路：会不会也撞 admissionPending？
 *  手写结论：`handoffSession` 不看源会话 runtime 的忙判（它从盘上读源、在**新**会话上干活）⇒ 不该撞。
 *  但 `compress:"session"` 那条会（它调 `startCompaction` ⇒ `busyConflict` 照样 409 `session_streaming`），
 *  命令面没有那个开关（命令不解析 compress）⇒ 只把现实量出来。 */
async function gateHandoffCommand(arm) {
  const failures = [];
  const sourceId = await createDurable(arm, { cwd: arm.durableCwdA, name: 'command handoff source', marker: 'HANDOFF_COMMAND_FIRST_TURN' });
  const stream = await openEventStream(arm.basePort, sourceId);
  const accepted = await request(arm.basePort, `/sessions/${sourceId}/message`, { method: 'POST', body: { text: `/handoff --cwd ${arm.commandHandoffCwd} COMMAND_HANDOFF_GOAL` } });

  const deadline = Date.now() + 25_000;
  let childNode = null;
  while (Date.now() < deadline) {
    const sessions = (await request(arm.basePort, '/tree')).value?.sessions ?? [];
    childNode = sessions.find((node) => node.cwd === arm.commandHandoffCwd) ?? null;
    if (childNode) break;
    if (noticesOf(stream).some((notice) => notice.level === 'error')) break;
    await sleep(100);
  }
  const notices = noticesOf(stream);
  await stream.close();

  if (accepted.status !== 202) failures.push(`把 /handoff 当消息发进去应当 202 accepted，实际 ${accepted.status}: ${accepted.raw.slice(0, 200)}`);
  if (childNode === null) failures.push(`用户面 /handoff 没有建出兄弟会话（落点 ${arm.commandHandoffCwd}）—— 现场：${JSON.stringify(notices.filter((notice) => notice.level === 'error'))}`);
  const errorNotices = notices.filter((notice) => notice.level === 'error');
  if (errorNotices.length > 0) failures.push(`用户面 /handoff 不应报错，实际 ${JSON.stringify(errorNotices)}`);
  const infoNotices = notices.filter((notice) => notice.level === 'info' && typeof notice.text === 'string' && notice.text.includes('已 handoff 到新会话'));
  if (infoNotices.length === 0) failures.push(`命令成功后必须给出"已 handoff 到新会话 …"的回执，实际 ${JSON.stringify(notices)}`);
  if (childNode !== null && childNode.parentId === sourceId) failures.push(`handoff 的新会话必须是**兄弟**（源是根 ⇒ 新会话也是根），实际 parentId=${JSON.stringify(childNode.parentId)}`);

  const sessions = (await request(arm.basePort, '/tree')).value?.sessions ?? [];
  const sourceNode = sessions.find((node) => node.id === sourceId) ?? null;
  if (sourceNode?.archived === true || sourceNode?.movedTo) failures.push(`有损 handoff 不许把源标 moved / 归档，实际 ${JSON.stringify(sourceNode)}`);
  const sourcePlacement = (await request(arm.basePort, '/placement')).value?.[sourceId] ?? null;
  if (sourcePlacement?.claimedBy !== null) failures.push(`有损 handoff 不许写源会话的 claimedBy，实际 ${JSON.stringify(sourcePlacement?.claimedBy)}`);

  return {
    ok: failures.length === 0,
    failures,
    evidence: {
      sourceId,
      messageStatus: accepted.status,
      toSessionId: childNode?.id ?? null,
      toCwd: childNode?.cwd ?? null,
      toParentId: childNode?.parentId ?? null,
      sourceArchived: sourceNode?.archived ?? null,
      sourceMovedTo: sourceNode?.movedTo ?? null,
      notices,
    },
  };
}

/** 未落盘的源上把**其它会话级路由**过一遍 —— 只列事实（哪些 500 / 哪些答得不对）。 */
async function censusPendingRoutes(arm) {
  const routes = [
    ['GET    /sessions/{id}', { method: 'GET' }, () => `/sessions/IDS`],
    ['GET    /sessions/{id}/messages', { method: 'GET' }, () => `/sessions/IDS/messages`],
    ['GET    /sessions/{id}/commands', { method: 'GET' }, () => `/sessions/IDS/commands`],
    ['GET    /sessions/{id}/models', { method: 'GET' }, () => `/sessions/IDS/models`],
    ['GET    /sessions/{id}/export', { method: 'GET', timeoutMs: 8000 }, () => `/sessions/IDS/export`],
    ['GET    /sessions/{id}/questions', { method: 'GET' }, () => `/sessions/IDS/questions`],
    ['GET    /sessions/{id}/events (SSE 头)', { method: 'GET', timeoutMs: 1500 }, () => `/sessions/IDS/events`],
    ['PATCH  /sessions/{id} {name}', { method: 'PATCH', body: { name: 'census pending renamed' } }, () => `/sessions/IDS`],
    ['POST   /sessions/{id}/title', { method: 'POST', body: { title: 'census pending' } }, () => `/sessions/IDS/title`],
    ['POST   /sessions/{id}/model', { method: 'POST', body: { model: 'fake-s4ds' } }, () => `/sessions/IDS/model`],
    ['POST   /sessions/{id}/questions {ask}', { method: 'POST', body: { op: 'ask', text: 'pending 普查问题', context: 'pending 普查：这条会话还没落盘，问一条问题看它怎么答——判断所需的事实（源是 pending、无 .jsonl）已写在 context 里。' } }, () => `/sessions/IDS/questions`],
    ['POST   /sessions/{id}/archive', { method: 'POST', body: { archived: true } }, () => `/sessions/IDS/archive`],
    ['POST   /sessions/{id}/steer', { method: 'POST', body: { text: 'census steer' } }, () => `/sessions/IDS/steer`],
    ['POST   /sessions/{id}/follow-up', { method: 'POST', body: { text: 'census follow-up' } }, () => `/sessions/IDS/follow-up`],
    ['POST   /sessions/{id}/abort', { method: 'POST', body: {} }, () => `/sessions/IDS/abort`],
    ['POST   /sessions/{id}/compact', { method: 'POST', body: {} }, () => `/sessions/IDS/compact`],
    ['POST   /sessions/{id}/move', { method: 'POST', body: { cwd: arm.censusCwd } }, () => `/sessions/IDS/move`],
    ['POST   /sessions/{id}/handoff', { method: 'POST', body: { goal: 'census', summary: 'census summary', to: { cwd: arm.censusCwd } } }, () => `/sessions/IDS/handoff`],
    ['POST   /sessions/{id}/dev-burst {n:2}', { method: 'POST', body: { n: 2, text: 'census burst' }, timeoutMs: 8000 }, () => `/sessions/IDS/dev-burst`],
    ['POST   /sessions/{id}/message', { method: 'POST', body: { text: 'census turn' }, timeoutMs: 20000 }, () => `/sessions/IDS/message`],
    // 两条**宿主（server/base.mjs）**侧的路由：它们用 /tree 做存在性判定，而 pending 会话不在盘上
    // ⇒ 这里会把"树上没有"当成"不存在"。宿主不能改，这里只列事实（提案写在 docs/manager-toolkit-plan.md §11）。
    ['GET    /sessions/{id}/draft（宿主）', { method: 'GET' }, () => `/sessions/IDS/draft`],
    ['PUT    /sessions/{id}/draft（宿主）', { method: 'PUT', body: { text: 'census draft' } }, () => `/sessions/IDS/draft`],
    ['POST   /sessions/{id}/seen（宿主）', { method: 'POST', body: {} }, () => `/sessions/IDS/seen`],
  ];
  const rows = [];
  let inTreeCount = 0;
  for (const [label, options, template] of routes) {
    const id = await createPending(arm, 'census');
    const pathname = template().replace('/sessions/IDS', `/sessions/${id}`);
    const reply = await request(arm.basePort, pathname, options);
    const inTree = ((await request(arm.basePort, '/tree')).value?.sessions ?? []).some((node) => node.id === id);
    if (inTree) inTreeCount += 1;
    rows.push({
      route: label,
      sessionId: id,
      inTree,
      status: reply.status,
      error: errorCodeOf(reply),
      message: typeof reply.value?.message === 'string' ? reply.value.message.slice(0, 120) : null,
      note: reply.aborted ? 'timeout/abort（SSE 或长响应，只记头）' : null,
    });
  }
  const got500 = rows.filter((row) => row.status === 500).map((row) => `${row.route} → 500 ${row.error}`);
  const notFound = rows.filter((row) => row.status === 404).map((row) => `${row.route} → 404 ${row.error}`);
  const other = rows.filter((row) => row.status !== null && row.status >= 400 && row.status !== 404 && row.status !== 409 && row.status !== 500).map((row) => `${row.route} → ${row.status} ${row.error}`);
  print('pending 会话上的会话级路由普查（逐条事实）', rows);
  print('普查分类', { status500: got500, status404: notFound, other4xx: other, pendingVisibleInTree: `${inTreeCount}/${rows.length}` });
  // 机械判据只钉一条硬线：pending 会话上**任何**会话级路由以 500 收场都是缺陷（本门只度量、不把
  // 产品缺口伪装成绿）；404 那一组（/export 与宿主侧的 /draft /seen）只能"列事实"——它们是已知缺口，
  // 写在 docs/handoff.md 里，不属于本次修法 (a)/(b)/(c) 的范围。
  const failures = got500.length === 0 ? [] : [`pending 会话上有路由以 500 收场：${JSON.stringify(got500)}`];
  return { ok: failures.length === 0, failures, evidence: { rows, status500: got500, status404: notFound, other4xx: other, pendingVisibleInTree: `${inTreeCount}/${rows.length}` } };
}

/** (c) 工具描述必须与账本现实一致：校验级拒绝不落行 ⇒ 描述不许再说"每次尝试都落一行"。 */
async function gateToolDescriptionTruth(arm) {
  const failures = [];
  const loaded = await discoverAndLoadExtensions([path.join(ROOT, 'pi-extensions', 'assistant', 'index.ts')], ROOT, arm.home);
  if (loaded.errors?.length) failures.push(`插件加载有错：${JSON.stringify(loaded.errors)}`);
  const tool = loaded.extensions?.[0]?.tools?.get('handoff') ?? null;
  if (!tool) failures.push(`没有加载到 handoff 工具`);
  const description = tool?.definition?.description ?? '';
  print('handoff 工具描述（真加载值）', description);
  if (/every attempt/i.test(description)) failures.push(`描述不许再说"Every attempt appends one line"（校验级拒绝不落行是现实）`);
  if (!/successful attempts append one line/i.test(description)) failures.push(`描述必须说清"成功的尝试才落一行"`);
  if (!/append NO line/i.test(description)) failures.push(`描述必须明写"校验级拒绝不落行"`);
  return { ok: failures.length === 0, failures, evidence: { chars: description.length, hasEveryAttemptClaim: /every attempt/i.test(description), saysNoLineOnRefusal: /append NO line/i.test(description) } };
}

// ---------------------------------------------------------------------------
// 收尾：把我在这条门里建的**全部**临时会话归档，并用 /tree 复核（任务书第 5 条）。
// 沙箱本身随后整个删掉；这里要的是"归档这件事真的做了"的**证据**（完整 uuid + archived:true）。
// ---------------------------------------------------------------------------
async function gateArchiveAllCreated(arm) {
  const failures = [];
  const treeSessions = async () => (await request(arm.basePort, '/tree')).value?.sessions ?? [];
  const before = await treeSessions();
  const actions = [];
  for (const node of before) {
    if (node.archived === true) { actions.push({ id: node.id, alreadyArchived: true }); continue; }
    const reply = await request(arm.basePort, `/sessions/${node.id}/archive`, { method: 'POST', body: { archived: true } });
    if (reply.status !== 200) failures.push(`归档 ${node.id} 失败：${reply.status} ${reply.raw.slice(0, 140)}`);
    actions.push({ id: node.id, alreadyArchived: false, status: reply.status });
  }
  const after = await treeSessions();
  const notArchived = after.filter((node) => node.archived !== true).map((node) => node.id);
  if (notArchived.length > 0) failures.push(`收尾后 /tree 里仍有未归档会话：${JSON.stringify(notArchived)}`);
  return {
    ok: failures.length === 0,
    failures,
    evidence: {
      sessionsOnTree: after.length,
      archivedOnTree: after.filter((node) => node.archived === true).length,
      ids: after.map((node) => node.id),
      actions,
    },
  };
}

async function runAllGates(arm) {
  const gates = {};
  gates.G_pending_handoff = await gatePendingHandoff(arm);
  gates.G_pending_move = await gatePendingMove(arm);
  gates.G_durable_positive = await gateDurableHandoff(arm);
  gates.G_move_positive = await gateMovePositive(arm);
  gates.G_move_command = await gateMoveCommand(arm);
  gates.G_handoff_command = await gateHandoffCommand(arm);
  gates.G_tool_description = await gateToolDescriptionTruth(arm);
  gates.G_census_pending = await censusPendingRoutes(arm);
  gates.G_archive_all = await gateArchiveAllCreated(arm);
  return gates;
}

// ---------------------------------------------------------------------------
// 跑两臂
// ---------------------------------------------------------------------------

const problems = [];
let primaryError;
const summary = [];
try {
  // ---- arm real：真代码（未打补丁的副本），全部门必须绿
  {
    const codeRoot = await makeCodeRoot('real', []);
    const arm = await startArm({ name: 'real', codeRoot: codeRoot.root });
    try {
      const gates = await runAllGates(arm);
      for (const [name, gate] of Object.entries(gates)) {
        print(`arm real · ${name}`, gate);
        assert.equal(gate.ok, true, `真代码上 ${name} 必须绿，实际红：${JSON.stringify(gate.failures)}`);
      }
      summary.push({ arm: 'real', gates: Object.fromEntries(Object.entries(gates).map(([name, gate]) => [name, gate.ok])) });
    } finally {
      await stopArm(arm, problems);
    }
  }

  // ---- arm mutant：把 (a)/(b) 的修法去掉 ⇒ 两条 pending 门**必红**，并重现旧形状
  {
    const codeRoot = await makeCodeRoot('mutant', ['pending-blind-move', 'pending-blind-handoff']);
    print('arm mutant · 补丁', codeRoot.applied);
    const arm = await startArm({ name: 'mutant', codeRoot: codeRoot.root });
    try {
      const handoffGate = await gatePendingHandoff(arm);
      print('arm mutant · G_pending_handoff（应红）', handoffGate);
      assert.equal(handoffGate.ok, false, '把 handoff 的修法去掉后，G_pending_handoff 必须红 —— 它仍然绿说明这条门没有牙齿');
      assert.equal(handoffGate.evidence.status, 404, `突变副本应当重现缺陷 (a) 的旧形状（404 session_not_found），实际 ${handoffGate.evidence.status}：${JSON.stringify(handoffGate.evidence)}`);
      assert.equal(handoffGate.evidence.error, 'session_not_found', `突变副本的旧形状错误码必须是 session_not_found，实际 ${JSON.stringify(handoffGate.evidence.error)}`);

      const moveGate = await gatePendingMove(arm);
      print('arm mutant · G_pending_move（应红）', moveGate);
      assert.equal(moveGate.ok, false, '把 move 的修法去掉后，G_pending_move 必须红 —— 它仍然绿说明这条门没有牙齿');
      assert.equal(moveGate.evidence.status, 500, `突变副本应当重现缺陷 (b) 的旧形状（500 internal_error ENOENT），实际 ${moveGate.evidence.status}：${JSON.stringify(moveGate.evidence)}`);
      assert.equal(moveGate.evidence.error, 'internal_error', `突变副本的旧形状错误码必须是 internal_error，实际 ${JSON.stringify(moveGate.evidence.error)}`);

      summary.push({ arm: 'mutant', G_pending_handoff: handoffGate.ok, G_pending_move: moveGate.ok, handoffOldShape: handoffGate.evidence, moveOldShape: moveGate.evidence });
    } finally {
      await stopArm(arm, problems);
    }
  }

  // ---- arm command-mutant：(f) 的修法去掉 ⇒ 用户面 `/move` **必红**，并把那条瞬时 session.notice 原文贴出来
  {
    const codeRoot = await makeCodeRoot('command-mutant', ['command-blind-move']);
    print('arm command-mutant · 补丁', codeRoot.applied);
    const arm = await startArm({ name: 'command-mutant', codeRoot: codeRoot.root });
    try {
      const gate = await gateMoveCommand(arm);
      print('arm command-mutant · G_move_command（应红）', gate);
      assert.equal(gate.ok, false, '把 (f) 的修法去掉后，G_move_command 必须红 —— 它仍然绿说明这条门没有牙齿');
      const errorNotice = (gate.evidence.notices ?? []).find((notice) => notice.level === 'error') ?? null;
      assert.ok(errorNotice, `突变副本应当重现"只有一条瞬时 error notice、什么都没发生"，实际 notices=${JSON.stringify(gate.evidence.notices)}`);
      assert.ok(typeof errorNotice.text === 'string' && errorNotice.text.includes('move refused: the source session is streaming, compacting, retrying, or accepting a prompt'), `突变副本的 notice 必须是那条 409 session_busy_move 原文，实际 ${JSON.stringify(errorNotice.text)}`);
      assert.equal(gate.evidence.sourceArchived, null, `突变副本里源会话不许被归档，实际 ${JSON.stringify(gate.evidence.sourceArchived)}`);
      assert.equal(gate.evidence.toSessionId, null, `突变副本里不许建出 fork，实际 ${JSON.stringify(gate.evidence.toSessionId)}`);
      summary.push({ arm: 'command-mutant', G_move_command: gate.ok, rawNotice: errorNotice });
    } finally {
      await stopArm(arm, problems);
    }
  }

  print('S4 源会话 durability 门', { verdict: summary, allGreen: true });
} catch (error) {
  primaryError = error;
} finally {
  await removeSandbox(TMP, problems);
  finishCleanup(primaryError, problems);
}
