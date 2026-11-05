#!/usr/bin/env node
// 门：manager toolkit P0（`docs/manager-toolkit-plan.md` §1–§4 与 §7 里服务端能覆盖的那些）。
//
// 真 A（`server/base.mjs` + generation worker）+ 假 provider，无 Chromium。每一门都打**原始回执**，
// 结论只挂在那些字节上。覆盖：
//   ① 去重（dedupeKey 相同且未答 ⇒ 不新开；force:true 只刷新既有那条）
//   ② 两查（status=open 只回未答；status=answered 能查到刚答的那条，带 answer/by/at）
//   ③ 回答成一条 user 消息（`/messages` 里逐字可读，带 〔回答#q-xxxx〕 标记）
//   ④ 关闭留痕（by + at + reason 都在条目里；不在 open 列表）
//   ⑤ 不阻塞（提问前后 streaming 不变、pendingMessages 不增、不触发回合）
//   ⑥ 只读会话（cwd 缺失）读 questions **不许 500**（如实 readOnly），写操作如实 409
//   ⑦ 忙（流式）时回答 ⇒ **steer**（业主 2026-09-22 拍板：与输入框那条统一成「插进当前这一轮」）：
//      回执 `mode:'steer'`/`queued:false`，且用**假 provider 收到的 messages** 断言回答真的进了**当前这一轮**
//      （不是只看回执字串，也不是等这轮跑完才送达）。
//   ⑦b 压缩中回答 ⇒ 如实 409 `session_compacting`，且**一字不写**（侧车/会话文件逐字节未变、问题仍在 open）；
//   ⑦c 忙但**没有活跃回合**（只剩 `admissionPending`：一条扩展命令正卡在准入窗口）⇒ 如实退成 `followUp`
//      （`mode:'followUp'`/`queued:true`，文本真进 followUp 队列而不是 steering），且**不偷偷起一轮**；
//      下一次真跑时它才作为一条 user 消息送达。
//   ⑦d 自动重试的退避窗口：`isRetrying` 时 `isStreaming` **必为真**（pi 把退避 sleep 放在 `_runAgentPrompt`
//      的 try 块里）—— 实测断言它，并断言此时的回答也走 steer（不是 idle 支的 startPrompt）。
//   ⑧ 插件三工具真被模型调用时真的落到服务端（agent 无 answer 工具，只给人答）
//   ⑨ 通知（P0 服务端那一半）：该会话 SSE 上发 `session.question`（ask/answer 两个 op）
//   ⑩ 探针：`/questions` 到底由哪个 generation 服务（**那个词加进 SESSION_PATH 前**实测 = current worker；
//      **加词后**实测 = owner —— 见下面 ⑩ 那一段的 A/B 两半与 `npm run test:hostpath`）
//   ⑪ 工具契约（业主 dogfood 后拍板）：ask 必须自带 `context`（判断所需的事实）——
//      缺/过短 ⇒ 400 `question_needs_context` 且**一字不写**；合格 ⇒ 条目与 GET 逐字带出；
//      老条目（无 context）如实 null；answer/close 不受影响；插件把 400 映射成**可纠正**的工具错误
//      （模型先漏背景 ⇒ 看到错 ⇒ 带着 context 重问 ⇒ 真的落上）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { cp, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox, stopSpawnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'sopho-questions-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const CWD = path.join(TMP, 'cwd');
const BASE_LOG_PATH = path.join(TMP, 'base.log');
// 反证臂（`--reverse-arm`）：把 `server/` 拷到沙箱副本里、把 steer 那一段改回 `followUp`，再跑同一批断言 ⇒ 必红。
// （与 `test/fallback-proxy-retry.mjs` 的反证臂同一套做法：副本树 + 只改要反证的那一处。）
const REVERSE_ARM = process.argv.includes('--reverse-arm');
// 第二个反证臂（`--reverse-arm-fakereceipt`）：**只**把内部那一步改回 `followUp`，回执字串照旧写 `mode:'steer'`
// （= “假回执”那种最危险的退化）⇒ 回执那几条断言不会报，但「文本真进了当前这一轮 / 真进了 steering 队列」必红。
const REVERSE_FAKE_RECEIPT = process.argv.includes('--reverse-arm-fakereceipt');
let BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');
let BASE_CWD = ROOT;
const QUESTION_ENTRY = 'sopho.question';
const answerMark = (id) => `〔回答#${id}〕`;
// 工具契约（`docs/manager-toolkit-plan.md` §2/§3）：ask 必须自带「判断所需的事实」。门里所有 ask
// 都走这个 ≥40 字的夹具背景；缺它/过短的那两条专门在 GATE-11 里当**反例**打。
const CTX = '夹具背景：子会话 dry-run 已回，494 条合计 376.41 GB，全部在顶层、无重复；A 组纯日志 202.6 GB 零风险，B/C 中的日志部分约 358.6 GB。当前主线：先清零风险的日志。';
// 插件门（GATE-8/11）里模型真调 question_ask 时用的背景（≥40 字）。
const TOOL_CTX = '机器人产线 A 今晚 02:00 重启，重启期间约 8 分钟不可用；继续会白跑一轮，停下则丢掉本批 3 条未提交改动。当前主线：跑冒烟测试。';

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let baseChild;
let baseLog;
let provider;
let basePort;
let providerPort;
// 「把这一个 provider 响应挂住」的开关：置上后，**下一个**到达的请求会先等着（`release()` 才继续）。
// ⑦b 用它把**压缩窗口**真的开住（压缩就是一条 provider 请求），从而能确定地打一发「压缩中答题」。
let providerHold = null;
// ⑦d：带 `RETRY_WINDOW` 的第一发回 500（“overloaded”）把 pi 推进自动重试的退避窗口，第二发才正常回。
let retryWindowFailures = 0;

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
    await sleep(50);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

function sseChunk(delta, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-questions',
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

function toolResultText(messages = []) {
  return messages.filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content)).join('\n');
}

// 只在**最后一条** tool 结果上做判据：历史里出现过 'question_needs_context' 之后它会一直是真，
// 拿它当判据会让纠正回路永远绕不出去（本轮实测抽到）。
function lastToolResultText(messages = []) {
  const last = messages.at(-1);
  if (!last || last.role !== 'tool') return '';
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

function toolCall(name, args) {
  return sseChunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${name}-${Math.random().toString(16).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
}

// 假 provider：按最后一条 user 文本决定回什么。工具回合的第二跳用来"证明工具真跑过"
// （它把看到的 tool result 编进回复文字，测试再从 /messages 里读回来）。
async function startProvider() {
  const requests = [];
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const part of incoming) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    if (providerHold) {
      const held = providerHold;
      providerHold = null;
      held.started = true;
      await held.released;
    }
    const prompt = lastUserText(body.messages);
    // ⑦d：`RETRY_WINDOW` 的第一发回 500（“overloaded”）把 pi 推进自动重试的退避窗口，第二发才正常回。
    // ⚠️ 必须在 `writeHead(200, …)` **之前**判（那一行已经开了 SSE 响应头，之后再 writeHead 会
    // ERR_HTTP_HEADERS_SENT —— 本臂第一版就塌在这里）。
    if (body.messages.at(-1)?.role !== 'tool' && prompt.includes('RETRY_WINDOW')) {
      retryWindowFailures += 1;
      if (retryWindowFailures === 1) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: 'simulated overloaded (HTTP 500)', type: 'server_error' } }));
        return;
      }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const toolText = toolResultText(body.messages);
    // 第二跳的判据：**最后一条消息是 tool 结果**（而不是"历史里出现过任何 tool 结果"）——
    // 同一个会话里前几轮的工具结果会让后者永远为真。
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
      // `BUSY_WINDOW:<秒>`（默认 3）；⑩ 探针用它把会话在 draining 代里“占住”（忙的会话不会被逐出）。
      const seconds = Number(/BUSY_WINDOW(?::\s*(\d+))?/u.exec(prompt)?.[1] ?? 3);
      return emitTool('bash', { command: `sleep ${seconds}` });
    }
    // ⑦ 的判别器（不是看回执字串）：那一轮还在跑、而回答已经被**插话**进来时，这条请求的最后一条消息
    // 是那条回答（`STEER_PROOF`），而**这一轮还没收尾**（assistant 还没说过 `BUSY_WINDOW_DONE`）
    // ⇒ 回 `STEER_SEEN`（插话真的影响了当前这一轮）。若回答是**排队等本轮跑完**才到的（旧 followUp 语义），
    // 它到达时 `BUSY_WINDOW_DONE` 已在上下文里 ⇒ 回 `STEER_ARRIVED_LATE`。
    if (prompt.includes('STEER_PROOF')) {
      const turnAlreadyEnded = body.messages.some((message) => message.role === 'assistant'
        && (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text || '').join('')).includes('BUSY_WINDOW_DONE'));
      return emitText(turnAlreadyEnded ? 'STEER_ARRIVED_LATE' : 'STEER_SEEN');
    }
    if (!secondTurn && prompt.includes('TOOL_ASK_NOCONTEXT')) return emitTool('question_ask', { context: '太短', text: '工具先漏了背景：是否继续？', options: ['继续', '停'] });
    // 更新分支：模型把 question_list 给的 id 传回 `questionId` ⇒ 就地改那条（不新开）。
    if (!secondTurn && prompt.includes('TOOL_UPDATE ')) {
      const id = /TOOL_UPDATE (q-[0-9a-f]{8})/u.exec(prompt)?.[1];
      return emitTool('question_ask', { questionId: id, context: TOOL_CTX, text: '工具更新：改过的题面？', options: ['改甲', '改乙'], priority: 'high' });
    }
    if (!secondTurn && prompt.includes('TOOL_ASK')) return emitTool('question_ask', { context: TOOL_CTX, text: '工具问：是否继续？', options: ['继续（会白跑一轮）', '停（丢掉 3 条未提交改动）'], priority: 'high' });
    if (!secondTurn && prompt.includes('TOOL_CLOSE')) {
      const id = /TOOL_CLOSE (q-[0-9a-f]{8})/u.exec(prompt)?.[1];
      return emitTool('question_close', { id, reason: '工具判定已过期' });
    }
    if (!secondTurn && prompt.includes('TOOL_LIST')) return emitTool('question_list', { status: 'all' });
    if (!secondTurn) return emitText(prompt.includes('BUSY_WINDOW') ? 'BUSY_WINDOW_DONE' : 'FAKE_OK');
    // GATE-11：模型先漏背景（context 过短）⇒ 服务端 400 question_needs_context ⇒ 插件把 400 如实
    // 映射成**纠正性工具错误**。这条臂让模型真的“看到错、带着 context 重问”，而不是只断言一个字符串。
    if (prompt.includes('TOOL_ASK_NOCONTEXT')) {
      const lastTool = lastToolResultText(body.messages);
      if (/已记下问题/u.test(lastTool)) return emitText('ASKCTX_TOOL_OK');
      if (/question_needs_context/u.test(lastTool)) {
        return emitTool('question_ask', { context: TOOL_CTX, text: '工具先漏了背景：是否继续？', options: ['继续（会白跑一轮）', '停（丢掉 3 条未提交改动）'] });
      }
      return emitText(`ASKCTX_TOOL_FAIL ${lastTool.slice(-800)}`);
    }
    if (prompt.includes('TOOL_ASK')) return emitText(toolText.includes('已记下问题') ? 'ASK_TOOL_OK' : `ASK_TOOL_FAIL ${JSON.stringify(toolText).slice(-500)}`);
    if (prompt.includes('TOOL_UPDATE ')) return emitText(toolText.includes('已更新问题') ? 'UPDATE_TOOL_OK' : `UPDATE_TOOL_FAIL ${JSON.stringify(toolText).slice(-500)}`);
    if (prompt.includes('TOOL_CLOSE')) {
      const ok = toolText.includes('已关闭') && !toolText.includes('没关成');
      return emitText(ok ? 'CLOSE_TOOL_OK' : `CLOSE_TOOL_FAIL ${JSON.stringify(toolText).slice(-500)}`);
    }
    if (prompt.includes('TOOL_LIST')) {
      const wanted = /TOOL_LIST (q-[0-9a-f]{8})/u.exec(prompt)?.[1];
      return emitText(toolText.includes('filteredCount') && toolText.includes(wanted) ? 'LIST_TOOL_OK' : `LIST_TOOL_FAIL ${JSON.stringify(toolText).slice(-500)}`);
    }
    if (prompt.includes('BUSY_WINDOW')) return emitText('BUSY_WINDOW_DONE');
    return emitText('FAKE_OK');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return {
    server,
    requests,
    // 把**下一个**到达的 provider 响应挂住；返回的 `started`/`released` 由调用方等 / 放。
    holdNext() {
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      providerHold = { started: false, released, release };
      return providerHold;
    },
  };
}

