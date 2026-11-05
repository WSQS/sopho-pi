#!/usr/bin/env node
// test/switch-perf-v21-v22.mjs —— 「会话切换」性能口径：v2.1(tag `v2.1-final`) vs v2.2(HEAD)。
//
// 为什么另开一条：test/perf-compare.mjs 量的是**服务端读取路径**（/tree、/sessions/{id}、
// /messages 的 HTTP 耗时与内存），且它只在 Windows 上跑（SKIP on Linux）。本 harness 量的是
// **一次「点树行 → 目标会话首屏」的用户动作**在真数据、真浏览器上的成本：
//
//   ① 点击 → 目标会话正文区第一块可辨认内容出现（页内 rAF + 逐帧 screencast 两条口径）；
//   ② 点击 → 静置（连续 quietMs 没有 DOM 变动，且渐进补齐已收工）；
//   ③ 主线程成本：CDP Performance.getMetrics 的 ScriptDuration/LayoutDuration/RecalcStyleCount
//      + PerformanceObserver('longtask') 的总时长与最长一条；
//   ④ DOM 代价：正文容器的新建节点数 / 顶层插入次数 / 移除数 / 插入批次；
//   ⑤ 网络：/messages 与其它请求的次数与字节（CDP Network 域，含 SSE）；
//   ⑥ 附带成本：切换窗口里的 /tree 请求次数与字节 + 树区 DOM 变动次数。
//
// 公平性（本 harness 的全部要点）：
//   · 同一份真实数据：从真 profile **只读复制同一批**会话文件到两份 home（v2.1/v2.2 各一份），
//     两份 home 的 sessions 逐字节相同；绝不就地动真 profile。
//   · 两个版本各自跑在自己的 worktree 里（v2.1 = `git worktree add --detach <work>/v21-tree v2.1-final`，
//     绝不在主树 checkout），node_modules 用 symlink 共享。
//   · 两版都走临时 ASSIST_HOME + 高位随机端口（7331/7321/7411/7412 一律禁用并拒停），
//     同一个 Chromium（CHROME_BIN），同一视口（1200x760 / 420x820）。
//   · 串行 + 交替（奇数轮 v2.1→v2.2，偶数轮反过来），每档 ≥N 个样本，报中位数与全距。
//
// 用法：
//   node test/switch-perf-v21-v22.mjs prepare
//   node test/switch-perf-v21-v22.mjs run --rounds 5
//   node test/switch-perf-v21-v22.mjs report
//   node test/switch-perf-v21-v22.mjs all --rounds 5          # prepare + run + report
//   node test/switch-perf-v21-v22.mjs gate                    # 机械门：只断言 v2.2 的切换成本上界
//
// 只读规矩：真实数据只读到 copies；日志只写 <work>/logs；停进程只按自己 spawn 的 pid 且核 cmdline。

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { browserSandboxEnv, cleanupStep, finishCleanup, processCommandLine, processTable, removeSandbox, stopOwnedListener, systemMemoryMiB } from './harness.mjs';
import { bandDiff, decodePng, isUniform } from './screencast-bands.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_BIN = process.env.CHROME_BIN || '/usr/bin/chromium';
const REAL_HOME = process.env.SOPHO_REAL_HOME || path.join(os.homedir(), '.pi', 'profiles', 'assistant');
const FORBIDDEN_PORTS = new Set([7331, 7321, 7322, 7411, 7412]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

// ───────────────────────────── CLI ─────────────────────────────
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
const WORK = path.resolve(String(args.work ?? path.join(os.tmpdir(), 'sopho-switch-perf')));
const OUT = path.resolve(String(args.out ?? path.join(WORK, 'out')));
const ROUNDS = Number(args.rounds ?? 5);
const ONLY = args.only ? String(args.only).split(',') : null;
const VIEWPORTS = String(args.viewports ?? '1200x760,420x820').split(',').map((text) => {
  const [width, height] = text.split('x').map(Number);
  return { width, height, label: text };
});
const QUIET_MS = Number(args['quiet-ms'] ?? 700);
const MAX_SAMPLE_MS = Number(args['max-sample-ms'] ?? 20000);
const SCREENCAST = args['no-screencast'] ? false : true;
const IS_GATE = MODE === 'gate';
// `--targets big|mid`：调试用，只量一个靶子。
const TARGET_FILTER = args.targets ? String(args.targets) : null;
const GATE_ROUNDS = Number(args.rounds ?? 3);

if (args.help) {
  process.stdout.write('usage: node test/switch-perf-v21-v22.mjs [prepare|run|report|all|gate] [--rounds 5] [--only v21,v22]\n' +
    '  --work <dir>  工作目录（v2.1 worktree / 两份 home / 日志 / 输出）\n' +
    '  --viewports 1200x760,420x820\n  --no-screencast  跳过逐帧 screencast 口径\n');
  process.exit(0);
}

// ───────────────────────────── 版本配置 ─────────────────────────────
// 两版的端口变量名不同（同一个名字 `SOPHO_PORT` 在两版里指**不同角色**）：
//   v2.1：A = SOPHO_BASE_PORT，B = SOPHO_PORT（B 另需 SOPHO_BASE_URL）
//   v2.2：A = SOPHO_PORT，      B = SOPHO_APP_PORT（B 另需 SOPHO_UPSTREAM_HOST/PORT）
const VERSIONS = {
  v21: {
    key: 'v21',
    label: 'v2.1',
    ref: 'v2.1-final',
    repo: () => path.join(WORK, 'v21-tree'),
    aEnv: (home, aPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_HOST: '127.0.0.1', SOPHO_BASE_PORT: String(aPort), SOPHO_CWD: home,
    }),
    bEnv: (home, aPort, bPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(bPort), SOPHO_BASE_URL: `http://127.0.0.1:${aPort}`,
    }),
    // v2.1 的正文容器是 `#hist`（`#messages` 是它的滚动外框）；树行是 `.sess`（onclick → open(id)）。
    rowSelector: (id) => `#tree .sess[title*="${id}"]`,
    paneSelector: '#messages',
    nodeContainerSelector: '#hist',
    messageNodeSelector: '#hist > *',
    // 「可辨认的正文」：v2.1 的 userEl/partsEl 都是 `div.msg`，扩展消息块是 `div.ext`。
    // ⚠️ 不能用 `#hist > *` 判首屏 —— 里面还有 `.who`（「助手 ›」角色标签）、`.more`（显示更早）
    // 和 `.empty`（「这个会话还没有可显示的文本。」）—— v2.1 在正文回来**之前**就会画一次空态，
    // 用 `> *` 会把那一帧当成「首屏内容」（实测就是如此）。
    contentNodeSelector: '#hist > .msg, #hist > .extras, #hist > details.cut',
    cwdRecentsShape: 'object',
    hasRenderComplete: false,
  },
  v22: {
    key: 'v22',
    label: 'v2.2',
    ref: 'HEAD',
    repo: () => root,
    aEnv: (home, aPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_HOST: '127.0.0.1', SOPHO_PORT: String(aPort),
    }),
    bEnv: (home, aPort, bPort) => ({
      ASSIST_HOME: home, SOPHO_AGENT_DIR: home, PI_CODING_AGENT_DIR: home,
      SOPHO_APP_HOST: '127.0.0.1', SOPHO_APP_PORT: String(bPort),
      SOPHO_UPSTREAM_HOST: '127.0.0.1', SOPHO_UPSTREAM_PORT: String(aPort),
    }),
    rowSelector: (id) => `[data-session-id="${id}"]`,
    paneSelector: '#messages',
    nodeContainerSelector: '#messages',
    messageNodeSelector: '#messages > article.message',
    contentNodeSelector: '#messages > article.message, #messages > .extra-message, #messages > .compaction-note',
    cwdRecentsShape: 'array',
    hasRenderComplete: true,
  },
};

// ───────────────────────────── 小工具 ─────────────────────────────
function log(...parts) { process.stdout.write(`${parts.join(' ')}\n`); }

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

function stats(samples) {
  const xs = samples.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  return { n: xs.length, min: xs[0], median, max: xs[xs.length - 1] };
}
const round2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
function fmtStat(stat, digits = 1) {
  if (!stat) return '—';
  const f = (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(digits));
  return `${f(stat.median)} (${f(stat.min)}–${f(stat.max)})`;
}

function httpGet(url, { agent, timeoutMs = 180000, parseJson = false } = {}) {
  return new Promise((resolve, reject) => {
    const started = nowMs();
    const request = http.request(url, { method: 'GET', agent, headers: { accept: 'application/json' } }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; if (parseJson) chunks.push(chunk); });
      response.on('end', () => {
        const result = { status: response.statusCode, ms: round2(nowMs() - started), bytes };
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

// ───────────────────────────── prepare ─────────────────────────────
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

const SIDECAR_FILES = ['archive.json', 'titles.json', 'seen.json', 'settled.json', 'models.json',
  'models-store.json', 'settings.json', 'paths.json', 'auth.json',
  'drafts.json', 'placement.json', 'extras.json'];

function uuidFromName(file) {
  const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file);
  return match ? match[1] : null;
}

/** 挑被测会话：同一批文件、同一顺序，两版各复制一份（绝不动真 profile）。
 *  形状按 brief 要求「挑重的」：长正文 + 代码块多（jsonl 里的 toolCall/工具结果）+ 消息条数多。 */
async function countMessages(file) {
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.includes('"type":"message"')).length;
}

/** 会话头（第一行）——用来取 `parentSession`（判断「祖先里有没有归档」要用它）。
 *  ⚠️ pi 的 header 里 `parentSession` 是**文件路径**（`/…/sessions/<stamp>_<uuid>.jsonl`），
 *  不是 uuid；直接当 uuid 查会全部查不到 ⇒ 一律当根节点 ⇒ 「父归档的子会话」判成可见（踩过）。 */
async function readSessionHeader(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text.slice(0, text.indexOf('\n')) || text);
  } catch { return null; }
}

/** header 里的 parentSession → uuid（接受路径或裸 uuid）。 */
function parentIdOf(value, byId) {
  if (!value || typeof value !== 'string') return null;
  if (byId.has(value)) return value;
  const fromPath = uuidFromName(path.basename(value));
  return fromPath && byId.has(fromPath) ? fromPath : null;
}

/** 归档判定：`archive.json` 的键 ∪ 文件里出现过 `"archived": true`（v2.2 的 `sopho.archive` 条目）。
 *  ⚠️ 这里**不能用 `includes('"archived":true')`** —— pi 落盘是 `"archived": true`（**带空格**），
 *  字面量匹配会漏（踩过一次：一条自己已归档的会话被判成可见，v2.2 整轮报「row never appeared」）。 */
