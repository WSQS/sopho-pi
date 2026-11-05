#!/usr/bin/env node
// compaction-count-wire.mjs —— M-34 ① 的**端到端**门：服务端 wire 的 `compactionCount`
// 从**真 server**（沙箱 base）出来，一路喂给**同一份 `web/render.js`** 渲染，逐字看它显示什么。
//
// 为什么要有它（修前的缺口）：`test:tui-parity-m33-m34` 只拿**合成** payload 焊住前端渲染分支，
// 真 wire 上「有计数字段」这条路**没有任何门走过** —— 服务端哪天不给这个字段，那条门照样绿。
// 本门把两段接起来：
//   ① 真 server：造一条压缩过 **N=2** 次的会话 + 一条 **0** 次的会话（同一次沙箱），
//      `GET /sessions/{id}/messages` ⇒ 断言顶层 `compactionCount` 逐字 = 2 / 0（**整数**，0 也是真数）；
//   ② 真前端：把 ① 拿到的**真 payload** 喂 `renderMessages()`（真 `web/render.js` + 假 DOM），
//      断言压缩块上画的是「本会话压缩过 N 次」；
//   ③ 红绿对照（内置）：把 ① 那份 payload 里的 `compactionCount` **去掉**（其余一字不动）再渲染
//      ⇒ 必须回到「本会话压缩次数：服务端未提供」。这条同时证明：正例显示的数**来自服务端字段**，
//      不是前端拿本地画了几个压缩块充数。
//
// 定义（与 `server/base-logic.mjs` 的 messageWire 一致）：计数 = 当前 branch 里
// `type === 'compaction'` 的 entry 条数；`branch_summary` 不算；没有压缩过就是 `0`（不是 null）。
//
// 纪律：只起自己 spawn 的 A、只按那个 pid 停；高位随机端口；不碰真 profile；不 pkill。

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostStatus, poll, request, startSandboxBase, writeMinimalHome } from './perf-verify-lib.mjs';
import { FakeDocument, FakeElement } from './fake-dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const MANY_ID = 'aa00cc00-0000-4000-8000-000000000002'; // 压缩过 2 次
const ZERO_ID = 'aa00cc00-0000-4000-8000-000000000000'; // 一次都没压缩

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const iso = (seconds) => new Date(T0 + seconds * 1000).toISOString();

const checks = [];
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks.push(name);
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};

/**
 * 一条内容已知的会话：`compactions` 条 `type === 'compaction'` entry，每条后面接一条正文。
 * 形状照 `test/messages-parity-fixture.mjs` 的 fixture（session 头 + 线性 parentId 链）。
 * 返回 `{ entries, compactionIds }` —— `compactionIds` 是**append 顺序**。
 */
export function buildSessionEntries({ cwd, id, compactions, name }) {
  const entries = [];
  const compactionIds = [];
  const push = (entry) => { entries.push(entry); return entry.id; };
  let parentId = null;
  parentId = push({ type: 'session', version: 3, id, timestamp: iso(0), cwd });
  parentId = push({ type: 'session_info', id: `${id}-info`, parentId, timestamp: iso(1), name });
  let userIndex = 0;
  const pushUser = (text, at) => {
    userIndex += 1;
    return push({ type: 'message', id: `${id}-u${userIndex}`, parentId, timestamp: iso(at), message: { role: 'user', content: [{ type: 'text', text }], timestamp: T0 + at * 1000 } });
  };
  parentId = pushUser('M34-COUNT-USER-0', 2);
  for (let index = 1; index <= compactions; index += 1) {
    const compactionId = `${id}-c${index}`;
    compactionIds.push(compactionId);
    parentId = push({
      type: 'compaction', id: compactionId, parentId, timestamp: iso(10 + index * 2),
      summary: `M34-COUNT-COMPACTION-${index}`, firstKeptEntryId: `${id}-u1`, tokensBefore: 1000 * index,
    });
    parentId = pushUser(`M34-COUNT-USER-${index}`, 12 + index * 2);
  }
  return { entries, compactionIds };
}

/** 把 entries 写成一条 pi JSONL 会话文件（只写临时目录，不碰真 profile）。 */
async function writeSessionFile(sessionsRoot, id, entries) {
  const file = path.join(sessionsRoot, `${id}.jsonl`);
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return file;
}

function descendants(node, out = []) {
  for (const child of node.children ?? []) { out.push(child); descendants(child, out); }
  return out;
}

/** 用**真** `web/render.js` 渲染一份 payload（假 DOM，与 `test:s1a2` 用同一套底座），
 *  返回压缩块上的 `.compaction-count` 文本（没有这个节点就是 null）。 */
async function loadRender() {
  const renderUrl = `${pathToFileURL(path.join(repoRoot, 'web', 'render.js')).href}?m34=${Date.now()}`;
  return import(renderUrl);
}

async function renderCountText(payload) {
  const { renderMessages } = await loadRender();
  const document = new FakeDocument();
  const container = new FakeElement(document, 'section');
  renderMessages(container, payload);
  const node = descendants(container).find((candidate) => candidate.className === 'compaction-count');
  return node ? node.textContent : null;
}

