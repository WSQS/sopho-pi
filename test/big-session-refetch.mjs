#!/usr/bin/env node
// test/big-session-refetch.mjs —— 「大会话每回合重拉整份 /messages」的量化门（真夹具 + 真 Chromium）。
//
// 要钉住的不是「快不快」，而是**这一轮真的只拉了这一轮**：
//   · 服务端：`GET /messages?after=<entryId>` 回的增量**拼回去必须与整份逐字一样**（零内容损失），
//     字节数与毫秒都要有 before/after；缺省（不传参）必须与整份逐字一样，游标认不出来时必须回整份；
//   · 客户端（真 Chromium + 假 API）：一轮结束时真身确实带游标去拉增量、只 append 新节点，
//     而这条路径画出来的正文与「整份拉回来整块重画」**逐节点一致**（身份 + 文本头比）。
//
// fixture 是**真实 profile 里最大的那个会话文件的只读拷贝**（`~/.pi/profiles/assistant/sessions/**`,
// ≥ 8 MiB；可用 `SOPHO_BIG_SESSION_FILE` 指定单个文件）。**不就地读活实例**：拷贝到临时 home 再起自己的 A。
// 夹具不可得（profile 不存在 / 没有 ≥ 8 MiB 的会话）⇒ 打一行 `SKIP` 并 exit 0，**不静默通过**。
//
// ⚠️ 这份夹具是**活的**（2026-09-25 定性）：最大的那个会话文件属于**正在跑的那个会话**，跑这道门的
// 那条 bash 就写在它末尾 ⇒ 拷贝那一刻它的末条常常是一张「助手消息 + 工具调用还没落地」的卡。
// 客户端 `tailBase()` 按约定**正确地**拒绝用增量（游标必须就是手上那份的最后一条，见
// `cursor-missing-or-not-last`）⇒ 本门曾在**产品毫无缺陷**的情况下稳定红。处置在
// `settledTailPayload()`：浏览器那半的载荷先裁到「已定稿的那条」（只去尾、改一个字节都没有）。
//
// 红线：只起自己 spawn 的 A；只按那个 pid 停（`test/harness.mjs`）；高位随机端口（绝不用 7331/7321）；
// 日志写本次沙箱；**不 pkill**；真实 profile 只读（只 stat/readdir/readFile + 拷贝）。
//
// 用法：
//   node test/big-session-refetch.mjs                              # 真夹具（npm run test:bigrefetch）
//   node test/big-session-refetch.mjs --reverse-arm=no-tail-query  # 反证臂：副本上摘掉客户端的游标 ⇒ 必红

import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSandboxEnv, cleanupStep, finishCleanup, removeSandbox, runGateOnMutatedCopy } from './harness.mjs';
import { MIB, hostStatus, poll, reserveHighPort, sleep, startSandboxBase, writeMinimalHome } from './perf-verify-lib.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 反证臂用：让门去跑**另一棵树**的 `web/`（子进程里由 `runGateOnMutatedCopy` 指过来）。
// 口径与 `test/docs-index-complete.mjs` 一致。沙箱 A 仍起**真树**的 `server/` —— 本门的臂打的是
// 客户端那一半，服务端一字不改（要打服务端那一半就该动 `server/**`，本门不碰）。
const root = path.resolve(process.env.SOPHO_BIGREFETCH_GATE_ROOT || DEFAULT_ROOT);
const webRoot = path.join(root, 'web');
const GATE_FILE = fileURLToPath(import.meta.url);

// ── 反证臂：`--reverse-arm=<名字>`（在**副本**上改一处，再拿真门去打它，断言它必红）─────────────
//
// 为什么要有它：这道门量的是「客户端那一轮只拉了尾部增量」。把那条能力**从客户端那一半弄坏**
// （不碰服务端），门必须红 —— 否则它只是一条会变绿的装饰（本仓的口径：一道从不判红的门等于没有门）。
// 副本由 `test/harness.mjs` 的 `runGateOnMutatedCopy` 建在**仓库根里面**（ESM 靠向上查找解析
// `node_modules`），跑的是**真门自己**（`GATE_FILE`）＋ `SOPHO_BIGREFETCH_GATE_ROOT`，真树一个字节不动。
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const ARM_MUTATIONS = {
  // `web/app.js` 的 `refreshMessagesOnce()`：客户端**照旧判得出**可以用增量（`tailBase()` 返回游标、
  // 插桩记录里 reason=`ok`），却把游标从 URL 上摘掉 ⇒ 一次 `?after=` 都不发 —— 正是本门要钉的能力。
  'no-tail-query': {
    expect: '8 次探测后客户端仍不用增量',
    async mutate(copyRoot) {
      const file = path.join(copyRoot, 'web', 'app.js');
      const source = await readFile(file, 'utf8');
      // 只认结构（`const query = base ? … : '';`），不认整行字面量 —— 产品改字面量不会让臂假红。
      const needle = /const query = base \? [^;]* : '';/;
      if (!needle.test(source)) throw new Error('反证臂 no-tail-query 的改写没命中：副本 web/app.js 里找不到 refreshMessagesOnce() 拼游标那一行（产品形状变了）');
      await writeFile(file, source.replace(needle, "const query = ''; // 反证臂：判定照旧，游标不进 URL"), 'utf8');
    },
  },
};

if (ARM) {
  const arm = ARM_MUTATIONS[ARM];
  if (!arm) {
    process.stdout.write(`✗ 未知的反证臂：${ARM}（认识的：${Object.keys(ARM_MUTATIONS).join(', ')}）\n`);
    process.exit(2);
  }
  let armResult = null;
  let armError = null;
  try {
    armResult = await runGateOnMutatedCopy({
      root: DEFAULT_ROOT,
      tag: 'bigrefetch',
      dirs: ['web'],
      mutate: arm.mutate,
      gateFile: GATE_FILE,
      expect: arm.expect,
      envKey: 'SOPHO_BIGREFETCH_GATE_ROOT',
    });
  } catch (error) {
    armError = error;
  }
  process.stdout.write(`\n──── 反证臂 ${ARM}：预期红在 ${JSON.stringify(arm.expect)} ────\n`);
  if (armError !== null) {
    process.stdout.write(`✗ 反证臂 ${ARM} 没红到位：${armError instanceof Error ? armError.message : String(armError)}\n`);
  } else {
    process.stdout.write(`✓ 反证臂 ${ARM} 红到位（真门退出码 ${armResult.exitCode}）—— 这是**期望**的结果，不是缺陷\n`);
    process.stdout.write(`  红的那一行：${armResult.redLine}\n`);
    process.stdout.write(`  门输出（末 1600 字）：\n${armResult.output.slice(-1600)}\n`);
  }
  for (const problem of armResult?.problems ?? []) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
  process.exit(armError === null && armResult?.ok === true && (armResult?.problems ?? []).length === 0 ? 0 : 1);
}

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-refetch-'));
const artifactRoot = path.join(os.tmpdir(), 'sopho-refetch');
const artifactFile = path.join(artifactRoot, 'big-session-refetch.json');

