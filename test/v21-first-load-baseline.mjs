#!/usr/bin/env node
// test/v21-first-load-baseline.mjs —— 「打开一条大会话」的**首次加载**口径：v2.1(tag `v2.1-final`) vs v2.2(HEAD)。
//
// 与 test/switch-perf-v21-v22.mjs 的区别：那条量的是「已经开着一个页面、点另一条会话的行」的**切换**；
// 这条量的是**冷页面直接深链打开那一条大会话**（`#<uuid>`）—— 也就是用户说的「打开一条大会话很重」。
//
// 量什么（同一份夹具、两版各一遍、真 Chromium）：
//   · 载荷：`/api/sessions/{id}/messages` 发了几次、每次多少字节（**线上字节**，含 br）、
//     响应体里有多少条消息（v2.1 会把工具结果并进上一条 ⇒ 条数本来就不同）；
//   · DOM：正文容器最终有多少正文节点、多少元素（含子树）、补了几批、什么时候补完；
//   · 构建成本：CDP Performance.getMetrics 的 Script/Layout/Task/Recalc/LayoutCount 前后差 + longtask；
//   · 时间线：导航 → 第一块正文可见 / 最后一条正文可见 / 全部正文进 DOM（相对导航起点的毫秒）；
//   · 滚到顶：顶上是「会话第一条」还是「显示更早 N 条」按钮（一眼看出 v2.1 的截断）；
//   · v2.1 专有：点「↑ 显示更早的 N 条」把整段历史真的建进 DOM 的成本（它拿什么换来的「轻」）。
//
// 公平性：两版各自一套临时 home（同一份夹具文件**逐字节相同**：一次冻结快照 + sha256 核对），
// 各自跑在自己的 worktree（v2.1 = `git worktree add --detach <work>/v21-tree v2.1-final`），
// 高位随机端口（7331/7321/7411/7412 一律禁用），同一个 Chromium、同一视口、轮内交替。
//
// 用法：
//   node test/v21-first-load-baseline.mjs prepare
//   node test/v21-first-load-baseline.mjs run --rounds 3
//   node test/v21-first-load-baseline.mjs report
//   node test/v21-first-load-baseline.mjs all --rounds 3
//
// 红线：真实 profile 只读（stat/readFile + 拷贝）；日志只写 <work>/logs；停进程只按自己 spawn 的
//       pid（test/harness.mjs 的 stopOwnedListener）；**不 pkill**；不碰任何活实例的端口。

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { browserSandboxEnv, cleanupStep, finishCleanup, stopOwnedListener } from './harness.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_BIN = process.env.CHROME_BIN || '/usr/bin/chromium';
const REAL_HOME = process.env.SOPHO_REAL_HOME || path.join(os.homedir(), '.pi', 'profiles', 'assistant');
const FORBIDDEN_PORTS = new Set([7331, 7321, 7322, 7411, 7412]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const round2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);

function parseArgs(argv) {
  const args = { mode: argv[0] && !String(argv[0]).startsWith('--') ? String(argv[0]) : 'all' };
  const start = args.mode === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const token = argv[i];
    if (!String(token).startsWith('--')) continue;
    const key = String(token).slice(2);
    const next = argv[i + 1];
    if (next === undefined || String(next).startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const MODE = args.mode;
const WORK = path.resolve(String(args.work ?? path.join(os.tmpdir(), 'v21-first-load')));
const OUT = path.resolve(String(args.out ?? path.join(WORK, 'out')));
const ROUNDS = Number(args.rounds ?? 3);
const ONLY = args.only ? String(args.only).split(',') : null;
const QUIET_MS = Number(args['quiet-ms'] ?? 700);
const MAX_SAMPLE_MS = Number(args['max-sample-ms'] ?? 60000);
const INSTRUMENT = args.instrument === true;
const [vw, vh] = String(args.viewport ?? '1200x760').split('x').map(Number);
const VIEWPORT = { width: vw, height: vh, label: `${vw}x${vh}` };
// 夹具：显式指定就用它；否则先看默认那条（派单里那条 17.20 MiB 的总台会话），
// 再不然就在真 profile 下挑**最大的** .jsonl（与 test/big-session-refetch.mjs 同一个回退口径）。
const DEFAULT_FIXTURE_FILE = path.join(REAL_HOME, 'sessions', '2026-09-15T05-23-59-625Z_01a0a385-a409-7728-bb01-2eee06a87ca9.jsonl');
const FIXTURE_FILE_ENV = process.env.SOPHO_FIRSTLOAD_SESSION_FILE || null;
const MIN_FIXTURE_BYTES = Number(process.env.SOPHO_FIRSTLOAD_MIN_BYTES ?? 8 * 1024 * 1024);

async function pickFixtureFile() {
  const candidates = [];
  if (FIXTURE_FILE_ENV) candidates.push(FIXTURE_FILE_ENV);
  else candidates.push(DEFAULT_FIXTURE_FILE);
  for (const file of candidates) {
    const info = await fsp.stat(file).catch(() => null);
    if (info?.isFile() && info.size >= MIN_FIXTURE_BYTES) return { file, bytes: info.size, how: FIXTURE_FILE_ENV ? 'env' : 'default' };
  }
  if (FIXTURE_FILE_ENV) return { missing: `SOPHO_FIRSTLOAD_SESSION_FILE=${FIXTURE_FILE_ENV} 不存在 / 不是文件 / < ${(MIN_FIXTURE_BYTES / 1048576).toFixed(1)} MiB` };
  let best = null;
  let scanned = 0;
  const walk = async (directory) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      scanned += 1;
      const info = await fsp.stat(full).catch(() => null);
      if (!info?.isFile() || info.size < MIN_FIXTURE_BYTES) continue;
      if (!best || info.size > best.bytes) best = { file: full, bytes: info.size, how: 'largest' };
    }
  };
  await walk(path.join(REAL_HOME, 'sessions'));
  if (!best) return { missing: `默认夹具不存在，且 ${REAL_HOME}/sessions 下扫了 ${scanned} 个 .jsonl，没有一个 ≥ ${(MIN_FIXTURE_BYTES / 1048576).toFixed(1)} MiB` };
  return best;
}

const SIDECAR_FILES = ['archive.json', 'titles.json', 'seen.json', 'settled.json', 'models.json',
  'models-store.json', 'settings.json', 'paths.json', 'auth.json',
  'drafts.json', 'placement.json', 'extras.json'];

