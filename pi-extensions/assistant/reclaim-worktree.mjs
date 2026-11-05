/**
 * reclaim-worktree —— 「创建者负责生命周期」那条**受守卫的回收路径**（本仓只有这一条）。
 *
 * ── 为什么要它（2026-09-24 的真实事故，维护者干的）─────────────────────────────────────────
 * 当时用两条判据筛「可删的 worktree」：①分支已是 `origin/master` 的祖先 ②`/tree` 的 `cwd` 字段不在活会话里
 * ⇒ **删掉了一个正干活、尚未提交的子会话的 cwd**（未提交改动不可恢复；主线未受损）。
 * 两条判据都不可靠：①「是祖先」只看得见**已提交**的内容（未提交的工作区改动完全不在里面 ✗）；
 * ②`/tree` 的 `cwd` 字段**实测会缺**（当时返回 0，而确实有两个子会话在那个目录下跑 ✗）。
 *
 * ── 谁创建的（决定了「创建者那一层」是谁）────────────────────────────────────────────────────
 * 是真的宿主在创建：`server/base.mjs` 的 `createWorktree()`（`git worktree add -b wt/<slug> … HEAD`），
 * 由 spawn 路由调用（`body.worktree === "new"`），失败时由同一个文件里的 `removeCreatedWorktree()` 回滚；
 * agent 面向的入口是插件工具 `spawn`（POST `/sessions/{id}/spawn`）。所以**回收必须做在同一层**：
 * 宿主那半要新增顶层路由、要重启宿主才生效（`AGENTS.md` 明写「宿主 server/base.mjs 的改动攒批、由人在终端做」），
 * 而插件 runtime 就在同一台机器上（`device_run` 已经在本进程里起过子进程），`git` 够得着 ⇒ 这条路放在插件侧。
 * ⇒ 代价（如实说）：本工具**没有**创建者的持久账本可查，所有事实都从 **git 与出题那两种一手来源**重新量出来
 *   （会话文件 header / `git worktree list` / `git status` / `git diff`），并把每一步的实测值原样写进回执。
 *
 * ── 判据（按顺序，缺一即**如实拒绝**，绝不静默降级）────────────────────────────────────────────
 *  a) 目标会话存在且**已归档**（`sopho.archive` 的最新一条；老账 `archive.json` 只作兼容）——「人不看了」是回收的前提；
 *  b) 目标 cwd 是**本仓已注册的 worktree**（`git worktree list` 能查到），且**不是主树**（`git-common-dir` 判）、
 *     且**有分支**（detached HEAD 拒绝：没有分支就没有「已并入」这件事可判）；
 *  c) **没有任何会话的 cwd 落在它里面（含子目录）**——判据的一手来源是**会话文件里的 `cwd` 字段**
 *     （`$ASSIST_HOME/sessions/**\/*.jsonl` 的 header），**绝不**用 `/tree` 之类投影字段 ✗（就是它骗了那一次）；
 *     另外加一份**只增不减**的交叉源：宿主 `/host` 报的活会话 id 里，凡是**看不到 header**（还没落盘）的，
 *     再用**第二份一手来源**——`placement.json` 里这条会话的 `cwd`（落位账；与 `server/base-logic.mjs` 的
 *     `readPlacement`／`PLACEMENT_FIELDS`／`PLACEMENT_KINDS` 同一口径，本文件只读它、不另造一套）——把
 *     「不知道」变成「知道」：
 *       · 有 `cwd` 且落在目标树里 ⇒ 它是**占用者** ⇒ 拒（这一半绝不放松 ✗）；
 *       · 有 `cwd` 且不在目标树里 ⇒ 不再因它拒（它压根不住这棵树里）；
 *       · 没有这条 id／`cwd` 缺失或不可解析 ⇒ **照旧拒**（那仍然是「猜」的地方，不许猜 ✗）；
 *     回执写明用的是哪份来源（`liveProbe.unknownCwdResolvedFrom` ＋ 逐条 `{id,cwd,source}`）—— 不许静默 ✗；
 *     `placement.json` 里 `claimedBy` 的会话（已搬家）不再占用旧 cwd，否则搬过家的 worktree 永远收不掉；
 *  d) **内容安全**：分支**已并入**基准（`origin/master`，退化到 `master`）**或**与基准**零差异**
 *     （`git diff --numstat`，不只看祖先 ✗）；并且工作区**不脏**（`git status --porcelain`，未提交改动正是那次被丢的东西 ✗），
 *     连**被 .gitignore 忽略的内容**也算在内（忽略路径里也可能埋着别人的半成品；唯一豁免是 `node_modules` 那层
 *     指向主检出的目录联接 —— 那是本仓自己的约定，不是谁的作品）；
 *  e) 通过才 `git worktree remove`：**先 unlink 里面的 `node_modules` 联接**（junction / symlink 绝不穿过 ✗，
 *     穿过去就删到主树了），再删目录；**按内容安全情况**决定分支删不删（c/d 任一不满足 ⇒ 不删分支）。
 *
 * 回执**如实**：每一步判据的实测值（哪个会话在占、差异多少行、脏了几个文件）＋结果；**幂等**（目录与分支都已不在 ⇒
 * `alreadyReclaimed`，`changed:false`）；id 非法 / 不存在 ⇒ 如实报错。`force:true` 只放宽 (d)（与「看不了活会话」那条
 * 工具性失败），**不放宽 (c)**，且回执里逐字写明丢了什么。
 *
 * ── 「未并入」那几个数字的**说话口径**（2026-10-11 与 `worktree-hint.mjs` 统一；**判据一个字不改**）──────────
 * 为什么：原来同一个回执里两个数字描述的不是同一件事 —— 提交数走**两点** `rev-list --count base..branch`（= 这条分支
 * **自己**多出来的提交 ✓），文件数却走 `diff base..branch`（也是两点，但 `git diff A B` 量的是**两条 tip 的差异**）
 * ⇒ 基点旧时把基准侧整段历史算成「它留下的」。实测误导过：一条分支被报成「1 个提交 / 322 个文件」，而它自己那一笔
 * 只改了 1 个文件 140 行 ✗。现在一律分开说，读的人必须先分清这两件事：
 *   · **它自己的改动**：`commitsAhead` = `rev-list --count <base>..<branch>`（两点）＋ `own.files/added/deleted`
 *     = `diff --numstat <base>...<branch>`（**三点** = merge-base → 分支 tip）⇒ 与提交数描述**同一件事**；
 *   · **并进基准的整体变化**：`vsMasterTwoDot` = `diff --numstat <base>..<branch>`（**两条 tip 的差异**）——名字自述，
 *     **绝不**混进上面那组冒充「它自己的改动」；
 *   · `mergeBase{sha,date}` = 分叉点：把「它有多旧」摊在明面上（数字为何是这样一眼可见）。
 * ⚠️ 判据 (d) 仍然只看**原来那两条**（祖先 ∨ 与基准**零差异**，两点 diff ⇒ 并进去不带来变化）：本口径只改
 *    **它怎么说话**，没有动任何一条回收 / 删除语义。
 */

