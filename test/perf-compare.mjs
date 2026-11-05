#!/usr/bin/env node
// perf-compare.mjs —— v2.1(tag `v2.1-final`) 与 v2.2 的性能对照 harness。
//
// 一条命令跑完（prepare + 交替 round + JSON + 人读汇总）：
//
//   node test/perf-compare.mjs all --out work/perf
//
// 它做的事（为什么这么设计，见 docs/history/perf-v21-vs-v22.md §方法）：
//   1. prepare：把真实 profile 复制成**两份**临时 home（v2.1 / v2.2 各一份，sessions 内容相同），
//      把两版的 `bin/serve.sh` / 端口变量差异压平成同一个「直接起 node」的起法。
//   2. 每轮**串行**交替两个版本（A/B/A/B…），每项测 ≥rounds 次。
//   3. 输出 JSON（全部原始样本）+ Markdown 汇总（median / p95 / 全距）。
//
// ⚠️ 铁律（写在代码里，防后来人改坏）：
//   · **绝不**碰真实 profile 与 7331/7321；home 是 `os.tmpdir()` 下的副本，端口是随机高位。
//   · **绝不** pkill；停进程只按「我们自己 spawn 出来的 pid」——先核对 cmdline 再 taskkill /T。
//   · 日志写到 --out 目录，**不写** /tmp/sopho-base.log。
//
// 端口变量的口径差异（这是最容易搞错的一条）：
//   v2.1(tag `v2.1-final`)：A = SOPHO_BASE_PORT，B = SOPHO_PORT
//   v2.2        ：A = SOPHO_PORT，      B = SOPHO_APP_PORT
// 同一个名字在两版里指**不同角色** —— 见下方 VERSIONS。

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { browserSandboxEnv } from './harness.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const CHROME_BIN = process.env.CHROME_BIN || (process.platform === 'win32'
  ? 'C:/Users/user/AppData/Local/Chromium/Application/chrome.exe'
  : '/usr/bin/chromium');
// 共享 node_modules 的来源：显式 SOPHO_MAIN_REPO 优先；否则按 git 的「公共目录」推**主检出**
// （worktree → 主树；独立克隆 → 它自己）。原来这里硬编码了作者那台机器的绝对路径，且**没有
// 平台保护**：换个用户名、或换到 Linux/macOS，缺这个环境变量就直接死在「共享 node_modules 不存在」，
// 而 docs 里的「一条命令」复现说明并没有提这个变量。口径与 test/s0b.mjs、test/win-serve.mjs 的
// node_modules 回落写法一致。
const MAIN_REPO = process.env.SOPHO_MAIN_REPO || (() => {
  try {
    const commonDir = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    return path.dirname(path.resolve(repoRoot, commonDir));
  } catch { return repoRoot; }
})();
const REAL_HOME = process.env.SOPHO_REAL_HOME || path.join(os.homedir(), '.pi', 'profiles', 'assistant');
const FORBIDDEN_PORTS = new Set([7331, 7321, 7322, 7411, 7412]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

// ───────────────────────────── 版本配置 ─────────────────────────────
// envA/envB 的参数：(home, aPort, bPort, repo)
const VERSIONS = {
  v21: {
    label: 'v2.1',
    ref: 'v2.1-final',
    envA: (home, aPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_HOST: '127.0.0.1', SOPHO_BASE_PORT: String(aPort), SOPHO_CWD: home,
    }),
    envB: (home, aPort, bPort, repo) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(bPort),
      SOPHO_BASE_URL: `http://127.0.0.1:${aPort}`, SOPHO_WEB_ROOT: path.join(repo, 'web'),
    }),
    rowSelector: '#tree .sess',
    // v2.1 的正文容器是 `#hist`（`#messages` 是它的滚动外框）——数错容器会把 1591 条数成 3。
    messageNodeSelector: '#hist > *',
    // v2.1 支持 `#<id>` 深链（hashchange → open(id)）。
    switchExpr: (id) => `location.hash = ${JSON.stringify(id)}; true`,
    hotCount: (probes) => (typeof probes.live?.count === 'number' ? probes.live.count : null),
    cwdRecentsShape: 'object',
  },
  v22: {
    label: 'v2.2',
    ref: 'HEAD',
    envA: (home, aPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(aPort),
    }),
    envB: (home, aPort, bPort, repo) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(bPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(aPort),
      SOPHO_WEB_ROOT: path.join(repo, 'web'),
    }),
    rowSelector: '#tree .tree-session',
    // v2.2 的正文容器是 `#messages`（消息/扩展/压缩边界/直播都直接挂在它下面）。
    messageNodeSelector: '#messages > *',
    // v2.2 树行带 data-session-id（web/render.js）。
    switchExpr: (id) => `(() => { const el = document.querySelector('[data-session-id=${JSON.stringify(id)}]'); if (!el) return false; el.click(); return true; })()`,
    hotCount: (probes) => {
      const pool = probes.host?.pool;
      if (typeof pool?.hot === 'number') return pool.hot;
      const details = Array.isArray(probes.host?.workerDetails) ? probes.host.workerDetails : [];
      const sum = details.reduce((acc, w) => acc + (typeof w.hot === 'number' ? w.hot : 0), 0);
      return details.length ? sum : null;
    },
    cwdRecentsShape: 'array',
  },
};

// ───────────────────────────── CLI ─────────────────────────────
function parseArgs(argv) {
  const args = { mode: argv[0] && !argv[0].startsWith('--') ? argv[0] : 'all' };
  for (let i = args.mode === argv[0] ? 1 : 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const ROUNDS = Number(args.rounds ?? 5);
const SUITE = String(args.suite ?? 'all');
const WORK = path.resolve(String(args.work ?? path.join(os.tmpdir(), 'sopho-perf-compare')));
const OUT = path.resolve(String(args.out ?? path.join(WORK, 'out')));
const SYNTHETIC_EXTRA = Number(args['synthetic-extra'] ?? 0);
const OPEN_COUNTS = String(args['open-counts'] ?? '1,8,16').split(',').map(Number);
const ONLY = args.only ? String(args.only).split(',') : null;
const HTTP_TIMEOUT = Number(args['http-timeout'] ?? 180000);

if (args.help) {
  process.stdout.write(`usage: node test/perf-compare.mjs [all|prepare|run] [--rounds 5] [--suite all|http|frontend]\n` +
    `  --work <dir>           工作目录（home 副本 / 日志 / 输出）。默认 os.tmpdir()/sopho-perf-compare\n` +
    `  --out <dir>            输出目录。默认 <work>/out\n` +
    `  --synthetic-extra N    prepare 时额外造 N 条合成会话（放大 /tree 规模）。默认 0\n` +
    `  --open-counts 1,8,16   内存项要开的会话数档位\n` +
    `  --http-timeout MS      单次 HTTP 超时。默认 180000\n`);
  process.exit(0);
}

// 本门依赖 Windows：prepare 用 powershell.exe 建 junction，内存/进程项走 psTable()
// （Get-CimInstance Win32_Process），停进程走 killTree()（taskkill）；非 Windows 上一调用就
// ENOENT，只能是「永远红」的假失败。照 test/win-serve.mjs 的先例：非 Windows 打印一行显眼的
// SKIP 并 exit 0（Windows 上的真跑一字不改）。
if (process.platform !== 'win32') {
  console.log(`SKIP test:perfcompare (Windows-only；本机 ${process.platform})`);
  process.exit(0);
}

// ───────────────────────────── 小工具 ─────────────────────────────
function log(...parts) { process.stdout.write(`${parts.join(' ')}\n`); }

async function reservePort() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (FORBIDDEN_PORTS.has(port)) continue;
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('could not reserve a free high port');
}

function stats(samples) {
  const xs = samples.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const at = (q) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))];
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return { n: xs.length, min: xs[0], median, p95: at(0.95), max: xs[xs.length - 1] };
}
const round2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

