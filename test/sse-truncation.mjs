#!/usr/bin/env node
// test/sse-truncation.mjs —— 「提早断流」这条**客户端报错**的服务端复现门 + 定性证据。
//
// ── 业主报的原话（逐字） ─────────────────────────────────────────────────────────────
//   Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>
//
// ── 溯源：这句不是本仓产生的（本仓 grep 0 命中），是 Python 侧 aiohttp 抛的 ────────────
//   · `aiohttp/http_parser.py` 的 `HttpPayloadParser.feed_eof()`：解析状态还是
//     `ParseState.PARSE_CHUNKED`（响应声明了 `Transfer-Encoding: chunked`）时直接
//       raise TransferEncodingError("Not enough data to satisfy transfer length header.")
//   · `aiohttp/client_proto.py` 的 `_response_eof()` 把它包成
//       ClientPayloadError(f"Response payload is not completed: {underlying_exc!r}")
//   · `TransferEncodingError` 继承 `BadHttpMessage`（`code = 400`）⇒ 那个 **400 不是 HTTP 状态码**，
//     是 aiohttp 给「响应报文不合法」这一类别的编号。**我们的服务端当时回的是 200**，不是 400。
//   ⇒ 触发条件只有一句：**响应头声明了 chunked，而连接在终止块 `0\r\n\r\n` 之前就没了。**
//     （同族但不同串：`ContentLengthError` = "Not enough data to satisfy content length header"，
//      那是声明了 Content-Length 的情形。）
//
// ── 这道门要钉什么 ────────────────────────────────────────────────────────────────
// 「SSE 的客户端在服务端收摊时，必须看到**干净收尾**（chunked 终止块），不是被掐断的流」——
// 判据是**原始字节**，不是「socket 关没关」（`res.end()` 在 keep-alive 上只补终止块、不关 socket，
// 对 aiohttp / EventSource 都算干净 EOF；与 `test/s1b-proxy.mjs` ④⑥ 同一口径）。
//
// 臂：
//   ① 检测器自检：合成上游**干净收尾** ⇒ 必须读出「有终止块」（绿）
//   ② 检测器自检：合成上游**中途 destroy** ⇒ 必须读出「无终止块」（绿）—— 检测器没牙这条先红
//   ③ 真 A + 真 B：`Accept: text/event-stream`，worker 被 SIGKILL ⇒ 必须干净收尾（今天已绿）
//   ④ 真 A + 真 B：`Accept: */*`（**aiohttp 的默认 Accept**），同一发 SIGKILL ⇒ 必须干净收尾
//      ⚠️ 2026-09-26 **之前**这一臂必红 = 业主报的那个错：宿主 `proxyToWorker` 用 **Accept 头**判「是不是 SSE」，
//        判成不是就走 `terminateDownstream` 的 `response.destroy()` ⇒ 掐断一条 chunked 流
//        ⇒ aiohttp 客户端拿到的正是那条 TransferEncodingError。修法已进产品（见下「修法①」）。
//   ⑤ SSE 挂着时按 pid 收掉 **B（`server/app.mjs`）** ⇒ 必须干净收尾。
//      ⚠️ 这一条的根**不在判据、在 B 的收摊路径**：`server.close()` 只**等**长活 SSE，
//      `closeIdleConnections()` 也不收「正在处理请求」的连接 ⇒ 末尾那次 `process.exit(0)`
//      直接把 chunked 流切断（2026-09-26 之前实测截断）。POSIX 上进程能听到信号；
//      Windows 上 `child.kill('SIGTERM')` 就是 `TerminateProcess`（`bin/stop-win.ps1` 用的也是
//      `taskkill /PID <pid> /T /F`），B 的 `shutdown()` 一行都不会跑 ⇒ 本臂把「信号有没有被听到」
//      当证据打出来，并据此决定判不判死。修法已进产品（见下「修法②」）。
//   ⑥ SSE 挂着时按 pid 收掉 **A（`server/base.mjs`）** ⇒ 必须干净收尾。今天**已绿**，但原因不是 A：
//      Windows 上 A 也是被硬杀的，客户端那条干净 EOF 是 **B 自己的 SSE 错误路 `sendSseSoftFailure`
//      → `response.end()`** 补上的（代价：客户端没有任何终止事件，只能看到一个“干净的结束”）。
//      ※ POSIX 上 A 才会跑自己的 shutdown（`closeAllConnections()` 在 2s 后把还开着的 SSE 一起掐掉）；
//      本机是 Windows，那条路**没验到**（见报告「没验到什么」）。
//   ⑦ **修法① 的针**（2026-09-26 起指向**产品自己**，不再打副本补丁）：客户端 `Accept: */*` 时
//      **按 pid SIGKILL 掉 A（`server/base.mjs` 那个进程）**，而不是杀 worker —— worker 死时 A 自己会先
//      给一个干净收尾，把 B 那条判据挡在后面。杀掉 A 之后「客户端看到什么」就只由 **B 自己**的判据决定
//      ⇒ 必须干净收尾（修好之前这里是 `response.destroy()` ⇒ 截断）。
//   ⑧ **修法② 的针**：真 B、SSE 挂着时按 pid 收掉 B ⇒ 必须干净收尾。
//      信号能被听到的平台（POSIX）上判据是「必须干净收尾」；Windows 上信号不可捕获
//      ⇒ 这一臂如实登记为「修法在本平台不可达」，不判死（它考的是 stop 路径，不是这段代码）。
//
// 跑法：
//   node test/sse-truncation.mjs              # 报告模式（默认；所有臂都跑、打印原始读数，退出 0）
//   node test/sse-truncation.mjs --assert     # 判据模式：③④⑤⑥⑨ 都必须干净收尾
//                                             #   （2026-09-26 起**全绿**；在那之前 ④⑤⑨ 红是设计如此、修法在宿主批）
//   node test/sse-truncation.mjs --reverse    # 反证臂（改的都是**副本**，仓库文件一字不动）：把「修法①/②」
//                                             #   在副本里**退回 Accept 头那套** ⇒ 门必须重新读到「被掐断」
//                                             #   （③⑥ 仍干净 / ④⑤⑦⑧⑨ 变截断）。读不出来就说明这条门没牙。
//   node test/sse-truncation.mjs --arms 3,4 --dump   # 只跑指定臂；--dump 打印原始响应字节
//
// 纪律：只起自己 spawn 的 A / B，只按**精确 pid** 停（绝不 pkill）；端口一律高位随机 + 127.0.0.1；
//       日志只写本次沙箱目录（绝不写 /tmp/sopho-base.log | sopho-app.log）；绝不碰真 profile。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { processAlive, processCommandLine, runArms } from './harness.mjs';
import { FORBIDDEN_PORTS, REPO_ROOT, readWorkerPortFromLog, sleep } from './perf-verify-lib.mjs';