import { execFile } from "node:child_process";
import { lstat, open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ARCHIVE_ENTRY = "sopho.archive";
/** 基准引用的候选顺序：先 `origin/master`（主口径），退化到本地 `master`（没有远端时也能判，回执写明用了哪个）。 */
export const BASE_REF_CANDIDATES = ["origin/master", "refs/remotes/origin/master", "master", "refs/heads/master"];

const SESSION_SUFFIX = ".jsonl";
const HEADER_MAX_BYTES = 1 << 20;
const ARCHIVE_TAIL_BYTES = 256 * 1024;
const DIRTY_SAMPLE_LIMIT = 20;
const DIFF_SAMPLE_LIMIT = 20;

/** 本机/环境里的 agent home（与 `server/base-logic.mjs` 同优先级）。 */
export function agentDirOf(env = process.env) {
  return path.resolve(env.PI_CODING_AGENT_DIR || env.ASSIST_HOME || env.SOPHO_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

/** 会话文件住哪（与 `server/base-logic.mjs` 的 `sessionsRoot` 同一条式子）。 */
export function sessionsRootOf(env = process.env) {
  return path.resolve(env.SOPHO_SESSION_DIR || env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDirOf(env), "sessions"));
}

/** 比路径用：Windows 上大小写不敏感，统一小写比较（对齐前先 `realpath`，见 `resolveExisting`）。 */
export function normalizeFsPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** candidate 是否等于 root 或落在 root 里面（用 `path.relative`，不做字符串前缀比较）。 */
export function pathInsideOrEqual(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 目录在盘上就先 `realpath`（消掉短名/联接差异），不在就退回 `path.resolve`。 */
export async function resolveExisting(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

/** 跑一次 git，**不抛**：回执里要的是真实退出码与 stderr。 */
export async function runGit(args, cwd) {
  return await new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({
        code,
        ok: !error,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        error: error ? String(error.message ?? error) : null,
      });
    });
  });
}

/** 只读文件的第一行（会话 header；累积 Buffer 到切出 `\n` 再解码，避免多字节被切在中间 ⇒ 假 invalid）。 */
export async function readFirstLine(file) {
  const handle = await open(file, "r");
  try {
    const chunks = [];
    let total = 0;
    while (total < HEADER_MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, HEADER_MAX_BYTES - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      if (buffer.subarray(0, bytesRead).includes(10)) break; // 10 = '\n'
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const cut = text.indexOf("\n");
    return cut >= 0 ? text.slice(0, cut) : text;
  } finally {
    await handle.close();
  }
}

/** `sessions/**\/*.jsonl`（不跟符号链接目录；`sessionsRoot` 下按 git 那样扁平存也照样找得到）。 */
export async function listSessionFiles(root) {
  const files = [];
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(SESSION_SUFFIX)) files.push(full);
    }
  };
  await walk(root);
  return files.sort();
}

/**
 * 扫出「盘上有会话文件的会话」的 (id, cwd, file)。
 * 一手来源 = **会话文件自己的 header**（不是 `/tree` 那种投影字段）。
 */
