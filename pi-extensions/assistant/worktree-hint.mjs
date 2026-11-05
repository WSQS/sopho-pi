/**
 * worktree-hint —— 「归档那一刻，这条会话还留着一棵 worktree / 一条分支吗？」
 *
 * ── 为什么有它（依据：`docs/plans/diagnosis-2026-10-09-subagent-management.md` §3④ ＋ §5 修法 4）────
 * `archiveSession()` 只写一个 `sopho.archive` 标记：**不读 worktree、不发通知、不关联分支**，而
 * 「跑完 ≠ 归档 ≠ 收树 ≠ 合分支」是**四个各走各的动作** ⇒ 归档那一刻是**唯一**还看得见「它占着什么」的时刻
 * （收尾后没人记得去查）。诊断单实测：25 个成功子会话里 23 个未归档、`reclaim_worktree` 调用 **0** 次、
 * 主仓挂着 12 棵 worktree。
 *
 * ── 它做什么 / **绝不**做什么 ────────────────────────────────────────────────────────────────
 * **只**在 `session_archive` 的**回执**里加一段**如实**的话：cwd 是已注册 worktree ⇒ 写明
 * 路径 / 分支 / 未并入基准的提交数与**它自己改动的**文件数，并给一句「要收就调 `reclaim_worktree`」。**绝不自动回收**
 * ——本文件里**没有**任何写操作（不 `git worktree remove`、不 `git branch -D`、不写盘），
 * 只有 `git rev-parse` / `git worktree list --porcelain` / `git rev-list --count` / `git diff --numstat`
 * 这几种**只读**调用。
 *
 * ── 判据（三种结果，都**如实**）─────────────────────────────────────────────────────────────
 *   · `worktree`      —— cwd 的 toplevel 是**本仓已注册的 worktree**、且**不是主检出** ⇒ 给提示；
 *   · `not_worktree`  —— **确定它没占 worktree** ⇒ **什么都不加**（不要噪音）。这一格包含三种：
 *                        cwd 是这个仓的**主检出**；cwd 在某个 git 仓里但不在 `git worktree list`
 *                        的注册项里；**cwd 根本不在任何 git 仓里**（⇒ 连仓都没有，谈不上占 worktree）。
 *                        ⚠️ 「不在任何 git 仓里」是**成功判定**，不是失败 —— 业主 2026-10-10 拍板：
 *                        那一行的职责是「归档那一刻告诉你它占着什么」，没占就什么都不说（原派单把
 *                        「不是仓库」写进「判定失败」那一格是写错了；写成降级文案会每次都多一句噪音）。
 *   · `unknown`       —— **判不出来**（git 不在 / 超时 / 会话文件里没有 cwd / header 读不出来 /
 *                        git 以别的方式失败）⇒ 回执里**如实写**「查不到它的 worktree 归属」＋原因，
 *                        **不许猜**，也**绝不因为查不到就自动做任何删除/回收动作**。
 *
 * 一手来源与会话本身无关的**会话文件 header**（`$ASSIST_HOME/sessions/**`，与 `reclaim_worktree` 同一口径），
 * **不读** `/tree` 那种投影字段（2026-09-24 那次事故就是被投影字段骗的）。
 *
 * 短死线：默认 `DEFAULT_DEADLINE_MS`（2 s）—— 超过就**如实降级**成 `unknown`，绝不把归档本身拖住。
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { BASE_REF_CANDIDATES, listSessionFiles, readFirstLine, resolveExisting, sessionsRootOf } from "./reclaim-worktree.mjs";

/** 默认短死线：归档本身不能被这次查询拖住（诊断单 §5 修法 4：毫秒级读；超时就如实降级）。 */
export const DEFAULT_DEADLINE_MS = 2000;

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_A_REPO = /not a git repository|不是 git 仓库|not a working tree/i;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** 只读 git，**带短死线**：超时就 kill 并如实标 `timedOut`（绝不静默等待）。 */
function gitBounded(args, cwd, budget) {
	const left = budget.left();
	if (left <= 0) {
		return Promise.resolve({ ok: false, code: -1, stdout: "", stderr: "", timedOut: true, error: `deadline exhausted before running: git ${args.join(" ")}` });
	}
	return new Promise((resolve) => {
		let timer = null;
		const child = execFile("git", args, { cwd, windowsHide: true, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
			if (timer !== null) clearTimeout(timer);
			const killed = error ? (error.killed === true || error.signal === "SIGTERM" || error.signal === "SIGKILL") : false;
			const code = error ? (typeof error.code === "number" ? error.code : (killed ? 124 : 1)) : 0;
			resolve({ ok: !error, code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: killed, error: error ? String(error.message ?? error) : null });
		});
		timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* already gone */ } }, left);
		if (typeof timer.unref === "function") timer.unref();
	});
}