const APP_ENTRY = path.join(REPO_ROOT, 'server', 'app.mjs');
const BASE_ENTRY = path.join(REPO_ROOT, 'server', 'base.mjs');

/**
 * 要一个空闲端口。**为什么不用 `reserveHighPort`**：它从 `42000+random*22000` 里挑，会落在
 * Windows 的**动态端口区间**（默认 49152-65535）里 —— 而本门自己每发都要建几条 TCP 连接
 * （每条 connect 都在那个区间占一个本地端口、进 TIME_WAIT），于是 `reserveHighPort` 挑中的端口
 * 很容易被**自己刚建过的连接**占着 ⇒ A 绑不上、`server.on('error')` 直接 exit(1)。实测这种
 * 「A never listened」在整门里失败率过半。改成**只在动态区间以下**（42000-49151）挑，并保留重试。
 */
async function reserveLocalPort() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const port = 42_000 + Math.floor(Math.random() * 7_100);
    if (FORBIDDEN_PORTS.has(port)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('could not reserve a local port below the dynamic range');
}

const options = { assert: false, reverse: false, keep: false, dump: false, arms: null };
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  const take = () => { index += 1; if (index >= process.argv.length) throw new Error(`${arg} needs a value`); return process.argv[index]; };
  if (arg === '--assert') options.assert = true;
  else if (arg === '--reverse') options.reverse = true;
  else if (arg === '--keep') options.keep = true;
  else if (arg === '--dump') options.dump = true;
  else if (arg === '--arms') options.arms = new Set(take().split(',').map((value) => value.trim()));
  else if (arg === '--help' || arg === '-h') { process.stdout.write('node test/sse-truncation.mjs [--assert] [--reverse] [--keep] [--dump] [--arms 1..9]\n'); process.exit(0); }
  else throw new Error(`unknown option: ${arg}`);
}

/** 契约被违反（= 我们已知的那个 bug）。报告模式下不判死，错误照旧判死。 */
class ContractViolation extends Error {}

/** 原始字节（latin1 转义）—— 报告里的「原始证据」就是它。 */
const dumpRaw = (raw) => JSON.stringify(raw.toString('latin1')).replaceAll('\\r\\n', '\\r\\n\n                 ');

const AIOHTTP_ERROR_LINE =
  "ClientPayloadError: Response payload is not completed: "
  + "<TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>";