// 一次 HTTP GET，返回 {status, ms, bytes, json?}。默认 keep-alive（稳态语义）；
// 传 agent:false 强制新连接（冷语义）。
function httpGet(url, { agent, timeoutMs = HTTP_TIMEOUT, parseJson = false, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const started = nowMs();
    const req = http.request(url, { method, agent, headers: { accept: 'application/json' } }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; if (parseJson) chunks.push(c); });
      res.on('end', () => {
        const result = { status: res.statusCode, ms: round2(nowMs() - started), bytes };
        if (parseJson) {
          const text = Buffer.concat(chunks).toString('utf8');
          try { result.json = JSON.parse(text); } catch { result.jsonError = text.slice(0, 200); }
        }
        resolve(result);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)));
    req.end();
  });
}

async function waitHttp(port, route, deadlineMs) {
  const started = nowMs();
  let last;
  while (nowMs() - started < deadlineMs) {
    try {
      const res = await httpGet(`http://127.0.0.1:${port}${route}`, { agent: false, timeoutMs: deadlineMs, parseJson: route === '/tree' });
      if (res.status === 200) return { ...res, waitedMs: round2(nowMs() - started) };
      last = `HTTP ${res.status}`;
    } catch (error) { last = error.message; }
    await sleep(150);
  }
  throw new Error(`${route} on ${port} never became ready (${last})`);
}

// ───────────────────────────── Windows 进程表 ─────────────────────────────
async function psTable() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 * 1024 * 1024 });
  const raw = JSON.parse(stdout || '[]');
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    name: r.Name,
    rss: Number(r.WorkingSetSize) || 0,
    cmd: typeof r.CommandLine === 'string' ? r.CommandLine : '',
  }));
}

function descend(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of byParent.get(pid) ?? []) { out.push(child); stack.push(child.pid); }
  }
  return out;
}

function rssOfTree(rows, rootPid) {
  const self = rows.find((r) => r.pid === rootPid);
  const kids = descend(rows, rootPid);
  return {
    selfRss: self?.rss ?? 0,
    children: kids.map((k) => ({ pid: k.pid, name: k.name, rss: k.rss })),
    totalRss: (self?.rss ?? 0) + kids.reduce((acc, k) => acc + k.rss, 0),
  };
}