// 两版的端口变量名不同（同一个名字 `SOPHO_PORT` 在两版里指**不同角色**）：
//   v2.1：A = SOPHO_BASE_PORT，B = SOPHO_PORT（B 另需 SOPHO_BASE_URL）
//   v2.2：A = SOPHO_PORT，      B = SOPHO_APP_PORT（B 另需 SOPHO_UPSTREAM_HOST/PORT）
const VERSIONS = {
  v21: {
    key: 'v21', label: 'v2.1', ref: 'v2.1-final',
    repo: () => path.join(WORK, 'v21-tree'),
    aEnv: (home, aPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_HOST: '127.0.0.1', SOPHO_BASE_PORT: String(aPort), SOPHO_CWD: home,
    }),
    bEnv: (home, aPort, bPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(bPort), SOPHO_BASE_URL: `http://127.0.0.1:${aPort}`,
    }),
    // v2.1 的正文容器是 `#hist`（`#messages` 是它的滚动外框）
    paneSelector: '#messages',
    nodeContainerSelector: '#hist',
    contentNodeSelector: '#hist > .msg, #hist > .extras, #hist > details.cut',
    // `.more` 是「↑ 显示更早的 N 条」按钮（截断的直接证据）
    moreSelector: '#hist > .more',
    cwdRecentsShape: 'object',
  },
  v22: {
    key: 'v22', label: 'v2.2', ref: 'HEAD', repo: () => root,
    aEnv: (home, aPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(aPort),
    }),
    bEnv: (home, aPort, bPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(bPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(aPort),
    }),
    paneSelector: '#messages',
    nodeContainerSelector: '#messages',
    contentNodeSelector: '#messages > article.message, #messages > .extra-message, #messages > .compaction-note',
    moreSelector: null,
    cwdRecentsShape: 'array',
  },
};

// ───────────────────────────── 小工具 ─────────────────────────────
async function reservePort() {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (FORBIDDEN_PORTS.has(port)) continue;
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('could not reserve a free high port');
}

function httpGet(url, { timeoutMs = 180000, parseJson = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = nowMs();
    const request = http.request(url, { method: 'GET', headers: { accept: 'application/json', ...headers } }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; if (parseJson) chunks.push(chunk); });
      response.on('end', () => {
        const result = {
          status: response.statusCode, ms: round2(nowMs() - started), bytes,
          contentEncoding: response.headers['content-encoding'] ?? null,
        };
        if (parseJson) {
          const text = Buffer.concat(chunks).toString('utf8');
          try { result.json = JSON.parse(text); } catch { result.jsonError = text.slice(0, 200); }
        }
        resolve(result);
      });
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)));
    request.end();
  });
}

async function waitHttp(port, route, deadlineMs) {
  const started = nowMs();
  let last;
  while (nowMs() - started < deadlineMs) {
    try {
      const response = await httpGet(`http://127.0.0.1:${port}${route}`, { timeoutMs: 10000, parseJson: true });
      if (response.status === 200) return { ...response, waitedMs: round2(nowMs() - started) };
      last = `HTTP ${response.status}`;
    } catch (error) { last = error.message; }
    await sleep(120);
  }
  throw new Error(`${route} on ${port} never became ready (${last})`);
}

async function gitSha(repo) {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function ensureWorktree(dir, ref) {
  if (fs.existsSync(path.join(dir, 'server', 'base.mjs'))) return 'exists';
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  await execFileAsync('git', ['-C', root, 'worktree', 'prune']).catch(() => {});
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '--detach', dir, ref]);
  return 'created';
}

async function ensureSymlink(link, target) {
  try { await fsp.lstat(link); return 'exists'; } catch {}
  await fsp.mkdir(path.dirname(link), { recursive: true });
  await fsp.symlink(target, link);
  return 'created';
}

const uuidFromName = (file) => /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] ?? null;

/** 夹具冻结：把**真 profile 里那条大会话**只读拷成一个快照文件，之后两版都用这一份。
 *  ⚠️ 那条会话是**活的、还在被追加写**（派单里说的 17.20 MiB 是诊断当时的尺寸，写这份时已更大）
 *   ⇒ 不冻结就没法「两版跑同一份字节」；冻结同时把末行截断（拷贝可能落在半行上）。 */