const ARCHIVED_RE = /"archived"\s*:\s*true/;

/**
 * 前端**真的会显示**的会话池。
 *
 * 为什么不能只看「这条自己有没有归档」：前端把归档会话**连同它的后代**一起折进「存档」箱
 * （v2.2 的 `hiddenByArchive`、v2.1 的折叠子项）。一条「自己没归档、但父节点归档」的会话
 * **在树上点不到** —— 上一轮量测就挑到过这种，v2.2 侧整轮报「tree row never appeared」，
 * 白烧十几分钟。所以判据要沿 parentSession 往上走：**自己和任一祖先都没归档**才算可见。
 *
 * 判据取两版的**并集**（比两版各自都严）：`archive.json` 的键（v2.1 的账）∪ 文件里出现过
 * `"archived":true`（v2.2 认的 `sopho.archive` 条目）。
 */
async function visiblePool(sourceDir) {
  const archiveRaw = await fsp.readFile(path.join(REAL_HOME, 'archive.json'), 'utf8').catch(() => '{}');
  let archiveIds = new Set();
  try {
    const parsed = JSON.parse(archiveRaw);
    archiveIds = new Set(Array.isArray(parsed) ? parsed : Object.keys(parsed));
  } catch {}
  const entries = [];
  for (const name of await fsp.readdir(sourceDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const id = uuidFromName(name);
    if (!id) continue;
    entries.push({ name, bytes: (await fsp.stat(path.join(sourceDir, name))).size, id });
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const archivedCache = new Map();
  const isArchived = async (id) => {
    if (archivedCache.has(id)) return archivedCache.get(id);
    let value = archiveIds.has(id);
    if (!value) {
      const text = await fsp.readFile(path.join(sourceDir, byId.get(id).name), 'utf8').catch(() => '');
      value = ARCHIVED_RE.test(text);
    }
    archivedCache.set(id, value);
    return value;
  };
  const parentCache = new Map();
  const parentOf = async (id) => {
    if (parentCache.has(id)) return parentCache.get(id);
    const header = byId.has(id) ? await readSessionHeader(path.join(sourceDir, byId.get(id).name)) : null;
    const parent = parentIdOf(header?.parentSession ?? null, byId);
    parentCache.set(id, parent);
    return parent;
  };
  const visible = async (id) => {
    const seen = new Set();
    let cursor = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (await isArchived(cursor)) return false;
      cursor = await parentOf(cursor);
    }
    return true;
  };
  const pool = [];
  for (const entry of entries) if (await visible(entry.id)) pool.push(entry);
  return { entries, pool };
}

/** 挑被测会话：同一批文件、同一顺序，两版各复制一份（绝不动真 profile）。
 *  形状按 brief 要求「挑重的」：长正文 + 代码块/工具调用多（jsonl 里的 tool part + 结果）+ 消息条数多。
 *  返回具名靶子，别靠下标推：
 *    · treeWeight —— 可见池里最大的那条，只作为**树里的重量**（`/tree` 要扫它），不当渲染靶子；
 *    · big / mid   —— 两个被量测的靶子（第二、第三重）；
 *    · small       —— **小但非空**（≥5 条 message）的一条，当「切走」的中立靶子。 */
async function selectFixtureFiles(sourceDir) {
  const { entries, pool } = await visiblePool(sourceDir);
  const descending = [...pool].sort((a, b) => b.bytes - a.bytes);
  // 排除**本 harness 自己的会话**（`PI_SESSION_FILE`）：它每一轮都在被追加写，
  // 当靶子会把「正文在变」混进量测里。树重量仍可包含它（只影响 /tree 的体积）。
  const ownId = process.env.PI_SESSION_FILE ? uuidFromName(path.basename(process.env.PI_SESSION_FILE)) : null;
  const treeWeight = descending[0];
  // 靶子池再排掉「树重量」那条：最大那条只当 `/tree` 的重量，**不当渲染靶子** ——
  // 它在 v2.2 的渐进补齐下会把单个样本拖到几十秒，量测窗口就没意义了（如实写在报告里）。
  const measuredPool = descending.filter((entry) => entry.id !== ownId && entry.id !== treeWeight.id);
  const targetPool = measuredPool.length >= 2 ? measuredPool : descending.filter((entry) => entry.id !== treeWeight.id);
  const measured = [...targetPool].sort((a, b) => b.bytes - a.bytes);
  const ascending = [...targetPool].sort((a, b) => a.bytes - b.bytes);
  if (measured.length < 3) throw new Error(`可见（自己与祖先都未归档）的会话只有 ${measured.length} 条，挑不出三个靶子`);
  // ⚠️ 真 profile 是**活的**：上一次 prepare 挑到的那条小会话，这一次可能已经长大（实测撞过：
  // 0.23 MiB → 1.2 MiB）或被归档。所以逐级放宽上限，取「第一档里最小的那条」。
  let small = null;
  for (const cap of [512 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024]) {
    for (const entry of ascending) {
      if (entry.bytes > cap) break;
      if (await countMessages(path.join(sourceDir, entry.name)) >= 5) { small = entry; break; }
    }
    if (small) break;
  }
  if (!small) throw new Error('没有找到「非空、可见」的会话当靶子（512 KiB / 2 MiB / 4 MiB 三档都空）');
  const picked = [treeWeight, measured[0], measured[1], measured[2], small].filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const entry of picked) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  const names = {
    treeWeight: treeWeight.name,
    big: measured[0].name,
    mid: measured[1].name,
    small: small.name,
  };
  return { files: unique, names, visibleCount: pool.length, totalCount: entries.length, ownSession: ownId };
}

