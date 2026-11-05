#!/usr/bin/env node
// 门：`session_new`/`POST /sessions` 不许把「会话其实已建成」回报成 500（2026-09-21 事故）。
//
// 故障注入（只在沙箱里用）：`SOPHO_FAULT_ATOMIC_RENAME=<CODE>:<COUNT>[:<basename>]`
//   ⇒ 让前 COUNT 次（可只匹配某个 basename 的）`rename` 抛给定 code，模拟 Windows 上
//      placement.json 的 rename 被短暂占用（杀软/索引器/别人刚打开的读句柄）抛 EPERM。
//
// 三个臂（各自一台沙箱，高位随机端口 + 副本 home + 假 provider）：
//   ① 回归臂：不注故障 ⇒ 201 + placementPersisted:true + placement.json 逐字含该会话；
//   ② 重试臂：`EPERM:2:placement.json`（< 重试次数）⇒ **仍然 201** + placementPersisted:true
//      （证明 A 的有界重试在；把重试去掉这臂就红）；
//   ③ 诚实臂：`EPERM:8:placement.json`（≥ 重试次数）⇒ 201（**不是 500**）+ 回执带 id +
//      placementPersisted:false + warning 文案含 "was created"；placement.json 里确实没有它，
//      但 GET /tree 看得到（derived:true / source:'pi-header'）；没有 .tmp 残留；
//      随后一发同进程的成功 placement 写（session_new 建子会话）把它**补齐落盘**（derived 条目不再缺）。
//      （把 B 的 try/catch 去掉，这臂变 500 ⇒ 红。）
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, listenerPid, removeSandbox, stopSpawnedListener } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'session-placement-fault-'));
const HOME = path.join(TMP, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const PARENT_CWD = path.join(TMP, 'parent-cwd');
const CHILD_CWD = path.join(TMP, 'child-cwd');
const BASE_ENTRY = path.join(ROOT, 'server', 'base.mjs');
const BASE_LOG_PATH = path.join(TMP, 'base.log');

let baseChild = null;
let baseLog = null;
let provider = null;
let basePort = null;
let providerPort = null;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const placementPath = () => path.join(HOME, 'placement.json');
const readPlacement = async () => JSON.parse(await readFile(placementPath(), 'utf8').catch(() => '{}'));

async function reservePort(excluded = new Set()) {
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

async function poll(label, operation, predicate, timeoutMs = 20_000) {
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

// 假 provider：会话只被创建、不被 prompt，所以只在真发 completion 时才需要答一句。
function startProvider() {
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') return response.writeHead(404).end();
    for await (const _chunk of incoming) { /* drain */ }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fault', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-fault', choices: [{ index: 0, delta: { role: 'assistant', content: 'FAKE_OK' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fault', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-fault', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(providerPort, '127.0.0.1', () => resolve({ server }));
  });
}

async function startBase(fault) {
  baseLog = await open(BASE_LOG_PATH, 'a');
  const env = {
    ...process.env,
    HOME,
    ASSIST_HOME: HOME,
    SOPHO_AGENT_DIR: HOME,
    PI_CODING_AGENT_DIR: HOME,
    PI_CODING_AGENT_SESSION_DIR: SESSIONS,
    PI_OFFLINE: '1',
    SOPHO_HOST: '127.0.0.1',
    SOPHO_PORT: String(basePort),
    SOPHO_DEFAULT_CWD: PARENT_CWD,
    SOPHO_NO_TOOLS: '1',
    SOPHO_MAX_HOT: '8',
  };
  delete env.SOPHO_FAULT_ATOMIC_RENAME;
  if (fault) env.SOPHO_FAULT_ATOMIC_RENAME = fault;
  baseChild = spawn(process.execPath, [BASE_ENTRY], { cwd: ROOT, env, stdio: ['ignore', baseLog.fd, baseLog.fd] });
  await poll('base ready', () => request('/host'), (reply) => reply.status === 200, 30_000);
  assert.equal(await listenerPid(basePort), baseChild.pid, 'base listener is not the spawned pid');
}

async function stopBase() {
  if (baseChild && basePort) await stopSpawnedListener(baseChild, basePort, BASE_ENTRY);
  baseChild = null;
  // 每次 boot 都开一个新 log handle；关掉上一个，否则 FileHandle 被 GC 时会报错（Node 22+）。
  if (baseLog) { await baseLog.close(); baseLog = null; }
}

async function tmpResidue() {
  const found = [];
  for (const entry of await readdir(HOME, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('.') && entry.name.endsWith('.tmp')) found.push(entry.name);
  }
  return found;
}

function assertHonestCreateReceipt(label, created, placement) {
  assert.ok(created.value?.id, `${label}: 201 回执里没有 id: ${created.raw}`);
  assert.equal(created.value.placementPersisted, false, `${label}: placementPersisted 应为 false: ${created.raw}`);
  assert.equal(created.value.warning?.code, 'placement_write_failed', `${label}: warning.code 不对: ${created.raw}`);
  assert.equal(created.value.warning?.file, placementPath(), `${label}: warning.file 不对: ${created.raw}`);
  assert.match(created.value.warning?.message ?? '', /was created/, `${label}: warning 文案没说清"会话已创建": ${created.raw}`);
  assert.equal(created.value.placement?.derived, true, `${label}: 未落盘的 placement 应如实报 derived:true: ${created.raw}`);
  assert.equal(created.value.placement?.source, 'pi-header', `${label}: 未落盘的 placement 应如实报 source:'pi-header': ${created.raw}`);
  assert.equal(Object.hasOwn(placement, created.value.id), false, `${label}: placement.json 不应含未落盘的会话: ${JSON.stringify(placement)}`);
}

const checks = [];
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks.push(name);
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};

let primaryError;
try {
  for (const directory of [HOME, SESSIONS, PARENT_CWD, CHILD_CWD]) await mkdir(directory, { recursive: true });
  const used = new Set();
  providerPort = await reservePort(used); used.add(providerPort);
  basePort = await reservePort(used);
  await writeFile(path.join(HOME, 'models.json'), `${JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', apiKey: 'sandbox', models: [{ id: 'fake-fault', name: 'Fake Fault', contextWindow: 8192, maxTokens: 1024 }] } } }, null, 2)}\n`);
  await writeFile(path.join(HOME, 'settings.json'), `${JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-fault', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);
  provider = await startProvider();
  print('sandbox', { tmp: TMP, home: HOME, basePort, providerPort, forbiddenPortsUsed: false });

  // ── ① 回归臂：不注故障 ─────────────────────────────────────────────────────────────
  await startBase(null);
  const clean = await request('/sessions', { method: 'POST', body: { scratch: true } });
  assert.equal(clean.status, 201, clean.raw);
  const cleanConfig = await readPlacement();
  check('回归臂：不注故障 ⇒ 201 + placementPersisted:true', clean.value.placementPersisted === true && !clean.value.warning, clean.raw);
  check('回归臂：placement.json 逐字含那条（derived:false / source:placement.json）',
    cleanConfig[clean.value.id]?.cwd === clean.value.cwd && clean.value.placement?.derived === false && clean.value.placement?.source === 'placement.json',
    JSON.stringify({ receipt: clean.value.placement, persisted: cleanConfig[clean.value.id] }));

  // ④ 真实争用臂（**不注故障**）：让网页首屏那种“突发并发读 /placement”压着创建。
  //    这台 Windows 上真会招来 `EPERM: operation not permitted, rename '.placement.json.<pid>.<uuid>.tmp' -> 'placement.json'`
  //    （实测 60 次创建里 59 次真 EPERM）—— 正是维护者“刚重启后第一次 POST /api/sessions {scratch:true} 拿到 500”的现场。
  //    断言：无论记账成没成，**一个 5xx 都不许有**（把 B 的 try/catch 去掉，这里会成片 500）。
  let stopReaders = false;
  const readers = Array.from({ length: 16 }, async () => { while (!stopReaders) { try { await request('/placement'); } catch { /* reader is best-effort */ } } });
  const contended = [];
  for (let i = 0; i < 30; i += 1) {
    const reply = await request('/sessions', { method: 'POST', body: i % 2 === 0 ? { scratch: true } : { cwd: PARENT_CWD } });
    contended.push({ status: reply.status, raw: reply.raw });
  }
  stopReaders = true;
  await Promise.all(readers);
  const serverErrors = contended.filter((entry) => entry.status >= 500);
  check('真实争用臂：并发读 /placement 压着创建 30 条 ⇒ 一个 5xx 都没有（修前会成片 500）',
    serverErrors.length === 0, JSON.stringify(serverErrors.slice(0, 2)));
  const notPersisted = contended.filter((entry) => entry.status === 201 && JSON.parse(entry.raw).placementPersisted === false).length;
  print('真实争用臂：真 EPERM 导致当场没落盘的条数（诚实回执，后续补齐）', notPersisted);
  check('真实争用臂：没有 .tmp 残留', (await tmpResidue()).length === 0, JSON.stringify(await tmpResidue()));
  await stopBase();

  // ── ② 重试臂：rename 前 2 次 EPERM（< 5 次重试上限）──────────────────────────────────
  await startBase('EPERM:2:placement.json');
  const retried = await request('/sessions', { method: 'POST', body: { scratch: true } });
  assert.equal(retried.status, 201, retried.raw);
  const retryConfig = await readPlacement();
  check('重试臂：EPERM:2（< 上限）⇒ A 的有界重试吃掉了它 ⇒ 201 + placementPersisted:true',
    retried.value.placementPersisted === true && !retried.value.warning, retried.raw);
  check('重试臂：placement.json 里确实落盘了（重试的是同一个临时文件，最终成功）',
    retryConfig[retried.value.id]?.kind === 'scratch' && retried.value.placement?.derived === false,
    JSON.stringify({ id: retried.value.id, row: retryConfig[retried.value.id] }));
  check('重试臂：没有 .tmp 残留', (await tmpResidue()).length === 0, JSON.stringify(await tmpResidue()));
  await stopBase();

  // ── ③ 诚实臂：rename 前 8 次 EPERM（≥ 5 次上限 ⇒ 这一次记账最终失败）──────────────
  await startBase('EPERM:8:placement.json');
  const parent = await request('/sessions', { method: 'POST', body: { cwd: PARENT_CWD, name: 'fault parent' } });
  assert.equal(parent.status, 201, parent.raw);
  const afterParent = await readPlacement();
  assertHonestCreateReceipt('诚实臂·POST /sessions', parent, afterParent);
  const treeAfterParent = await request('/tree');
  const parentRow = treeAfterParent.value.sessions.find((entry) => entry.id === parent.value.id);
  check('诚实臂：/tree 仍看得到它（derived:true / source:pi-header）',
    parentRow?.placement?.derived === true && parentRow?.placement?.source === 'pi-header',
    JSON.stringify(parentRow?.placement));
  check('诚实臂：最终失败后没有 .tmp 残留（catch 里 unlink 过）', (await tmpResidue()).length === 0, JSON.stringify(await tmpResidue()));

  // session_new（宿主的 /sessions/{parent}/session-new 路）也走同一条创建路径：
  const child = await request(`/sessions/${parent.value.id}/session-new`, { method: 'POST', body: { cwd: CHILD_CWD, name: 'fault child' } });
  assert.equal(child.status, 201, child.raw);
  assert.ok(child.value?.childSessionId, `session_new 回执里没有 childSessionId: ${child.raw}`);
  check('诚实臂：session_new 建子会话也没有 500，回执带 childSessionId', Boolean(child.value.childSessionId), child.raw.slice(0, 400));
  check('诚实臂：子会话这一发记账成功（EPERM 计数已耗尽）⇒ placementPersisted:true',
    child.value.child?.placementPersisted === true && !child.value.child?.warning, JSON.stringify(child.value.child));
  const healed = await readPlacement();
  check('补齐：下一次成功写 placement.json 把无关的 derived 条目一并落盘（父会话被补上）',
    Object.hasOwn(healed, parent.value.id) && Object.hasOwn(healed, child.value.childSessionId),
    JSON.stringify({ parentId: parent.value.id, childId: child.value.childSessionId, keys: Object.keys(healed).length }));
  check('补齐后：/placement 里父会话不再是 derived', (await request('/placement')).value[parent.value.id]?.derived === false, JSON.stringify((await request('/placement')).value[parent.value.id]));
  await stopBase();

  print('RESULT', `session create placement-fault gate PASS (${checks.length} checks)`);
} catch (error) {
  primaryError = error;
  try {
    const tail = (await readFile(BASE_LOG_PATH, 'utf8')).slice(-6000);
    if (tail.trim()) process.stderr.write(`\nbase log tail:\n${tail}\n`);
  } catch { /* no log yet */ }
} finally {
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'stop base', () => stopBase());
  if (provider?.server) {
    await cleanupStep(cleanupProblems, 'close provider', () => new Promise((resolve) => {
      provider.server.closeAllConnections();
      provider.server.close(resolve);
    }));
  }
  await cleanupStep(cleanupProblems, 'close base log', () => baseLog?.close());
  baseLog = null;
  await removeSandbox(TMP, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