// ───────────────────────── 原始字节：chunked 判定 ─────────────────────────
// 只认**协议事实**：头声明的是 chunked 还是 content-length，body 到不到终止块。
// 这正是 aiohttp `feed_eof()` 在 PARSE_CHUNKED 状态下看的同一件事。
function assessChunked(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    return { statusLine: null, headers: {}, chunked: false, terminated: false, reason: 'headers never completed', frames: 0, bodyBytes: 0, events: [] };
  }
  const head = raw.subarray(0, headerEnd).toString('latin1');
  const [statusLine, ...lines] = head.split('\r\n');
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  const body = raw.subarray(headerEnd + 4);
  const chunked = /chunked/i.test(headers['transfer-encoding'] ?? '');
  let terminated = false;
  let reason = null;
  let frames = 0;
  if (chunked) {
    let offset = 0;
    for (;;) {
      const newline = body.indexOf('\r\n', offset);
      if (newline < 0) { reason = 'chunk size line never completed (connection went away mid-frame)'; break; }
      const size = Number.parseInt(body.subarray(offset, newline).toString('latin1').split(';')[0].trim(), 16);
      if (!Number.isFinite(size)) { reason = `unparseable chunk size: ${JSON.stringify(body.subarray(offset, newline).toString('latin1'))}`; break; }
      offset = newline + 2;
      if (size === 0) { terminated = true; break; }
      if (offset + size + 2 > body.length) { reason = `chunk truncated: declared ${size} bytes, only ${Math.max(0, body.length - offset - 2)} arrived`; break; }
      offset += size + 2;
      frames += 1;
    }
  } else if (headers['content-length'] !== undefined) {
    const declared = Number(headers['content-length']);
    if (body.length === declared) terminated = true;
    else reason = `content-length declared ${declared}, only ${body.length} bytes arrived`;
  } else {
    reason = 'neither transfer-encoding nor content-length (response is unframed)';
  }
  return {
    statusLine,
    headers,
    chunked,
    terminated,
    reason,
    frames,
    bodyBytes: body.length,
    events: [...raw.toString('utf8').matchAll(/^event: (\S+)$/gm)].map((match) => match[1]),
  };
}

const summarise = (client) => {
  const a = assessChunked(client.raw);
  return {
    termination: a.terminated ? 'clean' : 'truncated',
    status: a.statusLine,
    transferEncoding: a.headers['transfer-encoding'] ?? null,
    contentLength: a.headers['content-length'] ?? null,
    frames: a.frames,
    bytes: client.raw.length,
    events: a.events,
    why: a.reason,
  };
};

// ───────────────────────── 原始 socket 客户端（看得见 chunk 框） ─────────────────────────
function rawGet(port, pathname, { accept = 'text/event-stream', connection = 'keep-alive' } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  const chunks = [];
  const waiters = [];
  let closedAt = null;
  const wake = () => { for (const waiter of waiters.splice(0)) waiter(); };
  socket.on('connect', () => socket.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: ${accept}\r\nConnection: ${connection}\r\n\r\n`));
  socket.on('data', (chunk) => { chunks.push(chunk); wake(); });
  const onGone = () => { closedAt ??= Date.now(); wake(); };
  socket.on('end', onGone);
  socket.on('close', onGone);
  socket.on('error', onGone);
  const client = {
    socket,
    accept,
    get raw() { return Buffer.concat(chunks); },
    get closed() { return closedAt !== null; },
    get assessment() { return assessChunked(client.raw); },
    get summary() { return summarise(client); },
    async waitFor(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (predicate(client)) return true;
        if (Date.now() >= deadline) return false;
        await Promise.race([new Promise((resolve) => waiters.push(resolve)), sleep(50)]);
      }
    },
    /** 等到「干净收尾」或「socket 没了」二者之一 —— 之后读数不再变化。 */
    settle(timeoutMs = 10_000) {
      return client.waitFor((self) => self.closed || self.assessment.terminated, timeoutMs);
    },
    close() { socket.destroy(); },
  };
  return client;
}

// ───────────────────────── 检测器自检用的合成上游（不碰本仓任何代码） ─────────────────────────
function chunkedSse(events, { terminate }) {
  const head = 'HTTP/1.1 200 OK\r\n'
    + 'content-type: text/event-stream; charset=utf-8\r\n'
    + 'cache-control: no-cache, no-store\r\n'
    + 'connection: keep-alive\r\n'
    + 'transfer-encoding: chunked\r\n\r\n';
  const parts = [Buffer.from(head, 'latin1')];
  for (const text of events) {
    const payload = Buffer.from(text, 'utf8');
    parts.push(Buffer.from(`${payload.length.toString(16)}\r\n`, 'latin1'), payload, Buffer.from('\r\n', 'latin1'));
  }
  if (terminate) parts.push(Buffer.from('0\r\n\r\n', 'latin1'));
  return Buffer.concat(parts);
}

function syntheticSseServer({ terminate }) {
  const held = new Set();
  const server = net.createServer((socket) => {
    held.add(socket);
    socket.on('close', () => held.delete(socket));
    socket.on('data', () => {
      socket.write(chunkedSse(['event: hello\ndata: {"t":1}\n\n'], { terminate }));
      if (!terminate) setTimeout(() => socket.destroy(), 60);   // 中途掐断：与 worker 被 SIGKILL 同形
    });
  });
  return {
    server,
    async listen() { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; },
    close() { for (const socket of held) socket.destroy(); server.close(); },
  };
}

// ───────────────────────── 沙箱：真 A（base.mjs）+ 真 B（app.mjs） ─────────────────────────
const sandboxes = [];
const running = [];
const sockets = [];

async function makeSandbox() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sopho-sse-trunc-'));
  const home = path.join(dir, 'home');
  const sessionsRoot = path.join(dir, 'sessions');
  const workspace = path.join(dir, 'ws');
  const logPath = path.join(dir, 'base.log');
  await mkdir(home, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // 最小 home：无密钥、无 provider。`/tree/events` 不需要会话，也就不需要模型。
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: {} }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultThinkingLevel: 'off', compaction: { enabled: false } }, null, 2)}\n`);
  const sandbox = { dir, home, sessionsRoot, workspace, logPath };
  sandboxes.push(sandbox);
  return sandbox;
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const connected = await new Promise((resolve) => {
      const probe = net.connect(port, '127.0.0.1');
      probe.on('connect', () => { probe.destroy(); resolve(true); });
      probe.on('error', () => resolve(false));
    });
    if (connected) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

async function spawnA(sandbox, entry) {
  const port = await reserveLocalPort();
  const logHandle = await open(sandbox.logPath, 'w');
  const child = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: sandbox.home,
      ASSIST_HOME: sandbox.home,
      SOPHO_AGENT_DIR: sandbox.home,
      PI_CODING_AGENT_DIR: sandbox.home,
      PI_CODING_AGENT_SESSION_DIR: sandbox.sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: sandbox.workspace,
      SOPHO_NO_TOOLS: '1',
    },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  const handle = {
    port,
    child,
    /**
     * 只按精确 pid 停；绝不按名字/模式杀。
     * ⚠️ A 被 **SIGKILL** 时（本门就有这种臂：臂⑦要的就是 A 突然死、不跑收摊），
     * 它 spawn 的 generation worker 会**变成孤儿**（A 的收摊代码没跑）—— 它也是本门 spawn 的，
     * 所以一并按**精确 pid** 收掉。收之前先核对身份（cmdline 里是不是 `worker.mjs`）：
     * `processCommandLine` 读的是**这个 pid**（不是扫进程表），防的是 pid 复用误杀。
     */
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const exited = await Promise.race([new Promise((resolve) => child.once('exit', () => resolve(true))), sleep(25_000).then(() => false)]);
        if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      const workerPid = handle.worker?.pid;
      if (workerPid && !handle.workerStopped) {
        handle.workerStopped = true;
        if (await processAlive(workerPid)) {
          const commandLine = await processCommandLine(workerPid).catch(() => '');
          if (commandLine.includes('worker.mjs')) {
            try { process.kill(workerPid, 'SIGKILL'); } catch { /* 已经走了 */ }
          }
        }
      }
      await logHandle.close().catch(() => {});
    },
  };
  running.push(handle);
  if (!await waitForPort(port, 30_000)) {
    const tail = await readFile(sandbox.logPath, 'utf8').catch(() => '');
    throw new Error(`A never listened on ${port}; A log tail: ${tail.slice(-600)}`);
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const worker = await readWorkerPortFromLog(sandbox.logPath).catch(() => null);
    if (worker) { handle.worker = worker; return handle; }
    await sleep(100);
  }
  throw new Error('A never logged worker_ready');
}

