#!/usr/bin/env node
/**
 * wt-report —— worktree 的**候选报告**（只读；一个目录都不动）。
 *
 * 为什么要有它：回收 worktree 这件事 2026-09-24 出过一次真实事故 —— 维护者用两条手搓判据
 * （①分支是 `origin/master` 的祖先 ②`/tree` 的 `cwd` 字段不在活会话里）筛「可删的树」，
 * 删掉了一个正在干活、尚未提交的子会话的 cwd（未提交改动不可恢复）。两条判据都不可靠：
 * ①「是祖先」只覆盖**已提交**的内容 ✗；②`/tree` 的 `cwd` 字段**实测会缺**（当时返回 0）✗。
 * ⇒ 本脚本把「每条 worktree 现在是什么状态」量成一张**可复核**的表，判据只用**一手来源**：
 *   · 会话文件自己的 header `cwd`（`$ASSIST_HOME/sessions/**\/*.jsonl`）—— 不是 `/tree` 那种投影 ✗
 *   · `git worktree list` / `git diff --numstat`（**差异**，不是只判祖先）/ `git status --porcelain`
 * 它**只报告**：建议动作是给人看的，动手一律走那条受守卫的路径（插件工具 `reclaim_worktree`，见
 * `pi-extensions/assistant/reclaim-worktree.mjs`）。
 *
 * 跑法：
 *   node bin/wt-report.mjs                       # 默认：cwd 所在仓库的**主检出** + 默认 agent home
 *   node bin/wt-report.mjs --repo <path> --home <dir>
 *   node bin/wt-report.mjs --json                # 同一份事实的机器可读形状
 *   node bin/wt-report.mjs --no-host-probe       # 不去问宿主 `/host`（离线/沙箱里用）
 *
 * 读法与它自己的边界（**都写在输出里**，不靠这段注释）：
 *   · 「占用」= 盘上有会话文件的会话，其 header `cwd` **等于或落在**这条 worktree 里（含子目录）；
 *     `placement.json` 里 `claimedBy` 的会话（已搬家）不算占用它的旧 cwd；
 *   · `--no-host-probe` 关掉之后、或宿主问不到时，「活会话」这一栏**只有盘上那一份** ⇒
 *     **刚建好、pi 还没落盘的 pending 会话看不见**（这一栏会如实标成 `incomplete`）；
 *   · 「宿主报了活会话、但盘上还没有它的会话文件」那一类**不再一律当未知**：用**第二份一手来源**
 *     `placement.json` 的 `cwd`（落位账；与守卫 `reclaim-worktree.mjs` 的 (c-2) **同一口径**）判它住哪 ——
 *     落在树里 ⇒ 照旧标成**挡路**（守卫会以 `live_session_in_worktree` 拒）；不在树里 ⇒ 如实的一类
 *     （它压根不住这儿，不再算「看不出」）；落位账读不出来／没有可用 cwd ⇒ 照旧 `needs-human`
 *     （那才是「不许猜」的地方）。每一行都写明**用的是哪份来源**（`liveWithoutHeader.source`）—— 不许静默 ✗；
 *   · 建议 `reclaimable` 的**前提**是：恰好 1 条引用它的会话、那条**已归档**、内容安全、工作区不脏，
 *     并且**没有**「落在树里的活会话」或「判不出 cwd 的活会话」（有的话守卫一定会拒）—— 全中才给，
 *     任何一条不中就给 `needs-human` ＋**为什么**。给不出会话 id 的（没人引用）标 `no-session`，
 *     因为回收工具**必须**点名一条已归档的会话。
 */

import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  agentDirOf,
  inspectContent,
  inspectDirty,
  latestArchiveState,
  listWorktrees,
  normalizeFsPath,
  pathInsideOrEqual,
  probeLiveSessions,
  readLegacyArchiveIds,
  readPlacement,
  resolveBaseRef,
  resolveExisting,
  sessionsRootOf,
  scanSessionHeaders,
  unmergedPhrase,
  unmergedReportOf,
} from "../pi-extensions/assistant/reclaim-worktree.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
// 两种写法都接：`--repo=<path>` 与 `--repo <path>`（文档里写的是后者）。
const value = (name) => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return null;
};

const JSON_OUT = flag("json");
const HOST_PROBE = !flag("no-host-probe");
const print = (line = "") => process.stdout.write(`${line}\n`);

function git(args, cwd) {
  try {
    return { ok: true, stdout: execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }), stderr: "" };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? error) };
  }
}

