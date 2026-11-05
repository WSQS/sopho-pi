import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { access, appendFile, open, readFile, readdir, mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { getHeapStatistics } from 'node:v8';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createUiSettingsStore,
  UI_SETTINGS_FILE_NAME,
} from './ui-settings.mjs';
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';

const { RuntimePool, poolConfigFromEnv } = await import(new URL('./pool.mjs', import.meta.url).href);
const execFileAsync = promisify(execFile);

export const LOGIC_SOURCE_VERSION = 's0a-v1';
const PING_BEHAVIOR = 'behavior-v1';
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// 安卓图片发送（2026-10-25）：`/message`、`/steer` 从 `{text}` 扩成可选 `images`。
// 这些是**服务端安全上限**，不是产品限制；客户端可以更严（Android 当前自定 1 张/缩放后≤2MiB）。
// 纯文请求仍按老口径 1MiB body；只有带 images 的请求才放宽到 MEDIA_REQUEST_MAX_BYTES，且有界。
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16_000_000;
const TEXT_REQUEST_MAX_BYTES = 1024 * 1024;
// 1MiB text + 4 × base64(4MiB) + JSON 余量。**不是**无限 readJson。
const MEDIA_REQUEST_MAX_BYTES = TEXT_REQUEST_MAX_BYTES + MAX_IMAGES_PER_MESSAGE * Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const ARCHIVE_ENTRY = 'sopho.archive';
// Manager toolkit（`docs/manager-toolkit-plan.md`）："要业主拍板的事"也走**会话文件自己的 custom 条目**，
// 与归档同规矩 —— append-only，`op: ask|answer|close`，**现状 = 该 id 最后一条**。
// 为什么不用侧车账（archive.json 那种）：问题必须跟着会话文件走（搬家/冷热/换代际都不丢），
// 而且"我答过没"要能在同一份事实源里追溯（谁/何时/为什么）。
const QUESTION_ENTRY = 'sopho.question';
const COMPACTION_NOTE = '正文列表 ≠ 模型现在看得见的东西';
// 分支摘要（`branch_summary` entry）是 `/tree` 切分支时给**被抛下的那条路**生成的摘要
// （`docs/session-format.md:250-262`）。它不在 `messages` 里（`atIndex` 只是「落在正文的哪个位置」）。
const BRANCH_SUMMARY_NOTE = '切分支时给被抛下的那条路生成的摘要（不是正文消息）';
const STREAMING_CONFLICT = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
const COMPACTION_CONFLICT = 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.';
const STATUS_LABELS = { working: '工作中', unread: '未读', idle: '闲置' };
const DEVICE_HOST = /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/;
const DEVICE_USER = /^[A-Za-z0-9._-]+$/;
const DEVICE_MODES = new Set(['tools', 'session']);
const RUN_KILL_GRACE_MS = 2000;
const DETACHED_NOTICE = 'this command is not part of the local process tree: the webui interrupt / process-tree kill cannot reach it, only the local ssh client is killed here';
const DEVICE_FIELDS = new Set(['host', 'user', 'mode', 'repoHints', 'cwdRoot', 'note', 'addedAt', 'lastProbe']);
const PLACEMENT_FIELDS = new Set(['kind', 'cwd', 'device', 'scratchRoot', 'claimedBy', 'at']);
const PLACEMENT_KINDS = new Set(['dir', 'scratch', 'device']);
const COST_ESTIMATE_NOTE = 'Estimate only, not a bill.';
const UNKNOWN_USAGE_NOTE = 'This pi entry has no non-zero provider usage; usage is unknown, not zero.';
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const METRICS_KEY = '__sophoV22WorkerNetMetrics';
const METRICS_BUCKET_MS = 5_000;
const METRICS_BUCKETS_KEPT = 12;
// A long-lived worker sees every client-chosen path, so the per-route table has to be
// bounded or it grows without limit (the v2.1 instrument had the same shape). Routes that
// fall out of the cap are folded into one overflow row, so the totals stay exact.
const METRICS_ROUTES_MAX = Number(process.env.SOPHO_METRICS_ROUTES_MAX ?? 128);
const METRICS_OVERFLOW_PATTERN = '(other routes)';
if (!Number.isInteger(METRICS_ROUTES_MAX) || METRICS_ROUTES_MAX < 2) throw new Error(`invalid SOPHO_METRICS_ROUTES_MAX: ${process.env.SOPHO_METRICS_ROUTES_MAX}`);
// `tree.session` 只在**状态转换**时发（created/title_changed/start/end/settled/…）—— 它一个事件
// 就等于树监听者那头一次整树读 + 整栏重建。delta 类（每个字一条）以前也发，在真实规模上实测到
// 171 条/秒、与 `session.delta` **1:1**，客户端随即 215 KB `GET /api/tree`；这不是树的状态变了，
// 只是正文字符多了。v2.1 本来就没有任何 per-delta 树事件（树靠轮询 + `{t:"title"}`）—— 这里恢复那个语义。
// ⚠️ `session.tool_update`（实时输出，2026-09-22）**必须**在这里：它是 ≈10 帧/秒的逐帧事件，
// 漏一个就会变成「每 100 ms 一次整树读 + 整栏重建」—— 与 `session.delta` 同一类病。
const TREE_EVENT_SUPPRESSED = new Set(['session.delta', 'session.tool_start', 'session.tool_end', 'session.tool_update', 'session.question', 'session.notice', 'session.annotation', 'session.annotation.skipped',
  // 推荐回复（`session.suggestions`）只是那条消息上的一个可选字段：它**不改树的任何事实**
  // （不碰状态/未读/名字），所以不许把它变成一次全树刷新。
  'session.suggestions']);

function netMetrics() {
  let state = globalThis[METRICS_KEY];
  if (!state) {
    state = { startedAt: Date.now(), requests: 0, bytes: 0, open: 0, maxOpen: 0, routes: new Map() };
    state.routes.set(METRICS_OVERFLOW_PATTERN, newMetricRoute(METRICS_OVERFLOW_PATTERN));
    globalThis[METRICS_KEY] = state;
  }
  return state;
}

function metricRoutePattern(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  const parts = segments.map((segment, index) => (index === 1 && segments[0] === 'sessions') || FULL_UUID.test(segment) ? ':id' : segment);
  return `/${parts.join('/')}`;
}

function metricByteLength(chunk, encoding) {
  if (chunk == null) return 0;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined);
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function newMetricRoute(pattern) {
  return { pattern, requests: 0, bytes: 0, open: 0, maxOpen: 0, firstAt: Date.now(), lastRequestAt: null, lastByteAt: null, buckets: new Map(), evictedRoutes: 0 };
}

/** Fold an evicted route into the overflow row: same totals, no lost bytes, no extra slot. */
function mergeMetricRoute(state, victim) {
  let overflow = state.routes.get(METRICS_OVERFLOW_PATTERN);
  if (!overflow) {
    overflow = newMetricRoute(METRICS_OVERFLOW_PATTERN);
    overflow.firstAt = victim.firstAt;
    state.routes.set(METRICS_OVERFLOW_PATTERN, overflow);
  }
  overflow.requests += victim.requests;
  overflow.bytes += victim.bytes;
  overflow.evictedRoutes += 1;
  overflow.firstAt = Math.min(overflow.firstAt, victim.firstAt);
  if (victim.lastRequestAt !== null) overflow.lastRequestAt = Math.max(overflow.lastRequestAt ?? 0, victim.lastRequestAt);
  if (victim.lastByteAt !== null) overflow.lastByteAt = Math.max(overflow.lastByteAt ?? 0, victim.lastByteAt);
  for (const [index, bucket] of victim.buckets) {
    const target = overflow.buckets.get(index);
    if (target) {
      target.requests += bucket.requests;
      target.bytes += bucket.bytes;
    } else {
      overflow.buckets.set(index, { ...bucket });
    }
  }
}

function metricRoute(state, pattern) {
  const existing = state.routes.get(pattern);
  if (existing) return existing;
  if (state.routes.size >= METRICS_ROUTES_MAX) {
    let victim = null;
    for (const candidate of state.routes.values()) {
      if (candidate.pattern === METRICS_OVERFLOW_PATTERN || candidate.open > 0) continue;
      if (!victim || (candidate.lastRequestAt ?? 0) < (victim.lastRequestAt ?? 0)) victim = candidate;
    }
    // If every named row is currently open, preserve truthful connection counts by folding
    // this new request straight into the reserved overflow row instead of evicting an open row.
    if (!victim) return state.routes.get(METRICS_OVERFLOW_PATTERN);
    state.routes.delete(victim.pattern);
    mergeMetricRoute(state, victim);
  }
  const route = newMetricRoute(pattern);
  state.routes.set(pattern, route);
  return route;
}

function bumpMetricBucket(route, at, requests, bytes) {
  const index = Math.floor(at / METRICS_BUCKET_MS);
  let bucket = route.buckets.get(index);
  if (!bucket) {
    bucket = { requests: 0, bytes: 0 };
    route.buckets.set(index, bucket);
    for (const key of route.buckets.keys()) if (key <= index - METRICS_BUCKETS_KEPT) route.buckets.delete(key);
  }
  bucket.requests += requests;
  bucket.bytes += bytes;
}

function addMetricBytes(state, route, bytes) {
  if (!bytes) return;
  const at = Date.now();
  state.bytes += bytes;
  route.bytes += bytes;
  route.lastByteAt = at;
  bumpMetricBucket(route, at, 0, bytes);
}

function instrumentRequest(request, response, pattern) {
  const state = netMetrics();
  const route = metricRoute(state, pattern);
  const at = Date.now();
  state.requests += 1;
  route.requests += 1;
  route.lastRequestAt = at;
  bumpMetricBucket(route, at, 1, 0);
  state.open += 1;
  route.open += 1;
  state.maxOpen = Math.max(state.maxOpen, state.open);
  route.maxOpen = Math.max(route.maxOpen, route.open);

  const countBody = request.method !== 'HEAD';
  const originalWrite = response.write;
  const originalEnd = response.end;
  response.write = function write(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (countBody) addMetricBytes(state, route, metricByteLength(chunk, encoding));
    return originalWrite.call(this, chunk, encoding, callback);
  };
  response.end = function end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    }
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (countBody) addMetricBytes(state, route, metricByteLength(chunk, encoding));
    return originalEnd.call(this, chunk, encoding, callback);
  };

  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    state.open -= 1;
    route.open -= 1;
  };
  response.on('finish', done);
  response.on('close', done);
}

const roundMetric = (value) => Math.round(value * 1000) / 1000;

function netSnapshot() {
  const state = netMetrics();
  const now = Date.now();
  const current = Math.floor(now / METRICS_BUCKET_MS);
  const oldest = current - METRICS_BUCKETS_KEPT + 1;
  const windowMs = METRICS_BUCKETS_KEPT * METRICS_BUCKET_MS;
  const buckets = [];
  for (let index = oldest; index <= current; index += 1) {
    let requests = 0;
    let bytes = 0;
    const routes = {};
    for (const route of state.routes.values()) {
      const bucket = route.buckets.get(index);
      if (!bucket || (!bucket.requests && !bucket.bytes)) continue;
      requests += bucket.requests;
      bytes += bucket.bytes;
      routes[route.pattern] = { requests: bucket.requests, bytes: bucket.bytes };
    }
    buckets.push({ t: index * METRICS_BUCKET_MS, ageSec: roundMetric((now - index * METRICS_BUCKET_MS) / 1000), requests, bytes, bytesPerSec: roundMetric(bytes / (METRICS_BUCKET_MS / 1000)), routes });
  }

  const routes = [];
  for (const route of state.routes.values()) {
    if (route.requests === 0 && route.bytes === 0 && route.open === 0) continue;
    const perBucket = [];
    let windowRequests = 0;
    let windowBytes = 0;
    for (let index = oldest; index <= current; index += 1) {
      const bucket = route.buckets.get(index) ?? { requests: 0, bytes: 0 };
      windowRequests += bucket.requests;
      windowBytes += bucket.bytes;
      perBucket.push({ t: index * METRICS_BUCKET_MS, requests: bucket.requests, bytes: bucket.bytes });
    }
    routes.push({
      pattern: route.pattern,
      requests: route.requests,
      openConnections: route.open,
      maxOpenConnections: route.maxOpen,
      bytes: route.bytes,
      bytesPerSec: roundMetric(route.bytes / Math.max((now - route.firstAt) / 1000, 0.001)),
      lastRequestAt: route.lastRequestAt,
      lastByteAt: route.lastByteAt,
      last1m: { requests: windowRequests, bytes: windowBytes, bytesPerSec: roundMetric(windowBytes / (windowMs / 1000)) },
      buckets: perBucket,
      ...(route.evictedRoutes > 0 ? { evictedRoutes: route.evictedRoutes } : {}),
    });
  }
  const totalBytes = state.bytes;
  const windowBytes = buckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
  const windowRequests = buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
  for (const route of routes) {
    route.share = totalBytes ? roundMetric(route.bytes / totalBytes) : 0;
    route.share1m = windowBytes ? roundMetric(route.last1m.bytes / windowBytes) : 0;
  }
  routes.sort((left, right) => right.bytes - left.bytes);
  return {
    now,
    pid: process.pid,
    startedAt: state.startedAt,
    uptimeMs: now - state.startedAt,
    bucketMs: METRICS_BUCKET_MS,
    bucketsKept: METRICS_BUCKETS_KEPT,
    bucketsOrder: 'oldest → newest',
    bytesNote: 'worker payload bytes only (res.write/res.end); excludes HTTP headers, chunk framing, stable-host-only fields, and B proxy overhead',
    selfExcluded: ['/metrics', '/reload-code', '/host'],
    scope: 'current generation worker egress; counters reset when this worker is replaced',
    routesNote: `per-route table is capped at ${METRICS_ROUTES_MAX} rows; the least recently used row is folded into "${METRICS_OVERFLOW_PATTERN}" and its evictedRoutes count, so totals never drift`,
    totals: {
      requests: state.requests,
      bytes: state.bytes,
      openConnections: state.open,
      maxOpenConnections: state.maxOpen,
      last1m: { requests: windowRequests, bytes: windowBytes, bytesPerSec: roundMetric(windowBytes / (windowMs / 1000)) },
      bytesPerSec: roundMetric(state.bytes / Math.max((now - state.startedAt) / 1000, 0.001)),
    },
    buckets,
    top3ByBytes: routes.slice(0, 3).map((route) => ({ pattern: route.pattern, bytes: route.bytes, share: route.share, bytesPerSec1m: route.last1m.bytesPerSec })),
    routes,
  };
}

export function createMemoryWatermarkLatch(budget) {
  let pressure = false;
  let episode = 0;
  return {
    sample(memory) {
      const aboveHigh = memory.heapUsed >= budget.heapHighBytes || memory.rss >= budget.rssHighBytes;
      const belowLow = memory.heapUsed <= budget.heapLowBytes && memory.rss <= budget.rssLowBytes;
      if (!pressure && aboveHigh) {
        pressure = true;
        episode += 1;
      } else if (pressure && belowLow) {
        pressure = false;
      }
      return { ...memory, pressure, episode, aboveHigh, belowLow };
    },
  };
}

function promptCommandsOf(session) {
  if (typeof session?.getCommands === 'function') {
    return session.getCommands().map((command) => ({
      name: command.name,
      description: command.description ?? null,
      source: command.source,
      argumentHint: command.argumentHint ?? null,
      path: command.sourceInfo?.path ?? null,
    }));
  }
  const commands = [];
  for (const command of session?.extensionRunner?.getRegisteredCommands?.() ?? []) {
    commands.push({
      name: command.invocationName,
      description: command.description ?? null,
      source: 'extension',
      argumentHint: null,
      path: command.sourceInfo?.path ?? null,
    });
  }
  for (const template of session?.promptTemplates ?? []) {
    commands.push({
      name: template.name,
      description: template.description ?? null,
      source: 'prompt',
      argumentHint: template.argumentHint ?? null,
      path: template.sourceInfo?.path ?? null,
    });
  }
  for (const skill of session?.resourceLoader?.getSkills?.().skills ?? []) {
    commands.push({
      name: `skill:${skill.name}`,
      description: skill.description ?? null,
      source: 'skill',
      argumentHint: null,
      path: skill.sourceInfo?.path ?? null,
    });
  }
  return commands;
}

// 「这条 prompt 文本是一条**扩展命令**吗」—— 与 `/commands` 用**同一份名单**（`promptCommandsOf` 里
// `source === 'extension'` 那部分），所以“用户能打出来的命令名”与这里的判据不会漂。
// 为什么需要它：pi 的 `prompt()` 对 `/cmd` 是**先交给扩展 handler**、handler 回来之后才 `preflightResult(true)`
//（`agent-session.js` 的 `_tryExecuteExtensionCommand`）⇒ 扩展命令的 handler 回头打 HTTP 时，本部署的
// `admissionPending` 必然还是 true，但**没有任何模型回合在飞**。`/move` 必须能把这一种与真 prompt 的
// 准入窗口分开（见 `adapter.isAdmittingOwnCommand()`），否则用户面 `/move` 在每个会话上必 409。
function extensionCommandNameIn(session, text) {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const space = text.indexOf(' ');
  const name = space === -1 ? text.slice(1) : text.slice(1, space);
  if (name === '') return null;
  let commands = [];
  try {
    commands = promptCommandsOf(session);
  } catch {
    return null;
  }
  const hit = commands.find((command) => command.name === name && command.source === 'extension');
  return hit ? name : null;
}

const builtinCommandsCache = { tried: false, commands: null, error: null, how: null };
async function builtinCommands() {
  if (builtinCommandsCache.tried) return builtinCommandsCache;
  builtinCommandsCache.tried = true;
  try {
    const root = await import(PI_PACKAGE);
    if (Array.isArray(root.BUILTIN_SLASH_COMMANDS)) {
      builtinCommandsCache.commands = root.BUILTIN_SLASH_COMMANDS;
      builtinCommandsCache.how = 'package-root';
      return builtinCommandsCache;
    }
  } catch {}
  try {
    const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE))));
    const file = path.join(packageRoot, 'dist', 'core', 'slash-commands.js');
    const module = await import(pathToFileURL(file).href);
    if (!Array.isArray(module.BUILTIN_SLASH_COMMANDS)) {
      builtinCommandsCache.error = `${file} does not export BUILTIN_SLASH_COMMANDS`;
      return builtinCommandsCache;
    }
    builtinCommandsCache.commands = module.BUILTIN_SLASH_COMMANDS;
    builtinCommandsCache.how = file;
  } catch (error) {
    builtinCommandsCache.error = `cannot read pi built-in slash commands: ${normalizeError(error).message}`;
  }
  return builtinCommandsCache;
}

export const WEB_BUILTINS = {
  compact: { via: 'compact', hint: '发 /compact，网页会调用这条会话的压缩入口。' },
  model: { via: 'model', hint: '发 /model <provider/model>；输入 /model 空格会列候选。' },
};
// ── 「谁替代了这条命令」必须机械可核实（M-05 事故的防线） ─────────────────────────
// 事故：`export: { tag: '点「快照」' }` 指向一个 web/** 里**不存在**的按钮（只有 app.js 里一句注释
// 提到「快照」）。也就是说「我们承认缺口」的台账本身会撒谎，而且没有任何东西会因此变红。
//
// 所以 tag 不再是自由文本：它只能取 TAG_KINDS 里登记过的**稳定话术**，并且每条话术明说
// 自己是否声称「网页上有个入口」（claimsUi）。声称有的，必须给出 UI_ENTRIES 里的 id，
// 而那个 id 必须在 web/** 里真的找得到对应元素 —— 判据在 test/command-tag-honesty.mjs。
export const TAG_KINDS = {
  'TUI 专用': { claimsUi: false, why: 'pi 的 TUI 能力，webui 里没有也不假装有' },
  '无网页入口': { claimsUi: false, why: '服务端能力在，但网页上还没有入口 —— 不许写成「点 X」' },
  '尚未恢复': { claimsUi: false, why: 'v2.1 有、v2.2 还没恢复的入口' },
  '看左栏树': { claimsUi: true, why: '左栏会话树' },
  '点左栏会话': { claimsUi: true, why: '左栏会话树里的会话行' },
  '用＋新会话': { claimsUi: true, why: '左栏「＋ 新会话」按钮' },
  '关标签页': { claimsUi: false, why: '浏览器行为，不是 web/** 里的元素' },
  '点右栏「快照」': { claimsUi: true, why: '右栏会话头部的「快照」链接（导出 HTML 快照）' },
  '点右栏「改名」': { claimsUi: true, why: '右栏会话头部的「改名」按钮' },
};

// uiEntry id → 它在 web/** 里的**可机械核对**出处（文件 + 原文片段）。
// 只登记真实存在的入口；某个入口被前端砍掉时，这道门会红（这是设计目的）。
export const UI_ENTRIES = {
  tree: { file: 'web/index.html', needle: 'id="tree"', what: '左栏会话树容器 #tree' },
  'new-session': { file: 'web/index.html', needle: 'id="new-session-toggle"', what: '左栏「＋ 新会话」按钮 #new-session-toggle' },
  export: { file: 'web/index.html', needle: 'id="export"', what: '右栏会话头部的「快照」链接 #export' },
  rename: { file: 'web/index.html', needle: 'id="rename"', what: '右栏会话头部的「改名」按钮 #rename' },
};

export const BUILTIN_ELSEWHERE = {
  settings: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（pi 的多项设置菜单：主题 / transport / 图片 / 自动压缩…，网页里没有这份菜单）。网页侧另有一处独立的设置（左栏底栏那个「设置」入口）＋直链 /settings.html（GET/PATCH /settings）：思考折叠的默认、卡片反馈的维护者会话、推荐回复、压缩即封存四项 —— 与这条内置命令不是同一个东西' },
  tree: { tag: '看左栏树', uiEntry: 'tree', reason: 'webui 用左栏会话树切换分支' },
  thinking: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（思考档位）' },
  'scoped-models': { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（模型轮换范围）' },
  // 修前这里写的是 `tag: '点「快照」'` —— 指向一个 web/** 里**不存在**的按钮（M-05 的事故）。
  // 现在网页侧的入口已经落地（`landing/v2.2-tui-parity-webui`：右栏顶栏 `<a id="export">快照</a>`
  // → `/api/sessions/{id}/export`），所以台账**指回那个真实入口**，并由 test/command-tag-honesty.mjs
  // 的 B 项去 `git show HEAD:web/index.html` 里核 `id="export"` 真的在。
  export: { tag: '点右栏「快照」', uiEntry: 'export', reason: 'webui 右栏的「快照」链接打开 pi 原生 HTML 快照（GET /sessions/{id}/export）' },
  import: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（从 JSONL 导入）' },
  share: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（分享成 gist）' },
  copy: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（复制到剪贴板）' },
  name: { tag: '点右栏「改名」', uiEntry: 'rename', reason: 'webui 右栏的「改名」按钮改名（PATCH /sessions/{id} {name}）' },
  session: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（会话统计）' },
  changelog: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（更新日志）' },
  hotkeys: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（快捷键一览）' },
  fork: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（从历史消息分叉）' },
  clone: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（复制当前会话）' },
  trust: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（项目信任）' },
  login: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（交互式登录 provider）' },
  logout: { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（登出 provider）' },
  new: { tag: '用＋新会话', uiEntry: 'new-session', reason: 'webui 用左栏的「＋ 新会话」' },
  resume: { tag: '点左栏会话', uiEntry: 'tree', reason: 'webui 用左栏会话树恢复或切换会话' },
  reload: { tag: 'TUI 专用', uiEntry: null, reason: 'v2.2 的代码代际更新走宿主 reload，不把 TUI reload 冒充成网页命令' },
  quit: { tag: '关标签页', uiEntry: null, reason: '关掉标签页不会停止 A/B 或其它会话' },
};
export const DEFAULT_UNAVAILABLE_BUILTIN = { tag: 'TUI 专用', uiEntry: null, reason: 'TUI 专用（v2.2 webui 没接这条命令）' };

async function allCommands(session) {
  const runnable = promptCommandsOf(session).map((command) => ({
    ...command,
    builtin: false,
    runnable: true,
    reason: null,
    tag: null,
    via: 'prompt',
    hint: null,
    shadowed: null,
  }));
  const builtins = await builtinCommands();
  if (!builtins.commands) {
    return { commands: runnable, builtinError: builtins.error, builtinHow: null };
  }
  const remaining = new Map(runnable.map((command) => [command.name, command]));
  const commands = builtins.commands.map((command) => {
    const shadowed = remaining.get(command.name) ?? null;
    if (shadowed) remaining.delete(command.name);
    const supported = WEB_BUILTINS[command.name];
    const unavailable = BUILTIN_ELSEWHERE[command.name] ?? DEFAULT_UNAVAILABLE_BUILTIN;
    return {
      name: command.name,
      description: command.description ?? null,
      source: 'builtin',
      argumentHint: command.argumentHint ?? null,
      path: null,
      builtin: true,
      runnable: Boolean(supported),
      reason: supported ? null : unavailable.reason,
      tag: supported ? null : unavailable.tag,
      // 指 UI 的那些 tag 带上稳定 id（前端/门都能机械核实它指向谁）；不指 UI 的一律 null。
      uiEntry: supported ? null : (unavailable.uiEntry ?? null),
      via: supported?.via ?? null,
      hint: supported?.hint ?? null,
      shadowed: shadowed ? {
        name: shadowed.name,
        source: shadowed.source,
        description: shadowed.description ?? null,
        path: shadowed.path ?? null,
      } : null,
    };
  });
  return { commands: [...commands, ...remaining.values()], builtinError: null, builtinHow: builtins.how };
}

function commandNameIn(text) {
  if (!text.startsWith('/')) return null;
  return text.slice(1).split(/\s/, 1)[0] || null;
}

function modelsOf(session) {
  const scoped = session?.scopedModels ?? [];
  if (scoped.length > 0) return { source: 'scoped', list: scoped.map((entry) => entry.model) };
  const runtime = session?.modelRuntime;
  if (runtime && typeof runtime.getAvailableSnapshot === 'function') return { source: 'available', list: [...runtime.getAvailableSnapshot()] };
  return { source: 'none', list: [] };
}

// Per-model, from pi-ai's own clamp table (`getSupportedThinkingLevels`). **Never** re-use the
// current session's list for another model: switching models is exactly when the list changes.
function thinkingLevelsOfModel(model) {
  return model ? getSupportedThinkingLevels(model) : null;
}

function thinkingLevelsOfSession(session) {
  if (!session?.model) return null;
  if (typeof session.getAvailableThinkingLevels === 'function') {
    const levels = session.getAvailableThinkingLevels();
    return Array.isArray(levels) ? [...levels] : null;
  }
  return thinkingLevelsOfModel(session.model);
}

function inputOfModel(model) {
  return model && Array.isArray(model.input) ? [...model.input] : null;
}

function assertImagesSupported(session, images) {
  if (!images || images.length === 0) return;
  const model = session.model ?? null;
  const input = inputOfModel(model);
  if (!input || !input.includes('image')) {
    throw new HttpError(409, 'model_does_not_support_images', `the current model (${modelRef(model) ?? 'unknown'}) does not declare image input`, {
      model: modelRef(model), input,
    });
  }
}

const modelRef = (model) => model ? `${model.provider}/${model.id}` : null;

function contextOf(session) {
  const usage = session?.getContextUsage?.();
  if (!usage) return null;
  const settings = session.settingsManager?.getCompactionSettings?.();
  if (!settings) return null;
  const contextWindow = Number.isFinite(usage.contextWindow) ? usage.contextWindow : null;
  const reserveTokens = Number.isFinite(settings.reserveTokens) ? settings.reserveTokens : null;
  const usedTokens = Number.isFinite(usage.tokens) ? usage.tokens : null;
  const thresholdTokens = contextWindow === null || reserveTokens === null ? null : contextWindow - reserveTokens;
  return {
    modelId: session.model?.id ?? null,
    provider: session.model?.provider ?? null,
    contextWindow,
    usedTokens,
    thresholdTokens,
    freeTokens: thresholdTokens === null || usedTokens === null ? null : thresholdTokens - usedTokens,
    reserveTokens,
    keepRecentTokens: Number.isFinite(settings.keepRecentTokens) ? settings.keepRecentTokens : null,
    compactionEnabled: typeof settings.enabled === 'boolean' ? settings.enabled : null,
  };
}

function pickModel(wanted, models) {
  const exact = models.find((model) => modelRef(model) === wanted);
  if (exact) return { model: exact, how: 'provider/id' };
  const byId = models.filter((model) => model.id === wanted);
  if (byId.length === 1) return { model: byId[0], how: 'id' };
  if (byId.length > 1) return { ambiguous: byId, how: 'id-ambiguous' };
  const lowered = wanted.toLowerCase();
  const insensitive = models.filter((model) => modelRef(model).toLowerCase() === lowered || model.id.toLowerCase() === lowered);
  if (insensitive.length === 1) return { model: insensitive[0], how: 'case-insensitive' };
  if (insensitive.length > 1) return { ambiguous: insensitive, how: 'case-insensitive-ambiguous' };
  return null;
}

class HttpError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) };
  }
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// ── 条件压缩（非回环客户端 + 大响应 + JSON/文本白名单）──
// 落点为什么在这层：响应字节是在**逻辑层**产生并缓存的（`sendJson` / `sendJsonText` /
// 正文响应体缓存），B（`server/app.mjs`）只是把上游响应原样 `pipe` 给客户端、连头都不改。
// 所以在这里压出来的字节，经 A→B 回环、再经 B→客户端 的那段网络，与在 B 里压出来的**完全
// 一样**；唯一在 B 里才能做的事是「看真正的客户端地址」——B 把它的对端写进 `x-forwarded-for`，
// 这边用 `requestPeerAddress` 判定回环。SSE 走 `beginSse` / `sseWrite`，根本不经过这里的
// `sendJson*`，所以白名单天然把 `text/event-stream` 排除（绝不压缩 SSE）。
const COMPRESS_ENABLED = process.env.SOPHO_COMPRESS !== '0';
const COMPRESS_TYPES = new Set([
  'application/json',
  'text/plain',
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'image/svg+xml',
]);

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${name}: ${raw} (expected integer ${min}..${max === Number.MAX_SAFE_INTEGER ? 'n' : max})`);
  }
  return value;
}

// 中等质量：业主链路是**明文 HTTP**，浏览器只提 `gzip, deflate` ⇒ 实际走 gzip（业主基线：
// gzip6 ≈ 20.5% / 342 ms，gzip1 ≈ 23.9% / 159 ms；取 ~5-6）。br 仍保留（标准协商：
// 客户端真提 br 时才用；当前明文链路用不到，加了 TLS/代理后才会被选中），别用 br q11。
const COMPRESS_MIN_BYTES = envInt('SOPHO_COMPRESS_MIN_BYTES', 64 * 1024);
const COMPRESS_MAX_BYTES = envInt('SOPHO_COMPRESS_MAX_BYTES', 64 * 1024 * 1024, { min: 1 });
const COMPRESS_GZIP_LEVEL = envInt('SOPHO_COMPRESS_GZIP_LEVEL', 6, { min: 0, max: 9 });
const COMPRESS_BROTLI_QUALITY = envInt('SOPHO_COMPRESS_BROTLI_QUALITY', 4, { min: 0, max: 9 });

function baseContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function isCompressibleContentType(value) {
  return COMPRESS_TYPES.has(baseContentType(value));
}

function normalizeAddress(address) {
  if (typeof address !== 'string') return null;
  let value = address.trim().toLowerCase();
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  return value === '' ? null : value;
}

function isLoopbackAddress(address) {
  const value = normalizeAddress(address);
  if (value === null) return false;
  if (value === '::1') return true;
  return /^127\./.test(value);
}

// 逻辑层永远看不到真正的浏览器：worker 的 TCP 对端是宿主 A（必然回环）。真正知道客户端
// 地址的只有 B；B 把它的对端写进 `x-forwarded-for`，宿主 A 原样转发。这里只在「直连对端
// 确实是回环」（即一定来自宿主 / B）时才信这个头，否则退回直连对端 —— 远端客户端不能自己
// 决定压不压。
function requestPeerAddress(request) {
  const direct = request.socket?.remoteAddress ?? null;
  if (!isLoopbackAddress(direct)) return direct;
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === 'string') {
    const first = raw.split(',')[0].trim();
    if (first !== '') return first;
  }
  return direct;
}

function acceptedEncodings(header) {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const quality = new Map();
  for (const part of raw.split(',')) {
    const [tokenRaw, ...params] = part.split(';');
    const token = tokenRaw.trim().toLowerCase();
    if (token === '') continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (match) q = Number(match[1]);
    }
    quality.set(token, q);
  }
  return quality;
}

function pickCompressionEncoding(header) {
  const quality = acceptedEncodings(header);
  if (quality === null) return null;
  const accepts = (name) => (quality.has(name) ? quality.get(name) : (quality.get('*') ?? 0));
  // 优先 brotli，其次 gzip；两者都不接受就直传。
  for (const name of ['br', 'gzip']) if (accepts(name) > 0) return name;
  return null;
}

// 每个请求一份的压缩计划：非回环客户端才 `enabled`。
function compressionPlan(request) {
  const peer = requestPeerAddress(request);
  return {
    peer,
    clientLoopback: isLoopbackAddress(peer),
    enabled: COMPRESS_ENABLED && !isLoopbackAddress(peer),
    encoding: pickCompressionEncoding(request.headers['accept-encoding']),
    minBytes: COMPRESS_MIN_BYTES,
    maxBytes: COMPRESS_MAX_BYTES,
    ifNoneMatch: request.headers['if-none-match'] ?? null,
  };
}

function ifNoneMatchMatches(header, etag) {
  if (typeof header !== 'string') return false;
  const raw = header.trim();
  if (raw === '') return false;
  if (raw === '*') return true;
  const bare = (value) => value.trim().replace(/^W\//, '');
  return raw.split(',').some((candidate) => candidate.trim() !== '' && bare(candidate) === bare(etag));
}

function compressBytes(buffer, encoding) {
  if (encoding === 'br') {
    return brotliCompressSync(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: COMPRESS_BROTLI_QUALITY } });
  }
  return gzipSync(buffer, { level: COMPRESS_GZIP_LEVEL });
}

// 一份响应体的压缩结果：`entry`（正文缓存条目）在场就顺带缓存，第二次不再重压。
// 一份响应体的压缩结果。缓存语义是 **(versionKey, encoding)**：
// 正文条目（`entry`，键 = versionKey）里单独存 `compressed: Map<encoding, Buffer>`，
// **不压的那份 `entry.body` 与任何编码的压缩字节各占一个槽、互不顶掉**。
function compressedBodyFor(entry, body, encoding, label) {
  const hit = entry?.compressed?.get(encoding);
  if (hit) {
    if (compressDiagnostics()) console.log(`[compress-cache] hit ${label} ${encoding} ${hit.length}B`);
    return hit;
  }
  const source = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const startedAt = Date.now();
  const out = compressBytes(source, encoding);
  if (compressDiagnostics()) {
    console.log(`[compress-cache] miss ${label} ${encoding} ${source.length}B -> ${out.length}B in ${Date.now() - startedAt}ms`);
  }
  if (entry && typeof entry.rememberCompressed === 'function') entry.rememberCompressed(encoding, out);
  return out;
}

function compressDiagnostics() {
  return process.env.SOPHO_COMPRESS_DIAGNOSTICS === '1';
}

// 所有 JSON/文本响应的唯一出口：在这里决定压不压、算不算 304、头怎么改对。
// 判据（两条一起才压）：① 客户端**非回环**；② 体积 ≥ 下限且 ≤ 上限；③ content-type 在白名单里。
function writeResponseBody(response, statusCode, body, {
  contentType,
  cacheControl = 'no-store',
  contentLength = null,
  etag = null,
  entry = null,
  label = 'json',
} = {}) {
  if (response.destroyed || response.headersSent) return;
  const plan = response.sophoCompression ?? null;
  const bytes = contentLength ?? Buffer.byteLength(body);
  const compressible = plan !== null && plan.enabled && isCompressibleContentType(contentType);
  const headers = {
    'content-type': contentType,
    ...(cacheControl === null ? {} : { 'cache-control': cacheControl }),
    // 同一 URL 会因为 accept-encoding 给不同表示：即使这次没压（回环/太小），也要声明。
    ...(plan === null ? {} : { vary: 'accept-encoding' }),
    ...(etag ? { etag } : {}),
  };

  // 304：版本没变 ⇒ 只回头、零传输（回环客户端也一样适用；没有正文，也就没有压缩一说）。
  if (etag && ifNoneMatchMatches(plan?.ifNoneMatch ?? null, etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }

  if (compressible && plan.encoding && bytes >= plan.minBytes && bytes <= plan.maxBytes) {
    const compressed = compressedBodyFor(entry, body, plan.encoding, label);
    response.writeHead(statusCode, {
      ...headers,
      'content-encoding': plan.encoding,
      'content-length': compressed.length,
    });
    response.end(compressed);
    return;
  }
  response.writeHead(statusCode, { ...headers, 'content-length': bytes });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  if (response.destroyed || response.headersSent) return;
  writeResponseBody(response, statusCode, `${JSON.stringify(value)}\n`, {
    contentType: 'application/json; charset=utf-8',
    label: 'json',
  });
}

// 已经序列化好的 body（与 sendJson 产出的字节**完全相同**）：缓存命中时不必再 stringify 一遍。
// `entry` 是正文缓存条目（`/messages` 用）：带它就能把压缩结果也缓存下来。
function sendJsonText(response, statusCode, body, contentLength = null, options = {}) {
  writeResponseBody(response, statusCode, body, {
    contentType: 'application/json; charset=utf-8',
    contentLength,
    ...options,
  });
}

async function readJsonWithSize(request, { maxBytes = 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'body_too_large', `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return { value: {}, size: 0 };
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), size };
  } catch (error) {
    throw new HttpError(400, 'invalid_json', 'request body must be valid JSON', normalizeError(error).message);
  }
}

async function readJson(request, { maxBytes = 1024 * 1024 } = {}) {
  return (await readJsonWithSize(request, { maxBytes })).value;
}

function requireFullSessionId(value) {
  if (!FULL_UUID.test(value || '')) {
    throw new HttpError(400, 'full_uuid_required', `session id must be a full UUID; prefixes are not accepted: ${value || '(empty)'}`);
  }
  return value.toLowerCase();
}

function requireText(value, field = 'text') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `invalid_${field}`, `${field} must be a non-empty string`);
  }
  return value;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 图片块（`docs/session-format.md:57-61`：`ImageContent { type:'image', data(base64), mimeType }`）。
// 修前 wire 把图片块**静默丢掉**：`contentText()` 只收 `type==='text'`，`parts` 只映射
// text/thinking/toolCall ⇒ 一条**只有图片**的消息（截图粘进会话就是这个形状）被投影成
// `text === ''` —— 又一种空壳（M-31 的服务端那一半）。
// 这里在 wire 上**另加一份元数据**：`images: [{ mimeType, bytes }]`（解码后的字节数），并把占位行
// 拼进 `text`，让「只有图片」的消息**不再有空 text**。
// ⚠️ 不说谎：image 的 base64 `data` **仍然按既有语义原样留在 `wire.content` 里**
// （修前就是这样，这次不动）—— 那是前端将来 `<img src="data:...">` 要用的原文
// （`docs/tui-parity.md` M-31 的完整做法）。`images` 是给人/前端算大小用的**派生物**，
// 不替代 `content`。
function imageBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'image')
    .map((block) => ({
      mimeType: typeof block.mimeType === 'string' ? block.mimeType : null,
      bytes: typeof block.data === 'string' ? Buffer.byteLength(block.data, 'base64') : null,
    }));
}

/** `contentText` + 图片占位行：**保证有图片时 text 非空**（不留空壳），且与结构化 `images` 一致。 */
function contentTextWithImages(content) {
  const text = contentText(content);
  const images = imageBlocks(content);
  if (images.length === 0) return text;
  const marker = images
    .map((image) => `[图片：${image.mimeType ?? '类型未知'}，${image.bytes === null ? '字节数未知' : `${image.bytes} 字节`}（网页暂不显示图片内容）]`)
    .join('\n');
  return text === '' ? marker : `${text}\n${marker}`;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Only the container signature: this is **not** a claim that fully decoding the image is safe. */
function sniffImageMime(buffer) {
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

function imageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png') {
    if (buffer.length < 24 || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 2 <= buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) return null;
      const marker = buffer[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9) return null;
      if (offset + 2 > buffer.length) return null;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
      if (JPEG_SOF_MARKERS.has(marker)) {
        if (segmentLength < 7) return null;
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += segmentLength;
    }
    return null;
  }
  return null;
}

/**
 * Strict image field parser for `/message` and `/steer`.
 * Base64 must be canonical; the declared mime must match the container signature; decoded
 * bytes and dimensions are bounded. Pixel decode itself is the provider's job — we do not
 * pretend this proves a full decode is safe, only that the container header/bytes are sane.
 */
function parseImageField(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid_images', 'images must be an array');
  if (value.length > MAX_IMAGES_PER_MESSAGE) {
    throw new HttpError(413, 'too_many_images', `at most ${MAX_IMAGES_PER_MESSAGE} images are allowed per message`, { max: MAX_IMAGES_PER_MESSAGE, count: value.length });
  }
  return value.map((item, index) => {
    if (!plainObject(item)) throw new HttpError(400, 'invalid_images', `images[${index}] must be an object`, { index });
    const { mimeType, data } = item;
    if (typeof mimeType !== 'string' || !IMAGE_MIME_TYPES.has(mimeType)) {
      throw new HttpError(415, 'unsupported_image_type', `images[${index}].mimeType must be one of ${[...IMAGE_MIME_TYPES].join(', ')}`, { index, mimeType: mimeType ?? null, allowed: [...IMAGE_MIME_TYPES] });
    }
    if (typeof data !== 'string' || data === '') {
      throw new HttpError(400, 'invalid_image_data', `images[${index}].data must be a non-empty base64 string`, { index });
    }
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new HttpError(400, 'invalid_image_data', `images[${index}].data must be canonical base64 without a data: prefix`, { index, reason: 'base64' });
    }
    const decoded = Buffer.from(data, 'base64');
    if (decoded.length === 0 || decoded.toString('base64') !== data) {
      throw new HttpError(400, 'invalid_image_data', `images[${index}].data must be canonical base64 without a data: prefix`, { index, reason: 'base64' });
    }
    if (decoded.length > MAX_IMAGE_BYTES) {
      throw new HttpError(413, 'image_too_large', `images[${index}] is ${decoded.length} decoded bytes; the limit is ${MAX_IMAGE_BYTES}`, { index, bytes: decoded.length, maxBytes: MAX_IMAGE_BYTES });
    }
    const detected = sniffImageMime(decoded);
    if (detected === null) {
      throw new HttpError(400, 'invalid_image_data', `images[${index}] is not a PNG or JPEG container`, { index, reason: 'not_an_image', mimeType });
    }
    if (detected !== mimeType) {
      throw new HttpError(400, 'invalid_image_data', `images[${index}].mimeType is ${mimeType} but the container is ${detected}`, { index, reason: 'magic_mismatch', mimeType, detected });
    }
    const size = imageDimensions(decoded, mimeType);
    if (!size || size.width <= 0 || size.height <= 0) {
      throw new HttpError(400, 'invalid_image_data', `images[${index}] has no readable ${mimeType} dimensions`, { index, reason: 'invalid_container' });
    }
    if (size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION || size.width * size.height > MAX_IMAGE_PIXELS) {
      throw new HttpError(413, 'image_too_large', `images[${index}] is ${size.width}x${size.height}; limits are ${MAX_IMAGE_DIMENSION}px per side and ${MAX_IMAGE_PIXELS} pixels`, {
        index, reason: 'dimensions', width: size.width, height: size.height, maxDimension: MAX_IMAGE_DIMENSION, maxPixels: MAX_IMAGE_PIXELS,
      });
    }
    return { type: 'image', mimeType, data };
  });
}

/** `/message` and `/steer`: text optional only when an image is present; old `{text}` behaviour stays. */
async function readMessageInput(request) {
  const { value, size } = await readJsonWithSize(request, { maxBytes: MEDIA_REQUEST_MAX_BYTES });
  const images = parseImageField(value.images);
  if (images.length === 0 && size > TEXT_REQUEST_MAX_BYTES) {
    throw new HttpError(413, 'body_too_large', `request body exceeds ${TEXT_REQUEST_MAX_BYTES} bytes`);
  }
  let text;
  if (value.text === undefined) {
    if (images.length === 0) throw new HttpError(400, 'invalid_text', 'text must be a non-empty string');
    text = '';
  } else {
    if (typeof value.text !== 'string') throw new HttpError(400, 'invalid_text', 'text must be a non-empty string');
    if (images.length === 0 && value.text.trim() === '') throw new HttpError(400, 'invalid_text', 'text must be a non-empty string');
    text = value.text;
  }
  if (Buffer.byteLength(text, 'utf8') > TEXT_REQUEST_MAX_BYTES) {
    throw new HttpError(413, 'body_too_large', `text exceeds ${TEXT_REQUEST_MAX_BYTES} bytes`);
  }
  return { text, images };
}

function finiteUsageField(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizedUsage(raw) {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const present = plainObject(raw) && fields.every((field) => finiteUsageField(raw[field]));
  const known = present && fields.some((field) => raw[field] > 0);
  if (!known) {
    return {
      status: 'unknown',
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      raw: raw ?? null,
      note: UNKNOWN_USAGE_NOTE,
    };
  }
  return {
    status: 'known',
    input: raw.input,
    output: raw.output,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    raw,
    note: null,
  };
}

function routerModelId(modelId) {
  return typeof modelId === 'string' && /(?:^|[-_/.])(?:auto|autorouter|router)(?:$|[-_/.])/i.test(modelId);
}

function assistantModel(message) {
  if (message?.role !== 'assistant') return null;
  const provider = typeof message.provider === 'string' ? message.provider : null;
  const requestedId = typeof message.model === 'string' ? message.model : null;
  const responseId = typeof message.responseModel === 'string' ? message.responseModel : null;
  const id = responseId || requestedId;
  if (!provider && !id) return null;
  return {
    provider,
    id,
    requestedId,
    responseId,
    routed: Boolean(responseId && requestedId && responseId !== requestedId),
    display: [provider, id].filter(Boolean).join('/'),
  };
}

function costFromRates(rates, usage) {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let selected = rates;
  let matchedThreshold = -1;
  for (const tier of rates?.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      selected = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  if (!selected || !['input', 'output', 'cacheRead', 'cacheWrite'].every((field) => finiteUsageField(selected[field]))) return null;
  const cost = {
    input: (selected.input / 1_000_000) * usage.input,
    output: (selected.output / 1_000_000) * usage.output,
    cacheRead: (selected.cacheRead / 1_000_000) * usage.cacheRead,
    cacheWrite: (selected.cacheWrite / 1_000_000) * usage.cacheWrite,
  };
  return { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite };
}

function recordedCost(raw) {
  const cost = raw?.cost;
  if (!plainObject(cost) || !['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every((field) => finiteUsageField(cost[field]))) return null;
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    total: cost.total,
  };
}

function assistantObservability(message, models) {
  const model = assistantModel(message);
  const usage = normalizedUsage(message?.usage);
  const metadata = model?.provider && model?.id ? models?.getModel(model.provider, model.id) : null;
  const requestedMetadata = !metadata && model?.provider && model?.requestedId ? models?.getModel(model.provider, model.requestedId) : null;
  const router = routerModelId(model?.requestedId) || routerModelId(model?.id);
  const responsePricingAssumed = Boolean(model?.responseId && !metadata && requestedMetadata);
  const costBasis = router || responsePricingAssumed || (!metadata && !requestedMetadata) ? 'assumed' : 'metadata';
  if (usage.status === 'unknown') {
    return {
      model,
      usage,
      cost: { status: 'unknown', input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
      costEstimated: true,
      costBasis,
      costNote: `${COST_ESTIMATE_NOTE} Cost cannot be estimated while usage is unknown.`,
    };
  }

  const fromMetadata = costFromRates((metadata ?? requestedMetadata)?.cost, usage);
  const recorded = recordedCost(message?.usage);
  const cost = model?.responseId && metadata ? (fromMetadata ?? recorded) : (recorded ?? fromMetadata);
  const costNote = router
    ? `${COST_ESTIMATE_NOTE} Router model pricing is approximate and may underestimate higher routing tiers.`
    : responsePricingAssumed
      ? `${COST_ESTIMATE_NOTE} Response-model metadata was unavailable; requested-model metadata was used as an assumption.`
      : fromMetadata
        ? `${COST_ESTIMATE_NOTE} Calculated from pi model metadata.`
        : `${COST_ESTIMATE_NOTE} Model metadata was unavailable; using pi's recorded cost fields as an assumption.`;
  return {
    model,
    usage,
    cost: cost ? { status: 'estimated', ...cost } : { status: 'unknown', input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
    costEstimated: true,
    costBasis,
    costNote,
  };
}

function sessionObservability(manager, models) {
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const costTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const seenModels = new Map();
  let knownRounds = 0;
  let unknownRounds = 0;
  let knownAuxiliary = 0;
  let unknownAuxiliary = 0;
  let estimatedCostOperations = 0;
  let unknownCostOperations = 0;
  let assumedCost = false;
  let lastTurn = null;

  const addUsage = (usage) => {
    for (const field of Object.keys(usageTotals)) usageTotals[field] += usage[field];
  };
  const addCost = (cost) => {
    for (const field of Object.keys(costTotals)) costTotals[field] += cost[field];
  };

  for (const entry of manager.getEntries()) {
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      const observed = assistantObservability(entry.message, models);
      lastTurn = observed;
      if (observed.model?.display) seenModels.set(observed.model.display, observed.model);
      if (observed.usage.status === 'known') {
        knownRounds += 1;
        addUsage(observed.usage);
      } else {
        unknownRounds += 1;
      }
      if (observed.cost.status === 'estimated') {
        estimatedCostOperations += 1;
        addCost(observed.cost);
        if (observed.costBasis === 'assumed') assumedCost = true;
      } else {
        unknownCostOperations += 1;
      }
      continue;
    }

    const auxiliaryUsage = entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.usage !== undefined
      ? entry.message.usage
      : (entry.type === 'branch_summary' || entry.type === 'compaction')
        ? entry.usage
        : undefined;
    if (auxiliaryUsage === undefined && entry.type !== 'branch_summary' && entry.type !== 'compaction') continue;
    const usage = normalizedUsage(auxiliaryUsage);
    const cost = usage.status === 'known' ? recordedCost(auxiliaryUsage) : null;
    if (usage.status === 'known') {
      knownAuxiliary += 1;
      addUsage(usage);
    } else {
      unknownAuxiliary += 1;
    }
    if (cost) {
      estimatedCostOperations += 1;
      addCost(cost);
      assumedCost = true;
    } else {
      unknownCostOperations += 1;
    }
  }

  const knownOperations = knownRounds + knownAuxiliary;
  const unknownOperations = unknownRounds + unknownAuxiliary;
  const usageStatus = knownOperations === 0 ? 'unknown' : unknownOperations > 0 ? 'partial' : 'known';
  const costStatus = estimatedCostOperations === 0 ? 'unknown' : unknownCostOperations > 0 ? 'partial' : 'estimated';
  const cumulativeCostBasis = estimatedCostOperations === 0 ? (lastTurn?.costBasis ?? 'assumed') : assumedCost ? 'assumed' : 'metadata';
  const unknownUsageParts = [
    ...(unknownRounds > 0 ? [`${unknownRounds} assistant round(s)`] : []),
    ...(unknownAuxiliary > 0 ? [`${unknownAuxiliary} auxiliary operation(s)`] : []),
  ];
  return {
    lastTurn,
    cumulative: {
      models: [...seenModels.values()],
      rounds: { known: knownRounds, unknown: unknownRounds },
      auxiliary: { known: knownAuxiliary, unknown: unknownAuxiliary },
      usage: {
        status: usageStatus,
        ...(knownOperations > 0 ? usageTotals : { input: null, output: null, cacheRead: null, cacheWrite: null }),
        note: unknownOperations > 0 ? `${unknownUsageParts.join(' and ')} have unknown usage and are not counted as zero.` : null,
      },
      cost: {
        status: costStatus,
        ...(estimatedCostOperations > 0 ? costTotals : { input: null, output: null, cacheRead: null, cacheWrite: null, total: null }),
      },
      costEstimated: true,
      costBasis: cumulativeCostBasis,
      costNote: `${COST_ESTIMATE_NOTE}${cumulativeCostBasis === 'assumed' ? ' At least one operation uses assumed/router pricing.' : ' Calculated from pi model metadata.'}`,
    },
  };
}

function jsonLocation(text, error) {
  const position = Number(normalizeError(error).message.match(/position\s+(\d+)/i)?.[1]);
  if (!Number.isInteger(position)) return null;
  const before = text.slice(0, position);
  const lines = before.split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function configError(code, file, detail, location = null) {
  const suffix = location ? ` at line ${location.line}, column ${location.column}` : '';
  return new HttpError(500, code, `${file} is invalid${suffix}: ${detail}`, {
    file,
    detail,
    ...(location ? location : {}),
  });
}

function devicesConfigError(file, detail, location = null) {
  return configError('devices-config-invalid', file, detail, location);
}

function placementConfigError(file, detail, location = null) {
  return configError('placement-config-invalid', file, detail, location);
}

function validatePlacementConfig(value, file) {
  if (!plainObject(value)) throw placementConfigError(file, 'top level must be an object keyed by full session UUID');
  for (const [sessionId, placement] of Object.entries(value)) {
    if (!FULL_UUID.test(sessionId)) throw placementConfigError(file, `key must be a full session UUID: ${JSON.stringify(sessionId)}`);
    if (!plainObject(placement)) throw placementConfigError(file, `placement ${sessionId} must be an object`);
    for (const field of Object.keys(placement)) {
      if (!PLACEMENT_FIELDS.has(field)) throw placementConfigError(file, `placement ${sessionId} has unknown field ${JSON.stringify(field)}`);
    }
    for (const field of PLACEMENT_FIELDS) {
      if (!Object.hasOwn(placement, field)) throw placementConfigError(file, `placement ${sessionId} is missing field ${JSON.stringify(field)}`);
    }
    if (!PLACEMENT_KINDS.has(placement.kind)) throw placementConfigError(file, `placement ${sessionId} kind must be "dir", "scratch", or "device"`);
    if (typeof placement.cwd !== 'string' || !path.isAbsolute(placement.cwd) || path.resolve(placement.cwd) !== placement.cwd) {
      throw placementConfigError(file, `placement ${sessionId} cwd must be a normalized absolute path`);
    }
    if (placement.device !== null && typeof placement.device !== 'string') throw placementConfigError(file, `placement ${sessionId} device must be a string or null`);
    if (placement.scratchRoot !== null && (typeof placement.scratchRoot !== 'string' || !path.isAbsolute(placement.scratchRoot) || path.resolve(placement.scratchRoot) !== placement.scratchRoot)) {
      throw placementConfigError(file, `placement ${sessionId} scratchRoot must be a normalized absolute path or null`);
    }
    if (placement.claimedBy !== null && !FULL_UUID.test(placement.claimedBy)) throw placementConfigError(file, `placement ${sessionId} claimedBy must be a full session UUID or null`);
    if (!Number.isInteger(placement.at) || placement.at < 0) throw placementConfigError(file, `placement ${sessionId} at must be a non-negative integer`);
    if (placement.kind === 'scratch' && placement.scratchRoot === null) throw placementConfigError(file, `placement ${sessionId} scratch kind requires scratchRoot`);
    if (placement.kind !== 'scratch' && placement.scratchRoot !== null) throw placementConfigError(file, `placement ${sessionId} non-scratch kind requires scratchRoot:null`);
    if (placement.kind === 'device' && placement.device === null) throw placementConfigError(file, `placement ${sessionId} device kind requires device`);
    if (placement.kind !== 'device' && placement.device !== null) throw placementConfigError(file, `placement ${sessionId} non-device kind requires device:null`);
  }
  return value;
}

async function readPlacementConfig(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: {} };
    throw placementConfigError(file, `cannot read file: ${normalizeError(error).message}`);
  }
  const jsonText = text.startsWith('\uFEFF') ? text.slice(1) : text;
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    throw placementConfigError(file, normalizeError(error).message, jsonLocation(jsonText, error));
  }
  return { exists: true, value: validatePlacementConfig(value, file) };
}

function validateLastProbe(value, file, name) {
  if (value === undefined || value === null) return;
  if (!plainObject(value)) throw devicesConfigError(file, `device ${JSON.stringify(name)} lastProbe must be an object or null`);
  const allowed = new Set(['at', 'ok', 'uname', 'error']);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw devicesConfigError(file, `device ${JSON.stringify(name)} lastProbe has unknown field ${JSON.stringify(field)}`);
  }
  if (!Number.isInteger(value.at) || value.at < 0) throw devicesConfigError(file, `device ${JSON.stringify(name)} lastProbe.at must be a non-negative integer`);
  if (typeof value.ok !== 'boolean') throw devicesConfigError(file, `device ${JSON.stringify(name)} lastProbe.ok must be boolean`);
  if (value.uname !== null && typeof value.uname !== 'string') throw devicesConfigError(file, `device ${JSON.stringify(name)} lastProbe.uname must be a string or null`);
  if (value.error !== null && typeof value.error !== 'string') throw devicesConfigError(file, `device ${JSON.stringify(name)} lastProbe.error must be a string or null`);
  if (value.ok && value.error !== null) throw devicesConfigError(file, `device ${JSON.stringify(name)} successful lastProbe.error must be null`);
  if (!value.ok && (typeof value.error !== 'string' || value.error.trim() === '')) {
    throw devicesConfigError(file, `device ${JSON.stringify(name)} failed lastProbe.error must be a non-empty string`);
  }
}

function validateDevicesConfig(value, file) {
  if (!plainObject(value)) throw devicesConfigError(file, 'top level must be an object keyed by device name');
  for (const [name, device] of Object.entries(value)) {
    if (name.trim() === '' || name.includes('/') || name.includes('\0')) {
      throw devicesConfigError(file, `invalid device name ${JSON.stringify(name)}`);
    }
    if (!plainObject(device)) throw devicesConfigError(file, `device ${JSON.stringify(name)} must be an object`);
    for (const field of Object.keys(device)) {
      if (!DEVICE_FIELDS.has(field)) throw devicesConfigError(file, `device ${JSON.stringify(name)} has unknown field ${JSON.stringify(field)}`);
    }
    if (typeof device.host !== 'string' || !DEVICE_HOST.test(device.host)) {
      throw devicesConfigError(file, `device ${JSON.stringify(name)} host must match ${DEVICE_HOST}`);
    }
    if (device.user !== undefined && (typeof device.user !== 'string' || !DEVICE_USER.test(device.user))) {
      throw devicesConfigError(file, `device ${JSON.stringify(name)} user must match ${DEVICE_USER}`);
    }
    if (device.user !== undefined && device.host.includes('@')) {
      throw devicesConfigError(file, `device ${JSON.stringify(name)} must not set user when host already contains @`);
    }
    if (!DEVICE_MODES.has(device.mode)) throw devicesConfigError(file, `device ${JSON.stringify(name)} mode must be "tools" or "session"`);
    if (!Number.isInteger(device.addedAt) || device.addedAt < 0) {
      throw devicesConfigError(file, `device ${JSON.stringify(name)} addedAt must be a non-negative integer`);
    }
    if (device.repoHints !== undefined && (!Array.isArray(device.repoHints)
      || device.repoHints.some((hint) => typeof hint !== 'string' || hint.trim() === '' || hint.includes('\0')))) {
      throw devicesConfigError(file, `device ${JSON.stringify(name)} repoHints must be an array of non-empty strings`);
    }
    if (device.cwdRoot !== undefined && (typeof device.cwdRoot !== 'string' || device.cwdRoot.trim() === '' || device.cwdRoot.includes('\0'))) {
      throw devicesConfigError(file, `device ${JSON.stringify(name)} cwdRoot must be a non-empty string`);
    }
    if (device.note !== undefined && typeof device.note !== 'string') {
      throw devicesConfigError(file, `device ${JSON.stringify(name)} note must be a string`);
    }
    validateLastProbe(device.lastProbe, file, name);
  }
  return value;
}

async function readDevicesConfig(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: {} };
    throw devicesConfigError(file, `cannot read file: ${normalizeError(error).message}`);
  }
  const jsonText = text.startsWith('\uFEFF') ? text.slice(1) : text;
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    throw devicesConfigError(file, normalizeError(error).message, jsonLocation(jsonText, error));
  }
  return { exists: true, value: validateDevicesConfig(value, file) };
}

// ── 原子 JSON 写：rename 有界重试 ────────────────────────────────────────────────────────
// Windows 上 rename 的目标文件被**短暂**占用（杀软实时扫描、索引器、别人刚打开的读句柄）会抛
// EPERM/EBUSY/EACCES；这类瞬时错误值得退避重试，其余（ENOENT/EINVAL/ENOSPC…）照旧立刻抛。
// 每次重试只**重新 rename 同一个临时文件**（不重建：重建会把半个文件留在原地），最终才 unlink。
// 最终失败抛定型 AtomicWriteError（带 file/code/attempts），好让上层如实回执 ——
// 2026-09-21 事故：这里裸抛 EPERM 让「会话其实已建成」被回报成 500。
const ATOMIC_WRITE_RENAME_ATTEMPTS = 5;
const ATOMIC_WRITE_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ATOMIC_WRITE_RETRY_DELAY_MS = 50;

class AtomicWriteError extends Error {
  constructor(file, code, attempts, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? '');
    super(`atomic write to ${file} failed after ${attempts} rename attempt(s): ${code ?? 'UNKNOWN'}${detail ? ` (${detail})` : ''}`);
    this.name = 'AtomicWriteError';
    this.file = file;
    this.code = code ?? null;
    this.attempts = attempts;
    if (cause !== undefined) this.cause = cause;
  }

  toJSON() {
    return { file: this.file, code: this.code, attempts: this.attempts, message: this.message };
  }
}

// 测试专用故障注入（生产不设 ⇒ 零影响）：SOPHO_FAULT_ATOMIC_RENAME=<CODE>:<COUNT>[:<basename>]
// ⇒ 让前 COUNT 次（可只匹配某个 basename 的）rename 抛给定 code，用来在沙箱里证明
// 「重试确实在」与「已建成的会话不许被回报成 500」。计划只在第一次 rename 时解析一次。
let atomicRenameFaultPlan;
function atomicRenameFaultFor(file) {
  if (atomicRenameFaultPlan === undefined) {
    atomicRenameFaultPlan = null;
    const spec = process.env.SOPHO_FAULT_ATOMIC_RENAME;
    if (spec) {
      const [code, countText, basename] = String(spec).split(':');
      const count = Number(countText);
      if (code && Number.isInteger(count) && count > 0) {
        atomicRenameFaultPlan = { code, remaining: count, basename: basename || null };
      }
    }
  }
  const plan = atomicRenameFaultPlan;
  if (!plan || plan.remaining <= 0) return null;
  if (plan.basename && path.basename(file) !== plan.basename) return null;
  plan.remaining -= 1;
  return plan.code;
}

// 同口径的另一支注入：`SOPHO_FAULT_SEAL_HOLD_BEFORE_RENAME_MS=<MS>[:<sessionId>]`
// ⇒ 把封存的「并发写者核验通过 → rename」这一段**撑开** MS 毫秒（给了 sessionId 就只对那条会话生效）。
// 那一段正是「**另一个写者**在整份替换同一个文件的窗口里挤进来」的那个窗口 —— 门里用它把并发臂
// （`test/session-seal.mjs` 的 G10）从「靠时序撞」变成确定性的：归档在独占段里时撑开多久都不红，
// 归档被挪回段外（`SOPHO_FAULT_ARCHIVE_UNLOCKED=1`）时必红。生产不设 ⇒ 这一段就是**零等待**。
let sealCommitHoldPlan;
async function sealCommitHoldBeforeRename(sessionId) {
  if (sealCommitHoldPlan === undefined) {
    sealCommitHoldPlan = null;
    const spec = process.env.SOPHO_FAULT_SEAL_HOLD_BEFORE_RENAME_MS;
    if (spec) {
      const [msText, target] = String(spec).split(':');
      const ms = Number(msText);
      if (Number.isFinite(ms) && ms > 0) sealCommitHoldPlan = { ms, sessionId: target ? target.toLowerCase() : null };
    }
  }
  const plan = sealCommitHoldPlan;
  if (!plan || (plan.sessionId !== null && plan.sessionId !== sessionId)) return;
  await delay(plan.ms);
}

// 同口径的另一支注入：`SOPHO_FAULT_ARCHIVE_HOT_GAP_MS=<MS>[:<sessionId>]`
// ⇒ 把归档「查 cwd → 写」这一步**撑开** MS 毫秒（给了 sessionId 就只对那条会话生效）。
// 这一段正是（**旧形状**下）封存能收掉那个 handle 的调度级空档：把「查 cwd ＋ 写」并进同一次
// `runExclusive` 之后，这一等就落在独占段**里面**（封存的 `dispose()` 必须 `await #operationQueue`
// ⇒ 等它结束），撑开多久都不再有缝。门里用它把并发臂（`test/session-seal.mjs` 的 G11 / R-G11）
// 从「靠时序撞」变成确定性的。生产不设 ⇒ 这一段就是**零等待**。
let archiveHotGapPlan;
async function archiveHotGapHold(sessionId) {
  if (archiveHotGapPlan === undefined) {
    archiveHotGapPlan = null;
    const spec = process.env.SOPHO_FAULT_ARCHIVE_HOT_GAP_MS;
    if (spec) {
      const [msText, target] = String(spec).split(':');
      const ms = Number(msText);
      if (Number.isFinite(ms) && ms > 0) archiveHotGapPlan = { ms, sessionId: target ? target.toLowerCase() : null };
    }
  }
  const plan = archiveHotGapPlan;
  if (!plan || (plan.sessionId !== null && plan.sessionId !== sessionId)) return;
  await delay(plan.ms);
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteBytes(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

/**
 * 原子写**字节**（temp + fsync + `rename`；`rename` 的故障注入 / 有界重试与上面同一套）。
 * 为什么封存必须用它：热文件是**同一个 id、同一条路径**上的原地替换，读者里另有一堆**按偏移**读的
 * （`/tree` 的索引扫描、`/export`）—— 实测只有 `temp + rename` 能让打开着的 fd 留在旧 inode 上，
 * 于是每个读者拿到的永远是**某一份完整版本**；`truncate + write` 会给出一份旧文件前缀的半成品（§9.6）。
 * 临时名以 `.tmp` 结尾（不是 `.jsonl`）⇒ 它**不会**被会话目录扫描当成第二条会话。
 * 返回 `temporary`（写好了但**还没** rename 的那一份）：调用方自己决定什么时候换上去
 * （封存要先落冷段、再换热文件，中途失败才能原样退回）。
 */
async function writeAtomicTemp(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await unlink(temporary); } catch {}
    throw error;
  }
  return temporary;
}

async function commitAtomicTemp(temporary, file) {
  let lastCode = null;
  let lastError = null;
  for (let attempt = 1; attempt <= ATOMIC_WRITE_RENAME_ATTEMPTS; attempt += 1) {
    try {
      const injected = atomicRenameFaultFor(file);
      if (injected) {
        const fault = new Error(`fault injection: rename ${temporary} -> ${file}`);
        fault.code = injected;
        throw fault;
      }
      await rename(temporary, file);
      return;
    } catch (error) {
      lastError = error;
      lastCode = error?.code ?? null;
      if (!ATOMIC_WRITE_RETRY_CODES.has(lastCode)) {
        try { await unlink(temporary); } catch {}
        throw error;
      }
      if (attempt === ATOMIC_WRITE_RENAME_ATTEMPTS) break;
      await delay(ATOMIC_WRITE_RETRY_DELAY_MS);
    }
  }
  try { await unlink(temporary); } catch {}
  throw new AtomicWriteError(file, lastCode, ATOMIC_WRITE_RENAME_ATTEMPTS, lastError);
}

async function atomicWriteBytes(file, bytes) {
  const temporary = await writeAtomicTemp(file, bytes);
  await commitAtomicTemp(temporary, file);
}

// 测试专用故障注入（生产不设 ⇒ 零影响），与上面 `SOPHO_FAULT_ATOMIC_RENAME` 同一口径：
//   `SOPHO_FAULT_NO_WORKER_REPLY=<COUNT>[:<METHOD>[:<PATH-PREFIX>]]`
// 让前 COUNT 发（可只匹配某个方法 / 路径前缀的）请求**没有上游回话** —— 在写出任何字节之前把连接
// 掐掉。宿主那边看到的就是 `reached === false`（`proxyToWorker` 的 `upstreamRequest` 报错）
// ⇒ 这一发必然走 `finishFailedProxy` 那条收尾：幂等 GET/HEAD 换当前代**重试一次**；写请求**不重试**、
// 回可重试语义（`503 generation_swapped` + `Retry-After: 1`）。
// 为什么要有它：那条路原来只能靠「按精确 pid 把 owner SIGSTOP 住再 SIGKILL」摆
//（`test/fallback-proxy-retry.mjs`），而 Windows 没有 SIGSTOP ⇒ 那条口径在 Windows 上根本没有门。
// 这个注入把同一个口径变成**确定性**的（与平台无关，不靠时序竞态），见
// `test/swap-window-injected.mjs`。计划只在第一次用时解析一次。
let noWorkerReplyFaultPlan;
function noWorkerReplyFaultFor(request) {
  if (noWorkerReplyFaultPlan === undefined) {
    noWorkerReplyFaultPlan = null;
    const spec = process.env.SOPHO_FAULT_NO_WORKER_REPLY;
    if (spec) {
      const [countText, method, pathPrefix] = String(spec).split(':');
      const count = Number(countText);
      if (Number.isInteger(count) && count > 0) {
        noWorkerReplyFaultPlan = { remaining: count, method: (method || '').toUpperCase() || null, pathPrefix: pathPrefix || null };
      }
    }
  }
  const plan = noWorkerReplyFaultPlan;
  if (!plan || plan.remaining <= 0) return false;
  if (plan.method && String(request.method || '').toUpperCase() !== plan.method) return false;
  if (plan.pathPrefix && !String(request.url || '').startsWith(plan.pathPrefix)) return false;
  plan.remaining -= 1;
  return true;
}

// 第二个同口径的注入：`SOPHO_FAULT_LIVE_FACTS_DOWN=<COUNT>` ⇒ 让前 COUNT 次 `liveSessionFacts()` 抛。
// 宿主侧的 `callWorker({type:'live-facts'})` 会收到 `{type:'error'}` 回执 ⇒ `allLiveSessionFacts()`
// 把它统一包成 `503 live_facts_unavailable` + `details.retryable` ⇒ 守卫路（`/move`·`/handoff`·
// `session_new`·子会话创建）**确定地**回「答不上来 + 可重试 + `Retry-After: 1`」，
// 不用 SIGSTOP、不用把 worker 暂停、也不用把死线拧成 0 去赌一个 0ms 定时器与一次 IPC 往返的先后。
// 它证明的是**真**语义（worker 确实答不上），不是伪造一个响应。
let liveFactsDownFaultRemaining;
function liveFactsDownFaultFires() {
  if (liveFactsDownFaultRemaining === undefined) {
    liveFactsDownFaultRemaining = null;
    const count = Number(process.env.SOPHO_FAULT_LIVE_FACTS_DOWN);
    if (Number.isInteger(count) && count > 0) liveFactsDownFaultRemaining = count;
  }
  if (liveFactsDownFaultRemaining === null || liveFactsDownFaultRemaining <= 0) return false;
  liveFactsDownFaultRemaining -= 1;
  return true;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function deviceTarget(device) {
  return device.user ? `${device.user}@${device.host}` : device.host;
}

function sshError(name, target, command, error, timeoutMs) {
  const failure = normalizeError(error);
  if (failure.name === 'AbortError' || failure.code === 'ABORT_ERR') {
    return `device ${name} (${target}) probe timed out after ${timeoutMs}ms while running ${command}`;
  }
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const detail = stderr || failure.message;
  return `device ${name} (${target}) probe failed while running ${command}: ${detail}`;
}

async function sshReadOnly(name, target, command, timeoutMs) {
  try {
    const { stdout } = await execFileAsync('ssh', ['--', target, command], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      signal: AbortSignal.timeout(timeoutMs),
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(sshError(name, target, command, error, timeoutMs));
  }
}

async function sshRun(target, command, { timeoutMs, maxBytes }) {
  return await new Promise((resolve, reject) => {
    const child = spawn('ssh', ['--', target, command], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const collect = () => ({ chunks: [], bytes: 0, truncated: false });
    const stdout = collect();
    const stderr = collect();
    // Keep an exact prefix of maxBytes and keep counting the rest, so truncation is
    // measured (how many bytes really arrived) instead of guessed.
    const absorb = (sink) => (chunk) => {
      if (sink.bytes < maxBytes) {
        const remaining = maxBytes - sink.bytes;
        sink.chunks.push(remaining >= chunk.length ? chunk : chunk.subarray(0, remaining));
      }
      sink.bytes += chunk.length;
      if (sink.bytes > maxBytes) sink.truncated = true;
    };
    child.stdout.on('data', absorb(stdout));
    child.stderr.on('data', absorb(stderr));
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), RUN_KILL_GRACE_MS);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    child.once('error', (error) => { finish(); reject(error); });
    child.once('close', (code) => {
      finish();
      resolve({
        timedOut,
        exitCode: timedOut ? null : code,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
      });
    });
  });
}

function deviceRoots(device) {
  return [...new Set([device.cwdRoot, ...(device.repoHints ?? [])].filter((root) => typeof root === 'string' && root !== ''))];
}

function pathUnder(root, target) {
  return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`);
}

// A device's cwd is either a remote path already (~/... under a declared root) or a local path
// that we can translate. Anything ambiguous refuses instead of guessing a remote path.
function translateDeviceCwd(name, device, requested) {
  const roots = deviceRoots(device);
  const declared = roots.length > 0
    ? `device ${name} declares roots ${roots.map((root) => JSON.stringify(root)).join(', ')}`
    : `device ${name} declares no cwdRoot/repoHints`;
  if (requested === undefined || requested === null) {
    return { local: null, remote: roots[0] ?? null, rule: roots.length > 0 ? 'device-default-root' : 'no-root' };
  }
  if (typeof requested !== 'string' || requested.trim() === '' || requested.includes('\0')) {
    throw new HttpError(400, 'invalid_cwd', 'cwd must be a non-empty string without NUL bytes');
  }
  if (requested.startsWith('~')) {
    const root = roots.find((candidate) => pathUnder(candidate, requested));
    if (!root) {
      throw new HttpError(400, 'cwd_not_mapped', `cannot map remote cwd ${JSON.stringify(requested)}: ${declared}; pass a path under a declared root`);
    }
    return { local: null, remote: requested, rule: `remote path under declared root ${JSON.stringify(root)}` };
  }
  const local = path.resolve(requested);
  const mirrored = roots.find((root) => pathUnder(root, local));
  if (mirrored) return { local, remote: local, rule: `mirrored declared root ${JSON.stringify(mirrored)}` };
  const sessionCwd = path.resolve(process.cwd());
  if (pathUnder(sessionCwd, local)) {
    if (roots.length !== 1) {
      throw new HttpError(400, 'cwd_not_mapped', `cannot map cwd ${JSON.stringify(local)}: ${declared}; translating the session directory needs exactly one declared root`);
    }
    return {
      local,
      remote: path.posix.join(roots[0], path.relative(sessionCwd, local)),
      rule: `session-relative path under declared root ${JSON.stringify(roots[0])}`,
    };
  }
  throw new HttpError(400, 'cwd_not_mapped', `cannot map cwd ${JSON.stringify(local)}: ${declared}, and it is not inside the session directory ${JSON.stringify(sessionCwd)}; refusing to guess a remote path`);
}

async function probeDevice(name, device, requestedPath, timeoutMs) {
  const target = deviceTarget(device);
  const gitPath = requestedPath ?? device.cwdRoot ?? device.repoHints?.[0] ?? null;
  if (gitPath !== null && (typeof gitPath !== 'string' || gitPath.trim() === '' || gitPath.includes('\0'))) {
    throw new HttpError(400, 'invalid_path', 'path must be a non-empty string without NUL bytes');
  }
  let uname = null;
  const git = { repo: null, branch: null, dirty: null };
  try {
    uname = await sshReadOnly(name, target, 'uname -a', timeoutMs);
    if (uname === '') throw new Error(`device ${name} (${target}) returned an empty uname`);
    if (gitPath !== null) {
      const cwd = shellQuote(gitPath);
      git.repo = await sshReadOnly(name, target, `git -C ${cwd} rev-parse --show-toplevel`, timeoutMs);
      git.branch = await sshReadOnly(name, target, `git -C ${cwd} branch --show-current`, timeoutMs) || null;
      git.dirty = (await sshReadOnly(name, target, `git -C ${cwd} status --porcelain`, timeoutMs)).length > 0;
    }
    return { name, host: device.host, user: device.user ?? null, target, mode: device.mode, path: gitPath, ok: true, uname, git, error: null };
  } catch (error) {
    return { name, host: device.host, user: device.user ?? null, target, mode: device.mode, path: gitPath, ok: false, uname, git, error: normalizeError(error).message };
  }
}

function latestArchiveState(entries) {
  let present = false;
  let archived = false;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== ARCHIVE_ENTRY) continue;
    present = true;
    archived = entry.data?.archived === true;
  }
  return { present, archived };
}

function archiveValue(entries, legacyArchived = false) {
  const latest = latestArchiveState(entries);
  return latest.present ? latest.archived : legacyArchived;
}

// —— 「压缩即封存」（反装版）的**纯函数层** ——
// 形状与判据：`docs/design-session-seal.md`（反装 = **同一个 id 的同一个文件被裁剪**成
// `[头] + [摘要] + [kept] + [tail]`，被裁掉的那一段另起一个**新 id** 落成归档件；
// 原 id / 身份机器一个字不动）。本文件只做三件纯事：找切点、定「要搬什么」、把两份文件拼出来。
//
// 两个**必须照做**的硬事实（上一轮实验，`docs/design-session-seal.md` §9 有原始输出）：
//   · 热文件必须**自己带上**叶路径上的 `thinking_level_change` 与 `session_info`：这两条在真样本里
//     正好都住在冷段（下标 1 / 2、8）⇒ 不搬就**静默降档**（wire 上 `reasoning_effort` high→medium，
//     `messages` 逐字相同）与**丢名字**（`/tree` 行 `name:null`，下一条消息还会把它改成 seed）；
//   · **kept 段不能省**（省 ⇒ `/messages` 少条目、prompt 少一截而 pi 一声不咽）。

// 自动封存的「等第一个真空闲时刻」：上界 8 次 × 250 ms（≈ 2 s）—— 超过就是真忙，如实记日志、不再重试。
const SEAL_AUTO_ATTEMPTS = 8;
const SEAL_AUTO_RETRY_MS = 250;

/** 会话条目 id：pi 的 `generateId` 形状（8 位 hex）+ 文件内唯一性校验（重复 id ⇒ `byId` 被盖）。 */
function sealEntryId(taken) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    if (!taken.has(id)) return id;
  }
  throw new Error('cannot allocate a unique seal entry id');
}

/**
 * 按行拆一份会话文件：`raw` = 逐字那一行（含行尾的 `\r`，但**不含** `\n`）、`entry` = 解析后的对象。
 * 保留 `raw` 是故意的：搬走的条目必须**逐字节**还是原来那一行（`id` 序列逐字不变是标注/游标的依赖，
 * 旧文档已验；重新序列化会把手改过的空格/键序也一起改掉）。
 * 坏行 / 末尾没有换行 ⇒ 返回 `null`（调用方如实拒绕：抽掉坏行 = 静默丢数据）。
 */
function sealLines(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) break;
    const raw = text.slice(start, newline);
    if (raw.trim() !== '') {
      try {
        lines.push({ raw, entry: JSON.parse(raw.replace(/\r$/, '')) });
      } catch {
        return null;
      }
    }
    start = newline + 1;
  }
  if (text.slice(start).trim() !== '') return null; // 末尾半行（没写完）：不猜
  return lines;
}

/** 一串条目（`{entry}` 或裸 entry）里「叶路径上的设置与名字」：取**最后一次出现**（线性会话 ⇒ 当下值）。 */
function sealLeafSettings(items) {
  const settings = { thinkingLevel: null, name: null, archived: null, archivedPresent: false };
  for (const item of items) {
    const entry = item?.entry ?? item;
    if (!entry) continue;
    if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') settings.thinkingLevel = entry.thinkingLevel;
    else if (entry.type === 'session_info') settings.name = typeof entry.name === 'string' ? entry.name : null;
    else if (entry.type === 'custom' && entry.customType === ARCHIVE_ENTRY) {
      settings.archivedPresent = true;
      settings.archived = entry.data?.archived === true;
    }
  }
  return settings;
}

/**
 * 「未答问题随热尾巴搬家」—— `sopho.question` 这一族条目的**按需补**（与 `sealLeafSettings` 同一处同一口径）。
 *
 * 为什么必须有这一条：`sopho.question` 是 append-only 的**状态机**（现状由 `op` 序列折叠出来，见
 * `questionStates`），而问题路由（`questionEntriesFor`）读的是**热文件**（runtime 或按热文件打开的 manager）。
 * 一条**未答**问题的条目若整段落在被裁段（冷段）里 ⇒ 封存之后它只在冷段文件里 ⇒
 * **热会话的问题清单里再也没有它**（用户看不见自己的未答问题，也答不了）。这不改变任何历史：冷段仍然是
 * 一份正常可读的会话，它只是**不在**热会话的那张清单上。
 *
 * 判据与 `sealLeafSettings` 同一套（**按需补、不重复补**），只是这里比的是「折叠出来的现状」：
 *   · 只搬**未答**（`status === 'open'`）的 id；**已答 / 已关留在冷段**（档案就是历史，不搬到热文件里来）；
 *   · 热文件里折叠出来的现状已经与源那份给用户看的字段**逐字段相同** ⇒ 不补；
 *   · 要补就把**该 id 的整条条目序列**照抄过去（顺序照旧）—— `questionStates` 每个字段都是「文件里最后一次
 *     出现说了算」⇒ 只有整条序列落在同一个文件里，折叠结果才等于源那份的现状。
 *     （只搬冷段里那几条会折出一个**从来没有过的现状**：`ask` 在冷段、`update` 在热尾巴时，照抄的 `ask`
 *     排在文件末尾会把题面/背景/`askedAt` 又盖回旧值 —— 所以是整条序列，不是半段。）
 *
 * 返回**源里那些条目对象本身**（`item.entry`）；调用方负责换新 id、把父指针接到**链上的叶** ——
 * 照抄原 `id`/`parentId` 会把 pi 的叶指针接到冷段里已经不在这份文件里的条目上（R11 的失败现场：上下文当场塌掉）。
 */
function sealOpenQuestions(sourceItems, hotItems) {
  const fold = (items) => questionStates(items.map((item) => item?.entry ?? item).filter((entry) => entry !== null && entry !== undefined));
  const source = fold(sourceItems);
  const retained = fold(hotItems);
  const groups = [];
  for (const [id, state] of source.states) {
    if (state.status !== 'open') continue; // 已答 / 已关：留在冷段
    const already = retained.states.get(id) ?? null;
    if (already && JSON.stringify(questionFacts(already)) === JSON.stringify(questionFacts(state))) continue; // 已经在热文件里、现状一致 ⇒ 不重复补
    const entries = sourceItems
      .map((item) => item?.entry ?? item)
      .filter((entry) => entry?.type === 'custom' && entry.customType === QUESTION_ENTRY && entry.data?.id === id);
    if (entries.length > 0) groups.push({ id, status: state.status, at: state.askedAt ?? null, entries });
  }
  return groups;
}

/**
 * 从**最后一条**往上走 `parentId`，得到叶路径。
 * 两个允许/不允许的口径（本件只对「一条单链」做封存）：
 *   · 路径**必须盖住文件里全部正文条目**（每条恰好一次）—— 分支/游离条目一律拒绕（形状没验过）；
 *   · **根可以是悬垂的**（`parentId` 指着不在本文件里的条目）：这正是**封存后的形状**（kept 的头一条
 *     的父指针指着冷段里的那条），而 `pi` 本来就容忍它（`docs/design-session-seal.md` §1.2 已验）。
 * 返回 `null` = 不是一条单链（环 / 悬在中间 / 有游离条目）。
 */
function sealPathOf(body) {
  const byId = new Map();
  for (const item of body) if (typeof item.entry?.id === 'string') byId.set(item.entry.id, item);
  const path = [];
  const seen = new Set();
  let current = body[body.length - 1];
  while (current) {
    if (seen.has(current)) return null; // 环
    seen.add(current);
    path.push(current);
    const parentId = current.entry?.parentId ?? null;
    current = parentId === null ? null : byId.get(parentId);
  }
  if (path.length !== body.length) return null; // 还有条目没被这条链盖住（分支 / 游离）
  path.reverse();
  return path;
}

/**
 * 切点。**只受理一条单链**的会话（见 `sealPathOf`）——本件只验过那个形状。
 * 命名照 `docs/design-session-seal.md` §1.1（线性文件上它就是文件下标）：
 * `C` = 选中的那条 compaction 在链上的下标，`K` = 它的 `firstKeptEntryId` 在链上的下标
 * ⇒ 冷段 = `path[0..K-1]`、kept = `path[K..C-1]`、tail = `path[C+1..]`。
 *
 * **边界可以显式给**（业主 2026-09-22 的追加要求）：一条**老会话**可能永远不会再压缩 ⇒ 要能
 * 「用**已有的那一次**压缩的边界补做一次封存」。所以这里不是「只从刚发生的那次压缩取边界」：
 *   · `compactionEntryId` —— 用**这一条** compaction 条目（收据里如实回报它）；
 *   · `firstKeptEntryId` —— 直接点名边界 ⇒ 取**最后一条** `firstKeptEntryId` 与它相同的 compaction
 *     条目（同一个边界可能有不止一条摘要，取最新那条）；
 *   · 两个都给 ⇒ 必须一致，不一致就拒绕（`boundary_mismatch`，不猜谁对）；
 *   · 两个都不给（默认）⇒ 链上**最后一条** compaction 条目（= 现状；自动触发走的是这条）。
 * 三种选法都落到同一个 `{C, K}` ⇒ 下游只有一条实现，**不是两套机制**。
 */
function sealPlanOf(lines, { compactionEntryId = null, firstKeptEntryId = null } = {}) {
  const header = lines[0]?.entry ?? null;
  if (!header || header.type !== 'session' || typeof header.id !== 'string') return { ok: false, reason: 'not_a_session_file' };
  const path = sealPathOf(lines.slice(1));
  if (path === null) return { ok: false, reason: 'session_not_a_single_path' };
  if (path.length === 0) return { ok: false, reason: 'empty_session' };
  let C = -1;
  if (compactionEntryId !== null) {
    C = path.findIndex((item) => item.entry?.id === compactionEntryId);
    if (C < 0) return { ok: false, reason: 'compaction_entry_missing', detail: { compactionEntryId } };
    if (path[C].entry?.type !== 'compaction') return { ok: false, reason: 'not_a_compaction_entry', detail: { compactionEntryId, type: path[C].entry?.type ?? null } };
  } else if (firstKeptEntryId !== null) {
    for (let index = path.length - 1; index >= 0; index -= 1) {
      if (path[index].entry?.type === 'compaction' && path[index].entry?.firstKeptEntryId === firstKeptEntryId) { C = index; break; }
    }
    if (C < 0) return { ok: false, reason: 'boundary_not_found', detail: { firstKeptEntryId } };
  } else {
    for (let index = path.length - 1; index >= 0; index -= 1) {
      if (path[index].entry?.type === 'compaction') { C = index; break; }
    }
  }
  if (C < 0) return { ok: false, reason: 'no_compaction' };
  const compactionItem = path[C];
  const compaction = compactionItem.entry;
  const boundary = typeof compaction.firstKeptEntryId === 'string' ? compaction.firstKeptEntryId : null;
  // 显式给的那个边界必须与选中那条 compaction 条目自己的边界一致 —— 不一致就是调用方看错了那条摘要，
  // 这时候**不能猜**（猜错就是拿 B 的摘要去盖 A 的那一段历史）。
  if (firstKeptEntryId !== null && compactionEntryId !== null && boundary !== firstKeptEntryId) {
    return { ok: false, reason: 'boundary_mismatch', detail: { compactionEntryId, entryFirstKeptEntryId: boundary, requestedFirstKeptEntryId: firstKeptEntryId } };
  }
  const K = boundary === null ? -1 : path.findIndex((item) => item.entry?.id === boundary);
  if (K < 0) return { ok: false, reason: 'first_kept_entry_missing', detail: { firstKeptEntryId: boundary } };
  const cold = path.slice(0, K);
  // 幂等：冷段里必须至少有一条**不是 compaction** 的条目。
  // 它就是「同一回合压两次 / 连着封存两次不许出重复冷段」的机械拓手：封过一次之后链上是
  // `[kept, 摘要, tail]`（`K = 0`）⇒ 冷段只剩那条摘要 ⇒ 再封一次会把摘要搬走、再造一个冷 id。
  // 所以这里先报「没什么可封的」（比 `first_kept_after_compaction` 准确得多）。
  if (!cold.some((item) => item.entry?.type !== 'compaction')) {
    return { ok: false, reason: 'nothing_to_seal', detail: { cold: cold.length, kept: path.length - K, C, K } };
  }
  if (K > C) return { ok: false, reason: 'first_kept_after_compaction', detail: { K, C } };
  return {
    ok: true,
    header: lines[0],
    path,
    C,
    K,
    compaction,
    compactionItem,
    cold,
    kept: path.slice(K, C),
    tail: path.slice(C + 1),
    settings: sealLeafSettings(path),
    // 收据里要说清「这条边界是谁给的」：显式点名 / 默认取链上最后那条摘要。
    boundarySource: compactionEntryId !== null || firstKeptEntryId !== null ? 'explicit' : 'last-compaction',
    boundaryRequest: { compactionEntryId, firstKeptEntryId },
  };
}

/** 把一份条目列表拼成文件字节（每行一条，每行末尾一个 `\n`；与 pi 自己写的形状一致）。 */
function sealBytes(items) {
  return Buffer.from(items.map((item) => {
    // 手滑写出一行没有原始字节的东西（例如把裸 entry 当成 `{raw, entry}` 混进来）⇒ 那一行会是
    // 字面量 `undefined`，而 pi 的读取器**跳过坏行**（静默丢一条 entry、链在那一处断掉）。
    // 所以在**写盘之前**就大声拒绕 —— 这类损坏必须成不了成品。
    if (typeof item?.raw !== 'string' || item.raw === '') throw new Error('seal: refusing to serialise a session line with no raw bytes (it would corrupt the session file)');
    return `${item.raw}\n`;
  }).join(''), 'utf8');
}

// —— 问题队列（manager toolkit P0）的纯函数层 ——
// 现状由 `op` 序列推出：有 ask 无 answer/close = 未答；有 answer = 已答；有 close = 已关。
// 与归档一致：**不修改历史条目，只追加**；`ask` 的 dedupeKey 是"不许重复问"的机械抓手。
const QUESTION_STATUSES = new Set(['open', 'answered', 'all']);
const QUESTION_ID_PATTERN = /^q-[0-9a-f]{8}$/;
const QUESTION_PRIORITIES = new Set(['normal', 'high']);
const QUESTION_BY = new Set(['agent', 'user']);
const QUESTION_LIMIT_DEFAULT = 50;
const QUESTION_LIMIT_MAX = 200;
const QUESTION_OPTIONS_MAX = 20;
const QUESTION_OPTION_MAX_CHARS = 200;
const QUESTION_TEXT_MAX_CHARS = 4000;
// `context` = 「判断这条问题所需的事实」（业主 dogfood 后拍板：问题页上不许只剩「一句话 + 两个选项」）。
// 为什么做成**必填 + 服务端 400** 而不是只靠提示词：用户看不到模型的 thinking，问题页上只有这一条 ——
// 事实不写进条目，用户就没法判断（`docs/questions-context-gap.md` 的 7 条真实例子）。
// 阈值/措辞属于**工具契约**（`docs/manager-toolkit-plan.md` §2/§3）：40 字是在「一句话本身就不足以判断」上定的。
const QUESTION_CONTEXT_MIN_CHARS = 40;
const QUESTION_CONTEXT_MAX_CHARS = 4000;
const QUESTION_CONTEXT_HINT = [
  'ask 必须带 `context`：用户看不到你的 thinking，问题页上只有这一条 —— 判断所需的事实必须写在里面。',
  `context 是一个字符串，至少 ${QUESTION_CONTEXT_MIN_CHARS} 个字；写清：为什么问、你已经查到的关键数字/结论、当前在做哪条工作线、每个候选各意味着什么代价。`,
  '合格示例：context="清理 Downloads：子会话 dry-run 已回，494 条合计 376.41 GB，全部在顶层、无重复；A 组纯日志 202.6 GB 零风险，B/C 中的日志部分约 358.6 GB，A+B+C 608 GB 风险高。当前主线是先清零风险的日志。"，'
    + 'text="Downloads 清理范围定哪一档？"，options=["只删 A 组（纯日志，202.6 GB，零风险）", ...]。',
].join(' ');

/** 去重抓手：文本归一化（trim + 折空白 + 小写）后的 sha1 前 12 位。 */
function questionDedupeKey(text) {
  return createHash('sha1').update(text.trim().replace(/\s+/gu, ' ').toLowerCase()).digest('hex').slice(0, 12);
}

function newQuestionId() {
  return `q-${randomUUID().replace(/-/gu, '').slice(0, 8)}`;
}

function questionOptions(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid_options', 'options must be an array of non-empty strings, or null');
  if (value.length > QUESTION_OPTIONS_MAX) throw new HttpError(400, 'invalid_options', `options must have at most ${QUESTION_OPTIONS_MAX} entries`);
  const options = value.map((option, index) => {
    if (typeof option !== 'string' || option.trim() === '') throw new HttpError(400, 'invalid_options', `options[${index}] must be a non-empty string`);
    if (option.length > QUESTION_OPTION_MAX_CHARS) throw new HttpError(400, 'invalid_options', `options[${index}] is longer than ${QUESTION_OPTION_MAX_CHARS} characters`);
    return option;
  });
  return options.length === 0 ? null : options;
}

function questionPriority(value) {
  if (value === undefined || value === null) return 'normal';
  if (typeof value !== 'string' || !QUESTION_PRIORITIES.has(value)) throw new HttpError(400, 'invalid_priority', 'priority must be "normal" or "high"');
  return value;
}

/**
 * `context` 的校验（**只**在 ask 这条路上调用；answer/close 一律不受影响）。
 * 缺失 / 不是字符串 / 过短 ⇒ 400 `question_needs_context`，`message` 自解释且可执行（自带合格示例）。
 * ⚠️ 这是**对既有调用方的破坏性变更**（裸 POST `{text,options}` 的脚本会被 400 打断）：
 * 报错必须能把「缺什么、该写什么」讲回来，契约写在 `docs/manager-toolkit-plan.md` §2/§3。
 * 存储时**原样保留**（不 trim、不折行）—— 多行背景要能逐字带出来。
 */
function questionContext(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'question_needs_context', QUESTION_CONTEXT_HINT, { field: 'context', minChars: QUESTION_CONTEXT_MIN_CHARS });
  if (value.trim().length < QUESTION_CONTEXT_MIN_CHARS) {
    throw new HttpError(400, 'question_needs_context', `${QUESTION_CONTEXT_HINT}（这次给的长度 ${value.trim().length}，要求至少 ${QUESTION_CONTEXT_MIN_CHARS}）`, { field: 'context', minChars: QUESTION_CONTEXT_MIN_CHARS, actualChars: value.trim().length });
  }
  if (value.length > QUESTION_CONTEXT_MAX_CHARS) throw new HttpError(400, 'invalid_context', `context must be at most ${QUESTION_CONTEXT_MAX_CHARS} characters`);
  return value;
}

// —— 卡片级反馈（annotations，`docs/design-annotations.md` v1）的纯函数层 ——
// 与问题看板**分开存**（标注不是要人回答的问题）：落 `$ASSIST_HOME/annotations.jsonl`，append-only、
// 一行一条 JSON，与 `handoffs.jsonl` 同族。这里只放校验与坏行容错；读写（带路径）在 createLogic 里。
const ANNOTATION_KINDS = new Set(['message', 'toolResult']);
const ANNOTATION_NOTE_MAX_CHARS = 2000;
const ANNOTATION_EXCERPT_MAX_CHARS = 200;
const ANNOTATION_FIELD_MAX_CHARS = 128;
const ANNOTATION_BLOCK_INDEX_MAX = 100000;
// 到上限**只警告不删**（append-only 底线不破，`docs/design-annotations.md` §5）。
const ANNOTATION_FILE_LIMIT = 500;
const ANNOTATION_ID_PATTERN = /^an-[0-9a-f]{8}$/;
// appVersion 是 B（静态 app，`server/app.mjs:15` 的 `APP_SOURCE_VERSION`）的源码版本；
// codeVersion 是这份逻辑 worker 的代际 id（`/ping` 的 `logicVersion`）。两者都**由服务端补**，
// 客户端发来的同名字段一律忽略（客户端不能伪造时间与版本）。B 的常量在逻辑层 import 不到
//（import `server/app.mjs` 会真的把那个静态服务器起起来）⇒ 这里留一份同值常量并注明出处。
const ANNOTATION_APP_VERSION = 's0b-v1';

function newAnnotationId() {
  return `an-${randomUUID().replace(/-/gu, '').slice(0, 8)}`;
}

/** 可空字符串字段：空串/缺省 ⇒ null（**不编**）；类型不对或过长 ⇒ 400。 */
function annotationOptionalString(value, field, { max = ANNOTATION_FIELD_MAX_CHARS } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, `invalid_${field}`, `${field} must be a string or null`);
  const text = value.trim();
  if (text === '') return null;
  if (text.length > max) throw new HttpError(400, `invalid_${field}`, `${field} must be at most ${max} characters`);
  return text;
}

/** `excerpt` = 人可见内容的前若干字（id 变了也能认出是哪一条）。拿不到 ⇒ null，**绝不编**。 */
function annotationExcerpt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_excerpt', 'excerpt must be a string or null');
  const text = value.trim();
  if (text === '') return null;
  if (text.length > ANNOTATION_EXCERPT_MAX_CHARS) {
    throw new HttpError(400, 'invalid_excerpt', `excerpt must be at most ${ANNOTATION_EXCERPT_MAX_CHARS} characters`);
  }
  return text;
}

function annotationBlockIndex(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > ANNOTATION_BLOCK_INDEX_MAX) {
    throw new HttpError(400, 'invalid_block_index', `blockIndex must be an integer between 0 and ${ANNOTATION_BLOCK_INDEX_MAX} or null`);
  }
  return value;
}

/** `POST /annotations` 的校验与记录构造（纯函数：不落盘）。合法 ⇒ 返回待落盘的一条；
 *  不合法 ⇒ 诚实 400（带 code 与说人话的 message）。`at`/`appVersion`/`codeVersion`/`state`/`id`
 *  在这里由服务端补 —— 客户端只发 `{note, kind, sessionId, messageId, blockIndex, toolCallId?, role?, excerpt}`。 */
function buildAnnotation(body, { logicVersion }) {
  if (!plainObject(body)) throw new HttpError(400, 'invalid_body', 'request body must be a JSON object');
  const note = requireText(body.note, 'note');
  if (note.length > ANNOTATION_NOTE_MAX_CHARS) {
    throw new HttpError(400, 'invalid_note', `note must be at most ${ANNOTATION_NOTE_MAX_CHARS} characters`);
  }
  if (typeof body.kind !== 'string' || !ANNOTATION_KINDS.has(body.kind)) {
    throw new HttpError(400, 'invalid_kind', 'kind must be "message" or "toolResult"');
  }
  return {
    id: newAnnotationId(),
    at: new Date().toISOString(),
    note,
    kind: body.kind,
    sessionId: requireFullSessionId(body.sessionId),
    messageId: annotationOptionalString(body.messageId, 'messageId'),
    blockIndex: annotationBlockIndex(body.blockIndex),
    toolCallId: annotationOptionalString(body.toolCallId, 'toolCallId'),
    toolName: annotationOptionalString(body.toolName, 'toolName'),
    role: annotationOptionalString(body.role, 'role'),
    excerpt: annotationExcerpt(body.excerpt),
    appVersion: ANNOTATION_APP_VERSION,
    codeVersion: logicVersion ?? null,
    state: 'open',
    resolvedAt: null,
    resolvedBy: null,
  };
}

/** `?since=` 的解析：ISO 时间戳 或 毫秒 epoch。拿不准就 400（**不猜**）。 */
function annotationSince(value) {
  if (value === null || value === undefined || value === '') return null;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
    throw new HttpError(400, 'invalid_since', `since must be an ISO timestamp or epoch milliseconds: ${value}`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new HttpError(400, 'invalid_since', `since must be an ISO timestamp or epoch milliseconds: ${value}`);
  return parsed;
}

/** 到上限只警告不删（append-only 底线不破）。`lines` = 文件实际行数（标注行 + resolve 事件行）。 */
function annotationCapWarning(total, lines = null) {
  if (total < ANNOTATION_FILE_LIMIT) return null;
  const lineNote = Number.isInteger(lines) ? `，文件共 ${lines} 行（标注行 + resolve 事件行）` : '';
  return `annotations.jsonl 已有 ${total} 条标注${lineNote}（上限 ${ANNOTATION_FILE_LIMIT}）：append-only 底线不破，服务端只警告、不删任何一条；请人工归档/轮转这个文件。`;
}

// —— v1.5「维护者」：open ⇒ done 的状态流转（append-only，旧行一个字都不改）——
// 先例：`POST /sessions/{id}/questions` 那套 —— **一层路径 + body 里带 `op`**，读侧把同 id 的
// 事件行**折**成现状（`questionStates()`）。这里同构：
//   · 创建行（v1 写的，**没有** `op`；或写了 `op:'annotate'`）⇒ `state:'open'`；
//   · `{op:'resolve', id, at, by}` ⇒ 该 id `state:'done'`，记 `resolvedAt`/`resolvedBy`。
// resolve **不改任何旧行**、也不改创建行的字段 —— 只追加一行事件（`docs/design-annotations.md` §1/§6）。
const ANNOTATION_STATES = new Set(['all', 'open', 'done']);
const ANNOTATION_OPS = new Set(['annotate', 'resolve']);
const ANNOTATION_RESOLVE_BY_MAX_CHARS = 128;

/** 读侧把行折成「每条标注的现状」：认不出的 `op`、对不上任何 id 的 resolve 行
 *  （文件被人工轮转/截断后可能出现）都**如实计数**，不假装没看见、也不悄悄改写历史。 */
function annotationStates(items) {
  const states = new Map();
  const order = [];
  const unknown = [];
  const orphans = [];
  let resolveEvents = 0;
  let duplicates = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const line = index + 1;
    const op = typeof item.op === 'string' ? item.op : 'annotate';
    if (op === 'resolve') {
      resolveEvents += 1;
      const id = typeof item.id === 'string' && ANNOTATION_ID_PATTERN.test(item.id) ? item.id : null;
      const state = id === null ? null : states.get(id);
      if (!state) { orphans.push({ line, id: id ?? (typeof item.id === 'string' ? item.id : null) }); continue; }
      state.eventCount += 1;
      state.resolveCount += 1;
      // **第一次** resolve 定现状（谁先标的、什么时候）；再来的只计数，不改它。
      if (state.state !== 'done') {
        state.state = 'done';
        state.resolvedAt = typeof item.at === 'string' ? item.at : null;
        state.resolvedBy = typeof item.by === 'string' ? item.by : null;
      }
      continue;
    }
    if (op !== 'annotate') { unknown.push({ line, op }); continue; }
    const id = typeof item.id === 'string' ? item.id : null;
    if (id === null || !ANNOTATION_ID_PATTERN.test(id)) { unknown.push({ line, op: 'annotate', id }); continue; }
    if (states.has(id)) { duplicates += 1; continue; }
    states.set(id, {
      id,
      at: typeof item.at === 'string' ? item.at : null,
      note: typeof item.note === 'string' ? item.note : null,
      kind: typeof item.kind === 'string' ? item.kind : null,
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : null,
      messageId: typeof item.messageId === 'string' ? item.messageId : null,
      blockIndex: Number.isInteger(item.blockIndex) ? item.blockIndex : null,
      toolCallId: typeof item.toolCallId === 'string' ? item.toolCallId : null,
      toolName: typeof item.toolName === 'string' ? item.toolName : null,
      role: typeof item.role === 'string' ? item.role : null,
      excerpt: typeof item.excerpt === 'string' ? item.excerpt : null,
      appVersion: typeof item.appVersion === 'string' ? item.appVersion : null,
      codeVersion: typeof item.codeVersion === 'string' ? item.codeVersion : null,
      // `state` 只看事件：创建行里自己写的 `state` 不算数（服务端写它时恒为 'open'）。
      state: 'open',
      resolvedAt: null,
      resolvedBy: null,
      resolveCount: 0,
      eventCount: 1,
      line,
    });
    order.push(id);
  }
  return { states, order, unknown, orphans, duplicates, resolveEvents };
}

/** 折好的现状 ⇒ 线上形状（与 v1 的落盘形状同构：既有读取面一个字不用改），另加事件计数。 */
function annotationWire(state) {
  return {
    id: state.id, at: state.at, note: state.note, kind: state.kind, sessionId: state.sessionId,
    messageId: state.messageId, blockIndex: state.blockIndex, toolCallId: state.toolCallId,
    toolName: state.toolName, role: state.role, excerpt: state.excerpt,
    appVersion: state.appVersion, codeVersion: state.codeVersion,
    state: state.state, resolvedAt: state.resolvedAt, resolvedBy: state.resolvedBy,
    resolveCount: state.resolveCount, eventCount: state.eventCount,
  };
}

/** `POST /annotations {op:'resolve', id, by?}`（也接设计文档 §1 那条 `POST /annotations/{id}/resolve`）
 *  的 id / by / note 校验（纯函数：不落盘、不读盘）。 */
function buildAnnotationResolve(body) {
  if (!plainObject(body)) throw new HttpError(400, 'invalid_body', 'request body must be a JSON object');
  if (typeof body.id !== 'string' || !ANNOTATION_ID_PATTERN.test(body.id)) {
    throw new HttpError(400, 'invalid_annotation_id', `id must look like an-<8 hex>: ${body.id ?? '(missing)'}`);
  }
  const by = annotationOptionalString(body.by, 'by', { max: ANNOTATION_RESOLVE_BY_MAX_CHARS });
  // 可选的「处理说明」（与创建行的 `note` 同一个上限，允许写一句
  // “改了哪里/为什么这么处理”，留在这条事件行里）。
  const note = body.note === undefined || body.note === null || body.note === ''
    ? null
    : annotationOptionalString(body.note, 'note', { max: ANNOTATION_NOTE_MAX_CHARS });
  return { id: body.id, by, note };
}

// —— 卡片级反馈的「到达即知道」：配置 ＋ 事件 ＋ 唤醒消息（业主 2026-09-22 拍的 ②）——
// 形状与取舍见 `docs/design-annotations.md` §8。三层：
//   ① **配置**：`annotations.notifySession`（服务端权威的 ui 设置，`GET/PATCH /settings`）——
//      谁是维护者会话；**空串 = 不通知**（退回 v1.5 的现状：维护者自己读文件/端点）。
//   ② **事件**：给那个会话发一条 `session.annotation`（载荷 = 这一批的**完整条目**）。
//   ③ **唤醒**：光发事件对**空闲**会话没用（空闲没有订阅者）⇒ 再给它投一条**自解释的消息**
//      （`customType:'sopho.annotation'`、`display:true`、`triggerTurn`）—— 与问题看板的回答同一条路
//      （回答也是作为一条消息投进会话并触发一轮）。
// 合并/防抖：窗口内到达的多条合并成**一条**消息（正文说「共 N 条」）；同一批只发一次（幂等）。
const ANNOTATION_NOTIFY_DEFAULT_WINDOW_MS = 30_000;
// 待发批次的上限：只影响**内存里的待发队列**（账本 `annotations.jsonl` 一个字都不动 ⇒ 不会丢数据，
// 只是这一批里最早的几条不会进这条通知消息）。到了就如实记一条日志。
const ANNOTATION_NOTIFY_MAX_PENDING = 200;
const ANNOTATION_NOTIFY_LOG = '[annotations] ';

/** `SOPHO_ANNOTATION_NOTIFY_WINDOW_MS`（合并窗口，默认 30s）——**只给门提供短的窗口**，
 *  值不合法就**如实回退到默认值**并记一条日志（旋钮不是用户数据，不为此拒绝启动）。 */
function annotationNotifyWindowMs(rawValue = process.env.SOPHO_ANNOTATION_NOTIFY_WINDOW_MS) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return { windowMs: ANNOTATION_NOTIFY_DEFAULT_WINDOW_MS, warning: null };
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0 || value > 3_600_000) {
    return {
      windowMs: ANNOTATION_NOTIFY_DEFAULT_WINDOW_MS,
      warning: `SOPHO_ANNOTATION_NOTIFY_WINDOW_MS=${JSON.stringify(rawValue)} 不是 0..3600000 的整数 ⇒ 用默认 ${ANNOTATION_NOTIFY_DEFAULT_WINDOW_MS}ms`,
    };
  }
  return { windowMs: value, warning: null };
}

/** 一条标注的锚点，写成一行给人看的事实（拿不到就写「还没落盘」，**不编**）。 */
function annotationAnchorLine(item) {
  const parts = [
    `messageId=${item.messageId ?? '(无：这条卡还没有稳定 id)'}`,
    `blockIndex=${Number.isInteger(item.blockIndex) ? item.blockIndex : '(无)'}`,
  ];
  if (item.toolCallId) parts.push(`toolCallId=${item.toolCallId}`);
  if (item.toolName) parts.push(`toolName=${item.toolName}`);
  if (item.role) parts.push(`role=${item.role}`);
  return parts.join(' ');
}

/**
 * 唤醒消息的正文（**纯函数**，门逐字断言它）：必须自解释 —— 说清「有新的卡片反馈」、
 * 每条 id/note/锚点，以及**该做什么**（读 `GET /annotations`、处理完 `POST /annotations {op:'resolve'}`）。
 */
function annotationNotifyText(items, { maintainerSessionId }) {
  const lines = [];
  lines.push(`【卡片反馈】网页上有新的标注（反馈）需要维护者处理，共 ${items.length} 条。`);
  lines.push('这条消息是服务端在标注到达后自动投的（不是人在打字）：把你叫起来是为了让你读并处理这批反馈。');
  lines.push('');
  items.forEach((item, index) => {
    const kindLabel = item.kind === 'toolResult' ? '工具结果卡' : '消息卡';
    lines.push(`${index + 1}. id=${item.id} · ${kindLabel} · 会话 ${item.sessionId}`);
    lines.push(`   锚点：${annotationAnchorLine(item)}`);
    lines.push(`   反馈：${item.note ?? '(空)'}`);
    if (item.excerpt) lines.push(`   卡片内容（前 200 字）：${item.excerpt}`);
    lines.push(`   标注时间：${item.at ?? '(未知)'}`);
  });
  lines.push('');
  lines.push('该做什么：');
  lines.push('  1) 读：`GET /annotations?state=open`（只读；也可以直接读 `$ASSIST_HOME/annotations.jsonl`）——');
  lines.push('     上面已经把这一批逐条列全了，这个端点用来补看别的还没处理的。');
  lines.push('  2) 逐条处理（改代码 / 改 UI / 记进待办）。');
  lines.push('  3) 处理完**逐条**回写状态：`POST /annotations {"op":"resolve","id":"an-…","by":"<谁处理的>"}`');
  lines.push(`     （幂等：已经 done 的再发一次不会重复记；\`by\` 建议写 \`${maintainerSessionId}\` 或一句人名/分支名）。`);
  lines.push('  · 不要在这条通知上再标注：它不是消息卡/工具卡，没有标注按钮；通知也**不会**再产生新标注。');
  return lines.join('\n');
}

/**
 * 把条目序列折成"每条问题的现状"。
 * `status` 只看该 id **最后一条**的 op（ask ⇒ open / answer ⇒ answered / close ⇒ closed），
 * 其余字段取它们最后一次出现的地方 —— 这样"最后一次状态变更"与"历史留痕"同时在账上。
 */
function questionStates(entries) {
  const states = new Map();
  const order = [];
  for (const entry of entries) {
    if (entry?.type !== 'custom' || entry.customType !== QUESTION_ENTRY) continue;
    const data = entry.data;
    if (!plainObject(data) || typeof data.id !== 'string' || data.id === '') continue;
    let state = states.get(data.id);
    if (!state) {
      state = {
        id: data.id, op: null, text: null, options: null, priority: null, dedupeKey: null,
        askedAt: null, askedBy: null, at: null, by: null,
        answer: null, answeredAt: null, answerBy: null,
        closeReason: null, closedAt: null, closedBy: null,
        context: null,
        updatedAt: null, updatedBy: null,
        entryId: null, entryCount: 0,
      };
      states.set(data.id, state);
      order.push(data.id);
    }
    state.entryCount += 1;
    if (typeof data.op === 'string') state.op = data.op;
    if (Number.isFinite(data.at)) state.at = data.at;
    if (typeof data.by === 'string') state.by = data.by;
    if (typeof entry.id === 'string') state.entryId = entry.id;
    if (typeof data.text === 'string' && data.text !== '') state.text = data.text;
    if (data.op === 'ask') {
      if (Number.isFinite(data.at)) state.askedAt = data.at;
      if (typeof data.by === 'string') state.askedBy = data.by;
      if (data.options !== undefined) state.options = Array.isArray(data.options) ? data.options : null;
      if (typeof data.priority === 'string') state.priority = data.priority;
      if (typeof data.dedupeKey === 'string') state.dedupeKey = data.dedupeKey;
      // 老条目没有 `context` 是**合法**的（append-only，不回填、不编）—— 缺失就如实留 null。
      if (typeof data.context === 'string') state.context = data.context;
    }
    // `update`：**就地**改写现状，但**不动历史**（append-only）——
    // `text/context/options/priority` 按「最后一条 op」合成；`askedAt/askedBy` 是「谁在何时问的」这个事实，
    // 更新**不碰**它，另记 `updatedAt/updatedBy`（业主 2026-09-21 定的契约）。
    // `op` 停在 `update` ⇒ 下面推状态时仍是 `open`（只允许更新未答的那条）。
    if (data.op === 'update') {
      if (typeof data.context === 'string') state.context = data.context;
      if (data.options !== undefined) state.options = Array.isArray(data.options) ? data.options : null;
      if (typeof data.priority === 'string') state.priority = data.priority;
      if (Number.isFinite(data.at)) state.updatedAt = data.at;
      if (typeof data.by === 'string') state.updatedBy = data.by;
    }
    if (data.op === 'answer') {
      state.answer = typeof data.answer === 'string' ? data.answer : '';
      if (Number.isFinite(data.at)) state.answeredAt = data.at;
      if (typeof data.by === 'string') state.answerBy = data.by;
    }
    if (data.op === 'close') {
      state.closeReason = typeof data.closeReason === 'string' ? data.closeReason : '';
      if (Number.isFinite(data.at)) state.closedAt = data.at;
      if (typeof data.by === 'string') state.closedBy = data.by;
    }
  }
  for (const state of states.values()) {
    state.status = state.op === 'answer' ? 'answered' : state.op === 'close' ? 'closed' : 'open';
  }
  return { states, order };
}

/**
 * 「给用户看的现状」= `questionWire` 去掉**文件里的账**（`entryId`/`entryCount`）。
 * 封存会把一条问题的条目搬到另一个文件里（同一个 id 的另一份文件）⇒ 这两笔账必然不同：
 * `entryId` 指的是「最后一次落笔的那一条条目」（照抄的那条是新 id），`entryCount` 是「这份文件里折到了几条」。
 */
function questionFacts(state) {
  const { entryId, entryCount, ...facts } = questionWire(state);
  return facts;
}

function questionWire(state) {
  return {
    id: state.id,
    status: state.status,
    text: state.text,
    options: state.options,
    // 提问时必须写的「判断所需的事实」（老条目为 null ⇒ 前端如实说「这条没自带背景」）。
    context: state.context,
    priority: state.priority,
    dedupeKey: state.dedupeKey,
    at: state.at,
    by: state.by,
    askedAt: state.askedAt,
    askedBy: state.askedBy,
    answer: state.answer,
    answeredAt: state.answeredAt,
    answerBy: state.answerBy,
    // 「这条被更新过」的留痕：谁在什么时候改的题面/背景/候选/优先级（没更新过 ⇒ null）。
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
    closeReason: state.closeReason,
    closedAt: state.closedAt,
    closedBy: state.closedBy,
    entryId: state.entryId,
    entryCount: state.entryCount,
  };
}

/** `status` 过滤（业主 2026-09-20 在父会话里定的口径，前端已在按它工作）：
 *   open     = 只有「还没结论」的（有 ask、无 answer 也无 close）
 *   answered = 【有结论的】= 答过的【或】关掉的（answered ∪ closed）—— 问题页把"已答/已关"放在**同一页签**下
 *   all      = 全部（含未答）
 * `counts.concluded` = 这个 `answered` 集合的大小（= answered + closed 逐状态计数），所以
 * `open + concluded === total`；`filteredCount` 恒等于本次返回集大小（status=answered 时二者相等）。
 */
function questionListView(states, order, status, limit) {
  const items = order
    .map((id) => states.get(id))
    .filter(Boolean)
    .sort((left, right) => (right.askedAt ?? 0) - (left.askedAt ?? 0) || String(right.id).localeCompare(String(left.id)));
  const counts = { open: 0, answered: 0, closed: 0, concluded: 0, total: items.length };
  for (const state of items) {
    counts[state.status] += 1;
    if (state.status !== 'open') counts.concluded += 1;
  }
  const filtered = items.filter((state) => (status === 'all' ? true : status === 'open' ? state.status === 'open' : state.status !== 'open'));
  return { questions: filtered.slice(0, limit).map(questionWire), counts, filteredCount: filtered.length };
}

// —— 对话内的「推荐回复」（suggestions）的纯函数层 ——
// 机制（业主 2026-09-23 拍的口径，逐条别改）：
//   · 一个回合的**最后一条助手消息落盘之后**，**另起一次模型调用**（不是复用未答问题的选项、
//     不是工具调用、**不**复用主回合的流）生成「用户下一句可能说什么」；
//   · **不阻塞**：模型调用是后台 job（触发点只做同步快照，然后 `void` 起 job —— 见
//     `createRuntimeAdapter` 的 `agent_settled` 分支），主回合该流式照流式；
//   · **可用了才出现**：结果落成**那条助手消息的可选字段** `suggestions: string[]` ＋ 同时发一帧
//     SSE `session.suggestions {messageId, items}`；前端只在收到事件时画那排（不画占位）；
//   · **绝不进对话正文**：不走 `session.prompt`、不落进 pi 的会话文件、不进 `parts`/`text`；
//   · **服务端严格校验**：非 JSON ⇒ 丢、过长 ⇒ 丢、空串 ⇒ 丢、超 3 条 ⇒ 截到 3（下面的
//     `parseSuggestionItems` 是**唯一**上屏路径）。
const SUGGESTION_MAX_ITEMS = 3;
// 单条候选的长度上限：超了一律**整条丢**（不是截半句 —— 截出来的残句一点就发出去，比不出现更坏）。
const SUGGESTION_ITEM_MAX_CHARS = 120;
// 喂给模型的最近消息条数与每条截断长度（业主给的「最近 2–3 条 + 截断」）。
const SUGGESTION_INPUT_MESSAGES = 3;
const SUGGESTION_INPUT_CHARS = 1200;
const SUGGESTION_DEFAULT_TIMEOUT_MS = 10_000;
const SUGGESTION_LOG = '[suggestions] ';
// 旁路调用的机器可读标记（写进系统提示，夹具/日志据此认它）：不是「对话的回合」那一次请求。
const SUGGESTION_BYPASS_MARK = 'sopho.suggestions.v1';
const SUGGESTION_SYSTEM_PROMPT = [
  '你是「下一句建议」生成器：读一段对话的结尾，给出用户接下来最可能打出的 1–3 条短句。',
  `只输出一个 JSON 字符串数组，例如 ["继续", "把测试补上"]；没有值得建议的就输出 []。`,
  '规则：',
  `· 最多 ${SUGGESTION_MAX_ITEMS} 条，每条不超过 ${SUGGESTION_ITEM_MAX_CHARS} 个字符；`,
  '· 用用户的口吻写（他接下来会打的那句话），不要复述助手；',
  '· 不要解释、不要代码块、不要多余文字 —— 输出必须能被 JSON.parse 解析；',
  '· 没意义就输出空数组，**不要凑数**。',
  // 这一行是给**夹具与日志**看的机器可读标记（模型不会因此改变行为）：旁路调用不是「对话的回合」，
  // 按 provider 被打次数做断言的门要能把它挑出来（`test/fixtures/suggestions-bypass.mjs`）。
  `（本次请求的标记：${SUGGESTION_BYPASS_MARK}）`,
].join('\n');

const suggestionLog = (message) => console.log(`${SUGGESTION_LOG}${message}`);

/** `SOPHO_SUGGESTIONS_TIMEOUT_MS`（默认 10s）—— 值不合法就**如实回退默认值＋记一条日志**
 *  （与 `SOPHO_ANNOTATION_NOTIFY_WINDOW_MS` 同一条口径：旋钮不是用户数据，不为此拒绝启动）。 */
function suggestionTimeoutMs(rawValue = process.env.SOPHO_SUGGESTIONS_TIMEOUT_MS) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return SUGGESTION_DEFAULT_TIMEOUT_MS;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0 || value > 600_000) {
    suggestionLog(`SOPHO_SUGGESTIONS_TIMEOUT_MS=${JSON.stringify(rawValue)} 不是 0..600000 的整数 ⇒ 用默认 ${SUGGESTION_DEFAULT_TIMEOUT_MS}ms`);
    return SUGGESTION_DEFAULT_TIMEOUT_MS;
  }
  return value;
}

/** 只容忍**恰好在外面包了一层 code fence** 这一种格式偏差（模型常见写法）；其余一律按「非 JSON ⇒ 丢」。 */
function suggestionFenceInner(text) {
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/u.exec(text.trim());
  return match ? match[1].trim() : text.trim();
}

/**
 * **严格校验**模型输出 —— 候选上屏的**唯一**路径（未经它的一律丢掉）。
 * 返回 `{ ok, reason, items, dropped }`：
 *   · `ok:false` = 整段不是 JSON 数组（非 JSON／不是数组／空串）⇒ **一条都不上屏**；
 *   · 元素不是字符串 ⇒ 丢；trim 后是空串 ⇒ 丢；超过 `SUGGESTION_ITEM_MAX_CHARS` ⇒ 丢；
 *   · 第 4 条起 ⇒ 丢（只留前 `SUGGESTION_MAX_ITEMS` 条）。
 * `dropped` 如实记账（诊断/日志用），不假装模型只给了这几条。
 */
function parseSuggestionItems(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty output', items: [], dropped: null };
  let parsed;
  try {
    parsed = JSON.parse(suggestionFenceInner(text));
  } catch (error) {
    return { ok: false, reason: `not JSON: ${normalizeError(error).message}`, items: [], dropped: null };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: `JSON is a ${parsed === null ? 'null' : typeof parsed}, not an array`, items: [], dropped: null };
  const items = [];
  const dropped = { invalid: 0, empty: 0, tooLong: 0, overflow: 0 };
  for (const raw of parsed) {
    if (typeof raw !== 'string') { dropped.invalid += 1; continue; }
    const item = raw.trim();
    if (item === '') { dropped.empty += 1; continue; }
    if (item.length > SUGGESTION_ITEM_MAX_CHARS) { dropped.tooLong += 1; continue; }
    if (items.length >= SUGGESTION_MAX_ITEMS) { dropped.overflow += 1; continue; }
    items.push(item);
  }
  return { ok: true, reason: null, items, dropped };
}

/** 喂给模型的**最近几条消息**（只看 message 条目里的 user/assistant，每条截断到 N 字符）。
 *  给不出东西（没有 user/assistant 消息）⇒ 空数组 ⇒ 调用方放弃这一次生成（不拿空上下文问模型）。 */
function suggestionTranscript(manager) {
  const lines = [];
  for (const entry of manager.getBranch()) {
    if (entry?.type !== 'message') continue;
    const role = entry.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = contentTextWithImages(entry.message?.content).trim();
    if (text === '') continue;
    lines.push({ role, text: text.length > SUGGESTION_INPUT_CHARS ? `${text.slice(0, SUGGESTION_INPUT_CHARS)}…（已截断）` : text });
  }
  return lines.slice(-SUGGESTION_INPUT_MESSAGES);
}

/** 最近一条助手消息的 entry id —— 就是候选挂着的那个 `messageId`（SSE 里同名字段）。没有 ⇒ null。 */
function lastAssistantEntryId(manager) {
  const branch = manager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === 'message' && entry.message?.role === 'assistant' && typeof entry.id === 'string' && entry.id !== '') return entry.id;
  }
  return null;
}

/** append-only 行 ⇒ 「每个会话**最新**的一条候选」（同一 id 只留最后一行；坏行/不认识的形状**跳过**）。
 *  为什么只留最新的一条：候选只对**尾巴**说话（上一轮的那排在新一轮开始后必须消失），
 *  所以历史候选在读侧一点用都没有 —— 留着只会让 `/messages` 的 payload 白白变胖。 */
function foldSuggestionRecords(items) {
  const bySession = new Map();
  let bad = 0;
  for (const item of items) {
    if (!plainObject(item)) { bad += 1; continue; }
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.toLowerCase() : '';
    const messageId = typeof item.messageId === 'string' ? item.messageId : '';
    const values = Array.isArray(item.items) ? item.items.filter((value) => typeof value === 'string' && value.trim() !== '') : [];
    if (sessionId === '' || messageId === '' || values.length === 0) { bad += 1; continue; }
    bySession.set(sessionId, { at: typeof item.at === 'string' ? item.at : null, sessionId: item.sessionId, messageId, items: values, model: typeof item.model === 'string' ? item.model : null });
  }
  return { bySession, bad };
}

/** 把候选挂到**它自己那条消息**上（`entryId` 逐字相等才挂；挂不上就什么都不做）。
 *  只加一个可选字段 `suggestions: string[]` —— `text`/`parts`/`content` 一个字都不动（**不进正文**）。 */
function attachSuggestions(wire, suggestion) {
  if (!suggestion || !Array.isArray(wire?.messages)) return wire;
  for (const message of wire.messages) {
    if (message?.entryId === suggestion.messageId) message.suggestions = [...suggestion.items];
  }
  return wire;
}

/** `/messages` 响应体缓存的版本键里代表「候选那一行」的那一段（没有候选 ⇒ `|sg:-`）。
 *  为什么要进键：候选落盘**不动会话文件**（size/mtime/ctime 一字不变），不进键就会命中候选到达
 *  之前存下的那份响应体 —— 刷新后那排就不在了。它只是**缓存键**，不是 ETag 的输入
 *  （ETag 仍按响应体内容算，见 `storeMessageBody`）。 */
function suggestionKeyPart(suggestion) {
  return `|sg:${suggestion ? `${suggestion.messageId}@${suggestion.at ?? ''}` : '-'}`;
}

function latestVisibleRole(branch) {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role)) return entry.message.role;
  }
  return null;
}

function statusFor(manager, adapter) {
  if (adapter?.isWorking()) return 'working';
  return latestVisibleRole(manager.getBranch()) === 'assistant' ? 'unread' : 'idle';
}

function modifiedAt(manager) {
  const entries = manager.getEntries();
  return entries.at(-1)?.timestamp ?? manager.getHeader()?.timestamp ?? null;
}

function summaryFromManager(manager, adapter = null, legacyArchived = false) {
  const status = statusFor(manager, adapter);
  const header = manager.getHeader();
  return {
    id: manager.getSessionId(),
    name: manager.getSessionName() || null,
    status,
    statusLabel: STATUS_LABELS[status],
    archived: archiveValue(manager.getEntries(), legacyArchived),
    cwd: manager.getCwd(),
    parentSessionPath: header?.parentSession ?? null,
    createdAt: header?.timestamp ?? null,
    modifiedAt: modifiedAt(manager),
  };
}

// BashExecutionMessage（`docs/session-format.md:125-134`）**没有** `content` 字段：它的形状是
// command / output / exitCode / cancelled / truncated / fullOutputPath / excludeFromContext。
// 修前 `messageWire` 对 `entry.type==='message'` 一律 `message.content ?? []` ⇒ `text` 是空串，
// 前端画出一个空壳（比不显示更糟）。
// 这里**只报文件里真有的值**：字段缺失就给 null（不按空串/0/false 猜），并且**保证 text 非空**
// （哪怕是「文件里没有命令行」这种诚实的说明，也不留给前端一个空壳）。
const BASH_EXECUTION_KIND = 'bashExecution';
function bashExecutionWire(message) {
  const command = typeof message.command === 'string' ? message.command : null;
  const output = typeof message.output === 'string' ? message.output : null;
  const exitCode = Number.isInteger(message.exitCode) ? message.exitCode : null;
  const cancelled = typeof message.cancelled === 'boolean' ? message.cancelled : null;
  const truncated = typeof message.truncated === 'boolean' ? message.truncated : null;
  const fullOutputPath = typeof message.fullOutputPath === 'string' ? message.fullOutputPath : null;
  const excludeFromContext = typeof message.excludeFromContext === 'boolean' ? message.excludeFromContext : null;
  const lines = [];
  if (command !== null) lines.push(`$ ${command}`);
  if (output !== null && output !== '') lines.push(output);
  else if (output === '') lines.push('(no output)');
  if (cancelled === true) lines.push('(command cancelled)');
  else if (exitCode !== null && exitCode !== 0) lines.push(`Command exited with code ${exitCode}`);
  if (truncated === true) lines.push(fullOutputPath === null ? '[Output truncated]' : `[Output truncated. Full output: ${fullOutputPath}]`);
  if (excludeFromContext === true) lines.push('[not sent to the model: this command was excluded from context]');
  if (lines.length === 0) lines.push('(bashExecution message has no command/output fields: nothing to show, rather than inventing one)');
  return {
    kind: BASH_EXECUTION_KIND,
    // 前端不用猜：`kind` 是 wire 的判别字段；结构化真值另给一份 `bash`，字段名与 pi 的会话文件一致。
    bash: { command, output, exitCode, cancelled, truncated, fullOutputPath, excludeFromContext },
    text: lines.join('\n'),
  };
}

// 工具结果的 `details`（`docs/session-format.md:98`：`ToolResultMessage.details`，工具特有的元数据 ——
// edit/write 的逐行 diff 就在里面）修前被 wire **整个丢掉**（只取 text 与 isError）⇒ 前端拿不到
// diff（M-25）。这里透传，但**有上限**：一次 edit 的 diff 可以几百 KB，直接塞进 SSE 会拖垮 payload。
// 超限时**不截成半截 JSON**（解析不了），而是「省略正文 + 报字节数 + 给一段原文预览」，并且
// `status` / `note` 如实说清发生了什么（与 `normalizedUsage` 同一种「known/unknown」措辞）。
const TOOL_DETAILS_MAX_BYTES = 64 * 1024;
const TOOL_DETAILS_PREVIEW_CHARS = 2000;
function detailsWire(details) {
  if (details === undefined || details === null) {
    return { status: 'absent', value: null, bytes: null, truncated: false, note: null, preview: null };
  }
  let json;
  try {
    json = JSON.stringify(details);
  } catch {
    json = undefined;
  }
  if (typeof json !== 'string') {
    return { status: 'unserializable', value: null, bytes: null, truncated: true, note: 'details 不能被 JSON 序列化（循环引用或 BigInt）：如实省略，不编一个假值', preview: null };
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > TOOL_DETAILS_MAX_BYTES) {
    return {
      status: 'oversized',
      value: null,
      bytes,
      truncated: true,
      note: `details 有 ${bytes} 字节，超过上限 ${TOOL_DETAILS_MAX_BYTES}：正文被省略（截成半截 JSON 没法用），下面是前 ${TOOL_DETAILS_PREVIEW_CHARS} 字符的原文预览`,
      preview: json.slice(0, TOOL_DETAILS_PREVIEW_CHARS),
    };
  }
  return { status: 'known', value: details, bytes, truncated: false, note: null, preview: null };
}

// 与 M-39 同一类空壳的其它入口：pi 的 AgentMessage 里 `BranchSummaryMessage` /
// `CompactionSummaryMessage` **也没有 `content`**（`dist/core/messages.js:42-52`）。落盘走的是
// `branch_summary` / `compaction` **entry**（上面两支），但万一哪天它们以 message entry 落下来，
// 这里同样不许画出空壳。
function contentlessMessageWire(message, text) {
  if (text !== '') return null;
  if (typeof message.summary !== 'string') return null;
  if (message.role === 'branchSummary') {
    return { kind: 'branchSummary', text: `[分支摘要]\n${message.summary}`, extra: { summary: message.summary, fromId: message.fromId ?? null } };
  }
  if (message.role === 'compactionSummary') {
    return {
      kind: 'compactionSummary',
      text: `[压缩摘要]\n${message.summary}`,
      extra: { summary: message.summary, tokensBefore: typeof message.tokensBefore === 'number' ? message.tokensBefore : null },
    };
  }
  return null;
}

// 工具调用的两个时间戳（TUI 平价：pi 的 shell 渲染器在卡片里写一行 muted 的 `Elapsed`/`Took 3.4s`，
// `dist/core/tools/renderers/bash.js:23`、`:93-95`）。用会话文件里 entry 的 `timestamp`：
// `startedAt` = 带这个 toolCall 的 assistant entry（它落盘后紧接着才跑工具）、`endedAt` = 配对的 toolResult entry。
// ⚠️ **近似、不是 CPU 时间**（同一条消息里多个 toolCall 共用一个 startedAt，含排队）；取不到（缺字段 /
// 不是字符串 / 解析不出时间）一律 `null`，**绝不**按 0 或本地时钟编一个值。完整口径见 `docs/handoff.md`「工具耗时」。
function entryTimestamp(value) {
  if (typeof value !== 'string' || value === '') return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function messageWire(manager, models, { isStreaming = false, unfinishedStatus = 'unfinished' } = {}) {
  const branch = manager.getBranch();
  const messages = [];
  const extras = [];
  const toolCalls = [];
  const toolResults = new Map();
  let latestCompaction = null;
  // M-34：本会话**压缩过几次** = 当前 branch 里 `type === 'compaction'` 的 entry 条数。
  //   · 定义钉死：**只数 `compaction` entry**（`branch_summary` 是切分支的摘要，不是一次压缩 ⇒ 不算）；
  //   · 0 是**真实的数**——没有压缩过就给 `0`，不写 null（前端据此区分「0 次」与「字段拿不到」）；
  //   · 与下面 `messages` / `branchSummaries` 走**同一次 `getBranch()` 遍历**，所以计数、`atIndex`、
  //     正文列表三者对**同一条 branch** 说话，不会各数各的。
  let compactionCount = 0;
  const branchSummaries = [];

  for (const entry of branch) {
    if (entry.type === 'message') {
      const message = entry.message ?? {};
      const content = Array.isArray(message.content) ? message.content : [];
      const observed = message.role === 'assistant' ? assistantObservability(message, models) : null;
      const bash = message.role === 'bashExecution' ? bashExecutionWire(message) : null;
      const images = bash === null ? imageBlocks(message.content) : [];
      const messageText = bash ? bash.text : contentTextWithImages(message.content);
      const contentless = bash === null ? contentlessMessageWire(message, messageText) : null;
      const wire = {
        entryId: entry.id,
        parentId: entry.parentId,
        timestamp: entry.timestamp,
        kind: bash ? bash.kind : (contentless?.kind ?? 'message'),
        role: message.role ?? 'unknown',
        content: message.content ?? [],
        text: contentless?.text ?? messageText,
        ...(bash ? { bash: bash.bash } : {}),
        ...(contentless ? contentless.extra : {}),
        // 图片元数据（mimeType + 字节数）+ text 里的占位行（见 imageBlocks/contentTextWithImages）；
        // 原图 base64 仍原样在 `content` 里（前端将来渲染用），这里**不**重复它。
        images,
        stopReason: message.stopReason ?? null,
        errorMessage: message.errorMessage ?? null,
        toolCallId: message.toolCallId ?? null,
        toolName: message.toolName ?? null,
        isError: message.isError ?? false,
        aborted: message.stopReason === 'aborted',
        extras: [],
        ...(observed ?? {}),
      };
      if (wire.role === 'assistant') {
        wire.parts = content.flatMap((part) => {
          if (part?.type === 'text') return [{ type: 'text', text: part.text ?? '' }];
          if (part?.type === 'thinking') return [{ type: 'thinking', text: part.thinking ?? '' }];
          if (part?.type === 'image') return [{ type: 'image', mimeType: typeof part.mimeType === 'string' ? part.mimeType : null, bytes: typeof part.data === 'string' ? Buffer.byteLength(part.data, 'base64') : null }];
          if (part?.type !== 'toolCall') return [];
          const tool = {
            type: 'tool',
            toolCallId: part.id ?? null,
            name: part.name ?? 'tool',
            args: part.arguments ?? {},
          };
          toolCalls.push({ message: wire, part: tool });
          return [tool];
        });
      }
      if (wire.role === 'toolResult' || wire.role === 'tool') {
        // details 只挂在**配对的 tool 卡**（下面配对循环里的 `call.part.details`），不在这条 toolResult
        // message 上再抄一份 —— 前端本来就跳过 toolResult message（`web/render.js` 的
        // `if (item.role === 'toolResult' ...) continue`），抄一份等于把 diff 在 payload 里塞两遍。
        const result = {
          text: wire.text,
          isError: wire.isError,
          toolName: wire.toolName,
          details: detailsWire(message.details),
          // 给上面的 `endedAt` 用（不发给前端 —— 它只挂在工具卡上）。
          timestamp: wire.timestamp,
        };
        if (wire.toolCallId) toolResults.set(wire.toolCallId, result);
      }
      messages.push(wire);
    } else if (entry.type === 'custom_message') {
      extras.push({
        entryId: entry.id,
        parentId: entry.parentId,
        timestamp: entry.timestamp,
        customType: entry.customType,
        content: entry.content ?? [],
        text: contentText(entry.content),
        display: entry.display === true,
        details: entry.details ?? null,
      });
    } else if (entry.type === 'compaction') {
      compactionCount += 1;
      latestCompaction = {
        entryId: entry.id,
        atIndex: messages.length,
        timestamp: entry.timestamp,
        summary: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId ?? null,
        tokensBefore: entry.tokensBefore ?? null,
        // 顺手（M-34 的服务端那一半）：`usage`/`details` 在 `compaction` entry 上也是**可选**的
        // （`docs/session-format.md:245-248`），与 `branch_summary` 块保持一致地报出来 ——
        // 缺就 `status:'unknown'`（不按 0 计）/null。这两项是「压缩花了多少」的唯一来源。
        usage: normalizedUsage(entry.usage),
        details: entry.details ?? null,
        note: COMPACTION_NOTE,
      };
    } else if (entry.type === 'branch_summary') {
      // M-33：修前这一类 entry **整条掉在地上**（只认 message / custom_message / compaction）。
      // 形状与 compaction 块自洽（entryId/parentId/atIndex/timestamp/summary/note），
      // 另给切分支特有的 fromId 与 entry 上的 usage/details（缺就是「缺」，不编）。
      branchSummaries.push({
        entryId: entry.id,
        parentId: entry.parentId ?? null,
        atIndex: messages.length,
        timestamp: entry.timestamp,
        summary: typeof entry.summary === 'string' ? entry.summary : null,
        fromId: entry.fromId ?? null,
        usage: normalizedUsage(entry.usage),
        details: entry.details ?? null,
        note: BRANCH_SUMMARY_NOTE,
      });
    }
  }

  let lastAssistant = null;
  for (const message of messages) if (message.role === 'assistant') lastAssistant = message;
  for (const call of toolCalls) {
    const result = call.part.toolCallId ? toolResults.get(call.part.toolCallId) : null;
    call.part.startedAt = entryTimestamp(call.message.timestamp);
    call.part.endedAt = result ? entryTimestamp(result.timestamp) : null;
    if (result) {
      call.part.status = result.isError ? 'done-error' : 'done-success';
      call.part.result = result.text;
      call.part.isError = result.isError;
      call.part.details = result.details;
    } else {
      call.part.status = isStreaming && call.message === lastAssistant && !call.message.aborted ? 'running' : unfinishedStatus;
    }
  }

  return {
    sessionId: manager.getSessionId(),
    observability: sessionObservability(manager, models),
    messages,
    extras,
    branchSummaries,
    // M-34（追加字段，既有 `compaction` 形状不动）：只投影**最近一次**的那块仍叫 `compaction`；
    // 次数单独给顶层 `compactionCount`，与 `compaction` 相邻 —— 前端 `web/render.js` 的
    // `compactionCountText()` 认 `compaction.count` **或**顶层 `compactionCount`（这里给后者）。
    compaction: latestCompaction ?? { atIndex: null, note: COMPACTION_NOTE },
    compactionCount,
  };
}

async function listJsonlFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(target);
    }
  }
  await visit(root);
  return files;
}

// `/tree` 每个会话只需要**几条「最后一次出现」的事实**：名字（最后一条 session_info）、最后一条
// user/assistant 消息的角色、归档标记、最后一个时间戳。老实现为每棵树**逐行 JSON.parse 每个字节**
// （327 会话 / 380 MB 实测 ~3.4 s），而宿主等 worker 的硬超时是 5 s —— 线上已经把 /tree 打成 500，
// 被放弃的请求还在 worker 里继续算。
//
// 按**字节**找就够了：JSON 转义保证这些片段只会以**结构**出现（字符串值里的引号是 `\"`，所以
// `"role":"user"` 绝不可能是某段正文里的文本）。只有候选行（名字 / 归档）才解码 + JSON.parse。
const TREE_BYTES = {
  session: Buffer.from('"type":"session"'),
  messageType: Buffer.from('"type":"message"'),
  sessionInfo: Buffer.from('"type":"session_info"'),
  archive: Buffer.from(ARCHIVE_ENTRY),
  roleUser: Buffer.from('"role":"user"'),
  roleAssistant: Buffer.from('"role":"assistant"'),
  timestamp: Buffer.from('"timestamp":"'),
};

// 续读的锚：**投影自称已经折过的整段 `[0, consumed)` 的 sha256**（不是前 4 KiB 的指纹）。
//
// 为什么必须升级（2026-09-22 的原始证据，`docs/design-session-seal.md` §9.2）：
//   · 「前 4 KiB 相同 + size 变大」这一支会**给出错的行**：原地重写出的新文件与旧文件前 4 KiB 逐字相同、
//     只是变长 ⇒ 走「纯追加」那条路 ⇒ 行里留着**旧版本**的名字/时间戳，而那份 `session_info` 已经不在文件里了；
//   · 「断点续扫」那一支同理（`resumes:1`，行报的是旧版本的 name/modifiedAt）；
//   · 续读的第一行若是含 `"type":"session_info"` 的半行碎片，按字节投影会去 JSON.parse 它 ⇒ `/tree` 500。
// 语义：**只有「投影自称折过的那一段逐字节没变」才敢接着读**；核不过就整份重扫（宁可慢，也不静默半份/错份投影）。
// 「同尾锚」（最后一行 id / 末尾 N 字节）一律**不能**当许可 —— 投影是「最后一次出现」的折叠，被裁掉的那一段
// 里可能有某个事实的最后一次出现。
const TREE_PREFIX_CHUNK_BYTES = 1024 * 1024;
// 测试专用的故障注入（生产不设 ⇒ 零影响，与 `SOPHO_FAULT_ATOMIC_RENAME` 同一口径）：
// `SOPHO_FAULT_TREE_ANCHOR=prefix4k` = **退回旧规则**（续读许可只看前 4 KiB 前缀，扫完不复核文件身份）。
// 为什么要有它：`test/session-seal.mjs` 的 R10 红臂要证明「同一把尺子量旧规则 ⇒ 给出文件里已经不存在的
// 名字」，而那件事只能在**旧规则真的在跑**的那个进程里量（env 在 worker spawn 时就固定了 ⇒ 另起一个宿主）。
const TREE_LEGACY_HEAD_SAMPLE = 4096;
const TREE_LEGACY_ANCHOR = 'legacy-prefix4k';
function treeAnchorFault() {
  return process.env.SOPHO_FAULT_TREE_ANCHOR === 'prefix4k' ? 'prefix4k' : null;
}
// 扫完再 `stat` 一次比 (size, mtimeMs, ctimeMs)：扫的**过程中**被替换/截断的那一份投影作废、重扫。
// 挡的是「读越界拿到 0 字节被当成 EOF ⇒ 静默给出半份投影」（§9.6 的原始输出）。
const TREE_SCAN_STAT_ATTEMPTS = 3;

/** 旧规则（`SOPHO_FAULT_TREE_ANCHOR=prefix4k` 才走到）：只核前面那可能不到 4 KiB 的字节。 */
async function verifyHeadPrefix(handle, head) {
  if (!Buffer.isBuffer(head) || head.length === 0) return { ok: false, hash: null };
  const buffer = Buffer.allocUnsafe(head.length);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  return { ok: bytesRead === head.length && buffer.equals(head), hash: null };
}

/** `[0, bytes)` 的 sha256 与「还在算的」hash 对象（核完还能接着 update ⇒ 下次续读的锚可以链式推下去）。 */
async function hashFilePrefix(handle, bytes, expectedDigest) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(TREE_PREFIX_CHUNK_BYTES, Math.max(1, bytes)));
  let position = 0;
  while (position < bytes) {
    const want = Math.min(buffer.length, bytes - position);
    const { bytesRead } = await handle.read(buffer, 0, want, position);
    if (bytesRead === 0) break; // 文件比自称的 `consumed` 还短 ⇒ 前缀核不过
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== bytes) return { ok: false, hash: null };
  // `copy()` 而不是 `digest()`：digest 会把对象 finalize，链式记账就断在这里了。
  if (hash.copy().digest('hex') !== expectedDigest) return { ok: false, hash: null };
  return { ok: true, hash };
}

function newTreeProjection() {
  return { name: null, latestRole: null, modified: null, archivePresent: false, archiveArchived: false };
}

// 非紧凑 JSONL（pi 永远写紧凑的 `{"type":"message",…}`；这是被外部导入 / 手改过的文件）的**回退**
// 投影：逐行 JSON.parse，语义与老实现逐条相同（坏行抛错）。宁可慢，也不静默算错。
// `projectTreeLineByParse` 解**一行**；`projectTreeTextByParse` 把切好的文本按行喂给它。
// （⚠️ 2026-09-21：这两个函数在 7983b0d 的重构里被拆开过，`projectTreeLineByParse` 的定义当时被
//   误删、调用点还在 ⇒ 非紧凑文件那条路必 500 `ReferenceError`。本提交把它补回来。）
function projectTreeLineByParse(line, projection, where) {
  if (line.trim() === '') return;
  let entry;
  try { entry = JSON.parse(line); }
  catch (error) { throw new Error(`invalid session entry JSON (${where}): ${normalizeError(error).message}`); }
  if (entry.timestamp !== undefined) projection.modified = entry.timestamp;
  if (entry.type === 'session_info') projection.name = entry.name || null;
  if (entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role)) projection.latestRole = entry.message.role;
  if (entry.type === 'custom' && entry.customType === ARCHIVE_ENTRY) {
    projection.archivePresent = true;
    projection.archiveArchived = entry.data?.archived === true;
  }
}

// 这一路也要**可中止 + 可断点续扫**（与按字节投影那条路同一份契约）：
//   · `signal` 到点就抛（旧实现这里没有任何中止点 —— 「客户端走了 worker 还在算」有一半是它）；
//   · `onProgress` 每 N 行报一次「已消费到的字节偏移」，被中止时下一个请求从这里接着解析。
// `startAt` = 上一次已经解析到的字节偏移（永远是行首，所以解码边界安全）。
function projectTreeTextByParse(text, projection, where, { startAt = 0, signal = null, onProgress = null } = {}) {
  let consumed = 0;
  let lines = 0;
  for (;;) {
    const newline = text.indexOf('\n', startAt);
    if (newline === -1) break; // 末尾没换行的半行：不消费
    const line = text.slice(startAt, newline).replace(/\r$/, '');
    projectTreeLineByParse(line, projection, where);
    consumed += Buffer.byteLength(text.slice(startAt, newline), 'utf8') + 1;
    startAt = newline + 1;
    lines += 1;
    if (lines % 512 === 0) {
      if (signal?.aborted) throw treeAbortError(signal);
      if (onProgress) onProgress(consumed);
    }
  }
  if (onProgress) onProgress(consumed);
  return consumed;
}

// 投影一行。语义与老实现逐条对齐（`latestRole` 取**最后一次**出现的角色，名字取最后一条
// session_info，归档取最后一条 sopho.archive），只是判据从 JSON.parse 换成字节片段。
function projectTreeLine(line, projection) {
  if (line.length === 0) return;
  const timestampAt = line.indexOf(TREE_BYTES.timestamp);
  if (timestampAt >= 0) {
    const valueStart = timestampAt + TREE_BYTES.timestamp.length;
    const valueEnd = line.indexOf(34, valueStart); // 34 = '"'
    if (valueEnd > valueStart) projection.modified = line.subarray(valueStart, valueEnd).toString('utf8');
  }
  // 只有 message 条目才算角色：custom_message 的 details 里也可能出现 role 键（那种行没有
  // `"type":"message"`）。同一行里若两个片段都在，取更靠后的那个（= 文件顺序更晚）。
  if (line.indexOf(TREE_BYTES.messageType) >= 0) {
    const assistantAt = line.indexOf(TREE_BYTES.roleAssistant);
    const userAt = line.indexOf(TREE_BYTES.roleUser);
    if (assistantAt >= 0 || userAt >= 0) projection.latestRole = assistantAt > userAt ? 'assistant' : 'user';
  }
  if (line.indexOf(TREE_BYTES.sessionInfo) >= 0) {
    let entry;
    try { entry = JSON.parse(line.toString('utf8')); }
    catch (error) { throw new Error(`invalid session_info entry JSON: ${normalizeError(error).message}`); }
    if (entry?.type === 'session_info') projection.name = entry.name || null;
  }
  if (line.indexOf(TREE_BYTES.archive) >= 0) {
    let entry;
    try { entry = JSON.parse(line.toString('utf8')); }
    catch (error) { throw new Error(`invalid archive entry JSON: ${normalizeError(error).message}`); }
    if (entry?.type === 'custom' && entry.customType === ARCHIVE_ENTRY) {
      projection.archivePresent = true;
      projection.archiveArchived = entry.data?.archived === true;
    }
  }
}

// 把 buffer 里**完整的行**投影进去，返回「最后一条完整行之后」的字节偏移。末尾没有换行的半行
// 不消费（pi 是追加写：半个行 = 还没写完），下一次从那里接着读。
function projectTreeBuffer(buffer, projection, from = 0) {
  let start = from;
  for (;;) {
    const newline = buffer.indexOf(10, start);
    if (newline === -1) break;
    projectTreeLine(buffer.subarray(start, newline), projection);
    start = newline + 1;
  }
  return start;
}

function treeAbortError(signal) {
  const reason = signal?.reason;
  const error = new Error(typeof reason === 'string' ? reason : 'tree scan aborted');
  error.name = 'AbortError';
  error.code = 'tree_scan_aborted';
  return error;
}

// 一次 open、一块一块地扫（行可以跨块：末尾那半行带到下一块前面）。
// 为什么不复用 `readFile` + `readSessionHeader`：这台机器上**每次 open 就要 3-4 ms**
// （Windows + 实时防护），两趟 open = 冷扫描一半的墙钟（303 文件实测 2.5 s）。
// 返回值 `header` 是**第一行**解析出来的会话头（拿不到就为 null，调用方回退到 readSessionHeader）；
// `consumed` = 最后一条**完整**行之后的字节偏移（末尾半行不消费，留给下一次）。
// `onProgress(consumed, byteMode)` 每块报一次（byteMode = 这一块的投影是不是**按字节**那一套）：
// 被中止时调用方把进度写进索引，于是这次的字节没白读。`byteMode` 是调用方带进来的已知口径
// （追加/续扫那条路进来就知道自己是不是按字节投影），为 null 时才由头那一行现算。
async function scanTreeStream(handle, { startAt = 0, chunkBytes = 1024 * 1024, projection, signal, onHeader = null, onProgress = null, byteMode = null, digest = null }) {
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let position = startAt;
  let carry = Buffer.alloc(0);
  let consumed = startAt;
  let header = null;
  let headerReported = false;
  let dense = byteMode; // null = 「不知道」（追加/续扫那条路进来时就带过来了），true/false = 头那一行是不是紧凑 JSON
  for (;;) {
    if (signal?.aborted) throw treeAbortError(signal);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const block = buffer.subarray(0, bytesRead);
    const data = carry.length > 0 ? Buffer.concat([carry, block]) : block;
    const dataStart = position - carry.length;
    if (header === null && startAt === 0 && dense === null) {
      const newline = data.indexOf(10);
      if (newline >= 0) {
        const firstLine = data.subarray(0, newline);
        // 紧凑判据：头那一行里有没有整字节序列 `"type":"session"`。
        dense = firstLine.indexOf(TREE_BYTES.session) >= 0;
        try {
          const parsed = JSON.parse(firstLine.toString('utf8'));
          if (parsed?.type === 'session' && typeof parsed.id === 'string') header = parsed;
        } catch { /* 头不是合法 JSON：交给调用方回退到 readSessionHeader */ }
      }
    }
    // 头一到手就**马上**过准入（A-29）：一个真正超预算的大文件要在「把它读完」之前就 503，
    // 不能先花几百 MB 内存再拒。onHeader 抛什么就抛什么（文件句柄在调用方的 finally 里关）。
    if (header !== null && !headerReported) {
      headerReported = true;
      if (onHeader) await onHeader(header);
    }
    const start = projectTreeBuffer(data, projection, 0);
    // 摘要只吃**完整行**（`[0, consumed)` 精确到行边界）：`data` 的起点永远等于上一次的 `consumed`
    // （carry = 上一次那半行），所以这样链下去就是 `[0, consumed)` 的逐字节摘要。
    if (digest && start > 0) digest.update(data.subarray(0, start));
    consumed = dataStart + start;
    carry = Buffer.from(data.subarray(start));
    position += bytesRead;
    if (onProgress) onProgress(consumed, dense);
  }
  return { consumed, header, dense };
}

function sseWrite(response, event, data, id = undefined) {
  if (response.destroyed || response.writableEnded) return;
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function beginSse(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write('retry: 1000\n\n');
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref?.();
  const closed = new Promise((resolve) => {
    const finish = () => {
      clearInterval(heartbeat);
      resolve();
    };
    request.once('aborted', finish);
    response.once('close', finish);
  });
  return closed;
}

function eventPayload(event) {
  if (event.type === 'message_start' && event.message?.role === 'assistant') {
    return { name: 'session.start', data: { role: 'assistant' } };
  }
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    return { name: 'session.delta', data: { channel: 'text', delta: event.assistantMessageEvent.delta } };
  }
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta') {
    return { name: 'session.delta', data: { channel: 'thinking', delta: event.assistantMessageEvent.delta } };
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    return {
      name: 'session.end',
      data: {
        stopReason: event.message.stopReason ?? null,
        errorMessage: event.message.errorMessage ?? null,
        text: contentText(event.message.content),
      },
    };
  }
  if (event.type === 'queue_update') {
    return { name: 'session.queue', data: { steering: event.steering, followUp: event.followUp } };
  }
  // M-36：自动重试的可见反馈。修前服务端只把 `auto_retry_*` 记成 busy（`setBusy('retry')`，
  // 前端仅用它「启用停止按钮」）—— 用户看到的是「卡住了」。这里把 pi 给的字段**如实**放出去：
  // attempt / maxAttempts / delayMs / errorMessage（`dist/core/agent-session.js:2299-2303`）
  // 与 end 的 success / attempt / finalError（`:412-416`、`:798-802`）。**不新造状态机**：pi 没给的
  // 字段全是 null，不猜（例如 cancelled 那次 end 只有 attempt + finalError）。
  if (event.type === 'auto_retry_start') {
    return {
      name: 'session.retry_start',
      data: {
        attempt: Number.isInteger(event.attempt) ? event.attempt : null,
        maxAttempts: Number.isInteger(event.maxAttempts) ? event.maxAttempts : null,
        delayMs: Number.isFinite(event.delayMs) ? event.delayMs : null,
        errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : null,
      },
    };
  }
  if (event.type === 'auto_retry_end') {
    return {
      name: 'session.retry_end',
      data: {
        success: event.success === true,
        attempt: Number.isInteger(event.attempt) ? event.attempt : null,
        finalError: typeof event.finalError === 'string' ? event.finalError : null,
      },
    };
  }
  // 压缩前的「摘要生成」也有一套重试（`_summarizationRetryCallbacks`，`dist/core/agent-session.js:2253-2260`），
  // 同一类「用户只看到卡住」的静默。如实转发（source 说明是哪一种重试）。
  if (event.type === 'summarization_retry_attempt_start') {
    return { name: 'session.summarization_retry_start', data: { source: typeof event.source === 'string' ? event.source : null } };
  }
  if (event.type === 'summarization_retry_finished') {
    return { name: 'session.summarization_retry_finished', data: {} };
  }
  if (event.type === 'compaction_start' || event.type === 'compaction_end') {
    return { name: `session.${event.type}`, data: event };
  }
  if (event.type === 'agent_settled') return { name: 'session.settled', data: {} };
  // ── 工具事件（I-16 / v2.1 `case "tool"`）────────────────────────────────────
  // 此前这里**没有任何映射** ⇒ pi 的 `tool_execution_start/end` 被吞掉，跑工具的那几秒
  // 前端一条信号都收不到（原始证据见 /tmp/live-tools-report.md 的「真实链路」一节）。
  // 直播工具卡要的就是这两相；`tool_execution_update`（partialResult）**以前故意不转** ——
  // v2.1 的契约只有 start/end，结果在 end 一次给全。2026-09-22 业主裁定要「跑的过程中实时显示
  // 已产出的输出」，于是**新增**第三相 `session.tool_update`（append-only：start/end 的字段一字未动）。
  // ⚠️ 这两个事件带上 `startedAt`/`endedAt`：pi 的 `tool_execution_start/end` **本身没有时间戳**
  // （`dist/core/agent-session.js:528-556`），所以这里是服务端收到该事件那一刻的观测时间。
  if (event.type === 'tool_execution_start') {
    return { name: 'session.tool_start', data: { toolCallId: event.toolCallId ?? null, name: event.toolName ?? 'tool', args: event.args ?? {}, startedAt: new Date().toISOString() } };
  }
  // ── `tool_execution_update` → `session.tool_update`（实时输出，2026-09-22 新增）──────────────
  // ⚠️ **这一帧里的 `text` 是「到目前为止的全部输出」的累积快照，不是 delta**。原始证据：
  // pi 的 bash 工具在 `onUpdate` 里给的是 `output.snapshot()`（`dist/core/tools/bash.js:155-199`），
  // 那是 `OutputAccumulator` 到此刻为止的全部内容（`dist/core/tools/output-accumulator.js:69-95`），
  // 由 `agent-loop.js:468` 包成 `{type:'tool_execution_update', toolCallId, toolName, args, partialResult}`。
  // ⇒ 前端必须按「最新快照**替换**实时尾」，而不是把帧 append 成一串（否则同一段会叠很多遍）。
  // 节流是 pi 给的（`BASH_UPDATE_THROTTLE_MS = 100`，`dist/core/tools/renderers/bash.js:15`）⇒ ≈10 帧/秒。
  // 行数诚实：bash 快照自带 `details.truncation`（`{truncated, truncatedBy, totalLines, outputLines,…}`）
  // —— `totalLines` 是**真实总行数**（哪怕这一帧只给了尾部 N 行），所以「共 M 行 / 尾部 N 行」画得出来。
  // 工具没给 details（或不是 bash 那一套）就一律给 `null` —— 绝不编一个 0 或一个总数。
  if (event.type === 'tool_execution_update') {
    const rawPartial = event.partialResult;
    const partialContent = Array.isArray(rawPartial)
      ? rawPartial
      : (Array.isArray(rawPartial?.content) ? rawPartial.content : null);
    const partialDetails = rawPartial !== null && typeof rawPartial === 'object' && !Array.isArray(rawPartial)
      ? (rawPartial.details ?? null)
      : null;
    // pi 的 bash 工具只在**真的被截断**时才给 `truncation`（`dist/core/tools/bash.js` 的 `formatOutput`
    // —— 逐字：`details = { truncation, fullOutputPath }` 只在 `truncation.truncated` 为真时构造）。
    // 反过来，`details` 对象**在**但 `truncation` **不在** ⇒ 这一帧就是全部输出（行数可以精确算）。
    // ⚠️ 这条判据靠的是 pi 那个对象的**键在不在**；pi 一改就会变成 `complete:false`（UI 退到
    // 「至少 N 行」那一档）—— **这就是想要的方向**：宁可说少，不说多。
    const detailsPresent = partialDetails !== null && typeof partialDetails === 'object';
    const hasTruncationKey = detailsPresent && Object.prototype.hasOwnProperty.call(partialDetails, 'truncation');
    const truncation = hasTruncationKey && partialDetails.truncation !== null && typeof partialDetails.truncation === 'object'
      ? partialDetails.truncation
      : null;
    return {
      name: 'session.tool_update',
      data: {
        toolCallId: event.toolCallId ?? null,
        name: event.toolName ?? 'tool',
        text: contentText(partialContent ?? rawPartial),
        truncated: truncation?.truncated === true,
        truncatedBy: typeof truncation?.truncatedBy === 'string' ? truncation.truncatedBy : null,
        totalLines: Number.isFinite(truncation?.totalLines) ? truncation.totalLines : null,
        emittedLines: Number.isFinite(truncation?.outputLines) ? truncation.outputLines : null,
        lastLinePartial: truncation?.lastLinePartial === true,
        // 「这一帧就是全部输出」—— 只有 pi **明确**说了（给了 details、且里面没有 truncation）才 true。
        complete: hasTruncationKey && truncation === null,
        at: new Date().toISOString(),
      },
    };
  }
  if (event.type === 'tool_execution_end') {
    // ⚠️ **append-only**：`result`（压平后的纯文本）是老消费者（`web/app.js` 的直播卡）读的字段，
    // 一个字都不许动/删。这次**新增**两个字段，把 `result` 那条路先前丢掉的两类结构化输出原样透出：
    //   · `details` —— 就是 pi 给的那份 `ToolResultMessage.details`（`docs/session-format.md:98`），**原样**、
    //     不套 `detailsWire()` 的 `{status,value,…}` 壳、不截断。`edit` 的 `{diff,firstChangedLine}` 就挂在这。
    //     没有（`undefined`/`null`）⇒ `null`（诚实给"没有"，不编一个空对象）。
    //   · `content` —— `event.result.content` 的内容块数组，**形状与 `/messages` 里配对的 toolResult
    //     message 的 `content` 逐块一致**（`[{type:'text',…}, {type:'image',data,mimeType}]`）。名字就叫
    //     `content`：前端可以直接把它当那条 message 的 `content` 交给同一个 `imageBlocksOf()`/`imageFigure()`
    //     渲染图片块，不必为直播路再写一套。缺 ⇒ `null`。
    // pi 有的老版本把 `event.result` 直接给成内容块数组（无 `.content`）—— 与既有 `contentText(event.result?.content ?? event.result)`
    // 同一套兼容：数组即内容块。
    const rawResult = event.result;
    const resultContent = Array.isArray(rawResult)
      ? rawResult
      : (Array.isArray(rawResult?.content) ? rawResult.content : null);
    const resultDetails = rawResult !== null && typeof rawResult === 'object' && !Array.isArray(rawResult)
      ? (rawResult.details ?? null)
      : null;
    return {
      name: 'session.tool_end',
      data: {
        toolCallId: event.toolCallId ?? null,
        name: event.toolName ?? 'tool',
        isError: event.isError === true,
        result: contentText(rawResult?.content ?? rawResult),
        details: resultDetails,
        content: resultContent,
        endedAt: new Date().toISOString(),
      },
    };
  }
  return null;
}

// ── 扩展 UI 上下文（M-41：把插件的 `ctx.ui.notify` 从「网页全静默」变成可见）────────────────
// pi 的 runner 默认挂 `noOpUIContext`（`mode:'print'`）⇒ 插件 notify 全部被丢掉（网页上什么都
// 看不到）。这里在会话创建后立刻给 runner 换上一份本层实现。取向是**最小差量**：
//   · 只有 `notify` 真实现（转成 `session.notice` 瞬时事件，只发本会话 SSE 订阅者）；
//   · 对话框类（select/confirm/input/editor/custom）返回 noOp 默认值**且**发一条 warning ——
//     静默正是要修的毛病，抛错又可能打断会话，所以「可见地按取消/默认处理」；
//   · 装饰类原样继承 pi 的 noOp（含 theme getter 等）—— 它们今天就不渲染，这次也不接。
const EXTENSION_NOTICE_MAX_CHARS = 8000;
const EXTENSION_NOTICE_TRUNCATION_MARK = '\n…（通知过长，已截断）';

function createExtensionUiContext(emit, fallback) {
  const post = (text, level) => {
    const raw = typeof text === 'string' ? text : String(text ?? '');
    const body = raw.length > EXTENSION_NOTICE_MAX_CHARS
      ? `${raw.slice(0, EXTENSION_NOTICE_MAX_CHARS)}${EXTENSION_NOTICE_TRUNCATION_MARK}`
      : raw;
    // 瞬时通知：只发给**此刻**的 SSE 订阅者，不落会话文件。没人订阅就自然丢弃（不抛错）。
    emit('session.notice', { level, text: body, source: 'extension' });
  };
  const unsupported = (kind) => post(`插件请求了交互式对话框（${kind}），网页端暂不支持 ⇒ 已按“取消/默认”处理。`, 'warning');
  return {
    // 装饰类（setStatus/setWidget/theme/…）原样继承 pi 的 noOp 实现 —— 行为与今天一字不差。
    ...fallback,
    notify(message, type) {
      post(message, type === 'warning' || type === 'error' ? type : 'info');
    },
    async select() { unsupported('select'); return undefined; },
    async confirm() { unsupported('confirm'); return false; },
    async input() { unsupported('input'); return undefined; },
    async editor() { unsupported('editor'); return undefined; },
    async custom() { unsupported('custom'); return undefined; },
  };
}

// ── 「到点如实降级」的通用死线工具（三条死线的语义见 `createLogic` 里那段注释）──────────────
// `null` = 没有死线（旧行为，留给反向臂与回退用）。
function envDeadlineMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${name}: ${raw} (>= 0; 0 = no deadline)`);
  return value === 0 ? null : Math.floor(value);
}

// 把一个 promise 套上**显式死线**：到点回 `{ timedOut: true }`，而不是让调用方永远 await 下去。
// 底下的 promise 后来无论怎么收场都不会变成 unhandled rejection（这里替它挂了 handler）；
// 错误被收进 `{ timedOut:false, error }` 由调用方决定抛出。
function raceDeadline(promise, ms) {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) {
    return promise.then(
      (value) => ({ timedOut: false, value }),
      (error) => ({ timedOut: false, error }),
    );
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ timedOut: false, value }); },
      (error) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ timedOut: false, error }); },
    );
  });
}

// abort 自己的死线（模块级：`createRuntimeAdapter` 与 `createLogic` 都要用）：
// `session.abort()` = pi 的 `agent.abort()` + `await waitForIdle()`（**无死线**），工具不返回就永不 resolve。
const ABORT_DEADLINE_MS = envDeadlineMs('SOPHO_ABORT_TIMEOUT_MS', 2000);

function createRuntimeAdapter({ session, manager, generationId, logicVersion, loadedAt, emitTree, reportLifecycle, titleSourceFor = null, onTitleObserved = null, onCompactionSettled = null, onTurnSettled = null }) {
  let handle = null;
  let disposed = false;
  let admissionPending = false;
  // 「压缩即封存」的两个派生条件（见下面 `compaction_end` / `agent_settled` 两段的注释）：
  //   · `compactionSeen`：**回合内部**压过一次（pi 自己的自动压缩）⇒ 回合落定之后派生一次封存；
  //   · `explicitCompaction`：这一次压缩是**显式** `POST /compact`（或 handoff 的 `compress:"session"`）
  //     那条路要的 —— 它不是「压缩回合」，也不该在用户还在用这条会话时把 runtime 收掉。
  let compactionSeen = false;
  let explicitCompaction = false;
  // 这次准入是不是“我自己正在派发一条扩展命令”（而不是真 prompt）：两者都会把 admissionPending 置真。
  let commandAdmission = false;
  let compactionPending = false;
  let eventSequence = 0;
  const listeners = new Set();

  const emit = (name, data = {}) => {
    const value = { seq: ++eventSequence, at: new Date().toISOString(), type: name, sessionId: manager.getSessionId(), ...data };
    for (const listener of listeners) listener(value);
    if (!TREE_EVENT_SUPPRESSED.has(name)) emitTree(manager.getSessionId(), name);
  };

  // M-41：会话创建后立刻把扩展 UI 上下文挂到 runner 上（`hasUI()` 因此变 true）。
  // 查清「绑定要跟得住」：逻辑层没有 in-place `session.reload()`/`bindExtensions()`；唯一的
  // reload 是宿主换 generation worker（新进程、新会话，openRuntime 会重新绑定），所以 runner 级
  // 绑定足够。若将来引入 `session.reload()`，要改用 `session.bindExtensions({uiContext, mode:'rpc'})`
  // 才会在重建 runner 后自动重挂 —— 那条路会顺带发 `session_start`，本次刻意不接。
  try {
    const extensionRunner = session.extensionRunner;
    if (extensionRunner && typeof extensionRunner.setUIContext === 'function') {
      extensionRunner.setUIContext(createExtensionUiContext(emit, extensionRunner.getUIContext?.()), 'rpc');
    }
  } catch (error) {
    // 绑定失败不能让整个会话起不来：如实记一条 error 事件（不是静默）。
    emit('session.error', { message: `extension UI context binding failed: ${normalizeError(error).message}` });
  }

  // 推荐回复（下一句候选）：**同一个 messageId 只派生一次**（压缩回合落定、重试结束这类
  // 会再次 settle，但尾巴那条助手消息没变 ⇒ 不重复问模型；`agent_settled` 的语义就是
  // 「pi 不会再自己继续了」，所以这是上下文最完整的那一个时刻）。
  let suggestedMessageId = null;
  /** 回合落定 → 把**这一刻**的事实同步快照下来，交给逻辑层异步跑（逻辑层负责设置开关、
   *  超时、严格校验、落盘与发事件）。这里**不许** `await` —— 这是 pi 的事件回调里，
   *  一 await 就把这一轮的收尾（`session.settled` 帧）拖在模型调用后面了（这就是两条反证臂里
   *  「把生成改成阻塞」那一条的形状）。 */
  function noteTurnSettled() {
    if (!onTurnSettled) return undefined;
    const messageId = lastAssistantEntryId(manager);
    if (messageId === null) return undefined;
    if (messageId === suggestedMessageId) return undefined;
    suggestedMessageId = messageId;
    // 返回那个 job 的 promise（**调用方这里刻意不看它** —— 不 await 就是「不阻塞回合」本身；
    // 依赖注入的那一端可以选择 await，那正是反证臂 `mutant-blocking` 注入的形状）。
    return onTurnSettled({
      sessionId: manager.getSessionId(),
      messageId,
      model: session.model ?? null,
      runtime: session.modelRuntime ?? null,
      transcript: suggestionTranscript(manager),
      emit,
    });
  }

  const queueSnapshot = () => {
    try {
      return {
        steering: [...(session.getSteeringMessages?.() ?? [])],
        followUp: [...(session.getFollowUpMessages?.() ?? [])],
      };
    } catch {
      return { steering: [], followUp: [] };
    }
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'agent_start') {
      handle?.setActive(true);
      reportLifecycle?.({ phase: 'start', sessionId: manager.getSessionId() });
    }
    if (event.type === 'agent_settled') {
      handle?.setActive(false);
      handle?.settled();
      reportLifecycle?.({ phase: 'settled', sessionId: manager.getSessionId() });
      void handle?.refreshPersistence().catch((error) => emit('session.error', { message: normalizeError(error).message }));
      // 「压缩即封存」的自动触发点：**压缩回合落定之后**（绝不在压缩那一刻 —— pi 的压缩发生在回合内部）。
      // 派生一次；真正能不能做由逻辑层在**第一个空闲时刻**判（isWorking + 没有 runtime 持有它）。
      if (compactionSeen) {
        compactionSeen = false;
        onCompactionSettled?.(manager.getSessionId());
      }
      // 推荐回复的触发点：**回合落定之后**（最后一条助手消息已落盘 ⇒ 上下文完整）。
      // 注意这里**不 await**：真正的模型调用在逻辑层（`void` 起的后台 job）；把它们排在一起，
      // 但这条只做同步快照（见 `noteTurnSettled`）。
      noteTurnSettled();
    }
    if (event.type === 'queue_update') handle?.setPendingMessages(event.steering.length + event.followUp.length);
    if (event.type === 'compaction_start') handle?.setBusy('compaction', true);
    if (event.type === 'compaction_end') {
      handle?.setBusy('compaction', false);
      // 只记「这一轮压过」这个事实（回合落定那一刻由 `agent_settled` 派生）。
      // ⚠️ **显式压缩不算**：`POST /compact`（与 handoff 的 `compress:"session"`）走的
      // `session.compact()` 不是一次「压缩回合」—— 它没有回合可等，用户往往正拿着这条会话继续用；
      // 那两条路要封存就用显式 `POST /sessions/{id}/seal`（本次不替它们做决定）。
      if (explicitCompaction) explicitCompaction = false;
      else compactionSeen = true;
    }
    if (event.type === 'auto_retry_start') handle?.setBusy('retry', true);
    if (event.type === 'auto_retry_end') handle?.setBusy('retry', false);
    if (event.type === 'session_info_changed') {
      // 会话名刚变（pi 的 session_info）。名字从 manager 读回来（不是 event.name），并带上
      // 我们自己账上的来源（seed/auto/manual）—— 前端/诊断据此如实展示，而不是猜。
      // 不是我们自己刚写的那条（外部改的 / 清空）→ 交给逻辑层对账（可能记 manual）。
      const titleSessionId = manager.getSessionId().toLowerCase();
      const titleName = manager.getSessionName() ?? null;
      const titleSource = titleSourceFor?.(titleSessionId, titleName) ?? null;
      if (titleSource === null) onTitleObserved?.(titleSessionId, titleName, manager);
      emit('session.title', { name: titleName, source: titleSource, at: new Date().toISOString() });
      return;
    }
    const mapped = eventPayload(event);
    if (mapped) emit(mapped.name, mapped.data);
  });

  function busyConflict({ requireStreaming = undefined } = {}) {
    if (compactionPending || session.isCompacting) return new HttpError(409, 'session_compacting', COMPACTION_CONFLICT);
    if (admissionPending) return new HttpError(409, 'session_streaming', STREAMING_CONFLICT);
    if (requireStreaming === true && !session.isStreaming) {
      return new HttpError(409, 'session_not_streaming', 'Agent is not currently processing; steer/followUp require an active response.');
    }
    if (requireStreaming === false && session.isStreaming) return new HttpError(409, 'session_streaming', STREAMING_CONFLICT);
    return null;
  }

  function startPrompt(text, images = []) {
    const conflict = busyConflict({ requireStreaming: false });
    if (conflict) throw conflict;
    assertImagesSupported(session, images);
    admissionPending = true;
    // 记下这次准入是“真 prompt”还是“扩展命令”：pi 对 `/cmd` 先派 handler（不会跑模型），
    // 而 handler 回头打 HTTP 时 admissionPending 仍为真 ⇒ 这个区分是 `/move` 能放行自己那条命令的唯一依据。
    commandAdmission = extensionCommandNameIn(session, text) !== null;
    let background;
    let resolveAccepted;
    let rejectAccepted;
    const accepted = new Promise((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const preflightResult = (success) => {
      admissionPending = false;
      commandAdmission = false;
      if (success) resolveAccepted();
      else queueMicrotask(() => background.then(
        () => rejectAccepted(new Error('prompt preflight rejected')),
        (error) => rejectAccepted(error),
      ));
    };
    background = session.prompt(text, {
      preflightResult,
      source: 'interactive',
      ...(images.length > 0 ? { images } : {}),
    });
    background.catch((error) => {
      admissionPending = false;
      commandAdmission = false;
      emit('session.error', { message: normalizeError(error).message });
    });
    return { accepted, background };
  }

  return {
    generationId,
    logicVersion,
    loadedAt,
    cwd: manager.getCwd(),
    get sessionFile() { return session.sessionFile; },
    getCurrentLeafId() { return manager.getLeafId(); },
    attachHandle(value) {
      handle = value;
      handle.setPendingMessages(session.pendingMessageCount);
      if (session.isStreaming) handle.setActive(true);
      if (session.isCompacting) handle.setBusy('compaction', true);
    },
    manager,
    session,
    isWorking() { return admissionPending || compactionPending || session.isStreaming || session.isCompacting || session.isRetrying; },
    // 「此刻唯一的“忙”，是我自己这条 prompt 正在派发一条扩展命令」：pi 先派命令、handler 回来之后
    // 才 `preflightResult(true)`（agent-session.js 的 `_tryExecuteExtensionCommand`）⇒ handler 里打 HTTP 时
    // admissionPending 必真，却**没有任何模型回合在飞**（也没有别的忙因）。`/move` 用它把
    // “命令自己在搬自己”与“真 prompt 的准入窗口 / 真在跑”分开：前者必须放行，后者必须拒绝。
    isAdmittingOwnCommand() {
      return admissionPending && commandAdmission
        && !compactionPending && !session.isStreaming && !session.isCompacting && !session.isRetrying;
    },
    isCommandStreaming() { return admissionPending || session.isStreaming; },
    snapshot() {
      return {
        summary: summaryFromManager(manager, this),
        isStreaming: session.isStreaming,
        isCompacting: session.isCompacting,
        isRetrying: session.isRetrying,
        pendingMessages: session.pendingMessageCount,
        queue: queueSnapshot(),
        model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
        // M-11（只读显示）：pi 的 `AgentSession.thinkingLevel`（`off|minimal|low|medium|high|xhigh|max`）。
        // 这是**追加**字段：既有字段名/类型一个没动；读不到就是 null（前端不猜档位）。
        // 它同时进 `GET /sessions/{id}` 的 `runtime` 与 SSE 的 `session.snapshot`（后者是 snapshot() 的平铺）。
        thinkingLevel: session.thinkingLevel ?? null,
        context: contextOf(session),
        observability: sessionObservability(manager, session.modelRuntime),
      };
    },
    messages() { return messageWire(manager, session.modelRuntime, { isStreaming: session.isStreaming }); },
    // 轻量 getter：`/tree` 只取这一项（不把整份 snapshot 连同 O(entries) 的累计 observability 一起算）。
    context() { return contextOf(session); },
    commands() { return allCommands(session); },
    models() {
      const { source, list } = modelsOf(session);
      const current = session.model ?? null;
      return {
        current: modelRef(current),
        source,
        thinking: {
          current: session.thinkingLevel ?? null,
          levels: thinkingLevelsOfSession(session),
        },
        models: list.map((model) => {
          const input = inputOfModel(model);
          return {
            provider: model.provider,
            id: model.id,
            name: model.name ?? null,
            ref: modelRef(model),
            reasoning: Boolean(model.reasoning),
            input,
            supportsImages: input === null ? null : input.includes('image'),
            thinkingLevels: thinkingLevelsOfModel(model),
            contextWindow: model.contextWindow ?? null,
            current: modelRef(model) === modelRef(current),
          };
        }),
      };
    },
    // 思考写 + 模型写共用一条 owner 路由（`POST /sessions/{id}/model`）：host 的 SESSION_PATH
    // 白名单里没有 `thinking` action，新加 action 会掉到兜底 proxy（稳定宿主本轮不改）。
    // **先验证再 mutation**：目标模型、目标模型的档位清单、当前 busy 都在写之前核完；
    // 两步写（setModel → setThinkingLevel）在同一个 withSession 独占回调里串行，中间没有别的写能插入。
    async setModelAndThinking({ model: wantedModel, thinkingLevel } = {}) {
      const conflict = busyConflict({ requireStreaming: false });
      if (conflict) throw conflict;
      const wantsModel = wantedModel !== undefined;
      const wantsThinking = thinkingLevel !== undefined;
      if (!wantsModel && !wantsThinking) throw new HttpError(400, 'invalid_model', 'model must be a non-empty string');
      if (wantsModel && typeof session.setModel !== 'function') {
        throw new HttpError(409, 'model_switch_unavailable', 'this pi runtime does not expose setModel');
      }
      if (wantsThinking && typeof session.setThinkingLevel !== 'function') {
        throw new HttpError(409, 'thinking_level_unavailable', 'this pi runtime does not expose setThinkingLevel');
      }

      let selected = null;
      let matchedBy = null;
      let source = null;
      if (wantsModel) {
        const models = modelsOf(session);
        source = models.source;
        selected = pickModel(wantedModel, models.list);
        matchedBy = selected?.how ?? null;
        if (selected?.ambiguous) {
          throw new HttpError(409, 'ambiguous_model', `model ${JSON.stringify(wantedModel)} exists under more than one provider`, {
            candidates: selected.ambiguous.map(modelRef),
          });
        }
        if (!selected?.model) {
          throw new HttpError(404, 'model_not_found', `model ${JSON.stringify(wantedModel)} is not available from this session's ${source} model list`, {
            sample: models.list.slice(0, 8).map(modelRef),
          });
        }
      }

      const targetModel = selected?.model ?? session.model ?? null;
      if (!targetModel) throw new HttpError(409, 'thinking_level_unavailable', 'this session has no current model to apply a thinking level to');
      const targetLevels = thinkingLevelsOfModel(targetModel);
      if (wantsThinking && (!targetLevels || !targetLevels.includes(thinkingLevel))) {
        throw new HttpError(409, 'thinking_level_unsupported', `thinking level ${JSON.stringify(thinkingLevel)} is not supported by ${modelRef(targetModel)}`, {
          level: thinkingLevel, levels: targetLevels, model: modelRef(targetModel),
        });
      }

      const previousModel = modelRef(session.model);
      const previousThinking = session.thinkingLevel ?? null;
      if (wantsModel) {
        await session.setModel(targetModel, { persist: false });
        emit('session.model', { model: modelRef(targetModel) });
      }
      if (wantsThinking) {
        session.setThinkingLevel(thinkingLevel);
        if ((session.thinkingLevel ?? null) !== previousThinking) {
          emit('session.thinking', { thinkingLevel: session.thinkingLevel ?? null, previous: previousThinking });
        }
      }
      const actualThinking = session.thinkingLevel ?? null;
      // Pre-validation should make this impossible; if pi still lands elsewhere, say so instead of
      // pretending the requested level was applied. The model write (if any) already happened.
      const partial = wantsThinking && actualThinking !== thinkingLevel;
      return {
        ...(wantsModel ? { model: modelRef(session.model), previous: previousModel, source, matchedBy } : { model: modelRef(session.model) }),
        thinkingLevel: actualThinking,
        previousThinkingLevel: previousThinking,
        thinkingLevels: thinkingLevelsOfModel(session.model),
        thinkingChanged: actualThinking !== previousThinking,
        persist: false,
        ...(partial ? { partial: true, thinkingLevelRequested: thinkingLevel } : {}),
      };
    },
    startPrompt,
    deliverDelegation({ kind, fromSessionId, text, triggerTurn = true }) {
      const message = {
        customType: 'sopho.delegation',
        content: text,
        display: true,
        details: { kind, fromSessionId },
      };
      // 投递语义（业主 **2026-10-13 改判**，问题 q-88e0fad8）：与 `deliverAnswer` 同形 ——
      // **有活跃回合 ⇒ `steer`**（插进当前这一轮：pi 在当前 assistant 回合的工具调用跑完之后、下一次 LLM
      // 调用之前注入它 ⇒ 它会影响这一轮接下来的动作，但**不会硬杀正在跑的命令**）。
      // 旧语义（忙 ⇒ `followUp`）在长 run 里的实测代价：一条 delegate **发出 → 落盘 +68 min 46 s**（其间过了
      // 116 个回合边界都没插进去）。⚠️ pi 的 `sendCustomMessage` 在流式时**默认就是 steer** ⇒ 旧的
      // `'followUp'` 是本仓**主动覆盖**，不是 pi 的默认。
      // 逐支如实算（回执 `mode` 必须与实际送法一致，**不许假回执** —— 我自己就把旧的 `queued:false` 误读过）：
      //   · `triggerTurn:false`（今天只有 handoff 指路那一条）⇒ **pi 根本不看 `deliverAs`**：
      //     `sendCustomMessage` 在 `triggerTurn === false` 时，流式走 `_pendingCustomMessages`（等本回合收尾才落盘）、
      //     空闲直接落盘（`agent-session.js` 的 `sendCustomMessage` 分支）。⇒ steer 对它**不可达**：硬传
      //     `'steer'` 只会是一张假回执。所以那条**保持排队语义**，回执如实说 `followUp`（流式）/`message`（空闲）。
      //   · 有活跃回合（`isStreaming`；`isRetrying` 的退避 sleep 在 `_runAgentPrompt` 的 try 块里 ⇒ 它时
      //     `isStreaming` 必为真，所以这一支已盖住它）⇒ `steer`；
      //   · 忙但**没有活跃回合**（压缩中 / 只剩准入窗口）⇒ steer 的前提不成立，如实退成 `followUp` 排队；
      //   · 都空闲且 `triggerTurn` ⇒ 真起一轮，`message`。
      const streaming = session.isStreaming;
      const busy = streaming || session.isCompacting || session.isRetrying;
      const mode = !triggerTurn
        ? (streaming ? 'followUp' : 'message')
        : streaming ? 'steer' : busy ? 'followUp' : 'message';
      const deliverAs = triggerTurn && (streaming || busy)
        ? (mode === 'steer' ? 'steer' : 'followUp')
        : undefined;
      const background = session.sendCustomMessage(message, { triggerTurn, deliverAs });
      background.catch((error) => emit('session.error', { message: normalizeError(error).message }));
      // `queued` 只在**真进了队列**（`mode:'followUp'`）时为真 ⇒ steer 路径上不再出现 `queued`（与 `deliverAnswer` 同口径）。
      return { queued: mode === 'followUp', mode };
    },
    async deliver(text) {
      const compactionConflict = busyConflict();
      if (compactionConflict?.code === 'session_compacting') throw compactionConflict;
      if (session.isStreaming) {
        await session.steer(text);
        return { accepted: true, mode: 'steer' };
      }
      const started = startPrompt(text);
      await started.accepted;
      return { accepted: true, mode: 'message' };
    },
    async steer(text, images = []) {
      const conflict = busyConflict({ requireStreaming: true });
      if (conflict) throw conflict;
      assertImagesSupported(session, images);
      await session.steer(text, images.length > 0 ? images : undefined);
    },
    async followUp(text) {
      const conflict = busyConflict({ requireStreaming: true });
      if (conflict) throw conflict;
      await session.followUp(text);
    },
    async abort() {
      if (!admissionPending && !compactionPending && !session.isStreaming && !session.isCompacting && !session.isRetrying) {
        return { aborted: false, reason: 'not_running' };
      }
      session.abortCompaction();
      // `session.abort()` = pi 的 `agent.abort()`（信号**同步**发出）+ `await waitForIdle()`（**无死线**）。
      // 工具永不返回时 `waitForIdle()` 永不 resolve ⇒ 这条 await 就是那个**永久占住按会话串行队列**
      // 的东西（它跑在 `runExclusive` 里）。到点**如实**回「没停掉」，绝不把永不 resolve 的 await 留在队列里。
      const outcome = await raceDeadline(session.abort(), ABORT_DEADLINE_MS);
      if (outcome.timedOut) return { aborted: false, reason: 'abort_timeout', retryable: true };
      if (outcome.error) throw outcome.error;
      return { aborted: true, reason: 'aborted' };
    },
    startCompaction(instructions) {
      const conflict = busyConflict({ requireStreaming: false });
      if (conflict) throw conflict;
      compactionPending = true;
      // 这一条是**显式**压缩（`POST /compact` / handoff 的 `compress:"session"`）⇒ 不参与自动封存。
      explicitCompaction = true;
      handle?.setBusy('compaction', true);
      const background = session.compact(instructions).catch((error) => {
        emit('session.error', { message: normalizeError(error).message });
      }).finally(() => {
        compactionPending = false;
        explicitCompaction = false; // 压缩失败/没发 compaction_end 也不要把它一直挂成 true
        handle?.setBusy('compaction', false);
        handle?.settled();
      });
      return background;
    },
    setTitle(name) {
      // 标题**必须**能在模型自己那一轮中途设置（`session_set_title` 工具就是这一轮里调的）——
      // 所以这里**不**做 streaming/compaction 的忙判（v2.1 也没有）。真名仍只由本 worker
      // 这一条路写进会话文件；归档那条仍然守忙判。
      session.setSessionName(name);
      return manager.getSessionName() ?? null;
    },
    // `meta`（可选）只承载**归档审计**：agent 工具把自己是谁 / 什么时候做的带进来，落成同一条
    // append-only `sopho.archive` 条目的附加字段（`by` / `at`）。读它的两个地方（`latestArchiveState`
    // 与 `/tree` 的字节投影）都只认 `data.archived`，多出来的字段一律忽略 ⇒ 这是**向后兼容的加法**；
    // 网页（人）那条路不传 `meta`，写法逐字不变。
    // `options.ignoreBusy`（归档 cwd 已消失的会话时用）：那时**不守忙判** —— 那种会话已经不能继续、
    // 跑着的回合也永远收不回来，而归档只是追加一条元数据账（与 `appendQuestionEntry` 同类）；
    // cwd 在的会话照旧守忙判。默认 false 时写法与忙判与以前逐字相同。
    setArchived(archived, meta = {}, { ignoreBusy = false } = {}) {
      const conflict = ignoreBusy ? null : busyConflict({ requireStreaming: false });
      if (conflict) throw conflict;
      manager.appendCustomEntry(ARCHIVE_ENTRY, { ...meta, archived: Boolean(archived) });
      emit('session.archive', { archived: Boolean(archived), ...meta });
      return Boolean(archived);
    },
    // 问题条目：append-only，**不碰队列/不碰 streaming**（提问不许阻塞会话）。
    // 写进文件后立刻广播 `session.question`，让前端（另一条 landing）能感知"新问题在等你"。
    appendQuestionEntry(data) {
      const entryId = manager.appendCustomEntry(QUESTION_ENTRY, data);
      emit('session.question', {
        op: data.op,
        id: data.id,
        text: data.text ?? null,
        priority: data.priority ?? null,
        answer: data.answer ?? null,
        closeReason: data.closeReason ?? null,
        by: data.by ?? null,
        at: data.at ?? null,
        entryId,
      });
      return entryId;
    },
    /**
     * 回答要**作为一条 user 消息**进会话（方案 §4），所以它触发一轮回复。
     * **业主 2026-09-22 拍板：投递语义与「用户在输入框打字」那条路统一成 `steer`** ——
     * 打字那条（`web/app.js` 的 `send()`）凭 SSE 的 `agentBusy` 选：忙 ⇒ `POST /steer`（插进当前这一轮），
     * 闲 ⇒ `POST /message`。以前回答那条相反：忙 ⇒ `followUp`（等这一轮跑完才送达）。两条入口在「忙」时
     * 默认语义相反是缺陷 ⇒ 现在回答走同一条：**会话确实有活跃回合 ⇒ `steer`**。
     *
     * 四种情形（回执如实说，不许与事实不符）：
     * · `compactionPending || session.isCompacting` ⇒ 409 `session_compacting`（那时**没有** agent run 可插话）；
     * · `session.isStreaming`（有活跃回合）⇒ `session.steer(text)`，回执 `mode:'steer'`、`queued:false`
     *   —— **不是排队**：pi 的 steer 在「当前 assistant 回合的工具调用跑完之后、下一次 LLM 调用之前」注入
     *   ⇒ 它**会影响当前这一轮的行为**（`agent-loop.js` 的 `getSteeringMessages` 即在回合边界被拉取）。
     *   ⚠️ pi 的 `isRetrying`（自动重试的退避 sleep）**包含在** `_runAgentPrompt` 的 try 块里
     *   （`_prepareRetry` 只被 `_handlePostAgentRun` 调用，而它由 `_runAgentPrompt` 的 while 驱动）
     *   ⇒ `isRetrying === true` 时 `isStreaming` 也必为 true，所以这一支已经覆盖它（旧代码里那个
     *   `|| session.isRetrying` 是冗余的，不是另一条路）。
     * · 忙但**没有活跃回合**（只剩 `admissionPending`：有一条 prompt 正在派发/一条扩展命令正在跑，
     *   `isStreaming` 还是 false）⇒ steer 的前提（有活跃回合可插话）不成立，**如实退成 `followUp`**：
     *   回执 `mode:'followUp'`、`queued:true`，note 明说为什么没走 steer。不静默丢掉、不假装插了话。
     * · 都空闲 ⇒ 真起一轮（`startPrompt`），回执 `mode:'message'`。
     */
    async deliverAnswer(text) {
      if (compactionPending || session.isCompacting) throw new HttpError(409, 'session_compacting', COMPACTION_CONFLICT);
      if (session.isStreaming) {
        await session.steer(text);
        return {
          mode: 'steer',
          queued: false,
          note: '会话正在跑：回答已作为插话注入当前这一轮 ⇒ 它会影响当前这一轮的行为（不再等这一轮跑完）。',
        };
      }
      if (admissionPending) {
        await session.followUp(text);
        return {
          mode: 'followUp',
          queued: true,
          note: '会话正处在准入窗口（有 prompt 正在派发/一条扩展命令正在跑，此刻还没有活跃回合）⇒ steer 的前提不成立；回答已排进 followUp 队列，等那一轮（若这次准入根本不跑模型，则等下一次跑）的回合边界再作为一条 user 消息送达。',
        };
      }
      const started = startPrompt(text);
      await started.accepted;
      return {
        mode: 'message',
        queued: false,
        note: '回答已作为一条 user 消息投进会话，并触发了新一轮回复。',
      };
    },
    /**
     * 卡片级反馈（标注）的**唤醒**：一条 `session.annotation` 事件 ＋ 一条自解释的消息。
     * 为什么两件都要（业主拍的 ② 的两层，缺一不可）：事件只到**在线**的订阅者 ——
     * 空闲会话（没人在看、没有 SSE 订阅者）根本收不到 ⇒ 不把它叫起来，「到达即知道」就只在那个人
     * 恰好开着这一页时成立。消息走 `sendCustomMessage({triggerTurn:true})`（与 `deliverDelegation`
     * 同一条路）：**与 delegate 同口径（业主 2026-10-13 改判，q-88e0fad8）—— 有活跃回合 ⇒ `steer`**（插进
     * 当前这一轮，不再等整个 run 跑完）；忙但没有活跃回合（压缩中）⇒ 如实退成 `followUp`；空闲就真起一轮。
     * · **归档的会话不叫**：如实回执 `session_archived`（调用方如实记日志、不重试）——归档 = 人不看了。
     * · `customType:'sopho.annotation'`（不是 `sopho.delegation`）：这不是子会话在回话，是服务端在报事。
     *   它在网页上落成 `aside.extra-message[data-custom-type="sopho.annotation"]`（**不是**消息卡/工具卡
     *   ⇒ 没有标注按钮 ⇒ 通知不会再产生新标注，即防环）。
     */
    deliverAnnotationNotify({ items, maintainerSessionId, text, legacyArchived = false }) {
      const archived = archiveValue(manager.getEntries(), legacyArchived);
      if (archived) {
        emit('session.annotation.skipped', { reason: 'session_archived', count: items.length, maintainerSessionId });
        return { delivered: false, reason: 'session_archived', count: items.length };
      }
      // 先发事件再投消息：正在看这条会话的人先看到「有新的」，接着文字就到。
      emit('session.annotation', {
        count: items.length,
        maintainerSessionId,
        ids: items.map((item) => item.id),
        items,
      });
      const streaming = session.isStreaming;
      const busy = streaming || session.isCompacting || session.isRetrying;
      // 与 `deliverDelegation` 同口径（业主 2026-10-13 改判）：有活跃回合 ⇒ steer（插进当前这一轮）。
      const mode = streaming ? 'steer' : busy ? 'followUp' : 'message';
      const wakeMessage = {
        customType: 'sopho.annotation',
        content: text,
        display: true,
        details: { kind: 'annotation.feedback', maintainerSessionId, count: items.length, ids: items.map((item) => item.id) },
      };
      const background = session.sendCustomMessage(wakeMessage, { triggerTurn: true, deliverAs: mode === 'steer' ? 'steer' : mode === 'followUp' ? 'followUp' : undefined });
      // 投递是后台的：这一轮真要跑起来才知道它成不成 —— 失败不能静默（与 `deliverDelegation` 同口径）。
      background.catch((error) => emit('session.error', { message: normalizeError(error).message }));
      return { delivered: true, count: items.length, mode, queued: mode === 'followUp' };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose(reason) {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      emit('session.runtime_disposed', { reason });
      session.dispose();
      listeners.clear();
    },
  };
}

export function createLogic({ logicVersion, generationId = logicVersion, codeRevision = null, onRoute = null }) {
  const reportRoute = (event) => {
    if (typeof onRoute === 'function') onRoute(event);
  };
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || process.env.ASSIST_HOME || process.env.SOPHO_AGENT_DIR || getAgentDir());
  const sessionsRoot = path.resolve(process.env.SOPHO_SESSION_DIR || process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, 'sessions'));
  const loadedAt = new Date().toISOString();
  const assistantExtensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pi-extensions', 'assistant', 'index.ts');
  const devicesFile = path.join(agentDir, 'devices.json');
  const legacyArchiveFile = path.join(agentDir, 'archive.json');
  const placementFile = path.join(agentDir, 'placement.json');
  const cwdRecentsFile = path.join(agentDir, 'cwd-recents.json');
  const exportsRoot = path.join(agentDir, 'exports');
  const handoffsFile = path.join(agentDir, 'handoffs.jsonl');
  // 卡片级反馈（`docs/design-annotations.md` v1）：与 handoffs 同族的 append-only 侧车。
  const annotationsFile = path.join(agentDir, 'annotations.jsonl');
  // 「对话内的推荐回复」的账（与 handoffs/annotations 同族的 append-only 侧车）：一行是一条
  // **已经过严格校验**的候选集，`{at, sessionId, messageId, items, model, ms}`。
  // 为什么不用 pi 的会话文件：会话文件是 pi 的（我们不往里面塞自定义字段），而候选只是这条会话的
  // 一个**注解式**事实；读侧只折出「每个会话最新的那一条」，再挂回它自己那条消息上（见
  // `foldSuggestionRecords` / `attachSuggestions`）。
  const suggestionsFile = path.join(agentDir, 'suggestions.jsonl');
  const titlesFile = path.join(agentDir, 'titles.json');
  // 配置（`docs/design-settings.md` v1）：我们**自己的** ui 设置侧车。绝不写 pi 自己的 `settings.json` ✗。
  // 写者用本文件既有的原子写（temp + fsync + rename + 有界重试）—— 形状/校验/读改写语义在 `ui-settings.mjs`。
  const uiSettingsFile = path.join(agentDir, UI_SETTINGS_FILE_NAME);
  const uiSettings = createUiSettingsStore({ file: uiSettingsFile, writeJson: atomicWriteJson });
  // 卡片级反馈的「到达即知道」（业主 2026-09-22 拍的 ②，`docs/design-annotations.md` §8）：
  // 这一份状态是**每个 worker 进程一份**的（不是账本）。真源永远是 `annotations.jsonl` 那份账：
  // 换代会把待发批次丢掉（已知缺口，写进文档），丢掉的只是「这一批没被叫起来」——
  // 那些条目仍能被 `GET /annotations?state=open` 读到。不第二个账本（少一个文件、少一套对账）。
  const notifyWindow = annotationNotifyWindowMs();
  if (notifyWindow.warning) console.warn(`${ANNOTATION_NOTIFY_LOG}${notifyWindow.warning}`);
  const annotationNotifyWindowBudgetMs = notifyWindow.windowMs;
  const annotationNotify = {
    pending: [],
    timer: null,
    notifiedIds: new Set(),
    last: null,
    skipped: [],
    windows: 0,
    dropped: 0,
  };
  const scratchRoot = path.join(agentDir, 'scratch');
  const rawDeviceProbeTimeout = process.env.SOPHO_DEVICE_PROBE_TIMEOUT_MS ?? '10000';
  const deviceProbeTimeoutMs = Number(rawDeviceProbeTimeout);
  if (!Number.isInteger(deviceProbeTimeoutMs) || deviceProbeTimeoutMs < 1) {
    throw new Error(`invalid SOPHO_DEVICE_PROBE_TIMEOUT_MS: ${rawDeviceProbeTimeout}`);
  }
  const rawDeviceRunTimeout = process.env.SOPHO_DEVICE_RUN_TIMEOUT_MS ?? '60000';
  const deviceRunTimeoutMs = Number(rawDeviceRunTimeout);
  if (!Number.isInteger(deviceRunTimeoutMs) || deviceRunTimeoutMs < 1) {
    throw new Error(`invalid SOPHO_DEVICE_RUN_TIMEOUT_MS: ${rawDeviceRunTimeout}`);
  }
  const rawDeviceRunMaxBytes = process.env.SOPHO_DEVICE_RUN_MAX_BYTES ?? '65536';
  const deviceRunMaxBytes = Number(rawDeviceRunMaxBytes);
  if (!Number.isInteger(deviceRunMaxBytes) || deviceRunMaxBytes < 1) {
    throw new Error(`invalid SOPHO_DEVICE_RUN_MAX_BYTES: ${rawDeviceRunMaxBytes}`);
  }
  const treeListeners = new Set();
  const openSseResponses = new Set();
  // 某条会话自己的直播流（`/sessions/{id}/events`）。只服务一个诚实场景：显式回收一个
  // 带 SSE 订阅者的 runtime（`POST /reclaim {includePinned:true}`）时，把那一路用可重连事件收尾 ——
  // 总不能留一个「● 已连接」却再也不会有事件的死流给客户端。
  const sessionSseResponses = new Map();
  // 因「回收」而收尾的会话直播流累计条数（递增事实，给回执算差值用）。
  let sseStreamsEndedByEvict = 0;
  let treeSequence = 0;
  let modelRuntimePromise;
  let deviceWriteQueue = Promise.resolve();
  let sessionCreateQueue = Promise.resolve();
  let handoffWriteQueue = Promise.resolve();
  let legacyArchiveCache = { signature: null, ids: new Set() };
  // —— /messages 的**响应体**缓存 ——
  // 为什么缓存**序列化后的字节**而不是 wire 对象：
  //  · 记账诚实：串的长度就是它真正占的字节。老实现用「文件大小 × 解析倍数」估计保留量，
  //    60 MB 的会话算出 480 MB > 上限 ⇒ 条目放进去当场就被裁掉 = 缓存等于没有（实测就是如此）；
  //  · 命中路径最省：既不重算 wire，也不重新序列化（61 MB 的 body 序列化一次就是几百 ms）。
  // 键 = 「内容版本」：冷读 = 文件 (size, mtime, **ctime**) + 只读标记；热读 = runtime 的
  // (leafId, isStreaming, isCompacting, model)。版本一变就重算，不变就一字不差地回放上一次的字节
  // （和 sendJson 产出的 body 逐字节相同，所以响应形状/字节数不变）。
  const messageBodyCacheMax = Number(process.env.SOPHO_MESSAGE_CACHE ?? process.env.SOPHO_READONLY_MESSAGE_CACHE ?? 4);
  const messageBodyCacheMaxBytes = Number(process.env.SOPHO_MESSAGE_CACHE_BYTES ?? process.env.SOPHO_READONLY_MESSAGE_CACHE_BYTES ?? 256 * 1024 * 1024);
  // 「客户端走了就停算」的检查周期（ms）。**为什么必须按时间 + 必须让出事件循环**：冷读正文那段
  // `for (line of text.split()) JSON.parse(line)` 是**一段同步代码**，里面 await 都没有 ⇒
  // `response.once('close')`（它才去 abort 那个 signal）根本轮不到跑，`signal.aborted` 在一次 parse
  // 里永远是 false。修前是「每 2000 行看一眼」，在真机最大的那个会话文件上是**死代码**
  // （60 835 111 B / **707 行** ⇒ lineNumber 取不到 2000 的倍数，一次都没看过）。
  // **周期本身也是判据的一部分**（2026-09-25 实测，门 `test:abandoncost`）：50 ms 时这条信号被看见
  // 得太晚、有时整发都算完了 —— 同一道门只把这一档从 50 改成 10、其余一字不动，就从 12/12 红变成
  // 9/10 绿；一条「8 发新夹具 + 50 ms 放弃、每发间隔 400 ms」的链在 50 ms 档下 **7/8 发把 61.7 MB
  // 算完并写进响应体缓存**（worker 自己 `/metrics` 记到写出去 432,165,153 B），10 ms 档下是 **0/8 发、
  // 0 B**。所以默认取 10 ms（`SOPHO_MESSAGE_ABORT_CHECK_MS` 仍可覆盖）。
  // `0` = **完全关掉**正文路径上的「客户端走了」检查（= 修前行为，**只为了反证臂**：
  // 门要能证明「把检查点去掉 ⇒ 红」）。
  const messageAbortCheckMs = Number(process.env.SOPHO_MESSAGE_ABORT_CHECK_MS ?? 10);
  if (!Number.isInteger(messageAbortCheckMs) || messageAbortCheckMs < 0) throw new Error(`invalid SOPHO_MESSAGE_ABORT_CHECK_MS: ${process.env.SOPHO_MESSAGE_ABORT_CHECK_MS}`);
  const messageAbortChecksEnabled = messageAbortCheckMs > 0;
  // 客户端已经走了、这段活没必要再算 ⇒ 抛 treeAbortError（调用方按「没有响应可写」收尾）。
  // `SOPHO_MESSAGE_ABORT_CHECK_MS=0` 时整个判据关掉（反证臂用）。
  function messageAbortError(signal) {
    return messageAbortChecksEnabled && signal?.aborted === true ? treeAbortError(signal) : null;
  }
  const persistedManagerCacheMax = Number(process.env.SOPHO_PERSISTED_MANAGER_CACHE ?? 8);
  const persistedManagerCacheMaxBytes = Number(process.env.SOPHO_PERSISTED_MANAGER_CACHE_BYTES ?? 256 * 1024 * 1024);
  for (const [name, value] of Object.entries({
    SOPHO_MESSAGE_CACHE: messageBodyCacheMax,
    SOPHO_MESSAGE_CACHE_BYTES: messageBodyCacheMaxBytes,
    SOPHO_PERSISTED_MANAGER_CACHE: persistedManagerCacheMax,
    SOPHO_PERSISTED_MANAGER_CACHE_BYTES: persistedManagerCacheMaxBytes,
  })) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`invalid ${name}: ${process.env[name]}`);
  }
  const messageBodyCache = new Map();
  const persistedManagerCache = new Map();
  const sessionFileCache = new Map();
  let messageBodyCacheBytes = 0;
  let persistedManagerCacheBytes = 0;
  // `/tree` 的磁盘索引：文件 → 它那几条投影事实（≈300 B/会话）+ 已扫描到的字节偏移。
  // 按 (size, mtimeMs, ctimeMs) 失效；文件**变长**时只读追加的那一段（可增量）。
  // 为什么不清在内存水位上（clearRebuildableCaches）：它占的是 O(文件数) 而不是 O(字节)，
  // 而一旦清掉，下一次 /tree 又要重读 400 MB —— 反而把内存压力变成 CPU/IO 压力。
  const treeIndexMax = Number(process.env.SOPHO_TREE_INDEX_MAX ?? 4096);
  if (!Number.isInteger(treeIndexMax) || treeIndexMax < 1) throw new Error(`invalid SOPHO_TREE_INDEX_MAX: ${process.env.SOPHO_TREE_INDEX_MAX}`);
  // 冷扫描一次开几个文件：每文件的固定成本主要是 open（Windows + 实时防护），所以这条是杠杆。
  const treeScanConcurrency = Number(process.env.SOPHO_TREE_SCAN_CONCURRENCY ?? 8);
  if (!Number.isInteger(treeScanConcurrency) || treeScanConcurrency < 1 || treeScanConcurrency > 64) {
    throw new Error(`invalid SOPHO_TREE_SCAN_CONCURRENCY: ${process.env.SOPHO_TREE_SCAN_CONCURRENCY} (1..64)`);
  }
  // `/tree` 的**索引死线**（毫秒）。这个数有一条硬约束：必须**小于**宿主等 worker 的那条
  // 硬超时（`server/base.mjs` 的 `workerJson`，默认 5000 ms），否则宿主会在 worker 答复之前
  // 先 abort —— 那正是 2026-09-21 真机上「reload 之后 /tree 永远 500」的机制（见下）。
  // ⚠️ 真正要满足的是**有效**上界：`预算 + 拼行保留额`（保留额 = min(1200, max(50, 0.25×预算))，
  // 见 `listTree`）< 宿主那条硬超时。默认 3500 + 875 = 4375 ms < 5000 ms ✓；把预算调到 4000 就
  // 正好顶到 5000（5000 + 1000）⇒ 那种配置会**重新**把 500 引回来（`test/tree-index-selflock.mjs`
  // 的 arm 0 把这条不等式断言住了）。
  // 到点不是「失败」而是「先回现在有的」：行都对、可能不全（`partial: true`），剩下的扫描
  // 在后台接着跑完。`0` = 旧行为（等到整份索引建完），留给反向臂与回退用。
  const treeIndexBudgetMs = Number(process.env.SOPHO_TREE_INDEX_BUDGET_MS ?? 3500);
  if (!Number.isFinite(treeIndexBudgetMs) || treeIndexBudgetMs < 0) {
    throw new Error(`invalid SOPHO_TREE_INDEX_BUDGET_MS: ${process.env.SOPHO_TREE_INDEX_BUDGET_MS} (>= 0; 0 = legacy unbounded)`);
  }

  // ── 「到点如实降级」的三条死线（2026-10-04 那次 `/tree` 持续 500 的修法）──────────────
  // 同一个机制：某个会话的按会话串行队列（`pool.runExclusive`）被一个**永不 resolve** 的操作占住时，
  // 排在它后面的读（`/tree` 的热 runtime 覆写、`liveSessionFacts()`）都会**一个字不回**，直到宿主那条
  // 5000ms 硬超时把它变成 500。这三条死线把「一个 handle」与「整个 worker」解耦；到点一律**如实**。
  //   · abort（模块级 `ABORT_DEADLINE_MS`）：`await waitForIdle()` 绝不能留在 `runExclusive` 里。
  //   · `/tree` 热覆写 / `liveSessionFacts()`：per-handle 死线，到点**跳过这个 handle 并如实标注**。
  const liveFactsHandleDeadlineMs = envDeadlineMs('SOPHO_LIVE_FACTS_HANDLE_TIMEOUT_MS', 250);
  const treeHandleDeadlineMs = envDeadlineMs('SOPHO_TREE_HANDLE_TIMEOUT_MS', 250);
  // `/tree` 热覆写循环的**总**上限：per-handle 死线在「很多个 handle 同时卡住」时会线性叠加，
  // 这里再钉一条总预算，保证「宁可不全也不给错」不会退化成「拼行那一步什么都不给」
  // （拼行另有 `rowBudgetMs` 保留额，见 `listTree`）。
  const treeHotFactsBudgetMs = envDeadlineMs('SOPHO_TREE_HOT_FACTS_BUDGET_MS', 1500);
  // `0` = **旧行为**（回退 / 反向臂用）：没有死线，也**不留断点** —— 与 2026-09-21 之前一字不差：
  // 中止就是丢掉那一次的投影，于是「一次投影不完」变成一个不动点。
  const treeSelfHeal = treeIndexBudgetMs > 0;
  const treeIndex = new Map();
  let treeScanState = null; // 正在跑的那一次索引刷新（并发 /tree 共享它，见 withTreeIndex）
  // 扫描进度账（只记事实，诊断 / 新门用）：跑了几次、中止了几次、一共投影了多少个文件。
  // 「连续 N 次 /tree 之后 worker 不得继续增长」的判据就是这里的数在客户端走后不再涨。
  let treeScanRuns = 0;
  let treeScanAborts = 0;
  let treeScanFiles = 0;
  // 「被中止后接着扫」与「到点先回部分视图」的次数。它们**不是**成绩单而是事实：
  // resumes > 0 就是说「那一次中止烧掉的字节没有白烧」，partials > 0 就是「有人拿到过不全的树」。
  let treeScanResumes = 0;
  let treeScanPartials = 0;
  // 「扫完再 stat ⇒ 三元组变了 ⇒ 这份投影作废、重扫」的次数（续读锚升级的孪生事实，诊断 / 门用）。
  let treeScanStatRetries = 0;
  // 最近一次列目录的结果：部分视图要说清「一共几个文件 / 已经索引了几个 / 还差几个」。
  let treeIndexListing = null;
  let treeScanLast = null;
  let pool;

  const heapLimitBytes = getHeapStatistics().heap_size_limit;
  const memoryNumber = (name, fallback, { min = 1 } = {}) => {
    const raw = process.env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < min) throw new Error(`invalid ${name}: ${raw}`);
    return Math.floor(value);
  };
  const memoryBudget = {
    heapHighBytes: memoryNumber('SOPHO_MEMORY_HEAP_HIGH_BYTES', heapLimitBytes * 0.60),
    heapLowBytes: memoryNumber('SOPHO_MEMORY_HEAP_LOW_BYTES', heapLimitBytes * 0.45),
    rssHighBytes: memoryNumber('SOPHO_MEMORY_RSS_HIGH_BYTES', heapLimitBytes * 0.95),
    rssLowBytes: memoryNumber('SOPHO_MEMORY_RSS_LOW_BYTES', heapLimitBytes * 0.75),
    reserveBytes: memoryNumber('SOPHO_MEMORY_RESERVE_BYTES', 128 * 1024 * 1024, { min: 0 }),
    // Calibration, not a guess: the transient peak of one /messages is dominated by
    // per-message object overhead, not by text bytes. Measured with
    // `test/a29-runtime-footprint.mjs` (12 MiB wire for a 5 MiB session collected 48-80 MiB
    // of garbage; the 13 MiB / 1521-message shape is the same ratio) the peak lands around
    // file×15-20, and the retained runtime around file×2-3. 8 with the reserve below covers
    // both with margin while still letting the default 4 GiB heap hold dozens of large
    // sessions: this is the *single admission* bound, so it must not be so large that the
    // pool-wide check rejects long before real memory is exhausted.
    sessionMultiplier: memoryNumber('SOPHO_MEMORY_SESSION_MULTIPLIER', 8),
  };
  if (memoryBudget.heapLowBytes >= memoryBudget.heapHighBytes) throw new Error('SOPHO_MEMORY_HEAP_LOW_BYTES must be lower than SOPHO_MEMORY_HEAP_HIGH_BYTES');
  if (memoryBudget.rssLowBytes >= memoryBudget.rssHighBytes) throw new Error('SOPHO_MEMORY_RSS_LOW_BYTES must be lower than SOPHO_MEMORY_RSS_HIGH_BYTES');
  const memoryLatch = createMemoryWatermarkLatch(memoryBudget);
  let reclaimedMemoryEpisode = 0;
  let lastMemoryAction = null;
  let lastMemoryReclaim = null;
  let lastMemoryRejection = null;
  let memoryRejections = 0;

  function cacheSnapshot() {
    const treeIndexCounts = treeIndexTally();
    return {
      persistedManager: { items: persistedManagerCache.size, bytes: persistedManagerCacheBytes, maxItems: persistedManagerCacheMax, maxBytes: persistedManagerCacheMaxBytes },
      readonlyMessages: { items: messageBodyCache.size, bytes: messageBodyCacheBytes, maxItems: messageBodyCacheMax, maxBytes: messageBodyCacheMaxBytes },
      sessionFiles: { items: sessionFileCache.size },
      treeIndex: {
        items: treeIndex.size,
        maxItems: treeIndexMax,
        concurrency: treeScanConcurrency,
        // 死线与自愈的账：budgetMs=0 就是旧行为（没有死线、不留断点）。
        budgetMs: treeIndexBudgetMs,
        rows: treeIndexCounts.rows,                 // 能当行用的条目（=/tree 能看到几个会话）
        checkpoints: treeIndexCounts.checkpoints,   // 投影还没盖到整份文件的断点
        checkpointBytes: treeIndexCounts.checkpointBytes, // 断点里已经投影过的字节（被中止时不会白读的那部分）
        stale: treeIndexCounts.stale,               // 断点里那份**上一次**的行（稍旧但真实，不是猜的）
        resumes: treeScanResumes,
        statRetries: treeScanStatRetries,           // 「扫完 stat 三元组变了 ⇒ 作废重扫」的次数
        partials: treeScanPartials,
        runs: treeScanRuns,
        aborts: treeScanAborts,
        filesProjected: treeScanFiles,
        inFlight: treeScanState !== null,
        last: treeScanLast,
      },
    };
  }

  function memorySample() {
    return memoryLatch.sample(process.memoryUsage());
  }

  function clearRebuildableCaches() {
    const before = cacheSnapshot();
    persistedManagerCache.clear();
    persistedManagerCacheBytes = 0;
    // 关联的压缩结果也在这本账里：先把 `cached` 落回去，再清表，否则在飞的条目会把
    // 字节数继续加进一本已经清零的账。
    for (const entry of messageBodyCache.values()) entry.cached = false;
    messageBodyCache.clear();
    messageBodyCacheBytes = 0;
    return { before, after: cacheSnapshot() };
  }

  function memoryPressureError(sessionId, sessionFile, sessionFileBytes, sample, predictedPeakBytes, reason) {
    memoryRejections += 1;
    lastMemoryAction = lastMemoryRejection = {
      at: new Date().toISOString(),
      action: 'reject',
      reason,
      sessionId,
      sessionFile,
      sessionFileBytes,
      predictedPeakBytes,
      sample,
    };
    return new HttpError(503, 'worker_memory_pressure', `worker cannot safely load session ${sessionId} within its memory budget; retry after other sessions become reclaimable`, {
      retryable: true,
      sessionId,
      sessionFileBytes,
      predictedPeakBytes,
      current: { heapUsedBytes: sample.heapUsed, rssBytes: sample.rss, pressure: sample.pressure },
      watermarks: memoryBudget,
      reason,
    });
  }

  // Admission for a session the pool is about to touch. `sessionFileBytes` is the size the
  // pool last verified (open / settle / release / evict); when the pool has no number yet
  // (pending session, or a caller that reached here directly) we stat once ourselves.
  async function admitSession(sessionId, sessionFile, { reclaimMemory = null, sessionFileBytes = null } = {}) {
    if (!sessionFile) return { sessionFileBytes: 0, predictedPeakBytes: memoryBudget.reserveBytes };
    let size = sessionFileBytes;
    if (size === null) {
      let info;
      try { info = await stat(sessionFile); } catch (error) {
        if (error?.code === 'ENOENT') return { sessionFileBytes: 0, predictedPeakBytes: memoryBudget.reserveBytes };
        throw error;
      }
      size = info.size;
    }
    const predictedPeakBytes = size * memoryBudget.sessionMultiplier + memoryBudget.reserveBytes;
    const singleFileBudget = Math.min(memoryBudget.heapHighBytes, memoryBudget.rssHighBytes);
    let sample = memorySample();
    if (predictedPeakBytes > singleFileBudget) {
      throw memoryPressureError(sessionId, sessionFile, sessionFileBytes, sample, predictedPeakBytes, 'single_session_prediction_exceeds_budget');
    }
    const unsafe = () => sample.heapUsed + predictedPeakBytes > memoryBudget.heapHighBytes
      || sample.rss + predictedPeakBytes > memoryBudget.rssHighBytes;
    if ((sample.pressure && reclaimedMemoryEpisode !== sample.episode) || unsafe()) {
      const caches = lastMemoryReclaim && reclaimedMemoryEpisode === sample.episode
        ? { skipped: 'already_cleared_in_pressure_episode', before: cacheSnapshot(), after: cacheSnapshot() }
        : clearRebuildableCaches();
      const evicted = reclaimMemory ? await reclaimMemory() : await pool.sweep({ memoryPressure: true });
      globalThis.gc?.();
      sample = memorySample();
      reclaimedMemoryEpisode = sample.episode;
      lastMemoryAction = lastMemoryReclaim = {
        at: new Date().toISOString(),
        action: 'reclaim',
        reason: sample.pressure ? 'watermark' : 'predicted_peak',
        sessionId,
        sessionFile,
        sessionFileBytes,
        predictedPeakBytes,
        evicted,
        caches,
        sample,
      };
    }
    if (unsafe()) {
      throw memoryPressureError(sessionId, sessionFile, sessionFileBytes, sample, predictedPeakBytes, 'predicted_peak_exceeds_budget_after_reclaim');
    }
    return { sessionFileBytes, predictedPeakBytes };
  }

  // v2.1 kept archive state in `$AGENT_DIR/archive.json`. v2.2 writes an
  // append-only `sopho.archive` entry into each session instead, but cutover
  // must remain read-compatible without mutating a real profile. Cache the
  // sidecar by mtime+size+**ctime** so `/tree` does not re-read it for every
  // request — ctime is what catches an in-place rewrite that happens to keep
  // both size and mtimeMs (see the file-identity note in `fileMessageBody`).
  async function legacyArchiveIds() {
    let fileStat;
    try {
      fileStat = await stat(legacyArchiveFile);
    } catch {
      legacyArchiveCache = { signature: 'missing', ids: new Set() };
      return legacyArchiveCache.ids;
    }
    const signature = `${fileStat.mtimeMs}:${fileStat.size}:${fileStat.ctimeMs}`;
    if (legacyArchiveCache.signature === signature) return legacyArchiveCache.ids;
    let ids = new Set();
    try {
      const value = JSON.parse(await readFile(legacyArchiveFile, 'utf8'));
      if (plainObject(value)) ids = new Set(Object.keys(value).map((id) => id.toLowerCase()));
    } catch {
      // A missing, concurrently replaced, or malformed legacy ledger is an
      // empty ledger. The next mtime/size/ctime change invalidates this result.
    }
    legacyArchiveCache = { signature, ids };
    return ids;
  }

  const emitTree = (sessionId, reason) => {
    const event = { seq: ++treeSequence, at: new Date().toISOString(), type: 'tree.session', sessionId, reason };
    for (const listener of treeListeners) listener(event);
  };

  // ─────────────────────── 标题：这个会话在树上叫什么 ───────────────────────
  // 与 v2.1 同一套规则（seed / auto / manual 三态 + 「绝不覆盖用户手动标题」），按 v2.2 的
  // owner-worker 架构重接：真名仍只写在**会话文件**里（pi 的 session_info，由 owner worker 调
  // `session.setSessionName()` 写 —— 会话文件的单写者不变）；`$ASSIST_HOME/titles.json` 只是
  // 我们这一层的**账**（这条标题是谁给的、什么时候给的），判「要不要覆盖」只看它。
  //   · `seed`   L0 确定性种子（零 LLM）：create 时**显式给**的名字，或会话收到第一条 user
  //              消息时用它的第一行当标题。
  //   · `auto`   L1 模型自己起 / 改：插件工具 `session_set_title` → `POST /sessions/{id}/title`。
  //   · `manual` 人给的：`PATCH /sessions/{id} {name}`、TUI `/name`、或手改会话文件。
  // 判「manual」的判据（与 v2.1 一致）：会话文件里当下的名字 ≠ 我们账上那条 ⇒ 名字是**别人**设的
  // ⇒ 记 manual，此后 auto/seed 一律被拒（这叫「用户手动标题不被覆盖」）。
  //
  // ⚠️ 会话文件按 owner 路由：标题设置请求经宿主路由到 owner worker 后才到得了这里，
  //   所以 `session.setSessionName()` 仍只有一个写者。sidecar 的写是原子的（tmp→fsync→rename）。
  //
  // ⚠️ **为什么不另开 `POST /sessions/{id}/title-changed`**（v2.1 有那条插件上报路）：v2.1 里插件
  //   跑在另一个进程（TUI）侧，得靠上报把「别人改了名字」告诉逻辑层；v2.2 里插件 runtime 就在
  //   owner worker **同一个进程**里，pi 的 `session_info_changed` 由本文件 adapter 的订阅**同步**
  //   收到（见 createRuntimeAdapter），上报绕一圈是重复的第二条路。而且宿主的 `SESSION_PATH`
  //   正则只把 `title` 路由到 owner worker（`title-changed` 不在其中），真加那条路会被错路由到
  //   current generation —— 对外部手改文件的会话反而对不了账。外部改动由「读时对账」（GET /titles、
  //   每次 applyTitle）盖住，不需要第二条写路。
  //
  // 一屏能看全的上限。24 = 树那一行的宽度（比模型被告知的「≤20 字」宽一点：留点余量给
  // 「不听话但内容好」的标题）。`SOPHO_TITLE_MAX` 可改。
  const rawTitleMax = process.env.SOPHO_TITLE_MAX ?? '24';
  const titleMax = Number(rawTitleMax);
  if (!Number.isInteger(titleMax) || titleMax < 4) throw new Error(`invalid SOPHO_TITLE_MAX: ${rawTitleMax}`);
  const TITLE_SOURCES = new Set(['seed', 'auto', 'manual']);
  const titleLog = (message) => console.log(`[title ${generationId}] ${message}`);
  // 我们自己正在写、还没收到回声的那条标题。adapter 的 `session_info_changed` 监听是**同步**
  // 触发的：靠它才分得清「这条事件是我们刚 setSessionName 的回声」还是「别人改的」——
  // 分不清就会把我们自己的写误记为 manual（标题被锁死，模型再也改不了）。
  const expectedTitleWrites = new Map(); // sessionId -> { title, source }
  let titleWriteQueue = Promise.resolve();

  function titlesInvalid(detail) {
    return new HttpError(500, 'titles_invalid', `${titlesFile} is invalid: ${detail}`, { file: titlesFile });
  }

  // titles.json 是**义务账**：坏了就大声报错，绝不当作空账 —— 空账意味着「用户没改过」，
  // 那会让下一次 auto 覆盖掉用户手设的标题（比 /tree 暂时读不出来坏得多）。
  async function readTitles() {
    let text;
    try {
      text = await readFile(titlesFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, value: {} };
      throw titlesInvalid(`cannot read: ${normalizeError(error).message}`);
    }
    const jsonText = text.startsWith('\uFEFF') ? text.slice(1) : text;
    let value;
    try {
      value = JSON.parse(jsonText);
    } catch (error) {
      throw titlesInvalid(normalizeError(error).message);
    }
    if (!plainObject(value)) throw titlesInvalid('top level must be an object keyed by full session UUID');
    for (const [id, record] of Object.entries(value)) {
      if (!FULL_UUID.test(id)) throw titlesInvalid(`key ${JSON.stringify(id)} is not a full session UUID`);
      if (!plainObject(record)) throw titlesInvalid(`record ${id} must be an object`);
      if (record.title !== null && typeof record.title !== 'string') throw titlesInvalid(`record ${id} title must be a string or null`);
      if (!TITLE_SOURCES.has(record.source)) throw titlesInvalid(`record ${id} source must be one of ${[...TITLE_SOURCES].join(', ')}`);
      if (!Number.isInteger(record.at) || record.at < 0) throw titlesInvalid(`record ${id} at must be a non-negative integer`);
    }
    return { exists: true, value };
  }

  // 只读路径（/tree）用：账读不出来时**如实**把 titleSource 报成 null 并带一个 error，而不是让
  // 整棵树 500（标题只是辅助信息）。写路径（applyTitle / 对账 / GET /titles）绝不吞错。
  async function readTitlesSafe() {
    try {
      const read = await readTitles();
      return { ok: true, exists: read.exists, value: read.value, error: null };
    } catch (error) {
      return { ok: false, exists: true, value: {}, error: normalizeError(error).message };
    }
  }

  // 本 worker 内串行；跨 generation 只靠「写前重读 + 原子 rename」兜底（与 placement.json 同一
  // 取舍，见 docs/handoff.md）。每条记录的实际写者是它当时的 owner worker，不会两条会话互相盖。
  function queueTitleWrite(operation) {
    const result = titleWriteQueue.then(operation, operation);
    titleWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function writeTitleRecord(sessionId, record) {
    return queueTitleWrite(async () => {
      const current = await readTitles(); // 写前重读：不拿旧账盖掉别人刚写的
      const next = { ...current.value };
      next[sessionId] = record;
      await atomicWriteJson(titlesFile, next);
      return record;
    });
  }

  /** pi 自己对会话名的洗法（session-manager 的 appendSessionInfo）：换行压成空格 + trim。
   *  账上那条**必须跟文件里的一字不差**，否则下一次对账会把它当成「别人改的」→ 错记 manual。 */
  const piName = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

  /** 标题文本的清洗（seed / auto 走这里，是**我们**把它写进文件的）：只取第一行、去 markdown、
   *  压空白、截断。第一行是纯 `/命令` → null（L0 靠它跳过命令；模型也不会这么起标题）。 */
  const cleanTitle = (text) => {
    const line = String(text ?? '').split('\n').map((part) => part.trim()).find(Boolean);
    if (!line) return null;
    const cleaned = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → alt
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 → 文字
      .replace(/^\s*[>#]+\s*/, '') // 引用 / 标题符
      .replace(/^\s*([-*_]\s*){1,3}(?=\S)/, '') // 列表符 / 水平线
      .replace(/`+/g, '')
      .replace(/\*{1,3}|__/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.startsWith('/')) return null;
    return cleaned.length > titleMax ? `${cleaned.slice(0, titleMax - 1)}…` : cleaned;
  };

  /** 对账：会话文件里当下的名字 vs 我们账上那条。不一致（或账上没有却已有名字）⇒ 名字是**别人**
   *  设的 ⇒ 记 `manual`，此后不覆盖。返回 { current, rec, changed, manualMarked, previous }。 */
  async function reconcileTitleState(manager, sessionId) {
    const read = await readTitles(); // 坏了就大声抛（不拿空账冒充「用户没改过」）
    const before = read.value[sessionId] ?? null;
    const current = manager.getSessionName() ?? null;
    // 正在写这条标题（setSessionName 与记账之间，见 applyTitle）→ **不判 manual**：
    // 否则一个并发的 GET /titles 会把「我们自己的中间态」当成「别人改的」→ 标题被锁死。
    if (expectedTitleWrites.has(sessionId)) {
      return { current, rec: before, changed: false, manualMarked: false, previous: before?.title ?? null, inFlight: true };
    }
    if (!before) {
      if (current === null) return { current, rec: null, changed: false, manualMarked: false, previous: null };
      const rec = await writeTitleRecord(sessionId, { title: current, source: 'manual', at: Date.now() });
      titleLog(`#${sessionId} 有一个不是我们设的名字「${current}」→ 记 manual（此后不覆盖）`);
      return { current, rec, changed: true, manualMarked: true, previous: null };
    }
    if ((before.title ?? null) !== current) {
      const rec = await writeTitleRecord(sessionId, { title: current, source: 'manual', at: Date.now() });
      titleLog(`#${sessionId} 标题被外部改成「${current ?? '（清空）'}」（账上是「${before.title ?? '（无）'}」）→ 记 manual`);
      return { current, rec, changed: true, manualMarked: true, previous: before.title ?? null };
    }
    return { current, rec: before, changed: false, manualMarked: false, previous: before.title ?? null };
  }

  /** 设标题的**唯一**入口（seed / auto / manual 都走这里）。返回 { ok, applied, name, source, previous, reason? }；
   *  reason: manual | empty-title | set-failed | already。
   *  raw:true 时按 pi 的洗法**原样记**（create 时显式给的名字是宿主直接写进文件的，用 cleanTitle
   *  截断会让账跟文件对不上 → 下一次对账会错记 manual）。
   *  ⚠️ setSessionName 会同步 emit `session_info_changed`；`expectedTitleWrites` 必须在它之前设好，
   *     那条回声才不会把我们自己刚设的标题误判成「别人改的」。 */
  async function applyTitle(adapter, { title, source, raw = false }) {
    const sessionId = adapter.manager.getSessionId().toLowerCase();
    const state = await reconcileTitleState(adapter.manager, sessionId);
    const want = raw ? (piName(title) || null) : cleanTitle(title);
    if (!want) return { ok: false, applied: false, reason: 'empty-title', previous: state.current };
    if (source !== 'manual' && state.rec?.source === 'manual') {
      const same = state.current === want;
      titleLog(same
        ? `#${sessionId} 想设的和（手动设的）名字一样 → 什么都不动`
        : `#${sessionId} 已有手动标题「${state.current}」→ 拒绝改成「${want}」（绝不覆盖用户改过的）`);
      return { ok: same, applied: false, reason: same ? 'already' : 'manual', name: state.current, source: 'manual', previous: state.current };
    }
    expectedTitleWrites.set(sessionId, { title: want, source });
    let name = want;
    let titleLedgerPersisted = true;
    let warning = null;
    try {
      let readback;
      try {
        readback = adapter.setTitle(want);
      } catch (error) {
        return { ok: false, applied: false, reason: 'set-failed', error: normalizeError(error).message, previous: state.current };
      }
      name = raw ? (piName(readback) || want) : (cleanTitle(readback) || want);
      try {
        await writeTitleRecord(sessionId, { title: name, source, at: Date.now() });
      } catch (error) {
        // 标题**已经写进会话文件**（setTitle 直接落盘）；这里失败的只是账（titles.json）。
        // 再抛会把「已生效的改名」回报成失败 —— 同一个「副作用已成、回执说失败」的病。
        // 如实降级：成功 + warning（代价：下一次对账会把这条记成 manual，此后不再被 auto 覆盖）。
        titleLedgerPersisted = false;
        warning = {
          code: 'title_ledger_write_failed',
          file: titlesFile,
          message: `title was applied to the session file, but its record could not be written to ${titlesFile}: ${normalizeError(error).message}`,
        };
        titleLog(`#${sessionId} 标题已写进会话文件，但账（titles.json）没写上：${normalizeError(error).message}`);
      }
    } finally {
      // 记账**尝试**完成后才解除「在飞」标记（无论成败）：期间本会话的对账不会把中间态错记成 manual。
      expectedTitleWrites.delete(sessionId);
    }
    titleLog(`#${sessionId} 标题 ${state.rec ? `「${state.rec.title}」(${state.rec.source})` : '（原来没有）'} → 「${name}」(${source})`);
    emitTree(sessionId, 'title_changed');
    return { ok: true, applied: state.current !== name, name, source, previous: state.current, titleLedgerPersisted, warning };
  }

  /** L0 种子：会话收到**第一条 user 消息**、它还没有名字、账上也空白 → 用这条消息的第一行当标题。
   *  零 LLM、零成本、立刻见效（放在 prompt 之前：消息刚发出去树上就已经有名字了）。
   *  已经有名字（spawn / 用户 / TUI 给的）就**不种** —— 那种名字归别人，账上会被记成 manual。 */
  async function seedTitleIfUnnamed(adapter, text) {
    const sessionId = adapter.manager.getSessionId().toLowerCase();
    const state = await reconcileTitleState(adapter.manager, sessionId);
    if (state.current || state.rec) return null;
    const want = cleanTitle(text);
    if (!want) return null;
    const result = await applyTitle(adapter, { title: want, source: 'seed' });
    if (result.ok) titleLog(`#${sessionId} 种子标题（第一条消息的第一行）→「${result.name}」`);
    return result;
  }

  async function modelRuntime() {
    modelRuntimePromise ??= ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
    });
    return modelRuntimePromise;
  }

  function queueDeviceWrite(operation) {
    const result = deviceWriteQueue.then(operation, operation);
    deviceWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function queueSessionCreate(operation) {
    const result = sessionCreateQueue.then(operation, operation);
    sessionCreateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // handoffs.jsonl is append-only: one line per attempt, never a rewrite. The write
  // queue serialises appends inside this worker; the single appendFile call keeps the
  // line whole for readers on POSIX.
  function queueHandoffWrite(operation) {
    const result = handoffWriteQueue.then(operation, operation);
    handoffWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function cwdRecentsInvalid(detail) {
    return new HttpError(500, 'cwd_recents_invalid', `${cwdRecentsFile} is invalid: ${detail}`, { file: cwdRecentsFile, detail });
  }

  async function readCwdRecents(limit = 50) {
    let text;
    try {
      text = await readFile(cwdRecentsFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, recents: [], error: null };
      throw cwdRecentsInvalid(`cannot read file: ${normalizeError(error).message}`);
    }
    const jsonText = text.startsWith('\uFEFF') ? text.slice(1) : text;
    let value;
    try {
      value = JSON.parse(jsonText);
    } catch (error) {
      throw cwdRecentsInvalid(normalizeError(error).message);
    }
    if (!Array.isArray(value) || value.some((entry) => !plainObject(entry) || typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd) || !Number.isInteger(entry.at) || entry.at < 0)) {
      throw cwdRecentsInvalid('top level must be an array of { cwd:absolute-path, at:non-negative-integer }');
    }
    return { exists: true, recents: value.slice(0, limit), error: null };
  }

  async function rememberCwd(cwd) {
    const current = await readCwdRecents(50);
    const next = [{ cwd, at: Date.now() }, ...current.recents.filter((entry) => entry.cwd !== cwd)].slice(0, 20);
    await atomicWriteJson(cwdRecentsFile, next);
    return next;
  }

  async function cwdGitFacts(cwd) {
    let rootOutput;
    try {
      ({ stdout: rootOutput } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel']));
    } catch {
      return { isGit: false, root: null, mainRepo: null, branch: null, dirty: null, worktree: false };
    }
    const root = path.resolve(rootOutput.trim());
    try {
      const [{ stdout: status }, { stdout: branch }, { stdout: gitDirOutput }, { stdout: commonDirOutput }] = await Promise.all([
        execFileAsync('git', ['-C', root, 'status', '--porcelain']),
        execFileAsync('git', ['-C', root, 'branch', '--show-current']),
        execFileAsync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir']),
        execFileAsync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
      ]);
      const gitDir = path.resolve(cwd, gitDirOutput.trim());
      const commonDir = path.resolve(cwd, commonDirOutput.trim());
      return {
        isGit: true,
        root,
        mainRepo: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : root,
        branch: branch.trim() || null,
        dirty: status.trim().length > 0,
        worktree: gitDir !== commonDir,
      };
    } catch (error) {
      throw new HttpError(500, 'cwd_git_inspection_failed', `cannot inspect git workspace ${cwd}: ${normalizeError(error).message}`);
    }
  }

  async function cwdEnvironment(requestedCwd) {
    const cwd = path.resolve(requestedCwd || process.env.SOPHO_DEFAULT_CWD || process.cwd());
    let info = null;
    try { info = await stat(cwd); } catch (error) {
      if (error?.code !== 'ENOENT') throw new HttpError(500, 'cwd_inspection_failed', `cannot inspect ${cwd}: ${normalizeError(error).message}`);
    }
    const isDirectory = info?.isDirectory() === true;
    let writable = false;
    if (isDirectory) {
      try { await access(cwd, fsConstants.W_OK); writable = true; } catch {}
    }
    const tree = await listTree();
    return {
      cwd,
      exists: info !== null,
      isDirectory,
      writable,
      agentsMd: isDirectory && await stat(path.join(cwd, 'AGENTS.md')).then((value) => value.isFile()).catch(() => false)
        ? path.join(cwd, 'AGENTS.md')
        : null,
      git: isDirectory ? await cwdGitFacts(cwd) : { isGit: false, root: null, mainRepo: null, branch: null, dirty: null, worktree: false },
      sessions: tree.sessions.filter((session) => path.resolve(session.cwd) === cwd),
    };
  }

  function isScratchCwd(cwd) {
    const relative = path.relative(scratchRoot, cwd);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  function derivedPlacement(cwd) {
    const scratch = isScratchCwd(cwd);
    return {
      kind: scratch ? 'scratch' : 'dir',
      cwd,
      device: null,
      scratchRoot: scratch ? scratchRoot : null,
      claimedBy: null,
      at: 0,
    };
  }

  function placementFor(config, sessionId, cwd) {
    const persisted = config.value[sessionId] ?? null;
    return persisted
      ? { ...persisted, derived: false, source: 'placement.json' }
      : { ...derivedPlacement(cwd), derived: true, source: 'pi-header' };
  }

  function applyPlacement(summary, placement) {
    if (!placement.claimedBy) return { ...summary, placement, movedTo: null };
    return {
      ...summary,
      name: `${summary.name ? `${summary.name} → ` : ''}moved-to:${placement.claimedBy}`,
      archived: true,
      placement,
      movedTo: placement.claimedBy,
    };
  }

  async function assertNotMoved(sessionId) {
    const config = await readPlacementConfig(placementFile);
    const movedTo = config.value[sessionId]?.claimedBy ?? null;
    if (movedTo) {
      throw new HttpError(409, 'session_moved', `session ${sessionId} was moved to ${movedTo}; continue in the new session instead`, {
        sessionId,
        movedTo,
        marker: `moved-to:${movedTo}`,
      });
    }
  }

  // 记账（placement.json）写失败后待补的条目：**下一次成功写 placement.json 时一并落盘**。
  // 这就是那条「补齐记账的机会」—— 不需要新路由、也不需要动宿主：树上这条会话本来就有派生显示
  // （`derived:true / source:'pi-header'`，从它的 cwd 或会话文件 header 来），补写只是把账补全。
  const pendingPlacements = new Map();

  function placementWriteWarning(file, message, error) {
    const failure = normalizeError(error);
    return {
      code: 'placement_write_failed',
      file,
      message,
      cause: error instanceof AtomicWriteError
        ? { code: error.code, attempts: error.attempts }
        : { code: error?.code ?? null, attempts: 1 },
    };
  }

  // 写 placement.json：先把待补条目并进来（**只补本代还热着或会话文件还在的**，删掉的会话不许复活成幽灵条目），
  // 写成功了才清空待补；写失败则待补原样留着，等下一次成功写。
  async function persistPlacement(config) {
    for (const [sessionId, entry] of [...pendingPlacements]) {
      if (Object.hasOwn(config.value, sessionId)) continue;
      // 待补的会话是**本代刚建出来的**：它现在热着（哪怕 pi 还没落盘 —— 刚建的会话要等第一次写
      // 才出现 .jsonl）。热着或落盘都在 ⇒ 补；都没有（被删 / 换代丢了）⇒ 不补，免得留幽灵条目。
      let exists = Boolean(pool.getHandle(sessionId));
      if (!exists) {
        try { exists = Boolean(await findPersistedSession(sessionId)); } catch { exists = false; }
      }
      if (exists) config.value[sessionId] = entry;
    }
    await atomicWriteJson(placementFile, config.value);
    pendingPlacements.clear();
  }

  async function placementView() {
    const config = await readPlacementConfig(placementFile);
    const placements = {};
    for (const file of await listJsonlFiles(sessionsRoot)) {
      const manager = SessionManager.open(file);
      const sessionId = requireFullSessionId(manager.getSessionId());
      placements[sessionId] = placementFor(config, sessionId, manager.getCwd());
    }
    // A session pi created but has not written yet has no file to derive from; its
    // sidecar entry is the only record of where it was placed, so report it.
    for (const [sessionId, placement] of Object.entries(config.value)) {
      placements[sessionId] ??= { ...placement, derived: false, source: 'placement.json' };
    }
    // Shape per docs/design-cwd-devices.md §4.3: the session map sits at the top
    // level; a UUID key can never collide with `exists` or `error`.
    return { exists: config.exists, error: null, ...placements };
  }

  function deviceList(value) {
    return Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, device]) => ({ name, ...device, lastProbe: device.lastProbe ?? null }));
  }

  async function listDevices() {
    const config = await readDevicesConfig(devicesFile);
    return { devices: deviceList(config.value), exists: config.exists, error: null };
  }

  async function runDeviceProbe(name, requestedPath) {
    return queueDeviceWrite(async () => {
      const config = await readDevicesConfig(devicesFile);
      const device = Object.hasOwn(config.value, name) ? config.value[name] : null;
      if (!device) {
        throw new HttpError(404, 'device_not_found', `device ${JSON.stringify(name)} is not present in ${devicesFile}`, {
          name,
          exists: config.exists,
        });
      }
      const result = await probeDevice(name, device, requestedPath, deviceProbeTimeoutMs);
      const lastProbe = {
        at: Date.now(),
        ok: result.ok,
        uname: result.uname,
        error: result.error,
      };
      device.lastProbe = lastProbe;
      // 探针（只读 ssh）已经跑完；把它的结果写进 devices.json 失败，不该把结果连带丢掉
      // （同一个「副作用已成、回执说失败」的病）⇒ 结果照回 + 如实标 lastProbePersisted:false。
      let lastProbePersisted = true;
      let warning = null;
      try {
        await atomicWriteJson(devicesFile, config.value);
      } catch (error) {
        lastProbePersisted = false;
        warning = {
          code: 'devices_write_failed',
          file: devicesFile,
          message: `probe ran, but lastProbe could not be recorded in ${devicesFile}: ${normalizeError(error).message}`,
        };
        console.error(`[devices] ${warning.message}`);
      }
      return { ...result, lastProbe, lastProbePersisted, warning };
    });
  }

  async function runDeviceCommand(name, command, requestedCwd) {
    const config = await readDevicesConfig(devicesFile);
    const device = Object.hasOwn(config.value, name) ? config.value[name] : null;
    if (!device) {
      throw new HttpError(404, 'device_not_found', `device ${JSON.stringify(name)} is not present in ${devicesFile}`, {
        name,
        exists: config.exists,
      });
    }
    // The ssh target is built from devices.json only; the caller never supplies a host.
    const target = deviceTarget(device);
    const cwd = translateDeviceCwd(name, device, requestedCwd);
    const remoteCommand = cwd.remote === null ? command : `cd ${shellQuote(cwd.remote)} && ${command}`;
    const result = await sshRun(target, remoteCommand, { timeoutMs: deviceRunTimeoutMs, maxBytes: deviceRunMaxBytes });
    const truncatedStreams = ['stdout', 'stderr'].filter((stream) => result.truncated[stream]);
    const timedOutNotice = result.timedOut
      ? `timed out after ${deviceRunTimeoutMs}ms; the local ssh client was terminated, but the command may still be running on ${device.host}`
      : null;
    const truncatedNotice = truncatedStreams.length > 0
      ? `${truncatedStreams.map((stream) => `${stream} output truncated at ${deviceRunMaxBytes} bytes`).join('; ')} (received ${truncatedStreams.map((stream) => `${stream} ${result[`${stream}Bytes`]} bytes`).join(', ')})`
      : null;
    return {
      name,
      host: device.host,
      user: device.user ?? null,
      target,
      ranOn: `this command ran on ${device.host} (${target}) over ssh, not on the local machine`,
      detachedFromLocalProcessTree: true,
      detachedNotice: DETACHED_NOTICE,
      command,
      remoteCommand,
      cwd,
      exitCode: result.exitCode,
      ok: !result.timedOut && result.exitCode === 0,
      timedOut: result.timedOut,
      timeoutMs: deviceRunTimeoutMs,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      truncated: result.truncated,
      truncatedNotice,
      timedOutNotice,
      error: result.timedOut ? timedOutNotice : (result.exitCode === 0 ? null : `${truncatedNotice ? `${truncatedNotice}; ` : ''}exit code ${result.exitCode}`),
    };
  }

  function trimManagerCache() {
    while (persistedManagerCache.size > persistedManagerCacheMax || persistedManagerCacheBytes > persistedManagerCacheMaxBytes) {
      const oldest = persistedManagerCache.keys().next().value;
      if (oldest === undefined) break;
      const entry = persistedManagerCache.get(oldest);
      persistedManagerCache.delete(oldest);
      persistedManagerCacheBytes -= entry?.bytes ?? 0;
    }
  }

  function trimMessageBodyCache() {
    while (messageBodyCache.size > messageBodyCacheMax || messageBodyCacheBytes > messageBodyCacheMaxBytes) {
      const oldest = messageBodyCache.keys().next().value;
      if (oldest === undefined) break;
      const entry = messageBodyCache.get(oldest);
      messageBodyCache.delete(oldest);
      if (entry) entry.cached = false;
      messageBodyCacheBytes -= entry?.bytes ?? 0;
    }
  }

  async function readSessionHeader(file) {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline < 0) throw new Error(`session header exceeds 65536 bytes or has no newline: ${file}`);
      return JSON.parse(text.slice(0, newline).replace(/\r$/, ''));
    } finally {
      await handle.close();
    }
  }

  async function openPersistedManager(file) {
    // 文件身份 = (size, mtimeMs, **ctimeMs**)。只比 size+mtimeMs 会被「原地重写恰好同长度同 mtime」骗过
    // （封存就地裁剪、pi 的 `_rewriteFile()` 都会整份重写），于是拿旧 manager 当真地投影；
    // ctime 在内容写入 / 元数据改动 / inode 被替换时必变，是这里唯一挡得住那条路的事实。
    const info = await stat(file);
    const hit = persistedManagerCache.get(file);
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs && hit.ctimeMs === info.ctimeMs) {
      persistedManagerCache.delete(file);
      persistedManagerCache.set(file, hit);
      return hit.manager;
    }
    if (hit) {
      persistedManagerCache.delete(file);
      persistedManagerCacheBytes -= hit.bytes ?? 0;
    }
    const manager = SessionManager.open(file);
    const entry = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, bytes: info.size * memoryBudget.sessionMultiplier, manager };
    persistedManagerCache.set(file, entry);
    persistedManagerCacheBytes += entry.bytes;
    trimManagerCache();
    return manager;
  }

  async function findPersistedSession(sessionId) {
    const cached = sessionFileCache.get(sessionId.toLowerCase());
    if (cached) {
      try {
        await stat(cached);
        return cached;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        sessionFileCache.delete(sessionId.toLowerCase());
      }
    }
    // /tree 已经扫过的会话直接就能拿到文件：不要再为一个详情把几百个文件的头读一遍
    // （这台机器上每次 open 3-4 ms ⇒ 一次未知会话的详情会白花 ~1 s）。
    // ⚠️ 但**要核文件还在**（索引记的是上次扫描时的事实）：带外删除的文件应该走下面的扫描
    // 然后正常 404，而不是拿着一个不存在的路径去 open（那会变成 500）。
    for (const entry of treeIndex.values()) {
      if (entry.id !== sessionId.toLowerCase()) continue;
      try {
        await stat(entry.record.file);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        break;
      }
      sessionFileCache.set(entry.id, entry.record.file);
      return entry.record.file;
    }
    const matches = [];
    for (const file of await listJsonlFiles(sessionsRoot)) {
      let header;
      try {
        header = await readSessionHeader(file);
      } catch (error) {
        throw new Error(`cannot read session header ${file}: ${normalizeError(error).message}`);
      }
      if (!header?.id) throw new Error(`session file has no valid header: ${file}`);
      const id = String(header.id).toLowerCase();
      sessionFileCache.set(id, file);
      if (id === sessionId.toLowerCase()) matches.push(file);
    }
    if (matches.length > 1) throw new Error(`duplicate session UUID found in profile: ${sessionId}`);
    return matches[0] ?? null;
  }

  const exportInFlight = new Map();
  let exporterPromise = null;

  function snapshotFile(sessionId) {
    return path.join(exportsRoot, `${sessionId}.html`);
  }

  async function loadExporter() {
    exporterPromise ??= (async () => {
      const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE))));
      const file = path.join(packageRoot, 'dist', 'core', 'export-html', 'index.js');
      const module = await import(pathToFileURL(file).href);
      if (typeof module.exportFromFile !== 'function') throw new Error(`${file} does not export exportFromFile`);
      return module.exportFromFile;
    })();
    return exporterPromise;
  }

  async function exportSnapshot(sessionId) {
    const existing = exportInFlight.get(sessionId);
    if (existing) return existing;
    const pending = (async () => {
      const sessionFile = await findPersistedSession(sessionId);
      if (!sessionFile) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);
      const sessionInfo = await stat(sessionFile);
      await admitSession(sessionId, sessionFile, { sessionFileBytes: sessionInfo.size });
      await mkdir(exportsRoot, { recursive: true });
      const output = snapshotFile(sessionId);
      const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const exportFromFile = await loadExporter();
        await exportFromFile(sessionFile, { outputPath: temporary });
        await rename(temporary, output);
      } catch (error) {
        try { await unlink(temporary); } catch {}
        throw error;
      }
      return { output, sessionFile };
    })().finally(() => exportInFlight.delete(sessionId));
    exportInFlight.set(sessionId, pending);
    return pending;
  }

  async function currentSnapshot(sessionId) {
    const sessionFile = await findPersistedSession(sessionId);
    if (!sessionFile) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);
    const output = snapshotFile(sessionId);
    const [sessionInfo, outputInfo] = await Promise.all([
      stat(sessionFile),
      stat(output).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error)),
    ]);
    if (outputInfo && sessionInfo.mtimeMs <= outputInfo.mtimeMs) return { output, info: outputInfo };
    try {
      const exported = await exportSnapshot(sessionId);
      return { output: exported.output, info: await stat(exported.output) };
    } catch (error) {
      if (outputInfo) return { output, info: outputInfo };
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, 'snapshot_export_failed', `failed to export session snapshot: ${normalizeError(error).message}`);
    }
  }

  async function sendSnapshot(request, response, sessionId) {
    const snapshot = await currentSnapshot(sessionId);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': snapshot.info.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    try {
      await pipeline(createReadStream(snapshot.output), response);
    } catch (error) {
      response.destroy(normalizeError(error));
    }
  }

  async function persistedSessionState(sessionId) {
    const file = await findPersistedSession(sessionId);
    let manager;
    if (file) manager = await openPersistedManager(file);
    else {
      const handle = pool.getHandle(sessionId);
      if (!handle) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);
      manager = await inspectAdapter(handle, (adapter) => adapter.manager);
    }
    const cwd = manager.getCwd();
    let cwdInfo;
    try {
      cwdInfo = await stat(cwd);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      cwdInfo = null;
    }
    return { file, manager, cwd, cwdMissing: cwdInfo === null };
  }

  function cwdMissingError(cwd) {
    return new HttpError(
      409,
      'session_cwd_missing',
      `这个会话的工作目录已不存在（${cwd}）—— 可以查看历史，不能继续；要接着干请先把该目录建回来`,
      { cwd },
    );
  }

  async function assertSessionCwdAvailable(sessionId) {
    const state = await persistedSessionState(sessionId);
    if (state.cwdMissing) throw cwdMissingError(state.cwd);
    return state;
  }

  const readonlyCacheDiagnostics = () => process.env.SOPHO_READONLY_CACHE_DIAGNOSTICS === '1';

  function takeMessageBody(key, label) {
    const hit = messageBodyCache.get(key);
    if (hit === undefined) return null;
    messageBodyCache.delete(key); // LRU：刚用过的放回尾部
    messageBodyCache.set(key, hit);
    if (readonlyCacheDiagnostics()) console.log(`[readonly-cache] hit ${label}`);
    return hit;
  }

  function storeMessageBody(key, value, label) {
    const body = `${JSON.stringify(value)}\n`;
    const contentLength = Buffer.byteLength(body);
    // 版本键 = 这一版正文的**缓存键**（冷读 = 文件 size+mtime；热读 = leafId/流式/压缩/模型；
    // 再加 `after` 游标）；它决定「这一版算不算同一版」。
    // ⚠️ ETag **不能**由它算（2026-09-19 修）：同一份正文有**两条生产路**，版本键前缀一个是
    // `file|…`、一个是 `hot|…` —— 打开一个会话时 `/messages` 先走冷读（文件），`/events` 把 runtime
    // 拉热之后同一条 URL 改走热读，于是**同一份字节给出两个 ETag**（实测：同一份 10 104 771 B 的正文，
    // 两条全量 `/messages` 的 ETag 是 `W/"v1-7acfe0ab…"` 与 `W/"v1-2122d108…"`），客户端手上的
    // `If-None-Match` 永远对不上、304 永远拿不到。
    // 改成按**内容**算（sha1(这一版的逐字序列化)）：同内容 ⇒ 同 ETag，与谁生产的无关；
    // 代价是每个版本多一次 sha1（实测 35 MiB 的 body ≈ 15–30 ms，且同一版本只算一次 ——
    // 命中缓存不再算；压缩缓存那份也照旧按 (versionKey, encoding) 分槽，不受影响）。
    const etagValue = `W/"v1-${createHash('sha1').update(body).digest('hex').slice(0, 24)}"`;
    const entry = {
      key,
      bytes: contentLength,
      contentLength,
      // 不压的那份（永远是这一版正文的**逐字**序列化）；它与下面的 compressed 各自独立，
      // 所以「同一游标再拉一次逐字一致」不会因为中间夹了一个压缩请求而变形。
      body,
      etag: etagValue,
      // 压缩缓存 = (versionKey, encoding)：entry 本身按 versionKey 定，压缩字节再按 encoding 分槽。
      // 只用 versionKey 共用一格会让 gzip/identity 两种变体互相顶掉（也会让中间层混）。
      compressed: new Map(),
      cached: false,
    };
    // 压缩结果也记进这本账（字节数诚实）；条目被裁掉/清掉后 `cached` 落回去，不再记账。
    entry.rememberCompressed = (encoding, buffer) => {
      if (!entry.cached || entry.compressed.has(encoding)) return;
      entry.compressed.set(encoding, buffer);
      entry.bytes += buffer.length;
      messageBodyCacheBytes += buffer.length;
      trimMessageBodyCache();
    };
    if (messageBodyCacheMax > 0 && messageBodyCacheMaxBytes > 0 && contentLength <= messageBodyCacheMaxBytes) {
      const previous = messageBodyCache.get(key);
      if (previous) messageBodyCacheBytes -= previous.bytes ?? 0;
      // 存 `contentLength`：命中时不必把一个 60 MB 的串再扫一遍数长度。
      messageBodyCache.set(key, entry);
      messageBodyCacheBytes += contentLength;
      entry.cached = true;
      trimMessageBodyCache();
    }
    return entry;
  }

  // `?after=<entryId>`：整份正文的**可选增量视图**（**不传 = 逐字节照旧**，见 tailMessageValue）。
  // 为什么要有它：大会话每回合末都要重拉一次正文 —— 本 landing 量的真夹具（`01a0a385-…`，
  // 那个模拟会话文件当时 17.7 MiB → 响应体 29.5 MiB / 2549 条）里，这一轮真正新增的只有末尾几条，
  // 其余全是客户端手上已经有的。客户端只在**能逐条证明**「手上那份就是这一版的前缀」时才用它
  // （`web/app.js` 的 tailBase / tailMerge）；核不过就落回整份替换；服务端这边游标找不到也照样回
  // 整份 —— 两条降级路都不丢内容。
  //
  // 语义（三条，客户端逐条核）：
  //   · `messages` 只给游标**之后**的那些；`tail.from` = 增量起点下标（游标下标 + 1）；
  //   · `tail.total` = 这一版的消息总数（客户端拿它验 `from + messages.length`）；
  //   · `extras` / `compaction` / `observability` **照旧给全**：客户端按 entryId 去重，**多给不会
  //     画重、少给会丢内容**，所以这一边选安全的那一侧（真夹具 73 条 extra ≈ 380 KB/次）。
  function tailMessageValue(value, after) {
    const messages = value.messages ?? [];
    let cursor = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.entryId === after) {
        cursor = index;
        break;
      }
    }
    if (cursor < 0) return null;
    return {
      ...value,
      messages: messages.slice(cursor + 1),
      tail: { afterEntryId: after, from: cursor + 1, total: messages.length },
    };
  }

  // 冷读：文件只读一遍（逐行 JSON.parse 当**校验**，坏文件如实 500），用**同一批 entries**
  // 建一个内存 manager（`SessionManager.inMemory` 与 `open` 给出同一条 branch，58 MiB 那个
  // 真实文件上逐条比过：706/706 一致）—— 不为了拿一个 manager 再整份解析一遍。
  async function fileMessageBody(file, flags, signal = null, after = null, suggestion = null) {
    // 文件身份 = (size, mtimeMs, **ctimeMs**)。`(size, mtimeMs)` 挡不住「原地重写恰好同长度同 mtime」
    // （封存就地裁剪 / pi 的 `_rewriteFile()` 都是整份重写）⇒ 会拿旧字节当真；
    // ctime 在内容写入 / 元数据改动 / inode 被替换时必变（实测三元组见 `test/cache-identity-ctime.mjs`）。
    // 身份里再加**候选那一行**（`sg:`）：它是响应体的一部分（挂在消息上的 `suggestions`），
    // 而候选落盘**不动会话文件**（size/mtime/ctime 一字不变）—— 少了这一段，`/messages` 会命中
    // 候选到达之前存下的那份响应体，刷新后那排就不在（门里 ⑦ 钉的就是这个）。
    const info = await stat(file);
    const versionKey = `file|${file}|${info.size}|${info.mtimeMs}|${info.ctimeMs}|${flags.readOnly ? 'ro' : 'rw'}${suggestionKeyPart(suggestion)}`;
    const key = after === null ? versionKey : `${versionKey}|after:${after}`;
    const hit = takeMessageBody(key, file);
    if (hit !== null) return hit;
    const text = await readFile(file, 'utf8');
    // 读这一份文件本身就要几百 ms（本机 35.7 MB ⇒ ~69 ms CPU；真机 60.8 MB 更久），客户端完全可能
    // 在这段时间里走了。**这一句之后就是不可切的一段**：`text.split(/\r?\n/)`（本机实测 +58.9 MiB RSS /
    // ~21 ms CPU，4677 行）—— 所以进循环之前先核一次，别把「切 + 逐行 parse」也付掉。
    // 口径与循环里的检查点完全一致（同一条 `signal` / 同一个 `messageAbortError`，`=0` 时整条判据仍是关的）。
    {
      const gone = messageAbortError(signal);
      if (gone) throw gone;
    }
    const entries = [];
    let skipped = 0;
    let lineNumber = 0;
    // 客户端中途走了就停（大文件的 JSON.parse 也不该继续烧）。**两条缺一不可**：
    //   · 判据按**时间**，不按行数 —— 「每 2000 行看一眼」在真机最大的会话文件上是死代码
    //     （60 835 111 B / 707 行，取不到 2000 的倍数 ⇒ 一次都没看过）；
    //   · 到点**让出事件循环** —— 这是一段同步 `JSON.parse` 循环，不让出的话
    //     `response.once('close')` 那个 abort 回调根本轮不到跑，`signal.aborted` 永远是 false。
    let abortCheckAt = messageAbortCheckMs > 0 ? Date.now() + messageAbortCheckMs : Infinity;
    for (const line of text.split(/\r?\n/)) {
      lineNumber += 1;
      if (line.trim() === '') continue;
      if (signal && Date.now() >= abortCheckAt) {
        const gone = messageAbortError(signal);
        if (gone) throw gone;
        abortCheckAt = messageAbortCheckMs > 0 ? Date.now() + messageAbortCheckMs : Infinity;
        await new Promise((resolve) => setImmediate(resolve));
      }
      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        // 坏行口径**两条路各自照旧**，不趁这次改：
        //  · cwd-missing 的只读路一直是「坏行 ⇒ 500」（它有自己的契约测试钉着）；
        //  · 普通冷读以前走 pi 的解析器（那个会**跳过**坏行）⇒ 这里也跳过，
        //    但把跳过的行数如实报出来（旧实现是静默跳过 —— 说一句比不说诚实）。
        if (flags.cwdMissing) throw new Error(`invalid session entry JSON at ${file}: ${normalizeError(error).message}`);
        skipped += 1;
      }
    }
    const header = entries.find((entry) => entry?.type === 'session') ?? null;
    if (!header) throw new Error(`session file has no valid header: ${file}`);
    // 解析完了但客户端已经走了：别再投影 / 序列化 / 算 sha1 / 写缓存。
    {
      const gone = messageAbortError(signal);
      if (gone) throw gone;
    }
    const manager = SessionManager.inMemory(typeof header.cwd === 'string' ? header.cwd : process.cwd(), undefined, entries);
    const models = await modelRuntime().catch(() => null);
    // 「未完成」那个标记的**口径照旧，不趁这次改**：
    //   · cwd-missing 的只读路径一直是 `interrupted`（会话已不能继续）；
    //   · 普通冷读以前走 runtime（isStreaming=false）⇒ `unfinished`；现在走文件也必须还是它。
    const wire = messageWire(manager, models, {
      isStreaming: false,
      unfinishedStatus: flags.cwdMissing ? 'interrupted' : 'unfinished',
    });
    // 推荐回复是**这条消息的可选字段**（不进 `text`/`parts`）—— 在投影之后、序列化之前挂上去。
    attachSuggestions(wire, suggestion);
    const value = {
      ...wire,
      ...(skipped === 0 ? {} : {
        invalidLines: skipped,
        invalidLinesNote: 'this session file has JSONL lines that do not parse; they are skipped here (pi\'s own reader skips them too) rather than silently pretending the history is complete',
      }),
      ...flags,
    };
    if (readonlyCacheDiagnostics()) console.log(`[readonly-cache] parse ${file}`);
    // wire 已建好，但序列化（JSON.stringify 61 MB + sha1）才是这一段的大头：最后再核一次。
    {
      const gone = messageAbortError(signal);
      if (gone) throw gone;
    }
    if (after === null) return storeMessageBody(versionKey, value, file);
    // 游标不在这一版里（压缩换枝 / 游标过期）⇒ 把整份存回去并如实回整份（客户端据此走整份替换）。
    const sliced = tailMessageValue(value, after);
    return storeMessageBody(sliced === null ? versionKey : key, sliced ?? value, file);
  }

  // 热读：runtime 已经在跑，wire 只有它能给（它手里可能有还没落盘的条目）。
  // 但**同一个版本**（leafId / streaming / compacting / 模型都没变）不该每次重算 + 重序列化。
  // `signal` 是「客户端走了」的信号：`adapter.messages()` 与序列化都是同步的、切不开，
  // 所以只能在它们的**前后**各核一次（rw 时 `withSession` 会真的进 pi，外面再核一次没坏处）。
  async function runtimeMessageBody(sessionId, handle, view, flags, after = null, signal = null, suggestion = null) {
    const versionKey = `hot|${sessionId}|${view.leafId ?? ''}|${view.streaming}|${view.compacting}|${view.model ?? ''}|${flags.readOnly ? 'ro' : 'rw'}|${flags.cwdMissing ?? ''}${suggestionKeyPart(suggestion)}`;
    const key = after === null ? versionKey : `${versionKey}|after:${after}`;
    const hit = takeMessageBody(key, sessionId);
    if (hit !== null) return hit;
    {
      const gone = messageAbortError(signal);
      if (gone) throw gone;
    }
    const wire = await withSession(sessionId, (live) => inspectAdapter(live, (adapter) => adapter.messages()));
    // 与冷读同一条：候选是那条消息的**可选字段**（`adapter.messages()` 不可能读侧车文件，所以挂在这里）。
    attachSuggestions(wire, suggestion);
    if (readonlyCacheDiagnostics()) console.log(`[readonly-cache] parse ${sessionId}`);
    const value = { ...wire, ...flags };
    {
      const gone = messageAbortError(signal);
      if (gone) throw gone;
    }
    if (after === null) return storeMessageBody(versionKey, value, sessionId);
    const sliced = tailMessageValue(value, after);
    return storeMessageBody(sliced === null ? versionKey : key, sliced ?? value, sessionId);
  }

  // GET /sessions/{id}/messages 的**响应体**（含末尾换行，与 sendJson 逐字节相同）。
  // 冷会话不再为了读正文建 runtime；cwd 不存在时仍然只读文件（与旧口径一致）。
  async function messageResponseBody(sessionId, signal = null, after = null) {
    // 候选（推荐回复）：读一次侧车（按文件身份缓存；ENOENT = 空账），再把这一条挂到那条消息上。
    // ⚠️ 这里读不出来（侧车文件坏了）**不能把正文读阻断**：候选只是锦上添花，如实记一条、当作没有。
    let suggestion = null;
    try {
      await loadSuggestions();
      suggestion = suggestionFor(sessionId);
    } catch (error) {
      suggestionLog(`${sessionId} 候选侧车读不出来 ⇒ 这一次正文不带 suggestions：${normalizeError(error).message}`);
    }
    const handle = pool.getHandle(sessionId);
    if (handle) {
      const view = await inspectAdapter(handle, (adapter) => ({
        cwd: adapter.manager.getCwd(),
        leafId: adapter.manager.getLeafId() ?? null,
        streaming: adapter.session.isStreaming === true,
        compacting: adapter.session.isCompacting === true,
        model: modelRef(adapter.session.model),
      }));
      if (!(await cwdIsMissing(view.cwd))) {
        return runtimeMessageBody(sessionId, handle, view, { readOnly: false, readOnlyReason: null, cwdMissing: null }, after, signal, suggestion);
      }
      const staleFlags = { readOnly: true, readOnlyReason: 'cwd-missing', cwdMissing: view.cwd };
      const file = await findPersistedSession(sessionId);
      // 有些会话只有 runtime 手里有（pi 在第一条 assistant 消息之前不落盘）：那就只能问它。
      return file
        ? fileMessageBody(file, staleFlags, signal, after, suggestion)
        : runtimeMessageBody(sessionId, handle, view, staleFlags, after, signal, suggestion);
    }
    const file = await findPersistedSession(sessionId);
    if (!file) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);
    // 这里只要 cwd（判 cwd-missing）—— 读个头就够，别为了它把整份文件投影一遍
    // （60 MB 的会话多跑一趟字节扫描 ~150 ms）。
    const header = await readSessionHeader(file);
    const cwd = typeof header?.cwd === 'string' ? header.cwd : null;
    const cwdMissing = cwd === null ? false : await cwdIsMissing(cwd);
    return fileMessageBody(file, { readOnly: cwdMissing, readOnlyReason: cwdMissing ? 'cwd-missing' : null, cwdMissing: cwdMissing ? cwd : null }, signal, after, suggestion);
  }

  async function prepareRuntime({ sessionId, currentGenerationId, sessionFile, options }) {
    let cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
    if (sessionFile) cwd = SessionManager.open(sessionFile).getCwd();
    const cwdInfo = await stat(cwd).catch(() => null);
    if (!cwdInfo?.isDirectory()) throw new Error(`session cwd does not exist or is not a directory: ${cwd}`);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [assistantExtensionPath],
    });
    // ── 为什么这里 **reload 两次**（口径修正，2026-10-04；依据 `docs/plans/research-pi-dynamic-tools.md`）──
    // pi 的插件模块缓存是**进程级**的（`pi-coding-agent/dist/core/extensions/loader.js:115-131`：
    // `extensionCache` 按 (extensionPath, cwd, generation) 命中，`moduleCache:false` 只保证**未命中时**从磁盘读），
    // 而 `DefaultResourceLoader.reload()` **只在 `this.loaded === true` 时才** `clearExtensionCache()`
    // （`…/dist/core/resource-loader.js:263-267`）。⇒ **新建 loader 的第一次 reload 不清进程级缓存**。
    // 后果（研究单 §3.3 步骤 ③/⑦ 实测）：同 cwd 再开一条 runtime 会命中上一次加载的**旧工厂** ⇒
    // 工具面是旧插件的；改完插件后，同 cwd 的新会话仍拿着**已删掉**的工具。
    //
    // 第二次 reload 时 `loaded` 已为 true ⇒ 真的走进 `clearExtensionCache()`；那一次的插件工厂因而是
    // **从磁盘重读**的（`moduleCache:false` 下未命中就是要读盘）⇒ 这一条 runtime 的工具面 ＝ 当前插件
    // 文件，且这是**每一次**开 runtime 都成立的事实，不再取决于 cwd 是否恰好变过。
    // 这是 pi 0.85.1 里**唯一可用的受支持路径**：`clearExtensionCache` **没有**从包根导出
    // （`dist/index.d.ts` 与 `package.json` 的 `exports` 里都没有它；直接 import 子路径会被
    // `ERR_PACKAGE_PATH_NOT_EXPORTED` 拒 —— 实测），所以只能借「同一个 loader 再 reload」这一步调它。
    // ⚠️ 这句注释里引的行号是 0.85.1 的；升级 pi 时**必须重读** loader.js / resource-loader.js 这两段，
    //    若 `loaded` 的置位或 `clearExtensionCache()` 的触发条件变了，这里的保证与 `cacheCleared` 的口径一起失效。
    await resourceLoader.reload();
    await resourceLoader.reload();
    const extensionErrors = resourceLoader.getExtensions().errors;
    if (extensionErrors.length > 0) {
      throw new Error(`pi extension load failed: ${extensionErrors.map((entry) => `${entry.path}: ${entry.error}`).join('; ')}`);
    }
    return {
      generationId: currentGenerationId,
      // 说实话的标志：上面第二次 reload 真的调过 `clearExtensionCache()` 并重读了插件文件。
      // （2026-10-04 之前这里恒为 `true` 却是**自报** —— 那时只 reload 一次，按 pi 的语义并不清缓存；
      //  `server/pool.mjs` 一直拿它当硬条件，所以两边的口径一起改了。见那份注释。）
      cacheCleared: true,
      cwd,
      settingsManager,
      resourceLoader,
      sessionId,
    };
  }

  pool = new RuntimePool({
    ...poolConfigFromEnv(),
    currentGenerationId: generationId,
    logicVersion,
    codeRevision,
    onEvent: (event) => {
      if (event.event === 'open' || event.event === 'restore') {
        reportRoute({ type: 'owner', sessionId: event.sessionId, phase: 'hot', generationId, pid: process.pid, owner: event.owner ?? null });
      } else if (event.event === 'evict' || event.event === 'close_disposing' || event.event === 'open_failed') {
        reportRoute({ type: 'owner', sessionId: event.sessionId, phase: 'cold', generationId, pid: process.pid, owner: null });
        // 自动路（TTL/换代）从不收有订阅者的 runtime（pin 是硬条件），所以这里只有
        // 「显式回收（includePinned）」会真的动到直播流；动就要把话说完（可重连事件 + 收尾）。
        if (event.event === 'evict') sseStreamsEndedByEvict += endSessionSseStreams(event.sessionId, event.reason ?? 'evicted');
      }
    },
    locateSession: async (sessionId) => {
      const sessionFile = await findPersistedSession(sessionId);
      return sessionFile ? { sessionFile } : null;
    },
    admitRuntime: async ({ sessionId, sessionFile, sessionFileBytes, reclaimMemory }) => admitSession(sessionId, sessionFile, { reclaimMemory, sessionFileBytes }),
    prepareRuntime,
    openRuntime: async ({ sessionId, sessionFile, generationId: actualGenerationId, prepared, options }) => {
      if (!sessionFile && options?.create !== true) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);
      await mkdir(sessionsRoot, { recursive: true });
      const manager = sessionFile
        ? SessionManager.open(sessionFile)
        : SessionManager.create(prepared.cwd, sessionsRoot, {
            id: sessionId,
            ...(options?.parentSession ? { parentSession: options.parentSession } : {}),
          });
      const { session } = await createAgentSession({
        cwd: prepared.cwd,
        agentDir,
        modelRuntime: await modelRuntime(),
        resourceLoader: prepared.resourceLoader,
        settingsManager: prepared.settingsManager,
        sessionManager: manager,
        ...(process.env.SOPHO_NO_TOOLS === '1' ? { noTools: 'all' } : {}),
      });
      return createRuntimeAdapter({
        session,
        manager,
        generationId: actualGenerationId,
        logicVersion,
        loadedAt,
        emitTree,
        reportLifecycle: (event) => reportRoute({ type: 'lifecycle', generationId, pid: process.pid, ...event }),
        // 只告诉我们自己刚写的那条标题的来源；不是我们写的一律返回 null（adapter 再去对账）。
        titleSourceFor: (sessionId, name) => {
          const expected = expectedTitleWrites.get(sessionId);
          return expected && expected.title === name ? expected.source : null;
        },
        // 外部改的名字（不是我们自己 setSessionName 的回声）：对它对账，可能记 manual + 广播。
        onTitleObserved: (sessionId, _name, observedManager) => {
          void reconcileTitleState(observedManager, sessionId)
            .then((state) => { if (state.changed) emitTree(sessionId, 'title_changed'); })
            .catch((error) => titleLog(`#${sessionId} session_info_changed 对账失败（已如实记日志，不篡改）：${normalizeError(error).message}`));
        },
        // 「压缩即封存」的自动触发点（回合落定 + 无 runtime 持有的安全点）。
        onCompactionSettled: (sessionId) => scheduleSealAfterCompaction(sessionId),
        // 「对话内的推荐回复」的触发点：回合落定 ⇒ 逻辑层起一个后台 job（异步、不阻塞这一轮）。
        onTurnSettled: (request) => scheduleSuggestions(request),
      });
    },
  });

  async function withSession(sessionId, operation, options = {}) {
    // No `await` may sit between acquire() and the operation: the per-session operation
    // queue is what keeps same-tick deliveries in arrival order (first message, rest
    // steer). Admission lives inside the pool's serialized acquire for exactly that
    // reason — see the comment there and test/s1a2-api.mjs's repeated burst gate.
    const handle = await pool.acquire(sessionId, options);
    try {
      return await operation(handle);
    } finally {
      await handle.release();
    }
  }

  async function inspectAdapter(handle, operation) {
    return handle.runExclusive((adapter) => operation(adapter), { active: false });
  }

  async function rejectStreamingCommand(adapter, text) {
    if (!adapter.isCommandStreaming()) return;
    const name = commandNameIn(text);
    if (!name) return;
    const { commands } = await adapter.commands();
    if (!commands.some((command) => command.name === name)) return;
    throw new HttpError(
      409,
      'command_while_streaming',
      `会话正在跑，斜杠命令「/${name}」不能插话也不能排队 —— 等这一轮跑完再发。`,
      { command: name },
    );
  }

  // 树上/标题账上都要看的「会话记录」：先扫盘（冷会话），再用本 worker 池里的热会话覆盖
  // （热会话的 manager 是最新的；pi 在第一条 assistant 消息落盘前根本不写文件，只靠扫盘会漏）。
  async function sessionRecords() {
    const byId = new Map();
    const pathToId = new Map();
    const files = await listJsonlFiles(sessionsRoot);
    const aggregateBytes = (await Promise.all(files.map((file) => stat(file)))).reduce((sum, info) => sum + info.size, 0);
    let sample = memorySample();
    const predictedPeakBytes = aggregateBytes * memoryBudget.sessionMultiplier + memoryBudget.reserveBytes;
    if (sample.heapUsed + predictedPeakBytes > memoryBudget.heapHighBytes || sample.rss + predictedPeakBytes > memoryBudget.rssHighBytes) {
      const caches = clearRebuildableCaches();
      const evicted = await pool.sweep({ memoryPressure: true });
      globalThis.gc?.();
      sample = memorySample();
      reclaimedMemoryEpisode = sample.episode;
      lastMemoryAction = lastMemoryReclaim = {
        at: new Date().toISOString(), action: 'reclaim', reason: 'tree_aggregate_prediction', sessionId: null,
        sessionFile: null, sessionFileBytes: aggregateBytes, predictedPeakBytes, evicted, caches, sample,
      };
      if (sample.heapUsed + predictedPeakBytes > memoryBudget.heapHighBytes || sample.rss + predictedPeakBytes > memoryBudget.rssHighBytes) {
        throw memoryPressureError('tree', null, aggregateBytes, sample, predictedPeakBytes, 'tree_aggregate_prediction_exceeds_budget');
      }
    }
    for (const file of files) {
      let manager;
      try {
        manager = SessionManager.open(file);
      } catch (error) {
        throw new Error(`cannot read session file ${file}: ${normalizeError(error).message}`);
      }
      if (!manager.getHeader()) throw new Error(`session file has no valid header: ${file}`);
      const id = manager.getSessionId().toLowerCase();
      if (!FULL_UUID.test(id)) throw new Error(`session header id is not a full UUID: ${file}: ${id}`);
      if (byId.has(id)) throw new Error(`duplicate session UUID found in profile: ${id}`);
      const canonical = await realpath(file);
      pathToId.set(canonical, id);
      byId.set(id, { manager, file: canonical, adapter: null });
    }

    for (const runtime of pool.listSessions()) {
      if (!runtime.owner) continue;
      const handle = pool.getHandle(runtime.sessionId);
      if (!handle) continue;
      const snapshot = await inspectAdapter(handle, (adapter) => ({ manager: adapter.manager, adapter, context: adapter.context() }));
      byId.set(runtime.sessionId, { ...snapshot, file: snapshot.manager.getSessionFile() ?? null });
      if (snapshot.manager.getSessionFile()) {
        try { pathToId.set(await realpath(snapshot.manager.getSessionFile()), runtime.sessionId); } catch {}
      }
    }
    return { byId, pathToId };
  }

  // 索引的两本账（只读事实，诊断 / 新门用）：
  //   · `rows` = 能当行用的条目（有 `record`）；
  //   · `checkpoints` = 投影还没盖到整份文件的断点（`partial`）；
  //   · `stale` = 断点里那份**上一次**投影出来的行（稍旧、真实，不是猜的）。
  function treeIndexTally() {
    let rows = 0;
    let checkpoints = 0;
    let stale = 0;
    let checkpointBytes = 0; // 断点里已经投影过的字节总数（= 被中止时会白读的那部分）
    for (const entry of treeIndex.values()) {
      const hasRow = entry.record !== undefined;
      if (hasRow) rows += 1;
      if (entry.partial === true) {
        checkpoints += 1;
        if (hasRow) stale += 1;
        if (Number.isFinite(entry.consumed)) checkpointBytes += entry.consumed;
      }
    }
    return { rows, checkpoints, stale, checkpointBytes };
  }

  function treeIndexSet(file, entry) {
    treeIndex.delete(file);
    treeIndex.set(file, entry);
    while (treeIndex.size > treeIndexMax) {
      const oldest = treeIndex.keys().next().value;
      if (oldest === undefined) break;
      treeIndex.delete(oldest);
    }
  }

  /**
   * `/tree` 的一个会话行：只拿几条「最后一次出现」的事实，不保留 SessionManager。
   * 成本模型：首次见一个文件要读它一遍（整文件 buffer，峰值 = 最大文件）；之后只要
   * (size, mtimeMs, ctimeMs) 没变就直接用索引里的行，变了（追加）只读新增的那一段。
   *
   * ⚠️ **被中止不再等于白读**（2026-09-21 的真机缺陷就是它）：扫的过程中把进度登记成一条
   * `partial` 的**断点**条目（`consumed` = 已经投影到的行边界字节偏移），中止/到点之后下一个
   * 请求从那里接着扫。于是「一次投影不完的大文件」每请求都往前推一截，而不是每次都从 0 重来
   * （旧实现下那是**不动点**：同样的死线、同样的工作量、永远 500）。
   * 断点里若原来就有一份行（追加/重写前投影出来的），就一并留着 —— 行集合因此与旧实现一致，
   * 只是它会被如实计入 `stale`，而不是假装新鲜。
   */
  async function persistedTreeRecord(file, signal) {
    let last = null;
    const recheck = treeAnchorFault() !== 'prefix4k'; // 旧行为没有「扫完再核一次」
    // 「扫完再核一次文件身份」：扫描**正在读**它的时候被替换/截断，读越界会拿到 0 字节并被当成 EOF
    // ⇒ 静默给出半份投影（§9.6 实测；更糟时 `/tree` 500）。所以扫完之后必须再 `stat` 一次，
    // 三元组与开扫时不同 ⇒ 这一份**作废重扫**（不是把它当完整的用）。
    for (let attempt = 0; attempt < TREE_SCAN_STAT_ATTEMPTS; attempt += 1) {
      const info = await stat(file);
      last = await treeRecordFor(file, info, signal);
      if (!recheck) return last;
      const after = await stat(file);
      if (after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs) return last;
      treeScanStatRetries += 1;
      if (signal?.aborted) throw treeAbortError(signal);
    }
    // 连着变（文件正被反复重写）：**不许**把这份投影当完整的用 —— 改成断点（`partial`），
    // 行仍留着（稍旧但真实），下一个请求重扫。
    const settled = { ...last, partial: true };
    treeIndexSet(file, settled);
    return settled;
  }

  async function treeRecordFor(file, info, signal) {
    const cached = treeIndex.get(file);
    // (size, mtime, ctime) 三样都一样才敢直接用 —— ctime 一起看是为了挡住「同长度同 mtime 的原地重写」。
    // ⚠️ `partial === true` 的条目**不算**能用：它的投影没盖到整份文件。
    if (cached && cached.partial !== true && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs) {
      treeIndexSet(file, cached); // LRU：刚用过的放回尾部
      return cached;
    }
    // 两种「接着扫」的候选，判据同一条：**投影自称折过的整段 `[0, consumed)` 逐字节没变**（sha256 核过）
    // 才敢接上去，变了就整份重扫（pi 的 _rewriteFile 会整文件重写且往往变长 —— 宁可慢也不脏读）：
    //   · 追加：缓存条目是一份**完整**投影，文件只变长；
    //   · 断点：缓存条目是上次被中止留下的半份投影（`consumed` 之前的那一段已经投影过了）。
    // ⚠️ 没有摘要的条目（老索引 / 现算失败）一律**不续**：宁可从 0 重扫，也不拿一个核不了的锚当许可。
    const appendFrom = cached && cached.partial !== true && cached.dense === true && typeof cached.consumedDigest === 'string' && info.size > cached.size && cached.consumed <= cached.size
      ? cached
      : null;
    const resumeFrom = treeSelfHeal && cached && cached.partial === true && cached.dense === true && typeof cached.consumedDigest === 'string' && cached.consumed > 0 && cached.consumed <= info.size
      ? cached
      : null;
    // 三号候选：非紧凑文件（`dense === false`）的断点。密度已经知道，连按字节那一趟都不必再跑，
    // 直接从上次解析到的行首接着做 JSON.parse。
    const parseFrom = treeSelfHeal && cached && cached.partial === true && cached.dense === false && typeof cached.parseDigest === 'string' && cached.parseConsumed > 0 && cached.parseConsumed <= info.size
      ? cached
      : null;
    const carried = appendFrom ?? resumeFrom ?? parseFrom;
    treeScanFiles += 1; // 只数「真的投影了一次」：缓存命中不算，所以它不会因重复请求而涨
    if (resumeFrom || parseFrom) treeScanResumes += 1; // 断点续扫的**事实**（诊断 / 新门用）
    let projection = carried ? carried.projection : newTreeProjection();
    let header = carried ? carried.header : null;
    let dense = carried ? carried.dense : null;
    let consumed = carried ? carried.consumed : 0;
    let admitted = false;
    let id = null;
    const admitOnce = async (value) => {
      if (admitted) return;
      id = requireFullSessionId(value?.id);
      await admitSession(id, file, { sessionFileBytes: info.size });
      admitted = true;
    };
    // 增量路：头早就在手上，开文件**之前**就把准入过了（A-29）。
    if (header) await admitOnce(header);
    // 断点条目：**先登记再扫**，于是被中止时已经消费的字节不会白读。它把旧的那份行一并带着
    // （旧实现对追加路就是这么显示的：稍旧但真实的行），所以**行集合不变**。
    const checkpoint = {
      partial: true,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      consumed,
      parseConsumed: carried?.parseConsumed ?? 0,
      dense: dense === true ? true : dense,
      // 续读的锚（`[0, consumed)` 的 sha256）与它对应的字节数：断点里也带上，
      // 于是「被中止之后接着扫」同样要过「整段没变」这道门（不再是前 4 KiB）。
      consumedDigest: carried?.consumedDigest ?? null,
      parseDigest: carried?.parseDigest ?? null,
      prefixHead: carried?.prefixHead ?? null,
      header,
      projection,
      ...(cached?.record !== undefined ? { id: cached.id, record: cached.record } : {}),
    };
    if (treeSelfHeal) treeIndexSet(file, checkpoint);
    const handle = await open(file, 'r');
    // 续读的锚 = 整段 `[0, consumed)` 的 sha256。核过之后那个 hash 对象**继续接着算**：
    // 扫完它就是 `[0, 新 consumed)` 的摘要，直接写进条目给下一次核。
    let legacyAnchor = treeAnchorFault() === 'prefix4k';
    let prefixHash = createHash('sha256');
    let prefixHead = null;
    let consumedDigest = null;
    let parseDigest = null;
    try {
      if (legacyAnchor) {
        // 旧规则那条路只看前 4 KiB：把那份字节读出来（条目里存下来给下一次核），条目里的锚
        // 就只剩前 4 KiB 的指纹（digest 位给一个非空占位，否则续读候选根本不成立，红臂也就测不到东西）。
        consumedDigest = TREE_LEGACY_ANCHOR;
        const headBuffer = Buffer.allocUnsafe(Math.min(TREE_LEGACY_HEAD_SAMPLE, info.size));
        const headRead = headBuffer.length > 0 ? await handle.read(headBuffer, 0, headBuffer.length, 0) : { bytesRead: 0 };
        prefixHead = headBuffer.subarray(0, headRead.bytesRead);
      }
      let startAt = 0;
      if (carried && carried.dense === false) {
        // 非紧凑文件的续读：真正的核对在下面 parse 分支（前缀摘要直接从**内存里的整份字节**算，
        // 这一路本来就要把文件读全 ⇒ 多核一遍不多花 I/O）。
        startAt = carried.consumed;
      } else if (carried) {
        // **只有**投影自称折过的那一段逐字节没变，才敢接着读（判据从「前 4 KiB 相同」升级成整段 sha256）：
        // 核不过就丢掉旧投影、从 0 重扫（宁可慢也不脏读）。
        const verified = legacyAnchor
          ? await verifyHeadPrefix(handle, carried.prefixHead)
          : await hashFilePrefix(handle, carried.consumed, carried.consumedDigest);
        if (verified.ok) {
          if (verified.hash) prefixHash = verified.hash;
          startAt = carried.consumed;
          if (legacyAnchor) consumedDigest = TREE_LEGACY_ANCHOR;
          else consumedDigest = carried.consumedDigest;
        } else {
          projection = newTreeProjection();
          header = null;
          dense = null;
          startAt = 0;
          consumed = 0;
          legacyAnchor = false;
        }
      }
      checkpoint.projection = projection;
      checkpoint.dense = dense === true ? true : dense;
      checkpoint.consumed = startAt;
      checkpoint.parseConsumed = dense === false ? startAt : 0;
      checkpoint.consumedDigest = consumedDigest;
      if (dense !== false) {
        // 按字节扫这一趟。密度已经知道的断点（`dense === false`）跳过这一趟 —— 它的投影会作废，
        // 再读一遍纯粹是白花 I/O。
        const scan = await scanTreeStream(handle, {
          startAt,
          projection,
          signal,
          digest: prefixHash,
          onHeader: admitOnce,
          // 口径也带进去：追加/续扫那条路进来就知道自己是不是按字节投影。
          byteMode: carried ? carried.dense === true : null,
          // 边扫边记账：中止发生在「下一块」之前（scanTreeStream 每块检查一次），
          // 但已经投影完的行那时已经落进断点了。
          // ⚠️ 只有**按字节投影**这一路才敢记：非紧凑文件的那份投影会整份作废（回退到 JSON.parse）。
          onProgress: (value, byteMode) => {
            if (byteMode === true) {
              consumed = value;
              checkpoint.consumed = value;
              checkpoint.dense = true;
              // 断点里的锚必须与断点里的 `consumed` 说得上话：hash 此刻正好覆盖 `[0, value)`。
              checkpoint.consumedDigest = legacyAnchor ? TREE_LEGACY_ANCHOR : prefixHash.copy().digest('hex');
            }
          },
        });
        consumed = scan.consumed;
        if (!legacyAnchor) consumedDigest = prefixHash.copy().digest('hex');
        header ??= scan.header;
        if (dense === null) dense = scan.dense;
        checkpoint.dense = dense === true ? true : dense;
      }
      if (dense === false) {
        // 非紧凑 JSONL（手改 / 外部导入的）⇒ 回退到逐行 JSON.parse 的老投影。宁可慢，也不静默算错。
        // 这一路同样可断点续扫：上次解析到的字节偏移（行首）之前的那一段不再重解析。
        // 它的锚直接从内存里的整份字节算（这一路本来就把文件读全了，核前缀不多花 I/O）。
        const bytes = await readFile(file);
        // 同一道门：整段 `[0, parseStart)` 没变（sha256 核过）才敢从上次的行首接着解析。
        // 其余情形（全新、续的是**按字节**那条路、前缀核不过）一律丢掉现有投影、从 0 重解析。
        let parseStart = carried?.dense === false && startAt > 0
          && carried.parseDigest === createHash('sha256').update(bytes.subarray(0, startAt)).digest('hex')
          ? startAt
          : 0;
        if (parseStart === 0) {
          projection = newTreeProjection();
          startAt = 0;
        }
        checkpoint.projection = projection;
        checkpoint.dense = false;
        checkpoint.consumed = startAt;
        checkpoint.parseConsumed = startAt;
        checkpoint.parseDigest = createHash('sha256').update(bytes.subarray(0, startAt)).digest('hex');
        const text = bytes.subarray(startAt).toString('utf8');
        const parsed = projectTreeTextByParse(text, projection, file, {
          startAt: 0,
          signal,
          onProgress: (value) => {
            consumed = startAt + value;
            checkpoint.consumed = consumed;
            checkpoint.parseConsumed = consumed;
            checkpoint.parseDigest = createHash('sha256').update(bytes.subarray(0, consumed)).digest('hex');
          },
        });
        consumed = startAt + parsed;
        parseDigest = createHash('sha256').update(bytes.subarray(0, consumed)).digest('hex');
        checkpoint.consumed = consumed;
        checkpoint.parseConsumed = consumed;
        checkpoint.parseDigest = parseDigest;
      }
    } finally {
      await handle.close();
    }
    // 头在 1 MiB 内拿不到（或不是合法会话头）⇒ 回退到老路径（它自己会报错 / 报真因）。
    header ??= await readSessionHeader(file);
    await admitOnce(header);
    if (signal?.aborted) throw treeAbortError(signal);
    const status = projection.latestRole === 'assistant' ? 'unread' : 'idle';
    const entry = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      consumed,
      dense: dense === true,
      // 下一个请求的续读许可：`[0, consumed)` 的 sha256（不是前 4 KiB）。
      // `SOPHO_FAULT_TREE_ANCHOR=prefix4k` 时退回旧指纹（只有前 4 KiB 的字节）—— 那是红臂。
      consumedDigest: dense === true ? (legacyAnchor ? TREE_LEGACY_ANCHOR : consumedDigest) : null,
      prefixHead: legacyAnchor ? prefixHead : null,
      parseDigest: dense === false ? parseDigest : null,
      id,
      header,
      projection,
      record: {
        id,
        file: await realpath(file),
        archiveState: { present: projection.archivePresent, archived: projection.archiveArchived },
        context: null,
        summary: {
          id,
          name: projection.name,
          status,
          statusLabel: STATUS_LABELS[status],
          archived: projection.archiveArchived,
          cwd: header.cwd,
          parentSessionPath: header.parentSession ?? null,
          createdAt: header.timestamp ?? null,
          modifiedAt: projection.modified ?? header.timestamp ?? null,
        },
      },
    };
    treeIndexSet(file, entry);
    return entry;
  }

  async function scanTreeIndex(signal) {
    const startedAt = Date.now();
    const filesBefore = treeScanFiles;
    treeScanRuns += 1;
    try {
      const files = await listJsonlFiles(sessionsRoot);
      const present = new Set(files);
      // 部分视图要说清「一共几个文件 / 已经能当行用的几个 / 还差几个」：列目录的结果留一份最新账。
      treeIndexListing = { at: startedAt, files };
      // 小并发：这台机器上每个文件的成本主要在 **open 的固定开销**（Windows + 实时防护，实测
      // 3-4 ms/次），所以「一次开几个」才是冷扫描的杠杆。并发度有界：每一路最多持 1 MiB 读写缓冲
      // + 当前那一行的尾巴，而且 A-29 的「单会话预测」准入不变（每个文件进来第一件事仍是
      // admitSession）。全部活干完之前不会有人拿索引当完整结果（扫描在 promise 里）。
      const queue = [...files];
      const lane = async () => {
        for (;;) {
          if (signal?.aborted) throw treeAbortError(signal);
          const file = queue.shift();
          if (file === undefined) return;
          await persistedTreeRecord(file, signal);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(treeScanConcurrency, queue.length)) }, lane));
      for (const file of [...treeIndex.keys()]) if (!present.has(file)) treeIndex.delete(file);
    } catch (error) {
      if (error?.code === 'tree_scan_aborted') treeScanAborts += 1;
      treeScanLast = { at: new Date().toISOString(), ms: Date.now() - startedAt, files: treeScanFiles - filesBefore, aborted: error?.code === 'tree_scan_aborted' };
      throw error;
    }
    treeScanLast = { at: new Date().toISOString(), ms: Date.now() - startedAt, files: treeScanFiles - filesBefore, aborted: false };
  }

  // 一次索引刷新**只跑一份**：并发 / 重入的 /tree 共享它，而不是每人重扫一遍。
  // 全部等待者都放弃（客户端断开 / 宿主硬超时 abort）时，扫描本身也中止 —— 不许
  // 「被放弃的请求」继续占 CPU/内存（线上实测：硬超时到后 worker 继续算，CPU 2 核、RSS 一路上涨）。
  // 已经读过的文件**留在索引里**，所以下一次请求是接着往前走，不是从零重来。
  //
  // `deadlineAt`（`/tree` 的索引死线，毫秒时间戳）到点就**不再等**：返回 `{ complete: false }`，
  // 让调用方先拿现在索引里的事回一份**部分视图**（行都对、可能不全）。
  // ⚠️ 到点返回**不是**放弃扫描：没人 abort 的话，扫描在后台自己跑完（共享的那一份），
  // 于是「第二次」注定快。只有**真的取消**（signal abort、所有等待者都走了）才中止扫描。
  async function withTreeIndex(signal, { deadlineAt = null } = {}) {
    // ⚠️ **每一个**等结果的调用者都要登记（包括不带 signal 的，比如 GET /env 内部的 listTree()）：
    // 只数带 signal 的等待者的话，「一个客户端走了」会把**还在等的健康调用者**一起干掉
    // （它们会收到 tree_scan_aborted ⇒ 500）。只有**所有**等结果的人都走了，扫描才该停。
    // 另外：如果自己没走、却因为别人走了而被中止，就重试一次（索引里已扫完的文件还在，重试通常只要 stat 一遍）。
    if (signal?.aborted) throw treeAbortError(signal);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!treeScanState) {
        const controller = new AbortController();
        const state = { controller, waiters: new Set() };
        state.promise = scanTreeIndex(controller.signal).finally(() => {
          if (treeScanState === state) treeScanState = null;
        });
        state.promise.catch(() => {}); // 所有等待者都 abort 时，没人 await 这个 promise
        treeScanState = state;
      }
      const state = treeScanState;
      const token = signal ?? { client: 'no-signal' };
      state.waiters.add(token);
      const mineGone = () => signal?.aborted === true;
      const onAbort = () => {
        state.waiters.delete(token);
        if (state.waiters.size === 0) state.controller.abort(signal.reason);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (deadlineAt === null) {
          await state.promise;
          return { complete: true };
        }
        const left = deadlineAt - Date.now();
        if (left <= 0) {
          treeScanPartials += 1;
          return { complete: false };
        }
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            treeScanPartials += 1;
            resolve({ complete: false });
          }, left);
          timer.unref?.();
          state.promise.then(
            () => { clearTimeout(timer); resolve({ complete: true }); },
            (error) => { clearTimeout(timer); reject(error); },
          );
        });
      } catch (error) {
        if (error?.code !== 'tree_scan_aborted' || mineGone() || attempt === 1) throw error;
        // 不是我走了，是别人把它带崩的：重试（并确保下一次真的重新起一次扫描）。
        if (state.controller.signal.aborted && treeScanState === state) treeScanState = null;
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        state.waiters.delete(token);
      }
    }
    throw treeAbortError(signal);
  }

  // 索引能给多少行 / 还差几个文件。`pending` = 列出的文件里**一个行都没有**的那些（还没被投影过）。
  // ⚠️ 它**不**按 `checkpoints` 判：断点里那份旧行是真的（只是稍旧），行集合与旧实现一致；
  // 拿「某个文件的投影正在追加中」当「树不全」会让界面在会话正在跑的时候把树冻住 —— 那更坏。
  function treeIndexCoverage() {
    const files = treeIndexListing?.files ?? [];
    let indexed = 0;
    for (const file of files) if (treeIndex.get(file)?.record !== undefined) indexed += 1;
    return { files: files.length, indexed, pending: files.length - indexed, incomplete: indexed < files.length };
  }

  async function treeRecords(signal, { deadlineAt = null } = {}) {
    const { complete } = await withTreeIndex(signal, { deadlineAt });
    const byId = new Map();
    const pathToId = new Map();
    for (const entry of treeIndex.values()) {
      // 断点里没有行（`record === undefined`）的条目**不成行**：宁可不全，也不拿半份投影冒充一条会话。
      if (entry.record === undefined) continue;
      if (byId.has(entry.id)) throw new Error(`duplicate session UUID found in profile: ${entry.id}`);
      byId.set(entry.id, entry.record);
      pathToId.set(entry.record.file, entry.id);
    }
    // A hot runtime may contain entries not durable yet, and it is the current truth for
    // working/status/context. Override the lightweight disk row without retaining any new
    // cold SessionManager.
    //
    // ⚠️ 这一步**逐 handle 走 `runExclusive`**：某个会话的串行队列被一个永不 resolve 的操作占住
    // （例如 abort 的 `waitForIdle()`）时，这里若无限等下去，整条 `/tree` 就一个字不回 ⇒ 宿主 500。
    // 所以每个 handle 都套一条**显式死线**：到点**跳过这一行**（盘上的行还在，只是缺了 working/context
    // 这个热覆写），并把它如实记进 `hotUnavailable`，由 `listTree` 回给调用方（`liveFactsUnavailable`）。
    const hotUnavailable = [];
    const hotDeadlineAt = deadlineAt === null ? Date.now() + (treeHotFactsBudgetMs ?? Number.POSITIVE_INFINITY) : deadlineAt;
    for (const runtime of pool.listSessions()) {
      if (!runtime.owner) continue;
      const handle = pool.getHandle(runtime.sessionId);
      if (!handle) continue;
      const left = hotDeadlineAt - Date.now();
      if (left <= 0) {
        hotUnavailable.push({ sessionId: runtime.sessionId, reason: 'tree_deadline' });
        continue;
      }
      const perHandle = treeHandleDeadlineMs === null ? left : Math.min(treeHandleDeadlineMs, left);
      const outcome = await raceDeadline(inspectAdapter(handle, (adapter) => ({
        id: runtime.sessionId,
        file: adapter.manager.getSessionFile() ?? null,
        archiveState: latestArchiveState(adapter.manager.getEntries()),
        context: adapter.context(),
        summary: summaryFromManager(adapter.manager, adapter),
      })), perHandle);
      if (outcome.timedOut) {
        // 宁可不全，也不给错：这一行的热事实取不到就**跳过**，绝不把「不知道」当「没有」。
        hotUnavailable.push({ sessionId: runtime.sessionId, reason: 'handle_timeout', timeoutMs: perHandle });
        continue;
      }
      if (outcome.error) throw outcome.error;
      const record = outcome.value;
      byId.set(record.id, record);
      if (record.file) {
        try { pathToId.set(await realpath(record.file), record.id); } catch {}
      }
    }
    return { byId, pathToId, complete, hotUnavailable };
  }

  // `/tree` 的最后一步：拿索引里的行拼一棵树。
  //
  // `budgetMs`（可选，> 0）是**索引死线**：到点不等了，回一份**部分视图**。
  // 部分视图的纪律（宁可不全，也不给错）：
  //   · 行只从**完整条目**来（半份投影不成行）；
  //   · `parentId` 解不出来的行（父文件还没扫到 / 正在重写）**先不发** —— 否则它的 parentId
  //     先是 null、父文件扫完又变成真 id，那是「给错数据」不是「给不全」；
  //   · 传递闭合：祖先被隐掉的后代一起隐掉（否则它们会浮到根上）。
  //   · 顶层加 `partial: true` + `indexScan:{files,indexed,pending,rows,hidden,truncated,...}`；一份**完整**树
  //     不加任何新字段 —— 既有字段一个不改、不删，前端不需要知道这个窗口。
  //
  // ⚠️ **拼行这一步也受死线管**：到点之后扫描还在后台跑，那时每一行的 `realpath` 都要和扫描抢
  // libuv 线程池（实测：抢起来一行能到几 ms），几百行就能把响应拖到死线外 —— 那就又从「部分视图」
  // 退回「500」了（真机就是这么坏的）。所以到点就**停在半路**（`truncated: true`），剩下的行下次给。
  // ⚠️ **拼行那一步另有保留配额**（`rowDeadlineAt = deadlineAt + reserve`）：上面那条死线必然被「等扫描」
  // 用满（扫描比死线长得多），若拼行也卡在同一条死线上，部分视图就会是 **0 行**
  // （实测：同一夹具的同一臂跑出过 70 / 174 / 0 行 —— 「宁可不全」就退化成「什么都不给」了）。
  // 保留额取预算的 0.25（下界 50 ms、上界 1200 ms）⇒ 总时长仍受「预算 + 保留额」约束
  // （默认 3500 + 875 = 4375 ms ≪ 宿主那条 5000 ms 硬超时），但部分视图一定装得下它装得下的行。
  // 到点之后剩下的行下次再给（`truncated: true` 如实标出来）。
  async function listTree({ signal, budgetMs = null } = {}) {
    const deadlineAt = typeof budgetMs === 'number' && budgetMs > 0 ? Date.now() + budgetMs : null;
    const placementConfig = await readPlacementConfig(placementFile);
    const legacyArchived = await legacyArchiveIds();
    // 标题账只**读**（/tree 是只读路径，绝不因为展示而写 sidecar；要对账看 GET /titles）。
    const titles = await readTitlesSafe();
    // 业主 2026-10-05 第(2)条：「已归档的子会话跟着**冷段**走」的侧车 —— `/tree` 解 `parentId` 时优先查它。
    const sealParents = await readSealParents();
    const { byId, pathToId, complete, hotUnavailable } = await treeRecords(signal, { deadlineAt });
    const rowBudgetMs = deadlineAt === null ? 0 : Math.min(1200, Math.max(50, Math.round(budgetMs * 0.25)));
    const rowDeadlineAt = deadlineAt === null ? null : deadlineAt + rowBudgetMs;

    const sessions = [];
    const unresolvedParent = new Set();
    let truncated = false;
    for (const [id, record] of byId) {
      if (rowDeadlineAt !== null && Date.now() > rowDeadlineAt) { truncated = true; break; }
      const archived = record.archiveState.present ? record.archiveState.archived : legacyArchived.has(id);
      const summary = applyPlacement(
        { ...record.summary, archived },
        placementFor(placementConfig, id, record.summary.cwd),
      );
      let parentId = null;
      if (summary.parentSessionPath) {
        try { parentId = pathToId.get(await realpath(summary.parentSessionPath)) ?? null; } catch { parentId = null; }
        // 索引还没建完时，「父解不出来」可能只是「还没扫到」：先不发这一行（见上面的纪律）。
        if (parentId === null && !complete) unresolvedParent.add(id);
      }
      // 侧车优先：封存那一刻**已经归档**的子会话改挂到冷段名下（业主第(2)条）。判定本身在
      // `resolveReportedParent` 里（**详情那一面调的是同一个函数** ⇒ 两处不可能漂）。
      // 目标（冷段）真在这份树里时才认它；不在就**回落到会话头里的值**（行不消失、不错挂）。
      // 索引还没建完时目标可能只是「还没扫到」⇒ 先不发这一行（宁可不全，也不给错）。
      const reported = resolveReportedParent({
        childId: id,
        fileParentId: parentId,
        sealParents,
        targetExists: (parentSessionId) => byId.has(parentSessionId),
      });
      parentId = reported.parentId;
      if (reported.deferred && !complete) unresolvedParent.add(id);
      // `name` 是 pi 文件里的当下名字（树显示的就是它）；`titleSource` 是**我们账上那条的来源**
      // （seed/auto/manual/null）。两者都如实；账读不出来时 titleSource 为 null 且顶层报 titles.error。
      sessions.push({ ...summary, id, parentId, titleSource: titles.ok ? (titles.value[id]?.source ?? null) : null, context: record.context });
    }
    let visible = sessions;
    if (!complete && unresolvedParent.size > 0) {
      const emitted = new Set(sessions.map((session) => session.id));
      for (const id of unresolvedParent) emitted.delete(id);
      // 传递闭合：祖先没了的后代也不发（否则它会被前端画到根上，位置随后又变）。
      for (let changed = true; changed;) {
        changed = false;
        for (const session of sessions) {
          if (!emitted.has(session.id)) continue;
          if (session.parentId !== null && !emitted.has(session.parentId)) {
            emitted.delete(session.id);
            changed = true;
          }
        }
      }
      visible = sessions.filter((session) => emitted.has(session.id));
    }
    // 同 `modifiedAt` 的并列项按 id 定序：索引现在是**并发**扫的（每文件的固定开销主要在 open），
    // 并列项的先后不能随「谁先扫完」飘 —— 否则同一个树两次请求的行序可能不一样。
    visible.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)) || left.id.localeCompare(right.id));
    const result = { sessions: visible, generatedAt: new Date().toISOString(), titles: { ok: titles.ok, exists: titles.exists, error: titles.error } };
    // 如实标注：热 runtime 覆写里某个 handle 到点没答上来（被卡住的串行队列占着）⇒ 那一行只剩
    // 扫盘出来的底（status/context 可能不是当下事实）。字段是**封闭、可断言**的：
    // `[{ sessionId, reason: 'handle_timeout'|'tree_deadline', timeoutMs? }]`。**不是** 500，也不撒谎。
    if (hotUnavailable.length > 0) result.liveFactsUnavailable = hotUnavailable;
    if (!complete || truncated) {
      const coverage = treeIndexCoverage();
      result.partial = true;
      result.indexScan = {
        complete: false,
        files: coverage.files,
        indexed: coverage.indexed,
        pending: coverage.pending,
        rows: visible.length,
        hidden: byId.size - visible.length,
        truncated,
        budgetMs: treeIndexBudgetMs,
        rowBudgetMs,
        resumes: treeScanResumes,
      };
    }
    return result;
  }

  // GET /sessions/{id} —— 看详情**不建 runtime**。
  //
  // 为什么：`withSession` = acquire = 冷会话也要建一个 pi runtime（插件加载 + 解析会话文件，
  // 真机冷开 ~1-3 s，而 v2.1 是 5 ms）。看详情只需要「文件里的事实 + 侧车账」，那些不需要 runtime。
  //
  // 两条路：
  //   · **已经热**（`pool.getHandle` 有句柄）：问 runtime —— isStreaming/isCompacting/model/context
  //     这几个只有 runtime 知道，而 runtime 已经在跑，读它们是零成本。`getHandle` 是**只读查询**，
  //     不是 acquire；这条区别就是「详情会不会冷开一个 runtime」的全部。
  //   · **冷**：只读文件（= /tree 那份投影，按 (size,mtime) 缓存）+ 侧车（placement/titles/archive）。
  //     离了 runtime 答不了的字段一律 null 并且**明列**在 `unavailableFields` 里（不猜、不编常量）。
  async function cwdIsMissing(cwd) {
    try {
      await stat(cwd);
      return false;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      return true;
    }
  }

  /** 一份会话文件的**头**里那个 `id`（只读第一行，不整份解析）。解不出来（路径悬垂 / 不是一份会话头 /
   *  `id` 不是完整 uuid）⇒ null。
   *  `/tree` 手里已经有一张扫出来的 `realpath → id` 表（`pathToId`）；详情为一条会话只解一个父，
   *  走的是**同一份事实来源**（会话文件的第一行头），不是另造一套口径。 */
  async function sessionIdAtPath(file) {
    try {
      return requireFullSessionId((await readSessionHeader(await realpath(file)))?.id);
    } catch {
      return null;
    }
  }

  /**
   * 详情这一面报的**父 id**：与 `/tree` 解 `parentId` 走**同一个** `resolveReportedParent`（同一条规矩：
   * 侧车优先、目标真存在才认、不然回落到文件层的值），侧车也走同一个 `readSealParents` 缓存。
   * 「目标真的存在」在详情这一面 = **盘上有那条会话的文件**；`/tree` 用它的索引（`byId.has`）—— 两边问的
   * 是同一件事（那条冷段是不是一份真会话）。
   * 沙箱注入（生产不设 ⇒ 零影响）：`SOPHO_FAULT_DETAIL_PARENT_IGNORES_SIDECAR` = 逗号分隔的会话 id
   *（或 `1` = 全部）⇒ 这一面假装侧车不存在（回到文件层的值），红臂用；`SOPHO_FAULT_SEAL_PARENTS_NO_FALLBACK`
   * 由 `resolveReportedParent` 读（与 `/tree` 同一个开关 ⇒ 同一份规矩）。
   */
  async function reportedParentIdOf(childId, rawParentPath, sealParents) {
    const ignored = process.env.SOPHO_FAULT_DETAIL_PARENT_IGNORES_SIDECAR;
    const ignoreSidecar = ignored === '1'
      || (typeof ignored === 'string' && ignored.split(',').some((value) => value.trim().toLowerCase() === childId));
    // 目标真不真存在：只查侧车真命中的那一支，且**提前**算（判定函数是同步的纯函数）。查不动
    //（非 ENOENT 的意外错）⇒ 当「不在」⇒ 走回落那条路：会话头永远是那份文件里的事实，比为一个
    // 侧车把详情打成 500 诚实。
    const rehomed = sealParents.get(childId);
    let targetExists = false;
    if (rehomed !== undefined) {
      try { targetExists = (await findPersistedSession(rehomed.parentId)) !== null; } catch { targetExists = false; }
    }
    const fileParentId = rawParentPath ? await sessionIdAtPath(rawParentPath) : null;
    return resolveReportedParent({ childId, fileParentId, sealParents, targetExists: () => targetExists, ignoreSidecar }).parentId;
  }

  async function sessionDetail(sessionId, ownerCurrentGeneration = null, signal = null) {
    const placementConfig = await readPlacementConfig(placementFile);
    const titles = await readTitlesSafe();
    const legacyArchived = await legacyArchiveIds();
    // 业主 2026-10-05 第(2)条：详情报的父级与 `/tree` 必须**同一个**（侧车优先、同一条回落）。
    const sealParents = await readSealParents();
    const titleSource = titles.ok ? (titles.value[sessionId]?.source ?? null) : null;
    const handle = pool.getHandle(sessionId);
    const file = await findPersistedSession(sessionId);
    // 没有文件也可能**有**会话：pi 建了会话但还没落盘（第一条 assistant 消息之前根本不写文件），
    // 那种只有 runtime 手里有。反过来只有文件没有 runtime 是常态（冷会话）。
    if (!file && !handle) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);

    // 热：问 runtime（它的当下事实只有它有：isStreaming/isCompacting/model/context，
    // 而且 runtime 已经在跑，读它们是零成本）。`pool.getHandle` 是**只读查询**，不是 acquire ——
    // 这条区别就是「看详情会不会冷开一个 runtime」的全部。
    if (handle) {
      // ⚠️ 父 id 在 `inspectAdapter` **外面**解：这是那条会话的串行段（`runExclusive`），在里
      // 面读盘会把别的操作挡在后面。所以这里只把运行时的父路径带出来，出去再解。
      let runtimeParentPath = null;
      const hot = await inspectAdapter(handle, async (adapter) => {
        const runtime = { ...adapter.snapshot(), archiveState: latestArchiveState(adapter.manager.getEntries()) };
        runtimeParentPath = runtime.summary.parentSessionPath ?? null;
        const archived = runtime.archiveState.present ? runtime.archiveState.archived : legacyArchived.has(sessionId);
        const placed = applyPlacement({ ...runtime.summary, archived }, placementFor(placementConfig, sessionId, runtime.summary.cwd));
        await handle.refreshPersistence();
        const base = { ...placed, sessionId, titleSource, ...poolSnapshot(sessionId, ownerCurrentGeneration), detailSource: 'runtime' };
        const cwd = adapter.manager.getCwd();
        if (await cwdIsMissing(cwd)) {
          // cwd 没了 = 只能看不能继续。这个形状沿用旧口径（readOnly + observable 都拿不到了）。
          return {
            ...base,
            observability: null,
            context: null,
            runtime: { isStreaming: false, isCompacting: false, isRetrying: false, model: null, thinkingLevel: null },
            readOnly: true,
            readOnlyReason: 'cwd-missing',
            cwdMissing: cwd,
            unavailableFields: ['observability', 'context', 'runtime.model', 'runtime.thinkingLevel'],
          };
        }
        return {
          ...base,
          observability: runtime.observability,
          context: runtime.context,
          runtime: {
            isStreaming: runtime.isStreaming,
            isCompacting: runtime.isCompacting,
            isRetrying: runtime.isRetrying,
            model: runtime.model,
            thinkingLevel: runtime.thinkingLevel ?? null,
          },
          readOnly: false,
          readOnlyReason: null,
          cwdMissing: null,
        };
      });
      // 父级与 `/tree` 同一条规矩（侧车优先、目标真存在才认、悬垂回落头里的值）：`parentSessionPath`
      // 仍是会话头里的投影（文件层真相，一个字不改），新报的 `parentId` 才是解出来的父。
      const parentId = await reportedParentIdOf(sessionId, runtimeParentPath, sealParents);
      return { ...hot, parentId };
    }

    // 冷：只读文件（= /tree 那份按 (size,mtime) 缓存的字节投影）+ 侧车账。不建 runtime。
    const entry = await persistedTreeRecord(file, signal);
    const summary = entry.record.summary;
    const cwdMissing = await cwdIsMissing(summary.cwd);
    const archived = entry.record.archiveState.present ? entry.record.archiveState.archived : legacyArchived.has(sessionId);
    const placed = applyPlacement({ ...summary, archived }, placementFor(placementConfig, sessionId, summary.cwd));
    const snapshot = poolSnapshot(sessionId, ownerCurrentGeneration);
    const known = Object.keys(snapshot).length > 0;
    // 没有 runtime ⇒ pluginStale/logicStale 没有主语：一律 null + 明列（不管池里有没有一条冷记录）。
    // 「池里有记录」只说明这一代 worker 曾经跑过它（durable/lastAccessAt/settledAt 那些还是真事实，照报），
    // 但它现在没有 runtime，所以「它跑哪一版插件」这个问题仍然无解 —— 不能因为有过记录就答 false。
    const { pluginStale: _pluginStale, logicStale: _logicStale, staleReason: _staleReason, ...poolRecord } = snapshot;
    const coldFields = known
      ? { pluginStale: null, logicStale: null, staleReason: null }
      : {
        runtimeState: 'cold',
        currentGenerationId: ownerCurrentGeneration ?? pool.currentGenerationId,
        runtimeId: null,
        generationId: null,
        workerPid: null,
        logicVersion: null,
        codeRevision: null,
        loadedAt: null,
        lastAccessAt: null,
        settledAt: null,
        idleForMs: 0,
        lastEvictedAt: null,
        lastEvictionReason: null,
        restoreCount: 0,
        acquiredLeases: 0,
        queuedOperations: 0,
        pendingMessages: 0,
        pinReasons: [],
        evictionEligible: false,
        owner: null,
        internalKey: null,
        durable: null,
        pluginStale: null,
        logicStale: null,
        staleReason: null,
      };
    const unavailableFields = ['observability', 'context', 'runtime.model', 'runtime.thinkingLevel', 'pluginStale', 'logicStale', 'staleReason'];
    if (!known) unavailableFields.push('durable', 'loadedAt', 'lastAccessAt', 'owner');
    // 冷这一面同样报解出来的父（与 `/tree` 同一处判定）；`parentSessionPath` 仍是会话头里的投影。
    const parentId = await reportedParentIdOf(sessionId, summary.parentSessionPath, sealParents);
    return {
      ...placed,
      sessionId,
      titleSource,
      parentId,
      ...poolRecord,
      ...coldFields,
      observability: null,
      context: null,
      runtime: { isStreaming: false, isCompacting: false, isRetrying: false, model: null, thinkingLevel: null },
      readOnly: cwdMissing,
      readOnlyReason: cwdMissing ? 'cwd-missing' : null,
      cwdMissing: cwdMissing ? summary.cwd : null,
      detailSource: known ? 'pool+file' : 'file',
      unavailableFields,
    };
  }

  // GET /titles —— 标题的**账**（诊断 / 验证）：每条 + 会话文件里**当下**的名字 + 对不对得上。
  // ⚠️ 它会**顺手对账**（把「不是我们设的」名字记成 manual），所以这个 GET 是**会写 sidecar**
  // 的（与 v2.1 一致）；只读路径是 /tree（它绝不写账）。
  async function titlesReport() {
    const { byId } = await sessionRecords();
    const items = [];
    for (const [sessionId, record] of byId) {
      const state = await reconcileTitleState(record.manager, sessionId);
      items.push({
        id: sessionId,
        name: state.current, // pi 文件里的当下名字（树显示的就是它）
        title: state.rec?.title ?? null, // 我们账上那条
        source: state.rec?.source ?? null,
        at: state.rec?.at ?? null,
        manual: state.rec?.source === 'manual',
      });
    }
    items.sort((left, right) => left.id.localeCompare(right.id));
    return { file: titlesFile, count: items.length, items };
  }

  async function createDelegatedSession({ sessionId, cwd, name, parentSessionPath, task }) {
    return queueSessionCreate(async () => {
      requireFullSessionId(sessionId);
      const placementConfig = await readPlacementConfig(placementFile);
      const targetCwd = path.resolve(requireText(cwd, 'cwd'));
      // A handoff between siblings inherits the source's parentSession, which may be
      // null when the source is a root session; then the new session is a root too.
      const parentFile = parentSessionPath === undefined || parentSessionPath === null
        ? null
        : path.resolve(requireText(parentSessionPath, 'parentSessionPath'));
      const result = await withSession(sessionId, async (handle) => {
        if (name !== undefined && name !== null) {
          if (typeof name !== 'string') throw new HttpError(400, 'invalid_name', 'name must be a string');
          // 显式给的名字 = L0 种子（确定性给的，不是模型判断的）→ 记 seed，此后模型可自己改。
          // raw:true：宿主直接把它写进文件，**不**用 cleanTitle 截断（截了就跟文件对不上 → 错记 manual）。
          if (piName(name)) await inspectAdapter(handle, (adapter) => applyTitle(adapter, { title: name, source: 'seed', raw: true }));
        }
        if (task !== undefined && task !== null) {
          const text = requireText(task, 'task');
          // 没有显式名字时，用第一条 user 消息的第一行当 L0 种子（放在 prompt 之前）。
          await inspectAdapter(handle, (adapter) => seedTitleIfUnnamed(adapter, text));
          const started = await inspectAdapter(handle, (adapter) => adapter.startPrompt(text));
          await started.accepted;
        }
        return inspectAdapter(handle, (adapter) => adapter.snapshot().summary);
      }, { create: true, cwd: targetCwd, ...(parentFile ? { parentSession: parentFile } : {}) });
      // 会话此刻**已经落盘**（withSession create 成功）⇒ 记账写失败绝不能把它变成 500：
      // 调用方拿不到 id、会去重试创建并撞上宿主的「cwd 已被占」409，没有恢复路径（2026-09-21 事故）。
      const placementEntry = { ...derivedPlacement(targetCwd), at: Date.now() };
      placementConfig.value[sessionId] = placementEntry;
      let placementPersisted = true;
      let warning = null;
      try {
        await persistPlacement(placementConfig);
      } catch (error) {
        placementPersisted = false;
        pendingPlacements.set(sessionId, placementEntry);
        warning = placementWriteWarning(placementFile, `session ${sessionId} was created, but its placement record could not be written to ${placementFile}; the session is already live and on the tree (placement is derived from its own cwd; /tree reports derived:true / source:'pi-header'), so do NOT retry the create — a retry would hit the live-cwd guard. The entry will be written on the next successful placement write.`, error);
        console.error(`[placement] ${warning.message} (${normalizeError(error).message})`);
      }
      emitTree(sessionId, task === undefined || task === null ? 'child_created' : 'delegated');
      return {
        ...result,
        placementPersisted,
        warning,
        placement: placementPersisted
          ? { ...placementEntry, derived: false, source: 'placement.json' }
          : { ...placementEntry, derived: true, source: 'pi-header' },
      };
    });
  }

  async function deliverTypedMessage(sessionId, { kind, fromSessionId, text }) {
    requireFullSessionId(sessionId);
    await assertSessionCwdAvailable(sessionId);
    await assertNotMoved(sessionId);
    const value = await withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => adapter.deliverDelegation({
      kind: requireText(kind, 'kind'),
      fromSessionId: fromSessionId === null ? null : requireFullSessionId(fromSessionId),
      text: requireText(text),
    })));
    emitTree(sessionId, `delegation_${kind}`);
    return value;
  }

  async function deliverDelegationMessage(sessionId, input) {
    return deliverTypedMessage(sessionId, input);
  }

  async function liveSessionFacts() {
    // 测试专用故障注入（生产不设 ⇒ 零影响）：见 `liveFactsDownFaultFires` 的注释。
    if (liveFactsDownFaultFires()) {
      throw new Error('fault injection: liveSessionFacts is down (SOPHO_FAULT_LIVE_FACTS_DOWN)');
    }
    const placementConfig = await readPlacementConfig(placementFile);
    const facts = [];
    // 逐 handle 走 `runExclusive`（见 `treeRecords` 那段注释）：到点就**跳过这个 handle**并如实记进
    // `unavailable`，**绝不**让一个卡住的会话把整条 live-facts 拖成一个永不 resolve 的 await。
    // 两条调用方各自按契约处理这个诚实结果：正确性路（`allLiveSessionFacts`）**不 fail-open**
    // ⇒ 有 `unavailable` 就回可重试 503；装饰路（draining 代）⇒ 标 `degraded`，不假装没人跑。
    const unavailable = [];
    for (const runtime of pool.listSessions()) {
      if (!runtime.owner) continue;
      const handle = pool.getHandle(runtime.sessionId);
      if (!handle) continue;
      const outcome = await raceDeadline(inspectAdapter(handle, (adapter) => {
        const snapshot = adapter.snapshot();
        return {
          id: runtime.sessionId,
          name: snapshot.summary.name,
          cwd: snapshot.summary.cwd,
          running: adapter.isWorking(),
          moved: Boolean(placementConfig.value[runtime.sessionId]?.claimedBy),
          sessionFile: adapter.manager.getSessionFile() ?? null,
          parentSessionPath: snapshot.summary.parentSessionPath,
        };
      }), liveFactsHandleDeadlineMs);
      if (outcome.timedOut) {
        unavailable.push({ sessionId: runtime.sessionId, reason: 'handle_timeout', timeoutMs: liveFactsHandleDeadlineMs });
        continue;
      }
      if (outcome.error) throw outcome.error;
      facts.push(outcome.value);
    }
    return { facts, unavailable };
  }

  async function parentSessionFact(sessionId) {
    const childId = requireFullSessionId(sessionId);
    await assertSessionCwdAvailable(childId);
    let childFile = await findPersistedSession(childId);
    const hot = pool.getHandle(childId);
    if (hot) childFile = await inspectAdapter(hot, (adapter) => adapter.manager.getSessionFile() ?? childFile);
    if (!childFile) throw new HttpError(404, 'session_not_found', `session not found: ${childId}`);
    const child = SessionManager.open(childFile);
    const parentPath = child.getHeader()?.parentSession ?? null;
    if (!parentPath) return { childSessionId: childId, parentSessionId: null, parentSessionPath: null };
    let parent;
    try {
      parent = SessionManager.open(parentPath);
    } catch (error) {
      throw new HttpError(409, 'parent_session_unreadable', `cannot read parent session from child header: ${normalizeError(error).message}`);
    }
    return {
      childSessionId: childId,
      parentSessionId: requireFullSessionId(parent.getSessionId()),
      parentSessionPath: path.resolve(parentPath),
    };
  }

  async function delegationSessionRead(sessionId, lines = 4) {
    const id = requireFullSessionId(sessionId);
    await assertSessionCwdAvailable(id);
    const limit = Number.isInteger(lines) ? Math.max(1, Math.min(lines, 50)) : 4;
    const detail = await sessionDetail(id);
    const wire = await withSession(id, (handle) => inspectAdapter(handle, (adapter) => adapter.messages()));
    const recent = wire.messages.slice(-limit);
    let turnStart = -1;
    for (let index = wire.messages.length - 1; index >= 0; index -= 1) {
      if (wire.messages[index].role === 'user') {
        turnStart = index;
        break;
      }
    }
    let lastAssistant = null;
    for (let index = wire.messages.length - 1; index > turnStart; index -= 1) {
      if (wire.messages[index].role === 'assistant') {
        lastAssistant = wire.messages[index];
        break;
      }
    }
    const assistantBodyLength = lastAssistant === null ? null : lastAssistant.text.length;
    return {
      sessionId: id,
      name: detail.name,
      cwd: detail.cwd,
      status: detail.status,
      running: Boolean(detail.runtime?.isStreaming || detail.runtime?.isCompacting || detail.runtime?.isRetrying),
      pluginStale: detail.pluginStale,
      recent,
      lastTurn: {
        assistantBodyLength,
        emptyAssistantBody: assistantBodyLength === 0,
        note: assistantBodyLength === 0 ? '这一回合最后一条助手消息正文长度为 0；内容可能只写进了 reasoning/thinking 通道。' : null,
      },
    };
  }

  // ── 「源会话必须已落盘」= `/move` 与 `handoff` 的共同前置条件，两条路必须答同一句话 ────────
  // pi 的 SessionManager 在**第一条 assistant 消息出现之前根本不写文件**
  //（`pi-coding-agent/dist/core/session-manager.js` 的 `_persist`：`hasAssistant === false` 时直接 return），
  // 所以一条建出来、还没跑过任何回合的会话（`POST /sessions`、`session_new`、handoff 的
  // createDelegatedSession）在本代里是**热的**（池记 `internalKey:"pending:<id>"` / `durable:false`），
  // 而 `adapter.manager.getSessionFile()` 已经给出一个**盘上还不存在**的路径。
  // 旧行为两种都不说真话：`/move` 拿那个路径直接 `readFile` ⇒ `500 internal_error ENOENT`（崩，不是拒绝）；
  // `handoff` 走只认磁盘的 `findPersistedSession` ⇒ `404 session_not_found`（"会话不存在"，把调用方
  // 引向错方向）。同一个条件 ⇒ 同一个码：`409 session_not_durable` + 一条能照着走的恢复路径。
  // 为什么不替调用方"materialize"（先落一个文件再搬）：pi 的 `flushed` 还是 false，下一次真落盘会走
  // `openSync(path, 'wx')` ⇒ **EEXIST 直接崩**；我们手写的文件不是它认账的那个文件。见 docs/handoff.md。
  function sourceNotDurable(sessionId) {
    return new HttpError(409, 'session_not_durable', `source session has no durable file on disk yet: it has never run a turn, so pi has not written its .jsonl (pi only writes a session file once its first assistant message exists). Send that session one message to make it durable, then retry — or pick a session that already has a file on disk: ${sessionId}`, { sessionId, durable: false, reason: 'never_ran_a_turn' });
  }

  // 「盘上真有这个文件吗」只看真实事实（`stat`）——**不**看 manager 给的名字，它在 pending 会话上照给。
  async function durableFileExists(file) {
    try {
      await stat(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function moveSession(sessionId, body) {
    const placementConfig = await readPlacementConfig(placementFile);
    await assertNotMoved(sessionId);
    const requestedCwd = requireText(body.cwd, 'cwd');
    const resolvedCwd = path.resolve(requestedCwd);
    const cwdInfo = await stat(resolvedCwd).catch(() => null);
    if (!cwdInfo?.isDirectory()) {
      throw new HttpError(409, 'target_cwd_missing', `target cwd does not exist or is not a directory: ${resolvedCwd}`, { cwd: resolvedCwd });
    }
    const targetCwd = await realpath(resolvedCwd);
    const result = await withSession(sessionId, async (handle) => inspectAdapter(handle, async (adapter) => {
      if (adapter.isWorking() && !adapter.isAdmittingOwnCommand()) {
        const snapshot = adapter.snapshot();
        throw new HttpError(409, 'session_busy_move', 'move refused: the source session is streaming, compacting, retrying, or accepting a prompt; wait until it settles so forkFrom cannot copy a partial snapshot', {
          sessionId,
          runtime: {
            isStreaming: snapshot.isStreaming,
            isCompacting: snapshot.isCompacting,
            isRetrying: snapshot.isRetrying,
            pendingMessages: snapshot.pendingMessages,
          },
        });
      }
      const sourceFile = adapter.manager.getSessionFile();
      // pi 给的是个"名字"，不保证盘上有这个文件（pending 会话上它照给）⇒ 必须自己 `stat` 一下，
      // 否则下面 `readFile` 撞 ENOENT，以 `500 internal_error` 收场（那是"没说真话"的极端形态）。
      if (!sourceFile || !(await durableFileExists(sourceFile))) throw sourceNotDurable(sessionId);
      const sourceBeforeFork = await readFile(sourceFile);
      const fork = SessionManager.forkFrom(sourceFile, targetCwd, sessionsRoot);
      const sourceAfterFork = await readFile(sourceFile);
      if (!sourceBeforeFork.equals(sourceAfterFork)) {
        throw new HttpError(500, 'fork_modified_source', `forkFrom unexpectedly modified source session: ${sourceFile}`);
      }
      const movedTo = requireFullSessionId(fork.getSessionId());
      const at = Date.now();
      placementConfig.value[sessionId] = {
        ...(placementConfig.value[sessionId] ?? derivedPlacement(adapter.manager.getCwd())),
        claimedBy: movedTo,
        at,
      };
      placementConfig.value[movedTo] = { ...derivedPlacement(targetCwd), at };
      // forkFrom 已经落盘 ⇒ 同一口径：记账写失败不让已发生的搬家被回报成 500（否则 toSessionId
      // 丢失，调用方重试 move 会再造一个 fork）。但必须如实警告：源会话没被标 moved。
      let placementPersisted = true;
      let warning = null;
      try {
        await persistPlacement(placementConfig);
      } catch (error) {
        placementPersisted = false;
        pendingPlacements.set(sessionId, placementConfig.value[sessionId]);
        pendingPlacements.set(movedTo, placementConfig.value[movedTo]);
        warning = placementWriteWarning(placementFile, `session ${movedTo} was forked and exists, but its placement record could not be written to ${placementFile}; the source ${sessionId} is therefore NOT marked as moved (placement claimedBy was not persisted), so do not retry the move — that would create a second fork. The entry will be written on the next successful placement write.`, error);
        console.error(`[placement] ${warning.message} (${normalizeError(error).message})`);
      }
      return {
        fromSessionId: sessionId,
        toSessionId: movedTo,
        sourceFile,
        targetFile: fork.getSessionFile(),
        cwd: targetCwd,
        parentSession: fork.getHeader()?.parentSession ?? null,
        sourceUnchangedByFork: true,
        sourceBytesAtFork: sourceBeforeFork.length,
        sourceLinesAtFork: sourceBeforeFork.toString('utf8').trimEnd().split('\n').length,
        archived: true,
        movedMarker: `moved-to:${movedTo}`,
        sourceBytesAfterMove: sourceAfterFork.length,
        placementPersisted,
        warning,
      };
    }));
    emitTree(sessionId, 'moved');
    emitTree(result.toSessionId, 'move_created');
    return result;
  }

  // ── 「压缩即封存」（反装版）：安全点 = **没有任何 runtime 持有它** ────────────────────────
  //
  // 形状与判据（`docs/design-session-seal.md`）：压缩回合落定之后、且没有任何 runtime 持有它时，
  // 把**同一个 id、同一条路径**的会话文件原地换成 `[头] + [摘要] + [kept] + [tail]`，
  // 被裁掉的那一段另起一个**新 id** 落成归档件。原 id / 身份机器一个字不动。
  //
  // **冷段与热会话是兄弟，不是父子**（业主 2026-10-05 的要求，与 `/handoff` 同一条口径：
  // `handoffSession` 的「The new session's parentSession is the source's parent, so the tree gains a
  // sibling, not a child」）。冷段的 `parentSession` = **热会话头里的那个 `parentSession`** ⇒ 热会话是根时
  // 冷段也是根、热会话有父时两者同级；**不再**指向热会话的文件（那会让树上「旧会话挂在压缩后的会话名下」）。
  // 原始读数（改前/改后：冷段的 `parentSession` 与 `/tree` 的 `parentId`）见本条改动的交付报告（`npm run test:seal` 的 G1/G1b 把它钉住了）。
  // ⚠️ `docs/history/design-session-seal.md` 的 §1.3 / §6② 写的是旧形状（冷段 → 热文件），那里已加修正注。
  //
  // 三条硬前提（都有原始输出，实验在 `docs/design-session-seal.md` §9）：
  //   ① **先 evict**（`pool.holdSession` 拿住串行段）→ temp + `rename` → 才允许重开：
  //      runtime 持有时替换 ⇒ 它下一次 append 的 `parentId` 指向已经不在文件里的叶 ⇒ 冷读两条/prompt 塌掉；
  //   ② 热文件**自己带上**叶路径上的思考档与名字（那些条目可能住在冷段里）；
  //   ③ 失败安全：备份 → 先冷段 → 再热文件；**绝不**出现「热文件已裁、冷段没写」。
  const sealsFile = path.join(agentDir, 'seals.jsonl');
  const sealBackupsRoot = path.join(agentDir, 'seal-backups');
  let sealWriteQueue = Promise.resolve();
  function queueSealWrite(operation) {
    const result = sealWriteQueue.then(operation, operation);
    sealWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // append-only、一行一条 JSON（与 handoffs.jsonl 同族）：改了/删了历史行就再也不知道当时发生了什么。
  async function appendSealRecord(record) {
    return queueSealWrite(async () => {
      await mkdir(path.dirname(sealsFile), { recursive: true });
      await appendFile(sealsFile, `${JSON.stringify(record)}\n`, 'utf8');
      return record;
    });
  }

  const sealLog = (message) => console.log(`[seal] ${message}`);

  /**
   * 与 `/move` **同一条门**：**同一个码**（`session_busy_move`，不新造词）、同一组事实
   *（`isWorking()` ＋「队列里还压着消息」）—— 回合没落定就冻文件 = 冻一份半成品（R9 / R11 的那道门）。
   * ⚠️ 措辞**不照抄** `/move` 那句：它说的是 `forkFrom` 不能抄一份半成品，而那**不是**封存被拒的原因
   *（封存不 fork）。这里把真实原因说出来，并把「这是哪条门」写进 message/details。
   */
  function sessionBusySeal(sessionId, facts) {
    return new HttpError(
      409,
      'session_busy_move',
      'seal refused: the session is streaming, compacting, retrying, or accepting a prompt, or it still has queued messages that only live in the runtime; wait until it settles before its file is rewritten in place — this is the same gate /move uses (409 session_busy_move)',
      { sessionId, sealed: false, reason: 'session_busy', sealGate: 'the same gate /move uses: isWorking() + pendingMessages; sealing needs a settled turn', ...facts },
    );
  }

  /**
   * 备份：**绝不被会话扫描看见**（任务书第 4 条）。两道各自独立的保证：
   *   · 位置：`<agentDir>/seal-backups/`（在 `sessionsRoot` **外面**；扫描只走 sessionsRoot）；
   *   · 命名：`*.jsonl.bak` 结尾 ⇒ 即使它真落在会话目录里，`entry.name.endsWith('.jsonl')` 也不成立。
   * 命中「落在 sessionsRoot 里」这种镜像（把 SESSION_DIR 指到备份目录下）时**如实报出来**，不静默。
   */
  async function writeSealBackup(sessionId, bytes, stamp) {
    const directory = path.join(sealBackupsRoot, sessionId);
    const file = path.join(directory, `${stamp}-${bytes.length}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.jsonl.bak`);
    await atomicWriteBytes(file, bytes);
    const relative = path.relative(sessionsRoot, file);
    return {
      file,
      bytes: bytes.length,
      insideSessionsRoot: relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
      note: 'backup of the pre-seal session file; it never ends with .jsonl (so the session scan cannot mistake it for a second session) and normally lives outside the sessions root',
    };
  }

  // ── 「已归档子会话跟着**冷段**走」的侧车（业主 2026-10-05 第(2)条）────────────────────────
  //
  // 业主原话：「旧的会话当中归档的会话应该跟着旧会话，而不是跟着新会话」。指称已澄清：这里的
  // 「旧会话」= **冷段**（压缩后被归档的那一段历史），「新会话」= 热会话。封存**只写热会话与冷段两个
  // 文件**（子会话文件逐字节不动 ⇒ 它们的头里 `parentSession` 仍指着热会话），所以本单**不重写 pi 的
  // 会话文件**，另记一本 append-only 的侧车 `$ASSIST_HOME/seal-parents.jsonl`（与同目录的 `seals.jsonl`
  // 同族）：
  //   { childId, parentId: <冷段 id>, fromParentId: <热会话 id>, at }
  // `/tree` 解 `parentId` 时**优先查它**；目标（冷段）不在这份树里时的**回落**是「会话头里的值」
  //（行不消失、不错挂 —— 侧车可以陈旧，会话头永远是那份文件里的事实）。
  // ★边界：只改挂**封存那一刻已经归档**的子会话；当场还活着的（未归档）留在热会话名下不动，
  //   封存**之后**才被归档的子会话也不在本单范围（那要另一条触发点，本单不做）。
  const sealParentsFile = path.join(agentDir, 'seal-parents.jsonl');
  let sealParentsCache = { signature: 'missing', value: new Map() };

  /**
   * 「这条会话报的父是谁」—— `/tree` 与 `GET /sessions/{id}` 共用的**唯一**一处判定（业主 2026-10-05 第(2)条）。
   *
   * 为什么必须有这一处：侧车 `seal-parents.jsonl` 把「封存那一刻**已经归档**」的子会话改挂到**冷段**名下，
   * `/tree` 早已按它解 `parentId`；而详情这一面原来只报会话头里的父路径 ⇒ **同一个孩子在两处说法不同**
   *（详情说热会话、树上说冷段）。判定收成这一份，两侧都调它；侧车也走同一个 `readSealParents`
   *（同一份缓存），不在别处再写一套读法 —— 两套口径迟早会漂。
   *
   * 规则（与既有 `/tree` 那条**一字不差**）：
   *   ① 先认**文件层**的父（`fileParentId`）：调用方按各自手里已有的事实解出来（`/tree` 用扫出来的
   *      `realpath → id` 表 `pathToId`，详情用父文件头里的 `id`）—— 会话头永远是那份文件里的事实；
   *   ② 侧车有这条孩子、且目标（冷段）**真的存在**（`targetExists`）⇒ 报侧车那条；
   *   ③ 目标不存在 ⇒ **回落**到文件层的值（行不消失、不错挂：侧车会陈旧、也可能被手改坏）；
   *   ④ 沙箱专用故障注入（生产不设 ⇒ 零影响）`SOPHO_FAULT_SEAL_PARENTS_NO_FALLBACK=1` ⇒ 跳过存在性检查
   *      （回落那条牙的红臂：两侧都会照单收下侧车里那个悬垂 id）；
   *   ⑤ `deferred:true` = 「现在答不了」（目标不在**还没建完**的索引里 —— 可能只是还没扫到）。只有
   *      `/tree` 会走到（它宁可不全也不给错）；详情问的是盘上事实，不 defer。
   *
   * ★**`parentId === null` 的语义**（两个面逐字同规则）：当且仅当「侧车没这条孩子 **或** 侧车那个目标不是
   *   一份真会话」**且**「文件层的父也解不出来（头里没有 `parentSession`、或那条路径悬垂/不是一份会话头）」。
   *   一个**悬垂 id**（指着一份不存在的会话）**只**在盲信侧车的注入下才会被报出来 —— 那正是红臂②要红掉的行为，
   *   平时绝不出现（null 与「悬垂」不是一回事）。
   * `ignoreSidecar` 是**另一支**沙箱注入（详情那条红臂的开关，见 `reportedParentIdOf`）：假装侧车不存在。
   */
  function resolveReportedParent({ childId, fileParentId, sealParents, targetExists, ignoreSidecar = false }) {
    if (ignoreSidecar) return { parentId: fileParentId, rehomed: false, deferred: false };
    const rehomed = sealParents.get(childId);
    if (!rehomed) return { parentId: fileParentId, rehomed: false, deferred: false };
    if (process.env.SOPHO_FAULT_SEAL_PARENTS_NO_FALLBACK === '1' || targetExists(rehomed.parentId)) {
      return { parentId: rehomed.parentId, rehomed: true, deferred: false };
    }
    return { parentId: fileParentId, rehomed: false, deferred: true };
  }

  /** 侧车（append-only JSONL）→ `childId → { parentId, fromParentId, at }`。坏行跳过：它是我们自己的
   *  派生物，读不出来的行**不冒充**一条改挂（回落那条路本来就兜着）。缓存按 (mtime,size,ctime) ——
   *  与 `legacyArchiveIds` 同一取舍（只比 size+mtime 会被「同长度同 mtime 的原地重写」骗过）。 */
  async function readSealParents() {
    let fileStat;
    try {
      fileStat = await stat(sealParentsFile);
    } catch {
      sealParentsCache = { signature: 'missing', value: new Map() };
      return sealParentsCache.value;
    }
    const signature = `${fileStat.mtimeMs}:${fileStat.size}:${fileStat.ctimeMs}`;
    if (sealParentsCache.signature === signature) return sealParentsCache.value;
    const value = new Map();
    let text = '';
    try {
      text = await readFile(sealParentsFile, 'utf8');
    } catch {
      text = '';
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const childId = typeof record?.childId === 'string' ? record.childId.toLowerCase() : null;
      const parentId = typeof record?.parentId === 'string' ? record.parentId.toLowerCase() : null;
      if (!childId || !parentId) continue;
      // append-only：同一个 child 可以因为（未来）多次封存被改挂 ⇒ 后写的那条说了算。
      value.set(childId, {
        parentId,
        fromParentId: typeof record.fromParentId === 'string' ? record.fromParentId.toLowerCase() : null,
        at: record.at ?? null,
      });
    }
    sealParentsCache = { signature, value };
    return value;
  }

  async function appendSealParentRecords(records) {
    return queueSealWrite(async () => {
      await mkdir(path.dirname(sealParentsFile), { recursive: true });
      await appendFile(sealParentsFile, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
      return records;
    });
  }

  /** 一份会话文件的归档现状：判据与会话文件里 `sopho.archive` 的**最后一条**同口径（`listTree` 用的是
   *  同一个 `projectTreeBuffer`，不是另造一套）。读不出来的文件按「没有归档标记」处理。 */
  async function archiveStateOfFile(file) {
    const projection = newTreeProjection();
    let buffer;
    try {
      buffer = await readFile(file);
    } catch {
      return { present: false, archived: false };
    }
    projectTreeBuffer(buffer, projection);
    return { present: projection.archivePresent, archived: projection.archiveArchived };
  }

  /**
   * 封存那一刻**挂在热会话名下、且已经归档**的子会话 id（升序）。
   *   · 父 = 会话头里的 `parentSession`，`realpath` 之后与热文件相等；
   *   · 归档 = 文件里最后一条 `sopho.archive`（`archiveStateOfFile`），文件里没有该标记时兼容老账
   *     `archive.json`（`legacyArchived`）—— 与 `listTree` / 守卫 `reclaim-worktree.mjs` 的
   *     `latestArchiveState` 同源，**不另造口径**。
   * **只做文件读**：封存那条独占段里再进池子队列（acquire/evict/sweep…）会自锁。
   */
  async function archivedChildrenOf(hotFile, hotId, legacyArchived) {
    const children = [];
    for (const file of await listJsonlFiles(sessionsRoot)) {
      let resolved;
      try { resolved = await realpath(file); } catch { continue; }
      if (resolved === hotFile) continue;
      let header;
      try { header = await readSessionHeader(file); } catch { continue; }
      const parentPath = header?.parentSession ?? null;
      if (!parentPath) continue;
      let parentFile = null;
      try { parentFile = await realpath(parentPath); } catch { parentFile = null; }
      if (parentFile !== hotFile) continue;
      if (typeof header.id !== 'string' || !FULL_UUID.test(header.id)) continue;
      const childId = header.id.toLowerCase();
      if (childId === hotId) continue;
      const state = await archiveStateOfFile(file);
      const archived = state.present ? state.archived : legacyArchived.has(childId);
      if (!archived) continue;
      children.push(childId);
    }
    children.sort((left, right) => left.localeCompare(right));
    return children;
  }

  /**
   * 封存一条会话。返回收据（`sealed:false` + `reason` = 没做，且**一个字节都没动**）。
   * 409 只留给两类事：回合没落定 / 有人拿着 runtime 收不掉（都是「现在不能做」）。
   */
  async function sealSession(requestedId, { trigger = 'manual', now = Date.now(), compactionEntryId = null, firstKeptEntryId = null } = {}) {
    // id 一律归一到小写再往下走：池子的记录、`sessionFileCache`、`treeIndex` 的键都是小写，
    // 拿一个大小写不同的 id 去问池子会**问不出持有者**（那就是 R11 的失败现场）⇒ 入口先归一。
    const sessionId = requireFullSessionId(requestedId);
    const found = await findPersistedSession(sessionId);
    if (!found) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);
    const hotPath = await realpath(found);
    const start = await stat(hotPath);
    // ① 落定门：先问 runtime 自己（`isWorking()` 与 `/move` 一模一样，再加一条它看得见的事实：
    //    队列里还压着消息 —— 那是**只在内存里**的内容，evict 会把它们一起丢掉）。
    const live = pool.getHandle(sessionId);
    if (live) {
      // 只要能判「现在能不能动」的**那几个布尔**（与 `/move` 的忙判同一组事实）：不要在这里调
      // `adapter.snapshot()` —— 它会把 context/observability 一起算出来（O(entries)，而且那条路会碰
      // pi 的 usage 汇总），而封存根本不需要那些数。
      const facts = await inspectAdapter(live, (adapter) => ({
        isWorking: adapter.isWorking() && !adapter.isAdmittingOwnCommand(),
        pendingMessages: adapter.session.pendingMessageCount ?? 0,
        isStreaming: adapter.session.isStreaming === true,
        isCompacting: adapter.session.isCompacting === true,
        isRetrying: adapter.session.isRetrying === true,
      }));
      if (facts.isWorking || facts.pendingMessages > 0) {
        sealLog(`${sessionId} 拒绕（${trigger}）：${JSON.stringify({ working: facts.isWorking, pendingMessages: facts.pendingMessages })}`);
        throw sessionBusySeal(sessionId, { runtime: facts, working: facts.isWorking });
      }
    }

    const operation = async () => {
      const before = await stat(hotPath);
      const raw = await readFile(hotPath);
      const lines = sealLines(raw.toString('utf8'));
      if (!lines || lines.length === 0) return { sealed: false, reason: 'invalid_session_lines', detail: { file: hotPath } };
      // 边界 = 显式点名的那条压缩条目 / 显式点名的边界 / 默认链上最后一条（见 `sealPlanOf`）。
      // 三种走的是同一个 `{C, K}` ⇒ 下游只有一条实现（不是「自动一套、补做一套」）。
      const plan = sealPlanOf(lines, { compactionEntryId, firstKeptEntryId });
      if (!plan.ok) return { sealed: false, reason: plan.reason, detail: plan.detail ?? null };
      // 业主第(2)条：封存那一刻挂在热会话名下、**已经归档**的子会话（改挂到冷段名下）。
      // 在**换文件之前**算好（列目录 + 读头 + 逐个子会话读一份文件），封存成功后写侧车。
      const legacyArchived = await legacyArchiveIds();
      const archivedChildren = await archivedChildrenOf(hotPath, sessionId, legacyArchived);
      const taken = new Set(plan.path.map((item) => item.entry?.id).filter((id) => typeof id === 'string'));
      const coldId = requireFullSessionId(randomUUID());
      const nowIso = new Date(now).toISOString();
      const sourceStamp = String(plan.header.entry.timestamp ?? '').replaceAll(':', '-').replaceAll('.', '-');
      const stamp = /^[0-9A-Za-z-]{4,64}$/.test(sourceStamp) ? sourceStamp : nowIso.replaceAll(':', '-').replaceAll('.', '-');
      const coldFile = path.join(path.dirname(hotPath), `${stamp}_${coldId}.jsonl`);

      // —— 热文件：同一个 id、同一条路径，物理顺序 `[头] + [摘要] + [kept] + [tail]`（与 pi 原文件同形）——
      // 父指针**保原链**（不重指）⇒ `/messages` 的压缩块落在 kept 之后，与压缩前的语义一致。
      const hotBody = [plan.compactionItem, ...plan.kept, ...plan.tail];

      // 叶路径上的「设置与名字」：这两条在真样本里正好都住在冷段 ⇒ 必须显式补到热尾巴上。
      // 补的条件是「原链上那条已经不在热文件里了」⇒ 已经带上的（在 tail 里）就不会重复补。
      //
      // ⚠️ 补的父指针必须接在**链上的叶**上，不是「我们哪个顺序排在最后」（`C > K` 时两者不是一回事：
      // pi 自己的压缩把摘要写在**最后一个条目**的位置上 ⇒ 链上的叶是那条摘要，而它在我们拼出的文件里
      // 排在最前面 —— 接错就把补的两条挂到一条半路条目上，链在那儿断掉、压缩块掉出路径）。
      const carried = [];
      let leaf = plan.path[plan.path.length - 1]?.entry?.id ?? null;
      const appendHot = (entry) => {
        const id = sealEntryId(taken);
        taken.add(id);
        const value = { ...entry, id, parentId: leaf };
        hotBody.push({ raw: JSON.stringify(value), entry: value });
        leaf = id;
        return value;
      };
      const retained = sealLeafSettings(hotBody);
      if (plan.settings.thinkingLevel !== null && retained.thinkingLevel !== plan.settings.thinkingLevel) {
        appendHot({ type: 'thinking_level_change', timestamp: nowIso, thinkingLevel: plan.settings.thinkingLevel });
        carried.push('thinking_level_change');
      }
      if (plan.settings.name && retained.name !== plan.settings.name) {
        appendHot({ type: 'session_info', timestamp: nowIso, name: plan.settings.name });
        carried.push('session_info');
      }
      // 归档：**照拄来源**（用户归档过的会话，封存不该偷偷把它取消归档）。
      if (plan.settings.archivedPresent && retained.archivedPresent !== true) {
        appendHot({ type: 'custom', customType: ARCHIVE_ENTRY, data: { archived: plan.settings.archived === true }, timestamp: nowIso });
        carried.push(ARCHIVE_ENTRY);
      }

      // —— 未答问题也随热尾巴搬家（与上面「叶路径上的设置」同一套按需补的口径）——
      // 不搬的话：一条**未答**问题若落在被裁段，就只剩冷段里有 ⇒ 热会话的问题清单里空空如也（用户看不到）。
      // **已答 / 已关**的不搬：它们在冷段里好端端地可读（那张清单本来也不显示它们）。
      // 照抄的是**该 id 的整条条目序列**（`data` 逐字节不改），只换 id / 父指针（接在链上的叶）/ 时间戳
      // （叶指针必须落在这份文件里；时间戳照其他补的条目一样取当下 —— 否则树的 `modifiedAt` 会倒着走）。
      const questionsCarried = [];
      for (const group of sealOpenQuestions(lines.slice(1), hotBody)) {
        const copied = [];
        for (const entry of group.entries) {
          copied.push(appendHot({ ...entry, timestamp: nowIso }).id);
        }
        questionsCarried.push({ id: group.id, status: group.status, askedAt: group.at, entries: copied.length, entryIds: copied });
      }

      // 头**逐字照抄**（`version: 3` 也照抄：缺了会被 pi 当成 v1 迁移 —— 重建所有条目的 id 并重写整份文件）。
      const hotOut = [plan.header, ...hotBody];

      // —— 冷段：**新 id**、归档；`parentSession` = **热会话的父级**（与热会话**同级**，不是它的子）——
      // 尾巴带一条 `session_info`（否则冷段丢名字）与 `sopho.archive{archived:true}`。
      // 不带摘要那一变体（§1.2 实测两者都正常；不带 = 没有悬垂的 `firstKeptEntryId`，最简）。
      //
      // 父级**照抄热会话头里那个值**（不做 `path.resolve`、不 `realpath`、不判存在）：那个父可能已经不在
      // 磁盘上了（老会话），把它重写成别的路径就是把父子关系**悄悄改指**到另一条会话 —— 这里只继承，不解释。
      // 热会话自己是根（头里没有 `parentSession`）⇒ 冷段也**不带**这个字段（两边都是根 = 兄弟）。
      const sourceParent = plan.header.entry.parentSession ?? null;
      const coldHeader = { ...plan.header.entry, id: coldId, timestamp: plan.header.entry.timestamp };
      if (sourceParent) coldHeader.parentSession = sourceParent;
      else delete coldHeader.parentSession;
      const coldBody = [{ raw: JSON.stringify(coldHeader), entry: coldHeader }, ...plan.cold];
      const appendCold = (entry) => {
        const id = sealEntryId(taken);
        taken.add(id);
        const value = { ...entry, id, parentId: coldBody[coldBody.length - 1]?.entry?.id ?? null };
        coldBody.push({ raw: JSON.stringify(value), entry: value });
        return value;
      };
      if (plan.settings.name) appendCold({ type: 'session_info', timestamp: nowIso, name: plan.settings.name });
      appendCold({ type: 'custom', customType: ARCHIVE_ENTRY, data: { archived: true }, timestamp: nowIso });

      const hotBytes = sealBytes(hotOut);
      const coldBytes = sealBytes(coldBody);

      // —— 失败安全：备份 → 先冷段 → 再热文件 ——（顺序不能反：先裁热再写冷，中途失败 = 数据没了）
      const backup = await writeSealBackup(sessionId, raw, stamp);
      const coldTemp = await writeAtomicTemp(coldFile, coldBytes);
      let hotTemp = null;
      try {
        await commitAtomicTemp(coldTemp, coldFile);
        hotTemp = await writeAtomicTemp(hotPath, hotBytes);
        // 并发写者核验：从我们读到它到现在，那份字节必须**一字未变**（另一个代/另一个 pi 在这中间
        // append 过 ⇒ 我们这份替换会把它的条目盖掉）。核不过就什么都不换，如实回可重试的 409。
        const current = await readFile(hotPath);
        if (!current.equals(raw)) {
          try { await unlink(coldFile); } catch {}
          try { await unlink(hotTemp); } catch {}
          return { sealed: false, reason: 'session_changed_during_seal', detail: { bytesRead: raw.length, bytesNow: current.length } };
        }
        // 核验与 rename 之间只留一条**零等待**（生产不设故障注入时就是一次函数调用）：这一段撑开多久，
        // 就是「另一个写者能挤进来的窗口」有多宽 —— 门里靠它把并发臂变成确定性的。
        await sealCommitHoldBeforeRename(sessionId);
        await commitAtomicTemp(hotTemp, hotPath);
      } catch (error) {
        try { await unlink(coldFile); } catch {}
        try { await unlink(hotTemp); } catch {}
        throw error;
      }

      // 侧车：`titles.json` 一起写（冷 id 写它自己的名字，否则它的名字会被下一次对账当成「别人设的」）。
      // 热 id 那条**不动**（名字与来源都没变）。侧车写失败「不能让已经发生的封存被回报成失败」
      // （同一个「副作用已成、回执说失败」的病）⇒ 如实降级成 warning。
      const warnings = [];
      const sourceRecord = (await readTitlesSafe()).value?.[sessionId] ?? null;
      if (plan.settings.name) {
        const title = plan.settings.name;
        const source = sourceRecord?.source ?? 'manual';
        try {
          await writeTitleRecord(coldId, { title, source, at: now });
        } catch (error) {
          warnings.push({ code: 'title_ledger_write_failed', file: titlesFile, message: normalizeError(error).message });
        }
      }
      // 业主第(2)条：把**封存那一刻已经归档**的子会话改挂到冷段名下 —— 写侧车（**不改 pi 的会话文件**）。
      // 侧车写不进去 = 改挂**没发生**（/tree 只认它）⇒ 如实降级成 warning，`childrenRehomed` 报空数组。
      const childrenRehomed = [];
      if (archivedChildren.length > 0) {
        const records = archivedChildren.map((childId) => ({ childId, parentId: coldId, fromParentId: sessionId, at: nowIso }));
        try {
          await appendSealParentRecords(records);
          for (const record of records) childrenRehomed.push({ childId: record.childId, fromParentId: record.fromParentId, parentId: record.parentId });
        } catch (error) {
          warnings.push({ code: 'seal_parents_write_failed', file: sealParentsFile, message: normalizeError(error).message });
        }
      }
      const receipt = {
        sealed: true,
        at: nowIso,
        trigger,
        sessionId,
        hot: { id: sessionId, file: hotPath, bytesBefore: raw.length, bytesAfter: hotBytes.length },
        // `parentSession` 如实回报：这是「冷段与热会话是不是兄弟」的那一个字段（null = 两边都是根）。
        cold: { id: coldId, file: coldFile, bytes: coldBytes.length, entries: coldBody.length, parentSession: sourceParent },
        compaction: { entryId: plan.compaction.id ?? null, firstKeptEntryId: plan.compaction.firstKeptEntryId ?? null, C: plan.C, K: plan.K },
        boundary: { source: plan.boundarySource, requested: plan.boundaryRequest, compactionEntryId: plan.compaction.id ?? null, firstKeptEntryId: plan.compaction.firstKeptEntryId ?? null },
        counts: { cold: plan.cold.length, kept: plan.kept.length, tail: plan.tail.length, hotEntries: hotOut.length },
        settingsCarried: carried,
        questionsCarried,
        // 业主第(2)条：改挂到冷段名下的**已归档**子会话（`[{childId, fromParentId, parentId}]`）。
        childrenRehomed,
        backup,
        warnings,
      };
      // 账写不进去**不许**把已经发生的封存回报成失败（同一个「副作用已成、回执说失败」的病）：
      // 如实降级成一条 warning（真源仍是那两个文件 + 备份）。
      try {
        await appendSealRecord({ ok: true, trigger, sessionId, coldId, coldParentSession: sourceParent, childrenRehomed, reason: null, hotBytesBefore: raw.length, hotBytesAfter: hotBytes.length, coldBytes: coldBytes.length, backup: backup.file, compactionEntryId: plan.compaction.id ?? null, firstKeptEntryId: plan.compaction.firstKeptEntryId ?? null, boundarySource: plan.boundarySource, boundaryRequest: plan.boundaryRequest, settingsCarried: carried, questionsCarried, warnings, at: nowIso });
      } catch (error) {
        const warning = { code: 'seal_ledger_write_failed', file: sealsFile, message: normalizeError(error).message };
        warnings.push(warning);
        receipt.warnings = warnings;
        sealLog(`${sessionId} 封存已成，但账（${sealsFile}）没写上：${normalizeError(error).message}`);
      }
      return receipt;
    };

    const held = await pool.holdSession(sessionId, operation);
    if (!held.ok) {
      sealLog(`${sessionId} 拒绕（${trigger}）：有人拿着 runtime 收不掉 ${JSON.stringify(held.blockers)}`);
      throw sessionBusySeal(sessionId, { runtimeBlockers: held.blockers, runtime: held.facts, evicted: false });
    }
    const evicted = held.evicted;
    const value = held.value;
    const receipt = { ...value, evicted, fileBytesAtStart: start.size };
    if (receipt.sealed !== true) {
      try {
        await appendSealRecord({ ok: false, trigger, sessionId, reason: receipt.reason, detail: receipt.detail ?? null, boundaryRequest: { compactionEntryId, firstKeptEntryId }, at: new Date(now).toISOString() });
      } catch (error) {
        // 「什么都没做」这条路更不能因为账本写不进去而回 500（回执里已经有 reason 了）。
        sealLog(`${sessionId} 未做（${receipt.reason}），账也没写上：${normalizeError(error).message}`);
      }
      return receipt;
    }
    emitTree(sessionId, 'sealed');
    emitTree(receipt.cold.id, 'seal_created');
    sealLog(`${sessionId} → 热 ${receipt.hot.bytesBefore} B→${receipt.hot.bytesAfter} B；冷 ${receipt.cold.id} ${receipt.cold.bytes} B（cold ${receipt.counts.cold} / kept ${receipt.counts.kept} / tail ${receipt.counts.tail}；边界 ${receipt.boundary.source}:${receipt.boundary.compactionEntryId}→${receipt.boundary.firstKeptEntryId}；补 ${JSON.stringify(receipt.settingsCarried)}＋问题 ${JSON.stringify(receipt.questionsCarried.map((group) => group.id))}；trigger=${trigger}；evicted=${evicted}）`);
    return receipt;
  }

  /**
   * 自动触发（业主批的默认 ①）：**压缩回合落定之后**的第一个空闲时刻派生**一次**。
   *
   * 为什么不在压缩那一刻切：pi 的压缩发生在**回合内部**（读码已验）⇒ 回合中间绝不切。
   * 为什么用 `setTimeout(0)`：这段回调从 pi 的 settle 钩子里上来，`handle.dispose()` 等的是那条
   * 每会话操作队列 —— 同步地叫它会自己等自己（死锁）。排到下一轮宏任务 ⇒ 那一轮已经结算。
   * 为什么还要重试几回：`compaction_end` 到 `isCompacting` 落回 false 之间有一小段窗口（显式
   * `POST /compact` 那条路），那一瞬间发出去只会拿到 `409 session_busy_move`。重试就是「等第一个
   * 真空闲的时刻」，而不是把这次压缩白白丢掉（上界 `SEAL_AUTO_ATTEMPTS`，不无限重试）。
   * 失败**不重试**、也不静默：如实记一条（与 `/move` 的 `placementPersisted:false` 同一口径）。
   */
  // 「这条会话待封存」= **只在内存里**的一张小表（`sessionId → { attempts, timer }`，本 worker 代内有效），
  // 它只做两件事：① 同一次落定不重复派生（`has` 就返回）；② 忙的时候隔 250 ms 再试（上界 8 次）。
  //
  // **幂等不靠它** ✗：重复冷段的拦法是**文件自己**给的 —— 切点规则要求冷段里至少有一条不是 `compaction`
  // 的条目（见 `sealPlanOf`），封过一次之后再封只能得到「冷段 = 摘要自己」⇒ `nothing_to_seal`。
  // 所以换代际 / 重启把这张表清了，最坏只是「这一次的意图丢了」（那条会话留在原地，等它下一次压缩或
  // 一次显式 `POST /seal`），**不会**多出一份冷段。跨进程的持久待办队列是**迁移运行**才需要的东西，
  // 本件不做（`docs/design-session-seal.md` §6⑥ / 任务书的边界）。
  const sealPending = new Map(); // sessionId → { attempts, timer }
  function scheduleSealAfterCompaction(sessionId) {
    const id = sessionId.toLowerCase();
    if (sealPending.has(id)) return; // 同一次落定不派生第二次
    const state = { attempts: 0, timer: null };
    sealPending.set(id, state);
    const attempt = async () => {
      state.timer = null;
      state.attempts += 1;
      try {
        let enabled = true; // 侧车读不出来 ⇒ 退回默认值（开），并如实记一条
        try {
          enabled = (await uiSettings.read()).settings['seal.autoOnCompaction'] === true;
        } catch (error) {
          sealLog(`${id} 读 ui-settings 失败（${normalizeError(error).message}）⇒ 按默认值（开）继续`);
        }
        if (!enabled) {
          sealPending.delete(id);
          sealLog(`${id} 压缩落定，但设置里关着自动封存（seal.autoOnCompaction=false）⇒ 不做`);
          return;
        }
        const receipt = await sealSession(id, { trigger: 'auto' });
        sealPending.delete(id);
        if (receipt.sealed !== true) {
          sealLog(`${id} 自动封存未做：${receipt.reason}${receipt.detail ? ` ${JSON.stringify(receipt.detail)}` : ''}`);
        }
      } catch (error) {
        const busy = error?.code === 'session_busy_move';
        if (busy && state.attempts < SEAL_AUTO_ATTEMPTS) {
          state.timer = setTimeout(() => { void attempt(); }, SEAL_AUTO_RETRY_MS);
          state.timer.unref?.();
          return;
        }
        sealPending.delete(id);
        sealLog(`${id} 自动封存失败（试了 ${state.attempts} 次）：${normalizeError(error).message}`);
      }
    };
    state.timer = setTimeout(() => { void attempt(); }, 0);
    state.timer.unref?.();
  }

  // Append-only JSONL reader. A malformed line is skipped and counted; it must never
  // make the whole ledger unreadable (one bad byte would otherwise hide every handoff).
  async function readHandoffs() {
    let text;
    try {
      text = await readFile(handoffsFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, handoffs: [], skipped: 0, bad: [] };
      throw new HttpError(500, 'handoffs_read_failed', `cannot read ${handoffsFile}: ${normalizeError(error).message}`);
    }
    const handoffs = [];
    const bad = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === '') continue;
      try {
        const value = JSON.parse(line);
        if (!plainObject(value)) throw new Error('handoff line is not a JSON object');
        handoffs.push(value);
      } catch (error) {
        bad.push({ line: index + 1, detail: normalizeError(error).message });
      }
    }
    return { exists: true, handoffs, skipped: bad.length, bad };
  }

  async function appendHandoff(record) {
    return queueHandoffWrite(async () => {
      await mkdir(path.dirname(handoffsFile), { recursive: true });
      await appendFile(handoffsFile, `${JSON.stringify(record)}\n`, 'utf8');
      return record;
    });
  }

  // ── 卡片级反馈（annotations）的「到达即知道」（配置 ＋ 事件 ＋ 唤醒消息）───────────────
  // 见文件头的纯函数段与 `docs/design-annotations.md` §8。这一段只做三件事：读配置、攒批、
  // 到点把这一批交给维护者会话（`adapter.deliverAnnotationNotify`）——**读/写到账本的那两条路一字未改**。

  /** 生效的维护者会话（服务端权威）：`ok` = 有；`off` = 键是空串（**不通知**，退回现状）；
   *  `unavailable` = 读不到设置（拿不准就不通知，但**不许静默**）。 */
  async function maintainerSessionConfig() {
    let view;
    try {
      view = await uiSettings.read();
    } catch (error) {
      return { status: 'unavailable', id: null, detail: normalizeError(error).message };
    }
    const value = view?.settings?.['annotations.notifySession'];
    if (typeof value !== 'string' || value.trim() === '') return { status: 'off', id: null, detail: null };
    return { status: 'ok', id: value.trim().toLowerCase(), detail: null };
  }

  function annotationNotifySkip(status, detail, record = null) {
    annotationNotify.skipped.push({ at: new Date().toISOString(), status, detail, ids: record ? [record.id] : [] });
    if (annotationNotify.skipped.length > 20) annotationNotify.skipped.splice(0, annotationNotify.skipped.length - 20);
  }

  /** `POST /annotations` 建完一条之后把它排进待发批次（**不改那一条的回执语义**，只多一个 `notify` 回执）。
   *  窗口内到达的多条共用一次唤醒（正文说「共 N 条」）；**同一批只发一次**（已发过的 id 不再进账）。 */
  async function queueAnnotationNotify(record) {
    const config = await maintainerSessionConfig();
    if (config.status === 'unavailable') {
      console.warn(`${ANNOTATION_NOTIFY_LOG}读不到 ui 设置，这一条（${record.id}）不通知：${config.detail}`);
      annotationNotifySkip('settings_unavailable', config.detail, record);
      return { status: 'settings_unavailable', maintainerSessionId: null, pending: annotationNotify.pending.length, windowMs: annotationNotifyWindowBudgetMs, detail: config.detail };
    }
    if (config.status === 'off') {
      // 留空 = 不通知（退回 v1.5 现状）。这是**预期行为**，不当错误记 —— 但回执要说清是「关着的」。
      return { status: 'disabled', maintainerSessionId: null, pending: 0, windowMs: annotationNotifyWindowBudgetMs, detail: null };
    }
    if (config.id === record.sessionId) {
      return { status: 'self', maintainerSessionId: config.id, pending: annotationNotify.pending.length, windowMs: annotationNotifyWindowBudgetMs, detail: '这条标注就来自维护者会话自己 ⇒ 不通知自己' };
    }
    if (annotationNotify.notifiedIds.has(record.id)) {
      return { status: 'already_notified', maintainerSessionId: config.id, pending: annotationNotify.pending.length, windowMs: annotationNotifyWindowBudgetMs, detail: null };
    }
    annotationNotify.pending.push({ record, maintainerSessionId: config.id });
    while (annotationNotify.pending.length > ANNOTATION_NOTIFY_MAX_PENDING) {
      const dropped = annotationNotify.pending.shift();
      annotationNotify.dropped += 1;
      console.warn(`${ANNOTATION_NOTIFY_LOG}待发批次已满（${ANNOTATION_NOTIFY_MAX_PENDING} 条）⇒ 最早的 ${dropped.record.id} 不进这条通知消息（账本里还在，维护者可 GET /annotations?state=open 补看）`);
    }
    if (annotationNotify.timer === null) {
      annotationNotify.windows += 1;
      annotationNotify.timer = setTimeout(() => {
        annotationNotify.timer = null;
        void flushAnnotationNotify('window').catch((error) => console.warn(`${ANNOTATION_NOTIFY_LOG}发通知时出错（已如实记下）：${normalizeError(error).message}`));
      }, annotationNotifyWindowBudgetMs);
      // 没人在等的时候不把 worker 多留 30s（宿主换代/关机不该被一个待发窗口拖住）。
      annotationNotify.timer.unref?.();
    }
    return { status: 'queued', maintainerSessionId: config.id, pending: annotationNotify.pending.length, windowMs: annotationNotifyWindowBudgetMs, detail: null };
  }

  /** 窗口到点：把攒下的这一批**合成一条**消息投给维护者会话（＋ 一条 `session.annotation` 事件）。
   *  发不出去（会话不存在/已归档/没有 cwd…）⇒ **如实记日志 + 回执**，**不重试**（账本才是真源）。 */
  async function flushAnnotationNotify(trigger) {
    const batch = annotationNotify.pending.splice(0, annotationNotify.pending.length);
    if (batch.length === 0) return null;
    // 幂等：这一批的 id 当场记下 —— 就算后面发不出去，也不会因为「再来一次」而重复叫一遍。
    for (const item of batch) {
      annotationNotify.notifiedIds.add(item.record.id);
      if (annotationNotify.notifiedIds.size > 2000) {
        const oldest = annotationNotify.notifiedIds.values().next().value;
        annotationNotify.notifiedIds.delete(oldest);
      }
    }
    const at = new Date().toISOString();
    const result = {
      at, trigger, count: batch.length, ids: batch.map((item) => item.record.id),
      maintainerSessionId: batch[0].maintainerSessionId, status: null, mode: null, queued: null, detail: null,
    };
    const config = await maintainerSessionConfig();
    result.maintainerSessionId = config.id;
    if (config.status !== 'ok') {
      result.status = config.status === 'off' ? 'disabled_at_flush' : 'settings_unavailable';
      result.detail = config.detail;
      console.warn(`${ANNOTATION_NOTIFY_LOG}这一批 ${batch.length} 条要发的时候，维护者会话${config.status === 'off' ? '被留空了（不通知）' : `读不到：${config.detail}`}`);
      annotationNotify.last = result;
      return result;
    }
    // 维护者会话**自己**标的那些不叫它（它自己刚点过，没必要再告诉它一遍）。
    const items = batch.filter((item) => item.record.sessionId !== config.id).map((item) => item.record);
    if (items.length === 0) {
      result.status = 'self';
      result.detail = '这一批的标注都来自维护者会话自己';
      annotationNotify.last = result;
      return result;
    }
    const text = annotationNotifyText(items, { maintainerSessionId: config.id });
    try {
      const delivery = await withSession(config.id, (handle) => inspectAdapter(handle, async (adapter) => {
        const legacyArchived = (await legacyArchiveIds()).has(config.id);
        return adapter.deliverAnnotationNotify({ items, maintainerSessionId: config.id, text, legacyArchived });
      }));
      result.status = delivery.delivered === false ? delivery.reason : 'delivered';
      result.mode = delivery.mode ?? null;
      result.queued = delivery.queued ?? null;
      // 具体理由**照回执里那个 reason 说**（不把「已归档」硬写成唯一原因 —— 将来多一种"不投递"的理由时，
      // 这句话不能变成一句不真的话）。
      result.detail = delivery.delivered === false
        ? (delivery.reason === 'session_archived'
          ? `维护者会话 ${config.id} 已归档 ⇒ 不叫它（退回：维护者自己读文件/端点）`
          : `没投递（reason=${delivery.reason}）`)
        : null;
      if (delivery.delivered === false) console.warn(`${ANNOTATION_NOTIFY_LOG}${result.detail}`);
    } catch (error) {
      const failure = normalizeError(error);
      result.status = 'failed';
      result.detail = failure.message;
      console.warn(`${ANNOTATION_NOTIFY_LOG}这一批 ${items.length} 条（${items.map((item) => item.id).join(', ')}）没能叫起维护者会话 ${config.id}：${failure.message} —— 不重试；账本里那几条仍在，维护者可以 \`GET /annotations?state=open\` 补看。`);
    }
    annotationNotify.last = result;
    return result;
  }

  /** `GET /annotations` 里的只读诊断块（门用它与「没验到什么」的现场）：配置/待发/上一批如实报。 */
  async function annotationNotifyReport() {
    const config = await maintainerSessionConfig();
    return {
      setting: 'annotations.notifySession',
      configured: config.id,
      configStatus: config.status,
      configDetail: config.detail,
      windowMs: annotationNotifyWindowBudgetMs,
      pending: annotationNotify.pending.length,
      windows: annotationNotify.windows,
      dropped: annotationNotify.dropped,
      notified: annotationNotify.notifiedIds.size,
      last: annotationNotify.last,
      skipped: annotationNotify.skipped.slice(-10),
    };
  }

  // ── 卡片级反馈（annotations）的读写 ───────────────────────────────────────
  // append-only、一行一条 JSON：写只有 appendFile（从不重写），读坏行跳过并计数。
  let annotationWriteQueue = Promise.resolve();
  function queueAnnotationWrite(operation) {
    const result = annotationWriteQueue.then(operation, operation);
    annotationWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readAnnotations() {
    let text;
    try {
      text = await readFile(annotationsFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, items: [], bad: [] };
      throw new HttpError(500, 'annotations_read_failed', `cannot read ${annotationsFile}: ${normalizeError(error).message}`);
    }
    const items = [];
    const bad = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === '') continue;
      try {
        const value = JSON.parse(line);
        if (!plainObject(value)) throw new Error('annotation line is not a JSON object');
        items.push(value);
      } catch (error) {
        bad.push({ line: index + 1, detail: normalizeError(error).message });
      }
    }
    return { exists: true, items, bad };
  }

  async function createAnnotation(body) {
    const record = buildAnnotation(body, { logicVersion });
    await queueAnnotationWrite(async () => {
      await mkdir(path.dirname(annotationsFile), { recursive: true });
      await appendFile(annotationsFile, `${JSON.stringify(record)}\n`, 'utf8');
    });
    // 读完算总数：到上限只警告不删（append-only 底线不破）。
    const { items } = await readAnnotations();
    const folded = annotationStates(items);
    const warning = annotationCapWarning(folded.states.size, items.length);
    if (warning) console.warn(`[annotations] ${warning}`);
    // 「到达即知道」（业主 2026-09-22 拍的 ②）：排进待发批次（窗口到点才叫维护者，见本文件那段）。
    // ⚠️ 这一步**不改这一条的回执语义**（还是同一个 201、同一条落盘行），只多一个 `notify` 回执。
    const notify = await queueAnnotationNotify(record);
    return { ok: true, annotation: record, total: folded.states.size, lines: items.length, warning, notify };
  }

  /** `op:'resolve'`：open ⇒ done，**只追加一行事件**（旧行一个字不改）。
   *  幂等口径（写进报告与文档）：已 done **不再追加事件行**，同样 200、`changed:false` +
   *  `alreadyDone:true`，并带上第一次的 `resolvedAt`/`resolvedBy`（**不假装**这是一次新操作）。
   *  读→定→写整段都在**同一个写队列**里（与创建共用 `queueAnnotationWrite`，照 handoffs.jsonl 那套）
   *  ⇒ 同一 worker 内不会与别人交错；跨代际并发只靠进程级 append（见「没验到什么」）。 */
  async function resolveAnnotation(body) {
    const { id, by, note } = buildAnnotationResolve(body);
    return queueAnnotationWrite(async () => {
      const { exists, items } = await readAnnotations();
      const folded = annotationStates(items);
      const state = folded.states.get(id);
      if (!state) {
        throw new HttpError(404, 'annotation_not_found', `no annotation with id ${id} in ${exists ? annotationsFile : `${annotationsFile} (file does not exist yet)`}`, { id });
      }
      if (state.state === 'done') {
        return {
          ok: true,
          id,
          state: 'done',
          changed: false,
          appended: false,
          alreadyDone: true,
          resolvedAt: state.resolvedAt,
          resolvedBy: state.resolvedBy,
          resolveCount: state.resolveCount,
          total: folded.states.size,
          lines: items.length,
          warning: annotationCapWarning(folded.states.size, items.length),
          event: null,
          note: `这条标注已经是 done（resolvedBy=${state.resolvedBy ?? '未记名'}，resolvedAt=${state.resolvedAt ?? '未记时间'}）：按幂等口径**没有**追加事件行。`,
        };
      }
      const event = {
        op: 'resolve',
        id,
        at: new Date().toISOString(),
        by,
        ...(note === null ? {} : { note }),
        appVersion: ANNOTATION_APP_VERSION,
        codeVersion: logicVersion ?? null,
      };
      await mkdir(path.dirname(annotationsFile), { recursive: true });
      await appendFile(annotationsFile, `${JSON.stringify(event)}\n`, 'utf8');
      const lines = items.length + 1;
      const warning = annotationCapWarning(folded.states.size, lines);
      if (warning) console.warn(`[annotations] ${warning}`);
      return {
        ok: true,
        id,
        state: 'done',
        changed: true,
        appended: true,
        alreadyDone: false,
        resolvedAt: event.at,
        resolvedBy: by,
        resolveCount: state.resolveCount + 1,
        total: folded.states.size,
        lines,
        warning,
        event,
        note: null,
      };
    });
  }

  async function listAnnotations({ since = null, sessionId = null, state = 'all' } = {}) {
    const { exists, items, bad } = await readAnnotations();
    const folded = annotationStates(items);
    const all = folded.order.map((id) => folded.states.get(id));
    const sinceFiltered = since === null ? all : all.filter((item) => {
      const at = typeof item.at === 'string' ? Date.parse(item.at) : NaN;
      return Number.isFinite(at) && at > since;
    });
    const sessionFiltered = sessionId === null ? sinceFiltered : sinceFiltered.filter((item) => item.sessionId === sessionId);
    const filtered = state === 'all' ? sessionFiltered : sessionFiltered.filter((item) => item.state === state);
    return {
      exists,
      items: filtered.map(annotationWire),
      total: all.length,
      filteredCount: filtered.length,
      counts: {
        open: all.filter((item) => item.state === 'open').length,
        done: all.filter((item) => item.state === 'done').length,
      },
      since: since === null ? null : new Date(since).toISOString(),
      session: sessionId,
      state,
      lines: items.length,
      resolveEvents: folded.resolveEvents,
      // 折不动 / 对不上 id 的行**如实报**，不静默丢：
      skipped: bad.length,
      bad,
      unknownOps: folded.unknown,
      orphanResolves: folded.orphans,
      duplicateIds: folded.duplicates,
      warning: annotationCapWarning(all.length, items.length),
      // 只读诊断：「到达即知道」那条线的现状（配的是谁 / 待发几条 / 上一批到底成没成）。
      notify: await annotationNotifyReport(),
    };
  }

  // ── 「对话内的推荐回复」的读写与后台生成 ────────────────────────────────
  // 三层：① 读（下面 `loadSuggestions`，按文件身份缓存，只折出每个会话最新的那一条）；
  //       ② 写（`appendSuggestion`，append-only + 写队列，与 handoffs/annotations 同规矩）；
  //       ③ 后台生成（`scheduleSuggestions`：设置开关 → 一次 `ModelRuntime.complete()` →
  //          严格校验 → 落盘 → 发一帧 `session.suggestions`）。
  // ⚠️ 模型调用走的就是**交接那份 LLM 摘要用的同一个 `complete()`**（`pi-extensions/assistant`
  //    里 `ctx.modelRegistry.complete` → `ModelRuntime.complete`）—— 不另写一套 provider 客户端。
  let suggestionCache = { identity: null, bySession: new Map() };
  let suggestionWriteQueue = Promise.resolve();
  function queueSuggestionWrite(operation) {
    const result = suggestionWriteQueue.then(operation, operation);
    suggestionWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 读侧：文件身份变了才重读（与 `/messages` 的响应体缓存同一条思路：身份 = size+mtime+ctime）。
   *  ENOENT 是**正常状态**（还没人落过一行）：空账、不是错；文件坏了才如实 500。 */
  async function loadSuggestions() {
    let info;
    try {
      info = await stat(suggestionsFile);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (suggestionCache.identity !== 'absent') suggestionCache = { identity: 'absent', bySession: new Map() };
        return suggestionCache;
      }
      throw new HttpError(500, 'suggestions_read_failed', `cannot stat ${suggestionsFile}: ${normalizeError(error).message}`);
    }
    const identity = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (identity === suggestionCache.identity) return suggestionCache;
    let text;
    try {
      text = await readFile(suggestionsFile, 'utf8');
    } catch (error) {
      throw new HttpError(500, 'suggestions_read_failed', `cannot read ${suggestionsFile}: ${normalizeError(error).message}`);
    }
    const parsed = [];
    const badLines = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === '') continue;
      try { parsed.push(JSON.parse(line)); } catch (error) { badLines.push(index + 1); }
    }
    const folded = foldSuggestionRecords(parsed);
    if (badLines.length > 0 || folded.bad > 0) {
      suggestionLog(`${suggestionsFile}: ${badLines.length} 行不可解析、${folded.bad} 条形状不对（已跳过，不影响其余）`);
    }
    suggestionCache = { identity, bySession: folded.bySession };
    return suggestionCache;
  }

  /** 一个会话**当前**的候选（没有 ⇒ null）。`/messages` 就靠它把可选字段挂回那条消息。 */
  function suggestionFor(sessionId) {
    return suggestionCache.bySession.get(String(sessionId).toLowerCase()) ?? null;
  }

  async function appendSuggestion(record) {
    return queueSuggestionWrite(async () => {
      await mkdir(path.dirname(suggestionsFile), { recursive: true });
      await appendFile(suggestionsFile, `${JSON.stringify(record)}\n`, 'utf8');
      // 内存里当场生效（读侧不必等下一次 stat）；身份作废 ⇒ 下一次 `loadSuggestions` 会重读一遍
      // （小文件，且这样一来“另一个 worker 写的行”与“自己写的行”走的是同一条对账路）。
      suggestionCache = {
        identity: null,
        bySession: new Map(suggestionCache.bySession).set(record.sessionId.toLowerCase(), record),
      };
      return record;
    });
  }

  // 「这一轮」的序号与在飞的 AbortController（每会话一份，本 worker 代内有效）。
  // 序号就是**陈旧判据**：新一轮满定 ⇒ 上一轮的结果即使回来了也不许上屏（业主拍的「不许出现
  // 上一轮的建议」），旧请求也当场 abort（省一次白烧的推理）。
  const suggestionTurns = new Map();

  /**
   * 一个回合落定 ⇒ 起一个**后台 job**（调用方 `void` 它，绝不 await 在主回合里）。
   * 任何一步失败/超时/输出不合格都在这里**安静放弃**：不落盘、不发事件、不造假，只记一行日志。
   */
  function scheduleSuggestions(request) {
    const id = String(request.sessionId).toLowerCase();
    const state = suggestionTurns.get(id) ?? { seq: 0, controller: null };
    suggestionTurns.set(id, state);
    state.seq += 1;
    const seq = state.seq;
    try { state.controller?.abort(); } catch { /* 已经结束的 controller：忽略 */ }
    const controller = new AbortController();
    state.controller = controller;
    // 返回这个 job 的 promise（**调用方不 await 它** —— 这就是「不阻塞主回合」的实现方式）。
    return (async () => {
      const startedAt = Date.now();
      try {
        // ① 总开关：关着 ⇒ **一次模型调用都不发**（门里断言的就是这条）。
        // 读不到侧车 ⇒ 退回默认值（开）并如实记一条（与 `seal.autoOnCompaction` 同一口径）。
        let enabled = true;
        try {
          enabled = (await uiSettings.read()).settings['suggestions.enabled'] === true;
        } catch (error) {
          suggestionLog(`${id} 读 ui-settings 失败（${normalizeError(error).message}）⇒ 按默认值（开）继续`);
        }
        if (!enabled) {
          suggestionLog(`${id} 设置里关着（suggestions.enabled=false，第 ${seq} 轮）⇒ 一次模型调用都不发`);
          return;
        }
        const model = request.model;
        const runtime = request.runtime;
        const transcript = Array.isArray(request.transcript) ? request.transcript : [];
        if (!model || !runtime || typeof runtime.complete !== 'function') {
          suggestionLog(`${id} 没有可用的模型/运行时 ⇒ 安静放弃（第 ${seq} 轮）`);
          return;
        }
        if (transcript.length === 0) {
          suggestionLog(`${id} 没有可喂的对话（最近几条都是空的）⇒ 安静放弃（第 ${seq} 轮）`);
          return;
        }
        const timeoutMs = suggestionTimeoutMs();
        const signal = timeoutMs > 0
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
          : controller.signal;
        const transcriptText = transcript.map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`).join('\n\n');
        const response = await runtime.complete(
          model,
          {
            systemPrompt: SUGGESTION_SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: [{ type: 'text', text: `以下是一段对话的结尾，请给出用户接下来最可能打的 1–3 条短句：\n\n${transcriptText}` }],
              timestamp: Date.now(),
            }],
          },
          { signal, cacheRetention: 'none' },
        );
        if (response?.stopReason === 'aborted') {
          // 「中止」有两个来源，日志里要分得开：新一轮已经开始（**陈旧**）还是超时。
          const stale = state.seq !== seq;
          suggestionLog(`${id} ${stale ? '结果已陈旧（新一轮已经开始）' : `中止（超时 ${timeoutMs}ms）`} ⇒ 安静放弃（第 ${seq} 轮）`);
          return;
        }
        if (response?.stopReason === 'error') {
          suggestionLog(`${id} 模型返回错误（${response.errorMessage ?? '未知'}）⇒ 安静放弃（第 ${seq} 轮）`);
          return;
        }
        // ② 陈旧：新一轮已经落定 ⇒ 这一轮的候选一条都不上屏（也不落盘）。
        if (state.seq !== seq) {
          suggestionLog(`${id} 结果已陈旧（第 ${seq} 轮，现在是第 ${state.seq} 轮）⇒ 丢弃`);
          return;
        }
        const text = (Array.isArray(response?.content) ? response.content : [])
          .filter((part) => part?.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n');
        // ③ 严格校验：`parseSuggestionItems` 是候选上屏的**唯一**路径。
        const parsed = parseSuggestionItems(text);
        if (!parsed.ok) {
          suggestionLog(`${id} 模型输出不是 JSON 数组（${parsed.reason}，${text.length} 字符）⇒ 一条都不上屏（第 ${seq} 轮）`);
          return;
        }
        if (parsed.items.length === 0) {
          suggestionLog(`${id} 模型给了空数组（丢掉 ${JSON.stringify(parsed.dropped)}）⇒ 不出这排（第 ${seq} 轮）`);
          return;
        }
        const record = {
          at: new Date().toISOString(),
          sessionId: request.sessionId,
          messageId: request.messageId,
          items: parsed.items,
          model: modelRef(model),
          ms: Date.now() - startedAt,
        };
        await appendSuggestion(record);
        if (state.seq !== seq) return; // 落盘与发事件之间又换了一轮：那一条事件不发（读侧也只折最新一条）
        request.emit?.('session.suggestions', { messageId: record.messageId, items: record.items });
        const droppedTotal = Object.values(parsed.dropped).reduce((sum, value) => sum + value, 0);
        suggestionLog(`${id} ${record.items.length} 条（${record.ms}ms${droppedTotal > 0 ? `，校验丢掉 ${JSON.stringify(parsed.dropped)}` : ''}）`);
      } catch (error) {
        // 失败/超时/断开：**安静放弃**（不出这排、不造假），只记一行日志。
        // ⚠️ 中止如果是因为新一轮已经开始，那就是**陈旧**（与 `stopReason:'aborted'` 那条同一条口径）。
        const stale = state.seq !== seq;
        suggestionLog(`${id} ${stale ? '结果已陈旧（新一轮已经开始）' : '失败（安静放弃）'}（第 ${seq} 轮）：${normalizeError(error).message}`);
      }
    })();
  }

  async function resolveHandoffCwd(value) {
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
      throw new HttpError(400, 'invalid_cwd', 'to.cwd must be a non-empty path string');
    }
    const requested = path.resolve(value);
    const info = await stat(requested).catch(() => null);
    if (!info?.isDirectory()) {
      throw new HttpError(409, 'target_cwd_missing', `handoff target cwd does not exist or is not a directory: ${requested}`, { cwd: requested });
    }
    return realpath(requested);
  }

  // 落点比对：两个都必须是字符串，且**解析后逐字相同**。比的是「这条会话真被绑到哪」与
  // 「请求的是哪」，不是「我传进去的值是什么」（那正是 2026-09-21 事故里没人核对的一环）。
  function sameCwdText(left, right) {
    return typeof left === 'string' && left !== '' && typeof right === 'string' && right !== '' && path.resolve(left) === path.resolve(right);
  }

  // 创建后**回读**新会话自己的 cwd：header 是持久化的那一份（用户与 /tree 看的就是它），
  // runtime manager 是活的那一份。缺一个就如实留 null，绝不拿请求值冒充回读结果。
  // ⚠️ header 是**异步落盘**的（pi 建会话与第一次 flush 之间有窗口，实测沙箱里偶发读不到）⇒
  // 有界重试（默认最多 2s）；等不到就带着 `error` 如实回，并标出 `waitedMs`。
  async function readBackHandoffCwd(sessionId, liveCwd, { attempts = 20, delayMs = 100 } = {}) {
    const out = { file: null, fromHeader: null, fromManager: typeof liveCwd === 'string' ? liveCwd : null, error: null, waitedMs: 0, attempts: 0 };
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      out.attempts = attempt;
      let file = null;
      try {
        file = await findPersistedSession(sessionId);
      } catch (error) {
        lastError = `cannot locate the persisted file of ${sessionId}: ${normalizeError(error).message}`;
      }
      if (file) {
        out.file = file;
        try {
          const headerCwd = SessionManager.open(file).getCwd() ?? null;
          if (headerCwd !== null) {
            out.fromHeader = headerCwd;
            out.error = null;
            return out;
          }
          lastError = `the header of ${file} carries no cwd yet`;
        } catch (error) {
          lastError = `cannot read the header of ${file}: ${normalizeError(error).message}`;
        }
      } else {
        lastError = `the new session ${sessionId} has no persisted file yet, so its cwd cannot be read back`;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        out.waitedMs += delayMs;
      }
    }
    out.error = lastError;
    return out;
  }

  // S4-2 handoff: move a session's context (lossy, a summary) to a *sibling* session.
  // The new session's parentSession is the source's parent, so the tree gains a sibling,
  // not a child. The source session is never modified on any failure path.
  async function handoffSession(sessionId, body) {
    await assertNotMoved(sessionId);
    const goal = requireText(body.goal, 'goal');
    const compress = body.compress === undefined || body.compress === null ? 'llm' : body.compress;
    if (compress !== 'llm' && compress !== 'session') {
      throw new HttpError(400, 'invalid_compress', 'compress must be "llm" or "session"');
    }
    const to = body.to === undefined || body.to === null ? {} : body.to;
    if (!plainObject(to)) throw new HttpError(400, 'invalid_to', 'to must be an object with cwd, sameCwd and/or device');
    for (const key of Object.keys(to)) {
      if (key !== 'cwd' && key !== 'device' && key !== 'sameCwd') throw new HttpError(400, 'invalid_to', `unsupported to.${key}; only cwd, sameCwd and device are accepted`);
    }
    if (to.sameCwd !== undefined && to.sameCwd !== null && typeof to.sameCwd !== 'boolean') {
      throw new HttpError(400, 'invalid_same_cwd', 'to.sameCwd must be a boolean: true is the explicit "yes, land the new session in this session\'s own cwd" opt-in');
    }
    if (to.sameCwd === true && to.cwd !== undefined && to.cwd !== null) {
      throw new HttpError(400, 'handoff_cwd_conflict', 'to.cwd and to.sameCwd:true contradict each other: pass exactly one of them (a real target directory, or the explicit "same cwd" opt-in)');
    }
    if (to.device !== undefined && to.device !== null) {
      if (typeof to.device !== 'string' || to.device.trim() === '') throw new HttpError(400, 'invalid_device', 'to.device must be a non-empty string');
      const deviceConfig = await readDevicesConfig(devicesFile);
      if (!Object.hasOwn(deviceConfig.value, to.device)) {
        throw new HttpError(404, 'device_not_found', `device ${JSON.stringify(to.device)} is not present in ${devicesFile}`, { name: to.device, exists: deviceConfig.exists });
      }
      throw new HttpError(409, 'handoff_device_unsupported', `handoff to device ${JSON.stringify(to.device)} is not implemented yet: the session would have to live on that machine (S3-2 remote sessions), and this build only moves a session between directories on this machine`, { device: to.device });
    }

    const sourceFile = await findPersistedSession(sessionId);
    if (!sourceFile) {
      // 404 只留给**真的不存在**。`findPersistedSession` 只认磁盘，所以一条还热着、但 pi 还没为它写文件的
      // pending 会话在这里也返回 null —— 那要与 `/move` 答**同一句话**（同一个条件 ⇒ 同一个码），
      // 而不是"会话不存在"（那会把"先发一条消息"这条恢复路径藏起来）。
      if (!pool.getSession(sessionId)) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);
      throw sourceNotDurable(sessionId);
    }
    const sourceManager = SessionManager.open(sourceFile);
    const sourceCwd = sourceManager.getCwd();
    const rawParent = sourceManager.getHeader()?.parentSession ?? null;
    const sourceParentPath = rawParent ? path.resolve(rawParent) : null;
    // 落点**必须显式**（2026-09-21 真用户事故：goal 写的是 `~/Documents/godot`，target.cwd 却是源会话
    // 自己的仓目录 —— 静默沿用，新会话被绑进源仓，而它第一条任务书里写着 godot，两边矛盾且四处都没说。
    // 口径与 `/move` 一致：不给目标目录就拒绝，绝不替调用方挑一个目录）。
    //   · `to.cwd`           ⇒ 校验必须已存在（不是目录 ⇒ 409 target_cwd_missing，绝不回落）
    //   · `to.sameCwd:true`  ⇒ 明文沿用源会话的 cwd，并记 cwdSource:"source"
    //   · 两个都没有         ⇒ 400 handoff_cwd_required
    //   · compress:"session" ⇒ 不建新会话、不换 cwd，落点无从谈起 ⇒ 不逼调用方给一个用不上的目录
    let targetCwd = null;
    let cwdSource = 'unused';
    if (to.cwd !== undefined && to.cwd !== null) {
      targetCwd = await resolveHandoffCwd(to.cwd);
      cwdSource = 'explicit';
    } else if (compress === 'session') {
      targetCwd = sourceCwd;
      cwdSource = 'unused';
    } else if (to.sameCwd === true) {
      targetCwd = sourceCwd;
      cwdSource = 'source';
    } else {
      throw new HttpError(400, 'handoff_cwd_required', `to.cwd is required: without it this handoff would land the new session in the source session's own cwd (${sourceCwd}) without anyone asking for that, and nothing in the receipt or in the new session's brief would say so. Pass to.cwd with an existing directory, or pass to.sameCwd:true to inherit ${sourceCwd} deliberately.`, { sourceCwd });
    }
    const target = { cwd: targetCwd, device: null };

    if (compress === 'session') {
      // Fall back to pi's own compaction: no new session file, no cwd change.
      await withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => adapter.startCompaction(`handoff: ${goal}`)));
      const record = await appendHandoff({ at: Date.now(), from: sessionId, to: null, goal, target, cwdSource, summarySha: null, compress, ok: true, mode: 'compaction' });
      emitTree(sessionId, 'handoff_compacted');
      return {
        ok: true,
        mode: 'compaction',
        compress,
        from: sessionId,
        to: null,
        goal,
        target,
        cwdSource,
        cwdVerified: null,
        summaryChars: 0,
        handoff: record,
        lossy: false,
        notice: 'compress:"session" 用 pi 自己的压缩原地压这条会话：没有产生新文件、没有换 cwd，所以 target.cwd 只是记下了源会话的 cwd，不是落点。',
      };
    }

    const summary = typeof body.summary === 'string' ? body.summary : '';
    const summaryError = body.summaryError === undefined || body.summaryError === null ? null : String(body.summaryError);
    if (summary.trim() === '') {
      // The summary step failed: the source session must stay untouched, and the only
      // thing we are allowed to write is one ok:false line. No session is created here.
      const record = await appendHandoff({ at: Date.now(), from: sessionId, to: null, goal, target, cwdSource, summarySha: null, compress, ok: false, error: summaryError ?? 'summary is empty' });
      return {
        ok: false,
        mode: 'llm',
        from: sessionId,
        to: null,
        goal,
        target,
        cwdSource,
        cwdVerified: null,
        summaryChars: 0,
        handoff: record,
        sourceUntouched: true,
        message: summaryError ?? 'the summarisation step produced no text',
        lossy: true,
        notice: '摘要那一步失败了：源会话一字未动，也没有建新会话；只往 handoffs.jsonl 记了一条 ok:false。',
      };
    }

    const summarySha = createHash('sha256').update(summary, 'utf8').digest('hex');
    const childSessionId = randomUUID();
    const created = await createDelegatedSession({
      sessionId: childSessionId,
      cwd: targetCwd,
      parentSessionPath: sourceParentPath,
      task: summary,
    });
    // 建完**回读**：这条会话真被绑到哪个目录，只有它自己的 header / runtime 说了算。
    // 请求值不算结果 —— 现场那条事故就是 ok:true 而 cwd 不对（docs/handoff.md 的 S4-2「落点回读」）。
    const back = await readBackHandoffCwd(childSessionId, created?.cwd ?? null);
    const actualCwd = back.fromHeader ?? back.fromManager ?? null;
    const cwdVerified = sameCwdText(actualCwd, targetCwd)
      && (back.fromManager === null || sameCwdText(back.fromManager, targetCwd))
      && (back.fromHeader === null || sameCwdText(back.fromHeader, targetCwd));
    const placementCwd = created?.placement?.cwd ?? null;
    // Requirement (v1 lesson): long answers live in files; the conversation only gets a
    // pointer. Send the new session a second message saying where the source is and that
    // what it received is a summary, not the full history.
    // 头部第一行永远是**生效的 cwd**：摘要里若写了别的目录，矛盾就摆在眼前（摘要本身一字不改）。
    const cwdHead = [
      `[handoff 落点] 这条会话的实际 cwd 是 ${actualCwd ?? '（回读失败）'}；本次落点来源：${cwdSource === 'source' ? `显式沿用源会话的 cwd（to.sameCwd:true）` : '调用方显式指定的 to.cwd'}。${cwdVerified ? '' : ` ⚠️ 与请求的 ${targetCwd} 不一致 —— 以**实际**这一行为准，并把这件事故报给调用方。`}`,
      cwdVerified
        ? '摘要里若写到别的目录，以这一行为准。'
        : `回读详情：header=${back.fromHeader ?? 'null'} / runtime=${back.fromManager ?? 'null'} / placement=${placementCwd ?? 'null'}${back.error ? ` / ${back.error}` : ''}`,
      '',
    ].join('\n');
    const pointer = `${cwdHead}[handoff 指路] 这条会话是从 ${sessionId} handoff 出来的（源 cwd ${sourceCwd}）。完整历史在那个会话里，落盘文件：${sourceFile}。你收到的第一条消息是摘要，不是全文；要细节就去读那个文件。`;
    // ⚠️ `triggerTurn:false`（这条不是要它的新回合，只是补一句指路）：pi 在 `triggerTurn === false` 时
    // **根本不看 `deliverAs`**（流式走 `_pendingCustomMessages` 等本回合收尾、空闲直接落盘）⇒ steer 对它不可达，
    // 这里的语义**就是排队**（`deliverDelegation` 的回执会如实报 `mode:'followUp'`/`'message'`，不谎称 steer）。
    await withSession(childSessionId, (handle) => inspectAdapter(handle, (adapter) => adapter.deliverDelegation({
      kind: 'handoff-pointer',
      fromSessionId: sessionId,
      text: pointer,
      triggerTurn: false,
    })));
    const record = await appendHandoff({
      at: Date.now(),
      from: sessionId,
      to: childSessionId,
      goal,
      target,
      cwdSource,
      requestedCwd: targetCwd,
      actualCwd,
      cwdVerified,
      summarySha,
      compress,
      ok: cwdVerified,
      mode: 'llm',
      // 新会话**已经落盘**（这句不撒谎）：cwd 不对时它是一个真存在的、位置不对的会话，
      // 只能 ok:false 并把它交回去，绝不假装成功（也绝不悄悄删掉它）。
      ...(cwdVerified ? {} : { error: `handoff landed the new session at an unexpected cwd: requested ${targetCwd}, read back ${actualCwd ?? '(unreadable)'}${back.error ? ` (${back.error})` : ''}` }),
    });
    emitTree(childSessionId, 'handoff_created');
    return {
      ok: cwdVerified,
      mode: 'llm',
      compress,
      from: sessionId,
      to: childSessionId,
      goal,
      target,
      cwd: actualCwd,
      cwdSource,
      cwdVerified,
      requestedCwd: targetCwd,
      cwdReadBack: {
        fromHeader: back.fromHeader,
        fromManager: back.fromManager,
        fromPlacement: placementCwd,
        file: back.file,
        error: back.error,
        waitedMs: back.waitedMs,
        attempts: back.attempts,
      },
      summaryChars: summary.length,
      summarySha,
      sourceFile,
      parentSessionPath: sourceParentPath,
      handoff: record,
      lossy: true,
      ...(cwdVerified ? {} : {
        createdButWrongCwd: true,
        message: `the handoff created ${childSessionId}, but its cwd is not the requested directory: requested ${targetCwd}, read back ${actualCwd ?? '(unreadable)'}. This is NOT ok:true — the session exists at ${actualCwd ?? 'an unknown directory'}, so decide whether to keep it or archive it yourself.`,
      }),
      notice: cwdVerified
        ? `传过去的是摘要，不是全文；新会话拿到的是自包含的一段上下文，不是源会话的全部历史。落点 ${actualCwd}（${cwdSource === 'source' ? '显式沿用源 cwd' : '调用方指定'}，已回读核对）。`
        : `⚠️ 新会话建在了 ${actualCwd ?? '(读不出来)'}，不是请求的 ${targetCwd}；已经 ok:false + 记账 + 在它的指路消息里写明实际落点。`,
    };
  }

  // —— 问题队列（manager toolkit P0）的服务端面 ——
  // 读：热会话问 runtime（它的 manager 有最新条目），冷会话只读文件 —— **不建 runtime**，
  // 所以 cwd 已消失的只读会话也能读（如实 readOnly，**不许 500**）。
  async function questionEntriesFor(sessionId) {
    const handle = pool.getHandle(sessionId);
    if (handle) {
      return inspectAdapter(handle, (adapter) => ({ entries: adapter.manager.getEntries(), cwd: adapter.manager.getCwd(), source: 'runtime' }));
    }
    const file = await findPersistedSession(sessionId);
    if (!file) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);
    const manager = await openPersistedManager(file);
    return { entries: manager.getEntries(), cwd: manager.getCwd(), source: 'file' };
  }

  async function questionsView(sessionId, { status = 'open', limit = QUESTION_LIMIT_DEFAULT } = {}) {
    const { entries, cwd, source } = await questionEntriesFor(sessionId);
    const { states, order } = questionStates(entries);
    const view = questionListView(states, order, status, limit);
    const cwdMissing = await cwdIsMissing(cwd);
    return {
      sessionId,
      exists: true,
      source,
      status,
      limit,
      readOnly: cwdMissing,
      readOnlyReason: cwdMissing ? 'cwd-missing' : null,
      cwdMissing: cwdMissing ? cwd : null,
      counts: view.counts,
      filteredCount: view.filteredCount,
      questions: view.questions,
    };
  }

  async function askQuestion(sessionId, body) {
    if (!plainObject(body)) throw new HttpError(400, 'invalid_body', 'request body must be a JSON object');
    const text = requireText(body.text, 'text');
    if (text.length > QUESTION_TEXT_MAX_CHARS) throw new HttpError(400, 'invalid_text', `text must be at most ${QUESTION_TEXT_MAX_CHARS} characters`);
    // 必填的上下文事实（缺失/过短 ⇒ 400 question_needs_context）；**只对 ask 强制**。
    // 校验放在 assertNotMoved/withSession 之前：缺事实时**一个字都不写**（不许半写）。
    const context = questionContext(body.context);
    const options = questionOptions(body.options);
    const priority = questionPriority(body.priority);
    if (body.force !== undefined && typeof body.force !== 'boolean') throw new HttpError(400, 'invalid_force', 'force must be a boolean');
    const force = body.force === true;
    const dedupeKey = questionDedupeKey(text);
    await assertNotMoved(sessionId);
    // 去重必须在**同一个 per-session 临界区**里做（读-判-写原子），否则两个同时到达的 ask 会各开一条。
    return withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => {
      const { states } = questionStates(adapter.manager.getEntries());
      const existing = [...states.values()].find((state) => state.status === 'open' && state.dedupeKey === dedupeKey) ?? null;
      const at = Date.now();
      if (existing && !force) {
        return { id: existing.id, deduped: true, forced: false, created: false, at, note: '这条已经在等你了（dedupeKey 相同且未答），没有新开一条。', question: questionWire(existing) };
      }
      // force:true 时"合并进既有条目"= 同 id 再追加一条 ask（刷新文本/选项/优先级），仍然只有一条 open。
      const id = existing ? existing.id : newQuestionId();
      adapter.appendQuestionEntry({ id, op: 'ask', text, options: options ?? null, priority, dedupeKey, at, by: 'agent', context });
      const state = questionStates(adapter.manager.getEntries()).states.get(id) ?? null;
      return {
        id,
        deduped: Boolean(existing),
        forced: Boolean(existing) && force,
        created: !existing,
        at,
        note: existing ? '已合并进既有那条（同 id，没有新开）。' : '新开一条，已在等你拍板。',
        question: state ? questionWire(state) : null,
      };
    }));
  }

  async function answerQuestion(sessionId, questionId, body) {
    if (!plainObject(body)) throw new HttpError(400, 'invalid_body', 'request body must be a JSON object');
    const answerText = requireText(body.text, 'text');
    await assertNotMoved(sessionId);
    return withSession(sessionId, (handle) => inspectAdapter(handle, async (adapter) => {
      const state = questionStates(adapter.manager.getEntries()).states.get(questionId) ?? null;
      if (!state) throw new HttpError(404, 'question_not_found', `no question with id ${questionId} in this session`, { id: questionId });
      if (state.status !== 'open') throw new HttpError(409, 'question_not_open', `question ${questionId} is already ${state.status}`, { id: questionId, status: state.status, answeredAt: state.answeredAt, closedAt: state.closedAt });
      // 先投递再落条目：投不进去（压缩中 / 没模型）就**一字不写**（全有或全无，回答不会只落一半）。
      const delivery = await adapter.deliverAnswer(`〔回答#${questionId}〕${answerText}`);
      const at = Date.now();
      adapter.appendQuestionEntry({ id: questionId, op: 'answer', text: state.text, answer: answerText, by: 'user', at });
      const next = questionStates(adapter.manager.getEntries()).states.get(questionId) ?? null;
      // 回执形状是前端（P1）要的：`queuedForDelivery` 只在**真的进了 followUp 队列**时为真
      // （准入窗口那条退化支）；`mode:'steer'` 是「已插进当前这一轮」⇒ `queuedForDelivery:false`。
      // `delivery` 整块照旧带上（诚实细节：mode/queued/note），不多不少。
      return {
        ok: true,
        id: questionId,
        status: 'answered',
        answeredAt: at,
        by: 'user',
        queuedForDelivery: delivery.queued === true,
        at,
        delivery,
        question: next ? questionWire(next) : null,
      };
    }));
  }

  async function closeQuestion(sessionId, questionId, body) {
    if (!plainObject(body)) throw new HttpError(400, 'invalid_body', 'request body must be a JSON object');
    const reason = requireText(body.reason, 'reason');
    // 谁关的：插件工具固定送 agent；网页那条路送 user。缺省当 user（只有人会用网页关），不默认冒充 agent。
    const by = body.by === undefined ? 'user' : body.by;
    if (typeof by !== 'string' || !QUESTION_BY.has(by)) throw new HttpError(400, 'invalid_by', 'by must be "agent" or "user"');
    await assertNotMoved(sessionId);
    return withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => {
      const state = questionStates(adapter.manager.getEntries()).states.get(questionId) ?? null;
      if (!state) throw new HttpError(404, 'question_not_found', `no question with id ${questionId} in this session`, { id: questionId });
      if (state.status !== 'open') throw new HttpError(409, 'question_not_open', `question ${questionId} is already ${state.status}`, { id: questionId, status: state.status, answeredAt: state.answeredAt, closedAt: state.closedAt });
      const at = Date.now();
      adapter.appendQuestionEntry({ id: questionId, op: 'close', text: state.text, closeReason: reason, by, at });
      const next = questionStates(adapter.manager.getEntries()).states.get(questionId) ?? null;
      return { ok: true, id: questionId, status: 'closed', closedAt: at, closedBy: by, at, question: next ? questionWire(next) : null };
    }));
  }

  // 按 id 更新一条**未答**问题（业主 2026-09-21 拍板：“让 ai 可以更新对话”）。
  // 业主的原话与理由：manager 型会话反复收到 subagent 结果 ⇒ 同一个待确认事项的**事实变了** ⇒
  // 旧问题过期了。这时该**更新那一条**（改写 text / 补 context / 调 options / 改 priority），
  // 而不是再开一条（`dedupeKey` 那套“拿归一化文本猜是不是同一件事”**暂不做**（2026-09-21 业主决定）
  // —— 由“按 id 更新”取代其主场景；若出现跨会话的改写重复再评估 —— 更新是直说）。
  // 存储/投影与 answer/close 同构：**只追加** `{op:'update',…}` 条目，现状由“最后一条 op”合成，
  // **不许**原地改历史条目；`askedAt/askedBy` 是“谁在何时问的”这个事实，更新不碰它（另记 updatedAt/updatedBy）。
  async function updateQuestion(sessionId, questionId, body) {
    if (!plainObject(body)) throw new HttpError(400, 'invalid_body', 'request body must be a JSON object');
    const hasText = body.text !== undefined && body.text !== null;
    const hasContext = body.context !== undefined && body.context !== null;
    const hasOptions = body.options !== undefined;
    const hasPriority = body.priority !== undefined && body.priority !== null;
    // 一次更新至少得改一样东西 —— 空请求没有可执行语义，如实 400（不静默当成功）。
    if (!hasText && !hasContext && !hasOptions && !hasPriority) {
      throw new HttpError(400, 'no_update', 'update needs at least one of text, context, options, priority');
    }
    const patch = {};
    if (hasText) {
      const text = requireText(body.text, 'text');
      if (text.length > QUESTION_TEXT_MAX_CHARS) throw new HttpError(400, 'invalid_text', `text must be at most ${QUESTION_TEXT_MAX_CHARS} characters`);
      patch.text = text;
    }
    // 更新后的 `context` 仍要过同一道“判断所需的事实”闸（业主 dogfood 后定的口径，§1.1），
    // 否则一次更新就能把题面退回“一句话 + 两个选项”。缺失=没给（保持原样），给了就必须合格。
    if (hasContext) patch.context = questionContext(body.context);
    // `options: []` ⇒ null（清空候选），与 ask 同一条归一化。
    if (hasOptions) patch.options = questionOptions(body.options);
    if (hasPriority) patch.priority = questionPriority(body.priority);
    await assertNotMoved(sessionId);
    return withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => {
      const state = questionStates(adapter.manager.getEntries()).states.get(questionId) ?? null;
      if (!state) throw new HttpError(404, 'question_not_found', `no question with id ${questionId} in this session`, { id: questionId });
      // **只允许更新未答**：已答/已关是“用户已经拍过板/已经作废”的事实，**不许静默改写**。
      // 如实说清“要新开一条”，让调用方能纠正（插件把它映射成可纠正的工具错误）。
      if (state.status !== 'open') {
        throw new HttpError(
          409,
          'question_not_open',
          `question ${questionId} is already ${state.status}; only an open question can be updated — 要新开一条（ask a new one instead）`,
          { id: questionId, status: state.status, answeredAt: state.answeredAt, closedAt: state.closedAt, hint: 'ask a new question instead' },
        );
      }
      // 幂等：内容与现状逐字段相同 ⇒ 不报错、也**不重复记**（照实说 updated:false）。
      // options 是数组，按序列化比（同一份候选的不同数组实例算相同）。
      const changed = [];
      if (Object.hasOwn(patch, 'text') && patch.text !== state.text) changed.push('text');
      if (Object.hasOwn(patch, 'context') && patch.context !== state.context) changed.push('context');
      if (Object.hasOwn(patch, 'options') && JSON.stringify(patch.options) !== JSON.stringify(state.options)) changed.push('options');
      if (Object.hasOwn(patch, 'priority') && patch.priority !== state.priority) changed.push('priority');
      const at = Date.now();
      if (changed.length === 0) {
        return { ok: true, id: questionId, updated: false, changed, at, by: 'agent', note: '内容与现状相同，没有重复记（幂等）。', question: questionWire(state) };
      }
      // 条目自足可读：`text` 总是带上（更新后的题面）——与 answer/close 同规矩；
      // 其余字段只在本次真的给了的时候出现（契约 §1 的 `{op:'update', text?, context?, options?, priority?, at, by}`）。
      const entry = { id: questionId, op: 'update', text: patch.text ?? state.text, at, by: 'agent' };
      if (Object.hasOwn(patch, 'context')) entry.context = patch.context;
      if (Object.hasOwn(patch, 'options')) entry.options = patch.options;
      if (Object.hasOwn(patch, 'priority')) entry.priority = patch.priority;
      adapter.appendQuestionEntry(entry);
      const next = questionStates(adapter.manager.getEntries()).states.get(questionId) ?? null;
      return { ok: true, id: questionId, updated: true, changed, at, by: 'agent', note: '已更新这条问题（就地刷新，没有新开一条）。', question: next ? questionWire(next) : null };
    }));
  }

  /**
   * 归档一条会话（agent 工具与网页**共用**这条路，工具只是它的一层薄封装）：
   * 这里**不引入任何额外限制** —— 任意会话、任意 id，路线接受就接受、拒绝就照原样拒绝。
   * `changed` 只在本发**真的改了**文件时才是 true；
   * 幂等：请求的状态与现状相同 ⇒ **不写任何条目**、`changed:false`（不报错，也不假装改过）；
   * 审计：`by` 给了就把它与 `at` 写进那条 `sopho.archive` 条目（人那条路不带 ⇒ 写法逐字不变）。
   *
   * 归档**只碰元数据** ⇒ 不需要 cwd（业主 2026-09-22：cwd 已消失的老会话也要能归档）。三条路：
   *   · cwd 在           ⇒ 照旧 `withSession`（含忙判；写那一刻拿着 acquire 的租约 ⇒ 与封存天然互斥）；
   *   · cwd 已消失且**热** ⇒ 走该 runtime 自己的 manager，但**不守忙判**（`ignoreBusy`）；
   *     判 cwd 与写并进**同一次** `runExclusive`（`archiveThroughHandle` 的 `cwdGate`）—— 关掉
   *     「查 cwd 的 `await`」与「写」之间那个调度级空档（见那边的注释）；
   *   · cwd 已消失且**冷** ⇒ 不能走 `withSession`（`prepareRuntime` 会因 cwd 不在而抛 ⇒ 500）
   *     ⇒ 在会话文件上追加，且**必须在封存那条独占段里**做（`archivePersistedSession`）。
   * cwd 缺失与否：热会话问它自己的 runtime（不为一次元数据写去重开一份落盘 manager），冷会话看落盘投影。
   */
  async function archiveSession(sessionId, { archived, by = null }) {
    const at = by === null ? null : Date.now();
    const meta = by === null ? {} : { by, at };
    const handle = pool.getHandle(sessionId);
    if (handle) {
      // 红半钩子（只给沙箱用，与 `SOPHO_FAULT_ARCHIVE_UNLOCKED` 同一口径）：`SOPHO_FAULT_ARCHIVE_HOT_SPLIT=1`
      // = **退回旧样子** —— 判 cwd 与写各是一次 `runExclusive`，两次之间是一个调度级空档，而且
      // **不**把「handle 已被收掉」翻译成可重试回执。那正是本件要关掉的「500 ＋ 条目一个字没写」。
      // 生产不设 ⇒ 零影响。
      if (process.env.SOPHO_FAULT_ARCHIVE_HOT_SPLIT === '1') {
        const cwdMissing = await inspectAdapter(handle, (adapter) => sessionCwdMissingOf(adapter));
        if (cwdMissing) {
          await archiveHotGapHold(sessionId);
          return await archiveThroughHandle(sessionId, handle, archived, meta, { ignoreBusy: true });
        }
      } else {
        let hot;
        try {
          hot = await archiveThroughHandle(sessionId, handle, archived, meta, { ignoreBusy: true, cwdGate: true });
        } catch (error) {
          // 走到这里 = 我们连这笔都没开始写：`getHandle` 返回的 handle 在那个瞬间已经/正在被收掉
          // （封存/回收把它 `dispose()` 了）⇒ `runExclusive` 的 `#assertOpen` 抛。这不是失败，是
          // 「现在不行」—— 一个字都没写，如实回**可重试**语义（与冷路、与 `/seal` 同一个码）。
          if (!handle.disposed && handle.disposing !== true) throw error;
          throw archiveBusyRetryable(sessionId, archived);
        }
        // 非 null = 这条热路处理了（cwd 已消失）；null = cwd 还在 ⇒ 不是这条热路。
        if (hot !== null) return hot;
      }
    } else if ((await persistedSessionState(sessionId)).cwdMissing) {
      return await archivePersistedSession(sessionId, archived, meta);
    }
    return await withSession(sessionId, (h) => archiveThroughHandle(sessionId, h, archived, meta, { ignoreBusy: false }));
  }

  /**
   * 「这条会话的 cwd 现在还在不在」——**唯一一份**判据（`getHandle` 那条热路与
   * `SOPHO_FAULT_ARCHIVE_HOT_SPLIT` 的红形状共用）。与「门」同一判据（`persistedSessionState`）：
   * 只有 ENOENT/ENOTDIR 算「cwd 没了」。
   */
  async function sessionCwdMissingOf(adapter) {
    try {
      return !(await stat(adapter.manager.getCwd())).isDirectory();
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      return true;
    }
  }

  /**
   * 归档拿不住运行时那条回执的**唯一一份**：一个字都没写、如实回**可重试**语义。
   * 码与措辞与封存一致（`session_busy_move` —— 那两个字说的是同一件事：「现在不行，等它落定再来」）；
   * 归档**不**因为别人恰好收走了 runtime 就变成会失败的操作。
   */
  function archiveBusyRetryable(sessionId, archived) {
    return new HttpError(409, 'session_busy_move', 'archive refused: the session has a runtime that cannot be taken right now (it is streaming, compacting, retrying, or holding a lease or a queue); retry once it settles — this is the same gate /seal uses (409 session_busy_move)', { sessionId, archived, changed: false, retryable: true });
  }

  /** 幂等口径的**唯一一份**：`sopho.archive` 的最新一条就是请求的状态 ⇒ 一个字都不写。 */
  function archiveStateMatches(manager, archived) {
    const current = latestArchiveState(manager.getEntries());
    return current.present && current.archived === archived;
  }

  /**
   * 热路写完之后刷新池子的落盘事实（`durable` / `sessionFileBytes`）。
   *
   * 为什么允许「跳过」：封存可以在我们这笔**已经写进文件**之后的尾巴上把 handle `dispose()` 掉
   * （`dispose()` 同步置 `#disposing`，然后 `await #operationQueue` 等我们这笔结束）⇒
   * `handle.refreshPersistence()` 的 `#assertOpen` 会抛。那种情形下这一代马上要把 handle 交给封存、
   * 池记录随后被清掉，刷新本来就多余；而这一笔归档**已经落盘**了 ⇒ **不许**因此把一笔已经发生的
   * 归档回报成 500（同一个「副作用已成、回执说失败」的病）。
   * 真正的刷新失败（文件读坏了、internalKey 被别处占着…）照旧原样抛 —— 只吞「handle 已收掉」这一种。
   */
  async function refreshPersistenceAfterHotArchive(handle) {
    try {
      await handle.refreshPersistence();
    } catch (error) {
      if (!handle.disposed && handle.disposing !== true) throw error;
    }
  }

  /**
   * 归档的那一笔写（**热路**）：走 runtime 自己的 manager。
   * `ignoreBusy` 只给「cwd 已消失」那条路用（那种会话已经不能继续、跑着的回合也永远收不回来）。
   *
   * `cwdGate:true`（只有「cwd 已消失且**热**」那条路用）：把「查 cwd ＋ 写」并进**同一次**
   * `runExclusive`。这是本件的修法：
   *   · 旧形状是「先 `inspectAdapter` 查 cwd（一次 `runExclusive`）→ 再 `inspectAdapter` 写
   *     （另一次 `runExclusive`）」，两次之间是一个**调度级空档**。这条路上 `getHandle` 拿到的
   *     handle **没有租约**，所以封存/回收可以在那个空档里把它 `dispose()` 掉 ⇒ 写撞上已 dispose 的
   *     handle ⇒ **500、条目一个字没写**（`dispose()` 会先等它毫发无伤结束 ⇒ 不丢数据）。
   *   · 并进同一次之后，`dispose()`（`await #operationQueue`）必须等这一笔**写完**（含回调里的
   *     `await`）⇒ 空档消失：要么归档在这笔里成功落盘（封存随后读到的是**带这条归档**的文件，
   *     并把它当作叶路径的一部分保留），要么这一笔根本没开始、如实回可重试的 409。
   *   · cwd 还在 ⇒ 回 `null`（不是这条热路）：调用方照旧走 `withSession`（含忙判 + 租约）。
   *
   * 为什么热路**不**（也不能）进封存那条独占段：那段保护的是「**没有 runtime 持有**时整份替换文件」，
   * 而热路要的**正是那个 runtime**；段里只许做文件/侧车读写，再 acquire 会自锁。热路的互斥靠池子
   * 看得见自己，两条路各有一条：
   *   · cwd 在 ⇒ 调用方是 `withSession`，写的那一刻**拿着 acquire 的租约**（`record.leaseCount ≥ 1`）
   *     ⇒ 封存的 `holdSession` 必回 `ok:false`（blocker `acquired_leases`），根本进不去那段；
   *   · cwd 已消失且热 ⇒ 写跑在该 handle 自己的 `runExclusive` 里，而封存要动手必先把 handle
   *     `dispose()`（`pool.#evict`）—— `dispose()` **同步**置 `#disposing` 再 `await #operationQueue`
   *     ⇒ 封存会等这一笔写完，而 `appendCustomEntry` 是一条**同步** `appendFileSync` ⇒ 与随后的 `rename`
   *     不重叠。
   * 反过来：封存先拿住段时，热路的 `acquire` 排在同一个 `#serializeOpen` 后面，拿到的会是**替换之后**
   * 的那份文件（R11 的绿臂量的就是这一条）。
   */
  async function archiveThroughHandle(sessionId, handle, archived, meta, { ignoreBusy, cwdGate = false }) {
    const result = await inspectAdapter(handle, async (adapter) => {
      if (cwdGate) {
        if (!(await sessionCwdMissingOf(adapter))) return null;
        // 沙箱注入（生产零等待）：把「查 cwd → 写」撑开。现在它在**独占段里面** ⇒ 撑开多久都
        // 不再有缝（封存要收这个 handle 就必须等这一笔结束）。
        await archiveHotGapHold(sessionId);
      }
      if (archiveStateMatches(adapter.manager, archived)) return { archived, changed: false };
      adapter.setArchived(archived, meta, { ignoreBusy });
      return { archived, changed: true };
    });
    if (result === null) return null;
    if (result.changed) {
      await refreshPersistenceAfterHotArchive(handle);
      emitTree(sessionId, 'metadata_changed');
    }
    return { id: sessionId, archived, changed: result.changed, ...meta };
  }

  /**
   * 冷会话 + cwd 已消失：在会话文件上追加那条 `sopho.archive`。
   *
   * **必须在封存那条独占段里做**（`pool.holdSession`，与封存共用同一条 `#serializeOpen` 串行队列）：
   * 封存是**原地整份替换**同一个文件（temp + rename），而这条追加是同一个文件的**另一个写者**
   * ⇒ 两路并行时，追加可能落进 rename 丢掉的那个旧 inode：**收据说 `changed:true`，文件里却没有那条**。
   * 段里**只做文件/侧车读写**（再进池子队列 —— acquire / evict / release 等 —— 会自锁，与封存那段同一条边界）。
   *
   * 段里**不 evict 是常态**（走到这里时本代本来就没有它的 runtime ⇒ `evicted:false`）：进段**不**把归档
   * 的语义改成「先 evict」—— evict 是封存需要的（它必须真的没有持有者才能换文件），归档只需要「没有
   * 别人同时在写」；也不是「会失败的操作」：段里真碰到收不掉的持有者就回到**热路**去写（见下）。
   */
  async function archivePersistedSession(sessionId, archived, meta = {}) {
    // 红半钩子（只给沙箱用，与 `SOPHO_FAULT_ARCHIVE_NEEDS_CWD` 同一口径）：`SOPHO_FAULT_ARCHIVE_UNLOCKED=1`
    // = **退回旧样子**（冷路不在段里，直接在文件上追加）—— 那正是本件要关掉的并发洞。生产不设 ⇒ 零影响。
    if (process.env.SOPHO_FAULT_ARCHIVE_UNLOCKED === '1') return await appendArchiveEntry(sessionId, archived, meta);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const held = await pool.holdSession(sessionId, () => appendArchiveEntry(sessionId, archived, meta));
      if (held.ok) return held.value;
      // 段里报「有人拿着它收不掉」= 就在这个窗口里它被 acquire 走了、而且正在跑（或握着租约/队列）
      // ⇒ 那就不再是冷路：回**热路**写（`ignoreBusy`，与上面「cwd 已消失且热」同一条）。
      // 归档**不**因为别人恰好打开过就变成会失败的操作。
      const late = pool.getHandle(sessionId);
      if (late) return await archiveThroughHandle(sessionId, late, archived, meta, { ignoreBusy: true });
      // 收不掉、此刻又看不到持有者（那一瞬间被别处收掉了）：再进段一次 —— 这条缝是调度级的，第 2 轮必收。
    }
    // 两轮都没收掉：**一个字都没写**，如实回可重试语义（与封存同码：那两个字说的是同一件事）。
    throw archiveBusyRetryable(sessionId, archived);
  }

  /**
   * 冷路的**唯一写点**：打开会话文件 → 按幂等口径追加那一条 `sopho.archive`。
   * 只做文件读写（`emitTree` 只广播事件、不碰池子队列）⇒ 可以安全地跑在封存那条独占段里。
   */
  async function appendArchiveEntry(sessionId, archived, meta) {
    const sessionFile = await findPersistedSession(sessionId);
    if (!sessionFile) throw new HttpError(404, 'session_not_found', `session not found: ${sessionId}`);
    const manager = SessionManager.open(sessionFile);
    if (archiveStateMatches(manager, archived)) return { id: sessionId, archived, changed: false, ...meta };
    manager.appendCustomEntry(ARCHIVE_ENTRY, { ...meta, archived: Boolean(archived) });
    emitTree(sessionId, 'metadata_changed');
    return { id: sessionId, archived, changed: true, ...meta };
  }

  async function mutateSession(sessionId, body) {
    return withSession(sessionId, async (handle) => {
      const changed = {};
      if (Object.hasOwn(body, 'name')) {
        if (typeof body.name !== 'string') throw new HttpError(400, 'invalid_name', 'name must be a string');
        // PATCH {name} 是**人**的改名路（网页以后想加「改名」也走这里）⇒ source=manual：
        // 此后模型的 session_set_title（auto）一律被拒，绝不会把人设的名字盖掉。
        const result = await inspectAdapter(handle, (adapter) => applyTitle(adapter, { title: body.name, source: 'manual' }));
        if (!result.ok) {
          throw new HttpError(409, result.reason === 'empty-title' ? 'empty_title' : 'title_rejected', result.reason === 'set-failed' ? `title not applied: ${result.error}` : `title not applied: ${result.reason}`, result);
        }
        changed.name = result.name;
      }
      if (Object.hasOwn(body, 'archived')) {
        if (typeof body.archived !== 'boolean') throw new HttpError(400, 'invalid_archived', 'archived must be a boolean');
        changed.archived = await inspectAdapter(handle, (adapter) => adapter.setArchived(body.archived));
      }
      if (Object.keys(changed).length === 0) throw new HttpError(400, 'no_mutation', 'provide name and/or archived');
      await handle.refreshPersistence();
      emitTree(sessionId, 'metadata_changed');
      return changed;
    });
  }

  async function sessionEvents(request, response, sessionId) {
    const handle = await pool.acquire(sessionId);
    const pinReason = `sse:${randomUUID()}`;
    handle.pin(pinReason);
    let released = false;
    let unsubscribe = () => {};
    try {
      const closed = beginSse(request, response);
      openSseResponses.add(response);
      const streamSet = sessionSseResponses.get(sessionId) ?? new Set();
      streamSet.add(response);
      sessionSseResponses.set(sessionId, streamSet);
      const adapterState = await inspectAdapter(handle, (adapter) => {
        unsubscribe = adapter.subscribe((event) => sseWrite(response, event.type, event, event.seq));
        return adapter.snapshot();
      });
      await handle.release();
      released = true;
      sseWrite(response, 'session.snapshot', { type: 'session.snapshot', sessionId, ...adapterState });
      await closed;
    } finally {
      unsubscribe();
      openSseResponses.delete(response);
      const streamSet = sessionSseResponses.get(sessionId);
      if (streamSet) {
        streamSet.delete(response);
        if (streamSet.size === 0) sessionSseResponses.delete(sessionId);
      }
      if (!released) {
        try { await handle.release(); } catch {}
      }
      try { handle.unpin(pinReason); } catch {}
    }
  }

  // 一条 runtime 被回收（目前只有显式 includePinned 会碰到带订阅者的那种）时，
  // 把它的直播流用**可重连**事件收尾：客户端拿到 retry:true，自己重连到当前代。
  function endSessionSseStreams(sessionId, reason) {
    const responses = sessionSseResponses.get(sessionId);
    if (!responses || responses.size === 0) return 0;
    let ended = 0;
    for (const response of [...responses]) {
      if (response.destroyed || response.writableEnded) continue;
      try {
        sseWrite(response, 'server.reload', { type: 'server.reload', retry: true, sessionId, reason });
        response.end();
        ended += 1;
      } catch {
        // 客户端已经走了：没什么可收尾的。
      }
    }
    return ended;
  }

  // 客户端走了（断开 / 宿主超时 abort）= 这个响应没人要了 —— 让正在跑的树扫描**可取消**。
  // 正常跑完时 'close' 也会响，`writableFinished` 就是「到底写完了没有」这个事实的判据。
  //
  // ⚠️ `close` 是**一次性事件**：客户端若在我们挂 listener **之前**就走了（socket 已经 destroy /
  // 响应已经 destroyed），那一次 `close` 不会再响 ⇒ 只挂 listener 等于这个信号从来不存在，这一发
  // 会照算到底。所以挂 listener 的**同时**把「已经走了」的现存事实核一遍，命中就立刻 abort。
  // ⚠️ **诚实**：2026-09-25 在本机复诊时，这条路径上"挂之前就走了"**不可达** —— TCP 保证同一连接上
  // request 字节先于 FIN，而 `/messages` 从 `handle()` 入口到这里的每一条 `await` 都在别的分支里
  // （见 docs/abandoned-request-cost.md §7.2）⇒ 这是一条**零成本的防御**（防将来有人在前面加一个
  // `await`），**不是**那批红的原因；那批红的真正旋钮是上面的检查周期。
  // `writableFinished` 那条语义**不变**：正常跑完（响应已经写完）不该 abort。
  function clientGoneSignal(request, response) {
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableFinished) controller.abort('client closed the connection before the response was written');
    };
    response.once('close', onClose);
    if (!response.writableFinished
      && (request.destroyed === true || request.socket?.destroyed === true || response.destroyed === true)) {
      controller.abort('client connection was already gone before the abort listener was armed');
    }
    return { signal: controller.signal, dispose: () => response.off('close', onClose) };
  }

  async function treeEvents(request, response) {
    const gone = clientGoneSignal(request, response);
    const closed = beginSse(request, response);
    openSseResponses.add(response);
    const listener = (event) => sseWrite(response, event.type, event, event.seq);
    treeListeners.add(listener);
    try {
      sseWrite(response, 'tree.snapshot', { type: 'tree.snapshot', ...(await listTree({ signal: gone.signal })) });
      await closed;
    } catch (error) {
      // 客户端走了 ⇒ 共享扫描被中止：这不是错误，也没有响应可写（别当一次 request failed 打日志）。
      if (error?.code !== 'tree_scan_aborted') throw error;
    } finally {
      treeListeners.delete(listener);
      openSseResponses.delete(response);
      gone.dispose();
    }
  }

  function memoryPolicyReport() {
    // `cpuUsage()` 是**本进程自起以来**的累计值（user + system，µs）。放出来是为了让
    // 「连续 N 次 /tree 之后 worker 有没有继续烧 CPU」有**可读的事实**，而不是靠墙钟猜；
    // 采样两次相减 = 那一段的 CPU 成本。它挂在 memoryPolicy 下面，所以宿主 /host 也带得出来
    // （宿主的 workerDetails[].memoryPolicy 原样透传）。
    const cpu = process.cpuUsage();
    return {
      heapLimitBytes,
      watermarks: memoryBudget,
      state: { ...memorySample(), reclaimedEpisode: reclaimedMemoryEpisode },
      cpu: {
        userMs: Math.round(cpu.user / 100) / 10,
        systemMs: Math.round(cpu.system / 100) / 10,
        totalMs: Math.round((cpu.user + cpu.system) / 100) / 10,
        note: 'cumulative for this worker process since start (process.cpuUsage); sample it twice and subtract to get the cost of a window',
      },
      caches: cacheSnapshot(),
      rejections: memoryRejections,
      lastAction: lastMemoryAction,
      lastReclaim: lastMemoryReclaim,
      lastRejection: lastMemoryRejection,
    };
  }

  function workerReport() {
    const memory = process.memoryUsage();
    return {
      pid: process.pid,
      generationId,
      logicVersion,
      codeRevision,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      hot: pool.summary().hot,
      active: pool.summary().active,
      draining: pool.summary().draining === true,
    };
  }

  function poolSnapshot(sessionId, ownerCurrentGeneration = null) {
    const snapshot = pool.getSession(sessionId);
    if (!snapshot) return {};
    const current = ownerCurrentGeneration ?? pool.currentGenerationId;
    const stale = snapshot.generationId !== null && snapshot.generationId !== current;
    return {
      ...snapshot,
      currentGenerationId: current,
      pluginStale: stale,
      logicStale: stale,
      staleReason: stale ? `generation ${snapshot.generationId} is not current ${current}` : null,
    };
  }

  async function stableHostTree() {
    // The stable host listens on this port and is the only writer of the notify registry;
    // the worker reads it over loopback. The default is the live instance口径, kept identical
    // to bin/serve.sh / bin/serve-win.ps1 so a hand-started host does not turn this diagnostic
    // into an invented 503.
    const port = Number(process.env.SOPHO_PORT ?? 7331);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HttpError(503, 'diagnostics_unavailable', 'stable host port is unavailable; cannot read notification registrations honestly');
    }
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/tree`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new HttpError(503, 'diagnostics_unavailable', `cannot read stable host notification state: ${normalizeError(error).message}`);
    }
    if (!response.ok) throw new HttpError(503, 'diagnostics_unavailable', `stable host /tree returned ${response.status}`);
    const value = await response.json().catch((error) => {
      throw new HttpError(503, 'diagnostics_unavailable', `stable host /tree was not valid JSON: ${normalizeError(error).message}`);
    });
    if (!Array.isArray(value?.sessions)) throw new HttpError(503, 'diagnostics_unavailable', 'stable host /tree omitted sessions');
    return value;
  }

  async function registrationsReport() {
    const tree = await stableHostTree();
    const now = Date.now();
    const records = [];
    for (const session of tree.sessions) {
      const notifies = session.notify?.notifies ?? [];
      if (notifies.length === 0) continue;
      // `hot` keeps the v2.1 meaning: "this pool holds a live runtime for it". A worker only
      // knows its own pool, so the scope is reported next to it instead of being guessed.
      const hot = pool.getHandle(session.id) !== null;
      for (const record of notifies) {
        const registeredAt = Number.isFinite(Date.parse(record.registeredAt)) ? Date.parse(record.registeredAt) : null;
        const settledAt = typeof record.settledAt === 'string' && Number.isFinite(Date.parse(record.settledAt)) ? Date.parse(record.settledAt) : null;
        records.push({
          parentId: record.watcherSessionId,
          parent: record.watcherSessionId,
          childId: session.id,
          child: session.id,
          at: registeredAt,
          ageMs: registeredAt === null ? null : now - registeredAt,
          quietMs: Number.isFinite(record.quietMs) ? record.quietMs : null,
          reason: null,
          label: null,
          seenHot: null,
          lastRunningSeenAt: null,
          settledCount: null,
          settledAt,
          settledIdleMs: settledAt === null ? null : now - settledAt,
          pendingWake: record.state === 'quiet_window',
          hot,
          streaming: session.status === 'working',
          state: record.state,
          dueAt: record.dueAt,
          error: record.error,
        });
      }
    }
    records.sort((left, right) => String(left.childId).localeCompare(String(right.childId)) || String(left.parentId).localeCompare(String(right.parentId)));
    const idleMs = records.find((record) => record.quietMs !== null)?.quietMs
      ?? (Number.isFinite(Number(process.env.SOPHO_NOTIFY_QUIET_MS)) ? Math.max(10, Number(process.env.SOPHO_NOTIFY_QUIET_MS)) : 20_000);
    return {
      enabled: true,
      sweepMs: null,
      idleMs,
      timeoutMs: null,
      source: 'stable-host /tree notify projection',
      startedAt: null,
      attaches: null,
      timersCreated: null,
      count: records.length,
      records,
      stats: null,
      error: null,
      hotScope: "records[].hot is this generation worker's own pool only",
      derivedFields: ['records[].streaming is derived from the /tree status (working), not from a runtime isStreaming read'],
      unavailableFields: [
        'sweepMs', 'timeoutMs', 'startedAt', 'attaches', 'timersCreated', 'stats',
        'records[].reason', 'records[].label', 'records[].seenHot', 'records[].lastRunningSeenAt', 'records[].settledCount',
      ],
    };
  }

  function pluginWatchReport() {
    const message = 'v2.2 does not run the v2.1 plugin file watcher; plugins change by replacing the generation worker with POST /reload-code';
    return {
      enabled: false,
      reason: message,
      file: assistantExtensionPath,
      intervalMs: null,
      startedAt: null,
      attaches: null,
      timersCreated: null,
      appliedHash: null,
      triggers: null,
      lastTriggerAt: null,
      lastTriggerHash: null,
      lastReloaded: null,
      lastReloadedAt: null,
      totalReloaded: null,
      skippedDirty: null,
      preflights: null,
      failures: null,
      lastError: null,
      lastErrorAt: null,
      pending: null,
      pendingIds: [],
      uncommittedHash: null,
      replacement: { kind: 'generation-worker', endpoint: 'POST /reload-code', generationId, logicVersion },
      error: { code: 'plugin_watch_not_applicable', message },
    };
  }

  function hotSessions() {
    return pool.listSessions()
      .filter((session) => session.owner !== null)
      .map((session) => ({
        sessionId: session.sessionId,
        generationId: session.generationId,
        runtimeState: session.runtimeState,
        durable: session.durable,
        pinReasons: session.pinReasons,
        acquiredLeases: session.acquiredLeases,
        owner: session.owner,
      }));
  }

  // 「这一代的 worker 眼里的宿主事实」——原来直接长在 `getHostStatus()` 里，`GET /debug/instances`
  // 要用同一份口径，所以提成一个具名函数（**行为一字未改**）。
  function hostStatusReport() {
    const memory = process.memoryUsage();
    const summary = pool.summary();
    return {
      generationId,
      codeRevision,
      currentGenerationId: pool.currentGenerationId,
      draining: summary.draining === true,
      // 正在排空的代必须能回答「谁挡着、为什么挡」：宿主 /host 与 reload 的 409 都把这份原样带出去，
      // 不让运维只能看到一个会话名单。没在排空时这两项是空集（不是 null 占位）。
      drain: {
        draining: summary.draining === true,
        busy: summary.draining ? pool.drainBusy() : [],
        blockers: summary.draining ? pool.drainBlockers() : [],
      },
      worker: workerReport(),
      hotSessions: hotSessions(),
      hostMemory: memory,
      sessionsRoot,
      memoryPolicy: memoryPolicyReport(),
      pool: summary,
    };
  }

  // ── 「暴露给 agent 的工具」的**分组声明表**（本单的唯一来源，业主 2026-09-26 那条要求）──────────
  //
  // 业主原话（`docs/human/v2.2-lessons.md` §调试工具 §agent工具明细，提交 `8966f3f`）：
  //   「暴露给agent了哪些工具，需要包含工具的名称、描述、参数、参数说明。因为现在agent工具已经比较多了，
  //    所以**工具应该要对应的分组**。」名称/描述/参数/参数说明四样已由 `67d7be1` 满足；本表补**分组**。
  //
  // 为什么必须有这张**显式**表（而不是按名字前缀猜）：
  //   · pi 侧**没有** group/category 概念 —— `ToolDefinition` 只有 name/label/description/parameters/
  //     execute ＋ `sourceInfo{source,path}`（`dist/core/agent-session.d.ts`），组名不是 pi 给的事实；
  //   · 实测这批工具大多是单例（只有 `device*` 3 / `session*` 6 / `question*` 3 有共同前缀）
  //     ⇒ 前缀猜不出组，只能声明。
  //
  // 为什么表落在**这个文件**（而不是插件 `pi-extensions/assistant/index.ts`）：
  //   · 分组要覆盖**全部**工具，其中 **8 个是 pi 内建**（bash/edit/find/grep/ls/powershell/read/write），
  //     插件根本不认识它们；
  //   · 插件侧没有可用的通路把组名带过数据面：`toolSurface()` 读的是 pi 会话对象上的 ToolDefinition，
  //     pi 不会保留定义之外的自定义字段，而本仓**有意识地不做**「插件上报」（见下面 toolSurfaceReport()
  //     那段理由）；
  //   · 这个文件是 `GET /debug/instances` 工具面**唯一**的生产者 ⇒ 表挨着它，改完 **`POST /reload-code` 即生效**
  //     （新代 worker 进程会重新 import 本文件；放插件侧则要**新开会话**才生效，且内建那 8 个仍无从声明）。
  // ⇒ 加工具（插件或 pi 内建）**必须**补这张表：没进表的工具会掉进显式组「未分组（没进声明表）」
  //   并被 `npm run test:debugtools` / `test:debuginstances` / `test:debugui` 判红（那是**登记缺口**，
  //   不是「其他」兜底桶）。
  //
  // 表是「组 → 该组工具名」的**有序**数组：组顺序＝这里的顺序（分组视图按它做稳定排序），
  // 「工具名 → 组名」的查找由它**派生**（不另写第二份）。组名要有语义，不许造「杂项」兜底组。
  const TOOL_GROUP_TABLE = [
    // ⚠️ 组名：业主 2026-09-26 在 `docs/human/v2.2-lessons.md` §调试工具 §agent工具明细 里写下
    // 「可以确认的分组：」（提交 eff06f9）—— 这是业主**第一次给分组定名**，那三条就是下面三个的组名。
    // 其余两组（设备（远端）／归档与回收）的名字是**仓库自拟、业主尚未确认** —— 不改，
    // 也不当作已定名（门 `test:toolnames` 只查业主声明的那几组）。
    // ⚠️ 2026-09-26 补充：原先还有一个仓库自拟的「自检」组（成员 `reflect` / `s0b_plugin_probe`）；`reflect` 先退休，
    // 最后 `s0b_plugin_probe` 也退休 ⇒ 该组归零、整组删掉（不是改名），表从 7 组变 6 组。
    // ⚠️ 2026-09-26 再补：业主决定把「阅读页」整条功能退休（由外部 `sopho-nook` 接管）⇒ 该组（7 个工具）整组删掉
    //（不是改名），表从 6 组变 **5** 组。
    // 这一组是 pi **内建**工具（不是本仓插件注册的）⇒ 它的 `source` 是 `builtin-table`：
    // 名字来自 pi 的内建清单，按**名字**归组；pi 换代加了内建工具而这里没补 ⇒ 掉进「未分组」并被门判红。
    { name: '内置工具组', source: 'builtin-table', tools: ['bash', 'edit', 'find', 'grep', 'ls', 'powershell', 'read', 'write'] },
    // 下面各组都是本仓插件注册的工具 ⇒ `source` 是 `declared`（组名由这里逐条声明）。
    // 业主 2026-09-26 给了「方便分组」的工具名写法（`docs/human/v2.2-lessons.md` §Agent 工具）⇒ 四个会话类工具
    // 改成 `session_` 前缀：send→session_send、push→session_push、archive_session→session_archive、set_title→session_set_title
    //（`session_new` / `session_read` 本来就是这个形状）。⚠️ 业主同一天把老的 `spawn` 并入 `session_new`（只留一个建会话工具）
    // 并砍掉 `role_start` / `reflect` / `s0b_plugin_probe` ⇒ 本组只剩下面七个；`cwd`/`handoff` 不带 `session_` 前缀，是否统一前缀业主**还没定**（不是漏改）。
    { name: '树形会话组', source: 'declared', tools: ['cwd', 'handoff', 'session_new', 'session_push', 'session_read', 'session_send', 'session_set_model', 'session_set_title'] },
    { name: '设备（远端）', source: 'declared', tools: ['device_list', 'device_probe', 'device_run'] },
    // 2026-10-26 新增：真生图（业主「继续推进让 gpt 6.1 sol 能直接生图」）。组名是**仓库自拟、业主尚未确认**
    // （同上面两组的口径：`test:toolnames` 只查业主声明过的那几组）。它必须登记在这里：本仓的唯一分组声明表，
    // 没登记就掉进「未分组」并被 `test:debugtools` 判红。
    { name: '图像生成', source: 'declared', tools: ['image_generate'] },
    { name: '提问组', source: 'declared', tools: ['question_ask', 'question_close', 'question_list'] },
    { name: '归档与回收', source: 'declared', tools: ['reclaim_worktree', 'session_archive'] },
  ];
  // 「没进声明表」那个显式组名：**它不是「其他」**，是如实写出来的登记缺口（门必红）。
  const TOOL_UNCLASSIFIED_GROUP = '未分组（没进声明表）';
  // 由表派生：工具名 → { group, groupSource }。表里重复登记同一个工具时**先出现的组赢**，重复本身由
  // `tools.groupTable.duplicateToolNames` 如实登记出来、并由门判红（不在这里抛异常 —— 那会把整个代
  // worker 拖垮，而这是一个可诊断的登记错误）。
  const TOOL_GROUP_BY_NAME = new Map();
  const TOOL_GROUP_DUPLICATES = [];
  for (const group of TOOL_GROUP_TABLE) {
    for (const tool of group.tools) {
      if (TOOL_GROUP_BY_NAME.has(tool)) { TOOL_GROUP_DUPLICATES.push(tool); continue; }
      TOOL_GROUP_BY_NAME.set(tool, { group: group.name, groupSource: group.source });
    }
  }
  // 一条工具记录落在哪一组：表里有 ⇒ 表说的；表里没有 ⇒ 显式「未分组」。
  function toolGroupOf(name) {
    return TOOL_GROUP_BY_NAME.get(name) ?? { group: TOOL_UNCLASSIFIED_GROUP, groupSource: 'unclassified' };
  }
  // 分组视图（`tools.groups`）：由同一张声明表**派生** —— 与逐工具字段是同一份事实的两种视图，
  // 所以两者必然一致（不重不漏）。顺序**确定**：组按声明表顺序，组内按传进来的注册顺序（`registered`
  // 已按名字排序），「未分组」永远排最后；空组不画（但空组/陈旧条目会被下面那两个差集点名）。
  function toolGroupsView(registeredNames) {
    const buckets = new Map();
    for (const group of TOOL_GROUP_TABLE) buckets.set(group.name, { name: group.name, groupSource: group.source, tools: [] });
    buckets.set(TOOL_UNCLASSIFIED_GROUP, { name: TOOL_UNCLASSIFIED_GROUP, groupSource: 'unclassified', tools: [] });
    for (const name of registeredNames) buckets.get(toolGroupOf(name).group).tools.push(name);
    return [...buckets.values()]
      .filter((bucket) => bucket.tools.length > 0)
      .map((bucket) => ({ name: bucket.name, groupSource: bucket.groupSource, toolCount: bucket.tools.length, tools: bucket.tools }));
  }
  // 声明表这块**静态**事实（不依赖有没有热 runtime ⇒ 永远可读），外加两个差集：它们只在真的读到注册
  // 清单时才有意义（读不到 ≠ 全都是陈旧的）⇒ 读不到时是 `null`，不是空数组假装「对得上」。
  function toolGroupTableReport(registeredNames) {
    const known = registeredNames === null ? null : new Set(registeredNames);
    return {
      declaredIn: 'server/base-logic.mjs TOOL_GROUP_TABLE (single source of truth; pi itself has no group concept, so this repo declares the groups explicitly). Takes effect on POST /reload-code because a new generation worker re-imports this file.',
      groupSourceValues: {
        declared: 'the tool name is listed in TOOL_GROUP_TABLE under a group this repo declares (the plugin tools)',
        'builtin-table': "the tool name is listed in TOOL_GROUP_TABLE's builtin group (pi's own built-in tools, matched by name)",
        unclassified: 'the tool is in neither table ⇒ it lands in the explicit group 未分组（没进声明表）; that is a registration gap the gates fail on, never a catch-all bucket',
      },
      groups: TOOL_GROUP_TABLE.map((group) => ({ name: group.name, groupSource: group.source, tools: [...group.tools] })),
      duplicateToolNames: [...new Set(TOOL_GROUP_DUPLICATES)],
      declaredButNotRegistered: known === null ? null : [...TOOL_GROUP_BY_NAME.keys()].filter((name) => !known.has(name)),
      registeredButNotDeclared: known === null ? null : registeredNames.filter((name) => !TOOL_GROUP_BY_NAME.has(name)),
    };
  }

  // 工具清单里每条记录的摘要（工具描述的**首行**而已：一整段描述不该把响应撑大）。
  // ⚠️ 这是**兼容用的截断字段**：`descriptionHead` 只有前 160 字，`parameterNames` 只有名字。
  // 业主 2026-09-25 那条要求（名称/描述/参数/参数说明四样都要）由下面三个**全量**字段满足：
  //   `description`（全文）、`parameters`（那份 JSON Schema 原样）、`parameterDetails[]`（每个参数一条）。
  function descriptionHead(value, maxChars = 160) {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  }

  // 每个参数的说明**照实**取：pi 的工具定义里，参数说明是 `parameters.properties[name].description`。
  // 实测**不是每个参数都有**（参数 schema 用了 `StringEnum(...)` 这类不带 description 的形状时就取不到）
  // ⇒ 取不到就写 `null`（UI 按本仓口径逐字写「这一项取不到」），
  // **不拿空串顶替**（空串会被 JSON 序列化后与「说明就是空」混为一谈）。
  function toolParameterRecord(name, schema, requiredNames) {
    const type = schema && typeof schema === 'object' && typeof schema.type === 'string' ? schema.type : null;
    const description = schema && typeof schema === 'object' && typeof schema.description === 'string' && schema.description.trim() !== ''
      ? schema.description
      : null;
    return {
      name,
      // JSON Schema 的 `type` 可以缺（例如 `Type.Any()`）⇒ 缺就 `null`，不猜。
      type,
      required: requiredNames.includes(name),
      description,
    };
  }

  function toolRecord(tool) {
    const parameters = tool?.parameters;
    const toolName = typeof tool?.name === 'string' ? tool.name : null;
    const schemaProperties = parameters && typeof parameters === 'object' && parameters.properties && typeof parameters.properties === 'object'
      ? parameters.properties
      : {};
    const propertyNames = Object.keys(schemaProperties);
    const requiredNames = Array.isArray(parameters?.required) ? parameters.required.filter((entry) => typeof entry === 'string') : [];
    const group = toolGroupOf(toolName);
    return {
      name: toolName,
      // `sourceInfo.source` 实测在真会话里是 "cli"（插件）/"builtin"（内建）——**不是**文件路径；
      // `path` 实测内建也不是空串（是 `<builtin:bash>` 这种形状）⇒ 别拿 `path` 当「插件/内建」的判据，
      // 用下面声明表给的 `groupSource`（见 web/render.js 里那一段注释）。两个原样字段都照报。
      source: tool?.sourceInfo?.source ?? null,
      path: tool?.sourceInfo?.path ?? null,
      hasParameters: parameters !== undefined && parameters !== null,
      // 兼容字段：参数名清单（全量形状见 `parameterDetails`）。
      parameterNames: propertyNames,
      // 业主那条要求里的「参数」：那份 JSON Schema **原样**带出去（`properties` 里嵌套的说明也在里面）。
      // 没有 schema 的工具（理论上不会有）如实 `null`，不拿 `{}` 假装有一份空 schema。
      parameters: parameters === undefined ? null : parameters,
      // 业主那条要求里的「参数说明」：**每个参数一条** `{ name, type, required, description }`。
      // `description` 为 `null` ＝这一项取不到（pi 的定义里就没写），不是「说明是空串」。
      parameterDetails: propertyNames.map((name) => toolParameterRecord(name, schemaProperties[name], requiredNames)),
      // 业主那条要求里的「描述」：**全文**（`descriptionHead` 只是它的前 160 字，留着做兼容）。
      description: typeof tool?.description === 'string' ? tool.description : null,
      descriptionHead: descriptionHead(tool?.description),
      // 业主 2026-09-26 那条要求：**分组**。组名不是 pi 给的事实（pi 没有 group 概念）⇒ 取自上面那张
      // **显式声明表**（单一来源）；`groupSource` 说清这个组名是**怎么定下来的**（取值含义见
      // `tools.groupTable.groupSourceValues`）：
      //   `declared`      —— 工具名逐条写在本仓声明的插件组里；
      //   `builtin-table` —— 工具名写在表的内建组里（pi 内建工具，按名字归组）；
      //   `unclassified`  —— 两张表都没有（新工具没进表）⇒ 落进显式组「未分组（没进声明表）」。
      //                      这**不是**「其他」兜底：门会拿 `tools.groupTable` 的两个差集把它判红。
      group: group.group,
      groupSource: group.groupSource,
    };
  }

  // 「这一代的 worker 现在往每条活着的会话上暴露了哪些工具」——给 UI 用的**只读**数据。
  //
  // 为什么**不走**「插件上报」那种形状（业主纠向里提过）：`pi.getAllTools()` / `pi.getActiveTools()`
  // 就是 pi 会话对象上的 `getAllTools()` / `getActiveToolNames()` 两个方法本身 —— 插件宿主就是这两个方法的
  // 字面转发（`dist/bundle/chunks/chunk-JVUZSMYM.js` 里的 `getActiveTools:()=>this.getActiveToolNames(),
  // getAllTools:()=>this.getAllTools()`；方法本身见 `dist/core/agent-session.d.ts:306,310`），而那个会话
  // 对象**就在本进程里**：`adapter.session` —— 本文件已有同一条路的先例（`adapter.session.isStreaming` /
  // `adapter.session.model`，见 sessionView）。插件本身也**跑在同一个 runtime 里** ⇒ 「让插件报」与
  // 「就地读会话」看到的东西一字不差，而上报还要多出：一条写路由 ＋ 一份缓存 ＋ 一条「报告落在
  // 换代后哪一代」的陈旧风险。所以这里就地读，不引入任何上报路径。
  //
  // 只读：只读**已经有热 runtime** 的会话（`pool.getHandle` 不 acquire、不建 runtime；`handle.toolSurface()`
  // 是同步纯读、不进操作队列）；没有热 runtime 的会话**读不到** ⇒ 如实写进 `unreadableLiveSessions` /
  // `registeredUnavailableReason`，不拿空数组或 null 假装「没有工具」。
  function toolSurfaceReport() {
    const live = [];
    const unreadable = [];
    for (const session of pool.listSessions()) {
      if (session.owner === null) continue; // 冷记录没有 runtime，也就没有工具面可读
      const handle = pool.getHandle(session.sessionId);
      const surface = handle ? handle.toolSurface() : { ok: false, reason: 'this session has no live runtime handle in this worker' };
      if (!surface.ok) {
        unreadable.push({ sessionId: session.sessionId, reason: surface.reason });
        continue;
      }
      const registered = surface.registered.map(toolRecord).sort((left, right) => String(left.name).localeCompare(String(right.name)));
      live.push({
        sessionId: session.sessionId,
        active: [...surface.active].sort(),
        registered,
        // 这一条会话报的注册名清单（分组视图与两个差集由它派生）。
        names: registered.map((tool) => tool.name),
        registeredNames: registered.map((tool) => tool.name ?? null).join('\u0000'),
      });
    }
    const [first] = live;
    const groupsView = first ? toolGroupsView(first.names) : null;
    return {
      source: "read in-process off this worker's live pi sessions — pi's AgentSession.getAllTools() / getActiveToolNames(), the two methods that pi.getAllTools() / pi.getActiveTools() forward to; no plugin report, no cache",
      scope: "the tool surface belongs to a LIVE runtime: this covers only sessions that are hot in THIS worker's pool, and `active` is **per session** (each session's own tool set, not a worker-wide constant)",
      liveSessionCount: live.length,
      observedOn: first ? first.sessionId : null,
      registered: first ? first.registered : null,
      registeredCount: first ? first.registered.length : null,
      registeredUnavailableReason: first
        ? null
        : 'no live runtime served this request, and the registered tool list is only readable off a live pi session',
      identicalRegisteredAcrossLiveSessions: live.length === 0
        ? null
        : live.every((row) => row.registeredNames === first.registeredNames),
      activeBySession: live.map((row) => ({ sessionId: row.sessionId, activeCount: row.active.length, active: row.active })),
      // 业主 2026-09-26 那条要求（分组）的两块数据面：
      //   · `groups` ＝**分组视图**（组名 + 该组工具；与逐工具的 `group` 由同一张表派生 ⇒ 必然一致）；
      //   · `groupTable` ＝声明表那块**静态**事实 ＋ 两个差集（「不重不漏」的判据，门拿它判红）。
      // 读不到注册清单（没有热 runtime）时 `groups` 与那两个差集都是 `null` ＋ 原因，**不吐空数组假装没有**。
      groups: groupsView,
      groupsUnavailableReason: first
        ? null
        : 'the group view is derived from the registered tool list, which is only readable off a live pi session (see registeredUnavailableReason)',
      groupTable: toolGroupTableReport(first ? first.names : null),
      unreadableLiveSessions: unreadable,
      unavailable: [
        'sessions with no hot runtime in this worker: the tool surface lives on the runtime, so nothing is reported (or guessed) for them',
        "other generations' sessions: only this worker's own pool is visible here (see GET /host -> workers[])",
      ],
    };
  }

  // `GET /debug/instances`（**只读**，给人也更是给 UI）：把「现在这些进程什么样」合成一份。
  //
  // 三条硬要求（写死在这里，改动前先读）：
  //   1. **一个写都不做**：不 evict、不建 runtime、不落任何文件。按会话那张表复用的就是回收/排空
  //      诊断那同一套只读判据（`pool.drainBlockers()` ＝ #recordsFacts ⊕ #reclaimBlockers），
  //      **只读它**，绝不调用 `pool.sweep` / `pool.reclaimIdle` / `pool.evict` 任何一条。
  //   2. 取不到的字段一律**如实登记**（`unavailable` / `unreadableLiveSessions` / `registeredUnavailableReason`），
  //      不是回 null 假装有。
  //   3. 端点跑在**这一代的 worker 进程**里，所以 `worker` 块就是那个进程自己的事实；
  //      宿主进程（A, server/base.mjs）与 B（server/app.mjs）都不在这个进程里 ⇒ 见 `unavailable`。
  function debugInstancesReport() {
    const memory = process.memoryUsage();
    const policy = memoryPolicyReport();
    return {
      at: new Date().toISOString(),
      endpoint: 'GET /debug/instances',
      readOnly: true,
      worker: {
        pid: process.pid,
        generationId,
        logicVersion,
        codeRevision,
        uptimeSeconds: Math.round(process.uptime() * 1000) / 1000,
        memory: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
        memorySource: 'process.memoryUsage() of the generation worker that serves this endpoint',
      },
      pool: {
        scope: "this generation worker's own pool only; other live generations hold their own pools and are not visible from here",
        summary: pool.summary(),
        // 与 `POST /reclaim {"dryRun":true}` 和 draining 诊断同源：`evictionEligible` / `blockers` /
        // `idleForMs` 就是回收入口真正用的那套判据，所以「谁挡着、为什么挡」在这里看到的口径
        // 与真去收一次完全一致（这里只是**读**它）。
        sessions: pool.drainBlockers(),
        sessionFields: [
          'sessionId', 'runtimeState', 'durable', 'running', 'runningNow', 'acquiredLeases',
          'pendingMessages', 'queuedOperations', 'busyFlags', 'pinReasons', 'idleForMs',
          'generationId', 'sessionFileBytes', 'evictionEligible', 'blockers',
        ],
        sessionsSource: 'pool.drainBlockers() — same read-only facts the reclaim/drain path uses',
      },
      policy: {
        heapLimitBytes: policy.heapLimitBytes,
        watermarks: policy.watermarks,
        pressure: policy.state,
        admission: {
          formula: 'predictedPeakBytes = sessionFileBytes * sessionMultiplier + reserveBytes; reject when predictedPeakBytes > min(heapHighBytes, rssHighBytes), or after reclaim when heapUsed + predictedPeakBytes > heapHighBytes or rss + predictedPeakBytes > rssHighBytes',
          singleFileBudgetBytes: Math.min(policy.watermarks.heapHighBytes, policy.watermarks.rssHighBytes),
          implementedIn: 'server/base-logic.mjs admitSession / memoryPressureError',
        },
        rejections: policy.rejections,
        lastAction: policy.lastAction,
      },
      host: hostStatusReport(),
      // 「暴露给 agent 了哪些工具」——给 UI 的**数据**（不是 agent 工具，本单也不加任何 UI）。
      tools: toolSurfaceReport(),
      // 取不到的一律点名、并说清**为什么**与**去哪儿取**——不拿 null 顶替。
      unavailable: [
        {
          field: 'hostProcess',
          reason: "the A host (server/base.mjs) is a separate process; its own pid/uptime/memory are not visible from inside a generation worker",
          where: 'GET /host on the A host (pid, uptimeSeconds, hostMemory, workerTotals, workers[])',
        },
        {
          field: 'appProcess',
          reason: "B (server/app.mjs) is not reachable from this worker and its address is not part of a worker's own facts",
          where: 'GET /app-host on B itself (pid, codeVersion, startedAt, upstream, webRoot) — B is a separate process on its own port; whoever renders this for a UI must ask it separately and say so when it does not answer',
        },
        {
          field: 'otherGenerations',
          reason: 'this response only covers the pool of the worker that served it; draining/older generations hold their own pools',
          where: 'GET /host -> workers[] (per-generation rssBytes/heapUsedBytes/sessions), and workers[].busy/blockers while draining',
        },
        {
          field: 'host.hostMemory / host.worker',
          reason: 'these two fields carry THIS worker process\'s process.memoryUsage() and workerReport(), because that is what logic.getHostStatus() returns; they are not the host process\'s memory',
          where: "GET /host on the A host for the host process's own memory",
        },
      ],
    };
  }

  return {
    async handle(request, response) {
      // 测试专用故障注入（生产不设 ⇒ 零影响）：见 `noWorkerReplyFaultFor` 的注释。
      if (noWorkerReplyFaultFor(request)) {
        // 一个字节都不写：宿主的 upstreamRequest 报错 ⇒ `reached === false`。
        response.socket?.destroy();
        return true;
      }
      const url = new URL(request.url || '/', 'http://logic.local');
      if (url.pathname === '/metrics') {
        if (request.method === 'GET') {
          sendJson(response, 200, netSnapshot());
          return true;
        }
        return false;
      }
      instrumentRequest(request, response, metricRoutePattern(url.pathname));
      // 条件压缩的判据一次性算好挂到 response 上：所有 JSON/文本响应（`sendJson` /
      // `sendJsonText`）共用同一条出口 `writeResponseBody`，所以「非回环 + 大 + 白名单」
      // 必然一致地生效，不会某条路由漏掉。
      response.sophoCompression = compressionPlan(request);
      try {
        if (request.method === 'GET' && url.pathname === '/ping') {
          sendJson(response, 200, { logicVersion, behavior: PING_BEHAVIOR });
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/devices') {
          try {
            sendJson(response, 200, await listDevices());
          } catch (error) {
            if (error?.code !== 'devices-config-invalid') throw error;
            sendJson(response, 500, {
              devices: [],
              exists: true,
              error: { code: error.code, detail: error.details?.detail ?? error.message },
              message: error.message,
              details: error.details,
            });
          }
          return true;
        }
        const deviceRunMatch = /^\/devices\/([^/]+)\/run$/.exec(url.pathname);
        if (request.method === 'POST' && deviceRunMatch) {
          let name;
          try { name = decodeURIComponent(deviceRunMatch[1]); } catch { throw new HttpError(400, 'invalid_device_name', 'device name has invalid URL encoding'); }
          const body = await readJson(request);
          if (body.cwd !== undefined && typeof body.cwd !== 'string') throw new HttpError(400, 'invalid_cwd', 'cwd must be a string');
          sendJson(response, 200, await runDeviceCommand(name, requireText(body.command, 'command'), body.cwd));
          return true;
        }
        const deviceProbeMatch = /^\/devices\/([^/]+)\/probe$/.exec(url.pathname);
        if (request.method === 'POST' && deviceProbeMatch) {
          let name;
          try { name = decodeURIComponent(deviceProbeMatch[1]); } catch { throw new HttpError(400, 'invalid_device_name', 'device name has invalid URL encoding'); }
          const body = await readJson(request);
          if (body.path !== undefined && typeof body.path !== 'string') throw new HttpError(400, 'invalid_path', 'path must be a string');
          sendJson(response, 200, await runDeviceProbe(name, body.path));
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/placement') {
          sendJson(response, 200, await placementView());
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/handoffs') {
          sendJson(response, 200, await readHandoffs());
          return true;
        }
        // `GET /debug/instances`（只读，给 UI 的调试面板供数）：顶层路由 ⇒ 宿主的 `SESSION_PATH`
        // 匹配不上，走**兜底 proxy 到 current worker** ⇒ 落在逻辑层，`POST /reload-code` 即生效，
        // 宿主 `server/base.mjs` 一字未动。方法不对时如实 405（不吞掉、不假装成功）。
        if (url.pathname === '/debug/instances') {
          if (request.method !== 'GET') {
            throw new HttpError(405, 'method_not_allowed', `method ${request.method} is not allowed for ${url.pathname}; this endpoint is read-only`);
          }
          sendJson(response, 200, debugInstancesReport());
          return true;
        }
        // 配置（`docs/design-settings.md` v1）：顶层路由（不带 `/sessions/` 前缀）⇒ 宿主的 `SESSION_PATH`
        // 匹配不上，走**兜底 proxy 到 current worker** —— 于是这条路由落在逻辑层，`POST /reload-code`
        // 即生效，宿主一字未动。写也只有**当前代**这一个写者（换代窗口里的 503/重试语义与别的写路径同一套）。
        // 形状照 `GET /titles` 那类只读账＋`PATCH /sessions/{id}` 那类写：GET 回**生效值**（默认 ⊕ 已存）——
        // 客户端**不许自己推算**；PATCH 校验，未知 key / 非法值一律诚实 400，绝不静默忽略。
        // 校验在所有写之前判完 ⇒ 400 时侧车文件逐字节未变（`test/settings-fold.mjs` 用 sha256 钉它）。
        if (url.pathname === '/settings') {
          if (request.method === 'GET') {
            sendJson(response, 200, await uiSettings.read());
            return true;
          }
          if (request.method === 'PATCH') {
            // `uiSettings.patch` 的校验错误自带 `statusCode`/`toJSON()` ⇒ 这里不吞错、不重造措辞，
            // 直接交给下面那个统一 catch（与 `HttpError` 同一条出口）。
            sendJson(response, 200, await uiSettings.patch(await readJson(request)));
            return true;
          }
          throw new HttpError(405, 'method_not_allowed', `method ${request.method} is not allowed for ${url.pathname}`);
        }
        // 卡片级反馈（`docs/design-annotations.md` v1/v1.5）：顶层路由（不带 `/sessions/` 前缀）
        // ⇒ 宿主兜底 proxy 到 current worker，`POST /reload-code` 即生效（宿主一字未动）。
        // 形状照 `POST /sessions/{id}/questions` 的先例：**一层路径 ＋ body 里的 `op`**
        //（`op` 缺省 / `'annotate'` = 新建，`'resolve'` = open ⇒ done）—— 与问题看板同一套「append-only 行 + 读侧折现状」。
        if (url.pathname === '/annotations') {
          if (request.method === 'GET') {
            const rawSession = url.searchParams.get('session');
            const state = url.searchParams.get('state') ?? 'all';
            if (!ANNOTATION_STATES.has(state)) throw new HttpError(400, 'invalid_state', `state must be one of all, open, done: ${state}`);
            sendJson(response, 200, await listAnnotations({
              since: annotationSince(url.searchParams.get('since')),
              sessionId: rawSession === null || rawSession === '' ? null : requireFullSessionId(rawSession),
              state,
            }));
            return true;
          }
          if (request.method === 'POST') {
            const body = await readJson(request);
            const op = body?.op === undefined || body?.op === null ? 'annotate' : body.op;
            if (op === 'annotate') { sendJson(response, 201, await createAnnotation(body)); return true; }
            if (op === 'resolve') { sendJson(response, 200, await resolveAnnotation(body)); return true; }
            throw new HttpError(400, 'invalid_op', `op must be one of ${[...ANNOTATION_OPS].join(', ')}: ${JSON.stringify(op)}`);
          }
          throw new HttpError(405, 'method_not_allowed', `method ${request.method} is not allowed for ${url.pathname}`);
        }
        // 设计文档 §1/§6 里写的那条路径（`POST /annotations/{id}/resolve`）：与上面 `op:'resolve'`
        // **同一个处理函数**（同一个幂等口径、同一行事件），只当等价别名 —— 宿主同样一字未动。
        const annotationResolveMatch = /^\/annotations\/([^/]+)\/resolve$/.exec(url.pathname);
        if (annotationResolveMatch) {
          if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', `method ${request.method} is not allowed for ${url.pathname}`);
          let annotationId;
          try { annotationId = decodeURIComponent(annotationResolveMatch[1]); } catch { throw new HttpError(400, 'invalid_annotation_id', 'annotation id has invalid URL encoding'); }
          const body = await readJson(request);
          if (body.id !== undefined && body.id !== null && body.id !== annotationId) {
            throw new HttpError(400, 'invalid_annotation_id', `body.id (${JSON.stringify(body.id)}) does not match the id in the path (${annotationId})`);
          }
          sendJson(response, 200, await resolveAnnotation({ ...body, id: annotationId }));
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/cwd-recents') {
          const requested = Number(url.searchParams.get('limit') ?? 50);
          const limit = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, 50) : 50;
          sendJson(response, 200, await readCwdRecents(limit));
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/env') {
          sendJson(response, 200, await cwdEnvironment(url.searchParams.get('cwd')));
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/registrations') {
          sendJson(response, 200, await registrationsReport());
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/plugin-watch') {
          sendJson(response, 200, pluginWatchReport());
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/tree') {
          const gone = clientGoneSignal(request, response);
          try {
            // 索引死线（`SOPHO_TREE_INDEX_BUDGET_MS`，默认 3500 ms）：**必须**小于宿主等 worker 的
            // 硬超时（`server/base.mjs` 的 workerJson，默认 5000 ms）。到点先回现在有的事（行都对、
            // 可能不全，`partial: true`），剩下的扫描在 worker 里接着跑完 —— 「慢一次」不再等于「永远 500」。
            sendJson(response, 200, await listTree({ signal: gone.signal, budgetMs: treeIndexBudgetMs }));
          } catch (error) {
            // 客户端已经走了（宿主硬超时）：没人要这个响应，也没有 500 可写。
            if (gone.signal.aborted) return true;
            throw error;
          } finally {
            gone.dispose();
          }
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/titles') {
          sendJson(response, 200, await titlesReport());
          return true;
        }
        if (request.method === 'GET' && url.pathname === '/tree/events') {
          await treeEvents(request, response);
          return true;
        }
        if (request.method === 'POST' && url.pathname === '/sessions') {
          const body = await readJson(request);
          if (body.scratch !== undefined && typeof body.scratch !== 'boolean') throw new HttpError(400, 'invalid_scratch', 'scratch must be a boolean');
          if (body.scratch === true && body.cwd !== undefined && body.cwd !== null) throw new HttpError(400, 'invalid_session_location', 'scratch:true and cwd are mutually exclusive');
          if (body.cwd !== undefined && body.cwd !== null && typeof body.cwd !== 'string') throw new HttpError(400, 'invalid_cwd', 'cwd must be a string or null');
          const result = await queueSessionCreate(async () => {
            const placementConfig = await readPlacementConfig(placementFile);
            const sessionId = randomUUID();
            const scratch = body.scratch === true || body.cwd === null;
            const cwd = scratch
              ? path.join(scratchRoot, sessionId)
              : path.resolve(typeof body.cwd === 'string' ? body.cwd : process.env.SOPHO_DEFAULT_CWD || process.cwd());
            if (scratch) await mkdir(cwd, { recursive: true });
            const summary = await withSession(sessionId, async (handle) => {
              if (body.name !== undefined) {
                if (typeof body.name !== 'string') throw new HttpError(400, 'invalid_name', 'name must be a string');
                // 建会话时显式给的名字 = L0 种子（确定性给的，不是模型判断的）。
                // raw:true：不截断 —— 账上那条必须与 pi 写进文件的一字不差。
                if (piName(body.name)) await inspectAdapter(handle, (adapter) => applyTitle(adapter, { title: body.name, source: 'seed', raw: true }));
              }
              return inspectAdapter(handle, (adapter) => adapter.snapshot().summary);
            }, { create: true, cwd });
            placementConfig.value[sessionId] = {
              kind: scratch ? 'scratch' : 'dir',
              cwd,
              device: null,
              scratchRoot: scratch ? scratchRoot : null,
              claimedBy: null,
              at: Date.now(),
            };
            const placementEntry = placementConfig.value[sessionId];
            // 同上：withSession create 已经把会话落盘 ⇒ 记账/旁账写失败不能把 201 变 500。
            let placementPersisted = true;
            let warning = null;
            try {
              await persistPlacement(placementConfig);
            } catch (error) {
              placementPersisted = false;
              pendingPlacements.set(sessionId, placementEntry);
              warning = placementWriteWarning(placementFile, `session ${sessionId} was created, but its placement record could not be written to ${placementFile}; the session is already live and on the tree (placement is derived from its own cwd; /tree reports derived:true / source:'pi-header'), so do NOT retry the create — a retry would hit the live-cwd guard. The entry will be written on the next successful placement write.`, error);
              console.error(`[placement] ${warning.message} (${normalizeError(error).message})`);
            }
            let cwdRecentsRecorded = true;
            if (!scratch) {
              try {
                await rememberCwd(cwd);
              } catch (error) {
                // cwd-recents.json 只是「最近用过的目录」的辅助账：目录与会话都已经建好，
                // 这里再抛会把 201 变成 500（同一个「副作用已成、回执说失败」的病）⇒ 如实降级。
                cwdRecentsRecorded = false;
                console.error(`[cwd-recents] not recorded for ${cwd}: ${normalizeError(error).message}`);
              }
            }
            emitTree(sessionId, 'created');
            return {
              ...summary,
              scratch,
              placementPersisted,
              warning,
              cwdRecentsRecorded,
              placement: placementPersisted
                ? { ...placementEntry, derived: false, source: 'placement.json' }
                : { ...placementEntry, derived: true, source: 'pi-header' },
            };
          });
          sendJson(response, 201, result);
          return true;
        }

        const sessionMatch = /^\/sessions\/([^/]+)(?:\/(messages|events|commands|models|model|message|steer|follow-up|followUp|dev-burst|abort|compact|title|archive|export|move|handoff|questions|seal))?$/.exec(url.pathname);
        if (!sessionMatch) return false;
        let rawId;
        try { rawId = decodeURIComponent(sessionMatch[1]); } catch { throw new HttpError(400, 'invalid_session_id', 'session id has invalid URL encoding'); }
        const sessionId = requireFullSessionId(rawId);
        const action = sessionMatch[2] ?? null;

        // Manager toolkit：问题队列（`docs/manager-toolkit-plan.md` §3）。
        // 路径是**一层**的 `/sessions/{id}/questions`，answer/close 靠 body 里的 `op` 区分 ——
        // 这样宿主 `SESSION_PATH` 原样就能按 owner 转发（嵌套路径会落到兜底 proxy 到 current worker，
        // 给 draining 代持有的会话冷开第二个 runtime = 破“写 owner 唯一”；2026-09-20 业主选了这条不改宿主的路）。
        if (action === 'questions') {
          if (request.method === 'GET') {
            const status = url.searchParams.get('status') ?? 'open';
            if (!QUESTION_STATUSES.has(status)) throw new HttpError(400, 'invalid_status', `status must be one of open, answered, all: ${status}`);
            const rawLimit = url.searchParams.get('limit');
            let limit = QUESTION_LIMIT_DEFAULT;
            if (rawLimit !== null) {
              if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > QUESTION_LIMIT_MAX) {
                throw new HttpError(400, 'invalid_limit', `limit must be an integer between 1 and ${QUESTION_LIMIT_MAX}: ${rawLimit}`);
              }
              limit = Number(rawLimit);
            }
            sendJson(response, 200, await questionsView(sessionId, { status, limit }));
            return true;
          }
          if (request.method === 'POST') {
            const body = await readJson(request);
            const op = body?.op === undefined || body?.op === null ? 'ask' : body.op;
            if (op === 'ask') {
              // 问 = 写会话文件 ⇒ 需要 cwd 可用（只读会话能读不能改，如实 409 session_cwd_missing）。
              await assertSessionCwdAvailable(sessionId);
              const result = await askQuestion(sessionId, body);
              sendJson(response, result.created ? 201 : 200, result);
              return true;
            }
            if (op !== 'answer' && op !== 'close' && op !== 'update') {
              throw new HttpError(400, 'invalid_op', 'op must be one of ask, answer, close, update');
            }
            if (typeof body.qid !== 'string' || !QUESTION_ID_PATTERN.test(body.qid)) {
              throw new HttpError(400, 'invalid_question_id', `qid must look like q-<8 hex>: ${body.qid ?? '(missing)'}`);
            }
            await assertSessionCwdAvailable(sessionId);
            const result = op === 'answer'
              ? await answerQuestion(sessionId, body.qid, body)
              : op === 'close'
                ? await closeQuestion(sessionId, body.qid, body)
                : await updateQuestion(sessionId, body.qid, body);
            sendJson(response, 200, result);
            return true;
          }
          throw new HttpError(405, 'method_not_allowed', `method ${request.method} is not allowed for ${url.pathname}`);
        }

        const readonlyHistoryRequest = (request.method === 'GET' && (action === null || action === 'messages' || action === 'export'))
          || (request.method === 'HEAD' && action === 'export');
        // 「封存」**不过 cwd 那道门**：它只重写会话文件本身（不建 runtime、不碰 cwd），而它要服务的一类会话
        // 正是「cwd 已经没了的老会话」（业主 2026-09-22 的追加要求：老会话可能永远不会再压缩 ⇒ 用**已有那次**
        // 压缩的边界补做一次）。
        //
        // 「归档」是**同类判断**（业主 2026-09-22）：`sopho.archive` 只是会话文件里的一条**元数据**追加，
        // 不建 runtime、不碰 cwd ⇒ 目录已被删掉的老会话**照样能归档/取消归档**。于是这两条写路由与
        // `/message`、`/title`、`/compact`、`/spawn` … 分开：后者要「继续用这条会话」（建 runtime / 跑回合）
        // ⇒ cwd 不在就必须如实 409 `session_cwd_missing`（**门不许整体拆掉**）。`readOnly` 语义因此**不变**：
        // cwd 缺失的会话仍 readOnly（能读、不能继续），只是元数据账能动。
        //
        // 红半钩子（只给沙箱用）：`SOPHO_FAULT_ARCHIVE_NEEDS_CWD=1` 把归档的判据改回旧样子（= 与其它写
        // 一样过 cwd 门）⇒ 让「cwd 缺失时归档照常成功」那条绿断言确实有牙齿。不设时零影响。
        const archiveNeedsCwd = process.env.SOPHO_FAULT_ARCHIVE_NEEDS_CWD === '1';
        const metadataWriteRequest = request.method === 'POST'
          && (action === 'seal' || (action === 'archive' && !archiveNeedsCwd));
        if (!readonlyHistoryRequest && !metadataWriteRequest) await assertSessionCwdAvailable(sessionId);

        if (request.method === 'GET' && action === null) {
          // The owner may be a draining generation; the host tells us which generation
          // it considers current so pluginStale/logicStale stay honest from the host's
          // point of view, not from the owner's stale self-view.
          const ownerCurrent = request.headers['x-sopho-current-generation'];
          const gone = clientGoneSignal(request, response);
          try {
            sendJson(response, 200, await sessionDetail(sessionId, typeof ownerCurrent === 'string' ? ownerCurrent : null, gone.signal));
          } catch (error) {
            if (gone.signal.aborted) return true; // 客户端已经走了：没有响应可写，也没有 500 该回
            throw error;
          } finally {
            gone.dispose();
          }
          return true;
        }
        if ((request.method === 'GET' || request.method === 'HEAD') && action === 'export') {
          await sendSnapshot(request, response, sessionId);
          return true;
        }
        if (request.method === 'GET' && action === 'messages') {
          const gone = clientGoneSignal(request, response);
          try {
            // `?after=<entryId>` 是**可选**的增量游标：不传 ⇒ null ⇒ 这一条路由的行为逐字节照旧。
            const rawAfter = url.searchParams.get('after');
            const after = rawAfter === null ? null : requireText(rawAfter, 'after');
            if (after !== null && after.length > 128) throw new HttpError(400, 'invalid_after', 'after must be an entry id (at most 128 characters)');
            const entry = await messageResponseBody(sessionId, gone.signal, after);
            sendJsonText(response, 200, entry.body, entry.contentLength, {
              etag: entry.etag,
              entry,
              label: sessionId,
            });
          } catch (error) {
            if (gone.signal.aborted) return true;
            throw error;
          } finally {
            gone.dispose();
          }
          return true;
        }
        if (request.method === 'GET' && action === 'events') {
          await sessionEvents(request, response, sessionId);
          return true;
        }
        if (request.method === 'GET' && action === 'commands') {
          const value = await withSession(sessionId, (handle) => inspectAdapter(handle, async (adapter) => {
            const snapshot = adapter.snapshot();
            return {
              sessionId,
              streaming: snapshot.isStreaming,
              compacting: snapshot.isCompacting,
              canRun: !snapshot.isStreaming && !snapshot.isCompacting,
              ...await adapter.commands(),
            };
          }));
          sendJson(response, 200, value);
          return true;
        }
        if (request.method === 'GET' && action === 'models') {
          const value = await withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => adapter.models()));
          sendJson(response, 200, { sessionId, hot: true, error: null, ...value });
          return true;
        }
        if (request.method === 'PATCH' && action === null) {
          await assertNotMoved(sessionId);
          sendJson(response, 200, await mutateSession(sessionId, await readJson(request)));
          return true;
        }
        if (request.method === 'POST' && action === 'title') {
          await assertNotMoved(sessionId);
          const body = await readJson(request);
          // 兼容两种入参形状：v2.1 的 `{title}`（插件工具 session_set_title 走这条）与 v2.2 的 `{name}`。
          const requested = body.title !== undefined ? body.title : body.name;
          if (typeof requested !== 'string') throw new HttpError(400, 'invalid_title', 'title must be a string');
          // source 只接 auto（模型/自动）；seed 是内部 L0 那条路，manual 只由 PATCH / 对账产生。
          const result = await withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => applyTitle(adapter, { title: requested, source: 'auto' })));
          sendJson(response, result.ok ? 200 : result.reason === 'no-session' ? 404 : 409, { id: sessionId, ...result });
          return true;
        }
        if (request.method === 'POST' && action === 'archive') {
          await assertNotMoved(sessionId);
          const body = await readJson(request);
          if (body.archived !== undefined && typeof body.archived !== 'boolean') throw new HttpError(400, 'invalid_archived', 'archived must be a boolean');
          const archived = body.archived ?? true;
          // `by` = 调用方（agent 工具）**自报**的会话 id，只用于**审计**（落进条目的 by/at）——
          // **不构成任何权限/范围限制**：路由接受的目标范围与以前一模一样（任意会话、只认完整 uuid）。
          let by = null;
          if (body.by !== undefined && body.by !== null) by = requireFullSessionId(body.by);
          const result = await archiveSession(sessionId, { archived, by });
          sendJson(response, 200, result);
          if (archived && result.changed) void exportSnapshot(sessionId).catch((error) => console.error(`[snapshot] archive export failed for ${sessionId}: ${normalizeError(error).message}`));
          return true;
        }
        if (request.method === 'POST' && action === 'move') {
          const body = await readJson(request);
          sendJson(response, 201, await queueSessionCreate(() => moveSession(sessionId, body)));
          return true;
        }
        if (request.method === 'POST' && action === 'seal') {
          // 「压缩即封存」的显式入口（设置里关掉自动触发时用它；也是门的确定性入口）。
          //
          // **边界可以点名**（业主 2026-09-22 的追加要求）：老会话可能永远不会再压缩 ⇒ 要能用**已有那次**
          // 压缩的边界补做一次封存。body 里可选 `compactionEntryId`（用这一条 compaction 条目）与
          // `firstKeptEntryId`（直接点名边界；同一个边界有多条摘要时取最新那条）。两个都不给 = 链上最后那条
          // compaction（自动触发走的就是它）。**不是两套机制**：三种选法都落到同一个 `{C, K}`（`sealPlanOf`）。
          // 收据形状：`sealed:true` + 热/冷两段的字节与条数 + `boundary{source, requested, …}` + 备份路径；
          // `sealed:false` + `reason` 就是「什么都没做」（一个字节都没动，含边界点名错的情形）。
          // 回合没落定 / 有人拿着 runtime 收不掉 ⇒ 409 `session_busy_move`（与 `/move` 同码同判据）。
          const body = await readJson(request);
          const optionalEntryId = (value, field) => {
            if (value === undefined || value === null) return null;
            if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
              throw new HttpError(400, `invalid_${field}`, `${field} must be a session entry id (a non-empty string of at most 128 characters)`);
            }
            return value;
          };
          const receipt = await sealSession(sessionId, {
            trigger: body?.trigger === 'auto' ? 'auto' : 'manual',
            compactionEntryId: optionalEntryId(body?.compactionEntryId, 'compaction_entry_id'),
            firstKeptEntryId: optionalEntryId(body?.firstKeptEntryId, 'first_kept_entry_id'),
          });
          sendJson(response, 200, receipt);
          return true;
        }
        if (request.method === 'POST' && action === 'handoff') {
          const body = await readJson(request);
          // Not wrapped in queueSessionCreate: handoffSession calls createDelegatedSession,
          // which queues itself. Wrapping both would make the inner queue wait on the outer.
          sendJson(response, 200, await handoffSession(sessionId, body));
          return true;
        }
        if (request.method === 'POST' && action === 'model') {
          await assertNotMoved(sessionId);
          const body = await readJson(request);
          const hasModel = body.model !== undefined;
          const hasThinking = body.thinkingLevel !== undefined;
          if (!hasModel && !hasThinking) throw new HttpError(400, 'invalid_model', 'model must be a non-empty string');
          const wantedModel = hasModel ? requireText(body.model, 'model').trim() : undefined;
          if (hasThinking && (typeof body.thinkingLevel !== 'string' || !THINKING_LEVELS.has(body.thinkingLevel))) {
            throw new HttpError(400, 'invalid_thinking_level', `thinkingLevel must be one of ${[...THINKING_LEVELS].join(', ')}`, {
              levels: [...THINKING_LEVELS],
            });
          }
          const result = await withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => adapter.setModelAndThinking({
            model: wantedModel,
            thinkingLevel: hasThinking ? body.thinkingLevel : undefined,
          })));
          sendJson(response, 200, { ok: true, sessionId, ...result });
          return true;
        }
        if (request.method === 'POST' && action === 'message') {
          await assertNotMoved(sessionId);
          const { text, images } = await readMessageInput(request);
          const accepted = await withSession(sessionId, async (handle) => {
            await inspectAdapter(handle, (adapter) => rejectStreamingCommand(adapter, text));
            // L0：还没有名字的会话，用这第一条 user 消息的第一行做标题（放在 prompt 之前）。
            await inspectAdapter(handle, (adapter) => seedTitleIfUnnamed(adapter, text));
            const started = await inspectAdapter(handle, (adapter) => adapter.startPrompt(text, images));
            await started.accepted;
            return true;
          });
          sendJson(response, 202, { accepted, sessionId, ...(images.length > 0 ? { images: images.length } : {}) });
          return true;
        }
        // Dev-only acceptance hook: HTTP requests cannot enter pi in the same tick, so
        // this creates that exact pressure inside one worker. Every item still goes
        // through the per-session exclusive gate; after the first starts, later items
        // become steering messages instead of receiving a false 202 and disappearing.
        if (request.method === 'POST' && action === 'dev-burst') {
          await assertNotMoved(sessionId);
          const body = await readJson(request);
          const count = Math.max(1, Math.min(50, Number(body.n ?? 2)));
          const prefix = typeof body.text === 'string' && body.text.trim() !== '' ? body.text : 'burst';
          const results = await Promise.all(Array.from({ length: count }, (_, index) => withSession(sessionId, (handle) => inspectAdapter(
            handle,
            (adapter) => adapter.deliver(`${prefix}-${index}`),
          ))));
          sendJson(response, 200, { sessionId, n: count, results });
          return true;
        }
        if (request.method === 'POST' && action === 'steer') {
          await assertNotMoved(sessionId);
          const { text, images } = await readMessageInput(request);
          await withSession(sessionId, (handle) => inspectAdapter(handle, async (adapter) => {
            await rejectStreamingCommand(adapter, text);
            await adapter.steer(text, images);
          }));
          sendJson(response, 202, { accepted: true, mode: 'steer', sessionId, ...(images.length > 0 ? { images: images.length } : {}) });
          return true;
        }
        if (request.method === 'POST' && (action === 'follow-up' || action === 'followUp')) {
          await assertNotMoved(sessionId);
          const text = requireText((await readJson(request)).text);
          await withSession(sessionId, (handle) => inspectAdapter(handle, async (adapter) => {
            await rejectStreamingCommand(adapter, text);
            await adapter.followUp(text);
          }));
          sendJson(response, 202, { accepted: true, mode: 'followUp', sessionId });
          return true;
        }
        if (request.method === 'POST' && action === 'abort') {
          const outcome = await withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => adapter.abort()));
          // 兼容两种形状：新的 `{aborted, reason, retryable?}` 与旧的布尔。**超时决不算成功**：
          // `aborted:false` + `reason:'abort_timeout'` + `retryable:true` 就是「这次没停掉」，
          // 调用方（页面那颗停止按钮）必须能看出这个区别，不许把「超时」显示成「已停止」。
          const aborted = outcome === true || outcome?.aborted === true;
          const reason = typeof outcome === 'object' && outcome !== null && typeof outcome.reason === 'string'
            ? outcome.reason
            : (aborted ? 'aborted' : 'not_running');
          sendJson(response, 200, {
            sessionId,
            aborted,
            reason,
            ...(outcome?.retryable === true ? { retryable: true } : {}),
          });
          return true;
        }
        if (request.method === 'POST' && action === 'compact') {
          await assertNotMoved(sessionId);
          const body = await readJson(request);
          if (body.instructions !== undefined && typeof body.instructions !== 'string') {
            throw new HttpError(400, 'invalid_instructions', 'instructions must be a string');
          }
          await withSession(sessionId, (handle) => inspectAdapter(handle, (adapter) => {
            adapter.startCompaction(body.instructions);
          }));
          sendJson(response, 202, { accepted: true, sessionId });
          return true;
        }
        throw new HttpError(405, 'method_not_allowed', `method ${request.method} is not allowed for ${url.pathname}`);
      } catch (error) {
        const failure = normalizeError(error);
        const statusCode = error?.statusCode ?? 500;
        const value = typeof error?.toJSON === 'function'
          ? error.toJSON()
          : {
            error: statusCode === 500 ? 'internal_error' : error?.code ?? 'request_failed',
            message: failure.message,
            ...(error?.details === undefined ? {} : { details: error.details }),
          };
        if (!response.headersSent) sendJson(response, statusCode, value);
        else if ((response.getHeader('content-type') || '').toString().startsWith('text/event-stream')) {
          sseWrite(response, 'server.error', { type: 'server.error', message: failure.message });
          response.end();
        }
        return true;
      }
    },

    getHostStatus() {
      return hostStatusReport();
    },

    // 显式、非破坏的回收入口（宿主 POST /reclaim 经 IPC 问每个活着的代）。
    // 只收闲置 runtime；在跑的一律拒绝并把事实列出来。
    async reclaimIdle(input = null) {
      const value = input && typeof input === 'object' ? input : {};
      const streamsEndedBefore = sseStreamsEndedByEvict;
      const result = await pool.reclaimIdle({
        dryRun: value.dryRun === true,
        includePinned: value.includePinned === true,
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
      });
      return { ...result, generationId, workerPid: process.pid, sessionSseStreamsEnded: sseStreamsEndedByEvict - streamsEndedBefore };
    },

    async drainToGeneration(targetGenerationId) {
      await pool.drainToGeneration(targetGenerationId);
      return pool.summary();
    },

    liveRuntimes() {
      return pool.liveRuntimes();
    },

    drainBusy() {
      return pool.drainBusy();
    },

    drainBlockers() {
      return pool.drainBlockers();
    },

    hotSessions,

    liveSessionFacts,

    parentSessionFact,

    createDelegatedSession,

    deliverDelegationMessage,

    delegationSessionRead,

    async probeRoute(sessionId) {
      if (typeof sessionId !== 'string' || !FULL_UUID.test(sessionId)) {
        return { sessionId: String(sessionId ?? null), generationId, phase: 'invalid' };
      }
      const record = pool.getSession(sessionId);
      if (!record || !record.owner) return { sessionId, generationId, phase: 'cold' };
      return { sessionId, generationId, phase: 'hot', owner: record.owner, runtimeState: record.runtimeState, durable: record.durable };
    },

    async dispose() {
      for (const response of openSseResponses) {
        sseWrite(response, 'server.reload', { type: 'server.reload', retry: true });
        response.end();
      }
      openSseResponses.clear();
      treeListeners.clear();
      await pool.close();
    },
  };
}
