#!/usr/bin/env node
// S4-2 落点门（A/B 红绿）：`handoff` 的 `to.cwd` 不许静默沿用源会话的 cwd，落点必须回读核对。
//
// 为什么有这个文件（2026-09-21 真用户事故，逐字现场在 `~/.pi/profiles/assistant/handoffs.jsonl`）：
//   `{"from":"01a09f25…","to":"a294a11b…","goal":"在~/Documents/godot下重新创建一个会话吧。",
//     "target":{"cwd":"C:\\Users\\user\\Documents\\ai\\sopho-pi"},"ok":true}`
//   ⇒ 调用方**没传** `to.cwd`（那条会话里连一次 handoff 工具调用都没有：pi 的 `/handoff` 命令走
//     `_tryExecuteExtensionCommand` 直接 return，**不落** user 消息/工具记录），而逻辑层的
//     `to.cwd === undefined ? sourceCwd : …` 就**静默**把它当成"同 cwd"，于是新会话被绑进源仓，
//     它第一条任务书（LLM 摘要，照着 goal 写）却说"你在 C:\Users\user\Documents\godot 下工作" ——
//     两边矛盾，四处都没人说，回执还是 ok:true。**最坏的形状**：可靠地错。
//
// 修法（本文件钉住的那三条）：
//   A 不许静默：省略 `to.cwd` 且没写 `to.sameCwd:true` ⇒ `400 handoff_cwd_required`；
//     写了 `to.sameCwd:true` ⇒ 允许，但账上/回执必须写 `cwdSource:"source"`。
//   B 结果可信：建完**回读**新会话自己的 header cwd 与请求目录**逐字**比对，不一致 ⇒ `ok:false`
//     （不许 ok:true）；回执与 `handoffs.jsonl` 带 `requestedCwd/actualCwd/cwdVerified/cwdReadBack`。
//   C 矛盾可见：新会话那条"指路"消息的**第一行**永远是生效的 cwd（回读值），摘要里写别的目录
//     时就摆在眼前（摘要本身一字不改）。
//
// 三条门 + 三条臂（**同一份门代码**，在真代码上必须绿、在突变副本上必须红）：
//   arm real          真代码（未打补丁的副本）          ⇒ G_given/G_omitted/G_caught 三条**全绿**
//   arm inject-wrong  故障注入：落点改成源 cwd（其余不动） ⇒ G_caught **绿**（修法接住了错落点）
//   arm mutant-prefix 把修法去掉（静默回落 + 不回读 + 橡皮章 + 落点改成源 cwd） ⇒ 三条门**全红**
//
// 铁律（与 test/host-session-path-probe.mjs 同口径）：
//   · 只起**自己 spawn** 的沙箱（副本 home + 高位随机端口），只按**精确 pid** 停，**绝不 pkill**；
//   · 端口绝不 7331/7321；日志写沙箱自己的目录，**绝不**写 /tmp/sopho-base*.log；
//   · 会话 id 一律完整 uuid；**绝不碰真 profile**（`~/.pi/profiles/assistant` 只读都不需要）；
//   · 打补丁必须可判定：锚点命中恰好 1 行、该行里 `from` 恰好 1 处、改完逐行只有那一行变、
//     `node --check` 兜底（`patchLineOnce`）——"文本变了"不算证据。
//
// 跑法：node test/s4-handoff-cwd.mjs
//       npm run test:s4hcwd
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, stopOwnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 沙箱放**仓内**：副本里的 `server/base-logic.mjs` 要 import `@earendil-works/pi-coding-agent`，
// 得顺着目录向上找到仓里的 `node_modules`（与 host-session-path-probe.mjs 同一条理由）。
const SANDBOX_ROOT = path.join(ROOT, '.probe-sandbox');
await mkdir(SANDBOX_ROOT, { recursive: true });
const TMP = await mkdtemp(path.join(SANDBOX_ROOT, 'handoff-cwd-'));
const BASE_ENTRY = 'server/base.mjs';
const CODE_ENTRIES = ['server', 'web', 'pi-extensions', 'package.json'];
// 沙箱一律经 `test/sandbox-guard.mjs`（纪律清单第一条）：同生共死（stdin EOF / IPC 断开都拆树）+ 寿命上限。
const GUARD_ENTRY = path.join(ROOT, 'test', 'sandbox-guard.mjs');
const SANDBOX_LIFETIME_MS = Number(process.env.SOPHO_SANDBOX_LIFETIME_MS) || 4 * 60 * 1000;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 打补丁的硬判据（只改命中锚点的那一行；改歪/改不动/改坏都要当场停）
// ---------------------------------------------------------------------------

