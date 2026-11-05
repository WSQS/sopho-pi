#!/usr/bin/env node
// tree-scale —— `/tree` 在「300+ 会话 / 含 10 MB 级文件」规模下的三条契约：
//
//   ① **耗时有上界**：冷扫描必须远低于宿主等 worker 的硬超时（`server/base.mjs` 的
//      `AbortSignal.timeout(5000)`），热路径必须回到百毫秒量级。
//      为什么是这两个数：5000 ms 是**代码里写死的**宿主悬崖（线上实测踩过 —— 打一次 /tree 回 500、
//      用时 5.002 s）；阈值取 4000 = 悬崖的 80%，留下「worker 慢一点也不会翻车」的余量。
//      热路径 1000 ms：v2.1（tag `v2.1-final`）在 327 会话上是 ~120-220 ms，热路径只该做「stat 一遍 + 拼行」。
//   ② **行不许变**：每一条树行（name/archived/cwd/parentId/parentSessionPath/createdAt/modifiedAt/
//      titleSource）都要与**测试自己逐行 JSON.parse** 算出来的参照值逐个相等 —— 提速不能靠少发/发错字段。
//   ③ **到点先回、后台接着建、断连不留坏账**（P0，2026-09-21 按新语义重写）：
//      · 索引有**死线**（`SOPHO_TREE_INDEX_BUDGET_MS`；必须小于宿主那条硬超时）：到点回
//        **200 + 部分视图**（行都对、可能不全、顶层 `partial: true` + `indexScan`），**绝不等成 500**；
//      · 到点**不是**放弃扫描：共享的那一次在后台跑完 ⇒ 第二次调用是完整树且快；
//      · **中途断连**（宿主硬超时走同一条路）⇒ 扫描真的停下来（不许被放弃的请求继续占 CPU），
//        但在途已经投影的字节**留在断点里** ⇒ 下一次从断点接着扫，不是从 0 重来；
//      · 并发/重复的请求**共享同一次**扫描（不是每人一层）。
//      ⚠️ 旧断言「被中止的扫描必须**没**扫完（`filesProjected < files.length`）」已经删掉：
//      它的前提是「客户端 60 ms 后才断开、而扫描更慢」，在快机器上 304 个小文件 4 ms 就扫完了
//      ⇒ 前提不成立（必红）；而且「到点/中止后后台把它跑完」正是**现在要的行为**，不是缺陷。
//      线上实测过的反面（宿主超时放弃后 worker 还在算、每请求叠一层、5409 条 TimeoutError）
//      靠的是「一次共享的扫描 + 让被放弃的那次真的停下」这一对，两条都还在。
//
// 自足：临时 home + 随机高位端口 + 自己 spawn 的 pid 收尾（绝不 pkill、绝不碰 7331/7321/真 profile）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLD_MAX_MS = Number(process.env.SOPHO_TREE_SCALE_COLD_MAX_MS ?? 4000);
const HOT_MAX_MS = Number(process.env.SOPHO_TREE_SCALE_HOT_MAX_MS ?? 1000);
// 规模：300 个小会话 + 3 个大文件（10 MB 一档，brief 点名的形状）。合计 ~30 MB。
const SMALL = Number(process.env.SOPHO_TREE_SCALE_SMALL ?? 300);
const BIG_FILES = 3;
const BIG_LINE_BYTES = 8 * 1024;
const BIG_LINES = 1200;
// 「中途掐断」那一臂的**前提**：等扫描真的投影过这么多字节再断（可观察事实，不是计时猜测）。
// 旧版本是「客户端 60 ms 后自己断开」——快机器上整趟扫描 4 ms 就完了，前提根本不成立。
const ABORT_PROGRESS_BYTES = Number(process.env.SOPHO_TREE_SCALE_ABORT_PROGRESS_BYTES ?? 256 * 1024);

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'tree-scale-'));
// 自带的看门狗：这个门里有几个「等事实出现」的循环，卡住时必须**自己响亮地死掉**，
// 而不是把 CI 挂在那里（踩过一次：SSE 客户端只等 error、没等 close）。
let primaryError = null;
const watchdog = setTimeout(() => {
  process.stderr.write('WATCHDOG: tree-scale did not finish in 300000 ms\n');
  process.exit(2);
}, 300000);
watchdog.unref?.();
const home = path.join(sandbox, 'home');
const sessions = path.join(home, 'sessions');
const workspace = path.join(sandbox, 'workspace');
const logPath = path.join(sandbox, 'base.log');
const abortLogPath = path.join(sandbox, 'base-abort.log'); // ③b 那条「死线很小」的宿主

const print = (label, value) => process.stdout.write(`${label}: ${JSON.stringify(value)}\n`);
// 只取关心的键（门里的断言用它：别的 landing 会不断往 part/message 上加字段，不该把我们的门弄红）。
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value?.[key]]));
const round = (n) => Math.round(n * 100) / 100;
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 各臂**独立报告**：一臂红了也要把其余臂跑完，最后一起汇总失败。
// 为什么（2026-09-21 的教训）：这条门原来在第 ③b 条断言上就抛出死掉 ⇒ 它后面**每一条臂都没跑**
// ⇒ 唯一覆盖「非紧凑 JSONL 回退」的 ⑦c 被整条遮住，于是把 `projectTreeLineByParse` 定义误删
// 造成的 500 回归一路漏到了门上（详情见 /tmp/tree-pep-and-partial-report.md §C）。
const armFailures = [];
async function arm(label, body) {
  try {
    await body();
    process.stdout.write(`✓ arm ${label}\n`);
  } catch (error) {
    armFailures.push({ label, error });
    process.stdout.write(`✗ arm ${label} —— ${error instanceof Error ? error.message : String(error)}\n`);
  }
}


function entry(id, parentId, timestamp, extra) {
  return JSON.stringify({ type: 'message', id, parentId, timestamp, message: extra });
}

// 参照事实（独立于服务端）：与老实现（逐行 JSON.parse）逐条对齐 —— 名字取最后一条 session_info、
// latestRole 取最后一条 user/assistant 消息、归档取最后一条 sopho.archive、modifiedAt 取最后一个 timestamp。
async function referenceFacts(file) {
  const text = await readFile(file, 'utf8');
  let header = null;
  let name = null;
  let latestRole = null;
  let modified = null;
  let archivePresent = false;
  let archived = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const item = JSON.parse(line);
    if (header === null && item.type === 'session' && typeof item.id === 'string') header = item;
    if (item.timestamp !== undefined) modified = item.timestamp;
    if (item.type === 'session_info') name = item.name || null;
    if (item.type === 'message' && ['user', 'assistant'].includes(item.message?.role)) latestRole = item.message.role;
    if (item.type === 'custom' && item.customType === 'sopho.archive') { archivePresent = true; archived = item.data?.archived === true; }
  }
  return {
    id: header.id.toLowerCase(),
    name,
    status: latestRole === 'assistant' ? 'unread' : 'idle',
    archived,
    cwd: header.cwd,
    parentSessionPath: header.parentSession ?? null,
    createdAt: header.timestamp ?? null,
    modifiedAt: modified ?? (header.timestamp ?? null),
  };
}

// 一条「什么都有」的会话：thinking / text / toolCall / toolResult / 第二条助手 / 扩展消息 / 压缩边界。
// 用它钉住 /messages 的**内容口径**（part 顺序、工具状态与结果、extras 单独一块、compaction 边界），
// 期望值是测试自己写死的（fixture 就是本测试造的）—— 提速不许改内容。
const RICH = {
  id: '01a0a001-0000-4000-8000-000000000001',
  entries: {
    user: '01a0a001-0000-4000-8000-000000000002',
    thinking: '01a0a001-0000-4000-8000-000000000003',
    toolResult: '01a0a001-0000-4000-8000-000000000004',
    second: '01a0a001-0000-4000-8000-000000000005',
    extra: '01a0a001-0000-4000-8000-000000000006',
    compaction: '01a0a001-0000-4000-8000-000000000007',
  },
};

async function writeRichSession() {
  const at = '2026-09-18T03:00:00.000Z';
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: RICH.id, timestamp: at, cwd: workspace }),
    JSON.stringify({ type: 'message', id: RICH.entries.user, parentId: null, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({
      type: 'message', id: RICH.entries.thinking, parentId: RICH.entries.user, timestamp: at,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'think-1' },
          { type: 'text', text: 'answer-1' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'x.txt' } },
        ],
        stopReason: 'toolUse',
      },
    }),
    JSON.stringify({
      type: 'message', id: RICH.entries.toolResult, parentId: RICH.entries.thinking, timestamp: at,
      message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'result-1' }], isError: false },
    }),
    JSON.stringify({ type: 'message', id: RICH.entries.second, parentId: RICH.entries.toolResult, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'answer-2' }], stopReason: 'stop' } }),
    JSON.stringify({ type: 'custom_message', id: RICH.entries.extra, parentId: RICH.entries.second, timestamp: at, customType: 'sopho.test-ext', content: [{ type: 'text', text: 'ext-1' }], display: true, details: { color: 'purple' } }),
    JSON.stringify({ type: 'compaction', id: RICH.entries.compaction, parentId: RICH.entries.extra, timestamp: at, summary: 'compact-1', firstKeptEntryId: RICH.entries.user, tokensBefore: 42 }),
  ];
  const file = path.join(sessions, `2026-09-18T03-00-00-000Z_${RICH.id}.jsonl`);
  await writeFile(file, `${lines.join('\n')}\n`);
  return { id: RICH.id, file };
}

