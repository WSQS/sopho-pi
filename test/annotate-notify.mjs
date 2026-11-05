#!/usr/bin/env node
// test/annotate-notify.mjs —— 卡片级反馈的「到达即知道」门（业主 2026-09-22 拍的 ②：
// 「指定一个维护者会话作为通知目标」）。
//
// 判据出处：`docs/design-annotations.md` §8（配置 ＋ 事件 ＋ 唤醒消息三层，缺一不可）。
// 这一门钉的就是那三层在**真宿主 + 真 worker + 真会话**上的行为：
//
//   臂 S（服务端；两臂共用同一份门代码：`arm real` 真代码副本 / `arm mutant` 把「发唤醒消息」那一步去掉）：
//     ① 配好维护者会话（`PATCH /settings {'annotations.notifySession'}`）后 `POST /annotations` 一条 ⇒
//        · 维护者会话**恰好收到 1 条**唤醒消息（`sopho.annotation` 的自定义条目），正文含该 id 与 `resolve` 指引；
//        · 维护者会话的 SSE 收到 `session.annotation`，载荷里的字段**逐字**是那一条（id/note/kind/sessionId/
//          messageId/blockIndex/toolCallId/at）。
//     ② 一个窗口（门里用 `SOPHO_ANNOTATION_NOTIFY_WINDOW_MS=600` 把 30s 压短）内连发 3 条 ⇒
//        **只多 1 条**消息、正文说「共 3 条」；SSE 也只有 1 帧（`count:3`）。
//     ③ 维护者留空（`''`）⇒ **不叫**（退回现状）；POST 回执说清是「关着的」。
//     ④ 维护者会话**自己**标注 ⇒ 不通知自己。
//     ⑤ 维护者不存在 / 已归档 ⇒ **不崩**（POST 仍 201）、**不静默**：`GET /annotations` 的 `notify.last`
//        如实带 `failed` / `session_archived`，宿主日志里也有那一条（断言原文）。
//     ⑥ 防环：这一门跑完，`annotations.jsonl` 的条数**恰好**等于我们 POST 的次数（通知不产生新标注）。
//     ⑦ 配置项形状：坏值/未知键照旧诚实 400；**没设旋钮时窗口默认 30s**（另起一台最短命的沙箱读 `GET /annotations`）。
//
//     反证臂（`arm mutant`）：把 `session.sendCustomMessage(...)` 那一步换成 `Promise.resolve(...)`
//     （**只留 SSE 事件**）⇒ ① 的消息那一半**必红** —— 这条红就是这句话的证据：
//     **光发事件对空闲会话没用**（空闲没有订阅者）。
//
//   臂 U（真 Chromium + 假 API）：维护者会话的页面收到 `session.annotation` 时**看得见**痕迹 ——
//     ① 瞬时会话通知行（与插件 notify 同一行、同一套语言）；② 那一条 `aside.extra-message
//     [data-custom-type="sopho.annotation"]` 被重拉出来（正文含 id 与 resolve 指引）；
//     ③ 它**不是**消息卡/工具卡 ⇒ 没有标注按钮（通知不会再产生新标注 = 防环的前端那一半）。
//
// 沙箱纪律（照 `test/s4-durable-source.mjs`）：只起**自己 spawn** 的沙箱（副本 home + 高位随机端口 +
// 假 provider + `test/sandbox-guard.mjs` 包起的宿主）；只按**精确 pid** 停；绝不 `pkill`/按命令行匹配；
// 端口绝不 7331/7321；日志写在沙箱自己的目录；真 profile 一个字节都不碰。
//
// 跑法：CHROME_BIN='C:/Users/user/AppData/Local/Chromium/Application/chrome.exe' node test/annotate-notify.mjs
//       npm run test:annotatenotify
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, stopOwnedListener } from './harness.mjs';
import { poll, request as libRequest, reserveHighPort, sleep } from './perf-verify-lib.mjs';
import { boot, readBody, sendJson, waitFor as uiWaitFor } from './ui-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 打开的日志句柄必须活到我们亲自 close 那一刻：Node 25 把「FileHandle 在 GC 里被关掉」从
// 弃用警告改成了**硬错误**（`ERR_INVALID_STATE`，进程当场死、连门自己的输出都丢）。
// 只写在 `startArm` 的局部变量里不够 —— 中间那些 `await`（等宿主就绪可能几十秒）里 V8 可以
// 判定它已死。这一个 Set 就是“别收它”的机械保证；close 之后从 Set 里摘掉。
const liveLogHandles = new Set();
// 沙箱放**仓内**：副本里的 `server/base-logic.mjs` 要 import `@earendil-works/pi-coding-agent`，
// 得顺着目录向上找到仓里的 `node_modules`（与 `test/s4-durable-source.mjs` 同一条理由）。
const SANDBOX_ROOT = path.join(ROOT, '.probe-sandbox');
await mkdir(SANDBOX_ROOT, { recursive: true });
const TMP = await mkdtemp(path.join(SANDBOX_ROOT, 'annotate-notify-'));
const BASE_ENTRY = 'server/base.mjs';
const CODE_ENTRIES = ['server', 'web', 'pi-extensions', 'package.json'];
const GUARD_ENTRY = path.join(ROOT, 'test', 'sandbox-guard.mjs');
const SANDBOX_LIFETIME_MS = Number(process.env.SOPHO_SANDBOX_LIFETIME_MS) || 6 * 60 * 1000;
const SANDBOX_MAX_HOT = '16';
// 门里的窗口：把 30s 压到 600ms（旋钮的语义就是「可配窗口」，默认值另有 ⑦ 一条最短命的沙箱专门验）。
const NOTIFY_WINDOW_MS = '600';
// 窗口默认值（`server/base-logic.mjs` 的 `ANNOTATION_NOTIFY_DEFAULT_WINDOW_MS`）—— 只在这里当**断言值**用，
// 不当作"抄一遍常量"：⑦ 的那一台沙箱不设旋钮，读 `GET /annotations` 的 `notify.windowMs` 与它比。
const EXPECTED_DEFAULT_WINDOW_MS = 30_000;
const ARTIFACTS = path.join(TMP, 'artifacts');