async function freezeFixture() {
  const frozen = path.join(WORK, 'fixture.jsonl');
  const metaPath = path.join(WORK, 'fixture-meta.json');
  await fsp.mkdir(WORK, { recursive: true });
  // 夹具是**活会话**（还在被追加写）⇒ 一次冻结就钉死，后续复跑默认**不重新冻结**，
  // 否则每次 prepare 的数字都对不上自己上一次的报告。要换夹具明确 --refreeze。
  if (!args.refreeze) {
    const existing = await fsp.readFile(metaPath, 'utf8').then(JSON.parse).catch(() => null);
    const still = existing && await fsp.stat(frozen).catch(() => null);
    if (still?.isFile()) {
      const sha = await sha256File(frozen);
      if (sha === existing.sha256) return { ...existing, how: `${existing.how}（已冻结，跳过重取；--refreeze 可强制重取）` };
    }
  }
  const picked = await pickFixtureFile();
  if (picked.missing) return { missing: picked.missing };
  const FIXTURE_FILE = picked.file;
  const info = await fsp.stat(FIXTURE_FILE).catch(() => null);
  if (!info?.isFile()) return { missing: `夹具文件不存在：${FIXTURE_FILE}` };
  if (info.size < MIN_FIXTURE_BYTES) return { missing: `夹具只有 ${(info.size / 1048576).toFixed(2)} MiB（< ${(MIN_FIXTURE_BYTES / 1048576).toFixed(1)} MiB）` };
  const raw = await fsp.readFile(FIXTURE_FILE, 'utf8');
  const lines = raw.split('\n');
  let droppedTrailer = 0;
  if (lines.length && lines[lines.length - 1] !== '') {
    // 拷到的是一份没以换行结尾的文件：末行可能是半行 —— 解析不了就丢。
    try { JSON.parse(lines[lines.length - 1]); } catch { lines.pop(); droppedTrailer = 1; }
  }
  const text = lines.join('\n');
  await fsp.writeFile(frozen, text, 'utf8');
  const result = {
    source: FIXTURE_FILE, how: picked.how, frozen, sourceBytes: info.size, frozenBytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'), lines: lines.length - 1, droppedTrailer,
    sourceMtime: info.mtime.toISOString(), uuid: uuidFromName(path.basename(FIXTURE_FILE)),
    frozenAt: new Date().toISOString(),
  };
  await fsp.writeFile(metaPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

async function prepareHome({ key, shape, repo, fixture }) {
  const home = path.join(WORK, `home-${key}`);
  const marker = path.join(home, '.prepared.json');
  const repoSha = await gitSha(repo);
  const existing = await fsp.readFile(marker, 'utf8').then(JSON.parse).catch(() => null);
  if (existing && existing.shape === shape && existing.repoSha === repoSha && existing.sha256 === fixture.sha256) return existing;
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.mkdir(path.join(home, 'sessions'), { recursive: true });
  const name = path.basename(fixture.source);
  await fsp.copyFile(fixture.frozen, path.join(home, 'sessions', name));
  for (const sidecar of SIDECAR_FILES) {
    try { await fsp.copyFile(path.join(REAL_HOME, sidecar), path.join(home, sidecar)); } catch {}
  }
  const recentsRaw = await fsp.readFile(path.join(REAL_HOME, 'cwd-recents.json'), 'utf8').catch(() => '{}');
  let recentsObject = {};
  try { recentsObject = JSON.parse(recentsRaw); } catch {}
  if (shape === 'array') {
    const list = Object.entries(recentsObject).map(([cwd, value]) => ({ cwd, at: Number(value?.at) || 0 }))
      .filter((entry) => path.isAbsolute(entry.cwd) && Number.isInteger(entry.at) && entry.at >= 0)
      .sort((a, b) => b.at - a.at).slice(0, 50);
    await fsp.writeFile(path.join(home, 'cwd-recents.json'), JSON.stringify(list, null, 1), 'utf8');
  } else {
    await fsp.writeFile(path.join(home, 'cwd-recents.json'), JSON.stringify(recentsObject, null, 1), 'utf8');
  }
  await ensureSymlink(path.join(home, 'extensions', 'assistant'), path.join(repo, 'pi-extensions', 'assistant'));
  const result = { shape, home, repo, repoSha, sha256: fixture.sha256, sha256InHome: await sha256File(path.join(home, 'sessions', name)) };
  await fsp.writeFile(marker, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

async function sha256File(file) {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex');
}

async function prepare() {
  await fsp.mkdir(OUT, { recursive: true });
  await fsp.mkdir(path.join(WORK, 'logs'), { recursive: true });
  const modules = await fsp.realpath(path.join(root, 'node_modules')).catch(() => null);
  if (!modules) throw new Error(`共享 node_modules 不存在：${path.join(root, 'node_modules')}`);
  let v21Sha = null;
  if (!ONLY || ONLY.includes('v21')) {
    const tree = VERSIONS.v21.repo();
    log('[prepare] v2.1 worktree =', tree, '(v2.1-final, --detach)');
    log('  worktree:', await ensureWorktree(tree, VERSIONS.v21.ref));
    log('  node_modules symlink:', await ensureSymlink(path.join(tree, 'node_modules'), modules));
    v21Sha = await gitSha(tree);
  }
  const fixture = await freezeFixture();
  if (fixture.missing) throw new Error(fixture.missing);
  log('[prepare] 夹具冻结:', fixture.source);
  log(`  ${(fixture.sourceBytes / 1048576).toFixed(2)} MiB（源，mtime ${fixture.sourceMtime}）→ ${(fixture.frozenBytes / 1048576).toFixed(2)} MiB / ${fixture.lines} 行 / sha256 ${fixture.sha256.slice(0, 16)}…`);
  const results = {
    preparedAt: new Date().toISOString(), chrome: CHROME_BIN, node: process.version, realHome: REAL_HOME,
    v21Sha, v22Sha: await gitSha(root), viewport: VIEWPORT, fixture,
    sessionId: fixture.uuid,
    caliberNote: '两版同一份冻结夹具（sha256 核对）；沙箱 home 里只有这一条会话（树大小是常量，不混进对比）；冷页面深链首次打开。',
  };
  for (const key of ['v21', 'v22']) {
    if (ONLY && !ONLY.includes(key)) continue;
    const cfg = VERSIONS[key];
    results[key] = await prepareHome({ key, shape: cfg.cwdRecentsShape, repo: cfg.repo(), fixture });
    log(`[prepare] home-${key}: sha256 ${results[key].sha256InHome.slice(0, 16)}… ${results[key].sha256InHome === fixture.sha256 ? '（与冻结夹具逐字节相同 ✓）' : '（✗ 不一致）'}`);
  }
  await ensureSymlink(path.join(root, 'node_modules'), modules).catch(() => {});
  await fsp.writeFile(path.join(OUT, 'fixtures.json'), JSON.stringify(results, null, 2), 'utf8');
  log('[prepare] fixtures →', path.join(OUT, 'fixtures.json'));
  return results;
}

// ───────────────────────────── 起 / 停 ─────────────────────────────
function spawnNode(repo, entry, env, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: repo, env: { ...process.env, ...env, NODE_ENV: 'production' }, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  return child;
}

async function startVersion(key) {
  const cfg = VERSIONS[key];
  const repo = cfg.repo();
  const home = path.join(WORK, `home-${key}`);
  const aPort = await reservePort();
  let bPort = await reservePort();
  while (bPort === aPort) bPort = await reservePort();
  if (FORBIDDEN_PORTS.has(aPort) || FORBIDDEN_PORTS.has(bPort)) throw new Error('reserved a forbidden port');
  const stamp = Date.now();
  const aLog = path.join(WORK, 'logs', `${key}-${stamp}-a.log`);
  const bLog = path.join(WORK, 'logs', `${key}-${stamp}-b.log`);
  const a = spawnNode(repo, 'server/base.mjs', cfg.aEnv(home, aPort), aLog);
  await waitHttp(aPort, '/host', 60000);
  const b = spawnNode(repo, 'server/app.mjs', cfg.bEnv(home, aPort, bPort), bLog);
  await waitHttp(bPort, '/api/host', 60000);
  return { key, cfg, repo, home, aPort, bPort, a, b, aLog, bLog };
}

async function stopVersion(session, problems) {
  await cleanupStep(problems, `stop ${session.key} B`, () => stopOwnedListener(session.bPort, 'server/app.mjs', session.b?.pid));
  await cleanupStep(problems, `stop ${session.key} A`, () => stopOwnedListener(session.aPort, 'server/base.mjs', session.a?.pid));
  for (const child of [session.b, session.a]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

// ───────────────────────────── Chromium / CDP ─────────────────────────────
class Cdp {
  constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); this.listeners = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('cdp ws error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`));
        else resolve(message.result);
        return;
      }
      if (message.method) for (const handler of this.listeners.get(message.method) ?? []) handler(message.params, message.sessionId);
    });
  }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }
  send(method, params = {}, sessionId, timeoutMs = 180000) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`)); }, timeoutMs);
      timer.unref?.();
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function launchChromium(userDataDir) {
  const debugPort = await reservePort();
  const child = spawn(CHROME_BIN, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--no-pings',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { env: browserSandboxEnv(userDataDir), stdio: 'ignore' });
  let version = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await httpGet(`http://127.0.0.1:${debugPort}/json/version`, { timeoutMs: 3000, parseJson: true });
      if (response.status === 200) { version = response.json; break; }
    } catch {}
    await sleep(100);
  }
  if (!version) { child.kill('SIGKILL'); throw new Error('chromium devtools endpoint never came up'); }
  return { child, debugPort, version };
}

/** 页内观察器。装在**文档开始**（Page.addScriptToEvaluateOnNewDocument），所以 t0 就是导航起点附近。
 *  它自己等到正文容器出现才挂 MutationObserver / IntersectionObserver（两个版本的容器都在静态 HTML 里）。 */