const MIN_FIXTURE_BYTES = Number(process.env.SOPHO_REFETCH_MIN_FIXTURE_BYTES ?? 8 * MIB);
const REAL_PROFILE = process.env.SOPHO_REFETCH_PROFILE ?? path.join(os.homedir(), '.pi', 'profiles', 'assistant');
// 「增量 ≤ 整份的百分之几」是**字节**判据（确定性，不看机器忙不忙）：真夹具上实测 1.3% 上下，
// 阈值放到 8% 仍远低于「整份」（=100%）—— 留出夹具形状漂移（例如 extras 变多）的余地。
const TAIL_BYTE_RATIO = Number(process.env.SOPHO_REFETCH_TAIL_RATIO ?? 0.08);
// 客户端那半的耗时判据：同一条路上「增量」必须比「整份重画」快至少一倍（真夹具上差一个量级）。
const TAIL_TIME_RATIO = Number(process.env.SOPHO_REFETCH_TIME_RATIO ?? 0.5);
// 复现开关（**只用于复现本门一开始那条假红**，不是产品行为开关）：
//   · `1` / `open`  ：只等开屏那次拉取**开始**就开量（落在 selectSession 还在跑那个窗口里）；
//   · `render`      ：等开屏那次拉取**到齐**（渲染已起步）但不等它画完 —— 就是本门原来那条假红的窗口。
const RACE_MODE = process.env.SOPHO_REFETCH_RACE ?? '';
// 「一整轮」那条尺子（游标退到这一轮第一条 user）：真夹具上实测 4.4% 上下（一轮可以很长，比如 66 条），
// 阈值 20% 仍然远低于「整份」，也不随夹具某轮特别长就报假红。
const ROUND_BYTE_RATIO = Number(process.env.SOPHO_REFETCH_ROUND_RATIO ?? 0.2);

