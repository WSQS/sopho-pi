#!/usr/bin/env node
// host-session-path-probe —— 为「宿主批那一个词」（`server/base.mjs` 的 `SESSION_PATH` 里加
// `questions`）准备的**红/绿 A/B 门 + 原始证据生成器**。
//
// ⚠️ 那个词已经落 trunk（2026-09-20）；这个相位因此改成**永久 A/B 两模式**，不再依赖
//   「仓里那份正则恰好还没带上那个词」（那会让它在“世界变好了”之后无法再复现旧行为/变红）：
//   · A 面（旧行为）：沙箱副本里**去掉**那个词 ⇒ draining 窗口里的 `/questions` 由 **current worker** 服务
//     （hot 0→1、owner 被接管、g1 自己那一代还热着 ⇒ **两个 writer**）—— **硬断言**保留。
//   · B 面（新行为）：沙箱副本里**带上**那个词 ⇒ 由 **owner** 服务（owner 映射不变、current worker 的 hot 保持 0）
//     —— **硬断言**。
//   两个副本只差 `SESSION_PATH` 那一个词（`makeCodeRoot` 钉的），所以对照不受任何竞态影响。
//
// 为什么需要它：`docs/manager-toolkit-plan.md` §11 / `docs/handoff.md` Q-10 一直靠**推测**说
//   「`/sessions/{id}/questions` 匹配不上宿主 `SESSION_PATH` ⇒ 落到末尾兜底 proxy 到 **current worker**」，
// 而 2026-09-20 线上 arc 那台三次 `question_ask` 拿到 404 `{"error":"not found"}` —— 需要钉死：
//   (a) 兜底那句话**对不对**（宿主到底代理了没有、代理给了哪一代）；
//   (b) 那个 404 的 body（worker 兜底 `{"error":"not found"}`）与「缺会话」的 404
//       （`{"error":"session_not_found","message":"session not found: <uuid>"}`）**逐字**怎么区分；
//   (c) draining 窗口里的**写**走 owner 还是走 current（**A/B 两模式各自硬断言**，见上）；
//   (d) `POST /reclaim` 三种调用的原始回执 + 「收 runtime 不动会话文件」+「从 JSONL 重建」。
//
// 铁律（与 test/perf-verify-lib.mjs 同口径，写在这里防后来人改坏）：
//   · 只起**自己 spawn** 的沙箱（副本 home + 高位随机端口），只按**精确 pid** 停，**绝不 pkill**；
//   · 端口绝不 7331/7321；日志写沙箱自己的目录，**绝不**写 /tmp/sopho-base.log|sopho-app.log；
//   · 会话 id 一律完整 uuid；**绝不碰真 profile**（`~/.pi/profiles/assistant`）。
//
// 三条必须遵守的“可判定性”约定（2026-09-21 补；当时 Linux 上稳定红过一次，根因就在头两条里）：
//   · **打补丁必须可判定**：只改**命中锚点的那一行**、那一行里字面量**恰好 1 处**、改完**逐行只有那一行变**、
//     写回的字节与打算写的一致，并且 `node --check` 在**两个平台**都跑（`patchLineOnce` / `assertParses`）。
//     —— 原先用的是整份文件的 `String.replace`（只换第一处、也不报命中数）+ 只断言 `after !== text`
//     （“文本变了”），改歪/改坏都能带着红往下跑。
//   · **先钉死路由，再断言回执**：带词的宿主把 `/questions` 匹配进 SESSION_PATH ⇒ 走 **owner 路由**；
//     而 reload 之后那个 owner（老代）随时会退场。请求若落进「老代已经在 `shutdown()`、宿主还没收到它的
//     exit」那条缝里，`server/worker.mjs` 的 `socket.destroy()` 会把连接扫掉 ⇒ 宿主拿到
//     `502 {"error":"worker unavailable","message":"read ECONNRESET"}`（连的已建立过，不是 ECONNREFUSED）
//     ⇒ 断言判的就不是「陈旧逻辑回 404」了。正解：先把会话**忙住**（`startHoldTurn`）再 reload，
//     让老代活着当确定的服务者；要问 current 代时，先等它自己退干净（`draining: []`）。
//   · **失败自诊断**：凡是 `打不通 / 502 / 503 / ECONNRESET` 的回执，都把**沙箱日志尾部**（宿主 + 它 fork 的
//     每一代 worker 的 stdout/stderr 都在那一份里）+ `/host` 的「谁持有谁、pid 还活着吗」打出来，
//     并提示 `--keep` 留沙箱（见 `diagnoseRequest` / `expectStatus`）。
//
// 沙箱根放在**仓内** `.probe-sandbox/`（不是 os.tmpdir()）：那两份「只改沙箱那份」的宿主副本要能
// 顺着目录向上找到仓里的 `node_modules`（`server/base-logic.mjs` 要 import `@earendil-works/pi-coding-agent`）。
// 目录在跑完时删掉（`--keep` 可留），`.gitignore` 不含它 —— 提交前请确认 `git status` 干净。
//
// 用法：
//   node test/host-session-path-probe.mjs --phase session-path     # A/B 红绿（硬断言）+ 缺路由/缺会话 404
//   node test/host-session-path-probe.mjs --phase reclaim          # ③reclaim 三种调用 + 文件不变 + 重建
//   node test/host-session-path-probe.mjs --phase drain-idle       # ⑥换代窗口到底谁挡着（AGENTS.md 那条注记）
//   node test/host-session-path-probe.mjs --phase swap-window      # 换代窗口里那条请求被怎么处理（只印不断言）+ 自愈（硬断言）
//   node test/host-session-path-probe.mjs --phase read-retry       # 读路径的重试支：臂1 owner 路由 reached=false；臂2 409 拦截（各正向 + 突变反证）
//   node test/host-session-path-probe.mjs --phase read-retry --arm arm1|arm2   # 只跑其中一条臂（调试用；默认 all）
//   node test/host-session-path-probe.mjs --phase session-path --keep
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { finishCleanup, removeSandbox } from './harness.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ⚠️ 反证臂要能指向一份**只改一处**的副本（例如把宿主里那条幂等判定 `method === 'GET' || method === 'HEAD'`
// 改成 `false`）⇒ 允许用 `SOPHO_PROBE_ROOT` 覆盖；**默认就是真树**（不设这个变量时行为一字不变 ✓、不碰真树 ✓）。
const REPO_ROOT_DEFAULT = path.resolve(HERE, '..');
const REPO_ROOT = process.env.SOPHO_PROBE_ROOT ?? REPO_ROOT_DEFAULT;
const GUARD_ENTRY = path.join(HERE, 'sandbox-guard.mjs');
const SANDBOX_ROOT = path.join(REPO_ROOT, '.probe-sandbox');
const FORBIDDEN_PORTS = new Set([7321, 7331]);
const LIFETIME_MS = 20 * 60 * 1000;

/** 探针用的合格 `context`（≥ 40 字）。
 *  ⚠️ 2026-09-20 的 ask 契约（`docs/manager-toolkit-plan.md` §1.1）要求每次 ask 自带判断所需的事实；
 *  缺/过短的请求会在逻辑层被 **400 `question_needs_context` 掉**，而那一步发生在碰会话之前
 *  ⇒ 它**不会**让 current worker 冷开 runtime、也就量不到路由。所以这里必须带上合格 context。 */
const PROBE_ASK_CONTEXT = '探针背景：这是 test/host-session-path-probe.mjs 的沙箱（副本 home + 高位随机端口 + 假 provider），用来判定 /sessions/{id}/questions 的写在 draining 窗口里由哪一代服务；不碰真实例。当前主线：宿主批那个词（SESSION_PATH 加 questions）的红/绿 A/B。';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

function print(label, value) {
  process.stdout.write(`${now()} ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function parseArgs(argv) {
  const options = { phase: 'session-path', keep: false, arm: 'all' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--phase') { options.phase = argv[index + 1]; index += 1; }
    else if (arg.startsWith('--phase=')) options.phase = arg.slice('--phase='.length);
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--arm') { options.arm = argv[index + 1]; index += 1; }
    else if (arg.startsWith('--arm=')) options.arm = arg.slice('--arm='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['session-path', 'reclaim', 'drain-idle', 'swap-window', 'owner-death', 'read-retry'].includes(options.phase)) throw new Error(`unknown --phase: ${options.phase}`);
  if (!['all', 'arm1', 'arm2'].includes(options.arm)) throw new Error(`unknown --arm: ${options.arm}`);
  return options;
}

// ───────────────────────────────── HTTP ─────────────────────────────────
/** 原始回执：`raw` 是**逐字**的响应体（探针要贴的就是它，不是解析后的形状）。 */
function request(port, pathname, { method = 'GET', body, headers = {}, timeoutMs = 180_000, collect = true } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        accept: 'application/json',
        connection: 'close',
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    });
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 「请求打不通 / 宿主说 worker 不可用」时先把**沙箱那一侧**的原始事实打出来，再让调用者拿到回执。
      // 为什么在这里挂：这些失败在探针里的形状都是“一条回执”，若只把回执交给断言，就只能看到
      // `502 !== 404`，看不出 worker 自己写了什么 ✗（诊断只对那几种回执触发，见 maybeReportFailure）。
      void maybeReportFailure(pathname, outcome).finally(() => resolve(outcome));
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish({ statusCode: 0, raw: `probe timeout after ${timeoutMs}ms`, value: null, error: 'timeout' });
    }, timeoutMs);
    req.once('error', (error) => finish({ statusCode: 0, raw: error.message, value: null, error: error.code ?? error.message }));
    req.once('response', (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (collect) raw += chunk; });
      response.once('end', () => {
        let value = null;
        if (raw) { try { value = JSON.parse(raw); } catch { value = raw; } }
        finish({ statusCode: response.statusCode, raw, value, headers: response.headers });
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function tryRequest(port, pathname, options) {
  try {
    return await request(port, pathname, options);
  } catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) return null;
    throw error;
  }
}

async function poll(label, operation, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)?.slice(0, 600)}`);
}

async function reserveHighPort() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const port = 42000 + Math.floor(Math.random() * 21000);
    if (FORBIDDEN_PORTS.has(port)) continue;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('could not reserve a high port');
}

// ───────────────────────────── SSE（只在 reclaim 相位用） ─────────────────────────────
function openSse(port, pathname) {
  const events = [];
  const waiters = new Set();
  let response;
  let buffer = '';
  let currentEvent = 'message';
  let currentData = [];
  const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { accept: 'text/event-stream' } });
  const connected = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', (incoming) => {
      response = incoming;
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => {
        buffer += chunk;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line === '') {
            if (currentData.length > 0) {
              const rawData = currentData.join('\n');
              let data;
              try { data = JSON.parse(rawData); } catch { data = rawData; }
              events.push({ event: currentEvent, data });
              for (const waiter of [...waiters]) waiter();
            }
            currentEvent = 'message';
            currentData = [];
          } else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) currentData.push(line.slice(5).trimStart());
        }
      });
      incoming.on('error', () => {});
      resolve();
    });
    req.end();
  });
  return {
    connected,
    events,
    waitFor(predicate, timeoutMs = 20_000) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`SSE wait timed out; tail=${JSON.stringify(events.slice(-6))}`)); }, timeoutMs);
        const check = () => {
          const value = events.find(predicate);
          if (!value) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(value);
        };
        waiters.add(check);
      });
    },
    close() { response?.destroy(); req.destroy(); },
  };
}

// ───────────────────────── 假 provider（openai-compatible SSE） ─────────────────────────
function usage() { return { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }; }
function chunk(content, finishReason = null, includeUsage = false) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-probe',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }],
    ...(includeUsage ? { usage: usage() } : {}),
  };
}