/** 端口是「先要一个、放掉、再让 A 去绑」—— 理论上会被抢走。重试几次（每次都换端口）。 */
async function spawnAWithRetry(sandbox, entry = null) {
  const resolved = entry ?? (await entriesForRun()).a;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const started = running.length;
    try {
      return await spawnA(sandbox, resolved);
    } catch (error) {
      lastError = error;
      for (const handle of running.splice(started)) await handle.stop().catch(() => {});
      process.stdout.write(`  · A 第 ${attempt + 1} 次没起来（${error.message.slice(0, 200)}），换端口重试\n`);
      await rm(sandbox.logPath, { force: true }).catch(() => {});
    }
  }
  throw lastError;
}

async function spawnB(upstreamPort, entry = APP_ENTRY) {
  const port = await reserveLocalPort();
  let output = '';
  const child = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SOPHO_APP_HOST: '127.0.0.1',
      SOPHO_APP_PORT: String(port),
      SOPHO_UPSTREAM_HOST: '127.0.0.1',
      SOPHO_UPSTREAM_PORT: String(upstreamPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const handle = {
    port,
    child,
    get output() { return output; },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const exited = await Promise.race([new Promise((resolve) => child.once('exit', () => resolve(true))), sleep(15_000).then(() => false)]);
        if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
  };
  running.push(handle);
  if (!await waitForPort(port, 20_000)) throw new Error(`B never listened on ${port}: ${output}`);
  return handle;
}

async function boot(label, { bEntry = null, sandbox = null } = {}) {
  const entries = await entriesForRun();
  const box = sandbox ?? await makeSandbox();
  const a = await spawnAWithRetry(box, entries.a);
  const b = await spawnB(a.port, bEntry ?? entries.b);
  const usedB = bEntry ?? entries.b;
  process.stdout.write(`  · boot ${label}: A=${a.port} B=${b.port} worker=${a.worker.pid} (${a.worker.generationId})`
    + `${usedB === APP_ENTRY ? '' : ` B-entry=${path.basename(usedB)}`}`
    + `${entries.a === BASE_ENTRY ? '' : ' A/B=回退副本'}`
    + ` sandbox=${box.dir}\n`);
  return { sandbox: box, a, b };
}

function openSse(label, port, pathname, accept) {
  const client = rawGet(port, pathname, { accept });
  sockets.push(client);
  const summary = { label, accept };
  process.stdout.write(`  · ${label}: GET ${pathname} Accept: ${accept}\n`);
  return Object.assign(client, summary);
}

// ───────────────────────── 反证臂：把修法在**副本**里退回 Accept 头那套 ─────────────────────────
/**
 * 反证臂（`--reverse`）的底座：把 `server/base.mjs` / `server/app.mjs` 拷进副本，再把 2026-09-26
 * 那两处修法**退回修好之前那套**（用客户端的 `Accept` 头判 SSE ＋ 收摊不结束下游 SSE）。
 * **仓库里的两个文件一字未改**。每个 marker 找不到就**抛**（绝不静默跳过一个没打上的补丁 ——
 * 那样反证臂会假绿）。
 *
 * ⚠️ 副本目录必须落在 **REPO_ROOT 下面**：`server/base.mjs` 用
 * `path.dirname(fileURLToPath(import.meta.url))/..` 定位 generation worker（`<rootDir>/server/worker.mjs`），
 * 而 worker 要 import pi（靠向上查找 `node_modules`）—— 放到 `os.tmpdir()` 里这两条都找不到，
 * 那种失败与修法无关（是脚手架在骗人）。
 */
const revertRoots = [];
function revertRoot() {
  if (revertRoots.length === 0) revertRoots.push(path.join(REPO_ROOT, `.ssetrunc-revert-${process.pid}`));
  return revertRoots[0];
}
async function revertedCopy(name, entry, patches) {
  const source = await readFile(entry, 'utf8');
  let text = source;
  for (const [marker, replacement] of patches) {
    assert.ok(text.includes(marker), `${name}: 找不到要改的那一段：${JSON.stringify(marker.slice(0, 70))}`);
    text = text.replace(marker, replacement);
  }
  assert.notEqual(text, source, `${name}: 补丁一个字都没改上`);
  const dir = revertRoot();
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${name}.mjs`);
  await writeFile(target, text);
  return target;
}

// 回退①（A）：`proxyToWorker` 里「拿到上游响应后改看 content-type」退回「只看客户端 Accept」。
const REVERT_A_SSE_JUDGEMENT = [
  [
    `    const sseUpstream = isEventStreamContentType(incoming.headers['content-type']) || sse;`,
    `    const sseUpstream = sse;   // [--reverse 副本] 退回修好之前：只看客户端的 Accept 头`,
  ],
];

