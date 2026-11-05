#!/usr/bin/env node
// test/suggestions.mjs —— 「对话内的推荐回复」（输入框上方那一排模型建议）的门。
//
// 业主拍板的口径（逐字，别再改）：
//   · 机制 = **每轮另起一次模型调用**生成候选（不是复用未答问题的选项、不是工具调用）；
//   · **不阻塞**：主回合该流式照流式，生成在**后台异步**跑，**可用了才出现**；
//   · **点击 = 直接发送**（走与打字**完全同一条**投递路：忙 ⇒ steer、空闲 ⇒ 普通消息）；
//   · 一排**最多 3 颗**；模型觉得没意义可以 **0 颗**（不许逼它凑数）。
//
// 这道门分三块，同一份门代码在**真代码**上必须全绿、在**突变副本**上必须红（A/B 红绿）：
//
//   ① 服务端臂（真 A（`server/base.mjs`）+ 假 provider + 原始 SSE 帧）：
//      S_frame       回合落定 ⇒ 另起一次模型调用 ⇒ `session.suggestions` 帧（messageId + 校验后的 items）
//      S_input       旁路那次调用不带工具、喂的是最近几条消息的文本（不进对话）
//      S_not_blocking 主回合的收尾帧按**事件序号**先于候选那帧（结构性判据，不是时间阈值）
//      S_not_blocking_scaling 主回合耗时**不随**旁路调用的时延增长（provider 时延 200ms vs 1500ms 两档对比）
//      S_before      候选到达**之前**那一版正文里没有 `suggestions` 字段（字段真的来自候选那一行）
//      S_persisted   同一份候选落成**那条助手消息的可选字段**（`/messages` 读得到）
//      S_not_in_body 候选**不进对话正文**（`text`/`parts` 里一个字都没有）
//      S_cache       候选落盘**不动会话文件** ⇒ 候选之前存的那份响应体不许再被命中
//                    （这正是「刷新后那排还在不在」的机器版）
//      S_validated   非 JSON / 过长 / 空串 / 非字符串 / 超 3 条 ⇒ **校验后的内容**才上屏
//      S_empty       模型给空数组 ⇒ 不落盘、不发帧、字段也不在（不逼它凑数）
//      S_notjson     整段不是 JSON ⇒ 一条都不上屏（安静放弃）
//      S_timeout     模型挂着不回 ⇒ 到点安静放弃（不出那排、不造假、只记一行日志）
//      S_stale       新一轮先开始 ⇒ 上一轮的结果被丢弃（不发帧、不落盘）
//      S_switch_off  关掉开关 ⇒ **一次模型调用都不发**（断言 provider 收到的建议请求数 = 0）
//      S_log         上面每一种放弃/校验/开关都留了一行日志（不静默）
//   ② 前端臂（真 Chromium + 假 API，`test/ui-harness.mjs`）：
//      U_no_event      没有事件 ⇒ **不出现**（不画占位、不画 spinner）
//      U_row           收到 `session.suggestions` ⇒ 这排出现、内容**逐字**、位置在输入框上方、≤3 颗
//      U_click_send    点击 ⇒ 真的发出去（空闲 ⇒ `/message`，正文逐字）；那排**同步**收起（候选被用掉）
//      U_draft         点建议**永不覆盖你正在打的字**（也不清草稿）
//      U_busy          忙时点击 ⇒ `/steer`（与忙时打字**同一条路**）
//      U_stale_start   新一轮开播 ⇒ 上一轮那排消失，属于旧 messageId 的事件不再让它回来
//      U_stale         陈旧 `messageId` ⇒ 忽略（不许出现上一轮的建议）
//      U_empty         事件里 `items: []` ⇒ 不出这排
//      U_keyboard      ⌥3 发第三颗；Esc 收起（收起后本轮不再打扰）
//      U_collapse      点 × 收起
//      U_refresh       刷新后候选**仍在**（读的是消息的可选字段）＋ 真 `location.reload()` 之后仍在
//      U_not_in_body   候选**不出现在消息正文里**
//   ③ 两条反证臂（各自**必红**）：
//      mutant-blocking  把生成塞进主回合收尾之前并 `await` ⇒ S_not_blocking / S_not_blocking_scaling 必红
//      mutant-raw       跳过 `parseSuggestionItems`、把模型原始输出直接当候选 ⇒ S_validated 必红
//
// 铁律（与 `test/s4-handoff-cwd.mjs` 同口径）：
//   · 只起**自己 spawn** 的沙箱（副本代码根 + 副本 home + 高位随机端口），只按**精确 pid** 停，
//     **绝不 pkill**；端口绝不 7331/7321；日志写沙箱自己的目录（**绝不**写 /tmp/sopho-base*.log）；
//   · 沙箱一律经 `test/sandbox-guard.mjs`（同生共死 + 寿命上限）；
//   · 会话 id 一律完整 uuid；**绝不碰真 profile**（`~/.pi/profiles/assistant` 只读都不需要）；
//   · 打补丁必须可判定：锚点命中恰好 1 行、该行里 `from` 恰好 1 处、改完逐行只有那一行变、
//     `node --check` 兜底。
//
// 跑法：
//   npm run test:suggestions                        # 三段全跑（real 全绿 + 两条反证臂各自红）
//   npm run test:suggestions:reverse-blocking       # 只跑 mutant-blocking 那一臂
//   npm run test:suggestions:reverse-raw            # 只跑 mutant-raw 那一臂
//   node test/suggestions.mjs --arm=real            # 只跑真代码（迭代用）
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, stopOwnedListener } from './harness.mjs';
import { boot, readBody, sendJson, waitFor as uiWaitFor } from './ui-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 沙箱放**仓内**：副本里的 `server/base.mjs` 要 import `@earendil-works/pi-coding-agent`，
// 得顺着目录向上找到仓里的 `node_modules`（与 `test/s4-handoff-cwd.mjs` 同一条理由）。
const SANDBOX_ROOT = path.join(ROOT, '.probe-sandbox');
await mkdir(SANDBOX_ROOT, { recursive: true });
const TMP = await mkdtemp(path.join(SANDBOX_ROOT, 'suggestions-'));
const CODE_ENTRIES = ['server', 'web', 'pi-extensions', 'package.json'];
const BASE_ENTRY = 'server/base.mjs';
const GUARD_ENTRY = path.join(ROOT, 'test', 'sandbox-guard.mjs');
const SANDBOX_LIFETIME_MS = Number(process.env.SOPHO_SANDBOX_LIFETIME_MS) || 6 * 60 * 1000;
const SHOT_DIR = process.env.SOPHO_SUGGESTIONS_SHOT_DIR || os.tmpdir();

// 沙箱里的旋钮（只影响这一个沙箱）：
//   · 建议超时 2s：比「正常」那一档的 800ms 慢回大一截，又让「挂着不回」那条臂两秒内就能判完；
//   · provider 在「正常」那一档故意慢回 800ms —— 那正是「主回合的收尾帧必须**先到**」的窗口。
const SUGGEST_TIMEOUT_MS = 2000;
const OK_DELAY_MS = 800;
const OK_ITEMS = ['继续做完', '先跑一遍门', '把结论写进报告'];
const JUNK_LONG = '长'.repeat(130);
const JUNK_ITEMS = ['ok', JUNK_LONG, '   ', 42, '四', '五', '六'];
const VALIDATED_JUNK = ['ok', '四', '五'];
const STALE_ITEMS = ['迟到的候选'];
// 与 `server/base-logic.mjs` 的 `SUGGESTION_SYSTEM_PROMPT` 对得上的那一句：provider 靠它把
// 「旁路的那一次模型调用」跟主回合的调用分开（与 `test/s4-handoff.mjs` 认摘要请求同一条办法）。
const SUGGEST_PROMPT_MARK = '下一句建议';
// 「不阻塞」那条判据的两档 provider 时延与生长上限（**差分**判据：同一台机器上两轮的差，
// 机器忙/冷沙箱会把两档一起抬高、差分把它消掉）。真阻塞的实现在这两档之间会长 ~1300ms ⇒ 必红。
const SCALING_FAST_DELAY_MS = 200;
const SCALING_SLOW_DELAY_MS = 1500;
const SCALING_GROWTH_LIMIT_MS = 400;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort(excluded = new Set()) {
  for (let candidate = 21000 + Math.floor(Math.random() * 30000); candidate < 62000; candidate += 1) {
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

function sseChunk(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-sug',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}

function messageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text || '').join('');
  return '';
}

const systemText = (messages = []) => messageText(messages.find((message) => message.role === 'system'));

function userText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messageText(messages[index]);
  }
  return '';
}