export async function scanSessionHeaders(root) {
  const files = await listSessionFiles(root);
  const sessions = [];
  const skipped = [];
  for (const file of files) {
    let header = null;
    let raw = null;
    try {
      raw = await readFirstLine(file);
      header = JSON.parse(raw);
    } catch (error) {
      skipped.push({ file, reason: `first line is not a session header: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (!header || header.type !== "session" || typeof header.id !== "string") {
      skipped.push({ file, reason: `first line type=${header?.type ?? "(none)"} (no session header)` });
      continue;
    }
    sessions.push({
      id: header.id.toLowerCase(),
      cwd: typeof header.cwd === "string" ? header.cwd : null,
      parentSession: header.parentSession ?? null,
      createdAt: header.timestamp ?? null,
      file,
    });
  }
  return { files: files.length, sessions, skipped };
}

/** `placement.json`（`claimedBy` = 这条会话已经搬去别的会话了）。读不出来就退成空账 —— 方向是安全的（只会少豁免）。 */
export async function readPlacement(agentDir) {
  try {
    const value = JSON.parse(await readFile(path.join(agentDir, "placement.json"), "utf8"));
    if (value && typeof value === "object") return { ok: true, value };
    return { ok: false, value: {}, error: "placement.json is not a JSON object" };
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return { ok: missing, value: {}, error: missing ? null : String(error?.message ?? error) };
  }
}

/** v2.1 的老归档账（`archive.json`）：只在会话文件里一条 `sopho.archive` 都没有时才用它。 */
export async function readLegacyArchiveIds(agentDir) {
  try {
    const value = JSON.parse(await readFile(path.join(agentDir, "archive.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ids: null, present: true, error: "archive.json is not a JSON object" };
    return { ids: new Set(Object.keys(value).map((id) => id.toLowerCase())), present: true, error: null };
  } catch (error) {
    const missing = error?.code === "ENOENT";
    // 老账读不出来 ⇒ 退成“没有豁免”（只会多拒一次，方向是安全的），但**如实说出来**（回执里有 present/error）。
    return { ids: null, present: !missing, error: missing ? null : String(error?.message ?? error) };
  }
}

/** 一条行是不是 `sopho.archive` 自定义条目；是就回 `data`。 */
function archiveDataOfLine(line) {
  if (!line.includes(ARCHIVE_ENTRY)) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry?.type !== "custom" || entry.customType !== ARCHIVE_ENTRY) return null;
  return entry.data ?? {};
}

/**
 * 会话「归档了没有」= **最后一条** `sopho.archive`（append-only，后写的赢）。
 * 先只读尾巴（快），尾巴里没有才整文件读一遍（长文件 + 小条目也不会漏，只是那次慢一点）。
 */
export async function latestArchiveState(file, { legacyArchived = null, sessionId = null } = {}) {
  let data = null;
  let lines = 0;
  let scanned = "tail";
  const readText = async (from) => {
    if (from === null) return (await readFile(file)).toString("utf8");
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      const start = Math.max(0, info.size - from);
      const buffer = Buffer.alloc(info.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  };
  const scan = (text, dropFirstLine) => {
    const rows = text.split(/\r?\n/);
    if (dropFirstLine && rows.length > 1) rows.shift(); // 尾巴从行中间切进来 ⇒ 第一行是半行
    let found = null;
    let count = 0;
    for (const row of rows) {
      if (row.length === 0) continue;
      count += 1;
      const hit = archiveDataOfLine(row);
      if (hit) found = hit;
    }
    return { found, count };
  };
  const info = await stat(file);
  if (info.size > ARCHIVE_TAIL_BYTES) {
    const tail = scan(await readText(ARCHIVE_TAIL_BYTES), true);
    data = tail.found;
    lines = tail.count;
  }
  if (data === null) {
    const full = scan(await readText(null), false);
    data = full.found;
    lines = full.count;
    scanned = info.size > ARCHIVE_TAIL_BYTES ? "full" : "whole-file";
  }
  if (data === null && legacyArchived && sessionId && legacyArchived.has(sessionId)) {
    return { archived: true, present: true, source: "legacy-archive.json", lines, scanned };
  }
  if (data === null) return { archived: false, present: false, source: null, lines, scanned };
  return { archived: data.archived === true, present: true, source: "session-file", lines, scanned };
}

/** `git worktree list --porcelain` 解析（每段：`worktree <path>` / `HEAD <sha>` / `branch <ref>` / 旗标）。 */
export async function listWorktrees(mainRepo) {
  const result = await runGit(["worktree", "list", "--porcelain"], mainRepo);
  if (!result.ok) return { ok: false, entries: [], code: result.code, stderr: result.stderr.trim() };
  const entries = [];
  let current = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), head: null, branchRef: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice(5).trim();
    else if (line.startsWith("branch ")) {
      current.branchRef = line.slice(7).trim();
      current.branch = current.branchRef.replace(/^refs\/heads\//, "");
    } else if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
    else if (line.startsWith("locked")) current.locked = true;
    else if (line.startsWith("prunable")) current.prunable = true;
  }
  return { ok: true, entries, code: 0, stderr: "" };
}

/** 基准引用：按 `BASE_REF_CANDIDATES` 找第一个能解析的，回它和它的 sha（回执里要写明用了哪个）。 */
export async function resolveBaseRef(repo, candidates = BASE_REF_CANDIDATES) {
  const tried = [];
  for (const ref of candidates) {
    const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo);
    if (resolved.ok && resolved.stdout.trim() !== "") {
      return { ref, sha: resolved.stdout.trim(), tried };
    }
    tried.push(ref);
  }
  return { ref: null, sha: null, tried };
}

function numstatSummary(stdout) {
  let files = 0;
  let added = 0;
  let deleted = 0;
  let binary = 0;
  const sample = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [rawAdded, rawDeleted, ...rest] = line.split("\t");
    files += 1;
    const file = rest.join("\t");
    if (rawAdded === "-" || rawDeleted === "-") binary += 1;
    else {
      added += Number(rawAdded) || 0;
      deleted += Number(rawDeleted) || 0;
    }
    if (sample.length < DIFF_SAMPLE_LIMIT) sample.push(file);
  }
  return { files, added, deleted, binary, sample };
}

/**
 * 内容安全判据（**差异**，不是只判祖先）＋**报给人看的那组读数**（与 `worktree-hint.mjs` 同一套口径）。
 *
 * ⚠️ 判据那一条**一个字不改**：`contentSafe = 祖先 ∨ 与基准零差异`，而「零差异」量的就是**两点**
 *    `diff <base>..<branch>`（两条 tip 的差异 ⇒ 并进去不带来变化）。本单只改「它说话的方式」：
 *    另加 `own`（**三点** = 它自己的改动）、`commitsAhead`、`mergeBase`，并把两点那份留在 `vsMasterTwoDot`
 *    （名字自述：「并进基准会带来多少变化」，**不是**它自己的改动）。
 */
export async function inspectContent({ repo, branchRef, baseRef }) {
  const ancestor = await runGit(["merge-base", "--is-ancestor", branchRef, baseRef], repo);
  const isAncestor = ancestor.code === 0;
  // 判据用这一条（两点 = 两条 tip 的差异）：为 0 ⇒ 并进基准不带来变化 ⇒ 内容安全。
  const twoTipRun = await runGit(["diff", "--numstat", `${baseRef}..${branchRef}`], repo);
  const vsMasterTwoDot = twoTipRun.ok ? numstatSummary(twoTipRun.stdout) : null;
  // 「它自己的改动」那一组（**三点** = merge-base → 分支 tip）＋ 提交数（两点）＋ 分叉点。
  const countRun = await runGit(["rev-list", "--count", `${baseRef}..${branchRef}`], repo);
  const ownRun = await runGit(["diff", "--numstat", `${baseRef}...${branchRef}`], repo);
  const own = ownRun.ok ? numstatSummary(ownRun.stdout) : null;
  const mergeBaseRun = await runGit(["merge-base", baseRef, branchRef], repo);
  const mergeBaseSha = mergeBaseRun.ok ? mergeBaseRun.stdout.trim() : "";
  const mergeBase = mergeBaseSha === "" ? null : { sha: mergeBaseSha, date: await mergeBaseDate(repo, mergeBaseSha) };
  const readingErrors = [
    countRun.ok ? null : `git rev-list --count 失败：${countRun.stderr.trim() || `exit ${countRun.code}`}`,
    ownRun.ok ? null : `git diff（三点：它自己的改动）失败：${ownRun.stderr.trim() || `exit ${ownRun.code}`}`,
    mergeBase === null ? (mergeBaseRun.ok ? "git merge-base 没给出分叉点（输出为空）" : `git merge-base 失败：${mergeBaseRun.stderr.trim() || `exit ${mergeBaseRun.code}`}`) : null,
  ].filter((value) => value !== null);
  return {
    branchRef,
    baseRef,
    ancestor: isAncestor,
    diffOk: twoTipRun.ok,
    diffError: twoTipRun.ok ? null : twoTipRun.stderr.trim(),
    // 两点（两条 tip 的差异）= 「并进基准会带来多少变化」——判据用它，回执里另存、名字自述。
    vsMasterTwoDot,
    zeroDiff: vsMasterTwoDot !== null && vsMasterTwoDot.files === 0,
    contentSafe: isAncestor || (vsMasterTwoDot !== null && vsMasterTwoDot.files === 0),
    // 报给人看的那组（**与 commitsAhead 描述同一件事** = 它自己的改动）。量不出来一律 null（如实，不猜）。
    commitsAhead: countRun.ok ? (Number(countRun.stdout.trim()) || 0) : null,
    own,
    mergeBase,
    readingError: readingErrors.length === 0 ? null : readingErrors.join("；"),
  };
}

/** 分叉点那一刻的日期（量不出来就 null —— 如实，不猜）。 */
async function mergeBaseDate(repo, sha) {
  const when = await runGit(["log", "-1", "--format=%ci", sha], repo);
  return when.ok ? when.stdout.trim() : null;
}

/**
 * 回执里「未并入」那一组的**唯一**形状（与 `worktree-hint.mjs` 的 `unmerged` 同一套口径）：
 *   · `commitsAhead` / `files` / `added` / `deleted` —— **它自己的改动**（两点提交数 ＋ 三点文件数 = 同一件事）；
 *   · `vsMasterTwoDot` —— 「并进基准会带来多少变化」＝**两条 tip 的差异**（**不是**它自己的改动，名字自述）；
 *   · `mergeBase{sha,date}` —— 分叉点（数字为何是这样，一眼可见）。
 * 量不出来的一律 null（如实，不猜）＋ `readingError` 写清为什么。
 */
export function unmergedReportOf({ branch = null, baseRef, content }) {
  const own = content?.own ?? null;
  const twoTip = content?.vsMasterTwoDot ?? null;
  return {
    branch,
    baseRef,
    commitsAhead: content?.commitsAhead ?? null,
    files: own?.files ?? null,
    added: own?.added ?? null,
    deleted: own?.deleted ?? null,
    sample: own?.sample ?? null,
    vsMasterTwoDot: twoTip === null ? null : { files: twoTip.files, added: twoTip.added, deleted: twoTip.deleted },
    mergeBase: content?.mergeBase ?? null,
    basis: "它自己的改动 = `git diff --numstat <base>...<branch>`（三点 = merge-base → 分支 tip）＋ `git rev-list --count <base>..<branch>`（两点）；vsMasterTwoDot = `git diff --numstat <base>..<branch>`（两条 tip 的差异）",
    readingError: content?.readingError ?? null,
  };
}

/**
 * 「未并入」那句话：**同一套口径**（先说它自己的改动，再另说并进基准的整体变化）。
 * 量不出来就如实降级，绝不猜；措辞与 `worktree-hint.mjs` 的 `worktreeNote()` 逐字同源。
 */
export function unmergedPhrase({ baseRef, content }) {
  if (content?.commitsAhead === null || content?.commitsAhead === undefined || content?.own === null || content?.own === undefined) {
    return `未并入 ${baseRef} 的计数量不出来：${content?.readingError ?? "未知原因"}（如实说，不猜）`;
  }
  const own = content.own;
  const mergeBase = content.mergeBase?.sha
    ? `，分叉点 ${content.mergeBase.sha.slice(0, 12)}（${content.mergeBase.date ?? "日期读不到"}）`
    : "，分叉点没量出来（如实说，不猜）";
  const overall = content.vsMasterTwoDot === null
    ? ""
    : `；另外、**不是它自己的改动**：并进 ${baseRef} 会带来 ${content.vsMasterTwoDot.files} 个文件的变化（+${content.vsMasterTwoDot.added} -${content.vsMasterTwoDot.deleted}）—— 那是**两条 tip 的差异**（基点旧 ⇒ 基准侧那段历史也算进来了）`;
  return `未并入 ${baseRef} 的提交 ${content.commitsAhead} 个 —— 这 ${content.commitsAhead} 个提交自己改了 ${own.files} 个文件（+${own.added} -${own.deleted}）${mergeBase}${overall}`;
}

/**
 * 工作区脏不脏 —— **未提交改动**正是那次事故被丢掉的东西（祖先判据完全看不见它 ✗）。
 *
 * `--ignored=matching` 顺手把**被 .gitignore 忽略的内容**也列出来（只列到目录那一层，不递归进里面）：
 * 忽略路径里也可能埋着人家没提交的半成品 ⇒ 默认也算不安全。
 * 唯一豁免：路径里有 `node_modules` —— 那是本仓自己的约定（对主检出的目录联接，见 `docs/handoff.md`），
 * 不是谁的作品，且 `(e)` 里会先把这层联接 unlink 掉。
 */
export async function inspectDirty(worktreePath) {
  const status = await runGit(["status", "--porcelain", "--ignored=matching"], worktreePath);
  if (!status.ok) {
    return { ok: false, count: null, sample: [], ignored: null, error: status.stderr.trim() || `git status exited ${status.code}` };
  }
  const tracked = [];
  const ignored = [];
  for (const line of status.stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (!line.startsWith("!!")) {
      tracked.push(line);
      continue;
    }
    const target = line.slice(2).trim().replace(/^"|"$/g, "");
    if (target.split(/[\\/]/).includes("node_modules")) continue;
    ignored.push(line);
  }
  return {
    ok: true,
    count: tracked.length,
    sample: tracked.slice(0, DIRTY_SAMPLE_LIMIT),
    ignored: { count: ignored.length, sample: ignored.slice(0, DIRTY_SAMPLE_LIMIT), note: "ignored entries whose path contains node_modules are not counted (the documented junction-to-main-tree shape)" },
    error: null,
  };
}

/**
 * 宿主 `/host` 报的活会话 id —— **只增不减的交叉源**（拿不到就如实说拿不到）。
 *
 * ⚠️ 读的是 `/host` 的真实形状：`workers[]`（当前代）＋ `drainingGenerations[]`（排空中的代），每项一个 `sessions[]`
 * （= 宿主自己的 `sessionOwners`）。**形状不认识时回 ok:false**，绝不回一个「0 条活会话」的假读数 ✗
 * —— 那条假读数正是这次要防的事故形状（`/tree` 的 `cwd` 字段当时就返回了 0）。
 */
export async function probeLiveSessions(baseUrl, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/host`, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) return { ok: false, ids: [], error: `GET /host answered ${response.status}`, shape: null };
    const value = await response.json();
    const rows = [
      ...(Array.isArray(value?.workers) ? value.workers : []),
      ...(Array.isArray(value?.drainingGenerations) ? value.drainingGenerations : []),
    ];
    if (rows.length === 0) {
      const keys = value && typeof value === "object" ? Object.keys(value).slice(0, 20) : [];
      return { ok: false, ids: [], error: `GET /host answered without the expected workers / drainingGenerations arrays (keys: ${keys.join(", ")}) — refusing to read that as "no live sessions"`, shape: keys };
    }
    const ids = new Set();
    for (const row of rows) for (const id of Array.isArray(row?.sessions) ? row.sessions : []) if (typeof id === "string") ids.add(id.toLowerCase());
    return {
      ok: true,
      ids: [...ids].sort(),
      error: null,
      generations: rows.length,
      shape: ["workers", "drainingGenerations"],
      reach: "the host's own sessionOwners map (sessions it has routed since it started): a live session never routed is not in it",
    };
  } catch (error) {
    return { ok: false, ids: [], error: String(error?.message ?? error), shape: null };
  } finally {
    clearTimeout(timer);
  }
}

function refusal(receipt, reason, note, extra = {}) {
  receipt.ok = false;
  receipt.reason = reason;
  receipt.changed = false;
  receipt.note = note;
  receipt.blockedBy = [...(receipt.blockedBy ?? []), reason];
  Object.assign(receipt, extra);
  return receipt;
}

/**
 * 唯一那条回收路径。**只**在全部判据通过后才动盘；任何一处不过都如实拒绝（回执里带上实测值）。
 *
 * @param {object} options
 * @param {string} options.sessionId 目标会话的**完整 uuid**
 * @param {boolean} [options.force] 只放宽内容安全 (d) 与「活会话探针拿不到」那条工具性失败；**不放宽 (c)**
 * @param {string} [options.callerCwd] 调用方会话的 cwd（防「回收自己脚下那棵树」）
 * @param {string} [options.baseUrl] 宿主地址（`/host` 探针用；给了才探）
 * @param {object} [options.env] 环境（默认 `process.env`）
 */
export async function reclaimWorktree(options = {}) {
  const { sessionId, force = false, callerCwd = null, baseUrl = null, env = process.env } = options;
  const receipt = {
    ok: false,
    tool: "reclaim_worktree",
    sessionId: typeof sessionId === "string" ? sessionId : null,
    force: force === true,
    changed: false,
    removed: false,
    branchDeleted: false,
    alreadyReclaimed: false,
    blockedBy: [],
    steps: {},
    discarded: null,
    note: null,
  };

  // 0) id 必须是完整 uuid（片段一律拒 —— 与全仓其它 id 载体同一口径）。
  if (typeof sessionId !== "string" || !FULL_UUID.test(sessionId)) {
    return refusal(receipt, "full_uuid_required", "reclaim 只认**完整会话 uuid**（片段不被解析，避免删错树）。", { supplied: typeof sessionId === "string" ? sessionId : null });
  }
  const targetId = sessionId.toLowerCase();
  const agentDir = agentDirOf(env);
  const sessionsRoot = sessionsRootOf(env);

  // 1) 一手来源：会话文件 header。
  let scanned;
  try {
    scanned = await scanSessionHeaders(sessionsRoot);
  } catch (error) {
    return refusal(receipt, "sessions_root_unreadable", `读不到会话目录 ${sessionsRoot}：${error?.message ?? error}`);
  }
  receipt.steps.scan = { sessionsRoot, sessionFiles: scanned.files, headersParsed: scanned.sessions.length, skipped: scanned.skipped.length, skippedSample: scanned.skipped.slice(0, 5) };
  const target = scanned.sessions.find((session) => session.id === targetId);
  if (!target) {
    return refusal(receipt, "session_not_found", `在 ${sessionsRoot} 里找不到会话 ${targetId} 的会话文件（扫了 ${scanned.files} 个 .jsonl）。`, { scannedSessionFiles: scanned.files });
  }
  receipt.steps.session = { id: target.id, file: target.file, cwd: target.cwd, createdAt: target.createdAt, parentSession: target.parentSession };
  if (typeof target.cwd !== "string" || target.cwd.trim() === "") {
    return refusal(receipt, "session_cwd_unknown", "这条会话的 header 里没有可用的 cwd ⇒ 不知道要收哪棵树，拒绝。");
  }

  // 2) (a) 已归档。
  const legacyArchived = await readLegacyArchiveIds(agentDir);
  let archiveState;
  try {
    archiveState = await latestArchiveState(target.file, { legacyArchived: legacyArchived.ids, sessionId: target.id });
  } catch (error) {
    return refusal(receipt, "session_unreadable", `读不到会话文件 ${target.file}：${error?.message ?? error}`);
  }
  receipt.steps.a_archived = { ...archiveState, legacyArchive: { present: legacyArchived.present, error: legacyArchived.error } };
  if (!archiveState.archived) {
    return refusal(receipt, "session_not_archived", `目标会话还没有归档（最近一条 ${ARCHIVE_ENTRY}: archived=${archiveState.present ? "false" : "无这条"}）⇒ 「人不看了」还不成立，拒绝回收。先 session_archive 再回收。`);
  }

  // 3) 目标目录 & 调用方安全（不许收自己脚下那棵）。
  const targetCwdRaw = path.resolve(target.cwd);
  const targetCwd = await resolveExisting(targetCwdRaw);
  const targetExists = await stat(targetCwd).then((info) => info.isDirectory()).catch(() => false);
  receipt.steps.target_dir = { raw: targetCwdRaw, resolved: targetCwd, exists: targetExists };
  if (callerCwd && pathInsideOrEqual(normalizeFsPath(await resolveExisting(callerCwd)), normalizeFsPath(targetCwd))) {
    return refusal(receipt, "caller_inside_target", `调用方自己的 cwd 就在目标树里（${callerCwd}）⇒ 不许回收自己脚下这棵树。`);
  }

  // 3b) 幂等那一半：目录已经不在了 ⇒ 不装成功、也不报错，如实说「没东西可收」；
  //     注册项还挂着就 prune，同名分支还留着就（只在内容安全时）清掉。mainRepo 只能从**调用方**的 cwd 推
  //     （目标目录没了，没别的一手来源）；推不出来就如实说「什么都没做」。
  if (!targetExists) {
    const callerCommon = callerCwd ? await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], callerCwd) : { ok: false };
    const callerCommonDir = callerCommon.ok ? path.resolve(callerCommon.stdout.trim()) : null;
    const mainRepo = callerCommonDir ? (path.basename(callerCommonDir) === ".git" ? path.dirname(callerCommonDir) : path.resolve(callerCwd)) : null;
    const gone = await reclaimAlreadyGone({ sessionId: targetId, mainRepo, worktreePath: targetCwd, force });
    receipt.ok = gone.ok;
    receipt.reason = gone.reason;
    receipt.note = gone.note;
    receipt.changed = gone.changed;
    receipt.branchDeleted = gone.branchDeleted;
    receipt.alreadyReclaimed = gone.alreadyReclaimed;
    receipt.steps.alreadyGone = gone.steps.already_gone;
    receipt.steps.alreadyGone.mainRepoFrom = callerCommon.ok ? "the caller's cwd (git rev-parse --git-common-dir)" : "unavailable: the caller's cwd is not a git repository";
    if (!gone.ok) receipt.blockedBy = [...receipt.blockedBy, gone.reason];
    return receipt;
  }

  // 4) (b) 本仓已注册 worktree、有分支、且不是主树。
  const toplevelGit = await runGit(["rev-parse", "--show-toplevel"], targetCwd);
  if (!toplevelGit.ok) {
    return refusal(receipt, "not_a_git_worktree", `目标 cwd 不是一个 git 工作树（git rev-parse 失败）：${toplevelGit.stderr.trim() || `exit ${toplevelGit.code}`}`, { targetCwd });
  }
  const worktreePath = await resolveExisting(toplevelGit.stdout.trim());
  const commonDirGit = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreePath);
  if (!commonDirGit.ok) {
    return refusal(receipt, "not_a_git_worktree", `拿不到 git-common-dir：${commonDirGit.stderr.trim() || `exit ${commonDirGit.code}`}`, { worktreePath });
  }
  const commonDir = path.resolve(commonDirGit.stdout.trim());
  const mainRepo = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : worktreePath;
  const listing = await listWorktrees(mainRepo);
  if (!listing.ok) {
    return refusal(receipt, "worktree_list_failed", `git worktree list 失败：${listing.stderr || `exit ${listing.code}`}`, { mainRepo });
  }
  const registered = listing.entries.find((entry) => normalizeFsPath(entry.path) === normalizeFsPath(worktreePath)) ?? null;
  receipt.steps.b_worktree = {
    requested: targetCwd,
    worktreePath,
    mainRepo,
    isMainWorktree: normalizeFsPath(worktreePath) === normalizeFsPath(mainRepo),
    registered: registered !== null,
    branch: registered?.branch ?? null,
    branchRef: registered?.branchRef ?? null,
    detached: registered?.detached ?? null,
    head: registered?.head ?? null,
    registeredCount: listing.entries.length,
    // 本仓 `createWorktree()` 的落点约定（`<main>/../.sopho-wt/<slug>` + 分支 `wt/<slug>`）；只报事实，不当作判据。
    conventionMatch: path.basename(path.dirname(worktreePath)) === ".sopho-wt" && registered?.branch === `wt/${path.basename(worktreePath)}`,
  };
  if (receipt.steps.b_worktree.isMainWorktree) {
    return refusal(receipt, "target_is_main_tree", `目标是**主检出**本身（${worktreePath}）⇒ 绝不回收。`);
  }
  if (!registered) {
    return refusal(receipt, "worktree_not_registered", `${worktreePath} 不在 git worktree list 里（${listing.entries.length} 条注册）⇒ 不是本仓已注册的 worktree，拒绝。`, { worktreePath, mainRepo });
  }
  if (!registered.branchRef) {
    return refusal(receipt, "worktree_detached", `${worktreePath} 没有分支（detached HEAD）⇒ 「已并入」这件事无从判起，拒绝。`, { worktreePath });
  }

  // 5) (c) 占用判据：会话文件 header（一手来源）+ 宿主活会话 id 的交叉核对。
  //    反证臂 ①（`test/wt-reclaim.mjs` 的 `--mutant=tree-projection`）把**下面到 `(c) end` 这一整段**
  //    换成「读 /tree 投影」那种历史判据（在副本树上换，本文件不动）—— 那一段曾经把一个正在干活的会话
  //    看成了 0 条 ⇒ 删掉了它未提交的改动。
  const placement = await readPlacement(agentDir);
  const occupants = [];
  for (const session of scanned.sessions) {
    if (session.id === targetId) continue;
    if (placement.value[session.id]?.claimedBy) continue; // 已搬家的会话不再占用旧 cwd
    if (typeof session.cwd !== "string" || session.cwd.trim() === "") continue;
    const resolved = await resolveExisting(session.cwd);
    if (!pathInsideOrEqual(normalizeFsPath(resolved), normalizeFsPath(worktreePath))) continue;
    let archived = false;
    try {
      archived = (await latestArchiveState(session.file, { legacyArchived: legacyArchived.ids, sessionId: session.id })).archived;
    } catch {
      archived = null; // 读不到就如实标 null（不许假装 false ⇒ 也不会被当成「没归档就等于安全」）
    }
    occupants.push({ id: session.id, cwd: resolved, file: session.file, archived, source: "session-file" });
  }
  const liveProbe = baseUrl ? await probeLiveSessions(baseUrl) : { ok: false, ids: [], error: "no baseUrl supplied (host live-facts probe skipped)" };
  const knownIds = new Set(scanned.sessions.map((session) => session.id));
  // 宿主报了活会话、但**盘上没有它的会话文件**（还没落盘）的 id —— 这一栏的语义没变：就是「看不到 header」。
  const liveWithoutHeader = liveProbe.ids.filter((id) => !knownIds.has(id));
  // ── (c-2) 第二份一手来源：`placement.json` 的 `cwd`（落位账）─────────────────────────────────────
  //    为什么需要它：`POST /sessions` 就会让宿主把它记进 sessionOwners（⇒ `/host` 报它是活会话），
  //    而 pi 的会话文件要等**第一条消息**才落盘 ⇒ 这类「刚建好、还没落盘」的会话在 `sessions/` 里查不到，
  //    旧实现只能把它当成「cwd 不明」而**一票否决**：一条这样的会话能挡住那台机器上**所有** worktree 回收
  //    （2026-09-2x winbox 的 33 棵就是这么被挡住的 —— 那台有一条报了 id、盘上没有会话文件的活会话）。
  //    落位账是同一件事的**另一份一手来源**（`server/base-logic.mjs` 的 `readPlacement`／`PLACEMENT_FIELDS`／
  //    `PLACEMENT_KINDS`；本文件只读、不另造字段口径），里面记着它的 cwd ⇒ 用它把「不知道」变成「知道」：
  //      · 有 cwd 且落在目标树里  ⇒ **占用者** ⇒ 拒（这一半绝不放松 ✗）；
  //      · 有 cwd 且不在目标树里  ⇒ 不再因它拒（它压根不住这棵树里）；
  //      · 没有这条 id／cwd 缺失或不可解析 ⇒ **照旧拒**（那仍然是「猜」的地方，不许猜 ✗）。
  const unknownCwdResolvedFrom = placement.ok ? "placement" : null;
  const placementResolvedLive = [];
  const stillUnknownCwdLive = [];
  for (const id of liveWithoutHeader) {
    const entry = placement.value?.[id];
    const cwd = entry && typeof entry.cwd === "string" && entry.cwd.trim() !== "" && path.isAbsolute(entry.cwd) ? entry.cwd : null;
    if (cwd === null) {
      stillUnknownCwdLive.push({ id, cwd: null, source: "unresolved", placementKind: null, why: entry ? "the placement entry carries no usable cwd" : "no placement entry for this id" });
      continue;
    }
    const resolved = await resolveExisting(cwd);
    const insideTarget = pathInsideOrEqual(normalizeFsPath(resolved), normalizeFsPath(worktreePath));
    placementResolvedLive.push({ id, cwd: resolved, source: "placement", insideTarget, placementKind: typeof entry.kind === "string" ? entry.kind : null });
    if (insideTarget) occupants.push({ id, cwd: resolved, file: null, archived: null, source: "placement" });
  }
  // ── (c-2) placement cwd end ──（反证臂 ③ `--mutant=placement-ignored` 的接缝，见 test/wt-reclaim.mjs）
  const liveOccupants = liveProbe.ids
    .map((id) => scanned.sessions.find((session) => session.id === id))
    .filter((session) => session && session.id !== targetId && !placement.value[session.id]?.claimedBy && typeof session.cwd === "string" && pathInsideOrEqual(normalizeFsPath(path.resolve(session.cwd)), normalizeFsPath(worktreePath)));
  for (const session of liveOccupants) {
    if (occupants.some((occupant) => occupant.id === session.id)) continue;
    occupants.push({ id: session.id, cwd: session.cwd, file: session.file, archived: null, source: "host-live-facts" });
  }
  receipt.steps.c_occupancy = {
    sources: [
      "session-file header cwd (first-hand)",
      "placement.json cwd, for live sessions with no session file yet (first-hand ledger)",
      ...(baseUrl ? ["host /host live session ids (cross-check)"] : []),
    ],
    worktreePath,
    occupants,
    occupantCount: occupants.length,
    placementReadable: placement.ok,
    placementError: placement.error,
    movedExempted: scanned.sessions.filter((session) => placement.value[session.id]?.claimedBy).map((session) => session.id),
    liveProbe: {
      ok: liveProbe.ok,
      error: liveProbe.error,
      liveSessionCount: liveProbe.ids.length,
      reach: liveProbe.reach ?? null,
      unknownCwdResolvedFrom,
      sessionsWithoutHeader: liveWithoutHeader,
      resolvedFromPlacement: placementResolvedLive,
      stillUnknownCwd: stillUnknownCwdLive,
    },
    treeProjectionUsed: false,
  };
  if (occupants.length > 0) {
    return refusal(receipt, "live_session_in_worktree", `${occupants.length} 条会话的 cwd 落在这棵树里（${occupants.map((occupant) => occupant.id).join(", ")}）⇒ 拒绝回收，一个字节都不动。`, { occupants });
  }
  if (!liveProbe.ok && force !== true) {
    return refusal(receipt, "live_probe_unavailable", `拿不到宿主活会话清单（${liveProbe.error}）⇒ 无法确认没有「还没落盘因此看不到 header」的活会话住在这棵树里，拒绝（force:true 才会带着这条风险继续）。`);
  }
  if (stillUnknownCwdLive.length > 0) {
    const ids = stillUnknownCwdLive.map((row) => row.id);
    return refusal(receipt, "live_session_cwd_unknown", `宿主报了 ${ids.length} 条活会话，它们的会话文件还没落盘，而落位账里${placement.ok ? "也没有可用的 cwd" : "读不出来（placementError）"} ⇒ 仍然看不出它们住哪（${ids.join(", ")}）⇒ 无法排除它们住在这棵树里，拒绝（这一条 force 也不放宽：那是猜）。`, { stillUnknownCwd: stillUnknownCwdLive, sessionsWithoutHeader: liveWithoutHeader, unknownCwdResolvedFrom });
  }
  // ── (c) end ──（反证臂 ① 替换的边界，见 test/wt-reclaim.mjs）

  // 6) (d) 内容安全：**差异**（不只看祖先）＋ 工作区**不脏**。
  const base = await resolveBaseRef(mainRepo);
  receipt.steps.d_content = { baseRef: base.ref, baseSha: base.sha, baseTried: base.tried, branch: registered.branch, dirty: await inspectDirty(worktreePath) };
  if (!base.ref) {
    return refusal(receipt, "base_ref_missing", `找不到基准引用（试过 ${base.tried.join(", ")}）⇒ 没有可比的东西，「内容安全」无从判起，拒绝。`, { mainRepo });
  }
  receipt.steps.d_content.content = await inspectContent({ repo: mainRepo, branchRef: registered.branchRef, baseRef: base.ref });
  const content = receipt.steps.d_content.content;
  const dirty = receipt.steps.d_content.dirty;
  const ignoredCount = dirty.ok === true ? (dirty.ignored?.count ?? 0) : 0;
  const contentSafe = content.contentSafe && dirty.ok === true && dirty.count === 0 && ignoredCount === 0;
  receipt.steps.d_content.contentSafe = contentSafe;
  if (!contentSafe && force !== true) {
    const dirtyNote = dirty.ok !== true
      ? `git status 读不到（${dirty.error}）`
      : dirty.count > 0
        ? `工作区有 ${dirty.count} 处未提交改动（${dirty.sample.join(" / ")}）`
        : `工作区里有 ${ignoredCount} 处被 .gitignore 忽略的内容（${dirty.ignored.sample.join(" / ")}）—— 忽略路径里也可能埋着没提交的半成品`;
    const reason = !content.contentSafe
      ? "unmerged_changes"
      : dirty.ok !== true
        ? "worktree_status_unavailable"
        : dirty.count > 0 ? "worktree_dirty" : "worktree_has_ignored_content";
    const unmergedNote = `分支 ${registered.branch} ${unmergedPhrase({ baseRef: base.ref, content })}`;
    const note = content.contentSafe
      ? `分支内容安全，但${dirtyNote} ⇒ 默认拒绝。force:true 才会带着「丢弃修改」继续。`
      : `${unmergedNote}${dirty.ok === true && (dirty.count > 0 || ignoredCount > 0) ? `，且${dirtyNote}` : ""} ⇒ 默认拒绝。force:true 才会带着「丢弃修改」继续。`;
    return refusal(receipt, reason, note, {
      unmerged: content.contentSafe ? null : unmergedReportOf({ branch: registered.branch, baseRef: base.ref, content }),
      dirty: dirty.ok === true ? { count: dirty.count, sample: dirty.sample, ignored: dirty.ignored } : { error: dirty.error },
    });
  }

  // 7) (e) 动手：先 unlink `node_modules` 联接（绝不穿过 junction ✗），再删目录。
  const nodeModulesPath = path.join(worktreePath, "node_modules");
  const linkInfo = await lstat(nodeModulesPath).catch(() => null);
  let linkUnlinked = null;
  if (linkInfo?.isSymbolicLink()) {
    try {
      await unlink(nodeModulesPath);
      linkUnlinked = { path: nodeModulesPath, removed: true, targetNotTouched: true };
    } catch (error) {
      linkUnlinked = { path: nodeModulesPath, removed: false, error: String(error?.message ?? error) };
      return refusal(receipt, "node_modules_link_unlink_failed", `删 ${nodeModulesPath} 这层联接失败（${linkUnlinked.error}）⇒ 不继续（git worktree remove 可能穿过去删到主树的 node_modules）。`, { linkUnlinked });
    }
  } else if (linkInfo) {
    linkUnlinked = { path: nodeModulesPath, removed: false, present: "real directory (not a link): left to git worktree remove" };
  }
  const removal = await runGit(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], mainRepo);
  const stillThere = await stat(worktreePath).then(() => true).catch(() => false);
  receipt.steps.e_removal = {
    nodeModulesLink: linkUnlinked,
    command: `git -C <mainRepo> worktree remove${force ? " --force" : ""} <worktreePath>`,
    code: removal.code,
    stdout: removal.stdout.trim(),
    stderr: removal.stderr.trim(),
    worktreeGone: !stillThere,
  };
  if (!removal.ok || stillThere) {
    return refusal(receipt, "worktree_remove_failed", `git worktree remove 没成功（exit ${removal.code}）${removal.stderr.trim() ? `：${removal.stderr.trim()}` : ""}；目录${stillThere ? "仍在" : "已不在"}。`, { worktreePath });
  }
  receipt.removed = true;
  receipt.changed = true;
  receipt.steps.e_removal.worktreePath = worktreePath;

  // 分支：**只有**内容安全时才删（c/d 任一不满足 ⇒ 不删 —— 未并入的提交不能跟着树一起消失）。
  if (contentSafe) {
    const branchRemoval = await runGit(["branch", "-D", registered.branch], mainRepo);
    receipt.steps.e_removal.branchCommand = `git -C <mainRepo> branch -D ${registered.branch}`;
    receipt.steps.e_removal.branchCode = branchRemoval.code;
    receipt.steps.e_removal.branchStderr = branchRemoval.stderr.trim();
    receipt.branchDeleted = branchRemoval.ok;
    receipt.steps.e_removal.branchKept = branchRemoval.ok ? null : `分支 ${registered.branch} 没删掉（exit ${branchRemoval.code}）：${branchRemoval.stderr.trim()}`;
  } else {
    receipt.steps.e_removal.branchKept = `内容安全不成立 ⇒ 分支 ${registered.branch} **保留**（force:true 只动工作区那半，未并入的提交不去）`;
  }
  receipt.discarded = contentSafe ? null : {
    force: true,
    branch: registered.branch,
    unmerged: content.contentSafe ? null : unmergedReportOf({ branch: registered.branch, baseRef: base.ref, content }),
    uncommitted: dirty.ok === true ? { count: dirty.count, sample: dirty.sample, ignored: dirty.ignored } : { error: dirty.error },
  };
  receipt.ok = true;
  receipt.reason = "reclaimed";
  const parts = [`已回收 ${worktreePath}（分支 ${registered.branch}）`];
  parts.push(receipt.branchDeleted ? "并删掉了分支（内容安全：已并入基准或与基准零差异）" : `分支没删：${receipt.steps.e_removal.branchKept}`);
  if (receipt.discarded) parts.push("⚠️ force:true ⇒ 上面 discarded 里逐字记的那些改动被丢弃了");
  receipt.note = `${parts.join("；")}。`;
  return receipt;
}

