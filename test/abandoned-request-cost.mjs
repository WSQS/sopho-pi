#!/usr/bin/env node
// test/abandoned-request-cost.mjs —— P0「客户端已经放弃、服务端还在继续算」的量尺。
//
// 要回答的一句话：**放弃一条最贵的 HTTP 读请求，我们白烧多少 ms CPU / 多少 MB 峰值？**
// 本文件只做测量（默认 report-only）；`--assert` 才下判据，`--reverse` 是反证臂
// （把检查点关掉 ⇒ 判据必须红）。
//
// 为什么要有它：`/messages` 的冷读把整份会话文件读进内存、逐行 JSON.parse、投影、再
// `JSON.stringify` 61 MB + 算 sha1。这一段是**同步代码**，修前「客户端走了就停」的检查点写成
// 「每 2000 行看一眼」——在真机最大的会话文件（60 835 111 B / **707 行**）上是**死代码**，
// 而且同步循环里 `response.once('close')` 的 abort 回调根本没机会跑。于是客户端 50 ms 就放弃的
// 一发，服务端照样把整发算完、还把 61 MB 写进响应体缓存（实测 609 ms CPU / +335 MiB）。
//
// 铁律（写在代码里，防后来人改坏）：
//   · 只起**自己 spawn** 的 `server/base.mjs`，只按**那个 pid** 停；**绝不 pkill**；
//   · 端口一律高位随机 + 127.0.0.1，**绝不**用 7331/7321/7322/7411/7412（活实例的端口）；
//   · 日志写本次沙箱；**绝不**写 /tmp/sopho-base.log | sopho-app.log（活实例的 fd 指着它们）；
//   · 夹具是**真 profile 里最大会话的只读拷贝**（绝不就地读活实例、绝不改真 profile）。

import { copyFile, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createProcessSampler } from './harness.mjs';
import { MIB, hostStatus, poll, readWorkerPortFromLog, request, sleep, startSandboxBase, workerToken } from './perf-verify-lib.mjs';

// ───────────────────────────── CLI ─────────────────────────────
function parseArgs(argv) {
  const options = { json: null, keep: false, assert: false, reverse: false, arms: null, fixture: null, timeoutSeconds: 1800, abortCheckMs: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => { index += 1; if (index >= argv.length) throw new Error(`${arg} requires a value`); return argv[index]; };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = next();
    else if (arg === '--arms') options.arms = next().split(',').map((value) => value.trim()).filter(Boolean);
    else if (arg === '--fixture') options.fixture = next();
    else if (arg === '--timeout-seconds') options.timeoutSeconds = Number(next());
    else if (arg === '--abort-check-ms') options.abortCheckMs = Number(next());
    else if (arg.startsWith('--abort-check-ms=')) options.abortCheckMs = Number(arg.slice('--abort-check-ms='.length));
    else if (arg === '--assert') options.assert = true;
    else if (arg === '--reverse') options.reverse = true;
    else if (arg === '--keep') options.keep = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.abortCheckMs !== null && (!Number.isInteger(options.abortCheckMs) || options.abortCheckMs < 0)) {
    throw new Error(`--abort-check-ms must be an integer >= 0: ${options.abortCheckMs}`);
  }
  if (options.reverse && options.abortCheckMs !== null) {
    throw new Error('--reverse means SOPHO_MESSAGE_ABORT_CHECK_MS=0; do not pass --abort-check-ms with it');
  }
  return options;
}

function usage() {
  return `Usage: node test/abandoned-request-cost.mjs [options]\n\n` +
    `  --arms a,b,c        只跑这几臂（默认全部）\n` +
    `  --fixture FILE      指定夹具会话文件（只读拷贝）；默认取真 profile 里最大的那个\n` +
    `  --assert            下判据（修后必须绿；配 --reverse 必须红）\n` +
    `  --reverse           反证臂：SOPHO_MESSAGE_ABORT_CHECK_MS=0 ⇒ 关掉检查点\n` +
    `  --abort-check-ms N  给沙箱 worker 下 SOPHO_MESSAGE_ABORT_CHECK_MS=N（不传 = 用产品默认；\n` +
    `                      N=50 = 旧默认，是「信号被看见得太晚」那条的常驻反证臂）\n` +
    `  --json PATH         把原始样本写成 JSON\n` +
    `  --keep              保留沙箱\n` +
    `  --timeout-seconds N 总超时（默认 1800）\n\n` +
    `绝不碰真 profile / 固定端口 / 活实例。`;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) { process.stdout.write(`${usage()}\n`); process.exit(0); }