// ─────────────────────────── 假 provider：主回合回一句，旁路那次按 mode 回候选 ───────────────────────────
function startProvider(port) {
  // `suggestDelayMs`：旁路那次**回答前**要等多久（`null` = 按 mode 的默认值）。
  // 「不阻塞」那条判据靠它做**两档对比**：主回合耗时不该随这个数增长。
  const state = { mode: 'ok', suggestDelayMs: null, suggest: [], turns: 0 };
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    const body = JSON.parse(raw);
    if (systemText(body.messages).includes(SUGGEST_PROMPT_MARK)) {
      const mode = state.mode;
      const defaultDelayMs = mode === 'ok' ? OK_DELAY_MS : mode === 'stale' ? 1200 : 100;
      const delayMs = Number.isFinite(state.suggestDelayMs) ? state.suggestDelayMs : defaultDelayMs;
      state.suggest.push({ at: Date.now(), mode, delayMs, userText: userText(body.messages), tools: body.tools?.length ?? 0, messages: body.messages?.length ?? 0 });
      // 「挂着不回」：连响应头都不发（pi 的 fetch 会一直等，直到这边的超时信号把它 abort）。
      if (mode === 'hang') return;
      await sleep(delayMs);
      if (response.destroyed || response.writableEnded) return;
      const payload = { ok: OK_ITEMS, empty: [], junk: JUNK_ITEMS, notjson: '我觉得可以继续（这不是 JSON）', stale: STALE_ITEMS }[mode] ?? [];
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      sseChunk(response, { role: 'assistant', content: text });
      sseChunk(response, {}, 'stop');
      response.end('data: [DONE]\n\n');
      return;
    }
    state.turns += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    sseChunk(response, { role: 'assistant', content: 'FAKE_TURN_OK' });
    sseChunk(response, {}, 'stop');
    response.end('data: [DONE]\n\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, state }));
  });
}

// ─────────────────────────── 打补丁（只改命中锚点的那一行） ───────────────────────────
async function readTextWithEol(file) {
  const text = await readFile(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  assert.equal(lines.join(eol), text, `${file}: 按认出的换行风格拼回去必须逐字相同（混合行尾？）`);
  return { eol, lines };
}

async function patchLineOnce({ file, anchor, from, to, what }) {
  const { eol, lines } = await readTextWithEol(file);
  const hits = lines.map((line, index) => (line.includes(anchor) ? index : -1)).filter((index) => index >= 0);
  assert.equal(hits.length, 1, `${file}: 锚点 ${JSON.stringify(anchor)} 必须恰好命中 1 行，实际 ${hits.length} 行（${what}）`);
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
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', file], (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} 打补丁后解析失败（node --check）：\n${String(stderr || stdout || error.message)}`));
      else resolve();
    });
  });
}

// 突变锚点。每条都只改**一行里的一个表达式/关键字**。
const BLOCKING_SUBSCRIBE_ANCHOR = 'const unsubscribe = session.subscribe((event) => {';
const BLOCKING_SUBSCRIBE_FROM = 'session.subscribe((event) => {';
const BLOCKING_SUBSCRIBE_TO = 'session.subscribe(async (event) => {   /* (mutation: 回调改成 async) */';
const BLOCKING_AWAIT_ANCHOR = '      noteTurnSettled();';
const BLOCKING_AWAIT_FROM = 'noteTurnSettled();';
const BLOCKING_AWAIT_TO = 'await noteTurnSettled();   /* (mutation: 把生成阻塞在主回合收尾之前) */';
const RAW_ANCHOR = 'const parsed = parseSuggestionItems(text);';
const RAW_FROM = 'parseSuggestionItems(text)';
const RAW_TO = '(() => { const raw = JSON.parse(text); return { ok: true, reason: null, items: Array.isArray(raw) ? raw : [], dropped: { invalid: 0, empty: 0, tooLong: 0, overflow: 0 } }; })()   /* (mutation: 跳过严格校验) */';

async function makeCodeRoot(name, patches) {
  const root = path.join(TMP, name);
  await mkdir(root, { recursive: true });
  for (const entry of CODE_ENTRIES) await cp(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
  const logicFile = path.join(root, 'server', 'base-logic.mjs');
  const applied = [];
  if (patches.includes('blocking')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: BLOCKING_SUBSCRIBE_ANCHOR, from: BLOCKING_SUBSCRIBE_FROM, to: BLOCKING_SUBSCRIBE_TO, what: '把 subscribe 回调改成 async' }));
    applied.push(await patchLineOnce({ file: logicFile, anchor: BLOCKING_AWAIT_ANCHOR, from: BLOCKING_AWAIT_FROM, to: BLOCKING_AWAIT_TO, what: '把生成 await 在主回合收尾之前（= 阻塞）' }));
  }
  if (patches.includes('raw')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: RAW_ANCHOR, from: RAW_FROM, to: RAW_TO, what: '跳过 parseSuggestionItems，直接用模型原始输出' }));
  }
  await assertParses(logicFile);
  return { root, applied };
}