async function startFakeProvider(port) {
  const plans = [];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ at: now(), messages: body.messages?.length ?? 0 });
    const plan = plans.shift() ?? { mode: 'normal', text: 'probe-reply' };
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(chunk(''))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk(plan.text))}\n\n`);
    plan.markStarted?.();
    if (plan.mode === 'hold') await plan.released;
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify(chunk(null, 'stop', true))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    server,
    requests,
    plan(mode, text) {
      let releaseResolve;
      let startedResolve;
      const plan = {
        mode,
        text,
        started: new Promise((resolve) => { startedResolve = resolve; }),
        released: new Promise((resolve) => { releaseResolve = resolve; }),
        markStarted: startedResolve,
      };
      plan.release = () => releaseResolve?.();
      plans.push(plan);
      return plan;
    },
  };
}

// ───────────────────────── 沙箱（守卫 + 宿主 + 副本 home） ─────────────────────────
async function listenerPid(port) {
  if (process.platform !== 'win32') {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('ss', ['-H', '-ltnp', `sport = :${Number(port)}`]);
    return Number(stdout.match(/pid=(\d+)/)?.[1] ?? 0);
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const script = `(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return Number(stdout.trim() || 0);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function writeSandboxHome(home, workspace, providerPort) {
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        apiKey: 'sandbox-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: 'fake-probe', name: 'Probe Fake', contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({
    defaultProvider: 'fake',
    defaultModel: 'fake-probe',
    defaultThinkingLevel: 'off',
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  }, null, 2)}\n`, 'utf8');
}

/**
 * 起一台沙箱宿主。`root` 是**跑哪一份代码**（仓根 = 当前 trunk；副本 = 「只改沙箱那份」）。
 * 守卫由我们 spawn（`stdin` 管道 + IPC）：本探针被 SIGKILL 时它按 pid 拆掉整棵树。
 */
async function startSandbox({ label, root, sandbox, providerPort, extraEnv = {} }) {
  const home = path.join(sandbox, `${label}-home`);
  const sessionsRoot = path.join(sandbox, `${label}-sessions`);
  const workspace = path.join(sandbox, `${label}-workspace`);
  const logPath = path.join(sandbox, `${label}-host.log`);
  await writeSandboxHome(home, workspace, providerPort);
  await mkdir(sessionsRoot, { recursive: true });
  const port = await reserveHighPort();
  const logHandle = await open(logPath, 'w');
  const guard = spawn(process.execPath, [
    GUARD_ENTRY,
    '--entry', path.join(root, 'server', 'base.mjs'),
    '--label', `host-session-path-${label}`,
    '--lifetime-ms', String(LIFETIME_MS),
    '--watch-stdin',
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: sessionsRoot,
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      SOPHO_DEFAULT_CWD: workspace,
      SOPHO_NO_TOOLS: '1',
      ...extraEnv,
    },
    stdio: ['pipe', logHandle.fd, logHandle.fd, 'ipc'],
    detached: true,
  });
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sandbox guard never reported sandbox-start')), 30_000);
    guard.on('message', (message) => {
      if (message?.type !== 'sandbox-start') return;
      clearTimeout(timer);
      resolve(message);
    });
    guard.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`sandbox guard exited before the host started (code=${code} signal=${signal})`));
    });
  });
  const host = await poll('host ready', () => tryRequest(port, '/host'), (reply) => reply?.statusCode === 200, 40_000);
  const runtime = {
    label, root, port, sandbox, home, sessionsRoot, workspace, logPath, logHandle, guard,
    hostPid: started.pid, host: host.value,
  };
  // 宿主起来之后才把「当前沙箱」交给诊断钩子：起来之前那条 `connect ECONNREFUSED` 是**正常状态**
  // （`poll('host ready')` 自己会把它报出来），拿它去刷一遍日志尾部只是噪声。
  activeRuntime = runtime;
  sandboxLogPaths.add(logPath);
  print('sandbox up', { label, root, port, hostPid: started.pid, guardPid: guard.pid, generation: host.value.currentGenerationId, sessionsRoot, logPath });
  return runtime;
}

async function stopSandbox(runtime) {
  if (!runtime) return;
  const { guard, hostPid, port, logHandle } = runtime;
  if (activeRuntime === runtime) activeRuntime = null;
  if (alive(hostPid)) {
    process.kill(hostPid, 'SIGTERM');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && alive(hostPid)) await sleep(50);
    if (alive(hostPid)) process.kill(hostPid, 'SIGKILL');
  }
  if (guard?.pid) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!alive(guard.pid)) break;
      if (attempt === 20) process.kill(guard.pid, 'SIGKILL');
      await sleep(50);
    }
  }
  await logHandle.close().catch(() => {});
  const leftover = await listenerPid(port);
  if (leftover) throw new Error(`sandbox ${runtime.label}: port ${port} still owned by pid ${leftover} after shutdown`);
}

// ───────────────── 失败自诊断（把「worker 为什么死」钉在输出与异常里） ─────────────────
// 为什么需要它：宿主只会说 `502 {"error":"worker unavailable","message":"read ECONNRESET"}` —— 它说的是
// **宿主到 worker 的 socket 断了**，说不出 worker 为什么断。没有 worker 那一侧的日志，探针红了就只能
// 在「补丁把代码改坏了」和「环境问题」两个猜测之间打转（2026-09-21 Linux 上就是这么卡住的）。
const DIAG_TAIL_LINES = 40;
let activeRuntime = null;   // 已经起好的沙箱：request() 失败时从它那儿取日志尾部
let diagnosing = false;     // 防止诊断内部的请求（它自己要 GET /host）又触发一轮诊断
let diagnosisSuppressed = false;  // 只有“本来就预期会看见 409/502/503”的那一拍（swap-window）关掉它
const sandboxLogPaths = new Set();   // `--keep` 时要如实印出“看哪几份日志”

/** 把一份（**宿主与 worker 混在一起**的）日志切成「宿主侧」与「worker 侧」两块。
 *  为什么要分：一条 `502 worker unavailable` 必须能回答“是宿主自己的问题，还是 worker 死了/没起来”——
 *  两侧混在一起看就得靠肉眼猜（2026-09-21 Linux 上就是这么卡住的）。
 *  ⚠️ 诚实说：这不是精确解析。宿主是按**块**（chunk）给 worker 输出加 `[worker <gen>] ` 前缀的，
 *  worker 侧的多行堆栈**只有第一行带前缀** ⇒ 续行只能按“顶格/缩进”猜。所以除了切块，
 *  下面还额外给一份**机器摘要**（`worker_ready` 出现几次、worker 侧看起来像报错的行数、宿主侧事件行），
 *  让“worker 到底起没起、有没有自己报错”不用靠肉眼读堆栈。 */
function splitLogSides(text) {
  const host = [];
  const worker = [];
  let side = 'host';
  for (const line of text.split('\n')) {
    if (line.startsWith('[worker ')) side = 'worker';
    else if (line.startsWith('[') || line.startsWith('{') || !/^\s/.test(line)) side = 'host';
    (side === 'worker' ? worker : host).push(line);
  }
  return { host, worker };
}

const WORKER_ERROR_SHAPE = /(?:SyntaxError|TypeError|ReferenceError|RangeError|Error:|ERR_[A-Z]+|unhandled|uncaught|throw )/;

/** 宿主与 worker 两侧的日志尾部（各 ~40 行）+ 机器摘要 + 沙箱/日志路径 + `--keep` 提示。
 *  注意：这份沙箱把两侧写在**同一个文件**里（宿主把 worker 的 stdout/stderr 转写成 '[worker <gen>] …'），
 *  所以下面先给“整份尾部”，再给“两侧各自的尾部”——路径也只可能是这一条，这点不假装成两份文件。 */
async function sandboxLogTails(runtime, lines = DIAG_TAIL_LINES) {
  if (!runtime) return ['（还没有沙箱）'];
  let text;
  try {
    text = await readFile(runtime.logPath, 'utf8');
  } catch (error) {
    return [`--- 读不到沙箱日志 ${runtime.logPath}：${error?.message ?? error}`];
  }
  const all = text.split('\n');
  const { host, worker } = splitLogSides(text);
  const ready = await workerPorts(runtime).catch(() => []);
  const hostEvents = host.filter((line) => line.startsWith('[host]') || line.startsWith('[sandbox-guard'));
  const workerErrors = worker.filter((line) => WORKER_ERROR_SHAPE.test(line));
  return [
    `--- 沙箱日志 ${runtime.logPath}（共 ${all.length} 行；**宿主与它 fork 的每一代 worker 的 stdout/stderr 都写在这一份里**）---`,
    `[整份日志] 最后 ${lines} 行：\n${all.slice(-lines).join('\n')}`,
    `[宿主侧] 最后 ${lines} 行：\n${host.slice(-lines).join('\n') || '(宿主侧没有行)'}`,
    `[worker 侧] 最后 ${lines} 行：\n${worker.slice(-lines).join('\n') || '(worker 侧没有行)'}`,
    `[机器摘要] worker_ready：${ready.length === 0 ? '(一条都没有 ⇒ worker 根本没起到就绪)' : ready.map((entry) => `${entry.generationId} pid=${entry.pid} port=${entry.port}`).join(' / ')}`,
    `[机器摘要] worker 侧看起来像报错的行（${WORKER_ERROR_SHAPE.source.slice(1, 40)}…）：${workerErrors.length} 行`,
    `[机器摘要] 宿主侧事件行（[host]/[sandbox-guard]）最后 12 行：\n${hostEvents.slice(-12).join('\n') || '(没有)'}`,
    `[路径] 沙箱目录=${runtime.sandbox}｜日志=${runtime.logPath}（宿主与每一代 worker 两侧都在这一份里）｜这一代由宿主启动：${runtime.root}`,
  ];
}

/** 「这条请求是谁在服务、那一代/那几个 pid 还活着吗」—— 把**路由事实**与**进程死活**摆在一起。 */
async function diagnoseRequest(runtime, { what, reply, sessionId = null }) {
  const lines = [`--- diagnose: ${what}`];
  lines.push(`回执：statusCode=${reply?.statusCode ?? null} transportError=${reply?.error ?? null} body=${String(reply?.raw ?? '').trim().slice(0, 400)}`);
  try {
    const { snapshot } = await getHost(runtime);
    lines.push(`/host：current=${snapshot.currentGenerationId} draining=${JSON.stringify(snapshot.draining)} workerCount=${snapshot.workerCount}`);
    for (const worker of snapshot.workers) {
      lines.push(`  worker ${worker.generationId} pid=${worker.pid} state=${worker.state} hot=${JSON.stringify(worker.hot)} 进程还活着=${alive(worker.pid)} owns=${JSON.stringify(worker.owns)}${sessionId && worker.owns.includes(sessionId) ? ' <== 它持有这条会话' : ''}`);
    }
    if (sessionId) lines.push(`  这条会话当前记在谁名下：${JSON.stringify(snapshot.workers.filter((worker) => worker.owns.includes(sessionId)).map((worker) => worker.generationId))}`);
  } catch (error) {
    lines.push(`/host 也读不到（宿主可能已经不在了）：${error?.message ?? error}`);
  }
  lines.push(...await sandboxLogTails(runtime));
  lines.push(`要把整个沙箱留下来再看这两侧的日志：重跑时加 --keep（沙箱目录 ${runtime?.sandbox ?? '?'}；日志 ${runtime?.logPath ?? '?'}）`);
  return lines.join('\n');
}

/** request() 的一道钩子：只对「打不通 / 宿主说 worker 不可用」这几种回执出诊断（正常回执完全不动）。 */
async function maybeReportFailure(pathname, reply) {
  try {
    if (diagnosing || diagnosisSuppressed || !activeRuntime) return;
    const broken = reply?.statusCode === 0
      || reply?.statusCode === 502
      || reply?.statusCode === 503
      || /ECONNRESET|ECONNREFUSED|EPIPE/.test(String(reply?.raw ?? ''));
    if (!broken) return;
    diagnosing = true;
    print('request failed at the transport/host layer', { pathname, statusCode: reply?.statusCode, body: String(reply?.raw ?? '').trim().slice(0, 200) });
    process.stderr.write(`${await diagnoseRequest(activeRuntime, { what: `请求 ${pathname}`, reply })}\n`);
  } catch (error) {
    process.stderr.write(`diagnose 自己失败了：${error?.message ?? error}\n`);
  } finally {
    diagnosing = false;
  }
}

/** 断言一条**回执**：期望的状态码 + **为什么**期望它；不满足时把沙箱日志尾部一起带进异常。
 *  为什么不用裸 `assert.equal(reply.statusCode, N)`：那样失败时只有一行 `502 !== 404`，
 *  看不出「哪一代在服务」「那一代还活着吗」「worker 自己说了什么」✗。 */
async function expectStatus(reply, statusCode, { what, why, runtime = null, sessionId = null, extra = {} } = {}) {
  if (reply?.statusCode === statusCode) return reply;
  const diagnosis = runtime ? await diagnoseRequest(runtime, { what, reply, sessionId }) : '(没有沙箱可诊断)';
  throw new Error(`${what}：期望 ${statusCode}，实际 ${reply?.statusCode} —— 回执逐字 ${String(reply?.raw ?? '').trim()}\n理由：${why}\n已知事实：${JSON.stringify(extra)}\n${diagnosis}`);
}

// ───────────────────── 会话文件事实（hash / stat / 定位） ─────────────────────
async function findSessionFile(sessionsRoot, sessionId) {
  for (const name of await readdir(sessionsRoot)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(sessionsRoot, name);
    let first;
    try {
      first = (await readFile(file, 'utf8')).split('\n').find((line) => line.trim() !== '');
    } catch { continue; }
    if (!first) continue;
    try { if (JSON.parse(first).id === sessionId) return file; } catch { /* half-written file, skip */ }
  }
  return null;
}

async function fileFacts(sessionsRoot, sessionId) {
  const file = await findSessionFile(sessionsRoot, sessionId);
  if (!file) return { file: null };
  const bytes = await readFile(file);
  const info = await stat(file);
  return {
    file,
    name: path.basename(file),
    bytes: bytes.length,
    lines: bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

/** 会话文件的条目摘要（只读）：用来证明「两代各写的东西最后都落在同一个文件里」。 */
async function sessionEntrySummary(sessionsRoot, sessionId) {
  const file = await findSessionFile(sessionsRoot, sessionId);
  if (!file) return { file: null };
  const bytes = await readFile(file, 'utf8');
  const entries = bytes.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  return {
    file: path.basename(file),
    bytes: Buffer.byteLength(bytes),
    entries: entries.map((entry, index) => ({
      i: index,
      type: entry.type,
      name: entry.name ?? null,
      id: entry.id ?? null,
      op: entry.data?.op ?? null,
      role: entry.message?.role ?? null,
      text: String(
        entry.data?.text
        ?? (typeof entry.message?.content === 'string'
          ? entry.message.content
          : (entry.message?.content ?? []).map?.((part) => part?.text ?? '').join('') ?? ''),
      ).slice(0, 70),
    })),
  };
}

// ───────────────────── 宿主快照（/host 的「谁持有谁」投影） ─────────────────────
function hostSnapshot(reply) {
  const value = reply?.value ?? {};
  return {
    statusCode: reply?.statusCode ?? null,
    currentGenerationId: value.currentGenerationId ?? null,
    draining: (value.drainingGenerations ?? []).map((worker) => worker.generationId),
    workerCount: value.workerCount ?? null,
    workers: (value.workers ?? []).map((worker) => ({
      generationId: worker.generationId,
      pid: worker.pid,
      state: worker.state,
      logicVersion: worker.logicVersion,
      hot: worker.hot,
      owns: worker.sessions ?? [],
    })),
    route: value.route ?? null,
  };
}

function ownedBy(snapshot, generationId) {
  return snapshot.workers.find((worker) => worker.generationId === generationId)?.owns ?? [];
}

/** 一代的 hot 计数（`/host` 投影里那一个数字）。`phaseSessionPath` 里另有一个同名局部函数 —— 这里放在
 *  模块级是为了让新增的相位（read-retry）也能用，不改动任何既有相位。 */
function hotOf(snapshot, generationId) {
  return snapshot.workers.find((worker) => worker.generationId === generationId)?.hot ?? null;
}

/** 从宿主日志里数一个字符串出现几次（相位 ⑦ 的「重试支真的跑了吗」机械证据就靠它）。 */
async function logCount(runtime, needle) {
  const text = await readFile(runtime.logPath, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.includes(needle)).length;
}

async function getHost(runtime) {
  const reply = await request(runtime.port, '/host');
  return { reply, snapshot: hostSnapshot(reply) };
}

// ───────────────────── 会话动作 ─────────────────────
async function createSession(runtime, name) {
  const reply = await request(runtime.port, '/sessions', { method: 'POST', body: { cwd: runtime.workspace, name } });
  if (reply.statusCode !== 201) throw new Error(`POST /sessions -> ${reply.statusCode} ${reply.raw}`);
  return reply.value.id;
}

/** 跑完一个普通回合，让会话落盘并由当前代热着它（pool 的 durable + hotIdle）。 */
async function warmTurn(runtime, provider, sessionId, text) {
  const plan = provider.plan('normal', text);
  const reply = await request(runtime.port, `/sessions/${sessionId}/message`, { method: 'POST', body: { text } });
  if (reply.statusCode !== 202) throw new Error(`warm message -> ${reply.statusCode} ${reply.raw}`);
  await plan.started;
  return poll('session durable and idle', async () => {
    const detail = await request(runtime.port, `/sessions/${sessionId}`);
    return detail.value;
  }, (value) => value?.durable === true && value?.runtime?.isStreaming === false, 30_000);
}

/** 起一个**长回合**（假 provider 只发第一块不放行）⇒ 会话 busy，draining 时不会被逐出。 */
async function startHoldTurn(runtime, provider, sessionId, text) {
  const plan = provider.plan('hold', text);
  const reply = await request(runtime.port, `/sessions/${sessionId}/message`, { method: 'POST', body: { text } });
  if (reply.statusCode !== 202) throw new Error(`hold message -> ${reply.statusCode} ${reply.raw}`);
  await plan.started;
  await poll('session streaming', async () => (await request(runtime.port, `/sessions/${sessionId}`)).value, (value) => value?.runtime?.isStreaming === true, 30_000);
  return plan;
}

async function reload(runtime) {
  const reply = await request(runtime.port, '/reload-code', { method: 'POST' });
  return reply;
}

async function sessionDetail(runtime, sessionId) {
  const reply = await request(runtime.port, `/sessions/${sessionId}`);
  const value = reply.value ?? {};
  return {
    statusCode: reply.statusCode,
    generationId: value.generationId ?? null,
    runtimeState: value.runtimeState ?? null,
    workerPid: value.workerPid ?? null,
    durable: value.durable ?? null,
    restoreCount: value.restoreCount ?? null,
    pinReasons: value.pinReasons ?? null,
    isStreaming: value.runtime?.isStreaming ?? null,
  };
}

/** 会话 SSE 上的事件表（reclaim 相位证「SSE 用可重连事件收尾」）。 */
async function watchSessionEvents(runtime, sessionId) {
  const stream = openSse(runtime.port, `/sessions/${sessionId}/events`);
  await stream.connected;
  await stream.waitFor((event) => event.event === 'session.snapshot', 20_000);
  return stream;
}

// ───────────────────── 沙箱代码副本（「只改沙箱那份」） ─────────────────────
// 两处补丁的**锚点**与**字面量**。锚点带上那一行自己的形状（`const … = /^\/sessions\/`），
// 这样“命中 1 行”这个判据本身就排除了注释、别的正则、别处的同名变量。
const SESSION_PATH_ANCHOR = 'const SESSION_PATH = /^\\/sessions\\/';
const SESSION_ROUTE_ANCHOR = 'const sessionMatch = /^\\/sessions\\/';
const SESSION_WORD_FROM = '|seen|draft))?$/';
const SESSION_WORD_TO = '|seen|draft|questions))?$/';
// ⚠️ 这一对字面量必须跟着 `server/base-logic.mjs` 的会话路由正则走（它加了动作名就得跟着加）：
// 2026-09-22 加了 `|seal`（「压缩即封存」的显式入口）。**判据没动**：照样是「把 `questions` 从
// 沙箱副本的路由正则里去掉」= 模拟陈旧逻辑层 ⇒ 那一相位要证明宿主仍按 owner 路由。
const STALE_ROUTE_FROM = '|archive|export|move|handoff|questions|seal))?$/';
const STALE_ROUTE_TO = '|archive|export|move|handoff|seal))?$/';

// ── 相位 ⑦（读路径的重试支）用的两个突变锚 ──
// 两处判定各一个：`server/base.mjs:1377`（`finishFailedProxy` 里的幂等重试 = M1）与
// `server/base.mjs:1299`（409 拦截里的幂等重试 = M2）。两处都用 `patchLineOnce` 的同一套硬判据：
// 锚点命中恰好 1 行、那一行里 `from` 恰好 1 处、改完逐行只有那一行变、`node --check` 两个平台都跑。
// ⚠️ 行号会随产品代码搬家（这份注释里的 1377/1299 是 2026-09-21 的 b798b4b）；锚点本身**不含行号**，
//    哪一行变了 `patchLineOnce` 会照实印出来（`line` 字段）——所以锚点没锚到会当场报错，不会静默跳过。
const FINISH_FAILED_IDEMPOTENT_ANCHOR = "  if (method === 'GET' || method === 'HEAD') {";
const FINISH_FAILED_IDEMPOTENT_FALSE = '  if (false) {   // (mutation 臂1反证：关掉 finishFailedProxy 的幂等重试)';
// M2 只改那一行里的**判定表达式**（`… ? currentWorker() : null` → `null`）——这一行里的 `{` 太普通，
// 锚在 `const retryWorker = `（全文件恰好 1 行）上；`from` 里带上 `? currentWorker() : null` 保证改的是判定。
const SWAP409_RETRY_ANCHOR = 'const retryWorker = ';
const SWAP409_RETRY_FROM = "(method === 'GET' || method === 'HEAD') ? currentWorker() : null";
const SWAP409_RETRY_NULL = 'null;   // (mutation 臂2反证：关掉 409 拦截的幂等重试)';

// 两条臂各跑几轮（任务要求「两个方向各 ≥3 次」）。
const READ_RETRY_ROUNDS = 3;
// 臂 2 那个窗口只有几毫秒宽（draining 代把这条 runtime 处置掉 → 宿主还没处理那条 owner 'cold'）⇒
// 用**顺序**的一串 GET（每发 ~1ms 往返）扫过那几毫秒；一旦有一发踩到，宿主那条拦截会先删掉映射
// ⇒ 后面自然都走 current 代（200）。
const READ_RETRY_BURST = 8;

/** 读一份文件 + 认出**它自己**的换行风格。
 *  为什么必须显式处理行尾：两个平台的检出可能一个 CRLF 一个 LF；若读改写时“顺手”normalize，
 *  两个平台跑的就不是同一份副本了 —— 而这道探针的全部论证都建立在「两侧只差一个词」上 ✗。
 *  顺手把往返做成硬判据：按认出的风格拼回去必须**逐字相同**（混合行尾的文件会被这条当场拦住，
 *  而不是被静默改写）。 */
async function readTextWithEol(file) {
  const text = await readFile(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  assert.equal(lines.join(eol), text, `${file}: 按认出的换行风格（${eol === '\r\n' ? 'CRLF' : 'LF'}）拼回去必须与原文件逐字相同 —— 这份文件的行尾是混合的？`);
  return { text, eol, lines };
}

/** 只改**命中锚点的那一行**，并把 `from` **恰一次**换掉；写回时用原文件自己的换行风格。
 *
 *  为什么不用整份文件的 `text.replace(from, to)`（这正是原来的写法）：
 *   · `String.replace` 只换**第一处**匹配，也不告诉你一共几处 —— 同一字面量若在文件里出现两次
 *     （注释、别的正则、别的副本），它会改到**别处**：副本被改坏，而原探针只断言 `after !== text`
 *     （“文本变了”）于是照样往下跑。这是「worker 起不来 ⇒ 502，却看不出病因」的一种解释。
 *   · 它也不校验改完还解析得了（那一半由 assertParses 用 `node --check` 在两个平台各跑一次兜底）。
 *  这里把四件事都变成硬判据：锚点命中**恰好 1 行**、那一行里 `from` **恰好 1 处**、改完**逐行只有
 *  那一行变**、写回的字节与打算写的一致。
 *  （`from` 在文件别处另有出现不算错 —— 我们**从不**碰那些行；但会把处数照实印出来，不静默。） */
async function patchLineOnce({ file, anchor, from, to, what }) {
  const { eol, lines } = await readTextWithEol(file);
  const hits = lines.map((line, index) => (line.includes(anchor) ? index : -1)).filter((index) => index >= 0);
  assert.equal(hits.length, 1, `${file}: 锚点 ${anchor} 必须恰好命中 1 行，实际 ${hits.length} 行（${what}）\n${JSON.stringify(hits.map((index) => ({ line: index + 1, text: lines[index]?.slice(0, 160) })))}`);
  const index = hits[0];
  const before = lines[index];
  const occurrences = before.split(from).length - 1;
  assert.equal(occurrences, 1, `${file}: 第 ${index + 1} 行里 ${from} 必须恰好 1 处（不是 1 就直接停），实际 ${occurrences} 处（${what}）\n该行逐字：${before}`);
  const after = before.replace(from, to);
  assert.notEqual(after, before, `${file}: 第 ${index + 1} 行替换后必须真的变了（${what}）`);
  const nextLines = [...lines];
  nextLines[index] = after;
  const changed = nextLines.map((line, i) => (line === lines[i] ? null : i + 1)).filter((value) => value !== null);
  assert.deepEqual(changed, [index + 1], `${file}: 打补丁只许改第 ${index + 1} 行，实际改了 ${JSON.stringify(changed)} 行（${what}）`);
  const next = nextLines.join(eol);
  await writeFile(file, next, 'utf8');
  const written = await readFile(file, 'utf8');
  assert.equal(written, next, `${file}: 写回的字节必须与打算写的一致（编码 / 行尾不许被悄悄改写）`);
  const elsewhere = lines.filter((line, i) => i !== index && line.includes(from)).length;
  return { line: index + 1, eol: eol === '\r\n' ? 'CRLF' : 'LF', before: before.trim(), after: after.trim(), occurrencesElsewhere: elsewhere };
}

/** 副本里那两份宿主代码都必须**解析得了**：`node --check`（**两个平台都跑**，不只在 Windows）。
 *  为什么：补丁打坏的语法在探针里只会表现成「worker 起不来 ⇒ 502」，看不出病因 ✗；
 *  这里把语法错误的原文直接带进异常 ✓。 */
async function assertParses(file) {
  try {
    await execFileAsync(process.execPath, ['--check', file]);
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    throw new Error(`${file} 打补丁后**解析失败**（node --check）：\n${detail}`);
  }
}

/**
 * 把仓里的 `server/**` 等复制成一份沙箱副本，并**只在副本里**钉住两个开关：
 *   · `sessionPathWord`：`SESSION_PATH` 那一行里**有没有** `questions`（true=带上那个词）。
 *     不论 trunk 当前是什么状态，两次调用（true/false）都能拿到两个可对照的臂 —— 那个词落地之后
 *     这道探针仍然可复现（不再依赖「trunk 恰好还没带上」）。
 *   · `stripQuestionsRoute`：把 `/sessions/…/questions` 从副本 base-logic.mjs 的路径正则里去掉，
 *     模拟「worker 装载于该路由落地**之前**」（arc 那台的情形）。
 */
async function makeCodeRoot(sandbox, name, { sessionPathWord = null, stripQuestionsRoute = false } = {}) {
  const root = path.join(sandbox, name);
  await mkdir(root, { recursive: true });
  for (const entry of ['server', 'web', 'pi-extensions', 'package.json']) {
    await cp(path.join(REPO_ROOT, entry), path.join(root, entry), { recursive: true });
  }
  const baseFile = path.join(root, 'server', 'base.mjs');
  if (sessionPathWord !== null) {
    // 「有没有那个词」只看**那一行**（不是整份文件里有没有这个字符串），并把它当硬判据。
    const { lines } = await readTextWithEol(baseFile);
    const line = lines.find((candidate) => candidate.includes(SESSION_PATH_ANCHOR));
    assert.ok(line, `${baseFile}: 找不到 ${SESSION_PATH_ANCHOR} 那一行（锚点行搬家了？）`);
    const wordPresent = line.includes(SESSION_WORD_TO);
    let patch = null;
    if (sessionPathWord && !wordPresent) {
      patch = await patchLineOnce({ file: baseFile, anchor: SESSION_PATH_ANCHOR, from: SESSION_WORD_FROM, to: SESSION_WORD_TO, what: 'SESSION_PATH 那一行加上 questions' });
    }
    if (!sessionPathWord && wordPresent) {
      patch = await patchLineOnce({ file: baseFile, anchor: SESSION_PATH_ANCHOR, from: SESSION_WORD_TO, to: SESSION_WORD_FROM, what: 'SESSION_PATH 那一行去掉 questions' });
    }
    // 只靠 `next !== text` 不足以证明钉住了：这里直接以「想要的状态 === 改完的状态」为准。
    if (sessionPathWord !== wordPresent && !patch) throw new Error(`${baseFile}: 期望把那个词钉成 ${sessionPathWord}，实际一处也没改到（锚点行：${line}）`);
    print('sandbox host copy SESSION_PATH pinned', {
      root,
      wanted: sessionPathWord ? 'with questions' : 'without questions',
      alreadyThere: wordPresent === sessionPathWord,
      line: patch?.line ?? null,
      eol: patch?.eol ?? null,
      before: patch?.before ?? line.trim(),
      after: patch?.after ?? line.trim(),
      sameLiteralElsewhere: patch?.occurrencesElsewhere ?? null,
    });
  }
  const logicFile = path.join(root, 'server', 'base-logic.mjs');
  if (stripQuestionsRoute) {
    const patch = await patchLineOnce({
      file: logicFile,
      anchor: SESSION_ROUTE_ANCHOR,
      from: STALE_ROUTE_FROM,
      to: STALE_ROUTE_TO,
      what: '把 questions 从沙箱副本的会话路由正则里去掉（模拟陈旧逻辑层）',
    });
    print('sandbox logic made "stale" (questions route removed from this copy only)', { root, logicFile, ...patch });
  }
  // **两个平台都跑**：副本必须解析得了。改坏了要当场看得见，不是等 worker 起不来再猜。
  for (const relative of ['server/base.mjs', 'server/base-logic.mjs']) await assertParses(path.join(root, relative));
  print('sandbox copy parses (node --check: base.mjs + base-logic.mjs)', { root });
  return root;
}

async function codeDigest(root) {
  const hash = createHash('sha256');
  for (const entry of ['server/base.mjs', 'server/base-logic.mjs']) {
    hash.update(entry);
    hash.update(await readFile(path.join(root, entry)));
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}

// ───────────────── 读沙箱日志里的 worker 口（直连 worker 当对照） ─────────────────
async function workerPorts(runtime) {
  const text = await readFile(runtime.logPath, 'utf8');
  return [...text.matchAll(/\{"event":"worker_ready"[^}]*\}/g)].map((match) => JSON.parse(match[0]));
}

function workerToken(hostPid, generationId, reason) {
  return createHash('sha256').update(`${hostPid}:${generationId}:${reason}`).digest('hex');
}

// ═══════════════════════════ 相位 ① ②：路径红/绿 + 404 逐字 ═══════════════════════════
async function phaseSessionPath(options) {
  const sandbox = path.join(SANDBOX_ROOT, `session-path-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });
  const providerPort = await reserveHighPort();
  const provider = await startFakeProvider(providerPort);
  let runtime = null;
  try {
    // ── 两个臂都是沙箱副本；trunk 当前是哪个状态只印出来（不拿它当事） ──
    const trunkLine = (await readFile(path.join(REPO_ROOT, 'server', 'base.mjs'), 'utf8')).split('\n').find((line) => line.includes('const SESSION_PATH'));
    print('trunk SESSION_PATH (verbatim, from ' + path.join(REPO_ROOT, 'server', 'base.mjs') + ')', trunkLine?.trim());
    print('trunk already has the word', { hasQuestions: Boolean(trunkLine?.includes('|questions')) });
    const redRoot = await makeCodeRoot(sandbox, 'root-without-word', { sessionPathWord: false });
    const greenRoot = await makeCodeRoot(sandbox, 'root-with-word', { sessionPathWord: true });
    print('code digests', {
      trunkRepo: await codeDigest(REPO_ROOT),
      redRoot: await codeDigest(redRoot),
      greenRoot: await codeDigest(greenRoot),
      plainCopyMatchesTrunk: await codeDigest(redRoot) === await codeDigest(REPO_ROOT),
      note: 'redRoot 与 greenRoot 只差 SESSION_PATH 那一个词；plainCopyMatchesTrunk 只在 trunk 尚未带上那个词时为 true',
    });

    // ════════ 第一幕：宿主副本 + **不带**那个词，逻辑层 = trunk ════════
    runtime = await startSandbox({ label: 'trunk', root: redRoot, sandbox, providerPort });
    const sessionId = await createSession(runtime, 'session-path trunk');
    await warmTurn(runtime, provider, sessionId, 'warm-trunk');
    print('act1 session', { sessionId, detail: await sessionDetail(runtime, sessionId) });

    // ①-a 同一个代里 POST /questions：宿主自己**没有**任何 questions 代码 ⇒ 拿到 201 只可能来自 worker
    const ask = await request(runtime.port, `/sessions/${sessionId}/questions`, { method: 'POST', body: { context: PROBE_ASK_CONTEXT, text: 'act1: 宿主到底代理了吗？' } });
    print('act1 POST /sessions/{id}/questions (same generation) VERBATIM', { statusCode: ask.statusCode, body: ask.raw.trim() });

    // ①-b 对照路径 1：**只在 worker 侧存在**的路由 `/export`（宿主枚举里也没有它）
    const exportReply = await request(runtime.port, `/sessions/${sessionId}/export`);
    print('act1 GET /sessions/{id}/export (host enum also lacks it) VERBATIM-HEAD', {
      statusCode: exportReply.statusCode,
      contentType: exportReply.headers?.['content-type'] ?? null,
      bytes: exportReply.headers?.['content-length'] ?? null,
      head: exportReply.raw.slice(0, 120),
    });

    // ①-c 对照路径 2：worker 兜底路由（worker.mjs:179）逐字
    const bogus = await request(runtime.port, `/sessions/${sessionId}/definitely-not-a-route`, { method: 'POST', body: {} });
    print('act1 POST /sessions/{id}/definitely-not-a-route (worker fallback) VERBATIM', { statusCode: bogus.statusCode, body: bogus.raw.trim() });

    // ①-d 缺会话（不是缺路由）：合法 uuid 但不存在
    const ghost = randomUUID();
    const ghostReply = await request(runtime.port, `/sessions/${ghost}/questions`, { method: 'POST', body: { text: 'act1: 这条会话不存在' } });
    print('act1 POST /sessions/{random uuid}/questions (session missing) VERBATIM', { statusCode: ghostReply.statusCode, body: ghostReply.raw.trim() });

    // ①-e 会话 id 片段：宿主那条路（匹配得上的动作）与兜底那条路（匹配不上的动作）各一次
    const prefix = sessionId.slice(0, 8);
    const prefixTitle = await request(runtime.port, `/sessions/${prefix}/title`, { method: 'POST', body: { title: 'x' } });
    const prefixQuestions = await request(runtime.port, `/sessions/${prefix}/questions`, { method: 'POST', body: { text: 'act1: 片段 id' } });
    print('act1 uuid-prefix /title (host-matched) VERBATIM', { statusCode: prefixTitle.statusCode, body: prefixTitle.raw.trim() });
    print('act1 uuid-prefix /questions (host-unmatched) VERBATIM', { statusCode: prefixQuestions.statusCode, body: prefixQuestions.raw.trim() });

    // ①-f 直连 worker（带宿主 spawn 时写的 token）当第三份对照：同一条路由 worker 自己答什么
    const workers1 = await workerPorts(runtime);
    const g1 = runtime.host.currentGenerationId;
    const g1Port = workers1.find((worker) => worker.generationId === g1)?.port;
    const direct = await request(g1Port, `/sessions/${sessionId}/questions`, {
      method: 'POST',
      body: { context: PROBE_ASK_CONTEXT, text: 'act1: 直连 worker 的同一路由' },
      headers: { 'x-sopho-worker-token': workerToken(runtime.hostPid, g1, 'boot') },
    });
    const directBogus = await request(g1Port, `/sessions/${sessionId}/definitely-not-a-route`, {
      method: 'POST',
      body: {},
      headers: { 'x-sopho-worker-token': workerToken(runtime.hostPid, g1, 'boot') },
    });
    print('act1 direct-to-worker POST /questions VERBATIM', { workerPort: g1Port, statusCode: direct.statusCode, body: direct.raw.trim() });
    print('act1 direct-to-worker POST /definitely-not-a-route VERBATIM', { workerPort: g1Port, statusCode: directBogus.statusCode, body: directBogus.raw.trim() });

    // ════════ 第一幕 · 红：draining 窗口里的**写**由谁服务 ════════
    // 会话必须**忙住**（busy 的不会被 draining 逐出），否则它一到 draining 就被自动回收，
    // 窗口就不存在了。
    const hold = await startHoldTurn(runtime, provider, sessionId, 'act1: 忙住这条会话当 draining 窗口');
    const beforeReload = await getHost(runtime);
    print('act1 before reload /host', beforeReload.snapshot);
    const reloadReply = await reload(runtime);
    print('act1 POST /reload-code VERBATIM', { statusCode: reloadReply.statusCode, body: reloadReply.raw.trim() });
    const afterReload = await getHost(runtime);
    const g2 = afterReload.snapshot.currentGenerationId;
    print('act1 after reload /host', afterReload.snapshot);
    print('act1 the busy session stays on the draining generation', { g1, g2, owners: { [g1]: ownedBy(afterReload.snapshot, g1), [g2]: ownedBy(afterReload.snapshot, g2) } });
    const hotOf = (snapshot, generationId) => snapshot.workers.find((worker) => worker.generationId === generationId)?.hot ?? null;
    // 前置事实（两个臂共有）：忙住的会话没被逐出 ⇒ owner 映射还在 draining 代上，current 代一个 runtime 都没开。
    await expectStatus(reloadReply, 200, {
      what: 'act1 POST /reload-code',
      why: '只有真换了一代，下面才有 draining 窗口可量；409（上一代没退干净）会让这一幕什么都没量到',
      runtime, sessionId,
    });
    assert.notEqual(g2, g1, `reload 必须换一代：${JSON.stringify({ g1, g2 })}`);
    assert.ok(ownedBy(afterReload.snapshot, g1).includes(sessionId), `忙住的会话应当仍由 draining 代(g1)持有：${JSON.stringify(afterReload.snapshot)}`);
    assert.equal(hotOf(afterReload.snapshot, g2), 0, `reload 后 current 代(g2)应当冷着（hot:0）：${JSON.stringify(afterReload.snapshot.workers)}`);

    // 背靠背：`/title`（枚举里）⇒ 由 g1 服务（对照臂）；`/questions`（本臂的宿主副本**去掉了**那个词）⇒ 由 g2 服务
    const titleReply = await request(runtime.port, `/sessions/${sessionId}/title`, { method: 'POST', body: { title: 'act1 owner-route control' } });
    const afterTitle = await getHost(runtime);
    print('act1 back-to-back A: POST /title (in the enum) VERBATIM', { statusCode: titleReply.statusCode, body: titleReply.raw.trim() });
    print('act1 after /title /host', { owners: { [g1]: ownedBy(afterTitle.snapshot, g1), [g2]: ownedBy(afterTitle.snapshot, g2) }, hot: afterTitle.snapshot.workers.map((worker) => ({ g: worker.generationId, hot: worker.hot, state: worker.state })) });
    // 对照臂硬断言：枚举里的动作在 draining 窗口里**落回 owner**，不惊动 current 代。
    await expectStatus(titleReply, 200, {
      what: 'act1 对照臂 POST /title（枚举里的动作）',
      why: '对照臂必须同台可用：它 200 才能说明“枚举里的写走 owner”那条路由是活的',
      runtime, sessionId,
    });
    assert.ok(ownedBy(afterTitle.snapshot, g1).includes(sessionId), `对照臂：/title 应由 owner(g1) 服务：${JSON.stringify(afterTitle.snapshot)}`);
    assert.equal(hotOf(afterTitle.snapshot, g2), 0, `对照臂：/title 不许惊动 current 代(g2)：${JSON.stringify(afterTitle.snapshot.workers)}`);

    const redAsk = await request(runtime.port, `/sessions/${sessionId}/questions`, { method: 'POST', body: { context: PROBE_ASK_CONTEXT, text: 'act1 RED: draining 窗口里写问题' } });
    const afterRed = await getHost(runtime);
    print('act1 back-to-back B (RED): POST /questions (NOT in the enum) VERBATIM', { statusCode: redAsk.statusCode, body: redAsk.raw.trim() });
    print('act1 RED /host after /questions', { owners: { [g1]: ownedBy(afterRed.snapshot, g1), [g2]: ownedBy(afterRed.snapshot, g2) }, hot: afterRed.snapshot.workers.map((worker) => ({ g: worker.generationId, hot: worker.hot, state: worker.state })) });
    print('act1 RED verdict-input', {
      g1Owns: ownedBy(afterRed.snapshot, g1).includes(sessionId),
      g2Owns: ownedBy(afterRed.snapshot, g2).includes(sessionId),
      note: 'g1 是 owner（会话在它上面忙）；g2 是 current。两个代同时持有 = 两个 writer。',
    });
    // ═══ A 面（旧行为）的**硬断言**：这就是「写 owner 唯一」被破的那一格，必须永久可复现。═══
    // 没有那个词 ⇒ `/questions` 落末尾兜底 proxy 到 current worker ⇒ g2 冷开了第二个 runtime（hot 0→1）、
    // 并把 owner 映射从 g1 手里接管过去；而 g1 自己那一代**仍然热着**同一个会话（hot 仍为 1）⇒ 真的两个 writer。
    await expectStatus(redAsk, 201, {
      what: 'RED arm（宿主副本**不带**那个词）：draining 窗口里的 POST /questions',
      why: '201 才意味着**有人真的受理了这次写**：没有那个词 ⇒ 宿主匹配不上这条路径 ⇒ 落末尾兜底 proxy 给 current worker',
      runtime, sessionId,
    });
    assert.ok(ownedBy(afterRed.snapshot, g2).includes(sessionId), `RED arm：/questions 应当让 current 代(g2)接管 owner 映射：${JSON.stringify(afterRed.snapshot)}`);
    assert.ok(!ownedBy(afterRed.snapshot, g1).includes(sessionId), `RED arm：owner 映射应当已从 g1 手里消失：${JSON.stringify(afterRed.snapshot)}`);
    assert.equal(hotOf(afterRed.snapshot, g2), 1, `RED arm：current 代(g2)应当冷开了第二个 runtime（hot 0→1）：${JSON.stringify(afterRed.snapshot.workers)}`);
    assert.equal(hotOf(afterRed.snapshot, g1), 1, `RED arm：g1 自己那一代应当仍然热着同一个会话（两个 writer）：${JSON.stringify(afterRed.snapshot.workers)}`);
    print('act1 RED assert summary', { twoWriters: true, g1Hot: hotOf(afterRed.snapshot, g1), g2Hot: hotOf(afterRed.snapshot, g2) });
    hold.release();
    await poll('g1 drains after the turn finishes', async () => (await getHost(runtime)).snapshot, (snapshot) => snapshot.draining.length === 0, 60_000);
    print('act1 g1 exited after the held turn finished', (await getHost(runtime)).snapshot);
    // 红窗口的**后果**（只报量到的）：同一个会话文件里是否同时留住了两代各写的条目。
    print('act1 JSONL after the RED window (g2 wrote the question while g1 held the in-flight turn)', await sessionEntrySummary(runtime.sessionsRoot, sessionId));

    // ════════ 第一幕 · 钉死 arc 那个 404 的真因：worker 的逻辑层里没有这条路由 ════════
    // 只改沙箱副本：把 `|questions` 从副本 base-logic.mjs 的路径正则里去掉，然后**冷启动**宿主
    // —— 这与 arc 那台的情形同构（它那个 worker 装载于 questions 路由落地**之前**）。
    await stopSandbox(runtime);
    runtime = null;
    const staleRoot = await makeCodeRoot(sandbox, 'root-stale-logic', { sessionPathWord: false, stripQuestionsRoute: true });
    print('act1 stale-logic copy digest', { staleRoot, digest: await codeDigest(staleRoot) });
    runtime = await startSandbox({ label: 'stale-logic', root: staleRoot, sandbox, providerPort });
    const staleSession = await createSession(runtime, 'stale logic');
    await warmTurn(runtime, provider, staleSession, 'warm-stale');
    const staleAsk = await request(runtime.port, `/sessions/${staleSession}/questions`, { method: 'POST', body: { text: 'act1: 逻辑层没有这条路由' } });
    print('act1 ARC REPLAY: POST /questions on a worker whose logic predates the route VERBATIM', { statusCode: staleAsk.statusCode, body: staleAsk.raw.trim() });
    // 钉死：那个 404 是 **worker** 的未命中兜底（`{"error":"not found"}`），不是“缺路由”的另一种形状。
    await expectStatus(staleAsk, 404, {
      what: 'act1 ARC REPLAY（陈旧逻辑层）：POST /questions',
      why: '期望的是 **worker 自己**的未命中兜底 404（error:"not found"），不是宿主那种缺会话 404（session_not_found），也不是 502/503',
      runtime, sessionId: staleSession,
    });
    assert.equal(staleAsk.value?.error, 'not found', `陈旧逻辑层的 404 body 应当是 worker 兜底：${staleAsk.raw}`);
    const staleWorkers = await workerPorts(runtime);
    const staleGen = runtime.host.currentGenerationId;
    const stalePort = staleWorkers.find((worker) => worker.generationId === staleGen)?.port;
    const staleDirect = await request(stalePort, `/sessions/${staleSession}/questions`, {
      method: 'POST',
      body: { text: 'act1: 直连陈旧 worker' },
      headers: { 'x-sopho-worker-token': workerToken(runtime.hostPid, staleGen, 'boot') },
    });
    print('act1 ARC REPLAY direct-to-worker (same body ⇒ 那个 404 是 worker 说的) VERBATIM', { workerPort: stalePort, statusCode: staleDirect.statusCode, body: staleDirect.raw.trim() });
    // 直连 worker 同字 ⇒ 宿主只是把它代理回来（“宿主自己不吐 error:"not found"”）。
    assert.equal(staleDirect.statusCode, staleAsk.statusCode, `直连 worker 应当与宿主代理回来的一样：${staleDirect.raw} vs ${staleAsk.raw}`);
    assert.equal(staleDirect.raw.trim(), staleAsk.raw.trim(), `两边 body 必须一字不差：${staleDirect.raw.trim()} vs ${staleAsk.raw.trim()}`);
    const staleTitle = await request(runtime.port, `/sessions/${staleSession}/title`, { method: 'POST', body: { title: 'still works' } });
    print('act1 ARC REPLAY control: POST /title still works VERBATIM', { statusCode: staleTitle.statusCode, body: staleTitle.raw.trim() });
    await expectStatus(staleTitle, 200, {
      what: 'act1 ARC REPLAY 对照：同台 POST /title',
      why: '同一个陈旧 worker 上，枚举里的动作照旧 200 ⇒ 那个 404 是“这条路由没了”，不是“这台机器/这份副本坏了”',
      runtime, sessionId: staleSession,
    });
    await stopSandbox(runtime);
    runtime = null;

    // ════════ 第二幕 · 绿：宿主副本带上那个词 ════════
    runtime = await startSandbox({ label: 'patched', root: greenRoot, sandbox, providerPort });
    const greenSession = await createSession(runtime, 'session-path patched');
    await warmTurn(runtime, provider, greenSession, 'warm-patched');
    const greenSame = await request(runtime.port, `/sessions/${greenSession}/questions`, { method: 'POST', body: { context: PROBE_ASK_CONTEXT, text: 'act2: 同代（补丁不该改变这档的行为）' } });
    print('act2 POST /questions in the SAME generation (patched host) VERBATIM', { statusCode: greenSame.statusCode, body: greenSame.raw.trim() });
    // 同一个代里（没有 draining 窗口）：带上那个词不该改变这档的行为。
    await expectStatus(greenSame, 201, {
      what: 'act2 补丁宿主：同代（无 draining 窗口）的 POST /questions',
      why: '同一个代里那个词不该改变这档的行为：它仍是 201',
      runtime, sessionId: greenSession,
    });

    const greenHold = await startHoldTurn(runtime, provider, greenSession, 'act2: 忙住它当 draining 窗口');
    const greenBefore = await getHost(runtime);
    const greenG1 = greenBefore.snapshot.currentGenerationId;
    const greenReload = await reload(runtime);
    print('act2 POST /reload-code VERBATIM', { statusCode: greenReload.statusCode, body: greenReload.raw.trim() });
    const greenAfterReload = await getHost(runtime);
    const greenG2 = greenAfterReload.snapshot.currentGenerationId;
    print('act2 after reload /host', { owners: { [greenG1]: ownedBy(greenAfterReload.snapshot, greenG1), [greenG2]: ownedBy(greenAfterReload.snapshot, greenG2) } });
    // B 面（新行为）的前置事实：与 A 面同构 —— 忙住的会话留在 g1，g2 冷着。
    await expectStatus(greenReload, 200, {
      what: 'act2 补丁宿主：POST /reload-code',
      why: '只有真换了一代，下面那个 draining 窗口里的写才是在“带词宿主 + 新一代”上量的',
      runtime, sessionId: greenSession,
    });
    assert.notEqual(greenG2, greenG1, `reload 必须换一代：${JSON.stringify({ greenG1, greenG2 })}`);
    assert.ok(ownedBy(greenAfterReload.snapshot, greenG1).includes(greenSession), `忙住的会话应当仍由 draining 代(g1)持有：${JSON.stringify(greenAfterReload.snapshot)}`);
    assert.equal(hotOf(greenAfterReload.snapshot, greenG2), 0, `reload 后 current 代(g2)应当冷着（hot:0）：${JSON.stringify(greenAfterReload.snapshot.workers)}`);
    const greenAsk = await request(runtime.port, `/sessions/${greenSession}/questions`, { method: 'POST', body: { context: PROBE_ASK_CONTEXT, text: 'act2 GREEN: draining 窗口里写问题' } });
    const greenAfterAsk = await getHost(runtime);
    print('act2 GREEN: POST /questions in the draining window VERBATIM', { statusCode: greenAsk.statusCode, body: greenAsk.raw.trim() });
    print('act2 GREEN /host after /questions', { owners: { [greenG1]: ownedBy(greenAfterAsk.snapshot, greenG1), [greenG2]: ownedBy(greenAfterAsk.snapshot, greenG2) }, hot: greenAfterAsk.snapshot.workers.map((worker) => ({ g: worker.generationId, hot: worker.hot, state: worker.state })) });
    print('act2 GREEN verdict-input', {
      g1Owns: ownedBy(greenAfterAsk.snapshot, greenG1).includes(greenSession),
      g2Owns: ownedBy(greenAfterAsk.snapshot, greenG2).includes(greenSession),
      g2Hot: hotOf(greenAfterAsk.snapshot, greenG2),
      note: '补丁后：请求落在 owner(g1)；g2 不持有、hot 不变。',
    });
    // ═══ B 面（新行为）的**硬断言**：带上那个词 ⇒ draining 窗口里的 `/questions` 落回 owner(g1)，
    // current 代(g2) 的 hot 保持 0（第二个 runtime 没开）、owner 映射不变 ⇒ 「写 owner 唯一」成立。═══
    await expectStatus(greenAsk, 201, {
      what: 'GREEN arm（补丁宿主）：draining 窗口里的 POST /questions',
      why: '带着那个词的宿主应当把这条写**落回 owner** 并 201；502/503 说明请求根本没到 worker，不是这条路由的结论',
      runtime, sessionId: greenSession,
    });
    assert.ok(ownedBy(greenAfterAsk.snapshot, greenG1).includes(greenSession), `GREEN arm：/questions 必须仍由 owner(g1) 服务：${JSON.stringify(greenAfterAsk.snapshot)}`);
    assert.ok(!ownedBy(greenAfterAsk.snapshot, greenG2).includes(greenSession), `GREEN arm：current 代(g2) 不许接管 owner 映射：${JSON.stringify(greenAfterAsk.snapshot)}`);
    assert.equal(hotOf(greenAfterAsk.snapshot, greenG2), 0, `GREEN arm：current 代(g2) 的 hot 必须保持 0（第二个 runtime 没开）：${JSON.stringify(greenAfterAsk.snapshot.workers)}`);
    print('act2 GREEN assert summary', { servedByOwner: true, g1Hot: hotOf(greenAfterAsk.snapshot, greenG1), g2Hot: hotOf(greenAfterAsk.snapshot, greenG2) });
    const greenTitle = await request(runtime.port, `/sessions/${greenSession}/title`, { method: 'POST', body: { title: 'act2 owner-route control' } });
    print('act2 control: POST /title in the same window VERBATIM', { statusCode: greenTitle.statusCode, body: greenTitle.raw.trim() });
    await expectStatus(greenTitle, 200, {
      what: 'GREEN arm 对照：同窗口 POST /title',
      why: '对照臂同台 200 ⇒ 上面那个 201 不是“这台机器只有一条路能走”',
      runtime, sessionId: greenSession,
    });
    greenHold.release();
    await poll('patched sandbox g1 drains', async () => (await getHost(runtime)).snapshot, (snapshot) => snapshot.draining.length === 0, 60_000);

    // 第二幕 · 那个词**不修**逻辑层陈旧的 404（补丁宿主 + 陈旧逻辑）
    await stopSandbox(runtime);
    const greenStaleRoot = await makeCodeRoot(sandbox, 'root-with-word-stale-logic', { sessionPathWord: true, stripQuestionsRoute: true });
    runtime = await startSandbox({ label: 'patched-stale', root: greenStaleRoot, sandbox, providerPort });
    const patchedStaleSession = await createSession(runtime, 'patched host, stale logic');
    await warmTurn(runtime, provider, patchedStaleSession, 'warm-patched-stale');

    // ⚠️ 这一步必须先让**路由确定**，否则两个平台判的不是同一件事（2026-09-21 Linux 稳定红的那一格）：
    //   补丁宿主把 `/questions` 匹配进 SESSION_PATH ⇒ 走 **owner 路由**（`sessionRoute`）。若这条会话只是
    //   **闲置**热着，`POST /reload-code` 之后老代(g1) 会被要求排空：它把闲置 runtime 逐出、自己退场。
    //   请求若正好落在「老代已经开始 shutdown、而宿主还没收到它的 exit」那条缝里，老代已经把自己的
    //   socket 扫掉了（`server/worker.mjs` 的 `shutdown()`：`for (const socket of openSockets) socket.destroy()`）
    //   ⇒ 宿主拿到 `read ECONNRESET`（**不是** `connect ECONNREFUSED`：连接已经建立过）⇒ 502
    //   `{"error":"worker unavailable","message":"read ECONNRESET"}` ⇒ 断言拿到 502 !== 404 而红。
    //   那是**探针自己的竞态**（这条请求归谁服务取决于微时序），不是产品行为 ⇒ 按 act1 的做法把会话
    //   **忙住**：老代活着、持有它、逻辑陈旧 ⇒ 这条路由**确定地**由老代服务（前面的 hold 就是“别让
    //   老代在这一刻死掉”）。
    const staleHold = await startHoldTurn(runtime, provider, patchedStaleSession, 'act2: 忙住它，让陈旧的老代活着服务这条路由');
    const staleOwnerGeneration = (await getHost(runtime)).snapshot.currentGenerationId;
    const patchedStaleReload = await reload(runtime);
    print('act2 POST /reload-code to load stale logic behind the patched host VERBATIM', { statusCode: patchedStaleReload.statusCode, body: patchedStaleReload.raw.trim() });
    await expectStatus(patchedStaleReload, 200, {
      what: '陈旧逻辑那一幕：POST /reload-code',
      why: '只有真换了一代，后面那条请求才是在“补丁宿主 + 逻辑陈旧的 worker”上问的；409（上一代还没退干净）会让这一幕问错东西',
      runtime, sessionId: patchedStaleSession,
    });
    const staleRouting = await getHost(runtime);
    const staleCurrentGeneration = staleRouting.snapshot.currentGenerationId;
    const staleOwnerPid = staleRouting.snapshot.workers.find((worker) => worker.generationId === staleOwnerGeneration)?.pid ?? null;
    // 前置事实（不是结论）：owner(g1) 必须**活着**持有这条会话，current 代必须冷着 ——
    // 这两条一旦成立，下面那条 404 就只可能来自那个陈旧的 owner。
    assert.notEqual(staleCurrentGeneration, staleOwnerGeneration, `reload 必须换一代：${JSON.stringify({ staleOwnerGeneration, staleCurrentGeneration })}`);
    assert.ok(ownedBy(staleRouting.snapshot, staleOwnerGeneration).includes(patchedStaleSession),
      `前置事实：忙住的会话必须仍由 draining 代(${staleOwnerGeneration})持有 —— 否则这条路由会被别的代服务，断言就不是在问“陈旧逻辑”了：${JSON.stringify(staleRouting.snapshot)}`);
    assert.equal(hotOf(staleRouting.snapshot, staleCurrentGeneration), 0,
      `前置事实：current 代(${staleCurrentGeneration}) 必须冷着 —— 否则 404 可能来自它而不是陈旧的 owner：${JSON.stringify(staleRouting.snapshot.workers)}`);
    print('act2 the ask below is pinned to the stale owner generation', {
      ownerGeneration: staleOwnerGeneration,
      ownerPid: staleOwnerPid,
      ownerProcessAlive: staleOwnerPid === null ? null : alive(staleOwnerPid),
      currentGeneration: staleCurrentGeneration,
      draining: staleRouting.snapshot.draining,
    });
    const patchedStaleAsk = await request(runtime.port, `/sessions/${patchedStaleSession}/questions`, { method: 'POST', body: { text: 'act2: 补丁宿主 + 陈旧逻辑' } });
    print('act2 PATCHED HOST + STALE LOGIC: POST /questions VERBATIM', { statusCode: patchedStaleAsk.statusCode, body: patchedStaleAsk.raw.trim() });
    // 那个词**不治**逻辑层陈旧的 404。这里期望的是**逐字**那一种：
    //   · 404 + `{"error":"not found"}` = **worker** 自己的未命中兜底
    //     （`server/worker.mjs`：`if (!handled && !response.headersSent) sendJson(response, 404, { error: 'not found' })`）；
    //   · **不是**宿主那种 404（`{"error":"session_not_found","message":"session not found: <uuid>"}`，那是“缺会话”，
    //     而这一暮里会话**存在**）；
    //   · 也**不是** 502/503（那是“请求根本没到 worker”，不是“worker 说没有这条路由”）。
    await expectStatus(patchedStaleAsk, 404, {
      what: '补丁宿主 + 陈旧逻辑：POST /questions',
      why: '宿主侧那个词不改变“逻辑层里没有这条路由”这件事 —— 陈旧的 worker 仍然只回它自己的未命中兜底 404',
      runtime, sessionId: patchedStaleSession,
      extra: { ownerGeneration: staleOwnerGeneration, ownerPid: staleOwnerPid, currentGeneration: staleCurrentGeneration },
    });
    assert.equal(patchedStaleAsk.value?.error, 'not found',
      `补丁宿主 + 陈旧逻辑的 404 body 必须是 worker 兜底 {"error":"not found"}（不是宿主那种 session_not_found）：${patchedStaleAsk.raw}`);
    // 那个词让写**落回 owner**：这一慕里 current 代也不该被惊动（与第二幕 GREEN 同一条事实，服务者换成了陈旧逻辑）。
    const staleAfterAsk = await getHost(runtime);
    assert.equal(hotOf(staleAfterAsk.snapshot, staleCurrentGeneration), 0,
      `陈旧逻辑那一幕也应由 owner 服务：current 代(${staleCurrentGeneration}) 的 hot 必须保持 0：${JSON.stringify(staleAfterAsk.snapshot.workers)}`);

    // 老代退完之后再问一次：这时**只剩 current 代**（同一份陈旧逻辑）能服务 —— 同一件事的另一个服务者。
    staleHold.release();
    await poll('patched-stale g1 drains after the held turn finished', async () => (await getHost(runtime)).snapshot, (snapshot) => snapshot.draining.length === 0, 60_000);
    const coldStaleAsk = await request(runtime.port, `/sessions/${patchedStaleSession}/questions`, { method: 'POST', body: { text: 'act2: 老代退完后只剩 current 代（同样陈旧逻辑）' } });
    print('act2 PATCHED HOST + STALE LOGIC after the old generation exited: POST /questions VERBATIM', { statusCode: coldStaleAsk.statusCode, body: coldStaleAsk.raw.trim() });
    await expectStatus(coldStaleAsk, 404, {
      what: '补丁宿主 + 陈旧逻辑：老代退完之后的 POST /questions',
      why: '这时唯一的服务者是 current 代（同一份陈旧逻辑）⇒ 同样是 worker 的未命中兜底 404（上一条是老代答的，这条是 current 答的）',
      runtime, sessionId: patchedStaleSession,
    });
    assert.equal(coldStaleAsk.value?.error, 'not found', `老代退完之后的 404 body 也必须是 worker 兜底：${coldStaleAsk.raw}`);
    await stopSandbox(runtime);
    runtime = null;
  } finally {
    if (runtime) await stopSandbox(runtime).catch((error) => process.stderr.write(`stopSandbox failed: ${error.message}\n`));
    provider.server.close();
    if (!options.keep) await removeSandbox(sandbox, cleanupProblems);
    else print('sandbox kept', sandbox);
  }
}

// ═══════════════════════════ 相位 ③：/reclaim 备料 ═══════════════════════════
async function phaseReclaim(options) {
  const sandbox = path.join(SANDBOX_ROOT, `reclaim-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });
  const providerPort = await reserveHighPort();
  const provider = await startFakeProvider(providerPort);
  let runtime = null;
  let stream = null;
  try {
    runtime = await startSandbox({ label: 'reclaim', root: REPO_ROOT, sandbox, providerPort });
    const g1 = runtime.host.currentGenerationId;
    print('reclaim start', { g1, hostPid: runtime.hostPid });

    // 四形状摆在一代上：闲置 / 闲置+SSE 订阅者 / 真在跑 / 从没落盘
    const idleSession = await createSession(runtime, 'idle reclaimable');
    await warmTurn(runtime, provider, idleSession, 'warm-idle');
    const pinnedSession = await createSession(runtime, 'idle pinned by a subscriber');
    await warmTurn(runtime, provider, pinnedSession, 'warm-pinned');
    stream = await watchSessionEvents(runtime, pinnedSession);
    const runningSession = await createSession(runtime, 'long turn must be refused');
    await warmTurn(runtime, provider, runningSession, 'warm-running');
    const hold = await startHoldTurn(runtime, provider, runningSession, 'reclaim: hold this turn');
    const pendingSession = await createSession(runtime, 'never persisted');
    print('reclaim layout', { idleSession, pinnedSession, runningSession, pendingSession });
    for (const [label, id] of [['idle', idleSession], ['pinned', pinnedSession], ['running', runningSession], ['pending', pendingSession]]) {
      print(`reclaim before facts (${label})`, await fileFacts(runtime.sessionsRoot, id));
      print(`reclaim before detail (${label})`, await sessionDetail(runtime, id));
    }
    const beforeFiles = {
      idle: await fileFacts(runtime.sessionsRoot, idleSession),
      pinned: await fileFacts(runtime.sessionsRoot, pinnedSession),
      running: await fileFacts(runtime.sessionsRoot, runningSession),
    };

    // ① dry-run：只报不收
    const dry = await request(runtime.port, '/reclaim', { method: 'POST', body: { dryRun: true } });
    print('reclaim ① POST /reclaim {"dryRun":true} VERBATIM', { statusCode: dry.statusCode, body: dry.raw.trim() });
    const dryAfterIdle = await fileFacts(runtime.sessionsRoot, idleSession);
    const dryAfterPinned = await fileFacts(runtime.sessionsRoot, pinnedSession);
    print('reclaim ① dry-run touched nothing', {
      idle: { sha256Before: beforeFiles.idle.sha256, sha256After: dryAfterIdle.sha256, unchanged: beforeFiles.idle.sha256 === dryAfterIdle.sha256 },
      pinned: { sha256Before: beforeFiles.pinned.sha256, sha256After: dryAfterPinned.sha256, unchanged: beforeFiles.pinned.sha256 === dryAfterPinned.sha256 },
      idleDetail: await sessionDetail(runtime, idleSession),
      pinnedDetail: await sessionDetail(runtime, pinnedSession),
    });
    assert.equal(dryAfterIdle.sha256, beforeFiles.idle.sha256, 'dry-run 不许动会话文件（idle）');
    assert.equal(dryAfterPinned.sha256, beforeFiles.pinned.sha256, 'dry-run 不许动会话文件（pinned）');

    // ② 真收（不带 includePinned）
    const reclaimDefault = await request(runtime.port, '/reclaim', { method: 'POST', body: {} });
    print('reclaim ② POST /reclaim {} VERBATIM', { statusCode: reclaimDefault.statusCode, body: reclaimDefault.raw.trim() });
    const afterDefault = {
      idle: await fileFacts(runtime.sessionsRoot, idleSession),
      pinned: await fileFacts(runtime.sessionsRoot, pinnedSession),
      running: await fileFacts(runtime.sessionsRoot, runningSession),
    };
    print('reclaim ② session files after POST /reclaim {}', {
      idle: { unchanged: beforeFiles.idle.sha256 === afterDefault.idle.sha256, before: beforeFiles.idle, after: afterDefault.idle },
      pinned: { unchanged: beforeFiles.pinned.sha256 === afterDefault.pinned.sha256, before: beforeFiles.pinned, after: afterDefault.pinned },
      running: { unchanged: beforeFiles.running.sha256 === afterDefault.running.sha256, before: beforeFiles.running, after: afterDefault.running },
    });
    // 硬断言（任务点名的那一条）：收掉 runtime **不许动会话文件**，在跑的回合也一律不收/不改。
    assert.equal(afterDefault.idle.sha256, beforeFiles.idle.sha256, '收掉 runtime 不许改会话文件（idle）');
    assert.equal(afterDefault.pinned.sha256, beforeFiles.pinned.sha256, '未收的 pinned（带订阅者）不许被动');
    assert.equal(afterDefault.running.sha256, beforeFiles.running.sha256, '在跑的回合不许被回收、也不许改文件');
    print('reclaim ② detail after POST /reclaim {}', {
      idle: await sessionDetail(runtime, idleSession),
      pinned: await sessionDetail(runtime, pinnedSession),
      running: await sessionDetail(runtime, runningSession),
      pending: await sessionDetail(runtime, pendingSession),
    });

    // ③ 带 includePinned：把「只有 SSE 订阅者」那种闲置也收掉，并把那一路用可重连事件收尾
    const reclaimPinned = await request(runtime.port, '/reclaim', { method: 'POST', body: { includePinned: true } });
    print('reclaim ③ POST /reclaim {"includePinned":true} VERBATIM', { statusCode: reclaimPinned.statusCode, body: reclaimPinned.raw.trim() });
    const afterPinned = {
      idle: await fileFacts(runtime.sessionsRoot, idleSession),
      pinned: await fileFacts(runtime.sessionsRoot, pinnedSession),
      running: await fileFacts(runtime.sessionsRoot, runningSession),
    };
    print('reclaim ③ session files after includePinned', {
      idle: { unchanged: beforeFiles.idle.sha256 === afterPinned.idle.sha256, beforeSha: beforeFiles.idle.sha256, afterSha: afterPinned.idle.sha256 },
      pinned: { unchanged: beforeFiles.pinned.sha256 === afterPinned.pinned.sha256, before: beforeFiles.pinned, after: afterPinned.pinned },
      running: { unchanged: beforeFiles.running.sha256 === afterPinned.running.sha256 },
    });
    assert.equal(afterPinned.pinned.sha256, beforeFiles.pinned.sha256, 'includePinned 收掉 runtime 也不许改会话文件（pinned）');
    assert.equal(afterPinned.running.sha256, beforeFiles.running.sha256, 'includePinned 也不许收在跑的回合（文件不动）');
    print('reclaim ③ detail after includePinned', {
      pinned: await sessionDetail(runtime, pinnedSession),
      running: await sessionDetail(runtime, runningSession),
    });
    let retryable = null;
    try {
      retryable = await stream.waitFor((event) => event.event === 'server.reload' && event.data?.retry === true, 10_000);
    } catch (error) {
      retryable = { error: error.message };
    }
    print('reclaim ③ the reclaimed pinned runtime got a retryable end', retryable);

    // ④ 重建：从 JSONL 重开（会话文件一字未变 + 历史照旧）
    const rebuild = {};
    for (const [label, id] of [['idle', idleSession], ['pinned', pinnedSession]]) {
      const acquire = await request(runtime.port, `/sessions/${id}/commands`);
      const detail = await poll(`rebuild ${label}`, async () => sessionDetail(runtime, id), (value) => value.generationId !== null, 30_000);
      const messages = await request(runtime.port, `/sessions/${id}/messages`);
      rebuild[label] = {
        commandsStatus: acquire.statusCode,
        detail,
        workerPid: detail.workerPid,
        texts: (messages.value?.messages ?? []).map((message) => String(message.text).slice(0, 80)),
      };
    }
    print('reclaim ④ rebuild from JSONL', rebuild);
    // 硬断言：收掉之后靠 GET /sessions/{id}/commands 会 acquire（从 JSONL 重建 ⇒ restoreCount 1）；
    // 重建**不许**改动会话文件（与「收 runtime 不动会话文件」是同一条事实的两个时点）。
    for (const label of ['idle', 'pinned']) {
      assert.equal(rebuild[label].commandsStatus, 200, `重建应当 200（${label}）：${JSON.stringify(rebuild[label])}`);
      assert.ok(rebuild[label].detail.generationId !== null, `重建应当真的开了 runtime（${label}）：${JSON.stringify(rebuild[label])}`);
      assert.ok(rebuild[label].texts.length > 0, `重建后历史应当读得出来（${label}）：${JSON.stringify(rebuild[label])}`);
    }
    const afterRebuild = {
      idle: await fileFacts(runtime.sessionsRoot, idleSession),
      pinned: await fileFacts(runtime.sessionsRoot, pinnedSession),
    };
    print('reclaim ④ files after rebuild (byte-for-byte)', {
      idle: { sameAsBeforeEverything: afterRebuild.idle.sha256 === beforeFiles.idle.sha256, before: beforeFiles.idle, after: afterRebuild.idle },
      pinned: { sameAsBeforeEverything: afterRebuild.pinned.sha256 === beforeFiles.pinned.sha256, before: beforeFiles.pinned, after: afterRebuild.pinned },
    });
    assert.equal(afterRebuild.idle.sha256, beforeFiles.idle.sha256, '从 JSONL 重建后文件必须一字未改（idle）');
    assert.equal(afterRebuild.pinned.sha256, beforeFiles.pinned.sha256, '从 JSONL 重建后文件必须一字未改（pinned）');

    // ⑤ draining 窗口：谁挡着换代、/reclaim 能不能解开
    stream?.close();
    stream = await watchSessionEvents(runtime, pinnedSession);
    const beforeReloadHost = await getHost(runtime);
    print('reclaim ⑤ /host before reload', { g1, owners: { [g1]: ownedBy(beforeReloadHost.snapshot, g1) } });
    const reload1 = await reload(runtime);
    print('reclaim ⑤ POST /reload-code #1 VERBATIM', { statusCode: reload1.statusCode, body: reload1.raw.trim() });
    const reload2 = await reload(runtime);
    print('reclaim ⑤ POST /reload-code #2 (while the previous generation still holds a running turn) VERBATIM', { statusCode: reload2.statusCode, body: reload2.raw.trim() });
    const dryDraining = await request(runtime.port, '/reclaim', { method: 'POST', body: { dryRun: true } });
    print('reclaim ⑤ POST /reclaim {"dryRun":true} in the draining window VERBATIM', { statusCode: dryDraining.statusCode, body: dryDraining.raw.trim() });
    const reclaimDraining = await request(runtime.port, '/reclaim', { method: 'POST', body: {} });
    print('reclaim ⑤ POST /reclaim {} in the draining window VERBATIM', { statusCode: reclaimDraining.statusCode, body: reclaimDraining.raw.trim() });
    const reclaimDrainingPinned = await request(runtime.port, '/reclaim', { method: 'POST', body: { includePinned: true } });
    print('reclaim ⑤ POST /reclaim {"includePinned":true} in the draining window VERBATIM', { statusCode: reclaimDrainingPinned.statusCode, body: reclaimDrainingPinned.raw.trim() });

    // 放行那一轮 ⇒ 旧代自己退（会话 SSE 还开着：测「挂着订阅者会不会把旧代钉住」）
    hold.release();
    const drained = await poll('draining generation exits with a live SSE subscriber still attached',
      async () => (await getHost(runtime)).snapshot, (snapshot) => snapshot.draining.length === 0, 90_000);
    print('reclaim ⑤ the draining generation exited while an SSE subscriber was still attached', { drained });
    let pinnedEnd = null;
    try {
      pinnedEnd = await stream.waitFor((event) => event.event === 'server.reload', 10_000);
    } catch (error) {
      pinnedEnd = { error: error.message, sseState: stream.events.length };
    }
    print('reclaim ⑤ the pinned subscriber saw', pinnedEnd);
    const reload3 = await reload(runtime);
    print('reclaim ⑤ POST /reload-code after the generation exited VERBATIM', { statusCode: reload3.statusCode, body: reload3.raw.trim() });
    assert.equal(drained.draining.length, 0, `放行那一轮之后旧代必须自己退：${JSON.stringify(drained)}`);
    assert.equal(reload3.statusCode, 200, `旧代退完后 reload 应当 200：${reload3.raw}`);
    print('reclaim ⑤ final /host', (await getHost(runtime)).snapshot);
    print('reclaim ⑤ running session file changed only because its held turn finished', {
      before: beforeFiles.running, after: await fileFacts(runtime.sessionsRoot, runningSession),
    });
  } finally {
    stream?.close();
    if (runtime) await stopSandbox(runtime).catch((error) => process.stderr.write(`stopSandbox failed: ${error.message}\n`));
    provider.server.close();
    if (!options.keep) await removeSandbox(sandbox, cleanupProblems);
    else print('sandbox kept', sandbox);
  }
}