async function prepareHome({ key, shape, repo, files }) {
  const home = path.join(WORK, `home-${key}`);
  const marker = path.join(home, '.prepared.json');
  const existing = await fsp.readFile(marker, 'utf8').then(JSON.parse).catch(() => null);
  if (existing && existing.shape === shape && existing.repoSha === (await gitSha(repo))) return existing;
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.mkdir(path.join(home, 'sessions'), { recursive: true });
  const copied = [];
  for (const file of files) {
    // 真复制（不 hardlink）：一次意外写就污染真 profile。
    await fsp.copyFile(path.join(REAL_HOME, 'sessions', file.name), path.join(home, 'sessions', file.name));
    copied.push({ file: file.name, bytes: file.bytes });
  }
  for (const name of SIDECAR_FILES) {
    try { await fsp.copyFile(path.join(REAL_HOME, name), path.join(home, name)); } catch {}
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
  const fixture = { shape, home, repo, repoSha: await gitSha(repo), files: copied };
  await fsp.writeFile(marker, JSON.stringify(fixture, null, 2), 'utf8');
  return fixture;
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
  const selection = await selectFixtureFiles(path.join(REAL_HOME, 'sessions'));
  log(`[prepare] 可见会话池（自己与祖先都未归档，前端真会显示）：${selection.visibleCount} / ${selection.totalCount} 条`);
  const files = selection.files;
  const ids = {
    treeWeightId: uuidFromName(selection.names.treeWeight),
    bigId: uuidFromName(selection.names.big),
    midId: uuidFromName(selection.names.mid),
    smallId: uuidFromName(selection.names.small),
  };
  log('[prepare] 被测会话（两版同一批）:');
  for (const file of files) log(`  ${uuidFromName(file.name)} ${(file.bytes / 1048576).toFixed(2)}MiB${uuidFromName(file.name) === ids.bigId ? '  ← BIG 靶子' : uuidFromName(file.name) === ids.midId ? '  ← MID 靶子' : uuidFromName(file.name) === ids.smallId ? '  ← 中立（切走）' : ''}`);
  const results = {
    preparedAt: new Date().toISOString(), chrome: CHROME_BIN, node: process.version, realHome: REAL_HOME,
    v21Sha, v22Sha: await gitSha(root),
    files: files.map((entry) => ({ file: entry.name, bytes: entry.bytes })), ids,
    visibleSessions: selection.visibleCount, totalSessions: selection.totalCount,
    // 口径：最大的那条真会话（15.9 MiB / 2288 条）只作为**树里的重量**（/tree 要扫它），
    // 不当渲染靶子 —— 它在 v2.2 的渐进补齐下会把单个样本拖到几十秒，量测窗口没意义。
    caliberNote: 'treeWeight 只进树；被量测的是 big(第二重) 与 mid(第三重)',
  };
  for (const key of ['v21', 'v22']) {
    if (ONLY && !ONLY.includes(key)) continue;
    const cfg = VERSIONS[key];
    results[key] = await prepareHome({ key, shape: cfg.cwdRecentsShape, repo: cfg.repo(), files });
  }
  // v2.2 就跑在本仓 worktree 里；node_modules 是 symlink（不提交）。
  await ensureSymlink(path.join(root, 'node_modules'), modules).catch(() => {});
  results.views = VIEWPORTS;
  await fsp.writeFile(path.join(OUT, 'fixtures.json'), JSON.stringify(results, null, 2), 'utf8');
  log('[prepare] fixtures →', path.join(OUT, 'fixtures.json'));
  return results;
}

// ───────────────────────────── 起 / 停 ─────────────────────────────
function spawnNode(repo, entry, env, logFile) {
  // 门会把自己上一轮的沙箱清掉（只留 out/），日志目录可能已经不在了 —— 自己保证它在。
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: repo,
    env: { ...process.env, ...env, NODE_ENV: 'production' },
    stdio: ['ignore', fd, fd],
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
  const startedAt = nowMs();
  const aLog = path.join(WORK, 'logs', `${key}-${Date.now()}-a.log`);
  const bLog = path.join(WORK, 'logs', `${key}-${Date.now()}-b.log`);
  const a = spawnNode(repo, 'server/base.mjs', cfg.aEnv(home, aPort), aLog);
  let aReady = null;
  try { aReady = await waitHttp(aPort, '/host', 60000); } catch (error) { aReady = { error: error.message }; }
  const b = spawnNode(repo, 'server/app.mjs', cfg.bEnv(home, aPort, bPort), bLog);
  let bReady = null;
  try { bReady = await waitHttp(bPort, '/api/host', 60000); } catch (error) { bReady = { error: error.message }; }
  return {
    key, cfg, repo, home, aPort, bPort, a, b, aLog, bLog,
    aReady, bReady, spawnToAReadyMs: round2(nowMs() - startedAt),
    startedAt,
  };
}

async function stopVersion(session, problems) {
  const stopped = {};
  await cleanupStep(problems, `stop ${session.key} B`, async () => {
    await stopOwnedListener(session.bPort, 'server/app.mjs', session.b?.pid);
    stopped.b = 'stopped';
  });
  await cleanupStep(problems, `stop ${session.key} A`, async () => {
    await stopOwnedListener(session.aPort, 'server/base.mjs', session.a?.pid);
    stopped.a = 'stopped';
  });
  for (const child of [session.b, session.a]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  return stopped;
}

async function killChromium(child, problems, label) {
  if (!child || !child.pid) return;
  await cleanupStep(problems, label, async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await sleep(50);
    }
    child.kill('SIGKILL');
    await sleep(200);
  });
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
      if (message.method) {
        for (const handler of this.listeners.get(message.method) ?? []) handler(message.params, message.sessionId);
      }
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

async function launchChromium(userDataDir, viewport) {
  const debugPort = await reservePort();
  const child = spawn(CHROME_BIN, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--no-pings',
    `--window-size=${viewport.width},${viewport.height}`,
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
  if (!version) {
    child.kill('SIGKILL');
    throw new Error('chromium devtools endpoint never came up');
  }
  return { child, debugPort, version };
}

const OBSERVER_SOURCE = (cfg) => String.raw`
(() => {
  window.__sw = { sample: null, lts: [], errors: [] };
  window.addEventListener('error', (event) => window.__sw.errors.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => window.__sw.errors.push('rejection: ' + String(event.reason)));
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__sw.lts.push({ start: entry.startTime, dur: entry.duration, name: entry.name });
    });
    observer.observe({ type: 'longtask', buffered: true });
    window.__sw.ltObserver = observer;
  } catch (error) { window.__sw.ltError = String(error); }

  const PANE = ${JSON.stringify(cfg.paneSelector)};
  const CONTAINER = ${JSON.stringify(cfg.nodeContainerSelector)};
  const NODES = ${JSON.stringify(cfg.messageNodeSelector)};
  const CONTENT = ${JSON.stringify(cfg.contentNodeSelector)};
  const TREE = '#tree';

  const inPane = (el, paneRect) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    return rect.bottom > paneRect.top + 2 && rect.top < paneRect.bottom - 2;
  };

  window.__swArm = (options) => {
    const opts = options || {};
    const container = document.querySelector(CONTAINER);
    if (!container) return { ok: false, reason: 'no-container' };
    const pane = document.querySelector(PANE);
    const tree = document.querySelector(TREE);
    const rec = {
      t0: performance.now(), epoch0: Date.now(), clickAt: null, trigger: null,
      quietMs: opts.quietMs || 700, maxMs: opts.maxMs || 20000,
      mutations: 0, addedNodes: 0, addedTopLevel: 0, removedNodes: 0,
      topLevelAdds: [], contentAdds: 0, contentAddBatches: [], addedSubtreeElements: 0,
      treeMutations: 0, treeAddedNodes: 0,
      firstContentAt: null, firstContentText: null, firstContentNodeCount: null,
      renderCompleteAt: null, nodeTotal: null, lastMutationAt: performance.now(),
      frames: 0, maxNodeCount: 0, nodeCountAtEnd: 0, containerChildrenAtEnd: 0,
      subtreeMaxDepthNodes: 0, paneRect: null, paneScrollHeightAtEnd: 0,
      finished: false, reason: null, endAt: null, armMs: null,
    };
    window.__sw.sample = rec;
    const finish = (reason) => {
      if (rec.finished) return;
      rec.finished = true; rec.reason = reason; rec.endAt = performance.now();
      try { messageObserver.disconnect(); treeObserver.disconnect(); io?.disconnect(); } catch (error) {}
      const endPane = document.querySelector(PANE);
      if (endPane) rec.paneScrollHeightAtEnd = endPane.scrollHeight;
      const endContainer = document.querySelector(CONTAINER);
      rec.nodeCountAtEnd = document.querySelectorAll(NODES).length;
      rec.contentCountAtEnd = document.querySelectorAll(CONTENT).length;
      rec.containerChildrenAtEnd = endContainer ? endContainer.children.length : -1;
      try {
        const rects = Array.from(document.querySelectorAll(CONTENT));
        const brief = (node) => { const r = node.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), Math.round(r.width), Math.round(r.height)]; };
        const endPane = document.querySelector(PANE);
        rec.diag = {
          paneRect: rec.paneRect,
          scrollTop: endPane ? endPane.scrollTop : null,
          scrollHeight: endPane ? endPane.scrollHeight : null,
          clientHeight: endPane ? endPane.clientHeight : null,
          contentCount: rects.length,
          containerDisplay: endContainer ? getComputedStyle(endContainer).display : null,
          containerHeight: endContainer ? Math.round(endContainer.getBoundingClientRect().height) : null,
          firstRects: rects.slice(0, 3).map(brief),
          childTall: endContainer ? Array.from(endContainer.children).map((node) => [String(node.className).slice(0, 24), Math.round(node.getBoundingClientRect().height)]).sort((a, b) => b[1] - a[1]).slice(0, 6) : null,
          childrenSum: endContainer ? Math.round(Array.from(endContainer.children).reduce((acc, node) => acc + node.getBoundingClientRect().height, 0)) : null,
          lastRect: rects.length ? brief(rects[rects.length - 1]) : null,
          visibility: document.visibilityState,
          ioObserved: rec.ioObserved ?? 0,
          ioCallbacks: rec.ioCallbacks ?? 0,
          frames: rec.frames,
          lastMutationAtRel: Math.round(rec.lastMutationAt - rec.t0),
        };
      } catch (error) { rec.diag = { error: String(error) }; }
    };
    rec.initialNodes = new Set(Array.from(document.querySelectorAll(NODES)));
    rec.initialMessageTotal = container.dataset ? (container.dataset.messageTotal ?? null) : null;
    // 首屏判据用 IntersectionObserver（root = 正文滚动区）：它由浏览器在**布局之后**投递，
    // 不靠我们每帧对每个节点调 getBoundingClientRect（那会把每帧强行拉成一次全量布局，
    // 既改变被测对象的成本，也会在大会话上把页内循环拖到几秒）。
    let io = null;
    if (typeof IntersectionObserver === 'function' && pane) {
      io = new IntersectionObserver((entries) => {
        rec.ioCallbacks = (rec.ioCallbacks ?? 0) + 1;
        for (const entry of entries) {
          if (rec.firstContentAt !== null) continue;
          if (rec.initialNodes && rec.initialNodes.has(entry.target)) continue; // 上一屏的旧节点
          if (!entry.isIntersecting) continue;
          if (entry.intersectionRect.width < 2 || entry.intersectionRect.height < 2) continue;
          const text = (entry.target.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length >= 4) {
            rec.firstContentAt = performance.now();
            rec.firstContentText = text.slice(0, 80);
            rec.firstContentNodeCount = document.querySelectorAll(NODES).length;
          }
        }
      }, { root: pane, rootMargin: '0px', threshold: 0 });
      rec.ioObserved = 0;
    }
    const observeContent = (node) => {
      if (!io) return;
      io.observe(node);
      rec.ioObserved = (rec.ioObserved ?? 0) + 1;
    };
    const messageObserver = new MutationObserver((records) => {
      const at = performance.now();
      rec.lastMutationAt = at;
      let topLevel = 0;
      let content = 0;
      for (const record of records) {
        rec.mutations += 1;
        rec.addedNodes += record.addedNodes.length;
        rec.removedNodes += record.removedNodes.length;
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || node.parentElement !== container) continue;
          topLevel += 1;
          rec.addedSubtreeElements += (node.querySelectorAll ? node.querySelectorAll('*').length + 1 : 1);
          if (node.matches(CONTENT)) { content += 1; observeContent(node); }
        }
      }
      if (topLevel > 0) rec.topLevelAdds.push([at, topLevel]);
      rec.addedTopLevel += topLevel;
      if (content > 0) { rec.contentAdds += content; rec.contentAddBatches.push([at, content]); }
    });
    messageObserver.observe(container, { childList: true, subtree: true });
    let treeObserver = { disconnect() {} };
    if (tree) {
      treeObserver = new MutationObserver((records) => {
        for (const record of records) { rec.treeMutations += 1; rec.treeAddedNodes += record.addedNodes.length; }
      });
      treeObserver.observe(tree, { childList: true, subtree: true });
    }
    const tick = () => {
      const at = performance.now();
      rec.frames += 1;
      const paneNow = document.querySelector(PANE);
      if (paneNow) {
        const rect = paneNow.getBoundingClientRect();
        rec.paneRect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      }
      const containerNow = document.querySelector(CONTAINER);
      const nodeCount = containerNow ? containerNow.children.length : 0;
      if (nodeCount > rec.maxNodeCount) rec.maxNodeCount = nodeCount;
      if (paneNow) rec.paneScrollTop = paneNow.scrollTop;
      if (containerNow && containerNow.dataset) {
        // ⚠️ 只在**这一次切换真的动过 DOM 之后**才认 renderComplete —— arm 那一刻容器里
        // 还挂着上一个会话留下的 'true'，直接读会把「补齐完成」记成 0ms（踩过）。
        if (rec.renderCompleteAt === null && rec.mutations > 0 && containerNow.dataset.renderComplete === 'true') rec.renderCompleteAt = at;
        if (containerNow.dataset.messageTotal !== undefined) rec.nodeTotal = Number(containerNow.dataset.messageTotal);
      }
      const fillDone = rec.renderCompleteAt !== null || containerNow?.dataset?.renderComplete === undefined;
      const quiet = at - rec.lastMutationAt >= rec.quietMs;
      // 静置 + 补齐完成 ⇒ 收工；但**首屏还没出现时给 3s 宽限**，免得把「还在取数」判成空。
      if (quiet && fillDone && (rec.firstContentAt !== null || at - rec.t0 >= 3000)) { finish('quiet'); return; }
      if (at - rec.t0 >= rec.maxMs) { finish('timeout'); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return { ok: true, t0: rec.t0, epoch0: rec.epoch0 };
  };

  window.__swClick = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, reason: 'row-missing' };
    const rec = window.__sw.sample;
    el.click();
    if (rec) { rec.clickAt = performance.now(); rec.trigger = selector; }
    return { ok: true, clickAt: rec ? rec.clickAt : null, rect: el.getBoundingClientRect().toJSON ? el.getBoundingClientRect().toJSON() : null };
  };

  window.__swRead = () => JSON.stringify({
    sample: window.__sw.sample,
    lts: window.__sw.lts,
    errors: window.__sw.errors,
    rowCount: document.querySelectorAll('#tree .sess, [data-session-id]').length,
  });

  window.__swPaneRect = () => {
    const pane = document.querySelector(PANE);
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  };

  window.__swHasRow = (selector) => document.querySelector(selector) !== null;
})();
`;

// ───────────────────────────── 一次量测 ─────────────────────────────
function classifyUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(pathname) || /^\/sessions\/[^/]+\/messages$/.test(pathname)) return 'messages';
    if (pathname === '/api/tree' || pathname === '/tree') return 'tree';
    if (/\/(events|stream)$/.test(pathname)) return 'sse';
    if (/^\/api\/sessions\/[^/]+$/.test(pathname) || /^\/sessions\/[^/]+$/.test(pathname)) return 'session-detail';
    if (pathname.startsWith('/api/')) return 'api-other';
    return 'static';
  } catch { return 'other'; }
}