/** 读一份文件 + 认出它自己的换行风格（两个平台的检出可能是 CRLF 或 LF）。 */
async function readTextWithEol(file) {
  const text = await readFile(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  assert.equal(lines.join(eol), text, `${file}: 按认出的换行风格拼回去必须逐字相同（混合行尾？）`);
  return { eol, lines };
}

async function patchLineOnce({ file, anchor, from, to, what }) {
  const { eol, lines } = await readTextWithEol(file);
  // `anchor` 可以是**正则**（行级）：同一段文本在别的缩进下也出现时，子串锚点会多命中
  // （踩过：`      cwd: targetCwd,` 被 8 空格那一行也 include 进去 ⇒ 命中 2 行）。
  const matches = (line) => (typeof anchor === "string" ? line.includes(anchor) : anchor.test(line));
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

// 突变锚点（都不含行号；哪一行变了会照实印出来）。每条都只改**一行里的一个表达式**。
const SILENT_FALLBACK_ANCHOR = '} else if (to.sameCwd === true) {';
const SILENT_FALLBACK_FROM = 'to.sameCwd === true';
const SILENT_FALLBACK_TO = 'true   /* (mutation: 落点静默沿用源 cwd) */';
const NO_READBACK_ANCHOR = 'const back = await readBackHandoffCwd(';
const NO_READBACK_FROM = 'const back = await readBackHandoffCwd(';
const NO_READBACK_TO = 'const back = ({ file: null, fromHeader: null, fromManager: null, error: null }); void (';
const WRONG_CWD_ANCHOR = /^ {6}cwd: targetCwd,$/;
const WRONG_CWD_FROM = 'cwd: targetCwd,';
const WRONG_CWD_TO = 'cwd: sourceCwd,   /* (mutation: 故障注入，落点改成源 cwd) */';
const RUBBER_STAMP_ANCHOR = 'const cwdVerified = sameCwdText(actualCwd, targetCwd)';
const RUBBER_STAMP_FROM = 'sameCwdText(actualCwd, targetCwd)';
const RUBBER_STAMP_TO = 'true   /* (mutation: 不核对，橡皮章) */';

/** 造一份代码根副本，按 `patches` 打补丁（patches 里每一项都是上面那三个常量之一）。 */
async function makeCodeRoot(name, patches) {
  const root = path.join(TMP, name);
  await mkdir(root, { recursive: true });
  for (const entry of CODE_ENTRIES) await cp(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
  const logicFile = path.join(root, 'server', 'base-logic.mjs');
  const applied = [];
  if (patches.includes('silent-fallback')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: SILENT_FALLBACK_ANCHOR, from: SILENT_FALLBACK_FROM, to: SILENT_FALLBACK_TO, what: '落点静默沿用（去掉 handoff_cwd_required）' }));
  }
  if (patches.includes('no-readback')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: NO_READBACK_ANCHOR, from: NO_READBACK_FROM, to: NO_READBACK_TO, what: '不回读新会话的 cwd' }));
  }
  if (patches.includes('rubber-stamp')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: RUBBER_STAMP_ANCHOR, from: RUBBER_STAMP_FROM, to: RUBBER_STAMP_TO, what: '不核对，只写 cwdVerified:true' }));
  }
  if (patches.includes('wrong-cwd')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: WRONG_CWD_ANCHOR, from: WRONG_CWD_FROM, to: WRONG_CWD_TO, what: '故障注入：新会话建在源 cwd' }));
  }
  await assertParses(logicFile);
  return { root, applied };
}

// ---------------------------------------------------------------------------
// 沙箱：副本 home + 一个只会回一句话的假 provider（摘要由调用方给，provider 只服务子会话那一轮）
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