let checks = 0;
const failures = [];
const problems = [];
function check(name, ok, detail) {
  if (ok) {
    checks += 1;
    process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
    return true;
  }
  failures.push(name);
  process.stdout.write(`✗ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  return false;
}
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

// `perf-verify-lib.request` 回的是 `{statusCode, value, raw}`；本门里一律用 `reply.status`（与
// `test/annotate.mjs` 等门同一把尺子）—— 就在这一个地方抹平，不把两种叫法散到断言里。
const request = async (port, pathname, options) => {
  const reply = await libRequest(port, pathname, options);
  return { ...reply, status: reply.statusCode };
};
async function api(port, pathname, { method = 'GET', body } = {}) {
  return request(port, pathname, { method, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 30_000 });
}

// ---------------------------------------------------------------------------
// 突变（照 `test/s4-durable-source.mjs` 的硬判据：锚点恰好 1 行、该行里 `from` 恰好 1 处、只改那一行）
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
  const hits = lines.map((line, index) => (line.includes(anchor) ? index : -1)).filter((index) => index >= 0);
  assert.equal(hits.length, 1, `${file}: 锚点 ${JSON.stringify(anchor)} 必须恰好命中 1 行，实际 ${hits.length} 行（${what}）`);
  const index = hits[0];
  const before = lines[index];
  const occurrences = before.split(from).length - 1;
  assert.equal(occurrences, 1, `${file}: 第 ${index + 1} 行里 ${JSON.stringify(from)} 必须恰好 1 处，实际 ${occurrences} 处（${what}）\n该行逐字：${before}`);
  const nextLines = [...lines];
  nextLines[index] = before.replace(from, to);
  const changed = nextLines.map((line, i) => (line === lines[i] ? null : i + 1)).filter((value) => value !== null);
  assert.deepEqual(changed, [index + 1], `${file}: 打补丁只许改第 ${index + 1} 行，实际改了 ${JSON.stringify(changed)} 行（${what}）`);
  const next = nextLines.join(eol);
  await writeFile(file, next, 'utf8');
  assert.equal(await readFile(file, 'utf8'), next, `${file}: 写回的字节必须与打算写的一致（${what}）`);
  return { line: index + 1, before: before.trim(), after: nextLines[index].trim() };
}

async function assertParses(file) {
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', file], (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} 打补丁后解析失败（node --check）：${stderr || stdout || error.message}`));
      else resolve();
    });
  });
}

// 突变锚点（**只改那一行里的一个表达式**）：把「投一条唤醒消息」那一步去掉，只留 `emit('session.annotation', …)`。
const WAKE_SEND_FROM = "const background = session.sendCustomMessage(wakeMessage, { triggerTurn: true, deliverAs: mode === 'steer' ? 'steer' : mode === 'followUp' ? 'followUp' : undefined });";
const WAKE_SEND_TO = "const background = Promise.resolve(null);   /* (mutation: 不发唤醒消息 —— 只留 SSE 事件) */";
const WAKE_CLAIM_FROM = "return { delivered: true, count: items.length, mode, queued: mode === 'followUp' };";
const WAKE_CLAIM_TO = "return { delivered: false, count: items.length, reason: 'mutation_no_wake_message', mode: null, queued: false };";