// 只按「我们自己起的 pid」停：先核 cmdline（防 pid 被复用），再 taskkill /T
// （Windows 下一次带走 v2.2 的 generation worker / chromium 全部子进程）。
// 额外的保险：这个 pid 如果正监听着禁用端口（真实例），**一个信号都不发**。
async function listeningPorts(pid) {
  const script = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq ${Number(pid)} } | Select-Object -ExpandProperty LocalPort`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return stdout.split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
}

async function killTree(pid, expectFragment) {
  if (!pid) return { stopped: false, reason: 'no-pid' };
  const rows = await psTable();
  const row = rows.find((r) => r.pid === pid);
  if (!row) return { stopped: false, reason: 'already-gone', pid };
  const normalized = row.cmd.replaceAll('\\', '/');
  if (expectFragment && !normalized.includes(expectFragment)) {
    return { stopped: false, pid, reason: `cmdline-mismatch: ${row.cmd.slice(0, 160)}` };
  }
  const ports = await listeningPorts(pid);
  if (ports.some((port) => FORBIDDEN_PORTS.has(port))) {
    return { stopped: false, pid, reason: `refusing: pid listens on forbidden port(s) ${ports.join(',')}` };
  }
  await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch((error) => ({ stdout: '', stderr: error.message }));
  for (let i = 0; i < 100; i += 1) {
    const after = await psTable();
    if (!after.some((r) => r.pid === pid)) return { stopped: true, pid, cmdline: row.cmd.slice(0, 200), listeningPorts: ports };
    await sleep(50);
  }
  return { stopped: false, pid, reason: 'still-alive-after-taskkill', cmdline: row.cmd.slice(0, 200) };
}

async function leftoverChildren(rows, rootPid) { return descend(rows, rootPid).map((k) => ({ pid: k.pid, name: k.name })); }

// ───────────────────────────── 机器负载快照 ─────────────────────────────
async function loadSnapshot() {
  const script = [
    '$c=@(Get-Process node -ErrorAction SilentlyContinue).Count',
    '$h=@(Get-Process chrome -ErrorAction SilentlyContinue).Count',
    '$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    '$os=Get-CimInstance Win32_OperatingSystem',
    '$pf=$os.FreePhysicalMemory',
    '$tp=$os.TotalVisibleMemorySize',
    'Write-Output "$c|$h|$cpu|$pf|$tp"',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const [node, chrome, cpu, freeKb, totalKb] = stdout.trim().split('|');
    return {
      at: new Date().toISOString(),
      nodeProcesses: Number(node), chromeProcesses: Number(chrome),
      cpuLoadPct: Number(cpu),
      memUsedMiB: Math.round((Number(totalKb) - Number(freeKb)) / 1024),
      memUsedPct: Math.round(((Number(totalKb) - Number(freeKb)) / Number(totalKb)) * 1000) / 10,
    };
  } catch (error) { return { at: new Date().toISOString(), error: error.message }; }
}

// ───────────────────────────── prepare ─────────────────────────────
async function gitSha(repo) {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function ensureJunction(link, target) {
  try { await fsp.lstat(link); return 'exists'; } catch {}
  const script = `New-Item -ItemType Junction -Path '${link.replaceAll("'", "''")}' -Target '${target.replaceAll("'", "''")}' | Out-Null`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return 'created';
}

const SIDECAR_FILES = ['archive.json', 'titles.json', 'seen.json', 'settled.json', 'workspaces.json',
  'models.json', 'models-store.json', 'settings.json', 'paths.json', 'auth.json'];

function uuidFromName(file) {
  const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file);
  return match ? match[1] : null;
}

async function prepareHome({ src, dst, repo, shape, syntheticExtra }) {
  const marker = path.join(dst, '.prepared.json');
  try {
    const existing = JSON.parse(await fsp.readFile(marker, 'utf8'));
    if (existing.syntheticExtra === syntheticExtra && existing.shape === shape) return existing;
  } catch {}

  await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(dst, { recursive: true });
  // sessions：真复制（绝不 hardlink 到真实数据 —— 一次意外写就污染真 profile）。
  await fsp.cp(path.join(src, 'sessions'), path.join(dst, 'sessions'), { recursive: true });
  for (const file of SIDECAR_FILES) {
    try { await fsp.copyFile(path.join(src, file), path.join(dst, file)); } catch {}
  }
  // extensions：指向**这个版本自己**的插件目录（两版插件不同，别让 v2.2 跑 v2.1 的插件）。
  await fsp.mkdir(path.join(dst, 'extensions'), { recursive: true });
  await ensureJunction(path.join(dst, 'extensions', 'assistant'), path.join(repo, 'pi-extensions', 'assistant'));

  // cwd-recents.json：v2.1 = 对象，v2.2 = 数组（两版形状不兼容，所以各一份 home）。
  let recentsObject = {};
  try { recentsObject = JSON.parse(await fsp.readFile(path.join(src, 'cwd-recents.json'), 'utf8')); } catch {}
  if (shape === 'array') {
    const list = Object.entries(recentsObject).map(([cwd, v]) => ({ cwd, at: Number(v?.at) || 0 }))
      .filter((e) => path.isAbsolute(e.cwd) && Number.isInteger(e.at) && e.at >= 0)
      .sort((a, b) => b.at - a.at).slice(0, 50);
    await fsp.writeFile(path.join(dst, 'cwd-recents.json'), JSON.stringify(list, null, 1), 'utf8');
  } else {
    await fsp.writeFile(path.join(dst, 'cwd-recents.json'), JSON.stringify(recentsObject, null, 1), 'utf8');
  }

  // 合成会话：字节级复制一条真实的极小会话，换 id / parent / 文件名。
  // 目的只有一个：把 /tree 的规模推到 300+（真实 profile 这里只有 172 条）。
  const sessionsDir = path.join(dst, 'sessions');
  const files = (await fsp.readdir(sessionsDir)).filter((f) => f.endsWith('.jsonl'));
  if (syntheticExtra > 0) {
    const seed = files
      .map((f) => ({ f, size: fs.statSync(path.join(sessionsDir, f)).size }))
      .sort((a, b) => a.size - b.size)[0].f;
    const seedText = await fsp.readFile(path.join(sessionsDir, seed), 'utf8');
    const seedLines = seedText.split('\n').filter(Boolean);
    for (let i = 0; i < syntheticExtra; i += 1) {
      const id = `01a0ffff-${String(i).padStart(4, '0')}-7000-8000-${String(i).padStart(12, '0')}`;
      const stamp = new Date(Date.parse('2026-09-18T00:00:00.000Z') + i * 1000).toISOString();
      const header = JSON.parse(seedLines[0]);
      header.id = id; header.timestamp = stamp; header.cwd = dst;
      const out = [JSON.stringify(header), ...seedLines.slice(1)];
      await fsp.writeFile(path.join(sessionsDir, `${stamp.replace(/[:.]/g, '-')}_${id}.jsonl`), `${out.join('\n')}\n`, 'utf8');
    }
  }

  // 选测试用会话：
  //   bigId      = 消息条数最多的（brief 点名的那种「1521 条」形状）；只在大文件里找，省得读全量。
  //   biggestId  = 文件字节最大的（可能是 60 MiB 那种「少条数、巨 payload」形状）。
  //   smallId    = 最小且 ≥15 条 message 的。
  const realFiles = (await fsp.readdir(sessionsDir)).filter((f) => f.endsWith('.jsonl') && !f.includes('01a0ffff-'));
  const sized = [];
  for (const f of realFiles) sized.push({ f, size: fs.statSync(path.join(sessionsDir, f)).size });
  sized.sort((a, b) => a.size - b.size);
  const biggest = sized[sized.length - 1];
  let big = null;
  for (const entry of sized.filter((e) => e.size > 5 * 1024 * 1024)) {
    const text = await fsp.readFile(path.join(sessionsDir, entry.f), 'utf8');
    const count = text.split('\n').filter((l) => l.includes('"type":"message"')).length;
    if (!big || count > big.messages) big = { ...entry, messages: count };
  }
  let small = null;
  for (const entry of sized) {
    const text = await fsp.readFile(path.join(sessionsDir, entry.f), 'utf8');
    const count = text.split('\n').filter((l) => l.includes('"type":"message"')).length;
    if (count >= 15) { small = { ...entry, messages: count }; break; }
  }
  const fixtures = {
    syntheticExtra, shape,
    sessionFileCount: (await fsp.readdir(sessionsDir)).filter((f) => f.endsWith('.jsonl')).length,
    realSessionFileCount: realFiles.length,
    bigId: big ? uuidFromName(big.f) : null, bigBytes: big?.size ?? null, bigFile: big?.f ?? null, bigMessages: big?.messages ?? null,
    biggestId: uuidFromName(biggest.f), biggestBytes: biggest.size, biggestFile: biggest.f,
    smallId: small ? uuidFromName(small.f) : null, smallBytes: small?.size ?? null, smallMessages: small?.messages ?? null,
    preparedAt: new Date().toISOString(),
  };
  await fsp.writeFile(marker, JSON.stringify(fixtures, null, 2), 'utf8');
  return fixtures;
}

async function ensureWorktree(dir, ref) {
  if (fs.existsSync(path.join(dir, 'server', 'base.mjs'))) return 'exists';
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  // 上一次跑留下的注册（目录已被删）会让 add 直接失败 —— 先 prune 掉死登记。
  await execFileAsync('git', ['-C', repoRoot, 'worktree', 'prune']).catch(() => {});
  await execFileAsync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', dir, ref]);
  return 'created';
}

const state = { fixtures: null, repos: {}, homeDirs: {}, shas: {} };

async function prepare() {
  await fsp.mkdir(OUT, { recursive: true });
  const v21Tree = path.join(WORK, 'v21-tree');
  log('[prepare] worktree v2.1 =', v21Tree, '(v2.1-final, --detach)');
  log('  worktree:', await ensureWorktree(v21Tree, 'v2.1-final'));
  state.repos.v21 = v21Tree;
  state.repos.v22 = repoRoot;

  const modules = path.join(MAIN_REPO, 'node_modules');
  if (!fs.existsSync(modules)) throw new Error(`共享 node_modules 不存在：${modules}（设 SOPHO_MAIN_REPO）`);
  log('  node_modules junction (v2.1):', await ensureJunction(path.join(v21Tree, 'node_modules'), modules));
  log('  node_modules junction (v2.2):', await ensureJunction(path.join(repoRoot, 'node_modules'), modules));

  state.shas.v21 = await gitSha(v21Tree);
  state.shas.v22 = await gitSha(repoRoot);
  log('[prepare] sha v2.1 =', state.shas.v21, '/ v2.2 =', state.shas.v22);

  for (const key of ['v21', 'v22']) {
    const home = path.join(WORK, `home-${key}`);
    log(`[prepare] home ${key} =`, home, '（复制真实 profile 的 sessions，只读来源）');
    state.homeDirs[key] = home;
    state.fixtures = await prepareHome({
      src: REAL_HOME, dst: home, repo: state.repos[key],
      shape: VERSIONS[key].cwdRecentsShape, syntheticExtra: SYNTHETIC_EXTRA,
    });
  }
  log('[prepare] fixtures =', JSON.stringify(state.fixtures));
  await fsp.writeFile(path.join(OUT, 'fixtures.json'), JSON.stringify(state.fixtures, null, 2), 'utf8');
}

// ───────────────────────────── 起 / 停 ─────────────────────────────
function spawnNode(repo, entry, env, logFile) {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  child.on('error', (error) => log(`[spawn error] ${entry}: ${error.message}`));
  return child;
}

async function startVersion(key, round, { withB }) {
  const cfg = VERSIONS[key];
  const repo = state.repos[key];
  const home = state.homeDirs[key];
  const aPort = await reservePort();
  const bPort = withB ? await reservePort() : null;
  const logA = path.join(OUT, `a-${key}-r${round}.log`);
  const logB = path.join(OUT, `b-${key}-r${round}.log`);

  const startedAt = nowMs();
  const a = spawnNode(repo, path.join('server', 'base.mjs'), cfg.envA(home, aPort), logA);
  const hostProbe = await waitHttp(aPort, '/host', 120000);
  const hostReadyMs = round2(nowMs() - startedAt);
  // /tree 的第一次：
  // ⚠️ v2.2 的 /tree 是让 worker 算的，而宿主等 worker 的**硬超时是 5s**
  //    （server/base.mjs 的 workerJson → AbortSignal.timeout(5000)）。
  //    一旦 worker 算不过来，客户端看到的就是 500。所以：**单次尝试 + 5s 退避**（不是 150ms
  //    轮询 —— 那样会在 worker 背后堆一长串废弃请求，把一个慢请求变成永久堆积），
  //    最多 6 次，**不抛**；拿不到就如实记 treeUnavailable。
  const treeAttempts = [];
  let treeProbe = null;
  const treeDeadline = nowMs() + 300000;
  while (nowMs() < treeDeadline && treeAttempts.length < 6) {
    let res;
    try {
      res = await httpGet(`http://127.0.0.1:${aPort}/tree`, { agent: false, timeoutMs: 60000, parseJson: true });
    } catch (error) { res = { status: 0, ms: null, bytes: 0, error: error.message }; }
    treeAttempts.push({ status: res.status, ms: res.ms, bytes: res.bytes, error: res.error });
    if (res.status === 200) { treeProbe = res; break; }
    if (nowMs() >= treeDeadline) break;
    await sleep(5000);
  }
  const treeReadyMs = treeProbe ? round2(nowMs() - startedAt) : null;

  let b = null; let bReadyMs = null;
  if (withB) {
    const bStarted = nowMs();
    b = spawnNode(repo, path.join('server', 'app.mjs'), cfg.envB(home, aPort, bPort, repo), logB);
    await waitHttp(bPort, '/app-host', 60000).catch(() => waitHttp(bPort, '/', 60000));
    bReadyMs = round2(nowMs() - bStarted);
  }
  return { a, b, aPort, bPort, logA, logB, startedAt, hostProbe, treeProbe, treeAttempts, treeUnavailable: !treeProbe, hostReadyMs, treeReadyMs, bReadyMs, cfg, repo, home };
}