if (!options.assert) options.reverse = false; // 反证只有在下判据时才有意义

const REAL_PROFILE = process.env.SOPHO_ABANDON_PROFILE ?? path.join(os.homedir(), '.pi', 'profiles', 'assistant');
const MIN_FIXTURE_BYTES = Number(process.env.SOPHO_ABANDON_MIN_FIXTURE_BYTES ?? 8 * MIB);

// ───────────────────────── 夹具 ─────────────────────────
async function pickFixtureFile() {
  if (options.fixture) {
    const info = await stat(options.fixture).catch(() => null);
    if (!info?.isFile()) throw new Error(`--fixture is not a file: ${options.fixture}`);
    return { source: path.resolve(options.fixture), real: false };
  }
  const dir = path.join(REAL_PROFILE, 'sessions');
  let names = [];
  try { names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')); } catch { names = []; }
  let best = null;
  for (const name of names) {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    if (!best || info.size > best.size) best = { file, size: info.size };
  }
  if (best && best.size >= MIN_FIXTURE_BYTES) return { source: best.file, real: true, bytes: best.size };
  return { source: null, real: false };
}

/** 合成一份「同形」的大会话（真夹具不可得时的降级；至少 8 MiB，行少而宽 —— 与真机 707 行的形状一致）。 */
async function writeSyntheticFixture(file, cwd, targetBytes) {
  const lineCount = 700;
  const per = Math.floor(targetBytes / lineCount);
  const header = { type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
  const out = createWriteStream(file, { encoding: 'utf8' });
  out.write(`${JSON.stringify(header)}\n`);
  const text = 'x'.repeat(per);
  for (let index = 0; index < lineCount; index += 1) {
    const id = index.toString(16).padStart(8, '0');
    const entry = { type: 'message', id, parentId: index === 0 ? null : (index - 1).toString(16).padStart(8, '0'), timestamp: new Date().toISOString(), message: { role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: new Date().toISOString() } };
    if (!out.write(`${JSON.stringify(entry)}\n`)) await new Promise((resolve) => out.once('drain', resolve));
  }
  await new Promise((resolve, reject) => out.end(resolve).once('error', reject));
}

/** 把夹具拷进沙箱；`cwd` 给了就把 header 的 id/cwd 换掉（/events、/questions 那条要求 cwd 可用的路要用）。 */
async function materializeFixture(fixture, sessionsRoot, workspace, tags) {
  const created = [];
  for (const tag of tags) {
    const id = randomUUID();
    const dest = path.join(sessionsRoot, `${tag}_${id}.jsonl`);
    if (fixture.real) await copyFile(fixture.source, dest);
    else await writeSyntheticFixture(dest, workspace, Math.max(MIN_FIXTURE_BYTES, 32 * MIB));
    // header 改写成新的 id（并可选把 cwd 指到沙箱里存在的目录）—— 原地等长替换 id，cwd 变长时重写首行。
    const handle = await open(dest, 'r+');
    const head = Buffer.alloc(8192);
    await handle.read(head, 0, head.length, 0);
    const text = head.toString('utf8');
    const nl = text.indexOf('\n');
    const header = JSON.parse(text.slice(0, nl));
    header.id = id;
    if (workspace) header.cwd = workspace;
    const newHeader = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8');
    const oldHeader = Buffer.from(text.slice(0, nl + 1), 'utf8');
    if (newHeader.length === oldHeader.length) {
      await handle.write(newHeader, 0, newHeader.length, 0);
      await handle.close();
    } else {
      await handle.close();
      // 长度变了：重写整个文件（只在这里做一次，成本可接受）。
      const tail = createReadStream(dest, { start: oldHeader.length });
      const out = createWriteStream(dest + '.rewrite', { encoding: 'utf8' });
      out.write(newHeader);
      await new Promise((resolve, reject) => { tail.on('data', (chunk) => out.write(chunk)); tail.once('end', () => out.end(resolve)); tail.once('error', reject); out.once('error', reject); });
      await rm(dest); await renameFile(dest + '.rewrite', dest);
    }
    created.push({ id, file: dest });
  }
  return created;
}
async function renameFile(from, to) { const { rename } = await import('node:fs/promises'); await rename(from, to); }

// ───────────────────────── HTTP / 采样 ─────────────────────────
function rawGet(port, pathname, { abortAfterMs = null, token = null, accept = 'application/json', collectBytes = true } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const headers = { accept, connection: 'close', ...(token ? { 'x-sopho-worker-token': token } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers });
    let settled = false; let bytes = 0; const chunks = [];
    const finish = (o) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve({ ...o, elapsedMs: Date.now() - started, bytes }); };
    const timer = abortAfterMs === null ? null : setTimeout(() => { req.destroy(); finish({ aborted: true, statusCode: 0, note: 'timer' }); }, abortAfterMs);
    req.once('error', (error) => finish({ aborted: false, statusCode: 0, error: error.message, note: 'error' }));
    req.once('response', (res) => {
      res.on('data', (chunk) => { bytes += chunk.length; if (collectBytes && chunks.length < 400) chunks.push(chunk); });
      res.once('end', () => finish({ aborted: false, statusCode: res.statusCode, note: 'end', sha1: createHash('sha1').update(Buffer.concat(chunks)).digest('hex'), raw: Buffer.concat(chunks).toString('utf8').slice(0, 300) }));
      res.once('error', (error) => finish({ aborted: false, statusCode: res.statusCode, error: error.message, note: 'stream' }));
    });
    req.end();
  });
}

