#!/usr/bin/env node
// test/session-seal.mjs —— 「压缩即封存」（**反装版**）的机械门：真 pi 沙箱 + 红绿两半。
//
// 形状与判据出自 `docs/design-session-seal.md`（反装 = **同一个 id 的同一个文件被裁剪**成
// `[头] + [摘要] + [kept] + [tail]`，被裁掉的那一段另起一个**新 id** 落成归档件；原 id 一字不动）。
//
// 绿半（每一条都必须绿）：
//   G1 形状：热文件 = 头（逐字）+ 摘要 + kept + tail（正文条目**逐字节**照搬），冷段是新 id + 归档；
//     `/messages` 的 entryId 序列是源文件那份的**连续后缀**；压缩块的 `firstKeptEntryId` 在热文件里。
//   G1b **冷段与热会话是兄弟，不是父子**（业主 2026-10-05）：冷段的 `parentSession` = 热会话头里那个值
//     ⇒ 热会话是根时冷段也不带这个字段（两边都是根）、热会话有父时两者同级；**不许**指向热会话自己的文件。
//     两种情形各一条断言（只有「有父」那一侧才能把「继承」与「永远置空」分开），＋四条红臂。
//     同一组还钉住**文件层的不变量**：封存**只动那两个文件**（热会话与冷段），热会话名下那两条
//     子会话（已归档 / 活跃）的文件逐字节未变、头里的 `parentSession` 仍指向热会话。
//   G1d **详情与 `/tree` 同口径**（业主 2026-10-05 第(2)条的收尾）：`GET /sessions/{id}` 多报一个 `parentId`
//     （与 `/tree` 解 `parentId` 共用同一个 `resolveReportedParent`：侧车优先、目标真存在才认、悬垂回落会话头值）
//     ⇒ 同一个孩子在两处报**同一个**父、都指冷段；`parentSessionPath` 两边都仍是会话头里的投影（文件层真相）。
//     含两条**真**红臂（详情忽略侧车／不做存在性回落）。
//   G2 上下文等价（门的心脏）：同一句用户消息，**封存前**（另一条同内容的会话）与**封存后**各捕一次假
//      provider 的请求正文 ⇒ sha256 必须逐字相同。
//   G3 封存后还能跑；**再封一次** ⇒ `sealed:false` + `nothing_to_seal`（幂等：不许出重复冷段）。
//   G4 冷段是一份**正常可 resume**的会话（真跑一轮）。
//   G5 热 id 一个字节都不用改的东西：`seen/settled/drafts/placement` 不变、没有任何 `movedTo`/`claimedBy`；
//      冷 id 从不进 `seen.json`（归档 ⇒ 未读判据恒假）。
//   G6 名字与思考档：热文件的名字与封存前相同（且没有被下一条消息改名）、`reasoning_effort` 逐字相同
//      （这两条来源条目在真样本里都住在**冷段**里 ⇒ 必须显式搬）。
//   G7 原子性：封存那一刻的并发读者拿到的必须是**某一份完整版本**（要么封存前的字节，要么封存后的），
//      不许是半成品；且不留 `.tmp`。
//   G8 **用已有的那次压缩的边界补做一次封存**（业主 2026-09-22 的追加要求）：老会话不必再压一次；
//      `compactionEntryId` / `firstKeptEntryId` 点名边界与默认（链上最后那条）落到同一份实现；
//      点名错如实回、文件一个字节不动；cwd 没了的会话也能补做（其余写路由照旧 409）。
//     其中「真 pi 自己压过两次」那条收尾臂有一条**既有 flake**：`poll(两条 compaction 条目)` 绿的时候
//     文件还在长（pi 的压缩条目写在**回合中间**）⇒ 读到的源快照可以比封存读到的少一条。现在读之前
//     先过一道**落定门**（`waitSettledFile`：runtime idle ＋ 文件字节连续 300 ms 不变，有上界）。
//     沙箱专用注入（不设 ⇒ 零影响）能把那条 flake 复现成**确定性红**：`SOPHO_FAULT_G8_TAIL_MS`
//     （这一轮回答晚落 X ms）＋ `SOPHO_FAULT_G8_SEAL_LATE_MS`（封存晚发 Y ms）＋ `SOPHO_FAULT_G8_NO_SETTLE=1`
//     （撤掉那道落定门 ⇒ 必红，形状与那次现场逐字相同）。
//   G9 **未答问题随热尾巴搬家**：`sopho.question` 是 append-only 的状态机，而问题路由读的是**热文件**
//      ⇒ 一条**未答**问题若整段落在被裁段，封存后热会话的问题清单里就再也没有它。这一组量：
//      未答（整段在被裁段 / `ask` 在被裁段而 `update` 在热尾巴两种）⇒ 封存后热会话的问题路由给出的现状
//      与封存前**逐字段相同**，且热文件里那份与被裁段那份 `data` 逐字节相同、整行只差 id/parentId/timestamp；
//      已答（落在被裁段）⇒ **不搬**（热清单里没有它）但沿链在冷段里可读；搬问题条目**不改模型上下文**
//      （`custom` 条目一条消息都不产生，问题文本一个字不进正文）。
//   G10 **归档的冷路追加与封存共用同一条独占段**（本件）：cwd 已消失、本代没有它的 runtime 时，归档
//      直接往会话文件上追加一条 `sopho.archive`；封存则是**原地整份替换**同一个文件（temp + rename）
//      ⇒ 两个写者可以同时动一个文件（追加落进 rename 丢掉的那个旧 inode = 收据说 `changed:true`、
//      文件里没有）。这一组在**同一条会话上同时发** `/seal` 与 `/archive`，判据是「两种完整状态之一」：
//      封存成功 ＋ 归档条目在、源条目一条不丢、两份文件逐行都是合法 JSON。
//   数字门：封存后 `sessionFileBytes` = **新的**热文件大小；`/messages` 的 ETag 随内容变。
//
// 红半（每一刀都必须能把它切红，原始输出贴报告里）：
//   R1 省掉 kept 段 / R2 丢摘要 / R3 从末尾截断尾巴 / R4 抽掉链条中间一条 / R5 摘要 `parentId` 打 null /
//   R6 摘要 `parentId` 自指 / R7 不带思考档 / R8 去掉 `version` / R9 有回合在跑时发封存请求 /
//   R10 裁掉开头之后的 tailer 重锚 / R11 runtime 持有时替换 /
//   R12 把「搬未答问题」这一刀撤掉（删掉收据点名的那几条）⇒ 未答问题只在冷段里（热会话问题路由里没有它）。
//   R1–R8 的做法：**先跑真的封存拿到实现的成品**，再把那一刀施加在那份成品上，然后跑**同一条绿断言** ⇒ 必红。
//   R9/R11 走真接口与真 runtime；R10/R-G10 另起一个宿主（旧规则 / 把归档挪回段外）当红臂。
//
// 沙箱纪律：副本 home + 高位随机端口（绝不用 7331/7321）、日志写沙箱自己的目录（绝不写
// /tmp/sopho-base.log|sopho-app.log）、只按自己 spawn 的精确 pid 停（绝不 pkill）、真 profile 只读、跑完自清。
//
// 用法：node test/session-seal.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeDocument, FakeElement } from './fake-dom.mjs';
import { cleanupStep, finishCleanup } from './harness.mjs';
// 「推荐回复」那次**旁路模型调用**不是「这一轮对话的请求」——本门这里要的 prompts 是**回合请求**，
// 所以用共享识别器把它挑掉（断言强度一个字未改：要断的仍然是「这一轮只有一次回合请求」）。
import { isSuggestionBypassRequest } from './fixtures/suggestions-bypass.mjs';
import { hostStatus, poll, request as hostRequest, reserveHighPort, startSandboxBase } from './perf-verify-lib.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const MIB = 1024 * 1024;