async function writeSessions() {
  await mkdir(sessions, { recursive: true });
  const files = [];
  for (let index = 0; index < SMALL; index += 1) {
    const id = randomUUID();
    const at = new Date(Date.parse('2026-09-18T00:00:00.000Z') + index * 1000).toISOString();
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: workspace }),
      entry(randomUUID(), null, at, { role: 'user', content: [{ type: 'text', text: `q${index}` }] }),
      // 名字故意写在**中间**（后面还接很多条）—— 「只读尾巴」的实现会在这里露馅。
      JSON.stringify({ type: 'session_info', id: randomUUID(), parentId: null, timestamp: at, name: `会话 ${index}` }),
    ];
    for (let filler = 0; filler < 6; filler += 1) {
      lines.push(entry(randomUUID(), null, new Date(Date.parse(at) + filler * 1000).toISOString(), { role: 'assistant', content: [{ type: 'text', text: `a${index}-${filler}` }] }));
    }
    if (index % 10 === 3) {
      lines.push(JSON.stringify({ type: 'custom', id: randomUUID(), parentId: null, timestamp: at, customType: 'sopho.archive', data: { archived: true } }));
      lines.push(entry(randomUUID(), null, at, { role: 'toolResult', toolName: 'x', content: [{ type: 'text', text: 'result' }] }));
    }
    if (index % 10 === 5) lines.push(entry(randomUUID(), null, at, { role: 'user', content: [{ type: 'text', text: 'last user' }] }));
    const file = path.join(sessions, `2026-09-18T00-00-${String(index).padStart(3, '0')}Z_${id}.jsonl`);
    await writeFile(file, `${lines.join('\n')}\n`);
    files.push({ id, file });
  }
  for (let big = 0; big < BIG_FILES; big += 1) {
    const id = randomUUID();
    const at = new Date(Date.parse('2026-09-18T01:00:00.000Z') + big * 1000).toISOString();
    const chunks = [
      `${JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: workspace })}\n`,
      `${JSON.stringify({ type: 'session_info', id: randomUUID(), parentId: null, timestamp: at, name: `大会话 ${big}` })}\n`,
      `${entry(randomUUID(), null, at, { role: 'user', content: [{ type: 'text', text: 'big task' }] })}\n`,
    ];
    const filler = 'x'.repeat(BIG_LINE_BYTES);
    for (let line = 0; line < BIG_LINES; line += 1) {
      chunks.push(`${entry(randomUUID(), null, new Date(Date.parse(at) + line * 1000).toISOString(), { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: `${filler}${line}` }] })}\n`);
    }
    chunks.push(`${entry(randomUUID(), null, new Date(Date.parse(at) + BIG_LINES * 1000).toISOString(), { role: 'assistant', content: [{ type: 'text', text: 'big done' }] })}\n`);
    const file = path.join(sessions, `2026-09-18T01-00-0${big}Z_${id}.jsonl`);
    await writeFile(file, chunks.join(''));
    files.push({ id, file });
  }
  files.push(await writeRichSession());
  return files;
}

async function reservePort() {
  for (;;) {
    const port = 44000 + Math.floor(Math.random() * 15000);
    if ([7331, 7321, 7322, 7411, 7412].includes(port)) continue;
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (ok) return port;
  }
}

function get(port, pathname, { timeoutMs = 180000, accept = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const started = nowMs();
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: { accept, connection: 'close' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        let value = null;
        try { value = JSON.parse(body.toString('utf8')); } catch {}
        resolve({ statusCode: response.statusCode, ms: round(nowMs() - started), bytes: body.length, value });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.once('error', reject);
  });
}

// POST（中止臂用 reload-code）：只需要状态码与 JSON。
function post(port, pathname, body, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body ?? {}));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length, connection: 'close' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let value = null;
        try { value = JSON.parse(raw); } catch {}
        resolve({ statusCode: response.statusCode, value, bytes: raw.length });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.once('error', reject);
    req.end(payload);
  });
}

// 保持一条 SSE 连接（= 在 worker 里 acquire + pin 住那个会话）。不需要读它的内容，
// 目的是让那条会话**热在某一代**里，而且那条代不会因为空转而退出。
function openSse(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: { accept: 'text/event-stream', connection: 'keep-alive' } }, (response) => {
      response.on('data', () => {});
      response.on('error', () => {});
      resolve({ req, response });
    });
    req.once('error', reject);
  });
}

// 等 draining 代**真的退干净**再继续。为什么需要这一句：
// 宿主每次 `/tree` 都会给 draining 代发一条 live-facts IPC（`drainingRunningSessionIds` → `callWorker`
// → `child.send`）。子进程的 IPC 通道**已经关了、但 'exit' 事件还没到**的那一瞬间，`send()` 会以
// EPIPE 收场；同一个子进程上**并发**失败两次以上时，第二个 'error' 事件没人接 ⇒ **宿主进程直接退出**
// （真机上就是整个实例挂掉）。这是产品侧一个独立缺陷：基线 `d4d1e49` 一样复现（探针与原始输出见
// `/tmp/tree-scale-realign-report.md`）。按本轮红线**没有动产品代码**，这里只是让本门要钉的契约
// （并发共享一次扫描）不要与那个缺陷的触发窗口叠在一起 —— 门测的仍然是「6 个并发 /tree 只扫一次」。
async function waitDrainingGone(port, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const host = (await get(port, '/host')).value;
    const draining = host?.drainingGenerations ?? [];
    if (draining.length === 0) return true;
    if (Date.now() > deadline) throw new Error(`draining generation did not exit in ${timeoutMs} ms: ${JSON.stringify(draining)}`);
    await sleep(20);
  }
}

async function waitHost(port) {
  const deadline = Date.now() + 60000;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await get(port, '/host', { timeoutMs: 3000 });
      if (response.statusCode === 200 && response.value?.currentWorkerPid) return response.value;
    } catch (error) { last = error; }
    await sleep(100);
  }
  const tail = (await readFile(logPath, 'utf8').catch(() => '(unreadable)')).split(/\r?\n/).slice(-15).join('\n');
  throw new Error(`host did not start on ${port}: ${last?.message}\n--- base.log tail ---\n${tail}`);
}

function treeIndexFacts(hostResponse) {
  const host = hostResponse?.value ?? hostResponse ?? {};
  const workers = Array.isArray(host.workers) ? host.workers : [];
  const worker = workers.find((detail) => detail.state === 'current') ?? workers[0] ?? null;
  return {
    workerPid: worker?.pid ?? host.currentWorkerPid ?? null,
    rssBytes: worker?.rssBytes ?? host.workerRssBytes ?? null,
    treeIndex: worker?.memoryPolicy?.caches?.treeIndex ?? host.memoryPolicy?.caches?.treeIndex ?? null,
  };
}

// 树的「内容」签名：比整份 body 少掉 generatedAt / unread 汇总 / 每个会话的 notify / context。
// 为什么不算 context：热会话的 context 来自 runtime（真的），冷会话是 null —— 那是「现在热不热」，
// 不是内容变了。这里要钉住的是**行**没变。
const rowSignature = (row) => JSON.stringify({
  id: row.id, name: row.name, archived: row.archived, cwd: row.cwd, parentId: row.parentId,
  parentSessionPath: row.parentSessionPath, createdAt: row.createdAt, modifiedAt: row.modifiedAt, titleSource: row.titleSource,
});
function treeSignature(tree) {
  return (tree?.sessions ?? []).map(rowSignature);
}
function sameTree(left, right) {
  const a = treeSignature(left);
  const b = treeSignature(right);
  if (a.length !== b.length) return { ok: false, reason: `row count ${a.length} !== ${b.length}` };
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return { ok: false, reason: `row ${index}: ${a[index]} !== ${b[index]}` };
  return { ok: true };
}

// 一批行与「测试自己逐行 JSON.parse 算出来的参照值」逐字段比（给不全可以，给错不行）。
// ⚠️ 这里额外钉 `parentId`：这些夹具里没有带父的会话 ⇒ 半成索引下也必须是 null，
// 不许出现「一会儿 null、一会儿真 id」的行（那是「给错」不是「给不全」）。
function rowMismatches(rows, referenceMap) {
  const wrong = [];
  for (const row of rows) {
    const want = referenceMap.get(row.id);
    if (!want) { wrong.push({ id: row.id, why: 'unknown id in reference' }); continue; }
    const got = { id: row.id, name: row.name, archived: row.archived, cwd: row.cwd, parentSessionPath: row.parentSessionPath, createdAt: row.createdAt, modifiedAt: row.modifiedAt, parentId: row.parentId };
    const expected = { id: want.id, name: want.name, archived: want.archived, cwd: want.cwd, parentSessionPath: want.parentSessionPath, createdAt: want.createdAt, modifiedAt: want.modifiedAt, parentId: null };
    if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push({ got, want: expected });
  }
  return wrong;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
  ]);
  if (exited === false) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
}