// ─────────────────────────── 沙箱（经 test/sandbox-guard.mjs） ───────────────────────────
async function startSandbox({ name, codeRoot }) {
  const home = path.join(TMP, `home-${name}`);
  const sessionsDir = path.join(home, 'sessions');
  const workCwd = path.join(TMP, `cwd-${name}`);
  for (const dir of [home, sessionsDir, workCwd]) await mkdir(dir, { recursive: true });
  const used = new Set();
  const providerPort = await reservePort(used); used.add(providerPort);
  const basePort = await reservePort(used);
  const provider = await startProvider(providerPort);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-sug', name: 'Fake SUG', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-sug', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);
  const sessionId = randomUUID();
  const sessionFile = path.join(sessionsDir, `seed_${sessionId}.jsonl`);
  const now = new Date().toISOString();
  await writeFile(sessionFile, [
    { type: 'session', version: 3, id: sessionId, timestamp: now, cwd: workCwd },
    { type: 'model_change', id: '50000001', parentId: null, timestamp: now, provider: 'fake', modelId: 'fake-sug' },
    { type: 'message', id: 'sug-user-1', parentId: '50000001', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: '先看一段历史：这一轮之前已经有对话了' }], timestamp: Date.now() } },
    { type: 'message', id: 'sug-assistant-1', parentId: 'sug-user-1', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: '知道了，接着来。' }], api: 'openai-completions', provider: 'fake', model: 'fake-sug', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } },
  ].map(JSON.stringify).join('\n') + '\n');

  const log = await open(path.join(TMP, `base-${name}.log`), 'w');
  const guard = spawn(process.execPath, [
    GUARD_ENTRY,
    '--entry', path.join(codeRoot, BASE_ENTRY),
    '--label', `suggestions-${name}-${basePort}`,
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
      SOPHO_DEFAULT_CWD: workCwd,
      SOPHO_MAX_HOT: '12',
      SOPHO_SUGGESTIONS_TIMEOUT_MS: String(SUGGEST_TIMEOUT_MS),
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
  await poll(`${name}: base 就绪`, () => request(basePort, '/host'), (reply) => reply.status === 200, 40_000);
  assert.equal(await listenerPid(basePort), started.pid, `${name}: 监听端口的必须是我 spawn 的沙箱根 pid`);
  print('sandbox host（经 test/sandbox-guard.mjs 包起）', { arm: name, port: basePort, guardPid: guard.pid, hostPid: started.pid, lifetimeMs: SANDBOX_LIFETIME_MS });
  return { name, codeRoot, home, sessionsDir, workCwd, sessionId, sessionFile, basePort, providerPort, provider, guard, hostPid: started.pid, exited, log };
}

async function stopSandbox(sandbox, problems) {
  await cleanupStep(problems, `${sandbox.name}: 关 provider`, () => new Promise((resolve) => {
    sandbox.provider.server.closeAllConnections();
    sandbox.provider.server.close(resolve);
  }));
  // ⚠️ 入口核对用的必须是**这个臂自己的代码根**（突变臂跑的是副本里的 base.mjs），
  // 拿仓里的路径去核会把「我自己起的」误判成「别人的」。
  await cleanupStep(problems, `${sandbox.name}: 停沙箱根（精确 pid + 入口核对）`, () => stopOwnedListener(sandbox.basePort, path.join(sandbox.codeRoot, BASE_ENTRY), sandbox.hostPid));
  await cleanupStep(problems, `${sandbox.name}: 收守树`, async () => {
    const settled = await Promise.race([sandbox.exited, sleep(15_000).then(() => null)]);
    if (settled === null && sandbox.guard?.pid) {
      try { process.kill(sandbox.guard.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
      await sandbox.exited;
    }
  });
  await cleanupStep(problems, `${sandbox.name}: 关日志`, () => sandbox.log?.close());
}

// ─────────────────────────── HTTP / SSE 助手 ───────────────────────────
async function request(port, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let value;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = raw; }
  return { status: response.status, raw, value };
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
    await sleep(40);
  }
  throw new Error(`${label} 超时；最后一次：${JSON.stringify(last)}`);
}

/** 一条会话的原始 SSE 订阅：把帧**逐条**记下来（名字 + 到达时间 + data）。 */
async function openSse(basePort, sessionId) {
  const frames = [];
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${basePort}/sessions/${sessionId}/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, `SSE 订阅必须 200，实际 ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const name = /^event: (.+)$/m.exec(chunk)?.[1] ?? null;
          const dataLine = /^data: (.*)$/m.exec(chunk)?.[1];
          if (!name || dataLine === undefined) continue;
          let data = null;
          try { data = JSON.parse(dataLine); } catch { data = { unparsable: dataLine }; }
          frames.push({ at: Date.now(), name, data });
        }
      }
    } catch { /* 订阅被关掉：正常 */ }
  })();
  return {
    frames,
    settledCount: () => frames.filter((frame) => frame.name === 'session.settled').length,
    suggestionsFrames: () => frames.filter((frame) => frame.name === 'session.suggestions'),
    wait: (name, predicate = () => true, timeoutMs = 20_000) => poll(`${name} 帧`, async () => frames.find((frame) => frame.name === name && predicate(frame)) ?? null, Boolean, timeoutMs),
    since: (index) => frames.slice(index),
    close: () => controller.abort(),
  };
}

async function readSuggestionLines(sandbox) {
  try {
    const text = await readFile(path.join(sandbox.home, 'suggestions.jsonl'), 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** `/messages` 里那条消息的 `suggestions` 可选字段（**读的就是前端刷新后读的那一份**）。 */
async function suggestionFieldOf(sandbox, entryId) {
  const reply = await request(sandbox.basePort, `/sessions/${sandbox.sessionId}/messages`);
  assert.equal(reply.status, 200, reply.raw.slice(0, 200));
  const message = (reply.value?.messages ?? []).find((item) => item.entryId === entryId);
  return { message, suggestions: message?.suggestions ?? null, text: message?.text ?? null, parts: message?.parts ?? null, messages: reply.value?.messages ?? [] };
}

const lastAssistantOf = (messages) => [...(messages ?? [])].reverse().find((item) => item.role === 'assistant') ?? null;

// ─────────────────────────── ① 服务端臂 ───────────────────────────
async function runServerArm(sandbox) {
  const failures = [];
  const evidence = {};
  const check = (name, ok, detail) => {
    if (!ok) failures.push({ name, detail });
    print(`服务端臂 · ${ok ? '✓' : '✗'} ${name}`, detail);
    return ok;
  };
  const base = `http://127.0.0.1:${sandbox.basePort}`;
  const sendTurn = async (text) => {
    const reply = await request(sandbox.basePort, `/sessions/${sandbox.sessionId}/message`, { method: 'POST', body: { text } });
    assert.equal(reply.status, 202, `POST /message 必须 202，实际 ${reply.status}: ${reply.raw.slice(0, 200)}`);
  };
  let sse = null;
  /** 发一轮、等到**这一轮**落定（靠 settled 的条数增量，不看时间）。 */
  const runTurn = async (text) => {
    const before = sse.settledCount();
    await sendTurn(text);
    await poll('本轮落定', async () => sse.settledCount() > before, Boolean, 25_000);
  };

  try {
    // ── S_frame / S_input / S_not_blocking / S_before / S_persisted / S_not_in_body / S_cache ──
    sandbox.provider.state.mode = 'ok';
    sse = await openSse(sandbox.basePort, sandbox.sessionId);
    await poll('快照帧', async () => sse.frames.find((frame) => frame.name === 'session.snapshot') ?? null, Boolean, 15_000);
    const suggestBefore = sandbox.provider.state.suggest.length;
    const postedAt = Date.now();
    const settledBefore = sse.settledCount();
    await sendTurn('S_frame：这一轮要出候选');
    await poll('本轮落定', async () => sse.settledCount() > settledBefore, Boolean, 25_000);
    // 候选到达**之前**存下这一版响应体（正是「刷新会命中旧响应体」那个现场）。
    const beforeReply = await request(sandbox.basePort, `/sessions/${sandbox.sessionId}/messages`);
    evidence.beforeField = lastAssistantOf(beforeReply.value?.messages)?.suggestions ?? null;
    const frame = await sse.wait('session.suggestions', () => true, 20_000);
    const settled = sse.frames.filter((item) => item.name === 'session.settled').at(-1);
    const beforeMessage = lastAssistantOf(beforeReply.value?.messages);
    check('S_frame 回合落定 ⇒ 另起一次模型调用 ⇒ `session.suggestions` 帧（messageId + 校验后的 items）',
      Array.isArray(frame.data?.items) && frame.data.items.join('|') === OK_ITEMS.join('|')
      && typeof frame.data?.messageId === 'string' && frame.data.messageId === beforeMessage?.entryId
      && sandbox.provider.state.suggest.length === suggestBefore + 1,
      { rawFrame: frame.data, messageId: frame.data?.messageId ?? null, items: frame.data?.items ?? null, lastAssistantEntryId: beforeMessage?.entryId ?? null, suggestRequests: sandbox.provider.state.suggest.length - suggestBefore });
    const lastSuggest = sandbox.provider.state.suggest.at(-1);
    check('S_input 旁路那次调用不带工具、喂的是最近几条消息的文本（不在对话里走）',
      lastSuggest?.tools === 0 && lastSuggest.userText.includes('S_frame：这一轮要出候选'),
      { tools: lastSuggest?.tools ?? null, userTextHead: (lastSuggest?.userText ?? '').slice(0, 90), messages: lastSuggest?.messages ?? null });
    // 「不阻塞」是**结构性**判据，不拿任何时间阈值当输赢：
    //   ① **事件序号**：收尾帧（`session.settled`）的 `seq` 必须**小于**候选那帧的 `seq` —— 同一会话的
    //      事件序号由适配器单调递增，这是「收尾在前」的机械形状，与机器快慢无关；
    //   ② 下面 `S_not_blocking_scaling`：同一条会话跑两轮、只把**旁路调用的 provider 时延**从 200ms
    //      换到 1500ms，主回合耗时**不该跟着长**（真阻塞的实现会几乎原样长那么多）。
    const settledSeq = settled?.data?.seq ?? null;
    const suggestionsSeq = frame.data?.seq ?? null;
    check('S_not_blocking（结构）主回合的收尾帧**按事件序号**先于候选那帧（不是时间阈值）',
      typeof settledSeq === 'number' && typeof suggestionsSeq === 'number' && settledSeq < suggestionsSeq,
      { settledSeq, suggestionsSeq, arrivedAt: { settledAt: settled?.at ?? null, suggestionsAt: frame.at }, settleLatencyMs: settled ? settled.at - postedAt : null });
    check('S_before 候选到达**之前**那一版正文里没有 `suggestions` 字段（字段真的来自候选那一行）', evidence.beforeField === null, { beforeField: evidence.beforeField });

    const after1 = await suggestionFieldOf(sandbox, frame.data.messageId);
    const after2 = await suggestionFieldOf(sandbox, frame.data.messageId);
    const lines = await readSuggestionLines(sandbox);
    const record = lines.at(-1);

    check('S_persisted 候选落成那条助手消息的可选字段 `suggestions`（`/messages` 读得到）',
      Array.isArray(after1.suggestions) && after1.suggestions.join('|') === OK_ITEMS.join('|')
      && record?.messageId === frame.data.messageId && record?.sessionId === sandbox.sessionId
      && Array.isArray(record?.items) && record.items.join('|') === OK_ITEMS.join('|'),
      { field: after1.suggestions, line: record ?? null, lines: lines.length });
    check('S_cache 候选到达**之后**每一次 `/messages` 都带那个字段（会话文件没变 ⇒ 响应体缓存的键必须带候选那一行）',
      Array.isArray(after2.suggestions) && after2.suggestions.join('|') === OK_ITEMS.join('|'),
      { first: after1.suggestions, second: after2.suggestions, versionNote: '同一份会话文件（size/mtime/ctime 没变）连读两次' });
    const bodyText = `${after1.text ?? ''}\n${JSON.stringify(after1.parts ?? [])}`;
    check('S_not_in_body 候选**不进对话正文**（`text`/`parts` 里一个字都没有）',
      OK_ITEMS.every((item) => !bodyText.includes(item)), { textHead: (after1.text ?? '').slice(0, 60), parts: after1.parts });

    // ── S_validated：非 JSON / 过长 / 空串 / 非字符串 / 超 3 条 ─────────────────────
    sandbox.provider.state.mode = 'junk';
    const junkBefore = sse.frames.length;
    await runTurn('S_validated：模型的输出要被打回');
    const junkFrame = await sse.wait('session.suggestions', (item) => item.at > frame.at, 20_000);
    const junkField = await suggestionFieldOf(sandbox, junkFrame.data.messageId);
    check('S_validated 非 JSON / 过长 / 空串 / 非字符串 / 超 3 条 ⇒ **校验后的内容**才上屏（帧与落盘两处都是）',
      junkFrame.data.items.join('|') === VALIDATED_JUNK.join('|') && junkFrame.data.items.length <= 3
      && !junkFrame.data.items.includes(JUNK_LONG)
      && junkField.suggestions?.join('|') === VALIDATED_JUNK.join('|'),
      { got: junkFrame.data.items, field: junkField.suggestions, want: VALIDATED_JUNK, providerRaw: JUNK_ITEMS, frames: sse.since(junkBefore).length });

    // ── S_empty：空数组 ⇒ 什么都不出（不许逼它凑数）────────────────────────────────
    sandbox.provider.state.mode = 'empty';
    const linesBeforeEmpty = (await readSuggestionLines(sandbox)).length;
    const emptyMark = sse.frames.length;
    await runTurn('S_empty：模型给空数组');
    await sleep(OK_DELAY_MS + 500);
    const emptyMessage = lastAssistantOf((await request(sandbox.basePort, `/sessions/${sandbox.sessionId}/messages`)).value?.messages);
    check('S_empty 模型返回空数组 ⇒ 不出这排（不落盘、不发帧、字段也不在）',
      sse.since(emptyMark).filter((item) => item.name === 'session.suggestions').length === 0
      && (await readSuggestionLines(sandbox)).length === linesBeforeEmpty
      && (emptyMessage?.suggestions ?? null) === null,
      { suggestionsFrames: sse.since(emptyMark).filter((item) => item.name === 'session.suggestions').length, lines: (await readSuggestionLines(sandbox)).length, field: emptyMessage?.suggestions ?? null });

    // ── S_notjson：整段不是 JSON ⇒ 一条都不上屏（安静放弃）────────────────────────
    sandbox.provider.state.mode = 'notjson';
    const notJsonMark = sse.frames.length;
    const linesBeforeNotJson = (await readSuggestionLines(sandbox)).length;
    await runTurn('S_notjson：模型回的是人话');
    await sleep(OK_DELAY_MS + 300);
    check('S_notjson 整段不是 JSON ⇒ 一条都不上屏（安静放弃，不造假）',
      sse.since(notJsonMark).filter((item) => item.name === 'session.suggestions').length === 0
      && (await readSuggestionLines(sandbox)).length === linesBeforeNotJson,
      { suggestionsFrames: sse.since(notJsonMark).filter((item) => item.name === 'session.suggestions').length });

    // ── S_timeout：模型挂着不回 ⇒ 到点安静放弃 ─────────────────────────────────────
    sandbox.provider.state.mode = 'hang';
    const hangMark = sse.frames.length;
    const suggestBeforeHang = sandbox.provider.state.suggest.length;
    const linesBeforeHang = (await readSuggestionLines(sandbox)).length;
    await runTurn('S_timeout：模型不回来');
    await sleep(SUGGEST_TIMEOUT_MS + 800);
    check('S_timeout 模型挂着不回 ⇒ 到点安静放弃（请求真的发出去了，但不出这排、不造假）',
      sandbox.provider.state.suggest.length === suggestBeforeHang + 1
      && sse.since(hangMark).filter((item) => item.name === 'session.suggestions').length === 0
      && (await readSuggestionLines(sandbox)).length === linesBeforeHang,
      { suggestRequests: sandbox.provider.state.suggest.length - suggestBeforeHang, suggestionsFrames: sse.since(hangMark).filter((item) => item.name === 'session.suggestions').length, waitedMs: SUGGEST_TIMEOUT_MS + 800 });

    // ── S_stale：新一轮先开始 ⇒ 上一轮的结果被丢弃 ─────────────────────────────────
    sandbox.provider.state.mode = 'stale';
    const staleMark = sse.frames.length;
    const linesBeforeStale = (await readSuggestionLines(sandbox)).length;
    await runTurn('S_stale：第一轮（候选会慢）');
    await poll('第一轮的候选请求', async () => sandbox.provider.state.suggest.at(-1)?.mode === 'stale' ? true : null, Boolean, 10_000);
    await runTurn('S_stale：第二轮（它一落定，第一轮就作废）');
    const staleFrame = await sse.wait('session.suggestions', (item) => item.at > (sse.frames.at(-1)?.at ?? 0) - 3000, 20_000);
    await sleep(300);
    const staleFrames = sse.since(staleMark).filter((item) => item.name === 'session.suggestions');
    const staleLines = await readSuggestionLines(sandbox);
    const secondTurnMessage = lastAssistantOf((await request(sandbox.basePort, `/sessions/${sandbox.sessionId}/messages`)).value?.messages);
    check('S_stale 新一轮先开始 ⇒ 上一轮那一条被丢弃（**只有最新一轮**发了帧、落了盘）',
      staleFrames.length === 1 && staleFrames[0].data.messageId === secondTurnMessage?.entryId
      && staleLines.length === linesBeforeStale + 1 && staleLines.at(-1)?.items?.join('|') === STALE_ITEMS.join('|'),
      { suggestionsFrames: staleFrames.map((item) => ({ at: item.at, messageId: item.data?.messageId, items: item.data?.items })), latestAssistantEntryId: secondTurnMessage?.entryId ?? null, lines: staleLines.slice(linesBeforeStale).map((line) => ({ messageId: line.messageId, items: line.items })), waitedForFrameAt: staleFrame.at });

    // ── S_not_blocking_scaling：主回合耗时**不随**旁路调用的时延增长（200ms vs 1500ms 两档）──
    // 为什么这样判才算「可证明的不阻塞」：两档测的是**同一个量**（从发消息到收尾帧）在同一台机器上
    // 的差；机器忙/冷沙箱只会让两档**一起**变慢（差分把那些干扰项消掉）。真阻塞的实现（见反证臂
    // `mutant-blocking`）会把 1500ms 那一档几乎原样拖长（实测 ~1300ms）。
    const turnWithSuggestDelay = async (delayMs) => {
      sandbox.provider.state.mode = 'ok';
      sandbox.provider.state.suggestDelayMs = delayMs;
      const settledMark = sse.settledCount();
      const posted = Date.now();
      await sendTurn(`S_scaling：旁路调用慢 ${delayMs}ms`);
      await poll('本轮落定', async () => sse.settledCount() > settledMark, Boolean, 25_000);
      const settledFrame = sse.frames.filter((item) => item.name === 'session.settled').at(-1);
      const suggestionsFrame = await sse.wait('session.suggestions', (item) => item.at >= settledFrame.at, 20_000);
      return {
        delayMs,
        settleMs: settledFrame.at - posted,
        settledSeq: settledFrame.data?.seq ?? null,
        suggestionsSeq: suggestionsFrame.data?.seq ?? null,
      };
    };
    const fastCase = await turnWithSuggestDelay(SCALING_FAST_DELAY_MS);
    const slowCase = await turnWithSuggestDelay(SCALING_SLOW_DELAY_MS);
    const growthMs = slowCase.settleMs - fastCase.settleMs;
    const delaysUsed = sandbox.provider.state.suggest.slice(-2).map((item) => item.delayMs);
    check('S_not_blocking_scaling 主回合耗时**不随**旁路调用的时延增长（200ms vs 1500ms 两档对比）',
      growthMs <= SCALING_GROWTH_LIMIT_MS
      && delaysUsed.join(',') === `${SCALING_FAST_DELAY_MS},${SCALING_SLOW_DELAY_MS}`
      && fastCase.settledSeq < fastCase.suggestionsSeq && slowCase.settledSeq < slowCase.suggestionsSeq,
      { fast: fastCase, slow: slowCase, growthMs, limitMs: SCALING_GROWTH_LIMIT_MS, providerDelaysUsed: delaysUsed });
    sandbox.provider.state.suggestDelayMs = null; // 后面的判据回到各自的默认时延
    // ── S_switch_off：关掉开关 ⇒ 一次模型调用都不发 ────────────────────────────────
    const patched = await request(sandbox.basePort, '/settings', { method: 'PATCH', body: { 'suggestions.enabled': false } });
    assert.equal(patched.status, 200, `PATCH /settings 必须 200，实际 ${patched.status}: ${patched.raw.slice(0, 200)}`);
    assert.equal(patched.value?.settings?.['suggestions.enabled'], false, JSON.stringify(patched.value?.settings ?? null));
    sandbox.provider.state.mode = 'ok';
    const suggestBeforeOff = sandbox.provider.state.suggest.length;
    const offMark = sse.frames.length;
    const turnsBeforeOff = sandbox.provider.state.turns;
    await runTurn('S_switch_off：开关关着');
    await sleep(OK_DELAY_MS + 500);
    check('S_switch_off 关掉开关 ⇒ **一次模型调用都不发**（主回合照常跑）',
      sandbox.provider.state.suggest.length === suggestBeforeOff
      && sandbox.provider.state.turns > turnsBeforeOff
      && sse.since(offMark).filter((item) => item.name === 'session.suggestions').length === 0,
      { suggestRequests: sandbox.provider.state.suggest.length - suggestBeforeOff, turns: sandbox.provider.state.turns - turnsBeforeOff, checkedSetting: patched.value?.settings?.['suggestions.enabled'] });
    evidence.offLineCount = (await readSuggestionLines(sandbox)).length;

    const restored = await request(sandbox.basePort, '/settings', { method: 'PATCH', body: { 'suggestions.enabled': true } });
    assert.equal(restored.status, 200, restored.raw.slice(0, 200));
  } finally {
    sse?.close();
  }

  // 日志里必须留下「安静放弃 / 校验打回 / 开关关着」的那几行（失败不许无声无息）。
  const logText = await readFile(path.join(TMP, `base-${sandbox.name}.log`), 'utf8').catch(() => '');
  const logLines = logText.split('\n').filter((line) => line.includes('[suggestions]'));
  const logHas = (needle) => logLines.some((line) => line.includes(needle));
  check('S_log 每一种安静放弃/打回/关着都留了一行日志（不静默）',
    logHas('不是 JSON 数组') && logHas('空数组') && logHas('关着') && logHas('陈旧') && (logHas('中止') || logHas('失败（安静放弃')),
    { logLines: logLines.slice(-10) });

  return { failures, evidence, logLines: logLines.slice(-12) };
}

// 两条反证臂各自只跑**它要打的那条判据**（跑法/断言与真代码那一臂逐字相同）。
async function runServerArmBlockingProbe(sandbox) {
  sandbox.provider.state.mode = 'ok';
  const sse = await openSse(sandbox.basePort, sandbox.sessionId);
  /** 一轮：只换**旁路调用的时延**，量「从发消息到收尾帧」与两帧的事件序号。 */
  const turn = async (delayMs) => {
    sandbox.provider.state.suggestDelayMs = delayMs;
    const settledMark = sse.settledCount();
    const posted = Date.now();
    await request(sandbox.basePort, `/sessions/${sandbox.sessionId}/message`, { method: 'POST', body: { text: `mutant-blocking：旁路慢 ${delayMs}ms` } });
    await poll('本轮落定', async () => sse.settledCount() > settledMark, Boolean, 25_000);
    const settledFrame = sse.frames.filter((item) => item.name === 'session.settled').at(-1);
    const suggestionsFrame = await sse.wait('session.suggestions', (item) => item.at >= settledFrame.at, 20_000);
    return {
      delayMs,
      settleMs: settledFrame.at - posted,
      settledSeq: settledFrame.data?.seq ?? null,
      suggestionsSeq: suggestionsFrame.data?.seq ?? null,
    };
  };
  try {
    await poll('快照帧', async () => sse.frames.find((frame) => frame.name === 'session.snapshot') ?? null, Boolean, 15_000);
    const fast = await turn(SCALING_FAST_DELAY_MS);
    const slow = await turn(SCALING_SLOW_DELAY_MS);
    const growthMs = slow.settleMs - fast.settleMs;
    // 两条与真代码那一臂**逐字相同**的判据：① 按事件序号收尾在前；② 主回合耗时不随旁路时延长。
    const seqOrderingOk = fast.settledSeq < fast.suggestionsSeq && slow.settledSeq < slow.suggestionsSeq;
    return {
      notBlocking: {
        ok: seqOrderingOk && growthMs <= SCALING_GROWTH_LIMIT_MS,
        evidence: { fast, slow, growthMs, limitMs: SCALING_GROWTH_LIMIT_MS, seqOrderingOk },
      },
    };
  } finally {
    sse.close();
  }
}

async function runServerArmRawProbe(sandbox) {
  sandbox.provider.state.mode = 'junk';
  const sse = await openSse(sandbox.basePort, sandbox.sessionId);
  try {
    await poll('快照帧', async () => sse.frames.find((frame) => frame.name === 'session.snapshot') ?? null, Boolean, 15_000);
    const settledBefore = sse.settledCount();
    await request(sandbox.basePort, `/sessions/${sandbox.sessionId}/message`, { method: 'POST', body: { text: 'mutant-raw：这一轮' } });
    await poll('本轮落定', async () => sse.settledCount() > settledBefore, Boolean, 25_000);
    const frame = await sse.wait('session.suggestions', () => true, 20_000);
    const field = await suggestionFieldOf(sandbox, frame.data.messageId);
    return {
      validated: {
        ok: frame.data.items.join('|') === VALIDATED_JUNK.join('|') && field.suggestions?.join('|') === VALIDATED_JUNK.join('|'),
        evidence: { got: frame.data.items, field: field.suggestions ?? null, want: VALIDATED_JUNK, providerRaw: JUNK_ITEMS },
      },
    };
  } finally {
    sse.close();
  }
}

// ─────────────────────────── ② 前端臂（真 Chromium + 假 API） ───────────────────────────
const FE_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FE_TAIL_ID = 'fe-assistant-1';
const FE_SUGGEST = ['继续把门跑完', '先把报告写出来', '停一下，我想改口径'];
const FE_STALE_ID = 'fe-assistant-0';
const FE_DRAFT = 'DRAFT-不能被覆盖';

function feHistory({ tailSuggestions = null } = {}) {
  return [
    { entryId: 'fe-user-1', role: 'user', text: '起一个头', content: [{ type: 'text', text: '起一个头' }], images: [] },
    {
      entryId: FE_TAIL_ID,
      role: 'assistant',
      text: '好的，已经做完了第一步。',
      content: [{ type: 'text', text: '好的，已经做完了第一步。' }],
      parts: [{ type: 'text', text: '好的，已经做完了第一步。' }],
      stopReason: 'stop',
      images: [],
      ...(tailSuggestions === null ? {} : { suggestions: tailSuggestions }),
    },
  ];
}

async function bootFrontend({ webRoot, tailSuggestions = null }) {
  const state = {
    messages: feHistory({ tailSuggestions }),
    streaming: false,
    stream: null,
    posts: [],
    drafts: [],
  };
  const rows = [{ id: FE_SESSION, name: '推荐回复的会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-23T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } }];
  const ui = await boot({
    webRoot,
    routes: async (incoming, response, url) => {
      if (url.pathname === '/api/host') { sendJson(response, 200, { ok: true }); return true; }
      if (url.pathname === '/api/devices') { sendJson(response, 200, { exists: true, devices: [] }); return true; }
      if (url.pathname === '/api/settings') {
        sendJson(response, 200, { version: 1, settings: { 'thinking.defaultFold': 'expanded', 'annotations.notifySession': '', 'suggestions.enabled': true }, defaults: {}, stored: {}, file: null, exists: false });
        return true;
      }
      if (url.pathname === '/api/tree') { sendJson(response, 200, { sessions: rows, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } }); return true; }
      if (url.pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions: rows })}\n\n`);
        return true;
      }
      const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|message|steer|follow-up))?$/.exec(url.pathname);
      if (match) {
        const action = match[2] ?? null;
        if (action === null) { sendJson(response, 200, { name: rows[0].name, cwd: '/tmp/fe', runtime: { isStreaming: state.streaming, isCompacting: false, isRetrying: false }, observability: null }); return true; }
        if (action === 'messages') { sendJson(response, 200, { sessionId: FE_SESSION, messages: state.messages, extras: [], compaction: { atIndex: null }, observability: null }); return true; }
        if (action === 'commands') { sendJson(response, 200, { streaming: state.streaming, commands: [] }); return true; }
        if (action === 'seen') { sendJson(response, 200, { ok: true }); return true; }
        if (action === 'draft' && incoming.method === 'GET') { sendJson(response, 200, { text: '' }); return true; }
        if (action === 'draft' && incoming.method === 'PUT') { state.drafts.push(JSON.parse(await readBody(incoming))); sendJson(response, 200, { ok: true }); return true; }
        if (action === 'message' || action === 'steer' || action === 'follow-up') {
          state.posts.push({ path: url.pathname, at: Date.now(), body: JSON.parse(await readBody(incoming)) });
          sendJson(response, 202, { accepted: true, mode: action === 'message' ? 'message' : action });
          return true;
        }
        if (action === 'events') {
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
          response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: state.streaming, isCompacting: false, isRetrying: false, pendingMessages: 0 })}\n\n`);
          state.stream = response;
          response.once('close', () => { if (state.stream === response) state.stream = null; });
          return true;
        }
      }
      if (url.pathname === '/api/test/event' && incoming.method === 'POST') {
        const { name, data } = JSON.parse(await readBody(incoming));
        if (name === 'session.start') state.streaming = true;
        if (name === 'session.end' && data?.stopReason !== 'toolUse') state.streaming = false;
        if (!state.stream || state.stream.destroyed) { sendJson(response, 409, { message: 'session stream unavailable' }); return true; }
        state.stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        sendJson(response, 200, { ok: true });
        return true;
      }
      return false;
    },
  });
  await uiWaitFor(() => ui.evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${FE_SESSION}"]')`), '页面没起来', 20_000);
  await ui.evaluate(`document.querySelector('[data-session-id="${FE_SESSION}"] .tree-select').click()`);
  await uiWaitFor(() => state.stream !== null, '会话事件流没连上');
  await uiWaitFor(() => ui.evaluate(`document.querySelector('#prompt')?.disabled === false`), '输入框没就绪');
  return { ui, state };
}