// 回退②（B）：判据同回退①，另外把「收摊时先结束下游 SSE」那两步去掉（登记 ＋ 收摊循环）。
const REVERT_B_SSE_JUDGEMENT = [
  [
    `      const sseByUpstream = isEventStreamContentType(upstreamResponse.headers['content-type']) || sse;`,
    `      const sseByUpstream = sse;   // [--reverse 副本] 退回修好之前：只看客户端的 Accept 头`,
  ],
  [
    [
      `    if (isEventStreamContentType(upstreamResponse.headers['content-type'])) {`,
      `      openSseResponses.add(response);`,
      `      response.once('close', () => openSseResponses.delete(response));`,
      `    }`,
      ``,
    ].join('\n'),
    '',
  ],
  [
    [
      `  for (const response of [...openSseResponses]) {`,
      `    try { if (!response.destroyed && !response.writableEnded) response.end(); } catch { /* 已经走了 */ }`,
      `  }`,
      `  openSseResponses.clear();`,
      ``,
    ].join('\n'),
    '',
  ],
];

/** 本次要跑的入口：默认是真产品；`--reverse` 下换成那两个回退副本（只建一次）。 */
let reverseEntries = null;
async function entriesForRun() {
  if (!options.reverse) return { a: BASE_ENTRY, b: APP_ENTRY };
  reverseEntries ??= {
    a: await revertedCopy('base-revert-accept-side', BASE_ENTRY, REVERT_A_SSE_JUDGEMENT),
    b: await revertedCopy('app-revert-accept-side', APP_ENTRY, REVERT_B_SSE_JUDGEMENT),
  };
  return reverseEntries;
}

// ───────────────────────── 判据 ─────────────────────────
// 契约（`--assert` 与报告模式）= 干净收尾；反证（`--reverse`）= 修好**之前**那套行为
//（③⑥ 干净 / ④⑤⑦⑧⑨ 被掐断）——2026-09-26 起 `--reverse` 跑的是**回退副本**（把两处修法退回
// Accept 头那套），所以它断言的是「副本里必须重新读到被掐断」：读不出来就说明这条门没牙。
// 报告模式：契约违反只登记、不判死；**任何别的失败（起不来 / 检测器坏了）照旧判死**。
const expect = (preFix) => (options.reverse ? preFix : 'clean');
const enforce = (armIndex) => options.assert || options.reverse || armIndex < 2;