/**
 * 幂等那一半（目录已经不在了）：不装成功、也不报错，如实说「没东西可收」；
 * 若同名分支还留着且内容安全，顺手删掉并说明。
 */
export async function reclaimAlreadyGone(options = {}) {
  const { sessionId, mainRepo = null, worktreePath = null, force = false } = options;
  const receipt = {
    ok: false,
    tool: "reclaim_worktree",
    sessionId,
    force: force === true,
    changed: false,
    removed: false,
    branchDeleted: false,
    alreadyReclaimed: false,
    blockedBy: [],
    steps: {},
    note: null,
  };
  const derivedBranch = worktreePath ? `wt/${path.basename(worktreePath)}` : null;
  // 目录名 → 分支名的对应关系**不是猜的**：`server/base.mjs` 的 `createWorktree()` 就是这么落的
  // （`target = path.join(<main>/../.sopho-wt, slug)`、`branch = \`wt/${slug}\``）；这里把这条推导原样报出来。
  receipt.steps.already_gone = { worktreePath, mainRepo, derivedBranch, branchRule: "branch wt/<basename of the worktree dir> (createWorktree in server/base.mjs)" };
  if (!mainRepo || !derivedBranch) {
    receipt.ok = true;
    receipt.alreadyReclaimed = true;
    receipt.reason = "already_reclaimed";
    receipt.note = `目标目录已不在（${worktreePath ?? "(unknown)"}），没有东西可收；也没能推出要清理的分支名（缺 mainRepo）⇒ 什么都没做。`;
    return receipt;
  }
  const listing = await listWorktrees(mainRepo);
  const registered = listing.ok ? listing.entries.find((entry) => normalizeFsPath(entry.path) === normalizeFsPath(worktreePath)) : null;
  if (registered) {
    const prune = await runGit(["worktree", "prune"], mainRepo);
    receipt.steps.already_gone.prune = { code: prune.code, stdout: prune.stdout.trim(), stderr: prune.stderr.trim() };
    receipt.changed = true;
    receipt.ok = true;
    receipt.alreadyReclaimed = true;
    receipt.reason = "already_reclaimed";
    receipt.note = `目录早就不在了，但 git 的注册项还挂着 ⇒ 已 \`git worktree prune\`（exit ${prune.code}，只清指向不存在目录的注册项）。`;
    return receipt;
  }
  const branchExists = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${derivedBranch}`], mainRepo);
  if (!branchExists.ok || branchExists.stdout.trim() === "") {
    receipt.ok = true;
    receipt.alreadyReclaimed = true;
    receipt.reason = "already_reclaimed";
    receipt.note = `目录已不在、注册项已不在、分支 ${derivedBranch} 也不在 ⇒ 已经没有东西可收（幂等，什么都没做）。`;
    return receipt;
  }
  const base = await resolveBaseRef(mainRepo);
  const content = base.ref ? await inspectContent({ repo: mainRepo, branchRef: `refs/heads/${derivedBranch}`, baseRef: base.ref }) : null;
  receipt.steps.already_gone.branch = {
    name: derivedBranch,
    baseRef: base.ref,
    content,
    unmerged: content ? unmergedReportOf({ branch: derivedBranch, baseRef: base.ref, content }) : null,
  };
  if (!content || !content.contentSafe) {
    receipt.ok = false;
    receipt.alreadyReclaimed = true; // 目录确实已经不在了（这一格是事实），只是分支还在、且不安全 ⇒ 不删
    receipt.reason = "already_reclaimed_branch_unsafe";
    receipt.note = `目录已不在（这就是幂等那一半），但分支 ${derivedBranch} 还留着，且${content ? unmergedPhrase({ baseRef: base.ref, content }) : "找不到基准引用"} ⇒ **不删分支**（未并入的提交不能悄悄丢）。`;
    return receipt;
  }
  const deletion = await runGit(["branch", "-D", derivedBranch], mainRepo);
  receipt.steps.already_gone.branchDelete = { code: deletion.code, stderr: deletion.stderr.trim() };
  receipt.branchDeleted = deletion.ok;
  receipt.changed = deletion.ok;
  receipt.ok = deletion.ok;
  receipt.alreadyReclaimed = true;
  receipt.reason = deletion.ok ? "already_reclaimed" : "already_reclaimed_branch_delete_failed";
  receipt.note = deletion.ok
    ? `目录与注册项都已不在；顺手删掉了残留分支 ${derivedBranch}（内容安全：${content.ancestor ? "已并入" : "与基准零差异"}）。`
    : `目录已不在；残留分支 ${derivedBranch} 删除失败（exit ${deletion.code}）：${deletion.stderr.trim()}`;
  return receipt;
}