const OBSERVER_SOURCE = (cfg, instrument = false) => String.raw`
(() => {
  const INSTRUMENT = ${instrument ? 'true' : 'false'};
  const PANE = ${JSON.stringify(cfg.paneSelector)};
  const CONTAINER = ${JSON.stringify(cfg.nodeContainerSelector)};
  const CONTENT = ${JSON.stringify(cfg.contentNodeSelector)};
  const MORE = ${JSON.stringify(cfg.moreSelector)};
  const FL = { t0: performance.now(), ready: false, sample: null, more: null, errors: [], fetches: [], lts: [], instr: [], rafGaps: [] };
  window.__fl = FL;
  if (INSTRUMENT) {
    try {
      const scrollDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperty(Element.prototype, 'scrollTop', {
        configurable: true,
        get() { return scrollDesc.get.call(this); },
        set(value) {
          const at = performance.now();
          scrollDesc.set.call(this, value);
          FL.instr.push({ kind: 'scrollTop', target: this.id || String(this.className).slice(0, 20), value, ms: Math.round((performance.now() - at) * 100) / 100, at });
        },
      });
      for (const name of ['prepend', 'append', 'replaceChildren', 'appendChild']) {
        const original = Element.prototype[name];
        if (typeof original !== 'function') continue;
        Element.prototype[name] = function (...callArgs) {
          const at = performance.now();
          const result = original.apply(this, callArgs);
          FL.instr.push({ kind: name, target: this.id || String(this.className).slice(0, 20), n: callArgs.length, ms: Math.round((performance.now() - at) * 100) / 100, at });
          return result;
        };
      }
    } catch (error) { FL.instrError = String(error); }
  }
  window.addEventListener('error', (event) => FL.errors.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => FL.errors.push('rejection: ' + String(event.reason)));
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) FL.lts.push({ start: entry.startTime, dur: entry.duration });
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch (error) { FL.ltError = String(error); }

  // fetch 打点：每个请求记 url / 开始 / 结束 / 状态 / 响应体字符数；正文那一发把文本留着按需解析。
  const origFetch = window.fetch;
  window.fetch = async function (...callArgs) {
    const input = callArgs[0];
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const startedAt = performance.now();
    try {
      const response = await origFetch.apply(this, callArgs);
      const record = { url, startedAt, endedAt: performance.now(), status: response.status, bytes: null, text: null };
      try {
        const text = await response.clone().text();
        record.bytes = text.length;
        if (url.includes('/messages')) record.text = text;
      } catch (error) { record.readError = String(error); }
      FL.fetches.push(record);
      return response;
    } catch (error) {
      FL.fetches.push({ url, startedAt, endedAt: performance.now(), status: -1, error: String(error) });
      throw error;
    }
  };

  function hash(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  }

  function makeRecorder() {
    const rec = {
      startedAt: performance.now(), clickAt: null,
      mutations: 0, addedTopLevel: 0, addedSubtreeElements: 0, removedNodes: 0,
      contentAdds: 0, contentBatches: [], firstContentAt: null, firstContentText: null,
      visibleAt: null, visibility: new Map(), frames: 0, maxContentNodes: 0,
      finished: false, reason: null, endAt: null,
    };
    const container = document.querySelector(CONTAINER);
    const pane = document.querySelector(PANE);
    if (!container) { rec.finished = true; rec.reason = 'no-container'; rec.endAt = performance.now(); return rec; }
    const initialNodes = new Set(Array.from(document.querySelectorAll(CONTENT)));
    rec.initialContent = initialNodes.size;
    let io = null;
    if (typeof IntersectionObserver === 'function' && pane) {
      io = new IntersectionObserver((entries) => {
        const at = performance.now();
        for (const entry of entries) {
          const node = entry.target;
          if (initialNodes.has(node)) continue;
          if (!entry.isIntersecting) continue;
          if (entry.intersectionRect.width < 2 || entry.intersectionRect.height < 2) continue;
          if (!rec.visibility.has(node)) rec.visibility.set(node, at);
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length >= 4 && rec.firstContentAt === null) {
            rec.firstContentAt = at; rec.firstContentText = text.slice(0, 80); rec.visibleAt = at;
          }
        }
      }, { root: pane, rootMargin: '0px', threshold: 0 });
    }
    const messageObserver = new MutationObserver((records) => {
      const at = performance.now();
      rec.lastMutationAt = at;
      let topLevel = 0; let content = 0; let subtree = 0; let removed = 0;
      for (const record of records) {
        rec.mutations += 1;
        removed += record.removedNodes.length;
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || node.parentElement !== container) continue;
          topLevel += 1;
          subtree += (node.querySelectorAll ? node.querySelectorAll('*').length + 1 : 1);
          if (node.matches(CONTENT)) { content += 1; io?.observe(node); }
        }
      }
      rec.addedTopLevel += topLevel;
      rec.addedSubtreeElements += subtree;
      rec.removedNodes += removed;
      if (content > 0) { rec.contentAdds += content; rec.contentBatches.push([at, content]); }
    });
    rec.lastMutationAt = performance.now();
    messageObserver.observe(container, { childList: true, subtree: true });
    rec.observer = messageObserver;
    rec.io = io;
    rec.container = container;
    rec.pane = pane;
    rec.initialNodes = initialNodes;
    const tick = () => {
      if (rec.finished) return;
      const at = performance.now();
      rec.frames += 1;
      if (FL.rafGaps.length < 4000) FL.rafGaps.push(at);
      const count = container.querySelectorAll(CONTENT).length;
      if (count > rec.maxContentNodes) rec.maxContentNodes = count;
      const complete = container.dataset ? container.dataset.renderComplete === undefined || container.dataset.renderComplete === 'true' : true;
      const quiet = at - rec.lastMutationAt >= ${QUIET_MS};
      if (quiet && complete && (rec.firstContentAt !== null || at - rec.startedAt >= 3000)) { finish('quiet'); return; }
      if (at - rec.startedAt >= ${MAX_SAMPLE_MS}) { finish('timeout'); return; }
      requestAnimationFrame(tick);
    };
    const finish = (reason) => {
      if (rec.finished) return;
      rec.finished = true; rec.reason = reason; rec.endAt = performance.now();
      try { messageObserver.disconnect(); io?.disconnect(); } catch (error) {}
    };
    requestAnimationFrame(tick);
    return rec;
  }

  const wire = (rec) => {
    const container = rec.container ?? document.querySelector(CONTAINER);
    const pane = rec.pane ?? document.querySelector(PANE);
    const nodes = container ? Array.from(container.querySelectorAll(CONTENT)) : [];
    const brief = (node) => (node ? (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) : null);
    const first = nodes[0] ?? null;
    const last = nodes[nodes.length - 1] ?? null;
    return {
      reason: rec.reason, startedAt: rec.startedAt, clickAt: rec.clickAt, endAt: rec.endAt,
      firstContentAt: rec.firstContentAt, firstContentText: rec.firstContentText,
      contentAdds: rec.contentAdds, contentBatches: rec.contentBatches, addedTopLevel: rec.addedTopLevel,
      addedSubtreeElements: rec.addedSubtreeElements, removedNodes: rec.removedNodes, mutations: rec.mutations,
      frames: rec.frames, maxContentNodes: rec.maxContentNodes, initialContent: rec.initialContent,
      contentCount: nodes.length,
      elementCount: container ? container.querySelectorAll('*').length : null,
      treeElementCount: document.querySelectorAll('*').length,
      firstNodeText: brief(first), lastNodeText: brief(last),
      firstNodeVisibleAt: first ? (rec.visibility.get(first) ?? null) : null,
      lastNodeVisibleAt: last ? (rec.visibility.get(last) ?? null) : null,
      visibleNodeCount: rec.visibility.size,
      scrollTop: pane ? pane.scrollTop : null, scrollHeight: pane ? pane.scrollHeight : null,
      clientHeight: pane ? pane.clientHeight : null,
      renderComplete: container?.dataset ? (container.dataset.renderComplete ?? null) : null,
      messageTotal: container?.dataset ? (container.dataset.messageTotal ?? null) : null,
      moreExists: MORE ? Boolean(document.querySelector(MORE)) : false,
      moreText: MORE ? (document.querySelector(MORE)?.textContent ?? null) : null,
    };
  };

  window.__flBoot = () => { FL.sample = makeRecorder(); FL.ready = true; return { ok: true, t0: FL.t0 }; };
  window.__flRead = () => JSON.stringify({ sample: FL.sample ? wire(FL.sample) : null, more: FL.more, lts: FL.lts, errors: FL.errors, t0: FL.t0, instr: FL.instr, rafGaps: FL.rafGaps });
  window.__flMessages = () => JSON.stringify(FL.fetches.filter((f) => f.url.includes('/messages')).map((f) => ({
    url: f.url, startedAt: f.startedAt, endedAt: f.endedAt, status: f.status, chars: f.bytes,
    hash: f.text ? hash(f.text) : null,
    messages: (() => { try { return JSON.parse(f.text).messages?.length ?? null; } catch { return null; } })(),
    extras: (() => { try { return JSON.parse(f.text).extras?.length ?? null; } catch { return null; } })(),
    compactionAt: (() => { try { return JSON.parse(f.text).compaction?.atIndex ?? null; } catch { return null; } })(),
    hasTail: (() => { try { return JSON.parse(f.text).tail !== undefined; } catch { return null; } })(),
  })));
  window.__flFetchSummary = () => JSON.stringify(FL.fetches.map((f) => ({ url: f.url.split('?')[0], q: f.url.includes('?') ? f.url.slice(f.url.indexOf('?')) : '', status: f.status, chars: f.bytes })));
  // 滚到顶：顶上是「会话第一条」还是「显示更早 N 条」按钮 —— 截断的直接证据。
  // 同时量「滚到顶之后手顺里第一条正文节点什么时候可见」（内容真在 DOM 里才会快）。
  window.__flReveal = () => new Promise((resolve) => {
    const pane = document.querySelector(PANE);
    const container = document.querySelector(CONTAINER);
    if (!pane || !container) return resolve(JSON.stringify({ ok: false }));
    const nodes = Array.from(container.querySelectorAll(CONTENT));
    const first = nodes[0] ?? null;
    let firstVisibleAt = null;
    let io = null;
    if (first && typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.intersectionRect.width < 2 || entry.intersectionRect.height < 2) continue;
          if (firstVisibleAt === null) firstVisibleAt = performance.now();
        }
      }, { root: pane, rootMargin: '0px', threshold: 0 });
      io.observe(first);
    }
    const scrolledAt = performance.now();
    pane.scrollTop = 0;
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      io?.disconnect();
      // 布局成本 A/B：先让当前状态（虚拟化开/关）各付一次 style+layout。
      // ⚠️ 只对**本来就有 data-virtual 这个属性**的容器做（v2.1 没有惰性规则，改了也没意义，
      //    而且 dataset.x = undefined 会被写成字符串 "undefined" —— 踩过）。
      let layoutAb = null;
      let virtualNow = container.dataset.virtual;
      try {
        if (typeof virtualNow === 'string') {
          const before = virtualNow;
          void container.offsetHeight;
          const t1 = performance.now();
          container.dataset.virtual = 'false';
          void container.offsetHeight;
          const withoutVirtual = Math.round((performance.now() - t1) * 100) / 100;
          const t2 = performance.now();
          container.dataset.virtual = 'true';
          void container.offsetHeight;
          const withVirtual = Math.round((performance.now() - t2) * 100) / 100;
          container.dataset.virtual = before;
          layoutAb = { withoutVirtual, withVirtual };
        }
      } catch (error) { layoutAb = { error: String(error) }; }
      resolve(JSON.stringify({
        ok: true, scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight,
        contentCount: nodes.length,
        virtual: container.dataset.virtual ?? null,
        computedContentVisibility: first ? getComputedStyle(first).contentVisibility : null,
        inlineVisibleCount: nodes.filter((node) => node.style && node.style.contentVisibility === 'visible').length,
        layoutAb,
        firstVisibleAfterScrollMs: firstVisibleAt === null ? null : Math.round((firstVisibleAt - scrolledAt) * 100) / 100,
        topNodeText: first ? (first.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) : null,
        moreExists: MORE ? Boolean(document.querySelector(MORE)) : false,
        moreText: MORE ? (document.querySelector(MORE)?.textContent ?? null) : null,
      }));
    }, 350)));
  });
  // v2.1 专有：点「↑ 显示更早的 N 条」把整段历史真的建进 DOM（它拿什么换来的「轻」）。
  window.__flMore = () => {
    const node = MORE ? document.querySelector(MORE) : null;
    if (!node) return JSON.stringify({ ok: false, reason: 'no-more-button' });
    const rec = makeRecorder();
    rec.clickAt = performance.now();
    node.click();
    FL.more = rec;
    return JSON.stringify({ ok: true, clickedAt: rec.clickAt });
  };
  window.__flMoreRead = () => JSON.stringify(FL.more ? wire(FL.more) : null);

  const boot = () => { if (!document.querySelector(CONTAINER)) { setTimeout(boot, 5); return; } window.__flBoot(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;

function classifyUrl(url) {
  const clean = String(url).split('?')[0];
  if (clean.includes('/messages')) return 'messages';
  if (clean.endsWith('/events') || clean.includes('event-stream')) return 'sse';
  if (clean.includes('/tree')) return 'tree';
  if (clean.includes('/sessions/')) return 'session-detail';
  // ⚠️ 两版静态资源的扩展名不同（v2.1 = .mjs，v2.2 = .js）—— 只认 .js 会把 v2.1 的 app.mjs/render.mjs
  //    漏进 'other' 里，让两版的静态字节不可比（踩过）。
  if (/\/(app|render|mentions|markdown)\.(js|mjs)$|\/(index\.html|slot\.css|favicon\.ico)$|\/vendor\//.test(clean)) return 'static';
  return 'other';
}

function summarizeNetwork(events, startedAt, endedAt) {
  const buckets = new Map();
  for (const event of events) {
    const at = event.at ?? 0;
    if (at < startedAt - 1 || at > endedAt + 1) continue;
    const key = classifyUrl(event.url);
    const bucket = buckets.get(key) ?? { count: 0, bytes: 0, decodedBytes: 0, encodings: new Set(), statuses: new Set() };
    bucket.count += 1;
    bucket.bytes += event.bytes ?? 0;
    bucket.decodedBytes += event.decodedBytes ?? 0;
    if (event.encoding) bucket.encodings.add(event.encoding);
    if (event.status) bucket.statuses.add(event.status);
    buckets.set(key, bucket);
  }
  const out = {};
  for (const [key, bucket] of buckets) {
    out[key] = { count: bucket.count, bytes: bucket.bytes, decodedBytes: bucket.decodedBytes, encodings: [...bucket.encodings], statuses: [...bucket.statuses] };
  }
  const total = [...buckets.values()].reduce((acc, bucket) => acc + bucket.bytes, 0);
  const totalDecoded = [...buckets.values()].reduce((acc, bucket) => acc + bucket.decodedBytes, 0);
  return { buckets: out, totalBytes: total, totalDecodedBytes: totalDecoded };
}

function metricSnapshot(metrics) {
  const out = {};
  for (const item of metrics.metrics ?? []) out[item.name] = item.value;
  return out;
}
function metricDelta(before, after) {
  const out = {};
  for (const key of ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'RecalcStyleCount', 'LayoutCount', 'JSHeapUsedSize']) {
    const a = Number(after[key]); const b = Number(before[key]);
    if (Number.isFinite(a) && Number.isFinite(b)) out[key] = key.endsWith('Count') ? a - b : round2((a - b) * 1000);
  }
  return out;
}

/** 一次「冷页面深链打开」。 */
async function measureFirstLoad({ session, round, instrument = false }) {
  const bPort = session.bPort;
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), `v21fl-chrome-${session.key}-`));
  const problems = [];
  const browser = await launchChromium(userDataDir);
  const cdp = new Cdp(browser.version.webSocketDebuggerUrl);
  await cdp.open();
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const pageSession = attached.sessionId;
  const s = (method, params, timeoutMs) => cdp.send(method, params, pageSession, timeoutMs);
  const netEvents = [];
  const balance = new Map();
  cdp.on('Network.requestWillBeSent', (params) => { balance.set(params.requestId, { url: params.request.url, at: nowMs(), encoding: null, status: null, dataLength: 0 }); });
  cdp.on('Network.responseReceived', (params) => {
    const entry = balance.get(params.requestId);
    if (!entry) return;
    entry.status = params.response.status;
    entry.encoding = params.response.headers['content-encoding'] ?? params.response.headers['Content-Encoding'] ?? null;
  });
  cdp.on('Network.dataReceived', (params) => {
    const entry = balance.get(params.requestId);
    if (entry) entry.dataLength += params.dataLength || 0;
  });
  cdp.on('Network.loadingFinished', (params) => {
    const entry = balance.get(params.requestId);
    if (entry) netEvents.push({ url: entry.url, at: nowMs(), bytes: params.encodedDataLength ?? 0, decodedBytes: entry.dataLength, encoding: entry.encoding, status: entry.status });
  });
  cdp.on('Network.loadingFailed', (params) => {
    const entry = balance.get(params.requestId);
    if (entry) netEvents.push({ url: entry.url, at: nowMs(), bytes: 0, decodedBytes: entry.dataLength, encoding: entry.encoding, status: entry.status, failed: params.errorText });
  });

  try {
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Network.enable');
    await s('Performance.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SOURCE(session.cfg, instrument) });
    const metricsBefore = metricSnapshot(await s('Performance.getMetrics'));
    const url = `http://127.0.0.1:${bPort}/#${session.id}`;
    const navStartedAt = nowMs();
    await s('Page.navigate', { url });
    // 等页内样本收工（settle + renderComplete），兜底 maxSample+20s。
    await s('Runtime.evaluate', {
      expression: `new Promise((resolve) => { const t = setInterval(() => { const fl = window.__fl; if (fl && fl.sample && fl.sample.finished) { clearInterval(t); resolve(true); } }, 50); setTimeout(() => { clearInterval(t); resolve(false); }, ${MAX_SAMPLE_MS + 20000}); })`,
      awaitPromise: true, returnByValue: true,
    }, MAX_SAMPLE_MS + 60000);
    const navEndedAt = nowMs();
    const read = await s('Runtime.evaluate', { expression: 'window.__flRead()', returnByValue: true });
    const state = JSON.parse(read.result.value);
    const messages = JSON.parse((await s('Runtime.evaluate', { expression: 'window.__flMessages()', returnByValue: true })).result.value);
    const fetches = JSON.parse((await s('Runtime.evaluate', { expression: 'window.__flFetchSummary()', returnByValue: true })).result.value);
    const metricsAfter = metricSnapshot(await s('Performance.getMetrics'));
    const reveal = JSON.parse((await s('Runtime.evaluate', { expression: 'window.__flReveal()', awaitPromise: true, returnByValue: true })).result.value);

    // v2.1 专有第二阶段：点「显示更早的 N 条」。
    let more = null;
    if (session.cfg.moreSelector) {
      const clicked = JSON.parse((await s('Runtime.evaluate', { expression: 'window.__flMore()', returnByValue: true })).result.value);
      if (clicked.ok) {
        const moreBefore = metricSnapshot(await s('Performance.getMetrics'));
        await s('Runtime.evaluate', {
          expression: `new Promise((resolve) => { const t = setInterval(() => { const fl = window.__fl; if (fl && fl.more && fl.more.finished) { clearInterval(t); resolve(true); } }, 50); setTimeout(() => { clearInterval(t); resolve(false); }, ${MAX_SAMPLE_MS + 20000}); })`,
          awaitPromise: true, returnByValue: true,
        }, MAX_SAMPLE_MS + 60000);
        const moreRead = JSON.parse((await s('Runtime.evaluate', { expression: 'window.__flMoreRead()', returnByValue: true })).result.value);
        const moreAfter = metricSnapshot(await s('Performance.getMetrics'));
        const ltsAfter = JSON.parse((await s('Runtime.evaluate', { expression: 'JSON.stringify(window.__fl.lts)', returnByValue: true })).result.value);
        const moreLts = (ltsAfter ?? []).filter((entry) => entry.start >= (moreRead.clickAt ?? 0) - 5);
        more = {
          ...moreRead,
          longtaskMaxMs: round2(moreLts.reduce((acc, entry) => Math.max(acc, entry.dur), 0)),
          longtaskTotalMs: round2(moreLts.reduce((acc, entry) => acc + entry.dur, 0)),
          metrics: metricDelta(moreBefore, moreAfter),
        };
      } else { more = clicked; }
    }

    const sample = state.sample ?? {};
    const t0 = state.t0 ?? 0;
    const rel = (value) => (typeof value === 'number' && Number.isFinite(value) ? round2(value - t0) : null);
    const lts = (state.lts ?? []).filter((entry) => entry.start >= t0 - 5);
    return {
      version: session.key, round, viewport: VIEWPORT.label, sessionId: session.id,
      url,
      navWallMs: round2(navEndedAt - navStartedAt),
      firstContentMs: rel(sample.firstContentAt),
      lastContentVisibleMs: rel(sample.lastNodeVisibleAt),
      firstContentNodeVisibleMs: rel(sample.firstNodeVisibleAt),
      allVisibleNodesMs: rel(sample.visibleNodeCount > 0 ? sample.endAt : null),
      settleMs: rel(sample.endAt),
      settleReason: sample.reason,
      contentBatches: (sample.contentBatches ?? []).map(([at, count]) => [rel(at), count]),
      contentAdds: sample.contentAdds ?? 0,
      contentCount: sample.contentCount ?? null,
      elementCount: sample.elementCount ?? null,
      pageElementCount: sample.treeElementCount ?? null,
      addedSubtreeElements: sample.addedSubtreeElements ?? 0,
      addedTopLevel: sample.addedTopLevel ?? 0,
      removedNodes: sample.removedNodes ?? 0,
      renderComplete: sample.renderComplete,
      messageTotal: sample.messageTotal,
      firstNodeText: sample.firstNodeText,
      lastNodeText: sample.lastNodeText,
      firstContentText: sample.firstContentText,
      moreExists: sample.moreExists,
      moreText: sample.moreText,
      paneScrollHeight: sample.scrollHeight,
      metrics: metricDelta(metricsBefore, metricsAfter),
      longtaskCount: lts.length,
      longtaskTotalMs: round2(lts.reduce((acc, entry) => acc + entry.dur, 0)),
      longtaskMaxMs: round2(lts.reduce((acc, entry) => Math.max(acc, entry.dur), 0)),
      longtaskEntries: lts.map((entry) => ({ start: rel(entry.start), dur: round2(entry.dur) })),
      network: summarizeNetwork(netEvents, navStartedAt, navEndedAt),
      instr: state.instr ?? [],
      rafGaps: state.rafGaps ?? [],
      messages,
      fetches,
      reveal,
      more,
      pageErrors: state.errors ?? [],
    };
  } finally {
    cdp.close();
    await cleanupStep(problems, 'close chromium', async () => {
      if (browser.child.exitCode === null && browser.child.signalCode === null) {
        browser.child.kill('SIGTERM');
        for (let attempt = 0; attempt < 60; attempt += 1) {
          if (browser.child.exitCode !== null || browser.child.signalCode !== null) break;
          await sleep(50);
        }
        if (browser.child.exitCode === null && browser.child.signalCode === null) browser.child.kill('SIGKILL');
      }
    });
    await cleanupStep(problems, 'remove chrome profile', () => fsp.rm(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  }
}

async function run(problems) {
  const fixtures = JSON.parse(await fsp.readFile(path.join(OUT, 'fixtures.json'), 'utf8'));
  const id = fixtures.sessionId;
  const results = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const order = round % 2 === 1 ? ['v21', 'v22'] : ['v22', 'v21'];
    for (const key of order) {
      if (ONLY && !ONLY.includes(key)) continue;
      const session = await startVersion(key);
      session.id = id;
      session.cfg = VERSIONS[key];
      try {
        const record = await measureFirstLoad({ session, round, instrument: INSTRUMENT });
        record.load = { key, startedAt: new Date().toISOString() };
        results.push(record);
        log(`[run] round ${round} ${VERSIONS[key].label}: firstContent=${record.firstContentMs}ms settle=${record.settleMs}ms content=${record.contentCount} elements=${record.elementCount} /messages=${record.messages.length} wire=${record.network.buckets.messages?.bytes ?? 0}B`);
        await fsp.writeFile(path.join(OUT, `sample-${key}-r${round}.json`), JSON.stringify(record, null, 2), 'utf8');
      } finally {
        await stopVersion(session, problems);
      }
    }
  }
  await fsp.writeFile(path.join(OUT, 'first-load.json'), JSON.stringify(results, null, 2), 'utf8');
  log('[run] raw →', path.join(OUT, 'first-load.json'));
  return results;
}