// v2.2 的 worker 端口会打在 A 的日志里（worker_ready 那行）。直连 worker 量一次 /tree，
// 把「worker 自己的 /tree 成本」与「宿主的 5s 超时」分开 —— 这是解释区分的直接证据。
async function workerDirectTree(session) {
  try {
    const text = await fsp.readFile(session.logA, 'utf8');
    const match = /"event":"worker_ready"[^\n]*?"port":(\d+)/.exec(text);
    if (!match) return { skipped: 'no worker_ready line (v2.1 has no worker)' };
    const port = Number(match[1]);
    const res = await httpGet(`http://127.0.0.1:${port}/tree`, { agent: false, timeoutMs: 180000 });
    return { workerPort: port, status: res.status, ms: res.ms, bytes: res.bytes };
  } catch (error) { return { error: error.message }; }
}

async function stopVersion(session) {
  const out = { aPid: session.a?.pid ?? null, bPid: session.b?.pid ?? null, a: null, b: null, leftovers: [] };
  if (session.b?.pid) out.b = await killTree(session.b.pid, 'server/app.mjs');
  if (session.a?.pid) out.a = await killTree(session.a.pid, 'server/base.mjs');
  // 清干净：确认没留下孤儿 worker / 子进程（v2.2 会 fork generation worker）。
  await sleep(200);
  const rows = await psTable();
  if (session.a?.pid) out.leftovers = rows.filter((r) => r.ppid === session.a.pid).map((r) => ({ pid: r.pid, name: r.name }));
  return out;
}

// ───────────────────────────── HTTP 套件 ─────────────────────────────
function agentOf(keepAlive) { return new http.Agent({ keepAlive, maxSockets: 32 }); }

function countTreeNodes(json) {
  const seen = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') {
      if (typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value.id)) seen.add(value.id);
      for (const key of Object.keys(value)) walk(value[key]);
    }
  };
  walk(json);
  return seen.size;
}

// /tree 里每个节点的 {id, cwd}（两版的字段名都是 id/cwd；按 id 去重，取第一次出现的）。
function collectTreeNodes(json) {
  const byId = new Map();
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') {
      if (typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value.id) && !byId.has(value.id)) {
        byId.set(value.id, { id: value.id, cwd: typeof value.cwd === 'string' ? value.cwd : null });
      }
      for (const key of Object.keys(value)) walk(value[key]);
    }
  };
  walk(json);
  return [...byId.values()];
}

// 会话文件大小表（用来把「开哪几个会话」固定成两版**同一批、同一顺序**，且小会话优先）。
async function sessionSizeMap(home) {
  const dir = path.join(home, 'sessions');
  const out = new Map();
  for (const file of await fsp.readdir(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const id = uuidFromName(file);
    if (!id) continue;
    out.set(id, (await fsp.stat(path.join(dir, file))).size);
  }
  return out;
}

async function runHttpSuite(key, round) {
  const cfg = VERSIONS[key];
  const result = { version: key, round, load: { before: await loadSnapshot() }, errors: [] };
  const session = await startVersion(key, round, { withB: false });
  const { aPort } = session;
  const alive = agentOf(true);
  try {
    result.coldStart = {
      spawnToHostMs: session.hostReadyMs,
      spawnToTreeMs: session.treeReadyMs,
      firstTreeRequestMs: session.treeProbe?.ms ?? null,
      firstTreeBytes: session.treeProbe?.bytes ?? null,
      treeAttempts: session.treeAttempts,
      treeUnavailable: session.treeUnavailable,
    };
    result.tree = { cold: session.treeProbe ? { ms: session.treeProbe.ms, bytes: session.treeProbe.bytes } : null, hot: [], degraded: session.treeUnavailable };
    const treeJson = session.treeProbe?.json ?? null;
    result.tree.nodes = treeJson ? countTreeNodes(treeJson) : null;
    result.tree.nodesIncludesSynthetic = (state.fixtures.syntheticExtra ?? 0) > 0;
    const treeNodesAll = treeJson ? collectTreeNodes(treeJson) : [];

    const base = `http://127.0.0.1:${aPort}`;
    const psAfterStart = await psTable();
    result.rss = { cold: rssOfTree(psAfterStart, session.a.pid), probes: {} };

    // GET /tree 热 ×3
    for (let i = 0; i < 3; i += 1) {
      let res;
      try { res = await httpGet(`${base}/tree`, { agent: alive, timeoutMs: 60000 }); }
      catch (error) { res = { status: 0, ms: null, bytes: null, error: error.message }; }
      result.tree.hot.push({ ms: res.ms, bytes: res.bytes, status: res.status, error: res.error });
    }
    result.workerDirectTree = key === 'v22' ? await workerDirectTree(session) : { skipped: 'v2.1 has no worker' };

    const bigId = state.fixtures.bigId;
    const smallId = state.fixtures.smallId;
    if (!bigId) throw new Error('fixtures.bigId 缺失');

    // GET /sessions/{id}（详情）冷/热
    result.detail = { cold: null, hot: [] };
    {
      const first = await httpGet(`${base}/sessions/${smallId}`, { agent: alive, parseJson: true });
      result.detail.cold = { ms: first.ms, bytes: first.bytes, status: first.status, hot: first.json?.hot ?? null };
      for (let i = 0; i < 3; i += 1) {
        const res = await httpGet(`${base}/sessions/${smallId}`, { agent: alive });
        result.detail.hot.push({ ms: res.ms, bytes: res.bytes, status: res.status });
      }
    }

    // 内存：开 N 个热会话后的 A 进程 RSS（v2.2 含 worker 子进程，按真实进程树算）。
    // 顺序上**放在大会话 /messages 之前**：否则 v2.2 为 15MiB/60MiB 那两个会话建的 runtime
    // 会把 worker 抬到 GB 级，N=1/8/16 的基线就被污染了。
    // 口径固定：候选 = 树里有 id、**cwd 在当前机器上存在**、且不是大会话的会话，
    // 按会话文件大小**升序**（小会话优先）⇒ 两版开的是同一批、同一顺序。
    const sizes = await sessionSizeMap(session.home);
    const excluded = new Set([bigId, smallId, state.fixtures.biggestId].filter(Boolean));
    const candidates = treeNodesAll
      .filter((node) => !excluded.has(node.id) && node.cwd && fs.existsSync(node.cwd))
      .sort((a, b) => (sizes.get(a.id) ?? 0) - (sizes.get(b.id) ?? 0))
      .map((node) => node.id);
    result.openCandidates = { count: candidates.length, firstIds: candidates.slice(0, 20) };
    result.rss.beforeMemory = rssOfTree(await psTable(), session.a.pid);
    const openedIds = new Set();
    for (const count of OPEN_COUNTS) {
      const entry = { count, opened: [], failed: [] };
      for (const id of candidates) {
        if (openedIds.size >= count) break;
        if (openedIds.has(id)) continue;
        let res;
        try { res = await httpGet(`${base}/sessions/${id}/commands`, { agent: alive, parseJson: true, timeoutMs: 60000 }); }
        catch (error) { res = { status: 0, ms: null, bytes: 0, error: error.message }; }
        openedIds.add(id);
        if (res.status !== 200) {
          entry.failed.push({ id, status: res.status, body: JSON.stringify(res.json ?? res.error ?? {}).slice(0, 300) });
        } else entry.opened.push(id);
      }
      // 等池子把热会话数落到 >= count（失败也如实记）
      const hotDeadline = nowMs() + 30000;
      let hot = null; let probes = {};
      while (nowMs() < hotDeadline) {
        const host = await httpGet(`${base}/host`, { agent: alive, parseJson: true });
        probes.host = host.json;
        if (key === 'v21') {
          const live = await httpGet(`${base}/live`, { agent: alive, parseJson: true });
          probes.live = live.json;
        }
        hot = cfg.hotCount(probes);
        if (typeof hot === 'number' && hot >= count) break;
        await sleep(200);
      }
      await sleep(1500); // 落一下分配（否则量到的是解析大文件那一下的瞬时峰值）
      const rows = await psTable();
      const rss = rssOfTree(rows, session.a.pid);
      entry.hot = hot;
      entry.rss = rss;
      entry.deltaFromBeforeMemoryMiB = round2((rss.totalRss - result.rss.beforeMemory.totalRss) / 1048576);
      entry.deltaFromColdMiB = round2((rss.totalRss - result.rss.cold.totalRss) / 1048576);
      entry.hostProbe = key === 'v22' ? probes.host?.workerDetails?.map((w) => ({ pid: w.pid, hot: w.hot, rssBytes: w.rssBytes, state: w.state })) : undefined;
      result.rss.probes[`n${count}`] = entry;
    }

    // 并发：8 个会话同时打开 + 8 个 /messages 并发
    const concIds = candidates.slice(0, 8);
    const conc = { opens: [], messages: [] };
    conc.opens = await Promise.all(concIds.map(async (id) => {
      try { const res = await httpGet(`${base}/sessions/${id}/commands`, { agent: alive, timeoutMs: 60000 }); return { id, ms: res.ms, status: res.status }; }
      catch (error) { return { id, error: error.message }; }
    }));
    conc.messages = await Promise.all(concIds.map(async (id) => {
      try { const res = await httpGet(`${base}/sessions/${id}/messages`, { agent: alive, timeoutMs: 60000 }); return { id, ms: res.ms, bytes: res.bytes, status: res.status }; }
      catch (error) { return { id, error: error.message }; }
    }));
    result.concurrency = conc;
    result.rss.afterConcurrency = rssOfTree(await psTable(), session.a.pid);

    // GET /sessions/{id}/messages —— 小会话
    result.messagesSmall = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await httpGet(`${base}/sessions/${smallId}/messages`, { agent: alive, parseJson: i === 0 });
      result.messagesSmall.push({
        i, ms: res.ms, bytes: res.bytes, status: res.status,
        messageCount: Array.isArray(res.json?.messages) ? res.json.messages.length : null,
        hot: res.json?.hot ?? null,
      });
    }

    result.rss.afterMessagesSmall = rssOfTree(await psTable(), session.a.pid);

    // GET /sessions/{id}/messages —— 大会话（13 MiB / 1500+ 条那种形状）
    result.messagesBig = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await httpGet(`${base}/sessions/${bigId}/messages`, { agent: alive, parseJson: i === 0 });
      result.messagesBig.push({
        i, ms: res.ms, bytes: res.bytes, status: res.status,
        messageCount: Array.isArray(res.json?.messages) ? res.json.messages.length : null,
        hot: res.json?.hot ?? null,
      });
    }

    result.rss.afterMessagesBig = rssOfTree(await psTable(), session.a.pid);

    // GET /sessions/{id}/messages —— 字节最大的那条（可能完全另一种形状）
    const biggestId = state.fixtures.biggestId;
    if (biggestId && biggestId !== bigId) {
      result.messagesBiggest = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await httpGet(`${base}/sessions/${biggestId}/messages`, { agent: alive, parseJson: i === 0 });
        result.messagesBiggest.push({
          i, ms: res.ms, bytes: res.bytes, status: res.status,
          messageCount: Array.isArray(res.json?.messages) ? res.json.messages.length : null,
          hot: res.json?.hot ?? null,
        });
      }
    }

    result.rss.afterMessagesBiggest = rssOfTree(await psTable(), session.a.pid);
    result.load.after = await loadSnapshot();
  } catch (error) {
    result.errors.push(error.stack ?? error.message);
  } finally {
    alive.destroy();
    result.stop = await stopVersion(session);
  }
  return result;
}