/**
 * 「宿主报了活会话、但盘上没有它的会话文件」那批 id 的落位判断 —— 与守卫 `reclaim-worktree.mjs` 的 (c-2)
 * **逐条同口径**：拿落位账 `placement.json` 的 `cwd`（第二份一手来源）把「不知道」变成「知道」。
 *   · 有 `cwd`（绝对路径、非空）⇒ 记下来（落位账**读不出来**时 `placement.value` 是空账 ⇒ 自然全落到 unknown）；
 *   · 没有这条 id／`cwd` 缺失或不可解析 ⇒ **仍然是「判不出 cwd」**（那是「不许猜」的地方）；
 * 这里**只做「能不能判出 cwd」**这一半（与守卫同一处判据）；「落在哪棵树里」是按行判的（同一个 id 对不同
 * 的树会有不同的答案），所以留给每一行去筛。来源名字一律带出来，不静默。
 */
async function classifyLiveWithoutHeader(ids, placement) {
  const resolved = [];
  const unknown = [];
  for (const id of ids) {
    const entry = placement.value?.[id];
    const cwd = entry && typeof entry.cwd === "string" && entry.cwd.trim() !== "" && path.isAbsolute(entry.cwd) ? entry.cwd : null;
    if (cwd === null) {
      unknown.push({ id, cwd: null, source: "unresolved", placementKind: null, why: entry ? "the placement entry carries no usable cwd" : "no placement entry for this id" });
      continue;
    }
    resolved.push({ id, cwd: await resolveExisting(cwd), source: "placement", placementKind: typeof entry.kind === "string" ? entry.kind : null });
  }
  return {
    source: placement.ok ? "placement.json (cwd ledger)" : `placement.json unreadable (${placement.error ?? "unknown error"})`,
    resolved,
    unknown,
  };
}

/** 主检出：`git rev-parse --path-format=absolute --git-common-dir`（与工具同一判据）。 */
async function mainRepoOf(start) {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], start);
  if (!common.ok) return null;
  const commonDir = path.resolve(common.stdout.trim());
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : path.resolve(start);
}

/** 最后一次提交时间：拿 `git worktree list` 给的 HEAD sha 去主检出问 ⇒ **不需要目录还在**。 */
function lastCommitOf(repo, head) {
  if (!head) return null;
  const result = git(["log", "-1", "--format=%cI", head], repo);
  return result.ok ? result.stdout.trim() : null;
}