// ───────────────────────────── 报表 ─────────────────────────────
function pick(samples, getter) {
  return samples.map(getter).filter((value) => typeof value === 'number' && Number.isFinite(value));
}
function stat(values) {
  const xs = [...values].sort((a, b) => a - b);
  if (!xs.length) return null;
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return { n: xs.length, min: xs[0], median, max: xs[xs.length - 1] };
}
const fmt = (s, digits = 1) => (!s ? '—' : `${s.median.toFixed(digits)} (${s.min.toFixed(digits)}–${s.max.toFixed(digits)})`);
const fmtInt = (s) => (!s ? '—' : `${Math.round(s.median)} (${Math.round(s.min)}–${Math.round(s.max)})`);

const ROWS = [
  ['导航 → 第一块正文可见', 'ms', (r) => r.firstContentMs, fmt],
  ['导航 → **最后一条**正文可见', 'ms', (r) => r.lastContentVisibleMs, fmt],
  ['导航 → 手顺里**第一条**正文节点可见（贴底时通常 null）', 'ms', (r) => r.firstContentNodeVisibleMs, fmt],
  ['导航 → 静置（无 DOM 变动 + 补齐完成）', 'ms', (r) => r.settleMs, fmt],
  ['正文节点数（结束时）', '个', (r) => r.contentCount, fmtInt],
  ['元素总数（正文容器子树）', '个', (r) => r.elementCount, fmtInt],
  ['页面元素总数', '个', (r) => r.pageElementCount, fmtInt],
  ['新建元素总数（含子树）', '个', (r) => r.addedSubtreeElements, fmtInt],
  ['正文重建批次数', '批', (r) => (r.contentBatches ?? []).length, fmtInt],
  ['主线程 ScriptDuration', 'ms', (r) => r.metrics.ScriptDuration, fmt],
  ['主线程 LayoutDuration', 'ms', (r) => r.metrics.LayoutDuration, fmt],
  ['主线程 TaskDuration', 'ms', (r) => r.metrics.TaskDuration, fmt],
  ['RecalcStyleCount', '次', (r) => r.metrics.RecalcStyleCount, fmtInt],
  ['LayoutCount', '次', (r) => r.metrics.LayoutCount, fmtInt],
  ['longtask 最长一条', 'ms', (r) => r.longtaskMaxMs, fmt],
  ['longtask 总时长', 'ms', (r) => r.longtaskTotalMs, fmt],
  ['/messages 请求数', '次', (r) => (r.messages ?? []).length, fmtInt],
  ['/messages 响应体（字符）', 'chars', (r) => r.messages?.[0]?.chars ?? null, fmtInt],
  ['/messages 服务端条数', '条', (r) => r.messages?.[0]?.messages ?? null, fmtInt],
  ['/messages 线上字节（CDP encodedDataLength）', 'B', (r) => r.network.buckets.messages?.bytes ?? null, fmtInt],
  ['/messages 响应体字节（CDP dataReceived，解压后）', 'B', (r) => r.network.buckets.messages?.decodedBytes ?? null, fmtInt],
  ['首屏窗口总字节（messages+static+tree+session-detail+other）', 'B', (r) => r.network.totalBytes ?? null, fmtInt],
  ['内容完整性：正文节点 / 服务端条数', '比值', (r) => { const total = r.messages?.[0]?.messages; return total ? round2(r.contentCount / total) : null; }, (s) => (!s ? '—' : `${s.median.toFixed(3)} (${s.min.toFixed(3)}–${s.max.toFixed(3)})`)],
  ['（第二阶段）滚到顶 → 手顺第一条可见', 'ms', (r) => r.reveal?.firstVisibleAfterScrollMs ?? null, fmt],
  ['（诊断）强制重排 · 关惰性布局', 'ms', (r) => (typeof r.reveal?.virtual === 'string' ? r.reveal?.layoutAb?.withoutVirtual ?? null : null), fmt],
  ['（诊断）强制重排 · 开惰性布局', 'ms', (r) => (typeof r.reveal?.virtual === 'string' ? r.reveal?.layoutAb?.withVirtual ?? null : null), fmt],
];