async function makeCodeRoot(name, patches) {
  const root = path.join(TMP, name);
  await mkdir(root, { recursive: true });
  for (const entry of CODE_ENTRIES) await cp(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
  const logicFile = path.join(root, 'server', 'base-logic.mjs');
  const applied = [];
  if (patches.includes('no-wake-message')) {
    applied.push(await patchLineOnce({ file: logicFile, anchor: WAKE_SEND_FROM, from: WAKE_SEND_FROM, to: WAKE_SEND_TO, what: '去掉「投一条唤醒消息」那一步' }));
    applied.push(await patchLineOnce({ file: logicFile, anchor: WAKE_CLAIM_FROM, from: WAKE_CLAIM_FROM, to: WAKE_CLAIM_TO, what: '回执不许再声称投出去了（突变副本说真话）' }));
  }
  await assertParses(logicFile);
  return { root, applied };
}

// ---------------------------------------------------------------------------
// 假 provider（一个只会回一句话的 OpenAI 兼容端点）—— 唤醒消息会触发一轮回复，
// 真跑一轮才能让「消息真的落进会话文件」这条断言有牙。
// ---------------------------------------------------------------------------

function sseChunk(response, delta, finishReason = null, includeUsage = false) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-annotate-notify',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage ? { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } } : {}),
  })}\n\n`);
}

async function startProvider(port, state) {
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of incoming) raw += chunk;
    state.requests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    sseChunk(response, { role: 'assistant', content: 'FAKE_ANNOTATE_NOTIFY_OK' });
    sseChunk(response, {}, 'stop', true);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

// ---------------------------------------------------------------------------
// 沙箱起停
// ---------------------------------------------------------------------------

async function startArm({ name, codeRoot, notifyWindowMs = NOTIFY_WINDOW_MS, withProvider = true }) {
  const home = path.join(TMP, `home-${name}`);
  const sessionsDir = path.join(home, 'sessions');
  const cwd = path.join(TMP, `cwd-${name}`);
  for (const dir of [home, sessionsDir, cwd]) await mkdir(dir, { recursive: true });
  const used = new Set();
  const providerPort = withProvider ? await reserveHighPort() : null;
  if (providerPort) used.add(providerPort);
  const basePort = await reserveHighPort();
  const providerState = { requests: 0 };
  const provider = withProvider ? await startProvider(providerPort, providerState) : null;
  if (withProvider) {
    await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-annotate-notify', name: 'Fake Annotate Notify', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
    await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-annotate-notify', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);
  }
  const logPath = path.join(TMP, `base-${name}.log`);
  const log = await open(logPath, 'w');
  liveLogHandles.add(log);
  const env = {
    ...process.env,
    HOME: home,
    ASSIST_HOME: home,
    SOPHO_AGENT_DIR: home,
    PI_CODING_AGENT_DIR: home,
    PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    PI_OFFLINE: '1',
    SOPHO_HOST: '127.0.0.1',
    SOPHO_PORT: String(basePort),
    SOPHO_DEFAULT_CWD: cwd,
    SOPHO_MAX_HOT: SANDBOX_MAX_HOT,
  };
  if (notifyWindowMs === null) delete env.SOPHO_ANNOTATION_NOTIFY_WINDOW_MS;
  else env.SOPHO_ANNOTATION_NOTIFY_WINDOW_MS = String(notifyWindowMs);
  const guard = spawn(process.execPath, [
    GUARD_ENTRY,
    '--entry', path.join(codeRoot, BASE_ENTRY),
    '--label', `annotate-notify-${name}-${basePort}`,
    '--lifetime-ms', String(SANDBOX_LIFETIME_MS),
    '--watch-stdin',
  ], { cwd: codeRoot, env, stdio: ['pipe', log.fd, log.fd, 'ipc'], detached: true });
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
  // ⚠️ 实情：沙箱宿主在这里要十几秒才真正 listen（副本树的首次加载/扫描，Windows 上尤其明显）。
  // 所以必须**轮询**等它，不能只发一发就当它应了（照 `test/annotate.mjs` 的 `poll('base ready', …)`）。
  await poll(`${name}: 宿主就绪（GET /host）`, () => request(basePort, '/host', { timeoutMs: 5_000 }), (reply) => reply.status === 200, 90_000);
  assert.equal(await listenerPid(basePort), started.pid, `${name}: 监听端口的必须是我 spawn 的沙箱根 pid`);
  print('sandbox host（经 test/sandbox-guard.mjs 包起）', { arm: name, basePort, guardPid: guard.pid, hostPid: started.pid, notifyWindowMs, providerPort, logPath });
  return { name, home, sessionsDir, cwd, basePort, providerPort, provider, providerState, guard, exited, log, logPath, codeRoot, hostPid: started.pid };
}

async function stopArm(arm, problems) {
  if (arm.provider) await cleanupStep(problems, `${arm.name}: 关 provider`, () => new Promise((resolve) => { arm.provider.closeAllConnections?.(); arm.provider.close(resolve); }));
  await cleanupStep(problems, `${arm.name}: 停沙箱根（精确 pid + 入口核对）`, () => stopOwnedListener(arm.basePort, path.join(arm.codeRoot, BASE_ENTRY), arm.hostPid));
  await cleanupStep(problems, `${arm.name}: 收守树`, async () => {
    const settled = await Promise.race([arm.exited, sleep(15_000).then(() => null)]);
    if (settled === null && arm.guard?.pid) {
      try { process.kill(arm.guard.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
      await arm.exited;
    }
  });
  await cleanupStep(problems, `${arm.name}: 关日志`, async () => {
    liveLogHandles.delete(arm.log);
    await arm.log?.close();
  });
}

// ---------------------------------------------------------------------------
// 沙箱里的小工具
// ---------------------------------------------------------------------------

async function createSession(arm, name, cwd = arm.cwd) {
  const reply = await api(arm.basePort, '/sessions', { method: 'POST', body: { cwd, name } });
  assert.equal(reply.status, 201, `${arm.name}: 建会话必须 201，实际 ${reply.status}: ${reply.raw.slice(0, 200)}`);
  const id = reply.value?.id;
  assert.match(id, /^[0-9a-f-]{36}$/, `${arm.name}: 会话 id 形状不对：${JSON.stringify(id)}`);
  return id;
}

async function setMaintainer(arm, sessionId) {
  const reply = await api(arm.basePort, '/settings', { method: 'PATCH', body: { 'annotations.notifySession': sessionId } });
  assert.equal(reply.status, 200, `${arm.name}: PATCH /settings 必须 200，实际 ${reply.status}: ${reply.raw.slice(0, 200)}`);
  return reply.value;
}

async function postAnnotation(arm, body) {
  return api(arm.basePort, '/annotations', { method: 'POST', body });
}

/** 维护者会话里那些「唤醒消息」的自定义条目（`/messages` 的 extras）。 */
async function wakeMessages(arm, sessionId) {
  const reply = await api(arm.basePort, `/sessions/${sessionId}/messages`);
  return (reply.value?.extras ?? []).filter((entry) => entry.customType === 'sopho.annotation');
}

async function annotationLedger(arm) {
  const file = path.join(arm.home, 'annotations.jsonl');
  const text = await readFile(file, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
  if (text === null) return { lines: 0, creates: 0, resolves: 0 };
  const rows = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  return { lines: rows.length, creates: rows.filter((row) => (row.op ?? 'annotate') === 'annotate').length, resolves: rows.filter((row) => row.op === 'resolve').length };
}

/** 维护者会话的 SSE：连上、收帧、按需取走（门里用它断言 `session.annotation` 的载荷）。 */
async function openSessionStream(arm, sessionId) {
  const chunks = [];
  const req = http.get({ host: '127.0.0.1', port: arm.basePort, path: `/sessions/${sessionId}/events`, headers: { accept: 'text/event-stream' } }, (reply) => {
    reply.setEncoding('utf8');
    reply.on('data', (chunk) => chunks.push(chunk));
  });
  req.on('error', (error) => chunks.push(`ERR ${error.message}`));
  const state = {
    raw: () => chunks.join(''),
    frames: (name) => chunks.join('').split('\n\n').filter((frame) => frame.includes(`event: ${name}`)),
    close: () => { try { req.destroy(); } catch { /* already gone */ } },
  };
  await poll(`${arm.name}: 维护者会话 SSE 连上`, async () => state.raw().includes('event: session.snapshot'), Boolean, 10_000);
  return state;
}

function annotationFramePayload(frame) {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, `帧里没有 data 行：${JSON.stringify(frame).slice(0, 200)}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

function baseLogLines(arm, needle) {
  return readFile(arm.logPath, 'utf8').then((text) => text.split('\n').filter((line) => line.includes(needle)));
}

// ---------------------------------------------------------------------------
// ① + ② 正向：配好维护者 ⇒ 一条唤醒（恰一条）＋ SSE 载荷逐字；窗口内 3 条 ⇒ 只唤醒一次且说「共 3 条」
// ---------------------------------------------------------------------------