function summarizeNetwork(events, startedAt, endedAt) {
  const inWindow = events.filter((event) => event.recvAt >= startedAt && event.recvAt <= endedAt);
  const byKind = new Map();
  for (const event of inWindow) {
    const kind = classifyUrl(event.url);
    if (!byKind.has(kind)) byKind.set(kind, { kind, requests: 0, bytes: 0, statuses: [], urls: [] });
    const bucket = byKind.get(kind);
    bucket.requests += 1;
    bucket.bytes += event.dataLength || 0;
    bucket.statuses.push(event.status ?? null);
    if (bucket.urls.length < 6) bucket.urls.push(event.url.slice(0, 120));
  }
  const out = {};
  for (const [kind, bucket] of byKind) out[kind] = bucket;
  return {
    byKind: out,
    messagesRequests: out.messages?.requests ?? 0,
    messagesBytes: out.messages?.bytes ?? 0,
    treeRequests: out.tree?.requests ?? 0,
    treeBytes: out.tree?.bytes ?? 0,
    sseRequests: out.sse?.requests ?? 0,
    totalRequests: inWindow.length,
    totalBytes: inWindow.reduce((acc, event) => acc + (event.dataLength || 0), 0),
  };
}

const PERF_KEYS = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleCount', 'LayoutCount', 'TaskDuration', 'JSHeapUsedSize', 'Nodes', 'Documents'];

function metricSnapshot(metrics) {
  const out = {};
  for (const metric of metrics.metrics ?? []) {
    if (PERF_KEYS.includes(metric.name)) out[metric.name] = metric.value;
  }
  return out;
}
function metricDelta(before, after) {
  const out = {};
  for (const key of PERF_KEYS) {
    if (before[key] === undefined || after[key] === undefined) continue;
    out[key] = round2((after[key] - before[key]) * (key.endsWith('Count') || key === 'Nodes' || key === 'Documents' ? 1 : 1000));
  }
  return out;
}

async function ensureNeutral(s, cfg, neutralId, targets) {
  // 每次都从一个**固定的中立会话**出发，保证「被量测的那一次切换」路径一致。
  const row = cfg.rowSelector(neutralId);
  const has = await s('Runtime.evaluate', { expression: `window.__swHasRow(${JSON.stringify(row)})`, returnByValue: true });
  if (has.result?.value !== true) return false;
  await s('Runtime.evaluate', { expression: `window.__swArm({ quietMs: 400, maxMs: 8000 })`, returnByValue: true });
  await s('Runtime.evaluate', { expression: `window.__swClick(${JSON.stringify(row)})`, returnByValue: true });
  // 等静置：轮询页内的 finished 位
  const deadline = nowMs() + 12000;
  while (nowMs() < deadline) {
    const read = await s('Runtime.evaluate', { expression: 'JSON.stringify(window.__sw.sample ? { f: window.__sw.sample.finished, id: location.hash } : null)', returnByValue: true });
    const value = read.result?.value ? JSON.parse(read.result.value) : null;
    if (value?.f) break;
    await sleep(60);
  }
  await sleep(180);
  return true;
}

async function measureSwitch({ cdp, pageSession, cfg, targetId, metricsBefore, netEvents }) {
  const s = (method, params, timeoutMs) => cdp.send(method, params, pageSession, timeoutMs);
  const row = cfg.rowSelector(targetId);
  const armed = await s('Runtime.evaluate', { expression: `JSON.stringify(window.__swArm({ quietMs: ${QUIET_MS}, maxMs: ${MAX_SAMPLE_MS} }))`, returnByValue: true });
  const armValue = JSON.parse(armed.result.value);
  if (!armValue.ok) throw new Error(`arm failed: ${armValue.reason}`);
  const startedAt = nowMs();
  const clicked = await s('Runtime.evaluate', { expression: `JSON.stringify(window.__swClick(${JSON.stringify(row)}))`, returnByValue: true });
  const clickValue = JSON.parse(clicked.result.value);
  if (!clickValue.ok) throw new Error(`click failed: ${clickValue.reason}`);
  // 一次往返等页内样本收工（页内 rAF 判断，不靠驱动侧轮询）。
  await s('Runtime.evaluate', {
    expression: `new Promise((resolve) => { const t = setInterval(() => { if (window.__sw.sample && window.__sw.sample.finished) { clearInterval(t); resolve(true); } }, 50); setTimeout(() => { clearInterval(t); resolve(false); }, ${MAX_SAMPLE_MS + 15000}); })`,
    awaitPromise: true, returnByValue: true,
  }, MAX_SAMPLE_MS + 40000);
  const endedAt = nowMs();
  const read = await s('Runtime.evaluate', { expression: 'window.__swRead()', returnByValue: true });
  const pageState = JSON.parse(read.result.value);
  const rec = pageState.sample ?? {};
  // 页内记的是 performance.now()（页面绝对时间）⇒ 这里一律换算成**相对点击前收工的时刻**。
  const t0 = rec.t0 ?? 0;
  const rel = (value) => (typeof value === 'number' && Number.isFinite(value) ? round2(value - t0) : null);
  const metricsAfter = metricSnapshot(await s('Performance.getMetrics'));
  const lts = (pageState.lts ?? []).filter((entry) => entry.start >= rec.t0 - 5);
  const windowLts = lts.filter((entry) => entry.start <= (rec.endAt ?? rec.t0 + MAX_SAMPLE_MS));
  const longtaskTotal = windowLts.reduce((acc, entry) => acc + entry.dur, 0);
  const longtaskMax = windowLts.reduce((acc, entry) => Math.max(acc, entry.dur), 0);
  const network = summarizeNetwork(netEvents, startedAt, endedAt);
  return {
    targetId,
    wallMs: round2(endedAt - startedAt),
    t0PageMs: round2(t0),
    firstContentMs: rel(rec.firstContentAt),
    settleMs: rel(rec.endAt),
    settleReason: rec.reason ?? null,
    renderCompleteMs: rel(rec.renderCompleteAt),
    clickAtMs: rel(rec.clickAt),
    firstContentText: rec.firstContentText ?? null,
    nodeTotal: rec.nodeTotal ?? null,
    addedNodes: rec.addedNodes ?? 0,
    addedTopLevel: rec.addedTopLevel ?? 0,
    contentAdds: rec.contentAdds ?? 0,
    addedSubtreeElements: rec.addedSubtreeElements ?? 0,
    contentAddBatches: (rec.contentAddBatches ?? []).length,
    contentAddBatchDetail: (rec.contentAddBatches ?? []).map(([at, count]) => [rel(at), count]),
    contentCountAtEnd: rec.contentCountAtEnd ?? 0,
    removedNodes: rec.removedNodes ?? 0,
    mutationCount: rec.mutations ?? 0,
    topLevelAddBatches: (rec.topLevelAdds ?? []).length,
    topLevelAdds: rec.topLevelAdds ?? [],
    frameCount: rec.frames ?? 0,
    treeMutations: rec.treeMutations ?? 0,
    treeAddedNodes: rec.treeAddedNodes ?? 0,
    maxNodeCount: rec.maxNodeCount ?? 0,
    nodeCountAtEnd: rec.nodeCountAtEnd ?? 0,
    containerChildrenAtEnd: rec.containerChildrenAtEnd ?? 0,
    paneScrollHeightAtEnd: rec.paneScrollHeightAtEnd ?? 0,
    metrics: metricDelta(metricsBefore, metricsAfter),
    longtaskCount: windowLts.length,
    longtaskTotalMs: round2(longtaskTotal),
    longtaskMaxMs: round2(longtaskMax),
    longtaskEntries: windowLts.map((entry) => ({ start: round2(entry.start), dur: round2(entry.dur) })),
    network,
    pageErrors: pageState.errors ?? [],
    paneRect: rec.paneRect ?? null,
    diag: rec.diag ?? null,
  };
}

// screencast 口径：真正被**画出来**的帧里，正文区第一块内容什么时候出现。
// ⚠️ screencast 本身会改变合成节奏（它按帧推送 + 我们逐帧 ack），所以这一项只用来**确认**
// 页内 rAF 的口径，不作为主口径（见报告 §方法）。
async function measureSwitchScreencast({ cdp, pageSession, cfg, targetId, viewport }) {
  const s = (method, params, timeoutMs) => cdp.send(method, params, pageSession, timeoutMs);
  const frames = [];
  let pendingAck = 0;
  const off = cdp.on('Page.screencastFrame', (params) => {
    frames.push({ timestamp: params.metadata?.timestamp ?? null, data: params.data, sessionId: params.sessionId });
    pendingAck += 1;
    cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, pageSession, 20000).then(() => { pendingAck -= 1; }, () => { pendingAck -= 1; });
  });
  const rect = (await s('Runtime.evaluate', { expression: 'JSON.stringify(window.__swPaneRect())', returnByValue: true })).result.value;
  const paneRect = rect ? JSON.parse(rect) : null;
  await s('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: viewport.width, maxHeight: viewport.height });
  await sleep(500);
  const referenceCount = frames.length;
  const reference = frames[referenceCount - 1];
  const row = cfg.rowSelector(targetId);
  const clickEpoch = (await s('Runtime.evaluate', { expression: `(() => { const el = document.querySelector(${JSON.stringify(row)}); if (!el) return null; el.click(); return Date.now(); })()`, returnByValue: true })).result.value;
  // 等帧：headless 只在**画面真的变了**时才推帧，所以判据是「有过帧，且已经 800ms 没有新帧」。
  const deadline = nowMs() + 14000;
  let quietSince = null;
  while (nowMs() < deadline) {
    if (frames.length <= referenceCount) { quietSince = null; await sleep(50); continue; }
    if (quietSince === null) quietSince = nowMs();
    if (nowMs() - quietSince > 800) break;
    await sleep(50);
  }
  await s('Page.stopScreencast');
  off();
  if (!paneRect || !reference || clickEpoch === null) {
    return { ok: false, reason: !paneRect ? 'no-pane' : !reference ? 'no-match-frame' : 'no-click', frames: frames.length };
  }
  const decode = (frame) => {
    try { return decodePng(Buffer.from(frame.data, 'base64')); } catch { return null; }
  };
  const refImage = decode(reference);
  if (!refImage) return { ok: false, reason: 'reference-undecodable', frames: frames.length };
  const scaleX = refImage.width / viewport.width;
  const scaleY = refImage.height / viewport.height;
  const scaled = { left: paneRect.left * scaleX, top: paneRect.top * scaleY, right: paneRect.right * scaleX, bottom: paneRect.bottom * scaleY };
  const threshold = 3;
  let firstChange = null;
  let lastChange = null;
  const series = [];
  // 切换的可见序列是：旧会话内容 → （可能一帧或多帧）空白 → 新会话内容。
  // 单靠「与参考帧不同」会把**清空**那一帧当成「内容出现」，所以另用「这一帧的正文区是不是
  // 一片同色（空白）」把两件事分开：先出现的空白帧之后，第一帧非空白 = 目标会话内容出现。
  let blankSeen = false;
  let firstBlankAt = null;
  let firstContentAfterClearMs = null;
  for (const frame of frames.slice(referenceCount)) {
    const image = decode(frame);
    if (!image) continue;
    const bands = bandDiff(image, refImage, scaled, 6);
    const mean = bands.reduce((acc, value) => acc + value, 0) / bands.length;
    const at = frame.timestamp === null ? null : frame.timestamp * 1000 - clickEpoch;
    let blank = null;
    try { blank = isUniform(image, scaled); } catch { blank = null; }
    series.push({ at: at === null ? null : round2(at), mean: round2(mean), max: round2(Math.max(...bands)), blank });
    const changed = mean > threshold || Math.max(...bands) > threshold * 4;
    if (firstChange === null && changed) firstChange = at;
    if (changed) lastChange = at;
    if (blank === true) { blankSeen = true; if (firstBlankAt === null) firstBlankAt = at; }
    if (blank === false && blankSeen && firstContentAfterClearMs === null) firstContentAfterClearMs = at;
  }
  return {
    ok: true,
    firstChangeMs: firstChange === null ? null : round2(firstChange),
    firstContentAfterClearMs: firstContentAfterClearMs === null ? null : round2(firstContentAfterClearMs),
    blankSeen,
    firstBlankAtMs: firstBlankAt === null ? null : round2(firstBlankAt),
    lastChangeMs: lastChange === null ? null : round2(lastChange),
    framesObserved: series.length,
    paneRect,
    scaledRect: scaled,
    series: series.slice(0, 80),
  };
}


