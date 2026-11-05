#!/usr/bin/env node
// tree-index-selflock —— `/tree` 的索引「慢一次」不许等于「永久坏」。
//
// 现场（2026-09-21 真机 winbox，Windows，206 个会话文件 / 含 59 MB 级）：
//   某次重启后 `GET /tree` ⇒ 200 / 0.095 s；之后一次 reload 造出新 worker ⇒ `GET /tree` ⇒
//   **500 / 5.011 s**，body `{"error":"The operation was aborted due to timeout"}`，连试多次都一样；
//   同期 /ping /metrics /sessions/{id} 都是 3 ms 级 ⇒ 只有树这一条路坏。
//
// 机制（本门钉住的那个**不动点**）：
//   整树索引要扫完整份会话目录才成；客户端（宿主 `server/base.mjs` 的 `workerJson`）有硬超时，
//   一到点就 abort ⇒ 1) worker 收到 abort、2) **正在投影的那些字节被丢掉**、3) 下一个请求从同样的
//   工作量重来 ⇒ 还是超时。同样的死线 + 同样的工作量 = 不动点，于是「冷一次」变成「永远 500」。
//
// 修法（本门钉的四条 arms）：
//   (a) 索引有**死线**（SOPHO_TREE_INDEX_BUDGET_MS，默认 3500 ms，必须小于宿主那条硬超时 5000 ms）：
//       到点回 200 + 部分视图（行都对、可能不全、顶层 `partial: true` + `indexScan`），**绝不 500**；
//   (b) 扫描**继续在后台跑完**，被中止时已经投影完的字节留在**断点**里 ⇒ 第二次注定快（打印两次 ms）；
//   (c) 响应形状与行内容：完整树与基线形状一字不差；部分视图的行是完整树行的**子集**（逐字段相等），
//       且 parentId 要么 null（父真的不在）要么指向响应内的行 —— 不许出现「一会儿 null、一会儿真 id」；
//       （这条与 (a)(b) 的对照见 arms 1/2：部分视图那一份就直接与测试自己逐行 JSON.parse 的参照值比）
//   (d) 反向臂：把修法整条关掉（`SOPHO_TREE_INDEX_BUDGET_MS=0` = 旧行为：没有死线、不留断点）
//       ⇒ 同一个夹具 + 同一个客户端死线必须**变红**（宿主侧 timeout ⇒ 500，且连试不收敛）。
//
// 关于 5 秒那个常数：本机（Linux/NVMe）的**按字节投影**实测约 0.6 GB/s（下面会打印），要造出真机上
// 那种 >5 s 的冷扫描得有 3-4 GB 的会话数据。所以本门用同一条**机制**（宿主侧 abort ⇒ 500 +
// 丢掉在途进度），但把三条死线按夹具实测的冷扫描代价 C 缩放（budget = 0.3C、宿主 = 0.7C、C 由
// arm 0 实测）—— 关系不变（budget < 宿主死线 < 冷扫描代价），夹具只要几百 MB。
// 真机上 5 s 那次的原始复现（同一机制、真实 500）见本轮报告。
//
// 自足：临时夹具（真 profile **只读**复制 + 合成补齐）+ 每个 arm 自己的临时 home + 随机高位端口 +
// 自己 spawn 的 pid 收尾（绝不 pkill、绝不碰 7331/7321/真 profile）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';
import { createTreeScaleFixture } from './tree-scale-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 夹具目标体量（尽量用真会话文件的字节填满；真 profile 小/不存在时合成的那份会顶上）。
// 为什么是 700 MiB：本机**按字节投影**实测 ~0.75 GB/s（下面会打印），700 MiB ⇒ 冷扫描 ~0.9 s。
// 夹具得明显大于「回完部分视图之后还要花的那点时间」（拼行 / realpath / JSON），
// 三条死线才能都留出余量（见下面的 0.25 / 0.85 两个系数）。
const TARGET_CORPUS_MIB = Number(process.env.SOPHO_SELFHEAL_CORPUS_MIB ?? 700);
// 冷扫描太便宜（< 这个数）就没法让死线真的绑住 ⇒ 显式 SKIP，而不是造一个假的结论。
const MIN_COLD_MS = Number(process.env.SOPHO_SELFHEAL_MIN_COLD_MS ?? 300);
// 与 server/base-logic.mjs / server/base.mjs 的默认值对齐：worker 的索引预算必须小于宿主那条硬超时。
const WORKER_BUDGET_DEFAULT_MS = 3500;
const HOST_DEADLINE_DEFAULT_MS = 5000;
const MIB = 1024 * 1024;

const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const round = (n) => Math.round(n * 100) / 100;
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let checks = 0;
// ⚠️ 失败**不抛**（收集起来、最后一起判红/绿）：一臂红了也要把其余臂跑完 —— 让一条红臂遮住
// 后面的覆盖是 2026-09-21 那次「误删 projectTreeLineByParser 的 500 回归漏过门」的直接原因。
const failures = [];
function check(name, ok, detail) {
  if (!ok) {
    failures.push({ name, detail });
    process.stdout.write(`✗ ${name} —— ${detail}\n`);
    return;
  }
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
}
/** 一臂整体抛了（例如上一个断言失败后代码继续 deref）：记下来，不打断其它臂。 */
function armThrew(label, error) {
  failures.push({ name: `${label}（整臂抛出）`, detail: error instanceof Error ? error.message : String(error) });
  process.stdout.write(`✗ ${label}（整臂抛出）—— ${error instanceof Error ? error.message : String(error)}\n`);
}