async function gateWakeAndCoalesce(arm) {
  const failures = [];
  const evidence = {};
  const maintainerId = await createSession(arm, `${arm.name} 维护者`);
  await setMaintainer(arm, maintainerId);
  const stream = await openSessionStream(arm, maintainerId);
  const annotatedSession = randomUUID();
  const ledgerBefore = await annotationLedger(arm);
  try {
    // ── ① 一条 ───────────────────────────────────────────────────────────────────────────
    const first = await postAnnotation(arm, {
      note: '这条正文讲得不清楚，请维护者看一眼。', kind: 'message', sessionId: annotatedSession,
      messageId: 'a-1', blockIndex: 1, role: 'assistant', excerpt: '助手正文：我跑了个命令。',
    });
    if (first.status !== 201) failures.push(`① 合法标注必须 201，实际 ${first.status}: ${first.raw.slice(0, 200)}`);
    const firstId = first.value?.annotation?.id ?? null;
    evidence.firstReceipt = { status: first.status, notify: first.value?.notify ?? null, id: firstId };
    if (first.value?.notify?.status !== 'queued') failures.push(`① POST 回执必须说这已经排进待发批次（notify.status='queued'），实际 ${JSON.stringify(first.value?.notify)}`);
    if (first.value?.notify?.maintainerSessionId !== maintainerId) failures.push(`① 回执里的 maintainerSessionId 必须逐字是配的那条，实际 ${JSON.stringify(first.value?.notify?.maintainerSessionId)}`);

    let landed = [];
    try {
      landed = await poll(`${arm.name}: ① 唤醒消息落地`, () => wakeMessages(arm, maintainerId), (items) => items.length >= 1, 12_000);
    } catch (error) {
      failures.push(`① 维护者会话没有收到唤醒消息（${error.message}）`);
    }
    evidence.wakeMessages = landed.map((entry) => ({ customType: entry.customType, kind: entry.details?.kind, ids: entry.details?.ids, textHead: String(entry.text ?? '').slice(0, 200) }));
    if (landed.length !== 1) failures.push(`① 必须**恰好 1 条**唤醒消息，实际 ${landed.length} 条`);
    const wakeText = String(landed[0]?.text ?? '');
    if (firstId === null || !wakeText.includes(firstId)) failures.push(`① 唤醒消息正文必须带那条的 id（${firstId}），实际正文：${JSON.stringify(wakeText.slice(0, 300))}`);
    if (!wakeText.includes('resolve')) failures.push(`① 唤醒消息正文必须带 \`resolve\` 指引（处理完怎么回写），实际正文：${JSON.stringify(wakeText.slice(0, 300))}`);
    if (!wakeText.includes('共 1 条')) failures.push(`① 一条的那一批，正文必须说「共 1 条」，实际：${JSON.stringify(wakeText.slice(0, 120))}`);
    if (landed[0]?.details?.kind !== 'annotation.feedback') failures.push(`① 唤醒消息的 details.kind 必须是 annotation.feedback，实际 ${JSON.stringify(landed[0]?.details)}`);

    // ── ① SSE：载荷逐字 ─────────────────────────────────────────────────────────────────
    const frames = stream.frames('session.annotation');
    evidence.sseFrames = frames.map((frame) => annotationFramePayload(frame));
    if (frames.length !== 1) failures.push(`① 维护者会话的 SSE 必须收**恰好 1 帧** session.annotation，实际 ${frames.length} 帧`);
    const payload = frames.length === 1 ? annotationFramePayload(frames[0]) : null;
    if (payload) {
      const item = Array.isArray(payload.items) ? payload.items[0] : null;
      if (payload.count !== 1 || payload.maintainerSessionId !== maintainerId) failures.push(`① 事件载荷的 count/maintainerSessionId 不对：${JSON.stringify({ count: payload.count, maintainerSessionId: payload.maintainerSessionId })}`);
      const anchors = item === null ? null : { id: item.id, note: item.note, kind: item.kind, sessionId: item.sessionId, messageId: item.messageId, blockIndex: item.blockIndex, toolCallId: item.toolCallId, at: item.at };
      if (JSON.stringify(anchors) !== JSON.stringify({ id: firstId, note: '这条正文讲得不清楚，请维护者看一眼。', kind: 'message', sessionId: annotatedSession, messageId: 'a-1', blockIndex: 1, toolCallId: null, at: (first.value?.annotation?.at ?? null) })) {
        failures.push(`① 事件载荷条目字段必须**逐字**是那一条，实际 ${JSON.stringify(anchors)}`);
      }
    }

    // ── ② 窗口内 3 条 ⇒ 只唤醒一次、正文说「共 3 条」 ─────────────────────────────────────
    const wakesBeforeBatch = (await wakeMessages(arm, maintainerId)).length;
    const framesBeforeBatch = stream.frames('session.annotation').length;
    const ids = [];
    for (const index of [1, 2, 3]) {
      const posted = await postAnnotation(arm, {
        note: `窗口内第 ${index} 条反馈`, kind: index === 3 ? 'toolResult' : 'message', sessionId: annotatedSession,
        messageId: `a-${index + 1}`, blockIndex: index + 1, ...(index === 3 ? { toolCallId: 'call_00_batch', toolName: 'bash' } : { role: 'assistant' }),
      });
      if (posted.status !== 201) failures.push(`② 第 ${index} 条必须 201，实际 ${posted.status}: ${posted.raw.slice(0, 160)}`);
      ids.push(posted.value?.annotation?.id ?? null);
    }
    await poll(`${arm.name}: ② 这一批的唤醒消息落地`, () => wakeMessages(arm, maintainerId), (items) => items.length > wakesBeforeBatch, 12_000).catch((error) => failures.push(`② 3 条之后没有新的唤醒消息（${error.message}）`));
    // 再等一个窗口：确认**没有第二条**（合并真的生效，不是"先到先发、后两条下一轮"）。
    await sleep(Number(NOTIFY_WINDOW_MS) * 2);
    const wakesAfterBatch = await wakeMessages(arm, maintainerId);
    const batchWakes = wakesAfterBatch.slice(wakesBeforeBatch);
    evidence.batchWakes = { added: batchWakes.length, ids, text: String(batchWakes[0]?.text ?? '').slice(0, 260) };
    if (batchWakes.length !== 1) failures.push(`② 窗口内连发 3 条必须**只加 1 条**唤醒消息，实际加了 ${batchWakes.length} 条`);
    if (!String(batchWakes[0]?.text ?? '').includes('共 3 条')) failures.push(`② 合并后的正文必须说「共 3 条」，实际：${JSON.stringify(String(batchWakes[0]?.text ?? '').slice(0, 160))}`);
    if (JSON.stringify(batchWakes[0]?.details?.ids ?? null) !== JSON.stringify(ids)) failures.push(`② 唤醒消息的 details.ids 必须逐字是那 3 条，实际 ${JSON.stringify(batchWakes[0]?.details?.ids)} vs ${JSON.stringify(ids)}`);
    const batchFrames = stream.frames('session.annotation').slice(framesBeforeBatch);
    if (batchFrames.length !== 1) failures.push(`② 这一批的 SSE 必须**恰好 1 帧** session.annotation，实际 ${batchFrames.length} 帧`);
    if (batchFrames.length === 1) {
      const batchPayload = annotationFramePayload(batchFrames[0]);
      if (batchPayload.count !== 3 || (batchPayload.items ?? []).length !== 3) failures.push(`② 事件载荷必须是这 3 条（count:3），实际 ${JSON.stringify({ count: batchPayload.count, items: (batchPayload.items ?? []).length })}`);
    }

    // 只读诊断也要与事实一致。
    const report = (await api(arm.basePort, '/annotations')).value?.notify ?? null;
    evidence.report = report;
    if (report?.configStatus !== 'ok' || report?.configured !== maintainerId) failures.push(`诊断块必须如实报「配的是谁」，实际 ${JSON.stringify({ configStatus: report?.configStatus, configured: report?.configured })}`);
    if (report?.last?.status !== 'delivered') failures.push(`诊断块的 last.status 必须是 delivered，实际 ${JSON.stringify(report?.last)}`);
    if (report?.last?.mode !== 'message' || report?.last?.queued !== false) failures.push(`诊断块必须如实报这一批是立即投递（mode=message/queued=false），实际 ${JSON.stringify(report?.last)}`);
    if (report?.windowMs !== Number(NOTIFY_WINDOW_MS)) failures.push(`诊断块必须如实报窗口（旋钮值 ${NOTIFY_WINDOW_MS}），实际 ${JSON.stringify(report?.windowMs)}`);
    if (report?.pending !== 0) failures.push(`窗口到点之后待发队列必须空，实际 pending=${JSON.stringify(report?.pending)}`);

    // ── ⑥ 防环：通知不产生新标注（账本条数 == 我们 POST 的次数） ──────────────────────────
    const ledgerAfter = await annotationLedger(arm);
    evidence.ledger = { before: ledgerBefore, after: ledgerAfter, posts: 4 };
    if (ledgerAfter.creates !== ledgerBefore.creates + 4) failures.push(`⑥ 账本里应当恰好多出 4 条创建行（通知不许自己产生标注），实际 ${ledgerBefore.creates} → ${ledgerAfter.creates}`);
    if (ledgerAfter.resolves !== ledgerBefore.resolves) failures.push(`⑥ 这一门里没有人 resolve，事件行不许变化：${ledgerBefore.resolves} → ${ledgerAfter.resolves}`);

    // 唤醒消息在会话文件里是 `custom_message`（不是 role 消息 ⇒ 卡片上没有标注按钮）。
    const sessionFiles = await readSessionEntries(arm.sessionsDir, maintainerId);
    const wakeEntries = sessionFiles.filter((entry) => entry.type === 'custom_message' && entry.customType === 'sopho.annotation');
    evidence.sessionEntries = { total: sessionFiles.length, wakeEntries: wakeEntries.length, wakeShape: wakeEntries.map((entry) => ({ type: entry.type, customType: entry.customType, display: entry.display })) };
    if (wakeEntries.length !== 2) failures.push(`⑥ 维护者会话文件里应当恰好 2 条 sopho.annotation 自定义条目（两批各一条），实际 ${wakeEntries.length}`);
    if (wakeEntries.some((entry) => entry.type !== 'custom_message')) failures.push(`⑥ 唤醒消息必须是 custom_message 条目（不是 role 消息），实际 ${JSON.stringify(evidence.sessionEntries.wakeShape)}`);
  } finally {
    stream.close();
  }
  return { ok: failures.length === 0, failures, evidence };
}