let checks = 0;
const skips = [];
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
function check(name, ok, detail) {
  if (!ok) throw new Error(`✗ ${name}\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}
function skip(name, reason) {
  skips.push(`${name}: ${reason}`);
  process.stdout.write(`⤵ SKIP ${name} —— ${reason}\n`);
}
const mib = (bytes) => Math.round((bytes / MIB) * 100) / 100;

/** 客户端 `tailBase()` 里那**四条提前返回**的标记 → 人话。顺序 = 源码里的顺序；
 *  标记是 `instrumentAppSource` 插进去的（数不对就报错），所以这句话说的是产品代码那条路自己的判定，
 *  不是门在旁边另判一遍。 */
const CURSOR_REFUSAL_NOTES = {
  'not-selected-or-visible-id-mismatch': '前提不成立：刷新目标 ≠ 选中会话 / 屏上正文的会话 id（换会话窗口里）',
  'no-rendered-payload-or-session-mismatch': '前提不成立：还没有一份「屏上那份正文」的载荷，或它的 sessionId 与刷新目标不一致',
  'render-not-complete': '前提不成立：容器 renderComplete 还不是 \'true\'（旧消息仍在空闲期分片补 / 正在重画）',
  'cursor-missing-or-not-last': '前提不成立：最后一条**已定稿**的消息不是手上那份的最后一条（后面还有没定稿的），或夹具末条根本没定稿',
};

/** 给服务端出去的 `web/app.js` 里的 `tailBase()` 插桩：把它**每条提前返回**换成带标记的拒绝、
 *  把接受分支也记一笔，于是「这次刷新用不用增量、不用是哪条前提」直接落在 `window.__probe.tailBases`。
 *  产品改成别的形状时（提前返回条数不对 / 接受分支不见了）**当场报错** —— 门不许静默失去观测。 */
function instrumentAppSource(source) {
  const header = 'function tailBase(id) {';
  const start = source.indexOf(header);
  if (start < 0) throw new Error('instrument: web/app.js 里找不到 tailBase()');
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error('instrument: 找不到 tailBase() 的函数体结尾');
  const body = source.slice(start, end);
  const reasons = Object.keys(CURSOR_REFUSAL_NOTES);
  let index = 0;
  const replaced = body.replace(/return null;/g, () => `return __refuse('${reasons[index++] ?? 'unknown-early-return'}');`);
  if (index !== reasons.length) throw new Error(`instrument: tailBase() 的提前返回有 ${index} 条，门上写的是 ${reasons.length} 条（产品形状变了）`);
  if (!replaced.includes('return { payload, cursor };')) throw new Error('instrument: tailBase() 的接受分支形状变了');
  const record = `(value, reason) => { (window.__probe ??= {}).tailBases ??= []; window.__probe.tailBases.push({ at: performance.now(), id, reason, base: value ? value.cursor.entryId : null, renderComplete: messagesNode.dataset.renderComplete ?? null, messageTotal: messagesNode.dataset.messageTotal ?? null, lastChild: (messagesNode.lastElementChild?.dataset?.entryId ?? messagesNode.lastElementChild?.dataset?.kind ?? null), payloadLength: (renderedPayload?.messages ?? []).length, payloadLast: ((renderedPayload?.messages ?? [])[(renderedPayload?.messages ?? []).length - 1]?.entryId) ?? null, hasPayload: renderedPayload !== null, payloadSessionId: renderedPayload?.sessionId ?? null, visibleMessagesId, selectedId }); }`;
  const instrumented = `${header}\n  const __record = ${record};\n  const __refuse = (reason) => { __record(null, reason); return null; };\n  const __accept = (value) => { __record(value, 'ok'); return value; };\n${replaced.slice(header.length).replace('return { payload, cursor };', 'return __accept({ payload, cursor });')}`;
  return source.slice(0, start) + instrumented + source.slice(end);
}

/** 插桩后的 app.js 必须还是**合法 JS**：写一份临时文件跑 `node --check`（只解析不执行）。
 *  没有这道自检时，插桩写坏了只会表现为「页面起不来 ⇒ tree did not render」，与本门要测的东西
 *  毫无关系 —— 门不可信。 */
async function assertInstrumentedParses(source, file) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, source, 'utf8');
  try {
    await promisify(execFile)(process.execPath, ['--check', file]);
  } catch (error) {
    throw new Error(`✗ 插桩后的 web/app.js 通不过 node --check（门的插桩写坏了）：${error.stderr || error.message}`);
  }
}

async function* walkJsonl(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full;
  }
}

/** fixture：真实 profile 里最大的那个会话文件（只读扫描 + 拷贝，绝不在原地起进程）。 */
async function pickFixture() {
  const explicit = process.env.SOPHO_BIG_SESSION_FILE;
  if (explicit) {
    const info = await stat(explicit).catch(() => null);
    if (!info?.isFile()) return { missing: `SOPHO_BIG_SESSION_FILE=${explicit} 不存在或不是文件` };
    if (info.size < MIN_FIXTURE_BYTES) return { missing: `SOPHO_BIG_SESSION_FILE=${explicit} 只有 ${mib(info.size)} MiB（< ${mib(MIN_FIXTURE_BYTES)} MiB）` };
    return { file: explicit, bytes: info.size, scanned: 'explicit env' };
  }
  let best = null;
  let scanned = 0;
  for await (const file of walkJsonl(path.join(REAL_PROFILE, 'sessions'))) {
    scanned += 1;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size < MIN_FIXTURE_BYTES) continue;
    if (!best || info.size > best.bytes) best = { file, bytes: info.size };
  }
  if (!best) return { missing: `${REAL_PROFILE}/sessions 下扫了 ${scanned} 个 .jsonl，没有一个 ≥ ${mib(MIN_FIXTURE_BYTES)} MiB` };
  return { ...best, scanned };
}

/** 一次完整的 GET：**整份**正文都收下来（perf-verify-lib 的 request 会把 raw 截到 4000 字符，
 *  这里要比「两次响应逐字节一样」，截断就不算证据了）。 */
function rawRequest(port, pathname, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname, headers: { accept: 'application/json', connection: 'close' } });
    const timer = setTimeout(() => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, elapsedMs: Date.now() - started });
    };
    req.once('error', (error) => finish({ error: error.message, statusCode: 0, bytes: 0, text: '' }));
    req.once('response', (response) => {
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => { bytes += chunk.length; chunks.push(chunk); });
      response.once('error', (error) => finish({ error: error.message, statusCode: response.statusCode ?? 0, bytes, text: '' }));
      response.once('end', () => finish({ statusCode: response.statusCode, bytes, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.end();
  });
}

const fixture = await pickFixture();
if (fixture.missing) {
  print('fixture', { searched: REAL_PROFILE, minMiB: mib(MIN_FIXTURE_BYTES), reason: fixture.missing });
  console.log(`SKIP test:bigsessionrefetch (${fixture.missing}；本门要的是真实大会话夹具的只读拷贝，不拿合成数据冒充)`);
  process.exit(0);
}
print('fixture', { file: fixture.file, MiB: mib(fixture.bytes), scanned: fixture.scanned ?? null });

const home = path.join(sandbox, 'home');
const sessionsRoot = path.join(home, 'sessions');
const workspace = path.join(sandbox, 'workspace');
const baseLogPath = path.join(sandbox, 'base.log');
let base;
let server;
let chromium;
let browser;
let treeStream;
const sessionStreams = new Map();
let primaryError;
let reference = null;

/** `web/app.js` 的 `messageSettled()` **同一口径**（助手消息要有 terminal `stopReason`、且它的工具
 *  卡都已有结果 —— 否则服务端还会改写它）。这里只在 Node 侧**摆前提**用，判据本身归产品那条路。 */
function messageSettled(item) {
  if (item?.role !== 'assistant') return true; // user / toolResult / 摘要类：一次写死
  if (typeof item.stopReason !== 'string' || item.stopReason === '') return false;
  for (const part of item.parts ?? []) {
    if (part?.type !== 'tool') continue;
    if (part.status !== 'done-success' && part.status !== 'done-error') return false;
  }
  return true;
}

/** 把浏览器那半的载荷裁到「最后一条**已定稿**的消息」（只去尾，一条正文都不改）。
 *
 *  为什么要裁：客户端 `tailBase()` 只在能证明「手上那份正文就是服务端这一版的严格前缀」时才带游标，
 *  而那条证明的第一条就是「游标 = 手上那份的**最后一条**」（见产品代码的 `cursor.index !== messages.length - 1`）。
 *  夹具是**活会话文件**的只读拷贝（见文件头），拷贝那一刻它常常卡在一张未定稿的工具卡上 ⇒ 这条前提
 *  **不可达**，客户端合法地退回整份，门就红在产品毫无缺陷的地方。裁到已定稿那条 = 「在末条已定稿那一刻
 *  取的那份快照」，前提自洽、可复现，且端到端的增量/重拉语义一条不少地照测。
 *
 *  ⚠️ 它只是**摆前提**的启发式：口径写歪/裁得不够 ⇒ 下面 `assertCursorReady` 会拿**产品自己**的判定
 *  报红（不是 skip、不是静默通过）。裁了几条、裁到哪条都打出来，绝不静默。 */
function settledTailPayload(raw) {
  const messages = raw.messages ?? [];
  let index = messages.length - 1;
  while (index >= 0 && !messageSettled(messages[index])) index -= 1;
  if (index < 0) {
    throw new Error(`✗ 夹具里 ${messages.length} 条消息没有一条已定稿 —— 「末条已定稿」这个前提在这份夹具上摆不出来，本门要测的增量/重拉语义测不了（**不跳过、不当绿**）`);
  }
  if (index === messages.length - 1) return raw;
  const trimmed = { ...raw, messages: messages.slice(0, index + 1) };
  print('browser fixture trim', {
    dropped: messages.length - trimmed.messages.length,
    from: messages.length,
    to: trimmed.messages.length,
    tail: trimmed.messages[index].entryId,
    why: '夹具末条未定稿（活会话卡在工具调用中）⇒ 客户端会合法地拒绝用增量，裁到已定稿那条',
  });
  return trimmed;
}

/** 客户端那半：真 Chromium + 假 API。载荷就是上面从真沙箱拿到的整份正文（先按 `settledTailPayload` 裁尾）。 */
async function runBrowserHalf(rawPayload) {
  const payload = settledTailPayload(rawPayload);
  const BIG_ID = payload.sessionId;
  const SMALL_ID = '11111111-1111-4111-8111-111111111111';
  const fullBytes = Buffer.byteLength(JSON.stringify({ ...payload }));
  const totalMessages = payload.messages.length;
  const smallPayload = {
    messages: Array.from({ length: 6 }, (_, index) => ({ entryId: `small-${index}`, role: index % 2 ? 'assistant' : 'user', timestamp: '2026-09-20T00:00:00.000Z', stopReason: index % 2 ? 'stop' : null, parts: [{ type: 'text', text: `小会话第 ${index} 条。` }] })),
    extras: [], compaction: { atIndex: null }, observability: null, context: null,
  };
  // 「这一轮新增的那条」：形状照真夹具的末条（assistant + terminal stopReason + 一个 text part）。
  const roundMessage = { entryId: 'round-probe-assistant', parentId: payload.messages[totalMessages - 1].entryId, timestamp: new Date().toISOString(), role: 'assistant', stopReason: 'stop', parts: [{ type: 'text', text: 'ROUNDPROBE 这一轮新增的正文。' }] };

  let servedMessages = payload.messages;
  let tailMode = 'on';
  const served = () => ({ ...payload, messages: servedMessages, extras: payload.extras ?? [], compaction: payload.compaction ?? { atIndex: null } });
  const tailSlice = (body, after) => {
    const index = body.messages.findIndex((item) => item.entryId === after);
    if (index < 0) return body;
    return { ...body, messages: body.messages.slice(index + 1), tail: { afterEntryId: after, from: index + 1, total: body.messages.length } };
  };
  const sessions = [
    { id: BIG_ID, name: '真大会话夹具', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T08:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
    { id: SMALL_ID, name: '小会话', parentId: null, archived: false, status: 'idle', statusLabel: '闲置', unread: false, modifiedAt: '2026-09-20T07:00:00.000Z', notify: { notifies: [], waitingFor: [] } },
  ];
  const sendJson = (response, status, value) => {
    const body = `${JSON.stringify(value)}\n`;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    response.end(body);
  };
  const contentType = (file) => (file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream');
  // 给服务端出去的 app.js 插桩（见 instrumentAppSource）：产品代码一字不改，只在**门伺服的那一份**里
  // 把 `tailBase()` 的每条出口记一笔。
  const instrumentedAppJs = instrumentAppSource(await readFile(path.join(webRoot, 'app.js'), 'utf8'));
  await assertInstrumentedParses(instrumentedAppJs, path.join(sandbox, 'instrumented-app.mjs'));
  const waitFor = async (operation, message, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try { last = await operation(); if (last) return last; } catch (error) { last = error; }
      await sleep(40);
    }
    throw new Error(`${message}; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
  };

  const port = await reserveHighPort();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true });
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: true, devices: [] });
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0, oldestId: null, oldestName: null, oldestAt: null } });
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      treeStream = response;
      return;
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|commands|seen|draft|events|message|models))?$/.exec(url.pathname);
    if (match) {
      const id = match[1];
      const action = match[2] ?? null;
      if (action === null) return sendJson(response, 200, { name: id === BIG_ID ? '真大会话夹具' : '小会话', runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null });
      if (action === 'messages') {
        let body = id === BIG_ID ? served() : smallPayload;
        const after = url.searchParams.get('after');
        if (id === BIG_ID && after !== null && tailMode === 'on') body = tailSlice(body, after);
        return sendJson(response, 200, body);
      }
      if (action === 'commands') return sendJson(response, 200, { streaming: false, commands: [] });
      if (action === 'models') return sendJson(response, 200, { models: [], current: null });
      if (action === 'seen') return sendJson(response, 200, { ok: true });
      if (action === 'draft') return sendJson(response, 200, { text: '' });
      if (action === 'message') return sendJson(response, 200, { ok: true });
      if (action === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false, pendingMessages: 0, queue: { steering: [], followUp: [] } })}\n\n`);
        sessionStreams.set(id, response);
        response.once('close', () => { if (sessionStreams.get(id) === response) sessionStreams.delete(id); });
        return;
      }
    }
    if (url.pathname === '/api/test/event' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const stream = sessionStreams.get(BIG_ID);
      if (!stream || stream.destroyed) return sendJson(response, 409, { message: 'session stream unavailable' });
      stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      return sendJson(response, 200, { ok: true });
    }
    const file = path.resolve(webRoot, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(`${webRoot}${path.sep}`)) return response.writeHead(403).end();
    try {
      const content = file.endsWith(`${path.sep}app.js`) ? instrumentedAppJs : await readFile(file);
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const debugPort = await reserveHighPort();
  const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
    ? 'C:/Users/user/AppData/Local/Chromium/Application/chrome.exe'
    : '/usr/bin/chromium');
  chromium = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(sandbox, 'chromium')}`, 'about:blank'], { env: browserSandboxEnv(sandbox), stdio: ['ignore', 'ignore', 'pipe'] });
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 'Chromium remote debugger did not start');
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const pageProblems = [];
  browser = (() => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') pageProblems.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageProblems.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
    });
    return {
      ready: new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      }),
      send(method, params = {}) {
        const id = ++sequence;
        const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        socket.send(JSON.stringify({ id, method, params }));
        return promise;
      },
      close() { socket.close(); },
    };
  })();
  await browser.ready;
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
  // 只读观测：①②3 三样。
  // ① `/messages` 的 URL/字节/到齐时刻；
  // ② `#messages` 上的 childList 变动（直播块 `.live-message` 自己会被挂上/摘下，单独计一档）；
  // ③ **客户端自己的判定**：服务端出去的 `web/app.js` 里 `tailBase()` 被插桩（见 instrumentAppSource），
  //    每次刷新「用不用增量、不用是哪条前提不成立」都原样落在 `window.__probe.tailBases`。
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__probe = { fetches: [], mutations: [], tailBases: [] };
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const url = String(args[0]);
      const p = originalFetch.apply(this, args);
      if (!/\\/messages/.test(url)) return p;
      const record = { url, t0: performance.now(), bytes: null, bodyMs: null };
      window.__probe.fetches.push(record);
      return p.then((response) => {
        const clone = response.clone();
        clone.arrayBuffer().then((buffer) => { record.bytes = buffer.byteLength; record.bodyMs = performance.now() - record.t0; });
        return response;
      });
    };
    const isLive = (node) => Boolean(node?.classList?.contains?.('live-message'));
    const observe = () => {
      const node = document.querySelector('#messages');
      if (!node) { setTimeout(observe, 20); return; }
      new MutationObserver((list) => {
        for (const entry of list) {
          const added = [...entry.addedNodes];
          const removed = [...entry.removedNodes];
          window.__probe.mutations.push({
            t: performance.now(),
            added: added.length - added.filter(isLive).length,
            removed: removed.length - removed.filter(isLive).length,
            liveAdded: added.filter(isLive).length,
            liveRemoved: removed.filter(isLive).length,
            children: node.children.length,
            complete: node.dataset.renderComplete,
          });
        }
      }).observe(node, { childList: true, subtree: false });
    };
    observe();
  ` });
  const evaluate = async (expression) => {
    const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
    return result.result.value;
  };
  /** 页面当前的**可观测事实**（失败时原样贴出来）——包括客户端自己那几条判定记录。 */
  const probeState = () => evaluate(`(() => {
    const node = document.querySelector('#messages');
    const probe = window.__probe;
    const last = node.lastElementChild;
    const sum = (key) => probe.mutations.reduce((total, item) => total + item[key], 0);
    return {
      renderComplete: node.dataset.renderComplete ?? null,
      messageTotal: node.dataset.messageTotal ?? null,
      children: node.children.length,
      lastChild: last ? (last.dataset.entryId ?? last.dataset.kind ?? '?') : null,
      added: sum('added'), removed: sum('removed'), liveAdded: sum('liveAdded'), liveRemoved: sum('liveRemoved'),
      batches: probe.mutations.length,
      fetches: probe.fetches.map((item) => ({ url: item.url.replace(/^.*\\/api/, '/api'), bytes: item.bytes, ms: item.bodyMs === null ? null : Math.round(item.bodyMs) })),
      tailBases: (probe.tailBases ?? []).slice(-4),
    };
  })()`);

  /** 静置：`#messages` 报 renderComplete、**所有**已记录的拉取都已到齐、且连续 `frames` 帧既无新拉取
   *  也无新 childList 变动。三件一起才算 —— 只看 renderComplete 会在「上一轮留下的 'true'」上提前返回，
   *  只看帧稳定会在一份几 MB 正文的空闲期补齐上提前返回；等不到就**报出**这三件各是什么。 */
  const quiesce = async (label, { frames = 20, timeoutMs = 180_000 } = {}) => {
    const settled = await evaluate(`(async () => {
      const budget = ${timeoutMs};
      const started = performance.now();
      let stable = 0;
      let lastFetches = -1;
      let lastMutations = -1;
      while (performance.now() - started < budget) {
        const node = document.querySelector('#messages');
        const probe = window.__probe;
        const mutations = probe.mutations.length;
        const fetchesSettled = probe.fetches.every((item) => item.bytes !== null);
        if (fetchesSettled && node.dataset.renderComplete === 'true' && mutations === lastMutations && probe.fetches.length === lastFetches) stable += 1;
        else { stable = 0; lastMutations = mutations; lastFetches = probe.fetches.length; }
        if (stable >= ${frames}) return true;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return false;
    })()`);
    if (settled) return;
    const state = await probeState();
    throw new Error(`✗ ${label}：等不到静置（renderComplete / 拉取到齐 / 连续 ${frames} 帧无变动 三件没同时成立）\n  页面状态：${JSON.stringify(state)}`);
  };

  const openBig = async () => {
    await evaluate(`window.__probe.fetches = []; window.__probe.mutations = []; true`);
    await evaluate(`document.querySelector('[data-session-id="${BIG_ID}"] .tree-select').click(); true`);
    if (RACE_MODE) {
      if (RACE_MODE === 'render') {
        // 等开屏那次拉取到齐（渲染已起步、`messageTotal` 已有），但**不等它画完**。
        await waitFor(() => evaluate(`window.__probe.fetches.length > 0 && window.__probe.fetches[0].bytes !== null && document.querySelector('#messages').dataset.messageTotal !== null`), 'race(render): open fetch did not land', 60_000);
      } else {
        await waitFor(() => evaluate(`window.__probe.fetches.length > 0`), 'race(open): open fetch did not start', 60_000);
      }
      return probeState();
    }
    await quiesce('开屏');
    const state = await probeState();
    // 开屏真的开完的判据：屏幕上那份就是服务端这一版的条数，而且**这之后没有在飞的拉取**
    //（只看 `fetches[0].bytes !== null` 不够 —— 初连的 snapshot 可能另开一次同内容的 GET，
    //  那一次还在飞时就开始量，会把它的应答记成「这一轮的拉取」—— 那就是本门一开始的假红）。
    check(`开屏落地（${state.messageTotal} 条、无在飞拉取）`, state.messageTotal === String(totalMessages) && state.fetches.every((item) => item.bytes !== null),
      `messageTotal=${state.messageTotal}（期望 ${totalMessages}）fetches=${JSON.stringify(state.fetches)}`);
    return state;
  };
  const postEvent = (name, data = {}) => evaluate(`fetch('/api/test/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ name, data }))} }).then((response) => response.ok)`);
  /** 一轮：`session.start` →（`stageRound`：载荷在这一刻真的变 = 助手那条落盘）→ `session.end`。
   *  ⚠️ `stageRound` 必须卡在两次事件之间**且等开播那一次拉取回来**：
   *  · 不卡在中间（改成开播前就变）⇒ 开播那一次就把这一轮拉走了，`session.end` 那次成了空增量，
   *    本门量到的东西就换了（字节/节点增量全变味）；
   *  · 不等它回来 ⇒ 两次拉取谁先谁后看运气，同样测不准。 */
  const fireRound = async (stageRound) => {
    const startArgs = `window.__probe.fetches = []; window.__probe.mutations = []; window.__probe.t0 = performance.now(); true`;
    await evaluate(startArgs);
    await postEvent('session.start', {});
    if (stageRound) {
      await waitFor(() => evaluate(`window.__probe.fetches.length >= 1 && window.__probe.fetches[0].bytes !== null`), '开播那一次 /messages 没有落地', 120_000);
      await quiesce('开播那一次拉取后的静置');
      stageRound();
    }
    await postEvent('session.end', { stopReason: 'stop', errorMessage: null });
  };
  const fireRoundEnd = () => fireRound(null);
  /** 客户端自己那条判定 → 一句人话（标记来自产品代码里 `tailBase()` 的哪一条提前返回，见 instrumentAppSource）。 */
  const refusalNote = (record) => {
    if (!record) return '没有记录到客户端对 tailBase() 的判定 —— **插桩没生效**（门失去了观测，当失败处理）';
    // `ok` = 产品那条路**说可以用**，可这一趟 URL 里却没有游标：那就不是「哪条前提不成立」，
    // 是游标没进 URL（拼 URL 那一半）。照实说，别把它栽到前提头上。
    if (record.reason === 'ok') {
      return `客户端 tailBase() 判定「可以用增量」（reason=ok、游标 ${record.base}），但这一趟刷新的 URL 里**没有**游标 —— 不是前提不成立，是游标没进 URL`;
    }
    return CURSOR_REFUSAL_NOTES[record.reason] ?? `前提不成立（tailBase 提前返回的标记：${record.reason}）`;
  };
  /** 量之前先让**客户端自己**回答「现在能不能用增量」：发一帧 `session.snapshot`（内容不变）→ 它必然
   *  触发一次刷新 —— 那一次的 URL 与 `tailBases` 最后一条就是答案。
   *  客户端完全可能**合法地**说「不行」（比如上一波的整块重画还在空闲期补），所以这里是**轮询**：
   *  每次先等静置、再探一帧；到点了还不成立才红，并把**客户端自己那条判定**原样贴出来（是哪条前提）。 */
  const assertCursorReady = async (label, { attempts = 8 } = {}) => {
    const timeline = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await quiesce(`${label}: 第 ${attempt} 次探测前的静置`);
      await evaluate(`window.__probe.fetches = []; window.__probe.mutations = []; true`);
      await evaluate(`fetch('/api/test/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'session.snapshot', data: { isStreaming: false, isCompacting: false, isRetrying: false, pendingMessages: 0, queue: { steering: [], followUp: [] } } }) }).then((response) => response.ok)`);
      await waitFor(() => evaluate(`window.__probe.fetches.length > 0 && window.__probe.fetches[0].bytes !== null && window.__probe.tailBases.length > 0`), `${label}：探针刷新（一帧 session.snapshot）没有落地`, 180_000);
      const state = await probeState();
      const url = state.fetches[0]?.url ?? '(没有拉取)';
      const record = state.tailBases.at(-1);
      if (!url.includes('?after=')) {
        timeline.push({ attempt, url: url.replace(/^.*\/api/, '/api'), reason: record?.reason ?? null });
        print(`${label}：第 ${attempt} 次探测，客户端说不行`, { reason: record?.reason ?? null, note: refusalNote(record) });
        if (attempt < attempts) await sleep(250);
        continue;
      }
      await quiesce(`${label}：探针刷新后静置`);
      const after = await probeState();
      check(`${label}：客户端自己判定「可以用增量」（游标 ${record.base}，第 ${attempt} 次探测）`, record.base !== null && record.base === record.payloadLast,
        `tailBases 最后一条：${JSON.stringify(record)}${attempt > 1 ? `；前 ${attempt - 1} 次客户端说不行：${JSON.stringify(timeline)}` : ''}`);
      check(`${label}：内容没变 ⇒ 增量是空的、正文一个节点都没动`, after.added === 0 && after.removed === 0 && after.messageTotal === state.messageTotal,
        `added=${after.added} removed=${after.removed} bytes=${after.fetches[0]?.bytes} messageTotal=${after.messageTotal}`);
      print(`${label}：探针刷新`, { attempt, url: url.replace(/^.*\/api/, '/api'), bytes: state.fetches[0]?.bytes, ms: state.fetches[0]?.ms, added: after.added, removed: after.removed, record });
      return after;
    }
    // 到点还不成立：说清**是哪条前提**（标记来自产品代码 `tailBase()` 的哪条提前返回），
    // 而不是笼统地说「客户端没带游标」。
    const state = await probeState();
    const record = state.tailBases.at(-1);
    throw new Error(`✗ ${label}：${attempts} 次探测后客户端仍不用增量 —— ${refusalNote(record)}\n  各次结果：${JSON.stringify(timeline)}\n  客户端自己的判定记录（tailBases，最近 4 条）：${JSON.stringify(state.tailBases)}\n  页面状态：${JSON.stringify({ ...state, tailBases: undefined })}`);
  };
  /** 一轮结束（真事件：start → end）→ 量这一次重拉。开量之前已经在 `assertCursorReady` 里确认
   *  「客户端的四条前提此刻都成立」；仍然被拒（例如探测之后又来了帧、新一轮整块重画正在飞）时返回
ull，
   *  由调用方**整场重跑**（重开页面重开会话）——拒绝本身是客户端的合法行为，不能靠改状态骗过去。 */
  const runRound = async (label, stageRound) => {
    await fireRound(stageRound);
    await quiesce(`${label}：一轮结束后的静置`);
    const state = await probeState();
    const record = state.tailBases.at(-1);
    const last = state.fetches.at(-1);
    if (!last?.url.includes('?after=')) {
      print(`${label}：这一轮客户端拒绝了增量`, { note: refusalNote(record), url: last?.url.replace(/^.*\/api/, '/api'), record, tailBases: state.tailBases });
      return null;
    }
    // ⚠️ 新事实（2026-09-19，`session.start` 顺手拉一次正文那次改动 —— 为了让会话外来的扩展消息
    // 画在流式正文**之前**，见 web/app.js 的 session.start）：一轮现在会有**两次**拉取 ——
    // 开播那一帧一次（新增），结束那一帧一次（就是本门要量的那次）。这里把不变量改强：
    // 两次**都必须**是尾部增量（`?after=`）—— 哪一条退化成整份拉取（如 35 MiB），就是这次
    // 改动的代价失控，本门要红；测量取**最后一次**（结尾那次），语义与以前完全一致。
    const fullFetches = state.fetches.filter((item) => !item.url.includes('?after='));
    if (fullFetches.length > 0) {
      throw new Error(`✗ ${label}：这一轮有 ${fullFetches.length} 次 /messages 没带尾部游标（整份拉取）—— 逐条：${JSON.stringify(state.fetches)}`);
    }
    if (state.fetches.length > 2) {
      throw new Error(`✗ ${label}：这一轮触发的 /messages 拉取多于两次（${state.fetches.length} 次）—— 逐条：${JSON.stringify(state.fetches)}`);
    }
    return {
      url: last.url,
      bytes: last.bytes,
      bodyMs: last.ms,
      startBytes: state.fetches[0]?.bytes ?? null,
      fetchCount: state.fetches.length,
      added: state.added,
      removed: state.removed,
      liveAdded: state.liveAdded,
      liveRemoved: state.liveRemoved,
      batches: state.batches,
      settleMs: Math.round(await evaluate(`window.__probe.mutations.length ? window.__probe.mutations[window.__probe.mutations.length - 1].t - window.__probe.t0 : performance.now() - window.__probe.t0`)),
      children: state.children,
      total: state.messageTotal,
      complete: state.renderComplete,
      probeText: await evaluate(`(document.querySelector('#messages').textContent.match(/ROUNDPROBE/g) || []).length`),
      record,
    };
  };

  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${BIG_ID}"]') !== null`), 'tree did not render');
  print('browser fixture', { payloadMiB: mib(fullBytes), messages: totalMessages, round: roundMessage.entryId });

  const fullRoundBytes = () => Buffer.byteLength(`${JSON.stringify(served())}\n`);
  /** 一整场：开屏 → 等静置 → 让**客户端自己**确认「可以用增量」→ 一轮结束 → 量。
   *  客户端在量之前又合法地拒了（罕见）就**整场重跑**（重开页面 + 重开会话），最多 3 次；
   *  3 次都被拒才红，并把三次的原因都打出来。 */
  const runScenario = async (label, stageRound) => {
    const refusals = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      servedMessages = payload.messages;
      const opened = await openBig();
      if (!RACE_MODE) await assertCursorReady(`${label} 准备`);
      const round = await runRound(label, stageRound);
      if (round) return { opened, round, attempt };
      refusals.push({ attempt, tailBases: (await probeState()).tailBases });
      if (attempt < 3) {
        await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
        await waitFor(() => evaluate(`document.querySelector('[data-session-id="${BIG_ID}"]') !== null`), 'tree did not render after a scenario retry', 60_000);
      }
    }
    throw new Error(`✗ ${label}：连跑 3 次客户端都拒绝用增量（这不是「客户端没带游标」—— 拒绝原因见上面的 tailBases）\n  各次：${JSON.stringify(refusals)}`);
  };

  // before：假服务端**不认** `after`，回的就是整份 —— 这正是这次改动之前那条路。
  tailMode = 'off';
  let beforeRoundBytes = 0;
  const beforeRun = await runScenario('整份（before）', () => { servedMessages = [...payload.messages, roundMessage]; beforeRoundBytes = fullRoundBytes(); });
  const before = beforeRun.round;
  const beforeOpen = beforeRun.opened;
  // after：同一份载荷、同一轮、同一段代码，唯一的区别是服务端认 `after`。
  tailMode = 'on';
  const afterRun = await runScenario('增量（after）', () => { servedMessages = [...payload.messages, roundMessage]; });
  const after = afterRun.round;
  const afterOpen = afterRun.opened;
  print('browser before', { ...before, openBytes: beforeOpen.fetches[0].bytes, expectedRoundBytes: beforeRoundBytes });
  print('browser after', { ...after, openBytes: afterOpen.fetches[0].bytes });

  check('before 那条路确实收到整份（字节 = 整份 + 这一轮那条）并整块重画', before.bytes === beforeRoundBytes,
    `before bytes=${before.bytes}（期望整份 ${beforeRoundBytes} = 首开 ${beforeOpen.fetches[0].bytes} + 这一轮）URL=${before.url.replace(/^.*\/api/, '/api')}`);
  check(`after 的字节数 ≤ before 的 ${Math.round(TAIL_BYTE_RATIO * 100)}%`, after.bytes <= before.bytes * TAIL_BYTE_RATIO,
    `after ${after.bytes} B（${mib(after.bytes)} MiB, ${(100 * after.bytes / before.bytes).toFixed(2)}%）vs before ${before.bytes} B（${mib(before.bytes)} MiB）；bodyMs ${after.bodyMs} vs ${before.bodyMs}；整份首开 ${afterOpen.fetches[0].bytes} B/${afterOpen.fetches[0].ms}ms`);
  check('after 只 append、一个旧正文节点都没动（before 是整块重画）', after.removed === 0 && after.added > 0 && before.removed > totalMessages * 0.5,
    `after added=${after.added} removed=${after.removed}（直播块另外计：+${after.liveAdded}/-${after.liveRemoved}）；before added=${before.added} removed=${before.removed}（批次 ${before.batches}）`);
  check(`after 的结算耗时 ≤ before 的 ${Math.round(TAIL_TIME_RATIO * 100)}%（同机同轮、同一判据）`, after.settleMs <= before.settleMs * TAIL_TIME_RATIO,
    `after settle=${after.settleMs}ms；before settle=${before.settleMs}ms`);
  check('增量那次真把这一轮画进了正文（ROUNDPROBE 一次、条数 +1）', after.probeText === 1 && after.total === String(totalMessages + 1),
    `ROUNDPROBE=${after.probeText} messageTotal=${after.total}（期望 ${totalMessages + 1}）children=${after.children} complete=${after.complete}`);

  // 零内容损失：把「增量画出来的那一屏」与「整份拉回来整块重画的那一屏」逐节点比（身份 + 文本头）。
  const identity = () => evaluate(`(() => Array.from(document.querySelector('#messages').children).map((node) => (node.dataset.entryId ?? node.dataset.kind ?? '?') + '#' + (node.textContent || '').slice(0, 24)).join('|'))()`);
  const tailIdentity = await identity();
  await quiesce('切到小会话前');
  await evaluate(`document.querySelector('[data-session-id="${SMALL_ID}"] .tree-select').click(); true`);
  await waitFor(() => evaluate(`document.querySelector('#messages').dataset.renderComplete === 'true' && document.querySelectorAll('#messages .message').length === ${smallPayload.messages.length}`), 'small session did not render', 60_000);
  await evaluate(`document.querySelector('[data-session-id="${BIG_ID}"] .tree-select').click(); true`);
  await quiesce('切回大会话（整份重画）');
  check('切回大会话是整份拉回来重画的（照旧那条路）', (await probeState()).messageTotal === String(totalMessages + 1),
    `messageTotal=${(await probeState()).messageTotal}（期望 ${totalMessages + 1}）`);
  const fullIdentity = await identity();
  const identityEqual = tailIdentity === fullIdentity;
  check('增量画出来的正文 == 整份重画的正文（逐节点身份 + 文本头）', identityEqual,
    identityEqual ? `节点数=${tailIdentity.split('|').length}（末尾：${tailIdentity.split('|').slice(-2).join(' / ')}）` : `不一致：增量 ${tailIdentity.split('|').length} 节点 vs 整份 ${fullIdentity.split('|').length} 节点`);

  // 空增量：这一轮什么都没新增 ⇒ 仍走增量、正文一个节点都不该动。
  // （上一步已经切回大会话并整份重画过，所以这里的判定也是「客户端自己说的」。）
  if (!RACE_MODE) await assertCursorReady('空增量准备');
  await evaluate(`window.__probe.fetches = []; window.__probe.mutations = []; window.__probe.t0 = performance.now(); true`);
  await fireRoundEnd();
  await quiesce('空增量：一轮结束后的静置');
  const emptyState = await probeState();
  const emptyLast = emptyState.fetches.at(-1);
  const empty = { ...emptyState, url: emptyLast?.url ?? '', bytes: emptyLast?.bytes ?? null, total: emptyState.messageTotal };
  if (!empty.url.includes('?after=')) {
    throw new Error(`✗ 空增量：客户端拒绝了增量 —— ${refusalNote(emptyState.tailBases.at(-1))}\n  客户端自己的判定记录：${JSON.stringify(emptyState.tailBases)}\n  页面状态：${JSON.stringify({ ...emptyState, tailBases: undefined })}`);
  }
  check('「这一轮没有新增」：仍带游标、字节仍远小于整份、正文一个节点不动', empty.bytes <= before.bytes * TAIL_BYTE_RATIO && empty.added === 0 && empty.removed === 0 && empty.total === String(totalMessages + 1),
    `bytes=${empty.bytes}（${(100 * empty.bytes / before.bytes).toFixed(2)}%）added=${empty.added} removed=${empty.removed} children=${empty.children} total=${empty.total}（期望 ${totalMessages + 1}）`);

  check('页面没有未捕获异常或 console.error', pageProblems.length === 0, JSON.stringify(pageProblems));
}