// ───────────────────────────── Chromium / CDP ─────────────────────────────
class Cdp {
  constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('cdp ws error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      }
      if (msg.method === 'Runtime.exceptionThrown') log('[page-exception]', msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') log('[page-console]', msg.params.args.map((arg) => arg.value || arg.description).join(' '));
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`)); }, 120000).unref?.();
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const OBSERVER = (rowSelector, nodeSelector) => `(() => {
  const p = window.__perf = { t0: performance.now(), rowsLog: [], msgsLog: [], firstRowAt: null, rows: 0, msgsReadyAt: null, msgs: 0, msgsFirstAt: null, scroll: null };
  const rows = () => document.querySelectorAll(${JSON.stringify(rowSelector)}).length;
  const nodes = () => document.querySelectorAll(${JSON.stringify(nodeSelector)}).length;
  let lastRows = -1, lastMsgs = -1;
  const tick = () => {
    const n = rows();
    if (n !== lastRows) { lastRows = n; p.rowsLog.push([n, Math.round(performance.now())]); if (n > 0 && p.firstRowAt === null) p.firstRowAt = Math.round(performance.now()); }
    p.rows = Math.max(p.rows, n);
    const c = nodes();
    if (c !== lastMsgs) { lastMsgs = c; p.msgsLog.push([c, Math.round(performance.now())]); if (c > 0 && p.msgsFirstAt === null) p.msgsFirstAt = Math.round(performance.now()); }
    p.msgs = Math.max(p.msgs, c);
    const m = document.querySelector('#messages');
    if (m && p.msgsReadyAt === null && nodes() > 0 && m.scrollHeight > m.clientHeight + 200) p.msgsReadyAt = Math.round(performance.now());
  };
  setInterval(tick, 20);
  window.__scrollFps = async (durationMs) => {
    const m = document.querySelector('#messages');
    const deltas = []; let last = performance.now(); m.scrollTop = 0;
    return await new Promise((resolve) => {
      const start = performance.now();
      const step = () => {
        const t = performance.now(); deltas.push(Math.round((t - last) * 100) / 100); last = t;
        m.scrollTop = Math.min(m.scrollHeight, m.scrollTop + 160);
        if (t - start < durationMs) requestAnimationFrame(step);
        else resolve({ deltas, frames: deltas.length, durationMs: Math.round(t - start), finalScrollTop: m.scrollTop, scrollHeight: m.scrollHeight, clientHeight: m.clientHeight });
      };
      requestAnimationFrame(step);
    });
  };
})()`;

async function launchChromium(userDataDir) {
  const debugPort = await reservePort();
  const child = spawn(CHROME_BIN, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { env: browserSandboxEnv(userDataDir), stdio: 'ignore', windowsHide: true });
  let version = null;
  for (let i = 0; i < 200; i += 1) {
    try {
      const res = await httpGet(`http://127.0.0.1:${debugPort}/json/version`, { agent: false, timeoutMs: 3000, parseJson: true });
      if (res.status === 200) { version = res.json; break; }
    } catch {}
    await sleep(100);
  }
  if (!version) throw new Error('chromium devtools endpoint never came up');
  return { child, debugPort, version };
}

