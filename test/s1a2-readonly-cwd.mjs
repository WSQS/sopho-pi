import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox, stopOwnedListener } from './harness.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 's1a2-readonly-cwd-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseEntry = path.join(root, 'server', 'base.mjs');
const appEntry = path.join(root, 'server', 'app.mjs');
const baseLogPath = path.join(sandbox, 'base.log');
const appLogPath = path.join(sandbox, 'app.log');
const redBaseLogPath = path.join(sandbox, 'red-base.log');
let provider;
let baseChild;
let appChild;
let baseLog;
let appLog;
let providerPort;
let basePort;
let appPort;
let redBase;
let redLog;
let redPort;

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

async function reservePort(excluded = new Set()) {
  for (let candidate = 44000 + Math.floor(Math.random() * 14000); candidate < 62000; candidate += 1) {
    if ([7331, 7321].includes(candidate) || excluded.has(candidate)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('no high port available');
}

async function requestOn(port, pathname, { method = 'GET', body, prefix = '' } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${prefix}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { statusCode: response.status, value, body: text };
}

function api(pathname, options = {}) {
  return requestOn(appPort, pathname, { ...options, prefix: '/api' });
}

// 直连宿主（base）而不是经 app：红半那条臂要带一个只给该进程的故障 env（见下）。
function baseApi(port, pathname, options = {}) {
  return requestOn(port, pathname, options);
}

async function poll(label, operation, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

async function startProvider() {
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    startedResolve(input);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', resolve);
  });
  return { server, started };
}

function withoutRuntimeState(value) {
  return {
    messages: value.messages.map((message) => ({
      ...message,
      ...(message.parts ? { parts: message.parts.map((part) => part.type === 'tool' ? { ...part, status: '<runtime-state>' } : part) } : {}),
    })),
    extras: value.extras,
    compaction: value.compaction,
  };
}

let primaryError;
try {
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  const sessionId = randomUUID();
  const sessionFile = path.join(sessionsRoot, `readonly_${sessionId}.jsonl`);
  const now = new Date().toISOString();
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: now, cwd },
    { type: 'model_change', id: '00000001', parentId: null, timestamp: now, provider: 'fake', modelId: 'fake-readonly' },
    { type: 'message', id: '00000002', parentId: '00000001', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'history before compaction' }], timestamp: Date.now() } },
    { type: 'message', id: '00000003', parentId: '00000002', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], provider: 'fake', model: 'fake-readonly', usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: 'stop', timestamp: Date.now() } },
    { type: 'compaction', id: '00000004', parentId: '00000003', timestamp: now, summary: 'compact boundary', firstKeptEntryId: '00000002', tokensBefore: 99, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { type: 'custom_message', id: '00000005', parentId: '00000004', timestamp: now, customType: 'readonly-extra', content: 'extra remains separate', display: true },
    { type: 'message', id: '00000006', parentId: '00000005', timestamp: now, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-live', name: 'bash', arguments: { command: 'sleep 30' } }], provider: 'fake', model: 'fake-readonly', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: null, timestamp: Date.now() } },
  ];
  await writeFile(sessionFile, `${lines.map(JSON.stringify).join('\n')}\n`);
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox-key', models: [{ id: 'fake-readonly', name: 'Fake readonly', contextWindow: 4096, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-readonly', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } }, null, 2)}\n`);

  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  // models.json contains the chosen port, so rewrite after reservation.
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox-key', compat: { supportsDeveloperRole: false }, models: [{ id: 'fake-readonly', name: 'Fake readonly', contextWindow: 4096, maxTokens: 1024 }] } } }, null, 2)}\n`);
  basePort = await reservePort(used); used.add(basePort);
  appPort = await reservePort(used); used.add(appPort);
  provider = await startProvider();
  baseLog = await open(baseLogPath, 'w');
  appLog = await open(appLogPath, 'w');
  baseChild = spawn(process.execPath, [baseEntry], {
    cwd: root,
    env: { ...process.env, HOME: home, ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: sessionsRoot, PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(basePort), SOPHO_DEFAULT_CWD: cwd, SOPHO_NO_TOOLS: '1', SOPHO_MAX_HOT: '8', SOPHO_READONLY_CACHE_DIAGNOSTICS: '1' },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  appChild = spawn(process.execPath, [appEntry], {
    cwd: root,
    env: { ...process.env, HOME: home, ASSIST_HOME: home, SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(appPort), SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(basePort), SOPHO_WEB_ROOT: path.join(root, 'web') },
    stdio: ['ignore', appLog.fd, appLog.fd],
  });
  await poll('A+B ready', () => api('/host').catch(() => null), (response) => response?.statusCode === 200);
  print('sandbox', { home, sessionId, providerPort, basePort, appPort, forbiddenPortsUsed: false });

  const accepted = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'start live tool' } });
  assert.equal(accepted.statusCode, 202);
  await provider.started;
  const runtimeMessages = await poll('running tool visible', () => api(`/sessions/${sessionId}/messages`), (response) => response.value?.messages?.some((message) => message.parts?.some((part) => part.status === 'running')));
  const runtimeTool = runtimeMessages.value.messages.flatMap((message) => message.parts || []).find((part) => part.status === 'running');
  assert.equal(runtimeTool.name, 'bash');

  await rm(cwd, { recursive: true, force: true });
  const readonlyDetail = await api(`/sessions/${sessionId}`);
  const readonlyMessages1 = await api(`/sessions/${sessionId}/messages`);
  const readonlyMessages2 = await api(`/sessions/${sessionId}/messages`);
  // 第三次读：只为了把「解析一次、命中多次」这件事在日志里看清（详情不再走 readonlyMessages ——
  // 它现在只用文件头投影 + 侧车，不建 runtime、也不解析全文）。
  const readonlyMessages3 = await api(`/sessions/${sessionId}/messages`);
  assert.equal(readonlyDetail.statusCode, 200);
  assert.equal(readonlyMessages1.statusCode, 200);
  assert.equal(readonlyMessages2.statusCode, 200);
  assert.equal(readonlyMessages3.statusCode, 200);
  assert.deepEqual(readonlyMessages3.value, readonlyMessages1.value);
  assert.equal(readonlyDetail.value.readOnly, true);
  assert.equal(readonlyDetail.value.readOnlyReason, 'cwd-missing');
  assert.equal(readonlyDetail.value.cwdMissing, cwd);
  assert.equal(readonlyMessages1.value.readOnly, true);
  assert.equal(readonlyMessages1.value.readOnlyReason, 'cwd-missing');
  assert.equal(readonlyMessages1.value.cwdMissing, cwd);
  const interrupted = readonlyMessages1.value.messages.flatMap((message) => message.parts || []).find((part) => part.toolCallId === runtimeTool.toolCallId);
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(withoutRuntimeState(readonlyMessages1.value), withoutRuntimeState(runtimeMessages.value));
  assert.deepEqual(readonlyMessages2.value, readonlyMessages1.value);
  assert.equal(readonlyMessages1.value.compaction.summary, 'compact boundary');
  assert.equal(readonlyMessages1.value.extras[0].customType, 'readonly-extra');
  print('runtime to readonly invariant', { runtimeTool: runtimeTool.status, readonlyTool: interrupted.status, readOnly: readonlyDetail.value, compaction: readonlyMessages1.value.compaction });

  const rejected = await api(`/sessions/${sessionId}/message`, { method: 'POST', body: { text: 'must not run' } });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.value.error, 'session_cwd_missing');
  assert.equal(rejected.value.details.cwd, cwd);
  assert.match(rejected.value.message, /可以查看历史，不能继续/);
  const eventsRejected = await api(`/sessions/${sessionId}/events`);
  const spawnRejected = await api(`/sessions/${sessionId}/spawn`, { method: 'POST', body: { task: 'must not spawn' } });
  const sessionNewRejected = await api(`/sessions/${sessionId}/session-new`, { method: 'POST', body: { cwd: home } });
  for (const response of [eventsRejected, spawnRejected, sessionNewRejected]) {
    assert.equal(response.statusCode, 409);
    assert.equal(response.value.error, 'session_cwd_missing');
    assert.equal(response.value.details.cwd, cwd);
  }
  print('runtime actions rejected', { message: rejected.value, events: eventsRejected.value, spawn: spawnRejected.value, sessionNew: sessionNewRejected.value });

  // 归档/取消归档 = **元数据操作**（只往会话文件追加一条 `sopho.archive`），不需要 cwd ⇒ cwd 缺失
  // 时**照常成功**（这是 2026-09-22 与「内容写」分开的那一条；`readOnly` 语义不变）。
  const archiveAccepted = await api(`/sessions/${sessionId}/archive`, { method: 'POST', body: { archived: true } });
  assert.equal(archiveAccepted.statusCode, 200, archiveAccepted.body);
  assert.equal(archiveAccepted.value.archived, true);
  assert.ok((await readFile(sessionFile, 'utf8')).split('\n').some((line) => line.includes('"sopho.archive"') && line.includes('"archived":true')), '归档条目要真的落进会话文件（不许静默降级）');
  const unarchiveAccepted = await api(`/sessions/${sessionId}/archive`, { method: 'POST', body: { archived: false } });
  assert.equal(unarchiveAccepted.statusCode, 200, unarchiveAccepted.body);
  assert.equal(unarchiveAccepted.value.archived, false);
  // 归档只动元数据账，不改「这条会话现在能不能继续用」：它仍是 readOnly。
  const afterArchiveDetail = await api(`/sessions/${sessionId}`);
  assert.equal(afterArchiveDetail.value.readOnly, true);
  assert.equal(afterArchiveDetail.value.readOnlyReason, 'cwd-missing');
  print('archive is metadata-only (cwd missing still archives)', { archive: archiveAccepted.value, unarchive: unarchiveAccepted.value, readOnly: afterArchiveDetail.value.readOnlyReason });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const logBeforeCorruption = await readFile(baseLogPath, 'utf8');
  const parseLines = logBeforeCorruption.split(/\r?\n/).filter((line) => line.includes(`[readonly-cache] parse ${sessionFile}`));
  const hitLines = logBeforeCorruption.split(/\r?\n/).filter((line) => line.includes(`[readonly-cache] hit ${sessionFile}`));
  assert.equal(parseLines.length, 1);
  assert.ok(hitLines.length >= 2);
  print('readonly cache evidence', { parses: parseLines.length, hits: hitLines.length, lines: [...parseLines, ...hitLines] });

  // ── 冷会话 + cwd 已消失：归档同样照常成功。走的是**文件路**（不能建 runtime —— `prepareRuntime`
  //    会因 cwd 不在而抛）；这正是「归档一条目录已被删掉的老会话」那个真实用途。──
  const coldCwd = path.join(sandbox, 'cold-workspace');
  await mkdir(coldCwd, { recursive: true });
  const coldId = randomUUID();
  const coldFile = path.join(sessionsRoot, `cold_${coldId}.jsonl`);
  const coldStamp = new Date().toISOString();
  await writeFile(coldFile, `${[
    JSON.stringify({ type: 'session', version: 3, id: coldId, timestamp: coldStamp, cwd: coldCwd }),
    JSON.stringify({ type: 'message', id: 'c0c00001', parentId: null, timestamp: coldStamp, message: { role: 'user', content: [{ type: 'text', text: '老的正文' }] } }),
  ].join('\n')}\n`);
  await rm(coldCwd, { recursive: true, force: true });
  const coldDetail = await api(`/sessions/${coldId}`);
  assert.equal(coldDetail.value.readOnly, true, coldDetail.body);
  assert.equal(coldDetail.value.readOnlyReason, 'cwd-missing');
  const coldArchive = await api(`/sessions/${coldId}/archive`, { method: 'POST', body: { archived: true } });
  assert.equal(coldArchive.statusCode, 200, coldArchive.body);
  assert.equal(coldArchive.value.archived, true);
  assert.ok((await readFile(coldFile, 'utf8')).split('\n').some((line) => line.includes('"sopho.archive"') && line.includes('"archived":true')), '冷会话的归档条目也要真的落盘');
  const coldTree = await api('/tree');
  const coldRow = (coldTree.value?.sessions ?? []).find((session) => session.id === coldId) ?? null;
  assert.equal(coldRow?.archived, true, `归档后的冷会话要在树上显示为已归档：${coldTree.body}`);
  print('cold cwd-missing session archives too', { detail: { readOnly: coldDetail.value.readOnlyReason }, archive: coldArchive.value, treeArchived: coldRow?.archived });

  // ── 红半：`SOPHO_FAULT_ARCHIVE_NEEDS_CWD=1` 把归档的判据改回**旧样子**（= 与其它写一样过 cwd 门）。
  //    同一个场景（冷 + cwd 已消失）在带这个故障 env 的宿主上必须回到 409 `session_cwd_missing`
  //    ⇒ 上一条绿断言确实有牙齿（判据一改回去就必红）。──
  const redHome = path.join(sandbox, 'red-home');
  const redSessions = path.join(redHome, 'sessions');
  const redWorkspace = path.join(sandbox, 'red-workspace');
  await mkdir(redSessions, { recursive: true });
  await mkdir(redWorkspace, { recursive: true });
  await writeFile(path.join(redHome, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(redHome, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const redGoneCwd = path.join(sandbox, 'red-gone');
  await mkdir(redGoneCwd, { recursive: true });
  const redId = randomUUID();
  const redFile = path.join(redSessions, `red_${redId}.jsonl`);
  const redStamp = new Date().toISOString();
  await writeFile(redFile, `${[
    JSON.stringify({ type: 'session', version: 3, id: redId, timestamp: redStamp, cwd: redGoneCwd }),
    JSON.stringify({ type: 'message', id: 'red00001', parentId: null, timestamp: redStamp, message: { role: 'user', content: [{ type: 'text', text: '红半的正文' }] } }),
  ].join('\n')}\n`);
  await rm(redGoneCwd, { recursive: true, force: true });
  redPort = await reservePort(used); used.add(redPort);
  redLog = await open(redBaseLogPath, 'w');
  redBase = spawn(process.execPath, [baseEntry], {
    cwd: root,
    env: { ...process.env, HOME: redHome, ASSIST_HOME: redHome, SOPHO_AGENT_DIR: redHome, PI_CODING_AGENT_DIR: redHome, PI_CODING_AGENT_SESSION_DIR: redSessions, PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(redPort), SOPHO_DEFAULT_CWD: redWorkspace, SOPHO_NO_TOOLS: '1', SOPHO_MAX_HOT: '8', SOPHO_FAULT_ARCHIVE_NEEDS_CWD: '1' },
    stdio: ['ignore', redLog.fd, redLog.fd],
  });
  await poll('red base ready', () => baseApi(redPort, '/host').catch(() => null), (response) => response?.statusCode === 200 && Number(response.value?.currentWorkerPid) > 0, 60000);
  const redArchive = await baseApi(redPort, `/sessions/${redId}/archive`, { method: 'POST', body: { archived: true } });
  assert.equal(redArchive.statusCode, 409, `红半：判据改回旧样子后必须回到 409（否则绿断言没有牙齿）：${redArchive.body}`);
  assert.equal(redArchive.value.error, 'session_cwd_missing');
  print('red arm: reverting the archive judgment gives 409 again', { statusCode: redArchive.statusCode, error: redArchive.value.error });

  await appendFile(sessionFile, '{broken json\n');
  const broken = await api(`/sessions/${sessionId}/messages`);
  assert.equal(broken.statusCode, 500);
  assert.equal(broken.value.error, 'internal_error');
  print('bad session fails loud', { statusCode: broken.statusCode, body: broken.value });
  print('RESULT', 'S1a-2 readonly cwd PASS');
} catch (error) { primaryError = error; } finally {
  const cleanupProblems = [];
  if (appPort) await stopOwnedListener(appPort, appEntry, appChild?.pid).catch((error) => process.stderr.write(`app cleanup failed: ${error.message}\n`));
  if (basePort) await stopOwnedListener(basePort, baseEntry, baseChild?.pid).catch((error) => process.stderr.write(`base cleanup failed: ${error.message}\n`));
  if (redPort) await stopOwnedListener(redPort, baseEntry, redBase?.pid).catch((error) => process.stderr.write(`red base cleanup failed: ${error.message}\n`));
  if (provider?.server) {
    provider.server.closeAllConnections();
    await new Promise((resolve) => provider.server.close(resolve));
  }
  if (baseLog) await cleanupStep(cleanupProblems, 'close baseLog', () => baseLog.close());
  if (appLog) await cleanupStep(cleanupProblems, 'close appLog', () => appLog.close());
  if (redLog) await cleanupStep(cleanupProblems, 'close redLog', () => redLog.close());
  const redOutput = await readFile(redBaseLogPath, 'utf8').catch(() => '');
  if (redOutput.trim()) print('red base log', redOutput.trim());
  const baseOutput = await readFile(baseLogPath, 'utf8').catch(() => '');
  if (baseOutput.trim()) print('base log', baseOutput.trim());
  const appOutput = await readFile(appLogPath, 'utf8').catch(() => '');
  if (appOutput.trim()) print('app log', appOutput.trim());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