async function readSessionEntries(sessionsDir, sessionId) {
  const names = await readdir(sessionsDir);
  const match = names.find((name) => name.includes(sessionId) && name.endsWith('.jsonl'));
  if (!match) return [];
  const text = await readFile(path.join(sessionsDir, match), 'utf8');
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// ③ 留空 = 不通知（退回现状） ④ 维护者自己标注自己不通知
// ---------------------------------------------------------------------------

async function gateDisabledAndSelf(arm) {
  const failures = [];
  const evidence = {};

  // ③ 留空
  const maintainerId = await createSession(arm, `${arm.name} 留空维护者`);
  await setMaintainer(arm, maintainerId);
  await setMaintainer(arm, '');
  const disabled = await postAnnotation(arm, { note: '留空时不该有人被叫起来', kind: 'message', sessionId: randomUUID(), messageId: 'b-1', blockIndex: 0, role: 'assistant' });
  evidence.disabledReceipt = { status: disabled.status, notify: disabled.value?.notify ?? null };
  if (disabled.status !== 201) failures.push(`③ 留空也要能正常标注（201），实际 ${disabled.status}`);
  if (disabled.value?.notify?.status !== 'disabled') failures.push(`③ 回执必须说这条路是**关着的**（notify.status='disabled'），实际 ${JSON.stringify(disabled.value?.notify)}`);
  await sleep(Number(NOTIFY_WINDOW_MS) * 2);
  const disabledWakes = await wakeMessages(arm, maintainerId);
  evidence.disabledWakes = disabledWakes.length;
  if (disabledWakes.length !== 0) failures.push(`③ 留空 ⇒ 一条唤醒消息都不许有，实际 ${disabledWakes.length} 条`);
  const offReport = (await api(arm.basePort, '/annotations')).value?.notify ?? null;
  if (offReport?.configStatus !== 'off' || offReport?.configured !== null) failures.push(`③ 诊断块必须如实报「关着的」，实际 ${JSON.stringify({ configStatus: offReport?.configStatus, configured: offReport?.configured })}`);

  // ④ 维护者自己标注自己
  const selfId = await createSession(arm, `${arm.name} 自己就是维护者`);
  await setMaintainer(arm, selfId);
  const selfPosted = await postAnnotation(arm, { note: '维护者自己标的这条', kind: 'message', sessionId: selfId, messageId: 'c-1', blockIndex: 0, role: 'assistant' });
  evidence.selfReceipt = { status: selfPosted.status, notify: selfPosted.value?.notify ?? null };
  if (selfPosted.value?.notify?.status !== 'self') failures.push(`④ 自己标自己 ⇒ 回执必须说清「不通知自己」（notify.status='self'），实际 ${JSON.stringify(selfPosted.value?.notify)}`);
  await sleep(Number(NOTIFY_WINDOW_MS) * 2);
  const selfWakes = await wakeMessages(arm, selfId);
  evidence.selfWakes = selfWakes.length;
  if (selfWakes.length !== 0) failures.push(`④ 自己标自己 ⇒ 一条唤醒消息都不许有，实际 ${selfWakes.length} 条`);

  return { ok: failures.length === 0, failures, evidence };
}

// ---------------------------------------------------------------------------
// ⑤ 维护者不存在 / 已归档 ⇒ 不崩、不静默（POST 仍 201 + 如实记日志 + 诊断块如实）
// ---------------------------------------------------------------------------

async function gateUnavailable(arm) {
  const failures = [];
  const evidence = {};

  // ⑤ 不存在
  const ghostId = randomUUID();
  await setMaintainer(arm, ghostId);
  const ghost = await postAnnotation(arm, { note: '给一条不存在的维护者会话', kind: 'message', sessionId: randomUUID(), messageId: 'd-1', blockIndex: 0, role: 'assistant' });
  evidence.missingReceipt = { status: ghost.status, notify: ghost.value?.notify ?? null, error: ghost.value?.error ?? null };
  if (ghost.status !== 201) failures.push(`⑤ 维护者不存在**不许**把标注本身弄失败（必须仍 201），实际 ${ghost.status}: ${ghost.raw.slice(0, 200)}`);
  if (ghost.value?.error !== undefined) failures.push(`⑤ 回执里不许出现 error（这一条标注本身是成功的），实际 ${JSON.stringify(ghost.value?.error)}`);
  const ghostReport = await poll(`${arm.name}: ⑤ 不存在的维护者被如实记下`, () => api(arm.basePort, '/annotations'), (reply) => reply.value?.notify?.last?.status === 'failed', 12_000).catch(() => null);
  const ghostLast = ghostReport?.value?.notify?.last ?? null;
  evidence.missingLast = ghostLast;
  if (ghostLast?.status !== 'failed') failures.push(`⑤ 诊断块 last.status 必须是 failed（不编成功），实际 ${JSON.stringify(ghostLast)}`);
  if (typeof ghostLast?.detail !== 'string' || !ghostLast.detail.includes('not found')) failures.push(`⑤ 诊断块必须带上服务端那句真话（session not found: …），实际 ${JSON.stringify(ghostLast?.detail)}`);
  const ghostLog = await baseLogLines(arm, '没能叫起维护者会话');
  evidence.missingLog = ghostLog;
  if (ghostLog.length === 0) failures.push(`⑤ **必须**在日志里留一条（不许静默失败），实际 ${arm.logPath} 里没有 "没能叫起维护者会话"`);
  if (ghostLog.some((line) => !line.includes(ghostId))) failures.push(`⑤ 日志那条必须带上维护者会话 id，实际 ${JSON.stringify(ghostLog)}`);

  // ⑤-b 已归档
  const archivedId = await createSession(arm, `${arm.name} 已归档的维护者`);
  const archivedReply = await api(arm.basePort, `/sessions/${archivedId}`, { method: 'PATCH', body: { archived: true } });
  if (archivedReply.status !== 200) failures.push(`⑤-b 归档这条会话必须 200，实际 ${archivedReply.status}: ${archivedReply.raw.slice(0, 160)}`);
  await setMaintainer(arm, archivedId);
  const archivedPost = await postAnnotation(arm, { note: '给一条已归档的维护者会话', kind: 'message', sessionId: randomUUID(), messageId: 'e-1', blockIndex: 0, role: 'assistant' });
  evidence.archivedReceipt = { status: archivedPost.status, notify: archivedPost.value?.notify ?? null };
  if (archivedPost.status !== 201) failures.push(`⑤-b 归档的维护者也不许把标注弄失败（必须仍 201），实际 ${archivedPost.status}`);
  const archivedReport = await poll(`${arm.name}: ⑤-b 归档的维护者被如实记下`, () => api(arm.basePort, '/annotations'), (reply) => reply.value?.notify?.last?.status === 'session_archived', 12_000).catch(() => null);
  const archivedLast = archivedReport?.value?.notify?.last ?? null;
  evidence.archivedLast = archivedLast;
  if (archivedLast?.status !== 'session_archived') failures.push(`⑤-b 诊断块 last.status 必须是 session_archived，实际 ${JSON.stringify(archivedLast)}`);
  if ((await wakeMessages(arm, archivedId)).length !== 0) failures.push('⑤-b 归档的会话不许收到唤醒消息');
  const archivedLog = await baseLogLines(arm, '已归档');
  evidence.archivedLog = archivedLog;
  if (archivedLog.length === 0) failures.push(`⑤-b **必须**在日志里留一条（不许静默），实际 ${arm.logPath} 里没有「已归档」`);

  // ⑤-c（顺带把配置项形状钉住）：坏值/未知键照旧诚实 400，且侧车文件逐字节未变。
  const settingsFile = path.join(arm.home, 'ui-settings.json');
  const beforeBytes = await readFile(settingsFile, 'utf8').catch(() => null);
  const badValue = await api(arm.basePort, '/settings', { method: 'PATCH', body: { 'annotations.notifySession': 'not-a-uuid' } });
  const badKey = await api(arm.basePort, '/settings', { method: 'PATCH', body: { 'annotations.nope': randomUUID() } });
  const afterBytes = await readFile(settingsFile, 'utf8').catch(() => null);
  evidence.settingsValidation = { badValue: { status: badValue.status, error: badValue.value?.error }, badKey: { status: badKey.status, error: badKey.value?.error } };
  if (badValue.status !== 400 || badValue.value?.error !== 'invalid_setting_value') failures.push(`⑤-c 坏 uuid ⇒ 400 invalid_setting_value，实际 ${badValue.status} ${JSON.stringify(badValue.value)}`);
  if (badKey.status !== 400 || badKey.value?.error !== 'unknown_setting_key') failures.push(`⑤-c 未知键 ⇒ 400 unknown_setting_key，实际 ${badKey.status} ${JSON.stringify(badKey.value)}`);
  if (beforeBytes !== afterBytes) failures.push('⑤-c 400 时侧车文件必须逐字节未变');

  return { ok: failures.length === 0, failures, evidence };
}

// ---------------------------------------------------------------------------
// ⑦ 不设旋钮时窗口默认 30s（另起一台最短命的沙箱：只读一次 GET /annotations）
// ---------------------------------------------------------------------------

async function gateDefaultWindow() {
  const failures = [];
  const arm = await startArm({ name: 'default-window', codeRoot: path.join(TMP, 'real'), notifyWindowMs: null, withProvider: false });
  try {
    const report = (await api(arm.basePort, '/annotations')).value?.notify ?? null;
    print('⑦ 默认窗口诊断块', report);
    if (report?.windowMs !== EXPECTED_DEFAULT_WINDOW_MS) failures.push(`不设 SOPHO_ANNOTATION_NOTIFY_WINDOW_MS 时窗口必须是默认 ${EXPECTED_DEFAULT_WINDOW_MS}ms，实际 ${JSON.stringify(report?.windowMs)}`);
    if (report?.configStatus !== 'ok' || report?.configured !== '01a09d8a-0379-7464-b71e-1602cde9c742') failures.push(`配置项的**初始值**必须是业主点名的那条会话 uuid（01a09d8a-…-1602cde9c742），实际 ${JSON.stringify({ configStatus: report?.configStatus, configured: report?.configured })}`);
    // 坏旋钮 ⇒ 诚实回退到默认值并记一条日志（不许当成没配、也不许拒绝启动）。
    return { ok: failures.length === 0, failures, evidence: { report } };
  } finally {
    await stopArm(arm, problems);
  }
}

async function gateBadWindowKnob() {
  const failures = [];
  const arm = await startArm({ name: 'bad-window', codeRoot: path.join(TMP, 'real'), notifyWindowMs: 'not-a-number', withProvider: false });
  try {
    const report = (await api(arm.basePort, '/annotations')).value?.notify ?? null;
    const log = await baseLogLines(arm, 'SOPHO_ANNOTATION_NOTIFY_WINDOW_MS');
    print('⑦-b 坏旋钮', { report, log });
    if (report?.windowMs !== EXPECTED_DEFAULT_WINDOW_MS) failures.push(`坏旋钮必须回退到默认 ${EXPECTED_DEFAULT_WINDOW_MS}ms，实际 ${JSON.stringify(report?.windowMs)}`);
    if (log.length === 0) failures.push('坏旋钮必须如实记一条日志（不许静默吞掉）');
    return { ok: failures.length === 0, failures, evidence: { report, log } };
  } finally {
    await stopArm(arm, problems);
  }
}

// ---------------------------------------------------------------------------
// 臂 U：真 Chromium + 假 API —— 维护者会话页面上「看得见」
// ---------------------------------------------------------------------------

const UI_MAINTAINER = '33333333-3333-4333-8333-333333333333';
const UI_NOTE = '这张卡上的正文读起来很费劲';
const UI_WAKE_TEXT = [
  '【卡片反馈】网页上有新的标注（反馈）需要维护者处理，共 2 条。',
  '',
  '1. id=an-aaaa1111 · 消息卡 · 会话 44444444-4444-4444-8444-444444444444',
  '   反馈：这张卡上的正文读起来很费劲',
  '',
  '该做什么：',
  '  3) 处理完**逐条**回写状态：`POST /annotations {"op":"resolve","id":"an-aaaa1111","by":"…"}`',
].join('\n');

async function runUiArm() {
  const uiFailures = [];
  const treePayload = {
    sessions: [{ id: UI_MAINTAINER, name: '维护者 UI', parentId: null, archived: false, cwd: 'C:/work/m', modifiedAt: new Date().toISOString(), titleSource: 'auto', status: 'idle', statusLabel: '闲置', unread: false, settledAt: 0, seenAt: 0, notify: { notifies: [], waitingFor: [] } }],
    unread: { count: 0 },
  };
  // ⚠️ 起始**没有**那条唤醒消息：它是在 `session.annotation` 到达之后才由服务端投进去的
  // （假 API 这里就把「投进去」这一刻模拟成 `/api/test/event` 到达之后 `extras` 才开始有）。
  const state = { stream: null, delivered: false, settings: null };
  const messagesPayload = () => ({
    sessionId: UI_MAINTAINER,
    messages: [
      { entryId: 'u-1', parentId: null, timestamp: Date.now() - 1000, kind: 'message', role: 'user', content: [{ type: 'text', text: '先看一眼。' }], text: '先看一眼。', images: [], parts: undefined },
      { entryId: 'a-1', parentId: 'u-1', timestamp: Date.now(), kind: 'message', role: 'assistant', content: [{ type: 'text', text: '看完了。' }], text: '看完了。', images: [], parts: [{ type: 'text', text: '看完了。' }] },
    ],
    extras: state.delivered ? [{
      entryId: 'x-anno-1', parentId: null, customType: 'sopho.annotation', display: true, kind: 'custom',
      timestamp: new Date().toISOString(), text: UI_WAKE_TEXT,
      details: { kind: 'annotation.feedback', maintainerSessionId: UI_MAINTAINER, count: 2, ids: ['an-aaaa1111', 'an-bbbb2222'] },
    }] : [],
    compaction: { atIndex: null, entryId: null, note: '' },
    observability: null,
  });
  const ui = await boot({
    width: 1200,
    height: 760,
    webRoot: path.join(TMP, 'real', 'web'),
    routes: async (request_, response, url) => {
      const { pathname } = url;
      if (pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
      if (pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
      if (pathname === '/api/settings') return sendJson(response, 200, { version: 1, settings: { 'thinking.defaultFold': 'expanded', 'annotations.notifySession': UI_MAINTAINER }, defaults: { 'thinking.defaultFold': 'expanded', 'annotations.notifySession': '01a09d8a-0379-7464-b71e-1602cde9c742' }, stored: {}, file: 'ui-settings.json', exists: false }), true;
      if (pathname === '/api/annotations' && request_.method === 'GET') return sendJson(response, 200, { exists: true, items: [], total: 0, filteredCount: 0 }), true;
      if (pathname === '/api/tree') return sendJson(response, 200, treePayload), true;
      if (pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload)}\n\n`);
        return true;
      }
      if (pathname === `/api/sessions/${UI_MAINTAINER}`) {
        return sendJson(response, 200, { id: UI_MAINTAINER, name: '维护者 UI', cwd: 'C:/work/m', archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
      }
      if (pathname === `/api/sessions/${UI_MAINTAINER}/events`) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        state.stream = response;
        response.once('close', () => { if (state.stream === response) state.stream = null; });
        return true;
      }
      if (pathname === `/api/sessions/${UI_MAINTAINER}/messages`) return sendJson(response, 200, messagesPayload()), true;
      if (pathname === `/api/sessions/${UI_MAINTAINER}/commands`) return sendJson(response, 200, { streaming: false, commands: [] }), true;
      if (pathname === `/api/sessions/${UI_MAINTAINER}/draft`) { await readBody(request_); return sendJson(response, 200, { text: '' }), true; }
      if (pathname === `/api/sessions/${UI_MAINTAINER}/seen`) { await readBody(request_); return sendJson(response, 200, { ok: true, id: UI_MAINTAINER, unread: false }), true; }
      if (pathname === '/api/test/event' && request_.method === 'POST') {
        const { name, data } = JSON.parse(await readBody(request_));
        if (!state.stream || state.stream.destroyed) { sendJson(response, 409, { message: 'session stream unavailable' }); return true; }
        // 「服务端同时把那条通知消息投进了这条会话」——事件与消息是一起发生的，这里就按同一个时刻摆。
        if (name === 'session.annotation') state.delivered = true;
        state.stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        sendJson(response, 200, { ok: true });
        return true;
      }
      return false;
    },
  });

  const evaluate = ui.evaluate;
  const problemsAtStart = ui.pageProblems.length;
  const wakeState = () => evaluate(`(() => {
    const aside = document.querySelector('aside.extra-message[data-custom-type="sopho.annotation"]');
    const notice = document.querySelector('#session-notice');
    return {
      noticeHidden: notice ? notice.hidden : null,
      noticeText: notice ? notice.textContent : null,
      hasAside: !!aside,
      asideText: aside ? aside.textContent : '',
      asideAnnotateControls: aside ? aside.querySelectorAll('.annotate').length : null,
      messageCards: document.querySelectorAll('#messages article.message').length,
      annotateControls: document.querySelectorAll('#messages .annotate').length,
    };
  })()`);
  try {
    await uiWaitFor(() => evaluate(`document.querySelector('[data-session-id="${UI_MAINTAINER}"]') !== null`), 'tree did not render', 15_000);
    await evaluate(`document.querySelector('[data-session-id="${UI_MAINTAINER}"] .tree-select').click()`);
    await uiWaitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not open', 15_000);
    await uiWaitFor(() => state.stream !== null, 'session events stream did not connect', 15_000);
    const before = await wakeState();
    print('臂 U：事件之前', before);
    if (before.hasAside) uiFailures.push('臂 U：「事件之前」不该已经有那条通知消息（这一条量的就是"事件之后才看得到"）');
    if (before.noticeHidden !== true) uiFailures.push(`臂 U：事件之前通知行应当是收起的，实际 hidden=${JSON.stringify(before.noticeHidden)}`);

    // 服务端那一侧发生的事：`session.annotation` 到达（＝同时投进了那条通知消息）。
    await ui.emit('session.annotation', {
      type: 'session.annotation', sessionId: UI_MAINTAINER, count: 2, maintainerSessionId: UI_MAINTAINER,
      ids: ['an-aaaa1111', 'an-bbbb2222'],
      items: [
        { id: 'an-aaaa1111', note: UI_NOTE, kind: 'message', sessionId: '44444444-4444-4444-8444-444444444444', messageId: 'a-1', blockIndex: 1, toolCallId: null, at: new Date().toISOString() },
        { id: 'an-bbbb2222', note: '第二张卡', kind: 'toolResult', sessionId: '44444444-4444-4444-8444-444444444444', messageId: 'a-1', blockIndex: 2, toolCallId: 'call_00_ui', at: new Date().toISOString() },
      ],
    });
    await uiWaitFor(async () => {
      const now = await wakeState();
      return now.noticeHidden === false && now.hasAside;
    }, 'event did not produce a visible trace', 15_000);
    const after = await wakeState();
    print('臂 U：事件之后', after);
    await mkdir(ARTIFACTS, { recursive: true });
    await ui.screenshot(path.join(ARTIFACTS, 'annotate-notify-1200x760.png'));

    if (after.noticeHidden !== false || !String(after.noticeText ?? '').includes('共 2 条')) uiFailures.push(`臂 U：通知行必须可见且说清「共 N 条」，实际 ${JSON.stringify(after.noticeText)}`);
    if (!after.hasAside || !after.asideText.includes('an-aaaa1111') || !after.asideText.includes('resolve')) uiFailures.push(`臂 U：那条通知消息必须看得见、且正文带 id 与 resolve 指引，实际 ${JSON.stringify(String(after.asideText).slice(0, 200))}`);
    if (after.asideAnnotateControls !== 0) uiFailures.push(`臂 U：通知消息里**不许**有标注按钮（通知不许再产生新标注 = 防环），实际 ${after.asideAnnotateControls} 个`);
    if (after.annotateControls === 0) uiFailures.push(`臂 U：卡片上的标注按钮本身要在（这一门不是把它弄没了）—— 消息卡/工具卡各该有，实际 ${after.annotateControls} 个`);

    const pageProblems = ui.pageProblems.slice(problemsAtStart);
    if (pageProblems.length > 0) uiFailures.push(`臂 U：页面不许有异常，实际 ${JSON.stringify(pageProblems)}`);
  } finally {
    await ui.close();
  }
  return { ok: uiFailures.length === 0, failures: uiFailures, evidence: { screenshot: path.join(ARTIFACTS, 'annotate-notify-1200x760.png') } };
}

// ---------------------------------------------------------------------------
// 跑：arm real（全绿）→ arm mutant（① 必红）→ ⑦ 配置项形状 → 臂 U
// ---------------------------------------------------------------------------

let primaryError;
const summary = [];
try {
  const realCode = await makeCodeRoot('real', []);
  {
    const arm = await startArm({ name: 'real', codeRoot: realCode.root });
    try {
      const wake = await gateWakeAndCoalesce(arm);
      if (!check('arm real · ① ② 正向（一条唤醒 + 窗口合并）', wake.ok, wake.failures.length === 0 ? wake.evidence : wake.failures)) print('arm real · ①② 证据', wake.evidence);
      const off = await gateDisabledAndSelf(arm);
      if (!check('arm real · ③ 留空不通知 ＋ ④ 不通知自己', off.ok, off.failures.length === 0 ? off.evidence : off.failures)) print('arm real · ③④ 证据', off.evidence);
      const gone = await gateUnavailable(arm);
      if (!check('arm real · ⑤ 维护者不存在/已归档：不崩、不静默', gone.ok, gone.failures.length === 0 ? gone.evidence : gone.failures)) print('arm real · ⑤ 证据', gone.evidence);
      summary.push({ arm: 'real', wake: wake.ok, disabledAndSelf: off.ok, unavailable: gone.ok });
    } finally {
      await stopArm(arm, problems);
    }
  }

  const defaultWindow = await gateDefaultWindow();
  check('⑦ 不设旋钮 ⇒ 窗口默认 30s ＋ 配置项初始值 = 业主点名的会话', defaultWindow.ok, defaultWindow.failures.length === 0 ? defaultWindow.evidence : defaultWindow.failures);
  const badWindow = await gateBadWindowKnob();
  check('⑦-b 坏旋钮 ⇒ 回退默认值并如实记日志', badWindow.ok, badWindow.failures.length === 0 ? badWindow.evidence : badWindow.failures);

  {
    const mutantCode = await makeCodeRoot('mutant', ['no-wake-message']);
    print('arm mutant · 补丁', mutantCode.applied);
    const arm = await startArm({ name: 'mutant', codeRoot: mutantCode.root });
    try {
      const wake = await gateWakeAndCoalesce(arm);
      print('arm mutant · ①② （① 必须红）', { ok: wake.ok, failures: wake.failures, evidence: wake.evidence });
      check('反证臂 · 去掉「发唤醒消息」那一步 ⇒ ① 必红（只留 SSE 事件叫不醒空闲会话）', wake.ok === false, wake.failures.length > 0 ? wake.failures : '它竟然还是绿的 —— 说明这条门没有牙齿');
      check('反证臂 · 红在「消息那一半」，而 SSE 事件那一半仍然是绿的（正是要证明的那句话）',
        wake.failures.some((line) => line.includes('恰好 1 条') || line.includes('没有收到唤醒消息')) && !wake.failures.some((line) => line.includes('SSE')),
        wake.failures);
      summary.push({ arm: 'mutant', red: !wake.ok, failures: wake.failures });
    } finally {
      await stopArm(arm, problems);
    }
  }

  const uiArm = await runUiArm();
  check('臂 U（真 Chromium + 假 API）· 事件到达 ⇒ 页面上看得见（通知行 + 那条通知消息，且没有标注按钮）', uiArm.ok, uiArm.failures.length === 0 ? uiArm.evidence : uiArm.failures);
  summary.push({ arm: 'ui', ...uiArm });

  print('annotate-notify 门', { checks, failures, verdict: summary });
} catch (error) {
  primaryError = error;
} finally {
  await removeSandbox(TMP, problems);
  finishCleanup(primaryError, problems);
}