const findings = [];
function judge(armIndex, name, client, expectation, { enforce: forced = null, note = null } = {}) {
  const summary = client.summary;
  process.stdout.write(
    `  · ${summary.termination === 'clean' ? 'CLEAN ' : 'TRUNC '} ${name}`
    + ` [status=${summary.status ?? '(无)'} transfer-encoding=${summary.transferEncoding ?? '(无)'}`
    + ` content-length=${summary.contentLength ?? '(无)'} bytes=${summary.bytes}`
    + ` events=${JSON.stringify(summary.events)}]\n`,
  );
  if (note) process.stdout.write(`          note: ${note}\n`);
  if (summary.termination === 'truncated') {
    process.stdout.write(`          ⇒ 客户端（aiohttp）会抛：${AIOHTTP_ERROR_LINE}\n`);
    process.stdout.write(`          ⇒ 接线原因是：${summary.why}\n`);
  }
  if (options.dump) process.stdout.write(`          raw = ${dumpRaw(client.raw)}\n`);
  findings.push({ name, expectation, note, ...summary });
  const mustEnforce = forced === null ? enforce(armIndex) : forced;
  if (summary.termination !== expectation && mustEnforce) {
    throw new ContractViolation(
      `${name}: 期望 ${expectation}，实际 ${summary.termination}`
      + `${summary.why ? `（${summary.why}）` : ''}`
      + (summary.termination === 'truncated' ? ` ⇒ ${AIOHTTP_ERROR_LINE}` : ''),
    );
  }
  return summary;
}

/**
 * 收摊信号到底有没有被那个进程**听到** —— 这直接决定一条修法在这台机器上可不可验。
 * Windows 没有真信号：`child.kill('SIGTERM')` == `TerminateProcess`，进程里的任何 handler 都不会跑
 * （`bin/stop-win.ps1` 用的也是 `taskkill /PID <pid> /T /F` = 硬杀）。POSIX 的 `kill -TERM`（`bin/stop.sh`）才会跑到。
 */
async function stopSignalObserved(handle, { marker, outputOf = null, logPath = null }) {
  await handle.stop();
  const text = outputOf !== null ? outputOf.output : await readFile(logPath, 'utf8').catch(() => '');
  const observed = text.includes(marker);
  process.stdout.write(`  · 收摊信号是否被那个进程听到（找 ${JSON.stringify(marker)}）：${observed ? '是（进程跑了收摊代码）' : '否（信号没到 / 不可捕获）'}\n`);
  return { observed, tail: text.slice(-400) };
}