async function runFrontendSuite(key, round) {
  const cfg = VERSIONS[key];
  const result = { version: key, round, load: { before: await loadSnapshot() }, errors: [] };
  const session = await startVersion(key, round, { withB: true });
  let chrome = null; let cdp = null; let pageSession = null;
  try {
    // ⚠️ 目录名要短：私有 TMPDIR 建在它下面，chromium 的 ProcessSingleton socket 路径不能超 sun_path
    //    （见 test/harness.mjs 的 `browserSandboxEnv`：超预算时它会当场报错）。
    const userDataDir = path.join(WORK, `c-${key}-r${round}-${Date.now().toString(36)}`);
    chrome = await launchChromium(userDataDir);
    cdp = new Cdp(chrome.version.webSocketDebuggerUrl);
    await cdp.open();
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    pageSession = attached.sessionId;
    const s = (method, params) => cdp.send(method, params, pageSession);
    await s('Page.enable'); await s('Runtime.enable');
    await s('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER(cfg.rowSelector, cfg.messageNodeSelector) });

    const url = `http://127.0.0.1:${session.bPort}/`;
    await s('Page.navigate', { url });
    // 等树渲染完（rows 数量不再变且 >0）
    const deadline = nowMs() + 60000;
    let perf = null;
    while (nowMs() < deadline) {
      const evaluated = await s('Runtime.evaluate', { expression: 'JSON.stringify(window.__perf ?? null)', returnByValue: true });
      perf = evaluated.result?.value ? JSON.parse(evaluated.result.value) : null;
      if (perf && perf.rows > 0 && perf.rowsLog.length > 0 && (nowMs() - session.startedAt) > 4000) {
        const last = perf.rowsLog[perf.rowsLog.length - 1];
        if (last[0] === perf.rows) break;
      }
      await sleep(200);
    }
    const nav = await s('Runtime.evaluate', { expression: 'JSON.stringify(performance.getEntriesByType("navigation")[0] ?? null)', returnByValue: true });
    // 从**浏览器里**再问一次 /api/tree：v2.2 的树走 worker，A→worker 有 5s 超时（server/base.mjs 的 workerJson）
    // ——超了就是 500，前端就一行都画不出来。probe 把这件事留成原始证据。
    const probe = await s('Runtime.evaluate', {
      expression: `(async () => { const t0 = performance.now(); let r; try { r = await fetch('/api/tree'); } catch (e) { return JSON.stringify({ error: String(e) }); } const ms = Math.round(performance.now() - t0); let bytes = 0; try { bytes = (await r.text()).length; } catch {} return JSON.stringify({ status: r.status, ms, bytes, treeInnerHtmlLength: document.querySelector('#tree')?.innerHTML.length ?? -1, treeConnection: document.querySelector('#tree-connection')?.textContent ?? null }); })()`,
      awaitPromise: true, returnByValue: true,
    });
    const probeValue = probe.result?.value ? JSON.parse(probe.result.value) : null;
    result.firstScreen = {
      navigation: nav.result?.value ? JSON.parse(nav.result.value) : null,
      rows: perf?.rows ?? null,
      firstRowAtMs: perf?.firstRowAt ?? null,
      rowsLog: perf?.rowsLog ?? [],
      bReadyMs: session.bReadyMs,
      expectedTreeNodes: session.treeProbe ? countTreeNodes(session.treeProbe.json) : null,
      apiTreeProbe: probeValue,
      valid: (perf?.rows ?? 0) > 0,
    };

    // 树渲染耗时：从导航到最后一个树行出现
    const log = perf?.rowsLog ?? [];
    const peak = log.length ? log[log.length - 1] : null;
    result.treeRender = { rows: perf?.rows ?? null, firstRowAtMs: perf?.firstRowAt ?? null, allRowsAtMs: peak?.[1] ?? null, log };

    // 切到大会话 → 到正文可滚动 + JS heap
    const before = await psTable();
    result.rss = { cold: rssOfTree(before, session.a.pid) };
    const switchStarted = nowMs();
    const switched = await s('Runtime.evaluate', { expression: cfg.switchExpr(state.fixtures.bigId), returnByValue: true });
    result.switchTriggered = switched.result?.value ?? null;
    let readyAt = null; let msgs = null;
    const switchDeadline = nowMs() + 120000;
    while (nowMs() < switchDeadline) {
      const evaluated = await s('Runtime.evaluate', { expression: 'JSON.stringify({ready: window.__perf?.msgsReadyAt ?? null, msgs: window.__perf?.msgs ?? 0, msgsLog: (window.__perf?.msgsLog ?? []).slice(-40)})', returnByValue: true });
      const value = JSON.parse(evaluated.result.value);
      readyAt = value.ready; msgs = value.msgs;
      if (readyAt) break;
      await sleep(50);
    }
    const heap = await s('Runtime.getHeapUsage');
    const afterSwitch = await psTable();
    result.switchToBig = {
      wallMs: round2(nowMs() - switchStarted),
      readyAtMs: readyAt, messagesRendered: msgs,
      messageNodeSelector: cfg.messageNodeSelector,
      heapUsedBytes: heap.usedSize, heapTotalBytes: heap.totalSize,
      rss: rssOfTree(afterSwitch, session.a.pid),
      expectedBackground: state.fixtures.bigBytes,
      valid: readyAt !== null && (msgs ?? 0) > 0,
    };

    // 滚动帧率（rAF 采样）
    const fps = await s('Runtime.evaluate', { expression: 'window.__scrollFps(2500)', awaitPromise: true, returnByValue: true });
    const deltas = fps.result?.value?.deltas ?? [];
    const sorted = [...deltas].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
    result.scrollFps = {
      frames: deltas.length,
      durationMs: fps.result?.value?.durationMs ?? null,
      p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted[sorted.length - 1],
      scrollHeight: fps.result?.value?.scrollHeight, clientHeight: fps.result?.value?.clientHeight,
      deltas,
      // 没东西可滚（树都没出来）时那个帧时间没有意义，不拿它上表。
      valid: deltas.length > 10 && (fps.result?.value?.scrollHeight ?? 0) > (fps.result?.value?.clientHeight ?? 0) + 200,
    };
    result.load.after = await loadSnapshot();
  } catch (error) {
    result.errors.push(error.stack ?? error.message);
  } finally {
    cdp?.close();
    if (chrome?.child?.pid) await killTree(chrome.child.pid, 'chrome.exe');
    result.stop = await stopVersion(session);
  }
  return result;
}

// 真实规模（把 150 条合成会话暂时挪出去）下再量一次 /tree —— 两版交替，各一轮。
// 目的：把「324 条（含合成）」与「174 条（全真实）」分开，免得合成文件把结论搅浑。
async function realOnlyTreePhase() {
  const moved = [];
  const out = [];
  try {
    for (const key of ['v21', 'v22']) {
      const dir = path.join(state.homeDirs[key], 'sessions');
      const stash = path.join(state.homeDirs[key], 'sessions-synthetic-stash');
      await fsp.mkdir(stash, { recursive: true });
      for (const file of await fsp.readdir(dir)) {
        if (file.includes('01a0ffff-')) {
          const from = path.join(dir, file); const to = path.join(stash, file);
          await fsp.rename(from, to);
          moved.push([from, to]);
        }
      }
    }
    log(`[real-only] 已挪出 ${moved.length} 条合成会话；量 /tree`);
    const results = {};
    for (const key of ['v21', 'v22', 'v21', 'v22']) {
      const session = await startVersion(key, `realonly-${results[key] ? 'b' : 'a'}`, { withB: false });
      const entry = {
        version: key,
        nodes: countTreeNodes(session.treeProbe.json),
        cold: { ms: session.treeProbe.ms, bytes: session.treeProbe.bytes },
        spawnToTreeMs: session.treeReadyMs,
        hot: [],
      };
      const alive = agentOf(true);
      try {
        const base = `http://127.0.0.1:${session.aPort}`;
        entry.rssAfterCold = rssOfTree(await psTable(), session.a.pid);
        for (let i = 0; i < 4; i += 1) {
          const res = await httpGet(`${base}/tree`, { agent: alive });
          entry.hot.push({ ms: res.ms, bytes: res.bytes, status: res.status });
        }
        entry.rssAfterHot = rssOfTree(await psTable(), session.a.pid);
      } finally { alive.destroy(); }
      entry.stop = await stopVersion(session);
      out.push(entry);
      log(`[real-only] ${key}: nodes=${entry.nodes} cold=${entry.cold.ms}ms hot=${JSON.stringify(entry.hot.map((h) => h.ms))} status=${JSON.stringify(entry.hot.map((h) => h.status))} rss=${Math.round(entry.rssAfterHot.totalRss / 1048576)}MiB`);
    }
    return out;
  } finally {
    for (const [from, to] of moved) await fsp.rename(to, from).catch((error) => log(`[real-only][warn] 恢复失败 ${from}: ${error.message}`));
  }
}

// ───────────────────────────── 汇总 ─────────────────────────────
function summarize(rounds, realOnly = []) {
  const pick = (version, fn) => rounds.filter((r) => r.version === version && r.suite === 'http').map(fn).filter((x) => x !== null && x !== undefined);
  const metrics = [];
  const add = (name, unit, v21, v22, note = '') => metrics.push({ name, unit, v21: stats(v21), v22: stats(v22), note });

  add('冷启动 → /host 可响应', 'ms', pick('v21', (r) => r.coldStart?.spawnToHostMs), pick('v22', (r) => r.coldStart?.spawnToHostMs));
  add('冷启动 → /tree 首次可读', 'ms', pick('v21', (r) => r.coldStart?.spawnToTreeMs), pick('v22', (r) => r.coldStart?.spawnToTreeMs));
  add('GET /tree 冷（首次）', 'ms', pick('v21', (r) => r.tree?.cold?.ms), pick('v22', (r) => r.tree?.cold?.ms));
  add('GET /tree 冷（首次）字节', 'B', pick('v21', (r) => r.tree?.cold?.bytes), pick('v22', (r) => r.tree?.cold?.bytes));
  add('GET /tree 热', 'ms', pick('v21', (r) => r.tree?.hot?.[0]?.ms), pick('v22', (r) => r.tree?.hot?.[0]?.ms));
  add('GET /tree 热 字节', 'B', pick('v21', (r) => r.tree?.hot?.[0]?.bytes), pick('v22', (r) => r.tree?.hot?.[0]?.bytes));
  add('GET /tree 热 非 200 次数（每次 3 请求）', '次', pick('v21', (r) => (r.tree?.hot ?? []).filter((x) => x.status !== 200).length), pick('v22', (r) => (r.tree?.hot ?? []).filter((x) => x.status !== 200).length));
  add('GET /sessions/{id} 冷', 'ms', pick('v21', (r) => r.detail?.cold?.ms), pick('v22', (r) => r.detail?.cold?.ms));
  add('GET /sessions/{id} 热', 'ms', pick('v21', (r) => r.detail?.hot?.[0]?.ms), pick('v22', (r) => r.detail?.hot?.[0]?.ms));
  add('GET /messages 小会话', 'ms', pick('v21', (r) => r.messagesSmall?.[0]?.ms), pick('v22', (r) => r.messagesSmall?.[0]?.ms));
  add('GET /messages 小会话 字节', 'B', pick('v21', (r) => r.messagesSmall?.[0]?.bytes), pick('v22', (r) => r.messagesSmall?.[0]?.bytes));
  add('GET /messages 大会话 冷（首次）', 'ms', pick('v21', (r) => r.messagesBig?.[0]?.ms), pick('v22', (r) => r.messagesBig?.[0]?.ms));
  add('GET /messages 大会话 热（第 3 次）', 'ms', pick('v21', (r) => r.messagesBig?.[2]?.ms), pick('v22', (r) => r.messagesBig?.[2]?.ms));
  add('GET /messages 大会话 字节', 'B', pick('v21', (r) => r.messagesBig?.[0]?.bytes), pick('v22', (r) => r.messagesBig?.[0]?.bytes));
  add('GET /messages 最大文件 冷（首次）', 'ms', pick('v21', (r) => r.messagesBiggest?.[0]?.ms), pick('v22', (r) => r.messagesBiggest?.[0]?.ms));
  add('GET /messages 最大文件 热（第 3 次）', 'ms', pick('v21', (r) => r.messagesBiggest?.[2]?.ms), pick('v22', (r) => r.messagesBiggest?.[2]?.ms));
  add('GET /messages 最大文件 字节', 'B', pick('v21', (r) => r.messagesBiggest?.[0]?.bytes), pick('v22', (r) => r.messagesBiggest?.[0]?.bytes));
  for (const count of OPEN_COUNTS) {
    add(`A 进程树 RSS（开 ${count} 个热会话）`, 'MiB',
      pick('v21', (r) => (r.rss?.probes?.[`n${count}`]?.rss?.totalRss ?? null) / 1048576),
      pick('v22', (r) => (r.rss?.probes?.[`n${count}`]?.rss?.totalRss ?? null) / 1048576));
    add(`A 进程树 RSS 增量（开 ${count} 个热会话）`, 'MiB',
      pick('v21', (r) => r.rss?.probes?.[`n${count}`]?.deltaFromBeforeMemoryMiB),
      pick('v22', (r) => r.rss?.probes?.[`n${count}`]?.deltaFromBeforeMemoryMiB));
  }
  add('并发：8 个 /commands 打开 p95', 'ms',
    pick('v21', (r) => stats((r.concurrency?.opens ?? []).map((x) => x.ms))?.p95),
    pick('v22', (r) => stats((r.concurrency?.opens ?? []).map((x) => x.ms))?.p95));
  add('并发：8 个 /messages p95', 'ms',
    pick('v21', (r) => stats((r.concurrency?.messages ?? []).map((x) => x.ms))?.p95),
    pick('v22', (r) => stats((r.concurrency?.messages ?? []).map((x) => x.ms))?.p95));

  const tpick = (version, fn) => realOnly.filter((r) => r.version === version).map(fn).filter((x) => x !== null && x !== undefined);
  add('GET /tree 真实规模(174) 冷（首次）', 'ms', tpick('v21', (r) => r.cold?.ms), tpick('v22', (r) => r.cold?.ms));
  add('GET /tree 真实规模(174) 热', 'ms', tpick('v21', (r) => r.hot?.[0]?.ms), tpick('v22', (r) => r.hot?.[0]?.ms));
  add('GET /tree 真实规模(174) 热 非 200 次数（每次 4 请求）', '次', tpick('v21', (r) => (r.hot ?? []).filter((x) => x.status !== 200).length), tpick('v22', (r) => (r.hot ?? []).filter((x) => x.status !== 200).length));
  add('A 进程树 RSS（/tree 后）', 'MiB', tpick('v21', (r) => (r.rssAfterHot?.totalRss ?? null) / 1048576), tpick('v22', (r) => (r.rssAfterHot?.totalRss ?? null) / 1048576));

  const fpick = (version, fn) => rounds.filter((r) => r.version === version && r.suite === 'frontend').map(fn).filter((x) => x !== null && x !== undefined);
  add('[前端] 树没出现的轮数', '轮', fpick('v21', (r) => (r.firstScreen?.valid ? 0 : 1)), fpick('v22', (r) => (r.firstScreen?.valid ? 0 : 1)));
  add('[前端] 首屏 → 树第一行可见', 'ms', fpick('v21', (r) => (r.firstScreen?.valid ? r.firstScreen?.firstRowAtMs : null)), fpick('v22', (r) => (r.firstScreen?.valid ? r.firstScreen?.firstRowAtMs : null)));
  add('[前端] 首屏 → 树渲染完', 'ms', fpick('v21', (r) => (r.firstScreen?.valid ? r.treeRender?.allRowsAtMs : null)), fpick('v22', (r) => (r.firstScreen?.valid ? r.treeRender?.allRowsAtMs : null)));
  add('[前端] 切到大会话 → 正文可滚动', 'ms', fpick('v21', (r) => (r.switchToBig?.valid ? r.switchToBig.readyAtMs : null)), fpick('v22', (r) => (r.switchToBig?.valid ? r.switchToBig.readyAtMs : null)));
  add('[前端] 大会话渲染的 JS heap', 'MiB', fpick('v21', (r) => (r.switchToBig?.valid ? r.switchToBig.heapUsedBytes / 1048576 : null)), fpick('v22', (r) => (r.switchToBig?.valid ? r.switchToBig.heapUsedBytes / 1048576 : null)));
  add('[前端] 切到大会话渲染的正文节点数', '个', fpick('v21', (r) => (r.switchToBig?.valid ? r.switchToBig.messagesRendered : null)), fpick('v22', (r) => (r.switchToBig?.valid ? r.switchToBig.messagesRendered : null)));
  add('[前端] 滚动帧时间 p50', 'ms', fpick('v21', (r) => (r.scrollFps?.valid ? r.scrollFps.p50Ms : null)), fpick('v22', (r) => (r.scrollFps?.valid ? r.scrollFps.p50Ms : null)));
  add('[前端] 滚动帧时间 p95', 'ms', fpick('v21', (r) => (r.scrollFps?.valid ? r.scrollFps.p95Ms : null)), fpick('v22', (r) => (r.scrollFps?.valid ? r.scrollFps.p95Ms : null)));
  return metrics;
}

function fmtStat(stat, unit) {
  if (!stat) return '—';
  const scale = unit === 'MiB' ? 1 : 1;
  return `${round2(stat.median * scale)} (${round2(stat.min)}–${round2(stat.max)})`;
}

function renderMarkdown(meta, protocols, metrics, realOnly = []) {
  const lines = [];
  lines.push('# v2.1 vs v2.2 性能对照（harness 自动汇总）', '');
  lines.push(`> 生成于 ${meta.generatedAt}；轮数 ${meta.rounds}；工作目录 \`${meta.work}\``, '');
  lines.push('| 指标 | 单位 | v2.1 median (min–max) | v2.2 median (min–max) | v2.2/v2.1 median |', '|---|---|---|---|---|');
  for (const metric of metrics) {
    const a = metric.v21?.median; const b = metric.v22?.median;
    const ratio = typeof a === 'number' && typeof b === 'number' && a !== 0 ? `${round2(b / a)}×` : '—';
    lines.push(`| ${metric.name} | ${metric.unit} | ${fmtStat(metric.v21, metric.unit)} | ${fmtStat(metric.v22, metric.unit)} | ${ratio} |`);
  }
  lines.push('', '## 真实规模 /tree（合成会话已挪出）', '```json');
  lines.push(JSON.stringify(realOnly, null, 1));
  lines.push('```', '');
  lines.push('', '## 协议（每轮原始观测）', '');
  for (const protocol of protocols) {
    lines.push(`### ${protocol.version} · round ${protocol.round} · ${protocol.suite}`, '```json');
    lines.push(JSON.stringify(protocol, null, 1));
    lines.push('```', '');
  }
  return lines.join('\n');
}

// ───────────────────────────── 主流程 ─────────────────────────────
async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  if (!fs.existsSync(path.join(WORK, 'v21-tree', 'server', 'base.mjs'))) await prepare();
  else {
    state.repos.v21 = path.join(WORK, 'v21-tree');
    state.repos.v22 = repoRoot;
    state.homeDirs.v21 = path.join(WORK, 'home-v21');
    state.homeDirs.v22 = path.join(WORK, 'home-v22');
    state.fixtures = JSON.parse(await fsp.readFile(path.join(OUT, 'fixtures.json'), 'utf8'));
    state.shas.v21 = await gitSha(state.repos.v21);
    state.shas.v22 = await gitSha(state.repos.v22);
    log('[reuse] fixtures =', JSON.stringify(state.fixtures));
  }
  if (args.mode === 'prepare') { log('[done] prepare only'); return; }
  if (!fs.existsSync(CHROME_BIN)) throw new Error(`CHROME_BIN 不存在：${CHROME_BIN}`);

  const meta = {
    generatedAt: new Date().toISOString(),
    rounds: ROUNDS, suite: SUITE, work: WORK, out: OUT,
    shas: state.shas,
    repos: state.repos,
    fixtures: state.fixtures,
    chrome: { bin: CHROME_BIN },
    machine: os.cpus().length ? `${os.cpus().length} cpus / ${Math.round(os.totalmem() / 1073741824)} GiB` : 'unknown',
    node: process.version,
    portConvention: { v21: 'A=SOPHO_BASE_PORT B=SOPHO_PORT', v22: 'A=SOPHO_PORT B=SOPHO_APP_PORT' },
    suites: [],
  };

  const all = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    // A/B/A/B：奇数轮 v21 先，偶数轮 v22 先。
    const order = (round % 2 === 1 ? ['v21', 'v22'] : ['v22', 'v21']).filter((key) => !ONLY || ONLY.includes(key));
    for (const key of order) {
      if (SUITE === 'http' || SUITE === 'all') {
        log(`[round ${round}] http  ${VERSIONS[key].label} …`);
        let result;
        try {
          result = { ...(await runHttpSuite(key, round)), suite: 'http' };
        } catch (error) {
          result = { version: key, round, suite: 'http', fatal: error.stack ?? String(error), errors: [String(error)] };
        }
        all.push(result);
        log(`   coldStart=${JSON.stringify(result.coldStart)} treeNodes=${result.tree?.nodes} errors=${result.errors?.length ?? 0}${result.fatal ? ' FATAL' : ''}`);
      }
      if (SUITE === 'frontend' || SUITE === 'all') {
        log(`[round ${round}] frontend ${VERSIONS[key].label} …`);
        let result;
        try {
          result = { ...(await runFrontendSuite(key, round)), suite: 'frontend' };
        } catch (error) {
          result = { version: key, round, suite: 'frontend', fatal: error.stack ?? String(error), errors: [String(error)] };
        }
        all.push(result);
        log(`   firstRow=${result.firstScreen?.firstRowAtMs}ms rows=${result.firstScreen?.rows} switch=${result.switchToBig?.readyAtMs}ms p95=${result.scrollFps?.p95Ms} errors=${result.errors?.length ?? 0}${result.fatal ? ' FATAL' : ''}`);
      }
      await sleep(1000); // 让机器从上一轮落下来
    }
    await fsp.writeFile(path.join(OUT, 'raw.json'), JSON.stringify({ meta, protocols: all }, null, 2), 'utf8');
  }

  let realOnly = [];
  if (SUITE === 'http' || SUITE === 'all') {
    try { realOnly = await realOnlyTreePhase(); } catch (error) { log(`[real-only][error] ${error.stack ?? error}`); }
  }

  const metrics = summarize(all, realOnly);
  meta.suites = all.map((r) => ({ version: r.version, round: r.round, suite: r.suite, errors: r.errors }));
  const markdown = renderMarkdown(meta, all, metrics, realOnly);
  await fsp.writeFile(path.join(OUT, 'perf.json'), JSON.stringify({ meta, metrics, realOnly, protocols: all }, null, 2), 'utf8');
  await fsp.writeFile(path.join(OUT, 'perf.md'), markdown, 'utf8');
  process.stdout.write(`\n${markdown.split('## 协议')[0]}\n`);
  log(`[done] JSON = ${path.join(OUT, 'perf.json')}`);
  log(`[done] 汇总 = ${path.join(OUT, 'perf.md')}`);
  // 如实报停不干净的情况（孤儿 worker）。
  let dirty = false;
  for (const r of all) {
    if (r.stop?.a && r.stop.a.stopped === false) { log(`[warn] ${r.version} r${r.round} A 没停干净：${JSON.stringify(r.stop.a)}`); dirty = true; }
    if (r.stop?.leftovers?.length) { log(`[warn] ${r.version} r${r.round} 残留子进程：${JSON.stringify(r.stop.leftovers)}`); dirty = true; }
  }
  if (dirty) log('[warn] 有没停干净的进程 —— 照上面 PID 人工核对后按 pid 停（别用 pkill）。');
  process.exit(0); // 防子进程句柄把 harness 自己挂住（跑完就该退出）
}

main().catch((error) => { console.error(error.stack ?? error); process.exit(1); });