let checks = 0;
const failures = [];
const problems = [];
/** 不中断：一次把红条目列全（报告里一眼看全貌），最后统一判。 */
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
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}\n`);

// ───────────────────────── 夹具 ─────────────────────────
// 形状照真样本（`docs/design-session-seal.md` §9 的源 A）：思考档与名字**都住在冷段里**，
// 摘要条目排在 kept **之后**（pi 自己写文件的顺序：… kept … 摘要 … tail …）。
const ISO = (seconds) => new Date(Date.parse('2026-09-01T00:00:00.000Z') + seconds * 1000).toISOString();

function buildFixture({ id, cwd, name, cold = 20, kept = 6, tail = 8, chars = 200, thinking = 'high', coldThinking = true, usageTokens = 16, parentSession = null, archived = false }) {
  const lines = [];
  const entries = [];
  let parentId = null;
  // `push` 顺手把 `parentId` 推进到刚写下的这条（与 pi 自己写文件的顺序一致：每条都挂在上一条上）。
  const push = (entry) => { entries.push(entry); lines.push(JSON.stringify(entry)); parentId = entry.id; return entry.id; };
  const ids = { messages: [], kept: [], tail: [] };
  lines.push(JSON.stringify({ type: 'session', version: 3, id, timestamp: ISO(0), cwd, ...(parentSession ? { parentSession } : {}) }));
  entries.push({ type: 'session', version: 3, id, timestamp: ISO(0), cwd, ...(parentSession ? { parentSession } : {}) });
  if (coldThinking) push({ type: 'thinking_level_change', id: 'th-0001', parentId, timestamp: ISO(1), thinkingLevel: thinking });
  push({ type: 'session_info', id: 'si-0001', parentId, timestamp: ISO(2), name });
  // 形状照**真**会话文件：assistant 消息带 `usage` / `stopReason` / `provider` / `model`
  // （少了 `usage` 会让 pi 的上下文汇总那一路抛 `Cannot read properties of undefined (reading 'totalTokens')`
  //  —— 那是 pi 自己的前提，不是本件要验的东西，所以夹具照真样本写）。
  const message = (index) => ({
    type: 'message',
    id: `m-${String(index).padStart(4, '0')}`,
    parentId,
    timestamp: ISO(10 + index),
    message: index % 2
      ? { role: 'assistant', content: [{ type: 'text', text: `MSG-${index}-${'x'.repeat(Math.max(0, chars - 20))}` }], stopReason: 'stop', provider: 'fake', model: 'fake-seal', usage: { input: Math.max(1, usageTokens - 4), output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: usageTokens }, timestamp: Date.parse(ISO(10 + index)) }
      : { role: 'user', content: [{ type: 'text', text: `MSG-${index}-${'x'.repeat(Math.max(0, chars - 20))}` }], timestamp: Date.parse(ISO(10 + index)) },
  });
  for (let index = 0; index < cold + kept + tail; index += 1) {
    const entry = message(index);
    push(entry);
    if (index < cold) ids.messages.push(entry.id);
    else if (index < cold + kept) ids.kept.push(entry.id);
    else ids.tail.push(entry.id);
    if (index === cold + kept - 1) {
      const compactionId = push({
        type: 'compaction',
        id: 'c-0001',
        parentId,
        timestamp: ISO(5 + index),
        summary: `SUMMARY-${id.slice(0, 8)}`,
        firstKeptEntryId: `m-${String(cold).padStart(4, '0')}`,
        tokensBefore: 12345,
      });
      ids.compactionId = compactionId;
    }
  }
  // 归档标记（`sopho.archive` 是会话文件里的 `custom` 条目，现状 = 该 id 最后一条）——
  // 给「挂在热会话名下的**已归档**子会话」那一类造夹具用（G1b）。
  if (archived) push({ type: 'custom', customType: 'sopho.archive', id: 'ar-0001', timestamp: ISO(5 + cold + kept + tail), data: { archived: true } });
  return { id, lines: `${lines.join('\n')}\n`, entries, ids };
}

// 独立投影（自己逐行 JSON.parse，不信服务端）：名字 / 时间戳 / 归档 / 条目数。
function projectText(text) {
  const result = { name: null, archived: null, modified: null, entries: 0, badLines: 0, ids: [], types: [] };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    result.entries += 1;
    let entry;
    try { entry = JSON.parse(line); } catch { result.badLines += 1; continue; }
    result.ids.push(entry.id ?? null);
    result.types.push(entry.type ?? null);
    if (entry.timestamp !== undefined) result.modified = entry.timestamp;
    if (entry.type === 'session_info') result.name = entry.name || null;
    if (entry.type === 'custom' && entry.customType === 'sopho.archive') result.archived = entry.data?.archived === true;
  }
  return result;
}

/**
 * 用**真前端渲染器**（`web/render.js` 的 `renderTree`）＋ 假 DOM 把一棵树画出来，回每一行的
 * `{id, depth, archived, parentRowId}`。`depth` 取行自己的 `dataset.depth`（渲染器写的就是它）；
 * `parentRowId` = DOM 上最近的那一个**会话行**祖先 —— 「这条挂在谁下面」的可见读数。
 * 与 `test/s1a2-api.mjs` / `test/fake-dom-contract.mjs` 同一法。
 */
async function renderTreeRows(treeValue, { expanded = [], atticOpen = false } = {}) {
  const { renderTree } = await import(`${pathToFileURL(path.join(sourceRoot, 'web', 'render.js')).href}?seal=${Date.now()}`);
  const document = new FakeDocument();
  const container = new FakeElement(document, 'section');
  // `treeValue` 既可是 `/tree` 的响应（`{ value: { sessions } }`），也可是直接的那份 payload。
  const list = treeValue?.value?.sessions ?? treeValue?.sessions ?? [];
  renderTree(container, list, () => {}, { expanded: new Set(expanded), atticOpen });
  const rows = [];
  const collect = (node) => {
    for (const child of node.children ?? []) {
      if (child?.dataset?.sessionId) rows.push({ id: child.dataset.sessionId, depth: Number(child.dataset.depth), archived: child.dataset.archived === 'true', parentRowId: null });
      collect(child);
    }
  };
  collect(container);
  // 会话行在 DOM 里是**平铺**的（缩进由 `dataset.depth` 表达，不是嵌套）⇒ 可见的父行 = 前面那条
  // depth-1 的行（这正是画面上的缩进关系）。
  const stack = [];
  for (const row of rows) {
    stack[row.depth] = row.id;
    stack.length = row.depth + 1;
    row.parentRowId = row.depth > 0 ? (stack[row.depth - 1] ?? null) : null;
  }
  return rows;
}

// ───────────────────────── 假 provider（按字节收请求正文）───────────
//
// 沙箱专用注入（不设 ⇒ 生产路径零影响）：`delayAnswers(n, ms)` ⇒ 把接下来 n 条**回答**请求的响应压后 ms 毫秒。
// 「回答」= 系统提示**不是** pi 的压缩摘要助手的那条请求（`compact()` 走的是另一条）。
// 它只做一件事：撑开「压缩条目已经落盘、这一轮的尾巴还没写」那段窗口 —— G8 收尾臂的 flake 就出在那里。
const SUMMARY_PROMPT_MARK = 'context summarization assistant';
function isSummaryRequest(body) {
  try { return String(JSON.parse(body.toString('utf8'))?.messages?.[0]?.content ?? '').includes(SUMMARY_PROMPT_MARK); } catch { return false; }
}
function startFakeProvider(port) {
  const calls = [];
  const plans = [];
  let delayPlan = null;
  const server = http.createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ url: incoming.url, body, at: Date.now() });
    if (incoming.url !== '/v1/chat/completions' || incoming.method !== 'POST') { response.writeHead(404).end('{}'); return; }
    // 注入：压的是**响应**（`stop` 那一帧之前）⇒ pi 的 `appendMessage` 就晚 ms 毫秒落盘。
    let delayedMs = null;
    if (delayPlan && delayPlan.remaining > 0 && !isSummaryRequest(body)) { delayPlan.remaining -= 1; delayedMs = delayPlan.ms; }
    const plan = plans.shift() ?? {};
    if (plan.hold === true) plan.usedAt = Date.now();
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-seal', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-seal', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: plan.usageTotal ?? 2 } } : {}) })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(chunk({ role: 'assistant', content: plan.text ?? 'OK' }));
    if (plan.started) plan.started();
    if (plan.hold) await plan.release; // `release` 是 Promise（`releaseNow` 才是那个 resolver）
    if (delayedMs !== null) await sleep(delayedMs);
    if (response.destroyed) return;
    response.write(chunk({}, 'stop'));
    response.end('data: [DONE]\n\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      server,
      calls,
      delayAnswers(count, ms) { delayPlan = { remaining: count, ms }; },
      plan(text, options = {}) {
        let releaseNow = null;
        const release = new Promise((done) => { releaseNow = done; });
        let started = null;
        const startedSignal = new Promise((done) => { started = done; });
        const plan = { text, hold: options.hold === true, usageTotal: options.usageTotal ?? null, started, startedSignal, release, releaseNow };
        plans.push(plan);
        return plan;
      },
    }));
  });
}

// ───────────────────────── 沙箱 ─────────────────────────
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-seal-'));
const home = path.join(sandbox, 'home');
const sessionsRoot = path.join(home, 'sessions');
const workspace = path.join(sandbox, 'workspace');
const baseLogPath = path.join(sandbox, 'base.log');
const legacyLogPath = path.join(sandbox, 'base-legacy-anchor.log');
// 「已归档子会话改挂到冷段」（业主第(2)条）的侧车：与 seals.jsonl 同目录（$ASSIST_HOME）。
const sealParentsPath = path.join(home, 'seal-parents.jsonl');
const legacyHome = path.join(sandbox, 'home-legacy');
const legacySessions = path.join(legacyHome, 'sessions');
await mkdir(sessionsRoot, { recursive: true });
await mkdir(workspace, { recursive: true });

const ID = {
  hot: '01a0b0bb-0000-4000-8000-00000000bb01',
  full: '01a0b0bb-0000-4000-8000-00000000bb02',
  sealed: '01a0b0bb-0000-4000-8000-00000000bb03',
  turn: '01a0b0bb-0000-4000-8000-00000000bb04',
  cold: '01a0b0bb-0000-4000-8000-00000000bb05',
  auto: '01a0b0bb-0000-4000-8000-00000000bb06',
  busy: '01a0b0bb-0000-4000-8000-00000000bb07',
  hold: '01a0b0bb-0000-4000-8000-00000000bb08',
  r1: '01a0b0bb-0000-4000-8000-00000000bc01',
  r2: '01a0b0bb-0000-4000-8000-00000000bc02',
  r3: '01a0b0bb-0000-4000-8000-00000000bc03',
  r4: '01a0b0bb-0000-4000-8000-00000000bc04',
  r5: '01a0b0bb-0000-4000-8000-00000000bc05',
  r6: '01a0b0bb-0000-4000-8000-00000000bc06',
  r7: '01a0b0bb-0000-4000-8000-00000000bc07',
  r8: '01a0b0bb-0000-4000-8000-00000000bc08',
  hole: '01a0b0bb-0000-4000-8000-00000000bd01',
  r11: '01a0b0bb-0000-4000-8000-00000000be01',
  r11ok: '01a0b0bb-0000-4000-8000-00000000be02',
  r11donor: '01a0b0bb-0000-4000-8000-00000000be03',
  r11sib: '01a0b0bb-0000-4000-8000-00000000be04',
  // 「用已有的那次压缩的边界补做一次封存」（业主 2026-09-22 的追加要求）
  g8a: '01a0b0bb-0000-4000-8000-00000000c801',
  g8full: '01a0b0bb-0000-4000-8000-00000000c802',
  g8expl: '01a0b0bb-0000-4000-8000-00000000c803',
  g8last: '01a0b0bb-0000-4000-8000-00000000c804',
  g8refuse: '01a0b0bb-0000-4000-8000-00000000c805',
  g8gone: '01a0b0bb-0000-4000-8000-00000000c806',
  // 「未答问题随热尾巴搬家」（本件）
  q1: '01a0b0bb-0000-4000-8000-00000000d101',
  q2: '01a0b0bb-0000-4000-8000-00000000d102',
  q3: '01a0b0bb-0000-4000-8000-00000000d103',
  q4: '01a0b0bb-0000-4000-8000-00000000d104',
  q5: '01a0b0bb-0000-4000-8000-00000000d105',
  q6: '01a0b0bb-0000-4000-8000-00000000d106',
  q7: '01a0b0bb-0000-4000-8000-00000000d107',
  r12: '01a0b0bb-0000-4000-8000-00000000d201',
  r12split: '01a0b0bb-0000-4000-8000-00000000d202',
  // 「归档的冷路追加与封存共用同一条独占段」（本件）
  g10: '01a0b0bb-0000-4000-8000-00000000e101',
  g10red: '01a0b0bb-0000-4000-8000-00000000e102',
  // 「冷段与热会话是兄弟」与「已归档子会话改挂到冷段」（业主 2026-10-05 第(1)(2)条）
  //（本单）：热会话自己有父那一种情形 ⇒ 需要一个**祖父**夹具
  //（它自己不带 compaction ⇒ 封不了，只当父指针的落点）＋ 一条指向它的嵌套热会话。
  gp: '01a0b0bb-0000-4000-8000-00000000f001',
  nested: '01a0b0bb-0000-4000-8000-00000000f002',
  childArch: '01a0b0bb-0000-4000-8000-00000000f003',
  childLive: '01a0b0bb-0000-4000-8000-00000000f004',
  // 第二条**已归档**子会话（本单）：业主第(2)条要的是「那批已归档子会话」⇒ 至少两条才能证明
  // 「改挂的是一批、不是恰好一条」＋「未归档那条不动」。
  childArch2: '01a0b0bb-0000-4000-8000-00000000f005',
  // G1d：头里 `parentSession` 指着一个**不存在的文件**的会话（悬垂的父路径 —— 父会话被删掉那种）。
  orphan: '01a0b0bb-0000-4000-8000-00000000f006',
  // 「cwd 已消失且**热**：查 cwd ＋ 写并进同一次 runExclusive」（本件）
  g11: '01a0b0bb-0000-4000-8000-00000000e201',
  g11red: '01a0b0bb-0000-4000-8000-00000000e202',
};

/**
 * **两条 compaction 的线性会话**（`[thinking, info, m0..m9, c1(firstKept=m5), m10..m19, c2(firstKept=m15), m20..m24]`）：
 * 用来证明「边界是从**点名的那条**压缩条目取的」——从 c1 封存 ⇒ 热文件里留下 c1 之后的**全部**
 * （含 c2 与新历史）、冷段只搬最老那一段；默认（不点名）则从 c2 取边界 ⇒ 冷段大得多。
 * 两条压过的会话也是真 pi 的形状（每条摘要都写在它那份 kept 之后）。
 */
function buildTwoCompactionFixture({ id, cwd, name, chars = 300 }) {
  const lines = [];
  const entries = [];
  const push = (entry) => { entries.push(entry); lines.push(JSON.stringify(entry)); return entry.id; };
  let parentId = null;
  lines.push(JSON.stringify({ type: 'session', version: 3, id, timestamp: ISO(0), cwd }));
  entries.push({ type: 'session', version: 3, id, timestamp: ISO(0), cwd });
  const message = (index) => ({ type: 'message', id: `m-${String(index).padStart(4, '0')}`, parentId, timestamp: ISO(10 + index), message: { role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `MSG-${index}-${'x'.repeat(Math.max(0, chars - 20))}` }] } });
  parentId = push({ type: 'thinking_level_change', id: 'th-0001', parentId, timestamp: ISO(1), thinkingLevel: 'high' });
  parentId = push({ type: 'session_info', id: 'si-0001', parentId, timestamp: ISO(2), name });
  for (let index = 0; index < 25; index += 1) {
    parentId = push(message(index));
    if (index === 9) parentId = push({ type: 'compaction', id: 'c-0001', parentId, timestamp: ISO(40), summary: `SUMMARY-C1-${id.slice(0, 8)}`, firstKeptEntryId: 'm-0005', tokensBefore: 1111 });
    if (index === 19) parentId = push({ type: 'compaction', id: 'c-0002', parentId, timestamp: ISO(60), summary: `SUMMARY-C2-${id.slice(0, 8)}`, firstKeptEntryId: 'm-0015', tokensBefore: 2222 });
  }
  return { id, lines: `${lines.join('\n')}\n`, entries };
}
async function seedTwo(id, overrides = {}) {
  const fixture = buildTwoCompactionFixture({ id, cwd: overrides.cwd ?? workspace, name: overrides.name ?? `SEAL-${id.slice(-4)}`, ...overrides });
  const file = path.join(sessionsRoot, `t_${id}.jsonl`);
  await writeFile(file, fixture.lines);
  fixtures.set(id, { ...fixture, file });
  return { ...fixture, file };
}

const PROBE = 'SEAL-PROBE: reply with nothing but OK';
const fixtures = new Map();
async function seed(id, overrides = {}) {
  const fixture = buildFixture({ id, cwd: overrides.cwd ?? workspace, name: overrides.name ?? `SEAL-${id.slice(-4)}`, ...overrides });
  const file = path.join(sessionsRoot, `t_${id}.jsonl`);
  await writeFile(file, fixture.lines);
  fixtures.set(id, { ...fixture, file });
  return { ...fixture, file };
}
const fileOf = (id) => fixtures.get(id)?.file ?? path.join(sessionsRoot, `t_${id}.jsonl`);
async function projectFile(file) { return projectText(await readFile(file, 'utf8')); }

/**
 * 「读源文件之前先等**落定**」—— G8 收尾臂（真 pi 自己压两次的那个真文件）的 flake 就出在这里。
 *
 * 为什么要它：那条臂原来是 `poll(还剩两条 compaction 条目)` 一绿就 `projectFile(file)`，而 pi 的
 * 压缩条目写在**回合中间**（摘要请求回来就先写它）⇒ 那条 poll 绿的时候文件**还在长**：实测那一臂
 * 新加的 5 条条目里，压缩条目是**第 1 条**，这一轮的用户消息与回答是后面 4 条（见报告的时间线）。
 * 于是「我们读到的源快照」可以比「封存实现读到的源」少一条（现场：`sourceEntries:61` vs 62 ⇒ `hotAppended:3`）。
 * 修的就是**何时读**这一件事：等一下再读，一条断言都不松。
 *
 * 判据两条（都要满足）：
 *   ① 会话 **idle**（`/sessions/{id}` 的 runtime 不是 streaming / compacting / retrying）—— 回合真的结束了；
 *   ② 文件**字节连续不变**并已持续 `stableMs`（撑住「还没落盘的尾巴」；比只看 size/mtime 更不会骗人）。
 * 两条都有**上界**：超时**不抛**（抛了会把后面所有臂一起带走），回 `{ok:false, reason:'settle_timeout'}`
 * 交给调用方判**明确的红**。
 */
async function waitSettledFile(file, { idle, timeoutMs = 30_000, stableMs = 300, intervalMs = 50 } = {}) {
  const startedAt = Date.now();
  let bytes = null;
  let unchangedSince = null;
  while (true) {
    let text = null;
    try { text = await readFile(file, 'utf8'); } catch (error) { text = `\u0000read-error:${error.code ?? error.message}`; }
    if (bytes !== null && text === bytes) unchangedSince ??= Date.now();
    else { bytes = text; unchangedSince = null; }
    // runtime 那份事实**只能证伪**：能确认它在忙（streaming/compacting/retrying）就挡住；读不到就当「没有
    // 写者」（那时候靠的就是上面那条字节稳定窗口）。
    let runtime = null;
    let busy = false;
    try {
      const facts = (await idle()).value?.runtime ?? null;
      if (facts) {
        runtime = { isStreaming: facts.isStreaming === true, isCompacting: facts.isCompacting === true, isRetrying: facts.isRetrying === true };
        busy = runtime.isStreaming || runtime.isCompacting || runtime.isRetrying;
      }
    } catch { /* 读不到 ⇒ 只靠字节稳定窗口 */ }
    const stableForMs = unchangedSince === null ? 0 : Date.now() - unchangedSince;
    const result = { ok: !busy && stableForMs >= stableMs, waitedMs: Date.now() - startedAt, stableForMs, bytes: text.length, runtime };
    if (result.ok) return result;
    if (Date.now() + intervalMs > startedAt + timeoutMs) return { ...result, ok: false, reason: 'settle_timeout', timeoutMs };
    await sleep(intervalMs);
  }
}

/**
 * 同一个夹具再插一组 `sopho.question` 条目：`cold` 插在 `session_info` 之后（**被裁段**里）、
 * `tail` 插在摘要条目之后（**热尾巴**里）。插完**重串一遍父指针** —— 夹具本来是一条线性链，
 * 在中间插条目会把链在插入处断开（那量到的是「文件坏了」，不是本件要验的东西）。
 */
async function seedQuestions(id, { cold = [], tail = [], ...overrides } = {}) {
  const fixture = await seed(id, overrides);
  const lines = (await readFile(fixture.file, 'utf8')).split('\n').filter((line) => line !== '');
  const header = lines[0];
  const body = lines.slice(1).map((line) => JSON.parse(line));
  const stamp = (data, tag) => ({ type: 'custom', customType: 'sopho.question', id: `sq-${tag}`, timestamp: ISO(2), data });
  const compactionAt = body.findIndex((entry) => entry.type === 'compaction');
  const infoAt = body.findIndex((entry) => entry.type === 'session_info');
  // 先插尾巴（摘要之后），再插被裁段（名字那条之后）—— 第二步的插入点在第一步动的范围之前，下标不受影响。
  const withTail = [...body.slice(0, compactionAt + 1), ...tail.map((data, index) => stamp(data, `t${index + 1}`)), ...body.slice(compactionAt + 1)];
  const answer = [...withTail.slice(0, infoAt + 1), ...cold.map((data, index) => stamp(data, `c${index + 1}`)), ...withTail.slice(infoAt + 1)];
  for (let index = 0; index < answer.length; index += 1) answer[index].parentId = index === 0 ? null : answer[index - 1].id;
  await writeFile(fixture.file, `${[header, ...answer.map((entry) => JSON.stringify(entry))].join('\n')}\n`);
  return { ...fixture, entries: answer };
}

/** `questionDedupeKey` 的算法（`server/base-logic.mjs:1765`）：**归一化**文本（`trim` ＋ 空白折叠 ＋ 小写）的 sha1 前 12 位。 */
const dedupeKeyOf = (text) => createHash('sha1').update(text.trim().replace(/\s+/gu, ' ').toLowerCase()).digest('hex').slice(0, 12);
/** 对照：**不**归一化直接哈希 ⇒ 与上面必然不同（证明归一化真的在起作用）。 */
const rawSha1 = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);
/** 一条问题的「给用户看的现状」——与服务的 `questionFacts` 同口径（去掉文件里的账 `entryId`/`entryCount`）。 */
const questionFacts = (question) => {
  if (!question) return null;
  const { entryId, entryCount, ...facts } = question;
  return facts;
};
const questionOf = (view, id) => (view.value?.questions ?? []).find((question) => question.id === id) ?? null;

let providerPort;
let base;
let legacyBase;
let provider;
let primaryError = null;
try {
  providerPort = await reserveHighPort();
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        // `supportsReasoningEffort` 是 R7/G6 的前提：没有它 pi 根本不发 `reasoning_effort`，那条断言就是空的。
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, thinkingFormat: 'openai' },
        // `contextWindow: 4096` + `keepRecentTokens: 128` 是为了让**自动压缩**在沙箱里确定性地发生
        // （自动封存的触发点是「压缩**回合**落定」⇒ 门里必须真的走一次 pi 自己的自动压缩）。
        models: [{ id: 'fake-seal', name: 'Seal Fake', contextWindow: 4096, maxTokens: 1024, reasoning: true, input: ['text'] }],
      },
    },
  }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-seal',
    // 默认档 = medium：与源文件里的 high **不同** ⇒ 「热文件没带上思考档」会立刻可见（§9.8 的口径）。
    defaultThinkingLevel: 'medium',
    // 自动压缩**开着**（阈值 = 4096 − 256 = 3840 tokens）：只有夹具自己把 `usage` 报大（`usageTokens: 5000`）
    // 的那条会在回合里被 pi 自己压一次 —— 那正是自动封存要等的「压缩回合」。其余夹具都远在阈值之下。
    compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`);
  // 手工标题：封存**不许**把它挤成 seed（`titles.json` 一起写的门）。
  await writeFile(path.join(home, 'titles.json'), `${JSON.stringify({ [ID.hot]: { title: 'SEAL-bb01', source: 'manual', at: 1 } }, null, 2)}\n`);

  provider = await startFakeProvider(providerPort);
  base = await startSandboxBase({ home, sessionsRoot, workspace, logPath: baseLogPath, extraEnv: { SOPHO_MAX_HOT: '16', SOPHO_FAULT_SEAL_HOLD_BEFORE_RENAME_MS: `800:${ID.g10}`, SOPHO_FAULT_ARCHIVE_HOT_GAP_MS: `2500:${ID.g11}` } });
  await poll('seal sandbox ready', () => hostStatus(base.port), (host) => host?.currentWorkerPid > 0, 60_000);
  print('# sandbox', { home, workspace, basePort: base.port, providerPort, hostPid: base.child.pid, log: baseLogPath });

    /** 带响应头的一次请求（perf-verify-lib 的 `request` 不返回 headers；ETag 那条数字门要它）。 */
  const rawRequest = (pathname, options = {}) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: base.port, path: pathname, method: options.method ?? 'GET', headers: { accept: 'application/json', connection: 'close', ...(options.body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(options.body) } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const buffer = Buffer.concat(chunks);
        let value = null;
        try { value = buffer.length ? JSON.parse(buffer.toString('utf8')) : null; } catch { value = null; }
        resolve({ statusCode: response.statusCode, headers: response.headers, bytes: buffer.length, value });
      });
    });
    req.once('error', (error) => resolve({ statusCode: 0, headers: {}, bytes: 0, value: null, error: error.message }));
    req.end(options.body ?? undefined);
  });
  const api = (pathname, options = {}) => hostRequest(base.port, pathname, {
    timeoutMs: options.timeoutMs ?? 120_000,
    method: options.method ?? 'GET',
    body: options.body === undefined ? null : JSON.stringify(options.body),
  });
  const messagesOf = async (id, options = {}) => api(`/sessions/${id}/messages`, options);
  const sealOf = (id, body = {}) => api(`/sessions/${id}/seal`, { method: 'POST', body });
  const questionsOf = (id, query = '') => api(`/sessions/${id}/questions${query}`);
  const treeOf = () => api('/tree');
  const rowOf = (tree, id) => (tree.value?.sessions ?? []).find((row) => row.id === id) ?? null;
  const waitIdle = async (id, timeoutMs = 30_000) => poll(`idle ${id}`, () => api(`/sessions/${id}`), (response) => response.value?.runtime?.isStreaming === false && response.value?.runtime?.isCompacting === false, timeoutMs);
  /** 发一轮并收下这一轮里 provider 收到的请求正文（`prompts`）。 */
  const send = async (id, text, { hold = false, usageTotal = null, timeoutMs = 60_000 } = {}) => {
    const mark = provider.calls.length;
    // `usageTotal` 让这一轮的**回答**报一个大 usage ⇒ pi 在**下一轮**的 preflight 上会再压一次
    // （`estimateContextTokens` 用的是「最后一条 assistant 的 usage + 之后那些条目的估算」）。
    const plan = hold || usageTotal !== null ? provider.plan('OK', { hold, usageTotal }) : null;
    const accepted = await api(`/sessions/${id}/message`, { method: 'POST', body: { text }, timeoutMs });
    if (accepted.statusCode !== 202) return { accepted, prompts: [], plan };
    if (plan) return { accepted, prompts: [], plan };
    await waitIdle(id, timeoutMs);
    await sleep(150);
    const prompts = provider.calls.slice(mark)
      .filter((call) => call.url === '/v1/chat/completions' && !isSuggestionBypassRequest(call.body))
      .map((call) => ({ bytes: call.body.length, sha256: sha256(call.body), body: call.body }));
    return { accepted, prompts, plan };
  };
  // `/host` 的树索引账在**顶层** `memoryPolicy.caches.treeIndex`（workerDetails 是别的形状）。
  const treeCounts = async () => (await api('/host', { timeoutMs: 30_000 })).value?.memoryPolicy?.caches?.treeIndex ?? null;
  const listFiles = async () => (await readdir(sessionsRoot)).filter((name) => name.endsWith('.jsonl')).sort();

  // ═════════════ 绿半 ═════════════
  const hot = await seed(ID.hot, { name: 'SEAL-HOT' });
  const full = await seed(ID.full, { name: 'SEAL-FULL' });
  const sealed = await seed(ID.sealed, { name: 'SEAL-SEALED' });
  const turn = await seed(ID.turn, { name: 'SEAL-TURN' });
  const cold = await seed(ID.cold, { name: 'SEAL-COLD' });

  // 预热：让 /tree 先把这几份都投影过（封存后第一次 /tree 的「重扫一次」才有可比基线）。
  const treeWarm = await treeOf();
  check('树里能看到夹具（预热扫描完成）', (treeWarm.value?.sessions ?? []).length >= 5, JSON.stringify({ rows: treeWarm.value?.sessions?.length, partial: treeWarm.value?.partial ?? false }));
  const hotBefore = await projectFile(hot.file);
  const messagesBefore = await messagesOf(ID.hot);
  const etagBefore = (await rawRequest(`/sessions/${ID.hot}/messages`)).headers?.etag ?? null;
  check('夹具的压缩块在正文里（`atIndex` 是**消息**下标，不是条目下标）',
    messagesBefore.statusCode === 200 && Number.isInteger(messagesBefore.value?.compaction?.atIndex) && messagesBefore.value.compaction.firstKeptEntryId === hot.ids.kept[0],
    JSON.stringify({ status: messagesBefore.statusCode, atIndex: messagesBefore.value?.compaction?.atIndex, count: messagesBefore.value?.messages?.length, firstKeptEntryId: messagesBefore.value?.compaction?.firstKeptEntryId }));

  // ── G1：形状 ────────────────────────────────────────────────────────────
  const filesBeforeSeal = await listFiles();
  const projectedBeforeSeal = Number((await treeCounts())?.filesProjected ?? 0);
  const startedAt = Date.now();
  const receipt = await sealOf(ID.hot);
  check('G1 `POST /sessions/{id}/seal` ⇒ 200 + `sealed:true`',
    receipt.statusCode === 200 && receipt.value?.sealed === true,
    JSON.stringify({ status: receipt.statusCode, value: receipt.value, ms: Date.now() - startedAt }));
  const hotAfter = await projectFile(hot.file);
  const coldFile = receipt.value?.cold?.file ?? null;
  const coldProjection = coldFile ? await projectFile(coldFile) : null;
  const hotSourceLines = hot.lines.split('\n').filter((line) => line !== '');
  const hotNowLines = (await readFile(hot.file, 'utf8')).split('\n').filter((line) => line !== '');
  const appendedHot = hotNowLines.slice(2 + hot.ids.kept.length + hot.ids.tail.length);
  check('G1 热文件：头**逐字照抄**，正文 = 摘要 ＋ kept（逐字节）＋ tail（逐字节）＋ 显式补的设置条目',
    hotNowLines[0] === hotSourceLines[0]
    && hotNowLines[1] === JSON.stringify(hot.entries.find((entry) => entry.type === 'compaction'))
    && hot.ids.kept.every((id, index) => hotNowLines[2 + index] === hotSourceLines.find((line) => line.includes(`"${id}"`)))
    && hot.ids.tail.every((id, index) => hotNowLines[2 + hot.ids.kept.length + index] === hotSourceLines.find((line) => line.includes(`"${id}"`))),
    JSON.stringify({ hotLines: hotNowLines.length, sourceLines: hotSourceLines.length, appended: appendedHot.length, firstLineEqual: hotNowLines[0] === hotSourceLines[0] }));
  check('G1 热文件补上的两条**落在叶路径上**（parentId 链起来，不是挂在根上）',
    appendedHot.length === 2
    && appendedHot[0].includes('"thinking_level_change"')
    && appendedHot[1].includes('"session_info"')
    && JSON.parse(appendedHot[0]).parentId === hot.ids.tail.at(-1)
    && JSON.parse(appendedHot[1]).parentId === JSON.parse(appendedHot[0]).id,
    JSON.stringify({ appended: appendedHot.map((line) => JSON.parse(line).type), parents: appendedHot.map((line) => JSON.parse(line).parentId) }));
  const messagesAfter = await messagesOf(ID.hot);
  const beforeIds = (messagesBefore.value?.messages ?? []).map((message) => message.entryId);
  const afterIds = (messagesAfter.value?.messages ?? []).map((message) => message.entryId);
  const suffix = beforeIds.slice(beforeIds.length - afterIds.length);
  check('G1 `/messages` 的 entryId 序列 = 源那份的**连续后缀**（逐条相同）',
    afterIds.length > 0 && suffix.length === afterIds.length && suffix.every((id, index) => id === afterIds[index]),
    JSON.stringify({ before: beforeIds.length, after: afterIds.length, suffixMatches: suffix.every((id, index) => id === afterIds[index]), firstDiff: afterIds.findIndex((id, index) => id !== suffix[index]) }));
  check('G1 压缩块里的 `firstKeptEntryId` **在热文件里**（kept 段没有被省掉）',
    messagesAfter.value?.compaction?.firstKeptEntryId === hot.ids.kept[0] && hotAfter.ids.includes(hot.ids.kept[0]),
    JSON.stringify({ firstKeptEntryId: messagesAfter.value?.compaction?.firstKeptEntryId, atIndex: messagesAfter.value?.compaction?.atIndex, keptInHot: hotAfter.ids.includes(hot.ids.kept[0]) }));
  check('G1 热文件真的小了，且少掉的正是冷段那一截',
    hotAfter.entries === 1 + 1 + hot.ids.kept.length + hot.ids.tail.length + 2 && hotBefore.entries === 1 + 1 + 2 + hot.ids.messages.length + hot.ids.kept.length + hot.ids.tail.length,
    JSON.stringify({ beforeEntries: hotBefore.entries, afterEntries: hotAfter.entries, kept: hot.ids.kept.length, tail: hot.ids.tail.length, cold: hot.ids.messages.length }));
  // 兄弟判定（**一条尺子**：绿臂与下面的红臂量的是同一个谓词）：热会话头里有 `parentSession` ⇒ 冷段必须
  // **逐字继承同一个值**；热会话是根（头里没这个字段）⇒ 冷段头里也**不许**有这个字段。
  const siblingOfHot = (coldHeader, hotHeader) => (Object.hasOwn(hotHeader, 'parentSession')
    ? coldHeader.parentSession === hotHeader.parentSession
    : !Object.hasOwn(coldHeader, 'parentSession'));
  check('G1 冷段：新 id + 归档 + 正文 = 源的那一段（逐字节）',
    coldProjection !== null
    && coldProjection.ids[0] === receipt.value.cold.id
    && coldProjection?.entries === 1 + hot.ids.messages.length + 2 + 2 // 头 ＋ 冷段正文（20 条消息 ＋ 思考档 ＋ 名字）＋ 补的 session_info ＋ archive
    && coldProjection.archived === true
    && JSON.parse((await readFile(coldFile, 'utf8')).split('\n')[0]).version === 3,
    JSON.stringify({ coldId: receipt.value.cold.id, entries: coldProjection?.entries, archived: coldProjection?.archived, name: coldProjection?.name, bytes: receipt.value.cold.bytes }));
  // ★这一条是 2026-10-05 收緊的：以前钉的是「冷段的 `parentSession` → **热文件**（树上就是它的子）」。
  // 业主的要求是**兄弟** ⇒ 旧判断反过来：冷段**不许**指向热会话自己的文件。
  const coldHeaderAfter = JSON.parse((await readFile(coldFile, 'utf8')).split('\n')[0]);
  const hotHeaderAfterSeal = JSON.parse(hotNowLines[0]);
  check('G1 冷段与热会话是**兄弟**（不是它的子）：热会话是根 ⇒ 冷段头里没有 `parentSession`、收据如实回报 null',
    siblingOfHot(coldHeaderAfter, hotHeaderAfterSeal) === true
    && coldHeaderAfter.parentSession !== hot.file
    && receipt.value.cold.parentSession === null,
    JSON.stringify({ coldParentSession: coldHeaderAfter.parentSession ?? null, hotParentSession: hotHeaderAfterSeal.parentSession ?? null, coldHeaderKeys: Object.keys(coldHeaderAfter), receiptColdParent: receipt.value.cold.parentSession, hotFile: hot.file }));
  const coldId = receipt.value?.cold?.id ?? null;
  const coldDetail = coldId === null ? { statusCode: 0, value: null } : await api(`/sessions/${coldId}`);
  check('G1 冷段的 `/sessions/{id}` 200、`parentSessionPath` 为 null（与热会话同级）、`archived:true`、名字保留',
    coldDetail.statusCode === 200 && coldDetail.value?.parentSessionPath === null && coldDetail.value?.archived === true && coldDetail.value?.name === 'SEAL-HOT',
    JSON.stringify({ status: coldDetail.statusCode, parentSessionPath: coldDetail.value?.parentSessionPath, archived: coldDetail.value?.archived, name: coldDetail.value?.name }));
  const treeAfter = await treeOf();
  const coldRow = coldId === null ? null : rowOf(treeAfter, coldId);
  check('G1 `/tree` 里冷段是**根行**（parentId null，与热会话并列）+ 归档行；热行 id / name 不变',
    coldRow !== null && coldRow?.parentId === null && coldRow?.archived === true && rowOf(treeAfter, ID.hot)?.name === 'SEAL-HOT' && rowOf(treeAfter, ID.hot)?.id === ID.hot,
    JSON.stringify({ coldRow: coldRow && { id: coldRow.id, parentId: coldRow.parentId, archived: coldRow.archived, name: coldRow.name }, hotRow: rowOf(treeAfter, ID.hot)?.name }));
  check('G1 备份：落在会话扫描之外、且不以 `.jsonl` 结尾（不会被当成第二条会话）',
    typeof receipt.value.backup?.file === 'string'
    && !receipt.value.backup.file.endsWith('.jsonl')
    && receipt.value.backup.insideSessionsRoot === false
    && (await stat(receipt.value.backup.file)).size === receipt.value.hot.bytesBefore,
    JSON.stringify(receipt.value.backup));
  check('G1 会话目录里**只多了一份新文件**（冷段），没有临时件留下',
    JSON.stringify(await listFiles()) === JSON.stringify([...filesBeforeSeal, path.basename(coldFile)].sort()),
    JSON.stringify({ before: filesBeforeSeal, after: await listFiles() }));

  // ── G1b：冷段与热会话是**兄弟**（热会话自己有父那一侧）＋ 红臂 ────────────────────
  // 为什么必须有这一组：「继承父级」与「永远置空」在「热会话是根」那一侧是**同一个结果**
  //（根 ⇒ 冷段也不带父指针）—— 只测根就等于没测「继承」这件事。所以这里造一条**有父的**热会话。
  const grandparent = await seed(ID.gp, { name: 'SEAL-GP' });
  const nested = await seed(ID.nested, { name: 'SEAL-NESTED', parentSession: grandparent.file });
  // 热会话名下挂**三条子会话**：**两条已归档**（本单要改挂的那一批）＋ 一条活跃（本单明确**不动**）。
  // 文件层的事实（G1b）先说清：封存**只动热会话与冷段两个文件** ⇒ 子会话文件逐字节不变、头里的
  // `parentSession` 仍指向热会话；改挂走的是**侧车**，不是重写它们的文件。
  const childArch = await seed(ID.childArch, { name: 'SEAL-CHILD-ARCH', parentSession: nested.file, archived: true });
  const childArch2 = await seed(ID.childArch2, { name: 'SEAL-CHILD-ARCH2', parentSession: nested.file, archived: true });
  const childLive = await seed(ID.childLive, { name: 'SEAL-CHILD-LIVE', parentSession: nested.file });
  const hashSessionFiles = async () => {
    const out = {};
    for (const name of await listFiles()) out[name] = sha256(await readFile(path.join(sessionsRoot, name)));
    return out;
  };
  const ledgerRecords = async () => {
    try {
      return (await readFile(path.join(home, 'seals.jsonl'), 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
    } catch { return []; }
  };
  // ── 改前基线（业主第(2)条：改挂之前该是什么样）──────────────────────────────
  await treeOf(); // 先把这几条扫进索引（改前/改后同一摆法）
  const nestedTreeBefore = await treeOf();
  const rowsBefore = await renderTreeRows(nestedTreeBefore, { expanded: [ID.gp, ID.nested] });
  const rowBefore = (id) => rowsBefore.find((row) => row.id === id) ?? null;
  const sidecarBefore = await stat(sealParentsPath).then(() => 'exists', (error) => error?.code === 'ENOENT' ? 'missing' : `error:${error.code}`);
  const ledgerBefore = (await ledgerRecords()).length;
  check('G1c 改前：侧车 `seal-parents.jsonl` 不存在（这条会话还没人封过）+ 账里还没有这条会话的记录',
    sidecarBefore === 'missing',
    JSON.stringify({ sealParentsFile: sealParentsPath, before: sidecarBefore, ledgerRecords: ledgerBefore }));
  check('G1c 改前：两条**已归档**子会话与那条**未归档**子会话在 `/tree` 里都挂在**热会话**名下（父 id = 热会话）',
    rowOf(nestedTreeBefore, ID.childArch)?.parentId === ID.nested
    && rowOf(nestedTreeBefore, ID.childArch2)?.parentId === ID.nested
    && rowOf(nestedTreeBefore, ID.childLive)?.parentId === ID.nested
    && rowBefore(ID.childArch)?.parentRowId === ID.nested && rowBefore(ID.childArch2)?.parentRowId === ID.nested && rowBefore(ID.childLive)?.parentRowId === ID.nested,
    JSON.stringify({ tree: { arch: rowOf(nestedTreeBefore, ID.childArch)?.parentId ?? null, arch2: rowOf(nestedTreeBefore, ID.childArch2)?.parentId ?? null, live: rowOf(nestedTreeBefore, ID.childLive)?.parentId ?? null }, rendered: { arch: rowBefore(ID.childArch)?.depth ?? null, archParent: rowBefore(ID.childArch)?.parentRowId ?? null, live: rowBefore(ID.childLive)?.depth ?? null } }));
  const filesBeforeNestedSeal = await hashSessionFiles();
  // ── 封存（改后读数）───────────────────────────────────────────────────
  const nestedReceipt = await sealOf(ID.nested);
  const nestedColdFile = nestedReceipt.value?.cold?.file ?? null;
  const nestedColdId = nestedReceipt.value?.cold?.id ?? null;
  const nestedColdHeader = nestedColdFile ? JSON.parse((await readFile(nestedColdFile, 'utf8')).split('\n')[0]) : null;
  const nestedHeaderNow = JSON.parse((await readFile(nested.file, 'utf8')).split('\n')[0]);
  check('G1b 热会话自己有父 ⇒ 冷段的 `parentSession` **逐字继承同一个父**（不是热会话自己的文件）',
    nestedReceipt.value?.sealed === true
    && nestedHeaderNow.parentSession === grandparent.file
    && siblingOfHot(nestedColdHeader, nestedHeaderNow) === true
    && nestedColdHeader.parentSession === grandparent.file
    && nestedReceipt.value.cold.parentSession === grandparent.file,
    JSON.stringify({ sealed: nestedReceipt.value?.sealed, hotParent: nestedHeaderNow.parentSession, coldParent: nestedColdHeader?.parentSession ?? null, receiptColdParent: nestedReceipt.value?.cold?.parentSession, hotFile: nested.file }));
  const nestedTree = await treeOf();
  const nestedColdRow = nestedColdFile ? rowOf(nestedTree, nestedReceipt.value.cold.id) : null;
  check('G1b `/tree`：冷段的 parentId = **祖父**那个 id（与热会话同级），热会话自己的 parentId 没变',
    nestedColdRow !== null && nestedColdRow.parentId === ID.gp && nestedColdRow.archived === true
    && rowOf(nestedTree, ID.nested)?.parentId === ID.gp
    && rowOf(nestedTree, ID.nested)?.parentId !== nestedColdRow.id,
    JSON.stringify({ coldRow: nestedColdRow && { id: nestedColdRow.id, parentId: nestedColdRow.parentId, archived: nestedColdRow.archived }, hotRow: rowOf(nestedTree, ID.nested)?.parentId, grandparent: ID.gp }));
  // 子会话那三条：文件层的不变量（封存**没有**任何机制去改它们的文件）+ 三条子会话头里的 `parentSession` 读数。
  const filesAfterNestedSeal = await hashSessionFiles();
  const changedFiles = Object.keys(filesAfterNestedSeal)
    .filter((name) => filesBeforeNestedSeal[name] !== filesAfterNestedSeal[name])
    .sort();
  const untouchedOthersOk = (before, after) => {
    const changed = Object.keys(after).filter((name) => before[name] !== after[name]).sort();
    return changed.length === 2 && changed.includes(path.basename(nested.file)) && changed.includes(path.basename(nestedColdFile));
  };
  check('G1b 封存**只动那两个文件**（热会话与冷段）：别的会话文件（含三条子会话）逐字节没变',
    nestedReceipt.value?.sealed === true && untouchedOthersOk(filesBeforeNestedSeal, filesAfterNestedSeal) === true,
    JSON.stringify({ changed: changedFiles, expected: [path.basename(nested.file), path.basename(nestedColdFile)].sort(), childArchBytesSame: filesBeforeNestedSeal[path.basename(childArch.file)] === filesAfterNestedSeal[path.basename(childArch.file)], childArch2BytesSame: filesBeforeNestedSeal[path.basename(childArch2.file)] === filesAfterNestedSeal[path.basename(childArch2.file)], childLiveBytesSame: filesBeforeNestedSeal[path.basename(childLive.file)] === filesAfterNestedSeal[path.basename(childLive.file)] }));
  const childParentFacts = {
    childArchHeader: JSON.parse((await readFile(childArch.file, 'utf8')).split('\n')[0]).parentSession ?? null,
    childArch2Header: JSON.parse((await readFile(childArch2.file, 'utf8')).split('\n')[0]).parentSession ?? null,
    childLiveHeader: JSON.parse((await readFile(childLive.file, 'utf8')).split('\n')[0]).parentSession ?? null,
  };
  check('G1b 子会话头里的 `parentSession` **仍指向热会话**（封存不去改它们的文件 —— 改挂走的是侧车）',
    childParentFacts.childArchHeader === nested.file && childParentFacts.childArch2Header === nested.file && childParentFacts.childLiveHeader === nested.file,
    JSON.stringify({ ...childParentFacts, hotFile: nested.file }));
  // ── G1c：**已归档**子会话改挂到冷段（业主第(2)条）─────────────────────────────
  // 改后的 `/tree` parentId：两条已归档 ⇒ 冷段；未归档那条 ⇒ 热会话。
  const rehomedOk = (row, cold) => row !== null && row.parentId === cold;
  const staysOk = (row, hot) => row !== null && row.parentId === hot;
  check('G1c `/tree`：两条**已归档**子会话 parentId ⇒ **冷段 id**；那条**未归档**子会话仍 = 热会话 id',
    rehomedOk(rowOf(nestedTree, ID.childArch), nestedColdId) && rehomedOk(rowOf(nestedTree, ID.childArch2), nestedColdId) && staysOk(rowOf(nestedTree, ID.childLive), ID.nested),
    JSON.stringify({ coldId: nestedColdId, childArch: rowOf(nestedTree, ID.childArch)?.parentId ?? null, childArch2: rowOf(nestedTree, ID.childArch2)?.parentId ?? null, childLive: rowOf(nestedTree, ID.childLive)?.parentId ?? null }));
  // 真前端渲染器读数：depth 与「挂在谁下面」的可见行。
  const rowsAfter = await renderTreeRows(nestedTree, { expanded: [ID.gp, ID.nested, nestedColdId] });
  const rowAfter = (id) => rowsAfter.find((row) => row.id === id) ?? null;
  check('G1c 渲染（真 `web/render.js` `renderTree` ＋ 假 DOM）：两条已归档子会话的 DOM 父行 ⇒ **冷段行**；未归档那条仍在**热会话行**下',
    rowAfter(ID.childArch)?.parentRowId === nestedColdId && rowAfter(ID.childArch2)?.parentRowId === nestedColdId && rowAfter(ID.childLive)?.parentRowId === ID.nested,
    JSON.stringify({ rendered: { arch: rowAfter(ID.childArch) && { depth: rowAfter(ID.childArch).depth, parentRowId: rowAfter(ID.childArch).parentRowId }, arch2: rowAfter(ID.childArch2) && { depth: rowAfter(ID.childArch2).depth, parentRowId: rowAfter(ID.childArch2).parentRowId }, live: rowAfter(ID.childLive) && { depth: rowAfter(ID.childLive).depth, parentRowId: rowAfter(ID.childLive).parentRowId } }, before: { archDepth: rowBefore(ID.childArch)?.depth ?? null, archParent: rowBefore(ID.childArch)?.parentRowId ?? null } }));
  // 侧车内容逐字（append-only、一行一条 JSON；`at` 只校验形状）。
  const sidecarText = await readFile(sealParentsPath, 'utf8');
  const sidecarRecords = sidecarText.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const sidecarKeyOf = (record) => ({ childId: record.childId, parentId: record.parentId, fromParentId: record.fromParentId });
  check('G1c 侧车 `seal-parents.jsonl` 逐字：两条 {childId, parentId=冷段, fromParentId=热会话, at}（按 childId 升序）',
    JSON.stringify(sidecarRecords.map(sidecarKeyOf)) === JSON.stringify([
      { childId: ID.childArch, parentId: nestedColdId, fromParentId: ID.nested },
      { childId: ID.childArch2, parentId: nestedColdId, fromParentId: ID.nested },
    ]) && sidecarRecords.every((record) => typeof record.at === 'string' && record.at.length > 0),
    JSON.stringify({ bytes: sidecarText.length, records: sidecarRecords }));
  // 收据与账里的 `childrenRehomed`（形状 `[{childId, fromParentId, parentId}]`）。
  const expectedRehomed = [
    { childId: ID.childArch, fromParentId: ID.nested, parentId: nestedColdId },
    { childId: ID.childArch2, fromParentId: ID.nested, parentId: nestedColdId },
  ];
  check('G1c 收据 `childrenRehomed` 逐字（形如 `[{childId, fromParentId, parentId}]`）',
    JSON.stringify(nestedReceipt.value?.childrenRehomed) === JSON.stringify(expectedRehomed),
    JSON.stringify({ childrenRehomed: nestedReceipt.value?.childrenRehomed ?? null }));
  const ledgerAfter = await ledgerRecords();
  const nestedLedger = ledgerAfter.findLast((record) => record.ok === true && record.sessionId === ID.nested) ?? null;
  const readChildrenRehomed = (record) => Array.isArray(record?.childrenRehomed) ? record.childrenRehomed : [];
  check('G1c 账 `seals.jsonl` 那条 `ok:true` 带 `childrenRehomed`（逐字）；老记录没有它 ⇒ 读者按空数组容忍',
    JSON.stringify(nestedLedger?.childrenRehomed) === JSON.stringify(expectedRehomed)
    && readChildrenRehomed({ ok: true, sessionId: 'legacy-record-without-the-field' }).length === 0
    && ledgerAfter.length > ledgerBefore,
    JSON.stringify({ ledgerRecords: ledgerAfter.length, childrenRehomed: nestedLedger?.childrenRehomed ?? null, legacyTolerance: readChildrenRehomed({ ok: true }) }));
  // ⑤ 本单**不许**动冷段/热会话的父子关系：两个头里的 `parentSession` 与封存那一刻逐字相同。
  check('G1c 冷段与热会话的父子关系一个字节没变（冷段父 = 祖父、热会话父 = 祖父；本单只动子会话归属）',
    nestedColdHeader.parentSession === grandparent.file && nestedHeaderNow.parentSession === grandparent.file && nestedColdRow.parentId === ID.gp && rowOf(nestedTree, ID.nested)?.parentId === ID.gp,
    JSON.stringify({ coldHeaderParent: nestedColdHeader.parentSession, hotHeaderParent: nestedHeaderNow.parentSession, coldRowParentId: nestedColdRow.parentId, hotRowParentId: rowOf(nestedTree, ID.nested)?.parentId }));
  // ── G1d：**详情与 `/tree` 同口径**（业主第(2)条的收尾：同一个孩子，换个面看不许说法不同）──────
  // 改前的病：`GET /sessions/{id}` 只有 `parentSessionPath` 这一个父字段（会话头里的路径）⇒ 它说**热会话**，
  // 而 `/tree` 已按侧车说**冷段**。现在详情多报一个 `parentId`，与 `/tree` 解 `parentId` 走**同一条规矩**
  // （侧车优先、目标真存在才认、目标不在就回落到会话头里的值），侧车也走同一个 `readSealParents` 缓存。
  // 判据是机械的：`GET /sessions/{childId}`.parentId 与 `/tree` 该行的 parentId **同一个值**，且两边都指冷段。
  // `parentSessionPath` 两边都**仍报会话头里的投影**（文件层真相，一个字不改）—— 它本来就不是「父级答案」，
  // `test/tree-index-selflock.mjs` 的 `ROW_FIELDS` 把它定义成文件投影字段。
  const parentAgrees = (detail, row, coldSessionId) => Boolean(detail && row
    && detail.parentId === coldSessionId && row.parentId === coldSessionId && detail.parentId === row.parentId);
  const detailOf = async (id) => (await api(`/sessions/${id}`)).value ?? null;
  const childArchDetail = await detailOf(ID.childArch);
  const childArch2Detail = await detailOf(ID.childArch2);
  check('G1d 详情与 `/tree` 同口径（已归档子会话）：`GET /sessions/{id}`.parentId = **冷段 id** = `/tree` 该行的 parentId（两边同一个值、都指冷段）',
    parentAgrees(childArchDetail, rowOf(nestedTree, ID.childArch), nestedColdId)
    && parentAgrees(childArch2Detail, rowOf(nestedTree, ID.childArch2), nestedColdId),
    JSON.stringify({ coldId: nestedColdId, detail: { arch: childArchDetail?.parentId ?? null, arch2: childArch2Detail?.parentId ?? null }, tree: { arch: rowOf(nestedTree, ID.childArch)?.parentId ?? null, arch2: rowOf(nestedTree, ID.childArch2)?.parentId ?? null } }));
  // 热那一支也要同口径（详情的热路径报的是 runtime 手里那份头里的父）—— 把那条**未归档**子会话真跑热再量。
  const liveTurn = await send(ID.childLive, PROBE);
  const liveTree = await treeOf();
  const childLiveDetail = await detailOf(ID.childLive);
  check('G1d 详情与 `/tree` 同口径（**热**会话、未归档那条）：热路径同样报文件层的父（热会话 id），与 `/tree` 那行同一个',
    liveTurn.accepted.statusCode === 202 && childLiveDetail?.runtime?.isStreaming === false
    && parentAgrees(childLiveDetail, rowOf(liveTree, ID.childLive), ID.nested),
    JSON.stringify({ accepted: liveTurn.accepted.statusCode, prompts: liveTurn.prompts.length, detail: childLiveDetail?.parentId ?? null, tree: rowOf(liveTree, ID.childLive)?.parentId ?? null, detailSource: childLiveDetail?.detailSource ?? null }));
  check('G1d 冷分支解父（未改挂那一支）：冷段自己的详情 `parentId` = **祖父 id** = `/tree` 那行的 parentId（冷段继承的是热会话的父）',
    parentAgrees(await detailOf(nestedColdId), nestedColdRow, ID.gp),
    JSON.stringify({ detail: (await detailOf(nestedColdId))?.parentId ?? null, tree: nestedColdRow?.parentId ?? null, gp: ID.gp }));
  // 悬垂的**父路径**（头里的 `parentSession` 指着一个不存在的文件）：两侧都不许编 —— 详情不是 500、
  // `parentId` 与 `/tree` 那行都是 null（不是那条路径、也不是一个编出来的 id）。
  const orphan = await seed(ID.orphan, { name: 'SEAL-ORPHAN', parentSession: path.join(sessionsRoot, 'no-such-parent.jsonl') });
  const orphanTree = await treeOf();
  const orphanDetail = await detailOf(ID.orphan);
  check('G1d 悬垂的父路径两侧一个都不编：头里 `parentSession` 指着不存在的文件 ⇒ 详情与 `/tree` 那行的 `parentId` 都是 null（也不报错）',
    orphanDetail !== null && orphanDetail.parentId === null && rowOf(orphanTree, ID.orphan)?.parentId === null
    && orphanDetail.parentSessionPath === path.join(sessionsRoot, 'no-such-parent.jsonl')
    && JSON.parse((await readFile(orphan.file, 'utf8')).split('\n')[0]).parentSession === path.join(sessionsRoot, 'no-such-parent.jsonl'),
    JSON.stringify({ detail: orphanDetail?.parentId ?? null, tree: rowOf(orphanTree, ID.orphan)?.parentId ?? null, path: orphanDetail?.parentSessionPath ?? null }));
  check('G1d 文件层的真相一个字节没改：详情与 `/tree` 行的 `parentSessionPath` **都仍是会话头里那个值**（热文件），且子会话文件里的 `parentSession` 也还是它',
    childArchDetail?.parentSessionPath === nested.file
    && rowOf(nestedTree, ID.childArch)?.parentSessionPath === nested.file
    && JSON.parse((await readFile(childArch.file, 'utf8')).split('\n')[0]).parentSession === nested.file,
    JSON.stringify({ detail: childArchDetail?.parentSessionPath ?? null, row: rowOf(nestedTree, ID.childArch)?.parentSessionPath ?? null, header: JSON.parse((await readFile(childArch.file, 'utf8')).split('\n')[0]).parentSession ?? null, hotFile: nested.file }));
  // ── 回落判据：侧车里的 `parentId` 指到一个**不存在的会话** ⇒ 回落到会话头里的值 ──────────
  const bogusId = '01a0b0bb-0000-4000-8000-0000000dead0';
  await writeFile(sealParentsPath, `${sidecarText}${JSON.stringify({ childId: ID.childLive, parentId: bogusId, fromParentId: ID.nested, at: new Date().toISOString() })}\n`);
  const fallbackTree = await treeOf();
  check('G1c 回落：侧车把 `childLive` 指到一个**不存在的会话** ⇒ `/tree` 回落到**会话头里的值**（热会话 id），不是那个不存在的 id、也不是 null',
    rowOf(fallbackTree, ID.childLive)?.parentId === ID.nested,
    JSON.stringify({ bogusId, parentId: rowOf(fallbackTree, ID.childLive)?.parentId ?? null, headerParent: ID.nested, bogusRowPresent: rowOf(fallbackTree, bogusId) !== null }));
  check('G1c 回落的反向臂：那个不存在的 id 不是树上的任何一行 ⇒ 若**盲信**侧车（不做存在性回落），那一行的父会是个悬垂 id、前端会把它浮到根上（与上面那条互为反证）',
    rowOf(fallbackTree, bogusId) === null && rowOf(fallbackTree, ID.childLive)?.parentId !== bogusId,
    JSON.stringify({ bogusRow: rowOf(fallbackTree, bogusId), liveParent: rowOf(fallbackTree, ID.childLive)?.parentId ?? null }));
  // 详情这一面必须与 `/tree` 是**同一条回落规矩**（否则它会把一个不存在的父当成真的）：这条孩子现在是**热**的
  // ⇒ 顺带把「热路径上的回落」也量了。
  const fallbackDetail = await detailOf(ID.childLive);
  check('G1d 回落（详情这一面）：侧车把这条孩子指到一个**不存在的会话** ⇒ 详情的 `parentId` 也回落到会话头里的值（热会话 id），与 `/tree` 那行同一个（同一条规矩，两个面）',
    fallbackDetail?.parentId === ID.nested && rowOf(fallbackTree, ID.childLive)?.parentId === ID.nested
    && fallbackDetail.parentId === rowOf(fallbackTree, ID.childLive).parentId,
    JSON.stringify({ detail: fallbackDetail?.parentId ?? null, tree: rowOf(fallbackTree, ID.childLive)?.parentId ?? null, bogusId }));
  // 红臂（每条新牙都要能打红；量的是**同一个**判定）：① 侧车不写（= 只有会话头那个值）⇒ 改挂判定必红；
  // ② 把**未归档**那条也挂过去 ⇒ 「未归档那条不动」必红；③ 回落规则拿掉 ⇒ 在故障注入的另一个宿主上必红；
  // ④ 若有人真去重写子会话文件 ⇒ 「只动了那两个文件」必红（沿用既有红臂④）。
  check('G1c 红臂①：侧车不写（那一行的 parentId 只剩会话头里的值 = 热会话）⇒ 「已归档子会话 ⇒ 冷段」必红',
    rehomedOk({ id: ID.childArch, parentId: ID.nested }, nestedColdId) === false,
    JSON.stringify({ mutated: `parentId → ${ID.nested}（会话头值，无侧车）`, verdict: rehomedOk({ id: ID.childArch, parentId: ID.nested }, nestedColdId) }));
  check('G1c 红臂②：把**未归档**子会话也挂到冷段名下 ⇒ 「未归档那条仍在热会话名下」必红',
    staysOk({ id: ID.childLive, parentId: nestedColdId }, ID.nested) === false,
    JSON.stringify({ mutated: `${ID.childLive} → ${nestedColdId}`, verdict: staysOk({ id: ID.childLive, parentId: nestedColdId }, ID.nested) }));
  // G1d 红臂①（纯判定，量的是**同一个** `parentAgrees`）：详情若报**文件层的值**（热会话 id）—— 那正是本单
  // 改前它唯一能报的那个字段值 —— 「与 `/tree` 同一个且都指冷段」必红。（**真**打红的那一支在另一个宿主上，
  // 见下面 `SOPHO_FAULT_DETAIL_PARENT_IGNORES_SIDECAR` 那条：那才是「真的让详情路由忽略侧车」。）
  check('G1d 红臂①（纯判定）：详情报文件层的值（热会话 id，＝改前的行为）⇒ 「与 `/tree` 同一个且都指冷段」必红',
    parentAgrees({ parentId: ID.nested }, rowOf(nestedTree, ID.childArch), nestedColdId) === false,
    JSON.stringify({ mutated: `detail.parentId → ${ID.nested}（会话头值）`, verdict: parentAgrees({ parentId: ID.nested }, rowOf(nestedTree, ID.childArch), nestedColdId) }));
  // 红臂（每条新牙都要能打红；量的是**同一个** `siblingOfHot` / `untouchedOthersOk`）：
  const withoutParentKey = (header) => Object.fromEntries(Object.entries(header).filter(([key]) => key !== 'parentSession'));
  check('G1b 红臂①：把冷段的父改回「指向热会话自己」⇒ 兄弟判定必红（旧行为被这条挡住）',
    siblingOfHot({ ...nestedColdHeader, parentSession: nested.file }, nestedHeaderNow) === false,
    JSON.stringify({ mutated: `parentSession → ${nested.file}`, verdict: siblingOfHot({ ...nestedColdHeader, parentSession: nested.file }, nestedHeaderNow) }));
  check('G1b 红臂②：把「继承父级」写成「永远置空」⇒ **有父那一侧**必红（只测根那一种情形测不出这件事）',
    siblingOfHot(withoutParentKey(nestedColdHeader), nestedHeaderNow) === false,
    JSON.stringify({ mutated: 'parentSession 整个删掉', verdict: siblingOfHot(withoutParentKey(nestedColdHeader), nestedHeaderNow) }));
  check('G1b 红臂③：反过来，**根那一侧**凭空添一个父也必红（兄弟判定不是「怎么都算过」）',
    siblingOfHot({ ...coldHeaderAfter, parentSession: ID.hot }, hotHeaderAfterSeal) === false,
    JSON.stringify({ mutated: `凭空添 parentSession=${ID.hot}`, verdict: siblingOfHot({ ...coldHeaderAfter, parentSession: ID.hot }, hotHeaderAfterSeal) }));
  check('G1b 红臂④：若有人**真去重写子会话文件**（把它们的父改指到冷段）⇒ 「只动了那两个文件」这条必红',
    untouchedOthersOk(filesBeforeNestedSeal, { ...filesAfterNestedSeal, [path.basename(childArch.file)]: 'MUTATED-BYTES' }) === false,
    JSON.stringify({ mutated: path.basename(childArch.file), verdict: untouchedOthersOk(filesBeforeNestedSeal, { ...filesAfterNestedSeal, [path.basename(childArch.file)]: 'MUTATED-BYTES' }) }));

  // ── G2：上下文等价（门的心脏）────────────────────────────────────────────
  const fullTurn = await send(ID.full, PROBE);
  check('G2 对照臂（未封存的同内容会话）真的跑了一轮并捕到了请求正文',
    fullTurn.accepted.statusCode === 202 && fullTurn.prompts.length === 1,
    JSON.stringify({ status: fullTurn.accepted.statusCode, prompts: fullTurn.prompts.map((prompt) => prompt.bytes) }));
  const sealedReceipt = await sealOf(ID.sealed);
  const sealedTurn = await send(ID.sealed, PROBE);
  check('G2 封存臂真的跑了一轮并捕到了请求正文', sealedReceipt.value?.sealed === true && sealedTurn.prompts.length === 1, JSON.stringify({ sealed: sealedReceipt.value?.sealed, prompts: sealedTurn.prompts.map((prompt) => prompt.bytes) }));
  const referencePrompt = fullTurn.prompts[0];
  const sealedPrompt = sealedTurn.prompts[0];
  check('G2 **上下文等价**：封存前后同一句用户消息 ⇒ 请求正文 sha256 逐字节相同（这是门的心脏）',
    referencePrompt && sealedPrompt && referencePrompt.sha256 === sealedPrompt.sha256 && referencePrompt.bytes === sealedPrompt.bytes,
    JSON.stringify({ fullBytes: referencePrompt?.bytes, sealedBytes: sealedPrompt?.bytes, fullSha: referencePrompt?.sha256?.slice(0, 16), sealedSha: sealedPrompt?.sha256?.slice(0, 16) }));
  const referenceJson = referencePrompt ? JSON.parse(referencePrompt.body.toString('utf8')) : null;
  check('G2 两侧给模型的 messages 条数相同（不是「sha 撞了」）',
    JSON.stringify(referenceJson?.messages?.length) === JSON.stringify(JSON.parse(sealedPrompt?.body?.toString('utf8') ?? '{}')?.messages?.length),
    JSON.stringify({ full: referenceJson?.messages?.length, sealed: JSON.parse(sealedPrompt?.body?.toString('utf8') ?? '{}')?.messages?.length }));

  // ── G6：名字与思考档（这两条来源条目都住在冷段里）────────────────────────
  check('G6 思考档**没有**掉回 settings 默认值：封存臂的 `reasoning_effort` 仍是源文件里的 high（不是 medium）',
    referenceJson?.reasoning_effort === 'high' && JSON.parse(sealedPrompt?.body?.toString('utf8') ?? '{}')?.reasoning_effort === 'high',
    JSON.stringify({ full: referenceJson?.reasoning_effort, sealed: JSON.parse(sealedPrompt?.body?.toString('utf8') ?? '{}')?.reasoning_effort }));
  const sealedTree = await treeOf();
  check('G6 热文件的名字与封存前**相同**（没掉成 null、也没被下一条消息改成 seed —— §8 的那两个坑）',
    rowOf(sealedTree, ID.sealed)?.name === 'SEAL-SEALED' && rowOf(sealedTree, ID.sealed)?.titleSource !== 'seed',
    JSON.stringify({ name: rowOf(sealedTree, ID.sealed)?.name, titleSource: rowOf(sealedTree, ID.sealed)?.titleSource }));
  check('G6 手工标题的记录没有被封存挤掉（热 id 那条仍是 manual）',
    rowOf(treeAfter, ID.hot)?.titleSource === 'manual',
    JSON.stringify({ titleSource: rowOf(treeAfter, ID.hot)?.titleSource, titles: JSON.parse(await readFile(path.join(home, 'titles.json'), 'utf8')) }));

  // ── 数字门 ──────────────────────────────────────────────────────────────
  // `sessionFileBytes` 只活在池子的「事实」里（`#recordsFacts`）⇒ 用 `POST /reclaim {dryRun:true}` 读它；
  // 那条路对每个代回一份 `generations[i].wouldReclaim[]`（**不是**顶层字段）。
  const sealedSizeNow = (await stat(sealed.file)).size;
  const dryRun = await api('/reclaim', { method: 'POST', body: { dryRun: true, sessionId: ID.sealed }, timeoutMs: 30_000 });
  const facts = (dryRun.value?.generations ?? []).flatMap((generation) => [...(generation.wouldReclaim ?? []), ...(generation.reclaimed ?? [])]).find((item) => item.sessionId === ID.sealed) ?? null;
  check('数字门：封存之后**重新打开过**的那条会话，`sessionFileBytes` = **新的**热文件大小（内存准入按新的算，不是裁剪前那个）',
    facts?.sessionFileBytes === sealedSizeNow && sealedSizeNow < sealedReceipt.value.hot.bytesBefore,
    JSON.stringify({ sessionFileBytes: facts?.sessionFileBytes, fileBytes: sealedSizeNow, before: sealedReceipt.value.hot.bytesBefore, totals: dryRun.value?.totals }));
  const etagAfter = (await rawRequest(`/sessions/${ID.sealed}/messages`)).headers?.etag ?? null;
  const etagAgain = (await rawRequest(`/sessions/${ID.sealed}/messages`)).headers?.etag ?? null;
  check('数字门：`/messages` 的 ETag 随内容变、同内容仍同 ETag（封存前后的 ETag 不是同一个）',
    typeof etagAfter === 'string' && etagAfter.startsWith('W/"') && etagAfter === etagAgain && typeof etagBefore === 'string' && etagAfter !== etagBefore,
    JSON.stringify({ sealBefore: etagBefore, sealAfter: etagAfter, again: etagAgain, sealedBytes: (await messagesOf(ID.sealed)).bytes }));

  // ── G5：热 id 一个字都不用改的东西 ───────────────────────────────────────
  const seenAfter = await api(`/sessions/${ID.hot}/seen`, { method: 'POST', body: {} });
  const seenLedger = JSON.parse(await readFile(path.join(home, 'seen.json'), 'utf8').catch(() => '{}'));
  check('G5 `seen.json` 只认热 id（冷 id 归档 ⇒ 未读判据恒假，它不该进这本账）',
    seenAfter.statusCode === 200 && seenLedger[ID.hot] === seenAfter.value?.seenAt && (coldId === null || seenLedger[coldId] === undefined),
    JSON.stringify({ seenAt: seenAfter.value?.seenAt, ledgerKeys: Object.keys(seenLedger), coldId }));
  check('G5 没有任何 `movedTo` / `claimedBy`（反装省掉了 placement 那一整套）',
    rowOf(treeAfter, ID.hot)?.movedTo === null && rowOf(treeAfter, ID.hot)?.placement?.claimedBy === null
    && JSON.stringify(rowOf(treeAfter, ID.hot)?.placement) === JSON.stringify(rowOf(treeWarm, ID.hot)?.placement),
    JSON.stringify({ movedTo: rowOf(treeAfter, ID.hot)?.movedTo, before: rowOf(treeWarm, ID.hot)?.placement, after: rowOf(treeAfter, ID.hot)?.placement }));
  check('G5 `/messages` 里热段的 entryId 就是**源文件那份 id**（标注/游标锚得住）',
    hotAfter.ids.includes(hot.ids.kept[0]) && hotAfter.ids.includes(hot.ids.tail.at(-1)) && !hotAfter.ids.includes(hot.ids.messages[0]),
    JSON.stringify({ keptInHot: hotAfter.ids.includes(hot.ids.kept[0]), coldFirstInHot: hotAfter.ids.includes(hot.ids.messages[0]) }));

  // ── G3：封存后还能跑 + 幂等 ──────────────────────────────────────────────
  const turnReceipt = await sealOf(ID.turn);
  const filesBeforeIdempotent = await listFiles();
  const turnTurn = await send(ID.turn, PROBE);
  const turnAfter = await projectFile(turn.file);
  check('G3 封存之后这条会话**还能正常跑**（新条目接在热段的叶子上）',
    turnReceipt.value?.sealed === true && turnTurn.accepted.statusCode === 202 && turnAfter.entries === turnReceipt.value.counts.hotEntries + 2, // 一问一答两条
    JSON.stringify({ sealed: turnReceipt.value?.sealed, accepted: turnTurn.accepted.statusCode, entriesAfterTurn: turnAfter.entries, hotEntries: turnReceipt.value?.counts?.hotEntries }));
  const idempotent = await sealOf(ID.turn);
  check('G3 **幂等**：紧接着再封一次 ⇒ `sealed:false` + `nothing_to_seal`，一个字节都不动',
    idempotent.statusCode === 200 && idempotent.value?.sealed === false && idempotent.value.reason === 'nothing_to_seal'
    && JSON.stringify(await listFiles()) === JSON.stringify(filesBeforeIdempotent),
    JSON.stringify({ status: idempotent.statusCode, value: idempotent.value, files: (await listFiles()).length }));
  const doubleSeal = await sealOf(ID.turn);
  const turnLedger = (await readFile(path.join(home, 'seals.jsonl'), 'utf8')).trim().split('\n').filter((line) => line.includes(ID.turn)).map((line) => JSON.parse(line));
  check('G3 连着封存两次也不产生重复冷段（文件数不变；账上一条 ok:true ＋ 两条 ok:false 都如实记着）',
    doubleSeal.value?.sealed === false
    && JSON.stringify(await listFiles()) === JSON.stringify(filesBeforeIdempotent)
    && turnLedger.filter((record) => record.ok === true).length === 1
    && turnLedger.filter((record) => record.ok === false && record.reason === 'nothing_to_seal').length === 2,
    JSON.stringify({ files: (await listFiles()).length, ledger: turnLedger.map((record) => ({ ok: record.ok, reason: record.reason })) }));

  // ── G4：冷段是一份正常会话 ───────────────────────────────────────────────
  const coldReceipt = await sealOf(ID.cold);
  const coldMessagesBefore = await messagesOf(coldReceipt.value.cold.id);
  const coldTurn = await send(coldReceipt.value.cold.id, PROBE);
  const coldMessagesAfter = await poll('cold session persisted a turn', () => messagesOf(coldReceipt.value.cold.id), (response) => (response.value?.messages?.length ?? 0) === (coldMessagesBefore.value?.messages?.length ?? 0) + 2, 30_000);
  check('G4 冷段**真能 resume**：给它发一条消息 ⇒ 202、回答落盘（条目数 +2）',
    coldMessagesBefore.statusCode === 200 && coldMessagesBefore.value.messages.length === cold.ids.messages.length && coldTurn.accepted.statusCode === 202 && coldMessagesAfter.value.messages.length === coldMessagesBefore.value.messages.length + 2,
    JSON.stringify({ status: coldMessagesBefore.statusCode, before: coldMessagesBefore.value?.messages?.length, accepted: coldTurn.accepted.statusCode, after: coldMessagesAfter.value?.messages?.length }));

  // ── G7：原子性（并发读者只看得到完整版本）────────────────────────────────
  {
    const atomic = await seed('01a0b0bb-0000-4000-8000-00000000bf01', { name: 'SEAL-ATOMIC', cold: 240, kept: 40, tail: 60, chars: 1200 });
    await treeOf();
    const beforeTurn = await messagesOf(atomic.id);
    const bytesBefore = beforeTurn.bytes;
    const concurrent = [];
    const readers = Array.from({ length: 4 }, () => messagesOf(atomic.id, { timeoutMs: 60_000 }));
    const treeReaders = Array.from({ length: 3 }, () => treeOf());
    const sealedAtomic = await sealOf(atomic.id);
    concurrent.push(...(await Promise.all([...readers, ...treeReaders])));
    const sealedBytes = (await messagesOf(atomic.id)).bytes;
    const seen = concurrent.filter((response) => response.value?.messages !== undefined).map((response) => response.bytes);
    check('G7 封存**同时**的并发读者：每一个都拿到完整版本（要么封存前的字节，要么封存后的），没有一个半成品',
      sealedAtomic.value?.sealed === true && sealedAtomic.value.counts.cold === atomic.ids.messages.length + 2 // 冷段正文 = 20×... 条消息 ＋ 思考档 ＋ 名字
      && seen.length > 0 && seen.every((bytes) => bytes === bytesBefore || bytes === sealedBytes)
      && concurrent.every((response) => response.statusCode === 200 || response.statusCode === 304),
      JSON.stringify({ bytesBefore, sealedBytes, seen, statuses: concurrent.map((response) => response.statusCode), seal: sealedAtomic.value, coldExpected: atomic.ids.messages.length }));
    check('G7 封存跑完之后没有留下临时件（`.tmp`）',
      (await readdir(sessionsRoot)).every((name) => !name.endsWith('.tmp')),
      JSON.stringify({ files: (await readdir(sessionsRoot)).filter((name) => name.endsWith('.tmp')) }));
  }

  // ── G8：**用已有的那次压缩的边界补做一次封存**（业主 2026-09-22 的追加要求）──────────────
  // 为什么这条是硬的：已存在的大会话可能**永远不会再压缩**（归档的 / 没人继续用的）⇒ 必须有一条
  // 「用**已有那次**压缩的边界补做一次」的路，而它**不是新机制** —— 同一个封存操作，只是边界由调用方点名。
  {
    // ① 老会话（从来没被模型压过一次，文件里就带着一条从前的 compaction）⇒ 显式点名那条压缩条目。
    const old1 = await seed(ID.g8a, { name: 'SEAL-c801' });
    const beforeOld = await projectFile(old1.file);
    const sourceMessages = await messagesOf(ID.g8a);
    const named = await sealOf(ID.g8a, { compactionEntryId: 'c-0001' });
    const afterOld = await projectFile(old1.file);
    const afterMessages = await messagesOf(ID.g8a);
    const sourceIdsAll = (sourceMessages.value?.messages ?? []).map((message) => message.entryId);
    const afterIds1 = (afterMessages.value?.messages ?? []).map((message) => message.entryId);
    const suffixIds = sourceIdsAll.slice(sourceIdsAll.length - afterIds1.length);
    check('G8 老会话**不需要再压一次**：显式点名 `compactionEntryId` ⇒ 就用**已有那条**压缩的边界封存（`boundary.source:"explicit"`）',
      named.statusCode === 200 && named.value?.sealed === true
      && named.value.boundary?.source === 'explicit' && named.value.boundary.compactionEntryId === 'c-0001'
      && named.value.boundary.requested?.compactionEntryId === 'c-0001'
      && named.value.compaction.entryId === 'c-0001' && named.value.compaction.firstKeptEntryId === old1.ids.kept[0],
      JSON.stringify({ status: named.statusCode, sealed: named.value?.sealed, boundary: named.value?.boundary, compaction: named.value?.compaction }));
    check('G8 补做出来的两份文件形状照旧（热文件小了、正文是源那份的连续后缀、冷段归档成子）',
      afterOld.entries < beforeOld.entries
      && afterIds1.length > 0 && suffixIds.every((id, index) => id === afterIds1[index])
      && afterOld.ids.includes(old1.ids.kept[0]) && !afterOld.ids.includes(old1.ids.messages[0])
      && (await projectFile(named.value.cold.file)).archived === true,
      JSON.stringify({ beforeEntries: beforeOld.entries, afterEntries: afterOld.entries, keptInHot: afterOld.ids.includes(old1.ids.kept[0]), coldArchived: (await projectFile(named.value.cold.file)).archived }));

    // ② 两条 compaction 的会话：默认取**最后那条**摘要的边界；点名第一条 ⇒ 冷段更小、热文件更大。
    const last = await seedTwo(ID.g8last, { name: 'SEAL-c804' });
    const explicit = await seedTwo(ID.g8expl, { name: 'SEAL-c803' });
    const fullSibling = await seedTwo(ID.g8full, { name: 'SEAL-c802' });
    const defaultSeal = await sealOf(ID.g8last);
    const explicitSeal = await sealOf(ID.g8expl, { compactionEntryId: 'c-0001' });
    check('G8 默认（body 里什么都不给）取链上**最后那条** compaction 的边界；点名第一条 ⇒ 用的是**它**的边界（同一份实现的两种选法）',
      defaultSeal.value?.sealed === true && defaultSeal.value.boundary.source === 'last-compaction'
      && defaultSeal.value.compaction.entryId === 'c-0002' && defaultSeal.value.compaction.firstKeptEntryId === 'm-0015'
      && explicitSeal.value?.sealed === true && explicitSeal.value.boundary.source === 'explicit'
      && explicitSeal.value.compaction.entryId === 'c-0001' && explicitSeal.value.compaction.firstKeptEntryId === 'm-0005',
      JSON.stringify({
        last: { source: defaultSeal.value?.boundary?.source, entryId: defaultSeal.value?.compaction?.entryId, firstKept: defaultSeal.value?.compaction?.firstKeptEntryId, cold: defaultSeal.value?.counts?.cold, hot: defaultSeal.value?.counts?.hotEntries },
        explicit: { source: explicitSeal.value?.boundary?.source, entryId: explicitSeal.value?.compaction?.entryId, firstKept: explicitSeal.value?.compaction?.firstKeptEntryId, cold: explicitSeal.value?.counts?.cold, hot: explicitSeal.value?.counts?.hotEntries },
      }));
    const lastProjection = await projectFile(last.file);
    const explicitProjection = await projectFile(explicit.file);
    check('G8 点名**更早**那条 ⇒ 冷段确实更小、留在热文件里的历史更多（边界真的听调用方的，不是「永远取最后那条」）',
      explicitProjection.entries > lastProjection.entries
      && explicitSeal.value.counts.cold < defaultSeal.value.counts.cold
      && explicitProjection.ids.includes('c-0001') && explicitProjection.ids.includes('c-0002'),
      JSON.stringify({ lastEntries: lastProjection.entries, explicitEntries: explicitProjection.entries, lastCold: defaultSeal.value.counts.cold, explicitCold: explicitSeal.value.counts.cold }));
    const explicitMessages = await messagesOf(ID.g8expl);
    check('G8 从更早那条边界封存之后：正文仍可读，**最后那条**摘要（c2）还在链上、仍是上下文里那块边界（没有掉出路径）',
      explicitMessages.statusCode === 200 && explicitMessages.value?.compaction?.entryId === 'c-0002'
      && explicitMessages.value.compaction.atIndex !== null,
      JSON.stringify({ status: explicitMessages.statusCode, compaction: explicitMessages.value?.compaction && { entryId: explicitMessages.value.compaction.entryId, atIndex: explicitMessages.value.compaction.atIndex, firstKeptEntryId: explicitMessages.value.compaction.firstKeptEntryId } }));
    // 心脏臂再来一遍：**点名更早那条边界的封存**不许改变上下文（与同内容的未封存兄弟逐字节比）。
    const siblingTurn = await send(ID.g8full, PROBE, { timeoutMs: 60_000 });
    const explicitTurn = await send(ID.g8expl, PROBE, { timeoutMs: 60_000 });
    check('G8 心脏臂：从**更早那条**边界封存的会话，同一句用户消息的请求正文与同内容的未封存兄弟**逐字节相同**',
      siblingTurn.prompts[0] !== undefined && explicitTurn.prompts[0] !== undefined
      && siblingTurn.prompts[0].sha256 === explicitTurn.prompts[0].sha256,
      JSON.stringify({ siblingBytes: siblingTurn.prompts[0]?.bytes, explicitBytes: explicitTurn.prompts[0]?.bytes, siblingSha: siblingTurn.prompts[0]?.sha256?.slice(0, 16), explicitSha: explicitTurn.prompts[0]?.sha256?.slice(0, 16) }));

    // ③ 边界点名错的四种情形：**一个字节都不动**，回执如实说原因；随后照常还能封存。
    const refuse = await seed(ID.g8refuse, { name: 'SEAL-c805' });
    const beforeBytes = await readFile(refuse.file);
    const wrong = {
      missing: await sealOf(ID.g8refuse, { compactionEntryId: 'c-not-there' }),
      notCompaction: await sealOf(ID.g8refuse, { compactionEntryId: refuse.ids.kept[0] }),
      boundaryNotFound: await sealOf(ID.g8refuse, { firstKeptEntryId: 'm-nope' }),
      mismatch: await sealOf(ID.g8refuse, { compactionEntryId: 'c-0001', firstKeptEntryId: refuse.ids.messages[0] }),
      badType: await sealOf(ID.g8refuse, { compactionEntryId: 42 }),
    };
    check('G8 边界点名错 ⇒ 如实回（`compaction_entry_missing` / `not_a_compaction_entry` / `boundary_not_found` / `boundary_mismatch` / 400 类型错），且**文件逐字节未变**',
      wrong.missing.value?.reason === 'compaction_entry_missing'
      && wrong.notCompaction.value?.reason === 'not_a_compaction_entry'
      && wrong.boundaryNotFound.value?.reason === 'boundary_not_found'
      && wrong.mismatch.value?.reason === 'boundary_mismatch'
      && wrong.badType.statusCode === 400 && wrong.badType.value?.error === 'invalid_compaction_entry_id'
      && (await readFile(refuse.file)).equals(beforeBytes)
      && [wrong.missing, wrong.notCompaction, wrong.boundaryNotFound, wrong.mismatch].every((reply) => reply.value?.sealed === false),
      JSON.stringify({ reasons: { missing: wrong.missing.value?.reason, notCompaction: wrong.notCompaction.value?.reason, boundaryNotFound: wrong.boundaryNotFound.value?.reason, mismatch: wrong.mismatch.value?.reason, badType: { status: wrong.badType.statusCode, error: wrong.badType.value?.error } }, bytesUnchanged: (await readFile(refuse.file)).equals(beforeBytes) }));
    const afterRefusals = await sealOf(ID.g8refuse, { firstKeptEntryId: refuse.ids.kept[0] });
    check('G8 光点名 `firstKeptEntryId`（不给压缩条目）也能封存：取最后那条 `firstKeptEntryId` 相同的摘要',
      afterRefusals.value?.sealed === true && afterRefusals.value.boundary.source === 'explicit'
      && afterRefusals.value.compaction.firstKeptEntryId === refuse.ids.kept[0]
      && afterRefusals.value.boundary.requested?.firstKeptEntryId === refuse.ids.kept[0],
      JSON.stringify({ sealed: afterRefusals.value?.sealed, boundary: afterRefusals.value?.boundary, compaction: afterRefusals.value?.compaction }));

    // ④ cwd 已经没了的会话：封存**只重写会话文件** ⇒ 它不该被 cwd 那道门挡住（其余写路由照旧 409）。
    const gone = path.join(sandbox, 'gone-cwd');
    const goneFixture = await seed(ID.g8gone, { name: 'SEAL-c806', cwd: gone });
    const goneSeal = await sealOf(ID.g8gone);
    const goneDetail = await api(`/sessions/${ID.g8gone}`);
    const goneArchive = await api(`/sessions/${ID.g8gone}/archive`, { method: 'POST', body: { archived: true } });
    check('G8 cwd 没了的会话**可以**补做封存（它的 cwd 回不来，文件还在）：`readOnly` 不变；`/archive` 也照常成功（归档只碰元数据，2026-09-22 起不过 cwd 门）',
      goneSeal.statusCode === 200 && goneSeal.value?.sealed === true
      && goneDetail.value?.readOnly === true && goneDetail.value?.readOnlyReason === 'cwd-missing'
      && goneArchive.statusCode === 200 && goneArchive.value?.archived === true
      && (await projectFile(goneFixture.file)).entries < goneFixture.entries.length,
      JSON.stringify({ seal: goneSeal.value?.sealed, bytes: goneSeal.value?.hot, readOnly: goneDetail.value?.readOnlyReason, archive: { status: goneArchive.statusCode, archived: goneArchive.value?.archived } }));
  }

  // ── G9：**未答问题随热尾巴搬家** ────────────────────────────────────────────
  // 为什么这一组是硬的：`sopho.question` 是 append-only 的状态机（现状由 `op` 序列折叠出来），而问题路由
  // （`GET /sessions/{id}/questions`）读的是**热文件**。一条**未答**问题的条目若落在被裁段（冷段）里 ⇒
  // 封存之后热会话的问题清单里就再也没有它 ⇒ 用户看不见自己的未答问题（也答不了）。
  // 这一组量的是：**热会话那条问题路由给出的现状，封存前后逐字段相同**；而补进热文件的那几份与被裁段
  // 那几份是**同一份内容**（只有信封上的 id / parentId / timestamp 不同 —— 那三个是「叶指针必须落在这份
  // 文件里」与「树的 `modifiedAt` 不许倒着走」要求的，不是内容）。
  {
    const OPEN = 'q-1111aaaa';
    const ANS = 'q-2222bbbb';
    const SPLIT = 'q-3333cccc';
    const LEAK = 'q-5555eeee';
    const OPEN_TEXT = 'Q1-未答：未答问题要不要随热尾巴搬过来？';
    const ANS_TEXT = 'Q2-已答：这条已经拍过板了。';
    const SPLIT_OLD = 'Q3-旧题面：先这么问。';
    const SPLIT_NEW = 'Q3-新题面：事实变了，改这里。';
    const LEAK_TEXT = 'Q5-背景：这条只配一次上下文。';
    const CONTEXT = '本件要判的事实（≥40 字）：这条问题落在被裁段里，封存之后热会话的问题路由里必须还能看到它；看不到就等于用户看不见自己的未答问题。';
    const ASK_AT = Date.parse(ISO(4));
    const ANSWER_AT = Date.parse(ISO(5));
    const UPDATE_AT = Date.parse(ISO(6));

    // ⓪ 读码臂（任务书第 ① 条）：去重键到底怎么算 —— 用**真接口**问一条，拿回来的键与
    // `questionDedupeKey`（`server/base-logic.mjs:1765`）的公式逐字对比，再问同一句 ⇒ 必须被去重。
    const ASK_TEXT = 'Q7-去重键：\t 这里 有\t多余   空白与大小写 ABC。';
    await seedQuestions(ID.q7, { name: 'SEAL-d107' });
    const asked = await api(`/sessions/${ID.q7}/questions`, { method: 'POST', body: { text: ASK_TEXT, context: CONTEXT } });
    const askedAgain = await api(`/sessions/${ID.q7}/questions`, { method: 'POST', body: { text: ASK_TEXT, context: CONTEXT } });
    check('G9 读码臂：`POST /sessions/{id}/questions` 的键 = `questionDedupeKey`（**归一化**文本的 sha1 前 12 位）；同一句话再问一次 ⇒ `deduped:true`、同 id、没新开',
      asked.statusCode === 201 && asked.value?.created === true && asked.value?.question?.dedupeKey === dedupeKeyOf(ASK_TEXT)
      && dedupeKeyOf(ASK_TEXT) !== rawSha1(ASK_TEXT)
      && askedAgain.value?.deduped === true && askedAgain.value?.created === false && askedAgain.value?.id === asked.value.id
      && (await questionsOf(ID.q7)).value?.counts?.open === 1,
      JSON.stringify({ status: asked.statusCode, dedupeKey: asked.value?.question?.dedupeKey, formula: dedupeKeyOf(ASK_TEXT), rawSha1: rawSha1(ASK_TEXT), again: askedAgain.value && { deduped: askedAgain.value.deduped, created: askedAgain.value.created, id: askedAgain.value.id, note: askedAgain.value.note } }));

    // ① 未答的那条：**整条都在被裁段**里。
    const q1 = await seedQuestions(ID.q1, {
      name: 'SEAL-d101',
      cold: [{ id: OPEN, op: 'ask', text: OPEN_TEXT, options: ['搬（按需补）', '不搬'], priority: 'high', dedupeKey: dedupeKeyOf(OPEN_TEXT), at: ASK_AT, by: 'agent', context: CONTEXT }],
    });
    const q1Before = await questionsOf(ID.q1);
    const openBefore = questionOf(q1Before, OPEN);
    check('G9 前提：封存**前**热会话的问题路由里就有这条未答问题（`status:"open"`；文本/背景/候选/优先级/提问时间都在，去重键 = 归一化文本的 sha1 前 12 位）',
      q1Before.statusCode === 200 && openBefore !== null && openBefore.status === 'open' && openBefore.text === OPEN_TEXT
      && openBefore.context === CONTEXT && openBefore.dedupeKey === dedupeKeyOf(OPEN_TEXT)
      && JSON.stringify(openBefore.options) === JSON.stringify(['搬（按需补）', '不搬']) && openBefore.priority === 'high'
      && openBefore.askedAt === ASK_AT && openBefore.askedBy === 'agent' && q1Before.value?.counts?.open === 1,
      JSON.stringify({ status: q1Before.statusCode, source: q1Before.value?.source, counts: q1Before.value?.counts, question: openBefore && { id: openBefore.id, status: openBefore.status, text: openBefore.text, dedupeKey: openBefore.dedupeKey, askedAt: openBefore.askedAt, entryId: openBefore.entryId, entryCount: openBefore.entryCount } }));

    const q1Seal = await sealOf(ID.q1);
    const openAfter = questionOf(await questionsOf(ID.q1), OPEN);
    check('G9 未答（落在被裁段）⇒ 封存**后**它仍在热会话的问题路由里，且「给用户看的现状」逐字段与封存前相同（`entryId`/`entryCount` 是文件里的账，换了文件必然不同）',
      q1Seal.statusCode === 200 && q1Seal.value?.sealed === true
      && JSON.stringify(questionFacts(openAfter)) === JSON.stringify(questionFacts(openBefore))
      && openAfter !== null && questionFacts(openAfter).status === 'open' && (await questionsOf(ID.q1)).value?.counts?.open === 1,
      JSON.stringify({ sealed: q1Seal.value?.sealed, carried: q1Seal.value?.questionsCarried, before: questionFacts(openBefore), after: questionFacts(openAfter) }));
    const q1HotLines = (await readFile(q1.file, 'utf8')).split('\n').filter((line) => line !== '');
    const q1ColdLines = q1Seal.value?.cold?.file ? (await readFile(q1Seal.value.cold.file, 'utf8')).split('\n').filter((line) => line !== '') : [];
    const hotCopy = q1HotLines.map((line) => JSON.parse(line)).find((entry) => entry.data?.id === OPEN) ?? null;
    const coldOrigin = q1ColdLines.map((line) => JSON.parse(line)).find((entry) => entry.data?.id === OPEN) ?? null;
    // 「同一份内容」：把信封上那三个必然不同的字段（新 id / 新的父指针 / 封存的时刻）换回被裁段那一条的值
    // ⇒ 整行**逐字节**相同（`data` 那一块尤其是：文本/背景/候选/优先级/去重键一个都不能变）。
    const envelopeBack = (entry) => JSON.stringify({ ...entry, id: coldOrigin?.id, parentId: coldOrigin?.parentId, timestamp: coldOrigin?.timestamp });
    check('G9 热文件里那一份与被裁段那一份是**同一份内容**：`data` 逐字节相同、整行除 id/parentId/timestamp 外逐字节相同；且它接在**链上的叶**上（不是挂在冷段那条上）',
      hotCopy !== null && coldOrigin !== null
      && JSON.stringify(hotCopy.data) === JSON.stringify(coldOrigin.data)
      && envelopeBack(hotCopy) === envelopeBack(coldOrigin)
      && hotCopy.id !== coldOrigin.id
      && hotCopy.parentId === JSON.parse(q1HotLines[q1HotLines.length - 2]).id && q1HotLines[q1HotLines.length - 1] === JSON.stringify(hotCopy),
      JSON.stringify({ hotId: hotCopy?.id, coldId: coldOrigin?.id, dataIdentical: JSON.stringify(hotCopy?.data) === JSON.stringify(coldOrigin?.data), lineIdenticalApartFromEnvelope: envelopeBack(hotCopy) === envelopeBack(coldOrigin), hotParentId: hotCopy?.parentId, coldParentId: coldOrigin?.parentId, hotLastLine: q1HotLines[q1HotLines.length - 1] === JSON.stringify(hotCopy) }));

    const q1Again = await sealOf(ID.q1);
    check('G9 补进去的问题条目不破坏热文件的「一条单链」：紧接着再封一次仍是 `nothing_to_seal`（不是 `session_not_a_single_path`）',
      q1Again.value?.sealed === false && q1Again.value.reason === 'nothing_to_seal',
      JSON.stringify({ reason: q1Again.value?.reason, detail: q1Again.value?.detail }));

    // ② 已答的那条：`ask` ＋ `answer` 都在被裁段里 ⇒ **不搬**，留在冷段里（档案就是历史）。
    const q2 = await seedQuestions(ID.q2, {
      name: 'SEAL-d102',
      cold: [
        { id: ANS, op: 'ask', text: ANS_TEXT, options: ['留冷段'], priority: 'normal', dedupeKey: dedupeKeyOf(ANS_TEXT), at: ASK_AT, by: 'agent', context: CONTEXT },
        { id: ANS, op: 'answer', text: ANS_TEXT, answer: '留冷段（人答的）。', by: 'user', at: ANSWER_AT },
      ],
    });
    const ansBefore = questionOf(await questionsOf(ID.q2, '?status=all'), ANS);
    const q2Seal = await sealOf(ID.q2);
    const q2Hot = await questionsOf(ID.q2, '?status=all');
    const q2ColdView = q2Seal.value?.cold?.id ? await questionsOf(q2Seal.value.cold.id, '?status=all') : null;
    const ansCold = q2ColdView ? questionOf(q2ColdView, ANS) : null;
    const q2HotLines = (await readFile(q2.file, 'utf8')).split('\n').filter((line) => line !== '');
    check('G9 已答（落在被裁段）⇒ 行为如实：**不搬**进热文件（热会话的问题清单里根本没有它）——但**沿链可读**：它仍在**冷段**那一份里（题面/回答/答的时间逐字段与封存前相同）',
      ansBefore?.status === 'answered' && q2Seal.value?.sealed === true && JSON.stringify(q2Seal.value.questionsCarried) === '[]'
      && questionOf(q2Hot, ANS) === null && q2Hot.value?.counts?.total === 0
      && q2HotLines.every((line) => JSON.parse(line).data?.id !== ANS)
      && JSON.stringify(questionFacts(ansCold)) === JSON.stringify(questionFacts(ansBefore)),
      JSON.stringify({ carried: q2Seal.value?.questionsCarried, hotCounts: q2Hot.value?.counts, hotLinesWithIt: q2HotLines.filter((line) => JSON.parse(line).data?.id === ANS).length, coldCounts: q2ColdView?.value?.counts, coldQuestion: questionFacts(ansCold) }));

    // ③ 拆开的那条：`ask` 在被裁段、`update` 在热尾巴 ⇒ 搬的是**整条条目序列**（不是半段）。
    const q3 = await seedQuestions(ID.q3, {
      name: 'SEAL-d103',
      cold: [{ id: SPLIT, op: 'ask', text: SPLIT_OLD, options: ['旧候选'], priority: 'normal', dedupeKey: dedupeKeyOf(SPLIT_OLD), at: ASK_AT, by: 'agent', context: CONTEXT }],
      tail: [{ id: SPLIT, op: 'update', text: SPLIT_NEW, context: '新背景：事实变了（只改了题面/背景/优先级）。', priority: 'high', at: UPDATE_AT, by: 'agent' }],
    });
    const splitBefore = questionOf(await questionsOf(ID.q3), SPLIT);
    const q3Seal = await sealOf(ID.q3);
    const splitAfter = questionOf(await questionsOf(ID.q3), SPLIT);
    const splitOps = (await readFile(q3.file, 'utf8')).split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line)).filter((entry) => entry.data?.id === SPLIT).map((entry) => entry.data.op);
    check('G9 拆开的那条（`ask` 在被裁段、`update` 在热尾巴）⇒ 封存后热会话里的现状与封存前**逐字段相同**：题面/背景/优先级是 `update` 那份，而候选/去重键/`askedAt` 仍是 `ask` 那份（所以搬的是**整条条目序列**，不是半段）',
      splitBefore?.dedupeKey === dedupeKeyOf(SPLIT_OLD) && splitBefore?.text === SPLIT_NEW && splitBefore?.askedAt === ASK_AT && splitBefore?.updatedAt === UPDATE_AT
      && JSON.stringify(questionFacts(splitAfter)) === JSON.stringify(questionFacts(splitBefore))
      && splitAfter?.dedupeKey === dedupeKeyOf(SPLIT_OLD) && splitAfter?.askedAt === ASK_AT && splitAfter?.updatedAt === UPDATE_AT
      && JSON.stringify(splitOps) === JSON.stringify(['update', 'ask', 'update']),
      JSON.stringify({ before: questionFacts(splitBefore), after: questionFacts(splitAfter), opsInHot: splitOps, carried: q3Seal.value?.questionsCarried }));

    // ④ 心脏臂的对照：搬问题条目**不改模型上下文**（`custom` 条目一条消息都不产生），问题文本一个字都不进正文。
    const q4 = await seedQuestions(ID.q4, { name: 'SEAL-d104', cold: [{ id: LEAK, op: 'ask', text: LEAK_TEXT, options: null, priority: 'normal', dedupeKey: dedupeKeyOf(LEAK_TEXT), at: ASK_AT, by: 'agent', context: CONTEXT }] });
    const q5 = await seedQuestions(ID.q5, { name: 'SEAL-d104', cold: [{ id: LEAK, op: 'ask', text: LEAK_TEXT, options: null, priority: 'normal', dedupeKey: dedupeKeyOf(LEAK_TEXT), at: ASK_AT, by: 'agent', context: CONTEXT }] });
    const q4Turn = await send(ID.q4, PROBE);
    const q5Seal = await sealOf(ID.q5);
    const q5Turn = await send(ID.q5, PROBE);
    const plainPrompt = q4Turn.prompts[0] ?? null;
    const carriedPrompt = q5Turn.prompts[0] ?? null;
    check('G9 心脏臂：把未答问题搬进热尾巴**不改模型上下文**（`sopho.question` 是 `custom` 条目 ⇒ 一条消息都不产生）：同一句用户消息的请求正文与未封存的兄弟逐字节相同，且问题文本**一个字都没进**正文',
      plainPrompt !== null && carriedPrompt !== null && plainPrompt.sha256 === carriedPrompt.sha256 && plainPrompt.bytes === carriedPrompt.bytes
      && !plainPrompt.body.toString('utf8').includes(LEAK_TEXT) && !carriedPrompt.body.toString('utf8').includes(LEAK_TEXT)
      && q5Seal.value?.sealed === true && JSON.stringify(q5Seal.value.questionsCarried?.map((group) => group.id)) === JSON.stringify([LEAK]),
      JSON.stringify({ plainBytes: plainPrompt?.bytes, carriedBytes: carriedPrompt?.bytes, sha: [plainPrompt?.sha256?.slice(0, 16), carriedPrompt?.sha256?.slice(0, 16)], leakedInPlain: plainPrompt?.body?.toString('utf8').includes(LEAK_TEXT), leakedInCarried: carriedPrompt?.body?.toString('utf8').includes(LEAK_TEXT), carried: q5Seal.value?.questionsCarried }));

    // ⑤ 已答但**被拆开**（`ask` 在被裁段、`answer` 在热尾巴）：按「已答不搬」的口径，热文件里只剩那半截答复。
    //    这一条量的是**不许出假「未答」**（那是最坏的结果：用户会被拉去答一条早就答过的问题）+ 清单计数不矛盾
    //    + 历史那条沿链在冷段里仍然可读；半截残留的**字段级形状**在 detail 里如实打出来（报告里说清）。
    const SPLIT_ANS = 'q-4444dddd';
    const SPLIT_ANS_TEXT = 'Q4-已答、但被裁段与热尾巴拆开的那条。';
    const q6 = await seedQuestions(ID.q6, {
      name: 'SEAL-d106',
      cold: [{ id: SPLIT_ANS, op: 'ask', text: SPLIT_ANS_TEXT, options: ['旧候选'], priority: 'normal', dedupeKey: dedupeKeyOf(SPLIT_ANS_TEXT), at: ASK_AT, by: 'agent', context: CONTEXT }],
      tail: [{ id: SPLIT_ANS, op: 'answer', text: SPLIT_ANS_TEXT, answer: '答过了（人答的）。', by: 'user', at: ANSWER_AT }],
    });
    const q6Seal = await sealOf(ID.q6);
    const q6HotAll = await questionsOf(ID.q6, '?status=all');
    const q6HotOpen = await questionsOf(ID.q6);
    const q6Cold = q6Seal.value?.cold?.id ? await questionsOf(q6Seal.value.cold.id, '?status=all') : null;
    const coldAsk = q6Cold ? questionOf(q6Cold, SPLIT_ANS) : null;
    check('G9 已答但**被拆开**（`ask` 在被裁段、`answer` 在热尾巴）⇒ 行为如实：活会话的 `status=open` 清单里**没有它**（不许出假「未答」）、计数自洽；冷段那边看到的是**切点那一刻的快照**（它那时确实还没被答 ⇒ `open`，题面/背景/去重键都在）（半截残留的字段级形状见 detail）',
      q6Seal.value?.sealed === true
      && q6HotOpen.value?.counts?.open === 0 && questionOf(q6HotOpen, SPLIT_ANS) === null
      && q6HotAll.value?.counts?.total === q6HotAll.value.counts.open + q6HotAll.value.counts.concluded
      && coldAsk !== null && coldAsk.status === 'open' && coldAsk.text === SPLIT_ANS_TEXT && coldAsk.dedupeKey === dedupeKeyOf(SPLIT_ANS_TEXT),
      JSON.stringify({ hotAll: q6HotAll.value?.counts, hotOpen: q6HotOpen.value?.counts, ghostInHotFile: questionFacts(questionOf(q6HotAll, SPLIT_ANS)), coldAsk: questionFacts(coldAsk), carried: q6Seal.value?.questionsCarried }));
  }

  // ── G10：**归档的冷路追加与封存共用同一条独占段**（同一条会话上同时发 `/seal` 与 `/archive`）──────
  // 为什么这一条是硬的：归档那条**冷路**（cwd 已消失 ＋ 本代没有它的 runtime）本来是**直接在会话文件上
  // 追加**一条 `sopho.archive`（不经 runtime），而封存是**原地整份替换**同一个文件（temp + rename）
  // ⇒ 两个写者可以同时动一个文件：追加可能落进 rename 丢掉的那个旧 inode ⇒ **收据说 `changed:true`、
  // 文件里却没有那条**。判据是「两种完整状态之一」：封存成功 ＋ 归档条目在（谁先谁后都行）、源条目
  // 一条不丢、两份文件逐行都是合法 JSON。
  // 这一条臂的窗口是**确定**的（不靠时序撞）：本体宿主给这条会话挂了
  // `SOPHO_FAULT_SEAL_HOLD_BEFORE_RENAME_MS=800:<id>` —— 封存的「并发写者核验通过 → rename」被撑开
  // 800 ms，而那一发 `/archive` 就落在这 800 ms 里；红半（同一条臂 ＋ 把归档挪回段外）必红（见下）。
  {
    const goneCwd = path.join(sandbox, 'gone-g10');
    const g10 = await seed(ID.g10, { name: 'SEAL-e101', cwd: goneCwd });
    const g10Detail = await api(`/sessions/${ID.g10}`);
    const sourceIds = g10.entries.map((entry) => entry.id).filter((id) => typeof id === 'string');
    const [g10Seal, g10Archive] = await Promise.all([
      sealOf(ID.g10),
      api(`/sessions/${ID.g10}/archive`, { method: 'POST', body: { archived: true } }),
    ]);
    check('G10 前提：这条会话的 cwd 已消失（归档因此走**冷路**：不建 runtime、直接在会话文件上追加）',
      g10Detail.value?.readOnly === true && g10Detail.value?.readOnlyReason === 'cwd-missing',
      JSON.stringify({ readOnly: g10Detail.value?.readOnly, readOnlyReason: g10Detail.value?.readOnlyReason, cwd: goneCwd }));
    check('G10 **同时**发 `/seal` 与 `/archive`：两份回执都是完整回执（封存 `sealed:true`；归档 `archived:true` ＋ `changed:true`），没有一个半成品',
      g10Seal.statusCode === 200 && g10Seal.value?.sealed === true
      && g10Archive.statusCode === 200 && g10Archive.value?.archived === true && g10Archive.value?.changed === true,
      JSON.stringify({ seal: { status: g10Seal.statusCode, sealed: g10Seal.value?.sealed ?? null, reason: g10Seal.value?.reason ?? null, elapsedMs: g10Seal.elapsedMs }, archive: { status: g10Archive.statusCode, archived: g10Archive.value?.archived ?? null, changed: g10Archive.value?.changed ?? null, elapsedMs: g10Archive.elapsedMs } }));
    const g10Hot = await projectFile(g10.file);
    const g10Cold = g10Seal.value?.cold?.file ? await projectFile(g10Seal.value.cold.file) : null;
    const g10AllIds = [...g10Hot.ids, ...(g10Cold?.ids ?? [])].filter((id) => typeof id === 'string');
    const g10Missing = sourceIds.filter((id) => !g10AllIds.includes(id));
    const g10Repeated = sourceIds.filter((id) => g10AllIds.filter((value) => value === id).length !== 1);
    check('G10 **条目不丢**：源文件的每一条（头 / 思考档 / 名字 / 消息 / 摘要）都还在 —— 热段与冷段合起来各出现**恰好一次**',
      g10Cold !== null && g10Missing.length === 0 && g10Repeated.length === 0,
      JSON.stringify({ source: sourceIds.length, hot: g10Hot.ids.length, cold: g10Cold?.ids?.length ?? null, missing: g10Missing, repeated: g10Repeated }));
    const g10Lines = (await readFile(g10.file, 'utf8')).split('\n').filter((line) => line !== '');
    const g10Archives = g10Lines.map((line) => JSON.parse(line)).filter((entry) => entry.type === 'custom' && entry.customType === 'sopho.archive');
    const g10DetailAfter = await api(`/sessions/${ID.g10}`);
    check('G10 归档**真的落在这条会话的文件里**（热文件里恰好一条 `sopho.archive`、`archived:true`，`/sessions/{id}` 也这么说）',
      g10Archives.length === 1 && g10Archives[0].data?.archived === true
      && g10DetailAfter.value?.archived === true && g10DetailAfter.value?.readOnlyReason === 'cwd-missing',
      JSON.stringify({ archiveEntries: g10Archives.map((entry) => entry.data), archived: g10DetailAfter.value?.archived ?? null, readOnlyReason: g10DetailAfter.value?.readOnlyReason ?? null, archiveIsLastLine: JSON.parse(g10Lines.at(-1)).customType === 'sopho.archive' }));
    const g10HotMessages = await messagesOf(ID.g10);
    const g10ColdMessages = g10Seal.value?.cold?.id ? await messagesOf(g10Seal.value.cold.id) : null;
    check('G10 两份文件每一行都是合法 JSON、热/冷都还能读、会话目录里没留下临时件',
      g10Hot.badLines === 0 && g10Cold?.badLines === 0
      && g10HotMessages.statusCode === 200 && g10ColdMessages?.statusCode === 200
      && (await readdir(sessionsRoot)).every((name) => !name.endsWith('.tmp')),
      JSON.stringify({ hotBadLines: g10Hot.badLines, coldBadLines: g10Cold?.badLines ?? null, hotMessages: g10HotMessages.statusCode, coldMessages: g10ColdMessages?.statusCode ?? null, tmp: (await readdir(sessionsRoot)).filter((name) => name.endsWith('.tmp')) }));
  }

  // ── G11：**cwd 已消失且热** ⇒「查 cwd ＋ 写」并进同一次 `runExclusive`（本件）─────────
  // 为什么这一条是硬的：`pool.getHandle` 拿到的 handle **没有租约**。旧形状里「查 cwd 的 `await`」
  // 与「写」是两次 `runExclusive` ⇒ 中间是一个**调度级空档**，封存可以在那里 `dispose()` 掉它 ⇒
  // 那一笔写撞上已 dispose 的 handle（`runExclusive` 的 `#assertOpen` 抛）⇒ **500、条目一个字没写**；
  // 或者写成功但随后的 `refreshPersistence` 撞上 disposing ⇒ 500（副作用已成、回执说失败）。
  // 判据：让封存**恰好在那条空档上动手** —— 本体宿主给这条会话挂了 `SOPHO_FAULT_ARCHIVE_HOT_GAP_MS`
  // （把「查 cwd → 写」撑开 2500 ms），归档**先发**、150 ms 后发封存 ⇒ 归档必须**要么成功、要么如实
  // 回一条可重试回执**，**不许**出现「500 ＋ 条目没写」。红半（`R-G11`）另起一个宿主把修法撤掉。
  {
    const goneCwd = path.join(sandbox, 'gone-g11');
    await mkdir(goneCwd, { recursive: true });
    const g11 = await seed(ID.g11, { name: 'SEAL-e201', cwd: goneCwd });
    // 先把 runtime 弄**热**（`GET /commands` 走 `withSession` ⇒ acquire ⇒ 真打开一份 runtime；
    // 不建新会话、不需要 provider），再删 cwd ⇒ 走进「cwd 已消失且**热**」那条路。
    const g11Warm = await api(`/sessions/${ID.g11}/commands`, { timeoutMs: 60_000 });
    const g11HotDry = await api('/reclaim', { method: 'POST', body: { dryRun: true, sessionId: ID.g11 }, timeoutMs: 30_000 });
    const g11HotFacts = (g11HotDry.value?.generations ?? []).flatMap((generation) => [...(generation.wouldReclaim ?? []), ...(generation.reclaimed ?? [])]).find((item) => item.sessionId === ID.g11) ?? null;
    await rm(goneCwd, { recursive: true, force: true });
    const g11Detail = await api(`/sessions/${ID.g11}`);
    check('G11 前提：这条会话的 runtime **热着**（`hotIdle`、0 租约）而 cwd 已消失 ⇒ 归档走**热路**（不经 `withSession`、也不造新 runtime）',
      g11Warm.statusCode === 200 && g11HotFacts?.runtimeState === 'hotIdle' && g11HotFacts.acquiredLeases === 0 && g11HotFacts.durable === true
      && g11Detail.value?.readOnlyReason === 'cwd-missing',
      JSON.stringify({ warm: g11Warm.statusCode, hot: g11HotFacts && { runtimeState: g11HotFacts.runtimeState, acquiredLeases: g11HotFacts.acquiredLeases, durable: g11HotFacts.durable, sessionFileBytes: g11HotFacts.sessionFileBytes }, readOnlyReason: g11Detail.value?.readOnlyReason }));
    // 归档先发（它一进那段就被撑开 2500 ms），150 ms 后发封存 ⇒ 封存恰好落在那条空档上。
    const g11ArchivePending = api(`/sessions/${ID.g11}/archive`, { method: 'POST', body: { archived: true } });
    await sleep(150);
    const [g11Archive, g11Seal] = await Promise.all([g11ArchivePending, sealOf(ID.g11)]);
    const g11Hot = await projectFile(g11.file);
    const g11ArchiveEntries = (await readFile(g11.file, 'utf8')).split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line)).filter((entry) => entry.type === 'custom' && entry.customType === 'sopho.archive').map((entry) => entry.data);
    const g11Success = g11Archive.statusCode === 200 && g11Archive.value?.changed === true && g11ArchiveEntries.length === 1 && g11ArchiveEntries[0]?.archived === true && g11Hot.archived === true;
    const g11Retryable = g11Archive.statusCode === 409 && g11Archive.value?.error === 'session_busy_move' && g11Archive.value?.details?.retryable === true && g11ArchiveEntries.length === 0;
    check('G11 **同时**发 `/archive` 与 `/seal`（归档先、150 ms 后封存，窗口撑开 2500 ms）⇒ 归档**要么成功、要么如实回可重试**，绝不 500（把用户动作吞掉）；封存本身照常成功',
      g11Seal.statusCode === 200 && g11Seal.value?.sealed === true
      && g11Archive.statusCode < 500 && (g11Success || g11Retryable),
      JSON.stringify({ archive: { status: g11Archive.statusCode, value: g11Archive.value ?? null, elapsedMs: g11Archive.elapsedMs }, seal: { status: g11Seal.statusCode, sealed: g11Seal.value?.sealed ?? null, reason: g11Seal.value?.reason ?? null, evicted: g11Seal.value?.evicted ?? null, elapsedMs: g11Seal.elapsedMs }, archiveEntriesInHot: g11ArchiveEntries.length, archived: g11Hot.archived, badLines: g11Hot.badLines, outcome: g11Success ? 'success+entry-present' : g11Retryable ? 'retryable-409-no-entry' : 'UNEXPECTED' }));
    check('G11 绿半（本件修法）：撑开的窗口里封存**必须等这一笔结束** ⇒ 归档拿到了 200 `changed:true`（不是退路），且那一条真的落在会话文件里（封存把它当叶路径的一部分保住了）',
      g11Success,
      JSON.stringify({ status: g11Archive.statusCode, value: g11Archive.value, archiveEntries: g11ArchiveEntries, archived: g11Hot.archived, badLines: g11Hot.badLines, entries: g11Hot.entries }));
  }

  // ═════════════ 红半 ═════════════
  // 每一刀：**先用真的封存拿到实现的成品**，再把这一刀施加在那份成品上，然后跑同一条绿断言 ⇒ 必红。
  // 参考正文（`referencePrompt`）= 未封存的同内容会话那一轮 —— 绿断言就是「与它逐字节相同」。
  const redArm = async ({ id, mutate, symptom, expectation = 'sha' }) => {
    const fixture = await seed(id, { name: `SEAL-${id.slice(-4)}` });
    const sealedNow = await sealOf(id);
    assert.equal(sealedNow.value?.sealed, true, `${id} 的红臂前提：封存本身必须成功（${JSON.stringify(sealedNow.value)}）`);
    const file = fixture.file;
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
    const mutated = mutate(lines.slice());
    assert.ok(Array.isArray(mutated), `${id}: mutation must return lines`);
    await writeFile(file, `${mutated.join('\n')}\n`);
    return { fixture, sealedNow, lines };
  };

  {
    // R1 省掉 kept 段
    await redArm({ id: ID.r1, mutate: (lines) => [lines[0], lines[1], ...lines.slice(2 + hot.ids.kept.length)] });
    const arm = await send(ID.r1, PROBE);
    const prompt = arm.prompts[0];
    const messagesHot = await messagesOf(ID.r1);
    check('R1 省掉 kept 段 ⇒ 上下文必变（绿断言 G2 会红）+ `/messages` 少了那些条目',
      prompt && referencePrompt && prompt.sha256 !== referencePrompt.sha256
      && (messagesHot.value?.messages?.length ?? 0) === hot.ids.tail.length + 2 // 尾巴 8 条 + 这一轮的问答
      && !(messagesHot.value?.messages ?? []).some((message) => hot.ids.kept.includes(message.entryId)),
      JSON.stringify({ redBytes: prompt?.bytes, refBytes: referencePrompt?.bytes, messagesAfter: messagesHot.value?.messages?.length, tail: hot.ids.tail.length, keptLeaked: (messagesHot.value?.messages ?? []).filter((message) => hot.ids.kept.includes(message.entryId)).length }));

    // R2 丢摘要条目
    await redArm({ id: ID.r2, mutate: (lines) => lines.filter((line) => !line.includes('"type":"compaction"')) });
    const arm2 = await send(ID.r2, PROBE);
    const prompt2 = arm2.prompts[0];
    const messages2 = await messagesOf(ID.r2);
    check('R2 丢掉摘要条目 ⇒ 上下文必变（摘要那条消息缺席）+ `compactionCount` 归零',
      prompt2 && referencePrompt && prompt2.sha256 !== referencePrompt.sha256 && messages2.value?.compactionCount === 0 && messages2.value?.compaction?.atIndex === null,
      JSON.stringify({ redBytes: prompt2?.bytes, refBytes: referencePrompt?.bytes, compactionCount: messages2.value?.compactionCount }));

    // R3 从末尾截断尾巴
    await redArm({ id: ID.r3, mutate: (lines) => lines.slice(0, lines.length - 3) });
    const arm3 = await send(ID.r3, PROBE);
    const prompt3 = arm3.prompts[0];
    check('R3 从末尾截断尾巴 ⇒ 上下文必变（少了几条正文）',
      prompt3 && referencePrompt && prompt3.sha256 !== referencePrompt.sha256 && prompt3.bytes < referencePrompt.bytes,
      JSON.stringify({ redBytes: prompt3?.bytes, refBytes: referencePrompt?.bytes }));

    // R4 抽掉链条中间一条
    await redArm({ id: ID.r4, mutate: (lines) => lines.filter((line, index) => index !== 2 + Math.floor(hot.ids.kept.length / 2)) });
    const arm4 = await send(ID.r4, PROBE);
    const prompt4 = arm4.prompts[0];
    const messages4 = await messagesOf(ID.r4);
    check('R4 抽掉链条中间一条 ⇒ 上下文塌掉：**不只是少了那一条**，链在断点处停住（丢的比一刀更多）',
      prompt4 && referencePrompt && prompt4.sha256 !== referencePrompt.sha256
      && (messages4.value?.messages?.length ?? 0) < hot.ids.kept.length + hot.ids.tail.length + 2,
      JSON.stringify({ redBytes: prompt4?.bytes, refBytes: referencePrompt?.bytes, messages: messages4.value?.messages?.length, keptPlusTail: hot.ids.kept.length + hot.ids.tail.length + 2 }));

    // R5 摘要 parentId 打 null：摘要掉出路径
    await redArm({ id: ID.r5, mutate: (lines) => lines.map((line) => (line.includes('"type":"compaction"') ? JSON.stringify({ ...JSON.parse(line), parentId: null }) : line)) });
    const arm5 = await send(ID.r5, PROBE);
    const prompt5 = arm5.prompts[0];
    const messages5 = await messagesOf(ID.r5);
    check('R5 摘要 `parentId` 打 null（kept 不动）⇒ 摘要掉出它该在的位置：上下文必变、压缩块落到 `atIndex 0`',
      prompt5 && referencePrompt && prompt5.sha256 !== referencePrompt.sha256
      && messages5.value?.compaction?.atIndex === 0
      && messagesAfter.value?.compaction?.atIndex === hot.ids.kept.length,
      JSON.stringify({ redBytes: prompt5?.bytes, refBytes: referencePrompt?.bytes, redAtIndex: messages5.value?.compaction?.atIndex, correctAtIndex: messagesAfter.value?.compaction?.atIndex }));
  }

  // ── R9：有回合在跑时发封存请求 ⇒ 409（与 /move 同一句话）+ 一个新文件都不造 ──
  {
    const busyFixture = await seed(ID.busy, { name: 'SEAL-BUSY' });
    const filesBefore = await listFiles();
    const hotTurn = await send(ID.busy, PROBE, { hold: true });
    await hotTurn.plan.startedSignal; // 等到模型流**真的开始**（= 回合真的在飞），否则那一刀是空的
    let busyDetail = await api(`/sessions/${ID.busy}`);
    for (let attempt = 0; attempt < 30 && busyDetail.value?.runtime?.isStreaming !== true; attempt += 1) {
      await sleep(100);
      busyDetail = await api(`/sessions/${ID.busy}`);
    }
    check('R9 前提：假 provider 真的把这一轮挂住了，`GET /sessions/{id}` 如实报 `runtime.isStreaming:true`',
      hotTurn.accepted.statusCode === 202 && hotTurn.plan !== null && busyDetail.value?.runtime?.isStreaming === true,
      JSON.stringify({ status: hotTurn.accepted.statusCode, runtime: busyDetail.value?.runtime, holdUsed: hotTurn.plan?.usedAt !== undefined, providerCalls: provider.calls.length }));
    const refused = await sealOf(ID.busy);
    check('R9 回合在跑时发封存请求 ⇒ 409 `session_busy_move`（**与 /move 同一个码、同一条判据**；措辞按封存的真实原因写，不照抄 forkFrom 那句）',
      refused.statusCode === 409 && refused.value?.error === 'session_busy_move'
      && refused.value?.details?.sealed === false && refused.value?.details?.runtime?.isStreaming === true
      && typeof refused.value?.message === 'string' && refused.value.message.includes('session_busy_move') && !refused.value.message.includes('forkFrom'),
      JSON.stringify({ status: refused.statusCode, value: refused.value }));
    const busySizeBefore = Buffer.byteLength(busyFixture.lines) + `\n{"type":"message","id":"` .length; // 挂住的那一轮已经把 user 那条写进去了
    check('R9 被拒时**一个新文件都没造**（会话文件数不变），热文件也没被裁',
      JSON.stringify(await listFiles()) === JSON.stringify(filesBefore) && (await stat(busyFixture.file)).size > busySizeBefore && (await projectFile(busyFixture.file)).entries === busyFixture.entries.length + 1,
      JSON.stringify({ files: (await listFiles()).length, size: (await stat(busyFixture.file)).size, minExpected: busySizeBefore, entries: (await projectFile(busyFixture.file)).entries }));
    hotTurn.plan.releaseNow();
    await waitIdle(ID.busy, 20_000);
    const afterIdle = await sealOf(ID.busy);
    check('R9 回合落定之后再发 ⇒ 这次真的封存了（那条 409 是「现在不行」，不是「永远不行」）',
      afterIdle.value?.sealed === true,
      JSON.stringify(afterIdle.value));
  }

  // ── R7/R6/R8 单独做（各自的口径不同）──────────────────────────────────────
  {
    // R7 不带思考档：热文件里不补 `thinking_level_change` ⇒ 静默降档（messages 一字不差）
    const r7 = await seed(ID.r7, { name: 'SEAL-bc07' });
    const sealedR7 = await sealOf(ID.r7);
    const lines = (await readFile(r7.file, 'utf8')).split('\n').filter((line) => line !== '');
    // 删掉那条「补上来的」思考档；**把下一条重新挂到它的父上**（否则链在那里断掉，
    // 这一刀量的就不是「档位没带上」，而是「文件坏了」）。
    const thinkingAt = lines.findIndex((line) => line.includes('"type":"thinking_level_change"'));
    const removed = JSON.parse(lines[thinkingAt]);
    lines[thinkingAt + 1] = JSON.stringify({ ...JSON.parse(lines[thinkingAt + 1]), parentId: removed.parentId });
    lines.splice(thinkingAt, 1);
    await writeFile(r7.file, `${lines.join('\n')}\n`);
    const arm7 = await send(ID.r7, PROBE);
    const prompt7 = arm7.prompts[0];
    const json7 = prompt7 ? JSON.parse(prompt7.body.toString('utf8')) : null;
    const jsonRef = referenceJson;
    const sameMessages = JSON.stringify(json7?.messages) === JSON.stringify(jsonRef?.messages);
    check('R7 不补思考档 ⇒ `reasoning_effort` 从 high 掉成 medium（而 messages 逐字相同）—— 这正是反装的「默认行为」',
      sealedR7.value?.sealed === true && json7?.reasoning_effort === 'medium' && jsonRef?.reasoning_effort === 'high' && sameMessages,
      JSON.stringify({ sealedEffort: json7?.reasoning_effort, fullEffort: jsonRef?.reasoning_effort, messagesIdentical: sameMessages, sealedCount: json7?.messages?.length, refCount: jsonRef?.messages?.length, firstDiff: (() => { const a = jsonRef?.messages ?? []; const b = json7?.messages ?? []; for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return { at: i, ref: String(a[i]?.content?.[0]?.text ?? a[i]?.role).slice(0, 60), sealed: String(b[i]?.content?.[0]?.text ?? b[i]?.role).slice(0, 60) }; return null; })() }));
  }
  {
    // R8 去掉版本号：pi 会把它当成 v1 迁移 ⇒ 重建所有条目的 id 并重写整份文件
    const r8 = await seed(ID.r8, { name: 'SEAL-bc08' });
    const sealedR8 = await sealOf(ID.r8);
    const header = JSON.parse((await readFile(r8.file, 'utf8')).split('\n')[0]);
    delete header.version;
    const body = (await readFile(r8.file, 'utf8')).split('\n').filter((line) => line !== '').slice(1);
    await writeFile(r8.file, `${[JSON.stringify(header), ...body].join('\n')}\n`);
    // 建一个**真 runtime**（只有 open 会跑迁移）：POST /message 那条路最直白。
    const arm8 = await send(ID.r8, PROBE);
    const messages8 = await messagesOf(ID.r8);
    const idsNow = (messages8.value?.messages ?? []).map((message) => message.entryId);
    const sourceIds = new Set([...hot.ids.messages, ...hot.ids.kept, ...hot.ids.tail]);
    check('R8 去掉 `version` ⇒ pi 把它当 v1 迁移：条目 id 被**重建**（原 id 一个都不剩）',
      sealedR8.value?.sealed === true && arm8.accepted.statusCode === 202 && idsNow.length > 0 && idsNow.every((id) => !sourceIds.has(id)),
      JSON.stringify({ accepted: arm8.accepted.statusCode, rebuilt: idsNow.length, stillOriginal: idsNow.filter((id) => sourceIds.has(id)).length }));
  }

  // ── R12：把「搬未答问题」这一刀从成品里撤掉 ────────────────────────────────
  // 形状照 R1–R8：**先跑真的封存拿到实现的成品**，再把这一刀施加在那份成品上，然后跑**同一条绿断言** ⇒ 必红。
  // 撤法就是「删掉实现补上去的那几条」—— 删哪几条**不听我们自己猜**：收据（`questionsCarried[].entryIds`）
  // 点名了它写进去了哪几条，就删哪几条（顺带把「收据说的是真的」也量了）。
  {
    const RED_OPEN = 'q-6666dddd';
    const SPLIT_RED = 'q-7777eeee';
    const RED_TEXT = 'R12-未答：这条落在被裁段里。';
    const SPLIT_RED_OLD = 'R12-拆开-旧题面';
    const SPLIT_RED_NEW = 'R12-拆开-新题面';
    const CONTEXT = 'R12 要判的事实（≥40 字）：把「搬未答问题」这一刀撤掉之后，热会话的问题路由里就该看不到这条未答问题了 —— 那正是绿断言的反面。';
    const ASK_AT = Date.parse(ISO(4));
    const UPDATE_AT = Date.parse(ISO(5));
    /** 删掉收据点名的那几条（= 撤掉「搬未答问题」这一刀），其余一个字节不动。 */
    const stripCarried = async (file, entryIds) => {
      const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
      const kept = lines.filter((line) => !entryIds.includes(JSON.parse(line).id));
      await writeFile(file, `${kept.join('\n')}\n`);
      return { before: lines.length, after: kept.length, removed: lines.length - kept.length };
    };

    const plain = await seedQuestions(ID.r12, { name: 'SEAL-d201', cold: [{ id: RED_OPEN, op: 'ask', text: RED_TEXT, options: null, priority: 'normal', dedupeKey: dedupeKeyOf(RED_TEXT), at: ASK_AT, by: 'agent', context: CONTEXT }] });
    const beforePlain = questionOf(await questionsOf(ID.r12), RED_OPEN);
    const sealedPlain = await sealOf(ID.r12);
    const greenPlain = questionOf(await questionsOf(ID.r12), RED_OPEN);
    const plainIds = (sealedPlain.value?.questionsCarried ?? []).flatMap((group) => group.entryIds ?? []);
    const strippedPlain = await stripCarried(plain.file, plainIds);
    const redPlain = questionOf(await questionsOf(ID.r12), RED_OPEN);
    check('R12 撤掉「搬未答问题」这一刀（删掉收据点名的那几条）⇒ 同一条绿断言变红：热会话的问题路由里**没有它了**',
      beforePlain?.status === 'open' && sealedPlain.value?.sealed === true && greenPlain?.status === 'open'
      && plainIds.length > 0 && strippedPlain.removed === plainIds.length && redPlain === null,
      JSON.stringify({ before: beforePlain?.status, afterSeal: greenPlain?.status, carriedIds: plainIds, stripped: strippedPlain, afterStrip: redPlain }));
    const plainCold = sealedPlain.value?.cold?.id ? await questionsOf(sealedPlain.value.cold.id) : null;
    const coldPlain = plainCold ? questionOf(plainCold, RED_OPEN) : null;
    check('R12 那一刀之后它**只在冷段里**（冷段那同一把尺子还看得到它，题面/背景/去重键都在）—— 这正是「用户看不见自己的未答问题」的现场',
      coldPlain?.status === 'open' && coldPlain.dedupeKey === dedupeKeyOf(RED_TEXT) && coldPlain.context === CONTEXT,
      JSON.stringify({ coldCounts: plainCold?.value?.counts, coldQuestion: questionFacts(coldPlain) }));

    const split = await seedQuestions(ID.r12split, {
      name: 'SEAL-d202',
      cold: [{ id: SPLIT_RED, op: 'ask', text: SPLIT_RED_OLD, options: ['R12-旧候选'], priority: 'normal', dedupeKey: dedupeKeyOf(SPLIT_RED_OLD), at: ASK_AT, by: 'agent', context: CONTEXT }],
      tail: [{ id: SPLIT_RED, op: 'update', text: SPLIT_RED_NEW, priority: 'high', at: UPDATE_AT, by: 'agent' }],
    });
    const beforeSplit = questionFacts(questionOf(await questionsOf(ID.r12split), SPLIT_RED));
    const sealedSplit = await sealOf(ID.r12split);
    const greenSplit = questionFacts(questionOf(await questionsOf(ID.r12split), SPLIT_RED));
    const splitIds = (sealedSplit.value?.questionsCarried ?? []).flatMap((group) => group.entryIds ?? []);
    const strippedSplit = await stripCarried(split.file, splitIds);
    const redSplit = questionFacts(questionOf(await questionsOf(ID.r12split), SPLIT_RED));
    check('R12 拆开那条同样有牙齿：撤掉那一刀 ⇒ 热文件里只剩下半截（`update`），现状与封存前**不再相同** —— 去重键与「谁在何时问的」当场丢（绿断言那条逐字段相等变红）',
      beforeSplit !== null && JSON.stringify(greenSplit) === JSON.stringify(beforeSplit)
      && splitIds.length === 2 && strippedSplit.removed === 2
      && redSplit !== null && JSON.stringify(redSplit) !== JSON.stringify(beforeSplit)
      && redSplit.dedupeKey === null && redSplit.askedAt === null && redSplit.text === SPLIT_RED_NEW,
      JSON.stringify({ before: beforeSplit, green: greenSplit, carriedIds: splitIds, stripped: strippedSplit, red: redSplit }));
  }

  // ── R10：tailer 的重锚（旧规则的红臂在第二个宿主上跑）─────────────────────
  {
    const projectedAfterSeal = Number((await treeCounts())?.filesProjected ?? 0);
    check('R10 裁掉开头之后的第一次 `/tree`：整份重扫这一个文件（不是拿缓存的折叠值冒充）+ 行 = 真值',
      projectedAfterSeal >= projectedBeforeSeal + 1 && rowOf(treeAfter, ID.hot)?.name === 'SEAL-HOT',
      JSON.stringify({ projectedBefore: projectedBeforeSeal, projectedAfter: projectedAfterSeal, rowName: rowOf(treeAfter, ID.hot)?.name }));

    // HOLE：**同前缀 + 变大**（旧规则会走「纯追加」那条路 ⇒ 报一个文件里已经不存在的名字）。
    const headerLine = () => {
      const base = { type: 'session', version: 3, id: ID.hole, timestamp: ISO(0), cwd: workspace };
      const need = 4096 - 1 - Buffer.byteLength(JSON.stringify({ ...base, pad: '' }));
      return JSON.stringify({ ...base, pad: 'x'.repeat(need) }); // 含换行恰好 4096 B ⇒ 旧指纹的边界落在换行上
    };
    const line = (entry) => JSON.stringify(entry);
    const message = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: ISO(9), message: { role, content: [{ type: 'text', text }] } });
    const holeFile = path.join(sessionsRoot, `t_${ID.hole}.jsonl`);
    await writeFile(holeFile, `${[headerLine(), line(message('aaaaaaaa-0001', null, 'user', 'x'.repeat(200))), line({ type: 'session_info', id: 'aaaaaaaa-0002', parentId: 'aaaaaaaa-0001', timestamp: ISO(2), name: 'HOLE-NAME-A' }), line(message('aaaaaaaa-0003', 'aaaaaaaa-0002', 'assistant', 'y'.repeat(2000)))].join('\n')}\n`);
    await treeOf(); // 让索引缓存 A
    const bLines = [headerLine(), line(message('aaaaaaaa-0001', null, 'user', 'x'.repeat(200))), line({ type: 'session_info', id: 'bbbbbbbb-0002', parentId: 'aaaaaaaa-0001', timestamp: ISO(3), name: 'HOLE-NAME-B' }), line(message('bbbbbbbb-0003', 'bbbbbbbb-0002', 'assistant', 'y'.repeat(4000))), line(message('bbbbbbbb-0004', 'bbbbbbbb-0003', 'user', 'z'.repeat(4000))), line(message('bbbbbbbb-0005', 'bbbbbbbb-0004', 'assistant', 'w'.repeat(9000)))];
    await writeFile(holeFile, `${bLines.join('\n')}\n`);
    const truthB = await projectFile(holeFile);
    const treeHole = await treeOf();
    check('R10 同前缀 + 变大（旧规则的「纯追加」那一支）：行必须 = 真值（`HOLE-NAME-B`，不是文件里已经没有的 A）',
      treeHole.statusCode === 200 && rowOf(treeHole, ID.hole)?.name === truthB.name && truthB.name === 'HOLE-NAME-B',
      JSON.stringify({ status: treeHole.statusCode, rowName: rowOf(treeHole, ID.hole)?.name, truth: truthB.name, bytes: (await stat(holeFile)).size }));
  }

  // ── R11：runtime 持有时替换 ─────────────────────────────────────────────
  {
    const r11 = await seed(ID.r11, { name: 'SEAL-be01' });
    // ① 先真跑一轮 ⇒ 这条会话的 runtime 热着，它内存里握着**全量** fileEntries（回合已落定）。
    const first11 = await send(ID.r11, PROBE);
    const hotRead1 = await messagesOf(ID.r11); // 走 runtime（热读）
    check('R11 前提：runtime 热着、热读拿到了全量正文',
      first11.accepted.statusCode === 202 && hotRead1.value?.messages?.length === r11.ids.messages.length + r11.ids.kept.length + r11.ids.tail.length + 2,
      JSON.stringify({ accepted: first11.accepted.statusCode, hotRead: hotRead1.value?.messages?.length, expected: r11.ids.messages.length + r11.ids.kept.length + r11.ids.tail.length + 2 }));
    // ② 造一份**正确的封存产物**（同形状的 donor：同样跑一轮同样的话、再真封存），把它原地写回 R11。
    //    这就是「runtime 持有时替换」——不做 evict。
    const donor = await seed(ID.r11donor, { name: 'SEAL-be01' });
    await send(ID.r11donor, PROBE);
    const donorSeal = await sealOf(ID.r11donor);
    const donorLines = (await readFile(donor.file, 'utf8')).split('\n').filter((line) => line !== '');
    const r11Header = (await readFile(r11.file, 'utf8')).split('\n')[0];
    await writeFile(r11.file, `${[r11Header, ...donorLines.slice(1)].join('\n')}\n`);
    const hotRead2 = await messagesOf(ID.r11);
    const fileNow = await projectFile(r11.file);
    check('R11 失败现场：runtime 还拿着它的时候替换 ⇒ **热读看不见**（还是替换前的全量），而文件已经是裁过的',
      donorSeal.value?.sealed === true && hotRead2.value?.messages?.length === hotRead1.value?.messages?.length && fileNow.entries < hotRead2.value.messages.length,
      JSON.stringify({ donorSealed: donorSeal.value?.sealed, hotReadBefore: hotRead1.value?.messages?.length, hotReadAfterReplace: hotRead2.value?.messages?.length, fileEntries: fileNow.entries }));
    // ③ 再跑一轮（runtime 往它内存的那条叶上 append，而那条叶已经不在文件里了）⇒ evict ⇒ 冷读塌掉。
    const turn11 = await send(ID.r11, PROBE, { timeoutMs: 60_000 });
    const reclaimed = await api('/reclaim', { method: 'POST', body: { sessionId: ID.r11 }, timeoutMs: 60_000 });
    const coldRead = await messagesOf(ID.r11);
    const afterTurn11 = await send(ID.r11, PROBE, { timeoutMs: 60_000 });
    const prompt11 = afterTurn11.prompts[0];
    check('R11 失败现场：替换后那一条 append 的 `parentId` 指向已经不存在的叶 ⇒ evict 之后冷读**塌掉**（与热读不一致、下一轮正文远小于封存前）',
      reclaimed.statusCode === 200 && turn11.accepted.statusCode === 202
      && (coldRead.value?.messages?.length ?? 0) < hotRead1.value.messages.length
      && prompt11 !== undefined && prompt11.bytes < referencePrompt.bytes / 2,
      JSON.stringify({ reclaimed: reclaimed.value?.totals, reported: [...(reclaimed.value?.reclaimed ?? []), ...(reclaimed.value?.refused ?? [])].map((item) => ({ sessionId: item.sessionId, reason: item.reason })), hotRead: hotRead1.value?.messages?.length, coldRead: coldRead.value?.messages?.length, promptBytes: prompt11?.bytes, refBytes: referencePrompt.bytes, coldCompactionCount: coldRead.value?.compactionCount }));

    // ④ 绿臂：**先 evict** 的那条路（真实现）在同样「runtime 热着」的前提下不塌。
    //    对照臂 = 一条**同样跑过第一轮**、但没封存的兄弟会话（这样「同一句话」的请求正文才可以逐字节比）。
    const r11ok = await seed(ID.r11ok, { name: 'SEAL-be02' });
    const r11sib = await seed(ID.r11sib, { name: 'SEAL-be02' });
    const firstOk = await send(ID.r11ok, PROBE);
    const firstSib = await send(ID.r11sib, PROBE);
    const hotBeforeOk = await messagesOf(ID.r11ok);
    const sealedOk = await sealOf(ID.r11ok);
    const afterOk = await messagesOf(ID.r11ok);
    const turnOk = await send(ID.r11ok, PROBE, { timeoutMs: 60_000 });
    const turnSib = await send(ID.r11sib, PROBE, { timeoutMs: 60_000 });
    const afterTurnOk = await poll('R11 green turn settled', () => messagesOf(ID.r11ok), (response) => (response.value?.messages?.length ?? 0) > (afterOk.value?.messages?.length ?? 0), 30_000);
    const promptOk = turnOk.prompts[0];
    const promptSib = turnSib.prompts[0];
    check('R11 绿臂：真实现先 evict 再替换（`evicted:true`）⇒ 热读/冷读一致，且下一轮正文与**同内容的未封存兄弟**逐字节相同',
      firstOk.accepted.statusCode === 202 && firstSib.accepted.statusCode === 202
      && sealedOk.value?.sealed === true && sealedOk.value.evicted === true
      && afterOk.value?.messages?.length === hotBeforeOk.value.messages.length - r11ok.ids.messages.length
      && afterTurnOk.value?.messages?.length === afterOk.value.messages.length + 2
      && promptOk !== undefined && promptSib !== undefined && promptOk.sha256 === promptSib.sha256,
      JSON.stringify({ sealed: sealedOk.value?.sealed, evicted: sealedOk.value?.evicted, hotBefore: hotBeforeOk.value?.messages?.length, afterSeal: afterOk.value?.messages?.length, afterTurn: afterTurnOk.value?.messages?.length, promptShaMatch: promptOk?.sha256 === promptSib?.sha256, okBytes: promptOk?.bytes, sibBytes: promptSib?.bytes, coldMessages: r11ok.ids.messages.length }));
  }

  // ── 自动触发（默认开）＋ 设置开关 ─────────────────────────────────────────
  {
    // 这一条走的是**真的自动压缩**：夹具把自己的 `usage` 报成 5000 tokens（> 3840 阈值）
    // ⇒ pi 在**这个回合里**自己压一次 ⇒ 回合落定 ⇒ 逻辑层派生封存。显式 `POST /compact` 那条路
    // （不是回合）**不**自动封存，那是另一条口径（见 R9 下面那条臂）。
    const autoFixture = await seed(ID.auto, { name: 'SEAL-AUTO', cold: 40, kept: 8, tail: 6, chars: 900, usageTokens: 5000 });
    const before = await projectFile(autoFixture.file);
    // 怎么认出「自动封存产生的那一行」：**封存那一刻新出现的归档行**。
    // 2026-10-05 收緊：以前是按 `parentId === 热会话` 认的 —— 冷段改成**兄弟**之后那个关系不存在了
    // ⇒ 改成「新增行」（与热会话的父子关系无关，所以兄弟化之后仍然量得到，而且不靠猜 id）。
    const rowsBeforeAuto = new Set((await treeOf()).value?.sessions?.map((row) => row.id) ?? []);
    const autoTurn = await send(ID.auto, PROBE, { timeoutMs: 60_000 });
    const sealedAuto = await poll('auto seal after a compaction turn', async () => {
      const tree = await treeOf();
      const fresh = (tree.value?.sessions ?? []).filter((row) => !rowsBeforeAuto.has(row.id));
      return { cold: fresh.find((row) => row.archived === true) ?? null, fresh: fresh.map((row) => row.id), rows: tree.value?.sessions?.length ?? 0 };
    }, (state) => state.cold !== null, 30_000);
    const autoMessages = await messagesOf(ID.auto);
    check('自动触发（默认开）：**压缩回合**落定之后自己封存了 —— 树上多出一行归档行（与热会话**同级**），热行还在',
      autoTurn.accepted.statusCode === 202 && sealedAuto.cold !== null && sealedAuto.cold.parentId === null && sealedAuto.cold.archived === true && rowOf(await treeOf(), ID.auto)?.id === ID.auto,
      JSON.stringify({ accepted: autoTurn.accepted.statusCode, coldChild: sealedAuto.cold && { id: sealedAuto.cold.id, parentId: sealedAuto.cold.parentId, archived: sealedAuto.cold.archived }, fresh: sealedAuto.fresh, rows: sealedAuto.rows, entriesBefore: before.entries }));
    check('自动封存之后热文件仍是「摘要 + kept + tail」的形状（压缩块还在、条目变少）',
      autoMessages.statusCode === 200 && autoMessages.value?.compaction?.atIndex !== null && (await projectFile(autoFixture.file)).entries < before.entries,
      JSON.stringify({ atIndex: autoMessages.value?.compaction?.atIndex, entriesBefore: before.entries, entriesAfter: (await projectFile(autoFixture.file)).entries }));
    // 关掉开关：再压一次，不许再封存。
    const off = await api('/settings', { method: 'PATCH', body: { 'seal.autoOnCompaction': false } });
    check('设置开关：`seal.autoOnCompaction` 可关（PATCH 200 + 生效值 false）', off.statusCode === 200 && off.value?.settings?.['seal.autoOnCompaction'] === false, JSON.stringify({ status: off.statusCode, settings: off.value?.settings?.['seal.autoOnCompaction'] }));
    const auto2 = await seed('01a0b0bb-0000-4000-8000-00000000bb0a', { name: 'SEAL-AUTO-OFF', cold: 40, kept: 8, tail: 6, chars: 900, usageTokens: 5000 });
    // 同一条口径（「新增归档行」）—— 以前靠 `parentId === 热会话` 认冷段，兄弟化之后那个关系没了。
    const rowsBeforeOff = new Set((await treeOf()).value?.sessions?.map((row) => row.id) ?? []);
    const turnOff = await send('01a0b0bb-0000-4000-8000-00000000bb0a', PROBE, { timeoutMs: 60_000 });
    await sleep(3000);
    const treeOff = await treeOf();
    const offMessages = await messagesOf('01a0b0bb-0000-4000-8000-00000000bb0a');
    const freshOff = (treeOff.value?.sessions ?? []).filter((row) => !rowsBeforeOff.has(row.id));
    check('设置开关关掉之后：**压缩照旧发生**，但**不**自动封存（树上没有新的归档行、热文件没变小、压缩块还在）',
      turnOff.accepted.statusCode === 202
      && freshOff.length === 0
      && offMessages.value?.compaction?.atIndex !== null
      && (await projectFile(auto2.file)).entries > 2,
      JSON.stringify({ accepted: turnOff.accepted.statusCode, fresh: freshOff.map((row) => ({ id: row.id, archived: row.archived })), entries: (await projectFile(auto2.file)).entries, atIndex: offMessages.value?.compaction?.atIndex }));
  }

  // ── 显式 `POST /compact` 那条路**不**自动封存（它不是一次「压缩回合」）──────────────────
  {
    const explicit = await seed('01a0b0bb-0000-4000-8000-00000000bb0b', { name: 'SEAL-EXPLICIT', cold: 30, kept: 6, tail: 6, chars: 400 });
    const rowsBeforeExplicit = new Set((await treeOf()).value?.sessions?.map((row) => row.id) ?? []);
    const compactReply = await api('/sessions/01a0b0bb-0000-4000-8000-00000000bb0b/compact', { method: 'POST', body: {}, timeoutMs: 60_000 });
    await sleep(3000);
    const treeExplicit = await treeOf();
    const explicitMessages = await messagesOf('01a0b0bb-0000-4000-8000-00000000bb0b');
    const freshExplicit = (treeExplicit.value?.sessions ?? []).filter((row) => !rowsBeforeExplicit.has(row.id));
    check('显式 `POST /compact`（不是回合）压过之后：**没有**自动封存 —— 树上没有新的归档行、压缩块还在原处',
      compactReply.statusCode === 202
      && freshExplicit.length === 0
      && explicitMessages.value?.compaction?.atIndex !== null,
      JSON.stringify({ compact: compactReply.statusCode, fresh: freshExplicit.map((row) => ({ id: row.id, archived: row.archived })), atIndex: explicitMessages.value?.compaction?.atIndex, entries: (await projectFile(explicit.file)).entries }));
  }

  // ── G8 收尾：**真 pi 自己压过两次**的**真文件**上，点名更早那条边界（本件最想要的形状）──────
  // 前面 G8 用的是手造夹具（形状照 pi 的 `appendCompaction` 顺序）。这一条让 pi **自己**压两次
  // （每轮 preflight 一次：夹具的 usage 报大 ⇒ 第一轮压；这一轮的回答也报大 ⇒ 第二轮再压），
  // 然后在那个真文件上点名**更早那条**边界封存，并钉住「上下文里那块边界（最后那条摘要）位置前后逐字不变」。
  {
    // 沙箱专用注入（不设 ⇒ 生产路径零影响；红半/复现用它把窗口撑开，见报告「红半」一节）：
    //   · `SOPHO_FAULT_G8_TAIL_MS=<ms>`     —— 这一轮**回答**的响应压后 ms（⇒ 读的时候文件还在长）；
    //   · `SOPHO_FAULT_G8_SEAL_LATE_MS=<ms>` —— 封存请求晚发 ms（≈ 那次真实 flake 里「读早、封存晚」的间隔）。
    const faultTailMs = Number(process.env.SOPHO_FAULT_G8_TAIL_MS ?? 0) || 0;
    const faultSealLateMs = Number(process.env.SOPHO_FAULT_G8_SEAL_LATE_MS ?? 0) || 0;
    const noSettle = process.env.SOPHO_FAULT_G8_NO_SETTLE === '1';
    const two = await seed('01a0b0bb-0000-4000-8000-00000000c807', { name: 'SEAL-c807', cold: 40, kept: 8, tail: 6, chars: 900, usageTokens: 5000 });
    const turn1 = await send(two.id, PROBE, { usageTotal: 5000, timeoutMs: 60_000 });
    if (faultTailMs > 0) provider.delayAnswers(1, faultTailMs);
    const turn2 = await send(two.id, PROBE, { usageTotal: 5000, timeoutMs: 60_000 });
    await poll('two compactions landed', async () => projectFile(two.file), (projection) => projection.types.filter((type) => type === 'compaction').length === 2, 30_000);
    // ── 读源快照**之前**先等落定（本件唯一改的东西：何时读；判据与上界见 `waitSettledFile`）───────
    if (noSettle) {
      process.stdout.write('# 注入 `SOPHO_FAULT_G8_NO_SETTLE=1`：撤掉落定门（红半专用；这一跑预期红）\n');
    } else {
      const settled = await waitSettledFile(two.file, { idle: () => api(`/sessions/${two.id}`) });
      check('G8 真文件臂的**读前落定门**：runtime idle ＋ 文件连续 300 ms 一个字节没变 才去读源快照（上界 30 s，到点报红、不静默挂住）',
        settled.ok === true, JSON.stringify({ ok: settled.ok, reason: settled.reason ?? null, waitedMs: settled.waitedMs, stableForMs: settled.stableForMs, bytes: settled.bytes, runtime: settled.runtime }));
    }
    const before = await projectFile(two.file);
    const beforeLines = (await readFile(two.file, 'utf8')).split('\n').filter((line) => line !== '');
    const beforeBody = beforeLines.slice(1).map((line) => JSON.parse(line));
    const compactionIds = before.types.map((type, index) => (type === 'compaction' ? before.ids[index] : null)).filter((id) => id !== null);
    const beforeMessages = await messagesOf(two.id);
    const laterCompaction = beforeBody.find((entry) => entry.id === compactionIds[1]);
    const boundaryOfNamed = beforeBody.find((entry) => entry.id === compactionIds[0]).firstKeptEntryId;
    const boundaryIndex = beforeBody.findIndex((entry) => entry.id === boundaryOfNamed);
    if (faultSealLateMs > 0) await sleep(faultSealLateMs);
    const explicitTwo = await sealOf(two.id, { compactionEntryId: compactionIds[0] });
    const after = await projectFile(two.file);
    const afterMessages = await messagesOf(two.id);
    const coldProjection = await projectFile(explicitTwo.value.cold.file);
    const sourceIds = new Set(beforeBody.map((entry) => entry.id));
    const hotReused = after.ids.slice(1).filter((id) => sourceIds.has(id));      // 热文件里「从源搬过来」的那些（按热文件顺序）
    const hotAppended = after.ids.slice(1).filter((id) => !sourceIds.has(id));   // 热尾巴上补出来的设置条目
    const expectedRetained = beforeBody.slice(boundaryIndex).map((entry) => entry.id);
    const coldReused = coldProjection.ids.filter((id) => sourceIds.has(id));
    const beforeIds = (beforeMessages.value?.messages ?? []).map((message) => message.entryId);
    const afterIds = (afterMessages.value?.messages ?? []).map((message) => message.entryId);
    const suffix = beforeIds.slice(beforeIds.length - afterIds.length);
    check('G8 真 pi 压过两次的文件上：点名**更早那条**边界封存 ⇒ `boundary.source:"explicit"`、两条摘要都留在热文件里',
      turn1.accepted.statusCode === 202 && turn2.accepted.statusCode === 202 && compactionIds.length === 2
      && explicitTwo.value?.sealed === true && explicitTwo.value.boundary.source === 'explicit'
      && explicitTwo.value.boundary.compactionEntryId === compactionIds[0]
      && after.ids.includes(compactionIds[0]) && after.ids.includes(compactionIds[1]),
      JSON.stringify({ turns: [turn1.accepted.statusCode, turn2.accepted.statusCode], compactionIds, boundary: explicitTwo.value?.boundary, hotKeptBoth: after.ids.includes(compactionIds[0]) && after.ids.includes(compactionIds[1]) }));
    check('G8 真文件上「什么都没丢、也没乱」：热文件 = [点名那条摘要] ＋ 源里从点名边界到末尾的那些（顺序逐条相同）＋ 2 条补的设置条目；冷段 = 源里严格在边界之前的那些（顺序逐条相同）',
      hotAppended.length === 2
      && hotReused[0] === compactionIds[0]
      && JSON.stringify(hotReused.slice(1)) === JSON.stringify(expectedRetained.filter((id) => id !== compactionIds[0]))
      && JSON.stringify(coldReused) === JSON.stringify(beforeBody.slice(0, boundaryIndex).map((entry) => entry.id))
      && new Set([...hotReused, ...coldReused]).size === sourceIds.size,
      JSON.stringify({
        namedCompaction: compactionIds[0], boundary: boundaryOfNamed,
        hotReused: hotReused.length, expectedRetained: expectedRetained.length, hotAppended: hotAppended.length,
        coldReused: coldReused.length, expectedCold: boundaryIndex, covered: new Set([...hotReused, ...coldReused]).size, sourceEntries: sourceIds.size,
        orderOk: JSON.stringify(hotReused.slice(1)) === JSON.stringify(expectedRetained.filter((id) => id !== compactionIds[0])),
      }));
    check('G8 真文件上的安全前提：**更晚那条**摘要的 `firstKeptEntryId` 仍在热文件里（它不可能被裁到冷段 ⇒ pi 的上下文投影不会塌）',
      after.ids.includes(laterCompaction.firstKeptEntryId) && after.entries < before.entries,
      JSON.stringify({ laterCompaction: compactionIds[1], laterFirstKeptEntryId: laterCompaction.firstKeptEntryId, stillInHot: after.ids.includes(laterCompaction.firstKeptEntryId), beforeEntries: before.entries, afterEntries: after.entries }));
    check('G8 真文件上：上下文那块边界**还是同一条摘要、同一个 `firstKeptEntryId`**（正文是源那份的连续后缀）；`atIndex` 变小只是「冷段走了」（那是原始路径上的显示位置，不是上下文）',
      afterMessages.statusCode === 200
      && afterMessages.value?.compaction?.entryId === beforeMessages.value?.compaction?.entryId
      && afterMessages.value.compaction.firstKeptEntryId === beforeMessages.value.compaction.firstKeptEntryId
      && afterMessages.value.compaction.atIndex !== beforeMessages.value.compaction.atIndex
      && afterIds.length > 0 && suffix.every((id, index) => id === afterIds[index]),
      JSON.stringify({ beforeCompaction: { entryId: beforeMessages.value?.compaction?.entryId, firstKeptEntryId: beforeMessages.value?.compaction?.firstKeptEntryId, atIndex: beforeMessages.value?.compaction?.atIndex }, afterCompaction: { entryId: afterMessages.value?.compaction?.entryId, firstKeptEntryId: afterMessages.value?.compaction?.firstKeptEntryId, atIndex: afterMessages.value?.compaction?.atIndex }, beforeMessages: beforeIds.length, afterMessages: afterIds.length }));
  }

  // ── R10 红臂：**旧规则**（`SOPHO_FAULT_TREE_ANCHOR=prefix4k`）在另一个宿主上跑同一个场景 ──
  // （这个宿主在下面的 G10 红臂里兼扮「把归档挪回段外」的那一支：它另外挂了两支注入。）
  {
    await mkdir(legacySessions, { recursive: true });
    await writeFile(path.join(legacyHome, 'models.json'), '{"providers":{}}\n');
    await writeFile(path.join(legacyHome, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
    // 同一个 HOLE 场景（A → 同前缀 + 变大的 B）。
    for (let index = 0; index < 12; index += 1) {
      const id = randomUUID();
      await writeFile(path.join(legacySessions, `pad-${index}_${id}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id, timestamp: ISO(index), cwd: workspace })}\n${JSON.stringify({ type: 'message', id: `p-${index}`, parentId: null, timestamp: ISO(index), message: { role: 'user', content: [{ type: 'text', text: 'pad' }] } })}\n`);
    }
    const legacyHole = path.join(legacySessions, `hole_${ID.hole}.jsonl`);
    const headerLine = (id) => {
      const base = { type: 'session', version: 3, id, timestamp: ISO(0), cwd: workspace };
      const need = 4096 - 1 - Buffer.byteLength(JSON.stringify({ ...base, pad: '' }));
      return JSON.stringify({ ...base, pad: 'x'.repeat(need) });
    };
    const line = (entry) => JSON.stringify(entry);
    const message = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: ISO(9), message: { role, content: [{ type: 'text', text }] } });
    await writeFile(legacyHole, `${[headerLine(ID.hole), line(message('aaaaaaaa-0001', null, 'user', 'x'.repeat(200))), line({ type: 'session_info', id: 'aaaaaaaa-0002', parentId: 'aaaaaaaa-0001', timestamp: ISO(2), name: 'LEGACY-NAME-A' }), line(message('aaaaaaaa-0003', 'aaaaaaaa-0002', 'assistant', 'y'.repeat(2000)))].join('\n')}\n`);
    // 回落那条牙的红臂夹具（本单）：一条会话头里父 = 一个**真的存在**的会话，侧车把它指到一个
    // **不存在**的 id。本宿主带了 `SOPHO_FAULT_SEAL_PARENTS_NO_FALLBACK=1`（盲信侧车、不做存在性
    // 回落）⇒ 它必须给出那个悬垂 id（红）；主宿主上的同一条规则给出会话头里的值（G1c 的绿态）。
    const redParentId = '01a0b0bb-0000-4000-8000-00000000fa01';
    const redChildId = '01a0b0bb-0000-4000-8000-00000000fa02';
    const redBogusId = '01a0b0bb-0000-4000-8000-00000000fade';
    const redParentFile = path.join(legacySessions, `redparent_${redParentId}.jsonl`);
    const redChildFile = path.join(legacySessions, `redchild_${redChildId}.jsonl`);
    // G1d 的两条**真**红臂（同一本侧车、同一批夹具）：
    //   · 红臂① `SOPHO_FAULT_DETAIL_PARENT_IGNORES_SIDECAR=<id>` 把**详情**这一面对侧车的读取关掉（假装侧车
    //     不存在）⇒ 详情回到会话头里的值（热会话）⇒ 「详情与 `/tree` 同一个且都指冷段」必红（`/tree` 仍报冷段）；
    //   · 红臂② 本宿主本来就有 `SOPHO_FAULT_SEAL_PARENTS_NO_FALLBACK=1`（拿掉存在性回落）⇒ 侧车里那个
    //     **悬垂 id** 会被详情与 `/tree` **同时**照单收下 ⇒ 两边都不指任何真会话 ⇒ 同一条判据必红。
    // 两条臂用**两条不同的孩子**（一支开关是逐 id 的，像 `SOPHO_FAULT_SEAL_HOLD_BEFORE_RENAME_MS` 那样）。
    const redColdId = '01a0b0bb-0000-4000-8000-00000000fa03';
    const redIgnoreChildId = '01a0b0bb-0000-4000-8000-00000000fa04';
    const redIgnoreChildFile = path.join(legacySessions, `redignorechild_${redIgnoreChildId}.jsonl`);
    await writeFile(redParentFile, `${JSON.stringify({ type: 'session', version: 3, id: redParentId, timestamp: ISO(0), cwd: workspace })}\n`);
    await writeFile(redChildFile, `${JSON.stringify({ type: 'session', version: 3, id: redChildId, timestamp: ISO(1), cwd: workspace, parentSession: redParentFile })}\n${JSON.stringify({ type: 'message', id: 'rc-0001', parentId: null, timestamp: ISO(2), message: { role: 'user', content: [{ type: 'text', text: 'red child' }] } })}\n`);
    // 红臂① 的「冷段」：一条**真的存在**的会话（否则它在两支规则下都回落，量不出「详情忽略侧车」这一刀）。
    await writeFile(path.join(legacySessions, `redcold_${redColdId}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id: redColdId, timestamp: ISO(0), cwd: workspace })}\n`);
    await writeFile(redIgnoreChildFile, `${JSON.stringify({ type: 'session', version: 3, id: redIgnoreChildId, timestamp: ISO(1), cwd: workspace, parentSession: redParentFile })}\n${JSON.stringify({ type: 'message', id: 'ri-0001', parentId: null, timestamp: ISO(2), message: { role: 'user', content: [{ type: 'text', text: 'red ignore child' }] } })}\n`);
    await writeFile(path.join(legacyHome, 'seal-parents.jsonl'), [
      { childId: redChildId, parentId: redBogusId, fromParentId: redParentId, at: ISO(3) },
      { childId: redIgnoreChildId, parentId: redColdId, fromParentId: redParentId, at: ISO(4) },
    ].map((record) => `${JSON.stringify(record)}\n`).join(''));
    legacyBase = await startSandboxBase({ home: legacyHome, sessionsRoot: legacySessions, workspace, logPath: legacyLogPath, extraEnv: { SOPHO_FAULT_TREE_ANCHOR: 'prefix4k', SOPHO_FAULT_SEAL_PARENTS_NO_FALLBACK: '1', SOPHO_FAULT_DETAIL_PARENT_IGNORES_SIDECAR: redIgnoreChildId, SOPHO_FAULT_ARCHIVE_UNLOCKED: '1', SOPHO_FAULT_SEAL_HOLD_BEFORE_RENAME_MS: `1500:${ID.g10red}`, SOPHO_FAULT_ARCHIVE_HOT_SPLIT: '1', SOPHO_FAULT_ARCHIVE_HOT_GAP_MS: `2500:${ID.g11red}` } });
    await poll('legacy-anchor sandbox ready', () => hostStatus(legacyBase.port), (host) => host?.currentWorkerPid > 0, 60_000);
    const legacyApi = (pathname) => hostRequest(legacyBase.port, pathname, { timeoutMs: 60_000 });
    await legacyApi('/tree'); // 缓存 A
    await writeFile(legacyHole, `${[headerLine(ID.hole), line(message('aaaaaaaa-0001', null, 'user', 'x'.repeat(200))), line({ type: 'session_info', id: 'bbbbbbbb-0002', parentId: 'aaaaaaaa-0001', timestamp: ISO(3), name: 'LEGACY-NAME-B' }), line(message('bbbbbbbb-0003', 'bbbbbbbb-0002', 'assistant', 'y'.repeat(4000))), line(message('bbbbbbbb-0004', 'bbbbbbbb-0003', 'user', 'z'.repeat(4000))), line(message('bbbbbbbb-0005', 'bbbbbbbb-0004', 'assistant', 'w'.repeat(9000)))].join('\n')}\n`);
    const legacyTree = await legacyApi('/tree');
    const legacyRow = (legacyTree.value?.sessions ?? []).find((row) => row.id === ID.hole) ?? null;
    const legacyTruth = await projectFile(legacyHole);
    check('R10 红臂（旧规则 `SOPHO_FAULT_TREE_ANCHOR=prefix4k`）：同一个场景给出**文件里已经不存在的名字** ⇒ 绿断言确实有牙齿',
      legacyTruth.name === 'LEGACY-NAME-B' && legacyRow?.name === 'LEGACY-NAME-A',
      JSON.stringify({ status: legacyTree.statusCode, rowName: legacyRow?.name ?? null, truth: legacyTruth.name, bytes: (await stat(legacyHole)).size }));
    // G1c 红臂③：同一个侧车在「拿掉回落规则」的宿主上必须给出悬垂 id（主宿主上的绿态见 G1c 回落那条）。
    const redChildRow = (legacyTree.value?.sessions ?? []).find((row) => row.id === redChildId) ?? null;
    check('G1c 红臂③：把回落规则拿掉（`SOPHO_FAULT_SEAL_PARENTS_NO_FALLBACK=1`）⇒ 侧车的悬垂 `parentId` 被**照单全收**（树上给出一个不存在的父）⇒ 绿断言必红',
      redChildRow !== null && redChildRow.parentId === redBogusId && redChildRow.parentId !== redParentId,
      JSON.stringify({ childId: redChildId, parentId: redChildRow?.parentId ?? null, expectedRed: redBogusId, headerParent: redParentId, headerParentRowPresent: (legacyTree.value?.sessions ?? []).some((row) => row.id === redParentId) }));
    // G1d 红臂①（**真**打红）：这个宿主把**详情**这一面对侧车的读取关掉（`SOPHO_FAULT_DETAIL_PARENT_IGNORES_SIDECAR`）
    // ⇒ 详情回到**会话头里的值**（热会话 id，＝改前那个唯一能报的父字段值），而 `/tree` 仍按侧车给出冷段。
    const redIgnoreRow = (legacyTree.value?.sessions ?? []).find((row) => row.id === redIgnoreChildId) ?? null;
    const redIgnoreDetail = await legacyApi(`/sessions/${redIgnoreChildId}`);
    check('G1d 红臂①（真打红：`SOPHO_FAULT_DETAIL_PARENT_IGNORES_SIDECAR` 让详情忽略侧车）⇒ 详情报会话头里的值（热会话）、`/tree` 报冷段 ⇒ 「详情与 `/tree` 同一个且都指冷段」必红',
      redIgnoreRow !== null && redIgnoreRow.parentId === redColdId
      && redIgnoreDetail.value?.parentId === redParentId
      && !(redIgnoreDetail.value.parentId === redColdId && redIgnoreRow.parentId === redColdId && redIgnoreDetail.value.parentId === redIgnoreRow.parentId),
      JSON.stringify({ childId: redIgnoreChildId, detail: redIgnoreDetail.value?.parentId ?? null, tree: redIgnoreRow?.parentId ?? null, coldSegment: redColdId, fileLayer: redParentId, verdict: 'red' }));
    // G1d 红臂②（**真**打红）：同一条详情、同一本侧车，只是这条孩子指到一个**不存在的会话** ⇒ 拿掉存在性
    // 回落时（本宿主有 `SOPHO_FAULT_SEAL_PARENTS_NO_FALLBACK=1`）详情与 `/tree` 都照单收下那个悬垂 id。
    const redChildDetail = await legacyApi(`/sessions/${redChildId}`);
    check('G1d 红臂②（真打红：不做存在性回落）⇒ 详情与 `/tree` 都把侧车里那个**悬垂 id** 当真（那个 id 根本不是一份会话、也不回落）⇒ 「两边都指冷段」必红',
      redChildDetail.value?.parentId === redBogusId && redChildRow?.parentId === redBogusId
      && !(legacyTree.value?.sessions ?? []).some((row) => row.id === redBogusId)
      && redChildDetail.value.parentId !== redParentId,
      JSON.stringify({ childId: redChildId, detail: redChildDetail.value?.parentId ?? null, tree: redChildRow?.parentId ?? null, bogus: redBogusId, bogusIsASession: (legacyTree.value?.sessions ?? []).some((row) => row.id === redBogusId), fileLayer: redParentId, verdict: 'red' }));
  }

  // ── G10 红半：**把归档的冷路挪回段外** ⇒ 同一条并发臂必红 ────────────────────────────────
  // 做法（任务书说好可以用的「故障注入」）：**另一个宿主**（上面那个 legacy 宿主，它在 G10 红臂里
  // 兼扮「旧规则」）上挂两支注入：
  //   · `SOPHO_FAULT_ARCHIVE_UNLOCKED=1` —— 归档的冷路退回**旧样子**（不在封存那条独占段里，直接追加）；
  //   · `SOPHO_FAULT_SEAL_HOLD_BEFORE_RENAME_MS=1500:<id>` —— 封存那条会话的「核验通过 → rename」撑开 1500 ms。
  // 文件放出来（`legacySessions`），跑的也是**实现里的同一个函数**，只是那一刀的开关不同。
  // 时序：先发 `/seal`（它的准备阶段 ~10 ms），**300 ms 后**再发 `/archive` ⇒ 那一发追加必然落在
  // 「核验已过、rename 还没做」的 1500 ms 窗口里（不是靠撞时序）。
  {
    const redApi = (pathname, options = {}) => hostRequest(legacyBase.port, pathname, { timeoutMs: 120_000, method: options.method ?? 'GET', body: options.body === undefined ? null : JSON.stringify(options.body) });
    const seedRed = async (id, cwd, name) => {
      const fixture = buildFixture({ id, cwd, name });
      const file = path.join(legacySessions, `g10red_${id}.jsonl`);
      await writeFile(file, fixture.lines);
      return { fixture, file };
    };
    /** 独立投影（不信服务端）：热文件里那几条 `sopho.archive` 的 `data`。 */
    const archiveEntriesIn = async (file) => (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line)).filter((entry) => entry.type === 'custom' && entry.customType === 'sopho.archive').map((entry) => entry.data);

    // 把那个窗口**拉开**、让归档的追加落在「核验已过、rename 还没做」之间：收据说写了，rename 一盖就没了。
    const red1 = await seedRed(ID.g10red, path.join(sandbox, 'gone-g10-red-1'), 'SEAL-e102');
    const red1SealPending = redApi(`/sessions/${ID.g10red}/seal`, { method: 'POST', body: {} });
    await sleep(300); // 300 ms 足够封存跑到那段 hold（它撑开 1500 ms）、又远早于它 rename
    const red1Archive = await redApi(`/sessions/${ID.g10red}/archive`, { method: 'POST', body: { archived: true } });
    const red1Seal = await red1SealPending;
    const red1Archives = await archiveEntriesIn(red1.file);
    check('R-G10 把归档的冷路挪回段外 ⇒ 必红：收据说 `changed:true`、但那条追加被封存的 rename **盖掉了**（热文件里那一条不存在——绿半 G10 的那条断言在这里反过来）',
      red1Seal.value?.sealed === true && red1Archive.value?.changed === true && red1Archives.length === 0,
      JSON.stringify({ seal: { status: red1Seal.statusCode, sealed: red1Seal.value?.sealed ?? null, reason: red1Seal.value?.reason ?? null }, archive: { status: red1Archive.statusCode, ...red1Archive.value }, archiveEntriesInHotFile: red1Archives, hotBytes: (await stat(red1.file)).size }));

    // 注：与绿半**字面同一条臂**（同时发）**在红基座上不能当红臂用**：那一发追加如果比封存的第一次
    // 读更早落地，两路根本不碰面 ⇒ 结果与绿半一样（实测两种都出现过）—— 靠时序撞，不是判据。
    // 能判红的永远是上面那种**把窗口拉开**的形状。
  }

  // ── R-G11 红半：**把修法撤掉**（`SOPHO_FAULT_ARCHIVE_HOT_SPLIT=1`）⇒ 同一条臂必红 ──────────────
  // 这个 legacy 宿主上另挂了两支：`SOPHO_FAULT_ARCHIVE_HOT_SPLIT=1`（把「cwd 已消失且热」那条路
  // 退回旧形状：判 cwd 与写各一次 `runExclusive`，且不把「handle 已被收掉」翻译成可重试回执）＋
  // `SOPHO_FAULT_ARCHIVE_HOT_GAP_MS=2500:<id>`（把那条空档撑开）。
  // 时序：先发 `/archive`（它一进空档就停住），150 ms 后发 `/seal` ⇒ 封存恰好在那条空档上 `dispose()`
  // 掉那个 handle ⇒ 那一笔写撞上已 dispose 的 handle。
  {
    const redApi2 = (pathname, options = {}) => hostRequest(legacyBase.port, pathname, { timeoutMs: 120_000, method: options.method ?? 'GET', body: options.body === undefined ? null : JSON.stringify(options.body) });
    const redCwd = path.join(sandbox, 'gone-g11-red');
    await mkdir(redCwd, { recursive: true });
    const redFixture = buildFixture({ id: ID.g11red, cwd: redCwd, name: 'SEAL-e202' });
    const redFile = path.join(legacySessions, `g11red_${ID.g11red}.jsonl`);
    await writeFile(redFile, redFixture.lines);
    // 先把 runtime 弄热（不需要 provider），再删 cwd。
    const redWarm = await redApi2(`/sessions/${ID.g11red}/commands`);
    await rm(redCwd, { recursive: true, force: true });
    const redDetail = await redApi2(`/sessions/${ID.g11red}`);
    const redArchivePending = redApi2(`/sessions/${ID.g11red}/archive`, { method: 'POST', body: { archived: true } });
    await sleep(150);
    const redSeal = await redApi2(`/sessions/${ID.g11red}/seal`, { method: 'POST', body: {} });
    const redArchive = await redArchivePending;
    const redProjection = await projectFile(redFile);
    const redArchiveEntries = (await readFile(redFile, 'utf8')).split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line)).filter((entry) => entry.type === 'custom' && entry.customType === 'sopho.archive');
    check('R-G11 把修法撤掉（`SOPHO_FAULT_ARCHIVE_HOT_SPLIT=1`：判 cwd 与写各一次 `runExclusive` ⇒ 中间就是那条空档）⇒ 封存恰好在那条空档上动手：归档**500 ＋ 条目一个字没写** —— 绿半 G11 的那条断言在这里反过来（这就是修法有牙齿的证据）',
      redWarm.statusCode === 200 && redDetail.value?.readOnlyReason === 'cwd-missing'
      && redSeal.statusCode === 200 && redSeal.value?.sealed === true
      && redArchive.statusCode === 500 && redArchive.value?.error === 'internal_error'
      && /disposing or disposed/.test(String(redArchive.value?.message ?? ''))
      && redArchiveEntries.length === 0 && redProjection.badLines === 0,
      JSON.stringify({ warm: redWarm.statusCode, readOnlyReason: redDetail.value?.readOnlyReason, archive: { status: redArchive.statusCode, error: redArchive.value?.error ?? null, message: redArchive.value?.message ?? null, elapsedMs: redArchive.elapsedMs }, seal: { status: redSeal.statusCode, sealed: redSeal.value?.sealed ?? null, elapsedMs: redSeal.elapsedMs }, archiveEntriesInHotFile: redArchiveEntries.length, badLines: redProjection.badLines }));
  }
} catch (error) {
  primaryError = error;
  process.stderr.write(`${error?.stack ?? error}\n`);
} finally {
  const cleanup = [];
  await cleanupStep(problems, 'stop sandbox hosts', async () => { await base?.stop(); await legacyBase?.stop(); });
  await cleanupStep(problems, 'close fake provider', async () => { await new Promise((resolve) => provider?.server.close(() => resolve(undefined)) ?? resolve(undefined)); });
  cleanup.push(...cleanup);
  await cleanupStep(problems, 'remove sandbox', () => rm(sandbox, { recursive: true, force: true }));
  const ok = failures.length === 0 && primaryError === null;
  print('summary', { checks, failures: failures.length, failed: failures, sandbox });
  process.stdout.write(`RESULT ${ok ? 'session-seal PASS' : 'session-seal FAIL'} (${checks} checks${failures.length > 0 ? `, ${failures.length} failed` : ''})\n`);
  if (!ok) process.exitCode = 1;
  try {
    finishCleanup(primaryError, problems);
  } catch {
    process.exitCode = 1;
  }
}