// ───────────────────────── 臂 ─────────────────────────
const allArms = [
  ['① 检测器自检：合成上游干净收尾 ⇒ 读出「有终止块」', async () => {
    const synthetic = syntheticSseServer({ terminate: true });
    const port = await synthetic.listen();
    const client = rawGet(port, '/events');
    await client.settle(5000);
    const summary = judge(0, '① 合成上游·干净收尾', client, 'clean');
    client.close();
    synthetic.close();
    return summary;
  }],

  ['② 检测器自检：合成上游中途 destroy ⇒ 读出「无终止块」', async () => {
    const synthetic = syntheticSseServer({ terminate: false });
    const port = await synthetic.listen();
    const client = rawGet(port, '/events');
    await client.waitFor((self) => self.closed, 5000);
    const summary = judge(1, '② 合成上游·中途掐断', client, 'truncated');
    client.close();
    synthetic.close();
    return summary;
  }],

  ['③ 真 A+B：Accept: text/event-stream + worker 被 SIGKILL', async () => {
    const { a, b } = await boot('③');
    try {
      const client = openSse('③', b.port, '/api/tree/events', 'text/event-stream');
      if (!await client.waitFor((self) => self.raw.includes('event: tree.snapshot'), 20_000)) {
        throw new Error(`③ 没连上 SSE：${client.raw.toString('utf8').slice(0, 300)}`);
      }
      process.kill(a.worker.pid, 'SIGKILL');   // 只按精确 pid 杀 —— 绝不 pkill
      await client.settle(20_000);
      await sleep(400);                        // 收摊后读数别再变
      return judge(2, '③ Accept: text/event-stream + worker SIGKILL', client, expect('clean'));
    } finally {
      for (const socket of sockets.splice(0)) socket.close();
      await a.stop();
      await b.stop();
    }
  }],

  ['④ 真 A+B：Accept: */*（aiohttp 默认）+ worker 被 SIGKILL', async () => {
    const { a, b } = await boot('④');
    try {
      const client = openSse('④', b.port, '/api/tree/events', '*/*');
      if (!await client.waitFor((self) => self.raw.includes('event: tree.snapshot'), 20_000)) {
        throw new Error(`④ 没连上 SSE：${client.raw.toString('utf8').slice(0, 300)}`);
      }
      process.kill(a.worker.pid, 'SIGKILL');
      await client.settle(20_000);
      await sleep(400);
      return judge(3, '④ Accept: */* + worker SIGKILL', client, expect('truncated'));
    } finally {
      for (const socket of sockets.splice(0)) socket.close();
      await a.stop();
      await b.stop();
    }
  }],

  ['⑤ 真 A+B：SSE 挂着时按 pid 收掉 B', async () => {
    const { a, b } = await boot('⑤');
    try {
      const client = openSse('⑤', b.port, '/api/tree/events', 'text/event-stream');
      if (!await client.waitFor((self) => self.raw.includes('event: tree.snapshot'), 20_000)) throw new Error('⑤ 没连上 SSE');
      const signal = await stopSignalObserved(b, { marker: '[app] SIGTERM received', outputOf: b });
      await client.settle(25_000);
      await sleep(400);
      return judge(4, '⑤ B 被 SIGTERM（Accept: text/event-stream）', client, expect('truncated'), {
        note: signal.observed
          ? 'B 收到了信号并跑了收摊代码（POSIX 形状）'
          : 'B 根本没听到信号（Windows 上 kill(\'SIGTERM\') = TerminateProcess ⇒ B 的 shutdown() 是**不可达代码**）',
      });
    } finally {
      for (const socket of sockets.splice(0)) socket.close();
      await a.stop();
      await b.stop();
    }
  }],

  ['⑥ 真 A+B：SSE 挂着时按 pid 收掉 A', async () => {
    const { a, b, sandbox } = await boot('⑥');
    try {
      const client = openSse('⑥', b.port, '/api/tree/events', 'text/event-stream');
      if (!await client.waitFor((self) => self.raw.includes('event: tree.snapshot'), 20_000)) throw new Error('⑥ 没连上 SSE');
      const signal = await stopSignalObserved(a, { marker: '[base] SIGTERM received', logPath: sandbox.logPath });
      await client.settle(30_000);
      await sleep(400);
      return judge(5, '⑥ A 被 SIGTERM（Accept: text/event-stream）', client, expect('clean'), {
        note: signal.observed
          ? 'A 跑了自己的 shutdown（POSIX 形状）'
          : 'A 根本没听到信号（Windows 上 = TerminateProcess）⇒ 客户端看到干净 EOF 是 **B 自己的 SSE 错误路 end()** 补上的',
      });
    } finally {
      for (const socket of sockets.splice(0)) socket.close();
      await a.stop();
      await b.stop();
    }
  }],

  ['⑦ 修法①的针：Accept: */* 时按 pid 收掉 A ⇒ 只由 B 自己那条判据决定客户端看到什么', async () => {
    // ⚠️ 为什么杀 A（而不是杀 worker）：worker 被 SIGKILL 时 A 自己会先给一个干净收尾
    // （`terminateDownstream`）—— 那样这一臂就掩掉了 B 的判据，算不得在钉 B。
    // 杀掉 A 之后，“客户端看到什么”就只由 B 决定：修好之前 B 走 `response.destroy()`（截断），
    // 修好之后 B 看的是**上游响应的 content-type** ⇒ `sendSseSoftFailure` ⇒ 干净收尾。
    const sandbox = await makeSandbox();
    const { a, b } = await boot('⑦', { sandbox });
    try {
      const client = openSse('⑦', b.port, '/api/tree/events', '*/*');
      if (!await client.waitFor((self) => self.raw.includes('event: tree.snapshot'), 20_000)) {
        throw new Error(`⑦ 没连上 SSE：${client.raw.toString('utf8').slice(0, 300)}`);
      }
      process.kill(a.child.pid, 'SIGKILL');   // 只按精确 pid 杀 —— 绝不 pkill
      await client.settle(20_000);
      await sleep(400);
      return judge(6, '⑦ Accept: */* + A 被 SIGKILL（只考 B 的判据）', client, expect('truncated'));
    } finally {
      for (const socket of sockets.splice(0)) socket.close();
      await a.stop();
      await b.stop();
    }
  }],

  ['⑧ 修法②的针：B 收摊时先把自己下游还开着的 SSE 干净结束（信号听不到的平台不判死）', async () => {
    const sandbox = await makeSandbox();
    const { a, b } = await boot('⑧', { sandbox });
    try {
      const client = openSse('⑧', b.port, '/api/tree/events', 'text/event-stream');
      if (!await client.waitFor((self) => self.raw.includes('event: tree.snapshot'), 20_000)) throw new Error('⑧ 没连上 SSE');
      const signal = await stopSignalObserved(b, { marker: '[app] SIGTERM received', outputOf: b });
      await client.settle(25_000);
      await sleep(400);
      // 信号没被听到 ⇒ 这条修法在本平台**不可达**（考的不是修法，而是 stop 路径），不判死、如实登记。
      return judge(7, '⑧ 按 pid 收掉 B（收摊路径：先 end 下游 SSE 再关服务器）', client, signal.observed ? expect('truncated') : 'truncated', {
        enforce: signal.observed ? null : false,
        note: signal.observed
          ? 'B 听到了信号 ⇒ 这一臂考的就是收摊路径那一步（先 end 下游 SSE 再关服务器；缺了它 ⇒ 2 s 后 process.exit 直接切断）'
          : '本平台信号不可捕获（Windows：kill(\'SIGTERM\')=TerminateProcess、stop-win.ps1 用 taskkill /F）'
            + ' ⇒ 这条修法在 Windows 上**不可达**，真正的坑在 stop 路径（要另开控制通道/先 drain 再 /F）',
      });
    } finally {
      for (const socket of sockets.splice(0)) socket.close();
      await a.stop();
      await b.stop();
    }
  }],
  ['⑨ 直连 A（不经过 B）：Accept: */* + worker 被 SIGKILL ⇒ A 自己那条判据必须给干净收尾', async () => {
    // ④ 是「客户端看到的」那一跳（可能被 B 掩掉）；这条把 A 自己那一跳单独量一遍：
    // `proxyToWorker` 的 `sseUpstream` 与 B 里的同名判据是**同一个规则**（两份拷贝），两处都得对。
    const sandbox = await makeSandbox();
    const a = await spawnAWithRetry(sandbox);
    try {
      const client = openSse('⑨', a.port, '/tree/events', '*/*');
      if (!await client.waitFor((self) => self.raw.includes('event: tree.snapshot'), 20_000)) {
        throw new Error(`⑨ 没连上 SSE：${client.raw.toString('utf8').slice(0, 300)}`);
      }
      process.kill(a.worker.pid, 'SIGKILL');
      await client.settle(20_000);
      await sleep(400);
      return judge(8, '⑨ 直连 A + Accept: */* + worker SIGKILL', client, expect('truncated'));
    } finally {
      for (const socket of sockets.splice(0)) socket.close();
      await a.stop();
    }
  }],
];