try {
  // ── fixture 落地（只读拷贝）+ 沙箱 A ────────────────────────────────────────
  await writeMinimalHome(home, workspace);
  await mkdir(sessionsRoot, { recursive: true });
  const fixtureCopy = path.join(sessionsRoot, `fixture-${path.basename(fixture.file)}`);
  await copyFile(fixture.file, fixtureCopy);
  const header = JSON.parse((await readFile(fixtureCopy, 'utf8')).split('\n')[0]);
  const sessionId = String(header?.id ?? '');
  check('夹具头部有合法会话 id', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId), `id=${sessionId || '(缺)'}（来自拷贝的第 1 行 header）`);

  base = await startSandboxBase({
    home,
    sessionsRoot,
    workspace,
    logPath: baseLogPath,
    // 只读缓存诊断：用它**如实判**每一次 /messages 走的是热（runtime）还是冷（文件）那条路。
    extraEnv: { SOPHO_READONLY_CACHE_DIAGNOSTICS: '1' },
  });
  const readLog = () => readFile(baseLogPath, 'utf8').catch(() => '');
  try {
    await poll('refetch sandbox ready', () => hostStatus(base.port), (host) => host?.currentWorkerPid > 0, 120_000);
  } catch (error) {
    // 沙箱起不来时**原样贴日志尾巴**（最常见的两种：worktree 没装依赖 ⇒ 模块找不到；端口被占 ⇒ bind 失败）。
    const log = await readLog().catch(() => '(读不到日志)');
    throw new Error(`✗ 沙箱 A 没起来：${error.message}\n  base.log 尾巴：\n${log.split('\n').slice(-12).join('\n')}`);
  }
  const messages = (query = '') => rawRequest(base.port, `/sessions/${sessionId}/messages${query}`);

  // ── 服务端（冷读那条路）：缺省行为 + 增量语义 ──────────────────────────────
  const coldFull = await messages();
  check('缺省 GET /messages 仍 200 且带完整正文', coldFull.statusCode === 200 && coldFull.bytes > MIN_FIXTURE_BYTES, `status=${coldFull.statusCode} bytes=${coldFull.bytes}（${mib(coldFull.bytes)} MiB）ms=${coldFull.elapsedMs}`);
  const full = JSON.parse(coldFull.text);
  const totalMessages = full.messages.length;
  check('缺省响应里**没有** tail 标记（形状不变）', !('tail' in full), `'tail' in payload = ${'tail' in full}; messages=${totalMessages} extras=${(full.extras ?? []).length}`);
  print('coldFull', { bytes: coldFull.bytes, MiB: mib(coldFull.bytes), ms: coldFull.elapsedMs, messages: totalMessages, extras: (full.extras ?? []).length, compactionAt: full.compaction?.atIndex ?? null });

  const lastId = full.messages[totalMessages - 1].entryId;
  const deepCursor = [...full.messages].reverse().find((item) => item.role === 'user')?.entryId;
  check('夹具末条与最后一条 user 都有 entryId（增量游标取得到）', Boolean(lastId && deepCursor), `lastId=${lastId} lastUserId=${deepCursor}`);

  // ① 游标 = 最后一条 ⇒ 空增量
  const emptyResponse = await messages(`?after=${encodeURIComponent(lastId)}`);
  const emptyPayload = JSON.parse(emptyResponse.text);
  check('游标=最后一条 ⇒ 空增量且下标自洽', emptyResponse.statusCode === 200 && emptyPayload.tail?.from === totalMessages && emptyPayload.messages.length === 0 && emptyPayload.tail?.total === totalMessages,
    `tail=${JSON.stringify(emptyPayload.tail)} messages=${emptyPayload.messages.length} bytes=${emptyResponse.bytes}`);

  // ② 游标 = 最后一条 user ⇒ 「这一轮从用户那句话算起」的增量；拼回去必须与整份逐字一样
  const tail = await messages(`?after=${encodeURIComponent(deepCursor)}`);
  const tailPayload = JSON.parse(tail.text);
  check('增量响应带自洽的 tail 元信息', tailPayload.tail?.afterEntryId === deepCursor && tailPayload.tail.from === totalMessages - tailPayload.messages.length && tailPayload.tail.total === totalMessages,
    `tail=${JSON.stringify(tailPayload.tail)} messages=${tailPayload.messages.length}`);
  const { tail: tailMeta, ...tailRest } = tailPayload;
  const restitch = JSON.stringify({ ...tailRest, messages: [...full.messages.slice(0, tailMeta.from), ...tailPayload.messages] });
  check('增量 + 手上那份前缀 == 整份（逐字）', restitch === coldFull.text.trim(), restitch === coldFull.text.trim() ? `一致（${tailPayload.messages.length} 条增量 + ${tailMeta.from} 条前缀 = ${totalMessages} 条）` : `不一致：长度 ${restitch.length} vs ${coldFull.text.trim().length}`);
  check(`空增量（游标=最后一条）字节 ≤ 整份的 ${Math.round(TAIL_BYTE_RATIO * 100)}%`, emptyResponse.bytes <= coldFull.bytes * TAIL_BYTE_RATIO,
    `空增量 ${emptyResponse.bytes} B（${(100 * emptyResponse.bytes / coldFull.bytes).toFixed(2)}%）—— 它剩下的是**全量 extras**（真夹具 ${(full.extras ?? []).length} 条），见服务端注释里的取舍；ms ${emptyResponse.elapsedMs} vs ${coldFull.elapsedMs}`);
  check(`整轮增量（游标退到这一轮第一条 user）字节 ≤ 整份的 ${Math.round(ROUND_BYTE_RATIO * 100)}%`, tail.bytes <= coldFull.bytes * ROUND_BYTE_RATIO,
    `整轮 ${tail.bytes} B（${(100 * tail.bytes / coldFull.bytes).toFixed(2)}%）= 整份 ${coldFull.bytes} B（${mib(coldFull.bytes)} MiB）的 1/${Math.round(coldFull.bytes / tail.bytes)}；ms ${tail.elapsedMs} vs ${coldFull.elapsedMs}`);
  print('tail-vs-full', { tailBytes: tail.bytes, tailMiB: mib(tail.bytes), tailMs: tail.elapsedMs, fullBytes: coldFull.bytes, fullMiB: mib(coldFull.bytes), fullMs: coldFull.elapsedMs, ratioPct: Number((100 * tail.bytes / coldFull.bytes).toFixed(2)) });

  // ③ 同一版本 + 同一游标再拉一次 ⇒ 走响应体缓存，字节逐字一致
  const again = await messages(`?after=${encodeURIComponent(deepCursor)}`);
  check('同一游标再拉一次：整份响应体逐字一致（走响应体缓存）', again.text === tail.text && again.bytes === tail.bytes, `bytes=${again.bytes}/${tail.bytes} ms=${again.elapsedMs}/${tail.elapsedMs}`);

  // ④ 游标不在这一版（过期 / 换枝）⇒ 如实回整份，不编增量
  const bogus = await messages('?after=deadbeefdeadbeef');
  check('游标不在这一版 ⇒ 回整份（无 tail 标记、字节与缺省整份逐字一致）', bogus.statusCode === 200 && bogus.text === coldFull.text && bogus.bytes === coldFull.bytes,
    `status=${bogus.statusCode} bytes=${bogus.bytes} vs 缺省 ${coldFull.bytes}`);
  // ⑤ 参数校验（新参数也不能什么都收）
  const badEmpty = await messages('?after=');
  const badLong = await messages(`?after=${'x'.repeat(129)}`);
  check('`?after=` 空 / 超长 ⇒ 400 invalid_after', badEmpty.statusCode === 400 && badLong.statusCode === 400,
    `empty=${badEmpty.statusCode} ${badEmpty.text.slice(0, 60)}；long=${badLong.statusCode} ${badLong.text.slice(0, 60)}`);

  // ⑥ 热读那条路（runtime 在场）：用 /commands 把 runtime 拉起来，再核日志走的是 hot 分支
  const logBefore = await readLog();
  const warm = await rawRequest(base.port, `/sessions/${sessionId}/commands`, { timeoutMs: 60_000 });
  if (warm.statusCode !== 200) {
    skip('热读（runtime 在场）那条增量', `GET /commands -> ${warm.statusCode} ${warm.text.slice(0, 120)}（例如夹具的 cwd 在本机不存在时起不了 runtime）`);
  } else {
    const hotTail = await messages(`?after=${encodeURIComponent(deepCursor)}`);
    const freshLines = (await readLog()).slice(logBefore.length).split('\n').filter((line) => line.includes('readonly-cache'));
    check('热读增量：内容与冷读增量逐字一致', hotTail.text === tail.text, hotTail.text === tail.text ? `一致 bytes=${hotTail.bytes} ms=${hotTail.elapsedMs}（冷读 ms=${tail.elapsedMs}）` : `不一致（hot ${hotTail.bytes} B vs cold ${tail.bytes} B）`);
    check('热读增量走的确实是 runtime 那条路（诊断日志 `parse <sessionId>`）', freshLines.some((line) => line.includes(`parse ${sessionId}`)), `增量那次请求新增的缓存诊断：${JSON.stringify(freshLines.slice(-3))}`);
    print('hotTail', { bytes: hotTail.bytes, ms: hotTail.elapsedMs, log: freshLines.slice(-3) });
  }

  // ── 客户端那半（真 Chromium + 假 API，载荷 = 上面那份真正文）─────────────────
  reference = full;
  await runBrowserHalf(reference);

  await mkdir(artifactRoot, { recursive: true });
  await writeFile(artifactFile, `${JSON.stringify({ checks, skips, fixture: { file: fixture.file, MiB: mib(fixture.bytes) } }, null, 2)}\n`);
  print('skips', skips);
  print('checks', checks);
  print('artifact', artifactFile);
  print('RESULT', `big session refetch PASS (checks:${checks}${skips.length ? ` skips:${skips.length}` : ''})`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupProblems = [];
  await cleanupStep(cleanupProblems, 'close browser', () => browser?.close());
  await cleanupStep(cleanupProblems, 'destroy tree stream', () => { treeStream?.destroy(); });
  await cleanupStep(cleanupProblems, 'destroy session streams', () => { for (const stream of sessionStreams.values()) stream.destroy(); });
  if (chromium && chromium.exitCode === null) {
    await cleanupStep(cleanupProblems, 'stop chromium', async () => {
      chromium.kill('SIGTERM');
      await new Promise((resolve) => chromium.once('exit', resolve));
    });
  }
  await cleanupStep(cleanupProblems, 'close server', async () => {
    if (!server) return; // 第一阶段就失败时它还没起：不能落进一个永远不 resolve 的 Promise（否则门会挂住）
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await cleanupStep(cleanupProblems, 'stop sandbox base', () => base?.stop());
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