async function main() {
  if (flag("help")) {
    print("用法: node bin/wt-report.mjs [--repo <path>] [--home <dir>] [--base-url <url>] [--json] [--no-host-probe]");
    print("  只读：列出每条已注册 worktree 的分支/内容是否已并入（按差异）/是否被会话占用（一手来源）/最后提交时间/建议动作。");
    return;
  }
  const start = path.resolve(value("repo") ?? process.cwd());
  const repo = await mainRepoOf(start);
  if (!repo) {
    print(`✗ ${start} 不是一个 git 工作树（拿不到 git-common-dir）⇒ 这份报告需要 --repo <path> 指一个仓库。`);
    process.exitCode = 2;
    return;
  }
  const home = path.resolve(value("home") ?? agentDirOf(process.env));
  // `--home` 给了就当 sessions 也在这个 home 下（除非环境里另有显式的会话目录）；没给就按默认口径。
  const sessionsRoot = path.resolve(
    value("home")
      ? (process.env.SOPHO_SESSION_DIR || process.env.PI_CODING_AGENT_SESSION_DIR || path.join(home, "sessions"))
      : sessionsRootOf(process.env),
  );

  const listing = await listWorktrees(repo);
  if (!listing.ok) {
    print(`✗ git worktree list 失败：${listing.stderr || `exit ${listing.code}`}`);
    process.exitCode = 2;
    return;
  }
  const scan = await scanSessionHeaders(sessionsRoot);
  const placement = await readPlacement(home);
  const legacy = await readLegacyArchiveIds(home);
  const base = await resolveBaseRef(repo);
  const baseUrl = value("base-url") ?? process.env.SOPHO_DELEGATION_URL ?? `http://127.0.0.1:${process.env.SOPHO_PORT || "7331"}`;
  const live = HOST_PROBE ? await probeLiveSessions(baseUrl) : { ok: false, ids: [], error: "--no-host-probe", reach: null };
  const knownIds = new Set(scan.sessions.map((session) => session.id));
  const liveSet = new Set(live.ids);
  // 宿主报了、盘上却没有会话文件的那批 id（原始名单语义）＋ 用落位账判 cwd 的结果（与守卫 (c-2) 同一口径）。
  const liveWithoutHeader = live.ok ? live.ids.filter((id) => !knownIds.has(id)) : [];
  const pendingLive = await classifyLiveWithoutHeader(liveWithoutHeader, placement);
  const unknownCwdResolvedFrom = placement.ok ? "placement" : null;

  const rows = [];
  for (const [index, entry] of listing.entries.entries()) {
    const worktreePath = await resolveExisting(entry.path);
    const isMain = index === 0;
    const exists = await stat(worktreePath).then((info) => info.isDirectory()).catch(() => false);
    const referencing = [];
    for (const session of scan.sessions) {
      if (placement.value[session.id]?.claimedBy) continue; // 已搬家：不再占用旧 cwd
      if (typeof session.cwd !== "string" || session.cwd.trim() === "") continue;
      const resolved = await resolveExisting(session.cwd);
      if (!pathInsideOrEqual(normalizeFsPath(resolved), normalizeFsPath(worktreePath))) continue;
      let archived = null;
      try {
        archived = (await latestArchiveState(session.file, { legacyArchived: legacy.ids, sessionId: session.id })).archived;
      } catch {
        archived = null;
      }
      const liveNow = liveSet.has(session.id);
      referencing.push({
        id: session.id,
        cwd: resolved,
        archived,
        live: live.ok ? liveNow : null,
        source: liveNow ? "host-live-facts + session-file" : "session-file",
      });
    }
    // 「活会话、但盘上还没有它的会话文件」那一类：与守卫 (c-2) **同一口径**
    // （判 cwd 用的是**落位账** `placement.json`，来源写下来、不静默）。
    const headerless = {
      source: pendingLive.source,
      unknownCwdResolvedFrom,
      inTree: pendingLive.resolved.filter((row) => pathInsideOrEqual(normalizeFsPath(row.cwd), normalizeFsPath(worktreePath))),
      outside: pendingLive.resolved.filter((row) => !pathInsideOrEqual(normalizeFsPath(row.cwd), normalizeFsPath(worktreePath))),
      stillUnknown: pendingLive.unknown,
    };
    const content = !isMain && entry.branchRef && base.ref
      ? await inspectContent({ repo, branchRef: entry.branchRef, baseRef: base.ref })
      : null;
    const dirty = exists && !isMain ? await inspectDirty(worktreePath) : null;

    const reasons = [];
    if (isMain) reasons.push("这是主检出本身");
    if (!exists) reasons.push("目录已不存在");
    if (referencing.some((session) => session.archived !== true)) reasons.push(`${referencing.filter((session) => session.archived !== true).length} 条引用它的会话**没有归档**`);
    if (referencing.length > 1) reasons.push(`有 ${referencing.length} 条会话引用它（回收工具只认「恰好一条已归档的目标会话」）`);
    if (referencing.length === 0) reasons.push("没有会话引用它（回收工具必须点名一条已归档的会话 id）");
    if (!base.ref) reasons.push(`找不到基准引用（试过 ${base.tried.join(", ")}）`);
    if (content && !content.contentSafe) reasons.push(`分支 ${unmergedPhrase({ baseRef: base.ref, content })}`);
    if (dirty && dirty.ok === true && dirty.count > 0) reasons.push(`工作区有 ${dirty.count} 处未提交改动`);
    if (dirty && dirty.ok === true && (dirty.ignored?.count ?? 0) > 0) reasons.push(`工作区里有 ${dirty.ignored.count} 处被 .gitignore 忽略的内容（忽略路径里也可能埋着没提交的半成品）`);
    if (dirty && dirty.ok !== true) reasons.push(`工作区状态读不到（${dirty.error}）`);
    // 「活而无文件」那两类，口径与守卫一致：落在树里 ⇒ 挡路；连落位账也判不出 ⇒ 不许猜。
    // （能判出「不住这棵树里」的那些**不再进理由**：它们不构成任何一条拒绝条件。）
    if (headerless.inTree.length > 0) reasons.push(`${headerless.inTree.length} 条活会话（宿主报了它、盘上还没有会话文件）的 cwd 按**落位账**就落在这棵树里 ⇒ 挡路（守卫会以 live_session_in_worktree 拒绝；来源：${headerless.source}）`);
    if (headerless.stillUnknown.length > 0) reasons.push(`${headerless.stillUnknown.length} 条活会话（宿主报了它、盘上还没有会话文件）连落位账也判不出 cwd ⇒ 看不出它们住哪、不许猜（守卫会以 live_session_cwd_unknown 拒绝；来源：${headerless.source}）`);
    if (referencing.some((session) => session.live === true)) reasons.push("有活会话正引用它");

    let suggestion = "needs-human";
    const archivedOnly = referencing.length === 1 && referencing[0].archived === true;
    if (isMain) suggestion = "main-tree";
    else if (!exists) suggestion = "missing-dir";
    else if (referencing.length === 0) suggestion = "no-session";
    // 与守卫同一条口径：有「落在树里的活会话」或「判不出 cwd 的活会话」时，守卫一定会拒 ⇒ 这里也不给「可回收」。
    else if (archivedOnly && content?.contentSafe && dirty?.ok === true && dirty.count === 0 && (dirty.ignored?.count ?? 0) === 0
      && headerless.inTree.length === 0 && headerless.stillUnknown.length === 0) suggestion = "reclaimable";

    rows.push({
      path: worktreePath,
      branch: entry.branch ?? null,
      head: entry.head,
      detached: entry.detached,
      locked: entry.locked,
      isMain,
      exists,
      lastCommit: lastCommitOf(repo, entry.head),
      content: content
        ? {
            ancestor: content.ancestor,
            zeroDiff: content.zeroDiff,
            safe: content.contentSafe,
            // 与 `worktree_hint` / 守卫回执**同一套口径**：files/added/deleted ＋ commitsAhead = **它自己的改动**，
            // vsMasterTwoDot = **两条 tip 的差异**（并进基准的整体变化，**不是**它的改动）、mergeBase = 分叉点。
            // 旧版本这里报的是两点（把基准侧的历史也算成它的改动）⇒ 会误导。
            ...unmergedReportOf({ branch: entry.branch ?? null, baseRef: base.ref, content }),
          }
        : { baseRef: base.ref, branch: entry.branch ?? null, ancestor: null, files: null, added: null, deleted: null, commitsAhead: null, vsMasterTwoDot: null, mergeBase: null, zeroDiff: null, safe: null, note: isMain ? "主检出：不按分支内容判" : (entry.branchRef ? "没有基准引用可比" : "detached HEAD：没有分支可比") },
      dirty: dirty ? { ok: dirty.ok, count: dirty.count, sample: dirty.sample, ignored: dirty.ignored } : null,
      sessions: referencing,
      liveWithoutHeader: headerless,
      suggestion,
      reasons,
      action: suggestion === "reclaimable" ? `reclaim_worktree({ id: "${referencing[0].id}" })` : null,
    });
  }

  const report = {
    report: "wt-report",
    readOnly: true,
    repo,
    sessionsRoot,
    sessionFiles: scan.files,
    headersParsed: scan.sessions.length,
    skippedSessionFiles: scan.skipped.length,
    skippedSample: scan.skipped.slice(0, 5),
    placement: { readable: placement.ok, error: placement.error, legacyArchive: { present: legacy.present, error: legacy.error } },
    base: { ref: base.ref, sha: base.sha, tried: base.tried },
    hostProbe: HOST_PROBE
      ? {
          ok: live.ok,
          error: live.error,
          liveSessionIds: live.ids.length,
          reach: live.reach ?? null,
          sessionsWithoutHeader: liveWithoutHeader, // 原始名单：宿主报了活会话、盘上没有它的会话文件
          unknownCwdResolvedFrom, // 'placement'（落位账读得出来）/ null（读不出来）；与守卫回执里的同名字段同口径
          resolvedFromPlacement: pendingLive.resolved,
          stillUnknownCwd: pendingLive.unknown,
          placementReadable: placement.ok,
          placementError: placement.error,
        }
      : { ok: false, error: "--no-host-probe", liveSessionIds: 0, reach: null, sessionsWithoutHeader: [], unknownCwdResolvedFrom: null, resolvedFromPlacement: [], stillUnknownCwd: [], placementReadable: placement.ok, placementError: placement.error },
    // 「活会话这一栏完整」= 宿主问得到，**且**每条「活而无文件」的会话都在落位账里判出了 cwd。
    liveFactsComplete: live.ok === true && pendingLive.unknown.length === 0,
    worktrees: rows,
    counts: {
      total: rows.length,
      reclaimable: rows.filter((row) => row.suggestion === "reclaimable").length,
      needsHuman: rows.filter((row) => row.suggestion === "needs-human").length,
      noSession: rows.filter((row) => row.suggestion === "no-session").length,
      missingDir: rows.filter((row) => row.suggestion === "missing-dir").length,
    },
    limits: [
      "「宿主报了活会话、但盘上还没有它的会话文件」那一类用落位账 $ASSIST_HOME/placement.json 的 cwd 判它住哪（与守卫同一口径）：判出**不在**这棵树里的不再算「看不出」；判出**落在**树里的照旧标成挡路；落位账读不出来／没有可用 cwd 的仍如实标成「判不出 cwd、不许猜」（那时 liveFactsComplete:false）",
      "--no-host-probe 关掉之后（或宿主问不到）就只看得到盘上那一份会话：pending 会话一个都看不见，liveFactsComplete:false",
      "「已搬家」的豁免来自 $ASSIST_HOME/placement.json 的 claimedBy；那份账读不出来时只会**多**报占用（方向安全）",
      "工作区判据是 `git status --porcelain --ignored=matching`：`ignored:N` 是**被 .gitignore 忽略**的路径条数（忽略路径里也可能埋着人家没提交的半成品）；路径里有 `node_modules` 的那条不计（对主检出的目录联接，是本仓自己的约定）",
      "「未并入」的数字与守卫 / 归档提示**同一套口径**：`content.files/added/deleted` ＋ `content.commitsAhead` 是**它自己的改动**（三点 `diff <base>...<branch>` = merge-base → 分支 tip；`rev-list --count <base>..<branch>` 两点），`content.vsMasterTwoDot` 是**两条 tip 的差异** —— 即「并进基准会带来多少变化」，**不是**它的改动（基点旧时它会把基准侧那段历史也算进来），`content.mergeBase{sha,date}` 是分叉点",
      "本报告只读：它不删目录、不删分支、不动任何会话文件",
    ],
  };

  if (JSON_OUT) {
    print(JSON.stringify(report, null, 2));
    return;
  }
  print(`repo         ${repo}`);
  print(`base         ${base.ref ?? "(none)"}${base.sha ? ` ${base.sha.slice(0, 12)}` : ` (tried: ${base.tried.join(", ")})`}`);
  print(`sessions     ${sessionsRoot}  files=${scan.files} headers=${scan.sessions.length} skipped=${scan.skipped.length}`);
  print(`placement    readable=${placement.ok}${placement.error ? ` (${placement.error})` : ""}  legacyArchive.present=${legacy.present}`);
  print(`host probe   ok=${live.ok} liveSessionIds=${live.ids.length}${live.error ? ` (${live.error})` : ""}${live.ok ? `  reach: ${live.reach}` : ""}`);
  print(`liveFactsComplete ${report.liveFactsComplete}  (true ⇒ 每条活会话的 cwd 都判出来了；false ⇒ 宿主问不到，或落位账也判不出某些活会话的 cwd)`);
  print("");
  print(`worktrees    ${rows.length} 条注册`);
  for (const row of rows) {
    const mark = row.isMain ? "·" : " ";
    const content = row.content.files === null
      ? `content=n/a`
      : `content=${row.content.safe ? "safe" : `UNSAFE(own:${row.content.files}f +${row.content.added}/-${row.content.deleted}; merge-into-base two-dot:${row.content.vsMasterTwoDot?.files ?? "?"}f)`}`;
    const dirty = row.dirty === null ? "dirty=n/a" : row.dirty.ok === true ? `dirty=${row.dirty.count}${(row.dirty.ignored?.count ?? 0) > 0 ? `+ignored:${row.dirty.ignored.count}` : ""}` : "dirty=?";
    const occupants = row.sessions.length === 0
      ? "sessions=-"
      : `sessions=${row.sessions.map((session) => `${session.id.slice(0, 8)}${session.archived === true ? "(archived)" : session.archived === false ? "(ACTIVE)" : "(archive?)"}${session.live === true ? "(live)" : ""}`).join(",")}`;
    print(`${mark} ${(row.branch ?? "(detached)").padEnd(34)} ${row.lastCommit ?? "(no commit)"}  ${content.padEnd(30)} ${dirty.padEnd(9)} ${occupants}`);
    print(`    ${row.path}`);
    const headerless = row.liveWithoutHeader;
    if (headerless.inTree.length > 0 || headerless.outside.length > 0 || headerless.stillUnknown.length > 0) {
      print(`    live-but-no-session-file: in-tree=${headerless.inTree.length} outside=${headerless.outside.length} unknown=${headerless.stillUnknown.length}   [source: ${headerless.source}]`);
    }
    print(`    ⇒ ${row.suggestion}${row.action ? `   ${row.action}` : ""}${row.reasons.length > 0 ? `   [${row.reasons.join(" | ")}]` : ""}`);
  }
  print("");
  print(`counts: total=${report.counts.total} reclaimable=${report.counts.reclaimable} needsHuman=${report.counts.needsHuman} noSession=${report.counts.noSession} missingDir=${report.counts.missingDir}`);
  for (const limit of report.limits) print(`limit: ${limit}`);
  print("这条报告**没有**动任何目录（它只读）。要动手只有一条路：插件工具 reclaim_worktree({id})。");
}

await main();