function sse(response, delta, finishReason = null, includeUsage = false, model = 'fake-s4hc') {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } : {}),
  })}\n\n`);
}

async function startProvider(port, state) {
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    state.requests.push(JSON.parse(raw).messages?.length ?? 0);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    sse(response, { role: 'assistant', content: 'FAKE_S4HC_OK' });
    sse(response, {}, 'stop', true, true);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

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

/** 子会话文件里那条"指路"消息（custom_message 里的 `[handoff 落点]` 头 + `[handoff 指路]`）。 */
async function pointerHead(sessionsDir, childId) {
  const file = (await sessionHeaders(sessionsDir)).find((head) => head.id === childId)?.file;
  if (!file) return null;
  const entries = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const carrier = entries.find((entry) => entry.type === 'custom_message' && typeof entry.content === 'string' && entry.content.includes('[handoff 指路]'));
  return carrier?.content ?? null;
}

/** 一条臂的完整沙箱：代码根 + home + source 会话（cwd = A）+ 目标目录 B。 */
async function startArm({ name, codeRoot, sourceCwd, targetCwd }) {
  const home = path.join(TMP, `home-${name}`);
  const sessionsDir = path.join(home, 'sessions');
  const parentCwd = path.join(TMP, `parent-${name}`);
  for (const dir of [home, sessionsDir, sourceCwd, targetCwd, parentCwd]) await mkdir(dir, { recursive: true });
  const used = new Set();
  const providerPort = await reservePort(used); used.add(providerPort);
  const basePort = await reservePort(used);
  const providerState = { requests: [] };
  const provider = await startProvider(providerPort, providerState);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-s4hc', name: 'Fake S4HC', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-s4hc', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);
  const parentId = randomUUID();
  const parentFile = path.join(sessionsDir, `seed_${parentId}.jsonl`);
  const sourceId = randomUUID();
  const sourceFile = path.join(sessionsDir, `seed_${sourceId}.jsonl`);
  const now = new Date().toISOString();
  await writeFile(parentFile, `${JSON.stringify({ type: 'session', version: 3, id: parentId, timestamp: now, cwd: parentCwd })}\n`);
  await writeFile(sourceFile, [
    { type: 'session', version: 3, id: sourceId, timestamp: now, cwd: sourceCwd, parentSession: parentFile },
    { type: 'model_change', id: '40000001', parentId: null, timestamp: now, provider: 'fake', modelId: 'fake-s4hc' },
    { type: 'message', id: 's4hc-user', parentId: '40000001', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: '源会话在 A 目录里做一件事' }], timestamp: Date.now() } },
  ].map(JSON.stringify).join('\n') + '\n');

  const logPath = path.join(TMP, `base-${name}.log`);
  const log = await open(logPath, 'w');
  // 守卫包住 entry（同生共死 + 寿命上限）；沙箱根的 stdout/stderr 直接继承守卫的 fd 1/2
  // ⇒ 日志还是同一份，`[sandbox-guard]` 前缀的行是拆树原因。
  const guard = spawn(process.execPath, [
    GUARD_ENTRY,
    '--entry', path.join(codeRoot, BASE_ENTRY),
    '--label', `s4hcwd-${name}-${basePort}`,
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
      SOPHO_DEFAULT_CWD: sourceCwd,
      SOPHO_MAX_HOT: '12',
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
  const child = guard;
  const hostPid = started.pid;
  await poll(`${name}: base 就绪`, () => request(basePort, '/host'), (reply) => reply.status === 200, 40_000);
  // 监听端口的必须是守卫报出来的那个沙箱根 pid（不是守卫自己）——按精确 pid + entry 核对。
  assert.equal(await listenerPid(basePort), hostPid, `${name}: 监听端口的必须是我 spawn 的沙箱根 pid`);
  print('sandbox host（经 test/sandbox-guard.mjs 包起）', { arm: name, port: basePort, guardPid: guard.pid, hostPid, listenerPid: await listenerPid(basePort), lifetimeMs: SANDBOX_LIFETIME_MS });
  return { name, home, sessionsDir, sourceCwd, targetCwd, sourceId, parentFile, basePort, providerPort, provider, guard, child, hostPid, exited, log, logPath, providerState, codeRoot };
}

async function stopArm(arm, problems) {
  await cleanupStep(problems, `${arm.name}: 关 provider`, () => new Promise((resolve) => { arm.provider.closeAllConnections(); arm.provider.close(resolve); }));
  await cleanupStep(problems, `${arm.name}: 停沙箱根（精确 pid + 入口核对）`, () => stopOwnedListener(arm.basePort, path.join(arm.codeRoot, BASE_ENTRY), arm.hostPid));
  await cleanupStep(problems, `${arm.name}: 收守树`, async () => {
    const settled = await Promise.race([arm.exited, sleep(15_000).then(() => null)]);
    if (settled === null && arm.child?.pid) {
      try { process.kill(arm.child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
      await arm.exited;
    }
  });
  await cleanupStep(problems, `${arm.name}: 关日志`, () => arm.log?.close());
}

// ---------------------------------------------------------------------------
// 三条门（**同一份代码**，真代码上必须绿、突变副本上必须红）
// ---------------------------------------------------------------------------

/** G_given：给了 to.cwd=B ⇒ 落点必须**逐字**是被请求的 B，且回执/账里带**回读证据**。 */
async function gateGivenCwd(arm) {
  const failures = [];
  const before = (await jsonlFiles(arm.sessionsDir)).length;
  const recordsBefore = (await readHandoffRecords(arm.home)).length;
  const reply = await request(arm.basePort, `/sessions/${arm.sourceId}/handoff`, {
    method: 'POST',
    body: { goal: '到 B 继续', summary: 'GATE_GIVEN_SUMMARY', to: { cwd: arm.targetCwd } },
  });
  if (reply.status !== 200) failures.push(`HTTP 必须是 200，实际 ${reply.status}: ${reply.raw.slice(0, 200)}`);
  const value = reply.value ?? {};
  const record = (await readHandoffRecords(arm.home)).slice(recordsBefore).find((entry) => entry.to === value.to) ?? null;
  const childId = typeof value.to === 'string' ? value.to : null;
  if (childId === null) failures.push(`回执里没有新会话 id：${JSON.stringify(value).slice(0, 200)}`);
  const heads = await sessionHeaders(arm.sessionsDir);
  const childHead = heads.find((head) => head.id === childId) ?? null;
  const placement = childId === null ? null : (await request(arm.basePort, '/placement')).value?.[childId] ?? null;
  const head = childId === null ? null : await poll('G_given: 子会话指路消息', () => pointerHead(arm.sessionsDir, childId), Boolean).catch(() => null);
  const headFirstLine = typeof head === 'string' ? head.split('\n')[0] : null;

  // 1) 落点逐字（header / placement / 账 / 回执四处的 cwd 必须都等于 B）
  if (childHead?.cwd !== arm.targetCwd) failures.push(`header.cwd 必须逐字是 ${arm.targetCwd}，实际 ${JSON.stringify(childHead?.cwd)}`);
  if (placement?.cwd !== arm.targetCwd) failures.push(`placement.cwd 必须逐字是 ${arm.targetCwd}，实际 ${JSON.stringify(placement?.cwd)}`);
  if (record?.target?.cwd !== arm.targetCwd) failures.push(`handoffs.jsonl 的 target.cwd 必须逐字是 ${arm.targetCwd}，实际 ${JSON.stringify(record?.target?.cwd)}`);
  // 2) 回读证据（不许只有"一个目标"就完事）
  if (value.cwd !== arm.targetCwd) failures.push(`回执 cwd（生效值）必须逐字是 ${arm.targetCwd}，实际 ${JSON.stringify(value.cwd)}`);
  if (value.cwdVerified !== true) failures.push(`回执 cwdVerified 必须是 true，实际 ${JSON.stringify(value.cwdVerified)}`);
  if (value.cwdSource !== 'explicit') failures.push(`回执 cwdSource 必须是 explicit，实际 ${JSON.stringify(value.cwdSource)}`);
  if (value.requestedCwd !== arm.targetCwd) failures.push(`回执 requestedCwd 必须是 ${arm.targetCwd}，实际 ${JSON.stringify(value.requestedCwd)}`);
  if (value.cwdReadBack?.fromHeader !== arm.targetCwd) failures.push(`回执 cwdReadBack.fromHeader（**回读值**）必须是 ${arm.targetCwd}，实际 ${JSON.stringify(value.cwdReadBack?.fromHeader)}`);
  if (value.cwdReadBack?.fromManager !== arm.targetCwd) failures.push(`回执 cwdReadBack.fromManager 必须是 ${arm.targetCwd}，实际 ${JSON.stringify(value.cwdReadBack?.fromManager)}`);
  if (value.cwdReadBack?.fromPlacement !== arm.targetCwd) failures.push(`回执 cwdReadBack.fromPlacement 必须是 ${arm.targetCwd}，实际 ${JSON.stringify(value.cwdReadBack?.fromPlacement)}`);
  if (record?.cwdVerified !== true || record?.actualCwd !== arm.targetCwd || record?.requestedCwd !== arm.targetCwd) {
    failures.push(`handoffs.jsonl 必须记 cwdVerified:true / actualCwd:${arm.targetCwd} / requestedCwd:${arm.targetCwd}，实际 ${JSON.stringify(record).slice(0, 240)}`);
  }
  // 3) 矛盾可见：指路消息第一行就是生效的 cwd
  if (headFirstLine === null || !headFirstLine.startsWith('[handoff 落点]')) failures.push(`指路消息必须以 [handoff 落点] 开头，实际 ${JSON.stringify(headFirstLine)}`);
  if (headFirstLine !== null && !headFirstLine.includes(arm.targetCwd)) failures.push(`指路消息第一行必须逐字带生效 cwd ${arm.targetCwd}，实际 ${JSON.stringify(headFirstLine)}`);
  return { ok: failures.length === 0, failures, evidence: { status: reply.status, to: childId, childCwd: childHead?.cwd ?? null, placementCwd: placement?.cwd ?? null, recordCwd: record?.target?.cwd ?? null, cwdVerified: value.cwdVerified ?? null, fromHeader: value.cwdReadBack?.fromHeader ?? null, cwdReadBack: value.cwdReadBack ?? null, headFirstLine, newSessionFiles: (await jsonlFiles(arm.sessionsDir)).length - before } };
}

/** G_omitted：没给 to.cwd、也没写 to.sameCwd ⇒ 必须 400 拒绝（不是静默沿用），且不建会话、不记账。 */
async function gateOmittedCwd(arm) {
  const failures = [];
  const before = (await jsonlFiles(arm.sessionsDir)).length;
  const recordsBefore = (await readHandoffRecords(arm.home)).length;
  const reply = await request(arm.basePort, `/sessions/${arm.sourceId}/handoff`, {
    method: 'POST',
    body: { goal: '在别的目录继续', summary: 'GATE_OMITTED_SUMMARY' },
  });
  if (reply.status !== 400) failures.push(`HTTP 必须是 400（拒绝），实际 ${reply.status}: ${reply.raw.slice(0, 240)}`);
  if (reply.value?.error !== 'handoff_cwd_required') failures.push(`错误码必须是 handoff_cwd_required，实际 ${JSON.stringify(reply.value?.error)}`);
  if (typeof reply.value?.message !== 'string' || !reply.value.message.includes('to.cwd is required')) failures.push(`回执必须说清"要显式给 to.cwd"，实际 ${JSON.stringify(reply.value?.message)}`);
  if (reply.value?.details?.sourceCwd !== arm.sourceCwd) failures.push(`回执必须**明说**会沿用的那个源 cwd（${arm.sourceCwd}），实际 ${JSON.stringify(reply.value?.details?.sourceCwd)}`);
  const after = (await jsonlFiles(arm.sessionsDir)).length;
  if (after !== before) failures.push(`被拒的 handoff 不许建会话文件：${before} → ${after}`);
  const recordsAfter = (await readHandoffRecords(arm.home)).length;
  if (recordsAfter !== recordsBefore) failures.push(`被拒的 handoff 不许往 handoffs.jsonl 记账：${recordsBefore} → ${recordsAfter}`);
  return { ok: failures.length === 0, failures, evidence: { status: reply.status, error: reply.value?.error ?? null, sourceCwd: reply.value?.details?.sourceCwd ?? null, newSessionFiles: after - before } };
}

/** G_caught：**故障注入下的捕获**。真代码：ok:false + cwdVerified:false + 账/指路写明实际落点。
 *  若已把回读去掉（突变），同一个请求会变成 ok:true —— 那正是事故的形状（可靠地错）。 */
async function gateMismatchCaught(arm) {
  const failures = [];
  const recordsBefore = (await readHandoffRecords(arm.home)).length;
  const reply = await request(arm.basePort, `/sessions/${arm.sourceId}/handoff`, {
    method: 'POST',
    body: { goal: '到 B 继续（注入故障那一条）', summary: 'GATE_CAUGHT_SUMMARY', to: { cwd: arm.targetCwd } },
  });
  const value = reply.value ?? {};
  const childId = typeof value.to === 'string' ? value.to : null;
  const record = (await readHandoffRecords(arm.home)).slice(recordsBefore).find((entry) => entry.to === childId) ?? null;
  const heads = await sessionHeaders(arm.sessionsDir);
  const childHead = heads.find((head) => head.id === childId) ?? null;
  const head = childId === null ? null : await poll('G_caught: 子会话指路消息', () => pointerHead(arm.sessionsDir, childId), Boolean).catch(() => null);
  const headFirstLine = typeof head === 'string' ? head.split('\n')[0] : null;

  if (value.ok !== false) failures.push(`请求的落点没生效时**不许** ok:true，实际 ok=${JSON.stringify(value.ok)}（这是事故的形状）`);
  if (value.cwdVerified !== false) failures.push(`回执 cwdVerified 必须是 false，实际 ${JSON.stringify(value.cwdVerified)}`);
  if (childHead?.cwd === arm.targetCwd) failures.push(`这条臂是故障注入（落点应是源 cwd），但 header.cwd 竟然是请求的 ${arm.targetCwd} —— 注入没生效，这一臂无意义`);
  if (record?.actualCwd !== arm.sourceCwd || record?.ok !== false) failures.push(`账里必须 ok:false 且 actualCwd 是**实际**落点 ${arm.sourceCwd}，实际 ${JSON.stringify(record).slice(0, 240)}`);
  if (headFirstLine !== null && !headFirstLine.includes(arm.sourceCwd)) failures.push(`指路消息第一行必须写实际落点 ${arm.sourceCwd}，实际 ${JSON.stringify(headFirstLine)}`);
  if (headFirstLine !== null && !headFirstLine.includes('⚠️')) failures.push(`指路消息第一行必须标出"与实际落点不一致"，实际 ${JSON.stringify(headFirstLine)}`);
  return { ok: failures.length === 0, failures, evidence: { status: reply.status, ok: value.ok ?? null, cwdVerified: value.cwdVerified ?? null, message: (value.message ?? '').slice(0, 200), childCwd: childHead?.cwd ?? null, recordActualCwd: record?.actualCwd ?? null, headFirstLine } };
}

/** G_sameCwd：显式 sameCwd:true ⇒ 允许，但账/回执必须写 cwdSource:"source"。 */
async function gateSameCwd(arm) {
  const failures = [];
  const recordsBefore = (await readHandoffRecords(arm.home)).length;
  const reply = await request(arm.basePort, `/sessions/${arm.sourceId}/handoff`, {
    method: 'POST',
    body: { goal: '在原目录继续', summary: 'GATE_SAMECWD_SUMMARY', to: { sameCwd: true } },
  });
  const value = reply.value ?? {};
  const childId = typeof value.to === 'string' ? value.to : null;
  const record = (await readHandoffRecords(arm.home)).slice(recordsBefore).find((entry) => entry.to === childId) ?? null;
  const childHead = (await sessionHeaders(arm.sessionsDir)).find((head) => head.id === childId) ?? null;
  if (reply.status !== 200 || value.ok !== true) failures.push(`sameCwd:true 必须成功，实际 ${reply.status} ok=${JSON.stringify(value.ok)}: ${reply.raw.slice(0, 200)}`);
  if (value.cwdSource !== 'source') failures.push(`回执必须明写 cwdSource:"source"，实际 ${JSON.stringify(value.cwdSource)}`);
  if (value.cwd !== arm.sourceCwd || childHead?.cwd !== arm.sourceCwd) failures.push(`落点必须是源 cwd ${arm.sourceCwd}（回执 ${JSON.stringify(value.cwd)} / header ${JSON.stringify(childHead?.cwd)}）`);
  if (value.cwdVerified !== true) failures.push(`回读核对必须为 true，实际 ${JSON.stringify(value.cwdVerified)}`);
  if (record?.cwdSource !== 'source' || record?.actualCwd !== arm.sourceCwd) failures.push(`账里必须记 cwdSource:"source" + actualCwd:${arm.sourceCwd}，实际 ${JSON.stringify(record).slice(0, 240)}`);
  return { ok: failures.length === 0, failures, evidence: { status: reply.status, ok: value.ok ?? null, cwdSource: value.cwdSource ?? null, cwd: value.cwd ?? null, childCwd: childHead?.cwd ?? null } };
}

// ---------------------------------------------------------------------------
// 跑三条臂
// ---------------------------------------------------------------------------

const problems = [];
let primaryError;
const summary = [];
try {
  // ---- arm real：真代码（未打补丁的副本），三条门必须绿
  {
    const codeRoot = await makeCodeRoot('real', []);
    const arm = await startArm({
      name: 'real',
      codeRoot: codeRoot.root,
      sourceCwd: path.join(TMP, 'real-source'),
      targetCwd: path.join(TMP, 'real-target'),
    });
    try {
      const gates = {
        G_given: await gateGivenCwd(arm),
        G_omitted: await gateOmittedCwd(arm),
        G_sameCwd: await gateSameCwd(arm),
      };
      for (const [name, gate] of Object.entries(gates)) {
        print(`arm real · ${name}`, gate);
        assert.equal(gate.ok, true, `真代码上 ${name} 必须绿，实际红：${JSON.stringify(gate.failures)}`);
      }
      summary.push({ arm: 'real', G_given: gates.G_given.ok, G_omitted: gates.G_omitted.ok, G_sameCwd: gates.G_sameCwd.ok });
    } finally {
      await stopArm(arm, problems);
    }
  }

  // ---- arm inject-wrong：只注入"落点改成源 cwd"，回读照旧 ⇒ G_caught 必须绿（修法接住了）
  {
    const codeRoot = await makeCodeRoot('inject-wrong', ['wrong-cwd']);
    print('arm inject-wrong · 补丁', codeRoot.applied);
    const arm = await startArm({
      name: 'inject-wrong',
      codeRoot: codeRoot.root,
      sourceCwd: path.join(TMP, 'inject-source'),
      targetCwd: path.join(TMP, 'inject-target'),
    });
    try {
      const gate = await gateMismatchCaught(arm);
      print('arm inject-wrong · G_caught', gate);
      assert.equal(gate.ok, true, `注入错落点后，修法必须如实报 ok:false 并写明实际落点；实际红：${JSON.stringify(gate.failures)}`);
      summary.push({ arm: 'inject-wrong', G_caught: gate.ok });
    } finally {
      await stopArm(arm, problems);
    }
  }

  // ---- arm mutant-prefix：把修法全去掉（静默回落 + 不回读 + 橡皮章 + 注入错落点）⇒ 三条门必须**全红**
  {
    const codeRoot = await makeCodeRoot('mutant-prefix', ['silent-fallback', 'no-readback', 'rubber-stamp', 'wrong-cwd']);
    print('arm mutant-prefix · 补丁', codeRoot.applied);
    const arm = await startArm({
      name: 'mutant-prefix',
      codeRoot: codeRoot.root,
      sourceCwd: path.join(TMP, 'mutant-source'),
      targetCwd: path.join(TMP, 'mutant-target'),
    });
    try {
      // 「不给落点」在突变副本里会被静默沿用 ⇒ G_omitted 必红（400 变成 200 + target.cwd 变成源 cwd）
      const omitted = await gateOmittedCwd(arm);
      print('arm mutant-prefix · G_omitted（应红）', omitted);
      assert.equal(omitted.ok, false, '把"不许静默沿用"去掉后，G_omitted 必须红 —— 它仍然绿说明这条门没有牙齿');
      assert.equal(omitted.evidence.status, 200, `突变副本应当重现事故形状（200 + 静默沿用），实际 ${omitted.evidence.status}：${JSON.stringify(omitted.evidence)}`);
      // 「给了 to.cwd」在突变副本里仍然会落对（落点被注入改掉了 ⇒ 用 G_caught 看它有没有说真话）
      const caught = await gateMismatchCaught(arm);
      print('arm mutant-prefix · G_caught（应红）', caught);
      assert.equal(caught.ok, false, '把"回读核对"去掉后，G_caught 必须红 —— 它仍然绿说明这条门没有牙齿');
      assert.equal(caught.evidence.ok, true, `突变副本应当重现"ok:true 而 cwd 不对"，实际 ${JSON.stringify(caught.evidence)}`);
      summary.push({ arm: 'mutant-prefix', G_omitted: omitted.ok, G_caught: caught.ok, silentFallbackShape: omitted.evidence, worstShape: caught.evidence });
    } finally {
      await stopArm(arm, problems);
    }
  }

  print('S4-2 落点门（A/B）', { verdict: summary, allGreen: true });
} catch (error) {
  primaryError = error;
} finally {
  await removeSandbox(TMP, problems);
  finishCleanup(primaryError, problems);
}
