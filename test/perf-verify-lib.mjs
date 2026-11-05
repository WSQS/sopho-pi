// perf-verify-lib.mjs —— 规模/泄漏/正文平价几道门共用的地基：进程采样 · 沙箱 · HTTP。
//
// 为什么单独一份：A-29 这条验证线有三道门（泄漏门 / 正文平价 fixture / 一次性探针）都要
// 「起一个自己的 A、按 pid 停、量进程 CPU+RSS」。与其三处各写一遍，不如收口一处 ——
// 免得哪天「按 pid 停」只在其中一份里是对的。
//
// 铁律（写在代码里，防后来人改坏）：
//   · 只起**自己 spawn** 的 `server/base.mjs`，只按**那个 pid** 停；**绝不 pkill**；
//   · 端口一律高位随机 + 127.0.0.1，**绝不**用 7331/7321/7322/7411/7412（活实例的端口）；
//   · 日志写调用方给的临时路径，**绝不**写 /tmp/sopho-base.log / sopho-app.log（活实例的 fd 指着它们）。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MIB = 1024 * 1024;
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const BASE_ENTRY = path.join(REPO_ROOT, 'server', 'base.mjs');
export const FORBIDDEN_PORTS = new Set([7321, 7331, 7322, 7411, 7412]);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ───────────────────────── 进程级采样（CPU 时间 + RSS） ─────────────────────────
// 采样器（POSIX 读 procfs 的 stat/statm，Windows 用常驻 PowerShell）现在住在
// `test/harness.mjs` —— 平台分叉只住那一个文件，门不许自己再写一份 procfs 读取
// （纪律见 `test/harness-contract.mjs`）。本文件不再另写采样器，也不做中间再导出：
// `test/a29-tree-leak.mjs` 与 `test/abandoned-request-cost.mjs` 直接从 `./harness.mjs` import。
// 为什么不能只看 /host 的 workerHeapUsedBytes：那是 V8 视角；「还在烧 CPU」要
// 看内核给的 utime+stime —— 两条一起看才能区分「堆没涨但还在算」和「真停了」。

/**
 * 静默观察窗：按固定间隔采样，给出**窗内最大 CPU 速率**与总量。
 * 为什么用「最大速率」而不是窗内均值：被放弃的读若在窗内跑完，均值会被后半段空闲摊薄
 * （实测 875 ms/s 的均值对应窗内 1000+ ms/s 的满核）；最大速率才是「它还在算」的直接证据。
 */
export async function settleWindow(sampler, pid, windowMs, intervalMs = 250) {
  const start = (await sampler.sample([pid])).get(pid) ?? null;
  const trail = [];
  let last = start;
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    const now = (await sampler.sample([pid])).get(pid) ?? null;
    if (!now || !last) break;
    trail.push({ at: new Date().toISOString(), cpuMs: now.cpuMs, rssBytes: now.rssBytes, rateMsPerSec: Number((((now.cpuMs - last.cpuMs) * 1000) / intervalMs).toFixed(1)) });
    last = now;
  }
  const end = last;
  return {
    startCpuMs: start?.cpuMs ?? null,
    endCpuMs: end?.cpuMs ?? null,
    cpuMs: start && end ? Number((end.cpuMs - start.cpuMs).toFixed(1)) : null,
    maxRateMsPerSec: trail.reduce((max, entry) => Math.max(max, entry.rateMsPerSec), 0),
    rssStartBytes: start?.rssBytes ?? null,
    rssMaxBytes: trail.reduce((max, entry) => Math.max(max, entry.rssBytes), start?.rssBytes ?? 0),
    rssEndBytes: end?.rssBytes ?? null,
    samples: trail.length,
    trail,
  };
}

/** 采样直到 CPU 速率连续 2 次落回噪声（最长 maxMs）。 */
export async function waitForIdle(sampler, pid, thresholdMsPerSec, maxMs) {
  const trail = [];
  let last = (await sampler.sample([pid])).get(pid) ?? null;
  const deadline = Date.now() + maxMs;
  let quiet = 0;
  while (Date.now() < deadline) {
    await sleep(250);
    const now = (await sampler.sample([pid])).get(pid) ?? null;
    if (!now || !last) break;
    const rateMsPerSec = Number((((now.cpuMs - last.cpuMs) * 1000) / 250).toFixed(1));
    trail.push({ at: new Date().toISOString(), cpuMs: now.cpuMs, rssBytes: now.rssBytes, rateMsPerSec });
    last = now;
    quiet = rateMsPerSec <= thresholdMsPerSec ? quiet + 1 : 0;
    if (quiet >= 2) break;
  }
  return { trail, cpuMs: last?.cpuMs ?? null, rssBytes: last?.rssBytes ?? null };
}

// ───────────────────────── 沙箱 ─────────────────────────
export async function reserveHighPort() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 42000 + Math.floor(Math.random() * 22000);
    if (FORBIDDEN_PORTS.has(port)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('could not reserve a random high port');
}

