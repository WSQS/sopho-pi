#!/usr/bin/env node
// test/messages-etag-stability.mjs —— `/messages` 的 ETag 必须**只取决于这一版正文**。
//
// 要钉住的事（一条不能少）：
//   ① 同一份未变正文连拉两次 ⇒ **同一个 ETag**（客户端才可能拿到 304）；
//   ② 正文变了（文件里多落一条）⇒ ETag 必须跟着变（不许是常量）；
//   ③ 冷读（文件那条路）与热读（runtime 那条路）**同一份正文 ⇒ 同一个 ETag** ——
//      这正是「打开一个会话时 Etag 抖动」的现场：`/messages` 先走冷读、会话流把 runtime 拉热
//      之后同一条 URL 改走热读，两条路的 versionKey 前缀（`file|…` vs `hot|…`）不同 ⇒ 同一份
//      正文给出两个 ETag，客户端手上的 If-None-Match 永远对不上（304 永远拿不到）；
//   ④ `If-None-Match` 命中 ⇒ **304 且 0 字节**；陈旧 ETag ⇒ 200 + 整份（裸 HTTP 实测）。
//
// 红线：只起**自己 spawn** 的 A（`test/perf-verify-lib.mjs` 的 startSandboxBase）；只按那个 pid 停
// （`test/harness.mjs` 的 cleanupStep/removeSandbox/finishCleanup）；高位随机端口，**绝不用 7331/7321**；
// 日志写本次沙箱；**不 pkill**；不碰真实 profile。

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupStep, finishCleanup, removeSandbox } from './harness.mjs';
import { hostStatus, poll, startSandboxBase, writeMinimalHome } from './perf-verify-lib.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-etag-'));
const home = path.join(sandbox, 'home');
const workspace = path.join(sandbox, 'workspace');
const sessionsRoot = path.join(home, 'sessions');
const baseLogPath = path.join(sandbox, 'etag-base.log');

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
let checks = 0;
function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16);

/** 裸 HTTP GET：把状态行、响应头与**收全的**正文一起带回（不截断）。 */
function rawGet(port, pathname, headers = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const request = http.request({ host: '127.0.0.1', port, path: pathname, headers: { accept: 'application/json', connection: 'close', ...headers } });
    request.once('error', (error) => resolve({ error: error.message, statusCode: 0, headers: {}, body: Buffer.alloc(0), ms: Date.now() - started }));
    request.once('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', (error) => resolve({ error: error.message, statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), ms: Date.now() - started }));
      response.once('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), ms: Date.now() - started }));
    });
    request.end();
  });
}

/** 一条**形状合法**的会话文件（与 pi 的 JSONL 同形：header + 带 parentId 链的 message 行）。 */
function sessionLines({ id, messages }) {
  const now = '2026-09-19T00:00:00.000Z';
  const lines = [{ type: 'session', version: 3, id, timestamp: now, cwd: workspace }];
  for (let index = 0; index < messages; index += 1) {
    const text = `ETAG-PROBE-${index} ${'x'.repeat(400)}`;
    const message = index % 2
      ? { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.parse(now) }
      : { role: 'user', content: text, timestamp: Date.parse(now) };
    lines.push({ type: 'message', id: `${index + 1}`.padStart(8, '0'), parentId: index === 0 ? null : `${index}`.padStart(8, '0'), timestamp: now, message });
  }
  return lines;
}

