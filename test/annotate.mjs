#!/usr/bin/env node
// test/annotate.mjs —— 卡片级反馈（`docs/design-annotations.md` v1 + v1.5「维护者」）的机械门。
//
// 三臂，各钉一半事实（照 `test/live-tool-details.mjs` 的「服务端臂 + 前端臂」先例）：
//   臂 S（服务端，真 A 宿主 + 真逻辑 worker，沙箱高位端口）—— v1 + v1.5：
//     ① POST 的校验各来一发（空 note / 坏 kind / 坏 sessionId / 坏 blockIndex ⇒ 诚实 400，**不落盘**）；
//     ② 合法 POST ⇒ 201，服务端补 `at`/`appVersion`/`codeVersion`/`state`/`id`；客户端伪造的同名字段被忽略；
//     ③ append-only：连发三条 ⇒ `annotations.jsonl` 只增不改（第一条逐字节未变）；
//     ④ GET /annotations 回 `{items:[…]}`；`?since=`（ISO 与 epoch ms）只回更晚的；坏 since ⇒ 400。
//     ---- v1.5 ----
//     ⑤ resolve 正向：open ⇒ done（带 resolvedAt/resolvedBy）＋ **只追加一行事件**（原行逐字节未变、行数 +1）
//        ＋ 幂等（已 done 再来一次 ⇒ changed:false、**不追加**）＋ 不存在 ⇒ 404（一行不写）
//        ＋ 坏 op/by/id ⇒ 400 ＋ `?state=`/`?session=` 只读过滤＋别名 `POST /annotations/{id}/resolve`；
//     ⑧ 500 条上限：**超限** ⇒ 响应带 warning，且文件**一行都没少**（append-only 底线不破）。
//   臂 U（真 Chromium + 假 API，v1）—— 每张卡一个按钮、提交、只增不改、Esc/空提交零调用、只读清单页。
//   臂 B（真 Chromium + 假 API，v1.5）—— **直播卡 → 正式卡交接**仍对得上（⑦）＋
//     「已反馈 → 刷新 → 已处理 ✓」由**服务端 state** 驱动（④）。为什么另起一份页面：④ 量的就是
//     「新 document 里还剩什么」，而 `Page.reload` 会掐掉旧 document 在飞的请求 ⇒ 臂 U 的
//     「全程零异常」断言不该被这个导航窗口污染（臂 B 自己的异常断言把导航取消那一类**打印出来**再排除）。
//
// 红绿对照（报告里给的复跑命令；同一把尺子量两个版本：`SOPHO_ANNOTATE_ROOT`／`SOPHO_ANNOTATE_WEB`）：
//   · UI 那半改回（没按钮）：`SOPHO_ANNOTATE_WEB=<把 web/render.js 的 annotationControl 调用去掉的副本> node test/annotate.mjs`
//   · 服务端那半改回（没路由/不落盘）：`SOPHO_ANNOTATE_ROOT=<把 server/base-logic.mjs 的 /annotations 路由去掉的副本> node test/annotate.mjs`
//   · v1.5 服务端那半改回（resolve **不写事件行**）：`SOPHO_ANNOTATE_ROOT=<resolve 只回回执、不 append 的副本> node test/annotate.mjs` ⇒ ⑤ 必红
//   · v1.5 前端那半改回（**只读本地态**）：`SOPHO_ANNOTATE_WEB=<用本地 Set 记「已反馈」、不读服务端 state 的副本> node test/annotate.mjs` ⇒ ④ 必红
//
// 沙箱一律高位随机端口 + 临时 ASSIST_HOME/日志；不使用 7331/7321；不碰真实 profile；不 pkill（只杀自己 spawn 的进程/浏览器）。
//
// 用法：CHROME_BIN=/usr/bin/chromium node test/annotate.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';
import { boot, sendJson, readBody, waitFor as uiWaitFor } from './ui-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 红绿对照：把这两只 env 指到**副本**（同一把尺子量两个版本）。
const serverRoot = process.env.SOPHO_ANNOTATE_ROOT ? path.resolve(process.env.SOPHO_ANNOTATE_ROOT) : root;
const webRoot = process.env.SOPHO_ANNOTATE_WEB ? path.resolve(process.env.SOPHO_ANNOTATE_WEB) : path.join(serverRoot, 'web');
const BASE_ENTRY = path.join(serverRoot, 'server', 'base.mjs');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_MESSAGE = '这条助手正文讲得不清楚，请维护者看一眼。';
const NOTE_TOOL = '这个工具结果被截断了，看不到关键那行。';
// 上限臂的口径：**超过** 500 条（上限常量在 `server/base-logic.mjs`，这里只按同一个数构造现场）。
const ANNOTATION_FILE_LIMIT = 500;
const ANNOTATION_BULK_TARGET = ANNOTATION_FILE_LIMIT + 1;
const ANNOTATION_BULK_MAX_POSTS = ANNOTATION_BULK_TARGET + 8;
// `by` 的上限（`server/base-logic.mjs` 的 `ANNOTATION_RESOLVE_BY_MAX_CHARS`）—— 这里只用来造一条过长的。
const ANNOTATION_BY_TOO_LONG = 200;

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-annotate-'));
const HOME = path.join(sandbox, 'home');
const SESSIONS = path.join(HOME, 'sessions');
const CWD = path.join(sandbox, 'cwd');
const ANNOTATIONS_FILE = path.join(HOME, 'annotations.jsonl');
const BASE_LOG_PATH = path.join(sandbox, 'base.log');
const artifacts = path.join(os.tmpdir(), 'sopho-annotate');
const screenshotList = path.join(artifacts, 'annotations-list-1200x760.png');

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const problems = [];
let baseChild = null;
let baseLog = null;
let basePort = 0;