// ═════════════════════' 相位 ⑥：换代窗口到底谁挡着（AGENTS.md 那条注记的实测） ═════════════════════
// AGENTS.md 写「上一代上有**闲置但常驻**的会话就退不出去 ⇒ 新的 reload 会被 409 挡住」。
// a47c655 的 drain 修复 + `drainBusy()`（挂着订阅者的闲置 runtime 不算 busy）之后这句到底还成不成立，
// 用沙箱直接量：一代上只摆闲置 + 挂着 SSE 订阅者的闲置，reload 之后旧代会不会自己退、reload 还会不会 409。
async function phaseDrainIdle(options) {
  const sandbox = path.join(SANDBOX_ROOT, `drain-idle-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });
  const providerPort = await reserveHighPort();
  const provider = await startFakeProvider(providerPort);
  let runtime = null;
  let stream = null;
  try {
    runtime = await startSandbox({ label: 'drain-idle', root: REPO_ROOT, sandbox, providerPort });
    const g1 = runtime.host.currentGenerationId;
    const idleSession = await createSession(runtime, 'idle parked');
    await warmTurn(runtime, provider, idleSession, 'warm-idle-parked');
    const pinnedSession = await createSession(runtime, 'idle watched');
    await warmTurn(runtime, provider, pinnedSession, 'warm-idle-watched');
    stream = await watchSessionEvents(runtime, pinnedSession);
    print('drain-idle layout', {
      g1,
      idle: await sessionDetail(runtime, idleSession),
      pinned: await sessionDetail(runtime, pinnedSession),
      before: (await getHost(runtime)).snapshot,
    });
    const reload1 = await reload(runtime);
    print('drain-idle POST /reload-code #1 VERBATIM', { statusCode: reload1.statusCode, body: reload1.raw.trim() });
    const settled = await poll('the old generation exits on its own', async () => (await getHost(runtime)).snapshot,
      (snapshot) => snapshot.draining.length === 0, 60_000);
    print('drain-idle the previous generation exited on its own', { settled });
    assert.equal(reload1.statusCode, 200, `drain-idle reload #1 应当 200：${reload1.raw}`);
    assert.equal(settled.draining.length, 0, `闲置（含挂订阅者）的旧代必须自己退：${JSON.stringify(settled)}`);
    print('drain-idle idle session after the swap', { detail: await sessionDetail(runtime, idleSession) });
    const idleFull = await request(runtime.port, `/sessions/${idleSession}`);
    print('drain-idle idle session eviction facts', {
      lastEvictionReason: idleFull.value?.lastEvictionReason ?? null,
      lastEvictedAt: idleFull.value?.lastEvictedAt ?? null,
      runtimeState: idleFull.value?.runtimeState ?? null,
    });
    const pinnedEnd = stream.events.find((event) => event.event === 'server.reload') ?? null;
    print('drain-idle the pinned subscriber saw', pinnedEnd ?? { note: 'no server.reload event captured', events: stream.events.map((event) => event.event) });
    const reload2 = await reload(runtime);
    print('drain-idle POST /reload-code #2 (nothing should block it now) VERBATIM', { statusCode: reload2.statusCode, body: reload2.raw.trim() });
    assert.equal(reload2.statusCode, 200, `旧代退完后 reload #2 应当 200（不再被 draining 挡住）：${reload2.raw}`);
  } finally {
    stream?.close();
    if (runtime) await stopSandbox(runtime).catch((error) => process.stderr.write(`stopSandbox failed: ${error.message}\n`));
    provider.server.close();
    if (!options.keep) await removeSandbox(sandbox, cleanupProblems);
    else print('sandbox kept', sandbox);
  }
}