export function request(port, pathname, { timeoutMs = 120_000, collect = true, method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { accept: 'application/json', connection: 'close', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...headers } });
    const timer = setTimeout(() => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, elapsedMs: Date.now() - started });
    };
    req.once('error', (error) => finish({ error: error.message, statusCode: 0, bytes: 0, value: null }));
    req.once('response', (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => { bytes += chunk.length; if (collect) chunks.push(chunk); });
      res.once('error', (error) => finish({ error: error.message, statusCode: res.statusCode ?? 0, bytes, value: null }));
      res.once('end', () => {
        const raw = collect ? Buffer.concat(chunks).toString('utf8') : '';
        let value = null;
        if (raw) { try { value = JSON.parse(raw); } catch { value = raw.slice(0, 400); } }
        finish({ statusCode: res.statusCode, bytes, value, raw: raw.slice(0, 4000) });
      });
    });
    if (body) req.write(body);
    req.end();
  });
}

export async function poll(label, operation, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await operation(); } catch (error) { last = { error: error.message }; }
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)?.slice(0, 500)}`);
}

export async function hostStatus(port, timeoutMs = 30_000) {
  const response = await request(port, '/host', { timeoutMs });
  if (response.statusCode !== 200) throw new Error(`GET /host -> ${response.statusCode} ${response.raw?.slice(0, 300)}`);
  return { ...response.value, _elapsedMs: response.elapsedMs };
}

/** 宿主把自己的 stdout 里那行 `{"event":"worker_ready",...}` 原样写出 → 从日志里拿 worker 口。 */
export async function readWorkerPortFromLog(logPath) {
  const text = await readFile(logPath, 'utf8');
  const matches = [...text.matchAll(/\{"event":"worker_ready"[^}]*\}/g)];
  if (matches.length === 0) throw new Error('base log has no worker_ready line');
  const last = JSON.parse(matches.at(-1)[0]);
  return { port: last.port, pid: last.pid, generationId: last.generationId };
}

export async function startSandboxBase({ home, sessionsRoot, workspace, logPath, extraEnv = {}, workerOldSpaceMiB = 0, cwd = REPO_ROOT }) {
  const port = await reserveHighPort();
  const logHandle = await open(logPath, 'w');
  const child = spawn(process.execPath, [BASE_ENTRY], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      ASSIST_HOME: home,
      SOPHO_AGENT_DIR: home,
      PI_CODING_AGENT_DIR: home,
      ...(sessionsRoot ? { PI_CODING_AGENT_SESSION_DIR: sessionsRoot } : {}),
      PI_OFFLINE: '1',
      SOPHO_HOST: '127.0.0.1',
      SOPHO_PORT: String(port),
      ...(workspace ? { SOPHO_DEFAULT_CWD: workspace } : {}),
      SOPHO_NO_TOOLS: '1',
      ...(workerOldSpaceMiB > 0 ? { SOPHO_WORKER_OLD_SPACE_MIB: String(workerOldSpaceMiB) } : {}),
      ...extraEnv,
    },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        sleep(15_000).then(() => false),
      ]);
      if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await logHandle.close().catch(() => {});
  };
  return { port, child, stop, logPath };
}

/** 写一个「最小可用」的临时 home（不进 git 的模型配置，没有密钥）。 */
export async function writeMinimalHome(home, workspace, { models = { providers: {} }, settings = { defaultThinkingLevel: 'off', compaction: { enabled: false } } } = {}) {
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify(models, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * worker 只认宿主在 spawn 时写进它 env 的那个 token：`sha256(宿主pid:generationId:reason)`
 * （server/base.mjs:332）。fresh 沙箱的第一个 generation 的 reason 就是 `'boot'`
 * （server/base.mjs:1569）—— 所以这个值在测试里是可复算的事实，不是猜。
 */
export function workerToken(hostPid, generationId, reason = 'boot') {
  return createHash('sha256').update(`${hostPid}:${generationId}:${reason}`).digest('hex');
}

/**
 * 直连 worker 的 /tree，并在 `abortAfterMs` 后**主动断掉客户端** —— 与宿主 5 s 超时
 * 对 worker 是同一种事件（response `close`）。
 */
export function workerTreeRequest(workerPort, abortAfterMs, { token = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({
      host: '127.0.0.1',
      port: workerPort,
      path: '/tree',
      headers: { accept: 'application/json', connection: 'close', ...(token ? { 'x-sopho-worker-token': token } : {}) },
    });
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let value = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) { try { value = JSON.parse(raw); } catch { value = raw.slice(0, 300); } }
      resolve({ ...outcome, elapsedMs: Date.now() - started, sessions: value?.sessions?.length ?? null, bodyError: value?.error ?? null });
    };
    const timer = abortAfterMs === null ? null : setTimeout(() => {
      req.destroy();
      finish({ aborted: true, statusCode: 0, bytes });
    }, abortAfterMs);
    req.once('error', () => finish({ aborted: false, statusCode: 0, bytes, error: 'socket error' }));
    req.once('response', (res) => {
      res.on('data', (chunk) => { bytes += chunk.length; chunks.push(chunk); });
      res.once('error', () => finish({ aborted: false, statusCode: res.statusCode, bytes, error: 'stream error' }));
      res.once('end', () => finish({ aborted: false, statusCode: res.statusCode, bytes }));
    });
    req.end();
  });
}