async function watchQuiet(sampler, pid, { maxMs = 9000, quietRate = 40, quietSamples = 3 } = {}) {
  let last = (await sampler.sample([pid])).get(pid);
  const start = last;
  let peakRss = last?.rssBytes ?? 0;
  let quiet = 0; const trail = []; const t0 = Date.now();
  const deadline = t0 + maxMs;
  while (Date.now() < deadline) {
    await sleep(100);
    const now = (await sampler.sample([pid])).get(pid);
    if (!now || !last) break;
    peakRss = Math.max(peakRss, now.rssBytes ?? 0);
    const rate = ((now.cpuMs - last.cpuMs) * 1000) / 100;
    trail.push(Math.round(rate));
    last = now;
    quiet = rate <= quietRate ? quiet + 1 : 0;
    if (quiet >= quietSamples) break;
  }
  return { startCpuMs: start?.cpuMs ?? null, endCpuMs: last?.cpuMs ?? null, cpuMs: start && last ? Number((last.cpuMs - start.cpuMs).toFixed(1)) : null, rssStart: start?.rssBytes ?? null, rssPeak: peakRss, wallMs: Date.now() - t0, trail };
}

// ───────────────────────── 一臂一个干净沙箱 ─────────────────────────
const raw = { startedAt: new Date().toISOString(), options: { assert: options.assert, reverse: options.reverse, arms: options.arms }, fixture: null, arms: [] };
const report = (event, fields) => { process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`); };

async function withSandbox(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sopho-abandon-'));
  const home = path.join(dir, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(home, 'workspace');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const extraEnv = options.reverse
    ? { SOPHO_MESSAGE_ABORT_CHECK_MS: '0' }
    : options.abortCheckMs === null ? {} : { SOPHO_MESSAGE_ABORT_CHECK_MS: String(options.abortCheckMs) };
  const base = await startSandboxBase({ home, sessionsRoot, workspace, logPath: path.join(dir, 'base.log'), extraEnv });
  try {
    const host = await poll('sandbox ready', () => hostStatus(base.port), (value) => value?.currentWorkerPid > 0, 120_000);
    const worker = await readWorkerPortFromLog(base.logPath);
    const token = workerToken(host.pid, host.currentGenerationId, 'boot');
    await sleep(1200); // 让空闲基线 RSS 稳定（否则第一臂的 delta 会被 boot 尾巴污染）
    return await fn({ dir, home, sessionsRoot, workspace, base, host, worker, token, pid: host.currentWorkerPid });
  } finally {
    await base.stop();
    if (!options.keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
    else process.stderr.write(`sandbox kept at ${dir}\n`);
  }
}

/** 一条臂：[新夹具] → 发请求（可选在 abortAfterMs 放弃）→ 等到真正静默 → 记 CPU/RSS/缓存。 */
async function measureArm({ label, kind, method = 'messages', abortAfterMs = null, withCwd = false, warmEvents = false, sampler, sandbox, fixture }) {
  const { worker, token, pid, base, sessionsRoot, workspace } = sandbox;
  const [fx] = await materializeFixture(fixture, sessionsRoot, withCwd ? workspace : null, [kind]);
  let sse = null;
  if (warmEvents) {
    sse = http.request({ host: '127.0.0.1', port: worker.port, path: `/sessions/${fx.id}/events`, headers: { accept: 'text/event-stream', connection: 'close', 'x-sopho-worker-token': token } });
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 90_000);
      sse.on('response', (res) => res.on('data', (chunk) => { if (chunk.toString('utf8').includes('session.snapshot')) { clearTimeout(timer); resolve(true); } }));
      sse.on('error', () => { clearTimeout(timer); resolve(false); });
      sse.end();
    });
    if (!ok) { report('arm_skipped', { label, reason: 'SSE runtime warm-up did not produce a session.snapshot (cold runtime open failed or timed out)' }); sse.destroy(); return null; }
  }
  const pathname = method === 'messages' ? `/sessions/${fx.id}/messages`
    : method === 'questions' ? `/sessions/${fx.id}/questions`
      : method === 'detail' ? `/sessions/${fx.id}`
        : method === 'export' ? `/sessions/${fx.id}/export` : `/sessions/${fx.id}`;
  const accept = method === 'export' ? 'text/html' : 'application/json';
  const before = (await sampler.sample([pid])).get(pid);
  const t0 = Date.now();
  const outcome = await rawGet(worker.port, pathname, { abortAfterMs, token, accept, collectBytes: true });
  const afterRequest = (await sampler.sample([pid])).get(pid);
  const quiet = await watchQuiet(sampler, pid, { maxMs: 12000 });
  const hostAfter = await hostStatus(base.port).catch(() => null);
  if (sse) sse.destroy();
  const arm = {
    label, kind, method, abortAfterMs, withCwd, warmEvents,
    fileBytes: (await stat(fx.file)).size,
    aborted: outcome.aborted, statusCode: outcome.statusCode, note: outcome.note,
    clientBytes: outcome.bytes, responseSha1: outcome.sha1 ?? null, bodyHint: outcome.raw?.slice(0, 200) ?? null,
    clientWallMs: Date.now() - t0,
    busyCpuMs: before && afterRequest ? Number((afterRequest.cpuMs - before.cpuMs).toFixed(1)) : null,
    residualCpuMs: quiet.cpuMs,
    totalCpuMs: before && quiet.endCpuMs ? Number((quiet.endCpuMs - before.cpuMs).toFixed(1)) : null,
    rssBaselineMiB: quiet.rssStart ? Number((quiet.rssStart / 1048576).toFixed(1)) : null,
    rssDeltaMiB: quiet.rssStart ? Number(((quiet.rssPeak - quiet.rssStart) / 1048576).toFixed(1)) : null,
    cacheAfter: hostAfter?.memoryPolicy?.caches?.readonlyMessages ?? null,
    trail: quiet.trail.slice(0, 30),
  };
  raw.arms.push(arm);
  report('arm', arm);
  return arm;
}

const ARMS = {
  'messages-cold-full': { method: 'messages', abortAfterMs: null, kind: 'm-full' },
  'messages-cold-abort-50': { method: 'messages', abortAfterMs: 50, kind: 'm-a50' },
  'messages-cold-abort-200': { method: 'messages', abortAfterMs: 200, kind: 'm-a200' },
  'messages-hot-full': { method: 'messages', abortAfterMs: null, kind: 'm-hot-full', withCwd: true, warmEvents: true },
  'messages-hot-abort-50': { method: 'messages', abortAfterMs: 50, kind: 'm-hot-a50', withCwd: true, warmEvents: true },
  'questions-cold-full': { method: 'questions', abortAfterMs: null, kind: 'q-full' },
  'questions-cold-abort-50': { method: 'questions', abortAfterMs: 50, kind: 'q-a50' },
  'detail-cold-full': { method: 'detail', abortAfterMs: null, kind: 'd-full' },
  'detail-cold-abort-50': { method: 'detail', abortAfterMs: 50, kind: 'd-a50' },
  'export-abort-200': { method: 'export', abortAfterMs: 200, kind: 'e-a200' },
};

const selected = options.arms ?? [...Object.keys(ARMS), 'amp8-messages-abort-50', 'chain8-gap400-abort-50', 'tree4-abort-200'];
const results = {};
let fixture = null;
let deadline;
let sampler;
try {
  deadline = setTimeout(() => { report('deadline', { timeoutSeconds: options.timeoutSeconds }); process.exitCode = 3; process.exit(); }, options.timeoutSeconds * 1000);
  deadline.unref?.();
  sampler = createProcessSampler();

  fixture = await pickFixtureFile();
  if (!fixture.source) {
    report('fixture_note', { note: `no real session ≥ ${MIN_FIXTURE_BYTES} bytes under ${path.join(REAL_PROFILE, 'sessions')}; falling back to a synthetic ~32 MiB same-shape fixture`, real: false });
  }
  raw.fixture = { source: fixture.source, real: fixture.real, bytes: fixture.bytes ?? null };

  for (const label of selected) {
    const spec = ARMS[label];
    if (!spec) { report('arm_skipped', { label, reason: 'unknown arm' }); continue; }
    results[label] = await withSandbox((sandbox) => measureArm({ label, ...spec, sampler, sandbox, fixture }));
  }

  // 放大链：8 发「冷读 + 50 ms 放弃」**紧贴**在同一沙箱里（每发新夹具 ⇒ 全是缓存未命中），
  // 形状 = 前端退避链「同一份工作被重算 N 次」。
  // ⚠️ 这一臂的间隔只有 120 ms，**是对产品最有利的形状**（实测：紧贴 0/8 发算完；隔 400 ms 的
  // `chain8-gap400-abort-50` 在旧默认 50 ms 档 7/8 发把整份算完）。两条都在，别把这条当成「链就没问题了」。
  if (selected.includes('amp8-messages-abort-50')) {
    results['amp8-messages-abort-50'] = await withSandbox(async (sandbox) => {
      const { worker, token, pid, sessionsRoot } = sandbox;
      const before = (await sampler.sample([pid])).get(pid);
      const per = [];
      for (let index = 0; index < 8; index += 1) {
        const [fx] = await materializeFixture(fixture, sessionsRoot, null, [`amp${index}`]);
        const t0 = Date.now();
        const outcome = await rawGet(worker.port, `/sessions/${fx.id}/messages`, { abortAfterMs: 50, token });
        per.push({ aborted: outcome.aborted, wallMs: Date.now() - t0, clientBytes: outcome.bytes });
        await sleep(120);
      }
      const quiet = await watchQuiet(sampler, pid, { maxMs: 20000 });
      const arm = { label: 'amp8-messages-abort-50', per, totalCpuMs: before && quiet.endCpuMs ? Number((quiet.endCpuMs - before.cpuMs).toFixed(1)) : null, rssBaselineMiB: quiet.rssStart ? Number((quiet.rssStart / 1048576).toFixed(1)) : null, rssDeltaMiB: quiet.rssStart ? Number(((quiet.rssPeak - quiet.rssStart) / 1048576).toFixed(1)) : null };
      raw.arms.push(arm); report('arm', arm); return arm;
    });
  }

  // 「退避链」的**真实间隔**形状：8 发「新夹具 + 50 ms 放弃」，每发之间**隔 400 ms**（不是紧贴的 120 ms）。
  // 为什么必须单独一臂：紧贴的 amp8 是对产品最有利的形状 —— 2026-09-25 实测（新默认 10 ms 之前）：
  // 紧贴 0/8 发算完，隔 400 ms **7/8 发把整份 61.7 MB 算完并写进响应体缓存**（worker 自己
  // `/metrics` 记到写出去 432,165,153 B），而**当时门里没有任何断言会红**。
  // 这一臂的判据不看采样噪声，只看两个**事实**（都不需要抽样统计）：
  //   · 有没有哪一发把正文写进了响应体缓存（`/host.memoryPolicy.caches.readonlyMessages.items` 涨了）；
  //   · worker 在这条路由上**写出去多少字节**（`/metrics` 自己数的；一发正文 61 MB）。
  if (selected.includes('chain8-gap400-abort-50')) {
    results['chain8-gap400-abort-50'] = await withSandbox(async (sandbox) => {
      const { worker, token, pid, sessionsRoot } = sandbox;
      const workerHeaders = { 'x-sopho-worker-token': token };
      const routeBytes = async () => {
        const metrics = (await request(worker.port, '/metrics', { headers: workerHeaders })).value;
        return (metrics?.routes ?? []).find((row) => row.pattern === '/sessions/:id/messages')?.bytes ?? 0;
      };
      const cacheItems = async () => (await request(worker.port, '/host', { headers: workerHeaders })).value?.memoryPolicy?.caches?.readonlyMessages?.items ?? null;
      const bytesBefore = await routeBytes();
      const itemsBefore = await cacheItems();
      const before = (await sampler.sample([pid])).get(pid);
      const per = [];
      for (let index = 0; index < 8; index += 1) {
        const [fx] = await materializeFixture(fixture, sessionsRoot, null, [`ch${index}`]);
        const cacheBefore = await cacheItems();
        const t0 = Date.now();
        const outcome = await rawGet(worker.port, `/sessions/${fx.id}/messages`, { abortAfterMs: 50, token });
        await sleep(150); // 给这一发一个落定窗口（算完的话要 600-800 ms；这里只够看见「早停」）
        const cacheAfter = await cacheItems();
        per.push({
          aborted: outcome.aborted, wallMs: Date.now() - t0, clientBytes: outcome.bytes,
          cacheItemsBefore: cacheBefore, cacheItemsAfter: cacheAfter,
          wroteBody: cacheBefore !== null && cacheAfter !== null && cacheAfter > cacheBefore,
        });
        await sleep(400); // 与「前端退避链」同形状的间隔
      }
      const quiet = await watchQuiet(sampler, pid, { maxMs: 20000 });
      // ⚠️ `routeBytesWritten` 必须在静默窗**之后**读：算完的那一发可能晚到这个窗口里才写完。
      const routeBytesWritten = (await routeBytes()) - bytesBefore;
      const itemsAfter = await cacheItems();
      const arm = {
        label: 'chain8-gap400-abort-50', gapMs: 400, per,
        completedReads: per.filter((entry) => entry.wroteBody).length,
        routeBytesWritten,
        cacheItemsBefore: itemsBefore, cacheItemsAfter: itemsAfter,
        cacheItemsGrown: itemsBefore !== null && itemsAfter !== null && itemsAfter > itemsBefore,
        totalCpuMs: before && quiet.endCpuMs ? Number((quiet.endCpuMs - before.cpuMs).toFixed(1)) : null,
        rssBaselineMiB: quiet.rssStart ? Number((quiet.rssStart / MIB).toFixed(1)) : null,
        rssDeltaMiB: quiet.rssStart ? Number(((quiet.rssPeak - quiet.rssStart) / MIB).toFixed(1)) : null,
      };
      raw.arms.push(arm); report('arm', arm); return arm;
    });
  }

  // /tree 的放大链（共享索引：放弃应当接着往前跑，不是从零重来）。
  if (selected.includes('tree4-abort-200')) {
    results['tree4-abort-200'] = await withSandbox(async (sandbox) => {
      const { worker, token, pid } = sandbox;
      const before = (await sampler.sample([pid])).get(pid);
      const per = [];
      for (let index = 0; index < 4; index += 1) { const outcome = await rawGet(worker.port, '/tree', { abortAfterMs: 200, token }); per.push({ aborted: outcome.aborted, bytes: outcome.bytes }); await sleep(300); }
      const quiet = await watchQuiet(sampler, pid, { maxMs: 20000 });
      const arm = { label: 'tree4-abort-200', per, totalCpuMs: before && quiet.endCpuMs ? Number((quiet.endCpuMs - before.cpuMs).toFixed(1)) : null };
      raw.arms.push(arm); report('arm', arm); return arm;
    });
  }

  // ───────────────────────── 判据 ─────────────────────────
  if (options.assert) {
    const checks = [];
    const check = (id, ok, detail, evidence) => { checks.push({ id, ok, detail, evidence }); report('check', { id, ok, detail, evidence }); };
    const full = results['messages-cold-full'];
    const a50 = results['messages-cold-abort-50'];
    const hotFull = results['messages-hot-full'];
    const hotA50 = results['messages-hot-abort-50'];
    const amp = results['amp8-messages-abort-50'];

    check('FIXTURE-1-full-read-is-expensive', Boolean(full && full.statusCode === 200 && full.totalCpuMs >= 400),
      `夹具必须真的贵：整发冷读 CPU 须 ≥ 400 ms（实测 ${full?.totalCpuMs} ms / ${full?.fileBytes} B 文件 / ${full?.clientBytes} B 响应体）；否则这门什么都没测到`,
      { fullCpuMs: full?.totalCpuMs, fileBytes: full?.fileBytes, responseBytes: full?.clientBytes });

    if (full && a50) {
      const cap = Math.max(300, Number((full.totalCpuMs * 0.5).toFixed(1)));
      check('ABANDON-1-cold-read-stops', a50.totalCpuMs <= cap,
        `abort@50 之后这发总 CPU（含放弃前）须 ≤ max(300, 整发×0.5) = ${cap} ms；实测 ${a50.totalCpuMs} ms（整发 ${full.totalCpuMs} ms）⇒ 白烧 ${a50.residualCpuMs} ms`,
        { capMs: cap, fullCpuMs: full.totalCpuMs, abortCpuMs: a50.totalCpuMs, residualCpuMs: a50.residualCpuMs, abortRssDeltaMiB: a50.rssDeltaMiB, fullRssDeltaMiB: full.rssDeltaMiB });
      check('ABANDON-2-abandoned-read-does-not-pollute-cache', (a50.cacheAfter?.items ?? 0) === 0,
        `被放弃的冷读不许把 61 MB 写进响应体缓存（写了就是「没人要的 61 MB 常驻」）；实测 readonlyMessages.items=${a50.cacheAfter?.items}`,
        { cacheAfterAbort: a50.cacheAfter, cacheAfterFull: full.cacheAfter });
      const fileMiB = (full.fileBytes ?? 0) / MIB;
      // 门限口径（2026-09-25 重标，依据见 docs/abandoned-request-cost.md）：
      //   · **删掉了「整发增量×0.5」那一项** —— 静默窗是从**请求返回之后**才开始采样的，整发那一次的
      //     RSS 增长那时已经发生完了 ⇒ 这一项 12/12（旧实测）恒为 0，是**死代码**；它挂在公式里只会
      //     让人以为还有一条相对判据。
      //   · 绝对线 64 MiB 改成**相对夹具**：这一段 RSS 增量的物理下界就是「把这份文件读进内存」本身
      //     （本机 35.5 MiB 夹具：`readFile` +61.1 MiB、`split` +58.9 MiB），所以固定常数会在夹具尺寸
      //     变化时失真。实测（修后 n=22）：中位 24.3 MiB、最大 73.6 MiB = 2.07×夹具；取 3×（留 45% 余量）。
      const rssCapMiB = Math.max(64, Number((3 * fileMiB).toFixed(1)));
      check('ABANDON-3-abandon-does-not-cost-memory', (a50.rssDeltaMiB ?? 0) <= rssCapMiB,
        `abort@50 的 RSS 增量须 ≤ max(64 MiB, 3×夹具 MiB) = ${rssCapMiB} MiB（夹具 ${fileMiB.toFixed(1)} MiB）；实测 放弃 ${a50.rssDeltaMiB} MiB`,
        { capMiB: rssCapMiB, fileMiB: Number(fileMiB.toFixed(1)), abortRssDeltaMiB: a50.rssDeltaMiB, fullRssDeltaMiB: full.rssDeltaMiB, note: '旧公式 max(64, 整发×0.5) 的整发那一项已删（恒为 0 的死代码）；绝对线 64 MiB 改成相对夹具 3×夹具 MiB' });
    }
    if (hotFull && hotA50) {
      const cap = Math.max(300, Number((hotFull.totalCpuMs * 0.5).toFixed(1)));
      check('ABANDON-4-hot-read-stops', hotA50.totalCpuMs <= cap,
        `热读（runtime 已开）abort@50 的总 CPU 须 ≤ max(300, 热读整发×0.5) = ${cap} ms；实测 ${hotA50.totalCpuMs} ms（整发热读 ${hotFull.totalCpuMs} ms）`,
        { capMs: cap, hotFullCpuMs: hotFull.totalCpuMs, hotAbortCpuMs: hotA50.totalCpuMs, residualCpuMs: hotA50.residualCpuMs });
    }
    if (amp && full) {
      const cap = Number((8 * full.totalCpuMs * 0.35).toFixed(1));
      check('ABANDON-5-retry-chain-does-not-recompute', amp.totalCpuMs <= cap,
        `8 发「冷读 + 50 ms 放弃」（模拟退避链重算）总 CPU 须 ≤ 8×整发×0.35 = ${cap} ms；实测 ${amp.totalCpuMs} ms`,
        { capMs: cap, ampTotalCpuMs: amp.totalCpuMs, fullCpuMs: full.totalCpuMs, per: amp.per });
    }
    const chain = results['chain8-gap400-abort-50'];
    if (chain) {
      // 门限是**精确的 0**，不是抽样统计：这两条就是「放弃 = 没算」的定义本身（实测：修后 80 发 -
      // 默认档 0 发算完 / 写出去 0 B；旧默认 50 ms 档 6-7/8 发算完、写出去 ~432 MB）。
      // 1 MiB 的宽容只为了容忍「真回了一条短错误响应」这种良性别扭，绝不容忍 61 MB 的正文。
      check('ABANDON-6-gap400-chain-never-finishes', chain.completedReads === 0 && chain.routeBytesWritten < MIB,
        `8 发「冷读 + 50 ms 放弃」（每发隔 ${chain.gapMs} ms）里不许有任何一发把正文算完/写出去：须 0 发写缓存 且 这条路由写出去 < 1 MiB；实测 ${chain.completedReads}/8 发写了响应体缓存（cacheItems ${chain.cacheItemsBefore}→${chain.cacheItemsAfter}），这条路由写出去 ${chain.routeBytesWritten} B`,
        { gapMs: chain.gapMs, completedReads: chain.completedReads, routeBytesWritten: chain.routeBytesWritten, cacheItemsGrown: chain.cacheItemsGrown, per: chain.per.map(({ wallMs, clientBytes, wroteBody }) => ({ wallMs, clientBytes, wroteBody })) });
    }
    const ok = checks.filter((entry) => entry.ok).length;
    raw.checks = checks;
    report('summary', { checks: checks.map(({ id, ok: good }) => ({ id, ok: good })), passed: ok, failed: checks.length - ok, reverse: options.reverse });
    if (options.json) await writeFile(path.resolve(options.json), `${JSON.stringify(raw, null, 2)}\n`);
    if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
  } else {
    if (options.json) await writeFile(path.resolve(options.json), `${JSON.stringify(raw, null, 2)}\n`);
    report('summary', { mode: 'report-only', arms: raw.arms.map((arm) => ({ label: arm.label, totalCpuMs: arm.totalCpuMs, residualCpuMs: arm.residualCpuMs ?? null, rssDeltaMiB: arm.rssDeltaMiB ?? null, aborted: arm.aborted ?? null })) });
  }
} catch (error) {
  process.stderr.write(`abandoned-request-cost crashed: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
} finally {
  clearTimeout(deadline);
  await sampler?.stop?.();
}