const watchdog = setTimeout(() => {
  process.stderr.write('WATCHDOG: tree-index-selflock did not finish in 420000 ms\n');
  process.exit(2);
}, 420000);
watchdog.unref?.();

// ── 参照事实（独立于服务端：测试自己逐行 JSON.parse）─────────────────────────────────────────
// `status` 不在比较里：树上的 status 由宿主用自己的 seen/settled 账**重算**（decorateUnreadTree）。
// `modifiedAt` 有一个**契约上的**例外：/tree 的那条路是**按字节投影**（`"timestamp":"` 紧凑形，
// 见 server/base-logic.mjs 里 TREE_BYTES 的注释），而真数据里宿主写归档标记用的是**带空格**的
// 格式（`"timestamp": "..."`），那一条对投影不可见 —— 于是它报的是最后一条**紧凑行**的时间。
// 所以参照值也按这个契约算，并**只在两边看得见同一条行时**才断言两者相等（见 strict 对照）。
async function referenceFacts(file) {
  // 按 **Buffer** + 按行扫（不把整份解码成字符串）：夹具里有一个几百 MB 的大文件，
  // 整份 utf8 解码会撞 V8 的字符串上限（实测 RangeError: Invalid string length）。
  const bytes = await readFile(file);
  let header = null;
  let name = null;
  let latestRole = null;
  let modified = null;        // 字节投影看得见的那条（契约口径）
  let strictModified = null;  // 逐行 JSON.parse 的严格口径（用来验投影没跑偏）
  let archivePresent = false;
  let archived = false;
  let start = 0;
  for (;;) {
    const newline = bytes.indexOf(10, start);
    const end = newline === -1 ? bytes.length : newline;
    if (end > start) {
      const line = bytes.subarray(start, end).toString('utf8').replace(/\r$/, '');
      if (line.trim() !== '') {
        const item = JSON.parse(line);
        if (header === null && item.type === 'session' && typeof item.id === 'string') header = item;
        if (item.type === 'session_info') name = item.name || null;
        if (item.type === 'message' && ['user', 'assistant'].includes(item.message?.role)) latestRole = item.message.role;
        if (item.type === 'custom' && item.customType === 'sopho.archive') { archivePresent = true; archived = item.data?.archived === true; }
        if (item.timestamp !== undefined) {
          strictModified = item.timestamp;
          const at = line.indexOf('"timestamp":"');
          if (at >= 0) {
            const valueStart = at + '"timestamp":"'.length;
            const valueEnd = line.indexOf('"', valueStart);
            if (valueEnd > valueStart) modified = line.slice(valueStart, valueEnd);
          }
        }
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  assert.ok(header, `fixture file has no session header: ${file}`);
  return {
    id: header.id.toLowerCase(),
    name,
    archived,
    cwd: header.cwd,
    parentSessionPath: header.parentSession ?? null,
    createdAt: header.timestamp ?? null,
    modifiedAt: modified ?? (header.timestamp ?? null),
    strictModifiedAt: strictModified,
    archivePresent,
    latestRole,
  };
}

// 行里**文件投影出来的**那几个字段（宿主补的 status/unread/notify/context 不在此列：
// 它们来自宿主自己的账与 runtime，不是这个门要钉的「行」）。
const ROW_FIELDS = ['id', 'name', 'archived', 'cwd', 'parentSessionPath', 'createdAt', 'modifiedAt', 'titleSource'];
const pickRow = (row) => Object.fromEntries(ROW_FIELDS.map((key) => [key, row?.[key]]));
const pickRef = (ref) => Object.fromEntries(ROW_FIELDS.map((key) => [key, key === 'titleSource' ? null : ref[key]]));

function compareRows(rows, reference) {
  const mismatches = [];
  for (const row of rows) {
    const want = reference.get(row.id);
    if (!want) { mismatches.push({ id: row.id, why: 'unknown id' }); continue; }
    const got = pickRow(row);
    const expected = pickRef(want);
    // 只在两边「看得见的最后一条行」相同时才比 modifiedAt（见 referenceFacts 的注释）。
    if (want.strictModifiedAt !== null && want.strictModifiedAt !== want.modifiedAt) {
      got.modifiedAt = want.modifiedAt;
      expected.modifiedAt = want.modifiedAt;
    }
    if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches.push({ got, want: expected });
  }
  return mismatches;
}

/** 行内自洽：parentId 要么 null（父真的不在），要么指向响应里真的有的那一行。 */
function danglingParents(rows) {
  const ids = new Set(rows.map((row) => row.id));
  return rows.filter((row) => row.parentId !== null && row.parentId !== undefined && !ids.has(row.parentId)).map((row) => row.id);
}

// ── 夹具 ────────────────────────────────────────────────────────────────────────────────────
/**
 * 把夹具补到目标体量，并**造出一个投影不完的大文件**：
 *   · 主体是一份**真会话文件的字节**重复接起来（就换头那一行的 id）—— 真机上 59 MB 那一档的形状；
 *   · 再拿单份真会话复制到剩余会话，把总量补到目标。
 * 为什么必須有那个大文件：真机上的死锁是**单个文件一次投影不完**（小文件早就在索引里了，
 * 只剩它一个永远过不了死线）。均唇的夹具只会「第二次就好」，那样反向臂就不是真死锁。
 */
async function topUpFixture(fixture, targetBytes, { hugeFraction = 0.55 } = {}) {
  const source = [...fixture.sessions].sort((left, right) => right.bytes - left.bytes)[0] ?? null;
  if (!source) return { added: 0, files: 0, hugeBytes: 0, note: 'no session file to copy from; corpus stays synthetic' };
  const bytes = await readFile(source.file);
  const newline = bytes.indexOf(10);
  if (newline <= 0) return { added: 0, files: 0, hugeBytes: 0, note: 'source session file has no first-line boundary' };
  const tail = bytes.subarray(newline + 1);
  const header = (id, at) => `${JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: fixture.cwd })}\n`;
  let total = fixture.sessions.reduce((sum, item) => sum + item.bytes, 0);
  let added = 0;
  let count = 0;
  // ① 那个「一个投影不完」的大文件
  const hugeId = randomUUID();
  const hugeFile = path.join(fixture.sessionsRoot, `topup-huge_${hugeId}.jsonl`);
  await writeFile(hugeFile, header(hugeId, new Date(Date.UTC(2026, 8, 2)).toISOString()));
  const repeats = Math.max(1, Math.ceil((targetBytes * hugeFraction) / tail.length));
  for (let index = 0; index < repeats; index += 1) await appendFile(hugeFile, tail);
  const hugeBytes = (await stat(hugeFile)).size;
  total += hugeBytes;
  added += hugeBytes;
  // ② 剩下的用单份真会话复制到目标
  for (let index = 0; total < targetBytes && index < 400; index += 1) {
    const id = randomUUID();
    const file = path.join(fixture.sessionsRoot, `topup-${String(index + 1).padStart(4, '0')}_${id}.jsonl`);
    await writeFile(file, Buffer.concat([Buffer.from(header(id, new Date(Date.UTC(2026, 8, 2) + (index + 1) * 1000).toISOString()), 'utf8'), tail]));
    const info = await stat(file);
    total += info.size;
    added += info.size;
    count += 1;
  }
  return { added, files: count + 1, hugeId, hugeBytes, hugeRepeats: repeats, source: path.basename(source.file), sourceBytes: source.bytes };
}

// ── 沙箱 ────────────────────────────────────────────────────────────────────────────────────
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

function get(port, pathname, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = nowMs();
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: { accept: 'application/json', connection: 'close' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        let value = null;
        try { value = JSON.parse(body.toString('utf8')); } catch {}
        resolve({ statusCode: response.statusCode, ms: round(nowMs() - started), bytes: body.length, value, body: body.toString('utf8').slice(0, 300) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.once('error', reject);
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) { spawnedHosts.delete(child); return; }
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)).then(() => true),
    sleep(15000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  spawnedHosts.delete(child);
}

/** 顶层收尾：不管前面怎么抛，沙箱 host 一个也不许留下。 */
async function stopAllHosts() {
  for (const child of [...spawnedHosts]) await stop(child);
}

// 每个 arm 自己的 home（seen/settled/drafts 账落在这里，不跨 arm 串味）。
// 所有 spawn 出来的 host 都记在 `spawnedHosts` 里：即使某条臂的 finally 没跑到（抛/中断），
// 顶层收尾也会把它们按**精确 pid** 停掉 —— 沙箱进程不许漏在机器上。
const spawnedHosts = new Set();
async function startHost({ sandbox, label, sessionsRoot, workspace, env }) {
  const home = path.join(sandbox, `home-${label}`);
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const logPath = path.join(sandbox, `base-${label}.log`);
  const port = await reservePort();
  const log = await open(logPath, 'w');
  const child = spawn(process.execPath, [path.join(root, 'server', 'base.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: workspace,
      SOPHO_NO_TOOLS: '1',
      SOPHO_MEMORY_HEAP_HIGH_BYTES: '1000000000000',
      SOPHO_MEMORY_HEAP_LOW_BYTES: '900000000000',
      SOPHO_MEMORY_RSS_HIGH_BYTES: '1000000000000',
      SOPHO_MEMORY_RSS_LOW_BYTES: '900000000000',
      ...env,
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  spawnedHosts.add(child);
  return { child, port, logPath, home };
}

async function waitHost(port, logPath) {
  const deadline = Date.now() + 60000;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await get(port, '/host', { timeoutMs: 3000 });
      if (response.statusCode === 200 && response.value?.currentWorkerPid) return response.value;
    } catch (error) { last = error; }
    await sleep(100);
  }
  const tail = (await readFile(logPath, 'utf8').catch(() => '(unreadable)')).split(/\r?\n/).slice(-12).join('\n');
  throw new Error(`host did not start on ${port}: ${last?.message}\n--- ${logPath} tail ---\n${tail}`);
}

function treeIndexFacts(hostResponse) {
  const host = hostResponse?.value ?? hostResponse ?? {};
  const workers = Array.isArray(host.workers) ? host.workers : [];
  const worker = workers.find((detail) => detail.state === 'current') ?? workers[0] ?? null;
  return {
    workerPid: worker?.pid ?? host.currentWorkerPid ?? null,
    treeIndex: worker?.memoryPolicy?.caches?.treeIndex ?? host.memoryPolicy?.caches?.treeIndex ?? null,
  };
}

async function waitFor(port, predicate, { timeoutMs = 120000, intervalMs = 200, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = treeIndexFacts(await get(port, '/host'));
    if (predicate(last.treeIndex ?? {})) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last?.treeIndex)}`);
}

/** 一个 arm 的全过程。返回 `{ skipped, reason }` 或抛出（红）。所有沙箱都在 `sandbox` 里。 */
async function gate(sandbox) {
  // ── 夹具：真 profile 只读复制 + 合成补齐 + 真会话字节复制补量 ─────────────────────────────
  const fixture = await createTreeScaleFixture({
    out: path.join(sandbox, 'fixture'),
    sessions: 320,
    bigMib: 32,
    bigCount: 4,
    log: (line) => process.stderr.write(`[fixture] ${line}\n`),
  });
  const topped = await topUpFixture(fixture, TARGET_CORPUS_MIB * MIB);
  const files = (await readdir(fixture.sessionsRoot)).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(fixture.sessionsRoot, name));
  const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
  const corpusBytes = sizes.reduce((sum, value) => sum + value, 0);
  print('fixture', {
    files: files.length,
    corpusMiB: round(corpusBytes / MIB),
    largestMiB: round(Math.max(...sizes) / MIB),
    copiedReal: fixture.copiedReal.length,
    synthetic: fixture.synthetic.length,
    toppedUp: topped,
    realHome: fixture.realHome,
  });
  if (corpusBytes < 64 * MIB) {
    return { skipped: true, reason: `fixture is too small (${round(corpusBytes / MIB)} MiB) to make any deadline bind honestly` };
  }

  // 参照行（独立实现：逐行 JSON.parse）
  const reference = new Map();
  const refStarted = nowMs();
  for (const file of files) {
    const facts = await referenceFacts(file);
    assert.ok(!reference.has(facts.id), `duplicate session id in fixture: ${facts.id}`);
    reference.set(facts.id, facts);
  }
  print('reference', { sessions: reference.size, ms: round(nowMs() - refStarted), note: '测试自己逐行 JSON.parse 算出来的（不是服务端给的）' });
  // 契约例外的规模：最后那条时间戳写在**带空格**的行里的文件（对字节投影不可见）——
  // 这种文件两边「看得见的最后一条行」不同，不能拿来断言 modifiedAt。
  const spacedTail = [...reference.values()].filter((facts) => facts.strictModifiedAt !== null && facts.strictModifiedAt !== facts.modifiedAt);
  print('reference note', {
    spacedTimestampTail: spacedTail.length,
    sessions: reference.size,
    note: '这些文件的最后一条 timestamp 写在带空格的行里（宿主写的归档标记那种），字节投影本就看不见它',
  });

  // ── arm 0：默认配置下的冷扫描（量出 C = 冷扫描代价；顺带钉「完整树 = 参照值」）─────────────
  const plain = await startHost({ sandbox, label: 'preflight', sessionsRoot: fixture.sessionsRoot, workspace: fixture.cwd, env: {} });
  let coldMs = null;
  let budgetDefault = null;
  try {
    await waitHost(plain.port, plain.logPath);
    const cold = await get(plain.port, '/tree');
    check('arm 0：默认配置下冷 /tree 是 200 且是完整视图（没有 partial 标记）',
      cold.statusCode === 200 && cold.value?.partial === undefined && Array.isArray(cold.value?.sessions),
      `status=${cold.statusCode} partial=${cold.value?.partial} ms=${cold.ms} 行=${cold.value?.sessions?.length}`);
    const mismatches = compareRows(cold.value.sessions, reference);
    check('arm 0：完整树每一行都逐字段等于参照值（不丢行、不写错）',
      mismatches.length === 0 && cold.value.sessions.length === reference.size,
      `行=${cold.value.sessions.length}/${reference.size} 不一致=${JSON.stringify(mismatches.slice(0, 2))}`);
    const dangling = danglingParents(cold.value.sessions);
    check('arm 0：parentId 要么 null 要么指向响应里真的有的行', dangling.length === 0, JSON.stringify(dangling.slice(0, 3)));
    const facts = treeIndexFacts(await get(plain.port, '/host'));
    coldMs = facts.treeIndex?.last?.ms ?? null;
    budgetDefault = facts.treeIndex?.budgetMs ?? null;
    check('arm 0：索引账如实（跑了一次、没中止、没有断点、行数 = 夹具会话数）',
      facts.treeIndex?.runs >= 1 && facts.treeIndex?.aborts === 0 && facts.treeIndex?.checkpoints === 0 && facts.treeIndex?.rows === reference.size,
      JSON.stringify(facts.treeIndex));
    // 真正要满足的是**有效**上界：预算 + 拼行保留额（min(1200, max(50, 0.25×预算))）< 宿主那条硬超时。
    const defaultRowBudget = Math.min(1200, Math.max(50, Math.round(WORKER_BUDGET_DEFAULT_MS * 0.25)));
    check(`arm 0：默认「预算 + 拼行保留额」必须小于宿主等 worker 的硬超时（${WORKER_BUDGET_DEFAULT_MS} + ${defaultRowBudget} < ${HOST_DEADLINE_DEFAULT_MS}）`,
      budgetDefault === WORKER_BUDGET_DEFAULT_MS && budgetDefault + defaultRowBudget < HOST_DEADLINE_DEFAULT_MS,
      `worker budgetMs=${budgetDefault} rowBudgetMs=${defaultRowBudget} host deadline=${HOST_DEADLINE_DEFAULT_MS}`);
    print('arm 0 cold scan', {
      coldMs,
      coldMsTotal: cold.ms,
      files: files.length,
      corpusMiB: round(corpusBytes / MIB),
      throughputMiBs: coldMs ? round(corpusBytes / MIB / (coldMs / 1000)) : null,
      budgetDefault,
      hostDeadlineDefault: HOST_DEADLINE_DEFAULT_MS,
    });
  } catch (error) {
    armThrew('arm 0', error);
  } finally {
    await stop(plain.child);
  }

  if (coldMs === null || coldMs < MIN_COLD_MS) {
    return { skipped: true, reason: `cold scan is ${coldMs} ms (< ${MIN_COLD_MS} ms): a shorter deadline would be a lie, not a bound` };
  }

  const budgetMs = Math.max(60, Math.round(coldMs * 0.12));
  // 宿主死线取 C 的 0.35：既大于 budget + 「回完部分视图后那点工作」（固定臂不 500），
  // 又**小于那个大文件一个的投影代价**（反向臂因此真的锁死，而不是「第二次就好」）。
  const hostDeadlineMs = Math.max(budgetMs + 150, Math.round(coldMs * 0.35));
  if (hostDeadlineMs >= coldMs) throw new Error(`unusable deadlines: host deadline ${hostDeadlineMs} ms must stay below the cold scan ${coldMs} ms`);
  const throughputBytesPerMs = corpusBytes / coldMs;
  const hugeProjectionMs = round(topped.hugeBytes / throughputBytesPerMs);
  print('deadlines', {
    coldScanMs: coldMs,
    workerBudgetMs: budgetMs,
    hostDeadlineMs,
    hugeFileMiB: round(topped.hugeBytes / MIB),
    hugeProjectionMs,
    ordering: 'worker budget < host deadline < one huge file\u2019s projection < cold scan',
    scaledBecause: '本机冷扫描比真机快得多（真机是慢盘+实时防护），所以三条死线按实测 C 缩放；关系与线上一致',
  });
  if (hugeProjectionMs < hostDeadlineMs * 1.3) {
    return {
      skipped: true,
      reason: `the huge file alone would take ~${hugeProjectionMs} ms (< 1.3 * host deadline ${hostDeadlineMs} ms): this fixture cannot reproduce the permanent lock honestly`,
    };
  }

  // ── arm 1/2：修法开着 —— 冷 /tree 不许 500；第二次必须快、必须完整 ───────────────────────
  const fixed = await startHost({
    sandbox,
    label: 'fixed',
    sessionsRoot: fixture.sessionsRoot,
    workspace: fixture.cwd,
    env: { SOPHO_TREE_INDEX_BUDGET_MS: String(budgetMs), SOPHO_WORKER_JSON_TIMEOUT_MS: String(hostDeadlineMs) },
  });
  try {
    await waitHost(fixed.port, fixed.logPath);
    const first = await get(fixed.port, '/tree', { timeoutMs: hostDeadlineMs + 60000 });
    check('arm 1：冷 /tree 在死线内回 200（**不许 500**），且如实标了 partial',
      first.statusCode === 200 && first.value?.partial === true && Array.isArray(first.value?.sessions),
      `status=${first.statusCode} ms=${first.ms} partial=${first.value?.partial} body=${first.body}`);
    check('arm 1：这份部分视图真的没扫完（indexScan.pending > 0）—— 否则这条臂是空的',
      Number(first.value?.indexScan?.pending) > 0 && Number(first.value?.indexScan?.files) === files.length,
      JSON.stringify(first.value?.indexScan));
    check('arm 1：部分视图**不许是 0 行**（到点回的行数 > 0）—— 拼行有独立的保留配额',
      first.value.sessions.length > 0 && Number(first.value.indexScan?.rows) === first.value.sessions.length,
      `rows=${first.value.sessions.length} indexScan.rows=${first.value.indexScan?.rows} rowBudgetMs=${first.value.indexScan?.rowBudgetMs}`);
    check('arm 1：部分视图的每一行都逐字段等于参照值（给不全，但不给错）',
      compareRows(first.value.sessions, reference).length === 0,
      JSON.stringify(compareRows(first.value.sessions, reference).slice(0, 2)));
    check('arm 1：部分视图里没有悬空 parentId（宁可少发一行，也不发一个会变的 parentId）',
      danglingParents(first.value.sessions).length === 0 && (first.value.indexScan?.hidden ?? 0) >= 0,
      JSON.stringify({ dangling: danglingParents(first.value.sessions).slice(0, 3), hidden: first.value.indexScan?.hidden }));
    const fixedFacts = treeIndexFacts(await get(fixed.port, '/host'));
    check('arm 1：worker 到点回的是**部分视图**而不是中止扫描（索引条目数 > 这次响应的行数）',
      Number(fixedFacts.treeIndex?.partials) >= 1,
      JSON.stringify(fixedFacts.treeIndex));

    // 扫描在后台接着跑完（共享的那一份），断点被真的用上。
    const complete = await waitFor(fixed.port, (facts) => facts.checkpoints === 0 && facts.rows === reference.size, { what: 'the background scan to complete' });
    check('arm 2：被中止/到点之后，索引**在后台自己建完**（断点清零、行数 = 夹具会话数）',
      complete.treeIndex.rows === reference.size && complete.treeIndex.checkpoints === 0,
      JSON.stringify(complete.treeIndex));

    const projectedBefore = complete.treeIndex.filesProjected;
    const second = await get(fixed.port, '/tree', { timeoutMs: 60000 });
    const secondFacts = treeIndexFacts(await get(fixed.port, '/host'));
    check('arm 2：热了之后 /tree 是 200 + 完整视图（没有 partial 标记）',
      second.statusCode === 200 && second.value?.partial === undefined && second.value.sessions.length === reference.size,
      `status=${second.statusCode} ms=${second.ms} partial=${second.value?.partial} 行=${second.value?.sessions?.length}/${reference.size}`);
    check('arm 2：完整树每一行都逐字段等于参照值',
      compareRows(second.value.sessions, reference).length === 0,
      JSON.stringify(compareRows(second.value.sessions, reference).slice(0, 2)));
    check('arm 2：第二次**明显快于**第一次（部分视图那次），说明缓存真的热了',
      second.ms < first.ms && second.ms < 1000,
      `第一次(partial)=${first.ms} ms（死线 ${budgetMs} ms）· 第二次(完整)=${second.ms} ms`);
    check('arm 2：热路径**没有再投影任何一个文件**（不是「又扫了一遍刚好赶上了」）',
      secondFacts.treeIndex.filesProjected === projectedBefore,
      `filesProjected before=${projectedBefore} after=${secondFacts.treeIndex.filesProjected}`);
    check('arm 2：热路径不消耗死线（partials 计数不再涨）',
      Number(secondFacts.treeIndex.partials) === Number(complete.treeIndex.partials),
      JSON.stringify({ partialsBefore: complete.treeIndex.partials, partialsAfter: secondFacts.treeIndex.partials }));
    print('arm 1/2 self-heal', {
      firstPartialMs: first.ms,
      firstPartialBudgetMs: budgetMs,
      firstPartialPostMs: round(first.ms - budgetMs),
      firstPartialRows: first.value.sessions.length,
      indexScan: first.value.indexScan,
      secondCompleteMs: second.ms,
      secondRows: second.value.sessions.length,
      coldScanMs: coldMs,
      coldTotalMs: null,
      treeIndexAfter: complete.treeIndex,
      filesProjectedHot: secondFacts.treeIndex.filesProjected,
      note: '第一次在死线内回了 200+部分视图；扫描在后台建完，第二次是完整树且只做了一次 stat 遍',
    });

    // ── arm 2.5：**中途走掉的客户端** ⇒ 断点留在索引里 ⇒ 下一个请求从断点接着扫 ─────────────────
    // 这是「被中止不再等于白读」那一条：在途的那个文件的项目被写成断点（`checkpoints > 0`、
    // 而且 `checkpointBytes > 0` = 真的已经投影过一段），下一次扫描把 `resumes` 计数器排上去。
    // 顺带一条：新落盘的会话文件必须能出现在树里。
    {
      // 源选「最大但 ≤ 32 MiB」的会话（不要拿那个几百 MB 的 topup 大文件——尾巴接三遍会把内存和
      // 写盘都推到 GB 级；这个臂要的不是尺寸，是「一个能在半路被掐断的投影」）。
      const source = [...files]
        .map((file, index) => ({ file, size: sizes[index] }))
        .filter((item) => item.size <= 32 * MIB)
        .sort((left, right) => right.size - left.size)[0]?.file ?? null;
      assert.ok(source, 'fixture has no session file up to 32 MiB to build the late session from');
      const bytes = await readFile(source);
      const newline = bytes.indexOf(10);
      assert.ok(newline > 0, 'fixture is missing a session header line');
      // 尾巴接三遍：这个新文件的投影要花 ~100 ms，才有时间在**半路**把它掐掉。
      const tail = Buffer.concat([bytes.subarray(newline + 1), bytes.subarray(newline + 1), bytes.subarray(newline + 1)]);
      let aborted = null;
      let lateFile = null;
      for (let attempt = 0; attempt < 3 && aborted === null; attempt += 1) {
        const id = randomUUID();
        const header = `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(Date.UTC(2026, 8, 3) + attempt * 1000).toISOString(), cwd: fixture.cwd })}\n`;
        lateFile = path.join(fixture.sessionsRoot, `late-${String(attempt + 1).padStart(2, '0')}_${id}.jsonl`);
        await writeFile(lateFile, Buffer.concat([Buffer.from(header, 'utf8'), tail]));
        reference.set(id, await referenceFacts(lateFile));
        const before = treeIndexFacts(await get(fixed.port, '/host')).treeIndex.aborts;
        const sse = http.get({ host: '127.0.0.1', port: fixed.port, path: '/tree/events', headers: { accept: 'text/event-stream', connection: 'close' } }, (response) => { response.on('data', () => {}); response.on('error', () => {}); });
        sse.once('error', () => {});
        // 等到「真的已经投影过一段」再掐：掐太早（consumed=0）就没有断点可续，那条臂也就没验到东西。
        for (let wait = 0; wait < 60; wait += 1) {
          const facts = treeIndexFacts(await get(fixed.port, '/host')).treeIndex;
          if (Number(facts.checkpointBytes) > 2 * MIB) break;
          await sleep(20);
        }
        sse.destroy();
        for (let wait = 0; wait < 30; wait += 1) {
          const facts = treeIndexFacts(await get(fixed.port, '/host')).treeIndex;
          if (facts.aborts > before) { aborted = facts; break; }
          await sleep(100);
        }
        if (aborted === null) await rm(lateFile, { force: true });
      }
      assert.ok(aborted, '3 attempts failed to abort a scan mid-flight (the scan was too fast to interrupt)');
      check('arm 2.5：中途走掉的客户端真的让扫描停下来了，而且在途进度留成了断点（已投影的字节 > 0）',
        aborted.aborts >= 1 && aborted.checkpoints >= 1 && Number(aborted.checkpointBytes) > 0,
        JSON.stringify({ aborts: aborted.aborts, checkpoints: aborted.checkpoints, checkpointBytes: aborted.checkpointBytes, filesProjected: aborted.filesProjected }));
      const resumed = await get(fixed.port, '/tree', { timeoutMs: 60000 });
      check('arm 2.5：接着扫的那次是 200（不是 500）', resumed.statusCode === 200, `status=${resumed.statusCode} ms=${resumed.ms} body=${resumed.body}`);
      const afterResume = await waitFor(fixed.port, (facts) => facts.checkpoints === 0 && facts.rows === reference.size, { what: 'the resumed scan to complete' });
      check('arm 2.5：断点续扫真的发生了（resumes ≥ 1）—— 被中止那次的字节没白读',
        Number(afterResume.treeIndex.resumes) >= 1,
        JSON.stringify({ resumes: afterResume.treeIndex.resumes, filesProjected: afterResume.treeIndex.filesProjected, aborts: afterResume.treeIndex.aborts }));
      const grown = await get(fixed.port, '/tree', { timeoutMs: 60000 });
      check('arm 2.5：新落盘的会话文件进了树，且整棵树仍逐字段等于参照值',
        grown.value?.partial === undefined && grown.value.sessions.length === reference.size && compareRows(grown.value.sessions, reference).length === 0,
        `partial=${grown.value?.partial} 行=${grown.value?.sessions?.length}/${reference.size} 不一致=${JSON.stringify(compareRows(grown.value.sessions ?? [], reference).slice(0, 2))}`);
      check('arm 2.5：续扫之后热路径仍然不重投影（filesProjected 不再涨）',
        (await treeIndexFacts(await get(fixed.port, '/host'))).treeIndex.filesProjected === afterResume.treeIndex.filesProjected,
        `filesProjected=${afterResume.treeIndex.filesProjected}`);
      print('arm 2.5 resume after abort', {
        lateSession: path.basename(lateFile),
        aborts: afterResume.treeIndex.aborts,
        checkpointsAtAbort: aborted.checkpoints,
        resumes: afterResume.treeIndex.resumes,
        filesProjected: afterResume.treeIndex.filesProjected,
        sessions: reference.size,
        note: '旧实现下这几个在途文件白读，而且旧实现根本没人回 200；现在它们从断点接着扫',
      });
    }
    const log = await readFile(fixed.logPath, 'utf8');
    check('arm 1/2：全程没有宿主侧 timeout、也没有把中止记成请求失败',
      !/TimeoutError/.test(log) && !/worker_request_failed[^\n]*tree_scan_aborted/.test(log),
      `/TimeoutError/=${(log.match(/TimeoutError/g) ?? []).length} bytes=${log.length}`);
  } catch (error) {
    armThrew('arm 1/2/2.5', error);
  } finally {
    await stop(fixed.child);
  }

  // ── arm 3（反向臂）：把修法整条关掉（SOPHO_TREE_INDEX_BUDGET_MS=0 = 旧行为）⇒ 必须变红 ──────
  const legacy = await startHost({
    sandbox,
    label: 'legacy',
    sessionsRoot: fixture.sessionsRoot,
    workspace: fixture.cwd,
    env: { SOPHO_TREE_INDEX_BUDGET_MS: '0', SOPHO_WORKER_JSON_TIMEOUT_MS: String(hostDeadlineMs) },
  });
  try {
    await waitHost(legacy.port, legacy.logPath);
    const attempts = [];
    for (let index = 0; index < 3; index += 1) {
      attempts.push(await get(legacy.port, '/tree', { timeoutMs: hostDeadlineMs + 60000 }).catch((error) => ({ statusCode: 0, ms: null, value: null, body: error.message })));
    }
    const allFiveHundred = attempts.every((attempt) => attempt.statusCode === 500);
    check('arm 3（反向臂）：修法关掉 ⇒ 宿主侧 timeout ⇒ **500**（真机上那条 `aborted due to timeout`）',
      attempts[0].statusCode === 500 && /timeout/i.test(attempts[0].body ?? ''),
      JSON.stringify(attempts.map((attempt) => ({ status: attempt.statusCode, ms: attempt.ms, body: attempt.body }))));
    check('arm 3（反向臂）：每一个大文件一次都投影不完 ⇒ 连试 3 次都不收敛（真机上的**不动点**）',
      allFiveHundred,
      JSON.stringify({ attempts: attempts.map((attempt) => ({ status: attempt.statusCode, ms: attempt.ms })), hugeProjectionMs, hostDeadlineMs }));
    // 中止是在宿主 abort 之后才落账的：等它停止在飞（有界），账才是完整的。
    await waitFor(legacy.port, (facts) => facts.inFlight === false, { what: 'the aborted scans to stop being in flight', timeoutMs: 30000 });
    const legacyFacts = treeIndexFacts(await get(legacy.port, '/host'));
    check('arm 3（反向臂）：三次都真的被中止了，而且断点一个都不留、一次续扫都没有（所以每次都从零重来）',
      legacyFacts.treeIndex.aborts === 3 && legacyFacts.treeIndex.checkpoints === 0 && legacyFacts.treeIndex.resumes === 0,
      JSON.stringify(legacyFacts.treeIndex));
    check('arm 3（反向臂）：三次之后缺的恰好是那个大文件（其余会话早在索引里了）—— 真机上「只剩它永远过不了」就是这个形状',
      Number(legacyFacts.treeIndex.rows) >= reference.size - 2 && Number(legacyFacts.treeIndex.rows) <= reference.size - 1,
      `rows=${legacyFacts.treeIndex.rows}/${reference.size}（永远缺的那个：huge ${topped.hugeId} = ${round(topped.hugeBytes / MIB)} MiB ≈ ${hugeProjectionMs} ms > 宿主死线 ${hostDeadlineMs} ms）`);
    print('arm 3 reverse', {
      attempts: attempts.map((attempt) => ({ status: attempt.statusCode, ms: attempt.ms, body: attempt.body })),
      hostDeadlineMs,
      coldScanMs: coldMs,
      treeIndex: legacyFacts.treeIndex,
      note: 'budget=0 是「旧行为」：没有死线、不留断点 —— 这条路必须红，本门才不是空的',
    });
  } catch (error) {
    armThrew('arm 3', error);
  } finally {
    await stop(legacy.child);
  }

  // ── 汇总：所有臂都跑完了再判红/绿（一臂红不再遮住后面的覆盖），并带上宿主的日志尾部
  if (failures.length > 0) {
    print('failed checks', failures);
    print('log tails', {
      preflight: (await readFile(plain.logPath, 'utf8').catch(() => '')).split('\n').slice(-15).join('\n'),
      fixed: (await readFile(fixed.logPath, 'utf8').catch(() => '')).split('\n').slice(-15).join('\n'),
      legacy: (await readFile(legacy.logPath, 'utf8').catch(() => '')).split('\n').slice(-15).join('\n'),
    });
    assert.deepEqual(failures.map((failure) => failure.name), [], `${failures.length} check(s) failed`);
  }
  print('RESULT', {
    ok: true,
    checks,
    files: files.length,
    corpusMiB: round(corpusBytes / MIB),
    coldScanMs: coldMs,
    workerBudgetMs: budgetMs,
    hostDeadlineMs,
    spacedTimestampTail: spacedTail.length,
  });
  return { skipped: false };
}

// ── 收尾：沙箱删干净；夹具在沙箱里面，一删除干净（绝不碰真 profile）─────────────────────────
const problems = [];
let primaryError = null;
let sandbox = null;
let outcome = null;
try {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-selflock-'));
  print('sandbox', sandbox);
  outcome = await gate(sandbox);
} catch (error) {
  primaryError = error;
} finally {
  await stopAllHosts();
  if (sandbox) await removeSandbox(sandbox, problems, 'remove sandbox');
  if (outcome?.skipped) {
    print('SKIP', outcome.reason);
    print('RESULT', { ok: true, skipped: true, checks });
    process.stdout.write('RESULT: tree-index-selflock SKIP\n');
  } else if (!primaryError) {
    process.stdout.write('RESULT: tree-index-selflock PASS\n');
  }
  clearTimeout(watchdog);
  finishCleanup(primaryError, problems);
}