// `homeDir` / `logFile` / `env` 都是给第二条宿主（③b 那条「索引死线很小」的）用的：
// 同一个 sessions 目录、自己的 home 与日志，互不踩。
async function start(port, { homeDir = home, logFile = logPath, sessionsRoot = sessions, env = {} } = {}) {
  const log = await open(logFile, 'w');
  const child = spawn(process.execPath, [path.join(root, 'server', 'base.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: homeDir,
      ASSIST_HOME: homeDir,
      PI_CODING_AGENT_DIR: homeDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: workspace,
      SOPHO_NO_TOOLS: '1',
      SOPHO_READONLY_CACHE_DIAGNOSTICS: '1',
      SOPHO_MEMORY_HEAP_HIGH_BYTES: '1000000000000',
      SOPHO_MEMORY_HEAP_LOW_BYTES: '900000000000',
      SOPHO_MEMORY_RSS_HIGH_BYTES: '1000000000000',
      SOPHO_MEMORY_RSS_LOW_BYTES: '900000000000',
      ...env,
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  return child;
}

// 索引账（`/host` 上的只读事实）等到满足条件为止（有界）。③b/⑦a 都靠它拿**可观察前提**。
async function waitIndexFacts(port, predicate, { timeoutMs = 60000, intervalMs = 50, what = 'index facts' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = treeIndexFacts(await get(port, '/host')).treeIndex;
    if (last && predicate(last)) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
    await sleep(intervalMs);
  }
}

// 等到「扫描在飞、而且已经真的投影过 >= minBytes 字节」。满足它的那一刻，剩余工作量必然还很大
// （该文件还没投影到的地方 = 整份夹具还没扫的部分），所以接着断连就**必然**落在扫描中途。
async function waitScanProgress(port, { minBytes, timeoutMs = 30000 } = {}) {
  return waitIndexFacts(port, (facts) => facts.inFlight === true && Number(facts.checkpointBytes) >= minBytes, {
    timeoutMs,
    intervalMs: 10,
    what: `the scan to be mid-flight with >= ${minBytes} bytes already projected`,
  });
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const files = await writeSessions();
  const sizes = await Promise.all(files.map(async (item) => (await stat(item.file)).size));
  const totalBytes = sizes.reduce((sum, n) => sum + n, 0);
  print('fixture', { sessions: files.length, bigFileBytes: Math.max(...sizes), totalBytes, coldLimitMs: COLD_MAX_MS, hotLimitMs: HOT_MAX_MS, abortProgressBytes: ABORT_PROGRESS_BYTES, sandbox });

  // 参照事实（独立于服务端：逐行 JSON.parse）
  const reference = new Map();
  for (const item of files) reference.set(item.id.toLowerCase(), await referenceFacts(item.file));

  const port = await reservePort();
  const child = await start(port);
  // ①② 拿到的东西会被后面的臂读（`arm()` 把每臂包成了闭包 ⇒ 这类跨臂状态必须在外层声明）：
  // `cold`（③a/③b/③c 对账）、`afterHot`（③a 拿它比新旧 worker 的 pid）。
  let cold = null;
  let afterHot = null;
  try {
    await waitHost(port);

    await arm('①② 冷扫描 + 行等价 + 热路径上界', async () => {
      // ── ①② 冷扫描 + 行等价 + 热路径上界 ─────────────────────────────────────
      cold = await get(port, '/tree');
      assert.equal(cold.statusCode, 200, `cold /tree must be 200: ${JSON.stringify(cold.value)?.slice(0, 300)}`);
      assert.equal(cold.value.sessions.length, files.length, 'every session must be in the tree');
      assert.ok(cold.ms < COLD_MAX_MS, `cold /tree must stay far below the host's 5 s cliff (limit ${COLD_MAX_MS} ms): ${cold.ms} ms`);
      const coldIndex = treeIndexFacts(await get(port, '/host')).treeIndex;

      // ⚠️ `status` **不在此列**：宿主 `decorateUnreadTree` 会用自己那份 seen/settled 账**重新算**
      // status/unread（`server/base.mjs`），所以树上的 status 是宿主的事实、不是文件投影的事实。
      // 文件投影出来的 status 在最后用 `/sessions/{id}` 抽样验证。
      let mismatches = 0;
      const examples = [];
      for (const row of cold.value.sessions) {
        const want = reference.get(row.id);
        assert.ok(want, `unknown session id in tree: ${row.id}`);
        const got = { id: row.id, name: row.name, archived: row.archived, cwd: row.cwd, parentSessionPath: row.parentSessionPath, createdAt: row.createdAt, modifiedAt: row.modifiedAt };
        const expected = { id: want.id, name: want.name, archived: want.archived, cwd: want.cwd, parentSessionPath: want.parentSessionPath, createdAt: want.createdAt, modifiedAt: want.modifiedAt };
        if (JSON.stringify(got) !== JSON.stringify(expected)) {
          mismatches += 1;
          if (examples.length < 3) examples.push({ got, want: expected });
        }
      }
      assert.equal(mismatches, 0, `tree rows must match the per-line JSON.parse reference: ${JSON.stringify(examples)}`);
      assert.equal(cold.value.sessions.length, reference.size);
      print('cold scan + row equivalence', {
        sessions: files.length,
        totalBytes,
        coldMs: cold.ms,
        workerScanMs: coldIndex?.last?.ms ?? null,
        coldLimitMs: COLD_MAX_MS,
        mismatches,
        archivedRows: cold.value.sessions.filter((row) => row.archived).length,
        namesPresent: cold.value.sessions.filter((row) => row.name !== null).length,
        hostStatusNote: 'the tree status comes from the host unread bookkeeping (decorateUnreadTree), so a fresh sandbox shows idle; the file-derived status is asserted through /sessions/{id}',
      });

        const hot = [];
      for (let index = 0; index < 4; index += 1) {
        const response = await get(port, '/tree');
        assert.equal(response.statusCode, 200);
        hot.push(response.ms);
        const same = sameTree(response.value, cold.value);
        assert.ok(same.ok, `a cached tree must carry exactly the same rows as the cold one: ${same.reason}`);
      }
      const hotMax = Math.max(...hot);
      assert.ok(hotMax < HOT_MAX_MS, `hot /tree must be back to the hundred-millisecond class (limit ${HOT_MAX_MS} ms): ${hotMax} ms`);
      afterHot = treeIndexFacts(await get(port, '/host'));
      assert.equal(afterHot.treeIndex.items, files.length, 'every session must be indexed');
      print('hot path', {
        hotMs: hot,
        hotMaxMs: hotMax,
        hotLimitMs: HOT_MAX_MS,
        coldMs: cold.ms,
        speedup: round(cold.ms / hotMax),
        workerStatPassMs: afterHot.treeIndex?.last?.ms ?? null,
        workerPid: afterHot.workerPid,
        workerRssBytes: afterHot.rssBytes,
      });
    });

    await arm('③a 并发 /tree 共享同一次扫描', async () => {
      // ── ③a 并发 /tree 共享同一次扫描（线上「每个新 /tree 再叠一层」的乘数）────────
      const reloaded = await post(port, '/reload-code', {});
      assert.equal(reloaded.statusCode, 200, `reload-code must succeed: ${JSON.stringify(reloaded.value)?.slice(0, 200)}`);
      const newWorkerPid = reloaded.value.workerPid ?? (await waitHost(port)).currentWorkerPid;
      assert.notEqual(newWorkerPid, afterHot.workerPid, 'a reload must give a new worker process (fresh, cold tree index)');
      await waitHost(port);
      // 先等旧代退干净（见 waitDrainingGone 的注释）：这一臂要的是「冷 worker + 6 个并发 /tree 共享一次扫描」，
      // 不需要和「宿主给正在退出的 draining 代发 IPC」那个独立缺陷的窗口重叠。
      await waitDrainingGone(port);
      let indexFacts = treeIndexFacts(await get(port, '/host'));
      assert.equal(indexFacts.treeIndex.items, 0, 'the new worker must start with an empty tree index');

      const concurrent = await Promise.all(Array.from({ length: 6 }, () => get(port, '/tree')));
      assert.ok(concurrent.every((response) => response.statusCode === 200), 'all concurrent /tree requests must answer');
      for (const response of concurrent) {
        const same = sameTree(response.value, cold.value);
        assert.ok(same.ok, `a coalesced tree must be the same tree: ${same.reason}`);
      }
      indexFacts = treeIndexFacts(await get(port, '/host'));
      assert.ok(indexFacts.treeIndex.runs <= 2, `6 concurrent /tree requests must share one scan, not run six: ${JSON.stringify(indexFacts.treeIndex)}`);
      assert.equal(indexFacts.treeIndex.filesProjected, files.length, 'the shared scan must have projected every file exactly once');
      print('concurrent /tree shares one scan', {
        requests: concurrent.length,
        maxMs: Math.max(...concurrent.map((response) => response.ms)),
        scanRuns: indexFacts.treeIndex.runs,
        filesProjected: indexFacts.treeIndex.filesProjected,
        scanMs: indexFacts.treeIndex.last?.ms ?? null,
        note: 'runs counts index scans, not requests: N duplicate/abandoned requests must not add N scans',
      });
    });

    await arm('③b 到点回部分视图 / 后台扫完 / 断连留断点', async () => {
      // ── ③b 到点回部分视图 ⇒ 后台扫完 ⇒ 第二次快；中途断连不把索引搞坏 ──────────────
      // 这一臂**不再靠计时前提**（旧断言 `filesProjected < files.length` 说「被中止的扫描必须没扫完」：
      // 快机器上 304 个小文件 4 ms 就扫完了，而客户端是 60 ms 后才断开 ⇒ 前提不成立 ⇒ 必红；而且它断言
      // 的正是**新设计已经不这么做**的那件事：到点/中止之后后台会把这一趟跑完）。现在按「可观察事实」钉：
      //   · 死线 = 主夹具**实测**冷扫描的 0.35 倍（不是猜的数）⇒ 冷调用必然到点，回 200 + 部分视图；
      //   · 这条宿主扫的是**它自己的** sessions 目录：同一批会话**复制一份** + 一个 10 MB 级大文件重复
      //     接出来的 ~240 MB「一次投影不完」的文件。为什么非要它：中途断连那一臂要在扫描**还在中途**
      //     的时候断，而 ~70 ms 的整趟扫描里连「起连接 + 掐断」都可能来不及（实测就撞上了这个 race，
      //     `aborts` 一直是 0）。加上那个大文件的投影（~300 ms）之后，剩余工作量比掐断链路宽一个量级。
      //     用**自己的目录**而不是往主夹具里塞文件：主夹具后面几条臂（④⑦）还在拿它和 `cold` 对账。
      //   · 到点之后扫描仍在飞（可观察：`inFlight` + `checkpointBytes`）⇒ 断连那一臂有真实前提；
      //   · 被中止的在途字节留在**断点**里 ⇒ 下一次从断点接着扫（`resumes` 涨），后台扫完即完整且快。
      const partialBudgetMs = Math.max(5, Math.round(cold.ms * 0.35));
      const abortSessions = path.join(sandbox, 'sessions-abort');
      await mkdir(abortSessions, { recursive: true });
      const abortFiles = [];
      for (const item of files) {
        const target = path.join(abortSessions, path.basename(item.file));
        await copyFile(item.file, target);
        abortFiles.push({ id: item.id, file: target });
      }
      // 大文件：把主夹具那份 10 MB 会话的正文重复接起来（只换头那一行的 id）
      const sourceBig = files[SMALL].file;
      const sourceBytes = await readFile(sourceBig);
      const firstNewline = sourceBytes.indexOf(10);
      assert.ok(firstNewline > 0, 'the 10 MB fixture session has no header line to copy from');
      const bigTail = sourceBytes.subarray(firstNewline + 1);
      const hugeId = randomUUID();
      const hugeFile = path.join(abortSessions, `huge_${hugeId}.jsonl`);
      await writeFile(hugeFile, `${JSON.stringify({ type: 'session', version: 3, id: hugeId, timestamp: '2026-09-18T02:00:00.000Z', cwd: workspace })}\n`);
      for (let repeat = 0; repeat < 24; repeat += 1) await appendFile(hugeFile, bigTail);
      abortFiles.push({ id: hugeId, file: hugeFile });
      const abortReference = new Map(reference);
      abortReference.set(hugeId.toLowerCase(), await referenceFacts(hugeFile));
      const hugeBytes = (await stat(hugeFile)).size;
      const abortHome = path.join(sandbox, 'home-abort');
      await mkdir(abortHome, { recursive: true });
      await writeFile(path.join(abortHome, 'models.json'), '{"providers":{}}\n');
      await writeFile(path.join(abortHome, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
      const abortPort = await reservePort();
      const abortHost = await start(abortPort, {
        homeDir: abortHome,
        logFile: abortLogPath,
        sessionsRoot: abortSessions,
        env: { SOPHO_TREE_INDEX_BUDGET_MS: String(partialBudgetMs) },
      });
      try {
        await waitHost(abortPort);

        // (d) 先做「客户端中途断连」：让 **SSE 自己起**那一趟扫描（这条宿主的目录里那个大文件投影要
        //     ~250 ms），在它中途把客户端掐掉。为什么必须让 SSE 自己起扫描而不是「join 一份已经在飞的」：
        //     `clientGoneSignal` 的 close 监听是在 SSE 处理**开头**挂的，掐断必须落在它之后 ——
        //     实测掐在连上后 0.3 ms 时那个监听还没挂上，close 事件就没人接（扫描照跑完、aborts 不涨）。
        //     SSE 自己起扫描时，「等待者已经登记」有可观察证据：扫描在飞 + 已经真的投影过一段。
        const sse = await openSse(abortPort, '/tree/events');
        const inFlight = await waitScanProgress(abortPort, { minBytes: ABORT_PROGRESS_BYTES });
        print('abandoned mid-scan request: the SSE started the cold scan', {
          budgetMs: partialBudgetMs,
          mainColdMs: cold.ms,
          sessions: abortFiles.length,
          hugeFileBytes: hugeBytes,
          treeIndex: inFlight,
          note: '断连要落在扫描中途（可观察前提：inFlight + checkpointBytes > 0），不是「等 60 ms」那种计时前提',
        });
        sse.req.destroy();
        const abortedFacts = await waitIndexFacts(abortPort, (facts) => facts.inFlight === false && facts.aborts >= 1, { what: 'the abandoned scan to stop' });
        assert.ok(abortedFacts.checkpoints >= 1 && Number(abortedFacts.checkpointBytes) > 0,
          `中途断连必须把在途进度留成断点（否则那些字节下一轮就白读了）：${JSON.stringify(abortedFacts)}`);
        const projectedAtAbort = abortedFacts.filesProjected;
        await sleep(500);
        const settledFacts = treeIndexFacts(await get(abortPort, '/host')).treeIndex;
        assert.equal(settledFacts.filesProjected, projectedAtAbort, '客户端都走之后不许再继续投影（被放弃的扫描必须停）');
        print('abandoned mid-scan request stops the scan but keeps the checkpoint', {
          aborts: settledFacts.aborts,
          checkpoints: settledFacts.checkpoints,
          checkpointBytes: settledFacts.checkpointBytes,
          filesProjected: settledFacts.filesProjected,
          abortedScanMs: settledFacts.last?.ms ?? null,
          note: '旧实现这里什么都不留（那几个文件下一轮从 0 重扫）；现在留下的就是断点',
        });

        // (a) 接着那一次 /tree：死线很小 ⇒ **200 + 部分视图**（旧行为在这里会等满宿主那条硬超时 ⇒ 500）
        const resumesBefore = Number(settledFacts.resumes);
        const afterAbort = await get(abortPort, '/tree');
        assert.equal(afterAbort.statusCode, 200, `断点续扫那一次也必须是 200：${JSON.stringify(afterAbort.value)?.slice(0, 200)}`);
        const partialScan = afterAbort.value?.indexScan ?? {};
        assert.equal(afterAbort.value?.partial, true, '到点回的那一份必须如实标成 partial（不许拿它冒充完整树）');
        assert.ok(Number(partialScan.pending) > 0, `部分视图必须真的没扫完（否则这条臂是空的）：${JSON.stringify(partialScan)}`);
        // 行数：`pending > 0` ⇒ 索引里的行必然少于全部会话 ⇒ 这一份不可能冒充完整树。
        // 而且**不许是 0 行**：拼行有独立于「等扫描」的保留配额（`indexScan.rowBudgetMs`）——
        // 否则「宁可不全」就退化成「什么都不给」（2026-09-21 实测到过 0 行；修复与证据见
        // /tmp/tree-pep-and-partial-report.md 的 §B）。
        assert.ok(afterAbort.value.sessions.length > 0,
          `部分视图不许是 0 行（拼行保留配额 rowBudgetMs=${partialScan.rowBudgetMs}）：${JSON.stringify(partialScan)}`);
        assert.ok(afterAbort.value.sessions.length < abortFiles.length,
          `部分视图的行数必须少于全部会话：${afterAbort.value.sessions.length}/${abortFiles.length}`);
        assert.equal(Number(partialScan.rows), afterAbort.value.sessions.length, 'indexScan.rows 必须与真的发了多少行一致（账目不许编）');
        assert.ok(Number(partialScan.hidden) + afterAbort.value.sessions.length <= Number(partialScan.indexed),
          `hidden + rows 不许超过已索引行数：${JSON.stringify(partialScan)}`);
        // 行**都正确**：逐字段等于测试自己逐行 JSON.parse 算出来的参照值（给不全，但不给错）。
        // （上面那条 0 行的缺陷会让这一句在「0 行」那一轮里空转 —— 所以完整视图那边还会再验一次。）
        assert.deepEqual(rowMismatches(afterAbort.value.sessions, abortReference), [],
          `部分视图里的每一行都必须逐字段等于参照值：${JSON.stringify(rowMismatches(afterAbort.value.sessions, abortReference).slice(0, 2))}`);
        assert.ok(afterAbort.ms < Math.max(500, partialBudgetMs * 4), `到点回也必须很快（死线 ${partialBudgetMs} ms）：${afterAbort.ms} ms`);
        // (b1) 账目：到点在 `partials` 上留痕；两次扫描各一次 run（SSE 起的那次 + 这次）
        const partialFacts = await waitIndexFacts(abortPort, (facts) => Number(facts.partials) >= 1, { what: 'the partial counter to move' });
        assert.equal(partialFacts.runs, 2, `本该是两次扫描（断连那次 + 到点这次）：${JSON.stringify(partialFacts)}`);
        const resumedFacts = await waitIndexFacts(abortPort, (facts) => Number(facts.resumes) > resumesBefore, { what: 'the checkpoint to be resumed' });

        // (c) 后台扫完之后：第二次调用**快**且**完整**，热路径不再投影任何文件，形状回到与基线一字不差
        const complete = await waitIndexFacts(abortPort, (facts) => facts.checkpoints === 0 && facts.rows === abortFiles.length, { what: 'the background scan to complete' });
        const projectedBeforeFull = complete.filesProjected;
        const full = await get(abortPort, '/tree');
        assert.equal(full.statusCode, 200);
        assert.equal(full.value?.partial, undefined, '索引建完之后再调用不该再标 partial（完整树的形状与基线一字不差）');
        assert.equal(full.value.sessions.length, abortFiles.length, '建完之后必须是完整的树（一条不少、也不多）');
        assert.deepEqual(rowMismatches(full.value.sessions, abortReference), [],
          `建完之后每一行仍必须逐字段等于参照值：${JSON.stringify(rowMismatches(full.value.sessions, abortReference).slice(0, 2))}`);
        assert.ok(full.ms < cold.ms && full.ms < HOT_MAX_MS, `第二次必须明显更快（死线 ${partialBudgetMs} ms、主夹具冷扫描 ${cold.ms} ms）：${full.ms} ms`);
        const afterFull = treeIndexFacts(await get(abortPort, '/host')).treeIndex;
        assert.equal(afterFull.filesProjected, projectedBeforeFull, '热路径不许再投影任何文件（不是「又扫了一遍刚好赶上了」）');
        // 一次被中止的扫描最多浪费「当时正在投影的那几个文件」（并发度 K 路，都没提交 → 下一轮重扫）。
        const wastedBound = abortFiles.length + Number(afterFull.aborts) * (afterFull.concurrency ?? 8);
        assert.ok(afterFull.filesProjected <= wastedBound, `projections must be bounded by files + aborted attempts × concurrency: ${afterFull.filesProjected} > ${wastedBound}`);
        print('partial view at the index deadline', {
          budgetMs: partialBudgetMs,
          mainColdMs: cold.ms,
          partialMs: afterAbort.ms,
          partialRows: afterAbort.value.sessions.length,
          sessions: abortFiles.length,
          hugeFileBytes: hugeBytes,
          indexScan: afterAbort.value.indexScan,
          note: '死线 = 0.35 × 主夹具实测冷扫描：/tree 回 200+部分视图（这一份是**断点续扫**之后的那次）；行数必须 > 0（拼行有独立保留配额）',
        });
        print('partial → background complete → fast full tree', {
          partialMs: afterAbort.ms,
          partialRows: afterAbort.value.sessions.length,
          afterAbortMs: afterAbort.ms,
          fullMs: full.ms,
          sessions: full.value.sessions.length,
          totalSessions: abortFiles.length,
          budgetMs: partialBudgetMs,
          mainColdMs: cold.ms,
          treeIndex: afterFull,
          note: '三次调用（到点回部分视图 / 断点续扫 / 后台建完后的热路径）的 ms 与账目都在这里；resumes、partials 见 treeIndex',
        });
      } finally {
        await stop(abortHost);
      }

      const log = await readFile(logPath, 'utf8');
      const abortLog = await readFile(abortLogPath, 'utf8').catch(() => '');
      const timeouts = (log.match(/TimeoutError/g) ?? []).length + (abortLog.match(/TimeoutError/g) ?? []).length;
      assert.equal(timeouts, 0, `no host-side worker timeout may happen at this scale: ${timeouts} in base.log/base-abort.log`);
      for (const [label, text] of [['base.log', log], ['base-abort.log', abortLog]]) {
        assert.equal(/worker_request_failed[^\n]*tree_scan_aborted/.test(text), false, `an aborted scan must not be logged as a request failure (${label})`);
      }
      print('base log', { workerTimeouts: timeouts, bytes: log.length, abortLogBytes: abortLog.length });
    });

    await arm('③c 热 /tree 的 CPU/RSS 曲线', async () => {
      // ── ③c 连续 N=10 次 /tree 之后 worker 的 CPU/RSS 曲线 ────────────────────
      // 这条直接对应线上的病：打两次 /tree 后 worker 6 s 墙钟烧 22 s CPU、RSS 3.7 GiB。
      // 判据是**事实曲线**：每次热 /tree 的 CPU 增量必须有界，且不许有「越打越贵」的趋势；
      // RSS 在窗口内不许持续长（窗口内极差有界）。
      // ⚠️ CPU 只能从 /host 拿到，而 /host 自己也要花 CPU：先量一段**只有 /host 的对照**，
      // 从每个样本里减掉它，剩下的才是 /tree 自己的成本（不减就把 /host 的账算到树头上）。
      const factsAt = async () => {
        const response = await get(port, '/host');
        const worker = (response.value?.workers ?? []).find((detail) => detail.state === 'current') ?? null;
        return { cpuMs: worker?.memoryPolicy?.cpu?.totalMs ?? null, rssBytes: worker?.rssBytes ?? null };
      };
      const control = [];
      {
        let previous = await factsAt();
        for (let index = 0; index < 3; index += 1) {
          await get(port, '/host');
          const now = await factsAt();
          if (now.cpuMs !== null && previous.cpuMs !== null) control.push(now.cpuMs - previous.cpuMs);
          previous = now;
        }
      }
      const controlMs = control.length > 0 ? control.reduce((sum, value) => sum + value, 0) / control.length : 0;
      const curve = [];
      let previous = await factsAt();
      for (let index = 1; index <= 10; index += 1) {
        const response = await get(port, '/tree');
        assert.equal(response.statusCode, 200);
        const now = await factsAt();
        curve.push({
          n: index,
          treeMs: response.ms,
          cpuDeltaMs: now.cpuMs === null || previous.cpuMs === null ? null : round(Math.max(0, now.cpuMs - previous.cpuMs - controlMs)),
          cpuRawDeltaMs: now.cpuMs === null || previous.cpuMs === null ? null : round(now.cpuMs - previous.cpuMs),
          rssMiB: now.rssBytes === null ? null : round(now.rssBytes / 1048576),
        });
        previous = now;
      }
      const deltas = curve.map((point) => point.cpuDeltaMs).filter((value) => typeof value === 'number');
      assert.equal(deltas.length, 10, 'the worker must report cumulative cpu time so this curve can be read honestly');
      const firstFive = deltas.slice(0, 5).reduce((sum, value) => sum + value, 0) / 5;
      const lastFive = deltas.slice(5).reduce((sum, value) => sum + value, 0) / 5;
      const rssValues = curve.map((point) => point.rssMiB).filter((value) => typeof value === 'number');
      // 绝对上界很宽（对照已减掉，噪声仍然不小）：线上那次是「2 个请求 ~11 s CPU/个」，这条要能抓住那种数量级。
      assert.ok(Math.max(...deltas) < 1500, `one hot /tree must not burn unbounded CPU: ${JSON.stringify(curve)}`);
      assert.ok(lastFive <= Math.max(firstFive * 2, firstFive + 100), `hot /tree CPU must not grow with repetition: first5=${round(firstFive)} last5=${round(lastFive)}`);
      if (rssValues.length === 10) assert.ok(Math.max(...rssValues) - Math.min(...rssValues) < 200, `worker RSS must stay flat across repeated /tree: ${JSON.stringify(rssValues)}`);
      print('repeated /tree CPU/RSS curve', {
        curve,
        hostControlMs: round(controlMs),
        firstFiveCpuMs: round(firstFive),
        lastFiveCpuMs: round(lastFive),
        totalCpuMs: round(deltas.reduce((sum, value) => sum + value, 0)),
        rssSpreadMiB: rssValues.length === 10 ? round(Math.max(...rssValues) - Math.min(...rssValues)) : null,
        note: 'cpuDeltaMs = worker cumulative CPU between successive /tree requests MINUS a measured /host-only control; rss comes from the same /host sample',
      });
    });

    await arm('④ 追加写只重扫那一个文件', async () => {
      // ── ④ 追加写只重扫**那一个**文件（索引是可增量的）──────────────────────
      const target = [...reference.values()].find((row) => row.status === 'idle' && row.name !== null);
      assert.ok(target, 'fixture must contain a session ending in a user message with a name');
      const targetFile = files.find((item) => item.id.toLowerCase() === target.id).file;
      const projectionsBeforeAppend = treeIndexFacts(await get(port, '/host')).treeIndex.filesProjected;
      const appendedAt = '2026-09-18T02:00:00.000Z';
      await appendFile(targetFile, `${[
        entry(randomUUID(), null, appendedAt, { role: 'assistant', content: [{ type: 'text', text: 'appended' }] }),
        JSON.stringify({ type: 'session_info', id: randomUUID(), parentId: null, timestamp: appendedAt, name: '改名了' }),
        JSON.stringify({ type: 'custom', id: randomUUID(), parentId: null, timestamp: appendedAt, customType: 'sopho.archive', data: { archived: true } }),
      ].join('\n')}\n`);
      const afterAppend = await get(port, '/tree');
      assert.equal(afterAppend.value.sessions.length, files.length, 'an append must not change the session count');
      const appendedRow = afterAppend.value.sessions.find((row) => row.id === target.id);
      assert.equal(appendedRow.name, '改名了', 'the last session_info wins');
      assert.equal(appendedRow.archived, true, 'the last sopho.archive wins');
      assert.equal(appendedRow.modifiedAt, appendedAt, 'modifiedAt must come from the appended entry');
      const appendedWant = await referenceFacts(targetFile);
      assert.equal(appendedRow.name, appendedWant.name);
      assert.equal(appendedRow.archived, appendedWant.archived);
      assert.equal(appendedRow.modifiedAt, appendedWant.modifiedAt);
      const afterAppendFacts = treeIndexFacts(await get(port, '/host')).treeIndex;
      assert.equal(afterAppendFacts.filesProjected, projectionsBeforeAppend + 1, 'an append must re-project exactly one file (incremental), not the whole tree');
      print('append re-projects exactly one file', {
        targetId: target.id.slice(0, 8),
        projectionsBefore: projectionsBeforeAppend,
        projectionsAfter: afterAppendFacts.filesProjected,
        row: { name: appendedRow.name, archived: appendedRow.archived, modifiedAt: appendedRow.modifiedAt },
        note: 'this is the incremental arm: a growing session file must only re-read the appended bytes',
      });
    });

    await arm('⑤ 看详情不建 runtime（诚实字段）', async () => {
      // ── ⑤ 看详情不建 runtime（+ 诚实字段）────────────────────────────────────
      const acquireCount = async () => (await get(port, '/host')).value?.pool?.counters?.acquire ?? null;
      const coldTarget = files[7].id.toLowerCase();
      const acquireBefore = await acquireCount();
      const coldDetail = await get(port, `/sessions/${coldTarget}`);
      const acquireAfter = await acquireCount();
      assert.equal(coldDetail.statusCode, 200, JSON.stringify(coldDetail.value)?.slice(0, 200));
      assert.equal(acquireAfter, acquireBefore, 'GET /sessions/{id} must not acquire a runtime (that is the whole point of this arm)');
      assert.equal(coldDetail.value.detailSource, 'file');
      assert.equal(coldDetail.value.runtimeState, 'cold');
      assert.equal(coldDetail.value.context, null);
      assert.equal(coldDetail.value.observability, null);
      assert.equal(coldDetail.value.durable, null);
      assert.equal(coldDetail.value.pluginStale, null);
      assert.equal(coldDetail.value.logicStale, null);
      assert.equal(coldDetail.value.runtime.isStreaming, false);
      assert.equal(coldDetail.value.runtime.model, null);
      for (const field of ['context', 'observability', 'durable', 'pluginStale', 'logicStale', 'runtime.model']) {
        assert.ok(coldDetail.value.unavailableFields.includes(field), `${field} must be declared unavailable instead of invented`);
      }
      // 摘要那一半仍然是真事实：与测试自己逐行 JSON.parse 的参照值一致。
      const coldWant = reference.get(coldTarget);
      assert.equal(coldDetail.value.name, coldWant.name);
      assert.equal(coldDetail.value.status, coldWant.status);
      assert.equal(coldDetail.value.archived, coldWant.archived);
      assert.equal(coldDetail.value.modifiedAt, coldWant.modifiedAt);
      assert.equal(coldDetail.value.createdAt, coldWant.createdAt);
      print('cold detail: file-only, honest, no runtime', {
        sessionId: coldTarget.slice(0, 8),
        ms: coldDetail.ms,
        acquireBefore,
        acquireAfter,
        detailSource: coldDetail.value.detailSource,
        runtimeState: coldDetail.value.runtimeState,
        honestNulls: { context: coldDetail.value.context, observability: coldDetail.value.observability, durable: coldDetail.value.durable, pluginStale: coldDetail.value.pluginStale },
        unavailableFields: coldDetail.value.unavailableFields,
        row: { name: coldDetail.value.name, status: coldDetail.value.status, archived: coldDetail.value.archived, modifiedAt: coldDetail.value.modifiedAt },
      });
    });

    await arm('pluginStale/detail：旧代退干净后如实说冷', async () => {
      // 「旧代退干净之后，同一个会话的详情必须**如实**说它现在是冷的」（2026-09-21 按产品文档口径重写）。
      // 旧版这条臂的前提是「一个闲置 SSE 订阅者能钉住旧代」—— **那条前提是错的**，代码里写得很清楚：
      //   `server/base.mjs` 的 `drainWorker`：「an idle session held open by an SSE subscriber does not count」
      //   ⇒ reload 之后旧代几毫秒内自己就退干净。旧断言（`detailSource === 'runtime'` + `pluginStale === true`）
      //   于是变成**计时竞态**：poll 到 draining 之后再查详情，旧代常常已经没了 ⇒ 详情从文件回答 ⇒ 必红。
      // 所以这里改钉**确定成立**的那条，而且它本身也是个真回归风险：**曾经热过**的会话，在它那一代退掉之后，
      //   详情必须说「现在没有 runtime」—— 从文件回答 + `pluginStale/logicStale` 如实 null（不许把「没有主语」
      //   说成 false，也不许编），并且明列在 `unavailableFields` 里。
      // ⚠️ `pluginStale === true` 那一侧（热在一个**还在 drain** 的旧代里）不在这里验：它需要**真正在飞的回合**
      // 才能把旧代留住（闲置 SSE 留不住），那是 `test/runtime-isolation.mjs` 用假 provider 钉住的事
      // （`assert.equal(staleDetail.value.pluginStale, true)`）；冷侧的 null 在 `test/s1a2-api.mjs` 也钉着。
      {
        const staleTarget = files[20].id.toLowerCase();
        const pin = await openSse(port, `/sessions/${staleTarget}/events`);
        try {
          let pinned = null;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const hot = ((await get(port, '/host')).value?.workers ?? []).reduce((sum, worker) => sum + (worker.hot ?? 0), 0);
            if (hot >= 1) { pinned = hot; break; }
            await sleep(100);
          }
          assert.ok(pinned, 'the SSE must actually make the session hot in the current generation');
          const reload3 = await post(port, '/reload-code', {});
          assert.equal(reload3.statusCode, 200);
          // 旧代**自己**退干净：闲置 SSE 订阅者不算 pin（这就是产品的口径），不再指望它留住旧代。
          await waitDrainingGone(port);
          const hostAfter = (await get(port, '/host')).value;
          assert.equal((hostAfter.drainingGenerations ?? []).length, 0, '旧代必须已经退干净（它不该被一个闲置 SSE 留住）');
          assert.equal(hostAfter.currentWorkerPid, reload3.value.workerPid ?? hostAfter.currentWorkerPid, '当前代必须是 reload 之后那一代');
          const stale = await get(port, `/sessions/${staleTarget}`);
          assert.equal(stale.statusCode, 200);
          assert.equal(stale.value.detailSource, 'file', `旧代没了之后详情必须从文件回答：${JSON.stringify(stale.value)?.slice(0, 200)}`);
          assert.equal(stale.value.runtimeState, 'cold');
          assert.equal(stale.value.runtime?.isStreaming, false);
          // 没有 runtime ⇒ 这两项没有主语：如实 null + 明列（不许编 false）。
          assert.equal(stale.value.pluginStale, null, `旧代没了之后 pluginStale 必须如实 null，不许编：${JSON.stringify(stale.value)}`);
          assert.equal(stale.value.logicStale, null);
          assert.equal(stale.value.generationId, null);
          for (const field of ['pluginStale', 'logicStale']) {
            assert.ok((stale.value.unavailableFields ?? []).includes(field), `${field} 必须在 unavailableFields 里明列`);
          }
          // 同一个实例里另一条会话（从没热过）也是同一口径 —— 两个值一致说明它是「没有主语」而不是随口翻。
          const other = await get(port, `/sessions/${files[30].id.toLowerCase()}`);
          assert.equal(other.value.pluginStale, null);
          assert.equal(other.value.detailSource, 'file');
          print('a session that was hot reports cold once its generation is gone', {
            pinnedHotSessions: pinned,
            staleSession: staleTarget.slice(0, 8),
            detailSource: stale.value.detailSource,
            runtimeState: stale.value.runtimeState,
            pluginStale: stale.value.pluginStale,
            logicStale: stale.value.logicStale,
            unavailableFields: stale.value.unavailableFields,
            coldSessionPluginStale: other.value.pluginStale,
            note: '闲置 SSE 不钉旧代（产品文档口径）⇒ 旧代退干净后详情如实说「现在没有 runtime」；pluginStale===true 那一侧在 test/runtime-isolation.mjs 用真在飞回合钉着',
          });
        } finally {
          pin.req.destroy();
          await waitDrainingGone(port).catch(() => {});
        }
      }
    });

    await arm('⑥ /messages 内容口径 + 缓存正确性', async () => {
      // ── ⑥ /messages 的内容口径不变（逐字段 / 逐 part 比对）+ 缓存正确性 ────────
      const rich = await get(port, `/sessions/${RICH.id}/messages`);
      assert.equal(rich.statusCode, 200);
      const richValue = rich.value;
      assert.equal(richValue.messages.length, 4, 'the wire must carry every message entry (user / assistant / toolResult / assistant)');
      assert.deepEqual(richValue.messages.map((message) => message.role), ['user', 'assistant', 'toolResult', 'assistant']);
      assert.deepEqual(richValue.messages[0].parts, undefined, 'a user message has no parts');
      // ⚠️ 这里**只钉本单的不变量**：part 顺序 = 到达顺序、tool part 带上它的 result、字段值对。
      // 不整对象深比对 —— 别的 landing 往后加字段（`details`/`kind`/`images`/`branchSummaries` 都是已发生了的）
      // 不该把我们的门弄红。用 `pick` 只取关心的键。
      const parts = richValue.messages[1].parts;
      assert.deepEqual(parts.map((part) => part.type), ['thinking', 'text', 'tool'], 'part order must be arrival order (thinking → text → tool)');
      assert.deepEqual(pick(parts[0], ['type', 'text']), { type: 'thinking', text: 'think-1' });
      assert.deepEqual(pick(parts[1], ['type', 'text']), { type: 'text', text: 'answer-1' });
      assert.deepEqual(pick(parts[2], ['type', 'toolCallId', 'name', 'args', 'status', 'result', 'isError']), {
        type: 'tool', toolCallId: 'call-1', name: 'read', args: { path: 'x.txt' }, status: 'done-success', result: 'result-1', isError: false,
      }, 'the tool part must carry its own result and its finished status');
      assert.deepEqual(pick(richValue.messages[3].parts[0], ['type', 'text']), { type: 'text', text: 'answer-2' });
      assert.equal(richValue.messages[3].parts.length, 1);
      assert.equal(richValue.messages[2].role, 'toolResult');
      assert.equal(richValue.messages[2].text, 'result-1');
      assert.equal(richValue.extras.length, 1, 'extension messages stay out of `messages`');
      assert.equal(richValue.extras[0].customType, 'sopho.test-ext');
      assert.equal(richValue.extras[0].text, 'ext-1');
      assert.equal(richValue.messages.some((message) => message.text === 'ext-1'), false, 'an extension message must not leak into messages');
      assert.equal(richValue.compaction.atIndex, 4, 'the compaction boundary points past the messages it keeps out');
      assert.equal(richValue.compaction.summary, 'compact-1');
      assert.equal(richValue.compaction.firstKeptEntryId, RICH.entries.user);
      // 缓存不许改变字节：命中读与首读必须一字不差（响应形状也不许变）。
      const richAgain = await get(port, `/sessions/${RICH.id}/messages`);
      assert.equal(richAgain.bytes, rich.bytes, 'a cache hit must return exactly the same bytes');
      assert.equal(richAgain.value.messages.length, richValue.messages.length);
      // 文件变了 ⇒ 缓存必须失效（不是拿旧 body 充数）。
      const richFile = files.find((item) => item.id === RICH.id).file;
      await appendFile(richFile, `${JSON.stringify({ type: 'message', id: randomUUID(), parentId: RICH.entries.compaction, timestamp: '2026-09-18T04:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'answer-3' }], stopReason: 'stop' } })}\n`);
      const richAfterAppend = await get(port, `/sessions/${RICH.id}/messages`);
      assert.equal(richAfterAppend.value.messages.length, 5, 'an appended message must invalidate the cached body');
      assert.equal(richAfterAppend.value.messages.at(-1).text, 'answer-3');
      print('messages content contract', {
        roles: richValue.messages.map((message) => message.role),
        assistantParts: richValue.messages[1].parts,
        extras: richValue.extras,
        compaction: richValue.compaction,
        firstReadBytes: rich.bytes,
        cacheHitBytes: richAgain.bytes,
        afterAppendMessages: richAfterAppend.value.messages.length,
        note: 'expected values are written by the test itself (the fixture is ours): the same parts, order, statuses and extras as before, only faster',
      });

      // 热读：runtime 已经在跑 —— 同一个版本连读两次不许重算/重序列化。
      // 判据是**日志里的 parse/hit 计数**（不是墙钟）：wire 只构了一次，第二次是回放。
      const hotTarget = files[SMALL].id.toLowerCase(); // 一条 10 MB 的大会话
      const hotOpened = await get(port, `/sessions/${hotTarget}/commands`);
      assert.equal(hotOpened.statusCode, 200, 'the session must be openable (this builds a runtime on purpose)');
      const hotFirst = await get(port, `/sessions/${hotTarget}/messages`, { timeoutMs: 300000 });
      const hotSecond = await get(port, `/sessions/${hotTarget}/messages`, { timeoutMs: 300000 });
      assert.equal(hotFirst.statusCode, 200);
      assert.equal(hotSecond.statusCode, 200);
      assert.equal(hotSecond.bytes, hotFirst.bytes, 'a cached hot read must return exactly the same bytes');
      const workerLog = await readFile(logPath, 'utf8');
      const hotParses = (workerLog.match(new RegExp(`\\[readonly-cache\\] parse ${hotTarget}`, 'g')) ?? []).length;
      const hotHits = (workerLog.match(new RegExp(`\\[readonly-cache\\] hit ${hotTarget}`, 'g')) ?? []).length;
      assert.equal(hotParses, 1, `an unchanged runtime must be serialised once, not per read: ${hotParses}`);
      assert.ok(hotHits >= 1, `the second hot read must be a cache hit: ${hotHits}`);
      print('hot read cache', {
        sessionId: hotTarget.slice(0, 8),
        bytes: hotFirst.bytes,
        firstMs: hotFirst.ms,
        secondMs: hotSecond.ms,
        parseLines: hotParses,
        hitLines: hotHits,
        note: 'parse/hit counts come from the worker log ([readonly-cache]); the wire is built once and replayed byte-for-byte',
      });
    });

    await arm('文件投影出来的 status 抽样验证', async () => {
      // ── 文件投影出来的 status 走详情那条路验证（放最后）───────────────────────
      // 现在的详情会**建 runtime**，而 pi 建 runtime 会往会话文件**追加**一条 `thinking_level_change`
      // ⇒ 读一次详情会让文件真的变（modifiedAt 漂移）。所以这一步必须放在所有签名比较之后。
      // 参照事实也**重算一遍**：上面那条追加臂刚刚改过其中一个文件。
      for (const item of files) reference.set(item.id.toLowerCase(), await referenceFacts(item.file));
      const statusSample = [
        ...[...reference.values()].filter((row) => row.status === 'unread').slice(0, 3),
        ...[...reference.values()].filter((row) => row.status === 'idle').slice(0, 3),
      ];
      assert.equal(statusSample.filter((row) => row.status === 'unread').length, 3, 'fixture must contain sessions ending in an assistant message');
      assert.equal(statusSample.filter((row) => row.status === 'idle').length, 3, 'fixture must contain sessions ending in a user message');
      const detailStatus = [];
      for (const row of statusSample) {
        const detail = await get(port, `/sessions/${row.id}`);
        assert.equal(detail.statusCode, 200, `detail must answer for ${row.id}`);
        assert.equal(detail.value.status, row.status, `detail status must be the file-derived one for ${row.id}`);
        assert.equal(detail.value.name, row.name);
        assert.equal(detail.value.archived, row.archived);
        detailStatus.push({ id: row.id.slice(0, 8), status: detail.value.status, expected: row.status, ms: detail.ms });
      }
      print('file-derived status via detail', { detailStatus, note: "expected status comes from the test's own per-line JSON.parse, not from the server" });

      // ── ⑦ 审计发现的几条反例，各钉一个回归臂 ─────────────────────────────────
    });
    await arm('⑦a 一个客户端走掉不许误伤健康等待者', async () => {
      // ⑦a 共享扫描的**等待者记账**：一个客户端走了不许把还在等的健康调用者一起干掉。
      // `GET /env` 内部就是 `listTree()`（不带 signal）—— 它是最容易被误伤的坏个。
      {
        const reloadEnv = await post(port, '/reload-code', {});
        assert.equal(reloadEnv.statusCode, 200);
        await waitHost(port);
        await waitDrainingGone(port);
        const sse = await openSse(port, '/tree/events');
        const envPromise = get(port, `/env?cwd=${encodeURIComponent(workspace)}`, { timeoutMs: 120000 });
        // 断连必须落在**扫描还在飞**的时候（可观察前提，不是「等 90 ms」）：先等它真的投影过一段。
        const thenInFlight = await waitScanProgress(port, { minBytes: ABORT_PROGRESS_BYTES });
        sse.req.destroy();
        const env = await envPromise;
        assert.equal(env.statusCode, 200, `a healthy /env must not be killed by another client leaving: ${JSON.stringify(env.value)?.slice(0, 300)}`);
        assert.equal(env.value.sessions.length, files.length, '/env must still report the whole tree');
        print('abort does not kill healthy waiters', {
          envStatus: env.statusCode,
          envSessions: env.value.sessions.length,
          envMs: env.ms,
          checkpointBytesWhenAborted: thenInFlight.checkpointBytes,
          note: 'an abandoned SSE client aborted the shared scan; GET /env joined it without a signal and must still get its 200（断连发生在扫描中途：checkpointBytes 已 > 0）',
        });
      }
    });

    await arm('⑦b 原地重写不许当成追加', async () => {
      // ⑦b 变长的**原地重写**不许当成追加（只读 [consumed, size) 会脏读）。
      // 真形态：pi 的 `_rewriteFile()`（版本迁移）整文件重写且往往变长。
      {
        const target = files[11].file;
        const before = await readFile(target, 'utf8');
        const rows = before.split('\n').filter((line) => line.trim() !== '');
        // 重写头（多一个字段 ⇒ 头变长、首 4 KiB 变）+ 把 session_info 改成新名字（比原来长）
        rows[0] = rows[0].replace('"cwd":', '"rewrittenBy":"migration","cwd":');
        const renamed = rows.map((line) => line.includes('"type":"session_info"') ? line.replace(/"name":"[^"]*"/, '"name":"重写后的名字（更长）"') : line);
        await writeFile(target, `${renamed.join('\n')}\n`);
        const response = await get(port, '/tree');
        const row = response.value.sessions.find((item) => item.id === files[11].id.toLowerCase());
        assert.ok(row, 'the rewritten session must still be in the tree');
        assert.equal(row.name, '重写后的名字（更长）', 'a growing in-place rewrite must be re-scanned, not treated as an append');
        const want = await referenceFacts(target);
        assert.equal(row.name, want.name);
        assert.equal(row.modifiedAt, want.modifiedAt);
        print('growing in-place rewrite is not mistaken for an append', { sessionId: files[11].id.slice(0, 8), name: row.name, modifiedAt: row.modifiedAt, sizeBefore: Buffer.byteLength(before), sizeAfter: (await stat(target)).size });
      }
    });

    await arm('⑦c 非紧凑 JSONL 回退到逐行 parse', async () => {
      // ⑦c 非紧凑 JSONL（手改 / 外部导入）⇒ 回退到逐行 JSON.parse，宁可慢也不静默算错。
      {
        const id = '01a0a002-0000-4000-8000-000000000001';
        const at = '2026-09-18T05:00:00.000Z';
        const spaced = [
          `{ "type": "session", "version": 3, "id": "${id}", "timestamp": "${at}", "cwd": ${JSON.stringify(workspace)} }`,
          `{ "type": "message", "id": "01a0a002-0000-4000-8000-000000000002", "parentId": null, "timestamp": "${at}", "message": { "role": "assistant", "content": [{ "type": "text", "text": "spaced" }] } }`,
          `{ "type": "session_info", "id": "01a0a002-0000-4000-8000-000000000003", "parentId": null, "timestamp": "${at}", "name": "非紧凑会话" }`,
        ].join('\n');
        await writeFile(path.join(sessions, `2026-09-18T05-00-00-000Z_${id}.jsonl`), `${spaced}\n`);
        const response = await get(port, '/tree');
        const row = response.value.sessions.find((item) => item.id === id);
        assert.ok(row, 'a non-compact session file is still a session');
        assert.equal(row.name, '非紧凑会话', 'non-compact JSONL must fall back to a real parse instead of silently losing the name');
        // 树上的 status 由宿主 decorateUnreadTree 决定（新 sandbox = idle），文件口径要看详情。
        const spacedDetail = await get(port, `/sessions/${id}`);
        assert.equal(spacedDetail.value.status, 'unread', 'the file-derived status must also survive the fallback');
        print('non-compact JSONL falls back to a real parse', { id: id.slice(0, 8), name: row.name, detailStatus: spacedDetail.value.status });
      }
    });

    await arm('⑦d 坏行跳过并如实报数', async () => {
      // ⑦d 坏行：普通冷读**跳过**并如实报出条数（与 pi 的解析器同口径）；cwd-missing 那条路仍然 500（readonlycwd 门钉着）。
      {
        const id = '01a0a003-0000-4000-8000-000000000001';
        const at = '2026-09-18T06:00:00.000Z';
        const userId = '01a0a003-0000-4000-8000-000000000002';
        const assistantId = '01a0a003-0000-4000-8000-000000000003';
        const lines = [
          JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: workspace }),
          JSON.stringify({ type: 'message', id: userId, parentId: null, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'before' }] } }),
          '{broken json',
          JSON.stringify({ type: 'message', id: assistantId, parentId: userId, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'after' }], stopReason: 'stop' } }),
        ].join('\n');
        await writeFile(path.join(sessions, `2026-09-18T06-00-00-000Z_${id}.jsonl`), `${lines}\n`);
        const response = await get(port, `/sessions/${id}/messages`);
        assert.equal(response.statusCode, 200, `a cold read skips malformed lines like pi does: ${JSON.stringify(response.value)?.slice(0, 200)}`);
        assert.equal(response.value.invalidLines, 1, 'the skipped line count must be reported, not silently swallowed');
        assert.equal(response.value.messages.length, 2);
        print('malformed lines: skipped and reported', { id: id.slice(0, 8), invalidLines: response.value.invalidLines, messages: response.value.messages.length });
      }
    });

    await arm('⑦e 带外删除 ⇒ 404 不是 500', async () => {
      // ⑦e 索引里还记着但文件被带外删了 ⇒ 正常 404，不是 500。
      {
        const victim = files[13];
        await get(port, '/tree'); // 确保索引里一定有它
        await rm(victim.file);
        const detail = await get(port, `/sessions/${victim.id}`);
        assert.equal(detail.statusCode, 404, `a deleted session file must be a 404, not a 500: ${JSON.stringify(detail.value)?.slice(0, 200)}`);
        assert.equal(detail.value.error, 'session_not_found');
        print('deleted file behind a warm index', { id: victim.id.slice(0, 8), status: detail.statusCode, error: detail.value.error });
      }
    });
    // ── 汇总：所有臂都跑完了再判红/绿（一臂红不再遮住后面的覆盖），并带上宿主日志尾部
    if (armFailures.length > 0) {
      print('failed arms', armFailures.map((failure) => ({
        label: failure.label,
        error: failure.error instanceof Error ? failure.error.message : String(failure.error),
      })));
      print('host log tails', {
        base: (await readFile(logPath, 'utf8').catch(() => '')).split('\n').slice(-20).join('\n'),
        abort: (await readFile(abortLogPath, 'utf8').catch(() => '')).split('\n').slice(-20).join('\n'),
      });
      assert.deepEqual(armFailures.map((failure) => failure.label), [], `${armFailures.length} arm(s) failed`);
    }
  } finally {
    await stop(child);
  }
  print('RESULT', { ok: true, coldLimitMs: COLD_MAX_MS, hotLimitMs: HOT_MAX_MS });
  clearTimeout(watchdog);
  process.stdout.write('RESULT: tree-scale PASS\n');
} catch (error) {
  primaryError = error;
} finally {
  // 沙箱一律收（成功/失败都收）：失败时留在 /tmp 的沙箱没人认领。清理本身不许顶掉真失败。
  const cleanupProblems = [];
  await removeSandbox(sandbox, cleanupProblems);
  finishCleanup(primaryError, cleanupProblems);
}