// ── 臂 S：服务端（真 A 宿主 + 真逻辑 worker）───────────────────────────────────────────────
async function readAnnotationLines() {
  const text = await readFile(ANNOTATIONS_FILE, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
  if (text === null) return null;
  return text.split('\n').filter((line) => line !== '');
}

async function baseRequest(pathname, { method = 'GET', body } = {}) {
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

async function runServerArm() {
  for (const directory of [HOME, SESSIONS, CWD]) await mkdir(directory, { recursive: true });
  basePort = await reservePort();
  baseLog = await open(BASE_LOG_PATH, 'w');
  baseChild = spawn(process.execPath, [BASE_ENTRY], {
    cwd: serverRoot,
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
      SOPHO_MAX_HOT: '2',
    },
    stdio: ['ignore', baseLog.fd, baseLog.fd],
  });
  const host = await poll('base ready', () => baseRequest('/host'), (reply) => reply.status === 200);
  print('sandbox', { tmp: sandbox, basePort, basePid: baseChild.pid, logicVersion: host.value?.logicVersion ?? null });
  print('base log', BASE_LOG_PATH);

  // ── ① 校验各来一发：诚实 400，且**一个字都不写** ──────────────────────────────────────
  const invalid = {
    emptyNote: await baseRequest('/annotations', { method: 'POST', body: { note: '   ', kind: 'message', sessionId: SESSION_ID } }),
    badKind: await baseRequest('/annotations', { method: 'POST', body: { note: 'x', kind: 'notice', sessionId: SESSION_ID } }),
    badSession: await baseRequest('/annotations', { method: 'POST', body: { note: 'x', kind: 'message', sessionId: 'not-a-uuid' } }),
    badBlockIndex: await baseRequest('/annotations', { method: 'POST', body: { note: 'x', kind: 'message', sessionId: SESSION_ID, blockIndex: -1 } }),
    badExcerpt: await baseRequest('/annotations', { method: 'POST', body: { note: 'x', kind: 'message', sessionId: SESSION_ID, excerpt: 'a'.repeat(201) } }),
    wrongMethod: await baseRequest('/annotations', { method: 'PUT' }),
  };
  print('probe（坏输入）', Object.fromEntries(Object.entries(invalid).map(([key, reply]) => [key, { status: reply.status, body: reply.value }])));
  check('① 空 note ⇒ 400 invalid_note', invalid.emptyNote.status === 400 && invalid.emptyNote.value?.error === 'invalid_note', JSON.stringify(invalid.emptyNote.value));
  check('① 坏 kind ⇒ 400 invalid_kind', invalid.badKind.status === 400 && invalid.badKind.value?.error === 'invalid_kind', JSON.stringify(invalid.badKind.value));
  check('① 非完整 uuid 的 sessionId ⇒ 400 full_uuid_required', invalid.badSession.status === 400 && invalid.badSession.value?.error === 'full_uuid_required', JSON.stringify(invalid.badSession.value));
  check('① 坏 blockIndex ⇒ 400 invalid_block_index', invalid.badBlockIndex.status === 400 && invalid.badBlockIndex.value?.error === 'invalid_block_index', JSON.stringify(invalid.badBlockIndex.value));
  check('① 过长 excerpt ⇒ 400 invalid_excerpt', invalid.badExcerpt.status === 400 && invalid.badExcerpt.value?.error === 'invalid_excerpt', JSON.stringify(invalid.badExcerpt.value));
  check('① 坏方法 ⇒ 405 method_not_allowed', invalid.wrongMethod.status === 405 && invalid.wrongMethod.value?.error === 'method_not_allowed', JSON.stringify(invalid.wrongMethod.value));
  check('① 坏输入一个字都没落盘（annotations.jsonl 还不存在）', (await readAnnotationLines()) === null, String(ANNOTATIONS_FILE));

  // ── ② 合法 POST：服务端补字段；客户端伪造的 at/appVersion/id/state 被无视 ───────────────
  const forged = await baseRequest('/annotations', {
    method: 'POST',
    body: {
      note: NOTE_MESSAGE, kind: 'message', sessionId: SESSION_ID,
      messageId: 'a-1', blockIndex: 1, role: 'assistant', excerpt: '前 200 字',
      // 以下都是客户端**不该能定**的：服务端必须用自己的值盖掉。
      at: '1999-01-01T00:00:00.000Z', appVersion: 'forged', codeVersion: 'forged', state: 'done', id: 'an-ffffffff',
    },
  });
  print('POST ① message', { status: forged.status, body: forged.value });
  const first = forged.value?.annotation;
  check('② 合法 POST ⇒ 201，服务端补 `at`/`appVersion`/`codeVersion`/`state`/`id`',
    forged.status === 201
    && /^an-[0-9a-f]{8}$/.test(first?.id ?? '')
    && typeof first?.at === 'string' && first.at !== '1999-01-01T00:00:00.000Z' && !Number.isNaN(Date.parse(first.at))
    && first?.appVersion === 's0b-v1' && first?.codeVersion === host.value?.logicVersion
    && first?.state === 'open' && first?.resolvedAt === null && first?.resolvedBy === null,
    JSON.stringify({ id: first?.id, at: first?.at, appVersion: first?.appVersion, codeVersion: first?.codeVersion, state: first?.state }));
  check('② 客户端伪造的 id/state 被服务端覆盖（不能伪造）',
    first?.id !== 'an-ffffffff' && first?.state === 'open' && first?.appVersion === 's0b-v1',
    JSON.stringify({ id: first?.id, state: first?.state, appVersion: first?.appVersion }));
  check('② 锚点原样带上（messageId/blockIndex/role/excerpt）',
    first?.messageId === 'a-1' && first?.blockIndex === 1 && first?.role === 'assistant' && first?.excerpt === '前 200 字',
    JSON.stringify({ messageId: first?.messageId, blockIndex: first?.blockIndex, role: first?.role, excerpt: first?.excerpt }));

  const toolResult = await baseRequest('/annotations', {
    method: 'POST',
    body: { note: NOTE_TOOL, kind: 'toolResult', sessionId: SESSION_ID, messageId: 'a-1', blockIndex: 1, toolCallId: 'call_00_abc', toolName: 'bash', excerpt: '工具输出…' },
  });
  check('② 工具结果卡 ⇒ 201，带 toolCallId/toolName',
    toolResult.status === 201 && toolResult.value?.annotation?.toolCallId === 'call_00_abc' && toolResult.value?.annotation?.toolName === 'bash',
    JSON.stringify({ status: toolResult.status, toolCallId: toolResult.value?.annotation?.toolCallId, toolName: toolResult.value?.annotation?.toolName }));

  // ── ③ append-only：连发三条后，第一条**逐字节**未变 ────────────────────────────────────
  const linesAfterTwo = await readAnnotationLines();
  await baseRequest('/annotations', {
    method: 'POST',
    body: { note: '第三条（再发一次）', kind: 'message', sessionId: SESSION_ID, messageId: 'a-1', blockIndex: 1, role: 'assistant', excerpt: '再发一次' },
  });
  const linesAfterThree = await readAnnotationLines();
  print('annotations.jsonl', { file: ANNOTATIONS_FILE, lines: linesAfterThree?.length, firstLine: linesAfterThree?.[0] });
  check('③ 三条 POST ⇒ 文件恰好三行（只增）', linesAfterThree?.length === 3, JSON.stringify({ before: linesAfterTwo?.length, after: linesAfterThree?.length }));
  check('③ 第一条逐字节未变（append-only 证据）', linesAfterThree?.[0] === linesAfterTwo?.[0] && JSON.parse(linesAfterThree[0]).id === first.id, JSON.stringify({ same: linesAfterThree?.[0] === linesAfterTwo?.[0] }));
  check('③ 每一行都是合法 JSON 且 id 唯一', (() => {
    const parsed = linesAfterThree.map((line) => JSON.parse(line));
    return new Set(parsed.map((item) => item.id)).size === 3 && parsed[2].note === '第三条（再发一次）';
  })(), JSON.stringify(linesAfterThree.map((line) => JSON.parse(line).id)));

  // ── ④ GET /annotations（含 ?since=）────────────────────────────────────────────────────
  const list = await baseRequest('/annotations');
  print('GET /annotations', { status: list.status, total: list.value?.total, filtered: list.value?.filteredCount, ids: (list.value?.items ?? []).map((item) => item.id) });
  check('④ GET /annotations 回 `{items:[…]}`，三条都在', list.status === 200 && Array.isArray(list.value?.items) && list.value.items.length === 3, JSON.stringify({ status: list.status, items: list.value?.items?.length }));

  const secondAt = Date.parse(linesAfterThree[1] && JSON.parse(linesAfterThree[1]).at);
  const sinceIso = await baseRequest(`/annotations?since=${encodeURIComponent(new Date(secondAt).toISOString())}`);
  check('④ `?since=<ISO>` 只回更晚的那条', sinceIso.status === 200 && sinceIso.value?.items?.length === 1 && Date.parse(sinceIso.value.items[0].at) > secondAt, JSON.stringify({ status: sinceIso.status, count: sinceIso.value?.items?.length }));
  const sinceEpoch = await baseRequest(`/annotations?since=${secondAt}`);
  check('④ `?since=<epoch ms>` 与 ISO 同一口径', sinceEpoch.status === 200 && sinceEpoch.value?.items?.length === 1, JSON.stringify({ status: sinceEpoch.status, count: sinceEpoch.value?.items?.length }));
  const badSince = await baseRequest('/annotations?since=not-a-time');
  check('④ 坏 since ⇒ 400 invalid_since（不猜）', badSince.status === 400 && badSince.value?.error === 'invalid_since', JSON.stringify(badSince.value));

  // ── ⑤ v1.5 resolve 正向：open ⇒ done（记谁/何时），**只追加一行事件** ───────────────────
  const targetId = first.id;
  const toolResultId = toolResult.value.annotation.id;
  const linesBeforeResolve = await readAnnotationLines();
  const resolved = await baseRequest('/annotations', { method: 'POST', body: { op: 'resolve', id: targetId, by: 'wt/annot-v15 维护线', note: '已改：把那段正文重写了。' } });
  print('POST resolve（op 形式）', { status: resolved.status, body: resolved.value });
  check('⑤ resolve 正向 ⇒ 200 changed/appended:true、state=done、带 resolvedAt/resolvedBy',
    resolved.status === 200 && resolved.value?.ok === true && resolved.value?.changed === true && resolved.value?.appended === true
    && resolved.value?.alreadyDone === false && resolved.value?.state === 'done'
    && typeof resolved.value?.resolvedAt === 'string' && !Number.isNaN(Date.parse(resolved.value.resolvedAt))
    && resolved.value?.resolvedBy === 'wt/annot-v15 维护线',
    JSON.stringify(resolved.value));

  // ── ⑤（读侧）GET 把事件折进去：那条 state=done，其它两条没被连坐 ───────────────────────
  // ⚠️ 这条**排在 append-only 证据之前**：红绿对照里「resolve 不写事件行」那一版要红在
  // 「① 正向（open ⇒ done）」这条上（写侧回一句 changed:true 而读侧折不出 done —— 那正是骗人的形状）。
  const listAfterResolve = await baseRequest('/annotations');
  const foldedTarget = (listAfterResolve.value?.items ?? []).find((item) => item.id === targetId);
  print('GET /annotations（resolve 之后）', { counts: listAfterResolve.value?.counts, resolveEvents: listAfterResolve.value?.resolveEvents, target: foldedTarget });
  check('⑤ 读侧折出 state=done + resolvedAt/resolvedBy（resolveCount=1）',
    foldedTarget?.state === 'done' && foldedTarget?.resolvedBy === 'wt/annot-v15 维护线'
    && foldedTarget?.resolvedAt === resolved.value.resolvedAt && foldedTarget?.resolveCount === 1
    && foldedTarget?.note === NOTE_MESSAGE && foldedTarget?.messageId === 'a-1',
    JSON.stringify(foldedTarget));
  check('⑤ 同一次列表里其它两条仍是 open（没被连坐）',
    listAfterResolve.value?.counts?.open === 2 && listAfterResolve.value?.counts?.done === 1
    && listAfterResolve.value?.items?.filter((item) => item.state === 'open').length === 2,
    JSON.stringify(listAfterResolve.value?.counts));

  // ── ②（v1.5 那一半）append-only 证据：旧行**逐字节未变**，只多了一行事件行 ────────────────
  const linesAfterResolve = await readAnnotationLines();
  const eventLine = linesAfterResolve[linesAfterResolve.length - 1];
  print('annotations.jsonl（resolve 之后）', { lines: linesAfterResolve.length, firstLine: linesAfterResolve[0], eventLine });
  check('⑤ append-only：原行逐字节未变、行数恰好 +1、新行是 {op:resolve} 事件行',
    linesAfterResolve.length === linesBeforeResolve.length + 1
    && linesAfterResolve[0] === linesBeforeResolve[0]
    && JSON.parse(eventLine).op === 'resolve' && JSON.parse(eventLine).id === targetId
    && JSON.parse(eventLine).by === 'wt/annot-v15 维护线'
    && JSON.parse(eventLine).note === '已改：把那段正文重写了。'
    && JSON.parse(linesAfterResolve[1]).note === NOTE_TOOL,
    JSON.stringify({ before: linesBeforeResolve.length, after: linesAfterResolve.length, firstUnchanged: linesAfterResolve[0] === linesBeforeResolve[0], event: JSON.parse(eventLine) }));

  // ── ③（v1.5 那一半）幂等：已 done 再来一次 ⇒ 同 200，但**不产生第二条事件行** ──────────────
  const linesBeforeIdempotent = await readAnnotationLines();
  const again = await baseRequest('/annotations', { method: 'POST', body: { op: 'resolve', id: targetId, by: '另一个人' } });
  const linesAfterIdempotent = await readAnnotationLines();
  print('POST resolve（第二次）', { status: again.status, body: again.value });
  check('③ 幂等：changed:false/alreadyDone:true/appended:false，行数不变、resolvedBy 仍是第一次那个',
    again.status === 200 && again.value?.changed === false && again.value?.alreadyDone === true && again.value?.appended === false
    && linesAfterIdempotent.length === linesBeforeIdempotent.length
    && linesAfterIdempotent.join('\n') === linesBeforeIdempotent.join('\n')
    && again.value?.resolvedBy === 'wt/annot-v15 维护线'
    && typeof again.value?.note === 'string' && again.value.note.includes('已经'),
    JSON.stringify({ status: again.status, body: again.value, lines: [linesBeforeIdempotent.length, linesAfterIdempotent.length] }));
  const listAfterIdempotent = await baseRequest('/annotations');
  const foldedAgain = (listAfterIdempotent.value?.items ?? []).find((item) => item.id === targetId);
  check('③ 幂等之后 resolveCount 仍是 1（没有第二条事件折进去）', foldedAgain?.resolveCount === 1, JSON.stringify({ resolveCount: foldedAgain?.resolveCount }));

  // ── ⑤-b 设计文档 §1 写的等价别名：`POST /annotations/{id}/resolve` ────────────────────
  const alias = await baseRequest(`/annotations/${toolResultId}/resolve`, { method: 'POST', body: { by: '别名路径维护线' } });
  print('POST /annotations/{id}/resolve', { status: alias.status, body: alias.value });
  check('⑤-b 别名路径与 op 形式同一个处理函数：toolResult 那条也 open ⇒ done',
    alias.status === 200 && alias.value?.changed === true && alias.value?.id === toolResultId && alias.value?.resolvedBy === '别名路径维护线',
    JSON.stringify(alias.value));
  const mismatch = await baseRequest(`/annotations/${toolResultId}/resolve`, { method: 'POST', body: { id: 'an-00000000' } });
  check('⑤-b body.id 与路径不一致 ⇒ 400 invalid_annotation_id（不猜、不写）',
    mismatch.status === 400 && mismatch.value?.error === 'invalid_annotation_id', JSON.stringify(mismatch.value));

  // ── ⑤-c 对不存在的 id ⇒ 404，且**一行都不写**（不编一条孤儿事件） ─────────────────────
  const linesBeforeMissing = await readAnnotationLines();
  const missing = await baseRequest('/annotations', { method: 'POST', body: { op: 'resolve', id: 'an-00000000', by: 'x' } });
  const missingAlias = await baseRequest('/annotations/an-00000000/resolve', { method: 'POST', body: { by: 'x' } });
  const linesAfterMissing = await readAnnotationLines();
  check('⑤-c 不存在的 id ⇒ 404 annotation_not_found（两种路径都是），文件行数一字不变',
    missing.status === 404 && missing.value?.error === 'annotation_not_found'
    && missingAlias.status === 404 && missingAlias.value?.error === 'annotation_not_found'
    && linesAfterMissing.length === linesBeforeMissing.length,
    JSON.stringify({ op: [missing.status, missing.value?.error], alias: [missingAlias.status, missingAlias.value?.error], lines: [linesBeforeMissing.length, linesAfterMissing.length] }));

  // ── ⑤-d 坏输入与只读过滤（`?session=` / `?state=`） ──────────────────────────────────
  const badOp = await baseRequest('/annotations', { method: 'POST', body: { op: 'delete', id: targetId } });
  const badBy = await baseRequest('/annotations', { method: 'POST', body: { op: 'resolve', id: toolResultId, by: 'x'.repeat(ANNOTATION_BY_TOO_LONG) } });
  const badResolveId = await baseRequest('/annotations', { method: 'POST', body: { op: 'resolve', id: 'nope' } });
  check('⑤-d 坏 op/坏 by/坏 id ⇒ 400（invalid_op / invalid_by / invalid_annotation_id）',
    badOp.status === 400 && badOp.value?.error === 'invalid_op'
    && badBy.status === 400 && badBy.value?.error === 'invalid_by'
    && badResolveId.status === 400 && badResolveId.value?.error === 'invalid_annotation_id',
    JSON.stringify({ badOp: badOp.value, badBy: badBy.value, badResolveId: badResolveId.value }));
  const openFilter = await baseRequest('/annotations?state=open');
  const doneFilter = await baseRequest('/annotations?state=done');
  const mySession = await baseRequest(`/annotations?session=${SESSION_ID}`);
  const otherSession = await baseRequest('/annotations?session=22222222-2222-4222-8222-222222222222');
  const badState = await baseRequest('/annotations?state=nope');
  const badSession = await baseRequest('/annotations?session=nope');
  print('过滤', { open: openFilter.value?.filteredCount, done: doneFilter.value?.filteredCount, mine: mySession.value?.filteredCount, other: otherSession.value?.filteredCount });
  check('⑤-d `?state=open|done` 只回对应现状，`?session=<自己的 uuid>` 全回、别的 uuid 回 0 条',
    openFilter.status === 200 && openFilter.value?.filteredCount === 1 && openFilter.value?.items?.every((item) => item.state === 'open')
    && doneFilter.status === 200 && doneFilter.value?.filteredCount === 2 && doneFilter.value?.items?.every((item) => item.state === 'done')
    && mySession.value?.filteredCount === 3 && otherSession.value?.filteredCount === 0
    && openFilter.value?.total === 3,
    JSON.stringify({ open: openFilter.value?.filteredCount, done: doneFilter.value?.filteredCount, my: mySession.value?.filteredCount, other: otherSession.value?.filteredCount }));
  check('⑤-d 坏 state / 非完整 uuid 的 session ⇒ 诚实 400（不静默忽略）',
    badState.status === 400 && badState.value?.error === 'invalid_state'
    && badSession.status === 400 && badSession.value?.error === 'full_uuid_required',
    JSON.stringify({ badState: badState.value, badSession: badSession.value }));

  // ── ⑧ 500 条上限：超限 ⇒ 响应带 warning，且文件**一行都没少**（append-only 底线不破）──────
  const countOps = (lines, op) => lines.filter((line) => (JSON.parse(line).op ?? 'annotate') === op).length;
  let bulkLines = await readAnnotationLines();
  const firstLineBeforeBulk = bulkLines[0];
  let bulkPosts = 0;
  let bulkLast = null;
  while (countOps(bulkLines, 'annotate') < ANNOTATION_BULK_TARGET && bulkPosts < ANNOTATION_BULK_MAX_POSTS) {
    bulkLast = await baseRequest('/annotations', {
      method: 'POST',
      body: { note: `上限臂第 ${countOps(bulkLines, 'annotate') + 1} 条`, kind: 'message', sessionId: SESSION_ID, messageId: 'bulk', blockIndex: 0, role: 'assistant', excerpt: 'bulk' },
    });
    if (bulkLast.status !== 201) throw new Error(`上限臂：POST 没回 201，而是 ${bulkLast.status} ${bulkLast.raw}`);
    bulkPosts += 1;
    bulkLines = await readAnnotationLines();
  }
  print('上限臂', { posts: bulkPosts, annotations: countOps(bulkLines, 'annotate'), lines: bulkLines.length, events: countOps(bulkLines, 'resolve'), warning: bulkLast?.value?.warning ?? null });
  check(`⑧ 超过 ${ANNOTATION_FILE_LIMIT} 条 ⇒ 创建响应带 warning（只警告不删），总数如实报`,
    countOps(bulkLines, 'annotate') === ANNOTATION_BULK_TARGET
    && typeof bulkLast.value?.warning === 'string' && bulkLast.value.warning.includes(String(ANNOTATION_FILE_LIMIT))
    && bulkLast.value?.total === ANNOTATION_BULK_TARGET,
    JSON.stringify({ annotations: countOps(bulkLines, 'annotate'), total: bulkLast.value?.total, warning: bulkLast.value?.warning }));
  check('⑧ 一行都没少：各条创建行 + 2 行 resolve 事件行都在，第一条逐字节未变',
    bulkLines.length === ANNOTATION_BULK_TARGET + 2 && countOps(bulkLines, 'resolve') === 2
    && bulkLines[0] === firstLineBeforeBulk && JSON.parse(bulkLines[0]).id === targetId
    && bulkLines.every((line) => { try { JSON.parse(line); return true; } catch { return false; } }),
    JSON.stringify({ lines: bulkLines.length, events: countOps(bulkLines, 'resolve'), firstUnchanged: bulkLines[0] === firstLineBeforeBulk }));
  const bulkList = await baseRequest('/annotations');
  check('⑧ 满额时 GET 也如实带出 warning（清单页不会以为“一切正常”）',
    typeof bulkList.value?.warning === 'string' && bulkList.value?.total === ANNOTATION_BULK_TARGET && bulkList.value?.counts?.done === 2,
    JSON.stringify({ warning: bulkList.value?.warning, total: bulkList.value?.total, counts: bulkList.value?.counts }));
  const resolvedStillDone = (bulkList.value?.items ?? []).find((item) => item.id === targetId);
  check('⑧ 满额之后那条 done 的流转没丢（resolve 事件与后来的创建共存）',
    resolvedStillDone?.state === 'done' && resolvedStillDone?.resolvedBy === 'wt/annot-v15 维护线', JSON.stringify(resolvedStillDone));
}

// ── 臂 U：真 Chromium + 假 API ────────────────────────────────────────────────────────────
const fake = {
  posts: [], // 原始请求体（逐字），用来做 append-only 的字节断言
  store: [], // 解析后的记录（服务端补字段后的形状）
  messagesRequests: 0,
};

const messagesPayload = (id) => ({
  sessionId: id,
  messages: [
    { entryId: 'u-1', parentId: null, timestamp: Date.now() - 1000, kind: 'message', role: 'user', content: [{ type: 'text', text: '第一句用户消息：请帮我看一下。' }], text: '第一句用户消息：请帮我看一下。', images: [], parts: undefined },
    {
      entryId: 'a-1', parentId: 'u-1', timestamp: Date.now(), kind: 'message', role: 'assistant',
      content: [], text: '助手正文：我跑了个命令。', images: [],
      parts: [
        { type: 'text', text: '助手正文：我跑了个命令。' },
        { type: 'tool', toolCallId: 'call_00_abc', name: 'bash', args: { command: 'ls' }, status: 'done-success', isError: false, result: '工具输出：a b c（这一行很长很长很长…）' },
      ],
    },
  ],
  extras: [],
  compaction: { atIndex: null, entryId: null, note: '' },
  observability: null,
});

const fakeAnnotationRecord = (body, store = fake.store) => ({
  id: `an-${String(store.length + 1).padStart(8, '0')}`,
  at: new Date().toISOString(),
  note: body.note, kind: body.kind, sessionId: body.sessionId,
  messageId: body.messageId ?? null, blockIndex: body.blockIndex ?? null,
  toolCallId: body.toolCallId ?? null, toolName: body.toolName ?? null, role: body.role ?? null,
  excerpt: body.excerpt ?? null,
  appVersion: 's0b-v1', codeVersion: 'g-fake', state: 'open', resolvedAt: null, resolvedBy: null,
  resolveCount: 0, eventCount: 1,
});

async function runUiArm() {
  const treePayload = {
    sessions: [{ id: SESSION_ID, name: 'Annotate UI', parentId: null, archived: false, cwd: 'C:/work/a', modifiedAt: new Date().toISOString(), titleSource: 'auto', status: 'idle', statusLabel: '闲置', unread: false, settledAt: 0, seenAt: 0, notify: { notifies: [], waitingFor: [] } }],
    unread: { count: 0 },
  };

  const ui = await boot({
    width: 1200,
    height: 760,
    webRoot,
    routes: async (request, response, url) => {
      const { pathname } = url;
      if (pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
      if (pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
      if (pathname === '/api/tree') return sendJson(response, 200, treePayload), true;
      if (pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload)}\n\n`);
        return true;
      }
      if (pathname === '/api/annotations') {
        if (request.method === 'GET') {
          return sendJson(response, 200, { exists: true, items: fake.store, total: fake.store.length, filteredCount: fake.store.length, skipped: 0, bad: [] }), true;
        }
        if (request.method === 'POST') {
          const raw = await readBody(request);
          fake.posts.push(raw);
          let body = {};
          try { body = JSON.parse(raw); } catch { /* 坏输入在真服务端会 400；这里只验收前端发的形状 */ }
          const record = fakeAnnotationRecord(body);
          fake.store.push(record);
          return sendJson(response, 201, { ok: true, annotation: record, total: fake.store.length, warning: null }), true;
        }
      }
      if (pathname === `/api/sessions/${SESSION_ID}`) {
        return sendJson(response, 200, {
          id: SESSION_ID, name: 'Annotate UI', cwd: 'C:/work/a', archived: false,
          runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null,
        }), true;
      }
      if (pathname === `/api/sessions/${SESSION_ID}/events`) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return true;
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)\/(messages|commands|draft|seen)$/.exec(pathname);
      if (sessionMatch) {
        const action = sessionMatch[2];
        if (action === 'messages') { fake.messagesRequests += 1; return sendJson(response, 200, messagesPayload(sessionMatch[1])), true; }
        if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
        if (action === 'draft') { await readBody(request); return sendJson(response, 200, { text: '' }), true; }
        if (action === 'seen') { await readBody(request); return sendJson(response, 200, { ok: true, id: sessionMatch[1], unread: false }), true; }
      }
      return false;
    },
  });

  const problemsAtStart = ui.pageProblems.length;
  const evaluate = ui.evaluate;
  const annotateState = () => evaluate(`(() => {
    const cards = [...document.querySelectorAll('#messages article.message, #messages .tool-card')].filter((node) => node.dataset.role !== 'toolResult');
    return {
      messages: document.querySelectorAll('#messages article.message').length,
      messageControls: document.querySelectorAll('#messages article.message > .annotate').length,
      toolCards: document.querySelectorAll('#messages .tool-card').length,
      toolControls: document.querySelectorAll('#messages .tool-card > .annotate').length,
      tool: (() => {
        const control = document.querySelector('#messages .tool-card > .annotate');
        return control ? { key: control.dataset.annotateKey, messageId: control.dataset.annotateMessageId, blockIndex: control.dataset.annotateBlockIndex, toolCallId: control.dataset.annotateToolCallId, toolName: control.dataset.annotateToolName } : null;
      })(),
      assistant: (() => {
        const node = document.querySelector('#messages article.message-assistant');
        const control = node?.querySelector(':scope > .annotate');
        return control ? { key: control.dataset.annotateKey, messageId: control.dataset.annotateMessageId, blockIndex: control.dataset.annotateBlockIndex, role: control.dataset.annotateRole } : null;
      })(),
      listView: document.querySelector('main').dataset.view,
      listItems: document.querySelectorAll('#annotations-list .annotation-item').length,
      listText: document.querySelector('#annotations-list').textContent,
      rowDegenerate: cards.length === 0,
    };
  })()`);
  const openForm = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector(':scope > .annotate').querySelector('.annotate-button').click()`);
  const typeNote = (selector, value) => evaluate(`(() => { const note = document.querySelector(${JSON.stringify(selector)}).querySelector(':scope > .annotate').querySelector('.annotate-note'); note.value = ${JSON.stringify(value)}; })()`);
  const submitForm = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector(':scope > .annotate').querySelector('.annotate-form').requestSubmit()`);
  const pressKey = (selector, key) => evaluate(`(() => { const note = document.querySelector(${JSON.stringify(selector)}).querySelector(':scope > .annotate').querySelector('.annotate-note'); note.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); })()`);
  const fieldState = (selector) => evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}).querySelector(':scope > .annotate'); return { open: control.dataset.annotateOpen ?? '', state: control.dataset.annotateState ?? '', formHidden: control.querySelector('.annotate-form').hidden, doneHidden: control.querySelector('.annotate-done').hidden, status: control.querySelector('.annotate-status').textContent, value: control.querySelector('.annotate-note').value }; })()`);

  try {
    await uiWaitFor(() => evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"]') !== null`), 'tree did not render');
    await evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"] .tree-select').click()`);
    await uiWaitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not open');
    await uiWaitFor(() => evaluate(`document.querySelectorAll('#messages .tool-card').length === 1 && document.querySelectorAll('#messages article.message').length === 2`), 'cards did not render');

    const rendered = await annotateState();
    print('rendered', rendered);
    check('每张消息卡与每张工具结果卡都带上了那个小按钮（卡片 → 控件 = 1:1）',
      rendered.messageControls === 2 && rendered.toolControls === 1 && rendered.messageControls === rendered.messages,
      JSON.stringify({ messages: rendered.messages, messageControls: rendered.messageControls, toolCards: rendered.toolCards, toolControls: rendered.toolControls }));
    check('锚点是卡片自己的稳定 id（消息卡：entryId + 位置下标 + role；工具卡：所属 messageId + parts 下标 + toolCallId/name）',
      rendered.assistant?.messageId === 'a-1' && rendered.assistant?.blockIndex === '1' && rendered.assistant?.role === 'assistant'
      && rendered.tool?.messageId === 'a-1' && rendered.tool?.blockIndex === '1' && rendered.tool?.toolCallId === 'call_00_abc' && rendered.tool?.toolName === 'bash',
      JSON.stringify({ assistant: rendered.assistant, tool: rendered.tool }));

    // ── ④-a 不按按钮（也没点开）⇒ 零调用 ─────────────────────────────────────────────────
    const postsBaseline = fake.posts.length;
    await sleep(150);
    check('④ 不按按钮 ⇒ 端点零调用', fake.posts.length === postsBaseline, String(fake.posts.length));

    // ── ① 会话消息卡：点按钮 → 写一句 → 提交 ─────────────────────────────────────────────
    const assistantSelector = '#messages article.message-assistant';
    await openForm(assistantSelector);
    const opened = await fieldState(assistantSelector);
    check('① 点按钮 ⇒ 在该卡片下展开输入框（未提交前不动端点）', opened.open === 'true' && opened.formHidden === false && fake.posts.length === postsBaseline, JSON.stringify(opened));
    await typeNote(assistantSelector, NOTE_MESSAGE);
    await submitForm(assistantSelector);
    await uiWaitFor(() => fake.posts.length === 1, 'message-card annotation was not posted');
    const firstBody = JSON.parse(fake.posts[0]);
    print('POST ① message', firstBody);
    check('① 会话消息卡提交 ⇒ 端点收到 1 条，kind=message，锚点与那张卡一致',
      firstBody.kind === 'message' && firstBody.note === NOTE_MESSAGE && firstBody.sessionId === SESSION_ID
      && firstBody.messageId === 'a-1' && firstBody.blockIndex === 1 && firstBody.role === 'assistant'
      && typeof firstBody.excerpt === 'string' && firstBody.excerpt.includes('助手正文')
      && firstBody.at === undefined && firstBody.appVersion === undefined,
      JSON.stringify(firstBody));
    await uiWaitFor(async () => (await fieldState(assistantSelector)).state === 'sent', 'message card did not show the local sent mark');
    const sentState = await fieldState(assistantSelector);
    check('① 提交成功后该卡出现「已反馈 ✓」标记（v1.5：不再靠本地集合，而是服务端那份 201 记录里 state=open）', sentState.state === 'sent' && sentState.doneHidden === false && sentState.formHidden === true, JSON.stringify(sentState));
    await mkdir(artifacts, { recursive: true });
    await ui.screenshot(path.join(artifacts, 'session-cards-1200x760.png'));

    // ── ② 工具结果卡 ─────────────────────────────────────────────────────────────────────
    const toolSelector = '#messages .tool-card';
    await openForm(toolSelector);
    await typeNote(toolSelector, NOTE_TOOL);
    await submitForm(toolSelector);
    await uiWaitFor(() => fake.posts.length === 2, 'tool-card annotation was not posted');
    const secondBody = JSON.parse(fake.posts[1]);
    print('POST ② toolResult', secondBody);
    check('② 工具结果卡提交 ⇒ 1 条 kind=toolResult，且带 toolCallId/toolName 与同一个所属 messageId/下标',
      secondBody.kind === 'toolResult' && secondBody.note === NOTE_TOOL && secondBody.messageId === 'a-1' && secondBody.blockIndex === 1
      && secondBody.toolCallId === 'call_00_abc' && secondBody.toolName === 'bash' && secondBody.role === undefined
      && typeof secondBody.excerpt === 'string' && secondBody.excerpt.includes('工具输出'),
      JSON.stringify(secondBody));

    // ── ③ append-only（前端那一半的证据）：再提交一次，第一条请求体逐字节未变 ──────────────
    const firstRaw = fake.posts[0];
    await openForm(assistantSelector);
    await typeNote(assistantSelector, '再发一次，改一改措辞。');
    await submitForm(assistantSelector);
    await uiWaitFor(() => fake.posts.length === 3, 'third annotation was not posted');
    check('③ 再提交一次 ⇒ 第三条到达，但第一条请求体逐字节未变（append-only）',
      fake.posts.length === 3 && fake.posts[0] === firstRaw && fake.store.length === 3,
      JSON.stringify({ firstUnchanged: fake.posts[0] === firstRaw, count: fake.posts.length }));

    // ── ④-b Esc 取消 / 空提交 ⇒ 零调用 ───────────────────────────────────────────────────
    const beforeCancel = fake.posts.length;
    await openForm(toolSelector);
    await typeNote(toolSelector, '这条会被 Esc 取消，不该发出去。');
    await pressKey(toolSelector, 'Escape');
    await uiWaitFor(async () => (await fieldState(toolSelector)).formHidden === true, 'Esc did not close the form');
    const afterEsc = await fieldState(toolSelector);
    check('④ Esc 取消 ⇒ 表单收起、端点零调用', afterEsc.open === '' && afterEsc.formHidden === true && fake.posts.length === beforeCancel, JSON.stringify(afterEsc));

    await openForm(toolSelector);
    await typeNote(toolSelector, '   ');
    await submitForm(toolSelector);
    await sleep(150);
    check('④ 空提交 ⇒ 端点零调用（防误触）', fake.posts.length === beforeCancel, String(fake.posts.length));
    await evaluate(`document.querySelector('#messages .tool-card > .annotate .annotate-cancel').click()`);

    // ── ⑤ 只读清单页（与问题看板同级入口）───────────────────────────────────────────────
    await evaluate(`document.querySelector('#view-tab-annotations').click()`);
    await uiWaitFor(async () => {
      const state = await annotateState();
      return state.listView === 'annotations' && state.listItems === 3;
    }, 'annotations list did not render');
    const listState = await annotateState();
    print('list pane', { view: listState.listView, items: listState.listItems });
    check('⑤ 标注页列出全部反馈（时间 / 你说的话 / 类型 / 会话 / open 状态都在行里）',
      listState.listItems === 3
      && listState.listText.includes(NOTE_MESSAGE) && listState.listText.includes(NOTE_TOOL)
      && listState.listText.includes('消息卡') && listState.listText.includes('工具结果卡')
      && listState.listText.includes(SESSION_ID.slice(0, 8)) && listState.listText.includes('未处理'),
      JSON.stringify({ items: listState.listItems, text: listState.listText.slice(0, 240) }));
    await mkdir(artifacts, { recursive: true });
    await ui.screenshot(screenshotList);
    print('screenshot', screenshotList);

    const problemsAfter = ui.pageProblems.slice(problemsAtStart);
    check('全程浏览器零异常（无未捕获异常 / console.error）', problemsAfter.length === 0, JSON.stringify(problemsAfter));
  } finally {
    await ui.close();
  }
}

// ── 臂 B：前端（v1.5）—— 直播卡 → 正式卡交接，以及「已反馈 / 已处理 ✓」由**服务端 state** 驱动 ──────
// 为什么另起一份页面（而不是接着臂 U 往下跑）：④ 要量的正是「刷新之后还剩什么」（旧 document 的
// 本地记忆就是要被否掉的那一半）⇒ 只能在**新 document** 里量；臂 U 的断言（含「全程零异常」）
// 因此一字不动，不被这里的 `Page.reload` 影响。
const LIVE_TEXT = '直播第一段：我先看一眼目录再回答。';
const LIVE_TOOL_ID = 'call_00_live_annot';
const SECOND_TEXT = '第二条助手消息：与那条反馈完全无关的内容。';

// 一套卡片操作（与臂 U 里那四个同形，只是作用在另一份页面上）。
function annotationHelpers(evaluate) {
  const stateOf = (selector) => evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}).querySelector(':scope > .annotate'); const done = control.querySelector('.annotate-done'); return { open: control.dataset.annotateOpen ?? '', state: control.dataset.annotateState ?? '', formHidden: control.querySelector('.annotate-form')?.hidden ?? null, doneHidden: done.hidden, doneText: done.textContent, status: control.querySelector('.annotate-status')?.textContent ?? '' }; })()`);
  return {
    stateOf,
    open: (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector(':scope > .annotate').querySelector('.annotate-button').click()`),
    type: (selector, value) => evaluate(`(() => { const note = document.querySelector(${JSON.stringify(selector)}).querySelector(':scope > .annotate').querySelector('.annotate-note'); note.value = ${JSON.stringify(value)}; })()`),
    submit: (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector(':scope > .annotate').querySelector('.annotate-form').requestSubmit()`),
  };
}

async function runUiStateArm() {
  const treePayload = {
    sessions: [{ id: SESSION_ID, name: 'Annotate State', parentId: null, archived: false, cwd: 'C:/work/a', modifiedAt: new Date().toISOString(), titleSource: 'auto', status: 'idle', statusLabel: '闲置', unread: false, settledAt: 0, seenAt: 0, notify: { notifies: [], waitingFor: [] } }],
    unread: { count: 0 },
  };
  // 官方正文：先是用户那条（打开时只有它）；「交接」之后追加助手那条（entryId 'a-1' ⇒ index 1，
  // 与直播卡的 blockIndex 同号），另加一条**无关**的助手消息（用来量「匹配不到就不显示」）。
  const official = {
    messages: [
      { entryId: 'u-1', parentId: null, timestamp: Date.now() - 1000, kind: 'message', role: 'user', content: [{ type: 'text', text: '看看目录。' }], text: '看看目录。', images: [], parts: undefined },
    ],
  };
  const toolPart = { type: 'tool', toolCallId: LIVE_TOOL_ID, name: 'bash', args: { command: 'ls' }, status: 'done-success', isError: false, result: '工具输出：a b c' };
  const state = { stream: null, posts: [], store: [] };

  const resolveInStore = (id, by) => {
    const item = state.store.find((entry) => entry.id === id);
    if (!item) return { status: 404, body: { error: 'annotation_not_found', message: `no such annotation: ${id}` } };
    if (item.state === 'done') return { status: 200, body: { ok: true, id, state: 'done', changed: false, appended: false, alreadyDone: true, resolvedAt: item.resolvedAt, resolvedBy: item.resolvedBy } };
    item.state = 'done';
    item.resolvedAt = new Date().toISOString();
    item.resolvedBy = by ?? null;
    item.resolveCount = 1;
    return { status: 200, body: { ok: true, id, state: 'done', changed: true, appended: true, alreadyDone: false, resolvedAt: item.resolvedAt, resolvedBy: item.resolvedBy } };
  };

  const ui = await boot({
    width: 1200,
    height: 760,
    webRoot,
    routes: async (request, response, url) => {
      const { pathname } = url;
      if (pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
      if (pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
      if (pathname === '/api/tree') return sendJson(response, 200, treePayload), true;
      if (pathname === '/api/tree/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: tree.snapshot\ndata: ${JSON.stringify(treePayload)}\n\n`);
        return true;
      }
      if (pathname === '/api/annotations') {
        if (request.method === 'GET') {
          const session = url.searchParams.get('session');
          const items = session ? state.store.filter((item) => item.sessionId === session) : state.store;
          return sendJson(response, 200, { exists: true, items, total: state.store.length, filteredCount: items.length, skipped: 0, bad: [] }), true;
        }
        if (request.method === 'POST') {
          const raw = await readBody(request);
          state.posts.push(raw);
          let body = {};
          try { body = JSON.parse(raw); } catch { /* 坏输入在真服务端会 400；这里只验收前端发的形状 */ }
          if (body.op === 'resolve') {
            const done = resolveInStore(body.id, body.by);
            return sendJson(response, done.status, done.body), true;
          }
          const record = fakeAnnotationRecord(body, state.store);
          state.store.push(record);
          return sendJson(response, 201, { ok: true, annotation: record, total: state.store.length, warning: null }), true;
        }
      }
      if (pathname === `/api/sessions/${SESSION_ID}`) {
        return sendJson(response, 200, {
          id: SESSION_ID, name: 'Annotate State', cwd: 'C:/work/a', archived: false,
          runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null,
        }), true;
      }
      if (pathname === `/api/sessions/${SESSION_ID}/events`) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        state.stream = response;
        response.once('close', () => { if (state.stream === response) state.stream = null; });
        return true;
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)\/(messages|commands|draft|seen)$/.exec(pathname);
      if (sessionMatch) {
        const action = sessionMatch[2];
        if (action === 'messages') return sendJson(response, 200, { sessionId: SESSION_ID, messages: official.messages, extras: [], compaction: { atIndex: null, entryId: null, note: '' }, observability: null }), true;
        if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
        if (action === 'draft') { await readBody(request); return sendJson(response, 200, { text: '' }), true; }
        if (action === 'seen') { await readBody(request); return sendJson(response, 200, { ok: true, id: SESSION_ID, unread: false }), true; }
      }
      if (pathname === '/api/test/event' && request.method === 'POST') {
        const { name, data } = JSON.parse(await readBody(request));
        if (!state.stream || state.stream.destroyed) { sendJson(response, 409, { message: 'session stream unavailable' }); return true; }
        state.stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        sendJson(response, 200, { ok: true });
        return true;
      }
      return false;
    },
  });

  const evaluate = ui.evaluate;
  const { stateOf, open, type, submit } = annotationHelpers(evaluate);
  // 平铺（业主 2026-09-22）：直播期也是**顶层块**（assistant 段 + 顶层工具卡）—— 标注锚就挂在
  // assistant **那一段**上（与结束态的 `.message-assistant` 同形），不再是包装节点上的一个。
  const messageSelector = '#messages .live-message > .message-assistant';
  const liveToolSelector = '#messages .live-message > .tool-card';
  const officialMessageSelector = '#messages article.message-assistant';
  const officialToolSelector = '#messages .tool-card';
  const problemsAtStart = ui.pageProblems.length;

  try {
    await uiWaitFor(() => evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"]') !== null`), 'tree did not render', 15_000);
    await evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"] .tree-select').click()`);
    await uiWaitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not open', 15_000);
    await uiWaitFor(() => state.stream !== null, 'session events stream did not connect', 15_000);

    // ── 直播：一段正文 + 一张工具卡 ───────────────────────────────────────────────────────
    await ui.emit('session.start', { role: 'assistant' });
    await ui.emit('session.delta', { channel: 'text', delta: LIVE_TEXT });
    await uiWaitFor(() => evaluate(`!!document.querySelector('${messageSelector}')`), 'live block did not appear');
    await ui.emit('session.tool_start', { toolCallId: LIVE_TOOL_ID, name: 'bash', args: { command: 'ls' } });
    await ui.emit('session.tool_end', { toolCallId: LIVE_TOOL_ID, name: 'bash', isError: false, content: [{ type: 'text', text: '工具输出：a b c' }] });
    await uiWaitFor(() => evaluate(`document.querySelectorAll('${liveToolSelector}').length === 1`), 'live tool card did not appear');

    const liveAnchors = await evaluate(`(() => {
      const message = document.querySelector('${messageSelector}');
      const control = message.querySelector(':scope > .annotate');
      const toolControl = document.querySelector('${liveToolSelector} > .annotate');
      return { message: { messageId: control.dataset.annotateMessageId, blockIndex: control.dataset.annotateBlockIndex, role: control.dataset.annotateRole }, tool: { messageId: toolControl.dataset.annotateMessageId, blockIndex: toolControl.dataset.annotateBlockIndex, toolCallId: toolControl.dataset.annotateToolCallId } };
    })()`);
    print('直播卡锚点', liveAnchors);
    check('⑦ 直播卡的锚点如实：messageId 还没有（空串，**不编**）、blockIndex 是它在正文里的位置、工具卡带 toolCallId',
      liveAnchors.message.messageId === '' && liveAnchors.message.blockIndex === '1' && liveAnchors.message.role === 'assistant'
      && liveAnchors.tool.messageId === '' && liveAnchors.tool.toolCallId === LIVE_TOOL_ID,
      JSON.stringify(liveAnchors));

    // ── 对**直播**的消息卡提交一条反馈 ────────────────────────────────────────────────────
    await open(messageSelector);
    await type(messageSelector, NOTE_MESSAGE);
    await submit(messageSelector);
    await uiWaitFor(() => state.posts.length === 1, 'live message-card annotation was not posted');
    const liveMessagePost = JSON.parse(state.posts[0]);
    print('POST 直播消息卡', liveMessagePost);
    check('⑦ 直播的消息卡提交 ⇒ messageId=null（诚实）、blockIndex/role/excerpt 与那张卡一致',
      liveMessagePost.kind === 'message' && liveMessagePost.messageId === null && liveMessagePost.blockIndex === 1
      && liveMessagePost.role === 'assistant' && liveMessagePost.note === NOTE_MESSAGE
      && typeof liveMessagePost.excerpt === 'string' && liveMessagePost.excerpt.startsWith(LIVE_TEXT),
      JSON.stringify(liveMessagePost));
    await uiWaitFor(async () => (await stateOf(messageSelector)).state === 'sent', 'live card did not show the mark');
    const liveMessageMark = await stateOf(messageSelector);
    check('⑦ 提交之后直播卡上出现「已反馈 ✓」（**由服务端那份 201 记录驱动**，不是本地集合）',
      liveMessageMark.state === 'sent' && liveMessageMark.doneHidden === false && liveMessageMark.doneText === '已反馈 ✓', JSON.stringify(liveMessageMark));
    const untouchedLiveTool = await stateOf(liveToolSelector);
    check('⑦ 同一页上**没有反馈**的那张工具卡一个字都不显示（匹配不到就不显示）',
      untouchedLiveTool.state === '' && untouchedLiveTool.doneHidden === true, JSON.stringify(untouchedLiveTool));

    // ── 对**直播**的工具卡提交一条反馈（锚点靠 toolCallId）──────────────────────────────
    await open(liveToolSelector);
    await type(liveToolSelector, NOTE_TOOL);
    await submit(liveToolSelector);
    await uiWaitFor(() => state.posts.length === 2, 'live tool-card annotation was not posted');
    const liveToolPost = JSON.parse(state.posts[1]);
    print('POST 直播工具卡', liveToolPost);
    check('⑦ 直播的工具卡提交 ⇒ kind=toolResult、带 toolCallId（messageId 仍是 null）',
      liveToolPost.kind === 'toolResult' && liveToolPost.toolCallId === LIVE_TOOL_ID && liveToolPost.messageId === null,
      JSON.stringify(liveToolPost));
    await uiWaitFor(async () => (await stateOf(liveToolSelector)).state === 'sent', 'live tool card did not show the mark');

    // ── 交接：把这条助手消息落进官方正文，再走一次 `session.end`（前端会重拉 /messages）──────────
    official.messages.push({
      entryId: 'a-1', parentId: 'u-1', timestamp: Date.now(), kind: 'message', role: 'assistant',
      content: [{ type: 'text', text: `${LIVE_TEXT}后半段：目录里只有两个文件。` }],
      text: `${LIVE_TEXT}后半段：目录里只有两个文件。`, images: [],
      parts: [{ type: 'text', text: `${LIVE_TEXT}后半段：目录里只有两个文件。` }, toolPart],
    });
    official.messages.push({
      entryId: 'a-2', parentId: 'a-1', timestamp: Date.now() + 1, kind: 'message', role: 'assistant',
      content: [{ type: 'text', text: SECOND_TEXT }], text: SECOND_TEXT, images: [],
      parts: [{ type: 'text', text: SECOND_TEXT }],
    });
    await ui.emit('session.end', { stopReason: 'stop', errorMessage: null, text: '' });
    await uiWaitFor(() => evaluate(`document.querySelector('${messageSelector}') === null && document.querySelectorAll('#messages article.message-assistant').length === 2 && document.querySelectorAll('${officialToolSelector}').length === 1`), 'handover did not settle', 15_000);
    const officialAnchors = await evaluate(`(() => {
      const first = document.querySelector('#messages article.message-assistant');
      const tool = document.querySelector('#messages .tool-card');
      const control = first.querySelector(':scope > .annotate');
      const toolControl = tool.querySelector(':scope > .annotate');
      return { message: { messageId: control.dataset.annotateMessageId, blockIndex: control.dataset.annotateBlockIndex }, tool: { messageId: toolControl.dataset.annotateMessageId, blockIndex: toolControl.dataset.annotateBlockIndex, toolCallId: toolControl.dataset.annotateToolCallId } };
    })()`);
    print('正式卡锚点', officialAnchors);
    const handedMessage = await stateOf(officialMessageSelector);
    const handedTool = await stateOf(officialToolSelector);
    print('交接后的痕迹', { message: handedMessage, tool: handedTool });
    check('⑦ 直播卡 → 正式卡交接之后**仍能对上同一张卡**：消息卡靠 blockIndex+excerpt 前缀、工具卡靠 toolCallId，两张都还是「已反馈 ✓」',
      officialAnchors.message.messageId === 'a-1' && officialAnchors.message.blockIndex === '1'
      && officialAnchors.tool.toolCallId === LIVE_TOOL_ID && officialAnchors.tool.blockIndex !== liveAnchors.tool.blockIndex
      && handedMessage.state === 'sent' && handedMessage.doneText === '已反馈 ✓'
      && handedTool.state === 'sent' && handedTool.doneText === '已反馈 ✓',
      JSON.stringify({ official: officialAnchors, live: liveAnchors.tool, message: handedMessage, tool: handedTool }));
    const unrelated = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('#messages article.message-assistant')];
      const control = nodes[1]?.querySelector(':scope > .annotate') ?? null;
      if (!control) return null;
      return { cards: nodes.length, body: nodes[1].querySelector('.message-body')?.textContent ?? '', state: control.dataset.annotateState ?? '', doneHidden: control.querySelector('.annotate-done').hidden, doneText: control.querySelector('.annotate-done').textContent };
    })()`);
    check('⑦ 与反馈**无关**的那张卡片不显示任何痕迹（兜底也没乱匹配）',
      unrelated?.cards === 2 && unrelated.body.includes(SECOND_TEXT) && unrelated.state === '' && unrelated.doneHidden === true,
      JSON.stringify(unrelated));
    await mkdir(artifacts, { recursive: true });
    await ui.screenshot(path.join(artifacts, 'annotations-handover-1200x760.png'));

    // ── ④ 维护线把工具卡那条标成 done（**带外**：直接打端点，就像维护会话/curl 那样）─────────
    const toolRecord = state.store.find((item) => item.toolCallId === LIVE_TOOL_ID);
    const resolvedOutOfBand = await fetch(`http://127.0.0.1:${ui.port}/api/annotations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'resolve', id: toolRecord.id, by: 'test/annotate 维护线' }),
    }).then(async (reply) => ({ status: reply.status, body: await reply.json() }));
    print('resolve（带外）', resolvedOutOfBand);
    check('④ 带外 resolve 成功（服务端现在是 done）', resolvedOutOfBand.status === 200 && resolvedOutOfBand.body?.state === 'done', JSON.stringify(resolvedOutOfBand));
    await sleep(200);
    const staleTool = await stateOf(officialToolSelector);
    check('④ 刷新之前卡片**不自己变**（显示只随 (re)fetch 拿到的服务端 state 走，不做本地假设）',
      staleTool.state === 'sent' && staleTool.doneText === '已反馈 ✓', JSON.stringify(staleTool));

    // ── 刷新：新 document、内存清空 ⇒ 只能从服务端重新拉 ────────────────────────────────
    const problemsBeforeReload = ui.pageProblems.length;
    await ui.browser.send('Page.reload', { ignoreCache: true });
    await uiWaitFor(() => evaluate(`!!document.querySelector('#messages') && !!document.querySelector('[data-session-id="${SESSION_ID}"]')`), 'page did not come back after reload', 15_000);
    if (!(await evaluate(`document.querySelector('#prompt')?.disabled === false`))) {
      await evaluate(`document.querySelector('[data-session-id="${SESSION_ID}"] .tree-select').click()`);
    }
    await uiWaitFor(() => evaluate(`document.querySelector('#prompt').disabled === false`), 'session did not reopen after reload', 15_000);
    await uiWaitFor(() => evaluate(`document.querySelectorAll('#messages article.message-assistant').length === 2 && document.querySelectorAll('${officialToolSelector}').length === 1`), 'cards did not come back after reload', 15_000);
    await uiWaitFor(async () => (await stateOf(officialToolSelector)).state === 'done', 'tool card did not switch to done after reload');
    const reloadedTool = await stateOf(officialToolSelector);
    const reloadedMessage = await stateOf(officialMessageSelector);
    print('刷新后的痕迹', { tool: reloadedTool, message: reloadedMessage });
    check('④ 刷新（新 document、本地记忆全没了）之后：工具卡变「已处理 ✓」、消息卡仍是「已反馈 ✓」——两个状态并存 ⇒ 只能来自服务端 state',
      reloadedTool.state === 'done' && reloadedTool.doneHidden === false && reloadedTool.doneText === '已处理 ✓'
      && reloadedMessage.state === 'sent' && reloadedMessage.doneText === '已反馈 ✓',
      JSON.stringify({ tool: reloadedTool, message: reloadedMessage }));
    await ui.screenshot(path.join(artifacts, 'annotations-resolved-1200x760.png'));

    // 异常断言：reload 会掐掉旧 document 在飞的请求（导航取消）——只把这一类排除，**把原始列表都打出来**。
    const problems = ui.pageProblems.slice(problemsAtStart);
    const afterReload = ui.pageProblems.slice(problemsBeforeReload);
    const navigationNoise = /net::ERR_ABORTED|Failed to fetch|net::ERR_FAILED|EventSource/u;
    const realProblems = problems.filter((problem) => !navigationNoise.test(problem));
    print('页面异常', { 全部: problems, 刷新后: afterReload, 非导航取消: realProblems });
    check('全程浏览器零真异常（只排除 reload 那一刻被浏览器取消的在飞请求）', realProblems.length === 0, JSON.stringify(realProblems));
  } finally {
    await ui.close();
  }
}

let primaryError;
try {
  await runServerArm();
  await runUiArm();
  await runUiStateArm();
  process.stdout.write(`\n${checks} checks passed\n`);
} catch (error) {
  primaryError = error;
  process.stdout.write(`\n✗ annotate gate failed: ${error?.message ?? error}\n`);
} finally {
  if (baseChild && baseChild.exitCode === null && baseChild.signalCode === null) {
    baseChild.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      baseChild.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (baseLog) await baseLog.close().catch(() => {});
  await removeSandbox(sandbox, problems, 'remove annotate sandbox');
  try {
    finishCleanup(primaryError, problems);
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`\n✗ ${error?.message ?? error}\n`);
  }
  if (primaryError) process.exitCode = 1;
}