async function report() {
  const results = JSON.parse(await fsp.readFile(path.join(OUT, 'first-load.json'), 'utf8'));
  const fixtures = JSON.parse(await fsp.readFile(path.join(OUT, 'fixtures.json'), 'utf8'));
  const groups = { v21: results.filter((r) => r.version === 'v21'), v22: results.filter((r) => r.version === 'v22') };
  const lines = [];
  lines.push('# 打开大会话：首次加载 —— v2.1 vs v2.2');
  lines.push('');
  lines.push(`夹具：\`${path.basename(fixtures.fixture.source)}\`（${(fixtures.fixture.frozenBytes / 1048576).toFixed(2)} MiB / ${fixtures.fixture.lines} 行 / sha256 \`${fixtures.fixture.sha256.slice(0, 16)}…\`）`);
  lines.push(`v2.1 = tag v2.1-final \`${fixtures.v21Sha}\` · v2.2 = \`${fixtures.v22Sha}\` · 视口 ${VIEWPORT.label} · Node ${fixtures.node} · ${path.basename(fixtures.chrome)}`);
  lines.push('');
  lines.push(`| 指标 | 单位 | v2.1 (n=${groups.v21.length}) | v2.2 (n=${groups.v22.length}) | v2.2/v2.1 |`);
  lines.push('|---|---|---:|---:|---:|');
  for (const [label, unit, getter, formatter] of ROWS) {
    const a = stat(pick(groups.v21, getter));
    const b = stat(pick(groups.v22, getter));
    const ratio = a && b && a.median ? round2(b.median / a.median) : null;
    lines.push(`| ${label} | ${unit} | ${formatter(a)} | ${formatter(b)} | ${ratio === null ? '—' : `${ratio}×`} |`);
  }
  lines.push('');
  lines.push('## 逐样本');
  lines.push('');
  lines.push('| 轮 | 版 | firstContent | lastVisible | settle | 正文节点 | 元素 | /messages 次 | 条数 | 载荷字符 | 线上 B | 编码 | br? |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|');
  for (const r of results) {
    const bucket = r.network.buckets.messages ?? {};
    lines.push(`| ${r.round} | ${r.version} | ${r.firstContentMs} | ${r.lastContentVisibleMs} | ${r.settleMs} | ${r.contentCount} | ${r.elementCount} | ${(r.messages ?? []).length} | ${r.messages?.[0]?.messages ?? '—'} | ${r.messages?.[0]?.chars ?? '—'} | ${bucket.bytes ?? 0} | ${(bucket.encodings ?? []).join(',') || 'identity'} | ${(bucket.bytes ?? 0) < (r.messages?.[0]?.chars ?? Infinity) ? '✓' : '✗'} |`);
  }
  lines.push('');
  lines.push('## 惰性布局的诊断（`__flReveal` 里那一段 A/B）');
  lines.push('');
  for (const r of results) {
    const ab = r.reveal?.layoutAb;
    lines.push(`- r${r.round} ${r.version}: data-virtual=${r.reveal?.virtual} computed content-visibility(first)=${r.reveal?.computedContentVisibility} 行内 visible 节点=${r.reveal?.inlineVisibleCount} 强制重排(关惰性)=${ab ? `${ab.withoutVirtual}ms` : '—'} (开惰性)=${ab ? `${ab.withVirtual}ms` : '—'}`);
  }
  lines.push('');
  lines.push('## 滚到顶（`__flReveal`）');
  lines.push('');
  for (const key of ['v21', 'v22']) {
    for (const r of groups[key]) {
      lines.push(`- r${r.round} ${key}: content=${r.reveal?.contentCount} 滚到顶后第一条可见=${r.reveal?.firstVisibleAfterScrollMs}ms top=「${String(r.reveal?.topNodeText ?? '').slice(0, 60)}」 moreButton=${r.reveal?.moreExists ? `「${r.reveal.moreText}」` : '无'}`);
    }
  }
  lines.push('');
  const v21More = groups.v21.map((r) => r.more).filter((m) => m && typeof m.clickAt === 'number');
  if (v21More.length) {
    lines.push('## v2.1 点「↑ 显示更早的 N 条」之后的成本（它把首次加载省下来的那部分挪到了这里）');
    lines.push('');
    lines.push('| 轮 | 正文节点 | 元素 | 新建元素（含子树） | ScriptDuration | LayoutDuration | LayoutCount | longtask 最长 | 从点击到静置 |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of groups.v21) {
      if (!r.more || typeof r.more.clickAt !== 'number') continue;
      lines.push(`| ${r.round} | ${r.more.contentCount} | ${r.more.elementCount} | ${r.more.addedSubtreeElements} | ${r.more.metrics?.ScriptDuration} | ${r.more.metrics?.LayoutDuration} | ${r.more.metrics?.LayoutCount} | ${r.more.longtaskMaxMs ?? '—'} | ${round2((r.more.endAt ?? 0) - (r.more.clickAt ?? 0))} |`);
    }
    lines.push('');
  }
  const text = lines.join('\n');
  const file = path.join(OUT, 'first-load.md');
  await fsp.writeFile(file, text, 'utf8');
  process.stdout.write(text + '\n');
  log('[report] →', file);
  return file;
}

let primary = null;
const problems = [];
try {
  if (MODE === 'prepare' || MODE === 'all') await prepare();
  if (MODE === 'run' || MODE === 'all') await run(problems);
  if (MODE === 'report' || MODE === 'all') await report();
} catch (error) {
  primary = error;
} finally {
  finishCleanup(primary, problems);
}