function budgetOf(ms) {
	const deadline = Date.now() + ms;
	return { deadline, left: () => deadline - Date.now() };
}

function parsePorcelain(stdout) {
	const entries = [];
	let current = null;
	for (const line of stdout.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			current = { path: line.slice("worktree ".length).trim(), head: null, branchRef: null, branch: null, detached: false };
			entries.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice(5).trim();
		else if (line.startsWith("branch ")) {
			current.branchRef = line.slice(7).trim();
			current.branch = current.branchRef.replace(/^refs\/heads\//, "");
		} else if (line === "detached") current.detached = true;
	}
	return entries;
}

function countNumstat(stdout) {
	let files = 0;
	let added = 0;
	let deleted = 0;
	for (const line of stdout.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const [rawAdded, rawDeleted] = line.split("\t");
		files += 1;
		if (rawAdded === "-" || rawDeleted === "-") continue;
		added += Number(rawAdded) || 0;
		deleted += Number(rawDeleted) || 0;
	}
	return { files, additions: added, deletions: deleted };
}

function unknown(state, reason, detail = {}) {
	return { state: "unknown", note: `查不到它的 worktree 归属：${reason}。我什么都没做，也**不会**自动收/删（只提示）。`, reason, ...detail };
}

/**
 * 「相对基准的读数」——**只读**，量不出来就如实标 null：
 *   · `commitsAhead`            —— `rev-list --count base..branch`（**两点** = 这条分支自己多出来的提交 ✓）；
 *   · `filesChanged/…`          —— `diff --numstat base...branch`（**三点** = merge-base → 分支 tip）
 *                                 ⇒ **与 `commitsAhead` 描述同一件事**：「这条分支自己改了什么」✓。
 *                                 ⚠️ 2026-10-11 修：原先是**两点** `base..branch`，而 `git diff A B` 是**两条 tip 的差异**
 *                                 —— 基点很旧时，会把基准侧整段历史算成「它留下的改动」（实测回执：提交 1 个 /
 *                                 **322 个文件**，而它自己只加了 1 个文件 140 行）。**同一个回执里两个数字描述的不是同一件事**，
 *                                 读的人一定会被误导（业主被误导过）✗。改完后两者都只说「它自己的改动」。
 *   · `vsMasterTwoDot`         —— 「把它并进基准会带来多少变化」= `diff base..branch`（**两条 tip 的差异**，
 *                                 即旧那组数字）。名字**自述**，**绝不**混进上面那组冒充「它自己的改动」。
 *   · `mergeBase`              —— 分叉点 `{sha, date}`：把「它有多旧」摊在明面上（数字为何是这样一眼可见）。
 */
async function unmergedCounts({ repo, branchRef, budget }) {
	const tried = [];
	for (const ref of BASE_REF_CANDIDATES) {
		const verified = await gitBounded(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo, budget);
		if (!verified.ok || verified.stdout.trim() === "") { tried.push(ref); continue; }
		const baseRef = ref;
		const baseSha = verified.stdout.trim();
		const empty = { baseRef, baseSha, tried, commitsAhead: null, filesChanged: null, additions: null, deletions: null, vsMasterTwoDot: null, mergeBase: null };
		const count = await gitBounded(["rev-list", "--count", `${baseRef}..${branchRef}`], repo, budget);
		if (!count.ok) return { ...empty, reason: `git rev-list 失败：${count.timedOut ? "超时" : (count.stderr.trim() || `exit ${count.code}`)}` };
		// **三点**（merge-base → 分支 tip）：与 commitsAhead 描述同一件事 = 「它自己的改动」。
		const own = await gitBounded(["diff", "--numstat", `${baseRef}...${branchRef}`], repo, budget);
		if (!own.ok) return { ...empty, commitsAhead: Number(count.stdout.trim()) || 0, reason: `git diff（三点：它自己的改动）失败：${own.timedOut ? "超时" : (own.stderr.trim() || `exit ${own.code}`)}` };
		const diff = countNumstat(own.stdout);
		// 分叉点透明化（sha ＋ 日期）：老基点 ⇒ 下面的两点数字很大，读的人一眼知道为什么。
		const mergeBase = await mergeBaseOf({ repo, baseRef, branchRef, budget });
		// 另加、**自述名字**：「把它并进基准会带来多少变化」= 两条 tip 的差异（旧那组数字），
		// 绝不混进上面那组冒充「它自己的改动」。量不出来就 null（如实，不猜）。
		const twoTip = await gitBounded(["diff", "--numstat", `${baseRef}..${branchRef}`], repo, budget);
		const vsMasterTwoDot = twoTip.ok ? countNumstat(twoTip.stdout) : null;
		return { ...empty, commitsAhead: Number(count.stdout.trim()) || 0, filesChanged: diff.files, additions: diff.additions, deletions: diff.deletions, vsMasterTwoDot, mergeBase, reason: null };
	}
	return { baseRef: null, baseSha: null, tried, commitsAhead: null, filesChanged: null, additions: null, deletions: null, vsMasterTwoDot: null, mergeBase: null, reason: `找不到基准引用（试过 ${tried.join(", ")}）` };
}

/** 分叉点（merge-base）＋ 它那一刻的日期：把「这条分支有多旧」摊开。量不出来就 null（如实）。 */
async function mergeBaseOf({ repo, baseRef, branchRef, budget }) {
	const mergeBase = await gitBounded(["merge-base", baseRef, branchRef], repo, budget);
	const sha = mergeBase.ok ? mergeBase.stdout.trim() : "";
	if (sha === "") return null;
	const when = await gitBounded(["log", "-1", "--format=%ci", sha], repo, budget);
	return { sha, date: when.ok ? when.stdout.trim() : null };
}

function worktreeNote(info) {
	const branchText = info.branch ? `分支 ${info.branch}` : "detached HEAD（没有分支名）";
	const unmerged = info.unmerged && info.unmerged.filesChanged !== null
		? `未并入 ${info.unmerged.baseRef} 的提交 ${info.unmerged.commitsAhead} 个 —— 这 ${info.unmerged.commitsAhead} 个提交自己改了 ${info.unmerged.filesChanged} 个文件（+${info.unmerged.additions} -${info.unmerged.deletions}）`
			+ (info.unmerged.mergeBase?.sha ? `，分叉点 ${info.unmerged.mergeBase.sha.slice(0, 12)}（${info.unmerged.mergeBase.date ?? "日期读不到"}）` : "，分叉点没量出来（如实说，不猜）")
			+ (info.unmerged.vsMasterTwoDot === null
				? ""
				: `；另外、**不是它自己的改动**：并进 ${info.unmerged.baseRef} 会带来 ${info.unmerged.vsMasterTwoDot.files} 个文件的变化（+${info.unmerged.vsMasterTwoDot.additions} -${info.unmerged.vsMasterTwoDot.deletions}）—— 那是**两条 tip 的差异**（基点旧 ⇒ 基准侧那段历史也算进来了）`)
		: `未并入基准的计数量不出来：${info.unmerged?.reason ?? "未知原因"}（如实说，不猜）`;
	return `它留了一棵 worktree：${info.worktree}（${branchText}；${unmerged}）。要收就调 reclaim_worktree（有守卫、需要它是已归档会话）—— **我不会自动收**。`;
}

/**
 * 查一条会话的 worktree 归属。**只读**，任何失败都降级成 `unknown`（带原因），**不抛**给调用方去猜。
 *
 * @param {object} options
 * @param {string} options.sessionId 目标会话的完整 uuid（片段不解析）
 * @param {object} [options.env] 环境（默认 `process.env`）
 * @param {number} [options.deadlineMs] 短死线（默认 2 s）
 */
export async function worktreeHintForSession(options = {}) {
	const { sessionId, env = process.env, deadlineMs = DEFAULT_DEADLINE_MS } = options;
	if (typeof sessionId !== "string" || !FULL_UUID.test(sessionId)) return unknown("unknown", `传进来的不是完整会话 uuid（${typeof sessionId === "string" ? sessionId : typeof sessionId}）`);
	const targetId = sessionId.toLowerCase();
	const budget = budgetOf(deadlineMs);

	// 1) 一手来源：会话文件 header（**不是** `/tree` 投影）。
	const sessionsRoot = sessionsRootOf(env);
	let files;
	try {
		files = await listSessionFiles(sessionsRoot);
	} catch (error) {
		return unknown("unknown", `扫不了会话目录 ${sessionsRoot}：${error?.message ?? error}`);
	}
	const suffix = `${targetId}.jsonl`.toLowerCase();
	const file = files.find((candidate) => candidate.toLowerCase().endsWith(suffix)) ?? null;
	if (file === null) return unknown("unknown", `在 ${sessionsRoot} 里找不到它的会话文件（${targetId}.jsonl）`);
	let header;
	try {
		header = JSON.parse(await readFirstLine(file));
	} catch (error) {
		return unknown("unknown", `读不出 ${file} 的第一行（会话 header）：${error?.message ?? error}`, { sessionFile: file });
	}
	const cwdRaw = typeof header?.cwd === "string" && header.cwd.trim() !== "" ? header.cwd : null;
	if (cwdRaw === null) return unknown("unknown", `它的会话 header 里没有 cwd（${file}）`, { sessionFile: file });
	if (budget.left() <= 0) return unknown("unknown", `查 worktree 超时（${deadlineMs} ms 死线在起 git 之前就到点了）`, { sessionFile: file, cwd: cwdRaw, timedOut: true });

	// 2) cwd 在哪个仓里（只读 `git rev-parse`）。
	const top = await gitBounded(["rev-parse", "--show-toplevel"], cwdRaw, budget);
	if (!top.ok) {
		const raw = `${top.stderr}`.trim() || top.error || `exit ${top.code}`;
		if (top.timedOut) return unknown("unknown", `git 查询超时（${deadlineMs} ms 死线；cwd=${cwdRaw}）`, { cwd: cwdRaw, timedOut: true });
		// cwd 根本不在任何 git 仓里 ⇒ 连仓都没有 ⇒ **确定它没占 worktree**（成功判定，不是失败）
		// ⇒ 静默。业主 2026-10-10 拍板：把成功判定写成「查不到它的 worktree 归属」会每次都多一句噪音。
		if (NOT_A_REPO.test(raw)) return { state: "not_worktree", note: null, reason: `cwd 不在任何 git 仓里（${raw}）⇒ 确定它没占 worktree`, cwd: cwdRaw };
		return unknown("unknown", `git 查询失败（cwd=${cwdRaw}）：${raw}`, { cwd: cwdRaw, gitError: raw });
	}
	const worktreePath = await resolveExisting(top.stdout.trim());

	// 3) 是不是本仓**主检出**（是 ⇒ 静默：绝大多数会话就在这里跑，提示它只是噪音）。
	const common = await gitBounded(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreePath, budget);
	if (!common.ok) {
		const raw = `${common.stderr}`.trim() || common.error || `exit ${common.code}`;
		return unknown("unknown", `拿不到 git-common-dir（cwd=${worktreePath}）：${raw}`, { cwd: worktreePath, timedOut: common.timedOut === true });
	}
	const commonDir = path.resolve(common.stdout.trim());
	const mainRepo = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : worktreePath;
	if (path.resolve(worktreePath).toLowerCase() === path.resolve(mainRepo).toLowerCase()) return { state: "not_worktree", note: null, reason: "cwd 就是主检出（不是 worktree）", cwd: worktreePath };

	// 4) 注册项（只读 `git worktree list --porcelain`）。
	const listing = await gitBounded(["worktree", "list", "--porcelain"], mainRepo, budget);
	if (!listing.ok) {
		const raw = `${listing.stderr}`.trim() || listing.error || `exit ${listing.code}`;
		return unknown("unknown", `git worktree list 失败（${mainRepo}）：${raw}`, { cwd: worktreePath, timedOut: listing.timedOut === true });
	}
	const entries = parsePorcelain(listing.stdout);
	const target = path.resolve(worktreePath).toLowerCase();
	const registered = entries.find((entry) => path.resolve(entry.path).toLowerCase() === target) ?? null;
	if (registered === null) return { state: "not_worktree", note: null, reason: `cwd 不在 git worktree list 的注册项里（${entries.length} 条注册）`, cwd: worktreePath };

	// 5) 提示（**只读**：提交数 / 文件数）。
	const unmerged = registered.branchRef ? await unmergedCounts({ repo: mainRepo, branchRef: registered.branchRef, budget }) : { baseRef: null, commitsAhead: null, filesChanged: null, additions: null, deletions: null, vsMasterTwoDot: null, mergeBase: null, reason: "detached HEAD（没有分支 ⇒ 没有「已并入」可判）" };
	const info = { worktree: worktreePath, mainRepo, branch: registered.branch, branchRef: registered.branchRef, unmerged, conventionMatch: path.basename(path.dirname(worktreePath)) === ".sopho-wt" && registered.branch === `wt/${path.basename(worktreePath)}` };
	return { state: "worktree", note: worktreeNote(info), reason: null, ...info };
}

/** 给 `session_archive` 用的薄包装：不抛、只回「加不加那段话」需要的东西。 */
export async function archiveWorktreeHint(sessionId, { env = process.env } = {}) {
	try {
		const hint = await worktreeHintForSession({ sessionId, env });
		if (hint === null || hint === undefined) return null;
		if (hint.state === "not_worktree") return null;
		return hint;
	} catch (error) {
		return unknown("unknown", `提示器自己抛了：${error?.message ?? error}`);
	}
}