// 会话 SSE 的小收集器：等“某个事件名来了”就够用（门只用它证明通知那半边真的发了）。
async function openSessionEvents(sessionId) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${basePort}/sessions/${sessionId}/events`, { signal: controller.signal });
  const seen = [];
  let buffer = '';
  const reader = (async () => {
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
      }
    } catch { /* stream closed */ }
  })();
  return {
    seen,
    async close() { controller.abort(); await reader; },
  };
}

// 「回答到底进了 steering 还是 followUp 队列」只能从队列真相读 —— `/sessions/{id}` 的 runtime 不带队列，
// SSE 的 `session.snapshot.queue:{steering,followUp}`（**文本**）才是那份事实。这里新开一条连接、
// 取头部那个 snapshot 帧、马上关。
async function queueSnapshotOf(sessionId) {
  const events = await openSessionEvents(sessionId);
  try {
    const frame = await poll('session.snapshot on a fresh SSE', () => events.seen.find((entry) => entry.name === 'session.snapshot'), (value) => Boolean(value), 10_000);
    return frame.data?.queue ?? null;
  } finally {
    await events.close();
  }
}

async function sessionFileOf(sessionId) {
  const files = await readdir(SESSIONS, { recursive: true });
  const hit = files.find((entry) => typeof entry === 'string' && entry.endsWith(`${sessionId}.jsonl`));
  if (!hit) return null;
  return path.join(SESSIONS, hit);
}

async function questionEntries(sessionId) {
  const file = await sessionFileOf(sessionId);
  if (!file) return [];
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'custom' && entry.customType === QUESTION_ENTRY)
    .map((entry) => entry.data);
}

async function messagesOf(sessionId) {
  const reply = await request(`/sessions/${sessionId}/messages`);
  assert.equal(reply.status, 200, reply.raw);
  return reply.value.messages;
}

async function waitIdle(sessionId, timeoutMs = 40_000) {
  return poll(`session ${sessionId} settles`, () => request(`/sessions/${sessionId}`), (reply) => reply.value?.runtime?.isStreaming === false
    && reply.value?.runtime?.isCompacting === false
    && (reply.value?.pendingMessages ?? 0) === 0, timeoutMs);
}

async function ask(sessionId, body) {
  return request(`/sessions/${sessionId}/questions`, { method: 'POST', body });
}

// 契约（方案 §3，2026-09-20 定）：answer/close 都是同一个 POST，靠 body 里的 `op` 区分。
async function answer(sessionId, qid, text) {
  return ask(sessionId, { op: 'answer', qid, text });
}

async function close(sessionId, qid, reason, by) {
  return ask(sessionId, { op: 'close', qid, reason, ...(by === undefined ? {} : { by }) });
}

// 契约（方案 §3，2026-09-21 定）：按 id 更新一条未答问题 —— 同一层 POST，`op:'update'`。
async function update(sessionId, qid, patch) {
  return ask(sessionId, { op: 'update', qid, ...patch });
}

let primaryError;
try {
  for (const directory of [HOME, SESSIONS, CWD, path.join(HOME, 'extensions')]) await mkdir(directory, { recursive: true });
  // ⑦c 用的测试扩展：一条「慢命令」——它让会话停在**准入窗口**（`admissionPending` 真、`isStreaming` 还是假），
  // 这正是「忙但没有活跃回合」那个只有在真实的窗口里才看得到的状态。落在沙箱 home 的 `extensions/`
  // （pi 的 user-extension 自动发现；与 `test/notice-channel.mjs` 同一套做法，**不动用户的插件**）。
  await writeFile(path.join(HOME, 'extensions', 'slow-step.ts'), `