const ROW_STATE = `(() => {
  const row = document.querySelector('#suggestions');
  const list = document.querySelector('#suggestions-list');
  const prompt = document.querySelector('#prompt');
  const composer = document.querySelector('#composer');
  if (!row || !list || !prompt) return null;
  const rect = (node) => { const r = node.getBoundingClientRect(); return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), height: +r.height.toFixed(1) }; };
  const chips = [...list.querySelectorAll('.suggestion-chip')];
  return {
    hidden: row.hidden,
    label: row.querySelector('.suggestions-label')?.textContent ?? null,
    texts: chips.map((node) => node.textContent),
    indices: chips.map((node) => node.dataset.suggestionIndex ?? null),
    count: chips.length,
    rowRect: rect(row),
    promptRect: rect(prompt),
    insideComposer: composer.contains(row),
    promptValue: prompt.value,
    messagesText: document.querySelector('#messages')?.textContent ?? '',
  };
})()`;

async function runFrontendArm({ webRoot }) {
  const failures = [];
  const evidence = {};
  const check = (name, ok, detail) => {
    if (!ok) failures.push({ name, detail });
    print(`前端臂 · ${ok ? '✓' : '✗'} ${name}`, detail);
    return ok;
  };
  const rowState = (ui) => ui.evaluate(ROW_STATE);
  const clickChip = (ui, index) => ui.evaluate(`(() => { const chip = document.querySelector('#suggestions-list .suggestion-chip[data-suggestion-index="${index}"]'); if (!chip) return false; chip.click(); return true; })()`);
  const typeAndSend = (ui, text) => ui.evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); return true; })()`);

  // ── U_no_event / U_row / U_click_send / U_draft / U_busy / U_stale / U_empty / U_keyboard ──
  const a = await bootFrontend({ webRoot });
  try {
    const idle = await rowState(a.ui);
    check('U_no_event 没有候选事件 ⇒ 这排不出现（元素在但 hidden，且一颗 chip 都没有：不画占位 / 不画 spinner）',
      idle !== null && idle.hidden === true && idle.count === 0 && idle.label !== null,
      { row: idle && { hidden: idle.hidden, count: idle.count, label: idle.label } });
    await a.ui.screenshot(path.join(SHOT_DIR, 'sopho-suggestions-empty-1200x760.png'));

    await a.ui.emit('session.suggestions', { messageId: FE_TAIL_ID, items: FE_SUGGEST });
    await uiWaitFor(async () => (await rowState(a.ui))?.hidden === false, '候选那排没出现');
    const shown = await rowState(a.ui);
    check('U_row 收到 `session.suggestions` ⇒ 这排出现、内容**逐字**、标成「模型建议」、≤3 颗',
      shown.count === 3 && shown.texts.join('|') === FE_SUGGEST.join('|') && shown.label === '模型建议' && shown.indices.join(',') === '1,2,3',
      { count: shown.count, texts: shown.texts, label: shown.label, indices: shown.indices });
    check('U_row_geometry 位置在**输入框上方**（且这排住在 composer 里）',
      shown.insideComposer === true && shown.rowRect.bottom <= shown.promptRect.top + 0.5,
      { rowRect: shown.rowRect, promptRect: shown.promptRect, insideComposer: shown.insideComposer });
    await a.ui.screenshot(path.join(SHOT_DIR, 'sopho-suggestions-shown-1200x760.png'));

    // 点击 = 直接发送；**永不覆盖你正在打的字**。
    await a.ui.evaluate(`(() => { const p = document.querySelector('#prompt'); p.value = ${JSON.stringify(FE_DRAFT)}; p.dispatchEvent(new Event('input')); return p.value; })()`);
    await clickChip(a.ui, 2);
    // 「这一轮的候选被用掉」是**点下去那一刻**就成立的事 ⇒ 那排得**同步**收起，**不等** POST 往返。
    // （等一大截再读会把「实现把收起排在往返之后」这种也放过去 —— 那这一条就没牙了。）
    const rightAfterClick = await rowState(a.ui);
    check('U_click_hides 点一颗 ⇒ 这条候选**当场**被用掉、那排**同步**收起（不等 POST 往返）',
      rightAfterClick.hidden === true && rightAfterClick.count === 0,
      { hidden: rightAfterClick.hidden, count: rightAfterClick.count, texts: rightAfterClick.texts });
    await uiWaitFor(async () => a.state.posts.length > 0, '点建议之后没有发出请求');
    const chipPost = a.state.posts.at(-1);
    check('U_click_send 点一颗 ⇒ 真的发出去（空闲 ⇒ `/sessions/{id}/message`，正文逐字）',
      chipPost.path === `/api/sessions/${FE_SESSION}/message` && chipPost.body?.text === FE_SUGGEST[1],
      { posts: a.state.posts.map((item) => ({ path: item.path, text: item.body?.text ?? null })) });
    const afterClick = await rowState(a.ui);
    check('U_draft 点建议**永不覆盖你正在打的字**（输入框原文一字未动，也不把草稿写成空串）',
      afterClick.promptValue === FE_DRAFT && !a.state.drafts.some((draft) => draft.text === ''),
      { promptValue: afterClick.promptValue, drafts: a.state.drafts });
    await a.ui.screenshot(path.join(SHOT_DIR, 'sopho-suggestions-clicked-1200x760.png'));

    // 新一轮开播 ⇒ 上一轮那排消失，且旧 messageId 的事件不再让它回来。
    await a.ui.emit('session.start', { role: 'assistant' });
    await a.ui.emit('session.suggestions', { messageId: FE_TAIL_ID, items: FE_SUGGEST });
    await sleep(150);
    check('U_stale_start 新一轮开播 ⇒ 上一轮那排消失，且属于旧 messageId 的事件也不再让它出现',
      (await rowState(a.ui)).hidden === true, { row: await rowState(a.ui) });

    // 忙时点击 ⇒ `/steer`（与忙时打字**同一条路**）：快照说还在跑（agentBusy=true），
    // 收尾帧到达那一刻 streaming=false ⇒ 那排在、而 agentBusy 仍为真 —— 这一个窗口是真实存在的。
    await a.ui.emit('session.snapshot', { isStreaming: true, isCompacting: false, isRetrying: false, pendingMessages: 0 });
    await a.ui.emit('session.end', { stopReason: 'stop' });
    await sleep(200);
    await a.ui.emit('session.suggestions', { messageId: FE_TAIL_ID, items: FE_SUGGEST });
    await uiWaitFor(async () => (await rowState(a.ui))?.hidden === false, '忙窗口里那排没出现');
    const postsBeforeBusy = a.state.posts.length;
    await clickChip(a.ui, 1);
    await uiWaitFor(async () => a.state.posts.length > postsBeforeBusy, '忙时点建议没有发出请求');
    check('U_busy 忙时（agentBusy=true）点一颗 ⇒ 走 `/steer`（与忙时打字同一条路）',
      a.state.posts.at(-1).path === `/api/sessions/${FE_SESSION}/steer` && a.state.posts.at(-1).body?.text === FE_SUGGEST[0],
      { posts: a.state.posts.map((item) => ({ path: item.path, text: item.body?.text ?? null })) });
    // 对照：忙时**打字**也走 `/steer` —— 两条路逐字同一条（`sendMessageWithBusyFallback`）。
    a.state.posts.length = 0;
    await typeAndSend(a.ui, '忙时打字那条路');
    await uiWaitFor(async () => a.state.posts.length > 0, '忙时打字没有发出请求');
    check('U_path_same 忙时打字也走 `/steer`（与 U_busy 点建议逐字同一条路）',
      a.state.posts.at(-1).path === `/api/sessions/${FE_SESSION}/steer` && a.state.posts.at(-1).body?.text === '忙时打字那条路',
      { posts: a.state.posts.map((item) => ({ path: item.path, text: item.body?.text ?? null })) });
    await a.ui.emit('session.settled', {});

    // 之后每一轮都照**真实服务端的顺序**来：先落新的 assistant 消息 + 收尾事件（前端借此重拉正文、
    // 认出新的尾巴），再发候选事件 —— 候选事件是**回合落定之后**才可能到的。
    let turnIndex = 1;
    const newTurn = async () => {
      turnIndex += 1;
      const entryId = `fe-assistant-${turnIndex}`;
      a.state.messages = [...a.state.messages, { entryId, role: 'assistant', text: `第 ${turnIndex} 轮做完了。`, content: [{ type: 'text', text: `第 ${turnIndex} 轮做完了。` }], parts: [{ type: 'text', text: `第 ${turnIndex} 轮做完了。` }], stopReason: 'stop', images: [] }];
      await a.ui.emit('session.end', { stopReason: 'stop' });
      await sleep(250);
      return entryId;
    };

    const t2 = await newTurn();
    await a.ui.emit('session.suggestions', { messageId: t2, items: ['新一轮的第一句'] });
    await uiWaitFor(async () => (await rowState(a.ui))?.hidden === false, '新一轮的候选没出现');
    // 陈旧 messageId ⇒ 忽略
    await a.ui.emit('session.suggestions', { messageId: FE_STALE_ID, items: ['旧那一排不该上屏'] });
    await sleep(150);
    const afterStale = await rowState(a.ui);
    check('U_stale 陈旧 `messageId` ⇒ 忽略（这一排仍是当前那条消息的候选，没被换成旧的）',
      afterStale.hidden === false && afterStale.texts.join('|') === '新一轮的第一句' && !afterStale.texts.includes('旧那一排不该上屏'),
      { texts: afterStale.texts });

    await a.ui.emit('session.suggestions', { messageId: t2, items: [] });
    await sleep(150);
    check('U_empty 事件里 `items: []` ⇒ 不出这排（不逼模型凑数，也不留上一排）', (await rowState(a.ui)).hidden === true, { row: await rowState(a.ui) });

    // ⌥3 发第三颗
    const t3 = await newTurn();
    await a.ui.emit('session.suggestions', { messageId: t3, items: FE_SUGGEST });
    await uiWaitFor(async () => (await rowState(a.ui))?.hidden === false, '候选那排没回来');
    a.state.posts.length = 0;
    const postsBeforeKey = a.state.posts.length;
    await a.ui.evaluate(`document.querySelector('#prompt').focus()`);
    await a.ui.browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '3', code: 'Digit3', windowsVirtualKeyCode: 51, nativeVirtualKeyCode: 51, modifiers: 1 });
    await a.ui.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '3', code: 'Digit3', windowsVirtualKeyCode: 51, nativeVirtualKeyCode: 51, modifiers: 1 });
    await uiWaitFor(async () => a.state.posts.length > postsBeforeKey, '⌥3 没有把第三颗发出去');
    check('U_keyboard_alt ⌥3 ⇒ 把第三颗发出去（与点它同一条路、正文逐字）',
      a.state.posts.at(-1).body?.text === FE_SUGGEST[2], { text: a.state.posts.at(-1).body?.text ?? null });

    // Esc 收（焦点在输入框里时生效；收起后**本轮不再打扰**）
    const t4 = await newTurn();
    await a.ui.emit('session.suggestions', { messageId: t4, items: FE_SUGGEST });
    await uiWaitFor(async () => (await rowState(a.ui))?.hidden === false, '候选那排没回来（Esc 之前）');
    await a.ui.evaluate(`document.querySelector('#prompt').focus()`);
    await a.ui.browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await a.ui.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await uiWaitFor(async () => (await rowState(a.ui))?.hidden === true, 'Esc 没有收起这一排');
    await a.ui.emit('session.suggestions', { messageId: t4, items: ['收起之后本轮不该回来的'] });
    await sleep(150);
    check('U_keyboard_esc Esc 收起这一排（收起后**本轮不再打扰**：同一条候选再来也不让它回来）',
      (await rowState(a.ui)).hidden === true, { row: await rowState(a.ui) });

    // × 收起（换一轮再验：新的一轮自然复位「已收起」）
    const t5 = await newTurn();
    await a.ui.emit('session.suggestions', { messageId: t5, items: FE_SUGGEST });
    await uiWaitFor(async () => (await rowState(a.ui))?.hidden === false, '候选那排没回来（× 之前）');
    await a.ui.evaluate(`document.querySelector('#suggestions-close').click()`);
    await sleep(100);
    check('U_collapse 点 × ⇒ 收起（元素仍在，只是 hidden）', (await rowState(a.ui)).hidden === true, { row: await rowState(a.ui) });
  } finally {
    await a.ui.close();
  }

  // ── U_refresh / U_not_in_body：刷新后候选仍在（读消息的可选字段），且**不出现在消息正文里** ──
  const b = await bootFrontend({ webRoot, tailSuggestions: FE_SUGGEST });
  try {
    await uiWaitFor(async () => (await rowState(b.ui))?.hidden === false, '刷新之后那排没从可选字段画出来');
    const refreshed = await rowState(b.ui);
    check('U_refresh 刷新后候选**仍在**（来自那条消息的可选字段 `suggestions`，不是内存里留的）',
      refreshed.count === 3 && refreshed.texts.join('|') === FE_SUGGEST.join('|'),
      { texts: refreshed.texts, count: refreshed.count });
    check('U_not_in_body 候选**不出现在消息正文里**（`#messages` 的文本里一个字都没有）',
      FE_SUGGEST.every((item) => !refreshed.messagesText.includes(item)) && refreshed.messagesText.includes('好的，已经做完了第一步。'),
      { messagesTextHead: refreshed.messagesText.slice(0, 120), leaked: FE_SUGGEST.filter((item) => refreshed.messagesText.includes(item)) });
    // 真刷新（location.reload）再读一次：走的是同一个深链（hash）+ 同一条 `/messages`。
    const loaded = b.ui.browser.once('Page.loadEventFired');
    await b.ui.evaluate(`location.reload()`);
    await loaded;
    await uiWaitFor(() => b.ui.evaluate(`document.querySelector('#prompt')?.disabled === false`), '刷新后输入框没就绪', 20_000);
    await uiWaitFor(async () => (await rowState(b.ui))?.hidden === false, '真刷新之后那排没回来');
    const reloaded = await rowState(b.ui);
    check('U_refresh_reload 真 `location.reload()` 之后候选仍在（落盘那份可选字段），且仍不在正文里',
      reloaded.texts.join('|') === FE_SUGGEST.join('|') && FE_SUGGEST.every((item) => !reloaded.messagesText.includes(item)),
      { texts: reloaded.texts, leaked: FE_SUGGEST.filter((item) => reloaded.messagesText.includes(item)) });
  } finally {
    await b.ui.close();
  }

  return { failures, evidence };
}