// 「同一份正文被建了几遍」的直证：把 fetch 的 /messages 响应**克隆**出来算指纹。
// 只在**独立的一遍**里装（不参与计时），因为 clone+text() 会把响应体再读一次。
const PROBE_SOURCE = String.raw`
(() => {
  window.__probe = { messages: [], errors: [] };
  const hash = (text) => {
    let h = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      h ^= text.charCodeAt(index);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  };
  const original = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const response = await original.call(this, input, init);
    if (/\/messages(\?|$)/.test(url)) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        window.__probe.messages.push({ url, at: performance.now(), status: response.status, bytes: text.length, hash: hash(text) });
      } catch (error) { window.__probe.errors.push(String(error)); }
    }
    return response;
  };
})();
`;

/** 独立一遍：直接量「一次切换里 /messages 被拉了几次、两次的字节指纹是否相同、
 *  正文容器被重建了几次」。不改动计时那一遍的任何数字。 */
async function duplicateProbe({ cdp, pageSession, cfg, viewport, targetId, neutralId, bPort }) {
  const s = (method, params, timeoutMs) => cdp.send(method, params, pageSession, timeoutMs);
  // 直接在当前文档里打补丁即可（之后的所有 fetch 都走它）——不必重载页面。
  // ⚠️ 这一步**不是**计时那一遍的一部分：clone+text() 会把响应体再读一次。
  const expression = `${PROBE_SOURCE}; typeof window.__probe`;
  const installed = await s('Runtime.evaluate', { expression, returnByValue: true });
  if (process.env.SOPHO_PROBE_DEBUG) process.stdout.write(`[probe-debug] mid=${JSON.stringify(expression.slice(expression.indexOf('if (/' ), expression.indexOf('if (/') + 60))} result=${JSON.stringify(installed).slice(0, 200)}\n`);
  if (installed.result?.value !== 'object') throw new Error(`probe did not install: value=${JSON.stringify(installed.result?.value)} exception=${JSON.stringify(installed.exceptionDetails?.exception?.description ?? installed.exceptionDetails?.text)}`);
  for (const id of [neutralId, targetId]) await warmup(cdp, pageSession, cfg, id, { });
  await ensureNeutral(s, cfg, neutralId, [targetId]);
  const before = (await s('Runtime.evaluate', { expression: 'window.__probe.messages.length', returnByValue: true })).result.value;
  await s('Runtime.evaluate', { expression: `window.__swArm({ quietMs: ${QUIET_MS}, maxMs: ${MAX_SAMPLE_MS} })`, returnByValue: true });
  await s('Runtime.evaluate', { expression: `window.__swClick(${JSON.stringify(cfg.rowSelector(targetId))})`, returnByValue: true });
  const waitDeadline = nowMs() + MAX_SAMPLE_MS + 15000;
  while (nowMs() < waitDeadline) {
    const finished = await s('Runtime.evaluate', { expression: 'window.__sw.sample ? window.__sw.sample.finished : false', returnByValue: true });
    if (finished.result?.value === true) break;
    await sleep(80);
  }
  const read = await s('Runtime.evaluate', { expression: 'JSON.stringify({ probe: window.__probe, sample: window.__sw.sample })', returnByValue: true });
  const state = JSON.parse(read.result.value);
  const messages = state.probe.messages.slice(before);
  const sample = state.sample ?? {};
  const t0 = sample.t0 ?? 0;
  return {
    target: targetId,
    messagesRequests: messages.length,
    messages: messages.map((entry) => ({ at: round2(entry.at - t0), status: entry.status, bytes: entry.bytes, hash: entry.hash })),
    sameBytes: messages.length > 1 ? messages.every((entry) => entry.hash === messages[0].hash) : null,
    contentAddBatches: (sample.contentAddBatches ?? []).length,
    contentAdds: sample.contentAdds ?? 0,
    topLevelAddBatches: (sample.topLevelAdds ?? []).length,
    probeErrors: state.probe.errors ?? [],
  };
}

// 服务端读取路径的裸 HTTP 耗时（走 B 的对外端口，和浏览器同一条路；keep-alive 稳态语义）。
// 这一项不是「切换」本身，但它是切换耗时里最容易被误判成「前端慢」的那一半。
async function httpProbes(base, ids) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const out = {};
  const sample = async (route, key, times) => {
    out[key] = [];
    for (let index = 0; index < times; index += 1) {
      try {
        const response = await httpGet(`${base}${route}`, { agent });
        out[key].push({ i: index, ms: response.ms, bytes: response.bytes, status: response.status });
      } catch (error) { out[key].push({ i: index, error: error.message }); }
    }
  };
  // 内容口径：两版 /messages 返回的**条目数与 part 形状**（不是性能，是「发的东西不一样」的证据）。
  try {
    const response = await httpGet(`${base}/api/sessions/${ids.bigId}/messages`, { agent, parseJson: true, timeoutMs: 120000 });
    const parts = {};
    let messages = 0;
    let toolMessages = 0;
    let textChars = 0;
    for (const message of response.json?.messages ?? []) {
      messages += 1;
      let hasTool = false;
      for (const part of message?.parts ?? []) {
        const type = String(part?.type ?? 'unknown');
        parts[type] = (parts[type] ?? 0) + 1;
        if (type === 'tool') hasTool = true;
        if (type === 'text') textChars += String(part.text ?? '').length;
      }
      if (hasTool) toolMessages += 1;
    }
    out.caliber = { status: response.status, bytes: response.bytes, messages, toolMessages, parts, textChars, extras: (response.json?.extras ?? []).length, compaction: response.json?.compaction ?? null };
  } catch (error) { out.caliber = { error: error.message }; }
  await sample('/api/tree', 'tree', 3);
  await sample(`/api/sessions/${ids.bigId}`, 'session-detail-big', 2);
  await sample(`/api/sessions/${ids.bigId}/messages`, 'messages-big', 3);
  await sample(`/api/sessions/${ids.smallId}/messages`, 'messages-small', 2);
  agent.destroy();
  return out;
}

// 环境读数（内存 + 进程计数）：一律问 `test/harness.mjs`（`systemMemoryMiB` / `processTable`）
// —— 平台分叉只住那一个文件，本文件里不出现 procfs 字面量（纪律见 `test/harness-contract.mjs`）。
// 读不到就如实写 null / 0，不假装拿到值；这几个数只进报告，不做任何断言。
async function loadSnapshot() {
  const load = os.loadavg();
  const memory = await systemMemoryMiB();
  const memUsedMiB = memory?.usedMiB ?? null;
  let nodeCount = 0;
  let chromeCount = 0;
  try {
    for (const row of await processTable({ withCommandLine: false })) {
      if (row.name.startsWith('node')) nodeCount += 1;
      else if (row.name.startsWith('chrome') || row.name.startsWith('chromium')) chromeCount += 1;
    }
  } catch {}
  return { at: new Date().toISOString(), load1: round2(load[0]), load5: round2(load[1]), cpus: os.cpus().length, memUsedMiB, nodeProcesses: nodeCount, chromeProcesses: chromeCount };
}