let base = null;
let primaryError = null;
const report = {};
try {
  await writeMinimalHome(home, workspace);
  await mkdir(sessionsRoot, { recursive: true });
  const sessionId = randomUUID();
  const file = path.join(sessionsRoot, `etag_${sessionId}.jsonl`);
  const write = (messages) => writeFile(file, `${sessionLines({ id: sessionId, messages }).map(JSON.stringify).join('\n')}\n`);
  await write(24);

  base = await startSandboxBase({ home, sessionsRoot, workspace, logPath: baseLogPath });
  try {
    await poll('etag sandbox ready', () => hostStatus(base.port), (host) => host?.currentWorkerPid > 0, 120_000);
  } catch (error) {
    const log = await readFile(baseLogPath, 'utf8').catch(() => '(读不到日志)');
    throw new Error(`✗ 沙箱 A 没起来：${error.message}\n  base.log 尾巴：\n${log.split('\n').slice(-12).join('\n')}`);
  }
  const url = `/sessions/${sessionId}/messages`;
  const fetch = (headers) => rawGet(base.port, url, headers);
  const line = (label, response) => ({ step: label, status: response.statusCode, etag: response.headers.etag ?? null, bytes: response.body.length, sha256: sha(response.body), ms: response.ms });

  // ── ① 同一份未变正文连拉两次 ────────────────────────────────────────────────
  const cold1 = await fetch();
  const cold2 = await fetch();
  report.cold = [line('cold#1', cold1), line('cold#2', cold2)];
  check('① 冷读响应带弱 ETag', typeof cold1.headers.etag === 'string' && cold1.headers.etag.startsWith('W/"'), JSON.stringify({ status: cold1.statusCode, etag: cold1.headers.etag ?? null, bytes: cold1.body.length }));
  check('① 同一份未变正文连拉两次 ⇒ 同一个 ETag（且字节逐字相同）',
    cold1.headers.etag === cold2.headers.etag && Buffer.compare(cold1.body, cold2.body) === 0,
    JSON.stringify({ etag1: cold1.headers.etag, etag2: cold2.headers.etag, bytes: cold1.body.length, ms: [cold1.ms, cold2.ms] }));

  // ── ② 正文真变了 ⇒ ETag 必须跟着变 ─────────────────────────────────────────
  await write(25);
  const cold3 = await fetch();
  report.cold.push(line('cold#3(正文+1条)', cold3));
  check('② 正文变了 ⇒ ETag 跟着变（ETag 不是常量）',
    cold3.headers.etag !== cold1.headers.etag && sha(cold3.body) !== sha(cold1.body),
    JSON.stringify({ before: cold1.headers.etag, after: cold3.headers.etag, bytes: [cold1.body.length, cold3.body.length] }));

  // ── ③ 冷读 vs 热读：同一份正文 ⇒ 同一个 ETag（本次修的就是这条）────────────
  const commands = await rawGet(base.port, `/sessions/${sessionId}/commands`);
  if (commands.statusCode !== 200) {
    throw new Error(`✗ 起不了 runtime（GET /commands -> ${commands.statusCode}）：${commands.body.toString('utf8').slice(0, 300)}\n  这一臂没有 runtime 就量不到「冷/热两个 ETag」，不许 SKIP 成绿。`);
  }
  const hot1 = await fetch();
  const hot2 = await fetch();
  report.hot = [line('hot#1', hot1), line('hot#2', hot2)];
  check('③ 热读与冷读是**同一份正文**（逐字相同；这条不满足时下面的比对没有意义）',
    Buffer.compare(hot1.body, cold3.body) === 0,
    JSON.stringify({ coldBytes: cold3.body.length, hotBytes: hot1.body.length, coldSha: sha(cold3.body), hotSha: sha(hot1.body) }));
  check('③ 冷读与热读同一份正文 ⇒ 同一个 ETag（打开会话时 ETag 不许抖）',
    hot1.headers.etag === cold3.headers.etag,
    JSON.stringify({ cold: cold3.headers.etag, hot: hot1.headers.etag, bodySha: sha(hot1.body) }));
  check('③ 热读连拉两次 ⇒ 同一个 ETag', hot1.headers.etag === hot2.headers.etag, JSON.stringify({ etag1: hot1.headers.etag, etag2: hot2.headers.etag }));
  check('①③ 同一个 body hash ⇒ 同一个 ETag（四个观察点全等）',
    new Set([cold3.headers.etag, hot1.headers.etag, hot2.headers.etag]).size === 1,
    JSON.stringify({ etags: [cold3.headers.etag, hot1.headers.etag, hot2.headers.etag], bodysha: [sha(cold3.body), sha(hot1.body), sha(hot2.body)] }));

  // ── ④ If-None-Match：命中 304 + 0 字节；陈旧 ⇒ 200 + 整份 ───────────────────
  const notModified = await fetch({ 'if-none-match': String(hot1.headers.etag) });
  report.conditional = [
    { step: 'If-None-Match(当前 ETag)', status: notModified.statusCode, etag: notModified.headers.etag ?? null, bytes: notModified.body.length },
  ];
  check('④ If-None-Match 命中 ⇒ 304 且 0 字节',
    notModified.statusCode === 304 && notModified.body.length === 0,
    JSON.stringify({ status: notModified.statusCode, bytes: notModified.body.length, etag: notModified.headers.etag ?? null }));
  const stale = await fetch({ 'if-none-match': 'W/"v1-deadbeefdeadbeefdeadbeef"' });
  report.conditional.push({ step: 'If-None-Match(陈旧)', status: stale.statusCode, bytes: stale.body.length });
  check('④ 陈旧 ETag ⇒ 200 + 整份（不许拿 304 糊弄）',
    stale.statusCode === 200 && Buffer.compare(stale.body, hot1.body) === 0,
    JSON.stringify({ status: stale.statusCode, bytes: stale.body.length, expected: hot1.body.length }));
  report.responseHeaders = {
    cacheControl: cold1.headers['cache-control'] ?? null,
    vary: cold1.headers.vary ?? null,
    contentType: cold1.headers['content-type'] ?? null,
    contentEncoding: cold1.headers['content-encoding'] ?? null,
    note: '前端 fetch 不带条件头（web/app.js 的 api() 只发 accept）⇒ 这一条 ETag 今天只对中间层/别的客户端有用；客户端那一环要另开一笔',
  };

  print('report', report);
  print('RESULT', `messages etag stability PASS (${checks} checks)`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  if (base) await cleanupStep(cleanupProblems, 'stop A', () => base.stop());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