// ─────────────────────────── 一条臂 = 沙箱 + 服务端臂 + 前端臂 ───────────────────────────
async function runArm({ name, codeRoot, problems }) {
  const sandbox = await startSandbox({ name, codeRoot });
  try {
    const server = await runServerArm(sandbox);
    const frontend = await runFrontendArm({ webRoot: path.join(codeRoot, 'web') });
    return { failures: [...server.failures, ...frontend.failures], server, frontend };
  } finally {
    await stopSandbox(sandbox, problems);
  }
}

// ─────────────────────────── 主流程 ───────────────────────────
const armFlag = (process.argv.find((arg) => arg.startsWith('--arm=')) ?? '--arm=all').slice('--arm='.length);
const problems = [];
let primaryError;
const summary = [];
try {
  if (armFlag === 'all' || armFlag === 'real') {
    const codeRoot = await makeCodeRoot('real', []);
    const result = await runArm({ name: 'real', codeRoot: codeRoot.root, problems });
    print('arm real · 服务端臂结论', { failures: result.server.failures, evidence: result.server.evidence, logLines: result.server.logLines });
    print('arm real · 前端臂结论', { failures: result.frontend.failures });
    assert.equal(result.failures.length, 0, `真代码上三段门必须全绿，实际红：${JSON.stringify(result.failures, null, 2)}`);
    summary.push({ arm: 'real', allGreen: true });
  }

  if (armFlag === 'all' || armFlag === 'mutant-blocking') {
    const codeRoot = await makeCodeRoot('mutant-blocking', ['blocking']);
    print('arm mutant-blocking · 补丁', codeRoot.applied);
    const sandbox = await startSandbox({ name: 'mutant-blocking', codeRoot: codeRoot.root });
    try {
      const result = await runServerArmBlockingProbe(sandbox);
      print('arm mutant-blocking · S_not_blocking + S_not_blocking_scaling（应红）', result);
      assert.equal(result.notBlocking.ok, false, '把生成 await 在主回合收尾之前之后，「按事件序号收尾在前」与「主回合耗时不随旁路时延长」这两条必须红 —— 它们还绿说明这条门没有牙齿');
      assert.equal(result.notBlocking.evidence.seqOrderingOk, false, `突变副本应当重现「候选那帧先于收尾帧」的形状，实际 ${JSON.stringify(result.notBlocking.evidence)}`);
      assert.ok(result.notBlocking.evidence.growthMs > SCALING_GROWTH_LIMIT_MS, `突变副本的主回合耗时应当随旁路时延一起长（>${SCALING_GROWTH_LIMIT_MS}ms），实际 ${JSON.stringify(result.notBlocking.evidence)}`);
      summary.push({ arm: 'mutant-blocking', S_not_blocking: result.notBlocking.ok, shape: result.notBlocking.evidence });
    } finally {
      await stopSandbox(sandbox, problems);
    }
  }

  if (armFlag === 'all' || armFlag === 'mutant-raw') {
    const codeRoot = await makeCodeRoot('mutant-raw', ['raw']);
    print('arm mutant-raw · 补丁', codeRoot.applied);
    const sandbox = await startSandbox({ name: 'mutant-raw', codeRoot: codeRoot.root });
    try {
      const result = await runServerArmRawProbe(sandbox);
      print('arm mutant-raw · S_validated（应红）', result);
      assert.equal(result.validated.ok, false, '跳过 parseSuggestionItems 之后，「校验后的内容才上屏」这条必须红 —— 它还绿说明这条门没有牙齿');
      assert.ok(result.validated.evidence.got.includes(JUNK_LONG), `突变副本应当把未校验的原始输出（含那条 130 字的）直接端上屏，实际 ${JSON.stringify(result.validated.evidence)}`);
      summary.push({ arm: 'mutant-raw', S_validated: result.validated.ok, shape: result.validated.evidence });
    } finally {
      await stopSandbox(sandbox, problems);
    }
  }

  print('推荐回复门（A/B）', { verdict: summary, arms: armFlag });
} catch (error) {
  primaryError = error;
} finally {
  await removeSandbox(TMP, problems);
  finishCleanup(primaryError, problems);
}