// ═══════════ 相位 ④：换代窗口里那条请求被怎么处理（那条 502 的现场；只印不断言） ═══════════
// 为什么留这一步：2026-09-21 Linux 上 `test:hostpath` 稳定红的那条
//   `502 {"error":"worker unavailable","message":"read ECONNRESET"}`
// 就是这条路径 —— 宿主把请求代理给了一个**正在退场/已经退场**的 generation。而 `server/base.mjs` 里那句
//   「The owner died before replying: … (one honest retry)」**跑不到**：`proxyToWorker` 的 upstream
// error 分支（`base.mjs:1134-1139`）已经把 502 发出去了，调用方 `if (reached || response.headersSent) return;`
// （`base.mjs:1479`）于是必然 return（响应已提交）⇒ 那次 fallback 重试永远不会发生。
// 同一个窗口里还有一种**不报错**的形状：draining 代自己回 409 `session_not_owned_by_generation`
// （它已经不再持有这条会话）—— 宿主也不拿它去问 current 代。两种形状都属**产品级窄竞态**，
// 不是这道探针的判据（改产品代码不在本线），但它应当**可复现**。两拍：
//   拍 1（优雅排空）：会话忙住 → `POST /reload-code` → 放行之后**立刻**打一串请求；
//   拍 2（忽然死掉）：按精确 pid `SIGKILL` owner → 立刻打几次请求。
// 两拍里那几条非 200 **只印不断言**（否则就是把产品缺口伪装成探针自己的红）；
// 硬断言只落在最后：宿主能自愈（自己拉起新代并重新服务这条会话）。
async function phaseSwapWindow(options) {
  const sandbox = path.join(SANDBOX_ROOT, `swap-window-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });
  const providerPort = await reserveHighPort();
  const provider = await startFakeProvider(providerPort);
  let runtime = null;
  try {
    runtime = await startSandbox({ label: 'swap-window', root: REPO_ROOT, sandbox, providerPort });
    const sessionId = await createSession(runtime, 'swap window');
    await warmTurn(runtime, provider, sessionId, 'warm-swap-window');

    // ── 拍 1：优雅排空（就是 2026-09-21 那次 Linux 红的摆法，只是把命中窗口的概率抬高）──
    const hold = await startHoldTurn(runtime, provider, sessionId, 'swap-window: 忙住它当 draining 窗口');
    const firstGeneration = (await getHost(runtime)).snapshot.currentGenerationId;
    const reloadReply = await reload(runtime);
    const swap = await getHost(runtime);
    print('swap-window: graceful swap set up (busy session ⇒ reload)', {
      reload: reloadReply.statusCode,
      firstGeneration,
      secondGeneration: swap.snapshot.currentGenerationId,
      owners: { [firstGeneration]: ownedBy(swap.snapshot, firstGeneration), [swap.snapshot.currentGenerationId]: ownedBy(swap.snapshot, swap.snapshot.currentGenerationId) },
    });
    await expectStatus(reloadReply, 200, {
      what: 'swap-window 拍 1：POST /reload-code',
      why: '要量的是“换代窗口里那条请求被怎么处理”；409（上一代没退干净）就不是这个窗口了',
      runtime, sessionId,
    });
    hold.release();
    const burst = [];
    // 为什么是一串而不是一发：窗口只有几毫秒宽，一发要看运气；这里刻意对着窗口打，把形状**量出来**。
    diagnosisSuppressed = true;   // 这一段本来就是要看 409/502 的，下面自己会把回执印出来
    for (let index = 0; index < 40; index += 1) {
      if (index > 0) await sleep(4);
      burst.push(request(runtime.port, `/sessions/${sessionId}/title`, { method: 'POST', body: { title: `swap window ${index}` }, timeoutMs: 15_000 })
        .then((reply) => ({ index, statusCode: reply.statusCode, body: reply.raw.trim().slice(0, 160) })));
    }
    const duringSwap = await Promise.all(burst);
    diagnosisSuppressed = false;
    print('swap-window: the burst fired while the old generation was draining out', {
      byStatus: duringSwap.reduce((acc, entry) => ({ ...acc, [entry.statusCode]: (acc[entry.statusCode] ?? 0) + 1 }), {}),
      nonStandard: duringSwap.filter((entry) => entry.statusCode !== 200),
      note: '409 session_not_owned_by_generation = draining 代自己说“我不再持有它”仍被原样回给客户端；502 = 那一代的 socket 已经没了（它连话都说不了）。两种都**不是**产品应该给在途请求的最终答案。',
    });
    await poll('swap-window: the old generation drains out', async () => (await getHost(runtime)).snapshot, (snapshot) => snapshot.draining.length === 0, 60_000);

    // ── 拍 2：owner 忽然死掉（同一条路径的另一种触发）──
    const before = await getHost(runtime);
    const owner = before.snapshot.workers.find((worker) => worker.generationId === before.snapshot.currentGenerationId);
    assert.ok(owner?.pid, `起点必须有一个活着的 current generation：${JSON.stringify(before.snapshot)}`);
    print('swap-window: killing the owner generation by exact pid (SIGKILL；绝不 pkill)', { generation: owner.generationId, pid: owner.pid, owns: owner.owns });
    diagnosisSuppressed = true;
    process.kill(owner.pid, 'SIGKILL');
    const observed = [];
    for (let round = 0; round < 6; round += 1) {
      const title = await request(runtime.port, `/sessions/${sessionId}/title`, { method: 'POST', body: { title: `after the owner died ${round}` }, timeoutMs: 15_000 });
      const snapshot = (await getHost(runtime)).snapshot;
      observed.push({ round, statusCode: title.statusCode, body: title.raw.trim().slice(0, 200) });
      print('swap-window: POST /title right after the owner died VERBATIM', {
        round,
        statusCode: title.statusCode,
        body: title.raw.trim().slice(0, 200),
        workers: snapshot.workers.map((worker) => ({ g: worker.generationId, pid: worker.pid, state: worker.state, alive: alive(worker.pid), owns: worker.owns })),
      });
      await sleep(150);
    }
    diagnosisSuppressed = false;
    print('swap-window: the shapes seen while the owner was dying', {
      observed,
      note: '502/503 就是那条「承诺了 fallback 重试、但跑不到」的路径（base.mjs 的 proxyToWorker 先发了 502 ⇒ 调用方那次重试永远不跑）；它们**不是**这道探针的判据。',
    });

    // 自愈那一半：宿主应当自己起一个新的 generation，并重新服务（这条是硬断言）。
    // 恢复期本来就会一直回 503，直到新代就绪 ⇒ 把那个“失败就刷日志尾部”的钩子再关掉，
    // 免得把一件**预期**的事故意印十几遍（真正的自愈判据在下面那两条 assert）。
    diagnosisSuppressed = true;
    let recovered;
    try {
      recovered = await poll('a replacement generation serves the session again', async () => ({
        reply: await request(runtime.port, `/sessions/${sessionId}/title`, { method: 'POST', body: { title: 'recovered' }, timeoutMs: 15_000 }),
        snapshot: (await getHost(runtime)).snapshot,
      }), (state) => state.reply.statusCode === 200, 90_000);
    } finally {
      diagnosisSuppressed = false;
    }
    // ── ③ 的 GET 支：**新代已 ready 且 current** 这一格（就在上面那条 poll 之后 ✓）──
    // 正命题：换代**完成之后**，读路径不许被换代窗口的 409/503 误伤 ⇒ 同一批路径的 GET 串必须**全部 200**。
    // ⚠️ 这一格**不**踩 409 重试支（此刻 owner 映射已刷新、当前代可用 ⇒ 直连即 200）；要踩重试支需要
    // 「owner 已死但映射未刷新 + 替代代已 ready」那一瞬，这道相位不持有那一格（如实写在报告里）。
    const getPaths = [];
    for (let i = 0; i < 8; i += 1) getPaths.push(`/sessions/${sessionId}${i % 2 ? '/messages' : ''}`);
    const getBurst = await Promise.all(getPaths.map((pathname) => request(runtime.port, pathname, { timeoutMs: 30_000 })));
    const getStatuses = getBurst.map((reply) => reply.statusCode);
    print('swap-window: GET burst in the “replacement is current” cell (③ 的 GET 支)', {
      currentGenerationId: recovered.snapshot.currentGenerationId,
      statuses: getStatuses,
      nonStandard: getBurst.filter((reply) => reply.statusCode !== 200).map((reply) => ({ statusCode: reply.statusCode, body: reply.raw.trim().slice(0, 200) })),
    });
    assert.deepEqual([...new Set(getStatuses)], [200],
      `换代完成之后（新代 ready 且 current）的 GET 串必须全部 200，实得 ${JSON.stringify(getStatuses)} —— 读路径被换代窗口误伤了`);
    print('swap-window: the host recovered on its own', {
      statusCode: recovered.reply.statusCode,
      currentGenerationId: recovered.snapshot.currentGenerationId,
      workers: recovered.snapshot.workers.map((worker) => ({ g: worker.generationId, pid: worker.pid, state: worker.state, alive: alive(worker.pid) })),
    });
    // 硬断言：**最终**有人能服务这条会话（宿主自己拉起了新 generation）。
    // 为什么断的是这个而不是“回执必须是 200 而不是 502”：502 是产品缺口（要产品线去改），
    // 而“宿主会自愈”是它自己的故障恢复契约 —— 两者必须分开计分，免得把缺口伪装成探针的红。
    await expectStatus(recovered.reply, 200, {
      what: 'swap-window 拍 2：owner 死掉之后宿主的自愈：POST /title',
      why: '宿主的故障恢复路径必须能把这条会话重新服务起来（这是自愈的判据，不是那条 502 的判据）',
      runtime, sessionId,
    });
    assert.ok(recovered.snapshot.currentGenerationId && recovered.snapshot.workers.some((worker) => alive(worker.pid)),
      `自愈之后必须有一个活着的 current generation：${JSON.stringify(recovered.snapshot)}`);
    print('swap-window done', { duringSwap: duringSwap.map((entry) => entry.statusCode), afterKill: observed.map((entry) => entry.statusCode), recoveredGeneration: recovered.snapshot.currentGenerationId });
  } finally {
    if (runtime) await stopSandbox(runtime).catch((error) => process.stderr.write(`stopSandbox failed: ${error.message}\n`));
    provider.server.close();
    if (!options.keep) await removeSandbox(sandbox, cleanupProblems);
    else print('sandbox kept', sandbox);
  }
}

// ═══════════ 相位 ⑦：读路径的重试支（两处判定的判别性证据，2026-09-21） ═══════════
// 背景：⑥ 落地了「换代窗口里幂等 GET/HEAD 换当前代重试一次」，但**读路径那条重试支**一直没有判别性证据：
//   现有 `--phase swap-window` 的 GET 支落在「替代代已 ready 且 current」**之后** ⇒ 把两处幂等判定都关掉，
//   那一格**照样全 200**。这一相位把两处判定各钉一条臂（各自可机械判定、反证必红）：
//
//   · 臂 1 · owner 路由那条（`proxyToWorker` 上游连接断 ⇒ `reached === false` ⇒ `finishFailedProxy`）
//     摆法：会话忙住 ⇒ reload（g1 draining 仍持有它、g2 current）⇒ 按精确 pid **SIGSTOP** g1（被暂停的进程
//     监听套接字仍在内核里 ⇒ 宿主**连得上**、却在等它回话）⇒ 打 `GET /sessions/{id}`（走 owner 路由到 g1）
//     ⇒ SIGKILL g1 ⇒ 已建立的上游连接被对端关掉 ⇒ reached=false ⇒ 宿主忘掉旧 owner、换当前代 g2 重试一次 ⇒ 200。
//     机械证据：宿主日志出现 `generation swap (owner route): retrying GET …`。
//     反证（沙箱副本）：把 `finishFailedProxy` 那行 `if (method === 'GET' || method === 'HEAD')` 改成 `if (false)`
//     ⇒ 同一发**不再是 200**（诚实可重试的 503 `generation_swapped`）。
//
//   · 臂 2 · 409 拦截那条（draining 代自己回 409 `session_not_owned_by_generation`）
//     摆法：同前面那套（忙住 ⇒ reload）。放行那一轮之后，g1 的池已经在 draining，而 `pool.#evictExpired`
//     对「draining 且 idle 且 durable」的记录是**立刻到期**的（那段 filter 里的 `|| this.#draining`）
//     ⇒ `#evict(record, 'stale_generation')`：先在本地把 handle 处置掉（新 acquire 便会撞上
//     `if (this.#draining) throw new GenerationDrainingError`），**然后**才 emit 'evict' → base-logic
//     发一条 owner 'cold' 的 IPC → 宿主删掉那张映射。**这两步之间**就是那条 409 的窗口
//     （本地已无 handle、宿主映射还指着 g1）——实测几毫秒宽。
//     ⚠️ 所以打的是 **`GET /sessions/{id}/commands`**：它是宿主 `SESSION_PATH` 里的读路由，而 worker 侧
//     真的会 `pool.acquire`（`withSession`）——只有 acquire 才可能在那个窗口里拿到 409。
//     （`GET /sessions/{id}` 与 `/messages` **不会** acquire：`sessionDetail`/`messageResponseBody` 走
//     `pool.getHandle` 只读查询，冷了就直接读文件 ⇒ 它们**永远**不会回这条 409。本相位第一版踩过这个坑。）
//     正向：那一串 GET **全部 200**；机械证据：日志出现 `generation swap (session_not_owned_by_generation): retrying GET …`。
//     反证（沙箱副本）：把那行 `? currentWorker() : null` 改成 `? null` ⇒ 那一串 GET 里**至少一发不是 200**（409 透传）。
//     为什么是**顺序**的一串 GET 而不是并发：那个窗口只有几毫秒宽（上一棒实测：40 发并发 burst 里只有第 0 发
//     拿到 409）⇒ 顺序扫描（每发 ~1ms 往返）才确定扫得到；一旦有一发踩到，宿主那条拦截会先删掉映射
//     ⇒ 后面自然都走 current 代（200）。
//
// ⚠️ 两处突变都只落在**沙箱副本**里（`makeCodeRoot` + `patchLineOnce`：锚点命中恰好 1 行、那一行只改 1 处、
//   改完逐行只有那一行变、`node --check` 两个平台都跑）；真树 `server/` 一个字不动。
async function phaseReadRetry(options) {
  const sandbox = path.join(SANDBOX_ROOT, `read-retry-${Date.now()}`);
  await mkdir(sandbox, { recursive: true });
  const providerPort = await reserveHighPort();
  const provider = await startFakeProvider(providerPort);
  const runtimes = [];
  try {
    // 两份突变副本，各自只关掉一处幂等判定；都是从 REPO_ROOT（默认真树）复制出来的。
    const arm1Root = await makeCodeRoot(sandbox, 'root-arm1-no-finish-retry', {});
    const arm1Patch = await patchLineOnce({
      file: path.join(arm1Root, 'server', 'base.mjs'),
      anchor: FINISH_FAILED_IDEMPOTENT_ANCHOR,
      from: FINISH_FAILED_IDEMPOTENT_ANCHOR,
      to: FINISH_FAILED_IDEMPOTENT_FALSE,
      what: '臂1反证：把 finishFailedProxy 的幂等判定改成 if (false)',
    });
    await assertParses(path.join(arm1Root, 'server', 'base.mjs'));
    const arm2Root = await makeCodeRoot(sandbox, 'root-arm2-no-409-retry', {});
    const arm2Patch = await patchLineOnce({
      file: path.join(arm2Root, 'server', 'base.mjs'),
      anchor: SWAP409_RETRY_ANCHOR,
      from: SWAP409_RETRY_FROM,
      to: SWAP409_RETRY_NULL,
      what: '臂2反证：把 409 拦截里的幂等判定改成 ? null',
    });
    await assertParses(path.join(arm2Root, 'server', 'base.mjs'));
    print('read-retry mutations (each in its own sandbox copy; the real tree is untouched)', {
      arm1: { file: path.join(arm1Root, 'server', 'base.mjs'), ...arm1Patch },
      arm2: { file: path.join(arm2Root, 'server', 'base.mjs'), ...arm2Patch },
    });

    // ─────────────────── 臂 1：owner 路由那条（reached === false） ───────────────────
    const arm1 = {};
    for (const [mode, root] of (options.arm === 'arm2' ? [] : [['positive', REPO_ROOT], ['reverse', arm1Root]])) {
      const runtime = await startSandbox({ label: `arm1-${mode}`, root, sandbox, providerPort });
      runtimes.push(runtime);
      const rounds = [];
      for (let round = 0; round < READ_RETRY_ROUNDS; round += 1) {
        const sessionId = await createSession(runtime, `arm1 ${mode} ${round}`);
        await warmTurn(runtime, provider, sessionId, `arm1 ${mode} round ${round}: warm`);
        // 忙住它：忙着的会话不会被 draining 代逐出 ⇒ owner 映射留在 g1（正反两面都需要这个起点）。
        const hold = await startHoldTurn(runtime, provider, sessionId, `arm1 ${mode} round ${round}: 忙住它`);
        const before = await getHost(runtime);
        const g1 = before.snapshot.currentGenerationId;
        const reloadReply = await reload(runtime);
        const after = await getHost(runtime);
        const g2 = after.snapshot.currentGenerationId;
        const g1Worker = after.snapshot.workers.find((worker) => worker.generationId === g1) ?? null;
        // 起点事实（两条臂共有）：reload 真的换了代；忙住的会话仍由 g1 持有；g2 冷着；g1 的进程活着。
        await expectStatus(reloadReply, 200, {
          what: `read-retry 臂1(${mode}) round ${round + 1}: POST /reload-code`,
          why: '只有真换了一代才有 draining 代；409（上一代没退干净）会让这一幕什么都没量到',
          runtime, sessionId,
        });
        assert.notEqual(g2, g1, `reload 必须换一代：${JSON.stringify({ g1, g2 })}`);
        assert.ok(g1Worker?.pid, `draining 代(${g1}) 必须有 pid：${JSON.stringify(after.snapshot)}`);
        assert.ok(ownedBy(after.snapshot, g1).includes(sessionId), `前置事实：忙住的会话必须仍由 draining 代(${g1})持有：${JSON.stringify(after.snapshot)}`);
        assert.equal(hotOf(after.snapshot, g2), 0, `前置事实：current 代(${g2}) 必须冷着：${JSON.stringify(after.snapshot.workers)}`);
        assert.equal(alive(g1Worker.pid), true, `前置事实：draining 代(${g1}) 的进程必须活着（pid ${g1Worker.pid}）`);
        // 关键动作（按精确 pid，绝不 pkill）：SIGSTOP g1 ⇒ GET（走 owner 路由到 g1）⇒ 等 250ms（确保宿主已连上它）
        // ⇒ SIGKILL。之后上游那条已建立的连接被对端关掉 ⇒ reached=false ⇒ finishFailedProxy。
        process.kill(g1Worker.pid, 'SIGSTOP');
        const pending = request(runtime.port, `/sessions/${sessionId}`, { timeoutMs: 30_000 });
        await sleep(250);
        process.kill(g1Worker.pid, 'SIGKILL');
        const reply = await pending;
        hold.release();
        const retries = await logCount(runtime, '(owner route): retrying');
        rounds.push({ round: round + 1, sessionId, g1, g2, statusCode: reply.statusCode, body: reply.raw.trim().slice(0, 200), retryLines: retries });
        print(`read-retry arm1(${mode}) round ${round + 1} GET /sessions/{id} VERBATIM`, {
          g1, g2, generation1StoppedThenKilled: g1Worker.pid,
          statusCode: reply.statusCode, body: reply.raw.trim().slice(0, 220), retryLines: retries,
        });
        if (mode === 'positive') {
          await expectStatus(reply, 200, {
            what: `read-retry 臂1正向 round ${round + 1}: GET /sessions/{id}（owner 已答不上话，当前代 g2 可用）`,
            why: '幂等 GET 必须换当前代重试一次 ⇒ 200；不是 200 说明那条重试支没跑（或跑了没成）',
            runtime, sessionId,
          });
          assert.ok(retries > 0,
            `臂1正向：必须真的走过重试支 —— 宿主日志里的 'generation swap (owner route): retrying …' 是机械证据；retries=${retries}`);
        } else {
          assert.notEqual(reply.statusCode, 200,
            `臂1反证：关掉 finishFailedProxy 的幂等判定之后，同一发不许再是 200；实得 ${reply.statusCode} ${reply.raw.trim()}`);
          assert.equal(reply.statusCode, 503, `臂1反证：期望 sendWorkerUnavailable 的诚实可重试 503；实得 ${reply.statusCode} ${reply.raw.trim()}`);
          assert.equal(reply.value?.error, 'generation_swapped', `臂1反证：503 的 error 应当是 generation_swapped：${reply.raw.trim()}`);
          assert.equal(reply.value?.retryable, true, `臂1反证：503 必须带 retryable:true：${reply.raw.trim()}`);
          assert.equal(retries, 0, `臂1反证：关掉重试之后不该再出现 'retrying'；retries=${retries}`);
        }
        await poll(`arm1(${mode}) round ${round + 1}: 被停掉又杀掉的那一代已经不在 /host 里`,
          async () => (await getHost(runtime)).snapshot,
          (snapshot) => !snapshot.workers.some((worker) => worker.generationId === g1), 30_000);
      }
      arm1[mode] = rounds;
      print(`read-retry arm1(${mode}) all rounds`, { statuses: rounds.map((entry) => entry.statusCode), retryLines: rounds.map((entry) => entry.retryLines) });
    }

    // ─────────────────── 臂 2：409 拦截那条 ───────────────────
    const arm2 = {};
    for (const [mode, root] of (options.arm === 'arm1' ? [] : [['positive', REPO_ROOT], ['reverse', arm2Root]])) {
      const runtime = await startSandbox({ label: `arm2-${mode}`, root, sandbox, providerPort });
      runtimes.push(runtime);
      const rounds = [];
      // 每个 mode 只建**一条**会话、跨轮复用：轮次之间不必牵扯多条 hot 记录，摆法更干净（也不让
      // 上一轮留下的 hot 会话干扰下一轮的“这一代只服务这一条”事实）。
      const sessionId = await createSession(runtime, `arm2 ${mode} reused session`);
      for (let round = 0; round < READ_RETRY_ROUNDS; round += 1) {
        await warmTurn(runtime, provider, sessionId, `arm2 ${mode} round ${round}: warm`);
        const hold = await startHoldTurn(runtime, provider, sessionId, `arm2 ${mode} round ${round}: 忙住它`);
        const before = await getHost(runtime);
        const g1 = before.snapshot.currentGenerationId;
        const reloadReply = await reload(runtime);
        const after = await getHost(runtime);
        const g2 = after.snapshot.currentGenerationId;
        await expectStatus(reloadReply, 200, {
          what: `read-retry 臂2(${mode}) round ${round + 1}: POST /reload-code`,
          why: '只有真换了一代才有 draining 代；409（上一代没退干净）会让这一幕什么都没量到',
          runtime, sessionId,
        });
        assert.notEqual(g2, g1, `reload 必须换一代：${JSON.stringify({ g1, g2 })}`);
        assert.ok(ownedBy(after.snapshot, g1).includes(sessionId), `前置事实：忙住的会话必须仍由 draining 代(${g1})持有：${JSON.stringify(after.snapshot)}`);
        assert.equal(hotOf(after.snapshot, g2), 0, `前置事实：current 代(${g2}) 必须冷着：${JSON.stringify(after.snapshot.workers)}`);
        print(`read-retry arm2(${mode}) round ${round + 1} post-reload /host (before release)`, {
          g1, g2,
          workers: after.snapshot.workers.map((worker) => ({ g: worker.generationId, state: worker.state, hot: worker.hot, alive: alive(worker.pid), owns: worker.owns })),
        });
        const retriesBefore = await logCount(runtime, 'session_not_owned_by_generation): retrying');
        // 放行那一轮 ⇒ g1 的池在 draining 下立刻把这条 idle+durable 的记录按 `stale_generation` 处置：
        // 本地 handle 先没（新 acquire 就会撞上 GenerationDrainingError），那条 owner 'cold' 的 IPC 稍后才到。
        // ⚠️ 打的是 **GET /sessions/{id}/commands**：它是宿主 `SESSION_PATH` 里的读路由，而且 worker 侧
        //   真的会 `pool.acquire`（`withSession`）—— 只有 acquire 才可能在那个窗口里拿到那条 409。
        //   （`GET /sessions/{id}` 与 `/messages` **不会** acquire：`sessionDetail` 用 `pool.getHandle`
        //    只读查询，冷了就直接读文件 ⇒ 它们**永远**不会回这条 409。本相位第一版就是踩了这个坑。）
        hold.release();
        const burst = [];
        diagnosisSuppressed = true;   // 这一段本来就是要看 409 的，不拿它刷诊断
        try {
          for (let index = 0; index < READ_RETRY_BURST; index += 1) {
            const reply = await request(runtime.port, `/sessions/${sessionId}/commands`, { timeoutMs: 15_000 });
            const snapshot = (await getHost(runtime)).snapshot;
            const g1Now = snapshot.workers.find((worker) => worker.generationId === g1) ?? null;
            burst.push({
              index,
              statusCode: reply.statusCode,
              body: reply.raw.trim().slice(0, 180),
              g1: g1Now ? { state: g1Now.state, hot: g1Now.hot, owns: g1Now.owns } : null,
            });
            if (g1Now === null) break;   // g1 自己退场 ⇒ 后面只会由 g2 服务，再打下去也量不到那一瞬
          }
        } finally {
          diagnosisSuppressed = false;
        }
        const retries = await logCount(runtime, 'session_not_owned_by_generation): retrying') - retriesBefore;
        const nonStandard = burst.filter((entry) => entry.statusCode !== 200);
        const byStatus = burst.reduce((acc, entry) => ({ ...acc, [entry.statusCode]: (acc[entry.statusCode] ?? 0) + 1 }), {});
        rounds.push({ round: round + 1, sessionId, g1, g2, statuses: burst.map((entry) => entry.statusCode), nonStandard, retryLines: retries });
        print(`read-retry arm2(${mode}) round ${round + 1} sequential GET /sessions/{id}/commands burst in the draining-409 window`, {
          g1, g2, byStatus, nonStandard, retryLines: retries,
          burst: burst.map((entry) => ({ i: entry.index, s: entry.statusCode, g1: entry.g1, body: entry.statusCode === 200 ? undefined : entry.body })),
        });
        if (mode === 'positive') {
          assert.deepEqual([...new Set(burst.map((entry) => entry.statusCode))], [200],
            `臂2正向：那一串 GET 必须**全部 200**（踩到那条 409 的会被换当前代重试一次）；非 200 的几发：${JSON.stringify(nonStandard)}`);
          assert.ok(retries > 0,
            `臂2正向：必须真的踩到过 409 并走重试支 —— 宿主日志里的 'generation swap (session_not_owned_by_generation): retrying …' 是机械证据；retries=${retries}`);
        } else {
          assert.ok(nonStandard.length > 0,
            `臂2反证：关掉 409 拦截的幂等判定之后，那一串 GET 里**至少一发不许是 200**；实测全 200 ⇒ 这一臂**没判到东西**（没踩进那一瞬）`);
          assert.equal(retries, 0, `臂2反证：关掉重试之后不该再出现 'retrying'；retries=${retries}`);
          for (const entry of nonStandard) {
            assert.equal(entry.statusCode, 409,
              `臂2反证：非 200 的那几发应当是 409 session_not_owned_by_generation（原样透传/追加 retryable）；实得 ${entry.statusCode} ${entry.body}`);
            assert.equal(JSON.parse(entry.body || '{}')?.error, 'session_not_owned_by_generation',
              `臂2反证：409 的 error 码应当一字不改：${entry.body}`);
          }
        }
        await poll(`arm2(${mode}) round ${round + 1}: draining 代自己退干净`,
          async () => (await getHost(runtime)).snapshot,
          (snapshot) => snapshot.draining.length === 0, 60_000);
      }
      arm2[mode] = rounds;
      print(`read-retry arm2(${mode}) all rounds`, { statuses: rounds.map((entry) => entry.statuses), retryLines: rounds.map((entry) => entry.retryLines) });
    }

    print('read-retry RESULT', {
      arm1: { positive: (arm1.positive ?? []).map((entry) => entry.statusCode), reverse: (arm1.reverse ?? []).map((entry) => entry.statusCode) },
      arm2: { positive: (arm2.positive ?? []).map((entry) => entry.statuses), reverse: (arm2.reverse ?? []).map((entry) => entry.nonStandard.map((entry) => entry.statusCode)) },
      verdict: '两条臂都判到了重试支：正向走重试且成功，反证（各自关掉一处判定）必红',
    });
    print('read-retry done', { arm1RetryLines: (arm1.positive ?? []).map((entry) => entry.retryLines), arm2RetryLines: (arm2.positive ?? []).map((entry) => entry.retryLines) });
  } finally {
    for (const runtime of runtimes) await stopSandbox(runtime).catch((error) => process.stderr.write(`stopSandbox failed: ${error.message}\n`));
    provider.server.close();
    if (!options.keep) await removeSandbox(sandbox, cleanupProblems);
    else print('sandbox kept', sandbox);
  }
}

const options = parseArgs(process.argv.slice(2));
// 沙箱清理必须走共享助手（`removeSandbox` 收问题、`finishCleanup` 末尾统一裁决）：
// 直接 `rm` 会被 `npm run test:harness` 判成 bare rm in finally ✗（2026-09-21 被总台抓到，红的几个小时）。
const cleanupProblems = [];
let primaryError = null;
try {
  await mkdir(SANDBOX_ROOT, { recursive: true });
  if (options.phase === 'session-path') await phaseSessionPath(options);
  else if (options.phase === 'drain-idle') await phaseDrainIdle(options);
  else if (options.phase === 'swap-window' || options.phase === 'owner-death') await phaseSwapWindow(options);
  else if (options.phase === 'read-retry') await phaseReadRetry(options);
  else await phaseReclaim(options);
  print('probe done', { phase: options.phase });
} catch (error) {
  primaryError = error;
  process.stderr.write(`probe FAILED: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
// 无论成功还是失败（**失败时最需要**），`--keep` 都把“沙箱在哪、日志在哪”明确印出来：
// 宿主与它 fork 的每一代 worker 的 stdout/stderr 都写在同一份日志里（宿主转写成 '[worker <gen>] …'）。
if (options.keep) {
  print('--keep: 沙箱保留在这几个位置（宿主 + 每一代 worker 的日志都在里面）', {
    sandboxRoot: SANDBOX_ROOT,
    hostAndWorkerLogs: [...sandboxLogPaths],
    hint: '一条 502/ECONNRESET 先看那份日志的 [host] 行与 [worker …] 行：谁先没的、哪一代没起来',
  });
}
try {
  // 有主错误就重抛主错误；主流程通过但清理有失败时，这里会如实报出来（不让它静默 ✗）。
  finishCleanup(primaryError, cleanupProblems);
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
}