// ───────────────────────── 跑 ─────────────────────────
const mode = options.assert ? 'assert' : options.reverse ? 'reverse' : 'report';
const arms = options.arms
  ? [...options.arms].map((key) => {
    const arm = allArms[Number(key) - 1];
    if (!arm) throw new Error(`no such arm: ${key} (1..${allArms.length})`);
    return arm;
  })
  : allArms;
const result = await runArms(arms, { title: `sse-truncation (${mode})` });

process.stdout.write('\n──── 读数 ────\n');
for (const finding of findings) {
  process.stdout.write(
    `${finding.termination === 'clean' ? 'CLEAN ' : 'TRUNC '} ${finding.name}\n`
    + `        status=${finding.status ?? '(无)'} transfer-encoding=${finding.transferEncoding ?? '(无)'}`
    + ` content-length=${finding.contentLength ?? '(无)'} bytes=${finding.bytes}\n`
    + `        events=${JSON.stringify(finding.events)}${finding.why ? ` why=${finding.why}` : ''}`
    + `${finding.note ? `\n        note=${finding.note}` : ''}\n`,
  );
}
const truncated = findings.filter((finding) => finding.termination === 'truncated');
process.stdout.write(`\n合计：${findings.length} 条读数，其中**被掐断** ${truncated.length} 条（这些客户端拿到的就是 aiohttp 的 ClientPayloadError）。\n`);

// 只按精确 pid 收尾（绝不 pkill）；报告模式保留沙箱需显式 --keep。
for (const handle of running) await handle.stop().catch(() => {});
for (const socket of sockets) socket.close();
for (const sandbox of sandboxes) {
  if (options.keep) { process.stdout.write(`（--keep）保留沙箱：${sandbox.dir}\n`); continue; }
  await rm(sandbox.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {});
}
// 反证副本建在 REPO_ROOT 下面（见 `revertedCopy` 那段“为什么”），跑完同样按**精确路径**删掉（不用 glob）。
for (const root of revertRoots) {
  if (options.keep) { process.stdout.write(`（--keep）保留反证副本：${root}\n`); continue; }
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {});
}

if (!options.assert && !options.reverse) {
  // 报告模式：契约违反是**已知的 bug 形状**（要改的是产品，不是这里的期望值），不判死；
  // 但自检/起不来这类失败照旧判死（否则门会安静地烂掉）。
  const realFailures = result.failed.filter((arm) => !(arm.error instanceof ContractViolation));
  if (realFailures.length > 0) {
    process.stdout.write(`\n❌ 报告模式下仍有非契约失败：${realFailures.map((arm) => `${arm.name} → ${arm.error.message}`).join('; ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\n（报告模式：以上即今日事实 —— 契约档 `--assert` 判的就是它；2026-09-26 起两处修法已在产品里，'
      + '正常应当是 0 条被掐断。真读出被掐断就是回归，用 `npm run test:ssetrunc:assert` 判死。）\n');
    process.exitCode = 0;
  }
} else if (options.assert) {
  if (result.failed.length > 0) {
    process.stdout.write(`\n❌ --assert：${result.failed.length} 条臂不符合契约（客户端应看到干净收尾）\n`);
  } else {
    process.stdout.write('\n✅ --assert：所有臂都符合契约（客户端看到干净收尾）\n');
  }
} else if (result.failed.length > 0) {
  process.stdout.write(`\n❌ --reverse：回退副本里没读出预期的坏行为（${result.failed.length} 条：`
    + `${result.failed.map((arm) => arm.name).join('; ')}）⇒ 这条门可能没牙\n`);
} else {
  process.stdout.write('\n（--reverse：回退副本里重新读到「被掐断」（③⑥ 仍干净 / ④⑤⑦⑧⑨ 截断）⇒ 这条门有牙）\n');
}