export default function (pi) {
  pi.registerCommand("slow-step", {
    description: "test-only: hold the prompt admission window for N ms",
    handler: async (args, ctx) => {
      const ms = Number(String(args || "").trim()) || 3000;
      // 先说一声再睡：门靠这条 notice（SSE 的 session.notice）确定地知道「准入窗口真的开了」
      // —— 否则它只能猜一个 sleep。
      ctx.ui.notify("SLOWSTEP_STARTED", "info");
      await new Promise((resolve) => setTimeout(resolve, ms));
      ctx.ui.notify("SLOWSTEP_DONE", "info");
    },
  });
}
`, 'utf8');
  if (REVERSE_ARM || REVERSE_FAKE_RECEIPT) {
    const tree = path.join(TMP, 'reverse-tree');
    await mkdir(tree, { recursive: true });
    for (const part of ['server', 'pi-extensions']) await cp(path.join(ROOT, part), path.join(tree, part), { recursive: true });
    await cp(path.join(ROOT, 'package.json'), path.join(tree, 'package.json'));
    // Windows 上普通 symlink 要特权；'junction' 不用（且 Linux 上等价于 dir）。
    await symlink(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'), 'junction');
    const logicPath = path.join(tree, 'server', 'base-logic.mjs');
    const source = await readFile(logicPath, 'utf8');
    // 要改回去的那一段必须是 **deliverAnswer 独有**的 —— `deliver()` 里也有一行同缩进的 `await session.steer(text);`，
    // 单拿那一行去 replace 会改错地方（实测抽到过：假回执臂因此照样全绿）。所以锚点带上它后面的回执块。
    const from = "        await session.steer(text);\n        return {\n          mode: 'steer',\n          queued: false,";
    assert.ok(source.includes(from), '反证臂：要改回去的那一段在 base-logic.mjs 里找得到（找不到说明代码形状变了，本臂要跟着改）');
    const to = REVERSE_FAKE_RECEIPT
      ? "        await session.followUp(text);\n        return {\n          mode: 'steer',\n          queued: false,"
      : "        await session.followUp(text);\n        return {\n          mode: 'followUp',\n          queued: true,";
    await writeFile(logicPath, source.replace(from, to));
    BASE_ENTRY = path.join(tree, 'server', 'base.mjs');
    BASE_CWD = tree;
    print('reverse-arm mutation', {
      mutation: REVERSE_FAKE_RECEIPT
        ? 'deliverAnswer: session.steer → session.followUp（回执照旧写 mode:steer / queued:false ⇒ 假回执）'
        : 'deliverAnswer: session.steer → session.followUp（连同回执 mode:followUp/queued:true —— 旧语义整段搬回来）',
      tree,
    });
  }
  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used);
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-questions', name: 'Fake questions', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-questions', defaultThinkingLevel: 'off', compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000, provider: { maxRetries: 0 } } }, null, 2)}\n`);
  // 上面两个旋钮都是为门服务的，不会影响到别的门：
  // · `keepRecentTokens: 1` — 让 **⑦b 的手动压缩**在这么小的夹具会话上也真的跑得起来（自动压缩仍 `enabled:false`）；
  // · `retry.enabled:true` + `baseDelayMs:2000` — 让 **⑦d** 能把 pi 的自动重试退避窗口真开住；
  //   假 provider 只在带 `RETRY_WINDOW` 的那一发上回 500（“overloaded”），别的门一个错误都不制造。

  // 只读夹具：cwd 不存在、文件里已经躺着一条未答的问题（冷会话，不建任何 runtime）。
  const readonlyId = randomUUID();
  const missingCwd = path.join(TMP, 'gone-directory');
  const readonlyNow = new Date().toISOString();
  await writeFile(path.join(SESSIONS, `readonly_${readonlyId}.jsonl`), [
    { type: 'session', version: 3, id: readonlyId, timestamp: readonlyNow, cwd: missingCwd },
    { type: 'message', id: 'r0000001', parentId: null, timestamp: readonlyNow, message: { role: 'user', content: [{ type: 'text', text: '只读夹具' }], timestamp: Date.now() } },
    { type: 'custom', id: 'r0000002', parentId: 'r0000001', timestamp: readonlyNow, customType: QUESTION_ENTRY, data: { id: 'q-00000001', op: 'ask', text: '只读会话里的老问题', options: null, priority: 'normal', dedupeKey: 'aaaaaaaaaaaa', at: Date.now() - 1000, by: 'agent' } },
  ].map(JSON.stringify).join('\n') + '\n');

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

  const created = await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'questions' } });
  assert.equal(created.status, 201, created.raw);
  const sessionId = created.value.id;
  // 热身一轮：pi 的 SessionManager 在**第一条 assistant 消息落盘前**不写文件（`_persist` 的
  // `hasAssistant` 闸），所以"条目进文件"要等这一轮。真实路径里 question_ask 只能在一轮里被调，
  // 而那时带 toolCall 的 assistant 消息已经落盘 —— 这道热身只是让门里的文件断言可证。
  assert.equal((await request(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'WARMUP' } })).status, 202);
  await waitIdle(sessionId);
  assert.ok(await sessionFileOf(sessionId), `热身之后会话文件应当存在（${SESSIONS}）`);
  print('sandbox', { tmp: TMP, providerPort, basePort, basePid: baseChild.pid, sessionId, readonlyId });

  // 探针：四个端点在**修前**分别回什么（无副作用：只打空 text / 未知 qid / 只读 GET）。
  // 修前：URL 上根本没有 `/questions` ⇒ 全部 404 `{"error":"not found"}`（宿主与逻辑层都没有这条路由）；
  // 修后：200 / 400 invalid_text / 404 question_not_found / 400 invalid_op / 405。
  const probe = {
    list: await request(`/sessions/${sessionId}/questions`),
    listAll: await request(`/sessions/${sessionId}/questions?status=all&limit=5`),
    askEmpty: await ask(sessionId, { text: '' }),
    answerUnknown: await ask(sessionId, { op: 'answer', qid: 'q-deadbeef', text: 'x' }),
    closeUnknown: await ask(sessionId, { op: 'close', qid: 'q-deadbeef', reason: 'x' }),
    badOp: await ask(sessionId, { op: 'whatever', text: 'x' }),
    wrongMethod: await request(`/sessions/${sessionId}/questions`, { method: 'PUT' }),
  };
  // 机械护栏（契约选的是“一层面路径 + body op”，宿主 `server/base.mjs` 一行都不该改）放在 ⑩ 里做 ——
  // 那里把宿主那一行正则取出来、拿真 URL 试一遍（静态事实），再配一个 dynamic 路由探针。
  print('probe (修前红 / 修后绿 的原始凭据)', {
    list: { status: probe.list.status, body: probe.list.value },
    listAll: { status: probe.listAll.status, body: probe.listAll.value },
    askEmpty: { status: probe.askEmpty.status, body: probe.askEmpty.value },
    answerUnknown: { status: probe.answerUnknown.status, body: probe.answerUnknown.value },
    closeUnknown: { status: probe.closeUnknown.status, body: probe.closeUnknown.value },
    badOp: { status: probe.badOp.status, body: probe.badOp.value },
    wrongMethod: { status: probe.wrongMethod.status, body: probe.wrongMethod.value },
  });

  // ── ① 去重：同 dedupeKey 连 ask 两次 ⇒ 只有 1 条 open，第二次返回既有 id（deduped:true）──
  const askText = '要不要把 X 删掉？';
  const first = await ask(sessionId, { context: CTX, text: askText, options: ['删', '留'] });
  assert.equal(first.status, 201, first.raw);
  assert.equal(first.value.created, true);
  const qid = first.value.id;
  assert.match(qid, /^q-[0-9a-f]{8}$/u);
  const second = await ask(sessionId, { context: CTX, text: `  要不要把   X 删掉？  ` }); // 归一化后同 dedupeKey
  assert.equal(second.status, 200, second.raw);
  assert.equal(second.value.id, qid, '第二次必须返回既有 id，不许新开');
  assert.equal(second.value.deduped, true);
  assert.equal(second.value.created, false);
  assert.equal(second.value.question.entryCount, 1, '未答且非 force ⇒ 文件里该 id 只能有 1 条 ask');
  const forced = await ask(sessionId, { context: CTX, text: askText, priority: 'high', force: true });
  assert.equal(forced.status, 200, forced.raw);
  assert.equal(forced.value.id, qid, 'force:true 合并进既有条目，id 不变');
  assert.equal(forced.value.forced, true);
  assert.equal(forced.value.question.entryCount, 2, 'force:true = 同 id 再追加一条 ask（刷新），仍然 1 条 open');
  assert.equal(forced.value.question.priority, 'high');
  const openAfterDedupe = await request(`/sessions/${sessionId}/questions?status=open`);
  assert.equal(openAfterDedupe.status, 200, openAfterDedupe.raw);
  assert.equal(openAfterDedupe.value.questions.length, 1, `只许 1 条 open，实测 ${openAfterDedupe.raw}`);
  assert.deepEqual(openAfterDedupe.value.counts, { open: 1, answered: 0, closed: 0, concluded: 0, total: 1 });
  const askEntries = (await questionEntries(sessionId)).filter((data) => data.id === qid && data.op === 'ask');
  assert.equal(askEntries.length, 2, `文件里该 id 应有 2 条 ask（首次 + force 刷新），实测 ${JSON.stringify(askEntries)}`);
  print('GATE-1 dedupe', { id: qid, second: second.value.deduped, forced: forced.value.forced, fileAskEntries: askEntries.length, counts: openAfterDedupe.value.counts });

  // ── ⑤ 不阻塞：提问前后 streaming 不变、pendingMessages 不增、不触发回合 ──
  const beforeAsk = await request(`/sessions/${sessionId}`);
  const beforeMessages = (await messagesOf(sessionId)).length;
  const beforeEntryCount = (await questionEntries(sessionId)).length;
  const oneMore = await ask(sessionId, { context: CTX, text: '第二条：用哪个方案？' });
  assert.equal(oneMore.status, 201, oneMore.raw);
  const secondQid = oneMore.value.id;
  await sleep(400);
  const afterAsk = await request(`/sessions/${sessionId}`);
  const afterMessages = (await messagesOf(sessionId)).length;
  assert.equal(afterAsk.value.runtime.isStreaming, false, '提问不许把会话变成流式');
  assert.equal(beforeAsk.value.runtime.isStreaming, afterAsk.value.runtime.isStreaming, '提问前后 streaming 必须不变');
  assert.equal(afterAsk.value.pendingMessages, beforeAsk.value.pendingMessages, `提问前后 pendingMessages 不许变（${beforeAsk.value.pendingMessages} → ${afterAsk.value.pendingMessages}）`);
  assert.equal(afterAsk.value.pendingMessages, 0);
  assert.equal(afterMessages, beforeMessages, '提问不许触发回合（正文条数不变）');
  assert.equal((await questionEntries(sessionId)).length, beforeEntryCount + 1, '提问确实落了条目');
  print('GATE-5 non-blocking', { streaming: [beforeAsk.value.runtime.isStreaming, afterAsk.value.runtime.isStreaming], pendingMessages: [beforeAsk.value.pendingMessages, afterAsk.value.pendingMessages], messages: [beforeMessages, afterMessages] });

  // ── ② 两查 + ③ 回答成消息 + ④ 关闭留痕 ──
  const answerText = '批准：删掉 X，先备份。';
  const answered = await answer(sessionId, qid, answerText);
  assert.equal(answered.status, 200, answered.raw);
  assert.equal(answered.value.question.status, 'answered', '回答后该问题立即变成 answered');
  assert.equal(answered.value.question.answer, answerText);
  assert.equal(answered.value.question.answerBy, 'user');
  assert.equal(answered.value.delivery.queued, false, '空闲会话：回答直接作为一条消息触发一轮回复');
  assert.equal(answered.value.delivery.mode, 'message');
  assert.equal(typeof answered.value.question.answeredAt, 'number');
  // 前端（P1）要的回执形状（业主 2026-09-20 在父会话里定的口径）：逐字段钉住。
  assert.equal(answered.value.ok, true);
  assert.equal(answered.value.id, qid);
  assert.equal(answered.value.status, 'answered');
  assert.equal(typeof answered.value.answeredAt, 'number');
  assert.equal(answered.value.by, 'user');
  assert.equal(answered.value.queuedForDelivery, false, '空闲会话：回答立即作为一条消息发出');
  const openNow = await request(`/sessions/${sessionId}/questions?status=open`);
  assert.deepEqual(openNow.value.questions.map((item) => item.id), [secondQid], `open 只回未答（实测 ${openNow.raw}）`);
  const answeredNow = await request(`/sessions/${sessionId}/questions?status=answered`);
  const answeredItem = answeredNow.value.questions.find((item) => item.id === qid);
  assert.ok(answeredItem, `status=answered 必须能查到刚答的那条（实测 ${answeredNow.raw}）`);
  assert.equal(answeredItem.status, 'answered');
  assert.equal(answeredItem.answer, answerText);
  assert.equal(answeredItem.answerBy, 'user');
  assert.equal(typeof answeredItem.answeredAt, 'number');
  assert.equal(answeredNow.value.counts.open, 1);
  assert.equal(answeredNow.value.counts.answered, 1);
  assert.equal(answeredNow.value.counts.concluded, 1, 'concluded = 有结论的（answered ∪ closed）');
  assert.equal(answeredNow.value.filteredCount, answeredNow.value.counts.concluded, 'status=answered 的返回集大小必须 = counts.concluded');
  assert.equal(answeredNow.value.counts.open + answeredNow.value.counts.concluded, answeredNow.value.counts.total, 'open + concluded = total');
  print('GATE-2 two-way lookup', { open: openNow.value.questions.map((item) => item.id), answered: answeredNow.value.questions.map((item) => `${item.id}:${item.status}`), counts: answeredNow.value.counts });

  await waitIdle(sessionId);
  const marker = `${answerMark(qid)}${answerText}`;
  const withAnswer = await poll('answer message lands verbatim', () => messagesOf(sessionId), (messages) => messages.some((message) => message.role === 'user' && message.text === marker));
  const answerMessages = withAnswer.filter((message) => message.role === 'user' && message.text === marker);
  assert.equal(answerMessages.length, 1, `回答只许作为一条 user 消息出现一次，实测 ${JSON.stringify(answerMessages.map((message) => message.entryId))}`);
  const fileText = await readFile(await sessionFileOf(sessionId), 'utf8');
  assert.ok(fileText.includes(marker), '回答逐字在会话文件里');
  print('GATE-3 answer becomes a message', { entryId: answerMessages[0].entryId, text: answerMessages[0].text, occurrences: answerMessages.length });

  // ④ 关闭留痕：agent 关（插件那条路会送 by:agent）
  const closeReason = '方案已改，这条不用答了';
  const closed = await close(sessionId, secondQid, closeReason, 'agent');
  assert.equal(closed.status, 200, closed.raw);
  assert.equal(closed.value.closedBy, 'agent');
  assert.equal(closed.value.status, 'closed');
  assert.equal(closed.value.question.status, 'closed');
  assert.equal(closed.value.question.closeReason, closeReason);
  assert.equal(typeof closed.value.question.closedAt, 'number');
  const openAfterClose = await request(`/sessions/${sessionId}/questions?status=open`);
  assert.equal(openAfterClose.value.questions.length, 0, `关闭后不在 open 列表（实测 ${openAfterClose.raw}）`);
  const allAfterClose = await request(`/sessions/${sessionId}/questions?status=all`);
  const closedItem = allAfterClose.value.questions.find((item) => item.id === secondQid);
  assert.equal(closedItem.status, 'closed');
  assert.equal(closedItem.closedBy, 'agent');
  assert.equal(closedItem.closeReason, closeReason);
  // 口径（业主 2026-09-20 定的）：status=answered 是【有结论的】= 答过的【或】关掉的 —— 关掉的必须也在里面。
  const answeredAfterClose = await request(`/sessions/${sessionId}/questions?status=answered`);
  assert.deepEqual(answeredAfterClose.value.questions.map((item) => `${item.id}:${item.status}`).sort(), [`${qid}:answered`, `${secondQid}:closed`].sort(), `status=answered 必须同时含已答与已关（实测 ${answeredAfterClose.raw}）`);
  assert.equal(answeredAfterClose.value.filteredCount, answeredAfterClose.value.counts.concluded);
  assert.equal(answeredAfterClose.value.counts.answered, 1, 'counts.answered 是逐状态计数（仅答过），concluded 才是有结论的总数');
  assert.equal(answeredAfterClose.value.counts.closed, 1);
  assert.equal(answeredAfterClose.value.counts.concluded, 2);
  assert.equal(answeredAfterClose.value.counts.open + answeredAfterClose.value.counts.concluded, answeredAfterClose.value.counts.total);
  const closeEntries = (await questionEntries(sessionId)).filter((data) => data.id === secondQid && data.op === 'close');
  assert.equal(closeEntries.length, 1, '文件里应恰好 1 条 close');
  assert.deepEqual(Object.keys(closeEntries[0]).sort(), ['at', 'by', 'closeReason', 'id', 'op', 'text'], `close 条目字段（实测 ${JSON.stringify(closeEntries[0])}）`);
  assert.equal(closeEntries[0].by, 'agent');
  assert.equal(closeEntries[0].closeReason, closeReason);
  assert.equal(typeof closeEntries[0].at, 'number');
  print('GATE-4 close trace', { status: closedItem.status, by: closeEntries[0].by, at: closeEntries[0].at, reason: closeEntries[0].closeReason, open: openAfterClose.value.questions.length, answeredSet: answeredAfterClose.value.questions.map((item) => `${item.id}:${item.status}`), counts: answeredAfterClose.value.counts });

  // 坏输入如实 4xx（不静默）
  const badStatus = await request(`/sessions/${sessionId}/questions?status=whatever`);
  assert.equal(badStatus.status, 400); assert.equal(badStatus.value.error, 'invalid_status');
  const badLimit = await request(`/sessions/${sessionId}/questions?limit=0`);
  assert.equal(badLimit.status, 400); assert.equal(badLimit.value.error, 'invalid_limit');
  const badText = await ask(sessionId, { text: '   ' });
  assert.equal(badText.status, 400); assert.equal(badText.value.error, 'invalid_text');
  const badPriority = await ask(sessionId, { context: CTX, text: '优先级非法', priority: 'urgent' });
  assert.equal(badPriority.status, 400); assert.equal(badPriority.value.error, 'invalid_priority');
  const badOptions = await ask(sessionId, { context: CTX, text: '选项非法', options: ['ok', 3] });
  assert.equal(badOptions.status, 400); assert.equal(badOptions.value.error, 'invalid_options');
  const unknownQuestion = await ask(sessionId, { op: 'answer', qid: 'q-deadbeef', text: 'x' });
  assert.equal(unknownQuestion.status, 404); assert.equal(unknownQuestion.value.error, 'question_not_found');
  const badQuestionId = await ask(sessionId, { op: 'answer', qid: 'not-an-id', text: 'x' });
  assert.equal(badQuestionId.status, 400); assert.equal(badQuestionId.value.error, 'invalid_question_id');
  const badOp = await ask(sessionId, { op: 'whatever', text: 'x' });
  assert.equal(badOp.status, 400); assert.equal(badOp.value.error, 'invalid_op');
  const missingQid = await ask(sessionId, { op: 'close', reason: 'x' });
  assert.equal(missingQid.status, 400); assert.equal(missingQid.value.error, 'invalid_question_id');
  const doubleAnswer = await answer(sessionId, qid, '再答一次');
  assert.equal(doubleAnswer.status, 409); assert.equal(doubleAnswer.value.error, 'question_not_open');
  assert.equal(doubleAnswer.value.details.status, 'answered');
  const doubleClose = await close(sessionId, secondQid, '再关一次');
  assert.equal(doubleClose.status, 409); assert.equal(doubleClose.value.error, 'question_not_open');
  const wrongMethod = await request(`/sessions/${sessionId}/questions`, { method: 'PUT' });
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.value.error, 'method_not_allowed');
  print('bad input 4xx', { status: badStatus.value.error, limit: badLimit.value.error, text: badText.value.error, priority: badPriority.value.error, options: badOptions.value.error, unknown: unknownQuestion.value.error, badId: badQuestionId.value.error, badOp: badOp.value.error, missingQid: missingQid.value.error, doubleAnswer: doubleAnswer.value.error, doubleClose: doubleClose.value.error, method: wrongMethod.value.error });

  // ── ⑨ 通知（P0 只做服务端那一半）：该会话 SSE 上发 `session.question`（不复用“未读”） ──
  const events = await openSessionEvents(sessionId);
  await poll('session.snapshot on the session SSE', async () => events.seen.find((event) => event.name === 'session.snapshot') ?? null, Boolean);
  const notifyQ = await ask(sessionId, { context: CTX, text: 'SSE 通知门：新问题？', priority: 'high' });
  assert.equal(notifyQ.status, 201, notifyQ.raw);
  const askEvent = await poll('session.question (ask) on the session SSE', async () => events.seen.find((event) => event.name === 'session.question' && event.data.op === 'ask' && event.data.id === notifyQ.value.id) ?? null, Boolean);
  assert.equal(askEvent.data.text, 'SSE 通知门：新问题？');
  assert.equal(askEvent.data.priority, 'high');
  assert.equal(askEvent.data.by, 'agent');
  const notifyAnswer = await answer(sessionId, notifyQ.value.id, '通知门：答了');
  assert.equal(notifyAnswer.status, 200, notifyAnswer.raw);
  const answerEvent = await poll('session.question (answer) on the session SSE', async () => events.seen.find((event) => event.name === 'session.question' && event.data.op === 'answer' && event.data.id === notifyQ.value.id) ?? null, Boolean);
  assert.equal(answerEvent.data.answer, '通知门：答了');
  assert.equal(answerEvent.data.by, 'user');
  await events.close();
  await waitIdle(sessionId);
  print('GATE-9 question notification (SSE)', { ask: { op: askEvent.data.op, id: askEvent.data.id, priority: askEvent.data.priority, by: askEvent.data.by }, answer: { op: answerEvent.data.op, answer: answerEvent.data.answer, by: answerEvent.data.by }, treeEvents: 'session.question 已进 TREE_EVENT_SUPPRESSED（不发 tree 事件）' });

  // ── ⑥ 只读会话（cwd 缺失）读 questions 不许 500 ──
  const readonlyView = await request(`/sessions/${readonlyId}/questions?status=all`);
  assert.equal(readonlyView.status, 200, `cwd 缺失的只读会话读 questions 不许 500：${readonlyView.raw}`);
  assert.equal(readonlyView.value.readOnly, true);
  assert.equal(readonlyView.value.readOnlyReason, 'cwd-missing');
  assert.equal(readonlyView.value.cwdMissing, missingCwd);
  assert.deepEqual(readonlyView.value.questions.map((item) => item.id), ['q-00000001']);
  assert.equal(readonlyView.value.questions[0].text, '只读会话里的老问题');
  // ④（GATE-11）老条目（手写的 sopho.question，没有 context 字段）⇒ 字段如实缺失、不报错、不许编。
  assert.equal(readonlyView.value.questions[0].context, null, '老条目没有 context 时必须如实给 null（append-only，不回填、不编）');
  const readonlyWrite = await ask(readonlyId, { text: '不该写进去' });
  assert.equal(readonlyWrite.status, 409, readonlyWrite.raw);
  assert.equal(readonlyWrite.value.error, 'session_cwd_missing');
  const readonlyAnswer = await answer(readonlyId, 'q-00000001', '答不了');
  assert.equal(readonlyAnswer.status, 409, readonlyAnswer.raw);
  assert.equal(readonlyAnswer.value.error, 'session_cwd_missing');
  // 活会话把 cwd 删掉也是同一条口径（热会话那条路）
  const goneCwd = path.join(TMP, 'gone-live');
  await mkdir(goneCwd, { recursive: true });
  const liveReadonly = await request('/sessions', { method: 'POST', body: { cwd: goneCwd, name: 'gone' } });
  assert.equal(liveReadonly.status, 201, liveReadonly.raw);
  const liveId = liveReadonly.value.id;
  assert.equal((await ask(liveId, { context: CTX, text: '删 cwd 之前的问题' })).status, 201);
  await rm(goneCwd, { recursive: true, force: true });
  const liveView = await request(`/sessions/${liveId}/questions?status=open`);
  assert.equal(liveView.status, 200, `热会话 cwd 缺失也不许 500：${liveView.raw}`);
  assert.equal(liveView.value.readOnly, true);
  assert.equal(liveView.value.questions.length, 1);
  print('GATE-6 readonly session', { cold: { status: readonlyView.status, readOnly: readonlyView.value.readOnly, ids: readonlyView.value.questions.map((item) => item.id) }, coldWrite: readonlyWrite.value.error, hot: { status: liveView.status, readOnly: liveView.value.readOnly, ids: liveView.value.questions.map((item) => item.id) } });

  // ── ⑦ 忙（流式）时回答 ⇒ **steer**：插进当前这一轮（业主 2026-09-22 拍板，与输入框那条统一）──
  //    判据不看回执字串：假 provider **收到的 messages** 里要有那条回答，而且它到达时**这一轮还没收尾**
  //    （上下文中没有 assistant 的 `BUSY_WINDOW_DONE`）。
  const busySession = (await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'busy-answer' } })).value.id;
  const busyQ = (await ask(busySession, { context: CTX, text: '忙的时候问的：走 A 还是 B？' })).value.id;
  await waitIdle(busySession);
  const providerRequestStart = provider.requests.length;
  const startedBusy = await request(`/sessions/${busySession}/message`, { method: 'POST', body: { text: 'BUSY_WINDOW: 先跑一会儿' } });
  assert.equal(startedBusy.status, 202, startedBusy.raw);
  await poll('busy window opens', () => request(`/sessions/${busySession}`), (reply) => reply.value?.runtime?.isStreaming === true);
  const pendingBeforeAnswer = (await request(`/sessions/${busySession}`)).value.pendingMessages;
  const busyAnswerText = '忙时回答：走 B。STEER_PROOF';
  const busymarker = `${answerMark(busyQ)}${busyAnswerText}`;
  const busyAnswered = await answer(busySession, busyQ, busyAnswerText);
  assert.equal(busyAnswered.status, 200, `流式中回答不许 409：${busyAnswered.raw}`);
  assert.equal(busyAnswered.value.delivery.mode, 'steer', `流式中回答必须走 steer（原始回执：${busyAnswered.raw}）`);
  assert.equal(busyAnswered.value.delivery.queued, false, 'steer 不是排队 —— 回执里 queued 必须是 false');
  assert.equal(busyAnswered.value.queuedForDelivery, false, '前端要的字段：steer 这条路不是「已排队」');
  assert.match(busyAnswered.value.delivery.note, /插话/u, 'note 要说清它是插话（不是排队）');
  assert.match(busyAnswered.value.delivery.note, /这一轮/u, 'note 要说清它会影响当前这一轮');
  assert.equal(busyAnswered.value.status, 'answered');
  assert.equal(busyAnswered.value.by, 'user');
  assert.equal(typeof busyAnswered.value.answeredAt, 'number');
  assert.equal(busyAnswered.value.question.status, 'answered', '忙时回答也立刻标成 answered（回答已记录）');
  const duringBusy = await request(`/sessions/${busySession}`);
  assert.equal(duringBusy.value.runtime.isStreaming, true, '插话不许打断当前回合');
  assert.equal(duringBusy.value.pendingMessages, pendingBeforeAnswer + 1, `插话应恰好进队列 1 条（${pendingBeforeAnswer} → ${duringBusy.value.pendingMessages}）`);
  const queueDuringBusy = await queueSnapshotOf(busySession);
  assert.ok(queueDuringBusy, 'SSE 头部必须有 session.snapshot.queue');
  assert.ok(queueDuringBusy.steering.includes(busymarker), `回答必须在 **steering** 队列里（实测 ${JSON.stringify(queueDuringBusy)}）`);
  assert.ok(!queueDuringBusy.followUp.includes(busymarker), '回答**不许**在 followUp 队列里（那是旧的相反语义）');
  const openDuringBusy = await request(`/sessions/${busySession}/questions?status=open`);
  assert.equal(openDuringBusy.value.questions.length, 0, '回答过的问题立刻不在 open 列表');
  // ★ 真的进了当前这一轮：假 provider 收到的这一跳里，最后一条（非 tool）就是那条回答，而**这一轮没收尾**。
  const textOfMessage = (message) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part?.text || '').join('');
  const steerHop = await poll('answer injected into the running turn (raw provider evidence)',
    async () => provider.requests.slice(providerRequestStart),
    (requests) => requests.some((request) => JSON.stringify(request.messages).includes(busymarker)
      && request.messages.some((message) => message.role === 'tool')
      && !request.messages.some((message) => message.role === 'assistant' && textOfMessage(message).includes('BUSY_WINDOW_DONE'))), 30_000);
  const steeredRequest = steerHop.find((request) => JSON.stringify(request.messages).includes(busymarker) && request.messages.some((message) => message.role === 'tool'));
  const injectedAt = steeredRequest.messages.findIndex((message) => textOfMessage(message) === busymarker);
  assert.ok(injectedAt > 0, `回答必须真的作为一条消息进模型上下文（实测 index ${injectedAt}）`);
  assert.equal(steeredRequest.messages[injectedAt - 1].role, 'tool', '回答就在那条还在跑的 tool 调用之后被插进来（不是等这一轮跑完）');
  await waitIdle(busySession, 60_000);
  const busyMessages = await messagesOf(busySession);
  const busyLanded = busyMessages.filter((message) => message.text === busymarker);
  assert.equal(busyLanded.length, 1, `插话只许送达 1 次，实测 ${busyLanded.length}`);
  assert.equal(busyLanded[0].role, 'user');
  const seenIndex = busyMessages.findIndex((message) => message.role === 'assistant' && message.text === 'STEER_SEEN');
  const answerIndex = busyMessages.findIndex((message) => message.entryId === busyLanded[0].entryId);
  assert.ok(seenIndex >= 0, `这一轮必须真把它当上下文用上（原始尾部：${JSON.stringify(busyMessages.map((message) => message.text).slice(-4))}）`);
  assert.ok(answerIndex < seenIndex, '回答必须排在「它被读到」的那条回复之前（= 同一轮里插进去的）');
  assert.ok(!busyMessages.some((message) => message.text === 'STEER_ARRIVED_LATE'), '回答不许是这一轮跑完之后才到的（那就是 followUp 旧语义）');
  assert.equal((await request(`/sessions/${busySession}`)).value.pendingMessages, 0, '队列已排空');
  print('GATE-7 busy answer steers into the running turn', {
    receipt: { mode: busyAnswered.value.delivery.mode, queued: busyAnswered.value.delivery.queued, queuedForDelivery: busyAnswered.value.queuedForDelivery, note: busyAnswered.value.delivery.note },
    duringBusy: { isStreaming: duringBusy.value.runtime.isStreaming, pendingMessages: duringBusy.value.pendingMessages },
    queue: { steering: queueDuringBusy.steering, followUp: queueDuringBusy.followUp },
    providerEvidence: { messagesInRun: steeredRequest.messages.length, injectedAt, previousRole: steeredRequest.messages[injectedAt - 1].role, turnAlreadyEnded: steeredRequest.messages.some((message) => message.role === 'assistant' && textOfMessage(message).includes('BUSY_WINDOW_DONE')) },
    landed: busyLanded.length, order: { answerIndex, seenIndex },
  });

  // ── ⑦b 压缩中答题 ⇒ 如实 409，且**一字不写**（会话文件逐字节未变、问题仍在 open）──
  const compactSession = (await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'compact-answer' } })).value.id;
  const compactQ = (await ask(compactSession, { context: CTX, text: '压缩窗口里问的：这条能不能答？' })).value.id;
  assert.equal((await request(`/sessions/${compactSession}/message`, { method: 'POST', body: { text: 'WARMUP_COMPACT' } })).status, 202);
  await waitIdle(compactSession);
  const compactFile = await sessionFileOf(compactSession);
  assert.ok(compactFile, '热身之后会话文件应当存在');
  // 让假 provider 把**下一个**响应挂住 ⇒ 压缩真的开在窗口里（不是说了一句「应该在压」）。
  const hold = provider.holdNext();
  const compactAccepted = await request(`/sessions/${compactSession}/compact`, { method: 'POST', body: {} });
  assert.equal(compactAccepted.status, 202, compactAccepted.raw);
  await poll('compaction request reached the provider (window is really open)', async () => hold, (value) => value.started === true, 20_000);
  assert.equal((await request(`/sessions/${compactSession}`)).value.runtime.isCompacting, true, '压缩中：runtime.isCompacting 必须为真');
  const compactBytesBefore = await readFile(compactFile);
  const answerDuringCompaction = await answer(compactSession, compactQ, '压缩中不许写进去');
  assert.equal(answerDuringCompaction.status, 409, `压缩中答题必须如实 409：${answerDuringCompaction.raw}`);
  assert.equal(answerDuringCompaction.value.error, 'session_compacting');
  const compactBytesAfter = await readFile(compactFile);
  assert.ok(compactBytesBefore.equals(compactBytesAfter), '压缩中那次 409 必须**一字不写**（会话文件逐字节未变）');
  const openDuringCompaction = await request(`/sessions/${compactSession}/questions?status=open`);
  assert.equal(openDuringCompaction.value.questions.length, 1, '那一发 409 之后问题必须仍在 open（没丢）');
  assert.ok(openDuringCompaction.value.questions.some((item) => item.id === compactQ), '且还是原来那条');
  hold.release();
  await waitIdle(compactSession, 60_000);
  const compactedView = await request(`/sessions/${compactSession}/questions?status=open`);
  assert.equal(compactedView.value.questions.length, 1, '压缩结束后问题仍在 open（人还可以再答）');
  print('GATE-7b answer during compaction', {
    status: answerDuringCompaction.status, error: answerDuringCompaction.value.error, message: answerDuringCompaction.value.message,
    fileBytes: { before: compactBytesBefore.length, after: compactBytesAfter.length, identical: compactBytesBefore.equals(compactBytesAfter) },
    stillOpen: compactedView.value.questions.map((item) => item.id),
  });

  // ── ⑦c 忙但**没有活跃回合**（只剩 `admissionPending`）⇒ 如实退成 followUp，不许假装插了话 ──
  //    造法：发一条扩展命令 `/slow-step N`——pi 先派 handler、handler 跑完才 `preflightResult`，
  //    这整个窗口里 `admissionPending` 为真而 `isStreaming` 仍为假（就是业主点名的那一种）。
  const admitSession = (await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'admit-window' } })).value.id;
  const admitQ = (await ask(admitSession, { context: CTX, text: '准入窗口里问的：插话还是排队？' })).value.id;
  assert.equal((await request(`/sessions/${admitSession}/message`, { method: 'POST', body: { text: 'WARMUP_ADMIT' } })).status, 202);
  await waitIdle(admitSession);
  const requestsBeforeAdmit = provider.requests.length;
  const admitEvents = await openSessionEvents(admitSession);
  const slowCommand = request(`/sessions/${admitSession}/message`, { method: 'POST', body: { text: '/slow-step 4000' } });
  // 等到扩展命令的 handler 真的开始了（它自己发的那条 notice 到了）—— 这时 `admissionPending` 必真。
  await poll('extension command entered its handler (admission window is really open)',
    () => admitEvents.seen.find((entry) => entry.name === 'session.notice' && JSON.stringify(entry.data).includes('SLOWSTEP_STARTED')),
    Boolean, 15_000);
  const duringAdmit = await request(`/sessions/${admitSession}`);
  assert.equal(duringAdmit.value.runtime.isStreaming, false, '这道门的**前提**：此刻真的没有活跃回合（isStreaming=false）');
  assert.equal(duringAdmit.value.runtime.isCompacting, false, '也不是压缩中');
  const admitAnswerText = '准入窗口里的回答：先别动。';
  const admitMarker = `${answerMark(admitQ)}${admitAnswerText}`;
  const admitAnswered = await answer(admitSession, admitQ, admitAnswerText);
  assert.equal(admitAnswered.status, 200, `没有活跃回合时不许 409，要如实退成 followUp：${admitAnswered.raw}`);
  assert.equal(admitAnswered.value.delivery.mode, 'followUp', '没有活跃回合 ⇒ 如实报 mode:followUp（不许假装 steer）');
  assert.equal(admitAnswered.value.delivery.queued, true);
  assert.equal(admitAnswered.value.queuedForDelivery, true);
  assert.match(admitAnswered.value.delivery.note, /准入窗口/u, 'note 要如实说清为什么没走 steer');
  const admitQueue = await queueSnapshotOf(admitSession);
  assert.ok(admitQueue.followUp.includes(admitMarker), `必须真进 followUp 队列（实测 ${JSON.stringify(admitQueue)}）`);
  assert.ok(!admitQueue.steering.includes(admitMarker), '不许当成 steering 排队');
  const slowCommandReply = await slowCommand;
  assert.equal(slowCommandReply.status, 202, slowCommandReply.raw);
  const providerRequestsAfterWindow = provider.requests.length;
  assert.equal(providerRequestsAfterWindow, requestsBeforeAdmit, '准入窗口这一发回答**不许**偷偷起一轮（provider 一个新请求都不该收到）');
  await admitEvents.close();
  const admitAfterCommand = await request(`/sessions/${admitSession}`);
  assert.equal(admitAfterCommand.value.runtime.isStreaming, false, '命令跑完后仍然没有活跃回合（它的回答还在排队）');
  assert.equal(admitAfterCommand.value.pendingMessages, 1, '回答仍在那条 followUp 队列里（没丢）');
  // 下一次真跑（人被问住了去发一条）时它才作为 user 消息送达。
  assert.equal((await request(`/sessions/${admitSession}/message`, { method: 'POST', body: { text: 'AFTER_ADMIT' } })).status, 202);
  const admitLanded = await poll('queued answer lands on the next run', () => messagesOf(admitSession), (messages) => messages.some((message) => message.text === admitMarker), 30_000);
  assert.equal(admitLanded.filter((message) => message.text === admitMarker).length, 1, '只许送达 1 次');
  print('GATE-7c answer with no active turn', {
    receipt: { mode: admitAnswered.value.delivery.mode, queued: admitAnswered.value.delivery.queued, queuedForDelivery: admitAnswered.value.queuedForDelivery, note: admitAnswered.value.delivery.note },
    duringWindow: { isStreaming: duringAdmit.value.runtime.isStreaming, isCompacting: duringAdmit.value.runtime.isCompacting, pendingMessages: duringAdmit.value.pendingMessages },
    queue: admitQueue,
    providerRequestsDuringWindow: providerRequestsAfterWindow - requestsBeforeAdmit,
    afterCommand: { isStreaming: admitAfterCommand.value.runtime.isStreaming, pendingMessages: admitAfterCommand.value.pendingMessages },
    landedOnNextRun: admitLanded.filter((message) => message.text === admitMarker).length,
  });

  // ── ⑦d 自动重试的退避窗口：把「`isRetrying` 不是另一条路」量成实测 ──
  //    pi 的退避 sleep 发生在 `_runAgentPrompt` 的 try 块里（读源码得到的预期是 `isRetrying ⇒ isStreaming`）
  //    ⇒ 若真如此，此时答题必走 steer 支（而不是 idle 支的 startPrompt）。这一臂就是那句话的机械凭据。
  const retrySession = (await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'retry-window' } })).value.id;
  const retryQ = (await ask(retrySession, { context: CTX, text: '退避窗口里问的：这时候答会走哪条？' })).value.id;
  assert.equal((await request(`/sessions/${retrySession}/message`, { method: 'POST', body: { text: 'WARMUP_RETRY' } })).status, 202);
  await waitIdle(retrySession);
  const retryRequestStart = provider.requests.length;
  assert.equal((await request(`/sessions/${retrySession}/message`, { method: 'POST', body: { text: 'RETRY_WINDOW 先失败一次' } })).status, 202);
  await poll('pi entered its auto-retry backoff window', () => request(`/sessions/${retrySession}`), (reply) => reply.value?.runtime?.isRetrying === true, 20_000);
  const duringRetry = await request(`/sessions/${retrySession}`);
  assert.equal(duringRetry.value.runtime.isRetrying, true, '本臂的前提：此刻真的在重试退避里');
  assert.equal(duringRetry.value.runtime.isStreaming, true, 'pi 的退避 sleep 在活跃 run 里 ⇒ isStreaming 必须也为真（实测，不是读源码猜）');
  const retryAnswerText = '退避窗口里的回答：继续跑。STEER_PROOF';
  const retryMarker = `${answerMark(retryQ)}${retryAnswerText}`;
  const retryAnswered = await answer(retrySession, retryQ, retryAnswerText);
  assert.equal(retryAnswered.status, 200, retryAnswered.raw);
  assert.equal(retryAnswered.value.delivery.mode, 'steer', `重试窗口也算活跃回合 ⇒ 必须 steer（实测 ${retryAnswered.raw}）`);
  const retryQueue = await queueSnapshotOf(retrySession);
  assert.ok(retryQueue.steering.includes(retryMarker), `必须进 steering 队列（实测 ${JSON.stringify(retryQueue)}）`);
  await waitIdle(retrySession, 60_000);
  // 恢复后的那一跳里真的看见了它（退避前那条 error 消息已被 pi 从 state 里拿掉 ⇒ 重试请求的最后一条就是它）。
  const retryHop = (await poll('answer seen after the retry recovered', () => provider.requests.slice(retryRequestStart),
    (requests) => requests.some((request) => JSON.stringify(request.messages).includes(retryMarker)), 30_000))
    .find((request) => JSON.stringify(request.messages).includes(retryMarker));
  assert.ok(retryHop, '恢复后的那一跳必须带上那条回答');
  print('GATE-7d answer during the auto-retry backoff', {
    duringRetry: { isRetrying: duringRetry.value.runtime.isRetrying, isStreaming: duringRetry.value.runtime.isStreaming },
    receipt: { mode: retryAnswered.value.delivery.mode, queued: retryAnswered.value.delivery.queued },
    queue: retryQueue,
    providerRequestsInWindow: provider.requests.slice(retryRequestStart).length,
    landedOnce: (await messagesOf(retrySession)).filter((message) => message.text === retryMarker).length,
  });

  // ── ⑧ 插件三工具（模型真调用 ⇒ 真的落到服务端）──
  const toolSession = (await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'tools' } })).value.id;
  const toolQ = (await ask(toolSession, { context: CTX, text: '工具链要关掉的那条？' })).value.id;
  await waitIdle(toolSession);
  assert.equal((await request(`/sessions/${toolSession}/message`, { method: 'POST', body: { text: 'TOOL_ASK 请记一条' } })).status, 202);
  await poll('question_ask tool ran', () => messagesOf(toolSession), (messages) => messages.some((message) => message.text === 'ASK_TOOL_OK'));
  const toolAsked = (await request(`/sessions/${toolSession}/questions?status=open`)).value.questions.find((item) => item.text === '工具问：是否继续？');
  assert.ok(toolAsked, `question_ask 必须真的在会话文件里开出一条（实测 ${JSON.stringify((await request(`/sessions/${toolSession}/questions?status=all`)).value.questions.map((item) => item.text))}）`);
  assert.deepEqual(toolAsked.options, ['继续（会白跑一轮）', '停（丢掉 3 条未提交改动）'], '候选要自带含义与代价（工具契约的要求）');
  assert.equal(toolAsked.context, TOOL_CTX, 'question_ask 必须把 context 逐字送进服务端');
  assert.equal(toolAsked.priority, 'high');
  const toolFileEntries = await questionEntries(toolSession);
  assert.equal(toolFileEntries.filter((data) => data.id === toolAsked.id && data.op === 'ask').length, 1, 'question_ask 只落 1 条 ask');

  assert.equal((await request(`/sessions/${toolSession}/message`, { method: 'POST', body: { text: `TOOL_LIST ${toolAsked.id} 看看清单` } })).status, 202);
  const listRound = await poll('question_list tool ran', async () => (await messagesOf(toolSession)).find((message) => message.role === 'assistant' && String(message.text).startsWith('LIST_TOOL_')) ?? null, (found) => Boolean(found));
  assert.equal(listRound.text, 'LIST_TOOL_OK', `question_list 回执：${listRound.text}`);

  assert.equal((await request(`/sessions/${toolSession}/message`, { method: 'POST', body: { text: `TOOL_CLOSE ${toolAsked.id} 关掉它` } })).status, 202);
  const closeRound = await poll('question_close tool ran', async () => (await messagesOf(toolSession)).find((message) => message.role === 'assistant' && String(message.text).startsWith('CLOSE_TOOL_')) ?? null, (found) => Boolean(found));
  const beforeCloseAssert = await request(`/sessions/${toolSession}/questions?status=all`);
  print('GATE-8 close round raw', { assistant: closeRound.text, questions: beforeCloseAssert.value.questions.map((item) => ({ id: item.id, status: item.status, text: item.text, closedBy: item.closedBy, closeReason: item.closeReason })), file: await questionEntries(toolSession) });
  assert.equal(closeRound.text, 'CLOSE_TOOL_OK', `question_close 回执：${closeRound.text}`);
  const toolClosedItem = beforeCloseAssert.value.questions.find((item) => item.id === toolAsked.id);
  assert.equal(toolClosedItem.status, 'closed');
  assert.equal(toolClosedItem.closedBy, 'agent');
  assert.equal(toolClosedItem.closeReason, '工具判定已过期');
  const toolAskEntry = (await questionEntries(toolSession)).find((data) => data.op === 'close' && data.id === toolQ);
  assert.equal(toolAskEntry, undefined, '没被工具碰过的问题不许被关闭');
  print('GATE-8 plugin tools', { asked: { id: toolAsked.id, options: toolAsked.options, priority: toolAsked.priority, fileAskEntries: 1 }, list: 'LIST_TOOL_OK', close: { status: toolClosedItem.status, by: toolClosedItem.closedBy, reason: toolClosedItem.closeReason } });

  // ── ⑧b 插件侧：`question_ask` 带 `questionId` ⇒ 走 **update** 分支（就地改那条，不新开）──
  // 工具轨迹（模型真调工具、第二跳把它看到的回执编进回复）＋ 文件两侧对照。
  // 这是业主 2026-09-21 拍板的能力：“让 ai 可以更新对话”。
  const toolOpenBefore = await request(`/sessions/${toolSession}/questions?status=open`);
  const toolQBefore = toolOpenBefore.value.questions.find((item) => item.id === toolQ);
  assert.ok(toolQBefore, `更新分支的前置：${toolQ} 应当仍是未答（实测 ${toolOpenBefore.raw}）`);
  assert.equal((await request(`/sessions/${toolSession}/message`, { method: 'POST', body: { text: `TOOL_UPDATE ${toolQ} 就地改一下` } })).status, 202);
  const updToolRound = await poll('question_ask(questionId) update branch ran', async () => (await messagesOf(toolSession)).find((message) => message.role === 'assistant' && String(message.text).startsWith('UPDATE_TOOL_')) ?? null, (found) => Boolean(found));
  assert.equal(updToolRound.text, 'UPDATE_TOOL_OK', `question_ask 更新分支回执：${updToolRound.text}`);
  const toolUpdated = (await request(`/sessions/${toolSession}/questions?status=all`)).value.questions.find((item) => item.id === toolQ);
  assert.equal(toolUpdated.text, '工具更新：改过的题面？', '更新后的题面必须逐字落上');
  assert.equal(toolUpdated.context, TOOL_CTX, '更新后的 context 必须逐字落上');
  assert.deepEqual(toolUpdated.options, ['改甲', '改乙'], '更新后的候选逐字落上');
  assert.equal(toolUpdated.priority, 'high');
  assert.equal(typeof toolUpdated.updatedAt, 'number');
  assert.equal(toolUpdated.askedAt, toolQBefore.askedAt, '更新不许动 askedAt');
  assert.equal(toolUpdated.entryCount, 2, 'question_ask 更新分支只追加 1 条 update（共 2 条）');
  assert.deepEqual((await questionEntries(toolSession)).filter((data) => data.id === toolQ).map((data) => data.op), ['ask', 'update']);
  // 计数不变：更新不是新问题。
  const toolOpenAfter = await request(`/sessions/${toolSession}/questions?status=open`);
  assert.deepEqual(toolOpenAfter.value.counts, toolOpenBefore.value.counts, `question_ask 更新后未答数必须不变（${JSON.stringify(toolOpenAfter.value.counts)}）`);
  print('GATE-8b question_ask update branch', { id: toolQ, round: updToolRound.text, updatedText: toolUpdated.text, contextVerbatim: toolUpdated.context === TOOL_CTX, updatedAt: toolUpdated.updatedAt, askedAtKept: toolUpdated.askedAt === toolQBefore.askedAt, entryOps: (await questionEntries(toolSession)).filter((data) => data.id === toolQ).map((data) => data.op), countsUnchanged: toolOpenAfter.value.counts });

  // ── ⑪（服务端）工具契约：问题必须自带上下文事实（context）───────────────────────────────
  // 业主 dogfood 后拍板：问题页上不许只剩「一句话 + 两个选项」⇒ 根因在工具契约，服务端是**唯一**
  // 写入口（插件与 curl 都走它），所以强制放在 ask 这条路上。契约：`docs/manager-toolkit-plan.md` §2/§3。
  const ctxSession = (await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'context' } })).value.id;
  assert.equal((await request(`/sessions/${ctxSession}/message`, { method: 'POST', body: { text: 'WARMUP_CTX' } })).status, 202);
  await waitIdle(ctxSession);
  const entriesBefore = (await questionEntries(ctxSession)).length;

  // ① 缺 context ⇒ 400 question_needs_context；文件里**没有**新增条目（不许半写）。
  const missing = await ask(ctxSession, { text: '没有背景的问题' });
  assert.equal(missing.status, 400, `缺 context 必须 400：${missing.raw}`);
  assert.equal(missing.value.error, 'question_needs_context');
  assert.match(missing.value.message, /context/u, `报错必须点名缺什么：${missing.value.message}`);
  assert.match(missing.value.message, /至少 40 个/u, `报错必须说清阈值（可执行）：${missing.value.message}`);
  assert.match(missing.value.message, /合格示例/u, `报错必须自带合格示例：${missing.value.message}`);
  assert.equal((await questionEntries(ctxSession)).length, entriesBefore, '缺 context 时一个字都不许写（不许半写）');

  // ② 过短（< 40 字）⇒ 同样 400。
  const tooShort = await ask(ctxSession, { context: '太短了', text: '背景太短的问题' });
  assert.equal(tooShort.status, 400, tooShort.raw);
  assert.equal(tooShort.value.error, 'question_needs_context');
  assert.equal((await questionEntries(ctxSession)).length, entriesBefore, '过短时也不许写');

  // ③ 合格 ask（多行原样）⇒ 201；条目与 GET /questions 都**逐字**带出。
  const goodContext = '第一行：C: 只剩 515 GB，pagefile.sys 42 GB、hiberfil.sys 26 GB 都还没动。\n第二行：A 组纯日志 202.6 GB 零风险；B/C 中的日志部分约 358.6 GB；A+B+C 608 GB 风险高。\n第三行：当前主线 = 先把零风险的清掉。';
  const good = await ask(ctxSession, { context: goodContext, text: '按哪一档清？', options: ['只删 A 组（零风险）', '连 B/C 的日志一起（≈358.6 GB）'] });
  assert.equal(good.status, 201, good.raw);
  const goodId = good.value.id;
  assert.equal(good.value.question.context, goodContext, 'ask 回执里的 context 必须逐字等于提交的原文');
  const [goodEntry] = (await questionEntries(ctxSession)).filter((data) => data.id === goodId && data.op === 'ask');
  assert.equal(goodEntry.context, goodContext, '会话文件里的 context 必须逐字等于提交的原文（含换行）');
  const listCtx = await request(`/sessions/${ctxSession}/questions?status=all`);
  assert.equal(listCtx.status, 200, listCtx.raw);
  assert.equal(listCtx.value.questions.find((item) => item.id === goodId).context, goodContext, 'GET /questions 必须逐字带出 context');

  // ④ 老条目（没有 context）⇒ 字段如实给 null（append-only，不回填、不编、不报错）。
  const oldView = await request(`/sessions/${readonlyId}/questions?status=all`);
  assert.equal(oldView.status, 200, oldView.raw);
  assert.equal(oldView.value.questions[0].context, null, '老条目没有 context 时必须如实给 null（append-only，不回填、不编）');

  // ⑤ answer / close **不**因缺 context 被拦（只有 ask 强制）。
  const closeCtx = await close(ctxSession, goodId, '门里关掉它');
  assert.equal(closeCtx.status, 200, `close 不许被 context 拦下：${closeCtx.raw}`);
  assert.equal(closeCtx.value.question.status, 'closed');
  const secondCtx = await ask(ctxSession, { context: goodContext, text: '第二条要答的' });
  assert.equal(secondCtx.status, 201, secondCtx.raw);
  const answerCtx = await answer(ctxSession, secondCtx.value.id, '门里答掉它');
  assert.equal(answerCtx.status, 200, `answer 不许被 context 拦下：${answerCtx.raw}`);
  assert.equal(answerCtx.value.question.status, 'answered');
  await waitIdle(ctxSession);
  const ctxEntriesAfter = await questionEntries(ctxSession);
  print('GATE-11 question context contract (server)', {
    missing: { status: missing.status, error: missing.value.error, messageHead: String(missing.value.message).slice(0, 160) },
    tooShort: { status: tooShort.status, error: tooShort.value.error },
    good: { id: goodId, status: good.status, chars: goodContext.length, fileVerbatim: goodEntry.context === goodContext, wireVerbatim: listCtx.value.questions.find((item) => item.id === goodId).context === goodContext },
    oldEntry: { id: 'q-00000001', context: oldView.value.questions[0].context },
    answerCloseUnaffected: { close: closeCtx.status, answer: answerCtx.status },
    fileEntries: { before: entriesBefore, after: ctxEntriesAfter.length, ops: ctxEntriesAfter.map((data) => `${data.id}:${data.op}`) },
  });

  // ── ⑪（插件侧）契约违反是**可纠正的**：模型先漏 context（过短）⇒ 400 ⇒ 插件招纠正性工具错误
  //    ⇒ 模型带着 context 重问 ⇒ 条目里逐字落上。这条臂证明的是「纠正回路真的跑通了」，
  //    不只是断言一个字符串。──
  assert.equal((await request(`/sessions/${toolSession}/message`, { method: 'POST', body: { text: 'TOOL_ASK_NOCONTEXT 先漏一次背景' } })).status, 202);
  const ctxRound = await poll('question_ask corrective loop', async () => (await messagesOf(toolSession)).find((message) => message.role === 'assistant' && String(message.text).startsWith('ASKCTX_TOOL_')) ?? null, (found) => Boolean(found));
  assert.equal(ctxRound.text, 'ASKCTX_TOOL_OK', `纠正性错误没有把模型带回正道：${ctxRound.text}`);
  const ctxQuestion = (await request(`/sessions/${toolSession}/questions?status=all`)).value.questions.find((item) => item.text === '工具先漏了背景：是否继续？');
  assert.ok(ctxQuestion, '重问后应当真的开出一条');
  assert.equal(ctxQuestion.context, TOOL_CTX, '重问带上的 context 必须逐字落进条目');
  const ctxAskEntries = (await questionEntries(toolSession)).filter((data) => data.id === ctxQuestion.id && data.op === 'ask');
  assert.equal(ctxAskEntries.length, 1, '过短那一次一个字都不许落（只应有重问落下的 1 条）');
  print('GATE-11 (plugin) corrective question_ask', { round: ctxRound.text, id: ctxQuestion.id, contextVerbatim: ctxQuestion.context === TOOL_CTX, fileAskEntries: ctxAskEntries.length });

  // ── ⑫ 按 id 更新一条未答问题（`op:'update'`；业主 2026-09-21 拍板：“让 ai 可以更新对话”）──
  // 契约：`docs/manager-toolkit-plan.md` §1/§2/§3/§9；与 answer/close 同构（append-only + 最后一条 op 定现状）。
  // 取代被业主否掉的 `dedupeKey`（拿归一化文本猜是不是同一件事）—— 更新是直说。
  const updSession = (await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'update' } })).value.id;
  assert.equal((await request(`/sessions/${updSession}/message`, { method: 'POST', body: { text: 'WARMUP_UPDATE' } })).status, 202);
  await waitIdle(updSession);
  const updSeed = await ask(updSession, { context: CTX, text: '更新门：初始题面？', options: ['甲', '乙'], priority: 'normal' });
  assert.equal(updSeed.status, 201, updSeed.raw);
  const updId = updSeed.value.id;
  const seedQuestion = updSeed.value.question;
  const openBeforeUpdate = await request(`/sessions/${updSession}/questions?status=open`);
  assert.deepEqual(openBeforeUpdate.value.counts, { open: 1, answered: 0, closed: 0, concluded: 0, total: 1 }, openBeforeUpdate.raw);

  // ⑦ SSE：更新后要在该会话上发既有那条 `session.question`（op:'update'）—— 先开流，再更新。
  const updEvents = await openSessionEvents(updSession);
  await poll('session.snapshot on the update SSE', async () => updEvents.seen.find((event) => event.name === 'session.snapshot') ?? null, Boolean);

  const NEW_CTX = '更新门的新背景：subagent 回来了，494 条里 12 条已确认重复、目标目录只剩 515 GB；候选 A 只删纯日志（202.6 GB 零风险），B 连缓存一起（≈358.6 GB）风险高。当前主线：先把重复的清掉。';
  const upd = await update(updSession, updId, { text: '更新门：改过的题面？', context: NEW_CTX, options: ['甲改', '乙改'], priority: 'high' });
  assert.equal(upd.status, 200, upd.raw);
  assert.equal(upd.value.ok, true);
  assert.equal(upd.value.id, updId, '更新不许换 id（不是新开）');
  assert.equal(upd.value.updated, true);
  assert.deepEqual(upd.value.changed, ['text', 'context', 'options', 'priority'], `changed 要逐字段报（实测 ${JSON.stringify(upd.value.changed)}）`);
  // ① 现状按“最后一条 op”合成（text/context/options/priority）
  assert.equal(upd.value.question.text, '更新门：改过的题面？');
  assert.equal(upd.value.question.context, NEW_CTX);
  assert.deepEqual(upd.value.question.options, ['甲改', '乙改']);
  assert.equal(upd.value.question.priority, 'high');
  assert.equal(upd.value.question.status, 'open', '更新不是新状态：仍是未答');
  // ② askedAt/askedBy 不变 + updatedAt/updatedBy 出现
  assert.equal(upd.value.question.askedAt, seedQuestion.askedAt, '更新不许动 askedAt');
  assert.equal(upd.value.question.askedBy, seedQuestion.askedBy, '更新不许动 askedBy');
  assert.equal(typeof upd.value.question.updatedAt, 'number', '更新要另记 updatedAt');
  assert.equal(upd.value.question.updatedBy, 'agent');
  assert.equal(upd.value.question.entryCount, 2, 'ask + update = 2 条（append-only）');

  // 文件条目逐字（append-only：历史那条 ask 一个字都不改，只多一条 update）
  const updFileEntries = (await questionEntries(updSession)).filter((data) => data.id === updId);
  assert.deepEqual(updFileEntries.map((data) => data.op), ['ask', 'update']);
  assert.deepEqual(Object.keys(updFileEntries[1]).sort(), ['at', 'by', 'context', 'id', 'op', 'options', 'priority', 'text'], `update 条目字段（实测 ${JSON.stringify(updFileEntries[1])}）`);
  assert.equal(updFileEntries[1].context, NEW_CTX, 'update 条目里的 context 逐字等于提交的原文');
  assert.equal(updFileEntries[0].text, '更新门：初始题面？', '历史那条 ask 一个字都没被改（不许原地写）');
  assert.equal(updFileEntries[0].context, CTX, '历史那条 ask 的 context 也没被改');

  // ③ 计数不变（更新不是新问题 ⇒ 未答数不许 +1）
  const openAfterUpdate = await request(`/sessions/${updSession}/questions?status=open`);
  assert.deepEqual(openAfterUpdate.value.counts, openBeforeUpdate.value.counts, `更新后 counts 必须不变（${JSON.stringify(openAfterUpdate.value.counts)}）`);
  assert.deepEqual(openAfterUpdate.value.questions.map((item) => item.id), [updId]);
  // ⑥ 两查都对（更新过的未答条目只在 open 侧，answered 侧空）
  const answeredAfterUpdate = await request(`/sessions/${updSession}/questions?status=answered`);
  assert.deepEqual(answeredAfterUpdate.value.questions, [], '更新过的未答条目不许混进 answered');
  assert.equal(answeredAfterUpdate.value.counts.open, 1);

  // ⑤ 幂等：同 qid 重复一次**内容相同**的更新 ⇒ 不报错、不重复记。
  const dupUpdate = await update(updSession, updId, { text: '更新门：改过的题面？', context: NEW_CTX, options: ['甲改', '乙改'], priority: 'high' });
  assert.equal(dupUpdate.status, 200, dupUpdate.raw);
  assert.equal(dupUpdate.value.updated, false, '内容相同 ⇒ updated:false');
  assert.deepEqual(dupUpdate.value.changed, []);
  assert.equal(dupUpdate.value.question.entryCount, 2, '幂等：文件里该 id 仍是 2 条，没有多记');
  assert.deepEqual((await questionEntries(updSession)).filter((data) => data.id === updId).map((data) => data.op), ['ask', 'update']);

  // 部分更新：只改 priority（没给的字段必须保持原样 —— 更新不是整题重写）
  const partial = await update(updSession, updId, { priority: 'normal' });
  assert.equal(partial.status, 200, partial.raw);
  assert.deepEqual(partial.value.changed, ['priority'], `部分更新只报改了的那个（实测 ${JSON.stringify(partial.value.changed)}）`);
  assert.equal(partial.value.question.priority, 'normal');
  assert.equal(partial.value.question.text, '更新门：改过的题面？', '没给的字段必须保持原样');
  assert.equal(partial.value.question.context, NEW_CTX);
  assert.equal(partial.value.question.updatedBy, 'agent');

  // ⑦ SSE 真发了（既有那条 session.question；前端照刷新，计数不变）
  const updEvent = await poll('session.question (update) on the session SSE', async () => updEvents.seen.find((event) => event.name === 'session.question' && event.data.op === 'update' && event.data.id === updId) ?? null, Boolean);
  assert.equal(updEvent.data.text, '更新门：改过的题面？');
  assert.equal(updEvent.data.by, 'agent');
  await updEvents.close();

  // ④ 只允许更新未答：已答/已关 ⇒ 拒绝，且如实说“要新开一条”（不许静默改写用户已经答过的东西）
  const updAnswerText = '更新门的回答：按甲改走。';
  assert.equal((await answer(updSession, updId, updAnswerText)).status, 200);
  await waitIdle(updSession);
  const updAnswered = await update(updSession, updId, { text: '太晚了，想改也改不了' });
  assert.equal(updAnswered.status, 409, `对已答的问题更新必须被拒：${updAnswered.raw}`);
  assert.equal(updAnswered.value.error, 'question_not_open');
  assert.equal(updAnswered.value.details.status, 'answered');
  assert.match(String(updAnswered.value.message), /新开/u, `拒绝必须如实说清“要新开一条”：${updAnswered.value.message}`);
  const closedSeed = await ask(updSession, { context: CTX, text: '更新门第二条：先关掉再试' });
  assert.equal(closedSeed.status, 201, closedSeed.raw);
  const closedId = closedSeed.value.id;
  assert.equal((await close(updSession, closedId, '门里先关掉', 'agent')).status, 200);
  const updClosed = await update(updSession, closedId, { priority: 'high' });
  assert.equal(updClosed.status, 409, `对已关的问题更新必须被拒：${updClosed.raw}`);
  assert.equal(updClosed.value.error, 'question_not_open');
  assert.equal(updClosed.value.details.status, 'closed');
  // 被拒时**一字不写**：文件里只有 updId 那两条（完整更新 + 部分更新），closedId 一条 update 都没有
  const rejectedUpdateEntries = (await questionEntries(updSession)).filter((data) => data.op === 'update');
  assert.deepEqual(rejectedUpdateEntries.map((data) => data.id), [updId, updId], `被拒的更新不许落条目（实测 ${JSON.stringify(rejectedUpdateEntries)}）`);
  assert.ok(!rejectedUpdateEntries.some((data) => data.id === closedId), '对已关那条的更新一个字都不许落');
  // ⑥ 两查在新状态下也对；answered 侧也要带 updatedAt/askedAt 的留痕
  const updOpenFinal = await request(`/sessions/${updSession}/questions?status=open`);
  assert.deepEqual(updOpenFinal.value.counts, { open: 0, answered: 1, closed: 1, concluded: 2, total: 2 }, updOpenFinal.raw);
  const updAnsweredFinal = await request(`/sessions/${updSession}/questions?status=answered`);
  assert.deepEqual(updAnsweredFinal.value.questions.map((item) => `${item.id}:${item.status}`).sort(), [`${updId}:answered`, `${closedId}:closed`].sort());
  const updAnsweredWire = updAnsweredFinal.value.questions.find((item) => item.id === updId);
  assert.equal(updAnsweredWire.updatedAt, partial.value.question.updatedAt, 'answered 那侧也要带 updatedAt 留痕（最后一条 update 的时刻）');
  assert.equal(updAnsweredWire.askedAt, seedQuestion.askedAt, 'answered 那侧的 askedAt 仍是问的时刻');

  // 坏输入如实 4xx（不静默）：不存在 / 非规范 id / 一个字段都不给 / 过短 context / 非法 options·priority
  // （字段校验在状态判定之前 ⇒ 这几条与那条问题现在的状态无关）
  const updUnknown = await update(updSession, 'q-deadbeef', { text: 'x' });
  assert.equal(updUnknown.status, 404); assert.equal(updUnknown.value.error, 'question_not_found');
  const updBadId = await update(updSession, 'not-an-id', { text: 'x' });
  assert.equal(updBadId.status, 400); assert.equal(updBadId.value.error, 'invalid_question_id');
  const updEmpty = await update(updSession, updId, {});
  assert.equal(updEmpty.status, 400); assert.equal(updEmpty.value.error, 'no_update');
  const updBadCtx = await update(updSession, updId, { context: '太短' });
  assert.equal(updBadCtx.status, 400); assert.equal(updBadCtx.value.error, 'question_needs_context');
  const updBadOptions = await update(updSession, updId, { options: ['ok', 3] });
  assert.equal(updBadOptions.status, 400); assert.equal(updBadOptions.value.error, 'invalid_options');
  const updBadPriority = await update(updSession, updId, { priority: 'urgent' });
  assert.equal(updBadPriority.status, 400); assert.equal(updBadPriority.value.error, 'invalid_priority');
  print('GATE-12 update by id', {
    id: updId,
    updated: upd.value.updated,
    changed: upd.value.changed,
    partialChanged: partial.value.changed,
    askedAtKept: upd.value.question.askedAt === seedQuestion.askedAt,
    updatedAt: upd.value.question.updatedAt,
    countsUnchanged: openAfterUpdate.value.counts,
    idempotentEntryCount: dupUpdate.value.question.entryCount,
    answeredRejected: { status: updAnswered.status, error: updAnswered.value.error, message: updAnswered.value.message },
    closedRejected: { status: updClosed.status, error: updClosed.value.error },
    sseOp: updEvent.data.op,
    bad: { unknown: updUnknown.value.error, badId: updBadId.value.error, empty: updEmpty.value.error, ctx: updBadCtx.value.error, options: updBadOptions.value.error, priority: updBadPriority.value.error },
  });

  // ── ⑩ 契约前提的**决定性**测定：`/sessions/{id}/questions` 到底是不是 owner 路由？──
  // 方案 §3（e3f6cef）当年写的前提是「`/sessions/{id}/{一层动作}` 匹配得上宿主 `SESSION_PATH` ⇒ 天然 owner 路由」。
  // 那时 **不成立**：`questions` 不在那串**枚举动作名**里 ⇒ 这条路径落末尾“兜底 proxy 到 current worker”。
  // 2026-09-20 那个词（`|seen|draft` → `|seen|draft|questions`）已落 trunk ⇒ 现在**成立**。两半都测：
  //   (a) **静态**：把宿主那一行正则（从 base.mjs 原文里取出来）拿 `/title`（在枚举里）与 `/questions`
  //       （现在也在枚举里）两个 URL 各试一次 —— 这一条无歧义、不受任何竞态影响；
  //   (b) **动态**：把会话在 g1 上**忙住**（忙的会话不会被 draining 逐出）→ reload（`void drainWorker`，
  //       响应立即返回）→ 先 `/title`（在枚举里）再 `/questions`，用 `/host` 的 `hot`/`sessions` 看
  //       哪个 worker 真的开了 runtime。加词之后**两发都该由 owner（g1）服务**、g2 `hot` 保持 0。
  // 加词**前**那两半的对照实测（同一沙箱、两个宿主副本只差那一个词）在 `npm run test:hostpath` 的
  // `--phase session-path` 里（旧模式=两个 writer / 新模式=owner 服务），逐字原始输出见
  // `docs/history/host-session-path-2026-09-20.md`。
  const hostSource = await readFile(path.join(ROOT, 'server', 'base.mjs'), 'utf8');
  const sessionPathLine = hostSource.split('\n').find((line) => line.includes('const SESSION_PATH'));
  assert.ok(sessionPathLine, 'base.mjs 里应当有 SESSION_PATH');
  const sessionPathLiteral = /const SESSION_PATH = (\/.*\/);/u.exec(sessionPathLine)?.[1];
  assert.ok(sessionPathLiteral, `SESSION_PATH 应当是字面量正则：${sessionPathLine}`);
  const hostSessionPath = eval(sessionPathLiteral); // 门自己的沙箱：eval 的就是宿主那一行的原文
  const matchesHostSessionPath = (action) => Boolean(hostSessionPath.exec(`/sessions/11111111-1111-4111-8111-111111111111/${action}`));
  const staticMatch = { title: matchesHostSessionPath('title'), messages: matchesHostSessionPath('messages'), questions: matchesHostSessionPath('questions') };
  assert.equal(staticMatch.title, true, '宿主 SESSION_PATH 应当匹配 /title（否则门的取正则方式错了）');
  // 机械护栏（**已翻面**，2026-09-20 宿主批那个词落地后）：断言 `questions` **在**枚举里。
  // 这就是「写 owner 唯一」在这条路由上成立的前提；谁把它撤了，这道断言与下面 (b) 的动态断言一起变红，
  // 逼人显式改回契约与文档（而不是静默地退回“兜底 proxy 到 current worker”）。
  // ⚠️ 宿主只在**启动时**读这个文件 ⇒ 仓里改了不等于活宿主生效（见 docs/handoff.md 的 Q-10 段）。
  assert.equal(staticMatch.questions, true, `那个词必须在 SESSION_PATH 枚举里（实测 ${JSON.stringify(staticMatch)}）；活宿主仍跑着旧快照 = 预期，但要重启后才生效`);

  const routeSession = (await request('/sessions', { method: 'POST', body: { cwd: CWD, name: 'route-probe' } })).value.id;
  assert.equal((await request(`/sessions/${routeSession}/message`, { method: 'POST', body: { text: 'BUSY_WINDOW:10 route probe' } })).status, 202);
  const holdersOf = (host) => host.workers.map((worker) => ({ generationId: worker.generationId, state: worker.state, hot: worker.hot, owns: (worker.sessions || []).includes(routeSession) }));
  const hostBeforeReload = await poll('route probe session is hot and busy in g1', () => request('/host'), (reply) => {
    const worker = reply.value?.workers?.find((entry) => entry.generationId === reply.value.currentGenerationId);
    return worker && (worker.sessions || []).includes(routeSession) && reply.value.workerTotals?.active >= 1 ? reply : null;
  });
  const g1 = hostBeforeReload.value.currentGenerationId;
  const beforeReload = holdersOf(hostBeforeReload.value);
  const reload = await request('/reload-code', { method: 'POST' });
  assert.equal(reload.status, 200, reload.raw);
  const hostAfterReload = await request('/host');
  const g2 = hostAfterReload.value.currentGenerationId;
  assert.notEqual(g2, g1, `reload 必须换一代际：${JSON.stringify({ g1, g2 })}`);
  const afterReload = holdersOf(hostAfterReload.value);
  // 忙着的会话不会被 draining 代逐出 ⇒ owner 映射应该还在 g1 上。
  const ownerStillG1 = afterReload.find((worker) => worker.generationId === g1)?.owns === true;
  const titleProbe = await request(`/sessions/${routeSession}/title`, { method: 'POST', body: { title: 'route-probe-title' } });
  const afterTitle = holdersOf((await request('/host')).value);
  const askProbe = await ask(routeSession, { context: CTX, text: 'ROUTE_PROBE：draining 窗口的一条' });
  const afterQuestionAsk = holdersOf((await request('/host')).value);
  assert.equal(reload.status, 200, reload.raw);
  // (b) 动态断言（那个词落地后）：draining 窗口里的 `/questions` 必须落回 owner(g1)，不许冷开 g2。
  const afterTitleG1Owns = afterTitle.find((worker) => worker.generationId === g1)?.owns === true;
  const afterTitleG2Owns = afterTitle.find((worker) => worker.generationId === g2)?.owns === true;
  const afterAskG1Owns = afterQuestionAsk.find((worker) => worker.generationId === g1)?.owns === true;
  const afterAskG2Owns = afterQuestionAsk.find((worker) => worker.generationId === g2)?.owns === true;
  const afterTitleG2Hot = afterTitle.find((worker) => worker.generationId === g2)?.hot ?? null;
  const afterAskG2Hot = afterQuestionAsk.find((worker) => worker.generationId === g2)?.hot ?? null;
  assert.equal(askProbe.status, 201, `draining 窗口里的 ask 应当 201（由 owner 服务）：${askProbe.raw}`);
  assert.equal(afterTitleG1Owns, true, `对照臂：/title 在 draining 窗口里应由 owner(g1) 服务：${JSON.stringify({ afterTitle })}`);
  assert.equal(afterTitleG2Owns, false, `/title 不许让 current(g2) 接管 owner 映射：${JSON.stringify({ afterTitle })}`);
  assert.equal(afterAskG1Owns, true, `/questions 必须仍由 owner(g1) 服务：${JSON.stringify({ afterQuestionAsk })}`);
  assert.equal(afterAskG2Owns, false, `/questions 不许让 current(g2) 接管 owner 映射（那会冷开第二个 runtime）：${JSON.stringify({ afterQuestionAsk })}`);
  assert.equal(afterAskG2Hot, 0, `current(g2) 的 hot 必须保持 0（第二个 runtime 没开），实测 ${afterAskG2Hot}（/title 后为 ${afterTitleG2Hot}）`);
  print('GATE-10 (probe) owner routing for /questions', {
    staticSessionPathMatch: staticMatch,
    staticSessionPathLine: sessionPathLine.trim(),
    g1,
    g2,
    ownerStillG1AfterReload: ownerStillG1,
    beforeReload,
    afterReload,
    titleProbe: { status: titleProbe.status, afterTitle },
    questionProbe: { status: askProbe.status, afterQuestionAsk },
    titlePathOppenedRuntimeInCurrentWorker: afterTitleG2Owns,
    questionPathOpenedRuntimeInCurrentWorker: afterAskG2Owns,
  });
  await waitIdle(routeSession, 60_000);

  print('RESULT', 'manager toolkit P0 PASS (dedupe / two-way lookup / answer-as-message / close trace / non-blocking / readonly / busy-answer-steers / compaction-409-nothing-written / no-active-turn-followUp / plugin tools / session.question SSE / ask-context contract / update-by-id / questions-in-SESSION_PATH owner routing)');
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