async function main() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sopho-m34-count-'));
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(home, 'workspace');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeMinimalHome(home, workspace);

  const many = buildSessionEntries({ cwd: workspace, id: MANY_ID, compactions: 2, name: 'M34 count N=2' });
  const zero = buildSessionEntries({ cwd: workspace, id: ZERO_ID, compactions: 0, name: 'M34 count N=0' });
  const manyFile = await writeSessionFile(sessionsRoot, MANY_ID, many.entries);
  const zeroFile = await writeSessionFile(sessionsRoot, ZERO_ID, zero.entries);
  process.stdout.write(`${JSON.stringify({ event: 'fixture', home, manyFile, zeroFile, manyCompactions: many.compactionIds })}\n`);

  const sandbox = await startSandboxBase({ home, sessionsRoot, workspace, logPath: path.join(home, 'm34-count-base.log') });
  let primaryError = null;
  try {
    await poll('m34 count sandbox ready', () => hostStatus(sandbox.port), (host) => host?.currentWorkerPid > 0, 60_000);
    process.stdout.write(`${JSON.stringify({ event: 'sandbox_ready', port: sandbox.port, pid: sandbox.child.pid })}\n`);

    // ── ① 真 wire：N=2 ──────────────────────────────────────────────────────
    const manyResponse = await request(sandbox.port, `/sessions/${MANY_ID}/messages`, { timeoutMs: 120_000 });
    assert.equal(manyResponse.statusCode, 200, `GET /messages(N=2) -> ${manyResponse.statusCode} ${manyResponse.raw?.slice(0, 300)}`);
    const manyPayload = manyResponse.value;
    check('wire(N=2)：顶层 `compactionCount` 是**整数** 2（不是 null / 字符串 / 缺字段）',
      typeof manyPayload.compactionCount === 'number' && Number.isInteger(manyPayload.compactionCount) && manyPayload.compactionCount === 2,
      `compactionCount=${JSON.stringify(manyPayload.compactionCount)} typeof=${typeof manyPayload.compactionCount}`);
    check('wire(N=2)：`compaction`（最近一次）仍只投影最后那条 —— 计数与「最近一次」是两件事',
      manyPayload.compaction?.entryId === many.compactionIds.at(-1) && manyPayload.compactionCount !== 1,
      `compaction.entryId=${JSON.stringify(manyPayload.compaction?.entryId)} expected=${JSON.stringify(many.compactionIds.at(-1))} count=${manyPayload.compactionCount}`);

    // ── ① 真 wire：N=0（0 是真实的数，不是 null）─────────────────────────────
    const zeroResponse = await request(sandbox.port, `/sessions/${ZERO_ID}/messages`, { timeoutMs: 120_000 });
    assert.equal(zeroResponse.statusCode, 200, `GET /messages(N=0) -> ${zeroResponse.statusCode} ${zeroResponse.raw?.slice(0, 300)}`);
    const zeroPayload = zeroResponse.value;
    check('wire(N=0)：`compactionCount === 0`（**真实的 0**，不是 null / 缺字段）',
      zeroPayload.compactionCount === 0,
      `compactionCount=${JSON.stringify(zeroPayload.compactionCount)}`);
    check('wire(N=0)：没有压缩 entry 时 `compaction.atIndex === null`（既有形状不动）',
      zeroPayload.compaction?.atIndex === null,
      JSON.stringify(zeroPayload.compaction));

    // ── ② 真前端：把真 payload 喂给真 render.js ─────────────────────────────
    const manyText = await renderCountText(manyPayload);
    check('前端(N=2)：真 wire payload 渲染出「本会话压缩过 2 次」',
      manyText === '本会话压缩过 2 次', JSON.stringify(manyText));

    // N=0：一条压缩都没有 ⇒ 服务端 `compaction.atIndex === null` ⇒ 页面上**没有边界块**，
    // 计费行自然也没有落点。这是口径，不是漏画。前端「0 次 vs 缺字段」的区分由下面
    // 直接调 `compactionCountText()` 钉住（0 走 Number.isFinite(0) → 真；缺字段才走兜底）。
    const { compactionCountText } = await loadRender();
    const zeroText = await renderCountText(zeroPayload);
    check('前端(N=0)：没有压缩 ⇒ 没有压缩边界块，计费行无落点（不是漏画）',
      zeroText === null, JSON.stringify(zeroText));
    check('前端(0 vs 缺字段)：`compactionCountText` 把 0 当**真实的数**（「压缩过 0 次」），只有真缺字段才写「未提供」',
      compactionCountText({ compaction: { count: 0 } }) === '本会话压缩过 0 次'
        && compactionCountText({ compactionCount: 0 }) === '本会话压缩过 0 次'
        && compactionCountText({}) === '本会话压缩次数：服务端未提供'
        && compactionCountText({ compaction: { atIndex: null, note: 'x' } }) === '本会话压缩次数：服务端未提供',
      JSON.stringify({
        countZero: compactionCountText({ compaction: { count: 0 } }),
        topZero: compactionCountText({ compactionCount: 0 }),
        empty: compactionCountText({}),
        noCountBlock: compactionCountText({ compaction: { atIndex: null, note: 'x' } }),
      }));

    // ── ③ 红绿对照（内置）：把那个字段去掉 ⇒ 前端回到「服务端未提供」──────────
    const stripped = { ...manyPayload };
    delete stripped.compactionCount;
    const strippedText = await renderCountText(stripped);
    check('红绿对照：去掉 `compactionCount` ⇒ 前端回到「本会话压缩次数：服务端未提供」（正例那个 2 真的来自服务端字段）',
      strippedText === '本会话压缩次数：服务端未提供', JSON.stringify(strippedText));

    process.stdout.write(`${JSON.stringify({ event: 'm34_count_ok', checks: checks.length, manyCount: manyPayload.compactionCount, zeroCount: zeroPayload.compactionCount, manyText, zeroText, strippedText })}\n`);
    process.stdout.write(`RESULT M-34 compactionCount end-to-end PASS (${checks.length} checks)\n`);
  } catch (error) {
    primaryError = error;
  } finally {
    await sandbox.stop().catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
    if (primaryError) {
      process.stderr.write(`${primaryError.stack || primaryError.message}\n`);
      process.exitCode = 1;
    }
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