// ───────────────────────────── 一轮 ─────────────────────────────
async function runVersionRound({ key, round, viewport, fixtures, problems, screencast, probe, targets }) {
  const cfg = VERSIONS[key];
  const result = { version: key, label: cfg.label, round, viewport: viewport.label, samples: [], errors: [], notes: [] };
  const session = await startVersion(key);
  result.aReadyMs = session.aReady?.waitedMs ?? null;
  result.bReadyMs = session.bReady?.waitedMs ?? null;
  result.spawnToAReadyMs = session.spawnToAReadyMs;
  if (session.aReady?.error || session.bReady?.error) {
    result.errors.push(`start failed: a=${session.aReady?.error ?? 'ok'} b=${session.bReady?.error ?? 'ok'}`);
    await stopVersion(session, problems);
    return result;
  }
  let chrome = null;
  let cdp = null;
  let pageSession = null;
  // ⚠️ 目录名要短：私有 TMPDIR 建在它下面，chromium 的 ProcessSingleton socket 路径不能超 sun_path
  //    （本机实测：旧的 `chrome-<key>-r<round>-<label>-<ts>` 长路径直接让 chrome 启动即 FATAL。
  //    `test/harness.mjs` 的 `browserSandboxEnv` 会在超预算时当场报错，不再让它变成一个 30 s 后的谜）。
  const userDataDir = path.join(WORK, `c-${key}-r${round}-${Date.now().toString(36)}`);
  try {
    chrome = await launchChromium(userDataDir, viewport);
    cdp = new Cdp(chrome.version.webSocketDebuggerUrl);
    await cdp.open();
    const netEvents = [];
    const byRequestId = new Map();
    cdp.on('Network.requestWillBeSent', (params) => {
      const record = { id: params.requestId, url: params.request.url, method: params.request.method, type: params.type, recvAt: nowMs(), status: null, dataLength: 0 };
      byRequestId.set(params.requestId, record);
      netEvents.push(record);
    });
    cdp.on('Network.responseReceived', (params) => {
      const record = byRequestId.get(params.requestId);
      if (record) record.status = params.response.status;
    });
    cdp.on('Network.dataReceived', (params) => {
      const record = byRequestId.get(params.requestId);
      if (record) record.dataLength += params.dataLength || 0;
    });
    const pageIssues = [];
    cdp.on('Runtime.exceptionThrown', (params) => pageIssues.push(`exception: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text}`));
    cdp.on('Runtime.consoleAPICalled', (params) => { if (params.type === 'error') pageIssues.push(`console.error: ${params.args.map((arg) => arg.value || arg.description).join(' ')}`); });
    result.pageIssues = pageIssues;
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    pageSession = attached.sessionId;
    const s = (method, params, timeoutMs) => cdp.send(method, params, pageSession, timeoutMs);
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Performance.enable');
    await s('Network.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SOURCE(cfg) });
    const url = `http://127.0.0.1:${session.bPort}/`;
    const navigationStarted = nowMs();
    await s('Page.navigate', { url });
    // 等树画出来（并且目标行在）
    const deadline = nowMs() + 90000;
    const neededRows = [...targets, fixtures.ids.smallId];
    let ready = false;
    while (nowMs() < deadline) {
      const neededSelectors = neededRows.map((id) => cfg.rowSelector(id));
      const probe = await s('Runtime.evaluate', { expression: `JSON.stringify({ rows: document.querySelectorAll('#tree .sess, [data-session-id]').length, hasTarget: ${JSON.stringify(neededSelectors)}.every((selector) => !!document.querySelector(selector)) })`, returnByValue: true }).catch(() => null);
      const value = probe?.result?.value ? JSON.parse(probe.result.value) : null;
      if (value?.rows > 0 && value.hasTarget) { ready = true; break; }
      await sleep(150);
    }
    const pageState = (await s('Runtime.evaluate', { expression: 'JSON.stringify({ href: location.href, treeLen: (document.querySelector("#tree") || {}).innerHTML ? document.querySelector("#tree").innerHTML.length : -1, treeText: (document.querySelector("#tree") || {}).textContent ? document.querySelector("#tree").textContent.slice(0, 200) : null, bodyText: document.body ? document.body.innerText.slice(0, 300) : null })', returnByValue: true })).result?.value ?? null;
    result.firstScreen = { ready, ms: round2(nowMs() - navigationStarted), pageState: pageState ? JSON.parse(pageState) : null, pageIssues: pageIssues.slice(0, 10) };
    result.http = await httpProbes(`http://127.0.0.1:${session.bPort}`, fixtures.ids);
    result.load = await loadSnapshot();
    if (!ready) throw new Error(`tree rows never appeared in the browser; needed=${neededRows.join(',')}; page=${pageState}; issues=${pageIssues.slice(0, 6).join(' | ')}`);
    await sleep(500);

    // 热一下两个靶子（首次打开包含 runtime 建立 + /tree 冷扫描，不算进稳态口径）
    result.warmups = [];
    for (const targetId of targets) {
      const entry = await warmup(cdp, pageSession, cfg, targetId, fixtures);
      result.warmups.push({ target: targetId, ...entry });
      result.notes.push(`warmup ${targetId}: ${JSON.stringify(entry)}`);
    }

    for (const targetId of targets) {
      // 每次量测的**起点**都固定成同一个中立会话（这一段不计时）——否则量到的可能只是
      // 「点一个已经选中的行」，那就不是切会话了。起点一致之后，各行之间才可比。
      await ensureNeutral(s, cfg, fixtures.ids.smallId, targets);
      await sleep(200);
      const metricsBefore = metricSnapshot(await s('Performance.getMetrics'));
      try {
        const sample = await measureSwitch({ cdp, pageSession, cfg, targetId, metricsBefore, netEvents });
        sample.target = targetId;
        result.samples.push(sample);
      } catch (error) {
        result.errors.push(`switch ${targetId}: ${error.message}`);
      }
    }
    if (screencast && SCREENCAST && targets.length > 0) {
      try {
        await ensureNeutral(s, cfg, fixtures.ids.smallId, targets);
        await sleep(300);
        result.screencast = await measureSwitchScreencast({ cdp, pageSession, cfg, targetId: targets[0], viewport });
      } catch (error) {
        result.errors.push(`screencast: ${error.message}`);
      }
      if (probe) {
        try {
          result.duplicateProbe = await duplicateProbe({ cdp, pageSession, cfg, viewport, targetId: targets[0], neutralId: fixtures.ids.smallId, bPort: session.bPort });
        } catch (error) {
          result.errors.push(`duplicate-probe: ${error.message}`);
        }
      }
    }
    result.networkAll = netEvents.length;
  } catch (error) {
    result.errors.push(error.stack ?? error.message);
  } finally {
    cdp?.close();
    await killChromium(chrome?.child, problems, `kill chromium ${key} r${round}`);
    await removeSandbox(userDataDir, problems, `remove chrome profile ${key} r${round}`);
    result.stop = await stopVersion(session, problems);
  }
  return result;
}

async function warmup(cdp, pageSession, cfg, targetId, fixtures) {
  const s = (method, params, timeoutMs) => cdp.send(method, params, pageSession, timeoutMs);
  const started = nowMs();
  await s('Runtime.evaluate', { expression: `window.__swArm({ quietMs: 500, maxMs: 30000 })`, returnByValue: true });
  const clicked = await s('Runtime.evaluate', { expression: `JSON.stringify(window.__swClick(${JSON.stringify(cfg.rowSelector(targetId))}))`, returnByValue: true });
  const clickValue = JSON.parse(clicked.result.value);
  // 点不到就**当场**失败：以前这里会静默空转到 30s 超时，然后后面那次量测才报「row-missing」，
  // 把真正的原因埋掉（实测撞过一次）。
  if (!clickValue.ok) throw new Error(`warmup click failed (${clickValue.reason}) for ${targetId}`);
  const deadline = nowMs() + 40000;
  let finished = false;
  while (nowMs() < deadline) {
    const read = await s('Runtime.evaluate', { expression: 'window.__sw.sample ? window.__sw.sample.finished : false', returnByValue: true });
    if (read.result?.value === true) { finished = true; break; }
    await sleep(80);
  }
  const read = await s('Runtime.evaluate', { expression: 'window.__swRead()', returnByValue: true });
  const state = JSON.parse(read.result.value);
  return { ms: round2(nowMs() - started), finished, nodes: state.sample?.nodeCountAtEnd ?? null, total: state.sample?.nodeTotal ?? null, reason: state.sample?.reason ?? null };
}

// ───────────────────────────── 主流程 ─────────────────────────────
async function run({ rounds, problems }) {
  const fixtures = JSON.parse(await fsp.readFile(path.join(OUT, 'fixtures.json'), 'utf8'));
  const ids = fixtures.ids;
  const targets = TARGET_FILTER
    ? (TARGET_FILTER.split(',').map((name) => ids[`${name}Id`]).filter(Boolean))
    : [ids.bigId, ids.midId];
  const results = { startedAt: new Date().toISOString(), fixtures: { v21Sha: fixtures.v21Sha, v22Sha: fixtures.v22Sha, files: fixtures.files, ids }, rounds: [], load: [] };
  for (let round = 1; round <= rounds; round += 1) {
    const order = ONLY ? ONLY : (round % 2 ? ['v21', 'v22'] : ['v22', 'v21']);
    for (const viewport of VIEWPORTS) {
      for (const key of order) {
        log(`[run] round ${round} · ${VERSIONS[key].label} · ${viewport.label} …`);
        const result = await runVersionRound({ key, round, viewport, fixtures, problems, screencast: true, probe: round === 1, targets });
        results.rounds.push(result);
        const summary = result.samples.map((sample) => `${sample.target.slice(0, 8)} first=${sample.firstContentMs}ms settle=${sample.settleMs}ms script=${sample.metrics?.ScriptDuration}ms layout=${sample.metrics?.LayoutDuration}ms 正文=${sample.contentAdds}/${sample.contentAddBatches}批 msgReq=${sample.network.messagesRequests} treeReq=${sample.network.treeRequests} ltMax=${sample.longtaskMaxMs}ms diag=${JSON.stringify(sample.diag)}`).join(' | ');
        log(`      ${summary}`);
        if (result.errors.length) log(`      errors: ${result.errors.join(' ;; ')}`);
        // 树上找不到靶子行 = 量测前提不成立（挑到的会话在 UI 里看不见）。第一轮就中止，
        // 别把十分钟烧在每一轮重复同一处失败上 —— 上一次就是这么白烧的。
        if (result.errors.some((error) => error.includes('tree rows never appeared'))) {
          throw new Error(`量测前提不成立（第 ${round} 轮 · ${VERSIONS[key].label} · ${viewport.label}）：${result.errors.join(' ;; ')}`);
        }
        if (result.screencast) log(`      screencast firstChange=${result.screencast.firstChangeMs}ms firstContent=${result.screencast.firstContentAfterClearMs}ms blank=${result.screencast.blankSeen} frames=${result.screencast.framesObserved}`);
        if (result.duplicateProbe) log(`      duplicateProbe ${JSON.stringify(result.duplicateProbe)}`);
        await fsp.writeFile(path.join(OUT, 'switch-perf.json'), JSON.stringify(results, null, 2), 'utf8');
      }
    }
  }
  results.finishedAt = new Date().toISOString();
  await fsp.writeFile(path.join(OUT, 'switch-perf.json'), JSON.stringify(results, null, 2), 'utf8');
  return results;
}

// ───────────────────────────── 汇总 / 报告 ─────────────────────────────
function collectSamples(results, key, viewport, target) {
  return results.rounds
    .filter((round) => round.version === key && round.viewport === viewport)
    .flatMap((round) => round.samples.filter((sample) => sample.target === target));
}
function pickNumbers(samples, getter) { return samples.map(getter).filter((value) => typeof value === 'number' && Number.isFinite(value)); }

function buildMetrics(results, viewport) {
  const ids = results.fixtures.ids;
  const targets = [ids.bigId, ids.midId];
  const rows = [];
  const add = (name, unit, getter) => {
    const row = { name, unit, perTarget: {} };
    for (const target of targets) {
      const label = target === ids.bigId ? 'BIG(第二重)' : 'MID(第三重)';
      row.perTarget[label] = {
        v21: stats(pickNumbers(collectSamples(results, 'v21', viewport, target), getter)),
        v22: stats(pickNumbers(collectSamples(results, 'v22', viewport, target), getter)),
      };
    }
    rows.push(row);
  };
  add('点击 → 正文第一块可辨认内容', 'ms', (s) => s.firstContentMs);
  add('点击 → 静置（quiet+补齐完成）', 'ms', (s) => s.settleMs);
  add('点击 → 渐进补齐完成（v2.2 专有标记）', 'ms', (s) => s.renderCompleteMs);
  add('主线程 ScriptDuration', 'ms', (s) => s.metrics?.ScriptDuration);
  add('主线程 LayoutDuration', 'ms', (s) => s.metrics?.LayoutDuration);
  add('主线程 TaskDuration', 'ms', (s) => s.metrics?.TaskDuration);
  add('RecalcStyleCount', '次', (s) => s.metrics?.RecalcStyleCount);
  add('LayoutCount', '次', (s) => s.metrics?.LayoutCount);
  add('longtask 总时长', 'ms', (s) => s.longtaskTotalMs);
  add('longtask 最长一条', 'ms', (s) => s.longtaskMaxMs);
  add('longtask 条数', '条', (s) => s.longtaskCount);
  add('新建 DOM 元素总数（含子树）', '个', (s) => s.addedSubtreeElements);
  add('正文容器顶层插入节点数', '个', (s) => s.addedTopLevel);
  add('**正文**新建节点数', '个', (s) => s.contentAdds);
  add('**正文**重建批次数', '批', (s) => s.contentAddBatches);
  add('最后一次 DOM 变动（相对点击）', 'ms', (s) => s.diag?.lastMutationAtRel);
  add('顶层插入批次数', '批', (s) => s.topLevelAddBatches);
  add('移除节点数', '个', (s) => s.removedNodes);
  add('DOM 变动回调次数', '次', (s) => s.mutationCount);
  add('/messages 请求数', '次', (s) => s.network.messagesRequests);
  add('/messages 字节', 'B', (s) => s.network.messagesBytes);
  add('/tree 请求数（切换窗口内）', '次', (s) => s.network.treeRequests);
  add('/tree 字节（切换窗口内）', 'B', (s) => s.network.treeBytes);
  add('其它 API 请求数', '次', (s) => (s.network.byKind['api-other']?.requests ?? 0) + (s.network.byKind['session-detail']?.requests ?? 0));
  add('SSE 新连接数', '次', (s) => s.network.sseRequests);
  add('切换窗口总字节', 'B', (s) => s.network.totalBytes);
  add('树区 DOM 变动次数（切换窗口内）', '次', (s) => s.treeMutations);
  add('页面异常/错误条数', '条', (s) => (s.pageErrors ?? []).length);
  add('结束时正文节点数', '个', (s) => s.nodeCountAtEnd);
  add('/messages 条数（含工具行，服务端报）', '个', (s) => s.nodeTotal);
  return rows;
}

/** 第一遍打开（warmup）——含冷 runtime / 冷树扫描，是「第一次点开」的用户可见成本。 */
function warmupEntries(results, key, viewport) {
  const out = [];
  for (const round of results.rounds) {
    if (round.version !== key || round.viewport !== viewport) continue;
    const list = round.warmups ?? (round.notes ?? []).map((note) => {
      const match = /^warmup (\S+): (\{.*\})$/.exec(note);
      if (!match) return null;
      try { return { target: match[1], ...JSON.parse(match[2]) }; } catch { return null; }
    }).filter(Boolean);
    out.push(...list);
  }
  return out;
}

/** 服务端读取路径的裸 HTTP 观测（走 B 的对外端口）。 */
function httpTable(results, viewport) {
  const keys = ['tree', 'session-detail-big', 'messages-big', 'messages-small'];
  const labels = { tree: 'GET /api/tree', 'session-detail-big': 'GET /api/sessions/{big}', 'messages-big': 'GET /api/sessions/{big}/messages', 'messages-small': 'GET /api/sessions/{small}/messages' };
  const rows = [];
  for (const key of keys) {
    const row = { name: labels[key], unit: 'ms', per: {} };
    for (const version of ['v21', 'v22']) {
      const rounds = results.rounds.filter((round) => round.version === version && round.viewport === viewport && round.http);
      const values = rounds.flatMap((round) => (round.http[key] ?? []).map((entry) => entry.ms)).filter((value) => typeof value === 'number');
      const bytes = rounds.length ? (rounds[rounds.length - 1].http[key] ?? [])[0]?.bytes ?? null : null;
      row.per[version] = { stat: stats(values), bytes };
    }
    rows.push(row);
  }
  return rows;
}

function fmtRatio(v22, v21) {
  if (!v22 || !v21 || !v21.median) return '—';
  return `${(v22.median / v21.median).toFixed(2)}×`;
}

async function report() {
  const results = JSON.parse(await fsp.readFile(path.join(OUT, 'switch-perf.json'), 'utf8'));
  const ids = results.fixtures.ids;
  const out = [];
  out.push('# v2.1 vs v2.2 —— 「会话切换」性能对照（量测）');
  out.push('');
  out.push(`- 生成于：${new Date().toISOString()}`);
  out.push(`- v2.1 = tag v2.1-final \`${results.fixtures.v21Sha}\`（临时 worktree，不在主树 checkout）`);
  out.push(`- v2.2 = \`${results.fixtures.v22Sha}\``);
  out.push(`- 被测数据（两版同一批、逐字节相同）：`);
  for (const file of results.fixtures.files) out.push(`  - \`${uuidFromName(file.file)}\` ${(file.bytes / 1048576).toFixed(2)} MiB`);
  const roundsPerKey = results.rounds.filter((round) => round.version === 'v21' && round.viewport === VIEWPORTS[0].label).length;
  out.push(`- 样本：每（版 × 视口 × 靶子）${roundsPerKey} 个样本（串行；轮次内两版交替），报中位数 (min–max)`);
  out.push(`- 靶子：BIG=\`${ids.bigId}\` · MID=\`${ids.midId}\` · 中立会话=\`${ids.smallId}\``);
  out.push('');
  for (const viewport of VIEWPORTS) {
    out.push(`## 视口 ${viewport.label}`);
    out.push('');
    const rows = buildMetrics(results, viewport.label);
    const targets = Object.keys(rows[0].perTarget);
    out.push(`| 指标 | 单位 | ${targets[0]} v2.1 | ${targets[0]} v2.2 | v2.2/v2.1 | ${targets[1]} v2.1 | ${targets[1]} v2.2 | v2.2/v2.1 |`);
    out.push('|---|---|---:|---:|---:|---:|---:|---:|');
    for (const row of rows) {
      const a = row.perTarget[targets[0]];
      const b = row.perTarget[targets[1]];
      out.push(`| ${row.name} | ${row.unit} | ${fmtStat(a.v21)} | ${fmtStat(a.v22)} | ${fmtRatio(a.v22, a.v21)} | ${fmtStat(b.v21)} | ${fmtStat(b.v22)} | ${fmtRatio(b.v22, b.v21)} |`);
    }
    out.push('');
    const shots = results.rounds.filter((round) => round.viewport === viewport.label && round.screencast);
    if (shots.length) {
      out.push('screencast 口径（真像素，逐帧；BIG 靶子）：');
      for (const key of ['v21', 'v22']) {
        const ok = shots.filter((round) => round.version === key && round.screencast?.ok);
        const changed = ok.map((round) => round.screencast.firstChangeMs);
        const content = ok.map((round) => round.screencast.firstContentAfterClearMs);
        const blankSeen = ok.filter((round) => round.screencast.blankSeen).length;
        const lastChange = ok.map((round) => round.screencast.lastChangeMs);
        out.push(`- ${VERSIONS[key].label} 点击 → 正文区**任何**像素变化：${fmtStat(stats(changed))} ms` +
          ` · 最后一次可见变化：${fmtStat(stats(lastChange))} ms` +
          ` · 点击 → 清空之后**新内容**出现：${fmtStat(stats(content))} ms` +
          ` · 观察到「空白帧」的轮数 ${blankSeen}/${ok.length}（n=${changed.filter((v) => typeof v === 'number').length}）`);
      }
      out.push('');
    }
  }
  out.push('## /messages 的内容口径（两版发的东西不一样，字节差不能当性能差读）');
  out.push('');
  out.push('| 版 | 字节(未压缩) | messages 条数 | 带 tool part 的条数 | part 形状 | extras |');
  out.push('|---|---:|---:|---:|---|---:|');
  for (const version of ['v21', 'v22']) {
    const round = results.rounds.find((entry) => entry.version === version && entry.http?.caliber && !entry.http.caliber.error);
    const caliber = round?.http?.caliber;
    out.push(caliber
      ? `| ${VERSIONS[version].label} | ${caliber.bytes} | ${caliber.messages} | ${caliber.toolMessages} | ${JSON.stringify(caliber.parts)} | ${caliber.extras} |`
      : `| ${VERSIONS[version].label} | — | — | — | — | — |`);
  }
  out.push('');
  out.push('> 裸 HTTP 探测**不带 `Accept-Encoding`** ⇒ 上表字节是未压缩原文。浏览器里收到的字节另见「切换窗口总字节」。');
  out.push('');
  for (const viewport of VIEWPORTS) {
    out.push(`## 服务端读取路径（裸 HTTP，走 B 的对外端口，keep-alive） · ${viewport.label}`);
    out.push('');
    out.push('| 请求 | v2.1 中位数(min–max) ms | v2.1 字节 | v2.2 中位数(min–max) ms | v2.2 字节 | v2.2/v2.1 |');
    out.push('|---|---:|---:|---:|---:|---:|');
    for (const row of httpTable(results, viewport.label)) {
      const ratio = row.per.v21.stat && row.per.v22.stat && row.per.v21.stat.median ? `${(row.per.v22.stat.median / row.per.v21.stat.median).toFixed(2)}×` : '—';
      out.push(`| ${row.name} | ${fmtStat(row.per.v21.stat)} | ${row.per.v21.bytes ?? '—'} | ${fmtStat(row.per.v22.stat)} | ${row.per.v22.bytes ?? '—'} | ${ratio} |`);
    }
    out.push('');
    out.push('第一遍打开（warmup：含冷 runtime / 冷树扫描；每轮每靶子一次）：');
    for (const version of ['v21', 'v22']) {
      const entries = warmupEntries(results, version, viewport.label);
      for (const target of new Set(entries.map((entry) => entry.target))) {
        const values = entries.filter((entry) => entry.target === target).map((entry) => entry.ms);
        out.push(`- ${VERSIONS[version].label} ${target.slice(0, 8)}: ${fmtStat(stats(values))} ms`);
      }
    }
    out.push('');
  }
  out.push('## 「同一份正文被建了几遍 / 拉了几次」直证（独立一遍，fetch 指纹）');
  out.push('');
  out.push('| 轮 | 版 | 视口 | /messages 次数 | 两次的字节指纹相同？ | 正文重建批次 | 顶层插入批次 |');
  out.push('|---|---|---|---:|---|---:|---:|');
  for (const round of results.rounds) {
    if (!round.duplicateProbe) continue;
    const probe = round.duplicateProbe;
    out.push(`| ${round.round} | ${round.label} | ${round.viewport} | ${probe.messagesRequests} | ${probe.sameBytes === null ? '—' : probe.sameBytes ? '相同' : '不同'} | ${probe.contentAddBatches} | ${probe.topLevelAddBatches} |`);
  }
  out.push('');
  for (const round of results.rounds) {
    if (!round.duplicateProbe) continue;
    out.push(`- ${round.label} ${round.viewport}：${JSON.stringify(round.duplicateProbe.messages)}`);
  }
  out.push('');
  out.push('## 每轮原始观测（成功样本）');
  out.push('');
  out.push('| 轮 | 版 | 视口 | 靶子 | first | settle | reason | scriptMs | layoutMs | recalc | ltMax | 正文新建 | 正文批 | 正文节点@末 | /messages 次/字节 | /tree 次/字节 | 正文批次明细(相对 t0) |');
  out.push('|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|');
  for (const round of results.rounds) {
    for (const sample of round.samples) {
      out.push(`| ${round.round} | ${round.label} | ${round.viewport} | ${sample.target.slice(0, 8)} | ${sample.firstContentMs} | ${sample.settleMs} | ${sample.settleReason} | ${sample.metrics?.ScriptDuration} | ${sample.metrics?.LayoutDuration} | ${sample.metrics?.RecalcStyleCount} | ${sample.longtaskMaxMs} | ${sample.contentAdds} | ${sample.contentAddBatches} | ${sample.contentCountAtEnd} | ${sample.network.messagesRequests}/${sample.network.messagesBytes} | ${sample.network.treeRequests}/${sample.network.treeBytes} | ${JSON.stringify(sample.contentAddBatchDetail)} |`);
    }
  }
  out.push('');
  out.push('## 没验到什么 / 口径限制');
  out.push('');
  out.push('- 两版 `/messages` 的**内容口径不同**（v2.1 只留 `type:"text"` 的 part；v2.2 连工具 part 一起发）⇒ 字节与渲染工作量都不是同一份东西，见报告正文。');
  out.push('- screencast 会改变合成节奏（逐帧推送 + ack），因此那一栏只用于**确认**页内 rAF 口径，不当作耗时主口径。');
  out.push('- 每档样本数 = 轮数（`--rounds`），不是在同一进程里的连续重复 ⇒ 含进程/浏览器冷热抖动，报告给全距。');
  const markdown = `${out.join('\n')}\n`;
  await fsp.writeFile(path.join(OUT, 'switch-perf.md'), markdown, 'utf8');
  log(`[report] → ${path.join(OUT, 'switch-perf.md')}`);
  return markdown;
}

// 门跑完把沙箱收干净：一律走 test/harness.mjs 的共享助手（cleanupStep/removeSandbox），
// 保留 out/（报告）与 git worktree 的登记一起 prune（不然 worktree 目录删了登记还在）。
async function cleanupSandbox(problems) {
  const v21Tree = VERSIONS.v21.repo();
  if (fs.existsSync(path.join(v21Tree, 'server', 'base.mjs'))) {
    await cleanupStep(problems, 'git worktree remove', () => execFileAsync('git', ['-C', root, 'worktree', 'remove', '--force', v21Tree]));
  }
  for (const name of await fsp.readdir(WORK).catch(() => [])) {
    if (name === 'out') continue;
    await removeSandbox(path.join(WORK, name), problems, `remove ${name}`);
  }
  await cleanupStep(problems, 'git worktree prune', () => execFileAsync('git', ['-C', root, 'worktree', 'prune']));
}

// ───────────────────────────── 机械门 ─────────────────────────────
// 阈值挂**实测中位数 + 余量**（量测见 docs/… 与 /tmp 报告），不是永真/永假的门。
// 只对 v2.2 断言绝对上界（v2.1 是可选的对照，缺 worktree 时门不该因此变红）。
// 阈值挂**实测中位数 + 余量**（量测见 docs/history/session-switch-perf-v21-vs-v22.md）：
// 1200x760 下 v2.2 的实测（n=5，中位数）——首屏 257/109 ms、静置 1114/880 ms、
// Script 53/21 ms、Layout 106/58 ms、Recalc 11/10、long task 最长 90/0 ms、
// /messages 1 次、窗口内 /tree 0 次。取「中位数 ~2–4×」当上界：既拦得住真回归
// （例如正文再建一遍、详情路由退化成建 runtime、载荷膨胀），又不会在忙机器上误报。
const GATE = {
  '点击 → 正文第一块可辨认内容': { unit: 'ms', max: Number(process.env.SOPHO_GATE_FIRST_MS ?? 600) },
  '点击 → 静置（quiet+补齐完成）': { unit: 'ms', max: Number(process.env.SOPHO_GATE_SETTLE_MS ?? 2500) },
  '主线程 ScriptDuration': { unit: 'ms', max: Number(process.env.SOPHO_GATE_SCRIPT_MS ?? 300) },
  '主线程 LayoutDuration': { unit: 'ms', max: Number(process.env.SOPHO_GATE_LAYOUT_MS ?? 400) },
  'RecalcStyleCount': { unit: '次', max: Number(process.env.SOPHO_GATE_RECALC ?? 100) },
  'longtask 最长一条': { unit: 'ms', max: Number(process.env.SOPHO_GATE_LONGEST ?? 400) },
  '/messages 请求数': { unit: '次', max: 1 },
  '/tree 请求数（切换窗口内）': { unit: '次', max: 2 },
};

function gateAssertions(results) {
  const problems = [];
  const ids = results.fixtures.ids;
  const targets = [ids.bigId, ids.midId];
  const viewport = VIEWPORTS[0].label;
  const samples = [];
  for (const target of targets) samples.push(...collectSamples(results, 'v22', viewport, target));
  if (samples.length === 0) problems.push('gate: v2.2 在 1200x760 下没有任何样本（run 阶段失败？）');
  const assertion = { samples: samples.length, checks: [] };
  for (const [name, rule] of Object.entries(GATE)) {
    const rows = buildMetrics(results, viewport);
    const row = rows.find((entry) => entry.name === name);
    if (!row) { problems.push(`gate: 指标 ${name} 不存在`); continue; }
    for (const [target, value] of Object.entries(row.perTarget)) {
      const stat = value.v22;
      if (!stat) { problems.push(`gate: ${name} / ${target} 没有 v2.2 样本`); continue; }
      const ok = stat.median <= rule.max;
      assertion.checks.push({ name, target, median: stat.median, max: rule.max, ok });
      if (!ok) problems.push(`gate: ${name} / ${target} 中位数 ${stat.median}${rule.unit} > 上界 ${rule.max}${rule.unit}`);
    }
  }
  // 「一次切换只建一遍 / 节点数 = 正文条数」——v2.2 的既有不变式（test:switchpaint 口径），
  // 这里用真数据再钉一次：顶层插入批次 ≤ 2，且顶层新建节点数 ≥ 服务端报的正文条数。
  // ⚠️ 节点数**不等于** `/messages` 条数：v2.2 的 `buildMessageNodes` 不为 toolResult/tool
  // 角色建 article（见 web/render.js:887），所以「一次切换只建一遍」的正确口径是
  // 「这一次窗口里新建的顶层节点 == 结束时容器里的正文节点数」（即没有第二条渲染路径再建一遍）。
  for (const sample of samples) {
    if (sample.topLevelAddBatches > 2) problems.push(`gate: 顶层插入批次 ${sample.topLevelAddBatches} > 2（目标 ${sample.target.slice(0, 8)}）`);
    if (sample.nodeCountAtEnd > 0 && sample.addedTopLevel < sample.nodeCountAtEnd) {
      problems.push(`gate: 这一次窗口新建顶层节点 ${sample.addedTopLevel} < 结束时节点数 ${sample.nodeCountAtEnd}（目标 ${sample.target.slice(0, 8)}）`);
    }
  }
  assertion.invariants = samples.map((sample) => ({ target: sample.target.slice(0, 8), batches: sample.topLevelAddBatches, added: sample.addedTopLevel, endNodes: sample.nodeCountAtEnd, messages: sample.nodeTotal }));
  return { problems, assertion };
}

// ───────────────────────────── main ─────────────────────────────
const problems = [];
let primary = null;
try {
  if (IS_GATE) {
    // fixtures.json 可能还在、但上一轮门把 home/ 与 v2.1 worktree 清掉了 ⇒ 两条都要在才算 prepared。
    const fixturesPath = path.join(OUT, 'fixtures.json');
    const exists = await fsp.access(fixturesPath).then(() => true).catch(() => false)
      && await fsp.access(path.join(WORK, 'home-v22', 'sessions')).then(() => true).catch(() => false);
    if (!exists) await prepare();
    await run({ rounds: GATE_ROUNDS, problems });
    const results = JSON.parse(await fsp.readFile(path.join(OUT, 'switch-perf.json'), 'utf8'));
    const { problems: gateProblems, assertion } = gateAssertions(results);
    const fixtureList = results.fixtures.ids;
    log(`[gate] 靶子 big=${fixtureList.bigId} mid=${fixtureList.midId}`);
    for (const check of assertion.checks) log(`[gate] ${check.ok ? '✓' : '✗'} ${check.name} / ${check.target}: ${check.median} ≤ ${check.max}`);
    log(`[gate] 不变式：${JSON.stringify(assertion.invariants)}`);
    log(`[gate] 断言 ${assertion.checks.filter((c) => c.ok).length}/${assertion.checks.length} 通过（样本 ${assertion.samples}）`);
    assert.deepEqual(gateProblems, [], `切换成本门失败:\n${gateProblems.join('\n')}`);
    await report();
    await cleanupSandbox(problems);
  } else {
    if (MODE === 'prepare' || MODE === 'all') await prepare();
    if (MODE === 'run' || MODE === 'all') await run({ rounds: ROUNDS, problems });
    if (MODE === 'report' || MODE === 'all') await report();
  }
} catch (error) {
  primary = error;
} finally {
  finishCleanup(primary, problems);
}
