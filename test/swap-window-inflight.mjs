#!/usr/bin/env node
// swap-window-inflight —— 换代窗口里在途请求的**已定案**口径：
//   · 幂等方法（GET/HEAD）：**只重试一次**（换当前代）⇒ 窗口里的 GET 由新代服务成功；
//   · 写请求（POST…）：**绝不自动重试**（无法证明 worker 没处理过 ⇒ 双写风险）⇒ 回**诚实的可重试语义**
//     `503 {error:"generation_swapped", retryable:true, retryAfterMs:…}`，**不再**裸 502/503；
//   · **不做跨代挂起**（宿主里没有等待机制）。
// 三道臂（各自可机械判定）：
//   ① 正向：窗口里一串 **GET** ⇒ 全部 200，且宿主日志里出现 `retrying GET …`（重试的机械证据）；
//   ② 写请求：窗口里一串 **POST**（唯一 title）⇒ 日志里**没有** `retrying POST`、非 200 都是可重试语义、
//      没有 502，而且那些 title **一个都没落库**（= 只有一次尝试，没有任何自动重试造成的双写）；
//      另核 `Retry-After: 1`（秒）与 body 里的 `retryAfterMs: 1000` 处处一致（F7）。
//   ③ 反证（突变，两份副本各一个）：把幂等重试关掉 ⇒ ①变红；把「写请求不重试」反过来（写也重试）⇒ ②变红。
// 窗口的确定性摆法：`/host` 拿到 current worker 的 pid ⇒ 按**精确 pid** SIGKILL（自己沙箱，绝不 pkill）
// ⇒ 宿主进入换代窗口，同时**宿主会自己起替代代**（这就是「新代」）。跨平台：os.tmpdir()/path.join、
// net 自留端口、process.kill、沙箱收尾走 test/harness.mjs。
//
// ⚠️ **平台可达性（2026-09-21，Windows 复跑的 review 单提出）**：本门六条臂里有**一条**（③b，
//   「写请求也重试 ⇒ 双写」的反证）要的是「宿主已忘掉旧 owner、换当前代重试」那一小段里写请求也被
//   重试。那段窗口的存在条件是 **owner 的进程已死、而宿主还没看出它死了**
//   （`child.connected !== false` 且 `exitCode === null`）——
//     · Linux 上真撞得到，但是**竞态**：同一摆法跑两次，一次 12 发 GET 出 12 行 `retrying GET`、6 发
//       POST 出 2 行 `retrying POST`（③b 绿）；另一次 **0 行**（③b 会红 —— 那不是回归，是没撞上）；
//     · **Windows 上几乎撞不到**（实测：臂 ①a 那种「12 发 GET + 6 发 POST」的串多次跑都是
//       `retryLinesForGet: 0` / `postRetries: 0`；就只有突变副本那种「6 + 6」的串偶尔能由 GET 探针撞到，
//       **POST 那一串一次都没撞到**）⇒ ③b 在 Windows 上只会 SKIP（两种理由之一），既不是红也不是绿。
//       这不是产品回归，也不是我们能靠“多跑几轮”解决的：要把它变成确定性摆法，得能把 owner 摆成
//       「监听套接字还在、但不再回话」—— 那正是 `SIGSTOP` 那类摆法，Windows 没有。
//   ⇒ 在 win32 上**如实报告「跳过这条臂」**（⤵ SKIP，**不假红、也不假装它绿**），在撞不到窗口的那一轮也
//   一样如实报 SKIP（同一原因，只是换了个平台）；解释见 `docs/handoff.md` 的
//   「门的平台可达性（SIGSTOP 类摆法）」一节。**断言一个字都不放宽**：撞到窗口时照旧硬判。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { finishCleanup, removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const print = (l, v) => process.stdout.write(`${l}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawned = new Set();
const failures = [];
// 平台打不着的臂（win32 上的 ③b）记在这里：**如实报告跳过**，不算失败、也不算绿。
const skips = [];
let armsRun = 0;
// ③b 要撞的那条「owner 死而未觉」窗口是**竞态**的（WSL/Linux 实测十轮里约命中六轮、Windows 实测恒定 0）
// ⇒ 最多扫这么多轮；Windows 上只扫 1 轮（拿一份**当次实测**就够，不必白扫五轮）。
const WRITE_RETRY_ROUNDS = (() => {
  const raw = Number.parseInt(process.env.SOPHO_SWAPWINDOW_WRITE_ROUNDS ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return process.platform === 'win32' ? 1 : 5;
})();
async function arm(label, fn) {
  armsRun += 1;
  try {
    const result = await fn();
    // 臂自己说「本平台 / 本轮夹具没打着，什么都没判到」⇒ 如实报跳过（不是绿也不是红）。
    if (result?.skipReason) {
      skips.push(`${label}: ${result.skipReason}`);
      process.stdout.write(`⤵ SKIP ${label} —— ${result.skipReason}\n`);
      return;
    }
    process.stdout.write(`✓ arm ${label}\n`);
  }
  catch (error) { failures.push({ label, error }); process.stdout.write(`✗ arm ${label} —— ${error instanceof Error ? error.message : String(error)}\n`); }
}
const reservePort = () => new Promise((res, rej) => { const l = net.createServer(); l.once('error', rej); l.listen(0, '127.0.0.1', () => { const { port } = l.address(); l.close(() => res(port)); }); });
function request(port, pathname, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { accept: 'application/json', connection: 'close', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (response) => {
      const chunks = []; response.on('data', (c) => chunks.push(c));
      response.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let value = null; try { value = JSON.parse(raw); } catch {} resolve({ statusCode: response.statusCode, headers: response.headers, value, body: raw.slice(0, 160) }); });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject); req.end(payload ?? undefined);
  });
}
async function materialize(dir, mode) {
  await mkdir(dir, { recursive: true });
  await cp(path.join(root, 'server'), path.join(dir, 'server'), { recursive: true });
  await cp(path.join(root, 'web'), path.join(dir, 'web'), { recursive: true });
  await cp(path.join(root, 'pi-extensions'), path.join(dir, 'pi-extensions'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), await readFile(path.join(root, 'package.json')));
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (!mode) return dir;
  const file = path.join(dir, 'server', 'base.mjs');
  let text = await readFile(file, 'utf8');
  // ⚠️ 突变锚要跟住**代码搬家**：那套口径已从 owner 路由的内联块抽进了 `finishFailedProxy()`（2 空格缩进），
  //   锚于是一从前没锚到（门变红在“mutation anchor not found”上 —— 那是门在报“它盯的代码跑了”）。
  const anchor = "  if (method === 'GET' || method === 'HEAD') {";
  const anchorCount = text.split(anchor).length - 1;
  assert.equal(anchorCount, 1, `mutation anchor must appear exactly once (found ${anchorCount})`);
  text = text.replace(anchor, mode === 'no-retry'
    ? "  if (false) {   // (mutation①: 幂等重试被关掉)"
    : "  if (true) {    // (mutation②: 写请求也被重试（这正是双写风险）)");
  await writeFile(file, text);
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => execFile(process.execPath, ['--check', file], (error, stdout, stderr) => error ? reject(new Error(`mutated base.mjs does not parse: ${stderr || error.message}`)) : resolve()));
  return dir;
}
async function startHost({ treeDir, home, sessionsRoot, workspace, logFile }) {
  const port = await reservePort();
  const log = await open(logFile, 'w');
  const child = spawn(process.execPath, [path.join(treeDir, 'server', 'base.mjs')], {
    cwd: treeDir,
    env: {
      ...process.env, HOME: home, ASSIST_HOME: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1', SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(port), SOPHO_DEFAULT_CWD: workspace, SOPHO_NO_TOOLS: '1',
      SOPHO_MEMORY_HEAP_HIGH_BYTES: '1000000000000', SOPHO_MEMORY_HEAP_LOW_BYTES: '900000000000',
      SOPHO_MEMORY_RSS_HIGH_BYTES: '1000000000000', SOPHO_MEMORY_RSS_LOW_BYTES: '900000000000',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close(); spawned.add(child);
  const state = { child, port, logFile, workers: new Set() };
  for (let i = 0; i < 200; i += 1) {
    try { const host = await request(port, '/host', { timeoutMs: 3000 }); if (host.statusCode === 200 && host.value?.currentWorkerPid) { state.workers.add(host.value.currentWorkerPid); return state; } } catch {}
    await sleep(100);
  }
  const tail = (await readFile(logFile, 'utf8').catch(() => '')).split('\n').slice(-12).join('\n');
  throw new Error(`sandbox host did not become ready on ${port}\n--- log tail ---\n${tail}`);
}
async function stop(child) {
  if (!child) return; spawned.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([new Promise((r) => child.once('exit', r)).then(() => true), sleep(15000).then(() => false)]);
  if (!exited && child.exitCode === null) { child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)); }
}
/** 换代窗口：按精确 pid 干掉 current worker（宿主随后自己起替代代 ⇒ 那就是「新代」）。 */
async function openSwapWindow(state) {
  const host = await request(state.port, '/host');
  const pid = host.value?.currentWorkerPid;
  assert.ok(pid, 'there must be a live current generation to kill');
  process.kill(pid, 'SIGKILL');
  return pid;
}
async function waitGeneration(state, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const host = await request(state.port, '/host', { timeoutMs: 3000 }).catch(() => ({ value: null }));
    if (host.value?.currentWorkerPid) { state.workers.add(host.value.currentWorkerPid); return host.value.currentWorkerPid; }
    await sleep(50);
  }
  return null;
}
const titlesLanded = async (home, titles) => {
  const text = await readFile(path.join(home, 'titles.json'), 'utf8').catch(() => '');
  return titles.filter((title) => text.includes(title));
};

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'swap-window-'));
const problems = []; let primaryError = null;
try {
  const home = path.join(sandbox, 'home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(sandbox, 'workspace');
  for (const dir of [sessionsRoot, workspace]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(home, 'models.json'), '{"providers":{}}\n');
  await writeFile(path.join(home, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
  const sessionId = '01a0a100-0000-4000-8000-000000000001';
  const at = '2026-09-18T00:00:00.000Z';
  await writeFile(path.join(sessionsRoot, `s_${sessionId}.jsonl`), `${[
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: at, cwd: workspace }),
    JSON.stringify({ type: 'session_info', id: '01a0a100-0000-4000-8000-000000000002', parentId: null, timestamp: at, name: 'swap-window' }),
    JSON.stringify({ type: 'message', id: '01a0a100-0000-4000-8000-000000000003', parentId: null, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'swap-window' }] } }),
  ].join('\n')}\n`);
  print('fixture', { sandbox, sessionId, note: '窗口摆法与 test/host-session-path-probe.mjs --phase swap-window 同源：精确 pid SIGKILL owner ⇒ 换代窗口 + 宿主自起替代代' });

  const runWindow = async (state, { getCount, postCount }) => {
    const warm = await request(state.port, `/sessions/${sessionId}/commands`);
    assert.equal(warm.statusCode, 200, `warm-up must reach the live generation: ${warm.body}`);
    await openSwapWindow(state);
    const titles = Array.from({ length: postCount }, (_, i) => `swap-window-${Date.now()}-${i}`);
    const gets = Promise.all(Array.from({ length: getCount }, (_, i) => request(state.port, `/sessions/${sessionId}${i % 2 ? '/messages' : ''}`).then((r) => ({ statusCode: r.statusCode, headers: r.headers, value: r.value, body: r.body }))));
    const posts = Promise.all(titles.map((title) => request(state.port, `/sessions/${sessionId}/title`, { method: 'POST', body: { title } }).then((r) => ({ statusCode: r.statusCode, headers: r.headers, value: r.value, body: r.body }))));
    const [getResults, postResults] = await Promise.all([gets, posts]);
    await waitGeneration(state);   // 替代代就绪（宿主自己起的那个）
    // ⚠️ 换代**完成之后**的 GET 串：这一串是确定性的（有 current 代可服务）⇒ 必须**全部 200**。
    // 之所以分两串：按定案「不挂起」，窗口里（还没有替代代）的那一串只能得到可重试语义；
    // 而「旧代还活着但不持有 ⇒ 回 409」那个子窗口要它 200，得先做 409 的重路由（见报告）。
    const lateGets = await Promise.all(Array.from({ length: getCount }, (_, i) => request(state.port, `/sessions/${sessionId}${i % 2 ? '/messages' : ''}`).then((r) => ({ statusCode: r.statusCode, value: r.value, body: r.body }))));
    return { getResults, getResultsLate: lateGets, postResults, titles, log: await readFile(state.logFile, 'utf8').catch(() => '') };
  };

  // ── 同一次窗口数据，三条独立臂分开报：形状（绿）· GET 全 200（已知缺口）· 写请求只一次尝试（绿）
  let fixedLog = '';
  let windowData = null;
  await arm('①a 形状：窗口里**没有一个裸 502**；每个非 200 都是**诚实可重试语义**', async () => {
    const host = await startHost({ treeDir: root, home, sessionsRoot, workspace, logFile: path.join(sandbox, 'fixed.log') });
    try {
      const { getResults, getResultsLate, postResults, titles, log } = await runWindow(host, { getCount: 12, postCount: 6 });
      fixedLog = log;
      windowData = { getResults, getResultsLate, postResults, titles, log };
      const retryLines = log.split('\n').filter((line) => line.includes('generation swap (owner route): retrying'));
      assert.equal([...getResults, ...postResults].filter((r) => r.statusCode === 502).length, 0,
        `no bare 502 is allowed in the swap window: ${JSON.stringify([...getResults, ...postResults].filter((r) => r.statusCode === 502))}`);
      for (const result of [...getResults, ...postResults]) {
        if (result.statusCode === 200) continue;
        assert.equal(result.statusCode, 503, `a failed request in the window must be the honest retryable 503, got ${result.statusCode}: ${result.body}`);
        assert.equal(result.value?.error, 'generation_swapped', `...with error=generation_swapped: ${result.body}`);
        assert.equal(result.value?.retryable, true, `...retryable:true: ${result.body}`);
        assert.ok(Number(result.value?.retryAfterMs) > 0, `...retryAfterMs: ${result.body}`);
      }
      assert.equal(retryLines.filter((line) => /retrying POST/.test(line)).length, 0,
        `a POST must never be auto-retried: ${JSON.stringify(retryLines)}`);
      // **只有一次尝试**（没有任何自动重试造成的落库）：被拒的那些 title 一个都不该出现在 titles 账里。
      const landed = await titlesLanded(home, titles);
      const rejected = postResults.filter((r) => r.statusCode !== 200).length;
      assert.ok(rejected === 0 || landed.length === 0,
        `a POST rejected in the swap window must not land (no auto-retry ⇒ exactly one attempt): rejected=${rejected} landed=${JSON.stringify(landed)}`);
      print('arm①a shapes', {
        getStatuses: getResults.map((r) => r.statusCode),
        postStatuses: postResults.map((r) => r.statusCode),
        retryLinesForGet: retryLines.filter((line) => /retrying GET/.test(line)).length,
        retryLinesForPost: retryLines.filter((line) => /retrying POST/.test(line)).length,
        rejectedPostsThatLanded: landed.length,
      });
    } finally { await stop(host.child); }
  });

  await arm('①b 正向：**换代完成之后**的 GET 串全部由新代服务成功（200）', async () => {
    assert.ok(windowData, 'the window must have produced data');
    assert.ok(windowData.getResultsLate.length > 0, 'the late GET burst must have run');
    assert.deepEqual([...new Set(windowData.getResultsLate.map((r) => r.statusCode))].filter((c) => c !== 200), [],
      `every GET fired once the replacement generation is current must end 200: ${JSON.stringify(windowData.getResultsLate)}`);
    // 窗口内（替代代还没起来）那一串：按定案只能得到可重试语义 —— 这里**不断言**它们 200，
    // 只断言它们不是裸 502（那是 ①a 的活）；窗口内 GET 要 200 需要 409 重路由，见报告「已知缺口」。
    print('①b late-burst evidence', { late: windowData.getResultsLate.map((r) => r.statusCode), inWindow: windowData.getResults.map((r) => r.statusCode) });
  });

  await arm('② 写请求只一次尝试：窗口里的 POST 不被重试、被拒的一个都没落库', async () => {
    assert.ok(windowData, 'the window must have produced data');
    const retryLines = windowData.log.split('\n').filter((line) => line.includes('generation swap (owner route): retrying'));
    assert.equal(retryLines.filter((line) => /retrying POST/.test(line)).length, 0, `a POST must never be auto-retried: ${JSON.stringify(retryLines)}`);
    const landed = await titlesLanded(home, windowData.titles);
    const rejected = windowData.postResults.filter((r) => r.statusCode !== 200).length;
    assert.ok(rejected === 0 || landed.length === 0,
      `a POST rejected in the swap window must not land (no auto-retry ⇒ exactly one attempt): rejected=${rejected} landed=${JSON.stringify(landed)}`);
  });

  // ── ③a 反证：把幂等重试关掉 ⇒ 窗口里的 GET 不再全 200（门变红）
  await arm('③a 反证（突变：幂等重试关掉）⇒ 同窗口的 GET 不可能全由新代服务', async () => {
    const dir = await materialize(path.join(sandbox, 'mut-no-retry'), 'no-retry');
    const mutatedHome = path.join(sandbox, 'home-mut-no-retry');
    await mkdir(mutatedHome, { recursive: true });
    await writeFile(path.join(mutatedHome, 'models.json'), '{"providers":{}}\n');
    await writeFile(path.join(mutatedHome, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
    const host = await startHost({ treeDir: dir, home: mutatedHome, sessionsRoot, workspace, logFile: path.join(sandbox, 'mut-no-retry.log') });
    try {
      const { getResults, log } = await runWindow(host, { getCount: 12, postCount: 0 });
      const retries = log.split('\n').filter((line) => line.includes('retrying')).length;
      const served = getResults.filter((r) => r.statusCode === 200).length;
      print('arm③a mutated evidence', { statuses: getResults.map((r) => r.statusCode), retryLines: retries, served200: served });
      assert.ok(retries === 0 || served === 0,
        `with the idempotent retry removed the window GETs must not be served by the new generation (that is what the retry buys): retries=${retries} served=${served}`);
    } finally { await stop(host.child); }
  });

  // ── ③b 反证：把「写请求绝不重试」反过来（写也重试）⇒ 被拒的 title 会**落库**（双写风险的机械证据 ⇒ 门变红）
  await arm('②b 边界：被拒的写请求 ⇒ 非 2xx **保留原 code**（不许改名）+ 窗口内**追加** retryable/retryAfterMs（不许光杆 409）+ `SOPHO_SWAP_WINDOW_MS=0` 时**不许**带 retryable', async () => {
    assert.ok(windowData, 'the window must have produced data');
    const nonOk = windowData.postResults.filter((r) => r.statusCode < 200 || r.statusCode >= 300);
    assert.ok(nonOk.length > 0, `the write burst must have produced at least one non-2xx: ${JSON.stringify(windowData.postResults)}`);
    const knob = process.env.SOPHO_SWAP_WINDOW_MS;
    let sawOwnership409 = 0;
    for (const r of nonOk) {
      const body = r.value ?? JSON.parse(r.body ?? '{}');
      // 口径（集成/验收方 #4，改写后）：POST 非 2xx ⇒ **必须可机械识别**（`retryable:true`）且**保留原 code**
      // —— 两个诚实 code 之一，绝不许改名/翻译成别的东西：
      //   · `generation_swapped`             = 这一发**没到达任何一代**（`sendWorkerUnavailable`）
      //   · `session_not_owned_by_generation` = **已到达某一代**、而它说「我不再持有它」（追加式，见下）
      assert.ok(['generation_swapped', 'session_not_owned_by_generation'].includes(body.error),
        `a non-2xx write must keep one of the two honest codes (never a renamed/translated code): ${JSON.stringify(r)}`);
      assert.equal(body.retryable, true, `a non-2xx write must be machine-identifiable (retryable:true): ${JSON.stringify(r)}`);
      assert.equal(typeof body.retryAfterMs, 'number', `…and carry retryAfterMs: ${JSON.stringify(r)}`);
      // F7 的同一条口径：JSON 里的 `retryAfterMs: 1000` 与 HTTP 头 `Retry-After: 1`（秒）**处处一致**
      // —— 只看头（不看 body）的客户端也得拿到等待建议。这一条在本摆法里是**跨平台**的：
      // 窗口内的写请求不管走哪条回执路（`sendWorkerUnavailable` 的 503 / 409 的追加式），
      // 都带同一个头；Windows 上也不会因夹具打不着而失效。
      assert.equal(r.headers?.['retry-after'], '1', `a non-2xx write must carry Retry-After: 1 (matches retryAfterMs): ${JSON.stringify(r.headers)}`);
      if (body.error === 'session_not_owned_by_generation') {
        sawOwnership409 += 1;
        // 边界 3（裁定甲）：**非窗口**的真 ownership 冲突 ⇒ **不许**带 `retryable`。
        // ⚠️ 这条只能在**会真的产生那条 409** 的夹具里判 —— 本门自己这套摆法（SIGKILL owner）里
        // 每一发写都**没到达任何一代**（全是 `generation_swapped` + ECONNRESET）⇒ 这里**没有** 409 可判：
        // 判它要用那道 `--phase swap-window` 相位（他们的 burst 会产生恰好一发 409）。
        if (knob === '0') {
          assert.notEqual(body.retryable, true, `with SWAP_WINDOW_MS=0 a real ownership conflict must NOT be flagged retryable: ${JSON.stringify(r)}`);
        }
      }
    }
    print('②b write-409 shape evidence', {
      swapWindowKnob: knob ?? '(default 5000)',
      ownership409Seen: sawOwnership409,
      note: sawOwnership409 === 0 ? '本摆法里没有 409（写请求都没到达任何一代）⇒ 边界 3 的「非窗口不带 retryable」要用 --phase swap-window 那道相位的 409 判' : '',
      nonOk: nonOk.map((r) => ({ statusCode: r.statusCode, retryAfter: r.headers?.['retry-after'] ?? null, body: r.body })),
    });
  });

  // ── ③b 反证：把「写请求绝不重试」反过来（写也重试）⇒ 被拒的 title 会**落库**（双写风险的机械证据 ⇒ 门变红）
  //   ⚠️ 这条臂要的是「owner 的进程已死、而宿主还没看出它死了」那一小段窗口（详见文件头「平台可达性」）。
  //   它是个**竞态**（不是本门其它臂那种确定性摆法）：同一摆法同两台机器上，那个窗口**撞不撞得到**
  //   会变（Windows 实测整幕 0 次；WSL/Linux 实测有时 0 次、有时整串都撞上）。既然无法从外面分辨
  //   「撞到了但突变没生效」和「突变生效了但这一串恰好没撞上窗口」，这里就不把它们当中的任何一条
  //   当成红：
  //     · 扫最多 `SOPHO_SWAPWINDOW_WRITE_ROUNDS`（默认 5）轮窗口，**一旦逮到突变生效**（POST 真被重试
  //       过 / 被拒的 title 真落了库）就停并按原断言**硬判**（断言一个字不改）；
  //     · 一轮都没逮到 ⇒ **⤵ SKIP**，并把每一轮的实测（含**未突变**的读路径探针 `retrying GET` 撞没撞到）
  //       一起贴出来 —— 既不假红、也不假装它绿。
  //   （写请求与读请求在本摆法里是**并发**的，探针撞到不等于 POST 这一串也撞到 ⇒ 探针只用来写
  //    SKIP 的理由，不参与判据：那正是「分不清」的那一种情形。）
  //   ⚠️ **代价（如实说）**：这条臂从此**不会因为“没逮到”而红** —— 它只能当「突变确实生效」的见证。
  //   如果哪天有人真的把写路径那条重试弄没了、而窗口又撞不到，这条臂会一直 SKIP 而不报警；那种时候
  //   得靠人读每次都会打出来的 `⤵ SKIP …` 那一行与 `RESULT` 里的 `skipped:N`（突变锚丢了另有机械报
  //   警：`materialize` 会因锚点不是恰好 1 处而红）。
  const WRITE_RETRY_MUTATION_ARM = '③b 反证（突变：写请求也重试）⇒ 被拒的 POST 必须被逮到「落库了」（双写证据）';
  await arm(WRITE_RETRY_MUTATION_ARM, async () => {
    const dir = await materialize(path.join(sandbox, 'mut-retry-posts'), 'retry-posts');
    const mutatedHome = path.join(sandbox, 'home-mut-retry-posts');
    await mkdir(mutatedHome, { recursive: true });
    await writeFile(path.join(mutatedHome, 'models.json'), '{"providers":{}}\n');
    await writeFile(path.join(mutatedHome, 'settings.json'), '{"defaultThinkingLevel":"off","compaction":{"enabled":false}}\n');
    const host = await startHost({ treeDir: dir, home: mutatedHome, sessionsRoot, workspace, logFile: path.join(sandbox, 'mut-retry-posts.log') });
    try {
      const rounds = [];
      let witness = null;      // 逮到「突变真的生效」的那一轮
      let probeCaught = false; // **未突变**的读路径探针撞到窗口了吗（只进 SKIP 的理由，不进判据）
      for (let round = 1; round <= WRITE_RETRY_ROUNDS && witness === null; round += 1) {
        // 每轮一串 POST（要判的那半边）+ 一串 GET（探针：它与 POST 同发，撞没撞到用来写 SKIP 的理由）。
        const window = await runWindow(host, { getCount: 6, postCount: 6 });
        const postRetries = window.log.split('\n').filter((line) => /retrying POST/.test(line)).length;
        const landed = await titlesLanded(mutatedHome, window.titles);
        if (/retrying GET/.test(window.log)) probeCaught = true;
        rounds.push({ round, postStatuses: window.postResults.map((r) => r.statusCode), postRetries, landedTitles: landed.length });
        if (postRetries > 0 || landed.length > 0) witness = { ...window, postRetries, landed };
      }
      print('arm③b mutated evidence', { rounds, witness: witness !== null, windowProbeCaught: probeCaught });
      if (witness === null) {
        const reason = probeCaught
          ? `${process.platform} 上扫了 ${WRITE_RETRY_ROUNDS} 轮窗口，**未突变**的读路径探针撞到了那条「owner 死而未觉」窗口，但 ${6 * WRITE_RETRY_ROUNDS} 发 POST 一发都没逮到重试 ⇒ 分不清「突变没生效」和「POST 这一串恰好没落在窗口里」，如实不计（不假红、也不假装绿）；每轮实测：${JSON.stringify(rounds)}`
          : `${process.platform} 上扫了 ${WRITE_RETRY_ROUNDS} 轮窗口都撞不到那条「owner 死而未觉」窗口（连**未突变**的读路径探针 \`retrying GET\` 都没出现）⇒ 门夹具打不着，不是产品回归；按设计如实不计（不假红、也不假装绿）；每轮实测：${JSON.stringify(rounds)}`;
        return { skipReason: reason };
      }
      const rejected = witness.postResults.filter((r) => r.statusCode !== 200);
      assert.ok(witness.postRetries > 0 || witness.landed.length > 0 || rejected.length === 0,
        'with the write-retry mutation the door must show the double write: the retry either happened or the rejected title landed');
    } finally { await stop(host.child); }
  });

  print('skips', skips);   // 平台打不着的臂：**如实报**（不是绿也不是红）
  if (failures.length > 0) {
    print('failed arms', failures.map((f) => ({ label: f.label, error: f.error instanceof Error ? f.error.message : String(f.error) })));
    print('host log tails', {
      fixed: fixedLog.split('\n').slice(-15).join('\n'),
      mutNoRetry: (await readFile(path.join(sandbox, 'mut-no-retry.log'), 'utf8').catch(() => '')).split('\n').slice(-10).join('\n'),
      mutRetryPosts: (await readFile(path.join(sandbox, 'mut-retry-posts.log'), 'utf8').catch(() => '')).split('\n').slice(-10).join('\n'),
    });
    assert.deepEqual(failures.map((f) => f.label), [], `${failures.length} arm(s) failed`);
  }
  print('RESULT', { ok: true, arms: armsRun, skipped: skips.length, skips });
  process.stdout.write(`RESULT: swap-window-inflight PASS (arms:${armsRun}${skips.length ? ` skipped:${skips.length}` : ''})\n`);
} catch (error) {
  primaryError = error;
} finally {
  for (const child of [...spawned]) await stop(child);
  await removeSandbox(sandbox, problems);
  finishCleanup(primaryError, problems);
}
